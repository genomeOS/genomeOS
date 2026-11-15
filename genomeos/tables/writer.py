"""The one pinned DuckDB that writes every ``tables/`` file, and checks 1 and 2 on what it wrote.

Atlas data platform design 2026-10-18 §2.5 and §2.7 checks 1-2; builder's calls 15 and 16.

One DuckDB version (``DUCKDB_VERSION``) on one thread writes every file, so the same inputs give the
same bytes and a rebuild can be compared byte for byte. Each file is zstd-compressed in row groups of
``ROW_GROUP_ROWS`` (independently readable chunks a range read can skip), ordered by explicit columns,
and never larger than ``MAX_FILE_BYTES`` (§2.5: never above about 150 MB, where gcloud's composite
uploads drop the md5). Each carries its provenance in the Parquet key-value metadata:

- ``genomeos.table``, ``genomeos.schema_version`` and ``genomeos.contract_sha256``: the frozen contract
  it was checked against (``genomeos.tables.contracts``);
- ``genomeos.git_sha``: the commit that wrote it;
- ``genomeos.inputs`` and ``genomeos.sources``: what it was derived from, and those inputs' sources
  (``genomeos.tables.provenance``; call 16).

A file is written to ``<out>.partial``, checked against its contract (check 1) and its size cap, and
only then renamed into place: a file that fails is never left under its name. Check 2, that every
``key=value`` folder of a partitioned file equals the file's own column, runs over a release's paths.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Sequence
from pathlib import Path

import duckdb
import pandas as pd
import pandera.errors
import pyarrow
import pyarrow.parquet as pq

from genomeos.tables import contracts, provenance
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import InputRef

DUCKDB_VERSION = "1.5.5"
#: The storage version of every catalog file, so DuckDB 1.2.x can attach it (call 15).
STORAGE_VERSION = "v1.2.0"
ROW_GROUP_ROWS = 8192
MAX_FILE_BYTES = 150 * 1024 * 1024
GIT_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
#: The metadata every tables/ file carries, in the order it is written.
METADATA_KEYS = (
    "genomeos.table",
    "genomeos.schema_version",
    "genomeos.contract_sha256",
    "genomeos.git_sha",
    "genomeos.inputs",
    provenance.SOURCES_KEY,
)
#: Partition keys a file does not store: the binned table's, computed from its columns (check 2).
_DERIVED = {
    "chrom": "split_part(variant_id, '-', 1)",
    "bin": "CAST(pos // 1000000 AS VARCHAR)",
}
_FRAME_VIEW = "genomeos_frame"


def connect() -> duckdb.DuckDBPyConnection:
    """An in-memory connection of the pinned DuckDB on one thread, which never fetches an extension."""
    if duckdb.__version__ != DUCKDB_VERSION:
        raise TableError(
            f"DuckDB {duckdb.__version__} is installed, but every tables/ file is written by DuckDB "
            f"{DUCKDB_VERSION} (data platform call 15); install requirements.lock"
        )
    return duckdb.connect(
        config={
            "threads": 1,
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "preserve_insertion_order": True,
        }
    )


def write_parquet(
    con: duckdb.DuckDBPyConnection,
    select_sql: str,
    out: Path,
    *,
    table: str,
    git_sha: str,
    inputs: Sequence[InputRef],
    sources: Sequence[str],
    order_by: Sequence[str],
    row_group_rows: int = ROW_GROUP_ROWS,
) -> Path:
    """Write ``select_sql``'s rows, ordered by ``order_by``, as ``table``'s file at ``out``."""
    columns = contracts.columns(table)
    metadata = _metadata(table, git_sha, inputs, sources)
    unknown = [name for name in order_by if name not in columns]
    if not order_by or unknown:
        raise TableError(f"{table}: order_by {list(order_by)} must name columns of its contract")
    partial = out.with_name(f"{out.name}.partial")
    if "'" in str(partial):
        raise TableError(f"{out}: a path holding a quote (') cannot be written")
    literal = ", ".join(f"'{key}': '{value}'" for key, value in metadata.items())
    order = ", ".join(_identifier(name) for name in order_by)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        con.execute(
            f"COPY (SELECT * FROM ({select_sql}) ORDER BY {order}) TO '{partial}' "
            f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {int(row_group_rows)}, "
            f"KV_METADATA {{{literal}}})"
        )
        size = partial.stat().st_size
        if size > MAX_FILE_BYTES:
            raise TableError(
                f"{out}: {size / 2**20:.1f} MiB is over the {MAX_FILE_BYTES / 2**20:g} MiB cap (data "
                "platform §2.5); partition the table so each file stays within it"
            )
        check_table_file(partial, table)
        os.replace(partial, out)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return out


def write_frame(
    con: duckdb.DuckDBPyConnection,
    frame: pd.DataFrame,
    out: Path,
    *,
    table: str,
    git_sha: str,
    inputs: Sequence[InputRef],
    sources: Sequence[str],
    order_by: Sequence[str],
) -> Path:
    """Write ``frame`` through ``write_parquet``; an Arrow contract's types are applied on the way."""
    columns = contracts.columns(table)
    if tuple(frame.columns) != columns:
        raise TableError(
            f"{table}: frame columns {list(frame.columns)} are not its contract's {list(columns)}"
        )
    schema = contracts.TABLE_CONTRACTS[table].arrow_schema
    try:
        arrow = pyarrow.Table.from_pandas(frame, schema=schema, preserve_index=False)
    except (ValueError, TypeError, pyarrow.ArrowException) as error:
        raise TableError(f"{table}: the frame does not fit its contract: {error}") from error
    con.register(_FRAME_VIEW, arrow.replace_schema_metadata(None))
    try:
        return write_parquet(
            con,
            f"SELECT * FROM {_FRAME_VIEW}",
            out,
            table=table,
            git_sha=git_sha,
            inputs=inputs,
            sources=sources,
            order_by=order_by,
        )
    finally:
        con.unregister(_FRAME_VIEW)


