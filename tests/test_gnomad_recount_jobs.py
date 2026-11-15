"""The whole-genome recount's 166 jobs of 20 Mb: per-bin ledgers, resume, the cited inputs and the ingest row.

Atlas data platform design 2026-10-18 §1.2 D17 and D18, §2.7 check 9 and §2.10; builder's call 38. A job
refuses wrong inputs before it writes anything (the plan's Review Focus 1): another chromosome's VCF, a
``##contig`` length off GRCh38, an upstream object gnomAD replaced, an unmapped population or a source
outside the union. The ascertainment values here are O1's test values only (#509).
"""

from __future__ import annotations

import base64
import dataclasses
import email.message
import functools
import gzip
import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path

import pytest

from genomeos.observations.sources.gnomad_recount import jobs
from genomeos.observations.sources.gnomad_recount.jobs import (
    RECOUNT_SOURCES,
    CitedFile,
    Job,
    Ledger,
    combine_ledgers,
    job_by_id,
    plan_jobs,
    read_ledger,
    read_summary,
    recount_ingest,
    run_job,
    write_summary,
)
from genomeos.observations.sources.gnomad_recount.rule import (
    GNOMAD_VCF_URL,
    METADATA_URL,
    SAMPLE_META_URL,
    RecountError,
    Stage,
    Tally,
)
from genomeos.publication import data_release as dr
from genomeos.tables import contracts, measured, reference, writer
from genomeos.tables.binned import SOURCE_RECORD_ID_TEMPLATE
from genomeos.tables.contracts import TableError
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, lookup_set
from genomeos.tables.provenance import InputRef, read_kv
from scripts import recount_gnomad_hgdp_1kg as cli
from tests.gnomad_recount_fixtures import (
    FIXTURES,
    indexed_vcf,
    job_env,
    requires_native,
    synthetic_complete_ledger,
)

#: Task 17's seven synthetic HGDP + 1KG identities, which place the fixture's four labels.
HGDP_1KG_FIXTURE = Path(__file__).parent / "fixtures" / "hgdp_1kg_populations.tsv"


@functools.cache
def _synthetic() -> tuple[Ledger, ...]:
    """Every planned job's complete synthetic ledger; a test replaces, never mutates, them."""
    return tuple(synthetic_complete_ledger(job) for job in plan_jobs())


def _files(root: Path) -> dict[Path, int]:
    """Every file under ``root`` and its mtime."""
    return {path: path.stat().st_mtime_ns for path in root.rglob("*") if path.is_file()}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_genome_is_166_jobs_of_at_most_20_bins():
    jobs_ = plan_jobs()
    assert len(jobs_) == len({j.job_id for j in jobs_}) == 166
    assert (sum(j.chrom == "chrX" for j in jobs_), sum(j.chrom == "chrY" for j in jobs_)) == (8, 3)
    assert all(1 <= len(j.bins) <= 20 for j in jobs_)
    assert job_by_id("chr1-00") == Job("chr1", 0, 1, 19_999_999, tuple(range(20)))
    assert job_by_id("chr1-12") == Job("chr1", 12, 240_000_000, 248_956_422, tuple(range(240, 249)))
    expected = sorted(lookup_set("s", "v", GRCH38_LENGTHS).bins())
    assert sorted(BinRef(j.chrom, b) for j in jobs_ for b in j.bins) == expected
    with pytest.raises(RecountError, match="chr1-13"):
        job_by_id("chr1-13")


@requires_native
def test_a_job_writes_every_bin_and_its_tallies(tmp_path):
    env = job_env(tmp_path)
    ledger = run_job(job_by_id("chr1-00"), env.identity, **env.paths(tmp_path))
    assert ledger.complete and [ledger.bins[b].file.rows for b in (0, 19)] == [20, 4]
    assert all(ledger.bins[b].file.rows == 0 for b in range(1, 19))
    total = functools.reduce(Tally.merge, (e.tally for e in ledger.bins.values()))
    assert (total.pass_records, total.written_sites, total.monomorphic_in_stage) == (8, 7, 1)
    assert total.an_zero == Counter({"NorthernHan": 1, "PapuanHighlands": 1, "PapuanSepik": 2})
    assert (total.refusals[("PapuanSepik", "missing")], total.refusals[("Han", "low_gq")]) == (2, 2)
    recorded = {
        tuple(json.loads(read_kv(tmp_path / "bins" / e.file.path)["genomeos.sources"]))
        for e in ledger.bins.values()
    }
    assert recorded == {RECOUNT_SOURCES}
    assert all(_sha256(tmp_path / "bins" / e.file.path) == e.file.sha256 for e in ledger.bins.values())
    assert read_ledger(tmp_path / "ledger.json") == ledger


