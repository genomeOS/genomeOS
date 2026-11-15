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
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path

from genomeos.observations.sources.gnomad_recount.rule import Stage, read_stage

FIXTURES = Path(__file__).parent / "fixtures" / "gnomad_recount"
#: The samples of every fixture VCF line, in column order.
SAMPLES = tuple(f"SYN0{i}" for i in range(1, 10))
_QUERY_COLUMNS = ("CHROM", "POS", "ID", "REF", "ALT", "FILTER")
_QUERY_FIELDS = ("GT", "GQ", "DP", "AD")


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
