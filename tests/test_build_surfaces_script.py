"""The batch surface builder's default sampling budget (design §12; #111)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _builder():
    spec = importlib.util.spec_from_file_location("build_surfaces", ROOT / "scripts" / "build_surfaces.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_omitting_draws_uses_the_budget_the_parity_run_converged_with():
    """At 400 draws HbS missed the ESS floor and G6PD never mixed (#111); 1,200 converged."""
    builder = _builder()
    args = builder.parse_args(["--out", "unused"])
    config = builder.batch_config(args.draws, args.n_inducing)
    assert (config.draws, config.tune) == (1200, 1200)
    assert (config.approximation, config.n_inducing) == ("inducing", 150)


def test_an_explicit_budget_still_sets_warm_up_and_draws_together():
    builder = _builder()
    args = builder.parse_args(["--out", "unused", "--draws", "2000"])
    config = builder.batch_config(args.draws, args.n_inducing)
    assert (config.draws, config.tune) == (2000, 2000)
