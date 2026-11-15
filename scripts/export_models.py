#!/usr/bin/env python3
"""Export saved surface fits as safe model exports beside their artifacts (Atlas data platform design
2026-10-18 §2.1, §2.3, step 1.12; #471).

    python scripts/export_models.py --fits data/store/fits --artifacts data/store/artifacts \
        --artifact chr11-5227002-T-A__v4__map-2026-08 [--artifact ...] [--out data/store/models]

Each ``--artifact`` names a published artifact directory under ``--artifacts``. Its fit is the
``save_fit`` cache ``build_surfaces.py`` wrote, ``<fits>/<variant>.fit.pkl``: a pickle of this
machine's own making, which is why only this script loads one. What it writes,
``<out>/<artifact-id>/``, holds JSON and float64 ``.npy`` only (``genomeos.surfaces.model_export``).
Each export is then loaded back the way any reader loads it, rebuilding the graph from code, and must
reproduce the artifact's first published cells before the run succeeds.

Refused before any fit is loaded: an artifact whose model a committed release already published
(released keys never change, §2.2 rule 4), and an artifact that does not publish its fit input, since an
export is bound to that input's sha256 (#45). A run that fails removes the directories it created and
nothing else, so it can be rerun as it stands.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.surfaces.fit import load_fit  # noqa: E402
from genomeos.surfaces.model_export import (  # noqa: E402
    export_model,
    load_model_export,
    require_reproduces_cells,
)

try:
    from scripts.fetch_data import DATA, RELEASES, released_dirs  # noqa: E402
except ModuleNotFoundError:  # Direct `python scripts/export_models.py` entry.
    from fetch_data import DATA, RELEASES, released_dirs  # noqa: E402

#: Where exports are published in the data store (§2.3).
MODEL_PREFIX = "store/models/"


def fit_path_for(fits: Path, variant_id: str) -> Path:
    """The `save_fit` cache `build_surfaces.py` writes for `variant_id`; ':' is not portable."""
    return Path(fits) / f"{variant_id.replace(':', '__')}.fit.pkl"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export saved surface fits without pickle (#471).")
    parser.add_argument("--fits", type=Path, required=True, help="folder of <variant>.fit.pkl caches")
    parser.add_argument("--artifacts", type=Path, required=True, help="folder of published artifacts")
    parser.add_argument(
        "--artifact", action="append", required=True, help="artifact directory name; repeat for more"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DATA / MODEL_PREFIX,
        help="where exports land (default: data/store/models)",
    )
    parser.add_argument("--releases", type=Path, default=RELEASES, help=argparse.SUPPRESS)
    return parser


def bound_fits(args: argparse.Namespace, names: Sequence[str]) -> dict[str, Path]:
    """Each artifact's saved fit, after refusing a released model and an artifact with no fit input."""
    released = released_dirs(MODEL_PREFIX, args.releases)
    clashes = sorted(name for name in names if name in released)
    if clashes:
        raise ValueError(
            "already published in the data store, and released keys never change: "
            + ", ".join(f"{name} (release {released[name]})" for name in clashes)
            + ". Export a new artifact's model instead."
        )
    fits: dict[str, Path] = {}
    for name in names:
        manifest = json.loads((args.artifacts / name / "manifest.json").read_text(encoding="utf-8"))
        if not isinstance(manifest.get("observations"), dict):
            raise ValueError(
                f"{args.artifacts / name} does not publish its fit input (observations.parquet), so no "
                "model can be bound to it (#45)"
            )
        fits[name] = fit_path_for(args.fits, manifest["variant_id"])
        if not fits[name].is_file():
            raise ValueError(f"{name}: no saved fit at {fits[name]}")
    return fits


def export_all(args: argparse.Namespace, fits: dict[str, Path]) -> None:
    """Export, reload and check each model; on any failure remove the directories this run created."""
    created: list[Path] = []
    try:
        for name, fit_path in fits.items():
            artifact = args.artifacts / name
            if not (args.out / name).exists():
                created.append(args.out / name)
            directory = export_model(load_fit(fit_path), artifact, args.out)
            require_reproduces_cells(
                load_model_export(directory, artifact), pd.read_parquet(artifact / "cells.parquet")
            )
            print(f"  {name}: exported to {directory}, and it reproduces the artifact's cells")
    except BaseException:
        for directory in created:
            shutil.rmtree(directory, ignore_errors=True)
        raise


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        fits = bound_fits(args, list(dict.fromkeys(args.artifact)))
        export_all(args, fits)
    except (ValueError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"exported {len(fits)} models into {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
