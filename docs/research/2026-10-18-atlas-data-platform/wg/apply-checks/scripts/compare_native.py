"""Compare the Python recount's per-population ac/an with the native bcftools +setGT/+fill-tags path.

Usage: python -I compare_native.py <recount.parquet> <native.tsv> <groups.txt>
Counts only; prints how many (variant, population) cells agree on both ac and an.
"""
import re
import sys

import duckdb
import pandas as pd

rows = duckdb.sql(f"SELECT variant_id, source_label, ac, an FROM read_parquet('{sys.argv[1]}')").df()
groups = sorted({line.split('\t')[1].strip() for line in open(sys.argv[3]) if line.strip()})
cols = ["chrom", "pos", "ref", "alt"]
for g in groups:
    cols += [f"AC_{g}", f"AN_{g}"]
nat = pd.read_csv(sys.argv[2], sep="\t", header=None, names=cols, dtype=str)
nat["variant_id"] = nat["chrom"] + "-" + nat["pos"] + "-" + nat["ref"] + "-" + nat["alt"]
long = []
for g in groups:
    long.append(pd.DataFrame({"variant_id": nat["variant_id"], "g": g,
                              "ac_n": nat[f"AC_{g}"].replace(".", "0").astype(int),
                              "an_n": nat[f"AN_{g}"].replace(".", "0").astype(int)}))
long = pd.concat(long)
rows["g"] = rows["source_label"].map(lambda s: re.sub(r"[^A-Za-z0-9]", "_", s))
m = rows.merge(long, on=["variant_id", "g"], how="left", validate="one_to_one")
assert m["ac_n"].notna().all(), "every written cell must exist in the native output"
same = (m["ac"] == m["ac_n"]) & (m["an"] == m["an_n"])
print(f"cells {len(m)}; identical ac and an {int(same.sum())}; differ {int((~same).sum())}")
d = m[~same]
if len(d):
    print("an differences (python - native):", (d["an"] - d["an_n"]).value_counts().head().to_dict())
    print("ac differences (python - native):", (d["ac"] - d["ac_n"]).value_counts().head().to_dict())
