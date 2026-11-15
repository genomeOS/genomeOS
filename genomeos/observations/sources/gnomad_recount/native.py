"""The native bcftools count of D18's recount (Atlas data platform design 2026-10-18 §1.2 D18, §2.10;
builder's call 38).

One region at a time, bcftools applies D18's rule to the stage's genotypes and counts per population. The
pipeline is ``subprocess.Popen`` processes with no shell, joined by anonymous pipes. Every plugin stage
carries its own options after ``--``:

    [view]   bcftools view --no-update --regions-overlap pos -r CHR:START-END -S stage.txt -Ou VCF
    [tee]    tee /dev/fd/P /dev/fd/Q (the write ends of pipes P and Q), stdout to [c]
    [audit]  bcftools +check-ploidy -i 'FILTER="PASS"' - < pipe P > ploidy.tsv
    [guard]  bcftools query -i PARTIAL_GENOTYPE -f '%CHROM:%POS\\n' - < pipe Q > partial.txt
    [c]      bcftools +fill-tags -Ou - -- -S groups_c.txt -t NS
    [gq]     bcftools +setGT -Ou - -- -t q -n . -i QC_LOW_GQ
    [g]      bcftools +fill-tags -Ou - -- -S groups_g.txt -t NS
    [dp]     bcftools +setGT -Ou - -- -t q -n . -i QC_LOW_DP
    [d]      bcftools +fill-tags -Ou - -- -S groups_d.txt -t NS
    [ab]     bcftools +setGT -Ou - -- -t q -n . -i QC_LOW_ALLELE_BALANCE
    [p]      bcftools +fill-tags -Ou - -- -S groups_p.txt -t NS,AC,AN
    [query]  bcftools query -f native_query_format(n) - > native.tsv

- ``--regions-overlap pos`` selects records by POS, so a deletion spanning a bin edge is counted once, in
  its POS bin. ``--no-update`` keeps ``view -S`` from recomputing INFO/AC and AN for the subset, which would
  refuse an allele index above 1 at [view]. The record reaches [c] as written, and +fill-tags refuses it
  there ("Incorrect allele", D18 item 2).
- Group ``c03`` is the fourth label of ``stage.populations``, and each ``NS`` counts that population's
  called genotypes. Each +setGT sets the calls failing one of item 3's tests to missing, in
  ``REFUSAL_REASONS``' order, so the refusals are differences: missing = denominator - NS_c,
  low_gq = NS_c - NS_g, low_dp = NS_g - NS_d and low_allele_balance = NS_d - NS_p. AC_p and AN_p are ``ac``
  and ``an``; a haploid call counts once.

The checks run in a fixed order, and a bin is recorded only after all of them pass:

1. Wait for every stage, then raise on the earliest failing stage in ``_REPORT_ORDER``, with the last
   2 KB of its stderr. A stage killed by SIGPIPE only reports another stage's exit, and a stage this
   module stopped is skipped too.
2. A non-empty partial.txt raises (item 3).
3. The +check-ploidy audit runs (item 4, ``audit_ploidy``).
4. Only then are the lines parsed: ``check_record`` on every line (Decision 2), then the refusals and the
   consistency check on PASS lines (``parse_native_line``).

tee's two readers read anonymous pipes, not named FIFOs: on macOS a FIFO's reader at times stayed blocked in
``read`` after tee, its only writer, had exited (15 of 12,000 counts, always [guard]), and the count never
ended. This side holds each pipe's read end until every stage has exited, so a reader that dies leaves tee
blocked on a full pipe rather than killed by SIGPIPE; the stages still running are then stopped, and the
reader is the stage named. A reader still running ``_READER_GRACE_SECONDS`` after every other stage exited
is stopped, and the count raises instead of waiting forever (a job resumes, so rerunning it is safe).
bcftools' stderr names samples, so every stage sample id in an error is replaced by ``<sample>``: errors
never name a sample (``rule``).

``query_region`` and ``query_bin`` are the independent path: ``view | query -H -f PY_QUERY_FORMAT``,
counted by ``counter.recount_python`` (§2.7 check 12). Offline batch work; one region at a time per
workdir, whose files each run overwrites.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from genomeos.observations.sources.gnomad_recount.counter import PY_QUERY_FORMAT, recount_python
from genomeos.observations.sources.gnomad_recount.rule import (
    DP_MIN_DIPLOID,
    DP_MIN_HAPLOID,
    GQ_MIN,
    REFUSAL_REASONS,
    X_PARS,
    Y_PARS,
    RecountError,
    SiteCounts,
    Stage,
    Tally,
    check_record,
    denominators,
    expected_ploidy,
    segment,
)
from genomeos.tables.lookup_sets import BinRef, bin_range

__all__ = (
    "MIN_BCFTOOLS",
    "PARTIAL_GENOTYPE",
    "QC_LOW_ALLELE_BALANCE",
    "QC_LOW_DP",
    "QC_LOW_GQ",
    "NativeBin",
    "audit_ploidy",
    "bcftools_version",
    "groups_file",
    "header_contig_lengths",
    "indexed_contigs",
    "native_bin",
    "native_query_format",
    "native_region",
    "parse_bcftools_version",
    "parse_native_line",
    "query_bin",
    "query_region",
)

#: The oldest bcftools the native count was checked on (§14: the 2026-10-19 windows ran 1.21).
MIN_BCFTOOLS = (1, 21)
QC_LOW_GQ = f'FMT/GQ="." | FMT/GQ<{GQ_MIN}'
QC_LOW_DP = f'FMT/DP="." | (GT="hap" & FMT/DP<{DP_MIN_HAPLOID}) | (GT!="hap" & FMT/DP<{DP_MIN_DIPLOID})'
QC_LOW_ALLELE_BALANCE = (
    'GT="het" & (FMT/AD[:0]="." | FMT/AD[:1]="." | FMT/AD[:0]/FMT/DP<0.2 | FMT/AD[:1]/FMT/DP<0.2)'
)
PARTIAL_GENOTYPE = r'FILTER="PASS" & (GT~"[01][/|]\." | GT~"\.[/|][01]")'

_AUDIT = ("bcftools", "+check-ploidy", "-i", 'FILTER="PASS"')
_TEE_READERS = ("audit", "guard")
#: Where the failure is reported from: tee's two pipe readers come after the counting chain. When [c] refuses
#: a record mid-stream, tee dies of SIGPIPE and the audits read a truncated stream, so [c] is the cause.
_REPORT_ORDER = ("view", "tee", "c", "gq", "g", "dp", "d", "ab", "p", "query", *_TEE_READERS)
#: How long tee's readers may run once every other stage has exited. tee has then written its last bytes, so
#: each reader has at most one pipe buffer left; a reader still running after this never saw its input end.
_READER_GRACE_SECONDS = 60.0
_GROUPS = ("c", "g", "d", "p")
_COUNT_TAGS = ("NS_c", "NS_g", "NS_d", "NS_p", "AC_p", "AN_p")
_RECORD_FORMAT = ("%CHROM", "%POS", "%ID", "%REF", "%ALT", "%FILTER")
_PLOIDY_HEADER = ("[1]Sample", "[2]Chromosome", "[3]Region Start", "[4]Region End", "[5]Ploidy")
_STDERR_TAIL = 2048
_POLL_SECONDS = 0.02
_VERSION = re.compile(r"bcftools ([0-9]+)\.([0-9]+)(?![0-9])")
_NATURAL = re.compile(r"[0-9]+")
_POSITION = re.compile(r"[1-9][0-9]*")
_CONTIG_ID = re.compile(r"(?:^|,)ID=([^,]+)")
_CONTIG_LENGTH = re.compile(r"(?:^|,)length=([1-9][0-9]*)(?:,|$)")


def parse_bcftools_version(text: str) -> tuple[int, int]:
    """``(major, minor)`` from ``bcftools --version``'s first line; older than ``MIN_BCFTOOLS`` is refused."""
    lines = text.splitlines()
    match = _VERSION.match(lines[0]) if lines else None
    if match is None:
        raise RecountError(f"cannot read a bcftools version from {text[:80]!r}")
    version = (int(match[1]), int(match[2]))
    if version < MIN_BCFTOOLS:
        raise RecountError(
            f"bcftools {version[0]}.{version[1]} is older than MIN_BCFTOOLS "
            f"{MIN_BCFTOOLS[0]}.{MIN_BCFTOOLS[1]}, the oldest the native count was checked on"
        )
    return version


