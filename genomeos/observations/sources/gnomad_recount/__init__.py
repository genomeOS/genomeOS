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
- ``native``: the native bcftools count of a region or bin (``native_bin``), with its ``+check-ploidy``
  audit and partial-genotype guard, and the independent path's ``view | query`` (``query_bin``).
- ``rows``: one bin's rows of ``measured.allele_observations_binned`` (``binned_rows``): the registry join
  of each stage label to a ``population_id`` and its coordinate (``population_table``), the rows' own
  cohort (``recount_cohort_id``) and the ids derived under ``SOURCE_RECORD_ID_TEMPLATE``
  (``with_derived_ids``).
- ``jobs``: the 166 jobs of 20 Mb (``JOB_SPAN``, ``plan_jobs``, ``job_by_id``); the anonymous-HEAD
  citation of upstream files (``head_identity``, ``CitedFile``, D17); each job's ``JobIdentity`` and its
  ledger (``read_ledger``, ``write_ledger``); ``run_job`` with per-bin resume; and ``combine_ledgers``, the
  ``IngestSummary`` (``write_summary``, ``read_summary``) and its ``measured.ingests`` row
  (``recount_ingest``).
"""
