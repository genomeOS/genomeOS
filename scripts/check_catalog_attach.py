#!/usr/bin/env python3
"""Attach a release catalog read-only with the installed DuckDB, and read every view offline.

Atlas data platform design 2026-10-18 §2.6, step 1.6; builder's call 15. The pinned DuckDB writes
``atlas.duckdb`` in storage version v1.2.0 so that a reader on DuckDB 1.2.x can attach it. CI checks
that with this script, in a venv that holds only ``duckdb==1.2.2``:

    python -I scripts/check_catalog_attach.py --catalog tests/fixtures/catalog/atlas.duckdb \\
        --local tests/fixtures/catalog/data --expect tests/fixtures/catalog/expected.json

It sets ``genomeos_local`` to ``--local`` before it attaches, so every view reads the local copies, and
it never installs or loads an extension, so a view that read a URL would fail instead of fetching it.
``--expect`` names a JSON document whose ``views`` give each view's row count; ``--expect-views N``
requires N views and reads each once. It imports only the standard library and ``duckdb``.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

import duckdb

ALIAS = "atlas"


def view_counts(catalog: Path, local: Path) -> dict[str, int]:
    """Each view of ``catalog`` (``schema.view``) with its row count, read from the copies under ``local``."""
    con = duckdb.connect(config={"autoinstall_known_extensions": False, "autoload_known_extensions": False})
    try:
        con.execute(f"SET VARIABLE genomeos_local = {_literal(str(local))}")
        con.execute(f"ATTACH {_literal(str(catalog))} AS {ALIAS} (READ_ONLY)")
        views = con.execute(
            "SELECT schema_name, view_name FROM duckdb_views() "
            "WHERE database_name = ? AND NOT internal ORDER BY ALL",
            [ALIAS],
        ).fetchall()
        counts = {}
        for schema, view in views:
            row = con.execute(
                f"SELECT count(*) FROM {ALIAS}.{_identifier(schema)}.{_identifier(view)}"
            ).fetchone()
            assert row is not None
            counts[f"{schema}.{view}"] = int(row[0])
        return counts
    finally:
        con.close()


def check(
    catalog: Path,
    local: Path,
    *,
    expected: Mapping[str, int] | None = None,
    expect_views: int | None = None,
) -> list[str]:
    """What is wrong with ``catalog`` read offline from ``local``: nothing, when the list is empty.

    ``expected`` gives each view's row count, and ``expect_views`` the number of views. When nothing is
    wrong, it prints ``DuckDB <v>: <catalog> attached read-only; <n> views read offline``.
    """
    if not catalog.is_file():
        return [f"{catalog}: no such file"]
    try:
        counts = view_counts(catalog, local)
    except duckdb.Error as error:
        return [f"{catalog}: DuckDB {duckdb.__version__} cannot read it from {local}: {error}"]
    problems = []
    if expect_views is not None and len(counts) != expect_views:
        problems.append(f"{catalog}: {len(counts)} views, not the {expect_views} expected")
    if expected is not None:
        for view in sorted(set(expected) | set(counts)):
            found, wanted = counts.get(view), expected.get(view)
            if found is None:
                problems.append(f"{view}: expected {wanted} rows, but {catalog} has no such view")
            elif wanted is None:
                problems.append(f"{view}: {found} rows, but the expected counts do not name it")
            elif found != wanted:
                problems.append(f"{view}: {found} rows, expected {wanted}")
    if not problems:
        print(f"DuckDB {duckdb.__version__}: {catalog} attached read-only; {len(counts)} views read offline")
    return problems


def expected_counts(path: Path) -> dict[str, int]:
    """The ``views`` of the JSON document at ``path``: each view's row count."""
    document = json.loads(path.read_text(encoding="utf-8"))
    views = document.get("views") if isinstance(document, dict) else None
    if not isinstance(views, dict) or not all(
        isinstance(view, str) and type(rows) is int for view, rows in views.items()
    ):
        raise ValueError('not {"views": {"<schema>.<view>": <rows>, ...}}')
    return views


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Attach a release catalog and read every view offline.")
    parser.add_argument("--catalog", type=Path, required=True, help="the atlas.duckdb to attach")
    parser.add_argument("--local", type=Path, required=True, help="the data/ folder its views read")
    expectation = parser.add_mutually_exclusive_group(required=True)
    expectation.add_argument("--expect", type=Path, help="a JSON file whose views give each view's rows")
    expectation.add_argument("--expect-views", type=int, metavar="N", help="the number of views")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    expected = None
    if args.expect is not None:
        try:
            expected = expected_counts(args.expect)
        except (OSError, ValueError) as error:
            print(f"error: {args.expect}: {error}", file=sys.stderr)
            return 1
    problems = check(args.catalog, args.local, expected=expected, expect_views=args.expect_views)
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    return 1 if problems else 0


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


if __name__ == "__main__":
    raise SystemExit(main())
