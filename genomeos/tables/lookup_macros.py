"""The four lookup macros of a release catalog, rendered as SQL text.

Atlas data platform design 2026-10-18 §2.2 rule 3, §2.6, §2.9 and §3.1; builder's calls 30 and 31.

``lookup_statements`` renders four ``CREATE MACRO`` statements, which ``catalog.render_catalog_sql``
appends to ``catalog.sql`` after its views (§2.6: the catalog holds "view and macro definitions"):

- ``measured.lookup_url(v)``: the bin URLs ``v`` computes, one per lookup set whose recorded chromosome
  set holds ``v``'s chromosome and bin (§2.6, call 31); ``[]`` for any other id.
- ``measured.variant(v)``: ``v``'s observations as the 17 ``OBSERVATION_COLUMNS``. It unions ``v``'s rows
  in the one bin file it computes in each lookup set, whose ``source_record_id`` it derives from the set's
  recorded template (call 30), with its rows in every curated file whose key set holds it (§3.1).
- ``measured.near(v, lat0, lon0, km)``: those rows whose sampling disc reaches within ``km`` of
  ``(lat0, lon0)``, haversine ``<= km + radius_km``, with no spatial extension (§3.1).
- ``inferred.surfaces(v)``: the cells of every live surface of ``v``, as ``SURFACE_COLUMNS``.

Observations and surfaces come from separate macros and share no column but ``variant_id`` (§2.2 rule 3).

**How they read.** On DuckDB 1.5.5 and 1.2.2 (measured 2026-11-14) an attached macro cannot call another
macro or name a view, and ``read_parquet([])`` fails. So each macro is self-contained and picks its SQL
text as it binds, with ``query(CASE … END)`` over ``v`` and the variable ``genomeos_local``, and names
only the files that can hold ``v``: no file is opened for an id that computes no URL and is in no key
set. A curated file's key set holds each locus id exactly and the namespace of any other id
(``curated_key``). Offline, after ``SET VARIABLE genomeos_local = 'data/'`` (with or without the slash),
every file is read from its local copy at its release path, as the views read theirs; remote reads are
not hash-checked.

**Malformed ids.** An id that is neither a GRCh38 ``chr-pos-ref-alt`` locus spelled as a URL can carry it
(``STRICT_LOCUS_PATTERN``: chr1-22, X, Y or M, a position of 1-9 digits with no leading zero, alleles in
``ACGT``) nor a ``phenotype:``, ``hla:``, ``kir:``, ``mic:`` or ``cyt:`` id, NULL included, is an error
naming the accepted forms, never an empty result. The error is raised as the macro binds, so neither a
count nor a column subset hides it. ``v`` is spliced into SQL text only after it matches a pattern that
admits no quote, and rendering refuses any URL, path, key or id holding one.

**Withdrawals (§2.9, as amended).** The macros name only the live files the release builder passes in:
withdrawn ones are left out when the catalog is rendered, rather than anti-joined at query time, because
an attached macro cannot read the ``meta.withdrawn`` view. For a release's own catalog the two are
equivalent, and check 7 still refuses a catalog that names a withdrawn key.

Pure strings: this module imports neither duckdb nor ``genomeos.surfaces``. Every refusal is a
``DataReleaseError``, and the four statements total at most ``MAX_MACRO_BYTES``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit

from genomeos.observations.schema import VARIANT_ID_PATTERN
from genomeos.publication import artifact_inputs
from genomeos.publication import data_release as dr
from genomeos.tables.binned import source_record_id_sql
from genomeos.tables.contracts import TableError
from genomeos.tables.lookup_sets import BIN_BP, LOCUS_ID_PATTERN, PART_FILE, LookupSet

__all__ = (
    "EARTH_RADIUS_KM",
    "MAX_MACRO_BYTES",
    "OBSERVATION_COLUMNS",
    "STRICT_LOCUS_PATTERN",
    "SURFACE_COLUMNS",
    "CuratedFile",
    "FileRef",
    "PublishedLookupSet",
    "SurfaceFile",
    "curated_key",
    "file_sql",
    "lookup_statements",
)

#: ``measured.variant``'s columns and types: the fit-input contract's 17, in its order (§2.4).
OBSERVATION_COLUMNS: tuple[tuple[str, str], ...] = (
    ("variant_id", "VARCHAR"),
    ("rsid", "VARCHAR"),
    ("population_id", "VARCHAR"),
    ("lat", "DOUBLE"),
    ("lon", "DOUBLE"),
    ("radius_km", "DOUBLE"),
    ("ac", "BIGINT"),
    ("an", "BIGINT"),
    ("source_record_id", "VARCHAR"),
    ("source", "VARCHAR"),
    ("assay", "VARCHAR"),
    ("date_lower", "BIGINT"),
    ("date_upper", "BIGINT"),
    ("sampling_design", "VARCHAR"),
    ("disease_ascertainment_excluded", "BOOLEAN"),
    ("cohort_id", "VARCHAR"),
    ("ingest_version", "VARCHAR"),
)
#: ``inferred.surfaces``'s columns and types: format 3's 15 cell columns, then what the release records
#: of the artifact (``measurement``, ``artifact_format``, and whether the website serves it).
SURFACE_COLUMNS: tuple[tuple[str, str], ...] = (
    ("h3_index", "VARCHAR"),
    ("variant_id", "VARCHAR"),
    ("post_median", "DOUBLE"),
    ("post_mean", "DOUBLE"),
    ("post_sd", "DOUBLE"),
    ("prior_frequency_sd", "DOUBLE"),
    ("q025", "DOUBLE"),
    ("q975", "DOUBLE"),
    ("q25", "DOUBLE"),
    ("q75", "DOUBLE"),
    ("support", "VARCHAR"),
    ("posterior_contraction", "DOUBLE"),
    ("dist_nearest_obs_km", "DOUBLE"),
    ("model_version", "VARCHAR"),
    ("data_version", "VARCHAR"),
    ("measurement", "VARCHAR"),
    ("artifact_format", "INTEGER"),
    ("served", "BOOLEAN"),
)
#: The mean Earth radius of ``measured.near``'s haversine, as the parity smoke uses it.
EARTH_RADIUS_KM = 6371.0088
#: The most bytes the four statements may total, so the catalog stays a small attach (§2.6).
MAX_MACRO_BYTES = 131_072
#: The loci a lookup can be asked for, ``chrM`` included: a position of 1-9 digits, no leading zero.
STRICT_LOCUS_PATTERN = r"^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$"

#: The cell columns a surface file may lack (formats 1 and 2 store no ``prior_frequency_sd``).
_OPTIONAL_CELL_COLUMNS = frozenset({"prior_frequency_sd"})
#: The cell columns a surface file stores: every surface column but the three the release records.
_CELL_COLUMNS = tuple(name for name, _ in SURFACE_COLUMNS[:-3])
_MEASUREMENTS = tuple(artifact_inputs.INPUT_CONTRACTS)
_STRICT = re.compile(STRICT_LOCUS_PATTERN)
_LOCAL = "rtrim(getvariable('genomeos_local'), '/')"
_ACCEPTED_FORMS = (
    "a GRCh38 chr-pos-ref-alt id (chr1-22, X, Y or M; a position of 1-9 digits with no leading zero; "
    "alleles in ACGT) or a phenotype:, hla:, kir:, mic: or cyt: id"
)
#: Whether ``v`` is an id the macros accept: false, never NULL, for a NULL ``v``.
_ACCEPTED = (
    f"coalesce(regexp_full_match(v, '{VARIANT_ID_PATTERN}') AND (NOT starts_with(v, 'chr') "
    f"OR regexp_full_match(v, '{STRICT_LOCUS_PATTERN}')), false)"
)
#: The SQL literal of one quote, which closes the id a macro splices into its SQL text.
_QUOTE = "''''"
_V_CHROM = "split_part(v, '-', 1)"
_V_POS = "split_part(v, '-', 2)"
_V_BIN = f"TRY_CAST({_V_POS} AS BIGINT) // {BIN_BP}"
_CURATED_KEY = (
    f"CASE WHEN regexp_full_match(v, '{STRICT_LOCUS_PATTERN}') THEN v ELSE split_part(v, ':', 1) || ':' END"
)
_HAVERSINE_KM = (
    f"2 * {EARTH_RADIUS_KM} * asin(sqrt(sin(radians(lat - lat0) / 2)^2 + cos(radians(lat0)) "
    "* cos(radians(lat)) * sin(radians(lon - lon0) / 2)^2))"
)


@dataclass(frozen=True)
class FileRef:
    """One file a macro reads: its release path (the offline copy's) and its public URL."""

    path: str
    url: str


@dataclass(frozen=True)
class PublishedLookupSet:
    """A lookup set as one release publishes it: ``url_prefix`` is ``<lookup base>releases/<R>/``, and
    ``source_record_id_template`` the template ``measured.ingests`` records for it (call 30)."""

    lookup: LookupSet
    url_prefix: str
    source_record_id_template: str


@dataclass(frozen=True)
class CuratedFile:
    """One live curated ``measured.allele_observations`` file and its key set (``curated_key`` of its ids)."""

    file: FileRef
    keys: frozenset[str]


@dataclass(frozen=True)
class SurfaceFile:
    """One live artifact's ``cells.parquet``: its identity, what the release records of it, and the cell
    columns the file stores."""

    file: FileRef
    variant_id: str
    model_version: str
    data_version: str
    measurement: str
    artifact_format: int
    served: bool
    columns: frozenset[str]


def curated_key(variant_id: str) -> str:
    """The key under which a curated file holds ``variant_id``: the id itself for a locus, else its
    namespace (``hla:a-02-01`` is held under ``hla:``)."""
    return variant_id if _STRICT.fullmatch(variant_id) else variant_id.split(":", 1)[0] + ":"


def file_sql(ref: FileRef) -> str:
    """The SQL expression of ``ref``'s location: its copy under ``genomeos_local`` when that is set, else
    its URL."""
    path = dr.assert_data_path(ref.path)
    _assert_url(ref.url, "file URL", folder=False)
    return f"coalesce({_LOCAL} || {_literal('/' + path, 'path')}, {_literal(ref.url, 'file URL')})"


def lookup_statements(
    lookups: Sequence[PublishedLookupSet],
    curated: Sequence[CuratedFile],
    surfaces: Sequence[SurfaceFile],
) -> tuple[str, str, str, str]:
    """The four ``CREATE MACRO`` statements over these live files, in any input order the same text.

    ``measured.lookup_url``, ``measured.variant``, ``measured.near`` and ``inferred.surfaces``, each ending
    in ``;``. A curated file with no keys holds no rows, so no branch reads it. A ``DataReleaseError``
    refuses anything that cannot be spliced safely or reached, a file listed twice, and statements over
    ``MAX_MACRO_BYTES`` in all.
    """
    sets = sorted(lookups, key=lambda item: (item.lookup.source, item.lookup.ingest_version))
    _assert_once("lookup set", [f"{item.lookup.source}/{item.lookup.ingest_version}" for item in sets])
    files = sorted(curated, key=lambda item: item.file.path)
    _assert_once("curated file", [item.file.path for item in files])
    cells = sorted(
        surfaces, key=lambda item: (item.variant_id, item.model_version, item.data_version, item.file.path)
    )
    _assert_once("surface file", [item.file.path for item in cells])
    observations = [_bin_branch(item) for item in sets] + [
        _curated_branch(item) for item in files if item.keys
    ]
    union = "\nUNION ALL\n".join([_guard("measured.variant", OBSERVATION_COLUMNS), *observations])
    near_union = "\nUNION ALL\n".join([_guard("measured.near", OBSERVATION_COLUMNS), *observations])
    statements = (
        f"CREATE MACRO measured.lookup_url(v) AS\n{_lookup_url(sets)};",
        f"CREATE MACRO measured.variant(v) AS TABLE\n{union};",
        f"CREATE MACRO measured.near(v, lat0, lon0, km) AS TABLE\nSELECT * FROM (\n{near_union}\n)\n"
        f"WHERE {_HAVERSINE_KM} <= km + radius_km;",
        f"CREATE MACRO inferred.surfaces(v) AS TABLE\n{_surfaces(cells)};",
    )
    total = sum(len(statement.encode("utf-8")) for statement in statements)
    if total > MAX_MACRO_BYTES:
        raise dr.DataReleaseError(
            f"the lookup macros total {total:,} bytes, over MAX_MACRO_BYTES ({MAX_MACRO_BYTES:,}): every "
            "reader's attach downloads them, so split the curated ingests' keys before adding more (§2.6)"
        )
    return statements


def _guard(name: str, columns: Sequence[tuple[str, str]]) -> str:
    """The branch that refuses a malformed ``v`` as the macro binds, else adds typed, empty columns."""
    refusal = f"error({_text(f'{name} takes {_ACCEPTED_FORMS}')})"
    return f"SELECT * FROM query(CASE WHEN NOT {_ACCEPTED} THEN {refusal} ELSE {_text(_empty(columns))} END)"


def _empty(columns: Sequence[tuple[str, str]]) -> str:
    return f"SELECT {', '.join(f'NULL::{kind} AS {name}' for name, kind in columns)} WHERE false"


def _bin_condition(lookup: LookupSet) -> str:
    """Whether ``v`` computes a bin of ``lookup``: a locus on a recorded chromosome, below its bin count."""
    counts = " ".join(f"WHEN '{chrom}' THEN {lookup.n_bins(chrom)}" for chrom in lookup.contig_lengths)
    return f"regexp_full_match(v, '{LOCUS_ID_PATTERN}') AND {_V_BIN} < CASE {_V_CHROM} {counts} END"


def _bin_url(published: PublishedLookupSet) -> str:
    """The URL of ``v``'s bin file, or its copy under ``genomeos_local`` (``lookup_sets.bin_path``)."""
    prefix = _assert_url(published.url_prefix, "lookup url_prefix", folder=True)
    folder = _literal(f"{published.lookup.prefix}chrom=", "lookup set prefix")
    return (
        f"coalesce({_LOCAL} || '/', {_literal(prefix, 'lookup url_prefix')}) || {folder} || {_V_CHROM} "
        f"|| '/bin=' || CAST({_V_BIN} AS VARCHAR) || '/{PART_FILE}'"
    )


def _bin_branch(published: PublishedLookupSet) -> str:
    """``v``'s rows in its one bin file of ``published``, the ``source_record_id`` derived (call 30)."""
    try:
        derived = source_record_id_sql(published.source_record_id_template)
    except TableError as error:
        raise dr.DataReleaseError(f"{published.lookup.prefix}: {error}") from error
    derived_id = {"source_record_id": f"CAST({derived} AS VARCHAR)"}
    head = f"SELECT {_projection(OBSERVATION_COLUMNS, derived_id)} FROM read_parquet('"
    tail = _text("', hive_partitioning = false) WHERE pos = ")
    match = _text(" AND variant_id = '")
    read = (
        f"{_text(head)} || {_spliced(_bin_url(published))} || {tail} || {_V_POS} || {match} || v || {_QUOTE}"
    )
    empty = _text(_empty(OBSERVATION_COLUMNS))
    return f"SELECT * FROM query(CASE WHEN {_bin_condition(published.lookup)} THEN {read} ELSE {empty} END)"


def _curated_branch(item: CuratedFile) -> str:
    """``v``'s rows in one curated file, read only when the file's key set holds ``curated_key(v)``."""
    for key in item.keys:
        if "'" in key or curated_key(key) != key:
            raise dr.DataReleaseError(
                f"{item.file.path}: curated key {key!r} is not a curated_key: a locus id as "
                "STRICT_LOCUS_PATTERN spells it, or an id's namespace such as 'hla:'"
            )
    keys = ", ".join(f"'{key}'" for key in sorted(item.keys))
    head = f"SELECT {_projection(OBSERVATION_COLUMNS, {})} FROM read_parquet('"
    tail = _text("', hive_partitioning = false) WHERE variant_id = '")
    read = f"{_text(head)} || {_spliced(file_sql(item.file))} || {tail} || v || {_QUOTE}"
    condition = f"regexp_full_match(v, '{VARIANT_ID_PATTERN}') AND {_CURATED_KEY} IN ({keys})"
    empty = _text(_empty(OBSERVATION_COLUMNS))
    return f"SELECT * FROM query(CASE WHEN {condition} THEN {read} ELSE {empty} END)"


def _lookup_url(sets: Sequence[PublishedLookupSet]) -> str:
    urls = [
        f"CASE WHEN {_bin_condition(item.lookup)} THEN [{_bin_url(item)}] ELSE []::VARCHAR[] END"
        for item in sets
    ]
    listed = "[]::VARCHAR[]" if not urls else urls[0] if len(urls) == 1 else f"flatten([{', '.join(urls)}])"
    message = f"measured.lookup_url takes {_ACCEPTED_FORMS}"
    return f"CASE WHEN NOT {_ACCEPTED} THEN error({_text(message)}) ELSE {listed} END"


def _surfaces(cells: Sequence[SurfaceFile]) -> str:
    """``inferred.surfaces``'s body: the guard, then the cells of every surface of ``v``."""
    guard = _guard("inferred.surfaces", SURFACE_COLUMNS)
    by_variant: dict[str, list[str]] = {}
    for item in cells:
        by_variant.setdefault(_surface_id(item), []).append(_surface_read(item))
    if not by_variant:
        return guard
    glue = f" || {_text(' UNION ALL ')} || "
    whens = " ".join(
        f"WHEN '{variant_id}' THEN {glue.join(reads)}" for variant_id, reads in by_variant.items()
    )
    return (
        f"{guard}\nUNION ALL\nSELECT * FROM query(CASE v {whens} ELSE {_text(_empty(SURFACE_COLUMNS))} END)"
    )


def _surface_id(item: SurfaceFile) -> str:
    if "'" in item.variant_id or not (
        re.fullmatch(VARIANT_ID_PATTERN, item.variant_id)
        and (not item.variant_id.startswith("chr") or _STRICT.fullmatch(item.variant_id))
    ):
        raise dr.DataReleaseError(
            f"{item.file.path}: surface variant id {item.variant_id!r} is not {_ACCEPTED_FORMS}, so no "
            "lookup could reach it"
        )
    return item.variant_id


def _surface_read(item: SurfaceFile) -> str:
    """One surface's cells as ``SURFACE_COLUMNS``: typed NULLs for a column it lacks, and literals for what
    the release records of it."""
    if item.measurement not in _MEASUREMENTS:
        raise dr.DataReleaseError(
            f"{item.file.path}: measurement {item.measurement!r} is not one of {list(_MEASUREMENTS)}"
        )
    if (
        not isinstance(item.artifact_format, int)
        or isinstance(item.artifact_format, bool)
        or item.artifact_format < 1
    ):
        raise dr.DataReleaseError(
            f"{item.file.path}: artifact_format {item.artifact_format!r} is not a format"
        )
    missing = [
        name for name in _CELL_COLUMNS if name not in item.columns and name not in _OPTIONAL_CELL_COLUMNS
    ]
    if missing:
        raise dr.DataReleaseError(f"{item.file.path}: its cells lack the columns {missing}")
    known: Mapping[str, str] = {
        **{name: f"NULL::{kind}" for name, kind in SURFACE_COLUMNS[:-3] if name not in item.columns},
        "measurement": f"'{item.measurement}'",
        "artifact_format": f"{item.artifact_format}::INTEGER",
        "served": "true" if item.served else "false",
    }
    head = f"SELECT {_projection(SURFACE_COLUMNS, known)} FROM read_parquet('"
    tail = _text("', hive_partitioning = false)")
    return f"{_text(head)} || {_spliced(file_sql(item.file))} || {tail}"


def _projection(columns: Sequence[tuple[str, str]], given: Mapping[str, str]) -> str:
    """Each column as ``<expression> AS <name>``: the typed expression ``given`` holds for it, else the
    stored column cast to its type, so every branch of a union has the same types."""
    return ", ".join(f"{given.get(name, f'CAST({name} AS {kind})')} AS {name}" for name, kind in columns)


def _spliced(expression: str) -> str:
    """``expression``'s value as it is spliced inside a quoted literal of SQL text: quotes doubled, so a
    local root holding a quote still reads its file."""
    return f"replace({expression}, '''', '''''')"


def _text(sql: str) -> str:
    """A string literal holding SQL text this module wrote, its quotes doubled."""
    return "'" + sql.replace("'", "''") + "'"


def _literal(text: str, what: str) -> str:
    """A string literal of a value from outside this module, refused if it holds a quote."""
    if "'" in text:
        raise dr.DataReleaseError(f"{what} {text!r} holds a quote ('), which a lookup macro never splices")
    return f"'{text}'"


def _assert_url(url: str, what: str, *, folder: bool) -> str:
    """An absolute https URL (http only on localhost), ending in ``/`` exactly when ``folder``."""
    _literal(url, what)
    parts = urlsplit(url)
    loopback = parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1"}
    if (
        (parts.scheme != "https" and not loopback)
        or not parts.netloc
        or parts.query
        or parts.fragment
        or (url.endswith("/") != folder)
    ):
        shape = "a folder, ending in '/'" if folder else "one file"
        raise dr.DataReleaseError(f"{what} {url!r} is not an absolute https:// URL of {shape}")
    return url


def _assert_once(what: str, names: Iterable[str]) -> None:
    seen: set[str] = set()
    for name in names:
        if name in seen:
            raise dr.DataReleaseError(f"{what} {name} is listed twice, so its rows would be read twice")
        seen.add(name)
