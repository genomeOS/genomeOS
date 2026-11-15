"""One lookup-set bin file, written through the pinned writer, and the ``source_record_id`` it derives.

Atlas data platform design 2026-10-18 §2.4, §2.5, §2.7 check 2 and §2.10; builder's calls 15, 29 and 30.

A lookup set stores ``measured.allele_observations_binned`` as one file per chromosome and 1 Mb bin
(``genomeos.tables.lookup_sets``). ``write_bin`` writes one such file:

- its rows are validated against ``BINNED_OBSERVATIONS_SCHEMA`` (counts ``ac`` and ``an``, ``an > 0``,
  ``pos`` repeating the id's position, the ascertainment fields present), and then refused unless they
  belong to the bin: every row on the bin's chromosome with ``pos // BIN_BP`` equal to its bin (check 2's
  rule, enforced as the file is written), the lookup set's ``source`` and ``ingest_version``, and no
  ``(variant_id, source_label)`` twice, since that pair derives the row's ``source_record_id``;
- the pinned DuckDB writes it (call 15): every column CAST explicitly, so an empty bin, which is written
  too (call 29), keeps the full schema; sorted ``(pos, variant_id, population_id)``, which is
  ``(pos, ref, alt, population_id)`` because ``-`` sorts below every base; zstd in row groups of
  ``LOOKUP_ROW_GROUP_ROWS`` (call 29); atomically, under the 150 MiB cap, with its provenance (§2.5).

A bin stores no ``source_record_id`` (call 30). The lookup macro derives it from the template recorded in
``measured.ingests``, through ``source_record_id_sql``, so the curated and binned tables present the same
17 columns (§2.4). A refused row is a ``TableError`` or a pandera error, and nothing is dropped (v1 §12).
"""

from __future__ import annotations

import hashlib
import string
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
import pyarrow
import pyarrow.parquet as pq

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.tables import writer
from genomeos.tables.contracts import BINNED_OBSERVATIONS_SCHEMA, TableError
from genomeos.tables.lookup_sets import BIN_BP, BINNED_TABLE, BinRef, LookupSet, bin_path
from genomeos.tables.provenance import InputRef, read_kv

__all__ = (
    "BINNED_COLUMNS",
    "LOOKUP_ROW_GROUP_ROWS",
    "SOURCE_RECORD_ID_TEMPLATE",
    "BinFile",
    "read_bin_cells",
    "source_record_id_sql",
    "write_bin",
)

#: A bin's stored columns, in file order: the fit-input contract's without ``source_record_id``, then the
#: position its bin is computed from and the label the source gave the population (§2.4).
BINNED_COLUMNS: tuple[str, ...] = (
    *(name for name in OBSERVATIONS_SCHEMA.columns if name != "source_record_id"),
    "pos",
    "source_label",
)
#: Rows per row group of a bin file, overriding §2.5's 8,192 for lookup sets only (call 29).
LOOKUP_ROW_GROUP_ROWS = 122_880
#: The gnomAD recount's ``source_record_id`` (§2.10), recorded in ``measured.ingests`` (call 30).
SOURCE_RECORD_ID_TEMPLATE = "gnomad-hgdp-1kg:{variant_id}:{source_label}"

_TEMPLATE_FIELDS = ("source_label", "variant_id")
_ORDER_BY = ("pos", "variant_id", "population_id")
_ROWS_VIEW = "genomeos_bin_rows"
#: Each stored column's SQL type, VARCHAR unless listed: the explicit CAST keeps an empty bin's schema.
_SQL_TYPES = {
    **dict.fromkeys(("lat", "lon", "radius_km"), "DOUBLE"),
    **dict.fromkeys(("ac", "an", "date_lower", "date_upper", "pos"), "BIGINT"),
    "disease_ascertainment_excluded": "BOOLEAN",
}
_CELL_COLUMNS = ("variant_id", "source_label", "ac", "an")


@dataclass(frozen=True)
class BinFile:
    """One written bin: its data path, and the sha256, size in bytes and row count of its file."""

    path: str
    sha256: str
    bytes: int
    rows: int


