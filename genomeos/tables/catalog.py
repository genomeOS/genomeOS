"""A release's catalog: ``catalog.sql``, the views-only ``atlas.duckdb`` built from it, and ``tables.json``.

Atlas data platform design 2026-10-18 §2.6, §2.7 check 7 and §2.9; builder's calls 1, 4 and 17. Pure:
text from the release's objects, and checks of that text; ``writer.build_catalog_db`` builds the file.

``catalog.sql`` is canonical and committed with the release (call 17). It creates one view per table the
release lists, plus ``meta.release``, over the exact keys of the release manifest: sorted schemas, then
``meta.release``, then the views by name. A view reads its files with ``read_parquet`` and never names
another view, because a view or macro naming a view fails once the catalog is attached under an alias
(§2.6). Its file list is a ``CASE``: while the variable ``genomeos_local`` is unset it is the files'
public URLs; once a reader runs ``SET VARIABLE genomeos_local = 'data/'`` (with or without the slash) it
is that folder's sha256-checked copies, at their release paths. Remote reads are not hash-checked. After
the views come the release's macros, if any: ``render_catalog_sql(..., macros=...)`` appends the lookup
macros ``genomeos.tables.lookup_macros`` renders (§2.6, §3.1).

Withdrawals (§2.9): every view over files drops the files ``meta.withdrawn`` lists, by URL or by local
path, and the ``inferred`` views also drop every row of an artifact whose ``cells.parquet`` is withdrawn.
Only ``meta.withdrawn`` itself and ``meta.release``, which reads no file, do not. The macros name only
live files: withdrawn ones are left out when they are rendered, since an attached macro cannot read a
view. Check 7 refuses a catalog that lists a withdrawn key, in a view or a macro, so the anti-join guards
older catalogs and a regressed check.

``meta.release`` names the release, its manifest key and how to cite it, and the mirror (none until step
3.8). It never holds the manifest's sha256: the manifest lists the catalog, so the release builder writes
it last (call 4). ``tables.json`` lists the same files for Polars, pandas, R and ``curl``, each with its
key, URL, sha256, bytes, rows and ``access``: ``open`` for every file of a phase-1 catalog, with no
``hosts`` (call 1).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass

from genomeos.publication import data_release as dr
from genomeos.tables import contracts
from genomeos.tables.contracts import TableError
from genomeos.tables.write_once import fetch_prefix

CATALOG_SQL = "catalog/catalog.sql"
CATALOG_DB = "catalog/atlas.duckdb"
TABLES_JSON = "catalog/tables.json"
#: Every file under ``catalog/``: the release builder writes these three, and nothing else may be there.
CATALOG_PATHS = (CATALOG_DB, CATALOG_SQL, TABLES_JSON)
#: The released 994 MAP HbS surveys of the 2026-09-16 parity run (§2.4, §2.8), which check 8 reads.
PARITY_FILE = "validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet"
PARITY_TABLE = "evidence.parity_observations"
RELEASE_VIEW = "meta.release"
WITHDRAWN_TABLE = "meta.withdrawn"
#: The partition columns DuckDB reads from a table's folder names, with their types. Untyped, an
#: ``epoch=2026-11-20`` folder reads as a DATE and overrides the file's VARCHAR column (probed on 1.5.5).
HIVE_TYPES: dict[str, dict[str, str]] = {
    "inferred.cells_by_cell": {"epoch": "VARCHAR", "res": "INTEGER", "h3_r0": "VARCHAR"},
    "measured.allele_observations": {"source": "VARCHAR", "ingest_version": "VARCHAR"},
    "measured.carrier_observations": {"source": "VARCHAR", "ingest_version": "VARCHAR"},
    "measured.fit_inputs": {"epoch": "VARCHAR"},
}
TABLES_SCHEMA = "genomeos-tables"
TABLES_SCHEMA_VERSION = "1.0"
#: Every file of a phase-1 catalog is open (call 1); step 2.1 adds the access rule and ``hosts``.
ACCESS = "open"

_LOCAL = "rtrim(getvariable('genomeos_local'), '/')"
#: What precedes each local path in a file list: a local path anywhere else is refused (check 7).
_LOCAL_ENTRY = f"{_LOCAL} || "
_REMOTE = "getvariable('genomeos_local') IS NULL"
#: An artifact's surface file (``inferred.CELLS_FILE``): withdrawing it withdraws the artifact's rows.
_CELLS_FILE = "cells.parquet"
#: An artifact's directory from a ``cells_by_cell`` row (``meta.artifact_directory_name``).
_ROW_DIRECTORY = "replace(variant_id, ':', '__') || '__' || model_version || '__' || data_version"
_ENTRY_FIELDS = frozenset({"access", "bytes", "key", "rows", "sha256", "url"})
_LITERAL = re.compile(r"'((?:[^']|'')*)'")
_VIEW = re.compile(r"^CREATE VIEW (\S+) AS\b", re.MULTILINE)
_MACRO = re.compile(r"CREATE MACRO ([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*\(")
_HEADER = "-- The genomeOS Atlas catalog of release {release}, written by scripts/build_data_release.py.\n"


@dataclass(frozen=True)
class CatalogFile:
    """One file a catalog view reads: its table, release path, key, sha256, bytes and rows."""

    table: str
    path: str
    key: str
    sha256: str
    bytes: int
    rows: int


def cite_as(release: str) -> str:
    """How to cite release ``release``: the manifest's public URL, which names every object's sha256."""
    return f"genomeOS Atlas data, release {release}. {dr.DATA_STORE_BASE_URL}{dr.manifest_key(release)}"


def catalog_table(path: str) -> str | None:
    """The table whose view reads the release path ``path``, or ``None`` when no view reads it."""
    if path == PARITY_FILE:
        return PARITY_TABLE
    if path.startswith(dr.TABLES_PREFIX):
        return contracts.table_of(path)
    return None


def catalog_files(objects: Sequence[dr.ReleaseObject], rows: Mapping[str, int]) -> tuple[CatalogFile, ...]:
    """The files of ``objects`` a view reads, by table and path; ``rows`` maps each path to its row count.

    Every catalog reads the parity file (check 8) and ``meta.withdrawn`` (§2.9), so a release that lacks
    either is refused: the release builder keys only what the local tree holds.
    """
    found = []
    for item in objects:
        table = catalog_table(item.path)
        if table is None:
            continue
        if item.path not in rows:
            raise TableError(f"{item.path}: no row count was given for it")
        found.append(CatalogFile(table, item.path, item.key, item.sha256, item.bytes, int(rows[item.path])))
    tables = {file.table for file in found}
    if PARITY_TABLE not in tables:
        raise TableError(
            f"{PARITY_FILE}: the release does not list it, because the local tree lacks it, and "
            f"{PARITY_TABLE} reads it (the parity smoke, check 8); fetch it first: "
            f"python scripts/fetch_data.py --prefix {fetch_prefix(PARITY_FILE)}"
        )
    if WITHDRAWN_TABLE not in tables:
        raise TableError(
            f"{contracts.table_path(WITHDRAWN_TABLE)}: the release does not list it, and every view "
            f"anti-joins {WITHDRAWN_TABLE} (§2.9); build it first with scripts/build_tables.py"
        )
    return tuple(sorted(found, key=lambda file: (file.table, file.path)))


def render_catalog_sql(
    release: str,
    files: Sequence[CatalogFile],
    *,
    base_url: str = dr.DATA_STORE_BASE_URL,
    macros: Sequence[str] = (),
) -> str:
    """``catalog.sql`` for ``files``: its schemas, ``meta.release``, one view per table, then ``macros``.

    ``macros`` are ``CREATE MACRO <schema>.<name>`` statements (``lookup_macros.lookup_statements``),
    appended after the views in the order given; their schemas are created with the views'.
    """
    dr.assert_release_id(release)
    macro_schemas = set()
    for statement in macros:
        match = _MACRO.match(statement)
        if match is None:
            raise TableError(
                f"a catalog macro is one CREATE MACRO <schema>.<name>(...) statement, not {statement[:60]!r}"
            )
        macro_schemas.add(match.group(1))
    base = dr.assert_base_url(base_url)
    by_table: dict[str, list[CatalogFile]] = {}
    for file in sorted(files, key=lambda file: (file.table, file.path)):
        dr.assert_data_path(file.path)
        by_table.setdefault(file.table, []).append(file)
    if RELEASE_VIEW in by_table:
        raise TableError(f"{RELEASE_VIEW} is a view of the release id, never of a file")
    withdrawn = by_table.get(WITHDRAWN_TABLE)
    if not withdrawn:
        raise TableError(f"the catalog lists no {WITHDRAWN_TABLE} file, which every view anti-joins (§2.9)")
    schemas = sorted(
        {table.split(".", 1)[0] for table in by_table} | {RELEASE_VIEW.split(".", 1)[0]} | macro_schemas
    )
    statements = [
        "\n".join(f"CREATE SCHEMA {schema};" for schema in schemas),
        _release_view(release),
        *(_view(table, by_table[table], withdrawn, base) for table in sorted(by_table)),
        *macros,
    ]
    return _HEADER.format(release=release) + "\n" + "\n\n".join(statements) + "\n"


def render_tables_json(release: str, files: Sequence[CatalogFile]) -> bytes:
    """``tables.json``: every file of every view, under its table, with its public URL (§2.6)."""
    tables: dict[str, list[dict[str, object]]] = {}
    for file in sorted(files, key=lambda file: (file.table, file.path)):
        tables.setdefault(file.table, []).append(
            {
                "access": ACCESS,
                "bytes": file.bytes,
                "key": file.key,
                "rows": file.rows,
                "sha256": file.sha256,
                "url": f"{dr.DATA_STORE_BASE_URL}{file.key}",
            }
        )
    document = {
        "release": dr.assert_release_id(release),
        "schema": TABLES_SCHEMA,
        "schema_version": TABLES_SCHEMA_VERSION,
        "tables": tables,
    }
    return dr.canonical_bytes(document)


def catalog_urls(sql: str) -> tuple[str, ...]:
    """Every file URL ``sql`` names, sorted and unique (the bare base URL of the anti-join is not one)."""
    return tuple(
        sorted(
            {
                text
                for _, text in _literals(sql)
                if text.startswith(("https://", "http://")) and text[-1] != "/"
            }
        )
    )


def catalog_local_paths(sql: str) -> tuple[str, ...]:
    """Every release path ``sql`` reads offline, under ``genomeos_local``, sorted and unique."""
    return tuple(sorted({text[1:] for start, text in _literals(sql) if _is_local_entry(sql, start, text)}))


def catalog_views(sql: str) -> tuple[str, ...]:
    """The views ``sql`` creates, in its order."""
    return tuple(_VIEW.findall(sql))


def check_catalog(
    sql: str,
    tables_json: bytes,
    objects: Mapping[str, dr.ReleaseObject],
    withdrawn_keys: frozenset[str],
) -> None:
    """Check 7: every URL of ``sql`` is a key of ``objects`` (the release, by key) and not withdrawn; its
    local paths are those keys' paths, and appear nowhere but in the ``genomeos_local`` lists; and
    ``tables.json`` lists exactly those files, each with the manifest's sha256 and bytes."""
    keys = set()
    for url in catalog_urls(sql):
        key = url.removeprefix(dr.DATA_STORE_BASE_URL) if url.startswith(dr.DATA_STORE_BASE_URL) else None
        if key is None or key not in objects:
            raise TableError(f"check 7: {url}: not a manifest key of this release")
        if key in withdrawn_keys:
            raise TableError(f"check 7: {url}: withdrawn (§2.9); a catalog never reads a withdrawn key")
        keys.add(key)
    paths = {item.path for item in objects.values()}
    for start, text in _literals(sql):
        if not text.startswith(("https://", "http://")) and not _is_local_entry(sql, start, text):
            if any(path in text for path in paths):
                raise TableError(
                    f"check 7: {CATALOG_SQL}: local path {text!r} outside the genomeos_local CASE; a view "
                    "reads manifest URLs, or offline the copies under genomeos_local, and nothing else"
                )
    listed = {objects[key].path for key in keys}
    local = set(catalog_local_paths(sql))
    if local != listed:
        raise TableError(
            f"check 7: {CATALOG_SQL}: its local paths are not its URLs' paths: "
            f"{sorted(local - listed)[:3]} without a URL, {sorted(listed - local)[:3]} without a local path"
        )
    _check_tables_json(tables_json, objects, keys, withdrawn_keys)


