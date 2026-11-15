"""Synthetic observations and a sampling budget shared by the surface tests (design §7; #471).

``tests/test_surface_fit.py``, ``tests/test_surface_model.py``, ``tests/test_surface_mask.py`` and
``tests/test_crossval.py`` fit or build from the same frame, so it lives here rather than in a test
module the others import.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.surfaces.fit import FitConfig

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
