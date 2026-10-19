"""The observation table a fit consumed, serialized to travel with its artifact (#45; §5, §7.1b).

The properties tested here are the ones the table exists for: the bytes are deterministic, so the
sha256 in a manifest identifies the table rather than the moment it was written; the table is
counts, never frequencies; a carrier table is never labelled as allele counts (#133); and a reader
refuses a file that is not the one its record names.
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

from genomeos.observations.schema import CARRIER_OBSERVATIONS_SCHEMA, OBSERVATIONS_SCHEMA
from genomeos.observations.sources import afnd_carriers
from genomeos.surfaces.artifacts import MEASUREMENTS
from genomeos.surfaces.fit_input import (
    CARRIER_OBSERVATIONS_CONTRACT,
    INPUT_CONTRACTS,
    OBSERVATIONS_CONTRACT,
    OBSERVATIONS_FILE,
    ObservationsRecord,
    contract_sha256,
    load_observations,
    observations_record,
    serialize_observations,
)
from tests.observation_fixtures import kir_fit_rows, observation_rows

ROOT = Path(__file__).resolve().parents[1]
ALLELE = "allele_frequency"
CARRIER = "carrier_frequency"


def test_the_record_identifies_the_bytes_and_their_contract() -> None:
    frame = observation_rows()
    payload, record = serialize_observations(frame, measurement=ALLELE)
    assert record.path == OBSERVATIONS_FILE == "observations.parquet"
    assert record.sha256 == hashlib.sha256(payload).hexdigest()
    assert record.bytes == len(payload)
    assert record.row_count == len(frame)
    assert record.measurement == ALLELE
    assert record.columns == tuple(OBSERVATIONS_SCHEMA.columns)
    assert record.schema == OBSERVATIONS_CONTRACT == "contract/observations.schema.json"
    assert record.schema_sha256 == contract_sha256(ALLELE)
    assert observations_record(frame, measurement=ALLELE) == record


def test_every_artifact_measurement_has_an_input_contract() -> None:
    assert tuple(INPUT_CONTRACTS) == MEASUREMENTS


@pytest.mark.parametrize("measurement", MEASUREMENTS)
def test_the_record_pins_the_committed_frozen_contract(measurement: str) -> None:
    """`schema_sha256` is the sha256 of the contract file at the commit that wrote the artifact."""
    committed = (ROOT / INPUT_CONTRACTS[measurement].path).read_bytes()
    assert contract_sha256(measurement) == hashlib.sha256(committed).hexdigest()


def test_serialization_is_byte_deterministic_across_processes() -> None:
    """Same table, same locked environment, same bytes, whatever the hash seed or the clock."""
    script = (
        "import hashlib\n"
        "from tests.observation_fixtures import observation_rows\n"
        "from genomeos.surfaces.fit_input import serialize_observations\n"
        "payload, _ = serialize_observations(observation_rows(), measurement='allele_frequency')\n"
        "print(hashlib.sha256(payload).hexdigest())\n"
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
    assert digests == {serialize_observations(observation_rows(), measurement=ALLELE)[1].sha256}


def test_row_order_is_the_fits_and_the_index_does_not_leak_into_the_bytes() -> None:
    frame = observation_rows()
    shuffled_index = frame.set_axis([10, 3, 7, 1, 0, 5])
    assert (
        serialize_observations(shuffled_index, measurement=ALLELE)[0]
        == serialize_observations(frame, measurement=ALLELE)[0]
    )
    reordered = frame.iloc[::-1]
    assert (
        serialize_observations(reordered, measurement=ALLELE)[1].sha256
        != serialize_observations(frame, measurement=ALLELE)[1].sha256
    )


def test_the_table_round_trips_exactly() -> None:
    frame = observation_rows()
    payload, record = serialize_observations(frame, measurement=ALLELE)
    loaded = load_observations(payload, _as_json(record), context="fixture")
    pd.testing.assert_frame_equal(loaded, frame.reset_index(drop=True))
    assert pd.read_parquet(io.BytesIO(payload))["an"].tolist() == frame["an"].tolist()


def test_the_measurement_is_required() -> None:
    """Which quantity `ac`/`an` count is never assumed: a caller that cannot say is not ready (#133)."""
    with pytest.raises(TypeError, match="measurement"):
        serialize_observations(observation_rows())  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="measurement"):
        serialize_observations(observation_rows(), measurement="phenotype_frequency")


# --- a carrier table is never published as allele counts (#133) ---


def test_a_carrier_input_is_published_under_the_carrier_contract_with_its_own_columns() -> None:
    """A KIR fit read `ac`/`an` only because `as_binomial` renamed them; on disk they are people."""
    consumed = kir_fit_rows()
    payload, record = serialize_observations(consumed, measurement=CARRIER)
    assert record.measurement == CARRIER
    assert record.schema == CARRIER_OBSERVATIONS_CONTRACT == "contract/carrier_observations.schema.json"
    assert record.schema_sha256 == contract_sha256(CARRIER)
    assert record.columns == tuple(CARRIER_OBSERVATIONS_SCHEMA.columns)
    on_disk = pd.read_parquet(io.BytesIO(payload))
    assert {"carriers", "n_individuals"} <= set(on_disk.columns)
    assert not {"ac", "an"} & set(on_disk.columns)
    assert on_disk["n_individuals"].tolist() == consumed["an"].tolist()


