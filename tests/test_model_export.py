"""A fitted surface exported without pickle, and rebuilt from code and its draws (#471).

Atlas data platform design 2026-10-18 §2.1 and §2.3 publish trained models under
`store/models/<artifact-id>/`, "pickles never": an export holds JSON and float64 `.npy` only, and the
loader rebuilds the PyMC graph with `build_surface_model` from the artifact's own fit input. These tests
pin that the rebuilt fit predicts what the fit predicts, that every file is named and hashed, and that
an export is refused when it is not the artifact's, rather than bound to the wrong posterior.
"""

from __future__ import annotations

import hashlib
import json
import pickle
import shutil
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytensor
import pytest

from genomeos.surfaces.artifacts import read_observations
from genomeos.surfaces.config import SEED
from genomeos.surfaces.fit import SurfaceFit, fit_surface, free_variable_shapes
from genomeos.surfaces.footprint import ObservationSupportMetadata
from genomeos.surfaces.model_export import (
    EXPORT_FORMAT,
    EXPORT_SCHEMA,
    INDUCING_FILE,
    MODEL_FILE,
    MODEL_MANIFEST,
    POSTERIOR_DIR,
    REPRODUCTION_SAMPLE,
    export_model,
    load_model_export,
    require_reproduces_cells,
)
from tests.surface_fixtures import (
    FAST_CONFIG,
    jittered_point,
    published_artifact,
    synthetic_observations,
)

LAT = np.array([-6.0, 0.5, 4.0, 9.5])
LON = np.array([-7.5, 1.0, 8.0, -2.0])
SUMMARIES = ("post_median", "post_mean", "post_sd", "q025", "q975")


@pytest.fixture(scope="module")
def fit() -> SurfaceFit:
    return fit_surface(synthetic_observations(), FAST_CONFIG)


