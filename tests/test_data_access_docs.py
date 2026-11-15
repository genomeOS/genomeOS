"""docs/data-access.md against the code it describes (Atlas data platform design 2026-10-18 §3, §2.9,
§5, step 1.15), and docs/cost-controls.md's cache line (#473, #482).

The page states URLs, commands and numbers that the code owns. Each test reads the page and the code
together, so a change to either that leaves the other behind fails here. The SQL the page leads with is
checked against the browser panel's in website/tests/data-access-doc.test.ts.
"""

from __future__ import annotations

import contextlib
import io
import re
import shlex
from pathlib import Path

import pytest

from genomeos.publication import access_policy as ap
from genomeos.publication import cost_triggers as ct
from genomeos.publication import data_release as dr
from scripts import fetch_data as fd

DOCS = Path(__file__).resolve().parents[1] / "docs"
SECTIONS = [
    "Look up one variant",
    "Query in your browser",
    "URLs",
    "Quickstarts",
    "Downloads",
    "Offline mode",
    "Citing",
    "Takedowns",
    "When access stops: the brake and the kill switch",
    "Audit logs and privacy",
]
FENCED = re.compile(r"^```.*?^```", re.MULTILINE | re.DOTALL)
# Any Cloud Storage location: an HTTPS URL on its API host, or a gs:// one (which needs credentials).
STORAGE_URL = re.compile(r"(?:gs://|(?:https?://)?storage\.googleapis\.com/)[^\s`'\")<>]*")
# The arguments of each fetch_data.py command, inline or in a block, up to a comment or code span's end.
FETCH_COMMAND = re.compile(r"python scripts/fetch_data\.py([^\n`#]*)")


def _read(name: str) -> str:
    return (DOCS / name).read_text(encoding="utf-8")


def test_the_sections_are_in_order() -> None:
    prose = FENCED.sub("", _read("data-access.md"))
    assert re.findall(r"^## (.+)$", prose, re.MULTILINE) == SECTIONS


def test_every_storage_url_is_the_committed_base() -> None:
    urls = STORAGE_URL.findall(_read("data-access.md"))
    assert urls, "the page names no data-store URL"
    assert [url for url in urls if not url.startswith(dr.DATA_STORE_BASE_URL)] == []


def test_every_fetch_command_parses() -> None:
    commands = FETCH_COMMAND.findall(_read("data-access.md"))
    assert commands, "the page documents no fetch_data.py command"
    for arguments in commands:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            try:
                fd.build_parser().parse_args(shlex.split(arguments))
            except SystemExit:
                pytest.fail(f"python scripts/fetch_data.py{arguments}: {stderr.getvalue().strip()}")


def test_the_numbers_match_the_code() -> None:
    doc = _read("data-access.md")
    assert f"Cache-Control: {dr.CACHE_CONTROL}" in doc
    assert "$300" in doc
    assert "20 GiB" in doc
    assert ap.LOOKUP_DAILY_BYTES_MAX == 20 * 1024**3
    assert ct.KILL_SWITCH_USD == 300


def test_the_stale_cache_line_is_gone() -> None:
    text = _read("cost-controls.md")
    assert "max-age=31536000" not in text
    assert "up to a year" not in text
    assert f"Cache-Control: {dr.CACHE_CONTROL}" in text


def test_data_store_links_data_access() -> None:
    assert "(data-access.md)" in _read("data-store.md")
