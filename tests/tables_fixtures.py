"""Shared constants and helpers for the ``tables/`` tests (Atlas data platform design 2026-10-18 §2).

The trees and their builders live in ``scripts/fixture_trees.py``, which imports neither pytest nor
``tests/``, so that ``scripts/build_catalog_fixture.py`` builds the committed catalog fixture from them.
This module re-exports them, wraps two of them as pytest fixtures, and adds the helpers only tests use.

The meta tests read exactly the two committed manifests named in ``COMMITTED_RELEASES``, never a glob
of ``data/releases/``, so a release PR that commits a third manifest does not change their counts.

``fixture_tree`` is a small ``data/`` tree with its own committed release 2026-10-17: three artifacts
(HbS v1, format 1 at res 3 with no ``measurement``; HbS v3 and KIR 2DL1 v3, format 2 at res 4), each
with one cell over Lagos and one over London, all in ``RELEASED_WITHOUT_INPUT``. A test module
registers it by name: ``fixture_tree = tables_fixtures.fixture_tree``.

``catalog_tree`` (step 1.6) is ``make_catalog_tree`` in the test's ``tmp_path``: the same three artifacts
plus a 3-row parity file and the curated ``SOURCE.json``, committed as release 2026-10-17 (8 objects, 5
sources), with a web catalog, an empty withdrawn list and the files every release reads. A test builds
release ``EPOCH``'s tables with ``build_catalog_tables`` and releases it with ``release_catalog_tree``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Collection
from pathlib import Path
from typing import Any

import duckdb
import pytest

from genomeos.publication import data_release as dr
from genomeos.tables import meta, provenance, write_once
from scripts import build_tables
from scripts.fixture_trees import (
    CATALOG_SERVED,
    EPOCH,
    FIXTURE_ARTIFACTS,
    FIXTURE_RELEASE,
    FIXTURE_WITHOUT_INPUT,
    GIT_SHA,
    HBS_V1,
    HBS_V3,
    KIR_V3,
    LAGOS_R3,
    LAGOS_R4,
    LONDON_R3,
    LONDON_R4,
    PARITY_ROWS,
    R0_LAGOS,
    R0_LONDON,
    RELEASE_INPUTS,
    ROOT,
    WEB_CATALOG_FILE,
    FixtureTree,
    add_artifact,
    add_fixture_artifacts,
    artifact_manifest,
    build_catalog_tables,
    cells_frame,
    commit_release,
    identity,
    make_catalog_tree,
    release_catalog_tree,
    write_parity_file,
)

__all__ = [
    "CATALOG_SERVED",
    "COMMITTED_RELEASES",
    "EPOCH",
    "FIXTURE_ARTIFACTS",
    "FIXTURE_RELEASE",
    "FIXTURE_WITHOUT_INPUT",
    "GIT_INPUT_FLAGS",
    "GIT_SHA",
    "HBS_V1",
    "HBS_V3",
    "KIR_V3",
    "LAGOS_R3",
    "LAGOS_R4",
    "LONDON_R3",
    "LONDON_R4",
    "PARITY_ROWS",
    "R0_LAGOS",
    "R0_LONDON",
    "RELEASE_INPUTS",
    "ROOT",
    "WEB_CATALOG_FILE",
    "FixtureTree",
    "add_artifact",
    "add_fixture_artifacts",
    "artifact_manifest",
    "build_catalog_tables",
    "catalog_tree",
    "cells_frame",
    "commit_release",
    "committed_manifests",
    "copy_committed_releases",
    "fixture_tree",
    "identity",
    "make_catalog_tree",
    "published_objects",
    "release_catalog_tree",
    "rewrite_parquet",
    "withdrawal",
    "write_parity_file",
]

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
    con: duckdb.DuckDBPyConnection,
    source: Path,
    out: Path,
    select: str,
    *,
    metadata: bool = True,
    drop: Collection[str] = (),
) -> Path:
    """``SELECT <select>`` over ``source`` written to ``out`` by the pinned DuckDB, keeping its metadata
    except the keys in ``drop``.

    A file the writer would refuse to produce, for the checks that must refuse it on read.
    """
    kv = provenance.read_kv(source) if metadata else {}
    kv = {key: value for key, value in kv.items() if key not in drop}
    literal = ", ".join(f"'{key}': '{value}'" for key, value in sorted(kv.items()))
    options = f", KV_METADATA {{{literal}}}" if literal else ""
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(
        f"COPY (SELECT {select} FROM read_parquet('{source}', hive_partitioning = false)) "
        f"TO '{out}' (FORMAT parquet, COMPRESSION zstd{options})"
    )
    return out


@pytest.fixture
def fixture_tree(tmp_path: Path) -> FixtureTree:
    """Release 2026-10-17 of the three ``FIXTURE_ARTIFACTS``, committed to ``releases/``."""
    data = tmp_path / "data"
    add_fixture_artifacts(data)
    tree = FixtureTree(tmp_path, data, tmp_path / "releases")
    commit_release(tree.data, tree.releases, FIXTURE_RELEASE)
    return tree


@pytest.fixture
def catalog_tree(tmp_path: Path) -> Path:
    """``make_catalog_tree`` in ``tmp_path``: its ``data/`` and ``releases/`` folders."""
    return make_catalog_tree(tmp_path)


def published_objects(root: Path) -> dict[str, dr.ReleaseObject]:
    """Each path ``root/releases`` publishes, with its first publication."""
    return write_once.published_paths(build_tables.committed_manifests(root / "releases"))


def withdrawal(item: dr.ReleaseObject) -> dict[str, str]:
    """A ``WITHDRAWN.json`` entry for the published ``item``."""
    return {
        "key": item.key,
        "sha256": item.sha256,
        "reason": "a fixture takedown",
        "issue": "https://github.com/genomeOS/genomeOS/issues/1",
        "date": "2026-11-14",
        "decided_by": "owner",
    }
