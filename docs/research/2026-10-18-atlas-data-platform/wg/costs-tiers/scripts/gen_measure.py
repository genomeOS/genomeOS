"""Measure bytes/row of a whole-genome observation table under several Parquet layouts.

Synthetic but shaped like gnomAD HGDP+1KG long-format rows (OBSERVATIONS_SCHEMA, 17 columns):
- variants: a contiguous stretch of chr1 from 100 Mb, geometric gaps with mean 20 bp
  (153.9M variants / ~3.1 Gb), 85% SNVs, 15% indels; 75% carry an rsid.
- populations: 80; AN per population from the 73 real HGDP/1KG AN values the gnomAD API
  returned for chr11-5227002-T-A, plus 7 synthetic HGDP-sized ones.
- AC: total AC per variant from the neutral SFS P(k) ~ 1/k over 1..8187 (assumption; real data
  are rarer, i.e. more zeros, i.e. smaller), spread over populations by a Dirichlet-multinomial
  (alpha 0.5) weighted by AN, clipped to AN.
- AN per row: 2n exactly with p=0.85, else 2n - 2*Poisson(1).
Every count is an integer ac/an pair; no frequency column is ever written.
SEED = 42.
"""

import json
import os
import sys
import time

import duckdb
import numpy as np
import pyarrow as pa

SEED = 42
rng = np.random.default_rng(SEED)
POPS_JSON, OUT, N_VAR = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.makedirs(OUT, exist_ok=True)