def bcftools_version() -> str:
    """The first line of ``bcftools --version``, such as ``bcftools 1.23.1``, after the version floor."""
    text = _run(["bcftools", "--version"], "version")
    parse_bcftools_version(text)
    return text.splitlines()[0].strip()


def groups_file(stage: Stage, prefix: str) -> str:
    """``+fill-tags -S`` groups: one ``sample<TAB>prefix + NN`` line per sample, NN its population's index."""
    index = {population: i for i, population in enumerate(stage.populations)}
    return "".join(f"{s.sample_id}\t{prefix}{index[s.population]:02d}\n" for s in stage.samples)


def native_query_format(n_populations: int) -> str:
    """[query]'s format: the record, then NS_c, NS_g, NS_d, NS_p, AC_p and AN_p over every population."""
    if isinstance(n_populations, bool) or not isinstance(n_populations, int) or n_populations < 1:
        raise RecountError(f"{n_populations!r} is not a positive number of populations")
    tags = (",".join(f"%INFO/{tag}{i:02d}" for i in range(n_populations)) for tag in _COUNT_TAGS)
    return "\t".join((*_RECORD_FORMAT, *tags)) + "\n"


def _an_fits(seg: str, an: int, called: int) -> bool:
    """D18 item 4's ``an`` for ``called`` genotypes: diploid, haploid (chrY), or either (chrX non-PAR)."""
    if seg == "y_nonpar":
        return an == called
    if seg == "x_nonpar":
        return called <= an <= 2 * called
    return an == 2 * called


