"""D18's recount rule as code (Atlas data platform design 2026-10-18 §1.2 D18, §2.10).

D18's rule in §1.2 is the binding text; this module states it once, for both counters (§2.10, call 38):

- item 1, input and stage: gnomAD v3.1.2's 24 HGDP + 1KG VCFs (chr1-22, X, Y; no chrM file) and a named
  sample stage, each sample's population the metadata's literal ``population`` field (``read_stage``);
- item 2, records: PASS records are counted, others tallied per FILTER; a second ALT, a ``*`` ALT or an
  allele index above 1 fails the build on every record, PASS or not (the plan's Decision 2);
- item 3, calls: GQ >= 20, DP >= 10 (>= 5 haploid) and, for a heterozygote, each AD / DP >= 0.2; a failing
  or missing call lowers ``an`` and is counted per population and reason, in ``REFUSAL_REASONS``' order;
  a partial genotype fails the build (``assess_call``);
- item 4, sex chromosomes: ploidy follows ``gnomad_sex_imputation.sex_karyotype`` (XX and XY only) and
  Hail 0.2.77's GRCh38 PARs; a record in a chrY PAR, or a called genotype of another ploidy, fails the
  build (``segment``, ``expected_ploidy``);
- item 5, sites and cells: a PASS record is written if its ``ac`` is above 0 in the stage, else counted
  as ``monomorphic_in_stage``; a written cell with ``an = 0`` is counted per population, not written
  (``Tally.record_pass``).

Every hard error is a ``RecountError`` naming the D18 item it enforces; it reports values and counts,
never a sample id. Pure: no I/O.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, bin_range
from genomeos.validation.reference_cohorts import METADATA_SHA256, PAPER_SAMPLES_SHA256, PAPER_STAGE

__all__ = (
    "DP_MIN_DIPLOID",
    "DP_MIN_HAPLOID",
    "GNOMAD_RELEASE",
    "GNOMAD_VCF_URL",
    "GQ_MIN",
    "KARYOTYPES",
    "METADATA_URL",
    "REFUSAL_REASONS",
    "RULE_ID",
    "SAMPLE_META_URL",
    "X_PARS",
    "Y_PARS",
    "CallOutcome",
    "RecountError",
    "SiteCounts",
    "Stage",
    "StageSample",
    "Tally",
    "assess_call",
    "bin_region",
    "check_allele_indices",
    "check_record",
    "denominators",
    "expected_ploidy",
    "read_stage",
    "segment",
)

GNOMAD_RELEASE = "v3.1.2"
RULE_ID = "d18-v1"
GQ_MIN, DP_MIN_DIPLOID, DP_MIN_HAPLOID = 20, 10, 5
GNOMAD_VCF_URL = (
    "https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1.2/vcf/genomes/"
    "gnomad.genomes.v3.1.2.hgdp_tgp.{chrom}.vcf.bgz"
)
#: The pilot's metadata (``reference_cohorts.METADATA_SHA256``): ``s`` and the literal ``population``.
METADATA_URL = (
    "https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1/secondary_analyses/hgdp_1kg_v2/"
    "metadata_and_qc/gnomad_meta_updated.tsv"
)
#: The sample-meta file: ``s`` and ``gnomad_sex_imputation``, D18 item 4's karyotype authority.
SAMPLE_META_URL = (
    "https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1.2/vcf/genomes/"
    "gnomad.genomes.v3.1.2.hgdp_1kg_subset_sample_meta.tsv.bgz"
)
#: The PARs of Hail 0.2.77's GRCh38 reference, 1-based and inclusive (D18 item 4).
X_PARS = ((10_001, 2_781_479), (155_701_383, 156_030_895))
Y_PARS = ((10_001, 2_781_479), (56_887_903, 57_217_415))
KARYOTYPES = ("XX", "XY")
#: D18 item 3's refusal reasons, in the order a call is tested.
REFUSAL_REASONS = ("missing", "low_gq", "low_dp", "low_allele_balance")

Segment = Literal["autosome", "x_par", "x_nonpar", "y_par", "y_nonpar"]
Region = Literal["autosome", "par", "nonpar", "straddles_par"]

_STAGE_NAME = re.compile(r"[a-z0-9][a-z0-9_-]*")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_NATURAL = re.compile(r"[0-9]+")
_BASES = re.compile(r"[ACGT]+")
_ALLELE_SEPARATOR = re.compile(r"[/|]")
_MISSING_GENOTYPES = frozenset({".", "./.", ".|."})
_JSON_KARYOTYPE = "gnomad_sex_imputation"
_FLAT_KARYOTYPE = "gnomad_sex_imputation.sex_karyotype"
_TALLY_COUNTS = ("pass_records", "pass_non_snv", "monomorphic_in_stage", "written_sites")
_TALLY_KEYS = frozenset({"non_pass", "refusals", "an_zero", *_TALLY_COUNTS})


class RecountError(ValueError):
    """The recount's inputs or a record break D18's rule: the build fails (v1 §12)."""


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _check_karyotypes(karyotypes: Iterable[str]) -> None:
    others = Counter(k for k in karyotypes if k not in KARYOTYPES)
    if others:
        listed = ", ".join(f"{k}: {n}" for k, n in sorted(others.items()))
        raise RecountError(
            f"{others.total()} sample(s) have a karyotype other than XX or XY ({listed}); gnomAD "
            "hard-filters them, and a stage that keeps any fails the build for the owner to decide "
            "(D18 item 4)"
        )


@dataclass(frozen=True)
class StageSample:
    sample_id: str
    population: str
    karyotype: str


@dataclass(frozen=True)
class Stage:
    """A named sample stage, sorted by sample id; ``ids_sha256`` is the stage file's digest (D18 item 1)."""

    name: str
    samples: tuple[StageSample, ...]
    ids_sha256: str

    def __post_init__(self) -> None:
        if not _STAGE_NAME.fullmatch(self.name):
            raise RecountError(f"stage name {self.name!r} must match {_STAGE_NAME.pattern}")
        ids = [sample.sample_id for sample in self.samples]
        if not ids:
            raise RecountError("a stage holds at least one sample")
        if ids != sorted(set(ids)):
            raise RecountError("stage samples must be sorted by sample id and unique")
        _check_karyotypes(sample.karyotype for sample in self.samples)
        if not _SHA256.fullmatch(self.ids_sha256):
            raise RecountError("ids_sha256 must be 64 lowercase hex characters")

    @property
    def sample_ids(self) -> tuple[str, ...]:
        return tuple(sample.sample_id for sample in self.samples)

    @property
    def populations(self) -> tuple[str, ...]:
        """The literal population labels, sorted: the order of every ``ac`` and ``an`` tuple."""
        return tuple(sorted({sample.population for sample in self.samples}))


