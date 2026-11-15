"""Shared constants and helpers for the ``tables/`` tests (Atlas data platform design 2026-10-18 §2).

The meta tests read exactly the two committed manifests named in ``COMMITTED_RELEASES``, never a glob
of ``data/releases/``, so a release PR that commits a third manifest does not change their counts.

``fixture_tree`` is a small ``data/`` tree with its own committed release 2026-10-17: three artifacts
(HbS v1, format 1 at res 3 with no ``measurement``; HbS v3 and KIR 2DL1 v3, format 2 at res 4), each
with one cell over Lagos and one over London, all in ``RELEASED_WITHOUT_INPUT``. A test module
registers it by name: ``fixture_tree = tables_fixtures.fixture_tree``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import pytest

from genomeos.publication import data_release as dr
from genomeos.tables import inferred, meta, provenance, write_once
from scripts import build_data_release, build_tables

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


# --- fixture_tree: three released artifacts, for the inferred tables (step 1.5) ---

FIXTURE_RELEASE = "2026-10-17"
#: The release the inferred tests build, and so the first ``cells_by_cell`` epoch.
EPOCH = "2026-11-20"
HBS_V1 = "chr11-5227002-T-A__v1__map-2026-08"
HBS_V3 = "chr11-5227002-T-A__v3__map-2026-08"
KIR_V3 = "kir__2dl1__v3__afnd-2026-08"
#: Each fixture artifact: ``(artifact_format, resolution, cells, measurement)``.
FIXTURE_ARTIFACTS: Mapping[str, tuple[int, int, tuple[str, ...], str | None]] = {
    HBS_V1: (1, 3, (LAGOS_R3, LONDON_R3), None),
    HBS_V3: (2, 4, (LAGOS_R4, LONDON_R4), "allele_frequency"),
    KIR_V3: (2, 4, (LAGOS_R4, LONDON_R4), "carrier_frequency"),
}


def identity(artifact: str) -> tuple[str, str, str]:
    """``(variant_id, model_version, data_version)`` of an artifact directory name."""
    variant, model_version, data_version = artifact.rsplit("__", 2)
    return variant.replace("__", ":"), model_version, data_version


def cells_frame(artifact: str, cells: Sequence[str]) -> pd.DataFrame:
    """A format-1/2 ``cells.parquet`` frame: the 14 columns, one row per cell."""
    variant_id, model_version, data_version = identity(artifact)
    base = [0.05 * (i + 1) + len(artifact) / 1000 for i in range(len(cells))]
    columns = {
        "h3_index": list(cells),
        "variant_id": variant_id,
        "post_median": base,
        "post_mean": [value + 0.001 for value in base],
        "post_sd": [0.02] * len(cells),
        "q025": [value - 0.04 for value in base],
        "q975": [value + 0.04 for value in base],
        "q25": [value - 0.01 for value in base],
        "q75": [value + 0.01 for value in base],
        "support": ["observed", *["interpolated"] * (len(cells) - 1)],
        "posterior_contraction": [0.5] * len(cells),
        "dist_nearest_obs_km": [10.0 * (i + 1) for i in range(len(cells))],
        "model_version": model_version,
        "data_version": data_version,
    }
    return pd.DataFrame(columns, columns=list(inferred.CELLS_COLUMNS))


def artifact_manifest(
    artifact: str, *, artifact_format: int, resolution: int, cells: Sequence[str], measurement: str | None
) -> dict[str, Any]:
    """A released format-1/2 ``manifest.json``; format 1 may lack ``measurement``, as two real ones do."""
    variant_id, model_version, data_version = identity(artifact)
    manifest: dict[str, Any] = {
        "artifact_format": artifact_format,
        "correlation_range_km": 680.3,
        "data_version": data_version,
        "lengthscale_sigma": 0.7,
        "likelihood": "beta_binomial",
        "model_version": model_version,
        "n_cells": len(cells),
        "n_observations": 12,
        "prior_frequency_sd": 0.12919,
        "resolution": resolution,
        "support_counts": {"interpolated": len(cells) - 1, "observed": 1},
        "variant_id": variant_id,
    }
    if measurement is not None:
        manifest["measurement"] = measurement
    if artifact_format == 2:
        manifest["target_grid_source"] = "worldpop-1km-unconstrained"
        manifest["target_grid_version"] = "fixture"
    return manifest


def add_artifact(
    data: Path,
    artifact: str,
    *,
    artifact_format: int,
    resolution: int,
    cells: Sequence[str],
    measurement: str | None,
) -> Path:
    """Write ``store/artifacts/<artifact>/{cells.parquet,manifest.json}`` under ``data``."""
    directory = data / dr.ARTIFACT_PREFIX / artifact
    directory.mkdir(parents=True, exist_ok=True)
    cells_frame(artifact, cells).to_parquet(directory / "cells.parquet", index=False)
    manifest = artifact_manifest(
        artifact, artifact_format=artifact_format, resolution=resolution, cells=cells, measurement=measurement
    )
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return directory


def commit_release(data: Path, releases: Path, release: str) -> dict[str, Any]:
    """Key every file under ``data`` as release ``release`` and commit its manifest to ``releases``."""
    previous = build_tables.committed_manifests(releases)
    files = sorted(path for path in data.rglob("*") if path.is_file())
    records = []
    for path in files:
        relative = path.relative_to(data).as_posix()
        records.append(
            dr.FileRecord(
                relative,
                path.stat().st_size,
                build_data_release.sha256_of(path),
                False,
                build_data_release.sources_for(data, relative),
            )
        )
    used = sorted({name for record in records for name in record.sources})
    sources = {name: build_data_release.REVIEWED_SOURCES[name] for name in used}
    manifest = dr.build_manifest(records, sources, release, previous)
    releases.mkdir(parents=True, exist_ok=True)
    (releases / f"{release}.json").write_bytes(dr.canonical_bytes(manifest))
    return manifest


@dataclass(frozen=True)
class FixtureTree:
    """A ``data/`` tree and the ``releases/`` folder that commits it."""

    root: Path
    data: Path
    releases: Path

    def context(self, release: str = EPOCH, git_sha: str = GIT_SHA) -> build_tables.BuildContext:
        """The context ``build_tables`` gives each stage, over this tree's committed releases."""
        manifests = build_tables.committed_manifests(self.releases)
        return build_tables.BuildContext(
            data_root=self.data,
            out_root=self.data,
            release=release,
            git_sha=git_sha,
            manifests=manifests,
            published=write_once.published_paths(manifests),
            repo_root=ROOT,
        )

    @property
    def ctx(self) -> build_tables.BuildContext:
        return self.context()


@pytest.fixture
def fixture_tree(tmp_path: Path) -> FixtureTree:
    """Release 2026-10-17 of the three ``FIXTURE_ARTIFACTS``, committed to ``releases/``."""
    data = tmp_path / "data"
    for artifact, (artifact_format, resolution, cells, measurement) in FIXTURE_ARTIFACTS.items():
        add_artifact(
            data,
            artifact,
            artifact_format=artifact_format,
            resolution=resolution,
            cells=cells,
            measurement=measurement,
        )
    tree = FixtureTree(tmp_path, data, tmp_path / "releases")
    commit_release(tree.data, tree.releases, FIXTURE_RELEASE)
    return tree