def source_record_id_sql(template: str) -> str:
    """The SQL expression deriving ``source_record_id`` from a bin's columns under ``template``.

    The template names ``{variant_id}`` and ``{source_label}`` once each, with no conversion or format
    spec, and holds no quote ('), since its literal text becomes SQL string literals.
    """
    rule = (
        "a source_record_id template names {variant_id} and {source_label} once each, with no "
        "conversion or format spec, and holds no quote (')"
    )
    if not isinstance(template, str) or "'" in template:
        raise TableError(f"source_record_id template {template!r} refused: {rule}")
    try:
        parsed = list(string.Formatter().parse(template))
    except ValueError as error:
        raise TableError(f"source_record_id template {template!r} refused: {error}; {rule}") from error
    fields = sorted(field for _, field, _, _ in parsed if field is not None)
    flagged = any(spec or conversion for _, field, spec, conversion in parsed if field is not None)
    if tuple(fields) != _TEMPLATE_FIELDS or flagged:
        raise TableError(f"source_record_id template {template!r} refused: {rule}")
    parts: list[str] = []
    for literal, field, _, _ in parsed:
        if literal:
            parts.append(f"'{literal}'")
        if field is not None:
            parts.append(field)
    return " || ".join(parts)


def write_bin(
    rows: pd.DataFrame,
    out_root: Path,
    lookup: LookupSet,
    ref: BinRef,
    *,
    git_sha: str,
    inputs: Sequence[InputRef],
    sources: Sequence[str],
) -> BinFile:
    """Write ``rows`` as ``ref``'s file of ``lookup`` under ``out_root``, refusing any row not of that bin."""
    path = bin_path(lookup, ref)
    valid = BINNED_OBSERVATIONS_SCHEMA.validate(rows)
    _assert_rows_belong(valid, lookup, ref, path)
    arrow = pyarrow.Table.from_pandas(valid[list(BINNED_COLUMNS)], preserve_index=False)
    con = writer.connect()
    try:
        con.register(_ROWS_VIEW, arrow.replace_schema_metadata(None))
        out = writer.write_parquet(
            con,
            f"SELECT {', '.join(_cast(name) for name in BINNED_COLUMNS)} FROM {_ROWS_VIEW}",
            out_root / path,
            table=BINNED_TABLE,
            git_sha=git_sha,
            inputs=inputs,
            sources=sources,
            order_by=_ORDER_BY,
            row_group_rows=LOOKUP_ROW_GROUP_ROWS,
        )
    finally:
        con.close()
    with out.open("rb") as stream:
        sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    return BinFile(path, sha256, out.stat().st_size, pq.read_metadata(out).num_rows)


def read_bin_cells(path: Path) -> pd.DataFrame:
    """A bin file's cells in file order: ``variant_id``, ``source_label``, ``ac`` and ``an``."""
    table = read_kv(path).get("genomeos.table")
    if table != BINNED_TABLE:
        raise TableError(f"{path}: written as table {table!r}, not as a bin of {BINNED_TABLE}")
    return pq.read_table(path, columns=list(_CELL_COLUMNS)).to_pandas()


def _assert_rows_belong(rows: pd.DataFrame, lookup: LookupSet, ref: BinRef, path: str) -> None:
    """Every row on ``ref``'s chromosome and bin, of ``lookup``'s ingest, with a unique derived id."""
    refusals = {
        # The schema has matched each id to chr-pos-ref-alt, so the prefix is exactly its chromosome.
        f"chrom is not {ref.chrom}": ~rows["variant_id"].str.startswith(f"{ref.chrom}-"),
        f"bin (pos // {BIN_BP:_}) is not {ref.bin}": rows["pos"].floordiv(BIN_BP).ne(ref.bin),
        f"source is not {lookup.source}": rows["source"].ne(lookup.source),
        f"ingest_version is not {lookup.ingest_version}": rows["ingest_version"].ne(lookup.ingest_version),
        "(variant_id, source_label) repeats, so their derived source_record_id would too": rows.duplicated(
            ["variant_id", "source_label"], keep=False
        ),
    }
    for rule, bad in refusals.items():
        if bad.any():
            example = rows.loc[bad, ["variant_id", "population_id", "source_label"]].iloc[0].tolist()
            raise TableError(f"{path}: {int(bad.sum())} rows refused, because their {rule}; first: {example}")


def _cast(name: str) -> str:
    return f'CAST("{name}" AS {_SQL_TYPES.get(name, "VARCHAR")}) AS "{name}"'