def _lines(raw: bytes, what: str) -> list[str]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RecountError(f"the {what} must be UTF-8") from error
    if not text.endswith("\n") or "\r" in text:
        raise RecountError(f"the {what} must be LF-terminated lines")
    return text[:-1].split("\n")


def _read_stage_ids(raw: bytes) -> list[str]:
    ids = _lines(raw, "stage ids")
    blank = sum(1 for value in ids if not value or value != value.strip() or "\t" in value)
    if blank:
        raise RecountError(f"the stage ids have {blank} blank or padded line(s)")
    if ids != sorted(ids):
        raise RecountError("the stage ids must be sorted")
    if len(set(ids)) != len(ids):
        raise RecountError(f"the stage ids must be unique ({len(ids) - len(set(ids))} repeated)")
    return ids


def _read_tsv(raw: bytes, what: str) -> tuple[list[str], list[list[str]]]:
    header, *lines = _lines(raw, what)
    names = header.split("\t")
    if len(set(names)) != len(names) or not all(names):
        raise RecountError(f"the {what} header has blank or repeated columns")
    rows = [line.split("\t") for line in lines]
    for n, row in enumerate(rows, start=2):
        if len(row) != len(names):
            raise RecountError(f"line {n} of the {what} has {len(row)} fields, its header {len(names)}")
    return names, rows


def _stage_column(
    table: tuple[list[str], list[list[str]]], column: str, ids: Sequence[str], what: str
) -> list[str]:
    """``column``'s value for each stage sample, joined on ``s``; no other column is read."""
    names, rows = table
    absent = [name for name in ("s", column) if name not in names]
    if absent:
        raise RecountError(f"the {what} lack the column(s) {absent}")
    s, c = names.index("s"), names.index(column)
    by_sample: dict[str, str] = {}
    for row in rows:
        by_sample.setdefault(row[s], row[c])
    if len(by_sample) != len(rows):
        raise RecountError(f"the {what} repeat {len(rows) - len(by_sample)} sample id(s)")
    missing = sum(1 for sample in ids if sample not in by_sample)
    if missing:
        raise RecountError(f"{missing} stage sample(s) are missing from the {what}")
    values = [by_sample[sample] for sample in ids]
    blank = sum(1 for value in values if value in ("", "NA") or value != value.strip())
    if blank:
        raise RecountError(f"{blank} stage sample(s) have no {column} in the {what}")
    return values


