"""Shared constants and helpers for the ``tables/`` tests (Atlas data platform design 2026-10-18 §2).

The meta tests read exactly the two committed manifests named in ``COMMITTED_RELEASES``, never a glob
of ``data/releases/``, so a release PR that commits a third manifest does not change their counts.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import duckdb

from genomeos.tables import meta, provenance

ROOT = Path(__file__).resolve().parents[1]
#: A stand-in commit for the writer, which requires 40 lowercase hex characters, nothing more.
#: ``build_tables`` refuses it: its ``--git-sha`` must name a commit, so its tests pass ``HEAD``.
GIT_SHA = "0" * 40
#: ``build_tables``' hidden overrides, reading this checkout's web catalog and withdrawn list as they
#: stand rather than at the stamped commit, so an uncommitted edit to either cannot fail a test.
GIT_INPUT_FLAGS = (
    "--web-catalog",
    str(ROOT / meta.WEB_CATALOG),
    "--withdrawn",
    str(ROOT / meta.WITHDRAWN_LIST),
)
#: The two releases committed before the tables existed: 245 + 248 objects, 7 sources each.
COMMITTED_RELEASES = ("2026-10-17", "2026-10-18")

# H3 cells of Lagos and London: their res-4 cells, the res-3 parents and the res-0 base cells.
LAGOS_R4 = "84589c9ffffffff"
LONDON_R4 = "84194adffffffff"
LAGOS_R3 = "83589cfffffffff"
LONDON_R3 = "83194afffffffff"
R0_LAGOS = "8059fffffffffff"
R0_LONDON = "8019fffffffffff"


def committed_manifests() -> tuple[dict[str, Any], ...]:
    """The two committed manifests, oldest first."""
    releases = ROOT / "data" / "releases"
    return tuple(
        json.loads((releases / f"{release}.json").read_text(encoding="utf-8"))
        for release in COMMITTED_RELEASES
    )


def copy_committed_releases(directory: Path) -> Path:
    """A releases/ folder holding copies of exactly the two committed manifests."""
    directory.mkdir(parents=True, exist_ok=True)
    for release in COMMITTED_RELEASES:
        shutil.copyfile(ROOT / "data" / "releases" / f"{release}.json", directory / f"{release}.json")
    return directory


def rewrite_parquet(
    con: duckdb.DuckDBPyConnection, source: Path, out: Path, select: str, *, metadata: bool = True
) -> Path:
    """``SELECT <select>`` over ``source`` written to ``out`` by the pinned DuckDB, keeping its metadata.

    A file the writer would refuse to produce, for the checks that must refuse it on read.
    """
    kv = provenance.read_kv(source) if metadata else {}
    literal = ", ".join(f"'{key}': '{value}'" for key, value in sorted(kv.items()))
    options = f", KV_METADATA {{{literal}}}" if literal else ""
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(
        f"COPY (SELECT {select} FROM read_parquet('{source}', hive_partitioning = false)) "
        f"TO '{out}' (FORMAT parquet, COMPRESSION zstd{options})"
    )
    return out
