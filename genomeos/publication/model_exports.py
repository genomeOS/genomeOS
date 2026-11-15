"""The release rule for trained models under ``store/models/`` (Atlas data platform design 2026-10-18 §2.1,
§4.2 R0; step 1.12, #471).

§2.1 publishes a trained model as a safe export beside its artifact, ``store/models/<artifact-id>/``:
"pickles never". ``genomeos.surfaces.model_export`` writes one (JSON and float64 ``.npy``, then a
manifest) and loads it back without unpickling. This module is what a release checks before it lists
one, and it owns the export's layout (its file names and the manifest's keys): the exporter imports the
layout from here. The dependency runs that way only, because the release builder never imports the
surface stack, so this module imports no surface code.

R0 (no pickle, no object-dtype ``.npy``) is applied to every file before it is hashed, by
``scripts/build_data_release.py``'s ``collect``; ``data_release.build_manifest`` keeps a released model
directory closed, like an artifact. Here, each model directory must hold a closed manifest of a known
schema and format, naming its own directory as its artifact, bound to the sha256 of a fit input this
release or an earlier one publishes for that artifact (#45), and listing exactly the files the release
holds under the directory, each with its sha256 and size. Every violation is a hard error (v1 §12). No
I/O and no network.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from genomeos.publication import data_release as dr

# The export's layout. ``genomeos.surfaces.model_export`` writes and reads it, importing it from here.
EXPORT_SCHEMA = "genomeos-model-export"
#: The export formats a release accepts (``model_export.EXPORT_FORMAT`` is the one the exporter writes).
EXPORT_FORMATS = frozenset({1})
#: Written last, so a directory with a manifest is a directory whose files are all there.
MODEL_MANIFEST = "manifest.json"
MODEL_FILE = "model.json"
INDUCING_FILE = "inducing_points.npy"
POSTERIOR_DIR = "posterior"
#: The manifest's closed keys, and those of each file it lists.
MANIFEST_FIELDS = frozenset({"schema", "export_format", "artifact", "fit_input_sha256", "files", "software"})
FILE_FIELDS = frozenset({"sha256", "bytes"})
#: One ``.npy`` per free random variable; the group is the variable's name.
POSTERIOR_FILE = re.compile(rf"{POSTERIOR_DIR}/([A-Za-z_][A-Za-z0-9_]*)\.npy")

_SHA256 = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class ModelFile:
    """One file a release lists under ``store/models/``, as the builder measured it."""

    sha256: str
    bytes: int


def check_model_exports(
    manifests: Mapping[str, Mapping[str, Any]],
    files: Mapping[str, ModelFile],
    *,
    artifact_inputs: Mapping[str, str],
) -> None:
    """Refuse any model directory a release would publish that is not a complete export of its artifact.

    ``manifests`` maps each model directory to its parsed ``manifest.json``; ``files`` maps the data path
    of every file the release lists under ``store/models/``, manifests included, to its digest and size;
    ``artifact_inputs`` maps each artifact directory to the sha256 of the ``observations.parquet`` this
    release or an earlier one publishes for it.
    """
    listed: dict[str, dict[str, ModelFile]] = {directory: {} for directory in manifests}
    for path, measured in files.items():
        closed = dr.closed_directory(path)
        if closed is None or closed[0] != dr.MODEL_PREFIX:
            raise dr.DataReleaseError(f"{path}: not a file inside a model directory under {dr.MODEL_PREFIX}")
        listed.setdefault(closed[1], {})[path[len(dr.MODEL_PREFIX) + len(closed[1]) + 1 :]] = measured
    for directory, found in sorted(listed.items()):
        where = f"{dr.MODEL_PREFIX}{directory}/"
        if directory not in manifests or MODEL_MANIFEST not in found:
            raise dr.DataReleaseError(
                f"{where}: no {MODEL_MANIFEST}, so it is not a complete model export (it is written last)"
            )
        manifest = manifests[directory]
        _check_manifest(where, directory, manifest, artifact_inputs)
        recorded = _recorded_files(where, manifest["files"])
        on_release = set(found) - {MODEL_MANIFEST}
        unlisted, absent = sorted(on_release - set(recorded)), sorted(set(recorded) - on_release)
        if unlisted:
            raise dr.DataReleaseError(f"{where}: files not listed in its {MODEL_MANIFEST}: {unlisted}")
        if absent:
            raise dr.DataReleaseError(f"{where}: files listed in its manifest but not released: {absent}")
        for name, entry in sorted(recorded.items()):
            if found[name] != entry:
                raise dr.DataReleaseError(
                    f"{where}{name}: sha256 {found[name].sha256} ({found[name].bytes} bytes), but its "
                    f"{MODEL_MANIFEST} records {entry.sha256} ({entry.bytes} bytes)"
                )


def _check_manifest(
    where: str, directory: str, manifest: Mapping[str, Any], artifact_inputs: Mapping[str, str]
) -> None:
    """Closed keys, a known schema and format, its own artifact, and that artifact's fit input."""
    if not isinstance(manifest, Mapping):
        raise dr.DataReleaseError(f"{where}{MODEL_MANIFEST} is not a JSON object")
    unknown, missing = sorted(set(manifest) - MANIFEST_FIELDS), sorted(MANIFEST_FIELDS - set(manifest))
    if unknown or missing:
        raise dr.DataReleaseError(
            f"{where}{MODEL_MANIFEST}: unknown fields {unknown}, missing fields {missing}"
        )
    schema, export_format = manifest["schema"], manifest["export_format"]
    if schema != EXPORT_SCHEMA or type(export_format) is not int or export_format not in EXPORT_FORMATS:
        raise dr.DataReleaseError(
            f"{where}{MODEL_MANIFEST}: schema {schema!r} format {export_format!r} is not {EXPORT_SCHEMA!r} "
            f"format {sorted(EXPORT_FORMATS)}"
        )
    if manifest["artifact"] != directory:
        raise dr.DataReleaseError(
            f"{where}{MODEL_MANIFEST}: it is the model of {manifest['artifact']!r}, not of {directory!r}; "
            "a model is published under its own artifact's id"
        )
    if directory not in artifact_inputs:
        raise dr.DataReleaseError(
            f"{where}: no artifact with a fit input is published as {dr.ARTIFACT_PREFIX}{directory}/ in "
            "this release or an earlier one, so the model is bound to nothing (#45)"
        )
    if manifest["fit_input_sha256"] != artifact_inputs[directory]:
        raise dr.DataReleaseError(
            f"{where}: exported from fit input {manifest['fit_input_sha256']!r}, but its artifact's fit "
            f"input ({dr.ARTIFACT_PREFIX}{directory}/observations.parquet) is {artifact_inputs[directory]}"
        )
    software = manifest["software"]
    if not isinstance(software, Mapping) or not all(isinstance(value, str) for value in software.values()):
        raise dr.DataReleaseError(f"{where}{MODEL_MANIFEST}: software must map each package to its version")


