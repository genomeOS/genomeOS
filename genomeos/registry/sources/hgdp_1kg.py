"""HGDP + 1KG registry adapter: the 80 identities of the harmonized callset (design §6, P0).

Atlas data platform design 2026-10-18 §1.2 D18 item 1 and §2.4; step 1.7. D18 recounts the v3.1.2
HGDP + 1KG genotypes under all 80 population identities the callset's metadata names. gnomAD's own INFO
counts merge four of them (Han with NorthernHan, PapuanHighlands with PapuanSepik) into 78 labels; the
registry keeps the 80 apart, one ``population_id`` per literal label of each project.

Like ``registry.sources.hgdp`` this reads curated input, one row per population, and returns
``(populations, aliases)`` conforming to ``registry.schema``. It reuses that module's TSV refusals
(``hgdp._read_input``) and adds the fields a two-project panel cannot take as constants:

- ``alias_source`` is ``hgdp`` or ``onekg``, the project whose label the row carries; the
  ``population_id`` is ``<alias_source>-<slug of the label>`` (``population_id``), so the same label in
  two projects stays two identities.
- ``location_type`` is read, never defaulted: 1KG labels such as GBR are diaspora sampling sites, not
  ancestral origins (design §4), and only the curator can say which a coordinate is.
- ``biocultural_notice``: every ``hgdp`` row carries HGDP's CARE notice (``hgdp.BIOCULTURAL_NOTICE``)
  exactly; an ``onekg`` row's blank notice is null, never an empty string.

Every other field is required and non-blank, and ``uncertainty_radius_km`` has no default (§6). A
violation is a ``ValueError`` naming the column; nothing is dropped.
"""

from __future__ import annotations

import math
from pathlib import Path

import pandas as pd

from genomeos.registry.schema import ALIASES_SCHEMA, LOCATION_TYPES, POPULATIONS_SCHEMA
from genomeos.registry.sources import hgdp

ALIAS_SOURCES = ("hgdp", "onekg")
REQUIRED_COLUMNS = (
    "alias_source",
    "population",
    "latitude",
    "longitude",
    "uncertainty_radius_km",
    "location_type",
    "provenance",
    "biocultural_notice",
)
_NUMERIC = ("latitude", "longitude", "uncertainty_radius_km")


def population_id(alias_source: str, label: str) -> str:
    """``("hgdp", "NorthernHan")`` -> ``"hgdp-northernhan"``; ``("onekg", "GBR")`` -> ``"onekg-gbr"``.

    The slug is ``hgdp.slugify``'s, under the row's own project.
    """
    if alias_source not in ALIAS_SOURCES:
        raise ValueError(f"alias_source {alias_source!r} is not one of {ALIAS_SOURCES}")
    slug = hgdp.slugify(label).removeprefix(f"{hgdp.SOURCE}-")
    if not slug:
        raise ValueError(f"population {label!r} has no letter or digit to name an identity by")
    return f"{alias_source}-{slug}"


def load(path: Path, registry_version: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The curated TSV at ``path`` as registry rows of ``registry_version``."""
    raw = hgdp._read_input(path)
    missing = sorted(set(REQUIRED_COLUMNS) - set(raw.columns))
    if missing:
        raise ValueError(f"{path}: missing required columns {missing}")
    for column in REQUIRED_COLUMNS:
        if column != "biocultural_notice" and raw[column].str.strip().eq("").any():
            raise ValueError(f"{path}: blank required value in {column}")
    unknown = sorted(set(raw["alias_source"]) - set(ALIAS_SOURCES))
    if unknown:
        raise ValueError(f"{path}: alias_source {unknown} is not one of {ALIAS_SOURCES}")
    placed = sorted(set(raw["location_type"]) - set(LOCATION_TYPES))
    if placed:
        raise ValueError(f"{path}: location_type {placed} is not one of {LOCATION_TYPES}")
    numeric = {column: _numbers(raw[column], path, column) for column in _NUMERIC}
    if (numeric["uncertainty_radius_km"] <= 0).any():
        raise ValueError(f"{path}: uncertainty_radius_km must be strictly positive")
    notice = raw["biocultural_notice"].where(raw["biocultural_notice"].str.strip().ne(""))
    unnoticed = raw.loc[raw["alias_source"].eq("hgdp") & notice.ne(hgdp.BIOCULTURAL_NOTICE), "population"]
    if not unnoticed.empty:
        raise ValueError(
            f"{path}: hgdp rows {sorted(unnoticed)} lack HGDP's biocultural_notice "
            f"({hgdp.BIOCULTURAL_NOTICE!r}); an indigenous-population panel's entries always carry it"
        )

    labels = zip(raw["alias_source"], raw["population"], strict=True)
    ids = [population_id(source, label) for source, label in labels]
    populations = pd.DataFrame(
        {
            "population_id": ids,
            "lat": numeric["latitude"],
            "lon": numeric["longitude"],
            "uncertainty_radius_km": numeric["uncertainty_radius_km"],
            "location_type": raw["location_type"],
            "provenance": raw["provenance"],
            "biocultural_notice": notice,
            "registry_version": registry_version,
        }
    )
    aliases = pd.DataFrame({"population_id": ids, "source": raw["alias_source"], "label": raw["population"]})
    return POPULATIONS_SCHEMA.validate(populations), ALIASES_SCHEMA.validate(aliases)


def _numbers(values: pd.Series, path: Path, column: str) -> pd.Series:
    try:
        numbers = values.astype(float)
    except ValueError as exc:
        raise ValueError(f"{path}: invalid numeric value in {column}") from exc
    if not numbers.map(math.isfinite).all():
        raise ValueError(f"{path}: nonfinite value in {column}")
    return numbers
