"""Synthetic observations and a sampling budget shared by the surface tests (design §7; #471).

``tests/test_surface_fit.py``, ``tests/test_surface_model.py``, ``tests/test_surface_mask.py`` and
``tests/test_crossval.py`` fit or build from the same frame, so it lives here rather than in a test
module the others import. ``jittered_point`` is the point at which two surface graphs' log densities
are compared. ``published_artifact`` publishes a fit as the artifact a model export is bound to
(``tests/test_model_export.py``).
"""

from __future__ import annotations

from pathlib import Path

import h3
import numpy as np
import pandas as pd
import pymc as pm
from pymc.initial_point import make_initial_point_fn

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.surfaces.artifacts import ArtifactManifest, cell_table, publish
from genomeos.surfaces.config import SEED
from genomeos.surfaces.fit import FitConfig, SurfaceFit
from genomeos.surfaces.fit_input import observations_record
from genomeos.surfaces.prior import PRIOR_DRAWS, PRIOR_NORMALIZATION

# Enough draws to actually converge: fit_surface now refuses a fit that has not mixed (§12),
# so a too-short chain is a failure rather than a fast approximation. numpyro keeps it quick.
FAST_CONFIG = FitConfig(draws=800, tune=1000, chains=4)

HBS = "chr11-5227002-T-A"


def synthetic_observations(
    n: int = 70,
    beta_design: float = -1.0,
    designs: tuple[str, ...] = ("population_random", "healthy_reference"),
    concentration: float = 40.0,
    seed: int = 7,
) -> pd.DataFrame:
    """Synthetic observations with a known east-west cline and a known design effect.

    The first entry of `designs` is the reference level, so its true offset is 0.
    """
    rng = np.random.default_rng(seed)
    lon = rng.uniform(-10.0, 10.0, n)
    lat = rng.uniform(-10.0, 10.0, n)
    design_idx = rng.integers(0, len(designs), n)
    logit = -1.5 + 0.15 * lon + beta_design * (design_idx != 0)
    p = 1.0 / (1.0 + np.exp(-logit))
    an = np.full(n, 200)
    # Overdispersed, like the real corpus: two surveys of one locality differ by more than
    # binomial sampling error, because they differ in method, sub-population and decade. Exactly
    # binomial fixtures would also leave the beta-binomial concentration unidentified at the top
    # end, so the fixture matches both reality and the default likelihood.
    ac = rng.binomial(an, rng.beta(p * concentration, (1.0 - p) * concentration))

    return OBSERVATIONS_SCHEMA.validate(
        pd.DataFrame(
            {
                "variant_id": HBS,
                "rsid": "rs334",
                "population_id": [f"pop-{i:03d}" for i in range(n)],
                "lat": lat,
                "lon": lon,
                "radius_km": 25.0,
                "ac": ac,
                "an": an,
                "source_record_id": [f"synthetic:{i}" for i in range(n)],
                "source": "synthetic",
                "assay": "genotype",
                "date_lower": 0,
                "date_upper": 0,
                "sampling_design": [designs[i] for i in design_idx],
                "disease_ascertainment_excluded": [bool(i != 0) for i in design_idx],
                "cohort_id": [f"cohort-{i % 4}" for i in range(n)],
                "ingest_version": "test",
            }
        )
    )


def jittered_point(model: pm.Model, seed: int = SEED) -> dict[str, np.ndarray]:
    """A seeded point, on the transformed scale, at which a log density can see the data mapping.

    `Model.initial_point` applies no jitter, so it is the support point: the HSGP coefficients, the
    design offset and the cohort offsets are all 0 there, the field is the bare intercept, and graphs
    built from shuffled coordinates, designs or cohorts give the same log density. Jittering every free
    variable moves each one off its support point, and the seed keeps the point deterministic (#471).
    """
    return make_initial_point_fn(model=model, jitter_rvs=set(model.free_RVs), return_transformed=True)(seed)


#: `published_artifact`'s key and grid: H3 resolution 3, the coarsest an artifact may be written at.
MODEL_VERSION = "v9"
DATA_VERSION = "map-test"
RESOLUTION = 3


def published_artifact(
    fit: SurfaceFit,
    root: Path,
    *,
    measurement: str = "allele_frequency",
    observations: pd.DataFrame | None = None,
) -> Path:
    """Publish `fit` under `root` as `<variant>__v9__map-test`, through `surfaces.artifacts.publish`.

    The cells are the 91 resolution-3 cells within five rings of (0, 0), predicted at their centres as
    `scripts/publish_artifacts.py` does. The input is the fit's own unless `observations` names another
    table, which is how a test publishes an artifact that is not the fit's.
    """
    consumed = fit.observations if observations is None else observations
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(0.0, 0.0, RESOLUTION), 5))
    centres = np.array([h3.cell_to_latlng(cell) for cell in cells], dtype=float)
    frame = cell_table(
        fit,
        h3_index=cells,
        lat=centres[:, 0],
        lon=centres[:, 1],
        observations=consumed,
        variant_id=fit.variant_id,
        model_version=MODEL_VERSION,
        data_version=DATA_VERSION,
    )
    manifest = ArtifactManifest(
        variant_id=fit.variant_id,
        model_version=MODEL_VERSION,
        data_version=DATA_VERSION,
        resolution=RESOLUTION,
        n_cells=len(frame),
        correlation_range_km=float(fit.correlation_range_km),
        prior_normalization=PRIOR_NORMALIZATION,
        prior_draws=PRIOR_DRAWS,
        prior_seed=fit.config.seed,
        likelihood=fit.config.likelihood,
        lengthscale_sigma=float(fit.config.lengthscale_sigma),
        n_observations=len(consumed),
        support_counts={str(s): int((frame["support"] == s).sum()) for s in sorted(set(frame["support"]))},
        target_grid_source="test-grid",
        target_grid_version="test",
        measurement=measurement,
        observations=observations_record(consumed, measurement=measurement),
    )
    return publish(frame, root, manifest=manifest, observations=consumed)
