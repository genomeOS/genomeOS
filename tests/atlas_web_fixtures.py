"""Tiny, hand-readable Atlas web trees for the bucket-script tests (design 2026-10-07 §C.3).

One artifact, three tiers and three canonical JSON downloads, each a few bytes long, so every digest
in a failure message can be recomputed by eye. The bytes are stand-ins: the bucket scripts move and
verify bytes and never decode them (decoding is covered by Part B's codec tests).
"""

from __future__ import annotations

import hashlib
import json
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from genomeos.publication.web_layout import apply_download_layout, artifact_objects

GRID = b"GOSA grid stand-in: two res-3 cells\n"
RENDER = b"GOSA render stand-in: hbs-test\n"
DETAIL = b"GOSA detail stand-in: hbs-test\n"
SURFACE = b'{"artifact":{"id":"hbs-test"},"cells":[]}\n'
OBSERVATIONS = b'{"artifact":{"id":"hbs-test"},"observations":[]}\n'
MANIFEST = b'{"id":"hbs-test","model_version":"v1"}\n'
BORDERS = b'{"type":"FeatureCollection","features":[]}\n'
GNOMAD = b'{"source":"gnomad"}\n'
# The decoded-grid digest that keys catalog["grids"]; a stand-in that is never recomputed here.
GRID_SHA256 = "a1" * 32
GNOMAD_KEY = "external/gnomad/chr11-5227002-t-a.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _download(label: str, data: bytes, url: str) -> dict[str, Any]:
    return {"label": label, "media_type": "application/json", "sha256": sha256(data), "url": url}


def _tier(name: str, data: bytes) -> dict[str, Any]:
    url = f"surfaces/hbs-test/v1/map-test/{name}.{sha256(data)[:16]}.gosa"
    return {"bytes": len(data), "sha256": sha256(data), "url": url}


def flat_catalog() -> dict[str, Any]:
    """The catalog fields the bucket scripts read, as Part B's encoder writes them (flat JSON names)."""
    return {
        "artifacts": [
            {
                "data_version": "map-test",
                "downloads": {
                    "manifest": _download("Artifact manifest", MANIFEST, "hbs-test.manifest.json"),
                    "observations": _download(
                        "Measured observations", OBSERVATIONS, "hbs-test.observations.json"
                    ),
                    "surface": _download("Inferred surface", SURFACE, "hbs-test.surface.json"),
                },
                "external_resources": [
                    {"cache_sha256": sha256(GNOMAD), "cache_url": GNOMAD_KEY, "source": "gnomad"}
                ],
                "id": "hbs-test",
                "model_version": "v1",
                "observations_available": True,
                "observations_bytes": len(OBSERVATIONS),
                "observations_sha256": sha256(OBSERVATIONS),
                "observations_url": "hbs-test.observations.json",
                "surface_sha256": sha256(SURFACE),
                "surface_url": "hbs-test.surface.json",
                "web": {
                    "detail": _tier("detail", DETAIL),
                    "grid_sha256": GRID_SHA256,
                    "render": _tier("render", RENDER),
                },
            }
        ],
        "context_sources": [{"id": "natural-earth-admin-0", "url": "ne-50m-admin-0.geojson"}],
        "grids": {
            GRID_SHA256: {
                "bytes": len(GRID),
                "n_cells": 2,
                "resolution": 3,
                "sha256": sha256(GRID),
                "url": f"grids/h3-r3.{sha256(GRID)[:16]}.gosa",
            }
        },
    }


def staged_catalog() -> dict[str, Any]:
    """`flat_catalog()` after `encode_atlas_web.py --with-downloads`: what publishing reads."""
    return apply_download_layout(flat_catalog())[0]


def object_bytes(catalog: dict[str, Any]) -> dict[str, bytes]:
    """Every artifact-base key of `catalog`, in key order, mapped to its stand-in bytes."""
    by_digest = {sha256(data): data for data in (GRID, RENDER, DETAIL, SURFACE, OBSERVATIONS, MANIFEST)}
    return {item.key: by_digest[item.sha256] for item in artifact_objects(catalog)}


def write_staging(root: Path, catalog: dict[str, Any] | None = None) -> dict[str, Any]:
    """Write a staging tree (catalog.json plus every object at its key); return its catalog."""
    catalog = staged_catalog() if catalog is None else catalog
    for key, data in object_bytes(catalog).items():
        path = root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    text = json.dumps(catalog, sort_keys=True, separators=(",", ":")) + "\n"
    (root / "catalog.json").write_text(text, encoding="utf-8")
    return catalog


def write_dist(root: Path, artifact_base: str, catalog: dict[str, Any] | None = None) -> Path:
    """A built-site stand-in: /app/ with its baked data bases and inline catalog (default
    `staged_catalog()`, `<` escaped as the build escapes it), plus the site-base files."""
    (root / "app").mkdir(parents=True, exist_ok=True)
    bases = json.dumps({"artifact": artifact_base, "site": "/data/atlas/"})
    inline = json.dumps(staged_catalog() if catalog is None else catalog).replace("<", "\\u003c")
    (root / "app" / "index.html").write_text(
        f'<!doctype html><script type="application/json" id="atlas-data-bases">{bases}</script>\n'
        f'<script type="application/json" id="atlas-catalog">{inline}</script>\n',
        encoding="utf-8",
    )
    site = root / "data" / "atlas"
    (site / "external" / "gnomad").mkdir(parents=True, exist_ok=True)
    (site / "ne-50m-admin-0.geojson").write_bytes(BORDERS)
    (site / GNOMAD_KEY).write_bytes(GNOMAD)
    return root


FAKE_GCLOUD = Path(__file__).with_name("fake_gcloud.py")
MUTATING_VERBS = {
    "create",
    "update",
    "add-iam-policy-binding",
    "remove-iam-policy-binding",
    "cp",
    "enable",
    "deploy",
    "undelete",
}


@dataclass(frozen=True)
class FakeGcloud:
    """Handle on tests/fake_gcloud.py's state and call log for one test."""

    state_path: Path
    log_path: Path

    def state(self) -> dict[str, Any]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def write_state(self, state: dict[str, Any]) -> None:
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

    def _records(self) -> list[dict[str, Any]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]

    def calls(self) -> list[list[str]]:
        return [record["argv"] for record in self._records()]

    def configs(self) -> set[str | None]:
        return {record["cloudsdk_config"] for record in self._records()}

    def impersonations(self) -> set[str | None]:
        return {record.get("impersonate") for record in self._records()}

    def mutating_calls(self) -> list[list[str]]:
        return [call for call in self.calls() if MUTATING_VERBS & set(call[:4])]


def install_fake_gcloud(
    root: Path, monkeypatch: pytest.MonkeyPatch, state: dict[str, Any] | None = None
) -> FakeGcloud:
    """Point scripts/gcloud_repo.py at tests/fake_gcloud.py through GENOMEOS_GCLOUD_EXECUTABLE."""
    root.mkdir(parents=True, exist_ok=True)
    shim = root / "fake-gcloud"
    shim.write_text(
        f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(FAKE_GCLOUD))} "$@"\n',
        encoding="utf-8",
    )
    shim.chmod(0o755)
    fake = FakeGcloud(root / "fake-gcloud-state.json", root / "fake-gcloud-log.jsonl")
    fake.write_state(json.loads(json.dumps(state or {})))
    monkeypatch.setenv("GENOMEOS_GCLOUD_EXECUTABLE", str(shim))
    monkeypatch.setenv("FAKE_GCLOUD_STATE", str(fake.state_path))
    monkeypatch.setenv("FAKE_GCLOUD_LOG", str(fake.log_path))
    return fake