class _NativeLines:
    """``parse_native_line`` for one stage, each segment's denominators computed once."""

    def __init__(self, stage: Stage) -> None:
        self.stage = stage
        self.denominators: dict[str, tuple[int, ...]] = {}

    def parse(self, line: str) -> tuple[str, SiteCounts | None, dict[tuple[str, str], int]]:
        fields = line.removesuffix("\n").split("\t")
        try:
            return self._parse(fields)
        except RecountError as error:
            raise RecountError(f"{':'.join(fields[:2])}: {error}") from error

    def _counts(self, text: str, tag: str) -> tuple[int, ...]:
        values = text.split(",")
        if len(values) != len(self.stage.populations) or not all(_NATURAL.fullmatch(v) for v in values):
            raise RecountError(f"{tag} {text!r} is not {len(self.stage.populations)} counts")
        return tuple(int(value) for value in values)

    def _parse(self, fields: list[str]) -> tuple[str, SiteCounts | None, dict[tuple[str, str], int]]:
        width = len(_RECORD_FORMAT) + len(_COUNT_TAGS)
        if len(fields) != width:
            raise RecountError(f"{len(fields)} columns where the native query has {width}")
        chrom, pos_text, rsid, ref, alt, filter_ = fields[: len(_RECORD_FORMAT)]
        if not _POSITION.fullmatch(pos_text):
            raise RecountError(f"POS {pos_text!r} is not a 1-based position")
        pos = int(pos_text)
        check_record(chrom, pos, ref, alt)  # every record, PASS or not (Decision 2)
        if filter_ != "PASS":
            return filter_, None, {}
        seg = segment(chrom, pos)
        if seg not in self.denominators:
            self.denominators[seg] = denominators(self.stage, seg)
        texts = fields[len(_RECORD_FORMAT) :]
        counts = (self._counts(text, tag) for text, tag in zip(texts, _COUNT_TAGS, strict=True))
        ns_c, ns_g, ns_d, ns_p, ac, an = counts
        refusals: dict[tuple[str, str], int] = {}
        for i, population in enumerate(self.stage.populations):
            n = self.denominators[seg][i]
            if not (
                0 <= ns_p[i] <= ns_d[i] <= ns_g[i] <= ns_c[i] <= n
                and _an_fits(seg, an[i], ns_p[i])
                and 0 <= ac[i] <= an[i]
            ):
                raise RecountError(
                    f"native counts inconsistent for {population} ({seg}): denominator {n}, NS c/g/d/p "
                    f"{ns_c[i]}/{ns_g[i]}/{ns_d[i]}/{ns_p[i]}, AC {ac[i]}, AN {an[i]}"
                )
            steps = (n - ns_c[i], ns_c[i] - ns_g[i], ns_g[i] - ns_d[i], ns_d[i] - ns_p[i])
            for reason, count in zip(REFUSAL_REASONS, steps, strict=True):
                if count:
                    refusals[(population, reason)] = count
        return filter_, SiteCounts(chrom, pos, ref, alt, None if rsid == "." else rsid, ac, an), refusals


