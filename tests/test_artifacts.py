"""Immutable per-cell surface artifacts (design §5, §6).

Three properties carry the design's weight and are tested directly: an artifact **cannot be
silently overwritten**, the **support mask travels with the numbers**, and the **fit's input
travels with its output** (#45). Everything else about the format is convenience; those three are
what make a published surface citable, honest and checkable.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.observations.sources import afnd_carriers
from genomeos.surfaces.artifacts import (
    ARTIFACT_COLUMNS,
    ARTIFACT_FORMAT,
    ArtifactManifest,
    cell_table,
    publish,
    read,
    read_observations,
)
from genomeos.surfaces.fit_input import (
    OBSERVATIONS_FILE,
    observations_record,
    serialize_observations,
)
from genomeos.surfaces.prior import PRIOR_DRAWS, PRIOR_NORMALIZATION
from tests.observation_fixtures import kir_fit_rows, observation_rows

HBS = "chr11-5227002-T-A"


def _frame(n: int = 5, variant_id: str = "chr11-5227002-T-A") -> pd.DataFrame:
    rng = np.random.default_rng(42)
    post_sd = rng.uniform(0.001, 0.05, n)
    prior_sd = rng.uniform(0.06, 0.2, n)
    return pd.DataFrame(
        {
            "h3_index": [f"83{i:04x}fffffffff" for i in range(n)],
            "variant_id": variant_id,
            "post_median": rng.uniform(0, 0.2, n),
            "post_mean": rng.uniform(0, 0.2, n),
            "post_sd": post_sd,
            "prior_frequency_sd": prior_sd,
            "q025": 0.0,
            "q975": 0.3,
            "q25": 0.01,
            "q75": 0.1,
            "support": ["observed", "interpolated", "unknown", "prior_dominated", "observed"][:n],
            "posterior_contraction": post_sd / prior_sd,
            "dist_nearest_obs_km": rng.uniform(0, 3000, n),
            "model_version": "v1",
            "data_version": "map-2026-08",
        },
        columns=list(ARTIFACT_COLUMNS),
    )


def _measurement(variant_id: str) -> str:
    """As the publisher decides it: KIR presence is carrier frequency over individuals (#133)."""
    return "carrier_frequency" if variant_id.startswith("kir:") else "allele_frequency"


def _observations(variant_id: str = HBS) -> pd.DataFrame:
    """The table the fit consumed: what an artifact publishes beside its cells (#45)."""
    if _measurement(variant_id) == "carrier_frequency":
        return kir_fit_rows(variant_id=variant_id)
    return observation_rows(variant_id=variant_id)


def _manifest(variant_id: str = HBS, model_version: str = "v1") -> ArtifactManifest:
    return ArtifactManifest(
        variant_id=variant_id,
        model_version=model_version,
        data_version="map-2026-08",
        resolution=3,
        n_cells=5,
        correlation_range_km=680.0,
        prior_normalization=PRIOR_NORMALIZATION,
        prior_draws=PRIOR_DRAWS,
        prior_seed=42,
        likelihood="beta_binomial",
        lengthscale_sigma=0.7,
        n_observations=6,
        support_counts={"observed": 2},
        target_grid_source="worldpop-1km-unconstrained",
        target_grid_version="fixture-2020",
        measurement=_measurement(variant_id),
        observations=observations_record(_observations(variant_id), measurement=_measurement(variant_id)),
    )


def test_publishing_twice_is_refused_because_artifacts_are_immutable(tmp_path):
    """§5: a model change publishes new artifacts and never mutates a map someone has cited.

    A silent overwrite is exactly the failure that guarantee exists to prevent, so the second
    write must raise rather than succeed quietly.
    """
    publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    with pytest.raises(FileExistsError, match="immutable"):
        publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())


