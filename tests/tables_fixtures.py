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

The fit-input fixtures (step 1.9) read ``AFND_FIXTURE``, the AFND harvest stand-in: DQB1*03:01 in two
populations, a cytokine triple, KIR 2DL1 presence and KIR 3DL1*007, all in populations the released
``afnd-2026-08`` registry places. ``allele_part`` and ``carrier_part`` are the measured stage's
``afnd_frequencies`` and KIR carrier parts over it, ``afnd_aliases`` the registry's aliases, and
``web_payload`` one variant's observations JSON as ``export_atlas_web`` serves it. ``served_tree`` is the
fixture tree plus ``ART`` (HLA-DQB1*03:01, format 2 at res 4), all released in 2026-10-17 with the AFND
population table, and this release's measured parts over the fixture.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Collection
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import pytest

from genomeos.observations.sources import afnd_carriers
from genomeos.publication import data_release as dr
from genomeos.tables import fit_inputs, measured, meta, provenance, reference, write_once
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
    "AFND_FIXTURE",
    "AFND_POPULATIONS",
    "ART",
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
    "ServedTree",
    "add_artifact",
    "add_fixture_artifacts",
    "afnd_aliases",
    "allele_part",
    "artifact_manifest",
    "build_catalog_tables",
    "carrier_part",
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
    "served_tree",
    "web_json",
    "web_payload",
    "withdrawal",
    "write_parity_file",
]

#: The AFND harvest stand-in, in the real harvest's columns and with real AFND population names.
AFND_FIXTURE = Path(__file__).parent / "fixtures" / "afnd_frequencies_mixed.tsv"
#: The released AFND population table, the ``afnd-2026-08`` registry's input (call 18).
AFND_POPULATIONS = ROOT / "data" / measured.AFND_POPULATIONS
#: A served artifact the fixture's ``afnd_frequencies`` part holds: HLA-DQB1*03:01, format 2 at res 4.
ART = "hla__dqb1-03-01__v3__afnd-2026-08"

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


# --- the fit-input fixtures (step 1.9) ---


def _part(table: str, source: str) -> pd.DataFrame:
    """The measured stage's ``table`` part of ``source`` over ``AFND_FIXTURE`` (Task 19)."""
    (curated,) = (item for item in measured.CURATED_INGESTS if (item.table, item.source) == (table, source))
    rows, _ = curated.load(AFND_FIXTURE, AFND_POPULATIONS, curated.ingest_version)
    return measured.ingest_part(rows, table=table)


@cache
def _labels() -> dict[str, str]:
    """Each ``afnd-2026-08`` population's AFND name, the label the served JSON shows."""
    aliases = reference.afnd_legacy(AFND_POPULATIONS)[1]
    return dict(zip(aliases["population_id"], aliases["label"], strict=True))


@pytest.fixture
def allele_part() -> pd.DataFrame:
    """The ``afnd_frequencies`` part: DQB1*03:01 in two populations and KIR 3DL1*007."""
    return _part(measured.ALLELE_TABLE, "afnd_frequencies")


@pytest.fixture
def carrier_part() -> pd.DataFrame:
    """The KIR carrier part: 2DL1 present in 95 of 100 individuals."""
    return _part(measured.CARRIER_TABLE, "afnd")


@pytest.fixture
def afnd_aliases() -> pd.DataFrame:
    """The aliases of registry ``afnd-2026-08``, rebuilt from the released AFND population table."""
    return reference.afnd_legacy(AFND_POPULATIONS)[1]


def _edited(value: Any) -> Any:
    """Another value of the same JSON type."""
    if isinstance(value, bool):
        return not value
    if isinstance(value, int | float):
        return value + 1
    return f"{value}-edited"