def parse_native_line(line: str, stage: Stage) -> tuple[str, SiteCounts | None, dict[tuple[str, str], int]]:
    """One [query] line: its FILTER, and for a PASS record its counts and refusals; ``None, {}`` otherwise.

    ``check_record`` runs on every line; a PASS line must then satisfy, per population,
    ``0 <= NS_p <= NS_d <= NS_g <= NS_c <= denominator``, ``AN = 2 NS_p`` (autosomes, chrX PARs),
    ``AN = NS_p`` (chrY non-PAR) or ``NS_p <= AN <= 2 NS_p`` (chrX non-PAR), and ``0 <= AC <= AN``.
    """
    return _NativeLines(stage).parse(line)


def _segments(chrom: str, start: int, end: int) -> list[str]:
    """The segments ``chrom:start-end`` touches, in a fixed order (a 1 Mb bin meets at most one PAR edge)."""
    segment(chrom, start)
    segment(chrom, end)
    if start > end:
        raise RecountError(f"{chrom}:{start}-{end} ends before it starts")
    pars = {"chrX": X_PARS, "chrY": Y_PARS}.get(chrom)
    if pars is None:
        return ["autosome"]
    par, nonpar = ("x_par", "x_nonpar") if chrom == "chrX" else ("y_par", "y_nonpar")
    touched = [par] if any(lo <= end and start <= hi for lo, hi in pars) else []
    return touched + ([] if any(lo <= start and end <= hi for lo, hi in pars) else [nonpar])


def audit_ploidy(report: str, stage: Stage) -> int:
    """Check every ``+check-ploidy`` run against D18 item 4; the number of runs checked.

    A run is one sample's stretch of called PASS genotypes of one ploidy. It passes only if
    ``expected_ploidy`` gives that ploidy in every segment it touches (an XX sample's chrY calls give 0).
    """
    lines = report.splitlines()
    header = lines[0].removeprefix("#").removeprefix(" ").split("\t") if lines and lines[0][:1] == "#" else []
    if tuple(header) != _PLOIDY_HEADER:
        raise RecountError("the +check-ploidy report does not start with its header")
    karyotypes = {sample.sample_id: sample.karyotype for sample in stage.samples}
    for line in lines[1:]:
        fields = line.split("\t")
        if len(fields) != len(_PLOIDY_HEADER):
            raise RecountError(f"a +check-ploidy run has {len(fields)} columns, not {len(_PLOIDY_HEADER)}")
        sample, chrom, *numbers = fields
        karyotype = karyotypes.get(sample)
        if karyotype is None:
            raise RecountError("a +check-ploidy run names a sample outside the stage")
        if not all(_NATURAL.fullmatch(number) for number in numbers):
            raise RecountError(f"a +check-ploidy run on {chrom} has a non-integer start, end or ploidy")
        start, end, ploidy = (int(number) for number in numbers)
        for seg in _segments(chrom, start, end):
            expected = expected_ploidy(seg, karyotype)
            if ploidy != expected:
                raise RecountError(
                    f"ploidy: {chrom}:{start}-{end} holds calls of ploidy {ploidy} where {seg} gives an "
                    f"{karyotype} sample {expected} (D18 item 4)"
                )
    return len(lines) - 1


def _redact(text: str, stage: Stage) -> str:
    for sample in sorted(stage.sample_ids, key=len, reverse=True):
        if sample in text:
            text = text.replace(sample, "<sample>")
    return text


def _status(code: int) -> str:
    if code >= 0:
        return f"exited with status {code}"
    try:
        return f"was killed by {signal.Signals(-code).name}"
    except ValueError:
        return f"was killed by signal {-code}"


