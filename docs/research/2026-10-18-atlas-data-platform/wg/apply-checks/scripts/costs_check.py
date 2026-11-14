"""Re-derived figures for the 2026-10-19 check fixes. Inputs are measured (wg/apply-checks/out) or cited."""
GIB = 1024**3
EGRESS, CLASS_B, STORE = 0.12, 0.0004 / 1000, 0.02
FREE_GIB, FREE_OPS = 100e9 / GIB, 50_000
R = 153_894_851 * 80                       # one row count for every scaled figure
LOOKUP_B, LOOKUP_OPS = 157_734, 10         # measured 2026-10-19 (no source_label)
LABEL_DELTA = 220_924 / 214_998            # measured: same chr21 file with/without source_label

# bytes per row, proposed layout with source_label (measure_layout.py)
auto = 0.6395 * (0.7038 / 0.6937)          # chr21 INFO + label, x recount/INFO on chr11 like for like
fx, fy = 1.1255 / 0.7038, 1.2308 / 0.7038  # chrX, chrY relative to chr11 recount (like-sized windows)
sx, sy = 136.42 / 3381.84, 8.42 / 3381.84  # share of source bytes (estimate of row share)
bpr = (1 - sx - sy) * auto + sx * auto * fx + sy * auto * fy
size = bpr * R
print(f"R {R:,}; autosomal B/row {auto:.4f}; chrX {auto*fx:.3f}; chrY {auto*fy:.3f}; genome {bpr:.4f}")
print(f"table {size/1e9:.2f} GB = {size/GIB:.2f} GiB; storage ${size/GIB*STORE:.3f}/mo; pull ${size/GIB*EGRESS:.2f}")
print(f"avg per bin {size/3102/1e6:.2f} MB; autosomal bin {3_987_471*auto/1e6:.2f} MB; chrX bin {284_954*10*auto*fx/1e6:.2f} MB")
for lbl, b in [("stored srid", 2.465), ("rg 8192", 3.620), ("pop-major", 15.25)]:
    print(f"{lbl}: {b*R/1e9:.1f} GB = {b*R/GIB:.2f} GiB; crawl ${b*R/GIB*EGRESS:.2f}; storage ${b*R/GIB*STORE:.2f}")
print(f"ac>0 only: {8.855*0.1081*R/1e9:.1f} GB")
print(f"lookup with source_label (estimate): {LOOKUP_B*LABEL_DELTA:,.0f} B")

# 10x scenario: website first uses the free tier; lookups pay full price
web_gib = 4000e9 / GIB
lk = 4_000_000
lk_gib = lk * LOOKUP_B / GIB
lk_cost = lk_gib * EGRESS + lk * LOOKUP_OPS * CLASS_B
both = (web_gib + lk_gib - FREE_GIB) * EGRESS + (lk * LOOKUP_OPS - FREE_OPS) * CLASS_B
print(f"10x: website {web_gib:,.1f} GiB ${web_gib*EGRESS:.0f}; lookups {lk_gib:.1f} GiB ${lk_cost:.2f}; together, free tier once ${both:.0f}")
print(f"10x daily lookups {lk/30:,.0f}; brake 20 GiB/day = {20*GIB/LOOKUP_B:,.0f} lookups ({20*GIB/(LOOKUP_B*LABEL_DELTA):,.0f} with label); "
      f"headroom {20*GIB/LOOKUP_B/(lk/30)-1:.1%}; x{20*GIB/LOOKUP_B/(400_000/30):.1f} the 100x model")
print(f"60 GiB/day: {60*GIB/LOOKUP_B:,.0f} lookups, x{60*GIB/LOOKUP_B/(400_000/30):.0f} the 100x model, ${60*EGRESS:.2f}/day, ${60*EGRESS*30:.0f}/30 days")
print(f"crawls/day at 20 GiB: {20/(size/GIB):.1f}; one-bucket crawls to $300: {300/(size/GIB*EGRESS):.0f}")
for mb in (size / 3102 / 1e6, 2.465 * R / 3102 / 1e6):
    b = 200_000 * mb * 1e6
    print(f"website whole-file fallback at {mb:.2f} MB: ${b/GIB*EGRESS:.0f}/mo")
print(f"alerting points, one series, 30-s executions, 30 days: {2*60*24*30:,} -> ${2*60*24*30*0.5/1e6:.3f}")
for gib, rate, lbl in [(2642, 0.000021918, "long-term logical"), (230.46 * R / GIB, 0.000021918, "lt logical"),
                       (257.7 * R / GIB, 0.000031507, "active logical")]:
    print(f"BQ {lbl}: {gib:,.0f} GiB x ${rate*730:.4f}/GiB-mo = ${(gib-10)*rate*730:.1f}/mo")
for c, gib in [("chr1", 260.95), ("chr2", 274.93), ("all", 3_631_210_123_548 / GIB)]:
    b = gib * GIB
    print(c, f"{b/1e9:.1f} GB", " ".join(f"{b/r/3600:.2f}h@{r/1e6:.1f}MB/s" for r in (22.9e6, 25.4e6, 13.9e6, 10.8e6)))
