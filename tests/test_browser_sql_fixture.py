"""The committed browser SQL fixture: a data-store tree DuckDB-WASM reads over HTTP.

Atlas data platform design 2026-10-18 §2.6, §2.9, §3.1 and step 1.13. ``website/tests/fixtures/data-store``
is release ``2000-01-01`` as the bucket would hold it, keyed for ``http://127.0.0.1:4324/``: a range
probe no view reads, a catalog whose only data views are ``inferred.artifacts`` and
``evidence.parity_observations`` (beside ``meta.release`` and the empty ``meta.withdrawn`` every view
anti-joins), and the release's manifest beside an empty ``WITHDRAWN.json``.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from genomeos.publication import data_release as dr
from genomeos.tables import catalog, writer
from scripts import build_browser_sql_fixture as fixture

FIXTURE = fixture.FIXTURE
RELEASE_DIR = FIXTURE / dr.RELEASE_PREFIX / fixture.FIXTURE_RELEASE
MANIFESTS = FIXTURE / dr.MANIFEST_PREFIX
EMPTY_WITHDRAWN = {
    "schema": dr.WITHDRAWN_SCHEMA,
    "schema_version": dr.WITHDRAWN_SCHEMA_VERSION,
    "withdrawn": [],
}
DATA_VIEWS = {"evidence.parity_observations", "inferred.artifacts"}
#: The views every catalog has whatever it lists (§2.6, §2.9), so not data views of this fixture.
META_VIEWS = {catalog.RELEASE_VIEW, catalog.WITHDRAWN_TABLE}
LAGOS_DISC = (
    "SELECT count(*), sum(an), sum(ac) FROM atlas.evidence.parity_observations WHERE 2 * 6371.0088 * "
    "asin(sqrt(pow(sin(radians(lat - 6.5244) / 2), 2) + cos(radians(6.5244)) * cos(radians(lat)) * "
    "pow(sin(radians(lon - 3.3792) / 2), 2))) <= 500 + radius_km"
)


def _attached() -> duckdb.DuckDBPyConnection:
    """The fixture catalog attached as ``atlas``, its views reading the fixture's own copies."""
    con = writer.connect()
    con.execute("SET VARIABLE genomeos_local = ?", [f"{RELEASE_DIR}/"])
    con.execute(f"ATTACH '{RELEASE_DIR / catalog.CATALOG_DB}' AS atlas (READ_ONLY)")
    return con


def test_the_range_probe_is_98304_rows_in_12_zstd_row_groups() -> None:
    probe = pq.ParquetFile(RELEASE_DIR / fixture.PROBE_FILE)
    metadata = probe.metadata
    assert (metadata.num_rows, metadata.num_row_groups) == (98_304, 12)
    groups = [metadata.row_group(index) for index in range(metadata.num_row_groups)]
    assert {group.num_rows for group in groups} == {writer.ROW_GROUP_ROWS}
    codecs = {group.column(column).compression for group in groups for column in range(group.num_columns)}
    assert codecs == {"ZSTD"}
    assert probe.schema_arrow.names == ["h3_index", "post_mean"]
    row = (
        writer.connect()
        .execute(
            "SELECT count(*), max(post_mean) FROM read_parquet(?) WHERE h3_index = ?",
            [str(RELEASE_DIR / fixture.PROBE_FILE), fixture.PROBE_KEY],
        )
        .fetchone()
    )
    assert row == (1, 0xE000 / 98_304)


def test_every_parquet_file_of_the_fixture_is_zstd() -> None:
    """``--check`` compares bytes on every platform CI runs, and DuckDB's default Snappy output differs
    between macOS and Linux for the same rows; zstd at the writer's settings does not. (The artifact's
    ``cells.parquet``, which only ``inferred.artifacts``' sha256 records, comes from
    ``fixture_trees.add_artifact``, whose codec ``tests/test_catalog_fixture.py`` checks.)"""
    files = sorted(FIXTURE.rglob("*.parquet"))
    assert len(files) == 4
    codecs = {
        path.relative_to(FIXTURE).as_posix(): {
            metadata.row_group(group).column(column).compression
            for group in range(metadata.num_row_groups)
            for column in range(metadata.num_columns)
        }
        for path in files
        for metadata in [pq.ParquetFile(path).metadata]
    }
    assert {path: codec for path, codec in codecs.items() if codec - {"ZSTD"}} == {}


