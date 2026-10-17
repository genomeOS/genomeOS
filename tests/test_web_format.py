"""The Python→web Atlas data format version (docs/web-data-format.md; fast-load design §B.4, #467)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from genomeos.publication import surface_codec, web_format
from genomeos.publication.web_format import (
    CURRENT,
    WEB_FORMAT_VERSION,
    WebFormatError,
    catalog_format_version,
    parse_format_version,
    require_current,
    require_known,
)
from scripts import encode_natural_earth_borders, export_atlas_web

ROOT = Path(__file__).resolve().parents[1]
TS_CONSTANT = ROOT / "website" / "src" / "atlas" / "format-version.ts"
DEPLOYED_CATALOG = ROOT / "website" / "public" / "data" / "atlas" / "catalog.json"
#: Every committed fixture catalog. Readers must handle older MINORs, so these may lag the producer.
FIXTURE_CATALOGS = (
    "tests/fixtures/atlas-web/export/catalog.json",
    "website/tests/fixtures/atlas/golden/catalog.json",
    "website/tests/fixtures/atlas/parity/catalog.json",
    "website/tests/fixtures/atlas/e2e/catalog.json",
)
#: What each format MAJOR fixes in the objects a catalog references. A row is frozen once a catalog
#: of that MAJOR is deployed: a new per-object version is a new MAJOR and a new row, never an edit.
PINNED_OBJECT_VERSIONS = {
    1: {
        "gosa container format_version": 1,
        "gosa header schema_version": 1,
        "gobd container format_version": 1,
        "surface and observations json schema_version": 1,
    },
}


@pytest.mark.parametrize(
    ("text", "parsed"), [("1.0", (1, 0)), ("1.12", (1, 12)), ("0.3", (0, 3)), ("10.0", (10, 0))]
)
def test_a_major_minor_string_parses(text: str, parsed: tuple[int, int]) -> None:
    assert parse_format_version(text) == parsed


@pytest.mark.parametrize(
    "value",
    [1, 1.0, True, None, "", "1", "1.0.0", "01.0", "1.01", "v1.0", " 1.0", "1.0\n", "1.-1", "１.０"],
)
def test_anything_else_is_refused_not_coerced(value: object) -> None:
    with pytest.raises(WebFormatError, match="MAJOR.MINOR"):
        parse_format_version(value)


def test_a_catalog_without_format_version_is_refused_never_read_as_one() -> None:
    with pytest.raises(WebFormatError, match="declares no format_version"):
        catalog_format_version({"schema_version": 1, "artifacts": []})
    with pytest.raises(WebFormatError, match="not a JSON object"):
        catalog_format_version([])


def test_writers_accept_exactly_the_current_version() -> None:
    major, minor = parse_format_version(WEB_FORMAT_VERSION)
    require_current({"format_version": WEB_FORMAT_VERSION})
    for other in (f"{major}.{minor + 1}", f"{major + 1}.0", f"{major + 1}.{minor}"):
        with pytest.raises(WebFormatError, match="this code writes"):
            require_current({"format_version": other})


def test_python_readers_refuse_another_major_or_a_newer_minor(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_format, "CURRENT", (1, 2))
    assert require_known({"format_version": "1.0"}) == (1, 0)  # an older MINOR is a subset
    assert require_known({"format_version": "1.2"}) == (1, 2)
    with pytest.raises(WebFormatError, match="newer than 1.2"):
        require_known({"format_version": "1.3"})
    for other in ("2.0", "0.9"):
        with pytest.raises(WebFormatError, match="reads MAJOR 1 only"):
            require_known({"format_version": other})


def test_the_typescript_client_reads_what_this_code_writes() -> None:
    """One constant per language; this and website/tests/atlas-format-version.test.ts make them agree.

    Agree means the same MAJOR, with the client's MINOR never ahead of the producer's. The producer
    may be a MINOR ahead: the client reads that catalog and ignores the keys it does not know, so a
    MINOR change does not force a client change (docs/web-data-format.md).
    """
    found = re.findall(
        r"^export const ATLAS_WEB_FORMAT_VERSION = '([^']*)';$", TS_CONSTANT.read_text(), re.MULTILINE
    )
    assert len(found) == 1, f"expected one ATLAS_WEB_FORMAT_VERSION in {TS_CONSTANT}, found {found}"
    client_major, client_minor = parse_format_version(found[0])
    assert client_major == CURRENT[0], "a MAJOR change must land in Python and TypeScript together"
    assert client_minor <= CURRENT[1], "the client claims a MINOR this producer has not defined"


def test_the_deployed_catalog_is_exactly_the_format_this_code_writes() -> None:
    catalog = json.loads(DEPLOYED_CATALOG.read_text(encoding="utf-8"))
    require_current(catalog)
    assert "schema_version" not in catalog  # the catalog's pre-#467 integer, replaced, not kept beside


@pytest.mark.parametrize("path", FIXTURE_CATALOGS)
def test_every_fixture_catalog_is_a_format_this_code_reads(path: str) -> None:
    catalog = json.loads((ROOT / path).read_text(encoding="utf-8"))
    require_known(catalog)
    assert "schema_version" not in catalog


def test_the_format_major_pins_every_per_object_version() -> None:
    """Changing a per-object slot without a new format MAJOR would let a client of the old MAJOR
    accept the catalog and then fail on the object; see docs/web-data-format.md, "Bumping"."""
    major, _ = parse_format_version(WEB_FORMAT_VERSION)
    assert major in PINNED_OBJECT_VERSIONS, f"format MAJOR {major} has no pinned-object row"
    assert {
        "gosa container format_version": surface_codec.FORMAT_VERSION,
        "gosa header schema_version": surface_codec.SCHEMA_VERSION,
        "gobd container format_version": encode_natural_earth_borders.FORMAT_VERSION,
        "surface and observations json schema_version": export_atlas_web.SCHEMA_VERSION,
    } == PINNED_OBJECT_VERSIONS[major]
