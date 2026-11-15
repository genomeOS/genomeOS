#!/usr/bin/env python3
"""Recount gnomAD v3.1.2 HGDP + 1KG over the whole genome in 166 resumable jobs of 20 Mb.

Atlas data platform design 2026-10-18 §1.2 D17 and D18, §2.10; builder's call 38. Offline batch work: no
credential is used, and gnomAD's public objects are read anonymously.

    python scripts/recount_gnomad_hgdp_1kg.py plan
    python scripts/recount_gnomad_hgdp_1kg.py cite --chrom chr11 > cited-chr11.json
    python scripts/recount_gnomad_hgdp_1kg.py run --job chr11-00 --cited cited-chr11.json \\
        --metadata gnomad_meta_updated.tsv \\
        --karyotypes gnomad.genomes.v3.1.2.hgdp_1kg_subset_sample_meta.tsv.bgz \\
        --stage stage.txt --stage-name paper_ancestry_exclusion_4094 \\
        --registry data/tables/v1/reference/populations/1.0.0-<sha8> --registry-release <R> \\
        --ingest-version <iv> --sampling-design <O1> --disease-ascertainment-excluded <O1> \\
        --out data --ledger-dir ledgers --workdir work
    python scripts/recount_gnomad_hgdp_1kg.py combine --ledger-dir ledgers --out-summary summary.json

- ``plan`` prints the job ids as ``{"jobs": [...]}``.
- ``cite`` HEADs the chromosome's VCF, ``METADATA_URL`` and ``SAMPLE_META_URL`` and prints each as a cited
  file (URL, size, md5, generation): ``{"vcf", "metadata", "karyotypes"}``, the input of ``run``.
- ``run`` recounts one job (``jobs.run_job``) under the identity it builds from:
  - the cited files, whose VCF URL must be gnomAD's for the job's chromosome; ``--vcf`` reads a local copy
    instead, for tests and offline reruns;
  - the local metadata and karyotype files, which must be the cited objects (size and md5) and give the
    sha256s D17 records; a ``.bgz`` or ``.gz`` file is read through gzip. Karyotypes come only from the
    sample-meta file's ``gnomad_sex_imputation`` (D18 item 4), never the pilot's ``sex_imputation``;
  - the stage and its name;
  - the registry folder, read through ``reference.read_reference``: its ``hgdp_1kg.ALIAS_SOURCES`` aliases
    map the stage's labels, its two parquet files keyed under ``releases/<R>/`` are the bins' inputs, and
    the union of their recorded sources is the bins' sources;
  - the ingest version and its ascertainment, which have no defaults (O1, #509);
  - our code's commit. A checkout with uncommitted changes to tracked files is refused, since D17 records
    the commit the code ran at.
- ``combine`` combines every ``<job>.json`` ledger of ``--ledger-dir`` into the ingest summary, checks that it
  makes a ``measured.ingests`` row, writes the summary and prints its totals.

Ledgers are ``<ledger-dir>/<job>.json``; each job counts in ``<workdir>/<job>``. A refusal prints to stderr
and exits 1.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import asdict, replace
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.observations.sources.gnomad_recount import jobs, native  # noqa: E402
from genomeos.observations.sources.gnomad_recount.rows import (  # noqa: E402
    population_table,
    recount_cohort_id,
)
from genomeos.observations.sources.gnomad_recount.rule import (  # noqa: E402
    GNOMAD_VCF_URL,
    METADATA_URL,
    RULE_ID,
    SAMPLE_META_URL,
    RecountError,
    read_stage,
)
from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.registry.sources.hgdp_1kg import ALIAS_SOURCES  # noqa: E402
from genomeos.tables import provenance, reference  # noqa: E402
from genomeos.tables.lookup_sets import GRCH38_LENGTHS  # noqa: E402
from genomeos.tables.provenance import InputRef  # noqa: E402

CITED = ("vcf", "metadata", "karyotypes")


def git_sha() -> str:
    """``git rev-parse HEAD``, with ``-dirty`` appended when tracked files have uncommitted changes."""

    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
        ).stdout.strip()

    sha = git("rev-parse", "HEAD")
    return f"{sha}-dirty" if git("status", "--porcelain", "--untracked-files=no") else sha


def _plan(args: argparse.Namespace) -> int:
    print(json.dumps({"jobs": [job.job_id for job in jobs.plan_jobs()]}))
    return 0


def _cite(args: argparse.Namespace) -> int:
    urls = (GNOMAD_VCF_URL.format(chrom=args.chrom), METADATA_URL, SAMPLE_META_URL)
    cited = {name: asdict(jobs.head_identity(url)) for name, url in zip(CITED, urls, strict=True)}
    print(json.dumps(cited, indent=1, sort_keys=True))
    return 0


def _local(cited: jobs.CitedFile, path: Path, flag: str) -> tuple[jobs.CitedFile, bytes]:
    """``cited`` with the sha256 of ``path``, a local copy that must be the cited object; and its content."""
    raw = path.read_bytes()
    md5, sha256 = hashlib.md5(raw, usedforsecurity=False).hexdigest(), hashlib.sha256(raw).hexdigest()
    if (len(raw), md5) != (cited.size, cited.md5) or cited.sha256 not in (None, sha256):
        raise RecountError(
            f"{flag} {path} is not the cited {cited.url}: {len(raw)} bytes with md5 {md5}, where the "
            f"citation gives {cited.size} bytes with md5 {cited.md5}"
        )
    return replace(cited, sha256=sha256), gzip.decompress(raw) if path.suffix in (".bgz", ".gz") else raw


def _registry(
    folder: Path, release: str
) -> tuple[str, pd.DataFrame, pd.DataFrame, tuple[InputRef, ...], tuple[str, ...]]:
    """The registry folder's version, populations, HGDP + 1KG aliases, its two files as inputs keyed under
    ``releases/<release>/``, and the union of their recorded sources."""
    populations, aliases = reference.read_reference(folder)
    if populations is None:
        raise RecountError(f"{folder}: the recount's registry places its populations")
    version = str(aliases["registry_version"].iloc[0])
    inputs: list[InputRef] = []
    sources: set[str] = set()
    for path in reference.reference_paths(version):
        name = path.rsplit("/", 1)[1]
        inputs.append(
            InputRef(dr.release_key(release, path), hashlib.sha256((folder / name).read_bytes()).hexdigest())
        )
        sources.update(provenance.recorded_sources(folder, name))
    hgdp_1kg = aliases.loc[aliases["source"].isin(ALIAS_SOURCES)]
    return version, populations, hgdp_1kg, tuple(inputs), tuple(sorted(sources))


def _run(args: argparse.Namespace) -> int:
    job = jobs.job_by_id(args.job)
    cited = json.loads(args.cited.read_text(encoding="utf-8"))
    if not isinstance(cited, dict) or set(cited) != set(CITED):
        raise RecountError(f"--cited {args.cited} holds exactly {list(CITED)}, as cite prints them")
    vcf, metadata, karyotypes = (jobs.CitedFile(**cited[name]) for name in CITED)
    expected = GNOMAD_VCF_URL.format(chrom=job.chrom)
    if vcf.url != expected:
        raise RecountError(
            f"the cited VCF {vcf.url} is not the gnomAD v3.1.2 URL for {job.chrom}, {expected}"
        )
    sha = git_sha()
    if sha.endswith("-dirty"):
        raise RecountError(
            f"{ROOT} has uncommitted changes to tracked files ({sha}); commit them first, since D17 records "
            "the commit the code ran at"
        )
    metadata, metadata_bytes = _local(metadata, args.metadata, "--metadata")
    karyotypes, karyotype_bytes = _local(karyotypes, args.karyotypes, "--karyotypes")
    stage = read_stage(metadata_bytes, karyotype_bytes, args.stage.read_bytes(), name=args.stage_name)
    version, populations, aliases, inputs, sources = _registry(args.registry, args.registry_release)
    table = population_table(stage, populations, aliases)
    identity = jobs.JobIdentity(
        vcf=vcf,
        metadata=metadata,
        karyotypes=karyotypes,
        stage_name=stage.name,
        stage_sha256=stage.ids_sha256,
        registry_version=version,
        registry_inputs=inputs,
        sources=sources,
        populations=tuple(
            zip(map(str, table["source_label"]), map(str, table["population_id"]), strict=True)
        ),
        cohort_id=recount_cohort_id(stage.name),
        ingest_version=args.ingest_version,
        sampling_design=args.sampling_design,
        disease_ascertainment_excluded=args.disease_ascertainment_excluded == "true",
        rule=RULE_ID,
        git_sha=sha,
        bcftools=native.bcftools_version(),
        duckdb=duckdb.__version__,
    )
    ledger = jobs.run_job(
        job,
        identity,
        source=str(args.vcf) if args.vcf is not None else vcf.url,
        stage=stage,
        table=table,
        out_root=args.out,
        ledger_path=args.ledger_dir / f"{job.job_id}.json",
        workdir=args.workdir / job.job_id,
    )
    rows = sum(entry.file.rows for entry in ledger.bins.values())
    print(
        json.dumps({"job": job.job_id, "complete": ledger.complete, "bins": len(ledger.bins), "rows": rows})
    )
    return 0


def _combine(args: argparse.Namespace) -> int:
    ledgers = []
    for path in sorted(args.ledger_dir.glob("*.json")):
        ledger = jobs.read_ledger(path)
        if ledger is None or ledger.job.job_id != path.stem:
            raise RecountError(f"{path} is not the ledger of job {path.stem}")
        ledgers.append(ledger)
    summary = jobs.combine_ledgers(ledgers)
    ingest = jobs.recount_ingest(summary)
    jobs.write_summary(args.out_summary, summary)
    totals = {
        "jobs": len(ledgers),
        "bins": len(summary.bins),
        "rows": ingest.n_rows,
        "inputs": len(ingest.inputs),
    }
    print(json.dumps(totals))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Recount gnomAD HGDP + 1KG in 166 resumable 20 Mb jobs (D18)."
    )
    commands = parser.add_subparsers(dest="name", required=True)
    commands.add_parser("plan", help="print the job ids").set_defaults(command=_plan)
    cite = commands.add_parser("cite", help="HEAD a chromosome's VCF and the two metadata files anonymously")
    cite.add_argument("--chrom", required=True, choices=list(GRCH38_LENGTHS))
    cite.set_defaults(command=_cite)
    run = commands.add_parser("run", help="recount one job, resuming from its ledger")
    run.add_argument("--job", required=True)
    run.add_argument("--cited", type=Path, required=True, help="cite's output for the job's chromosome")
    run.add_argument("--vcf", type=Path, help="a local copy of the cited VCF, read instead of its URL")
    for flag in ("--metadata", "--karyotypes", "--stage", "--registry"):
        run.add_argument(flag, type=Path, required=True)
    for flag in ("--stage-name", "--registry-release", "--ingest-version"):
        run.add_argument(flag, required=True)
    run.add_argument("--sampling-design", required=True, help="no default (O1, #509)")
    run.add_argument("--disease-ascertainment-excluded", required=True, choices=("true", "false"))
    for flag in ("--out", "--ledger-dir", "--workdir"):
        run.add_argument(flag, type=Path, required=True)
    run.set_defaults(command=_run)
    combine = commands.add_parser("combine", help="combine the 166 ledgers into the ingest summary")
    combine.add_argument("--ledger-dir", type=Path, required=True)
    combine.add_argument("--out-summary", type=Path, required=True)
    combine.set_defaults(command=_combine)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.command(args)
    except (ValueError, OSError) as error:  # RecountError, TableError and DataReleaseError are ValueErrors
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
