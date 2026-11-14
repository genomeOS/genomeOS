"""Bytes per row of the proposed lookup-set layout, with and without `source_label`.

Usage: python -I measure_layout.py <out.json> <label>=<rows.parquet>[:<populations_used.tsv>] ...
Rows from the recount carry `source_label`; for the older INFO-based rows (chr21, chr2) it is joined
from populations_used.tsv (`population`, the source's literal label). Layout: DuckDB, zstd, sorted
(pos, ref, alt, population_id), 122,880-row groups, threads = 1 (builder's calls 15, 29).
"""
import json
import sys
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

C16 = ["variant_id", "rsid", "population_id", "lat", "lon", "radius_km", "ac", "an", "source", "assay",
       "date_lower", "date_upper", "sampling_design", "disease_ascertainment_excluded", "cohort_id",
       "ingest_version"]
out = Path(sys.argv[1])
res = {}
con = duckdb.connect()
con.execute("SET threads=1; SET preserve_insertion_order=true")
for arg in sys.argv[2:]:
    label, spec = arg.split("=", 1)
    rows, _, pops = spec.partition(":")
    if pops:
        con.execute(f"""CREATE OR REPLACE TABLE r AS SELECT x.*, p.population AS source_label
                        FROM read_parquet('{rows}') x JOIN read_csv('{pops}', delim='\t', header=true) p
                        USING (population_id)""")
    else:
        con.execute(f"CREATE OR REPLACE TABLE r AS SELECT * FROM read_parquet('{rows}')")
    n = con.execute("SELECT count(*) FROM r").fetchone()[0]
    for name, cols in (("c16+pos", C16 + ["pos"]), ("c16+pos+source_label", C16 + ["pos", "source_label"])):
        p = out.parent / f"{label}_{name}.parquet"
        con.execute(f"COPY (SELECT {', '.join(cols)} FROM r ORDER BY pos, ref, alt, population_id) "
                    f"TO '{p}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)")
        md = pq.ParquetFile(p).metadata
        assert md.num_rows == n
        res[f"{label} {name}"] = {"rows": n, "bytes": p.stat().st_size,
                                  "bytes_per_row": round(p.stat().st_size / n, 4),
                                  "row_groups": md.num_row_groups}
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res, indent=1))
