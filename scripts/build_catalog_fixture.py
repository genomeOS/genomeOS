#!/usr/bin/env python3
"""Build, or check, the committed catalog fixture ``tests/fixtures/catalog``.

Atlas data platform design 2026-10-18 §2.6 and §3.1, step 1.6; builder's call 15. The fixture is release
``FIXTURE_RELEASE`` of the tests' ``catalog_tree``, built by ``build_data_release.build(..., catalog=True)``,
with the four lookup macros (``genomeos.tables.lookup_macros``) appended to its ``catalog.sql``:

- ``catalog.sql``: the release's views, then the macros, through ``render_catalog_sql(..., macros=...)``;
- ``atlas.duckdb``, built from it by the pinned writer;
- under ``data/``, the files the views read at their release paths, and the two files the macros read:
  rs334's chr11/5 bin of a lookup set recording chr11 alone, and a curated ``measured.allele_observations``
  file with two rs334 rows. Neither is keyed by the fixture release, so no view lists them (the fixture
  keeps its 8 views); their URLs are ``example-*`` placeholders, never contacted;
- ``expected.json``: each view's row count, and what the macros return (``check_catalog_attach``).

The tree comes from ``scripts/fixture_trees.py``, which ``tests/tables_fixtures.py`` re-exports: a script
never imports ``tests/``, so this one runs without pytest. The pinned DuckDB writes every Parquet file, so
their bytes depend on no pandas or pyarrow version.

    python scripts/build_catalog_fixture.py            # write
    python scripts/build_catalog_fixture.py --check    # fail if stale

``--check`` builds it again and compares the Parquet files, ``catalog.sql`` and ``expected.json`` byte for
byte, and ``atlas.duckdb`` by its views' and macros' SQL, not its bytes: the fixture is built on macOS and
checked on Linux. CI attaches the fixture from DuckDB 1.2.2 (``scripts/check_catalog_attach.py``), and the
website's tests from the pinned DuckDB-WASM (``website/tests/atlas-catalog-attach.test.ts``).
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import shutil
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.observations.schema import OBSERVATIONS_SCHEMA  # noqa: E402
from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.tables import catalog, writer  # noqa: E402
from genomeos.tables.binned import BINNED_COLUMNS, SOURCE_RECORD_ID_TEMPLATE, write_bin  # noqa: E402
from genomeos.tables.contracts import TableError  # noqa: E402
from genomeos.tables.lookup_macros import (  # noqa: E402
    CuratedFile,
    FileRef,
    PublishedLookupSet,
    curated_key,
    lookup_statements,
)
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, bin_path, lookup_set  # noqa: E402
from genomeos.tables.provenance import InputRef  # noqa: E402
from scripts import build_data_release, fixture_trees  # noqa: E402
from scripts.check_catalog_attach import macro_results, view_counts  # noqa: E402

FIXTURE_RELEASE = "2026-11-20"
FIXTURE = ROOT / "tests" / "fixtures" / "catalog"
DATABASE = "atlas.duckdb"
CATALOG_SQL = "catalog.sql"
EXPECTED = "expected.json"
#: The folder of the files the catalog reads, which a reader names in ``genomeos_local``.
DATA = "data"

# --- the files the lookup macros read (Task 9 of the whole-genome plan) ---

#: Where the fixture's lookup set would be published: a placeholder lookup bucket (step 2.5 names it).
LOOKUP_URL_PREFIX = f"https://storage.googleapis.com/example-lookup/releases/{FIXTURE_RELEASE}/"
#: The curated file's release path, and the placeholder URL it would be published at.
CURATED_PATH = (
    "tables/v1/measured/allele_observations/source=gnomad_hgdp_1kg/ingest_version=tsv-fixture/part-0.parquet"
)
CURATED_URL = f"https://storage.googleapis.com/example-data/releases/{FIXTURE_RELEASE}/{CURATED_PATH}"
RS334 = "chr11-5227002-T-A"
#: The cohorts of the recount's bin rows and of the curated rows (whole-genome Decision 4).
RECOUNT_COHORT = "gnomad-v3.1.2-hgdp-1kg:fixture-3:d18-v1"
CURATED_COHORT = "gnomad-hgdp-1kg:curated-tsv"
#: rs334's cells: ``(population_id, source_label, lat, lon, ac, an)``, in the bin and in the curated file.
RS334_RECOUNT = (
    ("hgdp-yoruba", "Yoruba", 7.4, 3.9, 7, 210),
    ("hgdp-han", "Han", 32.27, 114.02, 0, 66),
    ("hgdp-northernhan", "NorthernHan", 40.0, 116.0, 0, 20),
)
RS334_CURATED = (
    ("hgdp-yoruba", "Yoruba", 7.4, 3.9, 5, 200),
    ("hgdp-han", "Han", 32.27, 114.02, 1, 100),
)
#: Both files' provenance: the 80-identity registry parquet as their input, and its sources.
_INPUTS = (
    InputRef(
        f"releases/{FIXTURE_RELEASE}/tables/v1/reference/populations/1.0.0-0a1b2c3d/populations.parquet",
        "a" * 64,
    ),
)
_SOURCES = ("genomeos", "gnomad_hgdp_1kg")


def build_fixture(out: Path) -> None:
    """Release ``FIXTURE_RELEASE`` of ``catalog_tree`` with its catalog and macros, written to ``out``.

    ``out/data`` is replaced; other files in ``out`` are left for ``--check`` to name.
    """
    with tempfile.TemporaryDirectory() as scratch:
        root = fixture_trees.make_catalog_tree(Path(scratch))
        with contextlib.redirect_stdout(io.StringIO()):  # build_tables prints each table's row count
            fixture_trees.build_catalog_tables(root)
        manifest = fixture_trees.release_catalog_tree(root)
        if manifest["release"] != FIXTURE_RELEASE:
            raise TableError(f"catalog_tree released {manifest['release']}, not {FIXTURE_RELEASE}")
        data = root / "data"
        files = build_data_release.listed_files(data, dr.validate_manifest(manifest))
        if catalog.render_catalog_sql(FIXTURE_RELEASE, files) != (data / catalog.CATALOG_SQL).read_text(
            encoding="utf-8"
        ):
            raise TableError(f"{catalog.CATALOG_SQL}: not render_catalog_sql over the release's files")
        statements, bin_file = write_macro_files(data)
        sql = catalog.render_catalog_sql(FIXTURE_RELEASE, files, macros=statements)
        if (out / DATA).exists():
            shutil.rmtree(out / DATA)
        out.mkdir(parents=True, exist_ok=True)
        (out / CATALOG_SQL).write_text(sql, encoding="utf-8")
        writer.build_catalog_db(sql, out / DATABASE, data_root=data)
        for path in (*catalog.catalog_local_paths(sql), bin_file):
            (out / DATA / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(data / path, out / DATA / path)
    expected = {
        "release": FIXTURE_RELEASE,
        "views": view_counts(out / DATABASE, out / DATA),
        "macros": macro_results(out / DATABASE, out / DATA),
    }
    (out / EXPECTED).write_text(json.dumps(expected, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_macro_files(data: Path) -> tuple[tuple[str, str, str, str], str]:
    """Write the macros' two files under ``data``; return the macros over them and the bin's path.

    The bin is rs334's three ``RS334_RECOUNT`` rows, written through ``write_bin`` as chr11/5 of a lookup
    set recording chr11 alone. The curated file is its two ``RS334_CURATED`` rows, written through
    ``writer.write_frame``. The macros list no surface. The ascertainment values are test values only:
    the recount rows' are undecided (whole-genome O1).
    """
    lookup = lookup_set("gnomad_hgdp_1kg", "2026-12-recount", {"chr11": GRCH38_LENGTHS["chr11"]})
    ref = BinRef("chr11", 5)
    recount = _rs334_rows(RS334_RECOUNT, cohort_id=RECOUNT_COHORT, ingest_version=lookup.ingest_version)
    write_bin(
        recount.reindex(columns=list(BINNED_COLUMNS)),
        data,
        lookup,
        ref,
        git_sha=fixture_trees.GIT_SHA,
        inputs=_INPUTS,
        sources=_SOURCES,
    )
    curated = _rs334_rows(RS334_CURATED, cohort_id=CURATED_COHORT, ingest_version="tsv-fixture")
    con = writer.connect()
    try:
        writer.write_frame(
            con,
            OBSERVATIONS_SCHEMA.validate(curated.reindex(columns=list(OBSERVATIONS_SCHEMA.columns))),
            data / CURATED_PATH,
            table="measured.allele_observations",
            git_sha=fixture_trees.GIT_SHA,
            inputs=_INPUTS,
            sources=_SOURCES,
            order_by=("source_record_id",),
        )
    finally:
        con.close()
    published = PublishedLookupSet(lookup, LOOKUP_URL_PREFIX, SOURCE_RECORD_ID_TEMPLATE)
    curated_file = CuratedFile(FileRef(CURATED_PATH, CURATED_URL), frozenset({curated_key(RS334)}))
    return lookup_statements([published], [curated_file], []), bin_path(lookup, ref)


def check_fixture(out: Path) -> list[str]:
    """How the fixture at ``out`` differs from a fresh build: nothing, when the list is empty."""
    with tempfile.TemporaryDirectory() as scratch:
        built = Path(scratch) / "catalog"
        build_fixture(built)
        found, wanted = fixture_files(out), fixture_files(built)
        problems = [f"{path}: missing" for path in sorted(wanted - found)]
        problems += [f"{path}: not part of the fixture" for path in sorted(found - wanted)]
        for path in sorted(found & wanted):
            if path == DATABASE:
                same = database_definitions(out / path) == database_definitions(built / path)
            else:
                same = (out / path).read_bytes() == (built / path).read_bytes()
            if not same:
                problems.append(f"{path}: differs from a fresh build")
    return problems


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build, or check, the committed catalog fixture.")
    parser.add_argument("--check", action="store_true", help="fail if the committed fixture is stale")
    args = parser.parse_args(argv)
    where = FIXTURE.relative_to(ROOT).as_posix()
    try:
        if not args.check:
            build_fixture(FIXTURE)
            print(f"wrote {where}: {len(fixture_files(FIXTURE))} files")
            return 0
        problems = check_fixture(FIXTURE)
    except (TableError, dr.DataReleaseError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if problems:
        print(f"{where} is stale:", *problems, sep="\n  ", file=sys.stderr)
        print("run: python scripts/build_catalog_fixture.py", file=sys.stderr)
        return 1
    print(f"{where}: current")
    return 0


def _rs334_rows(
    cells: Sequence[tuple[str, str, float, float, int, int]], *, cohort_id: str, ingest_version: str
) -> pd.DataFrame:
    """rs334's rows over ``cells``, with every column of either allele table (``pos`` and ``source_label``
    for a bin, ``source_record_id`` for a curated file)."""
    return pd.DataFrame(
        [
            {
                "variant_id": RS334,
                "rsid": "rs334",
                "population_id": population_id,
                "lat": lat,
                "lon": lon,
                "radius_km": 25.0,
                "ac": ac,
                "an": an,
                "source_record_id": f"gnomad-hgdp-1kg:{ingest_version}:{RS334}:{label}",
                "source": "gnomad_hgdp_1kg",
                "assay": "genome",
                "date_lower": 0,
                "date_upper": 0,
                "sampling_design": "healthy_reference",
                "disease_ascertainment_excluded": True,
                "cohort_id": cohort_id,
                "ingest_version": ingest_version,
                "pos": int(RS334.split("-")[1]),
                "source_label": label,
            }
            for population_id, label, lat, lon, ac, an in cells
        ]
    )


def fixture_files(root: Path) -> set[str]:
    """Every file under ``root``, as a path relative to it with ``/`` separators."""
    return {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}


def database_definitions(database: Path) -> list[tuple[str, str, str]]:
    """Each view and macro of ``database``: its schema, name and SQL."""
    con = writer.connect()
    try:
        con.execute(f"ATTACH '{database}' AS fixture (READ_ONLY)")
        views = con.execute(
            "SELECT schema_name, view_name, sql FROM duckdb_views() "
            "WHERE database_name = 'fixture' AND NOT internal ORDER BY ALL"
        ).fetchall()
        macros = con.execute(
            "SELECT schema_name, function_name, macro_definition FROM duckdb_functions() "
            "WHERE database_name = 'fixture' AND function_type IN ('macro', 'table_macro') ORDER BY ALL"
        ).fetchall()
        return views + macros
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