def _check_tables_json(
    tables_json: bytes,
    objects: Mapping[str, dr.ReleaseObject],
    keys: set[str],
    withdrawn_keys: frozenset[str],
) -> None:
    try:
        document = json.loads(tables_json)
    except json.JSONDecodeError as error:
        raise TableError(f"check 7: {TABLES_JSON}: not JSON: {error}") from error
    header = {"schema": TABLES_SCHEMA, "schema_version": TABLES_SCHEMA_VERSION}
    if (
        not isinstance(document, dict)
        or set(document) != {"release", *header, "tables"}
        or {name: document[name] for name in header} != header
        or not isinstance(document["tables"], dict)
    ):
        raise TableError(f"check 7: {TABLES_JSON}: not a {TABLES_SCHEMA} {TABLES_SCHEMA_VERSION} document")
    found = set()
    for table, entries in document["tables"].items():
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != _ENTRY_FIELDS:
                raise TableError(f"check 7: {TABLES_JSON}: {table}: an entry is not {sorted(_ENTRY_FIELDS)}")
            key, item = entry["key"], objects.get(entry["key"])
            if item is None or key in withdrawn_keys:
                raise TableError(f"check 7: {TABLES_JSON}: {key}: not a manifest key, or withdrawn")
            if (entry["sha256"], entry["bytes"]) != (item.sha256, item.bytes):
                raise TableError(
                    f"check 7: {TABLES_JSON}: {key}: sha256 {entry['sha256']} and {entry['bytes']} bytes, "
                    f"but the manifest records sha256 {item.sha256} and {item.bytes} bytes"
                )
            expected = (f"{dr.DATA_STORE_BASE_URL}{key}", ACCESS, catalog_table(item.path))
            if (entry["url"], entry["access"], table) != expected:
                raise TableError(
                    f"check 7: {TABLES_JSON}: {key}: url, access and table are {entry['url']!r}, "
                    f"{entry['access']!r} and {table!r}, not {expected}"
                )
            found.add(key)
    if found != keys:
        raise TableError(
            f"check 7: {TABLES_JSON} lists different files than {CATALOG_SQL}: "
            f"{sorted(found - keys)[:3]} only in {TABLES_JSON}, "
            f"{sorted(keys - found)[:3]} only in {CATALOG_SQL}"
        )


