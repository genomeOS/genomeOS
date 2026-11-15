"""Check 12's independent cross-check of the native recount on sampled bins.

Atlas data platform design 2026-10-18 §1.2 D18, §2.7 check 12 and §2.10; builder's call 38. The sampled bins
cover every class check 12 names and are reproducible; a bin passes only if its published cells, the
independent counter's cells and tally, and its recorded tally all equal a fresh native count, and its audit
checked ploidy wherever it has PASS records. ``tests/test_gnomad_recount_network.py`` runs the same
comparison on gnomAD's own windows (``-m network``).
"""

from __future__ import annotations

import dataclasses
import json
import tempfile
from collections import Counter
from pathlib import Path

import pandas as pd
import pytest

from genomeos.observations.sources.gnomad_hgdp_1kg import SOURCE
from genomeos.observations.sources.gnomad_recount import crosscheck, native
from genomeos.observations.sources.gnomad_recount.crosscheck import (
    REQUIRED_BINS,
    SEED,
    CrosscheckResult,
    choose_check_bins,
    compare_cells,
    crosscheck_bin,
)
from genomeos.observations.sources.gnomad_recount.jobs import job_by_id, run_job
from genomeos.observations.sources.gnomad_recount.rule import RecountError, Tally, bin_region
from genomeos.tables.binned import write_bin
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, lookup_set
from scripts import recount_gnomad_hgdp_1kg as cli
from tests.gnomad_recount_fixtures import FIXTURES, job_env, requires_native

#: Two variants' cells in three populations, index 0-5.
CELLS = pd.DataFrame(
    {
        "variant_id": ["chr1-1000-A-G"] * 3 + ["chr1-2000-ATCT-A"] * 3,
        "source_label": ["Han", "NorthernHan", "PapuanSepik"] * 2,
        "ac": [3, 0, 1, 0, 3, 0],
        "an": [4, 2, 2, 4, 4, 4],
    }
)
#: ``compare``'s stage flags for the fixture stage.
STAGE_FLAGS = (
    *("--metadata", str(FIXTURES / "metadata.tsv"), "--karyotypes", str(FIXTURES / "karyotypes.tsv")),
    *("--stage", str(FIXTURES / "stage.txt"), "--stage-name", "fixture-8"),
)


def _tallies_with_non_snv(m):
    """Every bin of GRCh38 with one PASS record, written, and ``m[ref]`` of them not SNVs (0 if absent)."""
    return {
        ref: Tally(pass_records=1, written_sites=1, pass_non_snv=m.get(ref, 0))
        for ref in lookup_set("s", "v", GRCH38_LENGTHS).bins()
    }


def test_sampling_covers_every_check_12_class_and_is_reproducible():
    assert [bin_region(r) for r in REQUIRED_BINS] == ["autosome", "par", "nonpar", "straddles_par", "nonpar"]
    # every bin has PASS records
    bins = _tallies_with_non_snv({BinRef("chr7", 3): 900, BinRef("chr2", 100): 40})
    chosen = choose_check_bins(bins, extra=3)
    assert chosen[:6] == (*REQUIRED_BINS, BinRef("chr7", 3)) and len(chosen) == len(set(chosen)) == 9
    assert chosen == choose_check_bins(dict(reversed(list(bins.items()))), extra=3)
    assert chosen[6:] != choose_check_bins(bins, extra=3, seed=7)[6:]
    assert all(bin_region(ref) == "autosome" for ref in chosen[5:])
    with pytest.raises(RecountError, match="chrY"):
        choose_check_bins(bins | {BinRef("chrY", 14): Tally()}, extra=0)


