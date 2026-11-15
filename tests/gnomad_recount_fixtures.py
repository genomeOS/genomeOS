"""Synthetic gnomAD HGDP + 1KG windows for D18's recount.

Atlas data platform design 2026-10-18 §1.2 D18, §2.10.

``tests/fixtures/gnomad_recount/`` holds nine synthetic samples, ``SYN01``-``SYN09``, and no real person:

- ``stage.txt``: the stage, ``SYN01``-``SYN08``, sorted and LF-terminated (``fixture_stage`` calls it
  ``fixture-8``);
- ``metadata.tsv`` (``s``, ``population``): two samples each of Han, NorthernHan, PapuanHighlands and
  PapuanSepik, and ``SYN09`` (Han), who is outside the stage;
- ``karyotypes.tsv`` (``s``, ``gnomad_sex_imputation`` as JSON): odd samples XX, even XY, ``SYN09`` XXY;
- ``populations.tsv``: the four labels in ``hgdp.load``'s format, for the registry the rows map to;
- ``windows.vcf``: 16 records over chr1, chr11, chrX and chrY, with the header (24 GRCh38 ``##contig`` lines,
  FORMAT GT:GQ:DP:AD) that ``vcf_with`` reuses.

``query_lines`` stands in for ``bcftools query -H -f PY_QUERY_FORMAT -S <ids>``, so the counter's tests run
without bcftools. ``HARD`` pairs one-record VCF lines with the D18 item each must fail under.

The native count's tests need the tools themselves: ``indexed_vcf`` bgzips and tabix-indexes a fixture VCF,
and ``requires_native`` skips a test only outside CI on a machine without bcftools, bgzip and tabix. CI
installs them, so there it never skips.

The jobs' tests (``jobs``) take two more:

- ``job_env`` indexes ``windows.vcf`` and gives ``run_job`` its stage, its population table and an identity
  citing the local VCF, which is never HEADed (``JobEnv.paths`` gives the rest of ``run_job``'s keywords);
- ``synthetic_complete_ledger`` is a complete ledger of any planned job under ``SYNTHETIC_IDENTITY``, with
  no file behind it, so 166 of them combine into a whole-genome ingest without a recount.

Their ``sampling_design`` and ``disease_ascertainment_excluded`` are test values only: the recount rows'
real values wait for O1 (#509).
"""

from __future__ import annotations

import dataclasses
import hashlib
import os
import subprocess
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import pytest

from genomeos.observations.sources.gnomad_hgdp_1kg import SOURCE
from genomeos.observations.sources.gnomad_recount import native
from genomeos.observations.sources.gnomad_recount.jobs import (
    RECOUNT_SOURCES,
    BinEntry,
    CitedFile,
    Job,
    JobIdentity,
    Ledger,
)
from genomeos.observations.sources.gnomad_recount.rows import population_table, recount_cohort_id
from genomeos.observations.sources.gnomad_recount.rule import (
    GNOMAD_VCF_URL,
    METADATA_URL,
    RULE_ID,
    SAMPLE_META_URL,
    Stage,
    Tally,
    read_stage,
)
from genomeos.publication import data_release as dr
from genomeos.registry.build import build_registry
from genomeos.registry.sources import hgdp
from genomeos.tables import reference
from genomeos.tables.binned import BinFile
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, bin_path, lookup_set
from genomeos.tables.provenance import InputRef
from tests.reference_tbi_fixture import native_tools

FIXTURES = Path(__file__).parent / "fixtures" / "gnomad_recount"
#: The samples of every fixture VCF line, in column order.
SAMPLES = tuple(f"SYN0{i}" for i in range(1, 10))
_QUERY_COLUMNS = ("CHROM", "POS", "ID", "REF", "ALT", "FILTER")
_QUERY_FIELDS = ("GT", "GQ", "DP", "AD")

#: Skips outside CI on a machine without bcftools, bgzip and tabix; CI installs them and never skips.
requires_native = pytest.mark.skipif(
    native_tools() is None and os.environ.get("CI") != "true",
    reason="bcftools, bgzip and tabix are unavailable",
)


def fixture_stage() -> Stage:
    """``read_stage`` over the fixture files: eight samples, two per population, named ``fixture-8``."""
    return read_stage(
        (FIXTURES / "metadata.tsv").read_bytes(),
        (FIXTURES / "karyotypes.tsv").read_bytes(),
        (FIXTURES / "stage.txt").read_bytes(),
        name="fixture-8",
    )