def _release_view(release: str) -> str:
    """``meta.release``: the release id, its manifest key, how to cite it, and no mirror yet (§2.6)."""
    return (
        f"CREATE VIEW {RELEASE_VIEW} AS SELECT {_literal(release)} AS release, "
        f"{_literal(dr.manifest_key(release))} AS manifest_key, {_literal(cite_as(release))} AS cite_as, "
        "NULL::VARCHAR AS mirror;"
    )


def _view(table: str, files: Sequence[CatalogFile], withdrawn: Sequence[CatalogFile], base: str) -> str:
    """One table's view: its files, less the withdrawn ones (and, for ``inferred``, withdrawn artifacts)."""
    if table == WITHDRAWN_TABLE:
        return f"CREATE VIEW {table} AS\nSELECT *\nFROM {_read(table, files, base, filename=False)};"
    listed = _read(WITHDRAWN_TABLE, withdrawn, base, filename=False)
    location = f"CASE WHEN {_REMOTE} THEN {_literal(base)} || key ELSE {_LOCAL} || '/' || path END"
    conditions = [f"filename NOT IN (\n  SELECT {location}\n  FROM {listed})"]
    if table.startswith("inferred."):
        directory = "artifact" if "artifact" in contracts.columns(table) else _ROW_DIRECTORY
        cells = f"{_literal(dr.ARTIFACT_PREFIX)} || {directory} || {_literal('/' + _CELLS_FILE)}"
        conditions.append(f"{cells} NOT IN (\n  SELECT path\n  FROM {listed})")
    return (
        f"CREATE VIEW {table} AS\nSELECT * EXCLUDE (filename)\n"
        f"FROM {_read(table, files, base, filename=True)}\n"
        f"WHERE {' AND '.join(conditions)};"
    )


