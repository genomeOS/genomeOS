"""Bytes and requests for one cold single-variant lookup over HTTP Range reads.

Usage: python -I lookup_bytes.py <port> <req_log> <out.json> <label>=<relative_parquet_path>=<variant_id> ...
DuckDB 1.5.5, httpfs, every cache off, one fresh connection per lookup (as the 2026-10-19 probes).
"""
import json
import sys
import time
from pathlib import Path

import duckdb

port, log, out = int(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
res = {}
for arg in sys.argv[4:]:
    label, rel, vid = arg.split("=", 2)
    pos = int(vid.split("-")[1])
    log.write_text("")
    con = duckdb.connect()
    con.execute("LOAD httpfs")
    for s in ("SET enable_http_metadata_cache=false", "SET enable_external_file_cache=false",
              "SET parquet_metadata_cache=false"):
        con.execute(s)
    rows = con.execute(f"SELECT population_id, ac, an FROM read_parquet('http://127.0.0.1:{port}/{rel}') "
                       f"WHERE pos = {pos} AND variant_id = '{vid}'").fetchall()
    con.close()
    time.sleep(0.3)
    lines = [x.split() for x in log.read_text().splitlines() if x.strip()]
    res[label] = {"rows": len(rows), "bytes": sum(int(x[3]) for x in lines), "requests": len(lines)}
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res, indent=1))