@pytest.fixture(scope="module")
def exported(fit: SurfaceFit, tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """`(model_dir, artifact_dir)`: the module's fit, published and exported once. Tests that change
    either work on a copy (`_copy`)."""
    root = tmp_path_factory.mktemp("export")
    artifact = published_artifact(fit, root / "artifacts")
    return export_model(fit, artifact, root / "models"), artifact


def _copy(exported: tuple[Path, Path], tmp_path: Path) -> tuple[Path, Path]:
    model_dir, artifact = exported
    copy = tmp_path / "models" / model_dir.name
    shutil.copytree(model_dir, copy)
    return copy, artifact


def _files(model_dir: Path) -> dict[str, bytes]:
    return {
        path.relative_to(model_dir).as_posix(): path.read_bytes()
        for path in sorted(model_dir.rglob("*"))
        if path.is_file()
    }


def _reseal(model_dir: Path) -> None:
    """Record every file on disk in the manifest with its digest, as an export would have, so a check
    that reads only the manifest's digests cannot be what refuses the change."""
    manifest = json.loads((model_dir / MODEL_MANIFEST).read_text())
    manifest["files"] = {
        name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        for name, data in _files(model_dir).items()
        if name != MODEL_MANIFEST
    }
    (model_dir / MODEL_MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def _edit_model_json(model_dir: Path, edit: Callable[[dict], None]) -> None:
    record = json.loads((model_dir / MODEL_FILE).read_text())
    edit(record)
    (model_dir / MODEL_FILE).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")


def test_an_exported_fit_predicts_what_the_fit_predicts(fit, exported):
    loaded = load_model_export(*exported)
    expected, predicted = fit.predict(lat=LAT, lon=LON), loaded.predict(lat=LAT, lon=LON)
    for column in SUMMARIES:
        np.testing.assert_allclose(expected[column], predicted[column])

    # The graph is the fit's own: the same log density at a seeded point off the support point, where a
    # graph built over other rows would differ (tests.surface_fixtures.jittered_point).
    point = jittered_point(loaded._model)
    assert loaded._model.compile_logp()(point) == fit._model.compile_logp()(point)
    pd.testing.assert_frame_equal(loaded.observations, fit.observations)
    assert loaded.config == fit.config
    assert loaded.variant_id == fit.variant_id
    assert loaded.design_levels == fit.design_levels
    assert (loaded.beta_design_applied, loaded.beta_cohort_applied) == (
        fit.beta_design_applied,
        fit.beta_cohort_applied,
    )
    assert loaded.correlation_range_km == fit.correlation_range_km
    assert loaded.inducing_spacing_ratio == fit.inducing_spacing_ratio
    assert loaded.prediction_metadata == fit.prediction_metadata
    assert loaded.footprint_metadata is None
    pd.testing.assert_frame_equal(loaded.design_effects(), fit.design_effects())


def test_an_export_holds_only_json_and_float64_npy(fit, exported, tmp_path, monkeypatch):
    model_dir, artifact = exported
    files = _files(model_dir)
    stems = {Path(name).stem for name in files if name.startswith(f"{POSTERIOR_DIR}/")}

    assert stems == set(free_variable_shapes(fit._model))
    assert not stems & {"f", "p", "freq_pred", "latent_logit_pred", "beta_cohort"}
    assert set(files) == {MODEL_MANIFEST, MODEL_FILE, INDUCING_FILE} | {
        f"{POSTERIOR_DIR}/{stem}.npy" for stem in stems
    }
    for name, data in files.items():
        if name.endswith(".json"):
            json.loads(data)
            continue
        array = np.load(model_dir / name, allow_pickle=False)
        assert array.dtype == np.float64, name
        assert data[:8] == b"\x93NUMPY\x01\x00", name  # .npy format version 1.0
    for stem in stems:
        draws = np.load(model_dir / POSTERIOR_DIR / f"{stem}.npy", allow_pickle=False)
        np.testing.assert_array_equal(draws, fit.idata.posterior[stem].to_numpy())

    manifest = json.loads(files[MODEL_MANIFEST])
    assert set(manifest) == {"schema", "export_format", "artifact", "fit_input_sha256", "files", "software"}
    assert (manifest["schema"], manifest["export_format"], manifest["artifact"]) == (
        EXPORT_SCHEMA,
        EXPORT_FORMAT,
        artifact.name,
    )
    assert set(manifest["files"]) == set(files) - {MODEL_MANIFEST}
    assert (
        manifest["fit_input_sha256"]
        == hashlib.sha256((artifact / "observations.parquet").read_bytes()).hexdigest()
    )
    assert set(json.loads(files[MODEL_FILE])) == {
        "variant_id",
        "config",
        "beta_design_applied",
        "beta_cohort_applied",
        "design_levels",
        "lengthscale_prior_km",
        "inducing_spacing_ratio",
        "correlation_range_km",
        "free_variables",
    }

    again = export_model(fit, artifact, tmp_path / "again")
    assert _files(again) == files

    def refuse(*args, **kwargs):
        raise AssertionError("loading a model export unpickled something")

    monkeypatch.setattr(pickle, "load", refuse)
    monkeypatch.setattr(pickle, "loads", refuse)
    # Rebuilding the graph compiles small functions (its shapes, the HSGP centre). PyTensor's default
    # numba backend unpickles its own compile cache and codegen literals while it does: local code, not
    # the export's bytes. FAST_COMPILE evaluates with PyTensor's Python implementations and compiles
    # nothing, so under it any unpickle left would be the loader's.
    with pytensor.config.change_flags(mode="FAST_COMPILE"):
        loaded = load_model_export(model_dir, artifact)
    assert set(loaded.idata.posterior.data_vars) == stems


def _object_npy(model_dir: Path) -> None:
    with (model_dir / POSTERIOR_DIR / "amplitude.npy").open("wb") as stream:
        np.save(stream, np.array([{"draws": 1}], dtype=object), allow_pickle=True)
    _reseal(model_dir)


def _flip_a_byte(model_dir: Path) -> None:
    path = model_dir / POSTERIOR_DIR / "lengthscale.npy"
    data = bytearray(path.read_bytes())
    data[-1] ^= 0x01
    path.write_bytes(bytes(data))


def _move_the_inducing_points(model_dir: Path) -> None:
    np.save(model_dir / INDUCING_FILE, np.array([[1.0, 0.0, 0.0]]), allow_pickle=False)
    _reseal(model_dir)


def _drop_the_seed(model_dir: Path) -> None:
    _edit_model_json(model_dir, lambda record: record["config"].pop("seed"))
    _reseal(model_dir)


@pytest.mark.parametrize(
    ("tamper", "match"),
    [
        pytest.param(_flip_a_byte, "sha256", id="a-changed-byte"),
        pytest.param(lambda d: (d / "notes.txt").write_text("x"), "not listed", id="an-extra-file"),
        pytest.param(_drop_the_seed, "config", id="seed-dropped-from-config"),
        pytest.param(_object_npy, "allow_pickle", id="a-pickled-npy"),
        pytest.param(_move_the_inducing_points, "inducing", id="other-inducing-points"),
        pytest.param(None, "fit input", id="another-fit-input"),
    ],
)
def test_loading_refuses_a_tampered_export(fit, exported, tmp_path, tamper, match):
    model_dir, artifact = _copy(exported, tmp_path)
    if tamper is None:
        # The same artifact directory, published with another input: one survey fewer.
        artifact = published_artifact(fit, tmp_path / "other", observations=fit.observations.iloc[:-1])
    else:
        tamper(model_dir)
    with pytest.raises(ValueError, match=match):
        load_model_export(model_dir, artifact)


def test_loading_refuses_a_posterior_whose_variables_are_not_the_rebuilt_models(exported, tmp_path):
    model_dir, artifact = _copy(exported, tmp_path)
    posterior = model_dir / POSTERIOR_DIR
    (posterior / "amplitude.npy").rename(posterior / "amplitude_renamed.npy")

    def rename(record: dict) -> None:
        record["free_variables"]["amplitude_renamed"] = record["free_variables"].pop("amplitude")

    _edit_model_json(model_dir, rename)
    _reseal(model_dir)
    with pytest.raises(ValueError, match=r"missing \['amplitude'\].*unknown \['amplitude_renamed'\]"):
        load_model_export(model_dir, artifact)


def _without_input(fit: SurfaceFit, artifact: Path, tmp_path: Path) -> tuple[SurfaceFit, Path]:
    bare = tmp_path / "bare" / artifact.name
    shutil.copytree(artifact, bare)
    manifest = json.loads((bare / "manifest.json").read_text())
    del manifest["observations"]
    (bare / "manifest.json").write_text(json.dumps(manifest))
    (bare / "observations.parquet").unlink()
    return fit, bare


def _occupied(fit: SurfaceFit, artifact: Path, tmp_path: Path) -> tuple[SurfaceFit, Path]:
    (tmp_path / "out" / artifact.name).mkdir(parents=True)
    return fit, artifact


FOOTPRINT = ObservationSupportMetadata(
    convention="footprint_probability_mean_v1",
    weighting="uniform_area",
    location_model="independent_location_per_trial",
    support_version="test",
    points_per_observation=4,
)


@pytest.mark.parametrize(
    ("case", "error", "match"),
    [
        pytest.param(
            lambda fit, artifact, tmp: (
                fit,
                published_artifact(fit, tmp / "other", observations=fit.observations.iloc[:-1]),
            ),
            ValueError,
            "not the fit input",
            id="another-input",
        ),
        pytest.param(
            lambda fit, artifact, tmp: (
                replace(fit, correlation_range_km=2 * fit.correlation_range_km),
                artifact,
            ),
            ValueError,
            "correlation_range_km",
            id="another-range",
        ),
        pytest.param(
            lambda fit, artifact, tmp: (replace(fit, config=replace(fit.config, seed=SEED + 1)), artifact),
            ValueError,
            "seed",
            id="another-seed",
        ),
        pytest.param(
            lambda fit, artifact, tmp: (replace(fit, design_levels=("hospital_cases",)), artifact),
            ValueError,
            "design_levels",
            id="other-levels",
        ),
        pytest.param(_without_input, ValueError, "fit input", id="no-input"),
        pytest.param(
            lambda fit, artifact, tmp: (replace(fit, observations=None), artifact),
            ValueError,
            "fit input",
            id="a-fit-that-recorded-no-input",
        ),
        pytest.param(
            lambda fit, artifact, tmp: (replace(fit, footprint_metadata=FOOTPRINT), artifact),
            ValueError,
            "footprint",
            id="a-footprint",
        ),
        pytest.param(_occupied, FileExistsError, "exists", id="an-existing-target"),
    ],
)
def test_exporting_refuses_a_fit_that_is_not_the_artifacts(fit, exported, tmp_path, case, error, match):
    _, artifact = exported
    candidate, artifact = case(fit, artifact, tmp_path)
    out = tmp_path / "out"
    before = sorted(out.rglob("*")) if out.exists() else []

    with pytest.raises(error, match=match):
        export_model(candidate, artifact, out)
    after = sorted(out.rglob("*")) if out.exists() else []
    assert after == before, "a refused export wrote something"


def test_cells_reproduce_and_a_drift_is_named(fit, exported):
    model_dir, artifact = exported
    cells = pd.read_parquet(artifact / "cells.parquet")
    assert len(cells) > REPRODUCTION_SAMPLE
    loaded = load_model_export(model_dir, artifact)
    require_reproduces_cells(loaded, cells)

    drifted = cells.copy()
    drifted["post_median"] += 1e-3
    with pytest.raises(ValueError, match="post_median") as refused:
        require_reproduces_cells(loaded, drifted)
    assert "post_mean" not in str(refused.value)

    beyond = cells.copy()
    beyond.loc[REPRODUCTION_SAMPLE:, "post_median"] += 1e-3
    require_reproduces_cells(loaded, beyond)  # only the first REPRODUCTION_SAMPLE cells are compared


def test_a_carrier_artifact_round_trips(fit, tmp_path):
    artifact = published_artifact(fit, tmp_path / "artifacts", measurement="carrier_frequency")
    published = read_observations(artifact)
    assert list(published.columns[6:8]) == ["carriers", "n_individuals"]

    model_dir = export_model(fit, artifact, tmp_path / "models")
    manifest = json.loads((model_dir / MODEL_MANIFEST).read_text())
    assert (
        manifest["fit_input_sha256"]
        == json.loads((artifact / "manifest.json").read_text())["observations"]["sha256"]
    )

    loaded = load_model_export(model_dir, artifact)
    pd.testing.assert_frame_equal(loaded.observations, fit.observations)
    expected, predicted = fit.predict(lat=LAT, lon=LON), loaded.predict(lat=LAT, lon=LON)
    for column in SUMMARIES:
        np.testing.assert_allclose(expected[column], predicted[column])
    require_reproduces_cells(loaded, pd.read_parquet(artifact / "cells.parquet"))
