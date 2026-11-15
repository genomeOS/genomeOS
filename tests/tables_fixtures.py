"""Shared constants and helpers for the ``tables/`` tests (Atlas data platform design 2026-10-18 §2).

The meta tests read exactly the two committed manifests named in ``COMMITTED_RELEASES``, never a glob
of ``data/releases/``, so a release PR that commits a third manifest does not change their counts.

``fixture_tree`` is a small ``data/`` tree with its own committed release 2026-10-17: three artifacts
(HbS v1, format 1 at res 3 with no ``measurement``; HbS v3 and KIR 2DL1 v3, format 2 at res 4), each
with one cell over Lagos and one over London, all in ``RELEASED_WITHOUT_INPUT``. A test module
registers it by name: ``fixture_tree = tables_fixtures.fixture_tree``.

``catalog_tree`` (step 1.6) is the same three artifacts plus a 3-row parity file and the curated
``SOURCE.json``, committed as release 2026-10-17 (8 objects, 5 sources), a web catalog serving HbS v3 and
KIR 2DL1 v3, an empty withdrawn list, and the files every release reads but 2026-10-17 did not publish
(the CPIC record, the inventory, the AFND population table and the normalization registry).
``make_catalog_tree`` builds it outside pytest too; ``build_catalog_tables`` then builds release
``EPOCH``'s tables and ``release_catalog_tree`` releases it. Every Parquet input is written by the pinned
DuckDB, so its bytes depend on no pandas or pyarrow version.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import pytest

from genomeos.publication import data_release as dr
from genomeos.tables import catalog, inferred, meta, provenance, write_once, writer
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
    """Write ``store/artifacts/<artifact>/{cells.parquet,manifest.json}`` under ``data``; the cells
    through the pinned DuckDB."""
    directory = data / dr.ARTIFACT_PREFIX / artifact
    directory.mkdir(parents=True, exist_ok=True)
    con = writer.connect()
    con.register("genomeos_cells", cells_frame(artifact, cells))
    con.execute(f"COPY genomeos_cells TO '{directory / 'cells.parquet'}' (FORMAT parquet)")
    manifest = artifact_manifest(
        artifact, artifact_format=artifact_format, resolution=resolution, cells=cells, measurement=measurement
    )
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return directory


def commit_release(
    data: Path, releases: Path, release: str, *, paths: Iterable[str] | None = None
) -> dict[str, Any]:
    """Key ``paths`` (default: every file under ``data``) as release ``release`` and commit its manifest
    to ``releases``. The CPIC, ClinVar and GeneReviews terms come from the records, when ``data`` holds
    them."""
    previous = build_tables.committed_manifests(releases)
    if paths is None:
        paths = (path.relative_to(data).as_posix() for path in data.rglob("*") if path.is_file())
    records = []
    for relative in sorted(paths):
        path = data / relative
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
    available = dict(build_data_release.REVIEWED_SOURCES)
    if (data / build_data_release.CPIC_RECORD).is_file():
        available |= build_data_release._record_sources(data)
    sources = {name: available[name] for name in used}
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


def add_fixture_artifacts(data: Path) -> None:
    """The three ``FIXTURE_ARTIFACTS`` under ``data``."""
    for artifact, (artifact_format, resolution, cells, measurement) in FIXTURE_ARTIFACTS.items():
        add_artifact(
            data,
            artifact,
            artifact_format=artifact_format,
            resolution=resolution,
            cells=cells,
            measurement=measurement,
        )


@pytest.fixture
def fixture_tree(tmp_path: Path) -> FixtureTree:
    """Release 2026-10-17 of the three ``FIXTURE_ARTIFACTS``, committed to ``releases/``."""
    data = tmp_path / "data"
    add_fixture_artifacts(data)
    tree = FixtureTree(tmp_path, data, tmp_path / "releases")
    commit_release(tree.data, tree.releases, FIXTURE_RELEASE)
    return tree


# --- catalog_tree: fixture_tree plus the parity file, for the catalog (step 1.6) ---

#: The parity rows, ``(lat, lon, radius_km, an, ac)``: one at Lagos, and two 600 km north of it, one
#: inside the 500 km disc plus its 150 km radius and one outside it plus its 50 km radius.
PARITY_ROWS = (
    (6.5244, 3.3792, 1.0, 100, 10),
    (11.9203, 3.3792, 150.0, 200, 20),
    (11.9203, 3.3792, 50.0, 400, 40),
)
#: The web catalog's served artifacts (call 7), in ``catalog_tree`` beside ``data/``.
CATALOG_SERVED = (HBS_V3, KIR_V3)
WEB_CATALOG_FILE = "web-catalog.json"
#: Every fixture artifact, with its reason: each was released without its fit input (#45).
FIXTURE_WITHOUT_INPUT: Mapping[str, str] = {
    artifact: build_data_release.RELEASED_WITHOUT_INPUT[artifact] for artifact in FIXTURE_ARTIFACTS
}
#: Files under required include roots that release 2026-10-17 of ``catalog_tree`` did not publish.
RELEASE_INPUTS: Mapping[str, bytes] = {
    "raw/afnd_populations.tsv": b"pop_id\tpopulation\n",
    "registry/variant_normalization.tsv": b"variant_id\n",
    "store/INVENTORY.json": b"{}\n",
    "store/catalog-metadata.json": b"{}\n",
}
_EMPTY_WITHDRAWN = {
    "schema": dr.WITHDRAWN_SCHEMA,
    "schema_version": dr.WITHDRAWN_SCHEMA_VERSION,
    "withdrawn": [],
}


def write_parity_file(data: Path) -> Path:
    """``PARITY_ROWS`` as the 17 observation columns of the released parity file, by the pinned DuckDB."""
    out = data / catalog.PARITY_FILE
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = ", ".join(
        f"({index}, {lat!r}, {lon!r}, {radius!r}, {an}, {ac})"
        for index, (lat, lon, radius, an, ac) in enumerate(PARITY_ROWS)
    )
    writer.connect().execute(
        "COPY (SELECT 'chr11-5227002-T-A' AS variant_id, 'rs334' AS rsid, 'map-hbs-' || i AS population_id, "
        "lat::DOUBLE AS lat, lon::DOUBLE AS lon, radius::DOUBLE AS radius_km, ac::BIGINT AS ac, "
        "an::BIGINT AS an, 'map-surveys:' || i AS source_record_id, 'map_hbs' AS source, "
        "'haemoglobin_electrophoresis' AS assay, 0::BIGINT AS date_lower, 0::BIGINT AS date_upper, "
        "'population_random' AS sampling_design, false AS disease_ascertainment_excluded, "
        "'cohort-' || i AS cohort_id, 'map-2026-08' AS ingest_version "
        f"FROM (VALUES {rows}) AS parity(i, lat, lon, radius, an, ac) ORDER BY i) "
        f"TO '{out}' (FORMAT parquet)"
    )
    return out


def make_catalog_tree(root: Path) -> Path:
    """``root/data`` and ``root/releases`` as the ``catalog_tree`` fixture describes; returns ``root``."""
    data, releases = root / "data", root / "releases"
    add_fixture_artifacts(data)
    write_parity_file(data)
    for record in (build_data_release.CURATED_RECORD, build_data_release.CPIC_RECORD):
        (data / record).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "data" / record, data / record)
    artifact_files = (
        f"{dr.ARTIFACT_PREFIX}{artifact}/{name}"
        for artifact in FIXTURE_ARTIFACTS
        for name in (inferred.CELLS_FILE, meta.MANIFEST_FILE)
    )
    published = [*artifact_files, catalog.PARITY_FILE, build_data_release.CURATED_RECORD]
    commit_release(data, releases, FIXTURE_RELEASE, paths=published)
    for path, payload in RELEASE_INPUTS.items():
        (data / path).parent.mkdir(parents=True, exist_ok=True)
        (data / path).write_bytes(payload)
    fields = ("variant_id", "model_version", "data_version")
    served = [dict(zip(fields, identity(artifact), strict=True)) for artifact in CATALOG_SERVED]
    (root / WEB_CATALOG_FILE).write_text(json.dumps({"artifacts": served}, indent=2) + "\n")
    (releases / dr.WITHDRAWN_FILE).write_bytes(dr.canonical_bytes(_EMPTY_WITHDRAWN))
    return root


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


def build_catalog_tables(root: Path, *, withdrawn: Sequence[Mapping[str, str]] = ()) -> None:
    """Release ``EPOCH``'s meta and inferred tables over ``root``, which withdraws ``withdrawn``."""
    tree = FixtureTree(root, root / "data", root / "releases")
    listed = tree.releases / dr.WITHDRAWN_FILE
    entries = sorted(withdrawn, key=lambda entry: entry["key"])
    listed.write_bytes(dr.canonical_bytes({**_EMPTY_WITHDRAWN, "withdrawn": entries}))
    build_tables.build_meta(tree.ctx, web_catalog=root / WEB_CATALOG_FILE, withdrawn=listed)
    build_tables.build_inferred(tree.ctx)


def release_catalog_tree(root: Path, *, catalog: bool = True) -> dict[str, Any]:
    """Release ``EPOCH`` of ``root`` (its tables built), in both passes when ``catalog``."""
    releases = root / "releases"
    return build_data_release.build(
        root / "data",
        EPOCH,
        tracked=set(),
        released_without_input=FIXTURE_WITHOUT_INPUT,
        previous=build_tables.committed_manifests(releases),
        withdrawn=build_data_release.withdrawn_entries(releases),
        catalog=catalog,
    )
