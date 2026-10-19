"""A tiny, schema-valid observation table, shared by the fit-input tests (#45)."""

from __future__ import annotations

import pandas as pd

from genomeos.observations.schema import OBSERVATIONS_SCHEMA


def observation_rows(n: int = 6, *, variant_id: str = "chr11-5227002-T-A") -> pd.DataFrame:
    """What `fit_surface` would have validated: counts (`ac`, `an`), never frequencies."""
    return OBSERVATIONS_SCHEMA.validate(
        pd.DataFrame(
            {
                "variant_id": variant_id,
                "rsid": ["rs334", None, "rs334", "rs334", None, "rs334"][:n],
                "population_id": [f"pop-{i}" for i in range(n)],
                "lat": [9.0 + i for i in range(n)],
                "lon": [-1.5 * i for i in range(n)],
                "radius_km": 12.616,
                "ac": [0, 3, 12, 40, 1, 7][:n],
                "an": [200, 180, 400, 410, 96, 222][:n],
                "source_record_id": [f"map-surveys:{100 + i}" for i in range(n)],
                "source": "map_hbs",
                "assay": "haemoglobin_electrophoresis",
                "date_lower": 0,
                "date_upper": 0,
                "sampling_design": "population_random",
                "disease_ascertainment_excluded": False,
                "cohort_id": [f"cohort-{i % 2}" for i in range(n)],
                "ingest_version": "map-2026-08",
            }
        )
    )
