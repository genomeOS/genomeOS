"""Raw harvests and external caches, each published with its source's terms (Atlas data platform design
2026-10-18 §2.1, §2.3, §4.3; step 1.8, #472)."""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path

import pytest

from genomeos.publication import data_release as dr
from genomeos.publication import raw_harvests as rh
from genomeos.publication.source_terms import REVIEWED_SOURCES

ROOT = Path(__file__).resolve().parents[1]
SHA_A = "a" * 64
SHA_B = "b" * 64
HARVEST = rh.RawHarvest(
    source="map",
    harvest_version="2026-08",
    files=(("g6pd.csv", SHA_A), ("hbs.csv", SHA_B)),
    upstream_url="https://data.malariaatlas.org/",
    copied_from=f"hf://datasets/bschilder/genomeos-data@{'0' * 40}/raw",
    retrieved_at=rh.NOT_RECORDED,
    fetch_command="python scripts/fetch_map_hbs.py --layer hbs",
)


def _record(path: str, sha256: str, size: int = 10) -> dr.FileRecord:
    return dr.FileRecord(path, size, sha256, False, (path.split("/")[1],))


def _records(harvest: rh.RawHarvest = HARVEST) -> list[dr.FileRecord]:
    return [_record(rh.harvest_path(harvest, name), sha256) for name, sha256 in harvest.files]


def test_a_harvest_lives_under_its_source_and_version() -> None:
    assert HARVEST.root == "raw/map/2026-08"
    assert rh.harvest_path(HARVEST, "hbs.csv") == "raw/map/2026-08/hbs.csv"
    with pytest.raises(dr.DataReleaseError, match="lists no file 'other.csv'"):
        rh.harvest_path(HARVEST, "other.csv")
    rh.check_raw_harvests(_records(), [HARVEST])


def test_a_refetch_with_other_bytes_needs_a_new_harvest_version() -> None:
    records = _records()
    records[1] = _record(records[1].path, "c" * 64)
    with pytest.raises(dr.DataReleaseError, match="raw/map/2026-08/hbs.csv: .* new harvest_version"):
        rh.check_raw_harvests(records, [HARVEST])


def test_a_listed_harvest_file_missing_locally_is_refused() -> None:
    with pytest.raises(dr.DataReleaseError, match="raw/map/2026-08/hbs.csv: .*missing"):
        rh.check_raw_harvests(_records()[:1], [HARVEST])


@pytest.mark.parametrize("path", ["raw/map/2026-08/extra.csv", "raw/other/2026-08/x.csv", "raw/loose.tsv"])
def test_an_unlisted_raw_file_is_refused(path: str) -> None:
    with pytest.raises(dr.DataReleaseError, match=f"{re.escape(path)}: no reviewed raw harvest"):
        rh.check_raw_harvests([*_records(), _record(path, SHA_A)], [HARVEST])


def test_a_harvest_listed_twice_is_refused() -> None:
    with pytest.raises(dr.DataReleaseError, match="raw/map/2026-08: listed twice"):
        rh.check_raw_harvests(_records(), [HARVEST, HARVEST])


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source", "nope"),
        ("harvest_version", "Aug 2026"),
        ("files", ()),
        ("files", (("hbs.csv", SHA_B), ("g6pd.csv", SHA_A))),
        ("files", (("hbs.csv", SHA_B), ("hbs.csv", SHA_B))),
        ("files", (("sub/hbs.csv", SHA_B),)),
        ("files", (("hbs.csv", "B" * 64),)),
        ("upstream_url", "http://x"),
        ("copied_from", "hf://datasets/other/x@main/y"),
        ("retrieved_at", "2026"),
        ("fetch_command", " "),
    ],
)
def test_a_harvest_field_outside_its_rule_is_refused(field: str, value: object) -> None:
    with pytest.raises(dr.DataReleaseError, match=f"^raw harvest [^:]+: {field} "):
        dataclasses.replace(HARVEST, **{field: value})


def test_a_harvest_may_be_fetched_rather_than_copied_and_dated() -> None:
    harvest = dataclasses.replace(
        HARVEST, harvest_version="2020", copied_from=None, retrieved_at="2026-11-15"
    )
    assert harvest.root == "raw/map/2020"


