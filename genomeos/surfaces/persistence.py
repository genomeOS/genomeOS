"""Persist and reload a trained surface (design §5, §6).

Split out of `surfaces.fit` when that module reached the agent-readable budget. The seam is a
real one: fitting is science and serialisation is plumbing, and the plumbing carries caveats —
environment coupling, arbitrary code execution on load — that have nothing to do with the model.

`fit` re-exports both functions, so the nine call sites that already import them from there
continue to work; this module is where they now live.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd
from pandas.api.types import is_integer_dtype

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.surfaces.config import FitConfig

# `fit` re-exports this module's functions from its last lines, so importing `fit` here at module
# level made the two a cycle: importing this module first failed with `FIT_FORMAT` not yet
# defined (#199). The annotations need `SurfaceFit` only for type checkers; `load_fit`, which
# checks and builds one at runtime, imports it when called, by which point both modules exist.
if TYPE_CHECKING:
    from genomeos.surfaces.fit import SurfaceFit

#: Bumped whenever `SurfaceFit`'s fields change in a way that makes an older file unreadable, or
#: that a reader must be able to rely on. Format 3 carries the observation table the fit consumed
#: (#45); formats 1 and 2 predate it and load with `observations=None`, never a guessed table.
FIT_FORMAT = 3
READABLE_FIT_FORMATS = frozenset({1, 2, FIT_FORMAT})

_FIT_FIELDS = (
    "variant_id",
    "config",
    "beta_design_applied",
    "lengthscale_prior_km",
    "beta_cohort_applied",
    "design_levels",
    "inducing_spacing_ratio",
    "correlation_range_km",
    "idata",
    "_model",
    "_centre",
    "_scale",
)


def _materialize_inference_data(idata):
    """Copy sampler-backed arrays to NumPy so cache reload cannot change their dtype."""
    if hasattr(idata, "subtree"):
        materialized = idata.copy(deep=True)
        for node in materialized.subtree:
            node.dataset = node.dataset.map(
                lambda variable: variable.copy(data=np.asarray(variable.data))
            )
        return materialized

    materialized = idata.copy()
    groups = materialized.groups
    if callable(groups):
        groups = groups()
    for group in groups:
        dataset = getattr(materialized, group)
        setattr(
            materialized,
            group,
            dataset.map(lambda variable: variable.copy(data=np.asarray(variable.data))),
        )
    return materialized


def save_fit(fit: SurfaceFit, path: str | Path) -> Path:
    """Persist a trained surface so predictions cost seconds instead of a refit.

    `SurfaceFit.predict` runs `sample_posterior_predictive` against a live PyMC model, so the
    model object and the posterior have to travel together — writing the InferenceData alone
    would leave nothing able to use it. cloudpickle handles the PyMC/pytensor graph that plain
    `pickle` cannot.

    Two limits worth knowing. The file is **coupled to this environment**: a PyMC or pytensor
    upgrade can make it unreadable, so it is a cache, never an archival artifact — §6 artifacts
    are the parquet outputs, not this. And pickle executes arbitrary code on load, so only ever
    load files you produced yourself. Sampler-backed inference arrays are materialized on a copy
    before serialization so a clean-process reload cannot silently change their dtype; the live
    fitted object is not mutated.
    """
    import cloudpickle

    _require_observations(fit, f"fit for {fit.variant_id}", current_contract=True)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    persisted = replace(fit, idata=_materialize_inference_data(fit.idata))
    with path.open("wb") as stream:
        cloudpickle.dump({"format": FIT_FORMAT, "fit": persisted}, stream)
    return path


def _require_observations(fit: object, context: str, *, current_contract: bool) -> None:
    """A current-format fit carries the non-empty table it consumed, with integer `ac` and `an` (#45).

    Saving also requires the current contract's columns, since a fit is saved from what it has just
    validated. Loading does not, so a contract revision cannot strand every format-3 cache behind a
    message that says its table is missing: conformance is checked when the table is published,
    where `fit_input.serialize_observations` re-validates it and refuses.
    """
    observations = getattr(fit, "observations", None)
    if (
        not isinstance(observations, pd.DataFrame)
        or observations.empty
        or not all(
            column in observations.columns and is_integer_dtype(observations[column].dtype)
            for column in ("ac", "an")
        )
    ):
        raise ValueError(
            f"{context} does not carry the observation table it consumed, with integer counts ac and "
            f"an, which fit format {FIT_FORMAT} requires; a fit loaded from an older cache keeps that "
            "file instead"
        )
    if current_contract and tuple(observations.columns) != tuple(OBSERVATIONS_SCHEMA.columns):
        raise ValueError(
            f"{context}: its observation table's columns {list(observations.columns)} are not the "
            f"current {OBSERVATIONS_SCHEMA.name} contract's {list(OBSERVATIONS_SCHEMA.columns)}"
        )


def load_fit(path: str | Path) -> SurfaceFit:
    """Reload a trusted-owner cache, reconstructing known formats 1 and 2 without refitting.

    Format 1 retained the posterior and predictive graph but stored an obsolete scalar prior SD.
    Reconstruction keeps the expensive scientific work and discards only that scalar; unknown or
    incomplete payloads refuse rather than guessing. Formats 1 and 2 did not record the table the
    fit consumed, so they load with `observations=None` and cannot publish a new artifact. A
    format-3 table needs only to be there, with integer `ac` and `an`: it is not held to the
    current contract here, which publishing re-checks. The input file is never rewritten.
    """
    import cloudpickle

    from genomeos.surfaces.fit import SurfaceFit

    with Path(path).open("rb") as stream:
        payload = cloudpickle.load(stream)
    fit_format = payload.get("format") if isinstance(payload, dict) else None
    if (
        isinstance(fit_format, bool)
        or not isinstance(fit_format, int)
        or fit_format not in READABLE_FIT_FORMATS
    ):
        raise ValueError(
            f"{path} is not a surface fit of a supported format (readable: "
            f"{', '.join(map(str, sorted(READABLE_FIT_FORMATS)))}); "
            "preserve it and investigate rather than guessing"
        )
    fit = payload.get("fit")
    if fit_format != 1 and not isinstance(fit, SurfaceFit):
        raise ValueError(f"{path}: format {fit_format} payload does not contain a SurfaceFit")
    missing = [field for field in _FIT_FIELDS if not hasattr(fit, field)]
    if missing:
        raise ValueError(f"{path}: surface fit is missing required fields {missing}")
    if not isinstance(fit.config, FitConfig):
        raise ValueError(f"{path}: surface fit does not contain a valid FitConfig configuration")
    model = fit._model
    named_vars = getattr(model, "named_vars", {})
    missing_nodes = [name for name in ("x_pred", "freq_pred") if name not in named_vars]
    if missing_nodes:
        raise ValueError(f"{path}: retained model is missing predictive nodes {missing_nodes}")
    if fit_format == FIT_FORMAT and isinstance(fit, SurfaceFit):
        _require_observations(fit, str(path), current_contract=False)
        return fit
    fields = {field: getattr(fit, field) for field in _FIT_FIELDS}
    for metadata_field in ("prediction_metadata", "footprint_metadata"):
        if hasattr(fit, metadata_field):
            fields[metadata_field] = getattr(fit, metadata_field)
    return SurfaceFit(**fields, observations=None)