def test_sampling_ties_go_to_the_earliest_bin_and_draws_skip_unwritten_bins():
    bins = _tallies_with_non_snv({BinRef("chr10", 0): 7, BinRef("chr2", 0): 7, BinRef("chr11", 5): 7})
    assert choose_check_bins(bins, extra=0) == REQUIRED_BINS + (BinRef("chr2", 0),)
    written = {BinRef("chr3", 4), BinRef("chr9", 9)}
    sparse = {ref: tally if ref in written else Tally(pass_records=1) for ref, tally in bins.items()}
    sparse |= {ref: bins[ref] for ref in (*REQUIRED_BINS, BinRef("chr2", 0))}
    assert set(choose_check_bins(sparse, extra=2)[6:]) == written
    with pytest.raises(RecountError, match="extra"):
        choose_check_bins(sparse, extra=3)
    with pytest.raises(RecountError, match="not an SNV"):
        choose_check_bins(_tallies_with_non_snv({}), extra=0)


def test_compare_cells_ignores_order_and_names_differences():
    assert compare_cells("independent", CELLS, CELLS.sample(frac=1, random_state=SEED)) == []
    problems = compare_cells(
        "independent", CELLS, CELLS.iloc[1:].assign(an=lambda d: d["an"].where(d.index != 3, d["an"] + 1))
    )
    assert len(problems) == 2 and any("only in" in p for p in problems)
    assert CELLS.loc[3, "variant_id"] in " ".join(problems)
    assert compare_cells("published", CELLS, pd.concat([CELLS, CELLS.iloc[[2]]])) == [
        "published: chr1-1000-A-G PapuanSepik is repeated in the published cells"
    ]


@requires_native
def test_a_clean_bin_matches_cell_for_cell(tmp_path):
    env = job_env(tmp_path)
    ledger = run_job(job_by_id("chr1-00"), env.identity, **env.paths(tmp_path))
    assert crosscheck_bin(
        ledger.bins[0], BinRef("chr1", 0), vcf=env.vcf, stage=env.stage, out_root=tmp_path / "bins",
        workdir=tmp_path / "w",
    ) == CrosscheckResult("chr1", 1, 999_999, 20, 20, True, 3)


@pytest.fixture(scope="module")
def chr1_00(tmp_path_factory):
    """``chr1-00`` run once over the fixture windows: its environment, ledger and folder."""
    root = tmp_path_factory.mktemp("chr1-00")
    env = job_env(root)
    return env, run_job(job_by_id("chr1-00"), env.identity, **env.paths(root)), root


def _published_extra_ac(env, entry, out_root, monkeypatch):
    """Bin 0 rewritten with one more Han ``ac`` at chr1:2000, and recorded under the new file's sha256."""
    rows = pd.read_parquet(out_root / entry.file.path)
    wrong = (rows["variant_id"] == "chr1-2000-ATCT-A") & (rows["source_label"] == "Han")
    file = write_bin(
        rows.assign(ac=rows["ac"].where(~wrong, rows["ac"] + 1)),
        out_root,
        lookup_set(SOURCE, env.identity.ingest_version, GRCH38_LENGTHS),
        BinRef("chr1", 0),
        git_sha=env.identity.git_sha,
        inputs=env.identity.registry_inputs,
        sources=env.identity.sources,
    )
    return dataclasses.replace(entry, file=file)


def _independent_missing_a_call(env, entry, out_root, monkeypatch):
    """The independent counter misses one Han allele at chr1:1000 A>G."""
    real = native.query_bin

    def query_bin(*args):
        sites, tally = real(*args)
        first = dataclasses.replace(sites[0], an=(sites[0].an[0] - 1, *sites[0].an[1:]))
        return (first, *sites[1:]), tally

    monkeypatch.setattr(native, "query_bin", query_bin)
    return entry


DAMAGES = {
    "published count": (_published_extra_ac, r"published: chr1-2000-ATCT-A Han"),
    "independent count": (_independent_missing_a_call, r"independent: chr1-1000-A-G Han"),
    "recorded tally": (
        lambda env, entry, root, mp: dataclasses.replace(
            entry, tally=entry.tally.merge(Tally(refusals=Counter({("Han", "low_gq"): 1})))
        ),
        r"recorded tally refusals Han low_gq: native 2, recorded 3",
    ),
    "no ploidy audit": (
        lambda env, entry, root, mp: dataclasses.replace(entry, ploidy_runs=0),
        "recorded: 7 PASS record.*check-ploidy",
    ),
    "unrecorded file": (
        lambda env, entry, root, mp: dataclasses.replace(
            entry, file=dataclasses.replace(entry.file, sha256="0" * 64)
        ),
        "sha256",
    ),
    "another bin's file": (
        lambda env, entry, root, mp: dataclasses.replace(
            entry, file=dataclasses.replace(entry.file, path=entry.file.path.replace("bin=0/", "bin=1/"))
        ),
        "not the file of chr1:0",
    ),
}


