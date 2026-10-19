"""The observation table a surface's fit consumed, as it travels with the artifact (#45; design §5, §7.1b).

An artifact is cited for its cells, but a cell can only be checked against the rows that produced
it. The 2026-09-16 HbS parity run pinned the sha256 of the 994 surveys it fit, yet no copy of them
survived, and they had to be rebuilt from a fresh vendor export a month later (#45). So
``fit_surface`` records the frame it consumed (``SurfaceFit.observations``), and publishing writes
exactly that frame beside the cells as ``observations.parquet``, with its identity in the artifact
manifest, which is written last.

Four properties are load-bearing:

1. **Exactly what the fit consumed.** The rows and columns ``fit_surface`` validated, in its row
   order. Nothing is reloaded or re-derived at publish time.
2. **Counts, not frequencies** (§7.1b). Each table is a strict frozen contract: integer counts and
   no other measurement column, so a frequency cannot travel in place of a count, and a zero out of
   200 stays weak evidence rather than becoming a 0.
3. **The measurement names its own columns** (#133). A fit reads ``ac``/``an`` whatever they count,
   because the binomial GP is the same over chromosomes and over people. A KIR fit's rows are
   carriers over individuals that ``afnd_carriers.as_binomial`` renamed to ``ac``/``an``, and a
   published table must never make its reader infer which of the two it holds. So a
   ``carrier_frequency`` input is written under ``contract/carrier_observations.schema.json``, with
   its columns named back to ``carriers``/``n_individuals``. ``as_binomial`` is a pure rename, so
   the rows are still exactly the fit's: applying it to the published table recovers the frame.
4. **Deterministic bytes.** The same frame in the same locked environment gives the same file, so
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
from types import MappingProxyType
from typing import Any

import numpy as np
import pandas as pd
import pandera.pandas as pa
from pandas.api.types import is_float_dtype

from genomeos.observations.schema import CARRIER_OBSERVATIONS_SCHEMA, OBSERVATIONS_SCHEMA

#: The input's name inside its artifact directory, beside ``cells.parquet``.
OBSERVATIONS_FILE = "observations.parquet"
#: The frozen contracts that define each table's types and checks (``scripts/freeze_contract.py``).
OBSERVATIONS_CONTRACT = "contract/observations.schema.json"
CARRIER_OBSERVATIONS_CONTRACT = "contract/carrier_observations.schema.json"
#: What every fit calls its numerator and denominator, whatever they count.
FIT_COUNTS = ("ac", "an")


@dataclass(frozen=True)
class InputContract:
    """How one measurement's input is written: its frozen contract, and its names for ``ac``/``an``."""

    path: str
    schema: pa.DataFrameSchema
    counts: tuple[str, str]


#: One contract per artifact measurement (``surfaces.artifacts.MEASUREMENTS``), in the same order.
INPUT_CONTRACTS: Mapping[str, InputContract] = MappingProxyType(
    {
        "allele_frequency": InputContract(OBSERVATIONS_CONTRACT, OBSERVATIONS_SCHEMA, FIT_COUNTS),
        "carrier_frequency": InputContract(
            CARRIER_OBSERVATIONS_CONTRACT, CARRIER_OBSERVATIONS_SCHEMA, ("carriers", "n_individuals")
        ),
    }
)

_SHA256 = re.compile(r"[0-9a-f]{64}")
_RECORD_FIELDS = frozenset(
    {"path", "sha256", "bytes", "row_count", "measurement", "schema", "schema_sha256", "columns"}
)
#: The fit's integer columns: counts and date bounds.
_INTEGER_COLUMNS = tuple(
    name for name, column in OBSERVATIONS_SCHEMA.columns.items() if str(column.dtype) == "Int64"
)


def _contract(measurement: object) -> InputContract:
    if not isinstance(measurement, str) or measurement not in INPUT_CONTRACTS:
        raise ValueError(
            f"measurement {measurement!r} has no input contract; expected one of {list(INPUT_CONTRACTS)}"
        )
    return INPUT_CONTRACTS[measurement]


def contract_sha256(measurement: str) -> str:
    """The sha256 of a measurement's contract file, serialized as ``scripts/freeze_contract.py`` writes it."""
    schema = _contract(measurement).schema
    text = json.dumps(json.loads(schema.to_json()), indent=2, sort_keys=True) + "\n"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


