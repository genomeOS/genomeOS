"""Whole-genome cost model. Prices: GCS and BigQuery pages saved 2026-10-18 (factcheck-dl/),
HF storage-limits and pricing pages, Cloudflare R2 pricing page (fetched 2026-10-19).
Measured inputs: out/m150k, out/m50k_* (gen_measure.py), query_bytes.py."""

GB, GiB = 1e9, 2**30
ROWS = 153_894_851 * 80  # Koenig et al. 2024 variant count x 80 populations
EG = 0.12        # $/GiB, GCS internet egress 0-10 TiB (worldwide excl. Asia & Australia)
EG2 = 0.11       # 10-150 TiB
FREE_EG_GIB = 100 * GB / GiB  # 100 GB North America free tier
GCS_ST = 0.02    # $/GiB-month Standard
BQ = dict(act_log=0.02, lt_log=0.01, act_phys=0.04, lt_phys=0.02)  # US multi-region $/GiB-month
BQ_Q = 6.25      # $/TiB on-demand past 1 TiB/month free
R2 = 0.015       # $/GB-month
KILL = 300.0

print(f"rows = {ROWS:,} = {ROWS:.4e}")
meas = {"wide lists (L5)": 0.74, "slim 5 cols (L4)": 1.154, "17 cols, rg 122,880 (L2)": 2.511,
        "17 cols, rg 8,192, design default (L1)": 3.676, "L1, noisier AN/rarer AC": 3.806,
        "17 cols snappy (today's format)": 8.004, "17 cols population-major (L6)": 15.96}
print("\nMeasured layouts scaled to whole genome:")
for k, b in meas.items():
    print(f"  {k:42s} {b:6.3f} B/row -> {ROWS*b/GB:8.1f} GB")
raw = 4.271
print(f"  raw TSV zstd (adapter input)              {raw:6.3f} B/row -> {ROWS*raw/GB:8.1f} GB; plain {ROWS*40.941/GB:.0f} GB")

sizes = [10, 46, 100, 200, 500, 2000]
print("\nPer size: GiB | GCS $/mo | R2 $/mo | one full download $ | downloads to $300 | BQ physical active/lt $/mo (if BQ compresses like Parquet)")
for s in sizes:
    gib = s * GB / GiB
    dl = gib * EG
    print(f"  {s:5d} GB | {gib:7.1f} | {gib*GCS_ST:6.2f} | {s*R2:6.2f} | {dl:7.2f} | {KILL/dl:6.1f} | {max(gib-10,0)*BQ['act_phys']:6.2f}/{max(gib-10,0)*BQ['lt_phys']:6.2f}")

# BigQuery logical (measured string lengths): 230.46 B/row all 17 cols
log_row, q4_row, srid_row = 230.46, 48.48, 42.89
log_gib = ROWS * log_row / GiB
print(f"\nBigQuery logical size: {ROWS*log_row/GB:.0f} GB = {log_gib:.0f} GiB = {log_gib/1024:.2f} TiB")
print(f"  storage logical active ${(log_gib-10)*BQ['act_log']:.1f}/mo, long-term ${(log_gib-10)*BQ['lt_log']:.1f}/mo")
for label, br in [("SELECT * full scan", log_row), ("variant_id,population_id,ac,an scan", q4_row)]:
    tib = ROWS * br / 2**40
    print(f"  {label}: {tib:.3f} TiB; querier pays ${max(tib-1,0)*BQ_Q:.2f} with full free tier, ${tib*BQ_Q:.2f} without")
print(f"  point lookups at the 10 MB minimum inside 1 TiB free: {2**40/(10*2**20):,.0f} (MiB) / {2**40/10e6:,.0f} (MB)")

# measured per-query bytes (MB) from query_bytes.py
point_small, point_big = 0.435, 3.034
region_small, region_big = 1.659, 4.259
scan_pop_frac, scan_agg_frac = 17.61 / 44.11, 15.155 / 44.11
print(f"\nGenome-wide scans as a fraction of table bytes: one population {scan_pop_frac:.2f}, aggregate {scan_agg_frac:.2f}")
for s in [46, 200, 2000]:
    print(f"  {s} GB table: one-population scan {s*scan_pop_frac:.0f} GB = ${s*scan_pop_frac*GB/GiB*EG:.2f}; aggregate {s*scan_agg_frac:.0f} GB = ${s*scan_agg_frac*GB/GiB*EG:.2f}")
for n, mb in [("point small files", point_small), ("point 44 MB files", point_big), ("region small", region_small), ("region big", region_big)]:
    print(f"  per 1,000 {n}: {mb:.3f} GB -> ${mb*1e6*1000/GiB*EG:.3f}")


def month(size_gb, lookups, regions, scans, downloads, mirror_share, scans_offloaded, point_mb, region_mb):
    """GiB sent from our GCS and the egress bill, before and after the 100 GB free tier."""
    b = lookups * point_mb * 1e6 + regions * region_mb * 1e6
    b += 0 if scans_offloaded else scans * size_gb * scan_pop_frac * GB
    b += downloads * (1 - mirror_share) * size_gb * GB
    gib = b / GiB
    cost = max(gib - FREE_EG_GIB, 0) * EG
    return gib, cost


print("\nIllustrative months (assumptions in the text):")
for size in [46, 200, 2000]:
    for name, args in [
        ("now, GCS only", (2_000 + 2_000, 200, 5, 5, 0.0, False)),
        ("now, mirror+BQ", (2_000 + 2_000, 200, 5, 5, 0.9, True)),
        ("100x, GCS only", (400_000, 20_000, 500, 500, 0.0, False)),
        ("100x, mirror+BQ", (400_000, 20_000, 500, 500, 0.9, True)),
    ]:
        for pm, rm, tag in [(point_small, region_small, "small files"), (point_big, region_big, "44 MB files")]:
            gib, cost = month(size, *args, pm, rm)
            print(f"  {size:5d} GB | {name:16s} | {tag:11s} | {gib:9.0f} GiB | ${cost:9.0f}")

# kill-switch overshoot per hour of billing lag
for gbps in [1, 10]:
    gib_h = gbps * 1e9 / 8 * 3600 / GiB
    print(f"\n{gbps} Gbit/s of downloads = {gib_h:.0f} GiB/hour = ${gib_h*EG:.0f}/hour")
# manifest growth: 429 B per object (2026-10-18 manifest, 106,409 B / 248)
for s, fmb in [(46, 6), (46, 50), (200, 50), (2000, 50)]:
    n = s * 1000 / fmb
    print(f"manifest: {s} GB in {fmb} MB files = {n:,.0f} objects = {n*429/1e6:.1f} MB")
print(f"\nHF Team 1 seat $20/mo (12 TB+1 TB public); PRO $9/mo (up to 10 TB public); add-on $12/TB/mo")