pops = json.load(open(POPS_JSON))
pops = [p for p in pops if p["id"] not in ("hgdp:XX", "hgdp:XY", "1kg:XX", "1kg:XY")]
labels = [p["id"].split(":")[1] for p in pops]
an_base = [p["an"] for p in pops]
for i in range(80 - len(pops)):
    labels.append(f"extra{i}")
    an_base.append(int(rng.integers(10, 60)) * 2 // 2 * 2)
P = len(labels)
assert P == 80, P
an_base = np.array(an_base, dtype=np.int64)
pop_ids = [("hgdp-" if i < 47 else "1kg-") + lab for i, lab in enumerate(labels)]
lat = rng.uniform(-40, 65, P).round(4)
lon = rng.uniform(-120, 150, P).round(4)
rad = rng.choice([2.5, 5.0, 25.0, 50.0, 75.0, 150.0], P)

# variants
gaps = rng.geometric(1 / 20, N_VAR)
pos = 100_000_000 + np.cumsum(gaps)
bases = np.array(list("ACGT"))
is_indel = rng.random(N_VAR) < 0.15
ref = bases[rng.integers(0, 4, N_VAR)].astype(object)
alt = bases[rng.integers(0, 4, N_VAR)].astype(object)
for i in np.nonzero(is_indel)[0]:
    L = int(rng.integers(1, 10))
    ins = "".join(bases[rng.integers(0, 4, L)])
    if rng.random() < 0.5:
        alt[i] = ref[i] + ins
    else:
        ref[i] = ref[i] + ins
same = (~is_indel) & (ref == alt)
alt[same] = np.where(ref[same] == "A", "C", "A")
vid = [f"chr1-{p}-{r}-{a}" for p, r, a in zip(pos, ref, alt)]
has_rs = rng.random(N_VAR) < 0.75
rsid = [f"rs{int(x)}" if h else None for x, h in zip(rng.integers(1_000_000, 2_000_000_000, N_VAR), has_rs)]

# counts
an = np.repeat(an_base[None, :], N_VAR, axis=0)
miss = rng.random((N_VAR, P)) >= 0.85
an = an - miss * 2 * rng.poisson(1.0, (N_VAR, P))
an = np.maximum(an, 2)
twoN = 8188
k = np.arange(1, twoN)
pk = 1.0 / k
pk /= pk.sum()
tot = rng.choice(k, N_VAR, p=pk)
ac = np.zeros((N_VAR, P), dtype=np.int64)
for i in range(N_VAR):
    w = rng.gamma(0.5, 1.0, P) * an[i]
    w /= w.sum()
    ac[i] = rng.multinomial(tot[i], w)
ac = np.minimum(ac, an)
assert (ac <= an).all() and (an > 0).all()
print("zero-ac fraction", float((ac == 0).mean()))

con = duckdb.connect()
con.execute("SET threads=4")
var_t = pa.table({"vi": np.arange(N_VAR), "variant_id": vid, "rsid": pa.array(rsid, pa.string())})
pop_t = pa.table({"pi": np.arange(P), "population_id": pop_ids, "pop_label": labels,
                  "lat": lat, "lon": lon, "radius_km": rad})
cnt_t = pa.table({"vi": np.repeat(np.arange(N_VAR), P), "pi": np.tile(np.arange(P), N_VAR),
                  "ac": ac.ravel(), "an": an.ravel()})
con.register("var_t", var_t); con.register("pop_t", pop_t); con.register("cnt_t", cnt_t)
con.execute("""
CREATE TABLE obs AS
SELECT v.variant_id, v.rsid, p.population_id, p.lat, p.lon, p.radius_km,
       c.ac, c.an,
       'gnomad-hgdp-1kg:' || v.variant_id || ':' || p.pop_label AS source_record_id,
       'gnomad_hgdp_1kg' AS source, 'genome' AS assay,
       0::BIGINT AS date_lower, 0::BIGINT AS date_upper,
       'healthy_reference' AS sampling_design, TRUE AS disease_ascertainment_excluded,
       'gnomad-v4-hgdp-1kg' AS cohort_id, 'gnomad-hgdp-1kg-v3.1.2' AS ingest_version
FROM cnt_t c JOIN var_t v USING (vi) JOIN pop_t p USING (pi)
ORDER BY c.vi, c.pi
""")
n = con.execute("SELECT count(*) FROM obs").fetchone()[0]
print("rows", n)

# BigQuery logical bytes: STRING = 2 + UTF-8 bytes, INT64/FLOAT64 = 8, BOOL = 1, NULL = 0
logical = con.execute("""
SELECT sum(2+strlen(variant_id)) + sum(CASE WHEN rsid IS NULL THEN 0 ELSE 2+strlen(rsid) END)
     + sum(2+strlen(population_id)) + 8*3*count(*) + 8*2*count(*)
     + sum(2+strlen(source_record_id)) + sum(2+strlen(source)) + sum(2+strlen(assay))
     + 8*2*count(*) + sum(2+strlen(sampling_design)) + count(*) + sum(2+strlen(cohort_id))
     + sum(2+strlen(ingest_version)),
       sum(2+strlen(variant_id)) + sum(2+strlen(population_id)) + 16*count(*),
       sum(2+strlen(source_record_id))
FROM obs""").fetchone()
print("bq_logical_bytes_per_row_all17", logical[0] / n)
print("bq_logical_bytes_per_row_vid_pop_ac_an", logical[1] / n)
print("bq_logical_bytes_per_row_source_record_id", logical[2] / n)

ALL = ("variant_id, rsid, population_id, lat, lon, radius_km, ac, an, source_record_id, source, "
       "assay, date_lower, date_upper, sampling_design, disease_ascertainment_excluded, cohort_id, "
       "ingest_version")
NO_SRID = ALL.replace("source_record_id, ", "")
SLIM = "variant_id, rsid, population_id, ac, an"
layouts = {
    "L1_all17_zstd_rg8192": (ALL, "COMPRESSION zstd, ROW_GROUP_SIZE 8192"),
    "L1v2_all17_zstd_rg8192_parquetv2": (ALL, "COMPRESSION zstd, ROW_GROUP_SIZE 8192, PARQUET_VERSION V2"),
    "L2_all17_zstd_rg122880": (ALL, "COMPRESSION zstd, ROW_GROUP_SIZE 122880"),
    "L1s_all17_snappy_rg8192": (ALL, "COMPRESSION snappy, ROW_GROUP_SIZE 8192"),
    "L3_no_srid_zstd_rg8192": (NO_SRID, "COMPRESSION zstd, ROW_GROUP_SIZE 8192"),
    "L4_slim5_zstd_rg8192": (SLIM, "COMPRESSION zstd, ROW_GROUP_SIZE 8192"),
}
res = {}
for name, (cols, opts) in layouts.items():
    fp = f"{OUT}/{name}.parquet"
    t0 = time.time()
    con.execute(f"COPY (SELECT {cols} FROM obs) TO '{fp}' (FORMAT parquet, {opts})")
    res[name] = os.path.getsize(fp)
    print(f"{name}: {res[name]} B, {res[name]/n:.3f} B/row, {time.time()-t0:.1f}s")

# wide: one row per variant, ac/an as fixed-order integer lists (population order in a sidecar)
fp = f"{OUT}/L5_wide_lists_zstd.parquet"
con.execute(f"""COPY (SELECT variant_id, any_value(rsid) AS rsid,
    list(ac ORDER BY population_id) AS ac, list(an ORDER BY population_id) AS an
    FROM obs GROUP BY variant_id ORDER BY min(rowid)) TO '{fp}'
    (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 8192)""")
res["L5_wide_lists_zstd"] = os.path.getsize(fp)
print(f"L5_wide_lists_zstd: {res['L5_wide_lists_zstd']} B, {res['L5_wide_lists_zstd']/n:.3f} B/obs-row")

# per-column compressed bytes for L1
import pyarrow.parquet as pq
md = pq.ParquetFile(f"{OUT}/L1_all17_zstd_rg8192.parquet").metadata
colb = {}
for rg in range(md.num_row_groups):
    r = md.row_group(rg)
    for c in range(r.num_columns):
        cc = r.column(c)
        colb[cc.path_in_schema] = colb.get(cc.path_in_schema, 0) + cc.total_compressed_size
print("L1 footer bytes", md.serialized_size, "row groups", md.num_row_groups)
for k_, v_ in sorted(colb.items(), key=lambda x: -x[1]):
    print(f"  {k_}: {v_/n:.3f} B/row")
json.dump({"rows": n, "sizes": res, "logical": [x / n for x in logical], "colb_per_row": {k_: v_ / n for k_, v_ in colb.items()},
           "l1_footer": md.serialized_size, "l1_row_groups": md.num_row_groups,
           "zero_ac_fraction": float((ac == 0).mean())}, open(f"{OUT}/measure.json", "w"), indent=1)