def _karyotype(cell: str) -> str:
    try:
        value = json.loads(cell)
    except json.JSONDecodeError:
        value = None
    karyotype = value.get("sex_karyotype") if isinstance(value, dict) else None
    if not isinstance(karyotype, str):
        raise RecountError(f"a stage sample's {_JSON_KARYOTYPE} has no sex_karyotype string (D18 item 4)")
    return karyotype


def read_stage(metadata: bytes, karyotypes: bytes, stage_ids: bytes, *, name: str) -> Stage:
    """The stage ``name``: ``stage_ids`` (sorted, LF-terminated), populations from ``metadata``'s literal
    ``population`` column, karyotypes from ``karyotypes``' ``gnomad_sex_imputation`` (JSON) or
    ``gnomad_sex_imputation.sex_karyotype`` (flat) column (D18 items 1 and 4).

    The paper's stage must be the paper's 4,094 over the pilot's metadata, checked by digest first.
    """
    if name == PAPER_STAGE:
        if _sha256(stage_ids) != PAPER_SAMPLES_SHA256:
            raise RecountError(f"stage {PAPER_STAGE}'s ids do not match PAPER_SAMPLES_SHA256 (D18 item 1)")
        if _sha256(metadata) != METADATA_SHA256:
            raise RecountError(f"stage {PAPER_STAGE}'s metadata does not match METADATA_SHA256 (D18 item 1)")
    if not _STAGE_NAME.fullmatch(name):
        raise RecountError(f"stage name {name!r} must match {_STAGE_NAME.pattern}")
    ids = _read_stage_ids(stage_ids)
    populations = _stage_column(_read_tsv(metadata, "metadata"), "population", ids, "metadata")
    table = _read_tsv(karyotypes, "karyotypes")
    forms = [column for column in (_JSON_KARYOTYPE, _FLAT_KARYOTYPE) if column in table[0]]
    if len(forms) != 1:
        raise RecountError(
            f"the karyotypes must have exactly one of {_JSON_KARYOTYPE} and {_FLAT_KARYOTYPE}; "
            f"they have {'both' if forms else 'neither'} (D18 item 4)"
        )
    cells = _stage_column(table, forms[0], ids, "karyotypes")
    sexes = cells if forms[0] == _FLAT_KARYOTYPE else [_karyotype(cell) for cell in cells]
    samples = tuple(StageSample(*values) for values in zip(ids, populations, sexes, strict=True))
    return Stage(name, samples, _sha256(stage_ids))


def segment(chrom: str, pos: int) -> Segment:
    """Where ``chrom:pos`` falls under D18 item 4; a chromosome outside the 24 files is item 1's error."""
    length = GRCH38_LENGTHS.get(chrom)
    if length is None:
        raise RecountError(
            f"{chrom!r} is not one of D18's 24 inputs, chr1-22, X and Y (there is no chrM file) (D18 item 1)"
        )
    if isinstance(pos, bool) or not isinstance(pos, int) or not 1 <= pos <= length:
        raise RecountError(f"position {pos!r} is outside {chrom} (1-{length})")
    if chrom == "chrX":
        return "x_par" if any(lo <= pos <= hi for lo, hi in X_PARS) else "x_nonpar"
    if chrom == "chrY":
        return "y_par" if any(lo <= pos <= hi for lo, hi in Y_PARS) else "y_nonpar"
    return "autosome"


def bin_region(ref: BinRef) -> Region:
    """Whether a 1 Mb bin is autosomal, inside one PAR, outside every PAR, or straddles a PAR's edge."""
    try:
        lo, hi = bin_range(ref)
    except ValueError as error:
        raise RecountError(str(error)) from error
    pars = {"chrX": X_PARS, "chrY": Y_PARS}.get(ref.chrom)
    if pars is None:
        return "autosome"
    if any(start <= lo and hi <= end for start, end in pars):
        return "par"
    if any(start <= hi and lo <= end for start, end in pars):
        return "straddles_par"
    return "nonpar"


def expected_ploidy(seg: str, karyotype: str) -> int:
    """The alleles a called genotype carries in ``seg`` for ``karyotype`` (D18 item 4); 0 means absent."""
    _check_karyotypes((karyotype,))
    if seg in ("autosome", "x_par"):
        return 2
    if seg == "x_nonpar":
        return 2 if karyotype == "XX" else 1
    if seg == "y_nonpar":
        return 0 if karyotype == "XX" else 1
    if seg == "y_par":
        raise RecountError("chrY's PARs hold no records: their variation is called on chrX (D18 item 4)")
    raise RecountError(f"unknown segment {seg!r}")