def test_a_new_model_version_publishes_alongside_rather_than_replacing(tmp_path):
    """The key is `(variant_id, model_version, data_version)`, so a refit coexists with what it
    supersedes and an older citation keeps resolving."""
    first = publish(_frame(), tmp_path, manifest=_manifest(model_version="v1"), observations=_observations())
    second = publish(_frame(), tmp_path, manifest=_manifest(model_version="v2"), observations=_observations())
    assert first != second
    assert first.exists() and second.exists()


def test_the_support_mask_travels_with_the_numbers(tmp_path):
    """§4's defence against a persuasive-but-unfounded cline is that a consumer can tell measured
    from inferred. An artifact of values without `support` strips the column that makes it honest.
    """
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    frame, _ = read(directory)
    assert "support" in frame.columns
    assert "posterior_contraction" in frame.columns
    # The distance is carried too, so a consumer can apply a stricter threshold without refitting.
    assert "dist_nearest_obs_km" in frame.columns
    assert frame["support"].notna().all()


def test_the_manifest_records_what_would_otherwise_be_unrecoverable(tmp_path):
    """A number is not citable without the assumptions behind it. The likelihood and the
    lengthscale prior in particular are per-variant choices (#116) that cannot be recovered from
    the cell values alone."""
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    _, manifest = read(directory)
    assert manifest["likelihood"] == "beta_binomial"
    assert manifest["lengthscale_sigma"] == 0.7
    assert manifest["correlation_range_km"] == 680.0
    assert manifest["n_observations"] == 6
    assert manifest["target_grid_source"] == "worldpop-1km-unconstrained"
    assert manifest["target_grid_version"] == "fixture-2020"
    assert manifest["artifact_format"] == ARTIFACT_FORMAT
    assert manifest["prior_normalization"] == PRIOR_NORMALIZATION
    assert manifest["prior_draws"] == PRIOR_DRAWS
    assert manifest["prior_seed"] == 42


def test_a_frozen_format_one_artifact_remains_readable_without_invented_grid_provenance(
    tmp_path,
):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    payload["artifact_format"] = 1
    del payload["prior_normalization"]
    del payload["prior_draws"]
    del payload["prior_seed"]
    del payload["target_grid_source"]
    del payload["target_grid_version"]
    path.write_text(json.dumps(payload))

    legacy_frame = pd.read_parquet(directory / "cells.parquet").drop(columns="prior_frequency_sd")
    legacy_frame.to_parquet(directory / "cells.parquet", index=False)
    before = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in directory.iterdir()
    }
    frame, manifest = read(directory)
    after = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in directory.iterdir()
    }
    assert manifest["artifact_format"] == 1
    assert "prior_frequency_sd" not in frame
    assert "target_grid_source" not in manifest
    assert "target_grid_version" not in manifest
    assert after == before


def test_a_frozen_format_two_artifact_remains_readable_without_invented_local_prior(tmp_path):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    manifest_path = directory / "manifest.json"
    payload = json.loads(manifest_path.read_text())
    payload["artifact_format"] = 2
    payload["prior_frequency_sd"] = 0.119
    for field in ("prior_normalization", "prior_draws", "prior_seed"):
        del payload[field]
    manifest_path.write_text(json.dumps(payload))
    legacy = pd.read_parquet(directory / "cells.parquet").drop(columns="prior_frequency_sd")
    legacy.to_parquet(directory / "cells.parquet", index=False)
    before = hashlib.sha256((directory / "cells.parquet").read_bytes()).hexdigest()
    frame, loaded = read(directory)
    assert loaded["artifact_format"] == 2
    assert "prior_frequency_sd" not in frame
    assert hashlib.sha256((directory / "cells.parquet").read_bytes()).hexdigest() == before


def test_format_two_still_requires_target_grid_provenance(tmp_path):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    payload["artifact_format"] = 2
    del payload["target_grid_source"]
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="target_grid_source"):
        read(directory)


@pytest.mark.parametrize("field", ["prior_normalization", "prior_draws", "prior_seed"])
def test_format_three_requires_every_prior_protocol_field(tmp_path, field):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    del payload[field]
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match=field):
        read(directory)