def test_the_legacy_afnd_table_is_not_a_harvest() -> None:
    """``raw/afnd_populations.tsv`` predates the harvest layout: an include root of its own (§2.1)."""
    assert rh.LEGACY_RAW == ("raw/afnd_populations.tsv",)
    rh.check_raw_harvests([_record(rh.LEGACY_RAW[0], SHA_A)], [])
    listed = {rh.harvest_path(harvest, name) for harvest in rh.RAW_HARVESTS for name, _ in harvest.files}
    assert not listed & set(rh.LEGACY_RAW)


def test_the_real_harvest_roster() -> None:
    assert {h.root: [name for name, _ in h.files] for h in rh.RAW_HARVESTS} == {
        "raw/afnd/2026-08": ["afnd_frequencies.tsv"],
        "raw/map/2026-08": ["map_g6pd_surveys.csv", "map_hbs_surveys.csv"],
        "raw/worldpop/2020": ["cok_ppp_2020_UNadj.tif", "ppp_2020_1km_Aggregated.tif"],
    }


def test_every_real_harvest_has_64_hex_digests_and_recorded_terms() -> None:
    assert rh.RAW_HARVESTS
    for harvest in rh.RAW_HARVESTS:
        assert all(re.fullmatch(r"[0-9a-f]{64}", sha256) for _, sha256 in harvest.files), harvest.root
        terms = REVIEWED_SOURCES[harvest.source]["terms"]
        assert terms["status"] != dr.NOT_CHECKED, harvest.root
        assert terms["recorded_in"], harvest.root
    catalog = json.loads((ROOT / "website/src/atlas/public-artifacts.json").read_text(encoding="utf-8"))
    copied = {harvest.copied_from for harvest in rh.RAW_HARVESTS} - {None}
    assert copied == {f"hf://datasets/{catalog['hf_dataset']}@{catalog['hf_revision']}/raw"}


#: Where the publishing machine's INVENTORY (released in 2026-10-17) recorded each pinned file.
INVENTORY_PATHS = {
    "raw/afnd/2026-08/afnd_frequencies.tsv": "data/raw/afnd_frequencies.tsv",
    "raw/map/2026-08/map_g6pd_surveys.csv": "data/raw/map_g6pd_surveys.csv",
    "raw/map/2026-08/map_hbs_surveys.csv": "data/raw/map_hbs_surveys.csv",
    "raw/worldpop/2020/cok_ppp_2020_UNadj.tif": "data/raw/worldpop_cok_100m_2020_UNadj.tif",
    "raw/worldpop/2020/ppp_2020_1km_Aggregated.tif": "data/raw/worldpop_1km_2020.tif",
}


def test_the_real_pins_equal_the_released_inventory() -> None:
    """The bytes each surface was fit on: the publishing machine hashed them before the fits shipped."""
    inventory = json.loads((ROOT / "data/store/INVENTORY.json").read_text(encoding="utf-8"))
    recorded = {item["path"]: item["sha256"] for item in inventory["files"]}
    pinned = {rh.harvest_path(h, name): sha256 for h in rh.RAW_HARVESTS for name, sha256 in h.files}
    assert {path: recorded[INVENTORY_PATHS[path]] for path in pinned} == pinned


def test_an_external_cache_carrying_a_non_commercial_field_is_refused() -> None:
    alphagenome = {"record": {"avi_phred": 31.2, "top_attributions": [{"feature": "x"}]}}
    with pytest.raises(
        dr.DataReleaseError, match=re.escape("split out top_attributions before publishing (R5, design §4.3)")
    ):
        rh.check_external_cache("store/external/alphagenome/chr11-5227002-t-a.json", alphagenome)
    gnomad = {"record": {"joint": {"populations": [{"id": "afr", "spliceai": {"ds_max": 0.1}}]}}}
    with pytest.raises(dr.DataReleaseError, match="spliceai"):
        rh.check_external_cache("store/external/gnomad/chr11-5227002-t-a.json", gnomad)
    rh.check_external_cache("store/external/gnomad/chr11-5227002-t-a.json", {"record": {"joint": {}}})
    rh.check_external_cache("store/external/dbsnp/rs334.json", {"record": {"spliceai": 1}})  # gnomAD's only


def test_an_external_cache_outside_the_reviewed_sources_is_refused() -> None:
    assert rh.EXTERNAL_CACHE_SOURCES == ("alphagenome", "dbsnp", "gnomad")
    with pytest.raises(dr.DataReleaseError, match="no reviewed external cache source"):
        rh.check_external_cache("store/external/other/x.json", {})