def record(
    chrom: str,
    pos: int,
    ref: str,
    alt: str,
    *,
    filter_: str = "PASS",
    calls: Mapping[str, str] | None = None,
    default: str = "0/0:30:30:30,0",
    rsid: str = ".",
) -> str:
    """One VCF line over ``SYN01``-``SYN09``: each sample's call is ``calls[sample]``, else ``default``."""
    calls = dict(calls or {})
    unknown = sorted(set(calls) - set(SAMPLES))
    if unknown:
        raise ValueError(f"calls name samples outside the fixture: {unknown}")
    fixed = (chrom, str(pos), rsid, ref, alt, ".", filter_, ".", "GT:GQ:DP:AD")
    return "\t".join((*fixed, *(calls.get(sample, default) for sample in SAMPLES)))


def vcf_with(records: Sequence[str]) -> str:
    """``windows.vcf``'s header followed by ``records``."""
    lines = (FIXTURES / "windows.vcf").read_text(encoding="utf-8").splitlines(keepends=True)
    return "".join(line for line in lines if line.startswith("#")) + "".join(f"{line}\n" for line in records)


def indexed_vcf(tmp_path: Path, text: str) -> Path:
    """``text`` bgzipped to ``tmp_path / "windows.vcf.gz"`` and tabix-indexed beside it."""
    tools = native_tools()
    if tools is None:
        raise RuntimeError("bgzip and tabix are required to index a fixture VCF")
    bgzip, tabix, _ = tools
    vcf = tmp_path / "windows.vcf.gz"
    compressed = subprocess.run([bgzip, "-c"], input=text.encode(), check=True, capture_output=True).stdout
    vcf.write_bytes(compressed)
    subprocess.run([tabix, "-p", "vcf", str(vcf)], check=True, capture_output=True)
    return vcf


def query_lines(vcf_text: str, sample_ids: Sequence[str]) -> list[str]:
    """``bcftools query -H -f PY_QUERY_FORMAT -S <sample_ids>`` in pure Python.

    As bcftools 1.21 does: the header line first, then one line per record, the sample columns in
    ``sample_ids``' order, a FORMAT field the record lacks printed as ``.``, and a sample missing from the
    VCF refused.
    """
    lines = vcf_text.splitlines()
    columns = next(line for line in lines if line.startswith("#CHROM")).split("\t")[9:]
    missing = [sample for sample in sample_ids if sample not in columns]
    if missing:
        raise ValueError(f"samples not in the VCF header: {missing}")
    keep = [columns.index(sample) for sample in sample_ids]
    names = [*_QUERY_COLUMNS, *(f"{columns[i]}:{name}" for i in keep for name in _QUERY_FIELDS)]
    out = ["#" + "\t".join(f"[{n}]{name}" for n, name in enumerate(names, start=1)) + "\n"]
    for line in lines:
        if line.startswith("#"):
            continue
        fields = line.split("\t")
        keys = fields[8].split(":")
        cells = [dict(zip(keys, fields[9 + i].split(":"), strict=False)) for i in keep]
        values = (cell.get(name, ".") for cell in cells for name in _QUERY_FIELDS)
        out.append("\t".join((*fields[:5], fields[6], *values)) + "\n")
    return out


#: One-record VCF lines that fail the build, each with the D18 item its error names.
HARD: list[tuple[str, str]] = [
    (record("chr1", 7000, "A", "G,T"), "D18 item 2"),
    (record("chr1", 7000, "A", "*"), "D18 item 2"),
    (record("chr1", 7000, "A", "G", calls={"SYN01": "0/2:30:30:15,15"}), "D18 item 2"),
    (record("chr1", 7000, "A", "G", calls={"SYN01": "./1:30:30:15,15"}), "D18 item 3"),
    (record("chr1", 7000, "A", "G", calls={"SYN01": "1:30:30:0,30"}), "D18 item 4"),
    (
        record(
            "chrX",
            100000500,
            "A",
            "G",
            default="0:30:30:30,0",
            calls={f"SYN0{i}": "0/0:30:30:30,0" for i in (1, 3, 5, 7)} | {"SYN02": "0/1:30:30:15,15"},
        ),
        "D18 item 4",
    ),
    (record("chrY", 14000500, "G", "T", default=".:.:.:.", calls={"SYN01": "0:30:30:30,0"}), "D18 item 4"),
    (record("chrY", 100000, "G", "T", default=".:.:.:."), "D18 item 4"),
]


