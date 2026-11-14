"""Rows from gnomAD's INFO AC_/AN_ (78 labels) for a window, shaped like recount.py's output.

Usage: python -I info_rows.py <info.tsv> <popnames.txt> <populations_used.tsv> <out.parquet>
info.tsv columns: CHROM POS REF ALT FILTER AC AN, then AC_<pop> AN_<pop> per popnames line.
Same site rule as the earlier probes (PASS, subset AC > 0); cells with AN = 0 or missing not written.
Used only to separate the recount's effect on bytes per row from the window's size.
"""
import sys

import duckdb
import numpy as np
import pandas as pd

info_path, pop_path, pops_used, out = sys.argv[1:5]
pops = [x.strip() for x in open(pop_path) if x.strip()]
cols = ["chrom", "pos", "ref", "alt", "filter", "AC", "AN"] + [f"{k}_{p}" for p in pops for k in ("AC", "AN")]
d = pd.read_csv(info_path, sep="\t", header=None, names=cols, dtype=str, na_values=["."], keep_default_na=False)
d = d[(d["filter"] == "PASS") & (d["AC"].astype(float) > 0)].reset_index(drop=True)
g = pd.read_csv(pops_used, sep="\t").set_index("gnomad_labeled_subpop").loc[pops].reset_index()
ac = d[[f"AC_{p}" for p in pops]].to_numpy(float)
an = d[[f"AN_{p}" for p in pops]].to_numpy(float)
vi, pi = np.nonzero(~np.isnan(an) & (an > 0))
vid = (d["chrom"] + "-" + d["pos"] + "-" + d["ref"] + "-" + d["alt"]).to_numpy()
n = len(vi)
rows = pd.DataFrame({
    "variant_id": vid[vi], "rsid": None, "population_id": g["population_id"].to_numpy()[pi],
    "lat": g["lat"].to_numpy()[pi], "lon": g["lon"].to_numpy()[pi], "radius_km": g["radius_km"].to_numpy()[pi],
    "ac": ac[vi, pi].astype(np.int64), "an": an[vi, pi].astype(np.int64),
    "source": "gnomad_hgdp_1kg", "assay": "genome", "date_lower": np.zeros(n, np.int64),
    "date_upper": np.zeros(n, np.int64), "sampling_design": "healthy_reference",
    "disease_ascertainment_excluded": np.ones(n, bool), "cohort_id": "gnomad-v3.1.2-hgdp-1kg-probe",
    "ingest_version": "gnomad_hgdp_1kg-v3.1.2-probe-2026-10-19",
    "pos": d["pos"].astype(np.int64).to_numpy()[vi], "ref": d["ref"].to_numpy()[vi], "alt": d["alt"].to_numpy()[vi],
    "source_label": g["population"].to_numpy()[pi],
})
con = duckdb.connect()
con.register("r", rows)
con.execute(f"COPY (SELECT * FROM r) TO '{out}' (FORMAT parquet, COMPRESSION zstd)")
print("rows", n, "sites", len(d))