def test_the_catalog_reads_exactly_the_two_data_views_and_not_the_probe() -> None:
    con = _attached()
    views = {
        f"{schema}.{name}"
        for schema, name in con.execute(
            "SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = 'atlas' AND NOT internal"
        ).fetchall()
    }
    assert views - META_VIEWS == DATA_VIEWS
    assert views == DATA_VIEWS | META_VIEWS
    sql = (RELEASE_DIR / catalog.CATALOG_SQL).read_text(encoding="utf-8")
    assert fixture.PROBE_FILE not in sql
    assert {url.removeprefix(fixture.FIXTURE_BASE_URL) for url in catalog.catalog_urls(sql)} == {
        f"{dr.RELEASE_PREFIX}{fixture.FIXTURE_RELEASE}/{path}" for path in catalog.catalog_local_paths(sql)
    }
    artifacts = con.execute(
        "SELECT variant_id, model_version, data_version FROM atlas.inferred.artifacts"
    ).fetchall()
    assert artifacts == [("chr11-5227002-T-A", "v3", "map-2026-08")]
    assert con.execute(LAGOS_DISC).fetchone() == (3, 60, 6)
    assert con.execute("SELECT count(*) FROM atlas.evidence.parity_observations").fetchone() == (5,)
    con.close()


def test_the_manifest_lists_every_file_and_withdrawn_is_empty() -> None:
    manifest = json.loads((MANIFESTS / f"{fixture.FIXTURE_RELEASE}.json").read_text(encoding="utf-8"))
    objects = dr.validate_manifest(manifest)
    on_disk = {
        path.relative_to(FIXTURE).as_posix()
        for path in FIXTURE.rglob("*")
        if path.is_file() and not path.is_relative_to(MANIFESTS)
    }
    assert {item.key for item in objects} == on_disk
    for item in objects:
        payload = (FIXTURE / item.key).read_bytes()
        assert (len(payload), hashlib.sha256(payload).hexdigest()) == (item.bytes, item.sha256), item.key
    assert {item.path for item in objects} >= {fixture.PROBE_FILE, catalog.CATALOG_DB, catalog.CATALOG_SQL}
    listed = sorted(path.name for path in MANIFESTS.iterdir())
    assert listed == [f"{fixture.FIXTURE_RELEASE}.json", dr.WITHDRAWN_FILE]
    assert (MANIFESTS / dr.WITHDRAWN_FILE).read_bytes() == dr.canonical_bytes(EMPTY_WITHDRAWN)


def test_a_rebuild_matches_the_committed_fixture() -> None:
    """Parquet files byte for byte, and ``atlas.duckdb`` by its views' SQL."""
    assert fixture.check_fixture(FIXTURE) == []


def test_the_check_names_each_stale_file(tmp_path: Path) -> None:
    stale = tmp_path / "data-store"
    shutil.copytree(FIXTURE, stale)
    probe = stale / dr.RELEASE_PREFIX / fixture.FIXTURE_RELEASE / fixture.PROBE_FILE
    probe.write_bytes(probe.read_bytes() + b"\0")
    database = stale / dr.RELEASE_PREFIX / fixture.FIXTURE_RELEASE / catalog.CATALOG_DB
    database.unlink()
    writer.connect().execute(f"ATTACH '{database}' AS stale; CREATE VIEW stale.main.v AS SELECT 1").close()
    (stale / dr.MANIFEST_PREFIX / dr.WITHDRAWN_FILE).unlink()
    (stale / "notes.txt").write_text("not built\n", encoding="utf-8")
    release = f"{dr.RELEASE_PREFIX}{fixture.FIXTURE_RELEASE}"
    assert fixture.check_fixture(stale) == [
        f"{dr.MANIFEST_PREFIX}{dr.WITHDRAWN_FILE}: missing",
        "notes.txt: not part of the fixture",
        f"{release}/{catalog.CATALOG_DB}: differs from a fresh build",
        f"{release}/{fixture.PROBE_FILE}: differs from a fresh build",
    ]
