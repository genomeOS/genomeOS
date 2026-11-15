"""A surface's PyMC model, built without sampling it (#471).

A safe model export (Atlas data platform design 2026-10-18 §2.1, step 1.12) stores only the posterior
draws and rebuilds the graph from code. That is sound only if the graph `build_surface_model` returns is
the one `fit_surface` sampled: the same free variables, the same log density and the same inducing
points, with no sampling and no new seed on the way.
"""

from __future__ import annotations

from dataclasses import replace
from unittest import mock

import numpy as np
import pandas as pd
import pytest

from genomeos.surfaces.config import SEED
from genomeos.surfaces.fit import (
    build_surface_model,
    fit_surface,
    free_variable_shapes,
    h3_inducing_points,
    inducing_points,
    to_unit_sphere,
)
from tests.surface_fixtures import FAST_CONFIG, synthetic_observations


@pytest.fixture(scope="module")
def fit():
    return fit_surface(synthetic_observations(), FAST_CONFIG)


def test_building_the_model_never_samples():
    with mock.patch("pymc.sample", side_effect=AssertionError("building a model must not sample")):
        built = build_surface_model(synthetic_observations(), FAST_CONFIG)

    assert built.design_levels == ("population_random", "healthy_reference")
    assert built.inducing.shape == (0, 3)
    assert built.beta_design_applied is True
    assert built.beta_cohort_applied is True
    assert built.cohorts == ("cohort-0", "cohort-1", "cohort-2", "cohort-3")


def test_the_built_model_is_the_fits_model(fit):
    built = build_surface_model(synthetic_observations(), FAST_CONFIG)

    assert free_variable_shapes(built.model) == free_variable_shapes(fit._model)
    point = built.model.initial_point(random_seed=SEED)
    assert built.model.compile_logp()(point) == fit._model.compile_logp()(point)
    pd.testing.assert_frame_equal(built.observations, fit.observations)
    assert built.design_levels[1:] == fit.design_levels
    assert built.beta_design_applied == fit.beta_design_applied
    assert built.beta_cohort_applied == fit.beta_cohort_applied
    assert built.lengthscale_prior_km == fit.lengthscale_prior_km
    assert built.footprint_metadata == fit.footprint_metadata


def test_free_variable_shapes_name_the_sampled_parameters_not_the_derived_ones():
    shapes = free_variable_shapes(build_surface_model(synthetic_observations(), FAST_CONFIG).model)

    assert shapes["beta_design"] == (1,)
    assert shapes["cohort_z"] == (4,)
    assert shapes["lengthscale"] == ()
    assert {"f", "p", "freq_pred", "latent_logit_pred", "beta_cohort"}.isdisjoint(shapes)
    assert all(isinstance(size, int) for shape in shapes.values() for size in shape)


@pytest.mark.parametrize("placement", ["h3", "kmeans"])
def test_inducing_points_rebuild_exactly(placement):
    observations = synthetic_observations()
    config = replace(FAST_CONFIG, approximation="inducing", inducing_placement=placement, n_inducing=12)

    first = build_surface_model(observations, config)
    second = build_surface_model(observations, config)

    assert first.inducing.shape == (12, 3)
    np.testing.assert_array_equal(first.inducing, second.inducing)
    if placement == "h3":
        expected = h3_inducing_points(
            observations["lat"].to_numpy(), observations["lon"].to_numpy(), 12, config.inducing_reach_km
        )
    else:
        expected = inducing_points(to_unit_sphere(observations["lat"], observations["lon"]), 12, config.seed)
    np.testing.assert_array_equal(first.inducing, expected)
    assert free_variable_shapes(first.model)["z_u"] == (12,)
