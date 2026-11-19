"""Design §3.1 path at whole-genome file counts: a views-only atlas.duckdb attached over HTTP.

Builds G_NP (population copy, 80 pop ids x 24 chroms, symlinks; real data only for the 78
sample groups on chr21), writes out/layouts/catalog/atlas.duckdb with views over the
3,102-file position list (G1) and the population list, plus a computed-URL macro, then
attaches it remotely and measures bytes/requests per query.

Usage: python -I catalog_probe.py <workdir> <port>
"""

import json
import os
import shutil
import sys
import time
from pathlib import Path

import duckdb

W = Path(sys.argv[1])
PORT = int(sys.argv[2])
B = f"http://127.0.0.1:{PORT}"
L = W / "out/layouts"
LOG = W / "out/req.log"
IV = "gnomad_hgdp_1kg-v3.1.2-probe-2026-10-19"
CHROMS = [f"chr{i}" for i in range(1, 23)] + ["chrX", "chrY"]
V, P = "chr21-25950001-C-T", 25950001
POP = "onekg-yri"

np_src = L / "NP" / "source=gnomad_hgdp_1kg" / f"ingest_version={IV}"
real = sorted(p.name.split("=", 1)[1] for p in np_src.iterdir())
pops = real + ["synthetic-pop-79", "synthetic-pop-80"]
g = L / "G_NP"
if g.exists():
    shutil.rmtree(g)
gb = g / "source=gnomad_hgdp_1kg" / f"ingest_version={IV}"
for pid in pops:
    for c in CHROMS:
        d = gb / f"population_id={pid}" / f"chrom={c}"
        d.mkdir(parents=True)
        tgt = np_src / f"population_id={pid if pid in real else real[0]}" / "chrom=chr21" / "part-0.parquet"
        os.symlink(tgt, d / "part-0.parquet")
np_urls = sorted(f"{B}/{p.relative_to(L)}" for p in g.rglob("*.parquet"))
pos_urls = sorted(f"{B}/{p.relative_to(L)}" for p in (L / "G1").rglob("*.parquet"))

cat = L / "catalog"
if cat.exists():
    shutil.rmtree(cat)
cat.mkdir()
c = duckdb.connect(str(cat / "atlas.duckdb"), config={"storage_compatibility_version": "v1.2.0"})
c.execute("CREATE SCHEMA measured")
lst = lambda us: "[" + ",".join(f"'{u}'" for u in us) + "]"  # noqa: E731
c.execute(f"CREATE VIEW measured.allele_obs_by_position AS SELECT * FROM read_parquet({lst(pos_urls)}, "
          "hive_partitioning=true, hive_types={'chrom': VARCHAR, 'bin': BIGINT})")
c.execute(f"CREATE VIEW measured.allele_counts_by_population AS SELECT * FROM read_parquet({lst(np_urls)}, "
          "hive_partitioning=true, hive_types={'population_id': VARCHAR, 'chrom': VARCHAR})")
c.execute(
    "CREATE MACRO measured.variant(v) AS TABLE SELECT * FROM read_parquet("
    f"'{B}/G1/source=gnomad_hgdp_1kg/ingest_version={IV}/chrom=' || split_part(v, '-', 1) || "
    "'/bin=' || (CAST(split_part(v, '-', 2) AS BIGINT) // 1000000) || '/part-0.parquet') "
    "WHERE variant_id = v AND pos = CAST(split_part(v, '-', 2) AS BIGINT)"
)
c.close()
res = {"catalog_bytes": (cat / "atlas.duckdb").stat().st_size, "pos_files": len(pos_urls), "pop_files": len(np_urls),
       "catalog_sql_url_chars": sum(len(u) + 3 for u in pos_urls + np_urls), "queries": []}


def run(label, sql):
    LOG.write_text("")
    con = duckdb.connect()
    con.execute("LOAD httpfs")
    for s in ("SET enable_http_metadata_cache=false", "SET enable_external_file_cache=false", "SET parquet_metadata_cache=false"):
        con.execute(s)
    t = time.time()
    con.execute(f"ATTACH '{B}/catalog/atlas.duckdb' AS atlas (READ_ONLY)")
    time.sleep(0.2)
    attach_lines = [x.split() for x in LOG.read_text().splitlines() if x.strip()]
    rows = con.execute(sql).fetchall() if sql else []
    dt = time.time() - t
    con.close()
    time.sleep(0.4)
    lines = [x.split() for x in LOG.read_text().splitlines() if x.strip()]
    rec = {"label": label, "rows": len(rows), "bytes_total": sum(int(x[3]) for x in lines),
           "requests_total": len(lines), "attach_bytes": sum(int(x[3]) for x in attach_lines),
           "attach_requests": len(attach_lines), "parquet_files_touched": len({x[1] for x in lines if x[1].endswith('.parquet')}),
           "seconds_loopback": round(dt, 3)}
    print(json.dumps(rec))
    res["queries"].append(rec)


run("attach only", None)
run("Q1 via view (hive predicates)", f"SELECT population_id, ac, an FROM atlas.measured.allele_obs_by_position "
    f"WHERE chrom='chr21' AND bin={P // 1_000_000} AND pos={P} AND variant_id='{V}'")
run("Q1 via computed-URL macro", f"SELECT population_id, ac, an FROM atlas.measured.variant('{V}')")
run("Q2 APP via view", "SELECT variant_id, population_id, ac, an FROM atlas.measured.allele_obs_by_position "
    "WHERE chrom='chr21' AND bin BETWEEN 25 AND 26 AND pos BETWEEN 25880535 AND 26171128")
run("Q3 one population, chr21 file of the population copy", f"SELECT pos, ref, alt, ac, an FROM atlas.measured.allele_counts_by_population "
    f"WHERE population_id='{POP}' AND chrom='chr21'")
json.dump(res, open(W / "out/catalog_results.json", "w"), indent=1)
print({k: v for k, v in res.items() if k != "queries"})
