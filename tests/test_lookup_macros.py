"""The four lookup macros: measured.variant, measured.near, measured.lookup_url and inferred.surfaces.

Atlas data platform design 2026-10-18 §2.2 rule 3, §2.6, §2.9 and §3.1; builder's calls 30 and 31. Each
test renders the macros over ``macro_release``'s tree, builds them into a catalog with the pinned writer,
attaches it read-only as ``atlas`` and reads offline through ``genomeos_local``: no URL is contacted.
"""

from __future__ import annotations

import ast
import shutil
from collections.abc import Iterator
from pathlib import Path

import duckdb
import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.publication import data_release as dr
from genomeos.surfaces import artifacts
from genomeos.tables import catalog, lookup_macros
from genomeos.tables.catalog import CatalogFile
from genomeos.tables.contracts import TableError
from genomeos.tables.lookup_macros import (
    MAX_MACRO_BYTES,
    OBSERVATION_COLUMNS,
    SURFACE_COLUMNS,
    CuratedFile,
    FileRef,
    PublishedLookupSet,
    SurfaceFile,
    curated_key,
    file_sql,
    lookup_statements,
)
from genomeos.tables.lookup_sets import BIN_BP, BINNED_PREFIX, GRCH38_LENGTHS, variant_bin_path
from tests.lookup_fixtures import RECOUNT, MacroRelease, attach_local, macro_release

#: Format 3's 15 cell columns. Phase-1 Task 23 (step 1.11) names them FORMAT_THREE_COLUMNS; until it
#: lands they are today's ARTIFACT_COLUMNS.
FORMAT_THREE_COLUMNS: tuple[str, ...] = getattr(artifacts, "FORMAT_THREE_COLUMNS", artifacts.ARTIFACT_COLUMNS)
RS334 = "chr11-5227002-T-A"


def _statements(release: MacroRelease) -> tuple[str, str, str, str]:
    return lookup_statements(release.lookups, release.curated, release.surfaces)


@pytest.fixture(scope="module")
def release(tmp_path_factory: pytest.TempPathFactory) -> MacroRelease:
    return macro_release(tmp_path_factory.mktemp("macros"))


@pytest.fixture(scope="module")
def local(release: MacroRelease) -> str:
    return f"{release.data_root}/"


@pytest.fixture(scope="module")
def atlas(release: MacroRelease, local: str) -> Iterator[duckdb.DuckDBPyConnection]:
    con = attach_local(_statements(release), release.data_root, local)
    yield con
    con.close()


def _copy_without(release: MacroRelease, root: Path, *removed: str) -> Path:
    """A copy of the release's data root, less the files or folders ``removed`` (release paths)."""
    copy = root / "data"
    shutil.copytree(release.data_root, copy)
    for path in removed:
        target = copy / path
        shutil.rmtree(target) if target.is_dir() else target.unlink()
    return copy