@requires_native
def test_population_mapping_fails_before_any_stream(tmp_path, monkeypatch):
    env = job_env(tmp_path)
    monkeypatch.setattr(jobs.native, "native_bin", lambda *a: pytest.fail("streamed"))
    with pytest.raises(RecountError, match="PapuanSepik"):
        run_job(job_by_id("chr1-00"), env.identity, **env.paths(tmp_path) | {"table": env.table.iloc[:3]})
    with pytest.raises(RecountError, match="afnd"):
        afnd = dataclasses.replace(env.identity, sources=("afnd", *RECOUNT_SOURCES))
        run_job(job_by_id("chr1-00"), afnd, **env.paths(tmp_path))
    assert not (tmp_path / "bins").exists() and not (tmp_path / "ledger.json").exists()


def test_combine_and_the_ingest_row(tmp_path):
    summary = combine_ledgers(_synthetic())
    assert (len(summary.bins), len(summary.inputs), summary.rows) == (3102, 24, 3102)
    write_summary(tmp_path / "s.json", summary)
    assert read_summary(tmp_path / "s.json") == summary
    ingest, ident = recount_ingest(summary), summary.identity
    assert (
        ingest.table,
        ingest.source,
        ingest.ingest_version,
        ingest.registry_version,
        ingest.adapter_git_sha,
        ingest.n_rows,
    ) == (
        "measured.allele_observations_binned",
        "gnomad_hgdp_1kg",
        "2026-12-recount",
        ident.registry_version,
        ident.git_sha,
        summary.rows,
    )
    assert ingest.adapter == "genomeos/observations/sources/gnomad_recount/jobs.py"
    assert (ingest.source_record_id_template, ingest.sample_rule, ingest.sample_stage_sha256) == (
        SOURCE_RECORD_ID_TEMPLATE,
        ident.cohort_id,
        ident.stage_sha256,
    )
    assert len(ingest.inputs) == 26 and all(
        i.key is None and i.url and i.md5 and i.generation for i in ingest.inputs
    )
    assert {i.url for i in ingest.inputs if i.sha256} == {METADATA_URL, SAMPLE_META_URL}
    assert [i.url for i in ingest.inputs[:24]] == [GNOMAD_VCF_URL.format(chrom=c) for c in GRCH38_LENGTHS]
    refusals = {dataclasses.astuple(refusal) for refusal in ingest.refusals}
    assert refusals == {
        ("low_gq", "hgdp-han", 2),
        ("an_zero", "hgdp-northernhan", 1),
        ("non_pass:AC0", None, 1),
        ("monomorphic_in_stage", None, 1),
    }
    # check 9: every input is a cited URL with md5 and generation, so no manifest is needed
    measured.check_ingest_inputs([ingest], published={})
    one = dataclasses.replace(summary, identity=dataclasses.replace(ident, karyotypes=ident.metadata))
    assert [i.url for i in recount_ingest(one).inputs[24:]] == [METADATA_URL]  # one file cited once (O3)


def test_a_cited_input_without_generation_fails_check_9():
    """``IngestInput`` refuses a cited input without a generation: no ingest row reaches check 9 with one."""
    ingest = recount_ingest(combine_ledgers(_synthetic()))
    first, *rest = ingest.inputs
    with pytest.raises(TableError, match="generation"):
        measured.check_ingest_inputs(
            [dataclasses.replace(ingest, inputs=(dataclasses.replace(first, generation=None), *rest))],
            published={},
        )


def _drop(job_id):
    return lambda ledgers: [ledger for ledger in ledgers if ledger.job.job_id != job_id]


def _change(job_id, change):
    return lambda ledgers: [change(ledger) if ledger.job.job_id == job_id else ledger for ledger in ledgers]


