#!/usr/bin/env python3
"""Attach a release catalog read-only with the installed DuckDB, and read every view and macro offline.

Atlas data platform design 2026-10-18 §2.6, §3.1, step 1.6; builder's call 15. The pinned DuckDB writes
``atlas.duckdb`` in storage version v1.2.0 so that a reader on DuckDB 1.2.x can attach it. CI checks
that with this script, in a venv that holds only ``duckdb==1.2.2``:

    python -I scripts/check_catalog_attach.py --catalog tests/fixtures/catalog/atlas.duckdb \\
        --local tests/fixtures/catalog/data --expect tests/fixtures/catalog/expected.json

It sets ``genomeos_local`` to ``--local`` before it attaches, so every view and macro reads the local
copies, and it never installs or loads an extension, so a read of a URL would fail instead of fetching
it. ``--expect`` names a JSON document whose ``views`` give each view's row count and whose ``macros``,
when present, give what the lookup macros return (``macro_results``); ``--expect-views N`` requires N
views and reads each once. It imports only the standard library and ``duckdb``.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import duckdb

ALIAS = "atlas"
#: The ids the macro checks look up: rs334, and an id no lookup set computes a URL for (§2.6, call 31).
RS334 = "chr11-5227002-T-A"
CHRM = "chrM-16519-T-C"
#: What each ``macros`` entry of ``expected.json`` records, by the call it comes from.
MACRO_CALLS = {
    "variant": f"measured.variant('{RS334}') by cohort_id, as [cohort_id, rows, sum ac, sum an]",
    "lookup_url_chrM": f"measured.lookup_url('{CHRM}')",
    "surfaces_rows": f"inferred.surfaces('{RS334}') rows",
}


def view_counts(catalog: Path, local: Path) -> dict[str, int]:
    """Each view of ``catalog`` (``schema.view``) with its row count, read from the copies under ``local``."""
    con = _attach(catalog, local)
    try:
        views = con.execute(
            "SELECT schema_name, view_name FROM duckdb_views() "
            "WHERE database_name = ? AND NOT internal ORDER BY ALL",
            [ALIAS],
        ).fetchall()
        counts = {}
        for schema, view in views:
            counts[f"{schema}.{view}"] = _one(
                con, f"SELECT count(*) FROM {ALIAS}.{_identifier(schema)}.{_identifier(view)}"
            )
        return counts
    finally:
        con.close()


def macro_results(catalog: Path, local: Path) -> dict[str, Any]:
    """What ``catalog``'s lookup macros return offline from ``local``, each named as in ``MACRO_CALLS``."""
    con = _attach(catalog, local)
    try:
        variant = con.execute(
            f"SELECT cohort_id, count(*), sum(ac), sum(an) FROM {ALIAS}.measured.variant(?) "
            "GROUP BY 1 ORDER BY 1",
            [RS334],
        ).fetchall()
        return {
            "variant": [[cohort, int(rows), int(ac), int(an)] for cohort, rows, ac, an in variant],
            "lookup_url_chrM": list(_one(con, f"SELECT {ALIAS}.measured.lookup_url(?)", [CHRM])),
            "surfaces_rows": _one(con, f"SELECT count(*) FROM {ALIAS}.inferred.surfaces(?)", [RS334]),
        }
    finally:
        con.close()