def test_an_artifact_from_an_unknown_format_is_refused_not_misread(tmp_path):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    payload["artifact_format"] = 999
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="artifact_format"):
        read(directory)


@pytest.mark.parametrize("bad_format", [True, 2.0, 3.0, "3", 2.9])
def test_artifact_read_refuses_noninteger_or_boolean_format(tmp_path, bad_format):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    payload["artifact_format"] = bad_format
    path.write_text(json.dumps(payload))

    with pytest.raises(ValueError, match="artifact_format"):
        read(directory)


def test_a_phenotype_composite_round_trips(tmp_path):
    """`phenotype:g6pd-deficiency` contains a colon, which is not a safe path component
    everywhere; the directory name must be sanitised without losing the id in the data."""
    variant = "phenotype:g6pd-deficiency"
    directory = publish(
        _frame(variant_id=variant),
        tmp_path,
        manifest=_manifest(variant_id=variant),
        observations=_observations(variant),
    )
    assert ":" not in directory.name
    frame, manifest = read(directory)
    assert set(frame["variant_id"]) == {variant}
    assert manifest["variant_id"] == variant


def test_a_manifest_must_say_which_quantity_it_holds():
    """An artifact of carrier frequencies over individuals and one of allele frequencies over
    chromosomes are indistinguishable by inspection, and a consumer averaging across both is
    wrong in a way nothing downstream can detect (#133). So the field is required and checked."""
    with pytest.raises(ValueError, match="unknown measurement"):
        ArtifactManifest(
            variant_id="kir:2dl1",
            model_version="v2",
            data_version="afnd-2026-08",
            resolution=3,
            n_cells=1,
            correlation_range_km=1000.0,
            prior_normalization=PRIOR_NORMALIZATION,
            prior_draws=PRIOR_DRAWS,
            prior_seed=42,
            likelihood="beta_binomial",
            lengthscale_sigma=0.7,
            n_observations=6,
            support_counts={},
            target_grid_source="worldpop-1km-unconstrained",
            target_grid_version="fixture-2020",
            measurement="whatever",
            observations=observations_record(_observations("kir:2dl1"), measurement="carrier_frequency"),
        )


@pytest.mark.parametrize("field", ["target_grid_source", "target_grid_version"])
def test_a_new_manifest_refuses_blank_target_grid_provenance(field):
    values = {
        "variant_id": "chr11-5227002-T-A",
        "model_version": "v2",
        "data_version": "map-2026-08",
        "resolution": 3,
        "n_cells": 1,
        "correlation_range_km": 680.0,
        "prior_normalization": PRIOR_NORMALIZATION,
        "prior_draws": PRIOR_DRAWS,
        "prior_seed": 42,
        "likelihood": "beta_binomial",
        "lengthscale_sigma": 0.7,
        "n_observations": 6,
        "support_counts": {"observed": 1},
        "target_grid_source": "worldpop-1km-unconstrained",
        "target_grid_version": "fixture-2020",
        "measurement": "allele_frequency",
        "observations": observations_record(_observations(), measurement="allele_frequency"),
    }
    values[field] = ""
    with pytest.raises(ValueError, match=field):
        ArtifactManifest(**values)


@pytest.mark.parametrize(
    "field,value,match",
    [
        ("artifact_format", 2, "artifact_format"),
        ("prior_normalization", "scalar", "prior_normalization"),
        ("prior_draws", 499, "prior_draws"),
        ("prior_draws", 500.0, "prior_draws"),
        ("prior_seed", -1, "prior_seed"),
        ("prior_seed", True, "prior_seed"),
    ],
)
def test_new_manifest_refuses_wrong_prior_protocol(field, value, match):
    values = _manifest().__dict__.copy()
    values[field] = value
    with pytest.raises(ValueError, match=match):
        ArtifactManifest(**values)


