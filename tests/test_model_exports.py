"""The release rule for trained models under ``store/models/`` (Atlas data platform design 2026-10-18 §2.1,
§4.2 R0; step 1.12, #471).

``genomeos.publication.model_exports`` checks what a release publishes there without importing the
surface stack: a closed manifest of a known schema and format, naming its own directory's artifact,
bound by sha256 to a fit input this release or an earlier one publishes, and listing exactly the files
the release holds under it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from genomeos.publication import data_release as dr
from genomeos.publication import model_exports as me
from genomeos.surfaces import model_export
from genomeos.surfaces.fit import fit_surface
from tests.surface_fixtures import FAST_CONFIG, published_artifact, synthetic_observations

ARTIFACT = "a__v4__map-x"
FIT_INPUT = "c" * 64
PAYLOADS = {
    "model.json": b'{"variant_id": "a"}\n',
    "inducing_points.npy": b"stand-in for a (0, 3) array",
    "posterior/lengthscale.npy": b"stand-in for the draws",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _export() -> tuple[dict[str, dict[str, Any]], dict[str, me.ModelFile]]:
    """One model directory as a release lists it: its manifest, and every file with its digest."""
    manifest = {
        "schema": me.EXPORT_SCHEMA,
        "export_format": 1,
        "artifact": ARTIFACT,
        "fit_input_sha256": FIT_INPUT,
        "files": {name: {"sha256": _sha256(data), "bytes": len(data)} for name, data in PAYLOADS.items()},
        "software": {"numpy": "2.3.0"},
    }
    written = json.dumps(manifest, sort_keys=True).encode()
    files = {
        f"{dr.MODEL_PREFIX}{ARTIFACT}/{name}": me.ModelFile(_sha256(data), len(data))
        for name, data in {**PAYLOADS, me.MODEL_MANIFEST: written}.items()
    }
    return {ARTIFACT: manifest}, files


def _check(manifests: dict[str, dict[str, Any]], files: dict[str, me.ModelFile]) -> None:
    me.check_model_exports(manifests, files, artifact_inputs={ARTIFACT: FIT_INPUT})


def test_a_complete_export_bound_to_its_artifacts_input_passes() -> None:
    _check(*_export())


def test_the_layout_constants_are_model_exports(tmp_path: Path) -> None:
    """The release rule copies the exporter's layout (it never imports the surface stack), so they must
    agree; and what ``export_model`` writes passes the rule unchanged."""
    for name in ("EXPORT_SCHEMA", "MODEL_MANIFEST", "MODEL_FILE", "INDUCING_FILE", "POSTERIOR_DIR"):
        assert getattr(me, name) == getattr(model_export, name), name
    assert me.EXPORT_FORMATS == frozenset({1})
    assert model_export.EXPORT_FORMAT in me.EXPORT_FORMATS

    fit = fit_surface(synthetic_observations(), FAST_CONFIG)
    artifact = published_artifact(fit, tmp_path / "artifacts")
    directory = model_export.export_model(fit, artifact, tmp_path / "models")
    files = {
        f"{dr.MODEL_PREFIX}{directory.name}/{path.relative_to(directory).as_posix()}": me.ModelFile(
            _sha256(path.read_bytes()), path.stat().st_size
        )
        for path in directory.rglob("*")
        if path.is_file()
    }
    manifests = {directory.name: json.loads((directory / me.MODEL_MANIFEST).read_text(encoding="utf-8"))}
    fit_input = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))["observations"]
    me.check_model_exports(manifests, files, artifact_inputs={artifact.name: fit_input["sha256"]})


@pytest.mark.parametrize(
    ("edit", "match"),
    [
        (lambda manifest: manifest.update(export_format=2), "format 2 is not"),
        (lambda manifest: manifest.update(export_format=True), "format True is not"),
        (lambda manifest: manifest.update(artifact="b__v4__map-x"), "model of 'b__v4__map-x'"),
        (lambda manifest: manifest.update(note="an extra field"), r"unknown fields \['note'\]"),
        (lambda manifest: manifest["files"].update({"notes.txt": {}}), "'notes.txt' is not a file"),
    ],
    ids=["export-format-2", "export-format-true", "another-artifact", "an-extra-field", "a-stray-file"],
)
def test_a_misdescribed_manifest_is_refused(edit: Callable[[dict[str, Any]], None], match: str) -> None:
    manifests, files = _export()
    edit(manifests[ARTIFACT])
    with pytest.raises(dr.DataReleaseError, match=match):
        _check(manifests, files)


def test_a_directory_whose_files_are_not_its_manifests_is_refused() -> None:
    """Without its manifest a directory binds to nothing; a listed file the release lacks is incomplete."""
    manifests, files = _export()
    with pytest.raises(dr.DataReleaseError, match=f"{ARTIFACT}/: no {me.MODEL_MANIFEST}"):
        _check({}, files)
    del files[f"{dr.MODEL_PREFIX}{ARTIFACT}/posterior/lengthscale.npy"]
    with pytest.raises(dr.DataReleaseError, match=r"listed in its manifest but not released: \['posterior"):
        _check(manifests, files)
