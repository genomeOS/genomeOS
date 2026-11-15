#!/usr/bin/env python3
"""Build, or check, the committed catalog fixture ``tests/fixtures/catalog``.

Atlas data platform design 2026-10-18 §2.6, step 1.6; builder's call 15. The fixture is release
``FIXTURE_RELEASE`` of the tests' ``catalog_tree`` (``tests/tables_fixtures.py``), built by
``build_data_release.build(..., catalog=True)``: its ``catalog.sql`` and views-only ``atlas.duckdb``, the
files the catalog reads under ``data/`` at their release paths, and ``expected.json``, each view's row
count as the pinned DuckDB reads it. The pinned DuckDB writes every Parquet file, so their bytes depend
on no pandas or pyarrow version.

    python scripts/build_catalog_fixture.py            # write
    python scripts/build_catalog_fixture.py --check    # fail if stale

``--check`` builds it again and compares the Parquet files, ``catalog.sql`` and ``expected.json`` byte for
byte, and ``atlas.duckdb`` by its views' SQL, not its bytes: the fixture is built on macOS and checked on
Linux. CI attaches the fixture from DuckDB 1.2.2 (``scripts/check_catalog_attach.py``), and the website's
tests from the pinned DuckDB-WASM (``website/tests/atlas-catalog-attach.test.ts``).
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import shutil
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.tables import catalog, writer  # noqa: E402
from genomeos.tables.contracts import TableError  # noqa: E402
from scripts.check_catalog_attach import view_counts  # noqa: E402
from tests import tables_fixtures  # noqa: E402

FIXTURE_RELEASE = "2026-11-20"
FIXTURE = ROOT / "tests" / "fixtures" / "catalog"
DATABASE = "atlas.duckdb"
CATALOG_SQL = "catalog.sql"
EXPECTED = "expected.json"
#: The folder of the files the catalog reads, which a reader names in ``genomeos_local``.
DATA = "data"


def build_fixture(out: Path) -> None:
    """Release ``FIXTURE_RELEASE`` of ``catalog_tree`` with its catalog, written to ``out`` as the fixture.

    ``out/data`` is replaced; other files in ``out`` are left for ``--check`` to name.
    """
    with tempfile.TemporaryDirectory() as scratch:
        root = tables_fixtures.make_catalog_tree(Path(scratch))
        with contextlib.redirect_stdout(io.StringIO()):  # build_tables prints each table's row count
            tables_fixtures.build_catalog_tables(root)
        manifest = tables_fixtures.release_catalog_tree(root)
        if manifest["release"] != FIXTURE_RELEASE:
            raise TableError(f"catalog_tree released {manifest['release']}, not {FIXTURE_RELEASE}")
        data = root / "data"
        sql = (data / catalog.CATALOG_SQL).read_text(encoding="utf-8")
        if (out / DATA).exists():
            shutil.rmtree(out / DATA)
        out.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(data / catalog.CATALOG_SQL, out / CATALOG_SQL)
        shutil.copyfile(data / catalog.CATALOG_DB, out / DATABASE)
        for path in catalog.catalog_local_paths(sql):
            (out / DATA / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(data / path, out / DATA / path)
    expected = {"release": FIXTURE_RELEASE, "views": view_counts(out / DATABASE, out / DATA)}
    (out / EXPECTED).write_text(json.dumps(expected, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def check_fixture(out: Path) -> list[str]:
    """How the fixture at ``out`` differs from a fresh build: nothing, when the list is empty."""
    with tempfile.TemporaryDirectory() as scratch:
        built = Path(scratch) / "catalog"
        build_fixture(built)
        found, wanted = _files(out), _files(built)
        problems = [f"{path}: missing" for path in sorted(wanted - found)]
        problems += [f"{path}: not part of the fixture" for path in sorted(found - wanted)]
        for path in sorted(found & wanted):
            if path == DATABASE:
                same = _views(out / path) == _views(built / path)
            else:
                same = (out / path).read_bytes() == (built / path).read_bytes()
            if not same:
                problems.append(f"{path}: differs from a fresh build")
    return problems


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build, or check, the committed catalog fixture.")
    parser.add_argument("--check", action="store_true", help="fail if the committed fixture is stale")
    args = parser.parse_args(argv)
    where = FIXTURE.relative_to(ROOT).as_posix()
    try:
        if not args.check:
            build_fixture(FIXTURE)
            print(f"wrote {where}: {len(_files(FIXTURE))} files")
            return 0
        problems = check_fixture(FIXTURE)
    except (TableError, dr.DataReleaseError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if problems:
        print(f"{where} is stale:", *problems, sep="\n  ", file=sys.stderr)
        print("run: python scripts/build_catalog_fixture.py", file=sys.stderr)
        return 1
    print(f"{where}: current")
    return 0


def _files(root: Path) -> set[str]:
    return {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}


def _views(database: Path) -> list[tuple[str, str, str]]:
    """Each view of ``database``: its schema, name and SQL."""
    con = writer.connect()
    try:
        con.execute(f"ATTACH '{database}' AS fixture (READ_ONLY)")
        return con.execute(
            "SELECT schema_name, view_name, sql FROM duckdb_views() "
            "WHERE database_name = 'fixture' AND NOT internal ORDER BY ALL"
        ).fetchall()
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