def web_json(part: pd.DataFrame, variant_id: str, *, edit: tuple[int, str] | None = None) -> bytes:
    """``variant_id``'s observations JSON as ``export_atlas_web`` writes it, from ``part``'s rows: canonical
    bytes, and a carrier part's counts as ``ac``/``an`` through ``as_binomial``. ``edit=(row, field)``
    changes that row's value of ``field``."""
    rows = part[part["variant_id"] == variant_id]
    carrier = "carriers" in part.columns
    if carrier:
        rows = afnd_carriers.as_binomial(rows)
    records = []
    for row in rows.to_dict(orient="records"):
        label = _labels()[row["population_id"]]
        records.append(
            {
                "ac": int(row["ac"]),
                "an": int(row["an"]),
                "assay": str(row["assay"]),
                "citation_text": f"Allele Frequency Net Database (AFND): {label}",
                "cohort_id": str(row["cohort_id"]),
                "disease_ascertainment_excluded": bool(row["disease_ascertainment_excluded"]),
                "ingest_version": str(row["ingest_version"]),
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
                "population_label": label,
                "radius_km": float(row["radius_km"]),
                "sampling_design": str(row["sampling_design"]),
                "source_locator": f"AFND {variant_id} measurement for {label}",
                "source_record_id": str(row["source_record_id"]),
                "source_url": "https://www.allelefrequencies.net/",
                "study_id": str(row["cohort_id"]),
                "study_label": label,
            }
        )
    if edit is not None:
        index, field = edit
        records[index][field] = _edited(records[index][field])
    artifact = {
        "artifact_format": 2,
        "data_version": measured.AFND_INGEST_VERSION,
        "entity_type": "allele",
        "id": variant_id.replace(":", "-"),
        "label": variant_id,
        "measurement": "carrier_frequency" if carrier else "allele_frequency",
        "model_version": "v3",
        "registry_version": reference.AFND_LEGACY,
        "resolution": 4,
        "variant_id": variant_id,
    }
    document = {"artifact": artifact, "observations": records, "schema_version": 1}
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    return text.encode()


def web_payload(
    part: pd.DataFrame, variant_id: str, *, edit: tuple[int, str] | None = None
) -> fit_inputs.WebObservations:
    """``web_json``, parsed as the build reads a served file pinned by its sha256."""
    payload = web_json(part, variant_id, edit=edit)
    return fit_inputs.parse_web_observations(payload, expected_sha256=hashlib.sha256(payload).hexdigest())


@dataclass(frozen=True)
class ServedTree(FixtureTree):
    """A fixture tree serving ``ART``: its observations JSON (``web``), and the same with row 0's ``ac`` + 1
    (``drifted_web``)."""

    web: tuple[fit_inputs.WebObservations, ...] = ()
    drifted_web: tuple[fit_inputs.WebObservations, ...] = ()


@pytest.fixture
def served_tree(tmp_path: Path) -> ServedTree:
    """``fixture_tree`` plus ``ART`` and the AFND population table, released in 2026-10-17, with the
    harvest stand-in and this release's measured parts over it."""
    tree = FixtureTree(tmp_path, tmp_path / "data", tmp_path / "releases")
    add_fixture_artifacts(tree.data)
    add_artifact(
        tree.data,
        ART,
        artifact_format=2,
        resolution=4,
        cells=(LAGOS_R4, LONDON_R4),
        measurement="allele_frequency",
    )
    _copy(AFND_POPULATIONS, tree.data / measured.AFND_POPULATIONS)
    commit_release(tree.data, tree.releases, FIXTURE_RELEASE)
    _copy(AFND_FIXTURE, tree.data / measured.AFND_FREQUENCIES)
    build_tables.build_measured(tree.ctx)
    part, variant_id = _part(measured.ALLELE_TABLE, "afnd_frequencies"), "hla:dqb1-03-01"
    return ServedTree(
        tree.root,
        tree.data,
        tree.releases,
        web=(web_payload(part, variant_id),),
        drifted_web=(web_payload(part, variant_id, edit=(0, "ac")),),
    )


def _copy(source: Path, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, out)
