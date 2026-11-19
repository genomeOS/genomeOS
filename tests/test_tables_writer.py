"""The one pinned DuckDB writer and checks 1-2 (Atlas data platform design 2026-10-18 §2.5, §2.7; call 15)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import duckdb
import pyarrow.parquet as pq
import pytest

from genomeos.tables import contracts, provenance, writer
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import InputRef
from tests.observation_fixtures import observation_rows
from tests.tables_fixtures import GIT_SHA, rewrite_parquet

CATALOG_REF = InputRef("git:website/public/data/atlas/catalog.json", "c" * 64)
SERVED_SQL = (
    "SELECT printf('artifact-%05d', i) AS artifact, 'chr11-5227002-T-A' AS variant_id, "
    "'v3' AS model_version, 'map-2026-08' AS data_version, "
    "'git:website/public/data/atlas/catalog.json' AS pinned_by, repeat('c', 64) AS pinned_sha256 "
    "FROM range({n}) AS t(i)"
)
ALLELE = "measured.allele_observations"
BINNED = "measured.allele_observations_binned"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _served(con, out: Path, n: int = 3, **options) -> Path:
    arguments = {
        "table": "meta.served",
        "git_sha": GIT_SHA,
        "inputs": [CATALOG_REF],
        "sources": provenance.union_sources([CATALOG_REF], manifests={}, new_sources={}),
        "order_by": ["artifact"],
        **options,
    }
    return writer.write_parquet(con, SERVED_SQL.format(n=n), out, **arguments)


def _part(con, root: Path, relative: str, frame, table: str = ALLELE) -> Path:
    """A measured part at ``root/relative``, stamped like any other (the path is not checked on write)."""
    ref = InputRef("releases/2026-10-17/raw/afnd_populations.tsv", "d" * 64)
    return writer.write_frame(
        con,
        frame,
        root / relative,
        table=table,
        git_sha=GIT_SHA,
        inputs=[ref],
        sources=["afnd"],
        order_by=list(contracts.TABLE_CONTRACTS[table].key),
    )


def test_write_parquet_stamps_provenance_zstd_8192_row_groups_and_is_deterministic(tmp_path):
    con = writer.connect()
    a = _served(con, tmp_path / "a" / "served.parquet", n=20_000)
    b = _served(con, tmp_path / "b" / "served.parquet", n=20_000)
    assert _sha256(a) == _sha256(b)
    kv = provenance.read_kv(a)
    assert (kv["genomeos.table"], kv["genomeos.schema_version"], kv["genomeos.git_sha"]) == (
        "meta.served",
        "1.0",
        GIT_SHA,
    )
    assert kv["genomeos.contract_sha256"] == contracts.contract_sha256("meta.served")
    assert json.loads(kv["genomeos.sources"]) == ["genomeos"]
    assert provenance.decode_inputs(kv["genomeos.inputs"]) == (CATALOG_REF,)
    md = pq.read_metadata(a)
    assert [md.row_group(i).num_rows for i in range(md.num_row_groups)] == [8192, 8192, 3616]
    assert md.row_group(0).column(0).compression == "ZSTD"


def test_connect_refuses_another_duckdb(monkeypatch):
    monkeypatch.setattr(duckdb, "__version__", "1.5.6")
    with pytest.raises(TableError, match=r"1\.5\.5"):
        writer.connect()


def test_connect_uses_one_thread():
    con = writer.connect()
    assert con.execute("SELECT current_setting('threads')").fetchone() == (1,)
    settings = "current_setting('autoinstall_known_extensions'), current_setting('autoload_known_extensions')"
    assert con.execute(f"SELECT {settings}").fetchone() == (False, False)


def test_an_oversize_file_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(writer, "MAX_FILE_BYTES", 10)
    out = tmp_path / "served.parquet"
    with pytest.raises(TableError, match="MiB"):
        _served(writer.connect(), out)
    assert not out.exists() and not (tmp_path / "served.parquet.partial").exists()
    assert list(tmp_path.iterdir()) == []


def test_a_table_with_no_contract_is_refused(tmp_path):
    with pytest.raises(TableError, match="contract"):
        _served(writer.connect(), tmp_path / "x.parquet", table="meta.nothing")


def test_a_bad_git_sha_or_a_quote_in_metadata_is_refused(tmp_path):
    con = writer.connect()
    with pytest.raises(TableError, match="git_sha"):
        _served(con, tmp_path / "x.parquet", git_sha="abc")
    with pytest.raises(TableError, match="quote"):
        _served(con, tmp_path / "x.parquet", sources=["it's"])
    assert list(tmp_path.iterdir()) == []


def test_a_file_without_inputs_or_sources_is_refused(tmp_path):
    """Every tables/ file records what it was derived from; nothing gets a source by default (§2.1)."""
    con = writer.connect()
    with pytest.raises(TableError, match="inputs"):
        _served(con, tmp_path / "x.parquet", inputs=[])
    with pytest.raises(TableError, match="sources"):
        _served(con, tmp_path / "x.parquet", sources=[])


def test_a_file_its_contract_refuses_is_never_written(tmp_path):
    """Check 1 runs on the written bytes before the file takes its name."""
    out = tmp_path / "served.parquet"
    with pytest.raises(TableError, match="pinned_sha256"):
        writer.write_parquet(
            writer.connect(),
            "SELECT 'a' AS artifact, 'v' AS variant_id, 'v3' AS model_version, 'd' AS data_version, "
            "'p' AS pinned_by, NULL::VARCHAR AS pinned_sha256",
            out,
            table="meta.served",
            git_sha=GIT_SHA,
            inputs=[CATALOG_REF],
            sources=["genomeos"],
            order_by=["artifact"],
        )
    assert list(tmp_path.iterdir()) == []


def test_check_table_file_refuses_columns_other_than_its_contract(tmp_path):
    con = writer.connect()
    good = _served(con, tmp_path / "served.parquet")
    writer.check_table_file(good, "meta.served")
    extra = rewrite_parquet(con, good, tmp_path / "extra.parquet", "*, 1 AS extra")
    with pytest.raises(TableError, match="contract"):
        writer.check_table_file(extra, "meta.served")
    with pytest.raises(TableError, match="meta.release_objects"):
        writer.check_table_file(good, "meta.release_objects")


def test_check_table_file_refuses_a_file_written_outside_the_writer(tmp_path):
    con = writer.connect()
    good = _served(con, tmp_path / "served.parquet")
    bare = rewrite_parquet(con, good, tmp_path / "bare.parquet", "*", metadata=False)
    with pytest.raises(TableError, match="genomeos.table"):
        writer.check_table_file(bare, "meta.served")


def test_a_partition_value_differing_from_the_file_is_refused(tmp_path):
    con = writer.connect()
    rows = observation_rows().assign(source="afnd", ingest_version="afnd-2026-08")
    right = "tables/v1/measured/allele_observations/source=afnd/ingest_version=afnd-2026-08/part-0.parquet"
    writer.check_partitions(con, _part(con, tmp_path, right, rows), right)
    wrong = "tables/v1/measured/allele_observations/source=map/ingest_version=afnd-2026-08/part-0.parquet"
    with pytest.raises(TableError, match="source"):
        writer.check_partitions(con, _part(con, tmp_path, wrong, rows), wrong)


def test_a_partition_key_missing_from_the_file_is_refused(tmp_path):
    con = writer.connect()
    rows = observation_rows().assign(source="afnd", ingest_version="afnd-2026-08")
    relative = "tables/v1/measured/allele_observations/source=afnd/ingest_version=afnd-2026-08/part-0.parquet"
    good = _part(con, tmp_path / "good", relative, rows)
    bad = rewrite_parquet(con, good, tmp_path / "bad" / relative, "* EXCLUDE (ingest_version)")
    with pytest.raises(TableError, match="partition key ingest_version is not a column"):
        writer.check_partitions(con, bad, relative)


def test_check_partitions_derives_chrom_and_bin_for_the_binned_table(tmp_path):
    con = writer.connect()
    rows = (
        observation_rows(1)
        .drop(columns="source_record_id")
        .assign(pos=5227002, source_label="YRI", source="gnomad_hgdp_1kg", ingest_version="gnomad-2026-08")
    )
    base = (
        "tables/v1/measured/allele_observations_binned/source=gnomad_hgdp_1kg/ingest_version=gnomad-2026-08"
    )
    right = f"{base}/chrom=chr11/bin=5/part-0.parquet"
    writer.check_partitions(con, _part(con, tmp_path, right, rows, table=BINNED), right)
    wrong = f"{base}/chrom=chr11/bin=4/part-0.parquet"
    with pytest.raises(TableError, match="bin"):
        writer.check_partitions(con, _part(con, tmp_path, wrong, rows, table=BINNED), wrong)