def _identity(**changes):
    return lambda ledger: dataclasses.replace(
        ledger, identity=dataclasses.replace(ledger.identity, **changes)
    )


def _vcf_md5(ledger):
    vcf = dataclasses.replace(ledger.identity.vcf, md5="1" * 32)
    return dataclasses.replace(ledger, identity=dataclasses.replace(ledger.identity, vcf=vcf))


def _extra(ledgers):
    return [
        *ledgers,
        dataclasses.replace(ledgers[0], job=Job("chr1", 13, 260_000_000, 279_999_999, tuple(range(20)))),
    ]


def _both(*cases):
    return lambda ledgers: functools.reduce(lambda found, case: case(found), cases, ledgers)


COMBINE_REFUSALS = {
    "missing": (_drop("chrY-02"), r"missing jobs: \['chrY-02'\]"),
    "unexpected": (_extra, r"unexpected jobs: \['chr1-13'\]"),
    "repeated": (lambda ledgers: [*ledgers, ledgers[5]], r"repeated jobs: \['chr1-05'\]"),
    "incomplete": (
        _change(
            "chr1-00",
            lambda ledger: dataclasses.replace(ledger, bins={b: e for b, e in ledger.bins.items() if b != 3}),
        ),
        r"incomplete.*chr1-00",
    ),
    "stage": (_change("chr2-00", _identity(stage_sha256="f" * 64)), r"chr2-00: stage_sha256"),
    "vcf": (_change("chr1-01", _vcf_md5), "two VCFs for chr1"),
    "dirty": (_change("chr3-00", _identity(git_sha="0" * 40 + "-dirty")), "dirty"),
    "git_sha": (_change("chr3-00", _identity(git_sha="1" * 40)), r"chr3-00: git_sha"),
    "every problem at once": (
        _both(_drop("chrY-02"), _change("chr3-00", _identity(git_sha="1" * 40))),
        r"chrY-02.*chr3-00: git_sha",
    ),
}


@pytest.mark.parametrize("case", list(COMBINE_REFUSALS))
def test_combine_refuses(case):
    change, match = COMBINE_REFUSALS[case]
    with pytest.raises(RecountError, match=match):
        combine_ledgers(change(list(_synthetic())))


@requires_native
def test_two_runs_give_identical_bins_and_ledgers(tmp_path):
    env, job = job_env(tmp_path), job_by_id("chr1-00")
    first = run_job(job, env.identity, **env.paths(tmp_path / "a"))
    assert run_job(job, env.identity, **env.paths(tmp_path / "b")) == first
    assert (tmp_path / "a" / "ledger.json").read_bytes() == (tmp_path / "b" / "ledger.json").read_bytes()
    for entry in first.bins.values():
        a, b = (tmp_path / run / "bins" / entry.file.path for run in "ab")
        assert a.read_bytes() == b.read_bytes()


@requires_native
def test_an_interrupted_job_resumes_at_the_first_unwritten_bin(tmp_path, monkeypatch):
    env, job = job_env(tmp_path), job_by_id("chr1-00")
    clean = run_job(job, env.identity, **env.paths(tmp_path / "clean"))
    streamed: list[int] = []
    cancelled: list[int] = []
    real = jobs.native.native_bin

    def interrupted(vcf, ref, stage, workdir):
        streamed.append(ref.bin)
        if ref.bin == 7 and not cancelled:  # the first visit to bin 7 only
            cancelled.append(ref.bin)
            raise OSError("the runner was cancelled")
        return real(vcf, ref, stage, workdir)

    monkeypatch.setattr(jobs.native, "native_bin", interrupted)
    with pytest.raises(OSError, match="cancelled"):
        run_job(job, env.identity, **env.paths(tmp_path))
    partial = read_ledger(tmp_path / "ledger.json")
    assert partial is not None and sorted(partial.bins) == list(range(7)) and not partial.complete
    streamed.clear()
    resumed = run_job(job, env.identity, **env.paths(tmp_path))
    assert streamed == list(range(7, 20))
    assert resumed == clean


