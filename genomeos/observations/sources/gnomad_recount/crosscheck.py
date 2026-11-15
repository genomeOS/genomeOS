"""Check 12's independent cross-check of the native recount (Atlas data platform design 2026-10-18 §2.7
check 12, §1.2 D18 and §2.10; builder's call 38).

The native bcftools count is the build; the independent Python counter (``counter.recount_python`` over
``native.query_bin``) recounts sampled bins and must match it cell for cell. A cell is one population at one
written record: ``variant_id``, ``source_label``, ``ac`` and ``an``, with ``an > 0`` (D18 item 5).

- ``choose_check_bins`` samples the bins: ``REQUIRED_BINS`` (rs334's autosomal bin, a chrX PAR bin, a chrX
  non-PAR bin, a bin straddling a chrX PAR edge and a chrY bin), the autosomal bin richest in PASS records
  that are not SNVs, and ``extra`` autosomal bins drawn with ``SEED``. It is the module's only stochastic
  path, and the same tallies give the same bins whatever their order.
- ``crosscheck_bin`` recounts one written bin natively and independently. The published file (the one its
  ledger records, by sha256), the independent cells and tally, and the recorded tally must each equal the
  fresh native count, and an audit must have checked ploidy wherever there are PASS records; otherwise it
  raises a ``RecountError`` listing up to ``MAX_LISTED`` problems.
- ``compare_counters`` runs both counters over any region and reports how far they agree, without raising:
  the measured windows of §2.10 and the script's ``compare``.

Offline batch work, never the serving path; the counts are ``ac`` and ``an``, never a frequency.
"""

from __future__ import annotations

import hashlib
import random
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from pathlib import Path

import numpy as np
import pandas as pd

from genomeos.observations.sources.gnomad_recount import native
from genomeos.observations.sources.gnomad_recount.jobs import BinEntry
from genomeos.observations.sources.gnomad_recount.rule import (
    RecountError,
    SiteCounts,
    Stage,
    Tally,
    bin_region,
)
from genomeos.tables.binned import read_bin_cells
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, bin_range, parse_bin_path

__all__ = (
    "CELL_COLUMNS",
    "MAX_LISTED",
    "REQUIRED_BINS",
    "SEED",
    "CrosscheckResult",
    "choose_check_bins",
    "compare_cells",
    "compare_counters",
    "crosscheck_bin",
    "site_cells",
)

SEED = 42
#: The bins check 12 always recounts: rs334's (autosomal), a chrX PAR bin, a chrX non-PAR bin, a bin
#: straddling a chrX PAR edge and a chrY non-PAR bin.
REQUIRED_BINS = (
    BinRef("chr11", 5),
    BinRef("chrX", 1),
    BinRef("chrX", 100),
    BinRef("chrX", 155),
    BinRef("chrY", 14),
)
#: How many problems a ``crosscheck_bin`` error lists.
MAX_LISTED = 5
CELL_COLUMNS = ("variant_id", "source_label", "ac", "an")
_KEY = ["variant_id", "source_label"]
_KARYOTYPE_ORDER = {chrom: i for i, chrom in enumerate(GRCH38_LENGTHS)}


def _genome_order(ref: BinRef) -> tuple[int, int]:
    return _KARYOTYPE_ORDER[ref.chrom], ref.bin


def _name(ref: BinRef) -> str:
    return f"{ref.chrom}:{ref.bin}"


def choose_check_bins(
    bins: Mapping[BinRef, Tally], *, extra: int = 3, seed: int = SEED
) -> tuple[BinRef, ...]:
    """The bins check 12 recounts, without duplicates: ``REQUIRED_BINS``, each of which must hold PASS
    records; the autosomal bin with the most PASS records that are not SNVs (ties to the earliest in GRCh38
    order); and ``extra`` bins drawn by ``random.Random(seed).sample`` from the other autosomal bins with
    written sites, sorted in GRCh38 order before the draw."""
    regions = {ref: bin_region(ref) for ref in bins}
    empty = [_name(ref) for ref in REQUIRED_BINS if ref not in bins or bins[ref].pass_records == 0]
    if empty:
        raise RecountError(
            f"check 12 recounts {', '.join(empty)}, which hold no PASS records: it needs rs334's bin, a chrX "
            "PAR bin, a chrX non-PAR bin, a bin straddling a PAR edge and a chrY bin (§2.7)"
        )
    autosomal = sorted((ref for ref, region in regions.items() if region == "autosome"), key=_genome_order)
    richest = max(autosomal, key=lambda ref: bins[ref].pass_non_snv, default=None)
    if richest is None or bins[richest].pass_non_snv == 0:
        raise RecountError(
            "no autosomal bin holds a PASS record that is not an SNV, so none is rich in indels (§2.7)"
        )
    chosen = list(dict.fromkeys((*REQUIRED_BINS, richest)))
    pool = [ref for ref in autosomal if ref not in chosen and bins[ref].written_sites > 0]
    if isinstance(extra, bool) or not isinstance(extra, int) or not 0 <= extra <= len(pool):
        raise RecountError(
            f"extra {extra!r} bins cannot be drawn from the {len(pool)} other written autosomal bins"
        )
    return (*chosen, *random.Random(seed).sample(pool, extra))


