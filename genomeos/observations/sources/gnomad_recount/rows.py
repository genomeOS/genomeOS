"""The recount's binned rows: the registry join, their own ``cohort_id`` and the ids they derive.

Atlas data platform design 2026-10-18 §1.2 D18, §2.4 and §2.10; builder's call 30.

``binned_rows`` turns one bin's ``SiteCounts`` (``rule``) into rows of ``measured.allele_observations_binned``
(``genomeos.tables.binned``, ``BINNED_COLUMNS``):

- each population label of the stage resolves, through the registry's aliases of
  ``gnomad_hgdp_1kg.ALIAS_SOURCES`` (``hgdp`` and ``onekg``), to one ``population_id`` and its coordinate
  (``population_table``). A label with no alias has no coordinate and is an ``UnmappedPopulationError``; a
  label listed twice, such as under both projects, is ambiguous and a ``RecountError``; ``radius_km`` is the
  registry's ``uncertainty_radius_km`` and has no default (v1 §6, §12);
- a cell is a row when its ``an`` is above 0, whatever its ``ac``: zero alternate alleles out of ``an`` is a
  count, not an absence. A cell with ``an = 0`` was not observed, so it is not written, and the recount's
  ``Tally.an_zero`` counts it (D18 item 5);
- the rows carry their own cohort, ``gnomad-v3.1.2-hgdp-1kg:<stage>:d18-v1`` (``recount_cohort_id``; the
  plan's Decision 4), and no ``source_record_id``: a bin stores none (call 30). ``with_derived_ids`` derives
  it under ``SOURCE_RECORD_ID_TEMPLATE`` (``derive_source_record_id``), as the lookup macro does, giving the
  fit input's 17 columns.

O1 (§2.4, AGENTS.md): the rows' ``sampling_design`` and ``disease_ascertainment_excluded`` are undecided.
The curated adapter's ``healthy_reference`` and ``True`` rest on gnomAD's exclusion policy, which did not
select the HGDP + 1KG subset, so they do not carry over. ``binned_rows`` takes both with no default, and the
owner decides them in issue #509 (https://github.com/genomeOS/genomeOS/issues/509).
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import pandas as pd

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.observations.sources.gnomad_hgdp_1kg import ALIAS_SOURCES, SOURCE, UnmappedPopulationError
from genomeos.observations.sources.gnomad_recount.rule import (
    _STAGE_NAME,
    GNOMAD_RELEASE,
    RULE_ID,
    RecountError,
    SiteCounts,
    Stage,
)
from genomeos.tables.binned import BINNED_COLUMNS, SOURCE_RECORD_ID_TEMPLATE

__all__ = (
    "ASSAY",
    "binned_rows",
    "derive_source_record_id",
    "population_table",
    "recount_cohort_id",
    "with_derived_ids",
)

ASSAY = "genome"
_COORDINATES = ("lat", "lon", "uncertainty_radius_km")


def recount_cohort_id(stage_name: str) -> str:
    """The cohort of the recount rows of stage ``stage_name``: ``gnomad-v3.1.2-hgdp-1kg:<stage>:d18-v1``."""
    if not _STAGE_NAME.fullmatch(stage_name):
        raise RecountError(f"stage name {stage_name!r} must match {_STAGE_NAME.pattern}")
    return f"gnomad-{GNOMAD_RELEASE}-hgdp-1kg:{stage_name}:{RULE_ID}"


def derive_source_record_id(variant_id: str, source_label: str) -> str:
    """A recount row's ``source_record_id``: ``SOURCE_RECORD_ID_TEMPLATE`` over its id and label."""
    return SOURCE_RECORD_ID_TEMPLATE.format(variant_id=variant_id, source_label=source_label)


