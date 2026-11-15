"""The curated AFND ingests under ``tables/v1/measured/``, and ``measured.ingests``.

Atlas data platform design 2026-10-18 §2.4, §2.7 checks 2-5 and 9, and §2.9; builder's call 6; step 1.9.
``built`` is a ``data/`` tree with no committed release, holding ``tests/fixtures/afnd_frequencies_mixed.tsv``
as the AFND harvest's frequency table and the released ``data/raw/afnd_populations.tsv``, with the measured
stage built over it. The fixture has two HLA rows (DQB1*03:01 in two populations), a cytokine triple
(IL-6 -174 CC, CG, GG), a KIR gene-presence row (2DL1) and a KIR allele row (3DL1*007), all in populations
the ``afnd-2026-08`` registry places. ``AF``, ``CYT`` and ``KIR`` are its three parts.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from dataclasses import dataclass, replace
from pathlib import Path

import duckdb
import pandas as pd
import pyarrow.parquet as pq
import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.publication import data_release as dr
from genomeos.publication import raw_harvests as rh
from genomeos.tables import catalog, contracts, measured, provenance, reference, writer
from genomeos.tables.contracts import TableError
from genomeos.tables.measured import ALLELE_TABLE, CARRIER_TABLE, INGESTS_PATH, SORT_KEY
from genomeos.tables.provenance import InputRef
from scripts import build_tables
from tests.observation_fixtures import carrier_rows, observation_rows
from tests.tables_fixtures import EPOCH, GIT_SHA, ROOT, FixtureTree, commit_release, write_parity_file

FIXTURE = Path(__file__).parent / "fixtures" / "afnd_frequencies_mixed.tsv"
#: The released AFND population table, from which the ``afnd-2026-08`` registry is rebuilt (call 18).
POPULATIONS = ROOT / "data" / measured.AFND_POPULATIONS
IV = "afnd-2026-08"
AF = measured.part_path(ALLELE_TABLE, "afnd_frequencies", IV)
CYT = measured.part_path(ALLELE_TABLE, "afnd", IV)
KIR = measured.part_path(CARRIER_TABLE, "afnd", IV)
LATER = "2026-11-21"
WITHDRAWN = "meta.withdrawn"


@dataclass(frozen=True)
class Built:
    """A tree the measured stage was built over, and the ingests the stage returned."""

    tree: FixtureTree
    ingests: tuple[measured.Ingest, ...]

    @property
    def out(self) -> Path:
        return self.tree.data


def _tree(root: Path) -> FixtureTree:
    tree = FixtureTree(root, root / "data", root / "releases")
    for path, source in ((measured.AFND_FREQUENCIES, FIXTURE), (measured.AFND_POPULATIONS, POPULATIONS)):
        (tree.data / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, tree.data / path)
    return tree


@pytest.fixture
def built(tmp_path: Path) -> Built:
    tree = _tree(tmp_path)
    return Built(tree, build_tables.build_measured(tree.ctx))


def _digests(data: Path) -> dict[str, str]:
    root = data / "tables"
    return {
        path.relative_to(data).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*") if root.is_dir() else [])
        if path.is_file()
    }


def test_kir_presence_is_carriers_over_individuals_never_allele_rows(built):
    names = pq.read_schema(built.out / KIR).names
    assert {"carriers", "n_individuals"} <= set(names) and not {"ac", "an"} & set(names)
    assert "kir:2dl1" not in set(pd.read_parquet(built.out / AF)["variant_id"]) | set(
        pd.read_parquet(built.out / CYT)["variant_id"]
    )


def test_ingests_has_one_row_per_table_source_and_version(built):
    rows = pq.read_table(built.out / INGESTS_PATH).to_pylist()
    assert [(r["table"], r["source"], r["ingest_version"]) for r in rows] == [
        (ALLELE_TABLE, "afnd", "afnd-2026-08"),
        (ALLELE_TABLE, "afnd_frequencies", "afnd-2026-08"),
        (CARRIER_TABLE, "afnd", "afnd-2026-08"),
    ]
    assert {r["registry_version"] for r in rows} == {"afnd-2026-08"} and all(
        r["source_record_id_template"] is None for r in rows
    )
    assert rows[1]["adapter"] == "genomeos/observations/sources/afnd_frequencies.py"
    assert [r["adapter"] for r in rows] == [
        "genomeos/observations/sources/afnd_cytokines.py",
        "genomeos/observations/sources/afnd_frequencies.py",
        "genomeos/observations/sources/afnd_carriers.py",
    ]
    assert {r["adapter_git_sha"] for r in rows} == {GIT_SHA}
    assert built.ingests == measured.read_ingests(built.out / INGESTS_PATH)


def test_allele_parts_store_the_17_observation_columns_sorted(built):
    for path in (AF, CYT):
        names = pq.read_schema(built.out / path).names
        assert names == list(OBSERVATIONS_SCHEMA.columns) and len(names) == 17
        assert not [name for name in names if "freq" in name]
        rows = pd.read_parquet(built.out / path)
        assert rows.equals(rows.sort_values(list(SORT_KEY), ignore_index=True))
    assert list(pd.read_parquet(built.out / AF)["variant_id"]) == [
        "hla:dqb1-03-01",
        "hla:dqb1-03-01",
        "kir:3dl1-007",
    ]
    assert list(pd.read_parquet(built.out / CYT)["variant_id"]) == ["cyt:il-6-174-c"]
    kir = pd.read_parquet(built.out / KIR)
    found = zip(kir["variant_id"], kir["carriers"], kir["n_individuals"], strict=True)
    assert list(found) == [("kir:2dl1", 95, 100)]


def test_a_part_holds_one_source_and_one_ingest_version(built):
    rows = observation_rows(4)
    two = rows.assign(ingest_version=["map-2026-08", "map-2026-08", "map-2026-09", "map-2026-09"])
    held = r"one ingest_version; these rows hold \['map-2026-08', 'map-2026-09'\]"
    with pytest.raises(TableError, match=held):
        measured.ingest_part(two, table=ALLELE_TABLE)
    with pytest.raises(TableError, match="source_record_id"):
        measured.ingest_part(rows.assign(source_record_id="map-surveys:100"), table=ALLELE_TABLE)
    with pytest.raises(TableError, match="carriers"):  # a carrier frame is never an allele part
        measured.ingest_part(carrier_rows(2), table=ALLELE_TABLE)
    afnd = pd.read_parquet(built.out / AF)
    measured.check_partition_values(AF, afnd)
    elsewhere = "tables/v1/measured/allele_observations/source=map/ingest_version=afnd-2026-08/part-0.parquet"
    with pytest.raises(TableError, match="3 rows have source 'afnd_frequencies', not the folder's 'map'"):
        measured.check_partition_values(elsewhere, afnd)


def test_ingest_inputs_and_refusals_are_recorded(built):
    paths = (measured.AFND_FREQUENCIES, measured.AFND_POPULATIONS)
    refs = [
        InputRef(dr.release_key(EPOCH, path), hashlib.sha256((built.out / path).read_bytes()).hexdigest())
        for path in paths
    ]
    inputs = tuple(
        measured.IngestInput(bytes=(built.out / path).stat().st_size, key=ref.key, sha256=ref.sha256)
        for path, ref in zip(paths, refs, strict=True)
    )
    by_key = {(ingest.table, ingest.source): ingest for ingest in built.ingests}
    for curated in measured.CURATED_INGESTS:
        ingest = by_key[(curated.table, curated.source)]
        assert ingest.inputs == inputs
        _, report = curated.load(*(built.out / path for path in curated.inputs), IV)
        assert {refusal.reason: refusal.count for refusal in ingest.refusals} == report.refusals
        assert all(refusal.population_id is None for refusal in ingest.refusals)
        part = built.out / measured.part_path(curated.table, curated.source, IV)
        assert ingest.n_rows == pq.read_metadata(part).num_rows
        recorded = provenance.decode_inputs(provenance.read_kv(part)["genomeos.inputs"])
        assert recorded == tuple(sorted(refs))
        assert provenance.read_kv(part)[provenance.SOURCES_KEY] == '["afnd"]'
    rows = {(r["table"], r["source"]): r for r in pq.read_table(built.out / INGESTS_PATH).to_pylist()}
    assert rows[(ALLELE_TABLE, "afnd_frequencies")]["refusals"] == [
        {"reason": "cytokine_genotype_not_allele_frequency", "population_id": None, "count": 3},
        {"reason": "kir_gene_presence_not_allele_frequency", "population_id": None, "count": 1},
    ]
    assert rows[(ALLELE_TABLE, "afnd")]["inputs"][0] == {
        "bytes": inputs[0].bytes,
        "key": refs[0].key,
        "sha256": refs[0].sha256,
        "url": None,
        "md5": None,
        "generation": None,
    }


def test_the_stage_prints_each_part_and_each_refusal(tmp_path, capsys):
    build_tables.build_measured(_tree(tmp_path).ctx)
    out = capsys.readouterr().out
    assert f"{ALLELE_TABLE} source=afnd_frequencies ingest_version={IV}: 3 rows, written" in out
    assert "  refused 3 cytokine_genotype_not_allele_frequency" in out
    assert "  refused 1 kir_gene_presence_not_allele_frequency" in out
    assert f"{CARRIER_TABLE} source=afnd ingest_version={IV}: 1 rows, written" in out
    assert "measured.ingests: 3 rows" in out


def test_the_same_ingest_twice_is_refused(tmp_path, built):
    tree = _tree(tmp_path / "again")
    first = measured.CURATED_INGESTS[0]
    with pytest.raises(TableError, match="twice"):
        build_tables.build_measured(tree.ctx, [first, replace(first, adapter="genomeos/x.py")])
    assert _digests(tree.data) == {}
    with pytest.raises(TableError, match="twice"):
        measured.ingests_table([built.ingests[0], built.ingests[0]])


def test_check_9_refuses_inputs_that_are_not_released_or_cited(built):
    manifest = commit_release(built.out, built.tree.releases, EPOCH)
    released = {item.key: item for item in dr.validate_manifest(manifest)}
    measured.check_ingest_inputs(built.ingests, released)
    ingest = built.ingests[0]
    first, *rest = ingest.inputs
    unreleased = replace(first, key=dr.release_key("2026-11-19", measured.AFND_FREQUENCIES))
    with pytest.raises(TableError, match=r"afnd_frequencies.tsv is not a manifest key"):
        measured.check_ingest_inputs([replace(ingest, inputs=(unreleased, *rest))], released)
    wrong = replace(first, sha256="0" * 64)
    with pytest.raises(TableError, match=r"sha256 0{64}, but the manifest records"):
        measured.check_ingest_inputs([replace(ingest, inputs=(wrong, *rest))], released)
    with pytest.raises(TableError, match="generation"):
        measured.IngestInput(bytes=10, url="https://example.org/afnd.tsv", md5="1B2M2Y8AsgTpgAmY7PhCfg==")
    cited = measured.IngestInput(
        bytes=10, url="https://example.org/afnd.tsv", md5="1B2M2Y8AsgTpgAmY7PhCfg==", generation=1
    )
    measured.check_ingest_inputs([replace(ingest, inputs=(cited,))], released)


def test_check_4_reingest_must_give_the_same_record_ids(built):
    part = pd.read_parquet(built.out / AF)
    measured.reingest_matches(part, part.iloc[::-1])
    with pytest.raises(TableError, match="source_record_id"):
        measured.reingest_matches(part, part.iloc[1:])
    commit_release(built.out, built.tree.releases, EPOCH)
    curated = measured.CURATED_INGESTS[0]

    def short(*args):
        rows, report = curated.load(*args)
        return rows.iloc[1:], report

    later = built.tree.context(release=LATER)
    with pytest.raises(TableError, match=rf"{re.escape(AF)}: check 4: .*source_record_id"):
        build_tables.build_measured(later, [replace(curated, load=short)])


def test_check_5_every_population_resolves_in_afnd_2026_08(tmp_path):
    tree = _tree(tmp_path)
    curated = measured.CURATED_INGESTS[0]

    def unknown(*args):
        rows, report = curated.load(*args)
        return rows.assign(population_id="afnd-999999"), report

    with pytest.raises(TableError, match="afnd-999999"):
        build_tables.build_measured(tree.ctx, [replace(curated, load=unknown)])
    assert _digests(tree.data) == {}


def test_map_rows_need_their_spatial_support_adapter(tmp_path):
    """Check 3: MAP's area-class radii fail ``sampling_bounding_disc`` (docs/map-spatial-support.md), so MAP
    rows enter only through ``map_surveys``, whose ``_explicit_radii`` enforces the contract."""
    tree = _tree(tmp_path)
    parity = pd.read_parquet(write_parity_file(tmp_path / "parity")).assign(source="map_surveys")
    ingest = measured.CuratedIngest(
        ALLELE_TABLE,
        "map_surveys",
        "map-2026-08",
        reference.MAP_LEGACY,
        adapter="tests/x.py",
        inputs=build_tables.MAP_SURVEYS[:1],
        load=lambda *args: (parity, None),
    )
    with pytest.raises(TableError, match="spatial-support contract"):
        build_tables.build_measured(tree.ctx, [ingest])
    assert _digests(tree.data) == {}
    assert dict(measured.SPATIAL_SUPPORT_ADAPTERS) == {
        "map_surveys": "genomeos/observations/sources/map_surveys.py"
    }


def test_a_published_part_is_verified_not_rewritten(built, tmp_path, capsys):
    digests = _digests(built.out)
    commit_release(built.out, built.tree.releases, EPOCH)
    later = built.tree.context(release=LATER, git_sha="1" * 40)
    capsys.readouterr()
    again = build_tables.build_measured(later)
    assert capsys.readouterr().out.count(", verified") == 3
    parts = (AF, CYT, KIR)
    assert {path: _digests(built.out)[path] for path in parts} == {path: digests[path] for path in parts}
    for path in parts:
        assert provenance.read_kv(built.out / path)["genomeos.git_sha"] == GIT_SHA
    # measured.ingests is a summary table: it gets a new key each release, and records this run.
    assert {ingest.adapter_git_sha for ingest in again} == {"1" * 40}
    assert [ingest.inputs for ingest in again] == [ingest.inputs for ingest in built.ingests]
    curated = measured.CURATED_INGESTS[0]

    def drifted(*args):
        rows, report = curated.load(*args)
        return rows.assign(ac=rows["ac"] + [1, *[0] * (len(rows) - 1)]), report

    with pytest.raises(TableError, match=r"a released part is immutable .* in 1 rows"):
        build_tables.build_measured(later, [replace(curated, load=drifted)])
    assert {path: _digests(built.out)[path] for path in parts} == {path: digests[path] for path in parts}
    other = _tree(tmp_path / "other")
    build_tables.build_measured(other.ctx)
    assert _digests(other.data) == digests


def test_a_stray_part_stops_the_stage_before_writing(tmp_path):
    tree = _tree(tmp_path)
    stray = tree.data / measured.part_path(ALLELE_TABLE, "afnd_frequencies", "afnd-2026-07")
    stray.parent.mkdir(parents=True)
    stray.write_bytes(b"PAR1 stand-in")
    unpublished = r"ingest_version=afnd-2026-07/part-0.parquet: no release published it"
    with pytest.raises(TableError, match=unpublished):
        build_tables.build_measured(tree.ctx)
    assert list(_digests(tree.data)) == [stray.relative_to(tree.data).as_posix()]


def test_inputs_resolve_through_fetch_data(tmp_path, monkeypatch):
    tree = _tree(tmp_path)
    asked = []
    monkeypatch.setattr(build_tables.fetch_data, "require_local", lambda path: asked.append(path) or path)
    build_tables.build_measured(tree.ctx)
    inputs = (measured.AFND_FREQUENCIES, measured.AFND_POPULATIONS)
    assert sorted(asked) == sorted(tree.data / path for path in inputs)


def test_the_curated_ingests_read_the_released_afnd_inputs():
    harvested = {rh.harvest_path(harvest, name) for harvest in rh.RAW_HARVESTS for name, _ in harvest.files}
    assert measured.AFND_FREQUENCIES in harvested and measured.AFND_POPULATIONS in rh.LEGACY_RAW
    assert measured.AFND_POPULATIONS == build_tables.AFND_POPULATIONS
    assert contracts.table_path(measured.INGESTS_TABLE) == INGESTS_PATH
    for ingest in measured.CURATED_INGESTS:
        assert (ROOT / ingest.adapter).is_file()
        assert ingest.inputs == (measured.AFND_FREQUENCIES, measured.AFND_POPULATIONS)
        assert (ingest.ingest_version, ingest.registry_version) == (IV, reference.AFND_LEGACY)


# --- the catalog over the measured parts (§2.6, §2.9) ---


def _catalog_sql(built: Built, *, withdraw: str | None = None) -> str:
    """``catalog.sql`` over the three parts and ``measured.ingests``, keyed under ``EPOCH``, and a
    ``meta.withdrawn`` file listing ``withdraw``."""

    def listed(path: str) -> catalog.CatalogFile:
        local = built.out / path
        return catalog.CatalogFile(
            contracts.table_of(path),
            path,
            dr.release_key(EPOCH, path),
            hashlib.sha256(local.read_bytes()).hexdigest(),
            local.stat().st_size,
            pq.read_metadata(local).num_rows,
        )

    files = [listed(path) for path in (AF, CYT, KIR, INGESTS_PATH)]
    entries = [
        {
            "key": file.key,
            "path": file.path,
            "sha256": file.sha256,
            "reason": "a fixture takedown",
            "issue": "https://github.com/genomeOS/genomeOS/issues/1",
            "date": "2026-11-15",
            "decided_by": "owner",
        }
        for file in files
        if file.path == withdraw
    ]
    path = contracts.table_path(WITHDRAWN)
    writer.write_frame(
        writer.connect(),
        pd.DataFrame(entries, columns=list(contracts.columns(WITHDRAWN))),
        built.out / path,
        table=WITHDRAWN,
        git_sha=GIT_SHA,
        inputs=[InputRef("git:data/releases/WITHDRAWN.json", "0" * 64)],
        sources=["genomeos"],
        order_by=("key",),
    )
    return catalog.render_catalog_sql(EPOCH, [*files, listed(path)])


def test_no_measured_view_divides_counts(built):
    catalog_sql = _catalog_sql(built)
    views = set(catalog.catalog_views(catalog_sql))
    assert {ALLELE_TABLE, CARRIER_TABLE, measured.INGESTS_TABLE} <= views
    assert re.search(r"\b(ac|carriers)\s*/\s*(an|n_individuals)\b", catalog_sql) is None


def test_a_withdrawn_measured_part_reads_no_rows(built):
    database = writer.build_catalog_db(
        _catalog_sql(built, withdraw=AF), built.tree.root / "atlas.duckdb", data_root=built.out
    )
    con = duckdb.connect()
    con.execute("SET VARIABLE genomeos_local = ?", [str(built.out)])
    con.execute(f"ATTACH '{database}' AS atlas (READ_ONLY)")
    cursor = con.execute(f"SELECT * FROM atlas.{ALLELE_TABLE}")
    rows = cursor.fetchall()
    assert [column[0] for column in cursor.description] == list(OBSERVATIONS_SCHEMA.columns)
    assert [row[0] for row in rows] == list(pd.read_parquet(built.out / CYT)["variant_id"])
    assert con.execute(f"SELECT count(*) FROM atlas.{CARRIER_TABLE}").fetchone() == (1,)
    assert con.execute(f'SELECT "table", source FROM atlas.{measured.INGESTS_TABLE}').fetchall() == [
        (ALLELE_TABLE, "afnd"),
        (ALLELE_TABLE, "afnd_frequencies"),
        (CARRIER_TABLE, "afnd"),
    ]
