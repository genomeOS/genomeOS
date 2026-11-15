"""gnomAD v3.1.2 HGDP + 1KG recount: the whole-genome observations (Atlas data platform design 2026-10-18
§1.2 D18, §2.10).

The callset's own per-population counts merge four of the registry's 80 identities into two, so the
whole-genome observations are recounted from genotypes under D18's rule, which §1.2 states in full and
which binds: the input and stage (item 1), the records (item 2), the calls (item 3), the sex chromosomes
(item 4), the sites and cells (item 5) and the scope (item 6). The native bcftools count is the build; an
independent Python counter recounts sampled bins and must match it cell for cell (§2.7 check 12,
builder's call 38). All of it is offline batch work, never the serving path.

Module map:

- ``rule``: D18's rule as pure code. The release, rule id, thresholds, PARs and input URLs; the sample
  stage (``read_stage``); segments, ploidy and denominators; the record and call checks
  (``check_record``, ``assess_call``); per-site counts (``SiteCounts``) and the refusal and filter
  tallies ``measured.ingests`` records (``Tally``). Every hard error is a ``RecountError`` naming the D18
  item it enforces and never a sample.
- ``counter``: the independent Python counter over ``bcftools query`` output (``recount_python``).
"""
