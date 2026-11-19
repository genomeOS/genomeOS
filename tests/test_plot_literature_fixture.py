"""Regenerability test for the literature observation review figure (design §§4, 11)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_literature_fixture_map_is_regenerable(tmp_path):
    output = tmp_path / "literature-fixture.png"
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "plot_literature_fixture.py"),
            "--out",
            str(output),
        ],
        cwd=ROOT,
        # Import the tree under test, not whichever checkout the editable install points at (#258).
        env={**os.environ, "PYTHONPATH": str(ROOT)},
        check=True,
        capture_output=True,
        text=True,
    )
    assert output.stat().st_size > 10_000
    assert "synthetic literature fixture" in completed.stdout
