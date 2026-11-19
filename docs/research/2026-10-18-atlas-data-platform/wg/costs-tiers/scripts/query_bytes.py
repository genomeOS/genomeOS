"""Bytes a DuckDB httpfs client pulls for typical observation queries, through a byte-logging
Range server (caches off). Files come from gen_measure.py (variant-major, 80 populations)."""

import os
import subprocess
import sys
import time

import duckdb

OUT, EXT, LOG = sys.argv[1], sys.argv[2], sys.argv[3]
PORT = 8791
B = f"http://127.0.0.1:{PORT}"
here = os.path.dirname(os.path.abspath(__file__))
srv = subprocess.Popen([sys.executable, "-I", f"{here}/rserve.py", OUT, str(PORT), LOG])
time.sleep(1.0)

con0 = duckdb.connect()
f0 = f"{OUT}/L1_all17_zstd_rg8192.parquet"
con0.execute(f"COPY (SELECT * FROM read_parquet('{f0}') LIMIT 1600000) TO '{OUT}/L1small_all17_zstd_rg8192.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 8192)")
vids = [r[0] for r in con0.execute(f"SELECT DISTINCT variant_id FROM read_parquet('{f0}') ORDER BY variant_id").fetchall()]
# a variant in the middle of the small file, and a 100 kb window (~5,000 variants at 1 per 20 bp)
mid = con0.execute(f"SELECT variant_id, split_part(variant_id,'-',2)::BIGINT FROM read_parquet('{OUT}/L1small_all17_zstd_rg8192.parquet') LIMIT 1 OFFSET 800000").fetchone()
pos0 = mid[1]
con0.close()


def run(label, sql):
    open(LOG, "w").close()
    con = duckdb.connect()
    con.execute(f"SET extension_directory='{EXT}'")
    con.execute("LOAD httpfs")
    for s in ["SET enable_http_metadata_cache=false", "SET enable_external_file_cache=false",
              "SET parquet_metadata_cache=false"]:
        try:
            con.execute(s)
        except Exception as e:  # noqa: BLE001
            print("setting failed", s, e)
    r = con.execute(sql).fetchall()
    con.close()
    time.sleep(0.3)
    lines = [ln.split() for ln in open(LOG) if ln.strip()]
    nb = sum(int(ln[3]) for ln in lines)
    gets = sum(1 for ln in lines if ln[0] == "GET")
    heads = sum(1 for ln in lines if ln[0] == "HEAD")
    print(f"{label}: result_rows={len(r)} bytes={nb} ({nb/1e6:.3f} MB) GET={gets} HEAD={heads}")
    return nb


cols = "variant_id, population_id, lat, lon, radius_km, ac, an, sampling_design, disease_ascertainment_excluded, cohort_id, source_record_id"
for f in ["L1small_all17_zstd_rg8192", "L1_all17_zstd_rg8192", "L2_all17_zstd_rg122880", "L4_slim5_zstd_rg8192"]:
    size = os.path.getsize(f"{OUT}/{f}.parquet")
    c = cols if not f.startswith("L4") else "variant_id, population_id, ac, an"
    print(f"--- {f}: {size} B")
    run("point (1 variant x 80 pops)", f"SELECT {c} FROM read_parquet('{B}/{f}.parquet') WHERE variant_id = '{mid[0]}'")
    run("region 100 kb", f"SELECT {c} FROM read_parquet('{B}/{f}.parquet') WHERE split_part(variant_id,'-',2)::BIGINT BETWEEN {pos0} AND {pos0 + 100_000}")
    run("one population, every variant in file", f"SELECT variant_id, ac, an FROM read_parquet('{B}/{f}.parquet') WHERE population_id = 'hgdp-yoruba'")
    run("aggregate scan ac, an by population", f"SELECT population_id, sum(ac), sum(an) FROM read_parquet('{B}/{f}.parquet') GROUP BY 1")
srv.terminate()
