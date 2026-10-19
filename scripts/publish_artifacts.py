"""Publish per-cell surface artifacts from saved fits (design §5, §6).

    python scripts/publish_artifacts.py --fits data/store/fits --out data/store/artifacts \
        --hbs data/curated/map_hbs_surveys.csv --g6pd data/raw/map_g6pd_surveys.csv \
        --population-cells data/store/worldpop-res4-2020.parquet \
        --population-source worldpop-1km-unconstrained \
        --population-version Global_2000_2020/2020/0_Mosaicked/ppp_2020_1km_Aggregated.tif \
        --h3-res 4

    python scripts/publish_artifacts.py --fits data/store/screen --out data/store/artifacts \
        --afnd data/raw/afnd_frequencies.tsv --afnd-populations data/raw/afnd_populations.tsv \
        --data-version afnd-2026-08 \
        --population-cells data/store/worldpop-res4-2020.parquet \
        --population-source worldpop-1km-unconstrained \
        --population-version Global_2000_2020/2020/0_Mosaicked/ppp_2020_1km_Aggregated.tif \
        --h3-res 4

Reads the fits `build_surfaces.py` saved and writes the immutable parquet each variant is meant to
be cited as. Separated from fitting on purpose: fitting is expensive and environment-coupled,
publishing is cheap and must be repeatable, and a figure or a national rollup should read the
artifact rather than re-running NUTS.

Each artifact carries `observations.parquet`, the table its fit consumed, taken from the fit's own
record (`SurfaceFit.observations`, fit format 3) rather than reloaded (#45). The flags still name the
inputs, but only to choose what to publish and to check them: rows that differ from the fit's record
are refused, and so is a fit cached before it recorded its input.

Published artifacts live in the public data store, not in git (data store design 2026-10-17). A
local `data/store/artifacts` may therefore be incomplete, so publishing there also refuses any
directory a committed release already holds, even with `--overwrite`: immutability may not depend on
what happens to be on this disk. New directories reach the store through
`scripts/build_data_release.py` and `scripts/publish_data_store.py`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import h3
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from genomeos.geo.population import PopulationGrid, publication_target_cells  # noqa: E402
from genomeos.observations.schema import OBSERVATIONS_SCHEMA  # noqa: E402
from genomeos.observations.sources import (  # noqa: E402
    afnd_carriers,
    afnd_cytokines,
    afnd_frequencies,
    map_g6pd,
    map_surveys,
)
from genomeos.surfaces.artifacts import ArtifactManifest, cell_table, publish  # noqa: E402
from genomeos.surfaces.fit import load_fit  # noqa: E402
from genomeos.surfaces.fit_input import observations_record  # noqa: E402
from genomeos.surfaces.prior import PRIOR_DRAWS, PRIOR_NORMALIZATION  # noqa: E402

try:
    from scripts.build_population_grid import read_population_grid  # noqa: E402
    from scripts.fetch_data import DATA, released_artifact_dirs  # noqa: E402
except ModuleNotFoundError:  # Direct `python scripts/publish_artifacts.py` entry.
    from build_population_grid import read_population_grid  # noqa: E402
    from fetch_data import DATA, released_artifact_dirs  # noqa: E402

LAYERS = {"hbs": map_surveys.load, "g6pd": map_g6pd.load}


def publication_coordinates(
    population_grid: PopulationGrid,
    observations,
) -> tuple[list[str], np.ndarray, np.ndarray]:
    """Resolve population-backed surface targets without a visual-geography fallback (§7, §9)."""
    required = {"lat", "lon"}
    missing = required - set(observations.columns)
    if missing:
        raise ValueError(f"observations require lat and lon; missing {sorted(missing)}")
    lat = observations["lat"].to_numpy(dtype=float)
    lon = observations["lon"].to_numpy(dtype=float)
    if not np.isfinite(lat).all() or not np.isfinite(lon).all():
        raise ValueError("observation lat and lon must be finite")
    if ((lat < -90) | (lat > 90)).any() or ((lon < -180) | (lon > 180)).any():
        raise ValueError("observation lat and lon are outside geographic bounds")
    cells = publication_target_cells(population_grid)
    centres = np.asarray([h3.cell_to_latlng(cell) for cell in cells], dtype=float)
    return cells, centres[:, 0], centres[:, 1]


def consumed_observations(
    fit, supplied: pd.DataFrame, *, variant_id: str, fit_path: Path
) -> pd.DataFrame:
    """The table `fit` consumed: what its artifact publishes, and what its cells are computed from.

    A fit cached before fit format 3 did not record its input, so what it consumed is unknown and it
    cannot publish a new artifact; refit it. The rows the flags supply must be the fit's own, or the
    artifact would be labelled with one input while its cells came from another (#45).
    """
    recorded = getattr(fit, "observations", None)
    if recorded is None:
        raise SystemExit(
            f"{fit_path}: this fit did not record the observation table it consumed (it predates fit "
            f"format 3), so {variant_id} cannot be published from it. Refit it (#45)."
        )
    if not OBSERVATIONS_SCHEMA.validate(supplied).reset_index(drop=True).equals(recorded):
        raise SystemExit(
            f"{fit_path}: the observations supplied for {variant_id} are not the rows this fit "
            "consumed. Point the flags at the export the fit was made from, or refit (#45)."
        )
    return recorded


def _directory_name(variant_id: str, args) -> str:
    return f"{variant_id.replace(':', '__')}__{args.model_version}__{args.data_version}"


def refuse_released(out: Path, names: list[str]) -> None:
    """Refuse, before any work, a directory a committed data-store release already published (§5)."""
    if Path(out).resolve() != (DATA / "store" / "artifacts").resolve():
        return
    released = released_artifact_dirs()
    clashes = sorted(name for name in names if name in released)
    if clashes:
        raise SystemExit(
            "already published in the data store, and artifacts are immutable (§5): "
            + ", ".join(f"{name} (release {released[name]})" for name in clashes)
            + ". Publish under a new --model-version instead; --overwrite never replaces a released one."
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fits", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--hbs", type=Path, help="curated MAP HbS CSV with explicit spatial support")
    ap.add_argument("--g6pd", type=Path)
    # AFND holds one file per corpus rather than per variant, so publishing it means publishing
    # every allele the adapter retains, not one named layer.
    ap.add_argument("--afnd", type=Path, help="AFND frequency table; publishes every fit found")
    ap.add_argument("--afnd-populations", type=Path)
    ap.add_argument("--cytokines", action="store_true",
                    help="also publish cytokine loci counted from genotypes (needs --afnd)")
    ap.add_argument("--kir", action="store_true",
                    help="also publish KIR gene presence as CARRIER frequency (needs --afnd)")
    ap.add_argument("--min-populations", type=int, default=30)
    ap.add_argument("--h3-res", type=int, default=3)
    ap.add_argument("--population-cells", type=Path, required=True)
    ap.add_argument("--population-source", required=True)
    ap.add_argument("--population-version", required=True)
    ap.add_argument("--model-version", default="v1")
    ap.add_argument("--data-version", default="map-2026-08")
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()

    population_grid = read_population_grid(args.population_cells)
    if population_grid.resolution != args.h3_res:
        raise SystemExit(
            f"population grid resolution {population_grid.resolution} != --h3-res {args.h3_res}"
        )
    if population_grid.source != args.population_source:
        raise SystemExit(
            f"population grid source {population_grid.source!r} != "
            f"--population-source {args.population_source!r}"
        )
    if population_grid.source_version != args.population_version:
        raise SystemExit(
            f"population grid version {population_grid.source_version!r} != "
            f"--population-version {args.population_version!r}"
        )
    print(population_grid)

    jobs: list[tuple[str, pd.DataFrame]] = []
    for layer, loader in LAYERS.items():
        path = getattr(args, layer)
        if path is None:
            continue
        observations, _ = loader(path, args.data_version)
        jobs.append((str(observations["variant_id"].iloc[0]), observations))

    if args.afnd:
        if not args.afnd_populations:
            raise SystemExit("--afnd needs --afnd-populations")
        corpus, report = afnd_frequencies.load(
            args.afnd, args.afnd_populations, args.data_version,
            min_populations=args.min_populations,
        )
        print(report)
        # Publish every allele that has a fit on disk. Which alleles those are is decided by
        # whatever sweep produced `--fits`, not here, so this stays a publishing step rather than
        # quietly becoming a selection step.
        for variant_id, rows in corpus.groupby("variant_id", sort=True):
            if (args.fits / f"{variant_id.replace(':', '__')}.fit.pkl").exists():
                jobs.append((str(variant_id), rows.reset_index(drop=True)))

    if args.cytokines:
        if not args.afnd or not args.afnd_populations:
            raise SystemExit("--cytokines needs --afnd and --afnd-populations")
        corpus, report = afnd_cytokines.load(
            args.afnd, args.afnd_populations, args.data_version,
            min_populations=args.min_populations,
        )
        print(report)
        for variant_id, rows in corpus.groupby("variant_id", sort=True):
            if (args.fits / f"{variant_id.replace(':', '__')}.fit.pkl").exists():
                jobs.append((str(variant_id), rows.reset_index(drop=True)))

    if args.kir:
        if not args.afnd or not args.afnd_populations:
            raise SystemExit("--kir needs --afnd and --afnd-populations")
        carriers, report = afnd_carriers.load(
            args.afnd, args.afnd_populations, args.data_version,
            min_populations=args.min_populations,
        )
        print(report)
        # `as_binomial` renames carriers/n_individuals to ac/an so the cell table can be built.
        # The manifest records `measurement="carrier_frequency"` so the distinction survives the
        # rename and reaches every consumer (#133).
        binomial = afnd_carriers.as_binomial(carriers)
        for variant_id, rows in binomial.groupby("variant_id", sort=True):
            if (args.fits / f"{variant_id.replace(':', '__')}.fit.pkl").exists():
                jobs.append((str(variant_id), rows.reset_index(drop=True)))

    refuse_released(args.out, [_directory_name(variant_id, args) for variant_id, _ in jobs])
    print(f"publishing {len(jobs)} variants")
    for variant_id, observations in jobs:
        stem = variant_id.replace(":", "__")
        fit_path = args.fits / f"{stem}.fit.pkl"
        if not fit_path.exists():
            print(f"  {variant_id}: no fit at {fit_path} — skipped")
            continue

        fit = load_fit(fit_path)
        consumed = consumed_observations(
            fit, observations, variant_id=variant_id, fit_path=fit_path
        )
        cells, lat, lon = publication_coordinates(population_grid, consumed)
        frame = cell_table(
            fit,
            h3_index=cells,
            lat=lat,
            lon=lon,
            observations=consumed,
            variant_id=variant_id,
            model_version=args.model_version,
            data_version=args.data_version,
        )
        counts = {s: int((frame["support"] == s).sum()) for s in sorted(set(frame["support"]))}
        manifest = ArtifactManifest(
            variant_id=variant_id,
            model_version=args.model_version,
            data_version=args.data_version,
            resolution=args.h3_res,
            n_cells=len(frame),
            correlation_range_km=float(fit.correlation_range_km),
            prior_normalization=PRIOR_NORMALIZATION,
            prior_draws=PRIOR_DRAWS,
            prior_seed=fit.config.seed,
            likelihood=fit.config.likelihood,
            lengthscale_sigma=float(fit.config.lengthscale_sigma),
            n_observations=len(consumed),
            support_counts=counts,
            target_grid_source=population_grid.source,
            target_grid_version=population_grid.source_version,
            measurement=(
                "carrier_frequency" if variant_id.startswith("kir:") else "allele_frequency"
            ),
            observations=observations_record(consumed),
        )
        directory = publish(
            frame, args.out, manifest=manifest, observations=consumed, overwrite=args.overwrite
        )
        size = (directory / "cells.parquet").stat().st_size / 1024
        print(f"  {variant_id}: {len(frame)} cells, {size:.0f} KB -> {directory}")
        print(f"      rho {fit.correlation_range_km:.0f} km   support {counts}")


if __name__ == "__main__":
    main()