def check_table_file(path: Path, table: str) -> None:
    """Check 1: ``path`` is a file of ``table`` under its frozen contract, with its provenance recorded."""
    columns = contracts.columns(table)
    contract = contracts.TABLE_CONTRACTS[table]
    kv = provenance.read_kv(path)
    missing = [key for key in METADATA_KEYS if key not in kv]
    if missing:
        raise TableError(f"{path}: records no {', '.join(missing)}; write it through genomeos.tables.writer")
    stamped = (kv["genomeos.table"], kv["genomeos.schema_version"], kv["genomeos.contract_sha256"])
    expected = (table, contract.schema_version, contracts.contract_sha256(table))
    if stamped != expected:
        raise TableError(f"{path}: written as {stamped}, but the {table} contract is {expected}")
    if not GIT_SHA_PATTERN.fullmatch(kv["genomeos.git_sha"]):
        raise TableError(f"{path}: genomeos.git_sha {kv['genomeos.git_sha']!r} is not a commit")
    if not provenance.decode_inputs(kv["genomeos.inputs"]):
        raise TableError(f"{path}: records no inputs (data platform §2.1)")
    provenance.parse_sources(kv[provenance.SOURCES_KEY], where=str(path))
    data = pq.ParquetFile(path).read()
    if tuple(data.column_names) != columns:
        raise TableError(
            f"{path}: columns {data.column_names} are not the {table} contract's {list(columns)}"
        )
    if contract.arrow_schema is None:
        assert contract.schema is not None
        try:
            contract.schema.validate(data.to_pandas())
        except (pandera.errors.SchemaError, pandera.errors.SchemaErrors) as error:
            raise TableError(f"{path}: rows the {table} contract refuses: {error}") from error
        return
    for field in contract.arrow_schema:
        column = data.column(field.name)
        if column.type != field.type:
            raise TableError(
                f"{path}: column {field.name} is {column.type}; its {table} contract says {field.type}"
            )
        if not field.nullable and column.null_count:
            raise TableError(
                f"{path}: column {field.name} holds {column.null_count} nulls, which its {table} "
                "contract forbids"
            )
    keys = data.group_by(list(contract.key)).aggregate([])
    if keys.num_rows != data.num_rows:
        raise TableError(
            f"{path}: {data.num_rows - keys.num_rows} rows repeat the {table} key {list(contract.key)}"
        )


def check_partitions(con: duckdb.DuckDBPyConnection, path: Path, relative: str) -> None:
    """Check 2: each ``key=value`` folder of ``relative`` equals the file's own column of that name.

    ``chrom`` and ``bin`` alone are derived, from ``variant_id`` and ``pos // 1_000_000``; any other
    partition key must be a stored column. Hive partitioning is off, so a folder never overrides a value.
    """
    names = set(pq.read_schema(path).names)
    for segment in relative.split("/")[:-1]:
        if "=" not in segment:
            continue
        key, value = segment.split("=", 1)
        if key in _DERIVED:
            expression = _DERIVED[key]
        elif key in names:
            expression = f"CAST({_identifier(key)} AS VARCHAR)"
        else:
            raise TableError(f"{relative}: partition key {key} is not a column of the file (check 2)")
        row = con.execute(
            f"SELECT count(*), any_value({expression}) FROM read_parquet(?, hive_partitioning = false) "
            f"WHERE ({expression}) IS DISTINCT FROM ?",
            [str(path), value],
        ).fetchone()
        assert row is not None
        count, example = row
        if count:
            raise TableError(
                f"{relative}: {count} rows have {key} {example!r}, not the folder's {value!r} (check 2)"
            )


def _metadata(table: str, git_sha: str, inputs: Sequence[InputRef], sources: Sequence[str]) -> dict[str, str]:
    if not isinstance(git_sha, str) or not GIT_SHA_PATTERN.fullmatch(git_sha):
        raise TableError(f"{table}: git_sha {git_sha!r} is not a 40-character lowercase hex commit")
    if not inputs:
        raise TableError(
            f"{table}: a tables/ file records the inputs it was derived from (data platform §2.1)"
        )
    names = sorted(set(sources))
    if not names:
        raise TableError(f"{table}: a tables/ file carries its inputs' sources (call 16); none were given")
    values = (
        table,
        contracts.TABLE_CONTRACTS[table].schema_version,
        contracts.contract_sha256(table),
        git_sha,
        provenance.encode_inputs(inputs),
        json.dumps(names, separators=(",", ":")),
    )
    metadata = dict(zip(METADATA_KEYS, values, strict=True))
    quoted = sorted(key for key, value in metadata.items() if "'" in value)
    if quoted:
        raise TableError(
            f"{table}: metadata {quoted} holds a quote ('), which the COPY statement cannot carry"
        )
    return metadata


def _identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'
