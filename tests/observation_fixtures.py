"""Tiny, schema-valid observation tables, shared by the fit-input tests (#45)."""

from __future__ import annotations

import pandas as pd

from genomeos.observations.schema import CARRIER_OBSERVATIONS_SCHEMA, OBSERVATIONS_SCHEMA
from genomeos.observations.sources import afnd_carriers


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


def carrier_rows(n: int = 6, *, variant_id: str = "kir:2dl1") -> pd.DataFrame:
    """KIR presence as the adapter emits it: carriers over individuals, not alleles (#133)."""
    rows = observation_rows(n, variant_id=variant_id).assign(rsid=None)
    rows = rows.rename(columns={"ac": "carriers", "an": "n_individuals"})
    return CARRIER_OBSERVATIONS_SCHEMA.validate(rows.assign(source="afnd", assay="kir_presence"))


def kir_fit_rows(n: int = 6, *, variant_id: str = "kir:2dl1") -> pd.DataFrame:
    """What a KIR fit consumes: carrier rows renamed to `ac`/`an` by `as_binomial`, and nothing else."""
    return OBSERVATIONS_SCHEMA.validate(afnd_carriers.as_binomial(carrier_rows(n, variant_id=variant_id)))
