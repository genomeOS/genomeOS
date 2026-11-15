"""The whole-genome recount as 166 resumable jobs of 20 Mb, and the ``measured.ingests`` row they make.

Atlas data platform design 2026-10-18 §1.2 D17 and D18, §2.7 checks 9 and 12, §2.10; builder's calls 29,
32 and 38.

**Jobs.** ``plan_jobs`` tiles D18's 24 chromosomes into jobs of ``JOB_SPAN``: job ``k`` covers positions
``max(1, k * JOB_SPAN)`` to ``min(length, (k + 1) * JOB_SPAN - 1)``, so it holds whole 1 Mb bins and the 166
jobs hold the 3,102 bins of the recorded chromosome set once each. ``run_job`` counts each bin natively
(``native.native_bin``), turns its sites into rows (``rows.binned_rows``), writes the bin
(``binned.write_bin``) and records the file's sha256, size and rows, its tally and its ploidy runs in the
job's ledger, written atomically after each bin.

**Identity** (``JobIdentity``). A ledger records what its bins depend on: the cited VCF, metadata and
karyotype files (URL, size, md5 and GCS generation, D17; the two small files also by the sha256 of the bytes
read), the stage, the registry and its inputs, the sources, the population mapping, the cohort, the ingest
and its ascertainment (no defaults, O1), the rule, our code's commit and the tool versions.

**Refusals before streaming** (the plan's Review Focus 1). ``run_job`` writes nothing unless the identity
matches the stage and rule and names a clean commit, the sources are exactly ``RECOUNT_SOURCES`` (§9,
Decision 6), the population table covers the stage and equals the identity's mapping, any existing ledger
has this job and this identity, the VCF has records on the job's chromosome at GRCh38's length, and the
cited gnomAD object is unchanged (an anonymous HEAD, ``head_identity``). The HEAD is repeated after the last
bin, before the ledger is complete, so an object replaced mid-job leaves the job incomplete.

**Resume.** A bin whose file has its recorded sha256 is skipped; a recorded bin whose file is missing or
damaged is rewritten and must reproduce its recorded entry. A cancelled job reruns from its first unwritten
bin (§2.10).

**Combining.** ``combine_ledgers`` takes the 166 complete ledgers into the unpublished ``IngestSummary``
(O7), refusing every problem at once: missing, unexpected, repeated or incomplete jobs, identities that
differ, a dirty tree, and two VCFs for one chromosome. ``recount_ingest`` records its totals as the
``measured.ingests`` row: the 24 cited VCFs and the cited metadata (one entry if one file, O3), the refusals
per population and reason (O11), and the sample rule. Offline batch work, never the serving path.
"""

from __future__ import annotations

import base64
import functools
import hashlib
import http.client
import json
import os
import re
import shutil
import tempfile
import urllib.request
from collections import Counter
from collections.abc import Collection, Mapping, Sequence
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any

import pandas as pd

from genomeos.observations.sources.gnomad_hgdp_1kg import SOURCE
from genomeos.observations.sources.gnomad_recount import native
from genomeos.observations.sources.gnomad_recount.rows import binned_rows, recount_cohort_id
from genomeos.observations.sources.gnomad_recount.rule import (
    GNOMAD_VCF_URL,
    RULE_ID,
    RecountError,
    Stage,
    Tally,
)
from genomeos.tables import measured, reference, writer
from genomeos.tables.binned import SOURCE_RECORD_ID_TEMPLATE, BinFile, write_bin
from genomeos.tables.contracts import TableError
from genomeos.tables.lookup_sets import BIN_BP, BINNED_TABLE, GRCH38_LENGTHS, BinRef, lookup_set
from genomeos.tables.provenance import InputRef

__all__ = (
    "ADAPTER",
    "JOB_SPAN",
    "LEDGER_SCHEMA",
    "RECOUNT_SOURCES",
    "SUMMARY_SCHEMA",
    "BinEntry",
    "CitedFile",
    "IngestSummary",
    "Job",
    "JobIdentity",
    "Ledger",
    "combine_ledgers",
    "head_identity",
    "job_by_id",
    "plan_jobs",
    "read_ledger",
    "read_summary",
    "recount_ingest",
    "run_job",
    "write_ledger",
    "write_summary",
)

