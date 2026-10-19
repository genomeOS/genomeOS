"""The observation table a surface's fit consumed, as it travels with the artifact (#45; design §5, §7.1b).

An artifact is cited for its cells, but a cell can only be checked against the rows that produced
it. The 2026-09-16 HbS parity run pinned the sha256 of the 994 surveys it fit, yet no copy of them
survived, and they had to be rebuilt from a fresh vendor export a month later (#45). So
``fit_surface`` records the frame it consumed (``SurfaceFit.observations``), and publishing writes
exactly that frame beside the cells as ``observations.parquet``, with its identity in the artifact
manifest, which is written last.

Three properties are load-bearing:

1. **Exactly what the fit consumed.** The rows and columns ``fit_surface`` validated, in its row
   order. Nothing is reloaded or re-derived at publish time.
2. **Counts, not frequencies** (§7.1b). The table is ``OBSERVATIONS_SCHEMA``, which is strict:
   ``ac`` and ``an`` as integers and no other measurement column, so a frequency cannot travel in
   place of a count, and a zero out of 200 stays weak evidence rather than becoming a 0.
3. **Deterministic bytes.** The same frame in the same locked environment gives the same file, so
   the sha256 in the manifest identifies the table, not the moment it was written.

The release builder checks the same record without importing this module (it must not load the
surface stack); ``genomeos.publication.artifact_inputs`` holds its side of the contract.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import pandas as pd

from genomeos.observations.schema import OBSERVATIONS_SCHEMA

#: The input's name inside its artifact directory, beside ``cells.parquet``.
OBSERVATIONS_FILE = "observations.parquet"
#: The frozen contract that defines the table's types and checks (``scripts/freeze_contract.py``).
OBSERVATIONS_CONTRACT = "contract/observations.schema.json"

_SHA256 = re.compile(r"[0-9a-f]{64}")
_RECORD_FIELDS = frozenset(
    {"path", "sha256", "bytes", "row_count", "schema", "schema_sha256", "columns"}
)


def contract_sha256() -> str:
    """The sha256 of the contract file, serialized exactly as ``scripts/freeze_contract.py`` writes it."""
    text = json.dumps(json.loads(OBSERVATIONS_SCHEMA.to_json()), indent=2, sort_keys=True) + "\n"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


@dataclass(frozen=True)
class ObservationsRecord:
    """The identity of an artifact's input, as its manifest records it.

    Field names follow the serving catalog's ``ArtifactFile`` (path, sha256, row_count), plus the
    byte count the data store verifies and the exact contract revision the columns obey.
    """

    path: str
    sha256: str
    bytes: int
    row_count: int
    schema: str
    schema_sha256: str
    columns: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.path != OBSERVATIONS_FILE:
            raise ValueError(f"path must be {OBSERVATIONS_FILE!r}, not {self.path!r}")
        if not isinstance(self.sha256, str) or not _SHA256.fullmatch(self.sha256):
            raise ValueError(f"sha256 {self.sha256!r} is not a lowercase hex digest")
        if not _count(self.bytes):
            raise ValueError(f"bytes {self.bytes!r} is not a positive integer")
        if not _count(self.row_count):
            raise ValueError(
                f"row_count {self.row_count!r} is not a positive integer: an empty table fits nothing"
            )
        if self.schema != OBSERVATIONS_CONTRACT:
            raise ValueError(f"schema must be {OBSERVATIONS_CONTRACT!r}, not {self.schema!r}")
        if not isinstance(self.schema_sha256, str) or not _SHA256.fullmatch(self.schema_sha256):
            raise ValueError(f"schema_sha256 {self.schema_sha256!r} is not a lowercase hex digest")
        if tuple(self.columns) != tuple(OBSERVATIONS_SCHEMA.columns):
            raise ValueError(
                f"columns {list(self.columns)} are not the observation contract's "
                f"{list(OBSERVATIONS_SCHEMA.columns)}"
            )


def serialize_observations(observations: pd.DataFrame) -> tuple[bytes, ObservationsRecord]:
    """The parquet bytes of the table a fit consumed, and the record that identifies them.

    Validates against ``OBSERVATIONS_SCHEMA`` first, as ``fit_surface`` did, so a frequency column,
    a missing ``an`` or a fractional count is a hard error here too (§12). The index is dropped,
    as the fit drops it, so it can neither leak into the bytes nor change them.
    """
    frame = OBSERVATIONS_SCHEMA.validate(observations).reset_index(drop=True)
    if frame.empty:
        raise ValueError("row_count 0: an empty table is not the input of any fit")
    buffer = io.BytesIO()
    frame.to_parquet(buffer, engine="pyarrow", compression="snappy", index=False)
    payload = buffer.getvalue()
    return payload, ObservationsRecord(
        path=OBSERVATIONS_FILE,
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
        row_count=len(frame),
        schema=OBSERVATIONS_CONTRACT,
        schema_sha256=contract_sha256(),
        columns=tuple(str(column) for column in frame.columns),
    )


def observations_record(observations: pd.DataFrame) -> ObservationsRecord:
    """The manifest record for ``observations``; ``publish`` re-derives it and refuses a mismatch."""
    return serialize_observations(observations)[1]


def load_observations(payload: bytes, record: Mapping[str, Any], *, context: str) -> pd.DataFrame:
    """Parse an artifact's input, refusing bytes that are not the table its manifest records."""
    if not isinstance(record, Mapping):
        raise ValueError(f"{context}: the observations record is not a JSON object")
    unknown, missing = sorted(set(record) - _RECORD_FIELDS), sorted(_RECORD_FIELDS - set(record))
    if unknown or missing:
        raise ValueError(
            f"{context}: observations record has unknown fields {unknown}, missing fields {missing}"
        )
    expected = ObservationsRecord(**{**record, "columns": tuple(record["columns"])})
    digest = hashlib.sha256(payload).hexdigest()
    if (digest, len(payload)) != (expected.sha256, expected.bytes):
        raise ValueError(
            f"{context}: {OBSERVATIONS_FILE} has sha256 {digest} ({len(payload)} bytes), but the manifest "
            f"records {expected.sha256} ({expected.bytes} bytes)"
        )
    frame = pd.read_parquet(io.BytesIO(payload), engine="pyarrow")
    validated = OBSERVATIONS_SCHEMA.validate(frame)
    if len(validated) != expected.row_count or tuple(validated.columns) != expected.columns:
        raise ValueError(
            f"{context}: {OBSERVATIONS_FILE} does not have the rows and columns its record states"
        )
    return validated