def _recorded_files(where: str, files: object) -> dict[str, ModelFile]:
    """The manifest's ``files``: each a file an export holds, recorded as exactly a sha256 and a size."""
    if not isinstance(files, Mapping):
        raise dr.DataReleaseError(
            f"{where}{MODEL_MANIFEST}: files must map each file to its sha256 and bytes"
        )
    recorded: dict[str, ModelFile] = {}
    for name, entry in files.items():
        if name not in (MODEL_FILE, INDUCING_FILE) and not POSTERIOR_FILE.fullmatch(name):
            raise dr.DataReleaseError(f"{where}{MODEL_MANIFEST}: {name!r} is not a file a model export holds")
        if (
            not isinstance(entry, Mapping)
            or set(entry) != FILE_FIELDS
            or not isinstance(entry["sha256"], str)
            or not _SHA256.fullmatch(entry["sha256"])
            or type(entry["bytes"]) is not int
        ):
            raise dr.DataReleaseError(
                f"{where}{MODEL_MANIFEST}: {name!r} must be recorded as exactly a sha256 and a byte count"
            )
        recorded[name] = ModelFile(entry["sha256"], entry["bytes"])
    for required in (MODEL_FILE, INDUCING_FILE):
        if required not in recorded:
            raise dr.DataReleaseError(f"{where}{MODEL_MANIFEST}: {required} is not listed")
    return recorded
