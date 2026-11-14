"""Bytes read and request counts for the three query shapes, DuckDB 1.5.5 over a local
Range-capable HTTP server (scripts/rserve.py), caches off, one cold connection per query.

Usage: python -I run_queries.py <workdir> <port>
"""

import json
import sys
import time
from pathlib import Path

import duckdb

W = Path(sys.argv[1])
PORT = int(sys.argv[2])
LOG = W / "out/req.log"
L = W / "out/layouts"
B = f"http://127.0.0.1:{PORT}"
IV = "gnomad_hgdp_1kg-v3.1.2-probe-2026-10-19"
APP = (25880535, 26171128)  # Ensembl ENSG00000142192, GRCh38
POP = "onekg-yri"

con0 = duckdb.connect()
V, P = con0.execute(
    f"SELECT variant_id, pos FROM read_parquet('{W}/out/rows.parquet') WHERE pos >= 25950000 "
    "AND length(ref)=1 AND length(alt)=1 ORDER BY pos LIMIT 1"
).fetchone()
con0.close()


def urls(layout):
    files = sorted(p for p in (L / layout).rglob("*.parquet"))
    return "[" + ",".join(f"'{B}/{p.relative_to(L)}'" for p in files) + "]", len(files)


def run(label, sql, setup=()):
    LOG.write_text("")
    con = duckdb.connect()
    con.execute("LOAD httpfs")
    for s in ("SET enable_http_metadata_cache=false", "SET enable_external_file_cache=false",
              "SET parquet_metadata_cache=false", "SET threads=4"):
        con.execute(s)
    for s in setup:
        con.execute(s)
    t = time.time()
    rows = con.execute(sql).fetchall()
    dt = time.time() - t
    con.close()
    time.sleep(0.4)
    lines = [ln.split() for ln in LOG.read_text().splitlines() if ln.strip()]
    nbytes = sum(int(x[3]) for x in lines)
    heads = sum(1 for x in lines if x[0] == "HEAD")
    gets = sum(1 for x in lines if x[0] == "GET")
    files = len({x[1] for x in lines})
    rec = {"label": label, "result_rows": len(rows), "bytes": nbytes, "HEAD": heads, "GET": gets,
           "requests": heads + gets, "files_touched": files, "seconds_loopback": round(dt, 3),
           "first_row": [str(c) for c in rows[0]] if rows else None}
    print(json.dumps(rec))
    return rec


Q1COLS = "population_id, ac, an, lat, lon, radius_km, sampling_design, disease_ascertainment_excluded, cohort_id"
res = {"variant": V, "pos": P, "population": POP, "queries": []}
q = res["queries"]
for lay in ("P1_rg8192", "P1_rg32768", "P1_rg122880", "P1_rg1048576", "P5_rg122880"):
    u, nf = urls(lay)
    bins = 5_000_000 if lay.startswith("P5") else 1_000_000
    q.append(run(f"{lay} Q1 one variant, all pops (macro predicates)",
                 f"SELECT {Q1COLS} FROM read_parquet({u}, hive_partitioning=true) "
                 f"WHERE chrom='chr21' AND bin={P // bins} AND pos={P} AND variant_id='{V}'"))
    q.append(run(f"{lay} Q1* one variant, SELECT * (17 cols)",
                 f"SELECT * FROM read_parquet({u}, hive_partitioning=true) "
                 f"WHERE chrom='chr21' AND bin={P // bins} AND pos={P} AND variant_id='{V}'"))
    q.append(run(f"{lay} Q2 APP region, all pops",
                 f"SELECT variant_id, population_id, ac, an FROM read_parquet({u}, hive_partitioning=true) "
                 f"WHERE chrom='chr21' AND bin BETWEEN {APP[0] // bins} AND {APP[1] // bins} "
                 f"AND pos BETWEEN {APP[0]} AND {APP[1]}"))
    q.append(run(f"{lay} Q3 one population, every row of the sample",
                 f"SELECT variant_id, ac, an FROM read_parquet({u}, hive_partitioning=true) WHERE population_id='{POP}'"))
    q.append(run(f"{lay} Q3agg one population, count/sum only",
                 f"SELECT count(*), sum(ac), sum(an) FROM read_parquet({u}, hive_partitioning=true) WHERE population_id='{POP}'"))

