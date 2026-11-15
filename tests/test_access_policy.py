"""The free/paid line's constants (Atlas data platform design 2026-10-18 §4.2) and their first use."""

from __future__ import annotations

from decimal import Decimal

import pytest

from genomeos.publication import access_policy as ap
from genomeos.publication import data_release as dr
from genomeos.publication import raw_harvests as rh

SHA = "d" * 64


def test_the_section_4_2_constants() -> None:
    assert isinstance(ap.EGRESS_USD_PER_GIB, Decimal)
    assert ap.EGRESS_USD_PER_GIB == Decimal("0.12")
    assert ap.OPEN_OBJECT_MAX_BYTES == 1_073_741_824
    assert ap.OPEN_RELEASE_GCS_MAX_BYTES == 2_147_483_648
    assert ap.LOOKUP_DAILY_BYTES_MAX == 21_474_836_480


def test_an_object_over_1_gib_is_refused_from_a_harvest() -> None:
    """A raw harvest is free whole only up to 1 GiB (§2.1); past it R5–R7 decide, and none is built yet."""
    harvest = rh.RawHarvest(
        source="worldpop",
        harvest_version="2020",
        files=(("big.tif", SHA),),
        upstream_url="https://hub.worldpop.org/",
        copied_from=None,
        retrieved_at=rh.NOT_RECORDED,
        fetch_command="python scripts/fetch_worldpop.py --year 2020",
    )
    path = rh.harvest_path(harvest, "big.tif")

    def record(size: int) -> dr.FileRecord:
        return dr.FileRecord(path, size, SHA, False, ("worldpop",))

    rh.check_raw_harvests([record(1 << 30)], [harvest])
    with pytest.raises(dr.DataReleaseError, match=f"{path}: 1,073,741,825 bytes .*R5–R7"):
        rh.check_raw_harvests([record((1 << 30) + 1)], [harvest])
