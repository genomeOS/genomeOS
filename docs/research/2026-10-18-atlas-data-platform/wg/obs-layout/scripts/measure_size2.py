"""Second size batch: Parquet V2 encodings and a derived (not stored) source_record_id.

Usage: python -I measure_size2.py <workdir>
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
NO_SRID = [c for c in CONTRACT if c != "source_record_id"]
con = duckdb.connect()
con.execute("SET threads=1; SET preserve_insertion_order=true")
con.execute(f"CREATE TABLE r AS SELECT * FROM read_parquet('{W}/out/rows.parquet')")


def write(name, select, order, rgs, extra=""):
    p = OUT / f"{name}.parquet"
    con.execute(
        f"COPY (SELECT {select} FROM r ORDER BY {order}) TO '{p}' "
        f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {rgs}{extra})"
    )
    md = pq.ParquetFile(p).metadata
    cols = {}
    for i in range(md.num_columns):
        nm = md.schema.column(i).name
        cols[nm] = sum(md.row_group(j).column(i).total_compressed_size for j in range(md.num_row_groups))
    enc = {md.schema.column(i).name: sorted(set(md.row_group(0).column(i).encodings)) for i in range(md.num_columns)}
    rows = md.num_rows
    size = p.stat().st_size
    return {
        "file": str(p), "rows": rows, "bytes": size, "bytes_per_row": size / rows, "row_groups": md.num_row_groups,
        "col_bytes_per_row": {k: round(v / rows, 3) for k, v in sorted(cols.items(), key=lambda kv: -kv[1])},
        "encodings_rg0": enc,
    }


POSMAJ = "pos, ref, alt, population_id"
POPMAJ = "population_id, pos, ref, alt"
V2 = ", PARQUET_VERSION V2"
res = {}
res["c17+pos_posmajor_rg122880_V2"] = write("c17p_pos_rg122880_v2", ", ".join(CONTRACT) + ", pos", POSMAJ, 122880, V2)
res["c17+pos_popmajor_rg122880_V2"] = write("c17p_pop_rg122880_v2", ", ".join(CONTRACT) + ", pos", POPMAJ, 122880, V2)
res["c16(no srid)+pos_posmajor_rg122880"] = write("c16p_pos_rg122880", ", ".join(NO_SRID) + ", pos", POSMAJ, 122880)
res["c16(no srid)+pos_posmajor_rg122880_V2"] = write("c16p_pos_rg122880_v2", ", ".join(NO_SRID) + ", pos", POSMAJ, 122880, V2)
res["c16(no srid)+pos_popmajor_rg122880_V2"] = write("c16p_pop_rg122880_v2", ", ".join(NO_SRID) + ", pos", POPMAJ, 122880, V2)
res["c16(no srid)+pos_popmajor_rg122880"] = write("c16p_pop_rg122880", ", ".join(NO_SRID) + ", pos", POPMAJ, 122880)
json.dump(res, open(W / "out/size_results2.json", "w"), indent=1)
for k, v in res.items():
    top = list(v["col_bytes_per_row"].items())[:6]
    print(f"{k}: bytes={v['bytes']} B/row={v['bytes_per_row']:.3f} top={top}")
    print("   enc:", {c: e for c, e in v["encodings_rg0"].items() if c in ("variant_id", "rsid", "source_record_id", "pos", "ac", "an")})
