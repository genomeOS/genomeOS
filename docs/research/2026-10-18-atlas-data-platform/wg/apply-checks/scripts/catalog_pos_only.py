"""Catalog cost when a view lists only the 3,102 position-bin URLs (no population copy).

Re-measures the rejected "view lists every bin" option of design §2.6 without the 1,920-URL
population copy that the 2026-10-19 probe also listed. Same DuckDB 1.5.5, storage v1.2.0, caches
off, byte-logging Range server.

Usage: python -I catalog_pos_only.py <layouts_dir> <port> <req_log> <out_dir>
"""
import json
import sys
import time
from pathlib import Path

import duckdb

L, PORT, LOG, OUT = Path(sys.argv[1]), int(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
B = f"http://127.0.0.1:{PORT}"
pos_urls = sorted(f"{B}/{p.relative_to(L)}" for p in (L / "G1").rglob("*.parquet"))
assert len(pos_urls) == 3102
cat = OUT / "catalog_pos_only"
cat.mkdir(parents=True, exist_ok=True)
db = cat / "atlas.duckdb"
db.unlink(missing_ok=True)
c = duckdb.connect(str(db), config={"storage_compatibility_version": "v1.2.0"})
c.execute("CREATE SCHEMA measured")
lst = "[" + ",".join(f"'{u}'" for u in pos_urls) + "]"
c.execute(f"CREATE VIEW measured.allele_obs_by_position AS SELECT * FROM read_parquet({lst}, "
          "hive_partitioning=true, hive_types={'chrom': VARCHAR, 'bin': BIGINT})")
c.close()
LOG.write_text("")
con = duckdb.connect()
con.execute("LOAD httpfs")
for s in ("SET enable_http_metadata_cache=false", "SET enable_external_file_cache=false",
          "SET parquet_metadata_cache=false"):
    con.execute(s)
rel = db.relative_to(L)
con.execute(f"ATTACH '{B}/{rel}' AS atlas (READ_ONLY)")
con.close()
time.sleep(0.4)
lines = [x.split() for x in LOG.read_text().splitlines() if x.strip()]
res = {"pos_files": len(pos_urls), "catalog_bytes": db.stat().st_size,
       "attach_bytes": sum(int(x[3]) for x in lines), "attach_requests": len(lines)}
json.dump(res, open(OUT / "catalog_pos_only.json", "w"), indent=1)
print(json.dumps(res))