@requires_native
def test_a_damaged_bin_is_rewritten_to_its_recorded_hash(tmp_path, monkeypatch):
    env, job = job_env(tmp_path), job_by_id("chr1-00")
    ledger = run_job(job, env.identity, **env.paths(tmp_path))
    damaged = tmp_path / "bins" / ledger.bins[0].file.path
    damaged.write_bytes(b"PAR1 damaged")
    streamed: list[int] = []
    real = jobs.native.native_bin

    def counted(vcf, ref, stage, workdir):
        streamed.append(ref.bin)
        return real(vcf, ref, stage, workdir)

    monkeypatch.setattr(jobs.native, "native_bin", counted)
    assert run_job(job, env.identity, **env.paths(tmp_path)) == ledger and streamed == [0]
    assert _sha256(damaged) == ledger.bins[0].file.sha256
    damaged.unlink()
    monkeypatch.setattr(jobs.native, "native_bin", lambda *a: dataclasses.replace(real(*a), sites=()))
    with pytest.raises(RecountError, match="non-deterministic rewrite"):
        run_job(job, env.identity, **env.paths(tmp_path))


def _changed(env, field):
    """``env``'s identity with ``field`` changed, and the ``run_job`` keywords that keep it consistent."""
    identity = env.identity
    if field == "stage_sha256":
        stage = Stage(env.stage.name, env.stage.samples, "f" * 64)
        return dataclasses.replace(identity, stage_sha256=stage.ids_sha256), {"stage": stage}
    if field == "populations":
        table = env.table.assign(population_id=env.table["population_id"] + "-2")
        pairs = tuple(zip(table["source_label"], table["population_id"], strict=True))
        return dataclasses.replace(identity, populations=pairs), {"table": table}
    value = {
        "git_sha": "1" * 40,
        "ingest_version": "2026-12-recount-b",
        "sampling_design": "population_survey",
    }
    return dataclasses.replace(identity, **{field: value[field]}), {}


@requires_native
@pytest.mark.parametrize(
    "field", ["git_sha", "stage_sha256", "ingest_version", "populations", "sampling_design"]
)
def test_a_changed_identity_refuses_to_resume(tmp_path, monkeypatch, field):
    env, job = job_env(tmp_path), job_by_id("chr1-00")
    real = jobs.native.native_bin

    def stopped(vcf, ref, stage, workdir):
        if ref.bin == 2:
            raise OSError("stopped after two bins")
        return real(vcf, ref, stage, workdir)

    monkeypatch.setattr(jobs.native, "native_bin", stopped)
    with pytest.raises(OSError):
        run_job(job, env.identity, **env.paths(tmp_path))
    before = _files(tmp_path)
    identity, keywords = _changed(env, field)
    with pytest.raises(RecountError, match=rf"identity \({field}\)"):
        run_job(job, identity, **env.paths(tmp_path) | keywords)
    assert _files(tmp_path) == before


@requires_native
def test_a_job_on_a_chromosome_the_file_lacks_fails_before_writing(tmp_path):
    env = job_env(tmp_path)
    with pytest.raises(RecountError, match="no records on chr2: wrong file for this job"):
        run_job(job_by_id("chr2-00"), env.identity, **env.paths(tmp_path))
    assert not list(tmp_path.rglob("*.parquet")) and not (tmp_path / "ledger.json").exists()


@requires_native
def test_a_contig_length_off_grch38_fails_before_writing(tmp_path):
    env = job_env(tmp_path)
    text = (FIXTURES / "windows.vcf").read_text(encoding="utf-8")
    off = text.replace("##contig=<ID=chr1,length=248956422>", "##contig=<ID=chr1,length=248956421>")
    assert off != text
    (tmp_path / "off").mkdir()
    vcf = indexed_vcf(tmp_path / "off", off)
    with pytest.raises(RecountError, match="248956421"):
        run_job(job_by_id("chr1-00"), env.identity, **env.paths(tmp_path) | {"source": str(vcf)})
    assert not list(tmp_path.rglob("*.parquet"))


@requires_native
def test_a_replaced_upstream_object_fails_before_writing(tmp_path, monkeypatch):
    env = job_env(tmp_path)
    cited = dataclasses.replace(env.identity.vcf, url=GNOMAD_VCF_URL.format(chrom="chr1"))
    monkeypatch.setattr(
        jobs, "head_identity", lambda url: dataclasses.replace(cited, generation=cited.generation + 1)
    )
    with pytest.raises(RecountError, match="generation"):
        run_job(job_by_id("chr1-00"), dataclasses.replace(env.identity, vcf=cited), **env.paths(tmp_path))
    assert not list(tmp_path.rglob("*.parquet")) and not (tmp_path / "ledger.json").exists()