def site_cells(sites: Sequence[SiteCounts], stage: Stage) -> pd.DataFrame:
    """``sites``' cells, by site and then in ``stage.populations``' order: ``variant_id``,
    ``source_label``, ``ac`` and ``an``, one per population whose ``an`` is above 0."""
    populations = stage.populations
    wrong = sum(1 for site in sites if len(site.an) != len(populations))
    if wrong:
        raise RecountError(
            f"{wrong} site(s) count other than stage {stage.name}'s {len(populations)} populations"
        )
    shape = (len(sites), len(populations))
    ac = np.array([site.ac for site in sites], dtype=np.int64).reshape(shape)
    an = np.array([site.an for site in sites], dtype=np.int64).reshape(shape)
    site_at, population_at = np.nonzero(an > 0)
    return pd.DataFrame(
        {
            "variant_id": np.array([site.variant_id for site in sites], dtype=object)[site_at],
            "source_label": np.array(populations, dtype=object)[population_at],
            "ac": ac[site_at, population_at],
            "an": an[site_at, population_at],
        }
    )


def _cells(frame: pd.DataFrame, name: str) -> pd.DataFrame:
    absent = [column for column in CELL_COLUMNS if column not in frame.columns]
    if absent:
        raise RecountError(f"the {name} cells lack the column(s) {absent}")
    return frame.loc[:, list(CELL_COLUMNS)]


def _merged(expected: pd.DataFrame, actual: pd.DataFrame) -> pd.DataFrame:
    """The outer join of two frames of unique cells on ``(variant_id, source_label)``, sorted by it: their
    ``ac`` and ``an`` suffixed ``_native`` and ``_other``, where each cell is ``held`` (``both``,
    ``left_only`` for the native cells alone, ``right_only`` for the other's), and whether it is the ``same``
    in both."""
    try:
        merged = expected.merge(
            actual, on=_KEY, how="outer", suffixes=("_native", "_other"), indicator="held", sort=True,
            validate="one_to_one",
        )
    except pd.errors.MergeError as error:
        raise RecountError(f"a counter repeats a cell: {error}") from error
    merged["same"] = (
        merged["held"].eq("both")
        & merged["ac_native"].eq(merged["ac_other"])
        & merged["an_native"].eq(merged["an_other"])
    )
    return merged


def compare_cells(label: str, expected: pd.DataFrame, actual: pd.DataFrame) -> list[str]:
    """Every difference between ``expected``, the native count's cells, and ``label``'s ``actual`` cells,
    whatever their row order: a repeated cell, a cell only in one of them, or a cell whose ``ac`` or ``an``
    differs. Empty when they hold the same cells."""
    named = (("native", _cells(expected, "native")), (label, _cells(actual, label)))
    problems = [
        f"{label}: {variant_id} {source_label} is repeated in the {name} cells"
        for name, frame in named
        for variant_id, source_label in frame.loc[frame.duplicated(_KEY), _KEY].drop_duplicates().itertuples(
            index=False
        )
    ]
    if problems:
        return problems
    merged = _merged(named[0][1], named[1][1])
    differ = merged.loc[~merged["same"]]
    columns = ("variant_id", "source_label", "held", "ac_native", "an_native", "ac_other", "an_other")
    for variant_id, source_label, held, ac, an, other_ac, other_an in zip(
        *(differ[column].to_numpy() for column in columns), strict=True
    ):
        where = f"{label}: {variant_id} {source_label}"
        native_counts, other_counts = f"ac {ac:.0f}, an {an:.0f}", f"ac {other_ac:.0f}, an {other_an:.0f}"
        if held == "left_only":
            problems.append(f"{where} only in the native count ({native_counts})")
        elif held == "right_only":
            problems.append(f"{where} only in the {label} count ({other_counts})")
        else:
            problems.append(f"{where}: native {native_counts}; {label} {other_counts}")
    return problems


