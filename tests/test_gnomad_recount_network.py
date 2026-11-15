"""Check 12 against gnomAD's own bytes: both counters on the measured windows, under the measured stand-in.

Atlas data platform design 2026-10-18 §1.2 D18, §2.7 check 12 and §2.10 (builder's call 38). Network: every
test streams public gnomAD v3.1.2 objects anonymously over HTTPS, with no credential (about 20 minutes), so
the module is marked ``network`` and deselected by default; run it with ``-m network``.

The stage is the spec's measured stand-in (``stand_in_stage``): gnomAD's 4,097 ``high_quality`` samples of the
sample-meta file, each under its ``hgdp_tgp_meta.population`` (78 labels) and its ``gnomad_sex_imputation``
karyotype. §2.10's three windows reproduce their measured cell counts (592,484 in all); the other windows of
§14 must agree cell for cell, and their counts go in the PR, never asserted; rs334 reproduces check 12's
78 rows, sum ``ac`` 208 and sum ``an`` 8,188. Each window is §2.10's region as written. A measured count that
differs is reported with its region, never edited.
"""

from __future__ import annotations

import gzip
import json
import shutil
import urllib.request

import pytest

from genomeos.observations.sources.gnomad_recount.crosscheck import compare_counters, site_cells
from genomeos.observations.sources.gnomad_recount.native import query_region
from genomeos.observations.sources.gnomad_recount.rule import (
    GNOMAD_VCF_URL,
    SAMPLE_META_URL,
    Stage,
    read_stage,
)

pytestmark = pytest.mark.network

#: §2.10's D18 windows and the written cells measured on each (592,484 in all).
MEASURED = {
    ("chr11", 5_200_000, 5_250_000): 265_419,
    ("chrX", 100_000_000, 100_100_000): 284_954,
    ("chrY", 14_000_000, 14_100_000): 42_111,
}
#: §14's other windows: two chrX PAR windows and the two autosomal layout windows.
OTHER = [
    ("chrX", 1_000_000, 1_010_000),
    ("chrX", 155_800_000, 155_810_000),
    ("chr21", 25_000_000, 26_999_999),
    ("chr2", 100_000_000, 100_999_999),
]
STAND_IN_SAMPLES = 4_097
STAND_IN_LABELS = 78


def _region(window: tuple[str, int, int]) -> str:
    return f"{window[0]}:{window[1]}-{window[2]}"


def stand_in_stage(sample_meta: bytes) -> Stage:
    """The measured stand-in stage from the bgzipped sample-meta TSV: its ``high_quality`` samples, each
    under ``hgdp_tgp_meta.population`` and with its ``gnomad_sex_imputation`` JSON as the karyotype."""
    header, *lines = gzip.decompress(sample_meta).decode("utf-8").removesuffix("\n").split("\n")
    names = header.split("\t")
    s, high_quality, meta, sex = (
        names.index(name) for name in ("s", "high_quality", "hgdp_tgp_meta", "gnomad_sex_imputation")
    )
    rows = [line.split("\t") for line in lines]
    assert all(len(row) == len(names) for row in rows)
    kept = sorted((row for row in rows if row[high_quality] == "true"), key=lambda row: row[s])
    assert len(kept) == STAND_IN_SAMPLES
    populations = [json.loads(row[meta])["population"] for row in kept]
    assert len(set(populations)) == STAND_IN_LABELS
    metadata = "s\tpopulation\n" + "".join(
        f"{row[s]}\t{population}\n" for row, population in zip(kept, populations, strict=True)
    )
    karyotypes = "s\tgnomad_sex_imputation\n" + "".join(f"{row[s]}\t{row[sex]}\n" for row in kept)
    ids = "".join(f"{row[s]}\n" for row in kept)
    return read_stage(metadata.encode(), karyotypes.encode(), ids.encode(), name="stand-in-high-quality")


@pytest.fixture(scope="module")
def stand_in() -> Stage:
    """``stand_in_stage`` over the sample-meta file, read anonymously."""
    with urllib.request.urlopen(SAMPLE_META_URL, timeout=300) as reply:
        return stand_in_stage(reply.read())


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    """The test's workdir and working directory, removed afterwards: a window's ``bcftools query`` text for
    the independent counter runs to gigabytes (about 52 KB a record at 4,097 samples), which pytest would
    otherwise keep, and htslib saves each remote VCF's index in the working directory."""
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    yield work
    monkeypatch.undo()
    shutil.rmtree(work, ignore_errors=True)


@pytest.mark.parametrize("window", MEASURED, ids=_region)
def test_counters_reproduce_the_measured_cells(workdir, stand_in, window: tuple[str, int, int]):
    result = compare_counters(GNOMAD_VCF_URL.format(chrom=window[0]), *window, stand_in, workdir)
    print(result)
    assert (result.cells, result.identical, result.tally_equal) == (MEASURED[window], MEASURED[window], True)
    assert window[0] != "chr11" or result.pass_non_snv > 0  # the indel-rich window: 560 of 3,812 not SNVs


@pytest.mark.parametrize("window", OTHER, ids=_region)
def test_counters_agree_on_the_other_windows(workdir, stand_in, window: tuple[str, int, int]):
    # the counts go in the PR and are never asserted
    result = compare_counters(GNOMAD_VCF_URL.format(chrom=window[0]), *window, stand_in, workdir)
    print(result)
    assert result.cells > 0 and result.identical == result.cells and result.tally_equal


def test_rs334_under_the_stand_in(workdir, stand_in):
    vcf = GNOMAD_VCF_URL.format(chrom="chr11")
    sites, _ = query_region(vcf, "chr11", 5_227_002, 5_227_002, stand_in, workdir)
    cells = site_cells([s for s in sites if s.variant_id == "chr11-5227002-T-A"], stand_in)
    sums = (int(cells["ac"].to_numpy().sum()), int(cells["an"].to_numpy().sum()))
    assert (len(cells), *sums) == (78, 208, 8188)
