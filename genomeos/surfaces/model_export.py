"""A trained surface exported without pickle, and rebuilt from code (Atlas data platform design 2026-10-18
§2.1, §2.3, step 1.12; #471).

§2.1 publishes trained models under ``store/models/<artifact-id>/``, "safe export; pickles never".
``save_fit`` is a cloudpickle of the live PyMC graph: coupled to the installed PyMC, and it runs code
when loaded, so it can never be shared. An export instead holds only what the graph cannot recompute:

- ``model.json``: the fit's configuration and the facts its artifact is checked against, as canonical
  JSON (sorted keys, ``allow_nan=False``);
- ``inducing_points.npy``: the inducing points, ``(0, 3)`` under hsgp;
- ``posterior/<name>.npy``: one float64 array per free random variable, ``(chains, draws, *shape)``.
  Deterministics such as ``f``, ``p`` and ``freq_pred`` are recomputed from these, so none is stored;
- ``manifest.json``, written last: the artifact it belongs to, the sha256 of that artifact's fit input,
  and the sha256 and size of every other file.

The layout (these file names and the manifest's keys) is ``genomeos.publication.model_exports``'s, the
pure rule a release checks an export against, imported from there so that the two cannot drift.

Arrays are ``.npy`` format 1.0, written and read with ``allow_pickle=False``. The loader rebuilds the
graph with ``build_surface_model`` from the artifact's own ``observations.parquet`` (#45), so the graph
and the draws can only meet if the code still builds the model the draws came from: every refusal is a
hard error (v1 §12), never a guess.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import platform
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict, fields
from pathlib import Path
from typing import Any

import arviz as az
import h3
import numpy as np
import pandas as pd
import pymc as pm
import pytensor

import genomeos
from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.observations.sources.afnd_carriers import as_binomial
from genomeos.publication.model_exports import (
    EXPORT_SCHEMA,
    FILE_FIELDS,
    INDUCING_FILE,
    MANIFEST_FIELDS,
    MODEL_FILE,
    MODEL_MANIFEST,
    POSTERIOR_DIR,
    POSTERIOR_FILE,
)
from genomeos.surfaces.artifacts import read_observations
from genomeos.surfaces.fit import (
    FitConfig,
    SurfaceFit,
    SurfaceModel,
    build_surface_model,
    free_variable_shapes,
    surface_fit_from,
)

#: The format this exporter writes; a release accepts ``model_exports.EXPORT_FORMATS``.
EXPORT_FORMAT = 1
#: How many of an artifact's cells a rebuilt fit must reproduce, and how closely.
REPRODUCTION_SAMPLE = 64
REPRODUCTION_ATOL = 1e-6

_MODEL_FIELDS = frozenset(
    {
        "variant_id",
        "config",
        "beta_design_applied",
        "beta_cohort_applied",
        "design_levels",
        "lengthscale_prior_km",
        "inducing_spacing_ratio",
        "correlation_range_km",
        "free_variables",
    }
)
_SHA256 = re.compile(r"[0-9a-f]{64}")
#: The artifact columns `predict` recomputes; `require_reproduces_cells` also recomputes the prior SD.
_SUMMARIES = ("post_median", "post_mean", "post_sd", "q025", "q975", "q25", "q75")
#: The artifact manifest's record of the fit, and the fit's own value of each.
_FIT_IDENTITY = (
    ("variant_id", lambda fit: fit.variant_id),
    ("likelihood", lambda fit: fit.config.likelihood),
    ("lengthscale_sigma", lambda fit: fit.config.lengthscale_sigma),
    ("prior_seed", lambda fit: fit.config.seed),
    ("correlation_range_km", lambda fit: fit.correlation_range_km),
)


def export_model(fit: SurfaceFit, artifact_dir: Path, out_root: Path) -> Path:
    """Write `fit` as the model of the artifact in `artifact_dir`, to `out_root/<artifact-id>/`.

    Everything is checked before anything is written: the artifact's fit input (renamed back by
    ``as_binomial`` for a carrier artifact) is the table the fit consumed; its manifest's variant,
    likelihood, sigma, seed and correlation range are the fit's; ``build_surface_model`` rebuilds the
    fit's design levels, flags, lengthscale prior and free-variable shapes from that input; and the
    target directory does not exist. A fit with an observation footprint is refused: the export does
    not carry its support points, so no loader could rebuild its graph.
    """
    artifact_dir, out_root = Path(artifact_dir), Path(out_root)
    target = out_root / artifact_dir.name
    if fit.footprint_metadata is not None:
        raise ValueError(
            f"{fit.variant_id}: the fit consumed observation footprint support points, which neither the "
            "artifact nor the export carries, so its graph cannot be rebuilt from code"
        )
    if fit.observations is None:
        raise ValueError(f"{fit.variant_id}: the fit did not record its fit input, so no export can name it")
    manifest = _artifact_manifest(artifact_dir)
    if not _fit_input(artifact_dir, manifest).equals(fit.observations):
        raise ValueError(f"{artifact_dir}: its observations.parquet is not the fit input of this fit")
    for key, fitted in _FIT_IDENTITY:
        if manifest.get(key) != fitted(fit):
            raise ValueError(
                f"{artifact_dir}: the artifact records {key} {manifest.get(key)!r}, the fit "
                f"{fitted(fit)!r}, so it is not this fit's artifact"
            )
    if target.exists():
        raise FileExistsError(f"{target} already exists; an export is written once")

    built = build_surface_model(fit.observations, fit.config)
    shapes = free_variable_shapes(built.model)
    for key, fitted, rebuilt in (
        ("design_levels", tuple(fit.design_levels), built.design_levels[1:]),
        ("beta_design_applied", fit.beta_design_applied, built.beta_design_applied),
        ("beta_cohort_applied", fit.beta_cohort_applied, built.beta_cohort_applied),
        (
            "lengthscale_prior_km",
            _json_floats(fit.lengthscale_prior_km),
            _json_floats(built.lengthscale_prior_km),
        ),
    ):
        _require_equal(key, fitted, rebuilt, source="the fit")
    posterior = fit.idata.posterior
    missing = [name for name in shapes if name not in posterior.data_vars]
    if missing:
        raise ValueError(f"{fit.variant_id}: the posterior has no draws of the free variables {missing}")
    draws: dict[str, np.ndarray] = {}
    for name, shape in shapes.items():
        values = np.ascontiguousarray(posterior[name].to_numpy())
        if values.dtype != np.float64 or values.shape != (fit.config.chains, fit.config.draws, *shape):
            raise ValueError(
                f"{fit.variant_id} posterior {name}: {values.dtype} {values.shape}, not float64 "
                f"{(fit.config.chains, fit.config.draws, *shape)} as the rebuilt model needs"
            )
        draws[name] = values

    record = {
        "variant_id": fit.variant_id,
        "config": asdict(fit.config),  # `hsgp_m`, a tuple, is written as a JSON array
        "beta_design_applied": fit.beta_design_applied,
        "beta_cohort_applied": fit.beta_cohort_applied,
        "design_levels": list(fit.design_levels),
        "lengthscale_prior_km": _json_floats(fit.lengthscale_prior_km),
        "inducing_spacing_ratio": fit.inducing_spacing_ratio,
        "correlation_range_km": fit.correlation_range_km,
        "free_variables": {name: list(shape) for name, shape in shapes.items()},
    }
    payloads = {MODEL_FILE: _canonical(record), INDUCING_FILE: _npy(built.inducing)}
    payloads.update({f"{POSTERIOR_DIR}/{name}.npy": _npy(values) for name, values in draws.items()})
    export_manifest = {
        "schema": EXPORT_SCHEMA,
        "export_format": EXPORT_FORMAT,
        "artifact": artifact_dir.name,
        "fit_input_sha256": manifest["observations"]["sha256"],
        "files": {
            name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            for name, data in sorted(payloads.items())
        },
        "software": _software(),
    }
    out_root.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    (target / POSTERIOR_DIR).mkdir()
    for name, data in payloads.items():
        with (target / name).open("xb") as stream:
            stream.write(data)
    with (target / MODEL_MANIFEST).open("xb") as stream:
        stream.write(_canonical(export_manifest))
    return target


def load_model_export(model_dir: Path, artifact_dir: Path) -> SurfaceFit:
    """Rebuild the fit `model_dir` exports for the artifact in `artifact_dir`, without unpickling.

    In order, it requires: (1) a closed manifest of this schema and format, naming this artifact, that
    lists exactly the files on disk with their sha256; (2) that the artifact's fit input is the one the
    export was made from; (3) a ``config`` holding exactly ``FitConfig``'s fields; (4) that
    ``build_surface_model`` over that input rebuilds ``model.json``'s levels, flags, prior and free
    variables, and the inducing points; (5) a posterior holding exactly the rebuilt free variables,
    naming any missing and any unknown, each float64 ``(chains, draws, *shape)``.
    """
    model_dir, artifact_dir = Path(model_dir), Path(artifact_dir)
    manifest = _read_export_manifest(model_dir, artifact_dir.name)
    artifact = _artifact_manifest(artifact_dir)
    if artifact["observations"]["sha256"] != manifest["fit_input_sha256"]:
        raise ValueError(
            f"{model_dir} was exported from fit input {manifest['fit_input_sha256']}, but {artifact_dir}'s "
            f"fit input is {artifact['observations']['sha256']}"
        )
    observations = _fit_input(artifact_dir, artifact)
    record = _closed_json(model_dir / MODEL_FILE, _MODEL_FIELDS)
    config = _config(record["config"])
    built = build_surface_model(observations, config)
    shapes = free_variable_shapes(built.model)
    _require_rebuilt(model_dir, record, built, shapes)
    posterior = _read_posterior(model_dir, manifest["files"], shapes, config)
    idata = az.from_dict(
        {
            "posterior": posterior,
            # What `pm.sample` records, so predictive sampling sees the training data as unchanged.
            "constant_data": {data.name: np.asarray(data.get_value()) for data in built.model.data_vars},
        }
    )
    # `fit_surface`'s own constructor. The variant is `model.json`'s (`_require_rebuilt`), and the graph
    # was built without footprint support, which `export_model` refuses.
    return surface_fit_from(
        built,
        config,
        idata,
        correlation_range_km=record["correlation_range_km"],
        inducing_spacing_ratio=record["inducing_spacing_ratio"],
    )


def require_reproduces_cells(fit: SurfaceFit, cells: pd.DataFrame) -> None:
    """Refuse `fit` unless it recomputes the first `REPRODUCTION_SAMPLE` of an artifact's `cells`.

    Each cell is predicted at its H3 centre, as ``scripts/publish_artifacts.py`` predicts it, and every
    recomputed column must agree to `REPRODUCTION_ATOL` with no relative slack; the columns that drift
    are named.
    """
    sample = cells.iloc[:REPRODUCTION_SAMPLE]
    if sample.empty:
        raise ValueError("there are no cells to reproduce")
    variants = sorted(set(sample["variant_id"].astype(str)))
    if variants != [fit.variant_id]:
        raise ValueError(f"the cells are of {variants}, not of {fit.variant_id!r}")
    centres = np.array([h3.cell_to_latlng(cell) for cell in sample["h3_index"]], dtype=float)
    predicted = fit.predict(lat=centres[:, 0], lon=centres[:, 1])
    recomputed = {column: predicted[column].to_numpy() for column in _SUMMARIES}
    # The mask's denominator: a graph with another prior would reproduce the posterior and not this.
    recomputed["prior_frequency_sd"] = fit.prior_frequency_sd_at(lat=centres[:, 0], lon=centres[:, 1])
    drifted = {}
    for column, values in recomputed.items():
        published = sample[column].to_numpy(dtype=np.float64)
        if not np.allclose(values, published, rtol=0.0, atol=REPRODUCTION_ATOL):
            drifted[column] = float(np.max(np.abs(values - published)))
    if drifted:
        raise ValueError(
            f"{fit.variant_id}: the rebuilt fit does not reproduce the published cells within "
            f"{REPRODUCTION_ATOL:g}: "
            + ", ".join(f"{column} differs by up to {gap:.3g}" for column, gap in drifted.items())
        )


def _artifact_manifest(artifact_dir: Path) -> dict[str, Any]:
    """The artifact's manifest, refusing one whose fit input was never published (#45)."""
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("observations"), dict):
        raise ValueError(
            f"{artifact_dir} does not publish its fit input (observations.parquet), so no model can be "
            "bound to it (#45)"
        )
    return manifest