def denominators(stage: Stage, seg: str) -> tuple[int, ...]:
    """Per population, in ``stage.populations``' order, the samples ``seg`` counts (XX is absent on chrY)."""
    counted = Counter(s.population for s in stage.samples if expected_ploidy(seg, s.karyotype) > 0)
    return tuple(counted[population] for population in stage.populations)


def check_record(chrom: str, pos: int, ref: str, alt: str) -> None:
    """D18's record checks, on every record whatever its FILTER: items 1 and 2, and item 4's chrY PARs."""
    seg = segment(chrom, pos)
    if "," in alt:
        raise RecountError(f"ALT {alt!r} has a second ALT; the callset is one ALT per record (D18 item 2)")
    if alt == "*":
        raise RecountError("a '*' ALT fails the build (D18 item 2)")
    if not (_BASES.fullmatch(ref) and _BASES.fullmatch(alt)):
        raise RecountError(f"REF {ref!r} and ALT {alt!r} must be bases [ACGT]+ in a variant id (D18 item 2)")
    if seg == "y_par":
        raise RecountError("a record in a chrY PAR fails the build: chrX carries the PARs (D18 item 4)")


def check_allele_indices(gt: str) -> list[str]:
    """``gt``'s alleles; any index above 1 fails the build on every record (D18 item 2, Decision 2)."""
    alleles = _ALLELE_SEPARATOR.split(gt)
    if not all(allele == "." or _NATURAL.fullmatch(allele) for allele in alleles):
        raise RecountError(f"invalid GT {gt!r}")
    if any(allele != "." and int(allele) > 1 for allele in alleles):
        raise RecountError(f"genotype {gt!r} has an allele index above 1 (D18 item 2)")
    return alleles


@dataclass(frozen=True)
class CallOutcome:
    """One call's contribution: ``alleles`` to ``an``, ``dosage`` to ``ac``, or the reason it was refused."""

    alleles: int
    dosage: int
    refusal: str | None


def _natural(token: str, what: str) -> int:
    if not _NATURAL.fullmatch(token):
        raise RecountError(f"invalid {what} {token!r}: not a non-negative integer")
    return int(token)


def assess_call(gt: str, gq: str, dp: str, ad: str, *, expected: int) -> CallOutcome:
    """D18 item 3 on one call that ``expected`` (item 4's ploidy) predicts: GT, then GQ, DP and, for a
    diploid heterozygote, AD, each read only when reached. A missing GQ or DP is low."""
    if expected not in (0, 1, 2):
        raise RecountError(f"expected ploidy {expected!r} is not 0, 1 or 2")
    if gt in _MISSING_GENOTYPES:
        return CallOutcome(0, 0, None if expected == 0 else "missing")
    alleles = check_allele_indices(gt)
    if "." in alleles:
        raise RecountError(f"partial genotype {gt!r} (D18 item 3)")
    if len(alleles) != expected:
        raise RecountError(
            f"ploidy: genotype {gt!r} has {len(alleles)} allele(s) where the segment and karyotype give "
            f"{expected} (D18 item 4)"
        )
    dosage = sum(int(allele) for allele in alleles)
    if gq == "." or _natural(gq, "GQ") < GQ_MIN:
        return CallOutcome(0, 0, "low_gq")
    if dp == ".":
        return CallOutcome(0, 0, "low_dp")
    depth = _natural(dp, "DP")
    if depth < (DP_MIN_HAPLOID if expected == 1 else DP_MIN_DIPLOID):
        return CallOutcome(0, 0, "low_dp")
    if expected == 2 and dosage == 1:
        depths = ad.split(",")
        if "." in depths:
            return CallOutcome(0, 0, "low_allele_balance")
        if len(depths) != 2:
            raise RecountError(f"AD {ad!r} has {len(depths)} values where a biallelic heterozygote has 2")
        for token in depths:
            if 5 * _natural(token, "AD") < depth:  # AD / DP < 0.2
                return CallOutcome(0, 0, "low_allele_balance")
    return CallOutcome(expected, dosage, None)


@dataclass(frozen=True)
class SiteCounts:
    """One PASS record's counts: ``ac`` and ``an`` per population, in the stage's population order."""

    chrom: str
    pos: int
    ref: str
    alt: str
    rsid: str | None
    ac: tuple[int, ...]
    an: tuple[int, ...]

    def __post_init__(self) -> None:
        pairs = zip(self.ac, self.an, strict=False)
        if len(self.ac) != len(self.an) or not all(0 <= c <= n for c, n in pairs):
            raise RecountError(f"{self.variant_id}: ac and an must pair up with 0 <= ac <= an")

    @property
    def variant_id(self) -> str:
        return f"{self.chrom}-{self.pos}-{self.ref}-{self.alt}"


