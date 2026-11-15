"""The parity smoke on a release's catalog (Atlas data platform design 2026-10-18 §2.7 check 8; call 3)."""

from __future__ import annotations

from pathlib import Path

import pytest

from genomeos.tables import catalog
from scripts import smoke_catalog as smoke
from tests import tables_fixtures
from tests.tables_fixtures import EPOCH, build_catalog_tables, release_catalog_tree

catalog_tree = tables_fixtures.catalog_tree


@pytest.fixture
def released(catalog_tree: Path) -> Path:
    """``catalog_tree``'s data/ tree, released with its catalog."""
    build_catalog_tables(catalog_tree)
    release_catalog_tree(catalog_tree)
    return catalog_tree / "data"


def test_the_smoke_names_the_first_differing_count(
    released: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The fixture's 3 parity rows are not the golden 994, and its disc holds 2 of them, not 40."""
    assert smoke.main(["--catalog", str(released / catalog.CATALOG_DB), "--local", str(released)]) == 1
    captured = capsys.readouterr()
    assert "disc_rows 2, expected 40" in captured.err
    assert "golden" not in captured.out


def test_catalog_url() -> None:
    assert smoke.catalog_url("2026-11-20") == (
        "https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/catalog/atlas.duckdb"
    )


def test_a_catalog_of_another_release_is_refused(
    released: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``--release`` reads meta.release before any file, so a stale catalog stops with no download."""
    monkeypatch.setattr(smoke, "catalog_url", lambda release, base=None: str(released / catalog.CATALOG_DB))
    assert smoke.main(["--release", "2026-11-21"]) == 1
    error = capsys.readouterr().err
    assert EPOCH in error and "2026-11-21" in error


@pytest.mark.parametrize(
    "arguments",
    [
        [],
        ["--catalog", "x.duckdb"],
        ["--local", "data"],
        ["--release", "2026-11-20", "--catalog", "x.duckdb"],
    ],
)
def test_the_smoke_takes_a_release_or_a_local_catalog(arguments: list[str]) -> None:
    with pytest.raises(SystemExit):
        smoke.main(arguments)
