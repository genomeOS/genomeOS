"""Data-support mask and masked aggregation (design §7, §7.1b, §10, P2).

The mask is the project's honesty guarantee. Design §4's first structural answer is that a
fitted surface must state where it does not know, because spatial interpolation manufactures
convincing clines with no demographic cause (Novembre & Stephens 2008). Four states:

- ``observed``        — an observation centre falls inside the cell
- ``interpolated``    — nearest observation within 2ρ, and the posterior contracted meaningfully
- ``prior_dominated`` — an observation is in range, but the posterior barely moved off the prior,
  so the value shown is mostly prior (§7.1b). This is the state that matters: rendering a prior
  as though it were data is the interpolation artifact wearing a new costume.
- ``unknown``         — no observation within 2ρ

``prior_dominated`` and ``unknown`` are rendered hatched and **excluded from every aggregation
statistic on the same footing**, and the excluded fraction is returned with the result (§10).

Known interaction, raised for calibration in #39: a cell containing a very small observation
(say AN=2) is classified ``observed`` because §7 orders that test first, yet its posterior may
not have contracted at all. Provenance and information are different questions and this enum
conflates them. Nothing is hidden — ``posterior_contraction`` and ``eff_n_in_range`` are emitted
per cell regardless — but such a cell does currently enter aggregates.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from genomeos.geo.h3util import GLOBAL_RESOLUTION, _haversine_km, cell_for, cells_within_km

SUPPORT_STATES: tuple[str, ...] = ("observed", "interpolated", "prior_dominated", "unknown")

STATISTICS: tuple[str, ...] = ("mean", "sum")

#: States excluded from every aggregation statistic (§7, §10).
MASKED_STATES: frozenset[str] = frozenset({"prior_dominated", "unknown"})

#: Allele-count bins for observed cells in the #39 calibration report. A cell's AN is the sum over
#: the observations whose centres fall in it; the edges separate a handful of people from a survey
#: large enough to pin a frequency down.
AN_BIN_EDGES: tuple[float, ...] = (0.0, 50.0, 200.0, 1000.0, float("inf"))

CONTRACTION_QUANTILES: tuple[float, ...] = (0.05, 0.25, 0.5, 0.75, 0.95)


@dataclass(frozen=True)
class MaskConfig:
    resolution: int = GLOBAL_RESOLUTION
    #: A cell whose posterior sd is still this fraction of the prior sd or more has not learned
    #: from the data. Placeholder pending the HbS calibration in #39.
    contraction_threshold: float = 0.9
    #: "within 2ρ" in §7 — how far the fitted correlation range is trusted to carry information.
    range_multiplier: float = 2.0

    def __post_init__(self) -> None:
        if not 0.0 < self.contraction_threshold <= 1.0:
            raise ValueError("contraction_threshold must be in (0, 1]")
        if self.range_multiplier <= 0:
            raise ValueError("range_multiplier must be > 0")


@dataclass(frozen=True)
class AggregateResult:
    """A statistic over a region, and how much of that region was unmapped.

    ``value`` is ``None`` when every cell was masked: §9 requires emitting no number rather
    than a wrong one.
    """

    value: float | None
    unmapped_fraction: float
    n_included: int
    n_total: int
    statistic: str


def classify_support(
    *,
    has_observation_centre: np.ndarray,
    dist_nearest_obs_km: np.ndarray,
    posterior_contraction: np.ndarray,
    correlation_range_km: float,
    config: MaskConfig,
) -> np.ndarray:
    """Assign one of ``SUPPORT_STATES`` per cell. Pure, vectorised, no model required."""
    in_range = dist_nearest_obs_km <= config.range_multiplier * correlation_range_km
    contracted = posterior_contraction < config.contraction_threshold

    states = np.full(len(dist_nearest_obs_km), "unknown", dtype=object)
    # Order matters and follows §7: no data in range is a stronger statement than a slack
    # posterior, and an observation inside the cell outranks both.
    states[in_range & ~contracted] = "prior_dominated"
    states[in_range & contracted] = "interpolated"
    states[has_observation_centre.astype(bool)] = "observed"
    return states


def candidate_cells(
    observations: pd.DataFrame,
    config: MaskConfig | None = None,
    correlation_range_km: float | None = None,
) -> list[str]:
    """Cells worth evaluating: everything within 2ρ of any observation, plus their own cells.

    Cells beyond this are ``unknown`` by construction, so enumerating them buys nothing — the
    client renders absence of a cell and absence of data identically.

    Pass the **fitted** ``correlation_range_km`` whenever a fit exists. Without it the reach
    falls back to the largest stated observation radius, which is the survey's own extent (a few
    km) rather than the distance over which the field is correlated (hundreds to thousands of
    km) — so the candidate set collapses to roughly the observation cells themselves.
    """
    config = config or MaskConfig()
    reach_km = config.range_multiplier * (
        correlation_range_km if correlation_range_km is not None
        else _fallback_range_km(observations)
    )
    cells: set[str] = set()
    for lat, lon in zip(observations["lat"], observations["lon"], strict=True):
        cells.update(cells_within_km(float(lat), float(lon), reach_km, config.resolution))
    return sorted(cells)


def evaluate_cells(
    fit: Any,
    observations: pd.DataFrame,
    cells: list[str],
    config: MaskConfig | None = None,
) -> pd.DataFrame:
    """Posterior summary plus support state for each H3 cell (§6's surfaces columns)."""
    import h3

    config = config or MaskConfig()
    if not cells:
        raise ValueError("evaluate_cells requires at least one cell")

    centres = np.array([h3.cell_to_latlng(c) for c in cells], dtype=float)
    lat, lon = centres[:, 0], centres[:, 1]

    predicted = fit.predict(lat=lat, lon=lon)

    obs_lat = observations["lat"].to_numpy(dtype=float)
    obs_lon = observations["lon"].to_numpy(dtype=float)
    obs_an = observations["an"].to_numpy(dtype=float)
    obs_cells = {
        cell_for(float(a), float(o), config.resolution)
        for a, o in zip(obs_lat, obs_lon, strict=True)
    }

    range_km = fit.correlation_range_km
    dist = np.empty(len(cells))
    eff_n = np.empty(len(cells))

    # Chunked broadcasting rather than a Python loop per cell: the full (cells x observations)
    # matrix is the natural formulation but would be gigabytes on a global grid, so it is walked
    # in blocks. Same arithmetic, no approximation.
    chunk = max(1, 4_000_000 // max(len(obs_lat), 1))
    for start in range(0, len(cells), chunk):
        stop = min(start + chunk, len(cells))
        block = _haversine_km(
            lat[start:stop, None], lon[start:stop, None], obs_lat[None, :], obs_lon[None, :]
        )
        if block.shape[1] == 0:
            dist[start:stop] = np.inf
            eff_n[start:stop] = 0.0
            continue
        dist[start:stop] = block.min(axis=1)
        # Distance-weighted allele count within one correlation range: §7's `eff_n_in_range`.
        weight = np.clip(1.0 - block / range_km, 0.0, None)
        eff_n[start:stop] = (obs_an[None, :] * weight).sum(axis=1)

    prior_sd = np.asarray(fit.prior_frequency_sd_at(lat=lat, lon=lon), dtype=float)
    if prior_sd.shape != (len(cells),) or not np.isfinite(prior_sd).all() or (prior_sd <= 0).any():
        raise ValueError("prior frequency SD must be an aligned finite positive vector")
    contraction = predicted["post_sd"].to_numpy() / prior_sd

    return pd.DataFrame(
        {
            "h3_index": cells,
            "lat": lat,
            "lon": lon,
            "post_mean": predicted["post_mean"].to_numpy(),
            "post_sd": predicted["post_sd"].to_numpy(),
            "prior_frequency_sd": prior_sd,
            "q025": predicted["q025"].to_numpy(),
            "q975": predicted["q975"].to_numpy(),
            "posterior_contraction": contraction,
            "dist_nearest_obs_km": dist,
            "eff_n_in_range": eff_n,
            "support": classify_support(
                has_observation_centre=np.array([c in obs_cells for c in cells]),
                dist_nearest_obs_km=dist,
                posterior_contraction=contraction,
                correlation_range_km=range_km,
                config=config,
            ),
        }
    )


def aggregate_cells(
    cells: pd.DataFrame, column: str = "post_mean", statistic: str = "mean"
) -> AggregateResult:
    """Aggregate over cells, excluding masked ones and reporting how much was excluded (§10)."""
    if statistic not in STATISTICS:
        raise ValueError(f"unknown statistic {statistic!r}; expected one of {STATISTICS}")

    n_total = len(cells)
    if n_total == 0:
        raise ValueError("aggregate_cells requires at least one cell")

    included = cells[~cells["support"].isin(MASKED_STATES)]
    unmapped = 1.0 - len(included) / n_total

    if included.empty:
        return AggregateResult(None, unmapped, 0, n_total, statistic)

    value = float(included[column].mean() if statistic == "mean" else included[column].sum())
    return AggregateResult(value, unmapped, len(included), n_total, statistic)


def contraction_report(
    cells: pd.DataFrame,
    observations: pd.DataFrame,
    config: MaskConfig | None = None,
) -> pd.DataFrame:
    """Posterior contraction by support state, and by allele count within observed cells (#39).

    The evidence #39 asks for before ``contraction_threshold`` is chosen and before deciding
    whether the contraction test should also apply to ``observed`` cells. ``cells`` is the frame
    `evaluate_cells` returns; nothing is refitted or re-predicted.

    One row per support state, every state present even when it has no cells (the canonical HbS
    run had none ``prior_dominated``, and that absence is a result), then one row per
    ``AN_BIN_EDGES`` bin of observed cells. Each row gives the cell count, contraction quantiles
    and the share below the threshold. ``observed_not_contracted`` counts observed cells at or
    above it: the cells #39's first option would reclassify as ``prior_dominated``. An empty
    group reports NaN quantiles rather than a number.
    """
    config = config or MaskConfig()
    for column in ("h3_index", "support", "posterior_contraction"):
        if column not in cells.columns:
            raise ValueError(f"cells is missing required column {column!r}")
    for column in ("lat", "lon", "an"):
        if column not in observations.columns:
            raise ValueError(f"observations is missing required column {column!r}")
    contraction = cells["posterior_contraction"].to_numpy(dtype=float)
    if not np.isfinite(contraction).all() or (contraction < 0).any():
        raise ValueError("posterior_contraction must be finite and non-negative")
    unknown_states = set(cells["support"]) - set(SUPPORT_STATES)
    if unknown_states:
        raise ValueError(f"unknown support states: {sorted(unknown_states)}")

    an_by_cell: dict[str, float] = {}
    for lat, lon, an in zip(observations["lat"], observations["lon"], observations["an"], strict=True):
        cell = cell_for(float(lat), float(lon), config.resolution)
        an_by_cell[cell] = an_by_cell.get(cell, 0.0) + float(an)

    def summary(group: str, values: np.ndarray, *, observed: bool) -> dict[str, object]:
        row: dict[str, object] = {"group": group, "cells": len(values)}
        quantiles = (
            np.quantile(values, CONTRACTION_QUANTILES)
            if len(values)
            else [np.nan] * len(CONTRACTION_QUANTILES)
        )
        for q, value in zip(CONTRACTION_QUANTILES, quantiles, strict=True):
            row[f"contraction_q{round(q * 100):02d}"] = float(value)
        below = values < config.contraction_threshold
        row["share_below_threshold"] = float(below.mean()) if len(values) else np.nan
        row["observed_not_contracted"] = int((~below).sum()) if observed else 0
        return row

    support = cells["support"].to_numpy()
    rows = [
        summary(f"support:{state}", contraction[support == state], observed=state == "observed")
        for state in SUPPORT_STATES
    ]

    observed = support == "observed"
    cell_an = np.array([an_by_cell.get(cell, np.nan) for cell in cells["h3_index"]], dtype=float)
    if np.isnan(cell_an[observed]).any():
        raise ValueError("an observed cell holds no observation centre at this resolution")
    for low, high in zip(AN_BIN_EDGES[:-1], AN_BIN_EDGES[1:], strict=True):
        in_bin = observed & (cell_an >= low) & (cell_an < high)
        label = f"observed:an_{low:g}_{high:g}" if np.isfinite(high) else f"observed:an_{low:g}_up"
        rows.append(summary(label, contraction[in_bin], observed=True))
    return pd.DataFrame(rows)


def _fallback_range_km(observations: pd.DataFrame) -> float:
    """A reach for candidate-cell generation before a fit exists: the largest stated radius."""
    return float(max(observations["radius_km"].max(), 1.0))