def test_the_manifest_round_trips_full_float_precision(tmp_path):
    """Fitted range metadata remains full precision in the versioned manifest."""
    rho = 2149.3847562819374
    manifest = ArtifactManifest(
        variant_id="chr11-5227002-T-A",
        model_version="v1",
        data_version="map-2026-08",
        resolution=3,
        n_cells=5,
        correlation_range_km=rho,
        prior_normalization=PRIOR_NORMALIZATION,
        prior_draws=PRIOR_DRAWS,
        prior_seed=42,
        likelihood="beta_binomial",
        lengthscale_sigma=0.7,
        n_observations=6,
        support_counts={"observed": 2},
        target_grid_source="worldpop-1km-unconstrained",
        target_grid_version="test",
        measurement="allele_frequency",
        observations=observations_record(_observations(), measurement="allele_frequency"),
    )
    published = json.loads(manifest.to_json())
    assert published["prior_normalization"] == PRIOR_NORMALIZATION
    assert published["correlation_range_km"] == rho

    directory = publish(_frame(), tmp_path, manifest=manifest, observations=_observations())
    on_disk = json.loads((directory / "manifest.json").read_text())
    assert on_disk["correlation_range_km"] == rho


@pytest.mark.parametrize("bad", [0.0, np.nan])
def test_format_three_refuses_malformed_per_cell_prior_before_creating_directory(tmp_path, bad):
    frame = _frame()
    frame.loc[2, "prior_frequency_sd"] = bad
    with pytest.raises(ValueError, match="prior_frequency_sd"):
        publish(frame, tmp_path, manifest=_manifest(), observations=_observations())
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("column", ["prior_frequency_sd", "post_sd", "posterior_contraction"])
@pytest.mark.parametrize("bad_kind", ["numeric_strings", "booleans"])
def test_format_three_publish_refuses_nonnumeric_sd_columns_before_creating_directory(
    tmp_path, column, bad_kind
):
    frame = _frame()
    if bad_kind == "numeric_strings":
        frame[column] = frame[column].map(str)
    else:
        frame[column] = True

    with pytest.raises(ValueError, match="numeric.*Boolean"):
        publish(frame, tmp_path, manifest=_manifest(), observations=_observations())
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("column", ["prior_frequency_sd", "post_sd", "posterior_contraction"])
@pytest.mark.parametrize("bad_kind", ["numeric_strings", "booleans"])
def test_format_three_read_refuses_nonnumeric_sd_columns(tmp_path, column, bad_kind):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "cells.parquet"
    frame = pd.read_parquet(path)
    if bad_kind == "numeric_strings":
        frame[column] = frame[column].map(str)
    else:
        frame[column] = True
    frame.to_parquet(path, index=False)

    with pytest.raises(ValueError, match="numeric.*Boolean"):
        read(directory)


def test_format_three_refuses_inconsistent_contraction(tmp_path):
    frame = _frame()
    frame.loc[0, "posterior_contraction"] += 1e-6
    with pytest.raises(ValueError, match="inconsistent"):
        publish(frame, tmp_path, manifest=_manifest(), observations=_observations())


def test_format_three_read_refuses_invalid_measurement(tmp_path):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    payload["measurement"] = "plausible-frequency"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="measurement"):
        read(directory)


def test_format_three_round_trips_nontrivial_binary64_prior_values(tmp_path):
    frame = _frame()
    values = np.array([0.12518374619283746, 0.11900000000000001, 0.13, 0.17, 0.09])
    frame["prior_frequency_sd"] = values
    frame["posterior_contraction"] = frame["post_sd"].to_numpy() / values
    restored, _ = read(publish(frame, tmp_path, manifest=_manifest(), observations=_observations()))
    np.testing.assert_array_equal(restored["prior_frequency_sd"].to_numpy(), values)