def _read(table: str, files: Sequence[CatalogFile], base: str, *, filename: bool) -> str:
    """``read_parquet`` of ``files``: public URLs, or the copies under ``genomeos_local`` when it is set.

    Hive partitioning is on, with typed columns, only for a ``HIVE_TYPES`` table, and off for every other,
    so a ``key=value`` folder in a reader's own local path never becomes a column.
    """
    urls = ",\n".join(f"    {_literal(base + file.key)}" for file in files)
    local = ",\n".join(f"    {_LOCAL_ENTRY}{_literal('/' + file.path)}" for file in files)
    options = ["filename = true"] if filename else []
    if table in HIVE_TYPES:
        types = ", ".join(f"{_literal(name)}: {kind}" for name, kind in HIVE_TYPES[table].items())
        options += ["hive_partitioning = true", f"hive_types = {{{types}}}"]
    else:
        options.append("hive_partitioning = false")
    listing = f"(CASE WHEN {_REMOTE} THEN [\n{urls}\n  ]\n  ELSE [\n{local}\n  ] END)"
    return f"read_parquet({listing}, {', '.join(options)})"


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _literals(sql: str) -> Iterator[tuple[int, str]]:
    """Each string literal of ``sql``: where it starts, and its text."""
    for match in _LITERAL.finditer(sql):
        yield match.start(), match.group(1).replace("''", "'")


def _is_local_entry(sql: str, start: int, text: str) -> bool:
    """Whether the literal at ``start`` is a local file path, ``'/<path>'`` after ``_LOCAL_ENTRY``."""
    return len(text) > 1 and text.startswith("/") and sql.endswith(_LOCAL_ENTRY, 0, start)