@dataclass(frozen=True)
class ObservationsRecord:
    """The identity of an artifact's input, as its manifest records it.

    Field names follow the serving catalog's ``ArtifactFile`` (path, sha256, row_count), plus the
    byte count the data store verifies, the measurement the counts are of, and the exact contract
    revision the columns obey.
    """

    path: str
    sha256: str
    bytes: int
    row_count: int
    measurement: str
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
        contract = _contract(self.measurement)
        if self.schema != contract.path:
            raise ValueError(
                f"schema must be {contract.path!r} for a {self.measurement} input, not {self.schema!r}"
            )
        if not isinstance(self.schema_sha256, str) or not _SHA256.fullmatch(self.schema_sha256):
            raise ValueError(f"schema_sha256 {self.schema_sha256!r} is not a lowercase hex digest")
        if tuple(self.columns) != tuple(contract.schema.columns):
            raise ValueError(
                f"columns {list(self.columns)} are not the {self.measurement} contract's "
                f"{list(contract.schema.columns)}"
            )


def _refuse_fractional_counts(observations: pd.DataFrame) -> None:
    """A fraction of a count is a hard error (§12), in whichever float dtype it arrives.

    ``OBSERVATIONS_SCHEMA`` refuses a numpy float64 200.5 but casts a pandas ``Float64`` or
    ``Float32`` 200.5 to ``Int64`` 200 without complaint (a #192 regression in the schema itself), so
    this module cannot rely on it alone. An integral float such as 200.0 is still a count.
    """
    for column in _INTEGER_COLUMNS:
        if column not in observations.columns or not is_float_dtype(observations[column].dtype):
            continue
        values = observations[column].to_numpy(dtype=np.float64, na_value=np.nan)
        finite = values[np.isfinite(values)]
        if (finite != np.floor(finite)).any():
            raise ValueError(f"{column} holds a fractional value, so it is not a count (§7.1b, §12)")


def serialize_observations(
    observations: pd.DataFrame, *, measurement: str
) -> tuple[bytes, ObservationsRecord]:
    """The parquet bytes of the table a fit consumed, and the record that identifies them.

    ``observations`` is the fit's frame, in its ``ac``/``an`` shape; ``measurement`` is what those
    counts are of, and has no default (#133). The frame is validated against
    ``OBSERVATIONS_SCHEMA`` first, as ``fit_surface`` did, so a frequency column, a missing ``an``
    or a fractional count (in any float dtype) is a hard error here too (§12). It is then written
    under its measurement's contract: a ``carrier_frequency`` table as ``carriers`` and
    ``n_individuals``, validated with ``CARRIER_OBSERVATIONS_SCHEMA``. The index is dropped, as the
    fit drops it, so it can neither leak into the bytes nor change them.
    """
    contract = _contract(measurement)
    _refuse_fractional_counts(observations)
    consumed = OBSERVATIONS_SCHEMA.validate(observations).reset_index(drop=True)
    if consumed.empty:
        raise ValueError("row_count 0: an empty table is not the input of any fit")
    names = dict(zip(FIT_COUNTS, contract.counts, strict=True))
    frame = contract.schema.validate(consumed.rename(columns=names))
    buffer = io.BytesIO()
    frame.to_parquet(buffer, engine="pyarrow", compression="snappy", index=False)
    payload = buffer.getvalue()
    return payload, ObservationsRecord(
        path=OBSERVATIONS_FILE,
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
        row_count=len(frame),
        measurement=measurement,
        schema=contract.path,
        schema_sha256=contract_sha256(measurement),
        columns=tuple(str(column) for column in frame.columns),
    )


def observations_record(observations: pd.DataFrame, *, measurement: str) -> ObservationsRecord:
    """The manifest record for ``observations``; ``publish`` re-derives it and refuses a mismatch."""
    return serialize_observations(observations, measurement=measurement)[1]


def load_observations(payload: bytes, record: Mapping[str, Any], *, context: str) -> pd.DataFrame:
    """Parse an artifact's input, refusing bytes that are not the table its manifest records.

    Returns the table as published, under its own contract's column names: a ``carrier_frequency``
    input comes back as ``carriers``/``n_individuals``, and ``afnd_carriers.as_binomial`` turns it
    back into the fit's frame.
    """
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
    validated = INPUT_CONTRACTS[expected.measurement].schema.validate(frame)
    if len(validated) != expected.row_count or tuple(validated.columns) != expected.columns:
        raise ValueError(
            f"{context}: {OBSERVATIONS_FILE} does not have the rows and columns its record states"
        )
    return validated