def test_cell_table_normalizes_by_aligned_local_prior_sd_and_preserves_support_rules():
    class Fit:
        correlation_range_km = 1000.0

        def __init__(self, post_sd):
            self.post_sd = post_sd

        def predict(self, lat, lon):
            return pd.DataFrame(
                {
                    "post_median": [0.1, 0.2, 0.3],
                    "post_mean": [0.1, 0.2, 0.3],
                    "post_sd": self.post_sd,
                    "q025": [0.01, 0.02, 0.03],
                    "q975": [0.2, 0.3, 0.4],
                    "q25": [0.05, 0.1, 0.15],
                    "q75": [0.15, 0.25, 0.35],
                }
            )

        def prior_frequency_sd_at(self, lat, lon):
            return np.array([0.05, 0.10, 0.20])

    frame = cell_table(
        Fit([0.05, 0.10, 0.20]),
        h3_index=["83754efffffffff", "837541fffffffff", "837543fffffffff"],
        lat=np.array([0.0, 0.0, 0.0]),
        lon=np.array([0.0, 4.0, 30.0]),
        observations=pd.DataFrame({"lat": [0.0], "lon": [0.0]}),
        variant_id="chr11-5227002-T-A",
        model_version="v2",
        data_version="test",
    )
    np.testing.assert_array_equal(frame["prior_frequency_sd"], [0.05, 0.10, 0.20])
    np.testing.assert_allclose(frame["posterior_contraction"], 1.0, rtol=0, atol=0)
    assert frame["support"].tolist() == ["observed", "prior_dominated", "unknown"]

    contracted = cell_table(
        Fit([0.05, 0.08, 0.20]),
        h3_index=frame["h3_index"].tolist(),
        lat=np.array([0.0, 0.0, 0.0]),
        lon=np.array([0.0, 4.0, 30.0]),
        observations=pd.DataFrame({"lat": [0.0], "lon": [0.0]}),
        variant_id="chr11-5227002-T-A",
        model_version="v2",
        data_version="test",
    )
    assert contracted.loc[1, "posterior_contraction"] == pytest.approx(0.8)
    assert contracted.loc[1, "support"] == "interpolated"


@pytest.mark.parametrize(
    "bad_prior",
    [np.array([0.0]), np.array([np.nan]), 0.05, np.array([0.05, 0.06])],
    ids=["zero", "nan", "scalar", "misaligned"],
)
def test_cell_table_refuses_malformed_local_prior_provider(bad_prior):
    class Fit:
        correlation_range_km = 1000.0

        def predict(self, lat, lon):
            return pd.DataFrame(
                {
                    "post_median": [0.1], "post_mean": [0.1], "post_sd": [0.05],
                    "q025": [0.01], "q975": [0.2], "q25": [0.05], "q75": [0.15],
                }
            )

        def prior_frequency_sd_at(self, lat, lon):
            return bad_prior

    with pytest.raises(ValueError, match="finite positive vector"):
        cell_table(
            Fit(),
            h3_index=["83754efffffffff"],
            lat=np.array([0.0]),
            lon=np.array([0.0]),
            observations=pd.DataFrame({"lat": [0.0], "lon": [0.0]}),
            variant_id="chr11-5227002-T-A",
            model_version="v2",
            data_version="test",
        )


# --- inputs travel with outputs (#45) ---


def test_the_fits_input_travels_with_the_cells(tmp_path):
    """The rows the fit consumed sit beside the cells, and the manifest names their exact bytes."""
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    payload = (directory / OBSERVATIONS_FILE).read_bytes()
    _, manifest = read(directory)
    record = manifest["observations"]
    assert record["sha256"] == hashlib.sha256(payload).hexdigest()
    assert record["bytes"] == len(payload)
    assert record["row_count"] == manifest["n_observations"] == 6
    assert record["columns"][6:8] == ["ac", "an"]
    pd.testing.assert_frame_equal(read_observations(directory), _observations())


def test_the_manifest_is_written_last(tmp_path, monkeypatch):
    """A manifest is the claim that the directory is complete, so nothing may follow it."""
    write_bytes = Path.write_bytes

    def fail_on_input(path, data):
        if path.name == OBSERVATIONS_FILE:
            raise OSError("disk full")
        return write_bytes(path, data)

    monkeypatch.setattr(Path, "write_bytes", fail_on_input)
    with pytest.raises(OSError, match="disk full"):
        publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    (directory,) = tmp_path.iterdir()
    assert not (directory / "manifest.json").exists()


