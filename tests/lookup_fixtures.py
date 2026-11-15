"""Shared rows and keywords for the lookup-set tests (Atlas data platform design 2026-10-18 §2.10).

``binned_row`` is one ``measured.allele_observations_binned`` row (rs334 in Han), unvalidated, so a test
can build the rows ``write_bin`` must refuse. Its ascertainment values are test values only: the recount
rows' ``sampling_design`` and ``disease_ascertainment_excluded`` are undecided (O1). ``W`` holds the
provenance keywords every ``write_bin`` call in the tests shares.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TypedDict

import pandas as pd

from genomeos.tables.binned import BINNED_COLUMNS
from genomeos.tables.provenance import InputRef


class WriteBinKeywords(TypedDict):
    """``write_bin``'s provenance keywords, typed so that ``**W`` type-checks against its signature."""

    git_sha: str
    sources: Sequence[str]
    inputs: Sequence[InputRef]


#: The provenance keywords of ``write_bin``: a commit, the 80-identity registry folder's parquet as the
#: input, and the union of its recorded sources.
W = WriteBinKeywords(
    git_sha="0" * 40,
    sources=["genomeos", "gnomad_hgdp_1kg"],
    inputs=[
        InputRef(
            "releases/2026-12-01/tables/v1/reference/populations/1.0.0-0a1b2c3d/populations.parquet",
            "a" * 64,
        )
    ],
)

_DEFAULTS: dict[str, object] = {
    "variant_id": "chr11-5227002-T-A",
    "rsid": "rs334",
    "pos": 5227002,
    "population_id": "hgdp-han",
    "source_label": "Han",
    "lat": 32.27,
    "lon": 114.02,
    "radius_km": 25.0,
    "ac": 3,
    "an": 4,
    "source": "gnomad_hgdp_1kg",
    "assay": "genome",
    "date_lower": 0,
    "date_upper": 0,
    "sampling_design": "healthy_reference",
    "disease_ascertainment_excluded": True,
    "cohort_id": "gnomad-v3.1.2-hgdp-1kg:fixture-8:d18-v1",
    "ingest_version": "fixture-1",
}


def binned_row(**overrides: object) -> pd.DataFrame:
    """One binned row in ``BINNED_COLUMNS`` order, the defaults overridden by column name."""
    unknown = sorted(set(overrides) - set(_DEFAULTS))
    if unknown:
        raise TypeError(f"binned_row() has no column {unknown}")
    values = {**_DEFAULTS, **overrides}
    return pd.DataFrame({name: [values[name]] for name in BINNED_COLUMNS})