def check(
    catalog: Path,
    local: Path,
    *,
    expected: Mapping[str, Any] | None = None,
    expect_views: int | None = None,
) -> list[str]:
    """What is wrong with ``catalog`` read offline from ``local``: nothing, when the list is empty.

    ``expected`` is an ``expected.json`` document (``read_expected``): its ``views`` give each view's row
    count, and its ``macros``, when present, what the lookup macros return. ``expect_views`` gives the
    number of views. When nothing is wrong, it prints ``DuckDB <v>: <catalog> attached read-only; <n>
    views read offline``, then, when it checked the macros, how many of rs334's rows the curated files and
    the computed bin gave.
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
        problems += _view_problems(catalog, counts, expected["views"])
    macros = None if expected is None else expected.get("macros")
    summary = None
    if macros is not None:
        try:
            found = macro_results(catalog, local)
            summary = _macro_summary(catalog, local, found)
        except duckdb.Error as error:
            problems.append(f"{catalog}: its macros fail under DuckDB {duckdb.__version__}: {error}")
        else:
            for name in sorted(set(found) | set(macros)):
                if found.get(name) != macros.get(name):
                    call = MACRO_CALLS.get(name, name)
                    problems.append(f"{call}: {found.get(name)!r}, expected {macros.get(name)!r}")
    if not problems:
        print(f"DuckDB {duckdb.__version__}: {catalog} attached read-only; {len(counts)} views read offline")
        if summary is not None:
            print(summary)
    return problems


def read_expected(path: Path) -> dict[str, Any]:
    """The ``expected.json`` document at ``path``: ``views`` gives each view's row count, and ``macros``,
    when present, one entry per ``MACRO_CALLS`` name."""
    document = json.loads(path.read_text(encoding="utf-8"))
    views = document.get("views") if isinstance(document, dict) else None
    if not isinstance(views, dict) or not all(
        isinstance(view, str) and type(rows) is int for view, rows in views.items()
    ):
        raise ValueError('not {"views": {"<schema>.<view>": <rows>, ...}, ...}')
    macros = document.get("macros")
    if macros is not None and (not isinstance(macros, dict) or set(macros) != set(MACRO_CALLS)):
        raise ValueError(f'its "macros" do not give exactly {sorted(MACRO_CALLS)}')
    return document


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Attach a release catalog and read every view and macro offline."
    )
    parser.add_argument("--catalog", type=Path, required=True, help="the atlas.duckdb to attach")
    parser.add_argument("--local", type=Path, required=True, help="the data/ folder its views read")
    expectation = parser.add_mutually_exclusive_group(required=True)
    expectation.add_argument(
        "--expect", type=Path, help="a JSON file whose views (and macros) give what the catalog returns"
    )
    expectation.add_argument("--expect-views", type=int, metavar="N", help="the number of views")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    expected = None
    if args.expect is not None:
        try:
            expected = read_expected(args.expect)
        except (OSError, ValueError) as error:
            print(f"error: {args.expect}: {error}", file=sys.stderr)
            return 1
    problems = check(args.catalog, args.local, expected=expected, expect_views=args.expect_views)
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    return 1 if problems else 0


def _view_problems(catalog: Path, counts: Mapping[str, int], expected: Mapping[str, int]) -> list[str]:
    problems = []
    for view in sorted(set(expected) | set(counts)):
        found, wanted = counts.get(view), expected.get(view)
        if found is None:
            problems.append(f"{view}: expected {wanted} rows, but {catalog} has no such view")
        elif wanted is None:
            problems.append(f"{view}: {found} rows, but the expected counts do not name it")
        elif found != wanted:
            problems.append(f"{view}: {found} rows, expected {wanted}")
    return problems


def _macro_summary(catalog: Path, local: Path, found: Mapping[str, Any]) -> str:
    """rs334's rows split by where they came from: the bin file its computed URL names, or curated files."""
    con = _attach(catalog, local)
    try:
        urls = _one(con, f"SELECT {ALIAS}.measured.lookup_url(?)", [RS334])
        files = ", ".join(_literal(url) for url in urls)
        read = f"read_parquet([{files}], hive_partitioning = false)"
        binned = _one(con, f"SELECT count(*) FROM {read} WHERE variant_id = ?", [RS334]) if urls else 0
    finally:
        con.close()
    rows = sum(entry[1] for entry in found["variant"])
    chrm = "computes no URL" if not found["lookup_url_chrM"] else f"computes {found['lookup_url_chrM']}"
    return f"macros: rs334 {rows - binned} curated + {binned} recount rows; {CHRM} {chrm}"


def _attach(catalog: Path, local: Path) -> duckdb.DuckDBPyConnection:
    """A DuckDB that never loads an extension, with ``catalog`` attached read-only over ``local``."""
    con = duckdb.connect(config={"autoinstall_known_extensions": False, "autoload_known_extensions": False})
    try:
        con.execute(f"SET VARIABLE genomeos_local = {_literal(str(local))}")
        con.execute(f"ATTACH {_literal(str(catalog))} AS {ALIAS} (READ_ONLY)")
    except BaseException:
        con.close()
        raise
    return con


def _one(con: duckdb.DuckDBPyConnection, sql: str, parameters: Sequence[object] = ()) -> Any:
    row = con.execute(sql, list(parameters)).fetchone()
    assert row is not None
    return row[0]


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


if __name__ == "__main__":
    raise SystemExit(main())
