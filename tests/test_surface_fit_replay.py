"""Replay guarantee across the `SurfaceFit` cache boundary (design §§5–7; #198).

A fit is persisted so figures, rollups and validation can be produced later without refitting,
which only holds if the reloaded object predicts what the fresh one did. #198 found a fresh fit
and its clean-process reload disagreeing in every latent and surface value (~5e-8): live JAX
float64 posterior arrays came back as float32, until `save_fit` materialized them as NumPy
(#203). A same-process round trip cannot see this, so the reload runs in a separate process.

Each guarantee is tested on its own, as #198 asks: fresh versus reloaded, and repeated or
reordered calls on one object. Equality is bitwise; no tolerance is applied to manufacture it.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from test_surface_fit import FAST_CONFIG, _observations

from genomeos.surfaces.fit import fit_surface, save_fit

LAT, LON, AN = [0.0, 5.0], [-8.0, 8.0], [200, 200]
#: The reload must import the tree under test, not whichever checkout an editable install names.
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def fresh():
    return fit_surface(_observations(), FAST_CONFIG)


def test_latent_and_surface_predictions_replay_bitwise_in_a_clean_process(fresh, tmp_path):
    np.savez(
        tmp_path / "fresh.npz",
        latent=fresh.predict_draws(LAT, LON),
        surface=fresh.predict(LAT, LON).to_numpy(),
        survey=fresh.predict_observation(LAT, LON, AN).to_numpy(),
    )
    save_fit(fresh, tmp_path / "surface.pkl")
    script = f"""
import sys
from pathlib import Path
import numpy as np
from genomeos.surfaces.fit import load_fit

directory = Path(sys.argv[1])
fitted = load_fit(directory / "surface.pkl")
np.savez(
    directory / "reloaded.npz",
    latent=fitted.predict_draws({LAT}, {LON}),
    surface=fitted.predict({LAT}, {LON}).to_numpy(),
    survey=fitted.predict_observation({LAT}, {LON}, {AN}).to_numpy(),
)
"""
    subprocess.run([sys.executable, "-c", script, str(tmp_path)], cwd=ROOT, check=True)
    before, after = np.load(tmp_path / "fresh.npz"), np.load(tmp_path / "reloaded.npz")
    for name in ("latent", "surface", "survey"):
        np.testing.assert_array_equal(after[name], before[name], err_msg=name)


def test_saved_posterior_keeps_float64_through_a_clean_reload(fresh, tmp_path):
    save_fit(fresh, tmp_path / "surface.pkl")
    script = """
import sys
from pathlib import Path
from genomeos.surfaces.fit import load_fit

posterior = load_fit(Path(sys.argv[1]) / "surface.pkl").idata.posterior
print(" ".join(f"{name}={posterior[name].dtype}" for name in sorted(posterior.data_vars)))
"""
    reloaded = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    live = [f"{name}={fresh.idata.posterior[name].dtype}" for name in sorted(fresh.idata.posterior.data_vars)]
    assert reloaded == live
    assert all(entry.endswith("float64") for entry in live if not entry.split("=")[1].startswith("int"))


def test_repeated_and_reordered_predictions_on_one_object_are_bitwise_equal(fresh):
    first = fresh.predict_draws(LAT, LON)
    np.testing.assert_array_equal(fresh.predict_draws(LAT, LON), first)
    reordered = fresh.predict_draws(LAT[::-1], LON[::-1])[:, ::-1]
    np.testing.assert_array_equal(reordered, first)