def _run(argv: list[str], name: str) -> str:
    """One short bcftools call's stdout; a failure raises naming ``[name]``."""
    try:
        done = subprocess.run(argv, capture_output=True, check=False)
    except OSError as error:
        raise RecountError(f"[{name}] cannot run {argv[0]}: {error}") from error
    if done.returncode != 0:
        tail = done.stderr[-_STDERR_TAIL:].decode("utf-8", "replace").strip()
        raise RecountError(f"[{name}] {_status(done.returncode)}: {tail or 'no stderr'}")
    return done.stdout.decode("utf-8")


def indexed_contigs(vcf: str) -> tuple[str, ...]:
    """The contigs ``vcf``'s index holds records on, in index order (``bcftools index --stats``)."""
    contigs = []
    for line in _run(["bcftools", "index", "--stats", vcf], "index").splitlines():
        fields = line.split("\t")
        if len(fields) != 3 or not fields[0] or not _NATURAL.fullmatch(fields[2]):
            raise RecountError(f"bcftools index --stats wrote {line[:120]!r}, not contig, length and records")
        if int(fields[2]) > 0:
            contigs.append(fields[0])
    if len(set(contigs)) != len(contigs):
        raise RecountError("bcftools index --stats lists a contig twice")
    return tuple(contigs)


def header_contig_lengths(vcf: str) -> dict[str, int]:
    """Every ``##contig`` line's ID and length in ``vcf``'s header (``bcftools view -h``)."""
    lengths: dict[str, int] = {}
    for line in _run(["bcftools", "view", "-h", vcf], "header").splitlines():
        if not line.startswith("##contig=<"):
            continue
        body = line.removeprefix("##contig=<").removesuffix(">")
        contig, length = _CONTIG_ID.search(body), _CONTIG_LENGTH.search(body)
        if contig is None or length is None:
            raise RecountError(f"a ##contig line lacks an ID or a positive length: {line[:120]!r}")
        if contig[1] in lengths:
            raise RecountError(f"the header declares ##contig {contig[1]!r} twice")
        lengths[contig[1]] = int(length[1])
    return lengths


class _Pipeline:
    """Stages started in data-flow order; each one's stderr goes to ``workdir/<tag>-<name>.stderr``."""

    def __init__(self, workdir: Path, tag: str) -> None:
        self.workdir, self.tag = workdir, tag
        self.procs: dict[str, subprocess.Popen[bytes]] = {}
        self.stopped: set[str] = set()
        self.held: set[int] = set()

    def _stderr(self, name: str) -> Path:
        return self.workdir / f"{self.tag}-{name}.stderr"

    def pipe(self) -> tuple[int, int]:
        """A new anonymous pipe's read and write ends, held here until ``release`` or ``close``."""
        read_end, write_end = os.pipe()
        self.held.update((read_end, write_end))
        return read_end, write_end

    def release(self, *ends: int) -> None:
        """Close this side's copy of each pipe end."""
        for end in ends:
            self.held.discard(end)
            os.close(end)

    def start(
        self,
        name: str,
        argv: Sequence[str],
        *,
        upstream: subprocess.Popen[bytes] | None = None,
        stdin: int | None = None,
        stdout: IO[bytes] | int = subprocess.PIPE,
        pass_fds: Sequence[int] = (),
    ) -> subprocess.Popen[bytes]:
        """Start ``argv``, reading ``upstream``'s stdout (whose copy here is closed), the pipe end ``stdin``
        or nothing; ``pass_fds`` stay open in the stage under their own numbers."""
        source = upstream.stdout if upstream is not None else subprocess.DEVNULL if stdin is None else stdin
        with self._stderr(name).open("wb") as stderr:
            self.procs[name] = subprocess.Popen(
                list(argv), stdin=source, stdout=stdout, stderr=stderr, pass_fds=tuple(pass_fds)
            )
        if upstream is not None and upstream.stdout is not None:
            upstream.stdout.close()
        return self.procs[name]

    def stop_running(self) -> None:
        for name, proc in self.procs.items():
            if proc.poll() is None:
                proc.kill()
                self.stopped.add(name)

    def wait(self, readers: Sequence[str] = (), *, where: str = "") -> None:
        """Wait for every stage. A failed tee reader stops the rest, which could block on its pipe; a reader
        still running ``_READER_GRACE_SECONDS`` after every other stage exited is stopped, and raises."""
        others_done: float | None = None
        while [proc.poll() for proc in self.procs.values()].count(None):  # polls every stage
            if any(self.procs[name].returncode not in (None, 0) for name in readers):
                self.stop_running()
            elif readers and all(p.returncode is not None for n, p in self.procs.items() if n not in readers):
                others_done = time.monotonic() if others_done is None else others_done
                if time.monotonic() - others_done > _READER_GRACE_SECONDS:
                    running = [f"[{name}]" for name in readers if self.procs[name].returncode is None]
                    self.stop_running()
                    grace = f"{_READER_GRACE_SECONDS:g} s"
                    raise RecountError(
                        f"{where}: {', '.join(running)} still running {grace} after every other stage "
                        "exited: its input never ended"
                    )
            time.sleep(_POLL_SECONDS)

    def close(self) -> None:
        """Stop what still runs (only after an error), reap every stage and close this side's pipes."""
        self.stop_running()
        for proc in self.procs.values():
            proc.wait()
            if proc.stdout is not None:
                proc.stdout.close()
        self.release(*sorted(self.held))

    def check(self, where: str, order: Sequence[str], stage: Stage) -> None:
        """Raise on the earliest failed stage in ``order`` that neither died of SIGPIPE nor was stopped."""
        failed = [name for name in order if self.procs[name].returncode != 0]
        if not failed:
            return
        first = next(
            (n for n in failed if n not in self.stopped and self.procs[n].returncode != -signal.SIGPIPE),
            failed[0],
        )
        tail = self._stderr(first).read_bytes()[-_STDERR_TAIL:].decode("utf-8", "replace").strip()
        message = f"{where}: [{first}] {_status(self.procs[first].returncode)}: {tail or 'no stderr'}"
        raise RecountError(_redact(message, stage))


