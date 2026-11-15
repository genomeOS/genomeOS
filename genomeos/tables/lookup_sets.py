"""Lookup-set geometry: the bin files a lookup set has, and the one URL a variant id computes.

Atlas data platform design 2026-10-18 §2.3, §2.6 and §2.10; builder's calls 29 and 31.

A lookup set is one ingest of ``measured.allele_observations_binned``, stored as one file per chromosome
and 1 Mb bin over the ingest's recorded chromosome set (chr1-22, X and Y for gnomAD: 3,102 bins), every
bin written, empty ones too (call 29). Its path is::

    tables/v1/measured/allele_observations_binned/source=<s>/ingest_version=<iv>/chrom=<c>/bin=<b>/part-0.parquet

with ``bin = pos // BIN_BP`` on 1-based GRCh38 positions, so bin 0 holds positions 1 to 999,999 and a
chromosome of length ``n`` has ``n // BIN_BP + 1`` bins.

A variant id computes a URL only when all three hold (§2.6, call 31): it matches ``LOCUS_ID_PATTERN``
(``chr-pos-ref-alt`` on chr1-22, X or Y, the position written without a leading zero), its chromosome is
in the recorded set, and ``pos // BIN_BP`` is below that chromosome's bin count. Any other id (``chrM``,
``hla:``, ``kir:``, ``phenotype:``, an ``rs`` number, a lowercase allele, a position past the last bin)
computes none and reads curated rows only, so a computed URL never 404s; check 7 enumerates every URL
this module can compute (``all_bin_paths``). There is no ``nonlocus`` bin.

A recorded set that is not a non-empty subset of GRCh38 at GRCh38's lengths, and a source or ingest
version that cannot name a path segment, raise ``DataReleaseError`` (v1 §12). Pure: no I/O.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import NamedTuple

from genomeos.publication import data_release as dr

__all__ = (
    "BINNED_PREFIX",
    "BINNED_TABLE",
    "BIN_BP",
    "GRCH38_LENGTHS",
    "LOCUS_ID_PATTERN",
    "PART_FILE",
    "BinRef",
    "LookupSet",
    "all_bin_paths",
    "bin_of",
    "bin_path",
    "bin_range",
    "lookup_set",
    "parse_bin_path",
    "variant_bin",
    "variant_bin_path",
)

BINNED_TABLE = "measured.allele_observations_binned"
BINNED_PREFIX = "tables/v1/measured/allele_observations_binned/"
BIN_BP = 1_000_000
PART_FILE = "part-0.parquet"
#: The ids that compute a URL: group 1 is the chromosome, group 2 the 1-based position (1-9 digits).
LOCUS_ID_PATTERN = r"^(chr(?:[1-9]|1[0-9]|2[0-2]|X|Y))-([1-9][0-9]{0,8})-[ACGT]+-[ACGT]+$"
#: GRCh38's chromosome lengths as Hail 0.2.77 records them, in karyotype order.
GRCH38_LENGTHS: Mapping[str, int] = MappingProxyType(
    {
        "chr1": 248956422,
        "chr2": 242193529,
        "chr3": 198295559,
        "chr4": 190214555,
        "chr5": 181538259,
        "chr6": 170805979,
        "chr7": 159345973,
        "chr8": 145138636,
        "chr9": 138394717,
        "chr10": 133797422,
        "chr11": 135086622,
        "chr12": 133275309,
        "chr13": 114364328,
        "chr14": 107043718,
        "chr15": 101991189,
        "chr16": 90338345,
        "chr17": 83257441,
        "chr18": 80373285,
        "chr19": 58617616,
        "chr20": 64444167,
        "chr21": 46709983,
        "chr22": 50818468,
        "chrX": 156040895,
        "chrY": 57227415,
    }
)

_LOCUS = re.compile(LOCUS_ID_PATTERN)
#: A source or ingest version: one path segment, never a hidden name, and no ``=`` inside a partition value.
_SEGMENT_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]*"
_SEGMENT = re.compile(_SEGMENT_PATTERN)
_BIN_PATH = re.compile(
    re.escape(BINNED_PREFIX)
    + rf"source=({_SEGMENT_PATTERN})/ingest_version=({_SEGMENT_PATTERN})"
    + rf"/chrom=([^/]+)/bin=(0|[1-9][0-9]*)/{re.escape(PART_FILE)}"
)


class BinRef(NamedTuple):
    """One 1 Mb bin of one chromosome, ordered as a tuple: ``(chrom, bin)``."""

    chrom: str
    bin: int


def bin_of(pos: int) -> int:
    """The bin of a 1-based position: ``pos // BIN_BP``."""
    if isinstance(pos, bool) or not isinstance(pos, int) or pos < 1:
        raise ValueError(f"position {pos!r} is not a 1-based position")
    return pos // BIN_BP


def bin_range(ref: BinRef) -> tuple[int, int]:
    """The first and last GRCh38 position of ``ref``, 1-based and inclusive; the last bin ends at the end."""
    length = GRCH38_LENGTHS.get(ref.chrom)
    if length is None or not _is_index(ref.bin) or ref.bin >= _n_bins(length):
        raise ValueError(f"{ref} is not a 1 Mb bin of a GRCh38 chromosome (chr1-22, chrX, chrY)")
    return max(ref.bin * BIN_BP, 1), min((ref.bin + 1) * BIN_BP - 1, length)