@requires_native
@pytest.mark.parametrize("case", list(DAMAGES))
def test_a_wrong_count_or_tally_is_caught(chr1_00, tmp_path, monkeypatch, case):
    env, ledger, root = chr1_00
    out_root = tmp_path / "bins"
    path = ledger.bins[0].file.path
    (out_root / path).parent.mkdir(parents=True)
    (out_root / path).write_bytes((root / "bins" / path).read_bytes())
    damage, match = DAMAGES[case]
    entry = damage(env, ledger.bins[0], out_root, monkeypatch)
    with pytest.raises(RecountError, match=match):
        crosscheck_bin(
            entry, BinRef("chr1", 0), vcf=env.vcf, stage=env.stage, out_root=out_root, workdir=tmp_path / "w"
        )


@requires_native
def test_a_problem_list_names_at_most_five(chr1_00, tmp_path, monkeypatch):
    env, ledger, root = chr1_00
    monkeypatch.setattr(native, "query_bin", lambda *args: ((), Tally()))
    with pytest.raises(RecountError, match=r"and \d+ more") as raised:
        crosscheck_bin(
            ledger.bins[0], BinRef("chr1", 0), vcf=env.vcf, stage=env.stage, out_root=root / "bins",
            workdir=tmp_path / "w",
        )
    assert str(raised.value).count("only in the native count") == 5


@requires_native
def test_compare_writes_no_files(tmp_path, monkeypatch, capsys):
    env = job_env(tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    before = sorted(tmp_path.rglob("*"))
    assert cli.main(["compare", "--region", "chr1:1-999999", "--vcf", env.vcf, *STAGE_FLAGS]) == 0
    assert json.loads(capsys.readouterr().out) == dataclasses.asdict(
        CrosscheckResult("chr1", 1, 999_999, 20, 20, True, 3)
    )
    assert sorted(tmp_path.rglob("*")) == before
    assert cli.main(["compare", "--region", "chr1:1000", "--vcf", env.vcf, *STAGE_FLAGS]) == 1
    assert "chr:start-end" in capsys.readouterr().err
    monkeypatch.setattr(crosscheck.native, "query_region", lambda *args: ((), Tally()))
    assert cli.main(["compare", "--region", "chr1:1-999999", "--vcf", env.vcf, *STAGE_FLAGS]) == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out)["identical"] == 0 and "disagree" in captured.err


def test_compare_counts_inside_its_temporary_folder(tmp_path, monkeypatch, capsys):
    """htslib saves a remote VCF's index in the working directory, so ``compare`` counts with its temporary
    folder as the working directory, and a relative local VCF still resolves."""
    seen = []

    def compare_counters(vcf, chrom, start, end, stage, workdir):
        seen.append((vcf, Path.cwd(), workdir.resolve()))
        return CrosscheckResult(chrom, start, end, 0, 0, True, 0)

    monkeypatch.setattr(crosscheck, "compare_counters", compare_counters)
    monkeypatch.chdir(tmp_path)
    expected = {"windows.vcf.gz": str(tmp_path.resolve() / "windows.vcf.gz"), "https://x/y.vcf.bgz": None}
    for vcf, resolved in expected.items():
        assert cli.main(["compare", "--region", "chr1:1-999999", "--vcf", vcf, *STAGE_FLAGS]) == 0
        passed, cwd, workdir = seen[-1]
        assert passed == (resolved or vcf) and cwd.resolve() == workdir and not workdir.exists()
        assert Path.cwd() == tmp_path and json.loads(capsys.readouterr().out)["cells"] == 0
