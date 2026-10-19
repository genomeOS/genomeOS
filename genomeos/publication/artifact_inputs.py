"""Inputs travel with outputs: the release rule for an artifact's fit input (#45; data store design §5).

Every artifact a release publishes carries ``observations.parquet``, the exact observation table its
fit consumed, and its ``manifest.json`` records that file's sha256, size, row count and contract.
The release builder measures the file and calls ``check_artifact_inputs``; any disagreement is a
hard error (design §12), never a skipped file.

Artifacts released before the rule cannot be repaired in place: a released artifact is immutable,
so it may not gain a file. Each one is named, with a reason, in the builder's reviewed
``RELEASED_WITHOUT_INPUT`` table, and that table may name only an artifact an earlier release holds.
Nothing is exempt by default: a released artifact that is missing from the table and has no input
fails the build like a new one.

Pure and dependency-free, like ``data_release``: the builder must not load the surface stack to
build a manifest. The publisher's side of the contract is ``genomeos.surfaces.fit_input``, and a
test pins the two together.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from typing import Any

from genomeos.publication.data_release import DataReleaseError

#: The input's name inside each artifact directory (``genomeos.surfaces.fit_input.OBSERVATIONS_FILE``).
INPUT_FILE = "observations.parquet"
#: The frozen contract its columns obey (``genomeos.surfaces.fit_input.OBSERVATIONS_CONTRACT``).
INPUT_CONTRACT = "contract/observations.schema.json"
#: The manifest key that records it.
RECORD_KEY = "observations"
#: Counts, not frequencies (design §7.1b): the binomial likelihood needs the denominator.
COUNT_COLUMNS = ("ac", "an")
_RECORD_FIELDS = frozenset({"path", "sha256", "bytes", "row_count", "schema", "schema_sha256", "columns"})
_SHA256 = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class InputFile:
    """What the builder measured from an artifact's ``observations.parquet``."""

    sha256: str
    bytes: int
    rows: int
    columns: tuple[str, ...]


def check_artifact_inputs(
    manifests: Mapping[str, Mapping[str, Any]],
    inputs: Mapping[str, InputFile],
    *,
    released: Collection[str],
    released_without_input: Mapping[str, str],
) -> None:
    """Refuse a release in which any artifact lacks the input its fit consumed, or misdescribes it.

    ``manifests`` maps each artifact directory in the release to its parsed ``manifest.json``;
    ``inputs`` maps the directories that hold an ``observations.parquet`` to what was measured from
    it; ``released`` names every artifact directory an earlier release holds.
    """
    for name, reason in sorted(released_without_input.items()):
        if not isinstance(reason, str) or not reason.strip():
            raise DataReleaseError(f"{name}: listed as released without its input, but with no reason")
        if name not in released:
            raise DataReleaseError(
                f"{name}: listed as released without its input, but no earlier release holds it. Only an "
                f"artifact released before inputs travelled with outputs may be listed; a new artifact "
                f"must carry {INPUT_FILE} (#45)"
            )
    for name in sorted(manifests):
        if name in released_without_input:
            if name in inputs:
                raise DataReleaseError(
                    f"{name}: released without its input, and now holds {INPUT_FILE}. A released artifact "
                    "is immutable and cannot gain a file (design §5); publish the recovered input under a "
                    "new key instead"
                )
            continue
        if name not in inputs:
            raise DataReleaseError(
                f"{name}: no {INPUT_FILE}. Every new artifact carries the observation table its fit "
                "consumed (#45); an artifact released before that rule must be named, with a reason, in "
                "RELEASED_WITHOUT_INPUT"
            )
        _check_record(name, manifests[name], inputs[name])


def _check_record(name: str, manifest: Mapping[str, Any], measured: InputFile) -> None:
    record = manifest.get(RECORD_KEY)
    if not isinstance(record, Mapping):
        raise DataReleaseError(f"{name}: manifest.json records no {RECORD_KEY} for its {INPUT_FILE}")
    unknown, missing = sorted(set(record) - _RECORD_FIELDS), sorted(_RECORD_FIELDS - set(record))
    if unknown or missing:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} record has unknown fields {unknown}, missing fields {missing}"
        )
    if record["path"] != INPUT_FILE:
        raise DataReleaseError(f"{name}: {RECORD_KEY} path {record['path']!r} is not {INPUT_FILE!r}")
    if record["schema"] != INPUT_CONTRACT:
        raise DataReleaseError(f"{name}: {RECORD_KEY} schema {record['schema']!r} is not {INPUT_CONTRACT!r}")
    if not isinstance(record["schema_sha256"], str) or not _SHA256.fullmatch(record["schema_sha256"]):
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} schema_sha256 {record['schema_sha256']!r} is not a digest"
        )
    if (record["sha256"], record["bytes"]) != (measured.sha256, measured.bytes):
        raise DataReleaseError(
            f"{name}: {INPUT_FILE} has sha256 {measured.sha256} ({measured.bytes} bytes), but its manifest "
            f"records sha256 {record['sha256']} ({record['bytes']} bytes)"
        )
    columns = record["columns"]
    if not isinstance(columns, list) or tuple(columns) != measured.columns:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} columns {columns!r} are not the file's {list(measured.columns)}"
        )
    if not set(COUNT_COLUMNS) <= set(measured.columns):
        raise DataReleaseError(f"{name}: {INPUT_FILE} must carry counts {list(COUNT_COLUMNS)} (design §7.1b)")
    n_observations = manifest.get("n_observations")
    if not (type(record["row_count"]) is int and record["row_count"] == measured.rows == n_observations):
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} row_count {record['row_count']!r}, file rows {measured.rows} and "
            f"n_observations {n_observations!r} must all agree"
        )
