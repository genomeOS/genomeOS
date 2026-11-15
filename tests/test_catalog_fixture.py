"""The committed catalog fixture, and its attach from a DuckDB other than the writer's.

Atlas data platform design 2026-10-18 §2.6, §3.1 and step 1.6; builder's call 15. ``tests/fixtures/catalog``
is release 2026-11-20 of ``catalog_tree``: its ``catalog.sql`` with the four lookup macros after its views,
its ``atlas.duckdb`` (storage v1.2.0), every file the views and macros read under ``data/``, and
``expected.json``, each view's row count and what the macros return. CI attaches it and runs the macros
from DuckDB 1.2.2 through ``scripts/check_catalog_attach.py``, and
``website/tests/atlas-catalog-attach.test.ts`` attaches it from the pinned DuckDB-WASM.
"""

from __future__ import annotations

import ast
import json
import shutil
import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

from genomeos.tables import catalog
from scripts import build_catalog_fixture as fixture
from scripts import check_catalog_attach as attach

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "catalog"
ATTACH_SCRIPT = ROOT / "scripts" / "check_catalog_attach.py"
CATALOG = ["--catalog", str(FIXTURE / "atlas.duckdb"), "--local", str(FIXTURE / "data")]
#: The builder's ``--check`` run as a script where pytest is not installed; it then prints its exit code
#: and every module of the ``tests`` package that got imported.
WITHOUT_PYTEST = """
import runpy, sys
sys.modules["pytest"] = None
sys.argv = ["build_catalog_fixture.py", "--check"]
try:
    runpy.run_path("scripts/build_catalog_fixture.py", run_name="__main__")
except SystemExit as stop:
    print(stop.code)
print(sorted(name for name in sys.modules if name.partition(".")[0] == "tests"))
"""


def test_the_committed_catalog_fixture_is_current() -> None:
    assert fixture.main(["--check"]) == 0


def test_the_fixture_builder_needs_no_pytest_and_imports_nothing_from_tests() -> None:
    """A script under scripts/ builds the trees from scripts/fixture_trees.py, never from tests/."""
    result = subprocess.run(
        [sys.executable, "-c", WITHOUT_PYTEST], cwd=ROOT, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-2:] == ["0", "[]"]


def test_the_fixture_check_names_each_stale_file(tmp_path: Path) -> None:
    """Parquet files byte for byte, atlas.duckdb by its views, and no file more or less."""
    stale = tmp_path / "catalog"
    shutil.copytree(FIXTURE, stale)
    parity = stale / "data" / catalog.PARITY_FILE
    parity.write_bytes(parity.read_bytes() + b"\0")
    (stale / "atlas.duckdb").unlink()
    duckdb.connect(str(stale / "atlas.duckdb")).execute("CREATE VIEW meta_release AS SELECT 1").close()
    (stale / "expected.json").unlink()
    (stale / "notes.txt").write_text("not built\n", encoding="utf-8")
    assert fixture.check_fixture(stale) == [
        "expected.json: missing",
        "notes.txt: not part of the fixture",
        "atlas.duckdb: differs from a fresh build",
        f"data/{catalog.PARITY_FILE}: differs from a fresh build",
    ]


def test_the_fixture_check_compares_the_catalog_macros(tmp_path: Path) -> None:
    """atlas.duckdb with the same views but one macro fewer is stale."""
    stale = tmp_path / "catalog"
    shutil.copytree(FIXTURE, stale)
    con = duckdb.connect()
    con.execute(f"ATTACH '{stale / 'atlas.duckdb'}' AS fixture")
    con.execute("DROP MACRO TABLE fixture.measured.variant")
    con.close()
    assert fixture.check_fixture(stale) == ["atlas.duckdb: differs from a fresh build"]


def test_the_attach_check_passes_on_the_fixture_under_the_pinned_duckdb() -> None:
    """The CI step's command, in isolated mode, under the writer's own DuckDB."""
    result = subprocess.run(
        [sys.executable, "-I", str(ATTACH_SCRIPT), *CATALOG, "--expect", str(FIXTURE / "expected.json")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "DuckDB 1.5.5:" in result.stdout
    # The macros' files (one bin, one curated file) are outside the fixture release, so no view lists them.
    assert "8 views" in result.stdout
    assert "macros: rs334 2 curated + 3 recount rows" in result.stdout


def test_the_attach_check_runs_the_macros(capsys: pytest.CaptureFixture[str]) -> None:
    """rs334 unions the curated file's 2 rows with the bin's 3; chrM computes no URL; no surface is listed."""
    expected = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))
    assert expected["macros"] == {
        "variant": [
            ["gnomad-hgdp-1kg:curated-tsv", 2, 6, 300],
            ["gnomad-v3.1.2-hgdp-1kg:fixture-3:d18-v1", 3, 7, 296],
        ],
        "lookup_url_chrM": [],
        "surfaces_rows": 0,
    }
    assert attach.check(FIXTURE / "atlas.duckdb", FIXTURE / "data", expected=expected) == []
    assert (
        "macros: rs334 2 curated + 3 recount rows; chrM-16519-T-C computes no URL" in capsys.readouterr().out
    )
    expected["macros"]["variant"][1][1] = 4
    problems = attach.check(FIXTURE / "atlas.duckdb", FIXTURE / "data", expected=expected)
    assert len(problems) == 1 and "measured.variant" in problems[0]
    assert "macros:" not in capsys.readouterr().out


def test_the_attach_check_fails_on_a_wrong_count(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    expected = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))
    expected["views"]["meta.release"] = 2
    wrong = tmp_path / "expected.json"
    wrong.write_text(json.dumps(expected), encoding="utf-8")
    assert attach.main([*CATALOG, "--expect", str(wrong)]) == 1
    captured = capsys.readouterr()
    assert "meta.release" in captured.err
    assert "views read offline" not in captured.out
    assert attach.main([*CATALOG, "--expect-views", "9"]) == 1
    assert "9" in capsys.readouterr().err


@pytest.mark.parametrize(
    "arguments",
    [[], ["--expect", "expected.json", "--expect-views", "8"]],
    ids=["neither", "both"],
)
def test_the_attach_check_takes_exactly_one_expectation(arguments: list[str]) -> None:
    with pytest.raises(SystemExit):
        attach.main([*CATALOG, *arguments])


def test_the_attach_check_imports_only_duckdb_and_the_standard_library() -> None:
    """It runs under ``python -I`` in a bare venv holding only ``duckdb``."""
    modules = set()
    for node in ast.walk(ast.parse(ATTACH_SCRIPT.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            modules |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0 and node.module is not None
            modules.add(node.module.split(".")[0])
    assert "duckdb" in modules
    assert {name for name in modules - {"duckdb"} if name not in sys.stdlib_module_names} == set()
