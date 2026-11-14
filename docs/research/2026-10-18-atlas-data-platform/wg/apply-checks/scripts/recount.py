"""Measurement-only recount of per-population ac/an from gnomAD v3.1.2 HGDP+1KG genotypes.

Usage (stdin is `bcftools query -S <stage> -f '%CHROM\t%POS\t%ID\t%REF\t%ALT\t%FILTER[\t%GT\t%GQ\t%DP\t%AD]\n'`):
    bcftools query ... | python -I recount.py <meta.tsv> <stage_samples.txt> <out_prefix> [haploid_dp]

Rule measured (the D18 text proposed in the platform design, 2026-10-19 revision):
- sites: every record; FILTER != PASS is counted, not ingested. One ALT per record is required
  (the callset is pre-split); a record with a second ALT, a `*` ALT or a GT allele index > 1 is a
  hard error.
- ploidy authority: gnomAD's `gnomad_sex_imputation.sex_karyotype`; the stage must be XX/XY only.
  Expected ploidy: autosomes and the GRCh38 PARs (Hail 0.2.77 reference) diploid; chrX non-PAR
  XX diploid, XY haploid; chrY non-PAR XY haploid, XX not in the denominator (call must be missing).
  A called genotype whose ploidy differs from the expected one is a hard error.
- QC per call: GQ >= 20; DP >= 10 (diploid) or DP >= haploid_dp (haploid); heterozygous calls need
  each of the two AD values / DP >= 0.2. A failing or missing call lowers `an` (never a ref call).
- cells: per population ac (alt dosage) and an (called alleles). Rows are written for PASS records
  with stage ac > 0; cells with an = 0 are counted per population, not written.
Counts only: ac and an, never ac/an. Prints aggregate counts; writes rows to <out_prefix>.parquet.
"""

import collections
import json
import re
import sys
import time

import duckdb
import numpy as np
import pandas as pd

meta_path, stage_path, out_prefix = sys.argv[1], sys.argv[2], sys.argv[3]
HAPLOID_DP = int(sys.argv[4]) if len(sys.argv) > 4 else 5
PAR = {"chrX": [(10001, 2781479), (155701383, 156030895)], "chrY": [(10001, 2781479), (56887903, 57217415)]}

meta = pd.read_csv(meta_path, sep="\t")
h = pd.json_normalize(meta["hgdp_tgp_meta"].map(json.loads).tolist())
sx = pd.json_normalize(meta["gnomad_sex_imputation"].map(json.loads).tolist())
info = pd.DataFrame({"s": meta["s"], "population": h["population"], "project": h["project"],
                     "lat": h["latitude"], "lon": h["longitude"], "karyotype": sx["sex_karyotype"]})
stage = [line.strip() for line in open(stage_path) if line.strip()]
info = info.set_index("s").loc[stage].reset_index()
bad = info[~info["karyotype"].isin(["XX", "XY"])]
if len(bad):
    raise SystemExit(f"HARD ERROR: stage holds karyotypes {sorted(bad['karyotype'].unique())}")
pops = sorted(info["population"].unique())
pidx = {p: i for i, p in enumerate(pops)}
sample_pop = info["population"].map(pidx).to_numpy()
is_xy = (info["karyotype"] == "XY").to_numpy()
P = len(pops)

GT_CACHE = {}
def gt_code(g):
    """(ploidy, dosage, called, het); ploidy 0 = missing."""
    if g in GT_CACHE:
        return GT_CACHE[g]
    a = re.split(r"[/|]", g)
    if any(x == "." for x in a):
        if not all(x == "." for x in a):
            raise SystemExit(f"HARD ERROR: partial genotype {g!r}")
        r = (0, 0, 0, 0)
    else:
        v = [int(x) for x in a]
        if any(x > 1 for x in v) or len(v) > 2:
            raise SystemExit(f"HARD ERROR: genotype {g!r} out of range for a split record")
        r = (len(v), sum(v), 1, int(len(v) == 2 and v[0] != v[1]))
    GT_CACHE[g] = r
    return r

def to_int(xs):
    return np.array([-1 if x == "." else int(x) for x in xs], dtype=np.int64)