@dataclass(frozen=True)
class LookupSet:
    """One ingest's lookup set: its source, its ingest version and its recorded chromosome set.

    Validated on construction. ``contig_lengths`` is kept read-only in karyotype order, so ``bins()`` and
    every listing derived from it come out in one order whatever order the set was recorded in.
    """

    source: str
    ingest_version: str
    # Left out of the hash, which a read-only mapping cannot take; equality still compares it.
    contig_lengths: Mapping[str, int] = field(hash=False)

    def __post_init__(self) -> None:
        _assert_segment("source", self.source)
        _assert_segment("ingest_version", self.ingest_version)
        object.__setattr__(self, "contig_lengths", _recorded_set(self.contig_lengths))

    @property
    def prefix(self) -> str:
        """The folder every bin file of this lookup set lies under, ending in ``/``."""
        return f"{BINNED_PREFIX}source={self.source}/ingest_version={self.ingest_version}/"

    def n_bins(self, chrom: str) -> int:
        """How many bin files ``chrom`` has: ``length // BIN_BP + 1``."""
        length = self.contig_lengths.get(chrom)
        if length is None:
            raise dr.DataReleaseError(f"{chrom!r} is not in the recorded chromosome set of {self.prefix}")
        return _n_bins(length)

    def bins(self) -> tuple[BinRef, ...]:
        """Every bin of the recorded chromosome set, in karyotype then bin order."""
        return tuple(BinRef(chrom, b) for chrom in self.contig_lengths for b in range(self.n_bins(chrom)))


def lookup_set(source: str, ingest_version: str, contig_lengths: Mapping[str, int]) -> LookupSet:
    """The lookup set of one ingest, refused unless its recorded set is a non-empty subset of GRCh38."""
    return LookupSet(source, ingest_version, contig_lengths)


def bin_path(lookup: LookupSet, ref: BinRef) -> str:
    """The data path of ``ref``'s file, refused for a bin outside the recorded chromosome set."""
    if (
        ref.chrom not in lookup.contig_lengths
        or not _is_index(ref.bin)
        or ref.bin >= lookup.n_bins(ref.chrom)
    ):
        raise dr.DataReleaseError(f"{ref} is not a bin of the recorded chromosome set of {lookup.prefix}")
    return dr.assert_data_path(f"{lookup.prefix}chrom={ref.chrom}/bin={ref.bin}/{PART_FILE}")


def all_bin_paths(lookup: LookupSet) -> tuple[str, ...]:
    """Every URL path a variant id can compute in ``lookup``, one per bin (check 7)."""
    return tuple(bin_path(lookup, ref) for ref in lookup.bins())


def variant_bin(lookup: LookupSet, v: str) -> BinRef | None:
    """The bin holding variant ``v`` in ``lookup``, or None when ``v`` computes no URL there."""
    match = _LOCUS.fullmatch(v)
    if match is None or match.group(1) not in lookup.contig_lengths:
        return None
    ref = BinRef(match.group(1), bin_of(int(match.group(2))))
    return ref if ref.bin < lookup.n_bins(ref.chrom) else None


def variant_bin_path(lookup: LookupSet, v: str) -> str | None:
    """The data path of the one file that can hold ``v`` in ``lookup``, or None when it computes none."""
    ref = variant_bin(lookup, v)
    return None if ref is None else bin_path(lookup, ref)


def parse_bin_path(path: str) -> tuple[str, str, BinRef] | None:
    """``(source, ingest_version, ref)`` of a bin file's path, or None for any path that is not one.

    A path is a bin file's only when it is spelled exactly as ``bin_path`` spells it, for a bin of a GRCh38
    chromosome; whether that bin is in a given lookup set is the caller's check.
    """
    match = _BIN_PATH.fullmatch(path)
    if match is None or match.group(3) not in GRCH38_LENGTHS:
        return None
    source, ingest_version, chrom, b = match.groups()
    ref = BinRef(chrom, int(b))
    return (source, ingest_version, ref) if ref.bin < _n_bins(GRCH38_LENGTHS[chrom]) else None


def _n_bins(length: int) -> int:
    return length // BIN_BP + 1


def _is_index(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _assert_segment(name: str, value: object) -> None:
    if not isinstance(value, str) or not _SEGMENT.fullmatch(value):
        raise dr.DataReleaseError(
            f"lookup set {name} {value!r} cannot name a path segment: expected ^{_SEGMENT_PATTERN}$"
        )


def _recorded_set(contig_lengths: Mapping[str, int]) -> Mapping[str, int]:
    """The recorded set in karyotype order at GRCh38's lengths; every problem is named at once."""
    if not contig_lengths:
        raise dr.DataReleaseError(
            "the recorded chromosome set is empty: a lookup set needs a GRCh38 chromosome"
        )
    problems = [
        f"{chrom!r} is not a GRCh38 chromosome of a lookup set (chr1-22, chrX, chrY)"
        if chrom not in GRCH38_LENGTHS
        else f"{chrom} has length {length!r}, but GRCh38's is {GRCH38_LENGTHS[chrom]}"
        for chrom, length in contig_lengths.items()
        if GRCH38_LENGTHS.get(chrom) != length
    ]
    if problems:
        raise dr.DataReleaseError(f"recorded chromosome set refused: {'; '.join(problems)}")
    return MappingProxyType({chrom: n for chrom, n in GRCH38_LENGTHS.items() if chrom in contig_lengths})
