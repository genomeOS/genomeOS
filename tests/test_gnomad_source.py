import re
from pathlib import Path

import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.observations.sources import gnomad_hgdp_1kg as gnomad
from genomeos.observations.sources.gnomad_recount.rows import recount_cohort_id
from genomeos.observations.sources.gnomad_recount.rule import GNOMAD_RELEASE
from genomeos.registry.build import build_registry
from genomeos.registry.sources import hgdp
from genomeos.validation.reference_cohorts import PAPER_STAGE

FIXTURES = Path(__file__).parent / "fixtures"
# A version token in the form gnomAD names its releases (v3.1.2, v4).
_RELEASE_TOKEN = re.compile(r"\bv\d+(?:\.\d+)*\b")


@pytest.fixture
def registry():
    return build_registry([hgdp.load(FIXTURES / "hgdp_populations.tsv", "0.1.0")])


def test_load_conforms_to_schema(registry):
    populations, aliases = registry
    obs = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", populations, aliases, "0.1.0")
    OBSERVATIONS_SCHEMA.validate(obs)
    assert len(obs) == 4


def test_coordinates_and_radius_come_from_the_registry(registry):
    populations, aliases = registry
    obs = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", populations, aliases, "0.1.0")
    yoruba = obs[obs["population_id"] == "hgdp-yoruba"].iloc[0]
    assert yoruba["lat"] == pytest.approx(7.38)
    assert yoruba["radius_km"] == pytest.approx(2.5)


def test_gnomad_is_marked_disease_depleted_healthy_reference(registry):
    """gnomAD excludes severe pediatric disease cases and their first-degree relatives (§7.1a)."""
    populations, aliases = registry
    obs = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", populations, aliases, "0.1.0")
    assert (obs["sampling_design"] == "healthy_reference").all()
    assert obs["disease_ascertainment_excluded"].all()


def test_zero_count_rows_are_retained(registry):
    populations, aliases = registry
    obs = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", populations, aliases, "0.1.0")
    assert (obs["ac"] == 0).sum() == 2


def test_source_record_ids_use_the_native_variant_population_key(registry):
    """Catches unstable dataframe positions or random IDs breaking evidence joins."""
    populations, aliases = registry
    obs = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", populations, aliases, "0.1.0")
    assert obs["source_record_id"].is_unique
    assert "gnomad-hgdp-1kg:chr11-5227002-T-A:Yoruba" in set(obs["source_record_id"])


def test_cohort_id_names_the_curated_tsv_count_set_not_a_gnomad_release(registry):
    """The TSV route is fixture-backed, so its rows name no gnomAD release (builder's call 36).

    The recount's cohort does name one, and the token pattern must find it there, so the
    final check can fail.
    """
    obs = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", *registry, "0.1.0")
    assert set(obs["cohort_id"]) == {"gnomad-hgdp-1kg:curated-tsv"}
    assert GNOMAD_RELEASE in _RELEASE_TOKEN.findall(recount_cohort_id(PAPER_STAGE))
    named = [c for c in {gnomad.COHORT_ID, *obs["cohort_id"]} if _RELEASE_TOKEN.search(c)]
    assert not named, f"curated cohort ids name a release: {named}"


def test_unmapped_population_label_is_a_hard_error(tmp_path, registry):
    populations, aliases = registry
    bad = tmp_path / "bad.tsv"
    bad.write_text(
        "variant_id\trsid\tpop_label\tAC\tAN\nchr11-5227002-T-A\trs334\tAtlantis\t1\t100\n"
    )
    with pytest.raises(gnomad.UnmappedPopulationError, match="Atlantis"):
        gnomad.load(bad, populations, aliases, "0.1.0")
