"""Build contract-shaped observation rows from the gnomAD v3.1.2 HGDP+TGP chr21 sample.

Input:  dl/sample.tsv  (bcftools query of chr21:25,000,001-27,000,000; per-group AC_/AN_ INFO)
        dl/meta.tsv    (gnomad.genomes.v3.1.2.hgdp_1kg_subset_sample_meta.tsv.bgz, decoded)
Output: out/rows.parquet (uncompressed-ish staging, DuckDB-written), out/rows_stats.json

Row rules (measurement only, mirrors genomeos/observations/sources/gnomad_hgdp_1kg.py):
- variants: FILTER == PASS and subset AC > 0 (polymorphic in the subset)
- one row per (variant, population group) with an > 0; cells with an == 0 or missing are
  counted and reported, never silently dropped from the accounting
- ac, an stored as counts (never ac/an)
- radius_km is a SYNTHETIC per-population placeholder (no local registry); lat/lon are the
  per-group means of hgdp_tgp_meta latitude/longitude
"""

import json
import re
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

W = Path(sys.argv[1])
d = pd.read_csv(W / "dl/sample.tsv", sep="\t", dtype={"chrom": str, "id": str, "ref": str, "alt": str, "filter": str}, na_values=["."], keep_default_na=False)
meta = pd.read_csv(W / "dl/meta.tsv", sep="\t")
m = pd.json_normalize(meta["hgdp_tgp_meta"].map(json.loads).tolist())
m = m[m["population"].notna()]
g = m.groupby(["gnomad_labeled_subpop", "population", "project"]).agg(lat=("latitude", "mean"), lon=("longitude", "mean")).reset_index()
assert g["gnomad_labeled_subpop"].is_unique


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.strip().lower()).strip("-")


g["population_id"] = [("hgdp-" if p == "HGDP" else "onekg-") + slug(x) for p, x in zip(g["project"], g["population"])]
g = g.sort_values("gnomad_labeled_subpop").reset_index(drop=True)
g["radius_km"] = [50.0 + float((i * 37) % 400) for i in range(len(g))]  # SYNTHETIC placeholder
pops = sorted(c[3:] for c in d.columns if c.startswith("AC_"))
assert pops == g["gnomad_labeled_subpop"].tolist(), "every INFO group must map to a population"

stats = {"records": int(len(d))}
keep = (d["filter"] == "PASS") & (d["AC"] > 0)
v = d[keep].reset_index(drop=True)
stats["variants_pass_ac_gt0"] = int(len(v))
stats["records_pass_ac0"] = int(((d["filter"] == "PASS") & (d["AC"] == 0)).sum())
stats["records_nonpass"] = int((d["filter"] != "PASS").sum())

ac = v[[f"AC_{p}" for p in pops]].to_numpy(float)
an = v[[f"AN_{p}" for p in pops]].to_numpy(float)
cell_ok = (~np.isnan(an)) & (an > 0)
stats["cells"] = int(ac.size)
stats["cells_an_zero_or_missing_excluded"] = int((~cell_ok).sum())
vi, pi = np.nonzero(cell_ok)
n = len(vi)
variant_id = (v["chrom"] + "-" + v["pos"].astype(str) + "-" + v["ref"] + "-" + v["alt"]).to_numpy()
rows = pd.DataFrame(
    {
        "variant_id": variant_id[vi],
        "rsid": v["id"].to_numpy()[vi],
        "population_id": g["population_id"].to_numpy()[pi],
        "lat": g["lat"].to_numpy()[pi],
        "lon": g["lon"].to_numpy()[pi],
        "radius_km": g["radius_km"].to_numpy()[pi],
        "ac": ac[vi, pi].astype(np.int64),
        "an": an[vi, pi].astype(np.int64),
        "source_record_id": [f"gnomad-hgdp-1kg:{a}:{b}" for a, b in zip(variant_id[vi], np.array(pops)[pi])],
        "source": "gnomad_hgdp_1kg",
        "assay": "genome",
        "date_lower": np.zeros(n, np.int64),
        "date_upper": np.zeros(n, np.int64),
        "sampling_design": "healthy_reference",
        "disease_ascertainment_excluded": np.ones(n, bool),
        "cohort_id": "gnomad-v4-hgdp-1kg",
        "ingest_version": "gnomad_hgdp_1kg-v3.1.2-probe-2026-10-19",
        # derived query columns (not in the 17-column contract): position for pruning
        "chrom": v["chrom"].to_numpy()[vi],
        "pos": v["pos"].to_numpy()[vi].astype(np.int64),
        "ref": v["ref"].to_numpy()[vi],
        "alt": v["alt"].to_numpy()[vi],
    }
)
rows.loc[rows["rsid"].isna(), "rsid"] = None
assert (rows["ac"] <= rows["an"]).all() and (rows["an"] > 0).all() and (rows["ac"] >= 0).all()
assert rows["source_record_id"].is_unique
stats["rows"] = int(n)
stats["rows_ac_gt0"] = int((rows["ac"] > 0).sum())
stats["populations"] = len(pops)
stats["variants_overall_af_ge_1pct"] = int(((v["AC"] / v["AN"]) >= 0.01).sum())
stats["rsid_null_frac"] = float(rows["rsid"].isna().mean())
stats["mean_variant_id_len"] = float(pd.Series(variant_id).str.len().mean())
stats["mean_source_record_id_len"] = float(rows["source_record_id"].str.len().mean())
g.to_csv(W / "out/populations_used.tsv", sep="\t", index=False)
con = duckdb.connect()
con.register("r", rows)
con.execute(f"COPY (SELECT * FROM r) TO '{W}/out/rows.parquet' (FORMAT parquet, COMPRESSION zstd)")
json.dump(stats, open(W / "out/rows_stats.json", "w"), indent=1)
print(json.dumps(stats, indent=1))
