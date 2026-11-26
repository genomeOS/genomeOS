"""Golden test 3 target data (design §8, issue #47).

These assertions are transcription and arithmetic checks. The truth rows decide whether the
ascertainment correction works, so a row that is silently mis-typed would later read as a model
failure. The table is validated on its own for the same reason `piel2013.py` is: a target that
cannot be trusted cannot score anything.

Two checks here are about *shape rather than arithmetic*, and they are the ones that would catch a
real regression: a panel total must never be presented as if it were an F508del frequency, and a
frequency we divided ourselves must not be labelled as published.
"""

import pandas as pd
import pytest

from genomeos.reference.carrier_screening import (
    FREQUENCY_SOURCES,
    SAMPLING_DESIGNS,
    f508del_specific_rows,
    read_truth_rows,
    truth_rows,
)


@pytest.fixture(scope="module")
def targets():
    return truth_rows()


def test_the_table_is_the_six_transcribed_rows(targets):
    assert len(targets) == 6
    assert targets["place_id"].is_unique


def test_every_row_cites_something_a_reader_can_resolve(targets):
    """Every row is citable: a PMID and a DOI each, and a stated reading level.

    The reading level is the honesty column. Two rows were read in full from the authors' own
    institutional copy and say so; the other four are abstract-level because those papers are closed
    access. A row claiming `full_text` without a locator would be the first sign that somebody pasted
    a memory instead of a quote.
    """
    assert targets["source_pmid"].notna().all()
    assert targets["source_doi"].notna().all()
    assert targets["source_pmid"].astype(str).str.fullmatch(r"\d{7,8}").all()
    assert targets["source_doi"].str.startswith("10.").all()
    assert set(targets["reading_level"]) <= {"abstract", "full_text"}
    assert set(targets.loc[targets["reading_level"] == "full_text", "place_id"]) == {
        "italy-northeast-east",
        "italy-northeast-west",
    }


def test_design_classes_are_from_the_closed_set(targets):
    """`sampling_design` is a closed vocabulary, so a typo here must fail rather than pass through."""
    assert set(targets["design_class"]) <= SAMPLING_DESIGNS
    assert set(targets["frequency_source"]) <= FREQUENCY_SOURCES


def test_carriers_cannot_exceed_the_number_tested(targets):
    counted = targets.dropna(subset=["carriers_f508del"])
    assert (counted["carriers_f508del"] <= counted["n_tested"]).all()
    assert (counted["carriers_f508del"] >= 0).all()


def test_frequencies_are_biologically_plausible(targets):
    """A carrier frequency above a few percent is not CF outside a founder population, and any
    value above 1 is a units error."""
    assert (targets["carrier_frequency"] > 0).all()
    assert targets["carrier_frequency"].max() < 0.15
    for row in targets.itertuples():
        if pd.notna(row.ci_lower):
            assert row.ci_lower < row.carrier_frequency < row.ci_upper


def test_computed_frequencies_reproduce_their_counts(targets):
    """Rows marked `computed` are carriers divided by n_tested. If those two drift apart, the row
    was edited and the note beside it was not."""
    computed = targets[targets["frequency_source"] == "computed"]
    assert len(computed) == 1
    assert set(computed["place_id"]) == {"australia-victoria"}
    assert computed["carriers_f508del"].notna().all()
    for row in computed.itertuples():
        expected = row.carriers_f508del / row.n_tested
        assert row.carrier_frequency == pytest.approx(expected, abs=1e-4)


def test_published_frequencies_agree_with_their_own_counts(targets):
    """Rows that print both a count and a rate must agree with their own arithmetic.

    Delhi prints 0.42% against 4/955, so the tolerance is the paper's rounding. The Italian rows print
    a rate to one decimal place of the ratio (1 in 8.1 and 1 in 23.8), which is 2559/314 and 87025/3650
    rounded, so they are held to a looser tolerance and the note on each row records the raw division.
    """
    by_place = targets.set_index("place_id")
    delhi = by_place.loc["india-delhi-cord-blood"]
    assert delhi["carriers_f508del"] == 4
    assert delhi["n_tested"] == 955
    assert delhi["carrier_frequency"] == pytest.approx(4 / 955, abs=1e-4)
    assert 1 / delhi["carrier_frequency"] == pytest.approx(238, abs=1)

    for place in ("italy-northeast-east", "italy-northeast-west"):
        row = by_place.loc[place]
        assert row["carrier_frequency"] == pytest.approx(
            row["carriers_f508del"] / row["n_tested"], abs=1e-3
        )


def test_exactly_three_rows_are_f508del_specific(targets):
    """The parity column. If this count changes, the test's scope changed and §8 should say so."""
    specific = f508del_specific_rows(targets)
    assert len(specific) == 3
    assert set(specific["place_id"]) == {
        "india-delhi-cord-blood",
        "brazil-five-states",
        "argentina-mendoza",
    }
    assert specific["count_is_f508del_specific"].all()


def test_panel_totals_are_kept_but_flagged(targets):
    """NE Italy and Victoria stay in the table so the reason they are not comparable stays visible.

    Their frequencies are panel totals, which run higher than any variant inside the panel: 4.19%
    and 12.27% sit against 0.42% to 2.3% for the single-variant rows. Dropping them would hide the
    distinction; scoring them would build the panel into the error.
    """
    panel = targets[~targets["count_is_f508del_specific"]]
    assert len(panel) == 3
    assert set(panel["place_id"]) == {
        "italy-northeast-east",
        "italy-northeast-west",
        "australia-victoria",
    }
    assert (panel["design_class"] == "carrier_screening").all()


def test_the_two_italian_rows_are_a_route_contrast_and_stay_separate(targets):
    """Same area, same surveillance, 2.93x apart, and the paper attributes it to who was offered a
    test. Pooling them would average a contrast into a frequency."""
    italy = targets.set_index("place_id").loc[
        ["italy-northeast-east", "italy-northeast-west"]
    ]
    assert italy["source_doi"].nunique() == 1
    ratio = italy.loc["italy-northeast-west", "carrier_frequency"] / italy.loc[
        "italy-northeast-east", "carrier_frequency"
    ]
    assert ratio == pytest.approx(2.93, abs=0.02)


def test_an_empty_table_is_refused(tmp_path):
    path = tmp_path / "empty.csv"
    path.write_text(
        "place_id,place,iso3,design_class,design_detail,n_tested,carriers_f508del,"
        "count_is_f508del_specific,frequency_source,carrier_frequency,ci_lower,ci_upper,"
        "source_pmid,source_doi,reading_level,note\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="empty"):
        read_truth_rows(path)


def test_a_missing_column_is_refused(tmp_path):
    path = tmp_path / "short.csv"
    path.write_text("place_id,place\nDelhi,Delhi\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing required columns"):
        read_truth_rows(path)


def test_an_unknown_design_class_is_refused(tmp_path):
    source = truth_rows().copy()
    source.loc[0, "design_class"] = "teleportation"
    path = tmp_path / "bad-design.csv"
    source.to_csv(path, index=False)
    with pytest.raises(ValueError, match="design_class"):
        read_truth_rows(path)


def test_a_duplicated_place_is_refused(tmp_path):
    source = truth_rows().copy()
    source.loc[1, "place_id"] = source.loc[0, "place_id"]
    path = tmp_path / "duplicate.csv"
    source.to_csv(path, index=False)
    with pytest.raises(ValueError, match="place_id"):
        read_truth_rows(path)
