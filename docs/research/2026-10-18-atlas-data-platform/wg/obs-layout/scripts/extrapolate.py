"""Whole-genome extrapolation from the measured sample (arithmetic printed, inputs cited).

Usage: python -I extrapolate.py <workdir>
"""

import json
import sys
from pathlib import Path

import duckdb

W = Path(sys.argv[1])
s1 = json.load(open(W / "out/size_results.json"))
s2 = json.load(open(W / "out/size_results2.json"))
s3 = json.load(open(W / "out/size_results3.json"))
st = json.load(open(W / "out/rows_stats.json"))
q = {r["label"]: r for r in json.load(open(W / "out/query_results.json"))["queries"]}
GiB = 2**30

VARIANTS_GENOME = 153e6  # Koenig et al., Genome Research 34:796 (2024): "more than 153 million"
POPS = 80
ROWS = VARIANTS_GENOME * POPS
rows_s = st["rows"]
var_s = st["variants_pass_ac_gt0"]
scale_rows = ROWS / rows_s
scale_var = VARIANTS_GENOME / var_s
print(f"genome rows R = 153e6 x 80 = {ROWS:.4g}; sample rows = {rows_s:,}; scale = R / sample = {scale_rows:,.1f}")
print(f"sample rows/variant = {rows_s / var_s:.2f} of 78 groups ({st['cells_an_zero_or_missing_excluded']:,} an=0/missing cells, "
      f"{st['cells_an_zero_or_missing_excluded'] / st['cells']:.2%})")
print(f"variant scale (per population) = 153e6 / {var_s:,} = {scale_var:,.1f}")


def gb(bpr):
    return bpr * ROWS


lay = {
    "A 17 contract cols + pos, pos-major, rg 122,880 (DuckDB)": s1["contract17+pos_posmajor_rg122880"]["bytes_per_row"],
    "A' same, rg 8,192 (design §2.5 default)": s1["contract17_posmajor_rg8192"]["bytes_per_row"],
    "B 16 cols + pos, source_record_id derived in view": s2["c16(no srid)+pos_posmajor_rg122880"]["bytes_per_row"],
    "C 17 cols + pos, srid DELTA_BYTE_ARRAY (pyarrow)": s3["pyarrow_c17+pos_posmajor_rg122880_srid_DELTA_BYTE_ARRAY"]["bytes_per_row"],
    "D population-major, all 17 cols + pos": s1["contract17+pos_popmajor_rg122880"]["bytes_per_row"],
    "N narrow population copy (pos, ref, alt, ac, an)": s3["narrow_popmajor_rg122880(population_id,pos,ref,alt,ac,an)"]["bytes_per_row"],
    "REF sparse ac>0 rows only (not proposed)": None,
}
print("\nSIZE: bytes/row x R")
out = {}
for k, b in lay.items():
    if b is None:
        sp = s1["REFERENCE_sparse_ac_gt0_contract17+pos_posmajor_rg122880"]
        frac = st["rows_ac_gt0"] / rows_s
        tot = sp["bytes_per_row"] * frac * ROWS
        print(f"  {k}: {sp['bytes_per_row']:.3f} B/row x ({frac:.4f} x R = {frac * ROWS:.3g} rows) = {tot / 1e9:.1f} GB")
        out[k] = tot
        continue
    print(f"  {k}: {b:.3f} B/row x {ROWS:.4g} = {gb(b) / 1e9:.1f} GB ({gb(b) / GiB:.1f} GiB)")
    out[k] = gb(b)
for n in (1e9,):
    print(f"  at 1e9 rows: A = {lay['A 17 contract cols + pos, pos-major, rg 122,880 (DuckDB)'] * n / 1e9:.2f} GB; B = {lay['B 16 cols + pos, source_record_id derived in view'] * n / 1e9:.2f} GB")
af = st["variants_overall_af_ge_1pct"] / var_s
print(f"  common-variant scope (subset AF >= 1%: {af:.3f} of sample variants) -> {af * ROWS:.3g} rows")

# bins
mb_rows = rows_s / 2.0  # sample spans 2 Mb
print(f"\nBINS: sample density {mb_rows:,.0f} rows/Mb (chr21 25-27 Mb)")
for bmb in (1, 5):
    rows_bin = mb_rows * bmb
    for k in ("A 17 contract cols + pos, pos-major, rg 122,880 (DuckDB)", "B 16 cols + pos, source_record_id derived in view"):
        print(f"  {bmb} Mb bin, {k[:2]}: {rows_bin:,.0f} rows x {lay[k]:.3f} = {rows_bin * lay[k] / 1e6:.1f} MB/file; row groups = {rows_bin / 122880:.0f}")
print("  files per ingest: 1 Mb bins = 3,102 (GRCh38 chr1-22,X,Y); population copy = 80 x 24 = 1,920")

# BigQuery logical bytes per row (STRING 2 + UTF-8; INT64/FLOAT64 8; BOOL 1; NULL 0)
con = duckdb.connect()
r = con.execute(f"""SELECT
  avg(2 + strlen(variant_id)), avg(CASE WHEN rsid IS NULL THEN 0 ELSE 2 + strlen(rsid) END), avg(2 + strlen(population_id)),
  avg(2 + strlen(source_record_id)), avg(2 + strlen(source)), avg(2 + strlen(assay)), avg(2 + strlen(sampling_design)),
  avg(2 + strlen(cohort_id)), avg(2 + strlen(ingest_version))
  FROM read_parquet('{W}/out/rows.parquet')""").fetchone()