def _tally_problems(label: str, expected: Tally, actual: Tally) -> list[str]:
    """Each field (and each key of a counted field) where ``label``'s tally differs from the native one."""
    problems = []
    for item in fields(Tally):
        mine, theirs = getattr(expected, item.name), getattr(actual, item.name)
        if isinstance(mine, Counter):
            mine, theirs = +mine, +theirs
            for key in sorted(set(mine) | set(theirs)):
                if mine[key] != theirs[key]:
                    shown = " ".join(key) if isinstance(key, tuple) else key
                    problems.append(
                        f"{label} tally {item.name} {shown}: native {mine[key]}, {label} {theirs[key]}"
                    )
        elif mine != theirs:
            problems.append(f"{label} tally {item.name}: native {mine}, {label} {theirs}")
    return problems


@dataclass(frozen=True)
class CrosscheckResult:
    """Both counters over ``chrom:start-end``: the cells either wrote, how many are identical in both, whether
    the tallies are equal, and the native count's PASS records that are not SNVs."""

    chrom: str
    start: int
    end: int
    cells: int
    identical: int
    tally_equal: bool
    pass_non_snv: int


def _file_sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def crosscheck_bin(
    entry: BinEntry, ref: BinRef, *, vcf: str, stage: Stage, out_root: Path, workdir: Path
) -> CrosscheckResult:
    """Check 12 on ``ref``, written as ``entry`` under ``out_root``: recount it natively and independently
    from ``vcf``. The published cells, the independent cells and tally, and the recorded tally must each
    equal the native count, and ploidy must have been audited wherever there are PASS records."""
    try:
        start, end = bin_range(ref)
    except ValueError as error:
        raise RecountError(str(error)) from error
    parsed = parse_bin_path(entry.file.path)
    if parsed is None or parsed[2] != ref:
        raise RecountError(f"{entry.file.path} is not the file of {_name(ref)}")
    path = out_root / entry.file.path
    found = _file_sha256(path)
    if found != entry.file.sha256:
        raise RecountError(
            f"{path}: {'missing' if found is None else f'sha256 {found}'}, where the ledger records "
            f"{entry.file.sha256}: not the published file"
        )
    counted = native.native_bin(vcf, ref, stage, workdir)
    sites, tally = native.query_bin(vcf, ref, stage, workdir)
    cells = site_cells(counted.sites, stage)
    problems = [
        *compare_cells("published", cells, read_bin_cells(path)),
        *compare_cells("independent", cells, site_cells(sites, stage)),
        *_tally_problems("independent", counted.tally, tally),
        *_tally_problems("recorded", counted.tally, entry.tally),
        *(
            f"{name}: {audited.pass_records} PASS record(s) and no +check-ploidy run (D18 item 4)"
            for name, audited, runs in (
                ("native", counted.tally, counted.ploidy_runs),
                ("recorded", entry.tally, entry.ploidy_runs),
            )
            if audited.pass_records and not runs
        ),
    ]
    if problems:
        more = f"; and {len(problems) - MAX_LISTED} more" if len(problems) > MAX_LISTED else ""
        raise RecountError(
            f"check 12 fails on {_name(ref)}: {'; '.join(problems[:MAX_LISTED])}{more} (§2.7)"
        )
    return CrosscheckResult(ref.chrom, start, end, len(cells), len(cells), True, counted.tally.pass_non_snv)


def compare_counters(
    vcf: str, chrom: str, start: int, end: int, stage: Stage, workdir: Path
) -> CrosscheckResult:
    """Both counters over ``chrom:start-end`` (1-based, inclusive, by POS), compared without raising.
    ``cells`` counts every cell either counter wrote, so ``identical == cells`` only when both wrote the same
    cells with the same ``ac`` and ``an``."""
    counted = native.native_region(vcf, chrom, start, end, stage, workdir)
    sites, tally = native.query_region(vcf, chrom, start, end, stage, workdir)
    merged = _merged(site_cells(counted.sites, stage), site_cells(sites, stage))
    identical = int(np.count_nonzero(merged["same"].to_numpy()))
    return CrosscheckResult(
        chrom, start, end, len(merged), identical, counted.tally == tally, counted.tally.pass_non_snv
    )
