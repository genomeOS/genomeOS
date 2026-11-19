"""The release catalog: catalog.sql, atlas.duckdb and tables.json.

Atlas data platform design 2026-10-18 §2.6, §2.7 checks 7 and 8, §2.9; builder's calls 1, 4, 15 and 17.
Each catalog is built over ``catalog_tree`` and attached under an alias, as a reader attaches the
published one.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path

import duckdb
import pytest

from genomeos.publication import data_release as dr
from genomeos.tables import catalog, inferred, writer
from genomeos.tables.catalog import PARITY_FILE
from genomeos.tables.contracts import TableError
from scripts import build_data_release as build
from scripts import smoke_catalog as smoke
from tests import tables_fixtures
from tests.tables_fixtures import (
    EPOCH,
    KIR_V3,
    build_catalog_tables,
    published_objects,
    release_catalog_tree,
    withdrawal,
)

catalog_tree = tables_fixtures.catalog_tree

COUNTS = {
    "evidence.parity_observations": 3,
    "inferred.artifacts": 3,
    "inferred.cells_by_cell": 6,
    "meta.release": 1,
    "meta.release_objects": 8,
    "meta.served": 2,
    "meta.sources": 5,
    "meta.withdrawn": 0,
}


def _build(root: Path, *, withdrawn: Sequence[Mapping[str, str]] = ()) -> dict:
    """Build release ``EPOCH``'s tables over ``root``, then release it in both passes."""
    build_catalog_tables(root, withdrawn=withdrawn)
    return release_catalog_tree(root)


def _attach(database: Path | str, local: Path | str) -> duckdb.DuckDBPyConnection:
    """A plain DuckDB reading ``database`` as ``atlas``, offline from ``local``."""
    con = duckdb.connect()
    con.execute("SET VARIABLE genomeos_local = ?", [str(local)])
    con.execute(f"ATTACH '{database}' AS atlas (READ_ONLY)")
    return con


def _one(con: duckdb.DuckDBPyConnection, sql: str) -> tuple:
    row = con.execute(sql).fetchone()
    assert row is not None
    return row


def _counts(con: duckdb.DuckDBPyConnection) -> dict[str, int]:
    return {view: _one(con, f"SELECT count(*) FROM atlas.{view}")[0] for view in COUNTS}