def _region(chrom: str, start: int, end: int) -> str:
    _segments(chrom, start, end)
    return f"{chrom}:{start}-{end}"


def _bin_range(ref: BinRef) -> tuple[int, int]:
    try:
        return bin_range(ref)
    except ValueError as error:
        raise RecountError(str(error)) from error


def _prepare(workdir: Path, stage: Stage) -> Path:
    """The stage's sample file in ``workdir`` (created if missing), after the bcftools version floor."""
    bcftools_version()
    workdir.mkdir(parents=True, exist_ok=True)
    stage_file = workdir / "stage.txt"
    stage_file.write_text("".join(f"{sample}\n" for sample in stage.sample_ids), encoding="utf-8")
    return stage_file


def _view(vcf: str, region: str, stage_file: Path) -> list[str]:
    selection = ["--no-update", "--regions-overlap", "pos", "-r", region, "-S", str(stage_file)]
    return ["bcftools", "view", *selection, "-Ou", vcf]


def _chain(workdir: Path, n_populations: int) -> list[tuple[str, list[str]]]:
    """[c] to [p]: the per-population NS after each of item 3's tests, then AC and AN."""

    def fill(group: str, tags: str) -> list[str]:
        groups = str(workdir / f"groups_{group}.txt")
        return ["bcftools", "+fill-tags", "-Ou", "-", "--", "-S", groups, "-t", tags]

    def set_missing(expression: str) -> list[str]:
        return ["bcftools", "+setGT", "-Ou", "-", "--", "-t", "q", "-n", ".", "-i", expression]

    return [
        ("c", fill("c", "NS")),
        ("gq", set_missing(QC_LOW_GQ)),
        ("g", fill("g", "NS")),
        ("dp", set_missing(QC_LOW_DP)),
        ("d", fill("d", "NS")),
        ("ab", set_missing(QC_LOW_ALLELE_BALANCE)),
        ("p", fill("p", "NS,AC,AN")),
        ("query", ["bcftools", "query", "-f", native_query_format(n_populations), "-"]),
    ]


@dataclass(frozen=True)
class NativeBin:
    """One region's native count: its written sites, its tally and the ploidy runs its audit checked."""

    sites: tuple[SiteCounts, ...]
    tally: Tally
    ploidy_runs: int


