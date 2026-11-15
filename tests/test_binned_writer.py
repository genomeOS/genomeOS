"""One lookup-set bin through the pinned writer (Atlas data platform design 2026-10-18 §2.10; calls 29-30)."""

from __future__ import annotations

import hashlib
import json

import pandas as pd
import pyarrow
import pyarrow.parquet as pq
import pytest
from pandera.errors import SchemaError, SchemaErrors

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.tables import writer
from genomeos.tables.binned import (
    BINNED_COLUMNS,
    LOOKUP_ROW_GROUP_ROWS,
    SOURCE_RECORD_ID_TEMPLATE,
    BinFile,
    read_bin_cells,
    source_record_id_sql,
    write_bin,
)
from genomeos.tables.contracts import BINNED_OBSERVATIONS_SCHEMA, TableError, contract_sha256
from genomeos.tables.lookup_sets import BINNED_TABLE, GRCH38_LENGTHS, BinRef, bin_path, lookup_set
from genomeos.tables.provenance import read_kv
from tests.lookup_fixtures import W, binned_row

LOOKUP = lookup_set("gnomad_hgdp_1kg", "fixture-1", GRCH38_LENGTHS)


def _sha256(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_write_bin_sorts_compresses_and_labels_its_file(tmp_path):
    assert set(BINNED_COLUMNS) == set(BINNED_OBSERVATIONS_SCHEMA.columns)
    assert BINNED_COLUMNS == tuple(c for c in OBSERVATIONS_SCHEMA.columns if c != "source_record_id") + (
        "pos",
        "source_label",
    )
    rows = pd.concat(
        [
            binned_row(variant_id="chr11-5227002-T-G"),
            binned_row(population_id="hgdp-northernhan", source_label="NorthernHan"),
            binned_row(),
            binned_row(variant_id="chr11-5227002-TA-T"),
            binned_row(variant_id="chr11-5200000-C-T", pos=5200000),
        ]
    )
    written = write_bin(rows, tmp_path, LOOKUP, BinRef("chr11", 5), **W)
    path = tmp_path / written.path
    assert written == BinFile(bin_path(LOOKUP, BinRef("chr11", 5)), _sha256(path), path.stat().st_size, 5)
    t = pq.read_table(path)
    assert tuple(t.column_names) == BINNED_COLUMNS
    assert list(zip(t["variant_id"].to_pylist(), t["population_id"].to_pylist(), strict=True)) == [
        ("chr11-5200000-C-T", "hgdp-han"),
        ("chr11-5227002-T-A", "hgdp-han"),
        ("chr11-5227002-T-A", "hgdp-northernhan"),
        ("chr11-5227002-T-G", "hgdp-han"),
        ("chr11-5227002-TA-T", "hgdp-han"),
    ]
    kv = read_kv(path)
    assert (kv["genomeos.table"], kv["genomeos.schema_version"], kv["genomeos.contract_sha256"]) == (
        BINNED_TABLE,
        "1.0",
        contract_sha256(BINNED_TABLE),
    )
    assert json.loads(kv["genomeos.sources"]) == W["sources"]
    assert pq.ParquetFile(path).metadata.row_group(0).column(0).compression == "ZSTD"


def test_bin_zero_sorts_by_position_not_by_id_text(tmp_path):
    """Only bin 0 mixes position widths, where the id text would put 100 before 99."""
    rows = pd.concat([binned_row(variant_id=f"chr11-{p}-T-A", pos=p) for p in (100, 99)])
    written = write_bin(rows, tmp_path, LOOKUP, BinRef("chr11", 0), **W)
    assert pq.read_table(tmp_path / written.path)["pos"].to_pylist() == [99, 100]


@pytest.mark.parametrize(
    "rows, match",
    [
        (lambda: binned_row(variant_id="chr11-6000000-A-G", pos=6000000), "bin"),
        (lambda: binned_row(variant_id="chr12-5227002-T-A"), "chrom"),
        (lambda: binned_row(source="gnomad_v4"), "source"),
        (lambda: binned_row(ingest_version="other-1"), "ingest_version"),
        (lambda: pd.concat([binned_row(), binned_row(population_id="hgdp-northernhan")]), "source_label"),
        (lambda: binned_row(ac=0, an=0), r"'an'.*greater_than"),
    ],
)
def test_rows_that_do_not_belong_are_refused_and_leave_no_file(tmp_path, rows, match):
    with pytest.raises((TableError, SchemaError, SchemaErrors), match=match):
        write_bin(rows(), tmp_path, LOOKUP, BinRef("chr11", 5), **W)
    assert not any(tmp_path.rglob("*.parquet*"))


def test_source_record_id_sql():
    sql = source_record_id_sql(SOURCE_RECORD_ID_TEMPLATE)
    assert sql == "'gnomad-hgdp-1kg:' || variant_id || ':' || source_label"
    derived = writer.connect().execute(
        f"SELECT {sql} FROM (SELECT 'chr11-5227002-T-A' AS variant_id, 'NorthernHan' AS source_label)"
    )
    expected = SOURCE_RECORD_ID_TEMPLATE.format(variant_id="chr11-5227002-T-A", source_label="NorthernHan")
    assert derived.fetchall() == [(expected,)]
    for template in (
        "x:{population_id}",
        "it's {variant_id}:{source_label}",
        "{variant_id}:{variant_id}",
        "{variant_id!r}:{source_label}",
        "{variant_id}:{source_label:>9}",
        "{variant_id}:{source_label",
    ):
        with pytest.raises(TableError, match="template"):
            source_record_id_sql(template)


def test_row_groups_hold_122880_rows(tmp_path):
    n = LOOKUP_ROW_GROUP_ROWS + 1
    pos = range(5_000_000, 5_000_000 + n)
    rows = binned_row().loc[[0] * n].assign(variant_id=[f"chr11-{p}-A-G" for p in pos], pos=list(pos))
    written = write_bin(rows, tmp_path, LOOKUP, BinRef("chr11", 5), **W)
    metadata = pq.read_metadata(tmp_path / written.path)
    assert (metadata.num_row_groups, metadata.row_group(0).num_rows) == (2, 122_880)
    assert written.rows == n


def test_an_empty_bin_has_the_full_schema(tmp_path):
    full = write_bin(binned_row(), tmp_path, LOOKUP, BinRef("chr11", 5), **W)
    empty = write_bin(binned_row().iloc[:0], tmp_path, LOOKUP, BinRef("chr11", 6), **W)
    assert empty.path.endswith("/chrom=chr11/bin=6/part-0.parquet") and empty.rows == 0
    schema = pq.read_schema(tmp_path / empty.path)
    assert schema == pq.read_schema(tmp_path / full.path)
    assert tuple(schema.names) == BINNED_COLUMNS
    assert (schema.field("lat").type, schema.field("ac").type, schema.field("pos").type) == (
        pyarrow.float64(),
        pyarrow.int64(),
        pyarrow.int64(),
    )
    assert schema.field("disease_ascertainment_excluded").type == pyarrow.bool_()


def test_write_bin_is_byte_deterministic(tmp_path):
    rows = pd.concat([binned_row(), binned_row(population_id="hgdp-northernhan", source_label="NorthernHan")])
    a = write_bin(rows, tmp_path / "a", LOOKUP, BinRef("chr11", 5), **W)
    b = write_bin(rows.iloc[::-1], tmp_path / "b", LOOKUP, BinRef("chr11", 5), **W)
    assert a.sha256 == b.sha256 == _sha256(tmp_path / "a" / a.path)


def test_read_bin_cells_reads_a_bins_counts(tmp_path):
    northern = binned_row(population_id="hgdp-northernhan", source_label="NorthernHan", ac=0)
    rows = pd.concat([northern, binned_row()])
    written = write_bin(rows, tmp_path, LOOKUP, BinRef("chr11", 5), **W)
    cells = read_bin_cells(tmp_path / written.path)
    assert list(cells.columns) == ["variant_id", "source_label", "ac", "an"]
    assert cells.to_dict("records") == [
        {"variant_id": "chr11-5227002-T-A", "source_label": "Han", "ac": 3, "an": 4},
        {"variant_id": "chr11-5227002-T-A", "source_label": "NorthernHan", "ac": 0, "an": 4},
    ]
    bare = tmp_path / "bare.parquet"
    pq.write_table(pq.read_table(tmp_path / written.path).replace_schema_metadata(None), bare)
    with pytest.raises(TableError, match=BINNED_TABLE):
        read_bin_cells(bare)