def _count(value: object, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RecountError(f"tally {what} must be a non-negative integer")
    return value


def _positive(pairs: Iterable[tuple[Any, object]], what: str) -> Counter[Any]:
    counts: Counter[Any] = Counter()
    for key, value in pairs:
        n = _count(value, what)
        if key in counts or n == 0:
            raise RecountError(f"tally {what} must hold each key once, with a positive count")
        counts[key] = n
    return counts


@dataclass
class Tally:
    """What a recount counts but does not write (D18 items 2, 3 and 5; ``measured.ingests``).

    ``refusals`` is keyed by ``(source_label, reason)`` and ``an_zero`` by ``source_label``. Refusals are
    counted on every PASS record, monomorphic ones included; ``an_zero`` only at written records.
    """

    non_pass: Counter[str] = field(default_factory=Counter)
    pass_records: int = 0
    pass_non_snv: int = 0
    monomorphic_in_stage: int = 0
    written_sites: int = 0
    refusals: Counter[tuple[str, str]] = field(default_factory=Counter)
    an_zero: Counter[str] = field(default_factory=Counter)

    def record_filtered(self, filter_: str) -> None:
        """A non-PASS record, under its whole FILTER value (``AC0;AS_VQSR`` is one key)."""
        if not filter_ or filter_ == "PASS":
            raise RecountError(f"FILTER {filter_!r} is not a non-PASS filter")
        self.non_pass[filter_] += 1

    def record_pass(
        self, site: SiteCounts, refusals: Mapping[tuple[str, str], int], populations: Sequence[str]
    ) -> bool:
        """Count a PASS record and its refusals; True when it is written (D18 item 5)."""
        if len(populations) != len(site.an):
            raise RecountError(f"{site.variant_id}: {len(site.an)} counts for {len(populations)} populations")
        unknown = sum(1 for label, why in refusals if label not in populations or why not in REFUSAL_REASONS)
        if unknown:
            raise RecountError(f"{site.variant_id}: {unknown} refusal(s) outside the stage or D18's reasons")
        self.pass_records += 1
        if len(site.ref) != 1 or len(site.alt) != 1:
            self.pass_non_snv += 1
        self.refusals.update(refusals)
        if sum(site.ac) == 0:
            self.monomorphic_in_stage += 1
            return False
        self.written_sites += 1
        self.an_zero.update(label for label, n in zip(populations, site.an, strict=True) if n == 0)
        return True

    def merge(self, other: Tally) -> Tally:
        """A new tally summing every field of both."""
        return Tally(
            non_pass=self.non_pass + other.non_pass,
            pass_records=self.pass_records + other.pass_records,
            pass_non_snv=self.pass_non_snv + other.pass_non_snv,
            monomorphic_in_stage=self.monomorphic_in_stage + other.monomorphic_in_stage,
            written_sites=self.written_sites + other.written_sites,
            refusals=self.refusals + other.refusals,
            an_zero=self.an_zero + other.an_zero,
        )

    def to_json(self) -> dict[str, Any]:
        """Sorted JSON values; ``refusals`` as ``[source_label, reason, n]`` rows, zero counts left out."""
        return {
            "non_pass": dict(sorted((+self.non_pass).items())),
            **{name: getattr(self, name) for name in _TALLY_COUNTS},
            "refusals": [[label, reason, n] for (label, reason), n in sorted((+self.refusals).items())],
            "an_zero": dict(sorted((+self.an_zero).items())),
        }

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> Tally:
        """The tally ``to_json`` wrote; anything else is refused."""
        if not isinstance(d, Mapping) or set(d) != _TALLY_KEYS:
            raise RecountError(f"a tally has exactly the keys {sorted(_TALLY_KEYS)}")
        rows = d["refusals"]
        if not isinstance(rows, list) or not all(
            isinstance(row, list) and len(row) == 3 and isinstance(row[0], str) and row[1] in REFUSAL_REASONS
            for row in rows
        ):
            raise RecountError("tally refusals must be [source_label, reason, n] rows with D18's reasons")
        if not isinstance(d["non_pass"], dict) or not isinstance(d["an_zero"], dict):
            raise RecountError("tally non_pass and an_zero must be objects")
        return cls(
            non_pass=_positive(d["non_pass"].items(), "non_pass"),
            **{name: _count(d[name], name) for name in _TALLY_COUNTS},
            refusals=_positive((((label, reason), n) for label, reason, n in rows), "refusals"),
            an_zero=_positive(d["an_zero"].items(), "an_zero"),
        )