def test_overwriting_removes_the_old_manifest_before_writing_anything(tmp_path, monkeypatch):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    write_bytes = Path.write_bytes

    def fail_on_input(path, data):
        if path.name == OBSERVATIONS_FILE:
            raise OSError("disk full")
        return write_bytes(path, data)

    monkeypatch.setattr(Path, "write_bytes", fail_on_input)
    with pytest.raises(OSError, match="disk full"):
        publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations(), overwrite=True)
    assert not (directory / "manifest.json").exists()


def test_publish_refuses_a_record_that_does_not_describe_the_table(tmp_path):
    with pytest.raises(ValueError, match="does not describe"):
        publish(_frame(), tmp_path, manifest=_manifest(), observations=observation_rows(5))
    assert not list(tmp_path.iterdir())


def test_publish_refuses_another_variants_rows_as_the_input(tmp_path):
    rows = _observations("kir:2dl1")
    manifest = replace(_manifest(), observations=observations_record(rows, measurement="allele_frequency"))
    with pytest.raises(ValueError, match="kir:2dl1"):
        publish(_frame(), tmp_path, manifest=manifest, observations=rows)
    assert not list(tmp_path.iterdir())


def test_a_manifest_refuses_an_input_record_of_another_size():
    with pytest.raises(ValueError, match="n_observations"):
        replace(_manifest(), n_observations=1071)
    with pytest.raises(ValueError, match="ObservationsRecord"):
        replace(_manifest(), observations={"row_count": 6})


def test_reading_the_input_refuses_bytes_that_are_not_the_recorded_table(tmp_path):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    other = serialize_observations(observation_rows(5), measurement="allele_frequency")[0]
    (directory / OBSERVATIONS_FILE).write_bytes(other)
    with pytest.raises(ValueError, match="sha256"):
        read_observations(directory)


def test_an_artifact_published_before_the_rule_has_no_input_to_read(tmp_path):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    del payload["observations"]
    path.write_text(json.dumps(payload))
    (directory / OBSERVATIONS_FILE).unlink()
    read(directory)  # the cells stay readable
    with pytest.raises(ValueError, match="does not carry"):
        read_observations(directory)


# --- a KIR artifact's input is carriers over individuals, never allele counts (#133) ---


def test_a_manifest_refuses_an_input_record_of_another_measurement():
    """The input's measurement is the artifact's: a carrier surface cannot cite an allele-count table."""
    allele_record = observations_record(kir_fit_rows(), measurement="allele_frequency")
    with pytest.raises(ValueError, match="measurement"):
        replace(_manifest("kir:2dl1"), observations=allele_record)
    with pytest.raises(ValueError, match="measurement"):
        replace(_manifest(), measurement="carrier_frequency")


def test_a_kir_artifact_publishes_its_input_under_the_carrier_contract(tmp_path):
    variant = "kir:2dl1"
    consumed = _observations(variant)
    directory = publish(
        _frame(variant_id=variant), tmp_path, manifest=_manifest(variant), observations=consumed
    )
    _, manifest = read(directory)
    record = manifest["observations"]
    assert manifest["measurement"] == record["measurement"] == "carrier_frequency"
    assert record["schema"] == "contract/carrier_observations.schema.json"
    assert record["columns"][6:8] == ["carriers", "n_individuals"]
    on_disk = pd.read_parquet(directory / OBSERVATIONS_FILE)
    assert not {"ac", "an"} & set(on_disk.columns)
    published = read_observations(directory)
    pd.testing.assert_frame_equal(
        OBSERVATIONS_SCHEMA.validate(afnd_carriers.as_binomial(published)), consumed
    )


def test_reading_an_input_refuses_a_record_of_another_measurement(tmp_path):
    directory = publish(_frame(), tmp_path, manifest=_manifest(), observations=_observations())
    path = directory / "manifest.json"
    payload = json.loads(path.read_text())
    payload["measurement"] = "carrier_frequency"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="measurement"):
        read_observations(directory)
