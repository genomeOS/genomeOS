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
from tests.observation_fixtures import carrier_rows, kir_fit_rows, observation_rows


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


HBS = "chr11-5227002-T-A"
G6PD = "phenotype:g6pd-deficiency"


def _fit(recorded, **fields):
    """A cached fit as `publish_artifacts` reads it, whose own record of its input is `recorded`."""
    config = SimpleNamespace(seed=7, likelihood="beta_binomial", lengthscale_sigma=0.7)
    return SimpleNamespace(correlation_range_km=680.0, config=config, observations=recorded, **fields)


def _map_layers(tmp_path, monkeypatch, **layers):
    """Serve each MAP layer flag (`hbs`, `g6pd`) the given rows, in order; return the flags."""
    monkeypatch.setattr(
        publish_artifacts,
        "LAYERS",
        {layer: (lambda path, version, rows=rows: (rows, None)) for layer, rows in layers.items()},
    )
    return [arg for layer in layers for arg in (f"--{layer}", str(tmp_path / f"{layer}.csv"))]


def _publisher(tmp_path, monkeypatch, fits_by_variant, *flags):
    """Prepare `main()` over one cached fit per variant; return the list each publish appends to."""
    fits = tmp_path / "fits"
    fits.mkdir(parents=True)
    by_file = {}
    for variant_id, fit in fits_by_variant.items():
        name = f"{variant_id.replace(':', '__')}.fit.pkl"
        (fits / name).touch()
        by_file[name] = fit
    published = []
    cell_inputs = {}

    monkeypatch.setattr(publish_artifacts, "read_population_grid", lambda path: _grid())
    monkeypatch.setattr(publish_artifacts, "load_fit", lambda path: by_file[path.name])
    monkeypatch.setattr(
        publish_artifacts,
        "publication_coordinates",
        lambda grid, rows: (["843f305ffffffff"], np.array([0.0]), np.array([0.0])),
    )

    def capture_cells(*args, **kwargs):
        cell_inputs[kwargs["variant_id"]] = kwargs["observations"]
        return pd.DataFrame({"support": ["observed"]})

    monkeypatch.setattr(publish_artifacts, "cell_table", capture_cells)

    def capture_publish(frame, root, *, manifest, observations, overwrite):
        published.append(
            {
                "manifest": manifest,
                "observations": observations,
                "cell_observations": cell_inputs[manifest.variant_id],
            }
        )
        directory = tmp_path / "published" / manifest.variant_id.replace(":", "__")
        directory.mkdir(parents=True)
        (directory / "cells.parquet").write_bytes(b"fixture")
        return directory

    monkeypatch.setattr(publish_artifacts, "publish", capture_publish)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "publish_artifacts.py", "--fits", str(fits), "--out", str(tmp_path / "out"), *flags,
            "--population-cells", str(tmp_path / "grid.parquet"), "--population-source",
            WORLDPOP_SOURCE, "--population-version", "fixture-2020", "--h3-res", "4",
        ],
    )
    return published


def _run_publisher(tmp_path, monkeypatch, *, supplied, recorded, **fit_fields):
    """Run `main()` over one HbS fit whose cached record is `recorded`; return what it published."""
    flags = _map_layers(tmp_path, monkeypatch, hbs=supplied)
    published = _publisher(tmp_path, monkeypatch, {HBS: _fit(recorded, **fit_fields)}, *flags)
    publish_artifacts.main()
    (only,) = published
    return only


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
    assert captured["manifest"].observations == observations_record(recorded, measurement="allele_frequency")


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


@pytest.mark.parametrize(
    "earlier",
    [
        lambda rows: rows.assign(retired_column="x"),
        lambda rows: rows.drop(columns=["cohort_id"]),
        lambda rows: rows[["lon", "lat", *[c for c in rows.columns if c not in {"lat", "lon"}]]],
    ],
    ids=["a-retired-column", "a-column-added-since", "reordered-columns"],
)
def test_publisher_refuses_a_fit_cached_under_an_earlier_observation_contract(tmp_path, monkeypatch, earlier):
    """A format-3 cache loads across a contract revision, but cannot publish until it is refit (#45).

    No rows the current contract validates can equal its table, so the refusal must name the
    revision, not blame the flags for supplying the wrong rows.
    """
    rows = observation_rows()
    with pytest.raises(SystemExit, match="earlier observation contract revision") as refused:
        _run_publisher(tmp_path, monkeypatch, supplied=rows, recorded=earlier(rows))
    assert "not the rows" not in str(refused.value)


def test_publisher_refuses_a_fit_that_also_consumed_support_points(tmp_path, monkeypatch):
    """`observations.parquet` does not describe a footprint's support points, so it would be incomplete."""
    rows = observation_rows()
    with pytest.raises(SystemExit, match="support"):
        _run_publisher(tmp_path, monkeypatch, supplied=rows, recorded=rows, footprint_metadata=object())


def test_a_mismatch_in_any_variant_publishes_nothing(tmp_path, monkeypatch):
    """Every fit's input is checked before the first directory is written, so a run is never half done."""
    hbs, g6pd = observation_rows(), observation_rows(variant_id=G6PD)
    edited = g6pd.copy()
    edited.loc[0, "an"] = 201
    flags = _map_layers(tmp_path, monkeypatch, hbs=hbs, g6pd=edited)
    published = _publisher(tmp_path, monkeypatch, {HBS: _fit(hbs), G6PD: _fit(g6pd)}, *flags)
    with pytest.raises(SystemExit, match=f"{G6PD} are not the rows"):
        publish_artifacts.main()
    assert published == []


def test_a_kir_fit_publishes_carriers_over_individuals_under_the_carrier_contract(tmp_path, monkeypatch):
    """The live `--kir` path: the fit read `ac`/`an`, but the artifact's input says they are people (#133)."""
    consumed = kir_fit_rows()
    no_alleles = consumed.iloc[:0]
    monkeypatch.setattr(publish_artifacts.afnd_frequencies, "load", lambda *a, **k: (no_alleles, "afnd"))
    monkeypatch.setattr(publish_artifacts.afnd_carriers, "load", lambda *a, **k: (carrier_rows(), "kir"))
    flags = ["--afnd", str(tmp_path / "afnd.tsv"), "--afnd-populations", str(tmp_path / "pops.tsv"), "--kir"]
    published = _publisher(tmp_path, monkeypatch, {"kir:2dl1": _fit(consumed)}, *flags)
    publish_artifacts.main()
    (only,) = published
    manifest = only["manifest"]
    assert manifest.measurement == manifest.observations.measurement == "carrier_frequency"
    assert manifest.observations.schema == "contract/carrier_observations.schema.json"
    assert manifest.observations.columns[6:8] == ("carriers", "n_individuals")
    assert manifest.observations == observations_record(consumed, measurement="carrier_frequency")