def test_a_carrier_input_is_exactly_the_fits_rows_under_their_own_names() -> None:
    """`as_binomial` is a pure rename, so applying it to the published table recovers the fit's frame."""
    consumed = kir_fit_rows()
    payload, record = serialize_observations(consumed, measurement=CARRIER)
    loaded = load_observations(payload, _as_json(record), context="fixture")
    CARRIER_OBSERVATIONS_SCHEMA.validate(loaded)
    pd.testing.assert_frame_equal(
        OBSERVATIONS_SCHEMA.validate(afnd_carriers.as_binomial(loaded)), consumed.reset_index(drop=True)
    )


def test_a_record_cannot_pair_a_measurement_with_another_measurements_contract() -> None:
    _, allele = serialize_observations(observation_rows(), measurement=ALLELE)
    _, carrier = serialize_observations(kir_fit_rows(), measurement=CARRIER)
    with pytest.raises(ValueError, match="schema"):
        replace(allele, measurement=CARRIER)
    with pytest.raises(ValueError, match="schema"):
        replace(carrier, schema=OBSERVATIONS_CONTRACT)
    with pytest.raises(ValueError, match="columns"):
        replace(carrier, columns=allele.columns)


# --- counts, not frequencies (§7.1b) ---


def test_a_frequency_never_travels_in_place_of_counts() -> None:
    """§7.1b: the table is `ac` and `an`. A frequency column, or a table missing `an`, is refused."""
    schema_errors = (pandera.errors.SchemaError, pandera.errors.SchemaErrors)
    with pytest.raises(schema_errors, match="frequency"):
        serialize_observations(observation_rows().assign(frequency=0.1), measurement=ALLELE)
    with pytest.raises(schema_errors, match="an"):
        serialize_observations(observation_rows().drop(columns=["an"]), measurement=ALLELE)


@pytest.mark.parametrize("dtype", ["float64", "float32", "Float64", "Float32"])
@pytest.mark.parametrize("column", ["ac", "an", "date_upper"])
def test_a_fractional_count_is_refused_whatever_its_float_dtype(dtype: str, column: str) -> None:
    """`OBSERVATIONS_SCHEMA` truncates a pandas Float64 200.5 to 200 unremarked; this guard does not."""
    rows = observation_rows()
    fractional = rows.assign(**{column: rows[column].astype(dtype) + 0.5})
    with pytest.raises(ValueError, match=f"{column}.*fractional"):
        serialize_observations(fractional, measurement=ALLELE)


@pytest.mark.parametrize("dtype", ["float64", "Float64"])
def test_an_integral_float_count_is_still_a_count(dtype: str) -> None:
    """Adapters computing `2 * n` in floating point produce 200.0, which the contract accepts (#192)."""
    rows = observation_rows()
    _, record = serialize_observations(rows.assign(an=rows["an"].astype(dtype)), measurement=ALLELE)
    assert record == observations_record(rows, measurement=ALLELE)


def test_an_empty_table_is_not_an_input() -> None:
    with pytest.raises(ValueError, match="row_count"):
        serialize_observations(observation_rows().iloc[:0], measurement=ALLELE)


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("path", "inputs.parquet", "path"),
        ("sha256", "abc", "sha256"),
        ("bytes", 0, "bytes"),
        ("bytes", True, "bytes"),
        ("row_count", 2.0, "row_count"),
        ("measurement", "phenotype_frequency", "measurement"),
        ("schema", "contract/carrier_observations.schema.json", "schema"),
        ("schema_sha256", "0" * 63, "schema_sha256"),
        ("columns", ("variant_id", "ac", "an"), "columns"),
    ],
)
def test_a_malformed_record_is_refused(field: str, value: object, match: str) -> None:
    _, record = serialize_observations(observation_rows(), measurement=ALLELE)
    with pytest.raises(ValueError, match=match):
        replace(record, **{field: value})


def test_a_reader_refuses_bytes_that_are_not_the_recorded_table() -> None:
    payload, record = serialize_observations(observation_rows(), measurement=ALLELE)
    other, _ = serialize_observations(observation_rows(5), measurement=ALLELE)
    with pytest.raises(ValueError, match="sha256"):
        load_observations(other, _as_json(record), context="fixture")
    with pytest.raises(ValueError, match="unknown fields"):
        load_observations(payload, {**_as_json(record), "frequency": 0.1}, context="fixture")
    with pytest.raises(ValueError, match="missing fields"):
        load_observations(payload, {k: v for k, v in _as_json(record).items() if k != "sha256"}, context="x")


def _as_json(record: ObservationsRecord) -> dict:
    """The record as a manifest stores it: a JSON object, `columns` a list."""
    return {**record.__dict__, "columns": list(record.columns)}