@requires_native
def test_an_object_replaced_during_the_job_leaves_its_ledger_incomplete(tmp_path, monkeypatch):
    env = job_env(tmp_path)
    cited = dataclasses.replace(env.identity.vcf, url=GNOMAD_VCF_URL.format(chrom="chr1"))
    heads = [cited, dataclasses.replace(cited, md5="1" * 32)]
    monkeypatch.setattr(jobs, "head_identity", lambda url: heads.pop(0))
    with pytest.raises(RecountError, match="md5"):
        run_job(job_by_id("chr1-00"), dataclasses.replace(env.identity, vcf=cited), **env.paths(tmp_path))
    ledger = read_ledger(tmp_path / "ledger.json")
    assert ledger is not None and not ledger.complete and sorted(ledger.bins) == list(range(19))


class _Reply:
    """A HEAD reply as ``urllib.request.urlopen`` gives it."""

    def __init__(self, headers: email.message.Message) -> None:
        self.status, self.headers = 200, headers

    def __enter__(self) -> _Reply:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def test_head_identity_reads_the_md5_from_every_x_goog_hash(monkeypatch):
    headers = email.message.Message()
    headers["Content-Length"] = "1234"
    headers["x-goog-generation"] = "1634000000000000"
    headers["x-goog-hash"] = "crc32c=AAAAAA=="  # GCS sends the crc32c first and the md5 in a second header
    headers["x-goog-hash"] = "md5=" + base64.b64encode(bytes(range(16))).decode()
    methods: list[str] = []
    monkeypatch.setattr(
        jobs.urllib.request,
        "urlopen",
        lambda request, timeout: methods.append(request.get_method()) or _Reply(headers),
    )
    assert jobs.head_identity(METADATA_URL) == CitedFile(
        METADATA_URL, 1234, bytes(range(16)).hex(), 1634000000000000, None
    )
    assert methods == ["HEAD"]
    del headers["x-goog-hash"]
    headers["x-goog-hash"] = "crc32c=AAAAAA=="
    with pytest.raises(RecountError, match="md5"):
        jobs.head_identity(METADATA_URL)
    with pytest.raises(RecountError, match="https"):
        jobs.head_identity("/data/gnomad.vcf.bgz")


def _registry(root: Path) -> Path:
    """The HGDP + 1KG fixture registry's folder under ``root``, written as the reference stage writes one."""
    release = reference.hgdp_1kg_registry(HGDP_1KG_FIXTURE)
    version = release.registry_version
    frames = reference.reference_frames(release.populations, release.aliases, registry_version=version)
    source = InputRef(
        dr.release_key("2026-12-01", "registry/hgdp_1kg/1.0.0/populations.tsv"), _sha256(HGDP_1KG_FIXTURE)
    )
    tables = (reference.POPULATIONS_TABLE, reference.ALIASES_TABLE)
    for path, table, frame in zip(reference.reference_paths(version), tables, frames, strict=True):
        writer.write_frame(
            writer.connect(),
            frame,
            root / path,
            table=table,
            git_sha="0" * 40,
            inputs=[source],
            sources=list(RECOUNT_SOURCES),
            order_by=contracts.TABLE_CONTRACTS[table].key,
        )
    return root / reference.reference_paths(version)[0].rsplit("/", 1)[0]


def _cited(url: str, path: Path, generation: int) -> CitedFile:
    raw = path.read_bytes()
    return CitedFile(url, len(raw), hashlib.md5(raw, usedforsecurity=False).hexdigest(), generation, None)