def population_table(stage: Stage, populations: pd.DataFrame, aliases: pd.DataFrame) -> pd.DataFrame:
    """Each of ``stage.populations``, in that order, with its ``population_id``, ``lat``, ``lon`` and
    ``radius_km`` from the registry ``(populations, aliases)``; columns ``source_label`` first."""
    labels = list(stage.populations)
    held = aliases.loc[aliases["source"].isin(ALIAS_SOURCES), ["label", "population_id"]]
    held = held[held["label"].isin(labels)]
    unmapped = sorted(set(labels) - set(held["label"]))
    if unmapped:
        raise UnmappedPopulationError(
            f"stage {stage.name}: population labels absent from the registry's {ALIAS_SOURCES} aliases, "
            f"so they have no coordinate: {unmapped}"
        )
    ambiguous = sorted(set(held.loc[held["label"].duplicated(), "label"]))
    if ambiguous:
        raise RecountError(
            f"stage {stage.name}: population labels ambiguous, listed more than once among the registry's "
            f"{ALIAS_SOURCES} aliases: {ambiguous}"
        )
    ids = held.set_index("label")["population_id"].loc[labels].to_numpy()
    # reindex refuses a registry that lists an identity twice, and leaves NaN for one it lacks.
    coords = populations.set_index("population_id")[list(_COORDINATES)].reindex(pd.Index(ids))
    values = coords.to_numpy(dtype=float, na_value=np.nan)
    missing = [labels[i] for i in np.flatnonzero(np.isnan(values).any(axis=1))]
    if missing:
        raise UnmappedPopulationError(
            f"stage {stage.name}: population labels whose registry identity has no {_COORDINATES}: {missing}"
        )
    return pd.DataFrame(
        {
            "source_label": labels,
            "population_id": ids,
            "lat": values[:, 0],
            "lon": values[:, 1],
            "radius_km": values[:, 2],
        }
    )


def binned_rows(
    sites: Sequence[SiteCounts],
    table: pd.DataFrame,
    *,
    cohort_id: str,
    ingest_version: str,
    sampling_design: str,
    disease_ascertainment_excluded: bool,
) -> pd.DataFrame:
    """``sites``' rows in ``BINNED_COLUMNS`` order: one per site and population with ``an > 0``, by site,
    then in ``table``'s order, which is ``population_table``'s and the order of every ``ac`` and ``an``.

    Vectorised with numpy, since a bin holds up to about 4.1M rows. The ascertainment fields have no
    default (O1); a flag that is not a ``bool`` is refused rather than coerced.
    """
    if not isinstance(disease_ascertainment_excluded, bool):
        flag = disease_ascertainment_excluded
        raise RecountError(f"disease_ascertainment_excluded {flag!r} must be a bool, never coerced (O1)")
    width = len(table)
    wrong = sum(1 for site in sites if len(site.an) != width)
    if wrong:
        raise RecountError(f"{wrong} site(s) count other than the table's {width} populations")
    shape = (len(sites), width)
    ac = np.array([site.ac for site in sites], dtype=np.int64).reshape(shape)
    an = np.array([site.an for site in sites], dtype=np.int64).reshape(shape)
    site_at, population_at = np.nonzero(an > 0)

    def per_site(values: list[object], dtype: type = object) -> np.ndarray:
        return np.array(values, dtype=dtype)[site_at]

    def per_population(column: str) -> np.ndarray:
        return table[column].to_numpy()[population_at]

    columns: dict[str, object] = {
        "variant_id": per_site([site.variant_id for site in sites]),
        "rsid": per_site([site.rsid for site in sites]),
        "population_id": per_population("population_id"),
        "lat": per_population("lat"),
        "lon": per_population("lon"),
        "radius_km": per_population("radius_km"),
        "ac": ac[site_at, population_at],
        "an": an[site_at, population_at],
        "source": SOURCE,
        "assay": ASSAY,
        "date_lower": 0,
        "date_upper": 0,
        "sampling_design": sampling_design,
        "disease_ascertainment_excluded": disease_ascertainment_excluded,
        "cohort_id": cohort_id,
        "ingest_version": ingest_version,
        "pos": per_site([site.pos for site in sites], np.int64),
        "source_label": per_population("source_label"),
    }
    return pd.DataFrame({name: columns[name] for name in BINNED_COLUMNS})


def with_derived_ids(rows: pd.DataFrame) -> pd.DataFrame:
    """``rows`` of ``BINNED_COLUMNS`` as the fit input's 17 ``OBSERVATIONS_SCHEMA`` columns: each row's
    ``source_record_id`` derived from its ``variant_id`` and ``source_label``; ``pos`` and ``source_label``
    left out."""
    if set(rows.columns) != set(BINNED_COLUMNS):
        raise RecountError(f"rows must have exactly BINNED_COLUMNS; they have {list(rows.columns)}")
    ids = [
        derive_source_record_id(variant_id, label)
        for variant_id, label in zip(rows["variant_id"], rows["source_label"], strict=True)
    ]
    return rows.assign(source_record_id=ids).reindex(columns=list(OBSERVATIONS_SCHEMA.columns))
