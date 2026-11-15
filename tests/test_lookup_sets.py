"""Lookup-set geometry: which ``(chrom, bin)`` files a lookup set has, and which URL a variant id computes.

Atlas data platform design 2026-10-18 §2.3, §2.6, §2.10; builder's calls 29 and 31.
"""

from __future__ import annotations

import pytest

from genomeos.publication import data_release as dr
from genomeos.tables.lookup_sets import (
    BINNED_PREFIX,
    GRCH38_LENGTHS,
    BinRef,
    all_bin_paths,
    bin_of,
    bin_path,
    bin_range,
    lookup_set,
    parse_bin_path,
    variant_bin,
    variant_bin_path,
)

IV = "gnomad-v3.1.2-hgdp-1kg-recount-test"
GNOMAD = lookup_set("gnomad_hgdp_1kg", IV, GRCH38_LENGTHS)


def test_recorded_gnomad_set_has_3102_bins_2887_autosomal():
    assert len(set(all_bin_paths(GNOMAD))) == len(GNOMAD.bins()) == 3102
    assert sum(GNOMAD.n_bins(c) for c in GRCH38_LENGTHS if c not in {"chrX", "chrY"}) == 2887
    assert [GNOMAD.n_bins(c) for c in ("chrX", "chrY", "chr11", "chr21")] == [157, 58, 136, 47]


def test_bin_edges_and_rs334():
    assert (bin_of(1), bin_of(999_999), bin_of(1_000_000)) == (0, 0, 1)
    assert bin_range(BinRef("chr1", 0)) == (1, 999_999)
    assert bin_range(BinRef("chr1", 248)) == (248_000_000, 248_956_422)
    assert variant_bin_path(GNOMAD, "chr11-5227002-T-A") == (
        f"{BINNED_PREFIX}source=gnomad_hgdp_1kg/ingest_version={IV}/chrom=chr11/bin=5/part-0.parquet"
    )
    with pytest.raises(ValueError):
        bin_of(0)
    with pytest.raises(ValueError):
        bin_range(BinRef("chr1", 249))
    with pytest.raises(ValueError):
        bin_range(BinRef("chrM", 0))


@pytest.mark.parametrize(
    "v",
    [
        "chrM-16519-T-C",
        "hla:a-02-01",
        "kir:2dl1",
        "phenotype:g6pd-deficiency",
        "mic:a-008",
        "cyt:il-10-1082-g",
        "chr21-47000000-A-G",
        "chrY-58000000-A-G",
        "chr1-99999999999999999999-A-G",
        "rs334",
        "11-5227002-T-A",
        "chr11-5227002-t-a",
        "chr23-1-A-G",
        "chr11-5227002-T-*",
        "chr1-0-A-G",
        "chr11-05227002-T-A",
        "",
        "chr11-5227002-T-A\n",
    ],
)
def test_ids_off_the_set_past_the_end_or_malformed_compute_no_url(v):
    assert variant_bin(GNOMAD, v) is None and variant_bin_path(GNOMAD, v) is None


def test_contig_ends_indels_and_round_trip():
    assert all(
        variant_bin(GNOMAD, f"{c}-{n}-A-G") == BinRef(c, GNOMAD.n_bins(c) - 1)
        for c, n in GRCH38_LENGTHS.items()
    )
    indels = ("chr11-5227002-TA-T", "chr11-5227002-T-TAA", "chr11-5227002-AC-GT")
    assert {variant_bin(GNOMAD, v) for v in indels} == {BinRef("chr11", 5)}
    for p in all_bin_paths(GNOMAD):
        parsed = parse_bin_path(p)
        assert parsed is not None and parsed[:2] == ("gnomad_hgdp_1kg", IV)
        assert dr.assert_data_path(p) == p and bin_path(GNOMAD, parsed[2]) == p


@pytest.mark.parametrize(
    "path",
    [
        "tables/v1/measured/allele_observations/source=s/ingest_version=v/part-0.parquet",
        f"{BINNED_PREFIX}source=s/ingest_version=v/chrom=chrM/bin=0/part-0.parquet",
        f"{BINNED_PREFIX}source=s/ingest_version=v/chrom=chr1/bin=249/part-0.parquet",
        f"{BINNED_PREFIX}source=s/ingest_version=v/chrom=chr1/bin=05/part-0.parquet",
        f"{BINNED_PREFIX}source=s/ingest_version=v/chrom=chr1/bin=5/part-1.parquet",
        f"{BINNED_PREFIX}source=s/ingest_version=a=b/chrom=chr1/bin=5/part-0.parquet",
        f"{BINNED_PREFIX}source=s/ingest_version=v/chrom=chr1/bin=5/part-0.parquet\n",
    ],
)
def test_a_path_that_is_not_a_grch38_bin_file_parses_to_none(path):
    assert parse_bin_path(path) is None


@pytest.mark.parametrize(
    ("source", "ingest_version", "contigs", "match"),
    [
        ("s", IV, {**GRCH38_LENGTHS, "chrM": 16569}, "chrM"),
        ("s", IV, {**GRCH38_LENGTHS, "chr1": 248956421}, "chr1"),
        ("s", IV, {}, "empty"),
        *(
            ("s", bad, GRCH38_LENGTHS, "ingest_version")
            for bad in ("", "a/b", "x:y", ".hidden", "v 1", "a=b")
        ),
        ("a/b", IV, GRCH38_LENGTHS, "source"),
    ],
)
def test_bad_recorded_sets_are_refused(source, ingest_version, contigs, match):
    with pytest.raises(dr.DataReleaseError, match=match):
        lookup_set(source, ingest_version, contigs)


def test_a_grch38_subset_is_valid():
    subset = lookup_set("f", IV, {"chr22": 50818468, "chr21": 46709983})
    assert subset.bins()[0] == BinRef("chr21", 0) and subset.bins()[-1] == BinRef("chr22", 50)
    assert variant_bin_path(subset, "chr11-5227002-T-A") is None
    for ref in (BinRef("chr11", 5), BinRef("chr21", 47), BinRef("chr21", -1)):
        with pytest.raises(dr.DataReleaseError, match="recorded chromosome set"):
            bin_path(subset, ref)
    with pytest.raises(dr.DataReleaseError, match="recorded chromosome set"):
        subset.n_bins("chr11")


def test_the_recorded_set_is_read_only_and_kept_in_karyotype_order():
    recorded = {"chr22": 50818468, "chr21": 46709983}
    subset = lookup_set("f", IV, recorded)
    recorded["chr1"] = 248956422
    assert list(subset.contig_lengths) == ["chr21", "chr22"]
    with pytest.raises(TypeError):
        subset.contig_lengths["chr1"] = 248956422  # type: ignore[index]
    assert subset == lookup_set("f", IV, {"chr21": 46709983, "chr22": 50818468}) != GNOMAD
    assert len({subset, lookup_set("f", IV, {"chr22": 50818468, "chr21": 46709983})}) == 1
