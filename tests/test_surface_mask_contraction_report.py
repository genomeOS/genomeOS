"""The #39 contraction calibration report over evaluated mask cells (design §7, §7.1b)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from genomeos.geo.h3util import cell_for
from genomeos.surfaces.mask import SUPPORT_STATES, MaskConfig, contraction_report

CONFIG = MaskConfig(contraction_threshold=0.9)


def _observations() -> pd.DataFrame:
    # Two surveys share a cell (AN 30 + 40 = 70); the others are alone in theirs.
    return pd.DataFrame(
        {
            "lat": [6.5, 6.5, 12.0, -1.3],
            "lon": [3.4, 3.4, 8.5, 36.8],
            "an": [30.0, 40.0, 10.0, 5000.0],
        }
    )


def _cells(observations: pd.DataFrame) -> pd.DataFrame:
    observed = [
        cell_for(a, o, CONFIG.resolution) for a, o in zip(observations.lat, observations.lon, strict=True)
    ]
    observed = list(dict.fromkeys(observed))  # 3 distinct cells, in order
    return pd.DataFrame(
        {
            "h3_index": [*observed, "interp-a", "interp-b", "unknown-a"],
            "support": ["observed", "observed", "observed", "interpolated", "interpolated", "unknown"],
            # AN 70 cell barely contracted; AN 10 cell not at all; AN 5000 cell strongly.
            "posterior_contraction": [0.85, 0.97, 0.20, 0.40, 0.60, 1.0],
        }
    )


def test_every_support_state_is_reported_even_when_it_has_no_cells():
    report = contraction_report(_cells(_observations()), _observations(), CONFIG)
    by_group = report.set_index("group")
    assert [f"support:{s}" for s in SUPPORT_STATES] == list(report.group[: len(SUPPORT_STATES)])
    assert by_group.loc["support:prior_dominated", "cells"] == 0
    assert np.isnan(by_group.loc["support:prior_dominated", "contraction_q50"])
    assert by_group.loc["support:interpolated", "cells"] == 2
    assert by_group.loc["support:interpolated", "contraction_q50"] == pytest.approx(0.5)


def test_observed_cells_are_binned_by_the_summed_allele_count_in_the_cell():
    report = contraction_report(_cells(_observations()), _observations(), CONFIG).set_index("group")
    assert report.loc["observed:an_0_50", "cells"] == 1  # AN 10
    assert report.loc["observed:an_50_200", "cells"] == 1  # AN 30 + 40
    assert report.loc["observed:an_1000_up", "cells"] == 1  # AN 5000
    assert report.loc["observed:an_200_1000", "cells"] == 0


def test_counts_the_observed_cells_option_one_would_reclassify():
    report = contraction_report(_cells(_observations()), _observations(), CONFIG).set_index("group")
    # Contraction 0.97 >= 0.9 is not contracted; 0.85 and 0.20 are.
    assert report.loc["support:observed", "observed_not_contracted"] == 1
    assert report.loc["observed:an_0_50", "observed_not_contracted"] == 1
    assert report.loc["support:observed", "share_below_threshold"] == pytest.approx(2 / 3)
    assert report.loc["support:interpolated", "observed_not_contracted"] == 0


@pytest.mark.parametrize(
    ("column", "value", "message"),
    [
        ("posterior_contraction", np.nan, "finite"),
        ("support", "maybe", "unknown support states"),
    ],
)
def test_refuses_malformed_cells(column, value, message):
    cells = _cells(_observations())
    cells.loc[0, column] = value
    with pytest.raises(ValueError, match=message):
        contraction_report(cells, _observations(), CONFIG)


def test_refuses_an_observed_cell_with_no_observation_in_it():
    cells = _cells(_observations())
    cells.loc[3, "support"] = "observed"  # "interp-a" holds no survey
    with pytest.raises(ValueError, match="no observation centre"):
        contraction_report(cells, _observations(), CONFIG)


def test_refuses_missing_columns():
    with pytest.raises(ValueError, match="'an'"):
        contraction_report(_cells(_observations()), _observations().drop(columns="an"), CONFIG)
