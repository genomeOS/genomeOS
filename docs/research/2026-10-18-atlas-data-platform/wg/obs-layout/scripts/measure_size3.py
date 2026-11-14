"""Third size batch: prefix-encoded source_record_id (pyarrow writer) and a narrow
population-major projection.

Usage: python -I measure_size3.py <workdir>
"""

import json
import sys
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

W = Path(sys.argv[1])
OUT = W / "out/size"
CONTRACT = [
    "variant_id", "rsid", "population_id", "lat", "lon", "radius_km", "ac", "an",
    "source_record_id", "source", "assay", "date_lower", "date_upper", "sampling_design",
    "disease_ascertainment_excluded", "cohort_id", "ingest_version",
]
con = duckdb.connect()
con.execute("SET threads=1; SET preserve_insertion_order=true")
con.execute(f"CREATE TABLE r AS SELECT * FROM read_parquet('{W}/out/rows.parquet')")
res = {}


def summarize(p):
    md = pq.ParquetFile(p).metadata
    cols = {}
    for i in range(md.num_columns):
        cols[md.schema.column(i).name] = sum(md.row_group(j).column(i).total_compressed_size for j in range(md.num_row_groups))
    enc = {md.schema.column(i).name: sorted(set(md.row_group(0).column(i).encodings)) for i in range(md.num_columns)}
    return {"file": str(p), "rows": md.num_rows, "bytes": p.stat().st_size, "bytes_per_row": p.stat().st_size / md.num_rows,
            "row_groups": md.num_row_groups,
            "col_bytes_per_row": {k: round(v / md.num_rows, 3) for k, v in sorted(cols.items(), key=lambda kv: -kv[1])},
            "encodings_rg0": enc}


# (1) pyarrow writer, pos-major, DELTA_BYTE_ARRAY for source_record_id, dictionary elsewhere
t = con.execute(f"SELECT {', '.join(CONTRACT)}, pos FROM r ORDER BY pos, ref, alt, population_id").fetch_arrow_table()
p = OUT / "pa_c17p_pos_dba.parquet"
pq.write_table(t, p, compression="zstd", row_group_size=122880,
               use_dictionary=[c for c in t.column_names if c != "source_record_id"],
               column_encoding={"source_record_id": "DELTA_BYTE_ARRAY"})
res["pyarrow_c17+pos_posmajor_rg122880_srid_DELTA_BYTE_ARRAY"] = summarize(p)
p = OUT / "pa_c17p_pos_default.parquet"
pq.write_table(t, p, compression="zstd", row_group_size=122880)
res["pyarrow_c17+pos_posmajor_rg122880_defaults"] = summarize(p)

# (2) narrow population-major projection: population in the path, keys + counts only
for v2 in (False, True):
    name = "narrow_popmajor" + ("_V2" if v2 else "")
    p = OUT / f"{name}.parquet"
    con.execute(
        f"COPY (SELECT population_id, pos, ref, alt, ac, an FROM r ORDER BY population_id, pos, ref, alt) TO '{p}' "
        f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880{', PARQUET_VERSION V2' if v2 else ''})"
    )
    res[name + "_rg122880(population_id,pos,ref,alt,ac,an)"] = summarize(p)
json.dump(res, open(W / "out/size_results3.json", "w"), indent=1)
for k, v in res.items():
    print(f"{k}: bytes={v['bytes']} B/row={v['bytes_per_row']:.3f} top={list(v['col_bytes_per_row'].items())[:6]}")
    print("   enc:", {c: e for c, e in v["encodings_rg0"].items() if c in ("variant_id", "source_record_id", "pos", "ref", "ac", "an")})