JOB_SPAN = 20_000_000
#: A recount bin's sources: the registry inputs' recorded union, and nothing else (§9; Decision 6).
RECOUNT_SOURCES = ("genomeos", "gnomad_hgdp_1kg")
LEDGER_SCHEMA = "gnomad_recount_job_v1"
SUMMARY_SCHEMA = "gnomad_recount_ingest_v1"
#: The adapter ``measured.ingests`` records: a repository file, as for every curated ingest.
ADAPTER = "genomeos/observations/sources/gnomad_recount/jobs.py"
HEAD_TIMEOUT_S = 60
_USER_AGENT = "genomeos-recount/1 (anonymous HEAD of a cited input, D17)"
_MD5 = re.compile(r"[0-9a-f]{32}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_CITED = ("vcf", "metadata", "karyotypes")
_TABLE_COLUMNS = ("source_label", "population_id", "lat", "lon", "radius_km")
_UPSTREAM = ("size", "md5", "generation")


def _is_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_int(value: object, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _require_keys(d: object, names: Collection[str], what: str) -> Mapping[str, Any]:
    if not isinstance(d, Mapping) or set(d) != set(names):
        raise RecountError(f"{what} has exactly the keys {sorted(names)}")
    return d


@dataclass(frozen=True)
class Job:
    """One 20 Mb range of one chromosome and the 1 Mb bins it writes."""

    chrom: str
    index: int
    start: int
    end: int
    bins: tuple[int, ...]

    @property
    def job_id(self) -> str:
        """``chr1-00``: the chromosome and the job's index on it."""
        return f"{self.chrom}-{self.index:02d}"


@functools.cache
def plan_jobs() -> tuple[Job, ...]:
    """Every job of D18's 24 chromosomes, in karyotype then position order: 166 jobs of at most 20 bins."""
    planned = []
    for chrom, length in GRCH38_LENGTHS.items():
        for index in range(length // JOB_SPAN + 1):
            start, end = max(1, index * JOB_SPAN), min(length, (index + 1) * JOB_SPAN - 1)
            planned.append(Job(chrom, index, start, end, tuple(range(start // BIN_BP, end // BIN_BP + 1))))
    return tuple(planned)


def job_by_id(job_id: str) -> Job:
    """The planned job ``job_id``, such as ``chr1-00``."""
    found = {job.job_id: job for job in plan_jobs()}.get(job_id)
    if found is None:
        raise RecountError(
            f"{job_id!r} is not one of the {len(plan_jobs())} planned jobs (chr1-00 to chrY-02)"
        )
    return found


@dataclass(frozen=True)
class CitedFile:
    """An upstream object as D17 cites it: its URL, byte size, md5 (32 hex), GCS generation and the sha256 of
    the bytes read, which is None only for a VCF (streamed, never hashed whole)."""

    url: str
    size: int
    md5: str
    generation: int
    sha256: str | None

    def __post_init__(self) -> None:
        if not (_is_text(self.url) and _is_int(self.size) and _is_int(self.generation, 1)):
            raise RecountError(f"cited file {self.url!r}: a URL, a byte size and a positive generation")
        if not _MD5.fullmatch(str(self.md5)) or not (
            self.sha256 is None or _SHA256.fullmatch(str(self.sha256))
        ):
            raise RecountError(f"cited file {self.url}: md5 is 32 and sha256 64 lowercase hex characters")


def head_identity(url: str) -> CitedFile:
    """The object at ``url`` by an anonymous HEAD: ``Content-Length``, the md5 of ``x-goog-hash`` (base64) as
    hex and ``x-goog-generation``. GCS sends the crc32c and the md5 as two ``x-goog-hash`` headers, so every
    one is read."""
    if not url.startswith("https://"):
        raise RecountError(f"{url}: an upstream object is cited by its https URL")
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=HEAD_TIMEOUT_S) as reply:  # noqa: S310 - https only
            headers = reply.headers
    except (OSError, http.client.HTTPException) as error:
        raise RecountError(f"HEAD {url} failed: {error}") from error
    hashes = {}
    for header in headers.get_all("x-goog-hash") or ():
        for item in header.split(","):
            name, _, value = item.strip().partition("=")
            hashes[name] = value
    try:
        md5 = base64.b64decode(hashes["md5"], validate=True).hex()
        return CitedFile(url, int(headers["Content-Length"]), md5, int(headers["x-goog-generation"]), None)
    except (KeyError, TypeError, ValueError) as error:
        raise RecountError(
            f"HEAD {url}: needs Content-Length, x-goog-generation and an md5 in x-goog-hash to cite the "
            f"object (D17); {error!r}"
        ) from error


def _cited_from_json(d: object) -> CitedFile:
    return CitedFile(**_require_keys(d, [f.name for f in fields(CitedFile)], "a cited file"))


@dataclass(frozen=True)
class JobIdentity:
    """Everything a job's bins depend on: a job resumes, and the ledgers combine, only under one identity."""

    vcf: CitedFile
    metadata: CitedFile
    karyotypes: CitedFile
    stage_name: str
    stage_sha256: str
    registry_version: str
    registry_inputs: tuple[InputRef, ...]
    sources: tuple[str, ...]
    #: ``(source_label, population_id)`` in the stage's population order.
    populations: tuple[tuple[str, str], ...]
    cohort_id: str
    ingest_version: str
    sampling_design: str
    disease_ascertainment_excluded: bool
    rule: str
    git_sha: str
    bcftools: str
    duckdb: str

    def __post_init__(self) -> None:
        texts = ("stage_name", "cohort_id", "ingest_version", "sampling_design", "rule", "git_sha")
        problems = [name for name in (*texts, "bcftools", "duckdb") if not _is_text(getattr(self, name))]
        cited = [getattr(self, name) for name in _CITED]
        if not all(isinstance(item, CitedFile) for item in cited) or None in (
            cited[1].sha256,
            cited[2].sha256,
        ):
            problems.append("vcf, metadata and karyotypes (the last two with a sha256)")
        if not _SHA256.fullmatch(str(self.stage_sha256)):
            problems.append("stage_sha256")
        if not (isinstance(self.registry_inputs, tuple) and self.registry_inputs) or not all(
            isinstance(ref, InputRef) for ref in self.registry_inputs
        ):
            problems.append("registry_inputs")
        if not isinstance(self.sources, tuple) or not all(_is_text(name) for name in self.sources):
            problems.append("sources")
        pairs = self.populations
        if not (isinstance(pairs, tuple) and pairs) or not all(
            isinstance(pair, tuple) and len(pair) == 2 and all(_is_text(v) for v in pair) for pair in pairs
        ):
            problems.append("populations")
        if not isinstance(self.disease_ascertainment_excluded, bool):
            problems.append("disease_ascertainment_excluded (a bool, never coerced: O1)")
        try:
            reference.registry_folder(self.registry_version)
        except TableError:
            problems.append("registry_version")
        if problems:
            raise RecountError(f"a job identity needs valid {', '.join(problems)}")


def _identity_from_json(d: object) -> JobIdentity:
    d = _require_keys(d, [f.name for f in fields(JobIdentity)], "a job identity")
    return JobIdentity(
        **{
            **d,
            **{name: _cited_from_json(d[name]) for name in _CITED},
            "registry_inputs": tuple(InputRef(**item) for item in d["registry_inputs"]),
            "sources": tuple(d["sources"]),
            "populations": tuple((label, population_id) for label, population_id in d["populations"]),
        }
    )


@dataclass(frozen=True)
class BinEntry:
    """One written bin: its file (path, sha256, bytes, rows), its tally and its audit's ploidy runs."""

    file: BinFile
    tally: Tally
    ploidy_runs: int


def _entry_json(entry: BinEntry) -> dict[str, Any]:
    return {"file": asdict(entry.file), "tally": entry.tally.to_json(), "ploidy_runs": entry.ploidy_runs}


def _entry_from_json(d: object) -> BinEntry:
    d = _require_keys(d, ("file", "tally", "ploidy_runs"), "a bin entry")
    file = BinFile(**_require_keys(d["file"], [f.name for f in fields(BinFile)], "a bin file"))
    counts = (file.bytes, file.rows, d["ploidy_runs"])
    if not (_is_text(file.path) and _SHA256.fullmatch(str(file.sha256)) and all(_is_int(n) for n in counts)):
        raise RecountError(f"bin entry {d['file']}: a path, a sha256, and byte, row and ploidy-run counts")
    return BinEntry(file, Tally.from_json(d["tally"]), d["ploidy_runs"])


@dataclass
class Ledger:
    """One job's record: the identity it runs under and each written bin's entry, by bin."""

    job: Job
    identity: JobIdentity
    bins: dict[int, BinEntry]

    def __post_init__(self) -> None:
        stray = sorted(set(self.bins) - set(self.job.bins))
        if stray:
            raise RecountError(
                f"the ledger of {self.job.job_id} records bins {stray}, which are not the job's"
            )

    @property
    def complete(self) -> bool:
        """Every bin of the job is recorded."""
        return set(self.bins) == set(self.job.bins)


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    """``payload`` at ``path`` atomically, with sorted keys: the same payload is the same bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.partial")
    partial.write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(partial, path)


def _read_json(path: Path, schema: str, keys: Collection[str]) -> Mapping[str, Any]:
    d = _require_keys(json.loads(path.read_text(encoding="utf-8")), keys, f"a {schema} file")
    if d["schema"] != schema:
        raise RecountError(f"its schema is {d['schema']!r}")
    return d


def write_ledger(path: Path, ledger: Ledger) -> None:
    """``ledger`` as ``LEDGER_SCHEMA`` JSON at ``path``: atomic, sorted keys and no timestamps."""
    bins = {str(b): _entry_json(entry) for b, entry in sorted(ledger.bins.items())}
    job, identity = asdict(ledger.job), asdict(ledger.identity)
    _write_json(path, {"schema": LEDGER_SCHEMA, "job": job, "identity": identity, "bins": bins})


def read_ledger(path: Path) -> Ledger | None:
    """The ledger at ``path``, or None if there is none; a file ``write_ledger`` did not write is refused."""
    if not path.exists():
        return None
    try:
        d = _read_json(path, LEDGER_SCHEMA, ("schema", "job", "identity", "bins"))
        job = _require_keys(d["job"], [f.name for f in fields(Job)], "a job")
        bins = {int(b): _entry_from_json(entry) for b, entry in d["bins"].items()}
        return Ledger(Job(**{**job, "bins": tuple(job["bins"])}), _identity_from_json(d["identity"]), bins)
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise RecountError(f"{path}: not a {LEDGER_SCHEMA} ledger: {error}") from error


def _check_identity(identity: JobIdentity, stage: Stage, table: pd.DataFrame) -> None:
    """The identity fits the stage, the rule, a clean commit, the sources and the population table."""
    expected = {
        "stage_name": stage.name,
        "stage_sha256": stage.ids_sha256,
        "cohort_id": recount_cohort_id(stage.name),
        "rule": RULE_ID,
    }
    problems = [
        f"{name} is {getattr(identity, name)!r}, where stage {stage.name} under {RULE_ID} gives {value!r}"
        for name, value in expected.items()
        if getattr(identity, name) != value
    ]
    if not writer.GIT_SHA_PATTERN.fullmatch(identity.git_sha):
        problems.append(f"git_sha {identity.git_sha!r} is not a clean commit (D17 records our code's commit)")
    if identity.sources != RECOUNT_SOURCES:
        others = sorted(set(identity.sources) - set(RECOUNT_SOURCES))
        problems.append(
            f"the registry inputs carry the sources {list(identity.sources)}, not exactly "
            f"{list(RECOUNT_SOURCES)}" + (f": {others} may not enter the union (§9)" if others else "")
        )
    if tuple(table.columns) != _TABLE_COLUMNS:
        problems.append(f"the population table has columns {list(table.columns)}, not {list(_TABLE_COLUMNS)}")
    else:
        pairs = tuple(zip(map(str, table["source_label"]), map(str, table["population_id"]), strict=True))
        labels = tuple(label for label, _ in pairs)
        if labels != stage.populations:
            problems.append(
                f"the population table's labels {list(labels)} are not stage {stage.name}'s "
                f"{list(stage.populations)}"
            )
        elif pairs != identity.populations:
            problems.append(
                f"the population table maps {sorted(set(pairs) - set(identity.populations))}, where the "
                f"identity's populations map {sorted(set(identity.populations) - set(pairs))}"
            )
    if problems:
        raise RecountError("the job cannot start: " + "; ".join(problems))


def _check_resume(existing: Ledger, job: Job, identity: JobIdentity, path: Path) -> None:
    if existing.job != job:
        raise RecountError(f"{path} is the ledger of {existing.job.job_id}, not of {job.job_id}")
    differ = [
        f.name for f in fields(JobIdentity) if getattr(existing.identity, f.name) != getattr(identity, f.name)
    ]
    if differ:
        raise RecountError(
            f"{path}: {job.job_id} began under another identity ({', '.join(differ)}); a job resumes "
            "only under the identity it began with, so start a new ingest_version or remove the ledger and "
            "its bins"
        )


def _check_source(job: Job, source: str) -> None:
    """``source`` has records on the job's chromosome, declared at GRCh38's length (Decision 5)."""
    contigs = native.indexed_contigs(source)
    if job.chrom not in contigs:
        raise RecountError(
            f"{source} has no records on {job.chrom}: wrong file for this job? Its index holds "
            f"{list(contigs)}"
        )
    length, expected = native.header_contig_lengths(source).get(job.chrom), GRCH38_LENGTHS[job.chrom]
    if length != expected:
        raise RecountError(
            f"{source}: ##contig {job.chrom} has length {length}, where GRCh38's is {expected}"
        )


def _check_upstream(cited: CitedFile) -> None:
    """The object at the cited URL is still the one cited (D17): a replaced object stops the job."""
    found = head_identity(cited.url)
    wrong = [
        f"{name} {getattr(found, name)}, cited {getattr(cited, name)}"
        for name in _UPSTREAM
        if getattr(found, name) != getattr(cited, name)
    ]
    if wrong:
        raise RecountError(
            f"{cited.url} is not the object this job cites ({'; '.join(wrong)}): gnomAD replaced it"
        )


def _file_sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run_job(
    job: Job,
    identity: JobIdentity,
    *,
    source: str,
    stage: Stage,
    table: pd.DataFrame,
    out_root: Path,
    ledger_path: Path,
    workdir: Path,
) -> Ledger:
    """Recount ``job`` from ``source`` (``identity.vcf.url``, or a local copy of it) into bins under
    ``out_root``, resuming from the ledger at ``ledger_path``; the complete ledger.

    Every refusal comes before a file is written. Each bin is written, then recorded; a bin whose file has
    its recorded sha256 is skipped, and any other recorded bin must be rewritten to its recorded entry.
    """
    _check_identity(identity, stage, table)
    existing = read_ledger(ledger_path)
    if existing is not None:
        _check_resume(existing, job, identity, ledger_path)
    _check_source(job, source)
    remote = identity.vcf.url.startswith(("https://", "http://"))
    if remote:
        _check_upstream(identity.vcf)
    lookup = lookup_set(SOURCE, identity.ingest_version, GRCH38_LENGTHS)
    bins = dict(existing.bins) if existing is not None else {}
    for b in job.bins:
        recorded = bins.get(b)
        if recorded is not None and _file_sha256(out_root / recorded.file.path) == recorded.file.sha256:
            continue
        ref = BinRef(job.chrom, b)
        # Each count runs in a new folder. On macOS, native's [guard] at times stays blocked in read() with
        # no writer left: in 7 of 4,800 counts at FIFO paths used before, 1 of 4,900 at new paths.
        workdir.mkdir(parents=True, exist_ok=True)
        counting = Path(tempfile.mkdtemp(prefix=f"{job.chrom}-bin{b}-", dir=workdir))
        counted = native.native_bin(source, ref, stage, counting)
        shutil.rmtree(counting)
        rows = binned_rows(
            counted.sites,
            table,
            cohort_id=identity.cohort_id,
            ingest_version=identity.ingest_version,
            sampling_design=identity.sampling_design,
            disease_ascertainment_excluded=identity.disease_ascertainment_excluded,
        )
        file = write_bin(
            rows,
            out_root,
            lookup,
            ref,
            git_sha=identity.git_sha,
            inputs=identity.registry_inputs,
            sources=identity.sources,
        )
        entry = BinEntry(file, counted.tally, counted.ploidy_runs)
        if recorded is not None and entry != recorded:
            raise RecountError(
                f"{file.path}: non-deterministic rewrite: it now has sha256 {file.sha256} and {file.rows} "
                f"rows, where the ledger records {recorded.file.sha256} and {recorded.file.rows}"
            )
        bins[b] = entry
        if len(bins) < len(job.bins):  # the bin completing the job waits for the second HEAD
            write_ledger(ledger_path, Ledger(job, identity, dict(bins)))
    if remote:
        _check_upstream(identity.vcf)
    ledger = Ledger(job, identity, bins)
    write_ledger(ledger_path, ledger)
    return ledger


def _totals(bins: Mapping[BinRef, BinEntry]) -> tuple[Tally, int, int]:
    entries = list(bins.values())
    tally = functools.reduce(Tally.merge, (entry.tally for entry in entries), Tally())
    return tally, sum(entry.ploidy_runs for entry in entries), sum(entry.file.rows for entry in entries)


@dataclass(frozen=True)
class IngestSummary:
    """The 166 ledgers combined: chr1-00's identity, each chromosome's cited VCF, every bin's entry and their
    totals. Unpublished (O7); ``recount_ingest`` records the totals in ``measured.ingests``."""

    identity: JobIdentity
    inputs: dict[str, CitedFile]
    bins: dict[BinRef, BinEntry]
    tally: Tally
    ploidy_runs: int
    rows: int
    source_record_id_template: str

    def __post_init__(self) -> None:
        if (self.tally, self.ploidy_runs, self.rows) != _totals(self.bins):
            raise RecountError("an ingest summary's tally, ploidy runs and rows are the sums of its bins'")


def combine_ledgers(ledgers: Sequence[Ledger]) -> IngestSummary:
    """The 166 planned jobs' complete ledgers as one ``IngestSummary``; every problem is listed at once."""
    planned = {job.job_id: job for job in plan_jobs()}
    rank = {job_id: i for i, job_id in enumerate(planned)}

    def in_plan_order(job_ids: Collection[str]) -> list[str]:
        return sorted(job_ids, key=lambda job_id: (rank.get(job_id, len(rank)), job_id))

    by_id: dict[str, Ledger] = {}
    for ledger in ledgers:
        by_id.setdefault(ledger.job.job_id, ledger)
    repeated = [job_id for job_id, n in Counter(ledger.job.job_id for ledger in ledgers).items() if n > 1]
    present = [by_id[job_id] for job_id in in_plan_order(by_id)]
    problems = [
        f"{what} jobs: {found}"
        for what, found in (
            ("missing", [job_id for job_id in planned if job_id not in by_id]),
            ("unexpected", [led.job.job_id for led in present if planned.get(led.job.job_id) != led.job]),
            ("repeated", in_plan_order(repeated)),
            ("incomplete", [led.job.job_id for led in present if not led.complete]),
        )
        if found
    ]
    compared = [f.name for f in fields(JobIdentity) if f.name != "vcf"]
    for ledger in present[1:]:
        differ = [
            name for name in compared if getattr(ledger.identity, name) != getattr(present[0].identity, name)
        ]
        if differ:
            problems.append(f"{ledger.job.job_id}: {', '.join(differ)} unlike {present[0].job.job_id}'s")
    dirty = [
        ledger.job.job_id
        for ledger in present
        if not writer.GIT_SHA_PATTERN.fullmatch(ledger.identity.git_sha)
    ]
    if dirty:
        problems.append(f"jobs {dirty} ran on a dirty tree, not a commit (D17 records our code's commit)")
    vcfs: dict[str, set[CitedFile]] = {}
    for ledger in present:
        vcfs.setdefault(ledger.job.chrom, set()).add(ledger.identity.vcf)
    for chrom, found in vcfs.items():
        if len(found) > 1:
            problems.append(
                f"{'two' if len(found) == 2 else len(found)} VCFs for {chrom}: {sorted(map(str, found))}"
            )
        elsewhere = sorted({item.url for item in found} - {GNOMAD_VCF_URL.format(chrom=chrom)})
        if elsewhere:
            problems.append(f"{chrom}: {elsewhere} is not the gnomAD v3.1.2 URL for {chrom}")
    if problems:
        raise RecountError("the ledgers do not combine: " + "; ".join(problems))
    bins = {BinRef(job.chrom, b): by_id[job_id].bins[b] for job_id, job in planned.items() for b in job.bins}
    inputs = {chrom: next(iter(vcfs[chrom])) for chrom in GRCH38_LENGTHS}
    return IngestSummary(by_id["chr1-00"].identity, inputs, bins, *_totals(bins), SOURCE_RECORD_ID_TEMPLATE)


_SUMMARY_KEYS = (
    "schema",
    "identity",
    "inputs",
    "bins",
    "tally",
    "ploidy_runs",
    "rows",
    "source_record_id_template",
)


def write_summary(path: Path, s: IngestSummary) -> None:
    """``s`` as ``SUMMARY_SCHEMA`` JSON at ``path``: atomic, sorted keys and no timestamps."""
    payload = {
        "schema": SUMMARY_SCHEMA,
        "identity": asdict(s.identity),
        "inputs": {chrom: asdict(cited) for chrom, cited in s.inputs.items()},
        "bins": [{"chrom": ref.chrom, "bin": ref.bin, **_entry_json(entry)} for ref, entry in s.bins.items()],
        "tally": s.tally.to_json(),
        "ploidy_runs": s.ploidy_runs,
        "rows": s.rows,
        "source_record_id_template": s.source_record_id_template,
    }
    _write_json(path, payload)


def read_summary(path: Path) -> IngestSummary:
    """The summary ``write_summary`` wrote at ``path``; its totals must be its bins' sums."""
    try:
        d = _read_json(path, SUMMARY_SCHEMA, _SUMMARY_KEYS)
        bins = {}
        for item in d["bins"]:
            item = _require_keys(item, ("chrom", "bin", "file", "tally", "ploidy_runs"), "a summary bin")
            bins[BinRef(item["chrom"], item["bin"])] = _entry_from_json(
                {key: item[key] for key in ("file", "tally", "ploidy_runs")}
            )
        if len(bins) != len(d["bins"]):
            raise RecountError("a bin is listed twice")
        return IngestSummary(
            _identity_from_json(d["identity"]),
            {chrom: _cited_from_json(cited) for chrom, cited in d["inputs"].items()},
            bins,
            Tally.from_json(d["tally"]),
            d["ploidy_runs"],
            d["rows"],
            d["source_record_id_template"],
        )
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise RecountError(f"{path}: not a {SUMMARY_SCHEMA} summary: {error}") from error


def recount_ingest(summary: IngestSummary) -> measured.Ingest:
    """The ``measured.ingests`` row of the recount: its lookup set, the cited inputs, the totals, the refusals
    per population and reason (O11), and the sample rule (D17)."""
    identity, tally = summary.identity, summary.tally
    ids = dict(identity.populations)
    unknown = sorted(({label for label, _ in tally.refusals} | set(tally.an_zero)) - set(ids))
    if unknown:
        raise RecountError(f"the tally counts labels {unknown}, which are not the identity's populations")
    refusals = [
        *(
            measured.Refusal(reason, ids[label], n)
            for (label, reason), n in sorted(tally.refusals.items())
            if n
        ),
        *(measured.Refusal("an_zero", ids[label], n) for label, n in sorted(tally.an_zero.items()) if n),
        *(measured.Refusal(f"non_pass:{name}", None, n) for name, n in sorted(tally.non_pass.items()) if n),
    ]
    if tally.monomorphic_in_stage:
        refusals.append(measured.Refusal("monomorphic_in_stage", None, tally.monomorphic_in_stage))
    metadata = {cited.url: cited for cited in (identity.metadata, identity.karyotypes)}
    if len(metadata) == 1 and identity.metadata != identity.karyotypes:
        raise RecountError(f"{identity.metadata.url} is cited as metadata and karyotypes with two identities")
    inputs = (
        *(
            measured.IngestInput(bytes=f.size, url=f.url, md5=f.md5, generation=f.generation)
            for f in summary.inputs.values()
        ),
        *(
            measured.IngestInput(bytes=f.size, url=f.url, md5=f.md5, generation=f.generation, sha256=f.sha256)
            for f in metadata.values()
        ),
    )
    return measured.Ingest(
        table=BINNED_TABLE,
        source=SOURCE,
        ingest_version=identity.ingest_version,
        registry_version=identity.registry_version,
        adapter=ADAPTER,
        adapter_git_sha=identity.git_sha,
        inputs=inputs,
        n_rows=summary.rows,
        refusals=tuple(refusals),
        source_record_id_template=summary.source_record_id_template,
        sample_rule=identity.cohort_id,
        sample_stage_sha256=identity.stage_sha256,
    )