@requires_native
def test_cli_plan_cite_and_run(tmp_path, monkeypatch, capsys):
    assert cli.main(["plan"]) == 0
    planned = json.loads(capsys.readouterr().out)["jobs"]
    assert len(planned) == 166 and planned[:2] == ["chr1-00", "chr1-01"] and planned[-1] == "chrY-02"

    vcf = indexed_vcf(tmp_path, (FIXTURES / "windows.vcf").read_text(encoding="utf-8"))
    karyotypes = tmp_path / "sample_meta.tsv.bgz"  # read through gzip, cited as its compressed bytes
    karyotypes.write_bytes(gzip.compress((FIXTURES / "karyotypes.tsv").read_bytes()))
    metadata = tmp_path / "gnomad_meta_updated.tsv"
    shutil.copyfile(FIXTURES / "metadata.tsv", metadata)
    upstream = {
        GNOMAD_VCF_URL.format(chrom="chr11"): _cited(GNOMAD_VCF_URL.format(chrom="chr11"), vcf, 11),
        METADATA_URL: _cited(METADATA_URL, metadata, 12),
        SAMPLE_META_URL: _cited(SAMPLE_META_URL, karyotypes, 13),
    }
    monkeypatch.setattr(jobs, "head_identity", upstream.__getitem__)
    assert cli.main(["cite", "--chrom", "chr11"]) == 0
    cited = json.loads(capsys.readouterr().out)
    assert {name: item["url"] for name, item in cited.items()} == {
        "vcf": GNOMAD_VCF_URL.format(chrom="chr11"),
        "metadata": METADATA_URL,
        "karyotypes": SAMPLE_META_URL,
    }
    (tmp_path / "cited.json").write_text(json.dumps(cited), encoding="utf-8")
    elsewhere = {**cited, "vcf": {**cited["vcf"], "url": "https://example.org/x.vcf.gz"}}
    (tmp_path / "elsewhere.json").write_text(json.dumps(elsewhere), encoding="utf-8")

    monkeypatch.setattr(cli, "git_sha", lambda: "0" * 40)
    out = tmp_path / "out"
    args = {
        "--job": "chr11-00",
        "--cited": str(tmp_path / "cited.json"),
        "--vcf": str(vcf),
        "--metadata": str(metadata),
        "--karyotypes": str(karyotypes),
        "--stage": str(FIXTURES / "stage.txt"),
        "--stage-name": "fixture-8",
        "--registry": str(_registry(tmp_path / "data")),
        "--registry-release": "2026-12-01",
        "--ingest-version": "2026-12-recount",
        "--sampling-design": "healthy_reference",
        "--disease-ascertainment-excluded": "true",
        "--out": str(out / "bins"),
        "--ledger-dir": str(out / "ledgers"),
        "--workdir": str(out / "work"),
    }

    def argv(**changes: str | None) -> list[str]:
        merged = {**args, **{f"--{k.replace('_', '-')}": v for k, v in changes.items()}}
        return [
            "run",
            *(part for flag, value in merged.items() if value is not None for part in (flag, value)),
        ]

    assert cli.main(argv(cited=str(tmp_path / "elsewhere.json"))) == 1
    assert "not the gnomAD v3.1.2 URL for chr11" in capsys.readouterr().err
    monkeypatch.setattr(cli, "git_sha", lambda: "0" * 40 + "-dirty")
    assert cli.main(argv()) == 1 and "dirty" in capsys.readouterr().err
    monkeypatch.setattr(cli, "git_sha", lambda: "0" * 40)
    assert cli.main(argv()) == 0
    ledger = read_ledger(out / "ledgers" / "chr11-00.json")
    assert ledger is not None and ledger.complete and ledger.bins[5].file.rows == 4  # rs334 in 4 populations
    identity = ledger.identity
    assert identity.vcf == upstream[GNOMAD_VCF_URL.format(chrom="chr11")]
    assert (identity.metadata.sha256, identity.karyotypes.sha256) == (_sha256(metadata), _sha256(karyotypes))
    assert identity.sources == RECOUNT_SOURCES and identity.git_sha == "0" * 40
    assert [key.rsplit("/", 1)[-1] for key in (ref.key for ref in identity.registry_inputs)] == [
        "populations.parquet",
        "population_aliases.parquet",
    ]
    assert all(
        ref.key.startswith("releases/2026-12-01/tables/v1/reference/populations/")
        for ref in identity.registry_inputs
    )
    capsys.readouterr()
    with pytest.raises(SystemExit) as exited:
        cli.main(argv(sampling_design=None))
    assert exited.value.code == 2
