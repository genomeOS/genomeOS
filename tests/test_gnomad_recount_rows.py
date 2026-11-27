"""The recount's binned rows: the registry join, their own ``cohort_id`` and the ids they derive.

Atlas data platform design 2026-10-18 §1.2 D18, §2.4 and §2.10. The rows' ascertainment values here are
test values; the real pair is decided in #509 and asserted at the end of this file.
"""

from __future__ import annotations

import inspect
from typing import TypedDict

import pandas as pd
import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.observations.sources import gnomad_hgdp_1kg
from genomeos.observations.sources.gnomad_recount.rows import (
    binned_rows,
    derive_source_record_id,
    population_table,
    recount_cohort_id,
    with_derived_ids,
)
from genomeos.observations.sources.gnomad_recount.rule import RecountError, SiteCounts
from genomeos.registry.build import build_registry
from genomeos.registry.sources import hgdp
from genomeos.tables import writer
from genomeos.tables.binned import BINNED_COLUMNS, SOURCE_RECORD_ID_TEMPLATE, source_record_id_sql, write_bin
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, lookup_set
from tests.gnomad_recount_fixtures import FIXTURES, fixture_stage
from tests.lookup_fixtures import W

SITES = (
    SiteCounts("chr1", 1000, "A", "G", "rs9001", (1, 0, 0, 0), (2, 0, 0, 0)),
    SiteCounts("chr1", 6000, "T", "C", None, (1, 0, 0, 0), (4, 4, 4, 0)),
)


class Ascertainment(TypedDict):
    """``binned_rows``' ascertainment keywords, typed so that ``**ASC`` type-checks against its signature."""

    sampling_design: str
    disease_ascertainment_excluded: bool


#: Test values; the real ones wait for O1.
ASC = Ascertainment(sampling_design="healthy_reference", disease_ascertainment_excluded=True)
COHORT = "gnomad-v3.1.2-hgdp-1kg:fixture-8:d18-v1"


@pytest.fixture
def registry() -> tuple[pd.DataFrame, pd.DataFrame]:
    return build_registry([hgdp.load(FIXTURES / "populations.tsv", "0.1.0")])


def test_cohort_id_and_population_table(registry):
    assert recount_cohort_id("paper_ancestry_exclusion_4094") == (
        "gnomad-v3.1.2-hgdp-1kg:paper_ancestry_exclusion_4094:d18-v1"
    )
    for name in ("", "Paper Stage", "a:b"):
        with pytest.raises(RecountError, match="stage name"):
            recount_cohort_id(name)
    table = population_table(fixture_stage(), *registry)
    assert table["population_id"].tolist() == [
        "hgdp-han",
        "hgdp-northernhan",
        "hgdp-papuanhighlands",
        "hgdp-papuansepik",
    ]
    assert table.loc[1, ["lat", "lon", "radius_km"]].tolist() == [39.90, 116.40, 50.0]


def test_an_unmapped_or_ambiguous_label_fails(registry):
    populations, aliases = registry
    with pytest.raises(gnomad_hgdp_1kg.UnmappedPopulationError, match="PapuanSepik"):
        population_table(fixture_stage(), populations, aliases[aliases["label"] != "PapuanSepik"])
    with pytest.raises(RecountError, match="ambiguous.*Han"):
        population_table(
            fixture_stage(),
            populations,
            pd.concat([aliases, aliases[aliases["label"] == "Han"].assign(source="onekg")]),
        )


def test_a_label_whose_identity_has_no_coordinate_fails(registry):
    populations, aliases = registry
    gap = populations.assign(lat=populations["lat"].where(populations["population_id"] != "hgdp-han"))
    for frame in (populations[populations["population_id"] != "hgdp-han"], gap):
        with pytest.raises(gnomad_hgdp_1kg.UnmappedPopulationError, match=r"no .*\['Han'\]"):
            population_table(fixture_stage(), frame, aliases)


def test_rows_refuse_a_site_of_another_width_a_non_bool_flag_and_other_columns(registry):
    table = population_table(fixture_stage(), *registry)
    with pytest.raises(RecountError, match="1 site.* 3 populations"):
        binned_rows(SITES[:1], table.iloc[:3], cohort_id=COHORT, ingest_version="fixture-1", **ASC)
    with pytest.raises(RecountError, match="must be a bool"):
        binned_rows(
            SITES,
            table,
            cohort_id=COHORT,
            ingest_version="fixture-1",
            sampling_design="healthy_reference",
            disease_ascertainment_excluded=1,  # type: ignore[arg-type]
        )
    rows = binned_rows(SITES, table, cohort_id=COHORT, ingest_version="fixture-1", **ASC)
    with pytest.raises(RecountError, match="BINNED_COLUMNS"):
        with_derived_ids(rows.drop(columns="pos"))


def test_rows_keep_zero_counts_drop_unobserved_cells_and_derive_ids(tmp_path, registry):
    rows = binned_rows(
        SITES,
        population_table(fixture_stage(), *registry),
        cohort_id=recount_cohort_id("fixture-8"),
        ingest_version="fixture-1",
        **ASC,
    )
    assert tuple(rows.columns) == BINNED_COLUMNS
    assert rows["ac"].tolist() == [1, 1, 0, 0] and rows["an"].tolist() == [2, 4, 4, 4]
    assert set(rows["sampling_design"]) == {"healthy_reference"} and set(rows["cohort_id"]) == {COHORT}
    assert rows["disease_ascertainment_excluded"].tolist() == [True] * 4
    full = OBSERVATIONS_SCHEMA.validate(with_derived_ids(rows))
    lookup = lookup_set("gnomad_hgdp_1kg", "fixture-1", GRCH38_LENGTHS)
    written = write_bin(rows, tmp_path, lookup, BinRef("chr1", 0), **W)
    sql = source_record_id_sql(SOURCE_RECORD_ID_TEMPLATE)
    con = writer.connect()
    try:
        query = f"SELECT {sql} FROM read_parquet('{tmp_path / written.path}') ORDER BY 1"
        ids = con.execute(query).fetchall()
    finally:
        con.close()
    assert [r[0] for r in ids] == sorted(full["source_record_id"])
    assert derive_source_record_id("chr11-5227002-T-A", "Yoruba") == (
        "gnomad-hgdp-1kg:chr11-5227002-T-A:Yoruba"
    )


def test_ascertainment_has_no_default():
    parameters = inspect.signature(binned_rows).parameters
    for name in ("sampling_design", "disease_ascertainment_excluded"):
        assert parameters[name].default is inspect.Parameter.empty


def test_the_recount_ascertainment_is_decided_and_still_has_no_default():
    """O1 (#509): ``population_random`` and ``False`` for every row, and the builder still refuses to guess.

    The values live in one place so the CLI, the docs and the fixtures cannot drift apart, and
    ``binned_rows`` keeps both parameters required because an ascertainment default is how a decision
    turns back into a guess (AGENTS.md).
    """
    from genomeos.observations.sources.gnomad_recount import rows as recount_rows

    assert recount_rows.RECOUNT_SAMPLING_DESIGN == "population_random"
    assert recount_rows.RECOUNT_DISEASE_ASCERTAINMENT_EXCLUDED is False
    assert "undecided" not in (recount_rows.__doc__ or "")
    assert "#509" in (recount_rows.__doc__ or "")

    parameters = inspect.signature(recount_rows.binned_rows).parameters
    for name in ("sampling_design", "disease_ascertainment_excluded"):
        assert parameters[name].default is inspect.Parameter.empty, (
            f"{name} must stay required: an ascertainment default hides the decision"
        )
