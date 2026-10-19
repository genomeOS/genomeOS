"""The observation table a fit consumed, serialized to travel with its artifact (#45; §5, §7.1b).

The properties tested here are the ones the table exists for: the bytes are deterministic, so the
sha256 in a manifest identifies the table rather than the moment it was written; the table is
counts, never frequencies; and a reader refuses a file that is not the one its record names.
"""

from __future__ import annotations

import hashlib
import io
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pandas as pd
import pandera.errors
import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.surfaces.fit_input import (
    OBSERVATIONS_CONTRACT,
    OBSERVATIONS_FILE,
    ObservationsRecord,
    contract_sha256,
    load_observations,
    observations_record,
    serialize_observations,
)
from tests.observation_fixtures import observation_rows

ROOT = Path(__file__).resolve().parents[1]


def test_the_record_identifies_the_bytes_and_their_contract() -> None:
    frame = observation_rows()
    payload, record = serialize_observations(frame)
    assert record.path == OBSERVATIONS_FILE == "observations.parquet"
    assert record.sha256 == hashlib.sha256(payload).hexdigest()
    assert record.bytes == len(payload)
    assert record.row_count == len(frame)
    assert record.columns == tuple(OBSERVATIONS_SCHEMA.columns)
    assert record.schema == OBSERVATIONS_CONTRACT == "contract/observations.schema.json"
    assert record.schema_sha256 == contract_sha256()
    assert observations_record(frame) == record


def test_the_record_pins_the_committed_frozen_contract() -> None:
    """`schema_sha256` is the sha256 of the contract file at the commit that wrote the artifact."""
    committed = (ROOT / OBSERVATIONS_CONTRACT).read_bytes()
    assert contract_sha256() == hashlib.sha256(committed).hexdigest()


def test_serialization_is_byte_deterministic_across_processes() -> None:
    """Same table, same locked environment, same bytes, whatever the hash seed or the clock."""
    script = (
        "import hashlib\n"
        "from tests.observation_fixtures import observation_rows\n"
        "from genomeos.surfaces.fit_input import serialize_observations\n"
        "print(hashlib.sha256(serialize_observations(observation_rows())[0]).hexdigest())\n"
    )
    digests = {
        subprocess.run(
            [sys.executable, "-c", script],
            cwd=ROOT,
            env={**os.environ, "PYTHONHASHSEED": seed},
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        for seed in ("0", "1", "4242")
    }
    assert digests == {serialize_observations(observation_rows())[1].sha256}


def test_row_order_is_the_fits_and_the_index_does_not_leak_into_the_bytes() -> None:
    frame = observation_rows()
    shuffled_index = frame.set_axis([10, 3, 7, 1, 0, 5])
    assert serialize_observations(shuffled_index)[0] == serialize_observations(frame)[0]
    reordered = frame.iloc[::-1]
    assert serialize_observations(reordered)[1].sha256 != serialize_observations(frame)[1].sha256


def test_the_table_round_trips_exactly() -> None:
    frame = observation_rows()
    payload, record = serialize_observations(frame)
    loaded = load_observations(payload, _as_json(record), context="fixture")
    pd.testing.assert_frame_equal(loaded, frame.reset_index(drop=True))
    assert pd.read_parquet(io.BytesIO(payload))["an"].tolist() == frame["an"].tolist()


def test_a_frequency_never_travels_in_place_of_counts() -> None:
    """§7.1b: the table is `ac` and `an`. A frequency column, or a table missing `an`, is refused."""
    schema_errors = (pandera.errors.SchemaError, pandera.errors.SchemaErrors)
    with pytest.raises(schema_errors, match="frequency"):
        serialize_observations(observation_rows().assign(frequency=0.1))
    with pytest.raises(schema_errors, match="an"):
        serialize_observations(observation_rows().drop(columns=["an"]))
    with pytest.raises(schema_errors):
        serialize_observations(observation_rows().assign(an=observation_rows()["an"].astype(float) + 0.5))


def test_an_empty_table_is_not_an_input() -> None:
    with pytest.raises(ValueError, match="row_count"):
        serialize_observations(observation_rows().iloc[:0])


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("path", "inputs.parquet", "path"),
        ("sha256", "abc", "sha256"),
        ("bytes", 0, "bytes"),
        ("bytes", True, "bytes"),
        ("row_count", 2.0, "row_count"),
        ("schema", "contract/carrier_observations.schema.json", "schema"),
        ("schema_sha256", "0" * 63, "schema_sha256"),
        ("columns", ("variant_id", "ac", "an"), "columns"),
    ],
)
def test_a_malformed_record_is_refused(field: str, value: object, match: str) -> None:
    _, record = serialize_observations(observation_rows())
    with pytest.raises(ValueError, match=match):
        replace(record, **{field: value})


def test_a_reader_refuses_bytes_that_are_not_the_recorded_table() -> None:
    payload, record = serialize_observations(observation_rows())
    other, _ = serialize_observations(observation_rows(5))
    with pytest.raises(ValueError, match="sha256"):
        load_observations(other, _as_json(record), context="fixture")
    with pytest.raises(ValueError, match="unknown fields"):
        load_observations(payload, {**_as_json(record), "frequency": 0.1}, context="fixture")
    with pytest.raises(ValueError, match="missing fields"):
        load_observations(payload, {k: v for k, v in _as_json(record).items() if k != "sha256"}, context="x")


def _as_json(record: ObservationsRecord) -> dict:
    """The record as a manifest stores it: a JSON object, `columns` a list."""
    return {**record.__dict__, "columns": list(record.columns)}
