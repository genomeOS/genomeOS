"""Measure a long-format per-population count table built from gnomAD v3.1.2 HGDP+1KG INFO.

Usage: python -I measure_long.py <info.tsv> <popnames.txt> <outdir>

Reads the bcftools query output (CHROM POS REF ALT FILTER AC AN, then AC_pop AN_pop per pop),
writes long-format Parquet under several encodings and prints sizes and per-row bytes.
Counts only: ac and an, never a frequency column.
"""

import os
import sys

import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

info_path, pop_path, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
pops = [line.strip() for line in open(pop_path) if line.strip()]
cols = ["chrom", "pos", "ref", "alt", "filter", "AC", "AN"]
for p in pops:
    cols += [f"AC_{p}", f"AN_{p}"]
raw = pd.read_csv(info_path, sep="\t", header=None, names=cols, dtype=str)
assert raw.shape[1] == len(cols)
n_sites = len(raw)
multi = raw["alt"].str.contains(",").sum()
print("sites", n_sites, "multiallelic_records", int(multi))

rows = []
for p in pops:
    part = pd.DataFrame(
        {
            "variant_id": raw["chrom"] + "-" + raw["pos"] + "-" + raw["ref"] + "-" + raw["alt"],
            "population": p,
            "filter": raw["filter"],
            "ac": raw[f"AC_{p}"],
            "an": raw[f"AN_{p}"],
        }
    )
    rows.append(part)
long = pd.concat(rows, ignore_index=True)
missing_ac = (long["ac"] == ".").sum()
missing_an = (long["an"] == ".").sum()
print("long_rows", len(long), "missing_ac", int(missing_ac), "missing_an", int(missing_an))
long = long[(long["ac"] != ".") & (long["an"] != ".")].copy()
long["ac"] = long["ac"].astype("int32")
long["an"] = long["an"].astype("int32")
print("rows ac==0", int((long["ac"] == 0).sum()), "of", len(long),
      f"({(long['ac'] == 0).mean():.3f})")
print("rows an==0", int((long["an"] == 0).sum()))
print("an per pop: min", int(long["an"].min()), "median", int(long["an"].median()),
      "max", int(long["an"].max()))

# Sum of per-pop AN vs total AN in INFO (which sample set do the per-pop counts use?)
an_total = raw["AN"].astype(int)
an_sum = sum(raw[f"AN_{p}"].replace(".", "0").astype(int) for p in pops)
print("INFO AN median", int(an_total.median()), "sum per-pop AN median", int(an_sum.median()),
      "max diff", int((an_total - an_sum).abs().max()))
ac_total = raw["AC"].replace(".", "0").astype(int)
ac_sum = sum(raw[f"AC_{p}"].replace(".", "0").astype(int) for p in pops)
print("AC total == sum per-pop AC on", int((ac_total == ac_sum).sum()), "of", n_sites)

long = long.sort_values(["variant_id", "population"], kind="stable").reset_index(drop=True)
table = pa.Table.from_pandas(long[["variant_id", "population", "ac", "an"]], preserve_index=False)
nonzero = pa.Table.from_pandas(
    long.loc[long["ac"] > 0, ["variant_id", "population", "ac", "an"]], preserve_index=False
)

def write(tbl, name, **kw):
    path = os.path.join(outdir, name)
    pq.write_table(tbl, path, **kw)
    size = os.path.getsize(path)
    print(f"{name}: {size} B, {tbl.num_rows} rows, {size / tbl.num_rows:.2f} B/row")
    return size

write(table, "long_zstd.parquet", compression="zstd", row_group_size=8192)
write(table, "long_snappy.parquet", compression="snappy", row_group_size=8192)
write(nonzero, "long_nonzero_zstd.parquet", compression="zstd", row_group_size=8192)

# Wide: one row per variant, ac/an per population as columns (still counts, not frequencies)
wide = raw[["chrom", "pos", "ref", "alt"]].copy()
wide["variant_id"] = raw["chrom"] + "-" + raw["pos"] + "-" + raw["ref"] + "-" + raw["alt"]
for p in pops:
    wide[f"ac_{p}"] = raw[f"AC_{p}"].replace(".", "-1").astype("int32")
    wide[f"an_{p}"] = raw[f"AN_{p}"].replace(".", "-1").astype("int32")
wide_tbl = pa.Table.from_pandas(wide.drop(columns=["chrom", "pos", "ref", "alt"]), preserve_index=False)
write(wide_tbl, "wide_zstd.parquet", compression="zstd", row_group_size=8192)

con = duckdb.connect()
print("duckdb check rows", con.execute(
    f"select count(*) from read_parquet('{os.path.join(outdir, 'long_zstd.parquet')}')").fetchone())