u, nf = urls("P1d_rg122880")
q.append(run("P1d_rg122880 Q1 one variant, all 17 cols with source_record_id derived",
             f"SELECT *, 'gnomad-hgdp-1kg:' || variant_id || ':' || population_id AS source_record_id "
             f"FROM read_parquet({u}, hive_partitioning=true) WHERE chrom='chr21' AND bin={P // 1_000_000} AND pos={P} AND variant_id='{V}'"))
q.append(run("P1d_rg122880 Q3 one population", f"SELECT variant_id, ac, an FROM read_parquet({u}, hive_partitioning=true) WHERE population_id='{POP}'"))

u, nf = urls("NP")
q.append(run(f"NP Q3 one population ({nf} files listed)",
             f"SELECT pos, ref, alt, ac, an FROM read_parquet({u}, hive_partitioning=true) WHERE population_id='{POP}' AND chrom='chr21'"))
q.append(run(f"NP Q1 one variant via population copy ({nf} files listed)",
             f"SELECT population_id, ac, an FROM read_parquet({u}, hive_partitioning=true) WHERE chrom='chr21' AND pos={P} "
             f"AND ref='{V.split('-')[2]}' AND alt='{V.split('-')[3]}'"))

# genome-sized list: 3,102 one-Mb bins (symlinks), does DuckDB prune by path before any request?
gl = sorted(p for p in (L / "G1").rglob("*.parquet"))
gu = "[" + ",".join(f"'{B}/{p.relative_to(L)}'" for p in gl) + "]"
res["genome_list_files"] = len(gl)
q.append(run(f"G1 Q1 one variant, {len(gl)}-file list, hive predicates",
             f"SELECT {Q1COLS} FROM read_parquet({gu}, hive_partitioning=true) "
             f"WHERE chrom='chr21' AND bin={P // 1_000_000} AND pos={P} AND variant_id='{V}'"))
q.append(run(f"G1 Q2 APP region, {len(gl)}-file list, hive predicates",
             f"SELECT variant_id, population_id, ac, an FROM read_parquet({gu}, hive_partitioning=true) "
             f"WHERE chrom='chr21' AND bin BETWEEN {APP[0] // 1_000_000} AND {APP[1] // 1_000_000} AND pos BETWEEN {APP[0]} AND {APP[1]}"))
q.append(run(f"G1 Q1 via a view over the {len(gl)}-file list",
             f"SELECT {Q1COLS} FROM obs WHERE chrom='chr21' AND bin={P // 1_000_000} AND pos={P} AND variant_id='{V}'",
             setup=(f"CREATE VIEW obs AS SELECT * FROM read_parquet({gu}, hive_partitioning=true)",)))
# computed-URL macro: does a table macro accept a URL built from its argument?
try:
    q.append(run("macro computed URL Q1",
                 "SELECT population_id, ac, an FROM obs_variant('" + V + "')",
                 setup=(f"CREATE MACRO obs_variant(v) AS TABLE SELECT * FROM read_parquet("
                        f"'{B}/P1_rg122880/source=gnomad_hgdp_1kg/ingest_version={IV}/chrom=' || split_part(v, '-', 1) || "
                        f"'/bin=' || (CAST(split_part(v, '-', 2) AS BIGINT) // 1000000) || '/part-0.parquet') "
                        f"WHERE variant_id = v AND pos = CAST(split_part(v, '-', 2) AS BIGINT)",)))
except Exception as e:  # record, do not hide
    res["macro_computed_url_error"] = f"{type(e).__name__}: {e}"
    print("macro error:", res["macro_computed_url_error"])
# worst case: no partition predicate on the genome list (a user who forgets the macro)
q.append(run(f"G1 Q1 NO hive predicate, {len(gl)}-file list",
             f"SELECT {Q1COLS} FROM read_parquet({gu}, hive_partitioning=true) WHERE pos={P} AND variant_id='{V}'"))
json.dump(res, open(W / "out/query_results.json", "w"), indent=1)
