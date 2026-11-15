"""The HGDP + 1KG registry adapter (Atlas data platform design 2026-10-18 §1.2 D18, §2.4; step 1.7).

Its fixture holds six synthetic ``hgdp`` rows (ancestral, with HGDP's notice) and one ``onekg`` row
(GBR, a sampling site, with no notice); every coordinate and radius in it is synthetic.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from genomeos.observations.sources import gnomad_hgdp_1kg as gnomad
from genomeos.registry.publication import publish_registry, registry_release
from genomeos.registry.release_contract import identify_input
from genomeos.registry.sources import hgdp, hgdp_1kg

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES / "hgdp_1kg_populations.tsv"
VERSION = "1.0.0"


def _edited(tmp_path: Path, label: str, column: str, value: str) -> Path:
    """The fixture with ``column`` of the row for ``label`` set to ``value``."""
    header, *rows = FIXTURE.read_text(encoding="utf-8").splitlines()
    names = header.split("\t")
    lines = [header]
    for row in rows:
        fields = row.split("\t")
        if fields[names.index("population")] == label:
            fields[names.index(column)] = value
        lines.append("\t".join(fields))
    path = tmp_path / "populations.tsv"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _identity(aliases) -> dict[str, tuple[str, str]]:
    return {row.label: (row.source, row.population_id) for row in aliases.itertuples()}


def test_colliding_labels_stay_four_identities():
    populations, aliases = hgdp_1kg.load(FIXTURE, VERSION)
    identity = _identity(aliases)
    assert [identity[label][1] for label in ("Han", "NorthernHan", "PapuanHighlands", "PapuanSepik")] == [
        "hgdp-han",
        "hgdp-northernhan",
        "hgdp-papuanhighlands",
        "hgdp-papuansepik",
    ]
    assert identity["GBR"] == ("onekg", "onekg-gbr")
    assert sorted(populations["population_id"]) == sorted(aliases["population_id"])
    assert hgdp_1kg.population_id("hgdp", "Yoruba") == hgdp.slugify("Yoruba")


def test_location_type_is_read_never_defaulted(tmp_path):
    populations, aliases = hgdp_1kg.load(FIXTURE, VERSION)
    placed = dict(zip(populations["population_id"], populations["location_type"], strict=True))
    assert placed.pop("onekg-gbr") == "sampling"
    assert set(placed.values()) == {"ancestral"}
    with pytest.raises(ValueError, match="location_type"):
        hgdp_1kg.load(_edited(tmp_path, "GBR", "location_type", ""), VERSION)


@pytest.mark.parametrize(
    "column", [name for name in hgdp_1kg.REQUIRED_COLUMNS if name != "biocultural_notice"]
)
def test_a_blank_required_value_is_refused(tmp_path, column):
    with pytest.raises(ValueError, match=column):
        hgdp_1kg.load(_edited(tmp_path, "Han", column, " "), VERSION)


@pytest.mark.parametrize("notice", ["", "Some other notice."])
def test_an_hgdp_row_needs_the_biocultural_notice(tmp_path, notice):
    with pytest.raises(ValueError, match="biocultural_notice"):
        hgdp_1kg.load(_edited(tmp_path, "Han", "biocultural_notice", notice), VERSION)
    populations, _ = hgdp_1kg.load(FIXTURE, VERSION)
    notices = dict(zip(populations["population_id"], populations["biocultural_notice"], strict=True))
    assert pd.isna(notices.pop("onekg-gbr"))  # an onekg blank is null, never an empty notice
    assert set(notices.values()) == {hgdp.BIOCULTURAL_NOTICE}


def test_an_unknown_alias_source_is_refused(tmp_path):
    with pytest.raises(ValueError, match="alias_source"):
        hgdp_1kg.load(_edited(tmp_path, "GBR", "alias_source", "tgp"), VERSION)
    with pytest.raises(ValueError, match="alias_source"):
        hgdp_1kg.population_id("tgp", "GBR")


def test_the_gnomad_adapter_resolves_through_the_new_ids():
    populations, aliases = hgdp_1kg.load(FIXTURE, VERSION)
    observations = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", populations, aliases, "0.1.0")
    assert set(observations["population_id"]) == {"hgdp-yoruba", "hgdp-sardinian", "hgdp-han"}


def test_registry_release_is_publish_registrys_identity(tmp_path):
    populations, aliases = hgdp_1kg.load(FIXTURE, VERSION)
    inputs = (identify_input("source", "hgdp_1kg", FIXTURE.read_bytes()),)
    release = registry_release(populations, aliases, inputs=inputs, release_version=VERSION)
    published = publish_registry(
        populations, aliases, inputs=inputs, release_version=VERSION, out=tmp_path / "r"
    )
    assert release.registry_version == published.registry_version
    assert release.registry_version.startswith(f"{VERSION}+sha256.")
    assert set(release.populations["registry_version"]) == {release.registry_version}
