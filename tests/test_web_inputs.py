"""An artifact's fit input at the web publication boundary (#45; data store design §5)."""

from __future__ import annotations

import pytest

from genomeos.publication import web_inputs
from tests.observation_fixtures import observation_rows

COLUMNS = ("ac", "an", "lat", "lon", "cohort_id", "disease_ascertainment_excluded", "source_record_id")


def test_rows_equal_by_value_are_the_consumed_rows_whatever_their_dtypes() -> None:
    """An `Int64` count read back from parquet is the same count an adapter reloads as `int64`, and
    the index, which neither table means anything by, is not compared."""
    consumed = observation_rows()
    reloaded = consumed.astype({"ac": "int64", "an": "int64", "cohort_id": object}).set_axis(range(10, 16))
    web_inputs.require_consumed_rows(consumed, reloaded, columns=COLUMNS, context="hbs")


def test_rows_that_differ_are_refused_by_name_even_when_as_many() -> None:
    consumed = observation_rows()
    reloaded = consumed.assign(an=consumed["an"] + 1, cohort_id="cohort-9")
    with pytest.raises(ValueError, match=r"hbs: .* differ in \['an', 'cohort_id'\]"):
        web_inputs.require_consumed_rows(consumed, reloaded, columns=COLUMNS, context="hbs")


def test_a_different_number_of_rows_is_refused() -> None:
    consumed = observation_rows()
    with pytest.raises(ValueError, match="5 reloaded observations, but its fit consumed 6"):
        web_inputs.require_consumed_rows(consumed, consumed.iloc[:5], columns=COLUMNS, context="hbs")


def test_a_column_the_web_json_needs_must_be_in_both_tables() -> None:
    consumed = observation_rows()
    with pytest.raises(ValueError, match=r"differ in \['cohort_id'\]"):
        web_inputs.require_consumed_rows(
            consumed, consumed.drop(columns="cohort_id"), columns=COLUMNS, context="hbs"
        )


def test_the_web_manifest_drops_only_the_data_store_path() -> None:
    record = {
        "path": "observations.parquet",
        "sha256": "0" * 64,
        "bytes": 1234,
        "row_count": 6,
        "measurement": "allele_frequency",
        "schema": "contract/observations.schema.json",
        "schema_sha256": "1" * 64,
        "columns": ["variant_id"],
    }
    manifest = {"n_observations": 6, "observations": record}
    served = web_inputs.web_manifest(manifest)
    assert served == {"n_observations": 6, "observations": {k: v for k, v in record.items() if k != "path"}}
    assert manifest["observations"]["path"] == "observations.parquet"  # the source is not mutated


def test_a_manifest_without_an_input_record_is_served_unchanged() -> None:
    manifest = {"artifact_format": 1, "n_observations": 1}
    assert web_inputs.web_manifest(manifest) == manifest

