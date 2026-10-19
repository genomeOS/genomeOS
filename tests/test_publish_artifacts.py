"""Publication-target integration for saved surface fits (design §7, §9)."""

from __future__ import annotations

import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from genomeos.geo.population import WORLDPOP_SOURCE, PopulationGrid
from genomeos.surfaces.fit_input import observations_record
from genomeos.surfaces.prior import PRIOR_DRAWS, PRIOR_NORMALIZATION
from scripts import publish_artifacts
from scripts.publish_artifacts import publication_coordinates
from tests.observation_fixtures import observation_rows


def test_publish_artifacts_direct_cli_loads() -> None:
    completed = subprocess.run(
        [sys.executable, "scripts/publish_artifacts.py", "--help"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert "--population-cells" in completed.stdout


def _grid() -> PopulationGrid:
    return PopulationGrid(
        cells=pd.DataFrame(
            {
                "h3_index": [
                    "845494bffffffff",
                    "843f305ffffffff",
                    "8459653ffffffff",
                ],
                "population": [1.0, 2.0, 0.0],
            }
        ),
        resolution=4,
        source=WORLDPOP_SOURCE,
        source_version="fixture-2020",
        pixels_counted=2,
        pixels_nodata=0,
        coverage_stride=16,
    )


def test_publication_coordinates_use_positive_population_cells():
    observations = pd.DataFrame({"lat": [14.933], "lon": [-23.513]})
    cells, lat, lon = publication_coordinates(_grid(), observations)
    assert cells == ["843f305ffffffff", "845494bffffffff"]
    assert len(cells) == len(lat) == len(lon) == 2
    assert np.isfinite(lat).all() and np.isfinite(lon).all()


def test_administrative_centroid_does_not_create_a_surface_cell():
    observations = pd.DataFrame({"lat": [-19.2114], "lon": [-158.9782]})
    cells, _, _ = publication_coordinates(_grid(), observations)
    assert "84b4c3bffffffff" not in cells


def test_publication_coordinates_refuse_missing_coordinates():
    observations = pd.DataFrame({"lat": [14.933]})
    with pytest.raises(ValueError, match="lat.*lon"):
        publication_coordinates(_grid(), observations)


def _run_publisher(tmp_path, monkeypatch, *, supplied, recorded):
    """Run `main()` over one HbS fit whose cached record is `recorded`; return what it published."""
    fits = tmp_path / "fits"
    fits.mkdir(parents=True)
    (fits / "chr11-5227002-T-A.fit.pkl").touch()
    fit = SimpleNamespace(
        correlation_range_km=680.0,
        config=SimpleNamespace(seed=7, likelihood="beta_binomial", lengthscale_sigma=0.7),
        observations=recorded,
    )
    captured = {}

    monkeypatch.setattr(publish_artifacts, "read_population_grid", lambda path: _grid())
    monkeypatch.setattr(
        publish_artifacts, "LAYERS", {"hbs": lambda path, version: (supplied, None)}
    )
    monkeypatch.setattr(publish_artifacts, "load_fit", lambda path: fit)
    monkeypatch.setattr(
        publish_artifacts,
        "publication_coordinates",
        lambda grid, rows: (["843f305ffffffff"], np.array([0.0]), np.array([0.0])),
    )

    def capture_cells(*args, **kwargs):
        captured["cell_observations"] = kwargs["observations"]
        return pd.DataFrame({"support": ["observed"]})

    monkeypatch.setattr(publish_artifacts, "cell_table", capture_cells)

    def capture_publish(frame, root, *, manifest, observations, overwrite):
        captured["manifest"] = manifest
        captured["observations"] = observations
        directory = tmp_path / "published"
        directory.mkdir()
        (directory / "cells.parquet").write_bytes(b"fixture")
        return directory

    monkeypatch.setattr(publish_artifacts, "publish", capture_publish)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "publish_artifacts.py", "--fits", str(fits), "--out", str(tmp_path / "out"),
            "--hbs", str(tmp_path / "hbs.csv"), "--population-cells",
            str(tmp_path / "grid.parquet"), "--population-source", WORLDPOP_SOURCE,
            "--population-version", "fixture-2020", "--h3-res", "4",
        ],
    )

    publish_artifacts.main()
    return captured


def test_publisher_records_pointwise_protocol_and_retained_fit_seed(tmp_path, monkeypatch):
    rows = observation_rows()
    manifest = _run_publisher(tmp_path, monkeypatch, supplied=rows, recorded=rows)["manifest"]
    assert manifest.prior_normalization == PRIOR_NORMALIZATION
    assert manifest.prior_draws == PRIOR_DRAWS
    assert manifest.prior_seed == 7


def test_publisher_publishes_the_table_the_fit_recorded(tmp_path, monkeypatch):
    """The artifact's input, its distances and its n_observations all come from the fit's record."""
    recorded = observation_rows()
    supplied = recorded.set_axis(range(10, 16))  # the same rows, as an adapter might index them
    captured = _run_publisher(tmp_path, monkeypatch, supplied=supplied, recorded=recorded)
    assert captured["observations"] is recorded
    assert captured["cell_observations"] is recorded
    assert captured["manifest"].n_observations == len(recorded)
    assert captured["manifest"].observations == observations_record(recorded)


def test_publisher_refuses_a_fit_that_did_not_record_its_input(tmp_path, monkeypatch):
    """A fit cached before fit format 3 cannot say what it consumed, so it publishes nothing new."""
    with pytest.raises(SystemExit, match="did not record"):
        _run_publisher(tmp_path, monkeypatch, supplied=observation_rows(), recorded=None)


def test_publisher_refuses_supplied_rows_that_the_fit_did_not_consume(tmp_path, monkeypatch):
    """Flags pointing at an edited export must not relabel a fit made from the original (#45)."""
    recorded = observation_rows()
    edited = recorded.copy()
    edited.loc[2, "ac"] = 13
    with pytest.raises(SystemExit, match="not the rows"):
        _run_publisher(tmp_path, monkeypatch, supplied=edited, recorded=recorded)
    with pytest.raises(SystemExit, match="not the rows"):
        _run_publisher(tmp_path / "fewer", monkeypatch, supplied=recorded.iloc[:5], recorded=recorded)
