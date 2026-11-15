"""Immutable per-cell surface artifacts (design §5, §6, §7.1b).

§5 says artifacts are **immutable and keyed by** ``(variant_id, model_version, data_version)``:
a model change publishes new artifacts and never mutates a map someone has cited. Until now
nothing wrote them, which is why every figure cost a refit and why a fitted surface existed only
as a live Python object.

**A fit is not an artifact.** ``surfaces.fit.save_fit`` pickles the PyMC graph so predictions are
cheap to repeat, and its own docstring calls that a cache: pickle is coupled to the installed PyMC
and executes arbitrary code on load, so it can be neither archival nor shared. The artifact is
this parquet — per-cell posterior summaries, plain columns, readable by anything that reads
parquet in ten years, and the thing P4's read API is meant to serve (§5: "the read API reads
precomputed artifacts and aggregates them; it never computes science").

**The mask travels with the numbers.** Every row carries its ``support`` state and
``posterior_contraction``, because §4's answer to a persuasive-but-unfounded cline is that a
consumer must be able to tell measured from inferred without going back to the model. An artifact
of values alone would strip exactly the column that makes the surface honest.

Written with ``partition_cols=["variant_id"]`` so one variant can be published, superseded or
withdrawn without rewriting the others — which is what immutability requires in practice.

**The input travels with the output** (#45). Beside ``cells.parquet`` sits ``observations.parquet``,
exactly the table the fit consumed (``surfaces.fit_input``), and the manifest records its sha256,
size, row count, measurement and contract. ``manifest.json`` is written last, so a directory with a
manifest is a directory whose files are all there.

**Format 4** (Atlas data platform design 2026-10-18 §2.5, step 1.11) is what ``publish`` writes now:
format 3's 15 columns plus each cell's ``h3_r0`` (its resolution-0 ancestor) and ``h3_parent_r3``
(its resolution-3 parent, itself at resolution 3), zstd, and row groups of 8,192 rows, so a range
read can skip data. ``publish`` recomputes the parents and refuses any that differ before it creates
the directory, and ``read`` refuses a format-4 ``cells.parquet`` whose parents, compression or row
groups are not these. Formats 1 to 3 stay readable as they were written.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import h3
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from pandas.api.types import is_bool_dtype, is_complex_dtype, is_numeric_dtype

from genomeos.surfaces.fit import SurfaceFit
from genomeos.surfaces.fit_input import (
    OBSERVATIONS_FILE,
    ObservationsRecord,
    load_observations,
    serialize_observations,
)
from genomeos.surfaces.mask import MaskConfig, classify_support
from genomeos.surfaces.prior import PRIOR_DRAWS, PRIOR_NORMALIZATION

#: Bumped when the columns change. Written into the manifest so a reader can refuse an artifact it
#: does not understand rather than silently misreading one. Format 4 is the design's "format 2.1"
#: (§2.5): manifests hold integers, and every reader refuses anything else.
ARTIFACT_FORMAT = 4
READABLE_ARTIFACT_FORMATS = frozenset({1, 2, 3, 4})

#: The quantity a cell value carries. `allele_frequency` counts chromosomes; `carrier_frequency`
#: counts individuals and comes from copy-number-variable genes such as KIR, where there is no
#: diploid genotype to count alleles from (#133).
MEASUREMENTS: tuple[str, ...] = ("allele_frequency", "carrier_frequency")

#: §6's per-cell columns, in order: all of format 3.
FORMAT_THREE_COLUMNS: tuple[str, ...] = (
    "h3_index",
    "variant_id",
    "post_median",
    "post_mean",
    "post_sd",
    "prior_frequency_sd",
    "q025",
    "q975",
    "q25",
    "q75",
    "support",
    "posterior_contraction",
    "dist_nearest_obs_km",
    "model_version",
    "data_version",
)
#: Format 4's additions (§2.5): each cell's resolution-0 ancestor and resolution-3 parent.
H3_PARENT_COLUMNS: tuple[str, ...] = ("h3_r0", "h3_parent_r3")
ARTIFACT_COLUMNS: tuple[str, ...] = FORMAT_THREE_COLUMNS + H3_PARENT_COLUMNS
#: How format 4 writes ``cells.parquet`` (§2.5): zstd, and row groups an HTTP range read can skip.
CELLS_COMPRESSION = "zstd"
CELLS_ROW_GROUP_ROWS = 8192
#: ``h3_parent_r3`` exists only for a cell at resolution 3 or finer.
MIN_FORMAT_FOUR_RESOLUTION = 3
_MAX_H3_RESOLUTION = 15

_EARTH_RADIUS_KM = 6371.0088


def _haversine_km(lat1, lon1, lat2, lon2):
    dlat, dlon = np.radians(lat2 - lat1), np.radians(lon2 - lon1)
    a = (
        np.sin(dlat / 2) ** 2
        + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(dlon / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_KM * np.arcsin(np.sqrt(a))


@dataclass(frozen=True)
class ArtifactManifest:
    """What was published, keyed as §5 requires, so an artifact can be cited and superseded."""

    variant_id: str
    model_version: str
    data_version: str
    resolution: int
    n_cells: int
    correlation_range_km: float
    prior_normalization: str
    prior_draws: int
    prior_seed: int
    likelihood: str
    lengthscale_sigma: float
    n_observations: int
    support_counts: dict[str, int]
    #: Population-supported cell selection is part of what the artifact means. It is required for
    #: new writes so a small-island cell cannot appear without a named denominator grid.
    target_grid_source: str
    target_grid_version: str
    #: What the per-cell numbers mean. Required, with no default: an artifact holding carrier
    #: frequencies over individuals and one holding allele frequencies over chromosomes are
    #: indistinguishable by inspection, and a consumer that averages across both is wrong in a way
    #: nothing downstream can detect (#133). A publisher that cannot say which it holds is
    #: incomplete, not ready to publish.
    measurement: str
    #: The identity of `observations.parquet`, the table the fit consumed (#45). Required, with no
    #: default: an artifact whose input cannot be named is not ready to publish. Its measurement is
    #: this manifest's, so a carrier surface's input is published under the carrier contract.
    observations: ObservationsRecord
    artifact_format: int = ARTIFACT_FORMAT

    def __post_init__(self) -> None:
        if (
            isinstance(self.artifact_format, bool)
            or not isinstance(self.artifact_format, int)
            or self.artifact_format != ARTIFACT_FORMAT
        ):
            raise ValueError(f"new manifests must use artifact_format {ARTIFACT_FORMAT}")
        _require_format_four_resolution(self.resolution, context="new manifest")
        if self.measurement not in MEASUREMENTS:
            raise ValueError(
                f"unknown measurement {self.measurement!r}; expected one of {MEASUREMENTS}"
            )
        if not self.target_grid_source.strip():
            raise ValueError("target_grid_source must be non-empty")
        if not self.target_grid_version.strip():
            raise ValueError("target_grid_version must be non-empty")
        if self.prior_normalization != PRIOR_NORMALIZATION:
            raise ValueError(f"prior_normalization must be {PRIOR_NORMALIZATION!r}")
        if (
            isinstance(self.prior_draws, bool)
            or not isinstance(self.prior_draws, int)
            or self.prior_draws != PRIOR_DRAWS
        ):
            raise ValueError(f"prior_draws must be {PRIOR_DRAWS}")
        if (
            isinstance(self.prior_seed, bool)
            or not isinstance(self.prior_seed, int)
            or self.prior_seed < 0
        ):
            raise ValueError("prior_seed must be a nonnegative integer")
        if not isinstance(self.observations, ObservationsRecord):
            raise ValueError("observations must be the ObservationsRecord of the fit's input")
        if self.observations.row_count != self.n_observations:
            raise ValueError(
                f"n_observations {self.n_observations} differs from the input's "
                f"row_count {self.observations.row_count}"
            )
        if self.observations.measurement != self.measurement:
            raise ValueError(
                f"measurement {self.measurement!r} differs from the input's "
                f"{self.observations.measurement!r}: a surface's counts are of one quantity (#133)"
            )

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True) + "\n"


def cell_table(
    fit: SurfaceFit,
    *,
    h3_index: list[str],
    lat: np.ndarray,
    lon: np.ndarray,
    observations: pd.DataFrame,
    variant_id: str,
    model_version: str,
    data_version: str,
    mask_config: MaskConfig | None = None,
) -> pd.DataFrame:
    """Per-cell posterior summaries with their support state, ready to publish.

    `observations` is needed for `dist_nearest_obs_km`, which is what the mask is computed from —
    the artifact carries the distance as well as the verdict so a consumer can apply a stricter
    threshold without refitting.
    """
    predicted = fit.predict(lat=lat, lon=lon)
    distance = np.min(
        _haversine_km(
            lat[:, None], lon[:, None],
            observations["lat"].to_numpy()[None, :], observations["lon"].to_numpy()[None, :],
        ),
        axis=1,
    )
    prior_sd = np.asarray(fit.prior_frequency_sd_at(lat=lat, lon=lon), dtype=float)
    if prior_sd.shape != (len(lat),) or not np.isfinite(prior_sd).all() or (prior_sd <= 0).any():
        raise ValueError("prior frequency SD must be an aligned finite positive vector")
    contraction = predicted["post_sd"].to_numpy() / prior_sd
    support = classify_support(
        has_observation_centre=distance < 50.0,
        dist_nearest_obs_km=distance,
        posterior_contraction=contraction,
        correlation_range_km=fit.correlation_range_km,
        config=mask_config or MaskConfig(),
    )
    frame = pd.DataFrame(
        {
            "h3_index": h3_index,
            "variant_id": variant_id,
            "post_median": predicted["post_median"].to_numpy(),
            "post_mean": predicted["post_mean"].to_numpy(),
            "post_sd": predicted["post_sd"].to_numpy(),
            "prior_frequency_sd": prior_sd,
            "q025": predicted["q025"].to_numpy(),
            "q975": predicted["q975"].to_numpy(),
            "q25": predicted["q25"].to_numpy(),
            "q75": predicted["q75"].to_numpy(),
            "support": support,
            "posterior_contraction": contraction,
            "dist_nearest_obs_km": distance,
            "model_version": model_version,
            "data_version": data_version,
            "h3_r0": [h3.cell_to_parent(cell, 0) for cell in h3_index],
            "h3_parent_r3": [h3.cell_to_parent(cell, 3) for cell in h3_index],
        },
        columns=list(ARTIFACT_COLUMNS),
    )
    return frame


def publish(
    frame: pd.DataFrame,
    root: Path,
    *,
    manifest: ArtifactManifest,
    observations: pd.DataFrame,
    overwrite: bool = False,
) -> Path:
    """Write one variant's artifact, the table its fit consumed, and its manifest under `root`.

    Refuses to overwrite by default. §5's immutability is the point: a model change publishes new
    artifacts under a new `model_version` rather than replacing a map someone has already cited,
    and a silent overwrite is precisely the failure that guarantee exists to prevent.

    `observations` is the fit's own record of its input (`SurfaceFit.observations`), in its
    `ac`/`an` shape. Its bytes are re-derived here under `manifest.measurement`'s contract (a
    carrier input is written as `carriers`/`n_individuals`, #133) and must be the ones
    `manifest.observations` names, and every row must belong to the artifact's variant. Everything
    is checked before the directory is created, and the manifest is written last.

    The cells are written as format 4 (§2.5): their `h3_r0` and `h3_parent_r3` must be the ones
    recomputed from `h3_index`, at the manifest's resolution, and the file is zstd in 8,192-row groups.
    """
    _validate_current(frame, manifest.__dict__, context="surface artifact")
    _validate_h3_parents(frame, manifest.resolution, context="surface artifact")
    payload, record = serialize_observations(observations, measurement=manifest.measurement)
    if record != manifest.observations:
        raise ValueError(
            "manifest.observations does not describe the observation table being published; build it "
            "with fit_input.observations_record() from the same table and measurement"
        )
    variants = sorted(set(observations["variant_id"].astype(str)))
    if variants != [manifest.variant_id]:
        raise ValueError(
            f"the input holds rows for {variants}, so it is not the input of {manifest.variant_id!r}'s "
            "artifact"
        )
    root = Path(root)
    stem = manifest.variant_id.replace(":", "__")
    directory = root / f"{stem}__{manifest.model_version}__{manifest.data_version}"
    if directory.exists() and not overwrite:
        raise FileExistsError(
            f"{directory} already exists. Artifacts are immutable (§5): publish under a new "
            "model_version rather than overwriting, or pass overwrite=True deliberately."
        )
    directory.mkdir(parents=True, exist_ok=True)
    # An overwritten directory loses its old manifest first, so no manifest ever describes a
    # half-written set of files.
    (directory / "manifest.json").unlink(missing_ok=True)
    frame.to_parquet(
        directory / "cells.parquet",
        index=False,
        compression=CELLS_COMPRESSION,
        row_group_size=CELLS_ROW_GROUP_ROWS,
    )
    (directory / OBSERVATIONS_FILE).write_bytes(payload)
    (directory / "manifest.json").write_text(manifest.to_json())
    return directory


def read(directory: Path) -> tuple[pd.DataFrame, dict]:
    """Read a published artifact and its manifest, refusing an unknown format."""
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    artifact_format = manifest.get("artifact_format")
    if (
        isinstance(artifact_format, bool)
        or not isinstance(artifact_format, int)
        or artifact_format not in READABLE_ARTIFACT_FORMATS
    ):
        raise ValueError(
            f"{directory} is artifact_format {artifact_format!r}; "
            f"this build reads {sorted(READABLE_ARTIFACT_FORMATS)}"
        )
    if artifact_format == 4:
        _require_cells_encoding(directory / "cells.parquet", context=str(directory))
    frame = pd.read_parquet(directory / "cells.parquet")
    if artifact_format >= 2:
        for field in ("target_grid_source", "target_grid_version"):
            value = manifest.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(
                    f"{directory}: artifact_format {artifact_format} requires non-empty {field}"
                )
    if artifact_format >= 3:
        _validate_current(frame, manifest, context=str(directory))
    if artifact_format == 4:
        _validate_h3_parents(frame, manifest.get("resolution"), context=str(directory))
    return frame, manifest


def read_observations(directory: Path) -> pd.DataFrame:
    """The table an artifact's fit consumed, refusing bytes its manifest does not name (#45).

    Returned under its contract's own column names: a carrier artifact's input is
    `carriers`/`n_individuals`, which `afnd_carriers.as_binomial` turns back into the fit's frame.
    """
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    record = manifest.get("observations")
    if record is None:
        raise ValueError(
            f"{directory} does not carry the observation table its fit consumed: it was published "
            "before inputs travelled with outputs (#45)"
        )
    frame = load_observations((directory / OBSERVATIONS_FILE).read_bytes(), record, context=str(directory))
    if len(frame) != manifest.get("n_observations"):
        raise ValueError(f"{directory}: the input's rows differ from n_observations")
    if record["measurement"] != manifest.get("measurement"):
        raise ValueError(
            f"{directory}: the input's measurement {record['measurement']!r} is not the artifact's "
            f"{manifest.get('measurement')!r} (#133)"
        )
    return frame


def _validate_current(frame: pd.DataFrame, manifest: dict, *, context: str) -> None:
    """Validate format-3 normalization (formats 3 and 4) without changing stored binary64 values."""
    artifact_format = manifest.get("artifact_format")
    if "prior_frequency_sd" in manifest:
        raise ValueError(
            f"{context}: format {artifact_format} stores prior_frequency_sd per cell, not in manifest"
        )
    for field in ("prior_normalization", "prior_draws", "prior_seed"):
        if field not in manifest:
            raise ValueError(f"{context}: artifact_format {artifact_format} requires {field}")
    if manifest["prior_normalization"] != PRIOR_NORMALIZATION:
        raise ValueError(f"{context}: unsupported prior_normalization")
    if (
        isinstance(manifest["prior_draws"], bool)
        or not isinstance(manifest["prior_draws"], int)
        or manifest["prior_draws"] != PRIOR_DRAWS
    ):
        raise ValueError(f"{context}: prior_draws must be {PRIOR_DRAWS}")
    seed = manifest["prior_seed"]
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError(f"{context}: prior_seed must be a nonnegative integer")
    if manifest.get("measurement") not in MEASUREMENTS:
        raise ValueError(f"{context}: unknown measurement {manifest.get('measurement')!r}")
    missing = set(FORMAT_THREE_COLUMNS) - set(frame.columns)
    if missing:
        raise ValueError(f"{context}: missing format-3 columns {sorted(missing)}")
    values: dict[str, np.ndarray] = {}
    for field in ("prior_frequency_sd", "post_sd", "posterior_contraction"):
        series = frame[field]
        if (
            is_bool_dtype(series.dtype)
            or is_complex_dtype(series.dtype)
            or not is_numeric_dtype(series.dtype)
        ):
            raise ValueError(f"{context}: {field} must have a numeric, non-Boolean dtype")
        values[field] = series.to_numpy(dtype=np.float64, na_value=np.nan)
    prior_sd = values["prior_frequency_sd"]
    post_sd = values["post_sd"]
    contraction = values["posterior_contraction"]
    if prior_sd.shape != (len(frame),) or not np.isfinite(prior_sd).all() or (prior_sd <= 0).any():
        raise ValueError(f"{context}: prior_frequency_sd must be finite and positive per cell")
    if (
        not np.isfinite(post_sd).all()
        or not np.isfinite(contraction).all()
        or (post_sd < 0).any()
        or (contraction < 0).any()
    ):
        raise ValueError(
            f"{context}: post_sd and posterior_contraction must be finite and nonnegative"
        )
    if not np.allclose(contraction, post_sd / prior_sd, rtol=1e-12, atol=0):
        raise ValueError(f"{context}: posterior_contraction is inconsistent with per-cell SDs")


def _require_format_four_resolution(resolution: object, *, context: str) -> int:
    if (
        isinstance(resolution, bool)
        or not isinstance(resolution, int)
        or not MIN_FORMAT_FOUR_RESOLUTION <= resolution <= _MAX_H3_RESOLUTION
    ):
        raise ValueError(
            f"{context}: resolution {resolution!r} is not an H3 resolution from "
            f"{MIN_FORMAT_FOUR_RESOLUTION} to {_MAX_H3_RESOLUTION}; format 4's h3_parent_r3 needs "
            f"cells at resolution {MIN_FORMAT_FOUR_RESOLUTION} or finer"
        )
    return resolution


def _validate_h3_parents(frame: pd.DataFrame, resolution: int, *, context: str) -> None:
    """Format 4: every cell is at the manifest's ``resolution``, and its ``h3_r0`` and ``h3_parent_r3``
    are the ones recomputed from ``h3_index``, never trusted as written."""
    resolution = _require_format_four_resolution(resolution, context=context)
    missing = [column for column in H3_PARENT_COLUMNS if column not in frame.columns]
    if missing:
        raise ValueError(f"{context}: missing format-4 columns {missing}")
    cells = frame["h3_index"].tolist()
    off = [
        cell
        for cell in cells
        if not isinstance(cell, str) or not h3.is_valid_cell(cell) or h3.get_resolution(cell) != resolution
    ]
    if off:
        raise ValueError(
            f"{context}: {len(off)} cells are not H3 cells at the manifest's resolution {resolution}, "
            f"e.g. {off[0]!r}"
        )
    for column, parent_resolution in (("h3_r0", 0), ("h3_parent_r3", 3)):
        for cell, written in zip(cells, frame[column].tolist(), strict=True):
            expected = h3.cell_to_parent(cell, parent_resolution)
            if written != expected:
                raise ValueError(
                    f"{context}: {column} of {cell} is {written!r}, not its resolution-"
                    f"{parent_resolution} parent {expected}"
                )


def _require_cells_encoding(path: Path, *, context: str) -> None:
    """Format 4: every column chunk is zstd, and every row group but the last holds 8,192 rows (the
    last at most that), as ``publish`` writes them (§2.5)."""
    metadata = pq.ParquetFile(path).metadata
    sizes: list[int] = []
    for index in range(metadata.num_row_groups):
        group = metadata.row_group(index)
        sizes.append(group.num_rows)
        for column in range(group.num_columns):
            chunk = group.column(column)
            if chunk.compression != CELLS_COMPRESSION.upper():
                raise ValueError(
                    f"{context}: {path.name} column {chunk.path_in_schema} in row group {index} is "
                    f"{chunk.compression}, not {CELLS_COMPRESSION} as format 4 requires"
                )
    if any(size != CELLS_ROW_GROUP_ROWS for size in sizes[:-1]) or (
        sizes and sizes[-1] > CELLS_ROW_GROUP_ROWS
    ):
        raise ValueError(
            f"{context}: {path.name} row groups hold {sizes} rows; format 4 writes {CELLS_ROW_GROUP_ROWS:,} "
            "rows in each but the last"
        )