@pytest.fixture
def built(catalog_tree: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """``catalog_tree`` released with its catalog, and the working directory, so ``data`` is relative."""
    _build(catalog_tree)
    monkeypatch.chdir(catalog_tree)
    return catalog_tree


@pytest.mark.parametrize("local", ["data", "data/"])
def test_the_catalog_attaches_under_an_alias_and_reads_local_copies(built: Path, local: str) -> None:
    con = _attach(Path("data") / catalog.CATALOG_DB, local)
    assert _counts(con) == COUNTS
    typed = con.execute("SELECT DISTINCT typeof(epoch), typeof(res) FROM atlas.inferred.cells_by_cell")
    assert typed.fetchall() == [("VARCHAR", "INTEGER")]


def test_the_disc_counts_the_sampling_radius(built: Path) -> None:
    """Lagos itself; 600 km north inside 500 + 150 km; 600 km north outside 500 + 50 km."""
    con = _attach(Path("data") / catalog.CATALOG_DB, "data")
    expected = {"rows": 3, "sum_an": 700, "sum_ac": 70, "disc_rows": 2, "disc_sum_an": 300, "disc_sum_ac": 30}
    assert smoke.parity_counts(con) == expected


def test_building_the_catalog_reads_only_local_copies(catalog_tree: Path) -> None:
    (catalog_tree / "data" / PARITY_FILE).unlink()
    with pytest.raises(TableError) as error:
        _build(catalog_tree)
    assert PARITY_FILE in str(error.value)
    assert "fetch_data.py --prefix" in str(error.value)
    assert "https://" not in str(error.value)


def test_a_listed_file_missing_locally_stops_the_catalog_build(built: Path) -> None:
    """Views bind when created, so the builder binds them over local copies and never over HTTPS."""
    data = built / "data"
    sql = (data / catalog.CATALOG_SQL).read_text(encoding="utf-8")
    part = next(path for path in catalog.catalog_local_paths(sql) if path.startswith(inferred.EPOCH_ROOT))
    (data / part).unlink()
    with pytest.raises(TableError) as error:
        writer.build_catalog_db(sql, built / "again.duckdb", data_root=data)
    message = str(error.value)
    assert part in message and "fetch it first: python scripts/fetch_data.py --prefix tables/" in message
    assert "https://" not in message
    assert not (built / "again.duckdb").exists()


def test_meta_release_names_the_manifest_key_and_cite_as(built: Path) -> None:
    con = _attach(Path("data") / catalog.CATALOG_DB, "data")
    row = _one(con, "SELECT * FROM atlas.meta.release")
    assert row == ("2026-11-20", "manifests/2026-11-20.json", catalog.cite_as("2026-11-20"), None)
    assert catalog.cite_as("2026-11-20") == (
        "genomeOS Atlas data, release 2026-11-20. "
        "https://storage.googleapis.com/genomeos-atlas-data/manifests/2026-11-20.json"
    )


def test_catalog_sql_has_no_arrow_lambdas(built: Path) -> None:
    sql = (built / "data" / catalog.CATALOG_SQL).read_text(encoding="utf-8")
    assert "->" not in sql
    assert catalog.catalog_views(sql) == ("meta.release", *sorted(set(COUNTS) - {"meta.release"}))


def test_two_builds_are_byte_identical(built: Path) -> None:
    data = built / "data"
    sql = (data / catalog.CATALOG_SQL).read_text(encoding="utf-8")
    first = writer.build_catalog_db(sql, built / "first.duckdb", data_root=data)
    second = writer.build_catalog_db(sql, built / "second.duckdb", data_root=data)
    assert first.read_bytes() == second.read_bytes() == (data / catalog.CATALOG_DB).read_bytes()


def test_withdrawing_an_artifact_drops_it_from_the_inferred_views(catalog_tree: Path) -> None:
    cells = published_objects(catalog_tree)[f"{dr.ARTIFACT_PREFIX}{KIR_V3}/{inferred.CELLS_FILE}"]
    _build(catalog_tree, withdrawn=[withdrawal(cells)])
    data = catalog_tree / "data"
    counts = _counts(_attach(data / catalog.CATALOG_DB, data))
    assert counts == {**COUNTS, "inferred.artifacts": 2, "inferred.cells_by_cell": 4, "meta.withdrawn": 1}


def test_every_view_anti_joins_the_withdrawn_files(catalog_tree: Path) -> None:
    """Check 7 refuses a catalog naming a withdrawn key; the views drop its rows even without check 7."""
    build_catalog_tables(catalog_tree, withdrawn=[withdrawal(published_objects(catalog_tree)[PARITY_FILE])])
    objects = dr.validate_manifest(release_catalog_tree(catalog_tree, catalog=False))
    data = catalog_tree / "data"
    sql = catalog.render_catalog_sql(EPOCH, build.listed_files(data, objects))
    database = writer.build_catalog_db(sql, catalog_tree / "atlas.duckdb", data_root=data)
    counts = _counts(_attach(database, data))
    assert counts == {**COUNTS, "evidence.parity_observations": 0, "meta.withdrawn": 1}
    with pytest.raises(TableError, match=r"check 7: https://\S+: withdrawn"):
        release_catalog_tree(catalog_tree)


# --- check 7 on catalog.sql and tables.json ---


def _drop_parity(tables_json: bytes) -> bytes:
    document = json.loads(tables_json)
    del document["tables"][catalog.PARITY_TABLE]
    return json.dumps(document).encode()


def _wrong_sha256(tables_json: bytes) -> bytes:
    document = json.loads(tables_json)
    document["tables"][catalog.PARITY_TABLE][0]["sha256"] = "0" * 64
    return json.dumps(document).encode()


#: A view reading the parity file's local copy by a path of its own, outside the genomeos_local CASE.
_LEAK = f"\nCREATE VIEW evidence.leak AS SELECT * FROM read_parquet('data/{PARITY_FILE}');\n"


@pytest.mark.parametrize(
    ("sql", "tables_json", "withdraw_parity", "match"),
    [
        (
            lambda sql: sql.replace("releases/2026-10-17/validation/", "releases/2026-10-16/validation/"),
            None,
            False,
            "not a manifest key",
        ),
        (None, None, True, "withdrawn"),
        (None, _wrong_sha256, False, "sha256"),
        (None, _drop_parity, False, "lists different files"),
        (lambda sql: sql + _LEAK, None, False, "local path"),
    ],
    ids=["a-url-that-is-no-key", "a-withdrawn-key", "a-wrong-sha256", "another-file-set", "a-local-path"],
)
def test_check_catalog_refuses(
    catalog_tree: Path, sql, tables_json, withdraw_parity: bool, match: str
) -> None:
    objects = {item.key: item for item in dr.validate_manifest(_build(catalog_tree))}
    data = catalog_tree / "data"
    text = (data / catalog.CATALOG_SQL).read_text(encoding="utf-8")
    listed = (data / catalog.TABLES_JSON).read_bytes()
    catalog.check_catalog(text, listed, objects, frozenset())
    parity = published_objects(catalog_tree)[PARITY_FILE].key
    withdrawn = frozenset({parity}) if withdraw_parity else frozenset()
    with pytest.raises(TableError, match=match):
        catalog.check_catalog(
            sql(text) if sql else text, tables_json(listed) if tables_json else listed, objects, withdrawn
        )
