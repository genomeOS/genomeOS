"""Bytes per row of the observation table under candidate physical layouts (DuckDB 1.5.5 writer).

Usage: python -I measure_size.py <workdir>
Writes out/size/*.parquet and out/size_results.json.
"""

import json
import os
import struct
import sys
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

W = Path(sys.argv[1])
OUT = W / "out/size"
OUT.mkdir(parents=True, exist_ok=True)
CONTRACT = [
    "variant_id", "rsid", "population_id", "lat", "lon", "radius_km", "ac", "an",
    "source_record_id", "source", "assay", "date_lower", "date_upper", "sampling_design",
    "disease_ascertainment_excluded", "cohort_id", "ingest_version",
]
con = duckdb.connect()
con.execute("SET threads=1; SET preserve_insertion_order=true")
con.execute(f"CREATE TABLE r AS SELECT * FROM read_parquet('{W}/out/rows.parquet')")
n_all = con.execute("SELECT count(*) FROM r").fetchone()[0]


def footer_len(path):
    with open(path, "rb") as f:
        f.seek(-8, os.SEEK_END)
        return struct.unpack("<I", f.read(4))[0] + 8


def write(name, select, order, rgs, extra=""):
    p = OUT / f"{name}.parquet"
    con.execute(
        f"COPY (SELECT {select} FROM r {('ORDER BY ' + order) if order else ''}) TO '{p}' "
        f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {rgs}{extra})"
    )
    md = pq.ParquetFile(p).metadata
    cols = {}
    for i in range(md.num_columns):
        nm = md.schema.column(i).name
        cols[nm] = sum(md.row_group(j).column(i).total_compressed_size for j in range(md.num_row_groups))
    size = p.stat().st_size
    rows = md.num_rows
    enc = {md.schema.column(i).name: sorted(set(md.row_group(0).column(i).encodings)) for i in range(md.num_columns)}
    return {
        "file": str(p), "rows": rows, "bytes": size, "bytes_per_row": size / rows,
        "row_groups": md.num_row_groups, "footer_bytes": footer_len(p),
        "col_bytes_per_row": {k: round(v / rows, 3) for k, v in sorted(cols.items(), key=lambda kv: -kv[1])},
        "encodings_rg0": enc,
    }


C = ", ".join(CONTRACT)
POSMAJ = "pos, ref, alt, population_id"
POPMAJ = "population_id, pos, ref, alt"
res = {"rows_total": n_all}
for rgs in (8192, 122880, 1048576):
    res[f"contract17_posmajor_rg{rgs}"] = write(f"c17_pos_rg{rgs}", C, POSMAJ, rgs)
res["contract17+pos_posmajor_rg122880"] = write("c17p_pos_rg122880", C + ", pos", POSMAJ, 122880)
res["contract17+pos_popmajor_rg122880"] = write("c17p_pop_rg122880", C + ", pos", POPMAJ, 122880)
res["contract17+pos_posmajor_rg122880_zstd9"] = write("c17p_pos_rg122880_l9", C + ", pos", POSMAJ, 122880, ", COMPRESSION_LEVEL 9")
res["contract17+pos_posmajor_rg122880_unsorted_input_order"] = write("c17p_none_rg122880", C + ", pos", None, 122880)
# reference: what the stored ac>0 rows alone would cost (NOT a proposal: an for ac=0 is evidence)
con.execute("CREATE TABLE r_sparse AS SELECT * FROM r WHERE ac > 0")
con.execute("ALTER TABLE r RENAME TO r_dense; ALTER TABLE r_sparse RENAME TO r")
res["REFERENCE_sparse_ac_gt0_contract17+pos_posmajor_rg122880"] = write("sparse_c17p_pos_rg122880", C + ", pos", POSMAJ, 122880)
json.dump(res, open(W / "out/size_results.json", "w"), indent=1)
for k, v in res.items():
    if isinstance(v, dict):
        top = list(v["col_bytes_per_row"].items())[:6]
        print(f"{k}: rows={v['rows']} bytes={v['bytes']} B/row={v['bytes_per_row']:.3f} rg={v['row_groups']} footer={v['footer_bytes']} top={top}")