@pytest.fixture(scope="module")
def atlas_without_binned_tree(
    release: MacroRelease, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[duckdb.DuckDBPyConnection]:
    """The same catalog over a copy with no bin file at all: any computed read would fail."""
    copy = _copy_without(release, tmp_path_factory.mktemp("unbinned"), BINNED_PREFIX)
    con = attach_local(_statements(release), copy, f"{copy}/")
    yield con
    con.close()


def test_variant_returns_17_contract_columns_and_unions_recount_and_curated_apart(
    atlas: duckdb.DuckDBPyConnection,
) -> None:
    described = atlas.execute(f"DESCRIBE SELECT * FROM atlas.measured.variant('{RS334}')").fetchall()
    assert [(r[0], r[1]) for r in described] == list(OBSERVATION_COLUMNS)
    assert [n for n, _ in OBSERVATION_COLUMNS] == list(OBSERVATIONS_SCHEMA.columns)
    assert atlas.execute(
        "SELECT cohort_id, count(*), sum(ac), sum(an) FROM atlas.measured.variant(?) GROUP BY 1 ORDER BY 1",
        [RS334],
    ).fetchall() == [("gnomad-hgdp-1kg:curated-tsv", 2, 6, 300), (RECOUNT, 3, 7, 296)]
    derived = atlas.execute(
        "SELECT source_record_id FROM atlas.measured.variant(?) WHERE cohort_id = ?", [RS334, RECOUNT]
    ).fetchall()
    assert {r[0] for r in derived} == {
        f"gnomad-hgdp-1kg:{RS334}:{x}" for x in ("Yoruba", "Han", "NorthernHan")
    }


@pytest.mark.parametrize(
    "v, rows",
    [
        ("chrM-16519-T-C", 2),
        ("hla:a-02-01", 4),
        ("kir:2dl1", 0),
        ("phenotype:g6pd-deficiency", 0),
        ("chr21-47000001-A-G", 0),
    ],
)
def test_ids_off_the_recorded_set_read_curated_rows_only(
    atlas_without_binned_tree: duckdb.DuckDBPyConnection, v: str, rows: int
) -> None:
    """With no bin file on disk, any computed read would raise."""
    assert atlas_without_binned_tree.execute(
        "SELECT count(*) FROM atlas.measured.variant(?)", [v]
    ).fetchone() == (rows,)
    assert atlas_without_binned_tree.execute("SELECT atlas.measured.lookup_url(?)", [v]).fetchone() == ([],)


def test_lookup_url_macro_agrees_with_python_at_every_contig_edge(
    atlas: duckdb.DuckDBPyConnection, release: MacroRelease, local: str
) -> None:
    lookup = release.lookups[0].lookup
    for chrom, length in GRCH38_LENGTHS.items():
        for pos in (1, length, lookup.n_bins(chrom) * BIN_BP):
            v = f"{chrom}-{pos}-A-G"
            expected = variant_bin_path(lookup, v)
            row = atlas.execute("SELECT atlas.measured.lookup_url(?)", [v]).fetchone()
            assert row is not None
            assert row[0] == ([] if expected is None else [local + expected]), v


@pytest.mark.parametrize("slash", ["", "/"])
def test_offline_root_takes_either_form(release: MacroRelease, slash: str) -> None:
    con = attach_local(_statements(release), release.data_root, str(release.data_root) + slash)
    assert con.execute(f"SELECT count(*) FROM atlas.measured.variant('{RS334}')").fetchone() == (5,)
    row = con.execute(f"SELECT atlas.measured.lookup_url('{RS334}')").fetchone()
    assert row is not None
    assert row[0] == [f"{release.data_root}/{variant_bin_path(release.lookups[0].lookup, RS334)}"]


@pytest.mark.parametrize(
    "bad",
    [
        "rs334",
        "11-5227002-T-A",
        "chr11-5227002-t-a",
        "chr11-5227002-T-A' OR '1'='1",
        "chr11-05227002-T-A",
        "chr11-1234567890-T-A",
        None,
    ],
)
def test_a_malformed_id_is_an_error_not_an_empty_result(
    atlas: duckdb.DuckDBPyConnection, bad: str | None
) -> None:
    for call in ("measured.variant(?)", "measured.near(?, 6.5, 3.4, 500)", "inferred.surfaces(?)"):
        with pytest.raises(duckdb.InvalidInputException, match="chr-pos-ref-alt"):
            atlas.execute(f"SELECT * FROM atlas.{call}", [bad]).fetchall()
    with pytest.raises(duckdb.InvalidInputException, match="chr-pos-ref-alt"):
        atlas.execute("SELECT atlas.measured.lookup_url(?)", [bad]).fetchall()


def test_a_malformed_id_fails_whatever_the_query_reads(atlas: duckdb.DuckDBPyConnection) -> None:
    """The refusal is raised as the macro binds, so neither a count nor a column subset hides it."""
    for sql in (
        "SELECT count(*) FROM atlas.measured.variant(?)",
        "SELECT ac FROM atlas.measured.variant(?) WHERE an = 7",
        "SELECT count(*) FROM atlas.inferred.surfaces(?)",
    ):
        with pytest.raises(duckdb.InvalidInputException, match="chr-pos-ref-alt"):
            atlas.execute(sql, ["rs334"]).fetchall()


def test_near_and_surfaces(atlas: duckdb.DuckDBPyConnection) -> None:
    assert atlas.execute(
        "SELECT population_id FROM atlas.measured.near('chr11-5227010-G-A', 6.5244, 3.3792, 500)"
    ).fetchall() == [("near-in",)]
    assert atlas.execute(
        "SELECT model_version, measurement, artifact_format, served, count(*), count(prior_frequency_sd) "
        "FROM atlas.inferred.surfaces(?) GROUP BY ALL ORDER BY 1",
        [RS334],
    ).fetchall() == [("v1", "allele_frequency", 1, False, 4, 0), ("v3", "allele_frequency", 3, True, 5, 5)]
    obs = {
        r[0] for r in atlas.execute(f"DESCRIBE SELECT * FROM atlas.measured.variant('{RS334}')").fetchall()
    }
    surf = {
        r[0] for r in atlas.execute(f"DESCRIBE SELECT * FROM atlas.inferred.surfaces('{RS334}')").fetchall()
    }
    assert obs & surf == {"variant_id"} and not any("freq" in c for c in obs)
    assert [n for n, _ in SURFACE_COLUMNS][: len(FORMAT_THREE_COLUMNS)] == list(FORMAT_THREE_COLUMNS)
    described = atlas.execute(f"DESCRIBE SELECT * FROM atlas.inferred.surfaces('{RS334}')").fetchall()
    assert [(r[0], r[1]) for r in described] == list(SURFACE_COLUMNS)


def test_kir_surfaces_are_carrier_frequency(atlas: duckdb.DuckDBPyConnection) -> None:
    assert atlas.execute(
        "SELECT DISTINCT measurement FROM atlas.inferred.surfaces('kir:2dl1')"
    ).fetchall() == [("carrier_frequency",)]


def test_curated_files_without_the_key_are_never_opened(release: MacroRelease, tmp_path: Path) -> None:
    """Curated B holds no hla: id, so with it deleted an hla: lookup still reads curated A alone."""
    copy = _copy_without(release, tmp_path, release.curated[1].file.path)
    con = attach_local(_statements(release), copy, f"{copy}/")
    assert con.execute("SELECT count(*) FROM atlas.measured.variant('hla:a-02-01')").fetchone() == (4,)
    with pytest.raises(duckdb.IOException, match="pub-fixture"):
        con.execute("SELECT count(*) FROM atlas.measured.variant('chrM-16519-T-C')").fetchall()


def test_surfaces_of_an_id_without_artifacts_open_nothing(release: MacroRelease, tmp_path: Path) -> None:
    copy = _copy_without(release, tmp_path, dr.ARTIFACT_PREFIX)
    con = attach_local(_statements(release), copy, f"{copy}/")
    assert con.execute("SELECT count(*) FROM atlas.inferred.surfaces('chr1-1000-A-G')").fetchone() == (0,)


def test_a_release_without_curated_files_renders_a_runnable_variant_macro(
    release: MacroRelease, local: str
) -> None:
    statements = lookup_statements(release.lookups, (), release.surfaces)
    con = attach_local(statements, release.data_root, local)
    assert con.execute(
        "SELECT cohort_id, count(*) FROM atlas.measured.variant(?) GROUP BY 1", [RS334]
    ).fetchall() == [(RECOUNT, 3)]


def test_a_release_without_lookup_sets_or_surfaces_still_guards_every_macro(
    release: MacroRelease, local: str
) -> None:
    con = attach_local(lookup_statements((), release.curated, ()), release.data_root, local)
    assert con.execute(f"SELECT count(*) FROM atlas.measured.variant('{RS334}')").fetchone() == (2,)
    assert con.execute(f"SELECT atlas.measured.lookup_url('{RS334}')").fetchone() == ([],)
    assert con.execute(f"SELECT count(*) FROM atlas.inferred.surfaces('{RS334}')").fetchone() == (0,)
    with pytest.raises(duckdb.InvalidInputException, match="chr-pos-ref-alt"):
        con.execute("SELECT count(*) FROM atlas.inferred.surfaces('rs334')").fetchall()


def test_rendering_is_order_independent_bounded_and_safe(release: MacroRelease) -> None:
    lookups, curated, surfaces = release.lookups, release.curated, release.surfaces
    assert lookup_statements(lookups, curated, surfaces) == lookup_statements(
        lookups, curated[::-1], surfaces[::-1]
    )
    assert curated_key("chrM-16519-T-C") == "chrM-16519-T-C" and curated_key("hla:a-02-01") == "hla:"
    with pytest.raises(dr.DataReleaseError, match="MAX_MACRO_BYTES"):
        lookup_statements(
            lookups,
            [CuratedFile(curated[0].file, frozenset(f"chr1-{i}-A-G" for i in range(1, 20_000)))],
            surfaces,
        )
    assert sum(len(s.encode()) for s in lookup_statements(lookups, curated, surfaces)) <= MAX_MACRO_BYTES


def _quoted_url(release: MacroRelease) -> tuple:
    ref = release.curated[0].file
    return (release.lookups, [CuratedFile(FileRef(ref.path, ref.url + "'"), release.curated[0].keys)], ())


def _quoted_prefix(release: MacroRelease) -> tuple:
    published = release.lookups[0]
    return (
        [
            PublishedLookupSet(
                published.lookup, published.url_prefix + "x'/", published.source_record_id_template
            )
        ],
        (),
        (),
    )


def _quoted_surface_id(release: MacroRelease) -> tuple:
    s = release.surfaces[0]
    bad = SurfaceFile(
        s.file,
        "chr11-5227002-T-A'",
        s.model_version,
        s.data_version,
        s.measurement,
        s.artifact_format,
        s.served,
        s.columns,
    )
    return ((), (), [bad])


def _frequency(release: MacroRelease) -> tuple:
    s = release.surfaces[0]
    bad = SurfaceFile(
        s.file,
        s.variant_id,
        s.model_version,
        s.data_version,
        "frequency",
        s.artifact_format,
        s.served,
        s.columns,
    )
    return ((), (), [bad])


def _missing_column(release: MacroRelease) -> tuple:
    s = release.surfaces[0]
    bad = SurfaceFile(
        s.file,
        s.variant_id,
        s.model_version,
        s.data_version,
        s.measurement,
        s.artifact_format,
        s.served,
        s.columns - {"q975"},
    )
    return ((), (), [bad])


def _bad_key(release: MacroRelease) -> tuple:
    return ((), [CuratedFile(release.curated[0].file, frozenset({"chr11-05227002-T-A"}))], ())


def _quoted_template(release: MacroRelease) -> tuple:
    published = release.lookups[0]
    return (
        [PublishedLookupSet(published.lookup, published.url_prefix, "x'{variant_id}:{source_label}")],
        (),
        (),
    )


def _twice(release: MacroRelease) -> tuple:
    return ((), (release.curated[0], release.curated[0]), ())


@pytest.mark.parametrize(
    "inputs, match",
    [
        (_quoted_url, "quote"),
        (_quoted_prefix, "quote"),
        (_quoted_surface_id, "variant id"),
        (_frequency, "measurement"),
        (_missing_column, "q975"),
        (_bad_key, "curated key"),
        (_quoted_template, "template"),
        (_twice, "twice"),
    ],
    ids=[
        "quote-in-url",
        "quote-in-prefix",
        "quote-in-surface-id",
        "measurement",
        "column",
        "key",
        "template",
        "twice",
    ],
)
def test_rendering_refuses_what_it_cannot_splice_safely(release: MacroRelease, inputs, match: str) -> None:
    with pytest.raises(dr.DataReleaseError, match=match):
        lookup_statements(*inputs(release))


def test_file_sql_reads_the_local_copy_when_genomeos_local_is_set() -> None:
    ref = FileRef(
        "tables/v1/x.parquet",
        "https://storage.googleapis.com/example-data/releases/2026-12-01/tables/v1/x.parquet",
    )
    assert file_sql(ref) == (
        "coalesce(rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/x.parquet', "
        "'https://storage.googleapis.com/example-data/releases/2026-12-01/tables/v1/x.parquet')"
    )


# --- catalog.sql: the macros follow the views (§2.6), and check 7 still refuses a withdrawn key (§2.9) ---

_WITHDRAWN_PATH = "tables/v1/meta/withdrawn.parquet"


def _object(path: str) -> dr.ReleaseObject:
    return dr.ReleaseObject(
        path=path,
        key=dr.release_key("2026-12-01", path),
        bytes=1,
        sha256="b" * 64,
        media_type="application/vnd.apache.parquet",
        in_git=False,
        sources=("genomeos",),
    )


def test_render_catalog_sql_appends_the_macros_after_the_views(release: MacroRelease) -> None:
    withdrawn = _object(_WITHDRAWN_PATH)
    files = [CatalogFile("meta.withdrawn", withdrawn.path, withdrawn.key, withdrawn.sha256, 1, 0)]
    statements = _statements(release)
    plain = catalog.render_catalog_sql("2026-12-01", files)
    sql = catalog.render_catalog_sql("2026-12-01", files, macros=statements)
    assert sql.startswith(
        plain.split("CREATE SCHEMA meta;")[0] + "CREATE SCHEMA inferred;\nCREATE SCHEMA measured;"
    )
    assert sql.endswith("\n\n" + "\n\n".join(statements) + "\n")
    assert sql.index("CREATE VIEW meta.withdrawn") < sql.index("CREATE MACRO measured.lookup_url")
    assert catalog.catalog_views(sql) == catalog.catalog_views(plain)
    with pytest.raises(TableError, match="CREATE MACRO"):
        catalog.render_catalog_sql("2026-12-01", files, macros=["CREATE VIEW measured.x AS SELECT 1;"])


def test_check7_refuses_a_macro_that_reads_a_withdrawn_file(release: MacroRelease) -> None:
    """Macros leave withdrawn files out when rendered (§2.9 as amended); check 7 stays the backstop."""
    withdrawn, curated = _object(_WITHDRAWN_PATH), _object(release.curated[0].file.path)
    files = [CatalogFile("meta.withdrawn", withdrawn.path, withdrawn.key, withdrawn.sha256, 1, 0)]
    ref = FileRef(curated.path, dr.DATA_STORE_BASE_URL + curated.key)
    statements = lookup_statements((), [CuratedFile(ref, release.curated[0].keys)], ())
    sql = catalog.render_catalog_sql("2026-12-01", files, macros=statements)
    tables_json = catalog.render_tables_json("2026-12-01", files)
    objects = {item.key: item for item in (withdrawn, curated)}
    with pytest.raises(TableError, match="check 7: .*withdrawn"):
        catalog.check_catalog(sql, tables_json, objects, frozenset({curated.key}))


def test_the_renderer_imports_neither_duckdb_nor_the_surfaces_package() -> None:
    """Pure strings (§2.6): the macros are text the pinned writer builds into the catalog."""
    tree = ast.parse(Path(lookup_macros.__file__).read_text(encoding="utf-8"))
    modules = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    modules |= {node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert not {name for name in modules if name == "duckdb" or name.startswith("genomeos.surfaces")}