stats = collections.Counter()
refuse = np.zeros((P, 4), dtype=np.int64)  # missing, low_gq, low_dp, low_ab (sequential dispositions)
an0_cells = np.zeros(P, dtype=np.int64)
recs = []  # (chrom, pos, id, ref, alt, ac[P], an[P])
t0 = time.time()
for line in sys.stdin:
    f = line.rstrip("\n").split("\t")
    chrom, pos, vid, ref, alt, filt = f[:6]
    pos = int(pos)
    stats["records"] += 1
    if "," in alt or alt == "*":
        raise SystemExit(f"HARD ERROR: unsplit or spanning ALT at {chrom}:{pos}")
    if filt != "PASS":
        stats["records_nonpass"] += 1
        continue
    is_snv = len(ref) == 1 and len(alt) == 1
    stats["pass_snv" if is_snv else "pass_indel_or_mnp"] += 1
    rest = f[6:]
    gts, gqs, dps, ads = rest[0::4], rest[1::4], rest[2::4], rest[3::4]
    codes = np.array([gt_code(g) for g in gts], dtype=np.int64)
    ploidy, dosage, called, het = codes[:, 0], codes[:, 1], codes[:, 2].astype(bool), codes[:, 3].astype(bool)
    in_par = any(a <= pos <= b for a, b in PAR.get(chrom, []))
    if chrom == "chrY" and in_par:
        raise SystemExit("HARD ERROR: record in a chrY PAR")
    if chrom in ("chrX", "chrY") and not in_par:
        expected = np.where(is_xy, 1, 2 if chrom == "chrX" else 0)
    else:
        expected = np.full(len(gts), 2)
    in_denom = expected > 0
    mism = called & (ploidy != expected)
    if mism.any():
        stats["ploidy_mismatch_calls"] += int(mism.sum())
        raise SystemExit(f"HARD ERROR: {int(mism.sum())} calls with unexpected ploidy at {chrom}:{pos}")
    gq, dp = to_int(gqs), to_int(dps)
    dp_min = np.where(expected == 1, HAPLOID_DP, 10)
    ok_gq = gq >= 20
    ok_dp = dp >= dp_min
    ok_ab = np.ones(len(gts), dtype=bool)
    for i in np.nonzero(called & het)[0]:
        a = ads[i].split(",")
        d = dp[i]
        if "." in a or d <= 0:
            ok_ab[i] = False
        else:
            ok_ab[i] = all(int(x) / d >= 0.2 for x in a)
    keep = in_denom & called & ok_gq & ok_dp & ok_ab
    # sequential refusal dispositions per population (counts only)
    miss = in_denom & ~called
    lgq = in_denom & called & ~ok_gq
    ldp = in_denom & called & ok_gq & ~ok_dp
    lab = in_denom & called & ok_gq & ok_dp & ~ok_ab
    for j, m in enumerate((miss, lgq, ldp, lab)):
        refuse[:, j] += np.bincount(sample_pop[m], minlength=P)
    if chrom in ("chrX", "chrY") and not in_par:
        stats["haploid_calls_dp5_to_9"] += int((in_denom & called & ok_gq & (expected == 1) & (dp >= 5) & (dp < 10)).sum())
        stats["haploid_calls_considered"] += int((in_denom & called & (expected == 1)).sum())
    an = np.bincount(sample_pop[keep], weights=ploidy[keep], minlength=P).astype(np.int64)
    ac = np.bincount(sample_pop[keep], weights=dosage[keep], minlength=P).astype(np.int64)
    if ac.sum() == 0:
        stats["pass_monomorphic_in_stage"] += 1
        continue
    stats["kept_sites"] += 1
    an0_cells += an == 0
    recs.append((chrom, pos, None if vid == "." else vid, ref, alt, ac, an))
elapsed = time.time() - t0
stats["counter_seconds"] = round(elapsed, 2)

# rows: proposed lookup-set layout (16 stored contract columns + pos + source_label)
g = info.groupby(["population", "project"]).agg(lat=("lat", "mean"), lon=("lon", "mean")).reset_index()
assert g["population"].is_unique
g = g.set_index("population").loc[pops].reset_index()
def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.strip().lower()).strip("-")
g["population_id"] = [("hgdp-" if p == "HGDP" else "onekg-") + slug(x) for p, x in zip(g["project"], g["population"])]
g["radius_km"] = [50.0 + float((i * 37) % 400) for i in range(len(g))]  # SYNTHETIC placeholder
n = len(recs)
AC = np.array([r[5] for r in recs]).reshape(n, P)
AN = np.array([r[6] for r in recs]).reshape(n, P)
vi, pi = np.nonzero(AN > 0)
variant_id = np.array([f"{r[0]}-{r[1]}-{r[3]}-{r[4]}" for r in recs])
rows = pd.DataFrame({
    "variant_id": variant_id[vi],
    "rsid": np.array([r[2] for r in recs], dtype=object)[vi],
    "population_id": g["population_id"].to_numpy()[pi],
    "lat": g["lat"].to_numpy()[pi], "lon": g["lon"].to_numpy()[pi], "radius_km": g["radius_km"].to_numpy()[pi],
    "ac": AC[vi, pi], "an": AN[vi, pi],
    "source": "gnomad_hgdp_1kg", "assay": "genome",
    "date_lower": np.zeros(len(vi), np.int64), "date_upper": np.zeros(len(vi), np.int64),
    "sampling_design": "healthy_reference", "disease_ascertainment_excluded": np.ones(len(vi), bool),
    "cohort_id": "gnomad-v3.1.2-hgdp-1kg-probe", "ingest_version": "gnomad_hgdp_1kg-v3.1.2-probe-2026-10-19",
    "pos": np.array([r[1] for r in recs], np.int64)[vi],
    "ref": np.array([r[3] for r in recs])[vi], "alt": np.array([r[4] for r in recs])[vi],
    "source_label": np.array(pops)[pi],
})
assert (rows["ac"] >= 0).all() and (rows["ac"] <= rows["an"]).all() and (rows["an"] > 0).all()
stats["rows"] = len(rows)
stats["cells_an_zero_not_written"] = int(an0_cells.sum())
stats["stage_samples"] = len(stage)
stats["stage_xx"], stats["stage_xy"] = int((~is_xy).sum()), int(is_xy.sum())
stats["populations"] = P
stats["refusals_missing_lowgq_lowdp_lowab"] = [int(x) for x in refuse.sum(axis=0)]
con = duckdb.connect()
con.register("r", rows)
con.execute(f"COPY (SELECT * FROM r) TO '{out_prefix}.parquet' (FORMAT parquet, COMPRESSION zstd)")
json.dump(dict(stats), open(f"{out_prefix}.stats.json", "w"), indent=1)
print(json.dumps(dict(stats), indent=1))