def _fit_input(artifact_dir: Path, manifest: Mapping[str, Any]) -> pd.DataFrame:
    """The artifact's fit input in the fit's `ac`/`an` shape: a carrier input is renamed back (#133)."""
    published = read_observations(artifact_dir)
    if manifest["observations"]["measurement"] == "carrier_frequency":
        published = as_binomial(published)
    return OBSERVATIONS_SCHEMA.validate(published).reset_index(drop=True)


def _read_export_manifest(model_dir: Path, artifact: str) -> dict[str, Any]:
    path = model_dir / MODEL_MANIFEST
    if not path.is_file():
        raise ValueError(f"{model_dir} has no {MODEL_MANIFEST}, so it is not a complete model export")
    manifest = _closed_json(path, MANIFEST_FIELDS)
    if (
        manifest["schema"] != EXPORT_SCHEMA
        or _not_int(manifest["export_format"])
        or manifest["export_format"] != EXPORT_FORMAT
    ):
        raise ValueError(
            f"{path}: schema {manifest['schema']!r} format {manifest['export_format']!r} is not "
            f"{EXPORT_SCHEMA!r} format {EXPORT_FORMAT}"
        )
    if manifest["artifact"] != artifact:
        raise ValueError(f"{path}: it is the model of {manifest['artifact']!r}, not of {artifact!r}")
    if not isinstance(manifest["fit_input_sha256"], str) or not _SHA256.fullmatch(
        manifest["fit_input_sha256"]
    ):
        raise ValueError(f"{path}: fit_input_sha256 {manifest['fit_input_sha256']!r} is not a sha256")
    software = manifest["software"]
    if not isinstance(software, dict) or not all(isinstance(v, str) for v in software.values()):
        raise ValueError(f"{path}: software must map each package to its version string")
    files = manifest["files"]
    if not isinstance(files, dict):
        raise ValueError(f"{path}: files must map each file to its sha256 and bytes")
    for name, entry in files.items():
        if name not in (MODEL_FILE, INDUCING_FILE) and not POSTERIOR_FILE.fullmatch(name):
            raise ValueError(f"{path}: {name!r} is not a file a model export holds")
        if (
            not isinstance(entry, dict)
            or set(entry) != FILE_FIELDS
            or not isinstance(entry["sha256"], str)
            or not _SHA256.fullmatch(entry["sha256"])
            or _not_int(entry["bytes"])
        ):
            raise ValueError(f"{path}: {name!r} must be recorded as exactly a sha256 and a byte count")
    for required in (MODEL_FILE, INDUCING_FILE):
        if required not in files:
            raise ValueError(f"{path}: {required} is not listed")
    on_disk = {
        item.relative_to(model_dir).as_posix() for item in model_dir.rglob("*") if not item.is_dir()
    } - {MODEL_MANIFEST}
    unlisted, absent = sorted(on_disk - set(files)), sorted(set(files) - on_disk)
    if unlisted or absent:
        raise ValueError(
            f"{model_dir}: files not listed in its manifest {unlisted}, listed but missing {absent}"
        )
    for name, entry in sorted(files.items()):
        data = (model_dir / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if (digest, len(data)) != (entry["sha256"], entry["bytes"]):
            raise ValueError(
                f"{model_dir / name}: sha256 {digest} ({len(data)} bytes), but the manifest records "
                f"{entry['sha256']} ({entry['bytes']} bytes)"
            )
    return manifest


def _config(value: object) -> FitConfig:
    """Exactly `FitConfig`'s fields, each of its default's JSON type, so no setting is ever defaulted."""
    if not isinstance(value, dict):
        raise ValueError(f"{MODEL_FILE} config is not a JSON object")
    _require_names(f"{MODEL_FILE} config", set(value), {field.name: None for field in fields(FitConfig)})
    settings: dict[str, Any] = {}
    for field in fields(FitConfig):
        default, given = field.default, value[field.name]
        if isinstance(default, tuple):
            valid = isinstance(given, list) and not any(_not_int(item) for item in given)
            given = tuple(given) if valid else given
        elif isinstance(default, bool):
            valid = isinstance(given, bool)
        elif isinstance(default, int):
            valid = not _not_int(given)
        elif isinstance(default, float):
            valid = isinstance(given, (int, float)) and not isinstance(given, bool)
            given = float(given) if valid else given
        else:
            valid = isinstance(given, type(default))
        if not valid:
            raise ValueError(f"{MODEL_FILE} config {field.name} {given!r} is not a {type(default).__name__}")
        settings[field.name] = given
    return FitConfig(**settings)


def _require_rebuilt(
    model_dir: Path, record: Mapping[str, Any], built: SurfaceModel, shapes: Mapping[str, tuple[int, ...]]
) -> None:
    """`model.json` and the inducing points are what `build_surface_model` rebuilds from the input."""
    _require_equal("variant_id", record["variant_id"], str(built.observations["variant_id"].iloc[0]))
    _require_equal("design_levels", record["design_levels"], list(built.design_levels[1:]))
    _require_equal("beta_design_applied", record["beta_design_applied"], built.beta_design_applied)
    _require_equal("beta_cohort_applied", record["beta_cohort_applied"], built.beta_cohort_applied)
    _require_equal(
        "lengthscale_prior_km", record["lengthscale_prior_km"], _json_floats(built.lengthscale_prior_km)
    )
    free = record["free_variables"]
    if not isinstance(free, dict):
        raise ValueError(f"{MODEL_FILE} free_variables is not a JSON object")
    _require_names(f"{MODEL_FILE} free_variables", set(free), shapes)
    _require_equal("free_variables", free, {name: list(shape) for name, shape in shapes.items()})
    for key, nullable in (("correlation_range_km", False), ("inducing_spacing_ratio", True)):
        value = record[key]
        if not (value is None and nullable) and (
            not isinstance(value, float) or not math.isfinite(value) or value <= 0
        ):
            raise ValueError(f"{MODEL_FILE} {key} {value!r} is not a positive finite number")
    inducing = _load_npy(model_dir, INDUCING_FILE)
    if inducing.shape != built.inducing.shape or not np.array_equal(inducing, built.inducing):
        raise ValueError(f"{INDUCING_FILE} is not the inducing points the rebuilt model places")


def _read_posterior(
    model_dir: Path, files: Mapping[str, Any], shapes: Mapping[str, tuple[int, ...]], config: FitConfig
) -> dict[str, np.ndarray]:
    stems = {match.group(1) for name in files if (match := POSTERIOR_FILE.fullmatch(name))}
    _require_names(f"{POSTERIOR_DIR}/", stems, shapes)
    posterior = {}
    for name, shape in shapes.items():
        values = _load_npy(model_dir, f"{POSTERIOR_DIR}/{name}.npy")
        expected = (config.chains, config.draws, *shape)
        if values.shape != expected:
            raise ValueError(f"{POSTERIOR_DIR}/{name}.npy has shape {values.shape}, not {expected}")
        posterior[name] = values
    return posterior


def _load_npy(model_dir: Path, name: str) -> np.ndarray:
    """An `.npy` array and nothing else: not an `.npz` archive, and never a pickled object array."""
    with (model_dir / name).open("rb") as stream:
        try:
            values = np.lib.format.read_array(stream, allow_pickle=False)
        except ValueError as error:
            raise ValueError(f"{name}: {error}") from error
    if values.dtype != np.float64:
        raise ValueError(f"{name} is {values.dtype}, not float64")
    return values


def _closed_json(path: Path, keys: frozenset[str]) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"), parse_constant=_refuse_constant)
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    unknown, missing = sorted(set(value) - keys), sorted(keys - set(value))
    if unknown or missing:
        raise ValueError(f"{path}: unknown fields {unknown}, missing fields {missing}")
    return value


def _require_names(context: str, found: set[str], expected: Mapping[str, Any]) -> None:
    missing, unknown = sorted(set(expected) - found), sorted(found - set(expected))
    if missing or unknown:
        raise ValueError(f"{context}: missing {missing}, unknown {unknown}")


def _require_equal(key: str, recorded: object, rebuilt: object, *, source: str = "the export") -> None:
    if recorded != rebuilt or type(recorded) is not type(rebuilt):
        raise ValueError(f"{key}: {source} records {recorded!r}, the rebuilt model has {rebuilt!r}")


def _json_floats(values: Sequence[float]) -> list[float | None]:
    """A fixed prior's anchors are NaN, which JSON cannot hold: they are written as null."""
    return [None if math.isnan(value) else float(value) for value in values]


def _not_int(value: object) -> bool:
    return isinstance(value, bool) or not isinstance(value, int)


def _refuse_constant(name: str) -> None:
    raise ValueError(f"{name} is not a JSON number; an export is written with allow_nan=False")


def _canonical(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n").encode(
        "utf-8"
    )


def _npy(values: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.lib.format.write_array(buffer, np.ascontiguousarray(values), version=(1, 0), allow_pickle=False)
    return buffer.getvalue()


def _software() -> dict[str, str]:
    """What wrote the export. Informational: the loader rebuilds from the installed code."""
    return {
        "python": platform.python_version(),
        "genomeos": genomeos.__version__,
        "numpy": np.__version__,
        "pymc": pm.__version__,
        "pytensor": pytensor.__version__,
        "arviz": az.__version__,
    }