#: The registry ``synthetic_complete_ledger`` cites, and the release its two files are keyed under.
SYNTHETIC_REGISTRY = "1.0.0+sha256." + "d" * 64
_REGISTRY_RELEASE = "2026-12-01"
#: Each fixture label and its ``population_id`` in the registry ``hgdp.load`` builds from ``populations.tsv``.
FIXTURE_POPULATIONS = (
    ("Han", "hgdp-han"),
    ("NorthernHan", "hgdp-northernhan"),
    ("PapuanHighlands", "hgdp-papuanhighlands"),
    ("PapuanSepik", "hgdp-papuansepik"),
)
#: A whole-genome job's identity with nothing real behind it: the fixture's stage and populations, chr1's
#: VCF, the metadata and karyotypes cited with sha256s ``"b" * 64`` and ``"c" * 64``, and O1's test values.
SYNTHETIC_IDENTITY = JobIdentity(
    vcf=CitedFile(GNOMAD_VCF_URL.format(chrom="chr1"), 1, "0" * 32, 1, None),
    metadata=CitedFile(METADATA_URL, 1, "0" * 32, 1, "b" * 64),
    karyotypes=CitedFile(SAMPLE_META_URL, 1, "0" * 32, 1, "c" * 64),
    stage_name="fixture-8",
    stage_sha256=fixture_stage().ids_sha256,
    registry_version=SYNTHETIC_REGISTRY,
    registry_inputs=tuple(
        InputRef(dr.release_key(_REGISTRY_RELEASE, path), digit * 64)
        for path, digit in zip(reference.reference_paths(SYNTHETIC_REGISTRY), "ef", strict=True)
    ),
    sources=RECOUNT_SOURCES,
    populations=FIXTURE_POPULATIONS,
    cohort_id=recount_cohort_id("fixture-8"),
    ingest_version="2026-12-recount",
    sampling_design="healthy_reference",
    disease_ascertainment_excluded=True,
    rule=RULE_ID,
    git_sha="0" * 40,
    bcftools="bcftools 1.23.1",
    duckdb="1.5.5",
)


def synthetic_complete_ledger(job: Job, *, ingest_version: str = "2026-12-recount") -> Ledger:
    """``job``'s complete ledger under ``SYNTHETIC_IDENTITY``, citing its chromosome's gnomAD VCF.

    Every bin holds one row and one written PASS record; chr11-00's bin 5 (rs334's) also holds 2 Han
    low_gq refusals, a NorthernHan cell with ``an = 0``, an AC0 record and a monomorphic record.
    """
    identity = dataclasses.replace(
        SYNTHETIC_IDENTITY,
        vcf=CitedFile(GNOMAD_VCF_URL.format(chrom=job.chrom), 1, "0" * 32, 1, None),
        ingest_version=ingest_version,
    )
    lookup = lookup_set(SOURCE, ingest_version, GRCH38_LENGTHS)
    bins = {
        b: BinEntry(
            BinFile(bin_path(lookup, BinRef(job.chrom, b)), "a" * 64, 1, 1),
            Tally(pass_records=1, written_sites=1),
            1,
        )
        for b in job.bins
    }
    if job.job_id == "chr11-00":
        rs334 = Tally(
            non_pass=Counter({"AC0": 1}),
            pass_records=1,
            written_sites=1,
            monomorphic_in_stage=1,
            refusals=Counter({("Han", "low_gq"): 2}),
            an_zero=Counter({"NorthernHan": 1}),
        )
        bins[5] = dataclasses.replace(bins[5], tally=rs334)
    return Ledger(job, identity, bins)


@dataclasses.dataclass(frozen=True, eq=False)
class JobEnv:
    """What ``run_job`` needs to recount a job of the fixture windows: the indexed VCF, the stage, its
    population table and an identity citing the local VCF."""

    vcf: str
    stage: Stage
    table: pd.DataFrame
    identity: JobIdentity

    def paths(self, out: Path) -> dict[str, Any]:
        """``run_job``'s keywords other than the job and identity, writing under ``out``."""
        return {
            "source": self.vcf,
            "stage": self.stage,
            "table": self.table,
            "out_root": out / "bins",
            "ledger_path": out / "ledger.json",
            "workdir": out / "work",
        }


def job_env(tmp_path: Path) -> JobEnv:
    """``windows.vcf`` indexed in ``tmp_path``, the fixture stage and registry, and ``SYNTHETIC_IDENTITY``
    citing that local VCF (never HEADed) under the bcftools and DuckDB that run here."""
    vcf = indexed_vcf(tmp_path, (FIXTURES / "windows.vcf").read_text(encoding="utf-8"))
    raw = vcf.read_bytes()
    cited = CitedFile(str(vcf), len(raw), hashlib.md5(raw, usedforsecurity=False).hexdigest(), 1, None)
    stage = fixture_stage()
    table = population_table(stage, *build_registry([hgdp.load(FIXTURES / "populations.tsv", "0.1.0")]))
    identity = dataclasses.replace(
        SYNTHETIC_IDENTITY, vcf=cited, bcftools=native.bcftools_version(), duckdb=duckdb.__version__
    )
    return JobEnv(str(vcf), stage, table, identity)