def native_region(vcf: str, chrom: str, start: int, end: int, stage: Stage, workdir: Path) -> NativeBin:
    """The native count of the records whose POS is in ``chrom:start-end`` (1-based, inclusive)."""
    where = _region(chrom, start, end)
    stage_file = _prepare(workdir, stage)
    for group in _GROUPS:
        (workdir / f"groups_{group}.txt").write_text(groups_file(stage, group), encoding="utf-8")
    ploidy, partial, counts = workdir / "ploidy.tsv", workdir / "partial.txt", workdir / "native.tsv"
    pipeline = _Pipeline(workdir, "native")
    try:
        (ploidy_in, ploidy_out), (partial_in, partial_out) = pipeline.pipe(), pipeline.pipe()
        view = pipeline.start("view", _view(vcf, where, stage_file))
        tee = ["tee", f"/dev/fd/{ploidy_out}", f"/dev/fd/{partial_out}"]
        upstream = pipeline.start("tee", tee, upstream=view, pass_fds=(ploidy_out, partial_out))
        pipeline.release(ploidy_out, partial_out)  # tee is then their only writer
        with ploidy.open("wb") as out:
            pipeline.start("audit", [*_AUDIT, "-"], stdin=ploidy_in, stdout=out)
        with partial.open("wb") as out:
            guard = ["bcftools", "query", "-i", PARTIAL_GENOTYPE, "-f", "%CHROM:%POS\n", "-"]
            pipeline.start("guard", guard, stdin=partial_in, stdout=out)
        *chain, (last, query) = _chain(workdir, len(stage.populations))
        for name, argv in chain:
            upstream = pipeline.start(name, argv, upstream=upstream)
        with counts.open("wb") as out:
            pipeline.start(last, query, upstream=upstream, stdout=out)
        pipeline.wait(_TEE_READERS, where=where)
    finally:
        pipeline.close()
    pipeline.check(where, _REPORT_ORDER, stage)
    partial_lines = partial.read_text(encoding="utf-8").splitlines()
    if partial_lines:
        raise RecountError(f"{partial_lines[0]}: partial genotype (D18 item 3)")
    runs = audit_ploidy(ploidy.read_text(encoding="utf-8"), stage)
    lines, sites, tally = _NativeLines(stage), [], Tally()
    with counts.open(encoding="utf-8", newline="\n") as rows:
        for row in rows:
            filter_, site, refusals = lines.parse(row)
            if site is None:
                tally.record_filtered(filter_)
            elif tally.record_pass(site, refusals, stage.populations):
                sites.append(site)
    return NativeBin(tuple(sites), tally, runs)


def native_bin(vcf: str, ref: BinRef, stage: Stage, workdir: Path) -> NativeBin:
    """The native count of one 1 Mb bin: the records whose POS is in ``bin_range(ref)``."""
    return native_region(vcf, ref.chrom, *_bin_range(ref), stage, workdir)


def query_region(
    vcf: str, chrom: str, start: int, end: int, stage: Stage, workdir: Path
) -> tuple[tuple[SiteCounts, ...], Tally]:
    """The independent count of ``chrom:start-end``: ``view | query``, then ``recount_python``."""
    where = _region(chrom, start, end)
    stage_file = _prepare(workdir, stage)
    out = workdir / "python-query.tsv"
    pipeline = _Pipeline(workdir, "python")
    try:
        view = pipeline.start("view", _view(vcf, where, stage_file))
        query = ["bcftools", "query", "-H", "-f", PY_QUERY_FORMAT, "-"]
        with out.open("wb") as handle:
            pipeline.start("query", query, upstream=view, stdout=handle)
        pipeline.wait()
    finally:
        pipeline.close()
    pipeline.check(where, ("view", "query"), stage)
    with out.open(encoding="utf-8", newline="\n") as lines:
        return recount_python(lines, stage)


def query_bin(vcf: str, ref: BinRef, stage: Stage, workdir: Path) -> tuple[tuple[SiteCounts, ...], Tally]:
    """The independent count of one 1 Mb bin (§2.7 check 12)."""
    return query_region(vcf, ref.chrom, *_bin_range(ref), stage, workdir)