names = ["variant_id", "rsid", "population_id", "source_record_id", "source", "assay", "sampling_design", "cohort_id", "ingest_version"]
lb = dict(zip(names, r))
lb.update({"lat": 8, "lon": 8, "radius_km": 8, "ac": 8, "an": 8, "date_lower": 8, "date_upper": 8, "disease_ascertainment_excluded": 1, "pos": 8})
full = sum(lb.values())
print("\nBIGQUERY logical bytes/row:", {k: round(v, 1) for k, v in lb.items()}, f"total {full:.1f}")
print(f"  full table logical = {full:.1f} x {ROWS:.4g} = {full * ROWS / 1e12:.2f} TB = {full * ROWS / 2**40:.2f} TiB")
for label, rate in (("active logical $0.000031507/GiB-h", 0.000031507), ("long-term logical $0.000021918/GiB-h", 0.000021918)):
    print(f"  storage {label}: {full * ROWS / GiB:,.0f} GiB x {rate} x 730 h = ${full * ROWS / GiB * rate * 730:,.0f}/month")
for nm, b in (("A", lay["A 17 contract cols + pos, pos-major, rg 122,880 (DuckDB)"]), ("B", lay["B 16 cols + pos, source_record_id derived in view"])):
    print(f"  IF physical bytes ~ Parquet {nm} ({b * ROWS / GiB:.0f} GiB; inference): active physical $0.000054795/GiB-h x 730 = ${b * ROWS / GiB * 0.000054795 * 730:.2f}/month + time travel")
scan_cols = lb["variant_id"] + lb["population_id"] + lb["ac"] + lb["an"]
print(f"  cross-population scan (variant_id, population_id, ac, an) = {scan_cols:.1f} B x R = {scan_cols * ROWS / 2**40:.3f} TiB billed "
      f"-> ${max(0, scan_cols * ROWS / 2**40) * 6.25:.2f} at $6.25/TiB once the free TiB is used")
pop_rows = VARIANTS_GENOME
print(f"  one population, clustered on population_id (pruning assumed, inference): {scan_cols:.1f} x 153e6 = {scan_cols * pop_rows / 1e9:.1f} GB "
      f"-> {2**40 / (scan_cols * pop_rows):.0f} such queries in the free TiB")

# query extrapolation
print("\nQUERIES (measured on sample; scaled)")
a1 = q["P1_rg122880 Q1 one variant, all pops (macro predicates)"]
a2 = q["P1_rg122880 Q2 APP region, all pops"]
a3 = q["P1_rg122880 Q3 one population, every row of the sample"]
a3g = q["P1_rg122880 Q3agg one population, count/sum only"]
a3m = q["P1_rg1048576 Q3 one population, every row of the sample"]
n3 = q["NP Q3 one population (78 files listed)"]
print(f"  Q1 one variant: {a1['bytes']:,} B, {a1['requests']} requests (size-independent: one bin file)")
print(f"  Q2 APP 290.6 kb: {a2['bytes']:,} B, {a2['requests']} requests")
print(f"  Q3 one population on position table: {a3['bytes']:,} B x {scale_rows:,.0f} = {a3['bytes'] * scale_rows / 1e9:.2f} GB; "
      f"{a3['requests']} req x {scale_rows:,.0f} = {a3['requests'] * scale_rows:,.0f} requests")
print(f"     (rg 1,048,576: {a3m['bytes'] * scale_rows / 1e9:.2f} GB, {a3m['requests'] * scale_rows:,.0f} requests)")
print(f"     count/sum only: {a3g['bytes'] * scale_rows / 1e9:.2f} GB")
np_file = 22540475 / 78
print(f"  Q3 on population copy: per-population sample file {np_file:,.0f} B x {scale_var:,.0f} = {np_file * scale_var / 1e9:.2f} GB "
      f"(measured query on sample read {n3['bytes']:,} B in {n3['requests']} requests incl. first-file bind)")
eg = 0.12
ops = 0.0004 / 1000
for label, b, rq in (("Q1", a1["bytes"], a1["requests"]), ("Q2", a2["bytes"], a2["requests"]),
                     ("Q3 position table", a3["bytes"] * scale_rows, a3["requests"] * scale_rows),
                     ("Q3 population copy", np_file * scale_var, 24 * 3 + (VARIANTS_GENOME / 122880) * 5)):
    print(f"  cost to us {label}: {b / GiB:.4g} GiB x ${eg} + {rq:,.0f} x ${ops:.7f} = ${b / GiB * eg + rq * ops:.4f}")
print(f"  kill switch $300 ~ 2,780 GB: Q3-position-table pulls per month = {2780e9 / (a3['bytes'] * scale_rows):,.0f}; "
      f"population-copy pulls = {2780e9 / (np_file * scale_var):,.0f}; Q1 lookups = {2780e9 / a1['bytes']:,.0f}")
for mbps in (100, 1000):
    bps = mbps * 1e6 / 8
    print(f"  transfer time at {mbps} Mbit/s (bandwidth only): Q3 position {a3['bytes'] * scale_rows / bps / 60:.1f} min; "
          f"population copy {np_file * scale_var / bps:.0f} s; full table A {out['A 17 contract cols + pos, pos-major, rg 122,880 (DuckDB)'] / bps / 60:.0f} min; "
          f"B {out['B 16 cols + pos, source_record_id derived in view'] / bps / 60:.0f} min")
for nm in ("A 17 contract cols + pos, pos-major, rg 122,880 (DuckDB)", "B 16 cols + pos, source_record_id derived in view", "N narrow population copy (pos, ref, alt, ac, an)"):
    print(f"  bulk pull of {nm[:1]} from GCS: {out[nm] / GiB:.1f} GiB x $0.12 = ${out[nm] / GiB * 0.12:.2f}; vs release guard 2 GiB")
