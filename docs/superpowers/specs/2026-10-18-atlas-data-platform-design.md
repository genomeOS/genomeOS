# genomeOS Atlas data platform: layout, queries and access tiers

Status: Approved by the owner 2026-11-14. Decisions are in §1; nothing is built yet.

2026-10-18; revised 2026-10-19 with the owner's decisions (D1, D1b, D4, D5a, D5b) and two clarifications on lookups and bulk downloads, then corrected the same day after a review check (D18's full rule for indels and the sex chromosomes, the free line for whole files, the binned table's own contract, sizes, build time and the 10x costs). Decisions D1c, D18, D16 and D17 were approved as recommended on 2026-11-14, with the design as a whole. Nothing is built and no cloud command was run. Builds on the v1 design (§3, §5, §6, §10, §12), the data store design 2026-10-17 (rules C1–C11) and the fit-input step (branch `data/fit-inputs`). The source designs, fact-checks, the 2026-10-19 whole-genome measurements and the probe scripts move to `docs/research/2026-10-18-atlas-data-platform/` in step 1.2.

**Reading guide.** Owners: the Summary, §1 (decisions, unknowns, your hands-on steps), §4 (the free/paid line), §7 (user journeys), §8 (costs) and §12 (risks); the rest is for implementers. Terms are defined at first use and in Appendix B. Units: 1 GiB ≈ 1.07 GB; Google prices per GiB; figures are rounded; "estimate" marks arithmetic beyond what was measured.

## Summary

**What you decided on 2026-10-19.** The free/paid line follows what serving costs us, not the release date (D1). Signing in with one's own Google account, which Google bills, meets "users log in" (D1b). The project's own data is CC BY 4.0 (D5a), and WorldPop is recorded as `explicitly_open` from its hub's CC BY 4.0 statement (D5b). v1's observations layer is the whole genome, always available (D4). And two clarifications: "we only need to look up data for one variant at a time", and "bulk downloads fall on users to pay for".

**What that means.**
- **The supported query is one variant:** its observations across all populations and, separately, its surfaces. Genome-wide and whole-population scans are not supported, and bulk download of the whole-genome table is not a goal.
- **The whole-genome table is laid out for that lookup:** about 154 million variants (SNVs and indels) × 80 populations, at most 1.23e10 rows of `ac` and `an` (ac = 0 included), in one Parquet file per chromosome (chr1–22, X and Y) and 1 Mb bin: 3,102 files, about 8.2 GB (estimate). A lookup from a laptop or the website, by DuckDB over HTTPS with no account, reads about 158 KB in about 10 requests (measured) and costs us about $0.02 per 1,000. No warehouse: BigQuery returns only if a genome-wide use case appears.
- **One source is derived; the rest are linked.** gnomAD's HGDP + 1KG callset (CC0) is the only open source we checked that is whole genome, GRCh38 and placeable on the map; its published counts merge 80 populations into 78, so we recount from its genotypes under a rule stated in full, indels and the sex chromosomes included (D18).
- **Observations stay measured and surfaces inferred:** the whole genome widens observations only; surfaces stay at the fitted variants, in separate tables, layers and macros.

**The line between free and paid (D1c, approved 2026-11-14).**

| | Free, no account | Paid by the downloader |
|---|---|---|
| One variant at a time from any table: its observations, surfaces, cells and files | yes, at any table size | |
| Everything published in release 2026-10-18 and earlier | yes, for good | |
| Whole files: any object under `OPEN_CLASSES` (today's kinds of data, query tables, catalogs, models) at any size; any other object ≤ 1 GiB, each lookup-set file included (a whole-genome bin is about 2.6 MB); within 2 GiB per release beyond a free mirror (lookup-set files outside it, bounded by the brake) | yes | |
| Bulk: a whole lookup set (the whole-genome table) or a selection of one over 1 GiB; a chargeable file over 1 GiB outside `OPEN_CLASSES` with no free mirror | | yes: Requester Pays, billed by Google to their own project (D1b) |
| Restricted, non-commercial or unchecked sources | by lookup, or from a free mirror | never; if neither fits, the build fails and you decide |

D1c narrows D1 only for lookup sets: a whole set becomes bulk, while each of its files stays free. Every object D1 made free stays free at any size, nothing published changes, and nothing is paid today: the whole-genome table's bulk door is built on the first request (step 3.2).

**What it costs us,** a month (§8; no usage analytics exist, so traffic is assumed, at 4 lookups per Atlas visit):

| | Our buckets only | With a free mirror (D3, on its trigger) |
|---|---|---|
| Now | about $0 | about $0 |
| 100x users | about $194 (lookups about $9 of it) | about $58 |
| 100x users and data | about $416 | about $77 |

- Lookups never drive the bill (400,000 a month cost about $9); downloads and Atlas page traffic do, as before. The whole-genome table adds $0.15 a month of storage.
- Without a mirror, 100x users and data passes the $300 kill switch (which makes the data bucket private) every month; D3 triggers at $50 a month of data egress, long before that. The lookup files get their own bucket and a brake acting within minutes (D16), so a crawler cannot take all Atlas data private.
- Website traffic stays outside every brake: at 1,000,000 visits a month it alone costs about $450 (D11).

> **What we need from you**
>
> **Recorded 2026-10-19.** D1, D1b, D4, D5a and D5b, as you answered (§1.1). D3b is superseded by builder's call 28 (no default download). D3 is re-asked, reframed for lookups, and no longer needed now (§1.3).
>
> **Recorded 2026-11-14.** D1c, D18, D16 and D17, each as recommended (§1.1, §1.2). Nothing else is needed now.
>
> **Later, each on an event** (§1.3): D3 on egress or the brake's first trip; D2a, D2c and D6a if a genome-wide use case appears; D7 after step 2.4 and a mirror; D11 on website cost; D12a–D12b on free egress; D13 when posterior draws ship; D14 at the second whole-genome ingest; D10 before a hosted query service; D2b and D15 confirm only; D6b, D8a–D8e and D9 when the first paid file is scheduled.
>
> **What starts once you approve this design.** Phase 1 (§11) in full, and the whole-genome code (2.6–2.7) under D18's approved rule, tested against the measured windows. Every upload, the buckets and the CORS changes are yours to run under your login (§1.5).

## 1. Decisions only the owner can make

Bare numbers such as 2.2 are build steps (§11); "§" marks sections.

### 1.1 Decided

| # | Your answer | What it means now |
|---|---|---|
| D1 | Yes: the free/paid line follows what a download costs us (§4.2), not the release date | The rule ships in 2.1; D1c sets where bulk falls |
| D1b | Yes: one's own Google account, billed by Google, meets "users log in" | No genomeOS account before the prepaid door (§5) |
| D4 | Whole genome: v1's observations layer is the whole genome, always available | About 1.23e10 rows, laid out for one-variant lookups (§2.10); not only the fitted and curated variants |
| D5a | CC BY 4.0 for data the project makes | genomeos objects become `explicitly_open` (step 1.3) |
| D5b | Record WorldPop as `explicitly_open` from its hub's CC BY 4.0 statement, by an evidence PR | Its 62 objects (85.8% of today's bytes) may use every door (step 1.3) |
| D1c | 2026-11-14, as recommended: one variant at a time, everything published so far, and whole files (any `OPEN_CLASSES` object at any size, any other object ≤ 1 GiB, each lookup-set file included) are free; a whole lookup set, a selection of one over 1 GiB, or a chargeable file over 1 GiB outside `OPEN_CLASSES` with no free mirror is bulk, paid by the downloader through Requester Pays | §1.2 holds the full line; it gates 2.1 and the whole-genome release |
| D18 | 2026-11-14, as recommended: recount gnomAD v3.1.2 HGDP + 1KG genotypes for the paper's 4,094 people under all 80 identities, by the rule in §1.2 | The rule in §1.2 is binding text; it gates 2.6 and 2.8 |
| D16 | 2026-11-14, as recommended: the lookup files get their own bucket with a 20 GiB-a-day brake that makes only that bucket private | Before the first whole-genome upload (2.5) |
| D17 | 2026-11-14, as recommended: the whole-genome ingest cites gnomAD's 24 VCFs (URL, size, md5, generation) and our code's commit instead of re-hosting 3.3 TiB | A documented exception to "inputs travel with outputs"; before 2.8 |

### 1.2 Approved 2026-11-14: the full text of D1c, D18, D16 and D17

Each was approved as recommended. The table keeps the questions as asked; the recommended column is now the decision.

| # | Question | Decision (as recommended) | Alternatives considered | Blocks |
|---|---|---|---|---|
| D1c | You said "bulk downloads fall on users to pay for". Is this the line: free = one variant at a time from any table; everything published so far; whole files of any object under `OPEN_CLASSES` at any size and of any other object ≤ 1 GiB, each lookup-set file included, within the 2 GiB-per-release guard beyond a free mirror (lookup-set files outside it, bounded by the brake); bulk = a whole lookup set or a selection of one over 1 GiB, or a chargeable file over 1 GiB outside `OPEN_CLASSES` with no free mirror, paid through Requester Pays? | Yes. D1c narrows D1 only for lookup sets: a whole set becomes bulk, each of its files stays free. Every object D1 made free (today's kinds of data, query tables, catalogs, models) stays free at any size; R1 keeps every published path free; restricted, non-commercial or unchecked data is never paid (by lookup, from a free mirror, or the build fails for you to decide) | **D1 unchanged** (lookup sets free to download whole): the whole-genome table breaks the 2 GiB guard unless a free mirror holds it (D3 becomes a precondition) or you raise the cap; each full pull costs us $0.92 (7.6 GiB). **Lookups only, no bulk door ever:** users wanting bulk rerun our code on gnomAD's free files | 2.1, 2.8 |
| D18 | Which counts become the whole-genome observations, and by exactly which rule? | Recount the v3.1.2 HGDP + 1KG genotypes (CC0) for the paper's 4,094 people under all 80 identities, by **D18's rule, in full** (below the table). It replaces "the chr22 pilot's rules", which covered only PASS biallelic SNVs on an autosome. `cohort_id` names the release, sample stage and rule. Relatedness (1,294 reported pairs in the pilot) is left to the fitting side, never pruned from the measurement | **gnomAD's own INFO counts:** no recount, but 78 labels (Han with NorthernHan, PapuanHighlands with PapuanSepik merged), only about 3,380 unrelated samples; the registry's 80 identities cannot be filled. **gnomAD v4.1's 80-label counts:** 565 GiB of Hail tables needing Hail and Spark, another sample set. **The recount on the about 3,380 unrelated samples:** no reported relatives, fewer people. **Within the recount:** DP ≥ 10 for haploid calls too (the pilot's one threshold) refuses 3.2% more XY chrX calls (measured); autosomes only in v1 (2,887 bins; X and Y ids then read curated rows only until a later ingest); writing PASS records with no allele in the stage too (2–6% more sites, measured; a lookup then shows zeros instead of no gnomAD rows) | 2.6, 2.8 |
| D16 | Should the lookup files live in their own bucket, with a brake on bytes sent that makes only that bucket private? | Yes: proposed `genomeos-atlas-lookup` (us-east1, read by key, CORS for range reads) in today's project. Brake: a Cloud Monitoring alert on its sent bytes (sampled every 60 s, visible within 210 s, [gcs-metrics]) at 20 GiB a day: about 136,000 lookups at the measured 158 KB (about 132,000 at the 162 KB estimated with `source_label`), 10.2 times the 100x model's 13,333 a day, at most $2.40 a day. **It is set to trip at about 10 times our 100x traffic, deliberately:** at that volume (133,333 lookups a day, 98% of the cap, 2% headroom) it trips on most days, and the free mirror (D3, whose trigger includes the brake's first trip) is the intended response. Alerting is free until charges start, no sooner than 2027-09-01; then $0.35 a month for each metric reference plus $0.50 per 1,000,000 points returned by the condition's query ([mon-pricing]). A condition runs every 30 s, so one series aggregated across API method and response code returns at least 86,400 points a month (about $0.04, estimate), more if left unaggregated; the points charge is measured once the policy exists. Restoring access stays your step | **60 GiB a day:** about 408,000 lookups, 31 times the 100x model; up to $7.20 a day, $216 in a 30-day month at the cap, which with other traffic reaches the $300 kill switch. **One bucket:** a crawl of the table costs $0.92, and about 330 a month trip the $300 kill switch, which makes all Atlas data private, hours late. **A billing budget on the bucket's label:** billing-account budgets only, one label each, hours late ([budgets]) | 2.5, 2.8 |
| D17 | Your rule publishes inputs with outputs. May the whole-genome ingest cite its input instead of re-hosting it? | Yes: `measured.ingests` records gnomAD's 24 VCFs by URL, size, md5 and GCS generation, the metadata file's sha256, the sample rule and our code's git SHA; anyone can rerun it anonymously from GCS or AWS | **Re-host the 3,381.84 GiB:** $68 a month stored, $406 per full pull from our bucket. **Publish an intermediate counts file:** about 53 GB (synthetic estimate), a second copy of the table's facts | 2.8 |

**D18's rule, in full** (what approving D18 approves; nothing in it is inherited by reference):

1. **Input and stage.** gnomAD v3.1.2's HGDP + 1KG dense VCFs: 24 files, chr1–22, X and Y; there is no chrM file. Samples: the paper's 4,094 (the stage is a parameter, named in `cohort_id`). Each sample's population is the source's literal population field, 80 identities, read from the metadata file recorded by sha256 (D17).
2. **Records.** FILTER = PASS; every other record is counted per filter in `measured.ingests`, not ingested. The callset is already split, one ALT per record (measured: none of 11,374 records in five windows has a second ALT; 22 of 583 and 198 of 3,437 positions in the chr22 and chr11 windows carry two or more records). A record with a second ALT or a `*` ALT, or a genotype allele index above 1, fails the build. **Every ALT is its own `chr-pos-ref-alt` row: SNVs, indels and MNPs alike** (12–15% of records are not SNVs: 72 of 616 and 560 of 3,812 in two windows). The pilot's PASS-biallelic-SNV selection was the pilot's scope, not part of this rule, and its hand controls do not yet cover indels (step 2.6 adds them).
3. **Calls.** A call counts if GQ ≥ 20, DP ≥ 10 (DP ≥ 5 for a haploid call, gnomAD's own default thresholds, [gnomad-adj]) and, if heterozygous, each of its two AD values divided by DP ≥ 0.2. A failing or missing call lowers `an` and never becomes a reference call; refusals are counted per population and reason (missing, low GQ, low DP, low allele balance, in that order). A partial genotype such as `./1` fails the build.
4. **Sex chromosomes.** Ploidy follows gnomAD's `gnomad_sex_imputation.sex_karyotype`, the authority. The stage holds only XX and XY samples: all 30 others in the callset (20 X, 2 XXY, 2 XYY, 6 ambiguous) are gnomAD hard-filtered (`sex_aneuploidy`, `ambiguous_sex`), and a stage that keeps any fails the build for you to decide. The pseudoautosomal regions (PARs), as the callset's Hail 0.2.77 GRCh38 reference defines them ([hail-grch38]): chrX:10,001–2,781,479 and chrX:155,701,383–156,030,895, diploid for everyone. chrX outside the PARs: XX diploid; XY haploid, adding 1 to `an` and 0 or 1 to `ac`, never 2. chrY outside the PARs: XY haploid; XX samples are not in the denominator. chrY's PARs (chrY:10,001–2,781,479 and 56,887,903–57,217,415) hold no records (measured): their variation is called on chrX. A called genotype whose ploidy differs from this fails the build.
5. **Sites and cells.** A PASS record is written if its recounted `ac` is above 0 in the stage; one with no allele in the stage is counted (`monomorphic_in_stage`), not written. Every population at a written record is a row, ac = 0 included, unless its `an` is 0 (counted per population, not written; builder's call 32).
6. **Scope.** chrX and chrY ship in v1 under items 4 and 5.

Measured on 2026-10-19 (`wg/apply-checks/`; a 4,097-sample stand-in stage, gnomAD's `high_quality` samples, with the sample-meta file's 78 labels): every called genotype's ploidy matched item 4 in two chrX PAR windows, a chrX non-PAR window (XY: 8,195,765 haploid calls, 0 diploid) and a chrY window (XX: all missing); the native bcftools count and an independent Python counter agreed on all 592,484 written cells of the chr11 (rs334), chrX non-PAR and chrY windows; DP ≥ 5 rather than 10 keeps 262,267 of 8,141,719 XY chrX calls (3.2%) and 19,185 of 1,199,713 chrY calls (1.6%); PASS records with no allele in the stage were 2.1% (chr11), 5.9% (chrX) and 3.0% (chrY).

### 1.3 Later, each on its trigger

| # | Question | We recommend | What changes | Trigger |
|---|---|---|---|---|
| D3 | Should a free mirror (an HF organisation dataset) copy each release, so small-file downloads try it first and lookups fall back to it when the brake trips? | Yes, when triggered. Not a precondition now: lookups cost about $0.02 per 1,000, and whole lookup sets are not free downloads (D1c) | At 100x users our bill falls from about $194 to $58; C8 admits committed free hosts. HF limits anonymous users per IP per 5-minute window in three buckets: 3,000 for `/resolve/` URLs, 500 for the API, 100 for pages ([hf-rate]). We assume a range read of a `/resolve/` URL counts as one resolver request (about 300 lookups of 10 requests per IP per window); if range reads count against the API bucket it is 50. Unverified (§1.4); it decides whether the mirror can carry website lookups when the brake trips | Data egress over $50 a month for two months (cost report, 1.14), or the brake's first trip |
| D3b | — | Superseded by builder's call 28: no implicit default; every download names what it wants | | — |
| D2a | Should genome-wide SQL scans go to a BigQuery copy billed to the querier? | Only if a genome-wide use case appears; anonymous lookups stay the main path | **Yes:** logical storage would cost us about $42–68 a month for the whole-genome copy ($0.000021918 long-term to $0.000031507 active per GiB-hour, about $0.016–0.023 per GiB-month, on 2.6–2.9 TiB; [bq-pricing]); physical about $0.3–1.3 (unmeasured), plus time-travel and failsafe storage, which physical billing charges and logical does not; a cross-population scan bills the querier 0.55 TiB, inside their free TiB | An issue with a genome-wide use case |
| D2c | Does a door where Google bills the user count as charging under your terms rule? | Yes ("even cost recovery"); applied until you say otherwise | **No:** those doors may carry everything. Not needed for the whole-genome table, whose sources are all chargeable | With 3.1, or a non-chargeable set for 3.2 |
| D6a | A second project for BigQuery? | Yes, with 3.1; id supplied at build time, never committed; own budget; physical storage billing | A table's address shows its project id, so it holds nothing else | With 3.1 |
| D7 | At $300 of monthly spend, should the kill switch keep making the data bucket private, or turn on Requester Pays? | Private, until step 2.4 exists and a mirror holds every non-chargeable file | **Requester Pays:** only users with a billing project continue; without the mirror condition, the 6 GeneReviews-linked objects and the catalogs (which carry GeneReviews) would be paid; needs `storage.buckets.update` | After 2.4 and 3.8 |
| D11 | How should the website bucket, which has no brake, be bounded? | Accept it now; past $50 a month for two months, move web data to Cloudflare R2 with a custom domain | Cloud CDN (about $18.25 a month standing) or the small render tier instead; each changes 3.5 | Cost report |
| D12a, D12b | Start sponsor mirrors (AWS Open Data, Google public datasets), opening the AWS account; ask AFND and MAP for permission to mirror? | When triggered | Zero-egress copies for downloads; WorldPop and genomeos now qualify; AWS needs data "usable for any purpose", and AFND has no licence | Free egress over $50 a month for two months, or a guard-raising PR |
| D13 | Publish posterior draws (105–217 GB in all) as a lookup set: one artifact's draws free, all draws Requester Pays? | Yes, under `store/draws/`: each artifact's draws file (150–311 MB) stays a free whole-file download under R3's proviso; the whole set is bulk. Until you answer, `store/draws/` is not a lookup set and nothing is published there | $2–4 a month stored; outside every default | When P3's burden draws ship |
| D14 | When should a manifest inherit from its parent (schema v3)? | Past about 2 MB | The first whole-genome ingest takes it to about 1.44 MB (estimate), the second past 2 MB | Second whole-genome ingest; 3.6 |
| D10 | Allow unbounded query endpoints on our compute before metering? | No; bounded lookups only | | Before 3.6 |
| D2b, D15 | Retire v1's BigQuery batch path (fits run on GitHub runners)? Does the Pan-UKB evidence index (Cloud SQL planned) stay a separate layer? | Yes; confirm | | Confirm only |
| D6b, D8a–D8e, D9 | Prepaid door: own project; build it; legal seller; Paddle or Stripe; $1 trial allowance (pool ≤ $50); credit a PO on payment; sell only recorded licences | Yes; when scheduled; an entity that passes seller review; Paddle; yes; on payment; yes | §6 | First scheduled `at_cost` object |

### 1.4 Unknowns that could change a recommendation

| Unknown | Affects | We find out | If it fails |
|---|---|---|---|
| DuckDB-WASM range-reads GCS after the CORS change ([wasm-1367] reports whole-file fetches on v1.30.0+) | website lookups | 1.13 | Whole-file reads would cost $59 a month at 100x (2.6 MB files); the website uses the P4 API for lookups |
| Genome-scale sizes, extrapolated from two autosomal windows (78 labels, placeholder radii) and 0.05–0.1 Mb recount windows on chr11, chrX and chrY, with chrX's and chrY's row shares taken from their shares of the source bytes | D16's cap, §8 | the first jobs of 2.8 | resize the cap; the layout holds within 50 MB files |
| Which metadata file carries the 80 identities: the gnomAD sample-meta file read on 2026-10-19 has 78 `population` values; the pilot's qualified metadata had 80 | D18 | 2.6 | the pilot's metadata, cited by sha256 (D17); if it cannot be cited, you decide |
| A GitHub runner's recount speed and its bandwidth from GCS (measured only on an Apple M3 Pro laptop: 22.9–25.4 MB/s streamed) | 2.8's job size | the first jobs of 2.8 | 10 Mb jobs (322, two workflow runs, since a matrix holds 256, [gh-limits]) |
| gnomAD's files stay anonymous and free (the paper says requester-pays; anonymous reads worked 2026-10-19 on GCS and AWS) | 2.8, D17 | 2.8 | the AWS copy, recorded beside GCS |
| HF hosts tens of GB free ("best-effort" past "the first few gigabytes", [hf-storage]) | D3, D13 | 3.8 | R2 or AWS Open Data |
| HF counts a range read of a `/resolve/` URL in the Resolvers bucket (3,000 per IP per 5 minutes), not the API bucket (500) ([hf-rate]) | D3: whether the mirror can serve website lookups when the brake trips | 3.8 | 50 lookups per IP per window; the website links gnomAD's browser instead |
| A no-card BigQuery sandbox can query another project's dataset ([bq-sandbox]) | D2a | 3.1 | require a billed project |

### 1.5 Your hands-on steps

Agents never hold your cloud or HF credentials, so these are yours.

| When | Step | What you do | Size |
|---|---|---|---|
| Phase 1, per release | 1.5–1.12 | run the publish runbook under your login (impersonating `data-store-publisher`); for 1.10 also `publish_atlas_web.py` | one session per release; two releases |
| Phase 1 | 1.13 | apply the CORS change | one command |
| Monthly | 1.14 | run the read-only cost report, or turn on billing export once | one command |
| Whole genome, once | 2.5 | create the lookup bucket, its CORS and its brake | one session |
| Per whole-genome ingest | 2.8 | upload about 8.2 GB in 3,102 files | one session |
| On trigger | 3.1–3.4, 3.8 | BigQuery project; bulk bucket; kill-switch role; AWS account and sponsor forms; HF dataset and scoped token | one session or form each |
| Phase 4 | 4.x | name the legal seller; pass merchant review; create the door's project | the provider's pace |

## 2. The data and how it is laid out

**Conclusion: Cloud Storage and immutable, hash-pinned Parquet stay the only source of truth; query-shaped derived tables sit beside the canonical artifacts, never in place of them; the whole-genome table is shaped for one-variant lookups.** Apart from it the data is small (0.25 GiB now, about 46 GB at 100x), written once and read mostly by people with no cloud account.

### 2.1 What is published

| Kind | Where | Access (§4) |
|---|---|---|
| Surfaces | `store/artifacts/<variant>__<model>__<data>/cells.parquet` (61 artifacts); query copy in `tables/v1/inferred/` | open |
| Fit inputs | `store/artifacts/<id>/observations.parquet` (step 1.1) | open |
| Harmonised observations, curated ingests | `tables/v1/measured/` (step 1.9) | open |
| Whole-genome observations | lookup bucket, `tables/v1/measured/allele_observations_binned/source=gnomad_hgdp_1kg/ingest_version=<iv>/chrom=<c>/bin=<b>/` (§2.10) | lookup (R3); each file free whole |
| Registries, sources, validation, catalogs | `registry/`, `sources/`, `validation/`, `tables/v1/reference/`, `catalog/` | open |
| Raw harvests | `raw/<source>/<harvest_version>/` (step 1.8, #472); today only `raw/afnd_populations.tsv` | open if ≤ 1 GiB; else R5–R7 |
| Trained models | `store/models/<artifact-id>/`, safe export (step 1.12, #471); pickles never | open |
| Posterior draws | `store/draws/<artifact-id>/` (D13) | undecided (D13); nothing published until then |

Every run's inputs ship in the same release as its outputs, and every derived table records its inputs by sha256; the whole-genome ingest cites its upstream input instead (D17).

### 2.2 Five rules

1. **The canonical artifact does not move:** `store/artifacts/<variant>__<model>__<data>/` (`cells.parquet`, `observations.parquet`, `manifest.json`) stays the citable unit; models and draws sit beside it.
2. **Everything else is derived** under `tables/v1/`, rebuilt deterministically from released bytes or cited inputs, never cited itself, never the only copy of a fact.
3. **Measured and inferred never share a table or file, nor a prefix under `tables/`.** Inside an artifact they are separate files under separate frozen contracts, linked only through `manifest.json`; the catalog exposes fit inputs only through `measured.*` views. Allele and carrier counts are separate tables; only `fit_inputs`, a table of keys, links measured to inferred. A variant lookup returns observations and surfaces from separate macros, never one joined table.
4. **Append-only:** released files are never rewritten; later releases reuse earlier keys.
5. **Every read is by key:** anonymous readers hold `roles/storage.legacyObjectReader`, which cannot list ([gcs-iam]), so the catalog names every file or computes its URL from a complete, manifest-checked set.

### 2.3 Layout

Keys stay `https://storage.googleapis.com/genomeos-atlas-data/releases/<R>/<path>`, `<R>` being the release that first published the file; lookup sets use the same paths in `genomeos-atlas-lookup` (D16). Only additions; the web bucket (`genomeos-atlas-web`) stays a key-value store for the browser.

```
store/artifacts/<variant>__<model>__<data>/{cells,observations}.parquet, manifest.json   CANONICAL
store/models/<artifact-id>/    store/draws/<artifact-id>/    raw/<source>/<harvest_version>/
tables/v1/                                                                                 DERIVED
  measured/{allele,carrier}_observations/source=<s>/ingest_version=<iv>/part-0.parquet       curated
  measured/allele_observations_binned/source=<s>/ingest_version=<iv>/chrom=<c>/bin=<b>/part-0.parquet   lookup sets
  measured/ingests.parquet   measured/fit_inputs/epoch=<R>/part-0.parquet
  inferred/artifacts.parquet inferred/cells_by_cell/epoch=<R>/res=<k>/h3_r0=<cell>/part-0.parquet
  reference/populations/<release>-<sha8>/...   reference/{variants,grid_cells}/<version>/...
  evidence/{crossval,refit_qc}.parquet   meta/{release_objects,sources,served,withdrawn}.parquet
catalog/{catalog.sql, atlas.duckdb, tables.json}
```

`key=value` folders need `assert_data_path` to accept `=` (builder's call 5). A `registry_version` (`RELEASE+sha256.DIGEST`) is not path-safe, so registry folders are `<release>-<sha8>`, with the full value as a column. The two legacy registries, whose `registry_version` holds no digest to derive a folder from, keep their names as folders: `afnd-2026-08` and `map-survey-coordinates-v1` (call 18).

### 2.4 Tables and partitions

| Table | Key | Partitions | Notes |
|---|---|---|---|
| `measured.allele_observations` | `(ingest_version, source_record_id)` | `source`, `ingest_version` | curated ingests, in the data bucket: `part-0.parquet` storing all 17 `OBSERVATIONS_SCHEMA` columns, `source_record_id` included; frozen contract `contract/tables/measured.allele_observations.v1.schema.json`; no frequency column or view |
| `measured.allele_observations_binned` | `(ingest_version, variant_id, population_id)` | `source`, `ingest_version`, `chrom`, `bin` | lookup sets, in the lookup bucket: the 16 contract columns other than `source_record_id`, plus `pos` and `source_label`; its own frozen contract `contract/tables/measured.allele_observations_binned.v1.schema.json`; the lookup macro derives `source_record_id` from the template recorded in `measured.ingests`, so both tables present the same 17 columns; no frequency column |
| `measured.carrier_observations` | `(ingest_version, source_record_id)` | `source`, `ingest_version` | `carriers`, `n_individuals`; never unioned with allele counts |
| `measured.ingests` | `(source, ingest_version)` | none | `registry_version`, adapter git SHA, input keys or cited URLs with md5 and generation, refusal counts, the `source_record_id` template |
| `measured.fit_inputs` | artifact + record | `epoch` | keys only; `evidence` = `fit-record` or `web-json-match` |
| `inferred.artifacts` | artifact | none | manifest fields; `fit_input_evidence` (`fit-record`, `web-json-match`, or `none` with a reason), never null |
| `inferred.cells_by_cell` | artifact + `(res, h3_index)` | `epoch`, `res`, `h3_r0` | 14 columns + `h3_r0`, `h3_parent_r3`, `measurement`, `artifact_format` |
| `reference.*` | version | version in path | `uncertainty_radius_km` has no default |
| `evidence.parity_observations` | `source_record_id` | none | view over the released `validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet` |
| `meta.*` | release + path | none | `release_objects`, `sources`, `served`, `withdrawn`; `meta.release` is a view |

The two allele tables never share a prefix, a file or a contract; `measured.variant` (§3.1) is the only place they meet, unioning one computed bin file of the binned table with the curated table's listed files.

`h3_r0`, an H3 cell's resolution-0 ancestor, never changes; Hive partitioning puts values in folder names so engines skip non-matching files ([duckdb-hive]). The res-4 grid has 93 non-empty base cells. With `epoch` (the release that first wrote a part), each release writes cells only for new artifacts; compaction past 16 epochs runs one `h3_r0` at a time, within a free runner's 14 GB disk ([gh-runners]). `measurement` keeps the 8 KIR carrier-frequency surfaces apart; the two format-1 manifests lacking it (HbS v1, G6PD v1) take it from a reviewed builder table, never a default. Phenotype composites such as G6PD are marked by their variant id (`phenotype__…`).

### 2.5 Formats

One pinned DuckDB writes every file (builder's call 15): zstd for `tables/` (−29% on a surface); row groups (independently readable chunks) of 8,192 rows, 122,880 for lookup sets (builder's call 29), so an HTTP range read (a request for part of a file) can skip data ([duckdb-https]); explicit `lat`, `lon` and radii; files of 1–50 MB, never above about 150 MB, where gcloud's composite uploads drop the md5. Each file carries `genomeos.table`, `genomeos.schema_version`, `genomeos.contract_sha256` and the git SHA that first wrote it; a MAJOR contract change is a new `tables/v2/`. New artifacts (format 2.1) adopt zstd, these row groups and `h3_parent_*`.

### 2.6 The catalog

`catalog/catalog.sql` is canonical and committed in the release PR: view and macro definitions over the exact URLs the manifest lists. From it the builder makes `atlas.duckdb`, a views-only DuckDB file (274,432 B) that readers attach read-only over HTTPS ([duckdb-attach], [duckdb-viewonly]), and `tables.json` (`key, url, sha256, bytes, rows, access`, plus `hosts` from step 2.1) for Polars, pandas, R and `curl`; neither is in git. **Lookup sets are reached by macros that build one file's URL from the variant id** (chromosome, `pos // 1e6`), and only for a chromosome in the ingest's recorded set (chr1–22, X and Y for gnomAD: 3,102 bins, all written). Any other id (`chrM`, `hla:`, `kir:`, `phenotype:`) computes no URL and reads curated rows only, so a computed URL never 404s; no lookup set has a `nonlocus` bin, since ids with no locus live in curated ingests. No view lists the 3,102 files: a catalog listing them alone measured 1,060,864 B and its attach read 2,109,444 B in 10 requests (re-measured 2026-10-19; the first probe, 1.8 MB and 2.9 MB, also listed a 1,920-file population copy the design does not build), against 274,432 B and 548,868 B for today's views-only catalog. None lets a query without a variant open every file (31,013 requests). `tables.json` lists every file. `meta.release` gives the release id, manifest key, `cite_as` and mirror, but not the manifest's sha256, because the manifest lists the catalog. The builder runs two passes: key everything but `catalog/`, write the catalog, then hash it and write the manifest. Tested on DuckDB 1.5.5: macros call `read_parquet` (a macro naming a view fails under an alias); URL-building macros work; CI builds twice under one alias and compares; newer-version files read best-effort ([duckdb-storage]). **Offline mode:** after a named download (§3.2), `SET VARIABLE genomeos_local = 'data/'` reads sha256-checked local copies; remote reads are not hash-checked.

### 2.7 Build-time integrity checks (hard errors, v1 §12)

(1) Files match frozen contracts: the curated and binned allele tables each against its own. (2) Path partition values equal in-file values (`bin = pos // 1e6`, `chrom` equals `variant_id`'s chromosome and is in the ingest's recorded set); nothing under `tables/` is in both `measured/` and `inferred/`. (3) Measured rows pass pandera and their source's spatial-support contract; keys are unique; each fit input appears identically in its ingest; a carrier artifact matched to the allele table fails. (4) Re-ingesting the released raw input, or the cited input (sampled bins, for a lookup set), gives the same `source_record_id` set; derived ids recompute from the recorded template. (5) Every `population_id` resolves in its pinned registry; MAP's own coordinates stay authoritative. (6) `cells_by_cell` equals each `cells.parquet` (count, checksum, `measurement`, `artifact_format`). (7) Every catalog URL, and every URL a macro can compute (the 3,102 bins of the recorded chromosome set; a test asserts that `chrM`, `hla:` and `kir:` ids compute none), is a manifest key with matching sha256, not withdrawn; two builds match; from step 2.1, `access` and `hosts` equal the rule's recomputation. (8) An anonymous post-upload smoke test on `evidence.parity_observations`: discs within 500 km of Lagos give 40 rows, sum `an` 52,340, sum `ac` 6,459. (9) Every recorded input sha256 is a manifest key in this or an earlier release, a committed `manifests/<R>.json`, a `git:<path>` whose sha256 is that file at the stamped `genomeos.git_sha`, or a cited upstream URL with md5 and generation (D17). (10) Every released artifact has a `fit_input_evidence`. (11) From step 2.2, no earlier path is missing unless withdrawn. (12) Lookup sets: every `(chrom, bin)` file of the recorded chromosome set exists, empty ones included; refusal counts reproduce; on sampled bins, at least one autosomal bin rich in indels, one chrX PAR bin, one chrX non-PAR bin and one chrY bin among them, an independent counter matches the native bcftools recount cell for cell and `bcftools +check-ploidy` agrees with the karyotypes; an anonymous lookup of rs334 (`chr11-5227002-T-A`) returns one gnomAD row per population with `an > 0`, the per-population refusal counts in `measured.ingests` accounting for the rest, with the recorded `ac` and `an` sums. The expected row count is recorded from the first real recount, never asserted in advance (the 78-label stand-in gave 78 of 78, sum `ac` 208, sum `an` 8,188).

### 2.8 The per-artifact fit input

**It fits as built:** the exact frame the fit consumed, in its order, as integer counts under the frozen contract of the artifact's `measurement`. `measured.fit_inputs` is built from it, check 3 reads it, and the web observations JSON of artifacts released with one becomes its projection. The KIR fix (`228ea54`) writes `carrier_frequency` inputs under `contract/carrier_observations.schema.json` and must land before any KIR artifact is released.

The 61 artifacts of 2026-10-17 have no input (`RELEASED_WITHOUT_INPUT`), and their inputs are never reconstructed. Web observations JSON exists only for the 30 the website serves (`website/public/data/atlas/catalog.json`). Where it exists and its source has a published ingest, step 1.9 writes `web-json-match` rows routed by `measurement`; the 4 served KIR files store carrier counts as `ac`/`an` (`export_atlas_web.py` uses `as_binomial`), mapped to `carriers`/`n_individuals`. Every other artifact gets `fit_input_evidence = none` with a reason, MAP ones included until a qualified MAP ingest ships. The only released MAP HbS rows, the 994-row parity input, have radii from MAP's area class, which fail the `sampling_bounding_disc` contract (`docs/map-spatial-support.md`), so they stay out of `measured.*` as `evidence.parity_observations`.

### 2.9 Withdrawals

Views and macros anti-join `meta.withdrawn`. A takedown that must remove bytes rebuilds the affected parts into a new epoch (or a new ingest version, for a lookup set) without those rows, publishes a new catalog, and lists the superseded parts in `data/releases/WITHDRAWN.json` (`key, sha256, reason, issue, date, decided_by`) for the owner to delete. Older catalogs naming a deleted part then fail loudly, as `docs/data-access.md` says.

### 2.10 Whole-genome observations (D4)

**Conclusion: one derived source, recounted from genotypes under D18's rule, stored as 3,102 bin files so one variant reads about 158 KB.**

**Source.** gnomAD v3.1.2's HGDP + 1KG dense callset: 24 per-chromosome VCFs, 3,381.84 GiB (3.63 TB), 4,151 samples, GRCh38, CC0, readable anonymously from GCS and AWS (measured 2026-10-19; [gnomad-downloads], [aws-gnomad]). Koenig et al. report 153,894,851 SNVs and indels in 4,094 genomes from 80 populations ([koenig2024]). The callset's per-population INFO counts cannot be used: they carry 78 labels, merging Han with NorthernHan and PapuanHighlands with PapuanSepik, and cover only the about 3,380 unrelated high-quality samples (measured: the 78 `AN_` values sum exactly to `AN`; [gnomad-hgdp-help]). Taking them would merge four registry identities into two with no adapter error. No gnomAD sites VCF carries HGDP or 1KG fields (measured on v3.1.2 and v4.1.1; v4's export drops them on purpose); v4's 80-label counts exist only in 565 GiB of Hail tables on another sample set. The three published count sets disagree: for rs334, 21 to 50 of 78 labels are identical. Hence the recount from genotypes (D18), the method the chr22 pilot proved (`docs/research/hgdp-count-pilot-2026-09-09.md`: 80 identities; every per-variant total matched an independent bcftools count). The pilot counted only PASS biallelic SNVs in one autosomal window; D18's rule (§1.2) states in full how indels and the sex chromosomes are counted.

**Not sources.** The phased HGDP + 1KG and 1000G panels (phasing fills missing genotypes and drops singletons, which would put inferred values into observations). 1000G high coverage and HGDP from Bergström et al. (3,199 of 3,202 and 802 of 929 samples are already inside; ingesting them would count people twice). ALFA (12 ancestry groups, not places, so no coordinate and radius). AADR and SGDP (hg19). PGG.SNV and GenomeAsia (no terms found; site unreachable). IndiGen (one all-India aggregate, academic use). MCPS (licence forbids redistribution and crawling). GenomeIndia (controlled access). The website links per variant to gnomAD's browser (v4 counts), Ensembl REST (1000G phase 3, 26 populations, GRCh38, [ensembl-rest]), GGV (hg19), ALFA and PGG.SNV.

**Rows.** Every population at every written record (D18 item 5: PASS, an allele in the stage), ac = 0 included: 89–92% of cells are zero and are kept, because `an` carries the evidence. At most 153,894,851 × 80 = 12,311,588,080 rows (Koenig's count of SNVs and indels in the 4,094, × 80 populations); every scaled figure below uses this one row count, and the first jobs of 2.8 replace it with our own. A cell with `an = 0` is not an observation (no allele was called; 0.01–0.34% of cells in three windows): it is counted per population in `measured.ingests`, not written, and the build fails if a rerun's counts differ (builder's call 32). Non-PASS records and PASS records with no allele in the stage are counted, not ingested. `variant_id` is GRCh38 `chr-pos-ref-alt`, one row per ALT, indels and MNPs included (12–15% of records).

**Layout** (builder's calls 29–31, 37). Table `measured.allele_observations_binned`, its own contract and prefix (§2.4). DuckDB 1.5.5, zstd, sorted `(pos, ref, alt, population_id)`, 122,880-row groups, one file per chromosome and 1 Mb bin over the ingest's recorded chromosome set (chr1–22, X and Y: 3,102 bins), every bin written (empty ones too, so a computed URL never 404s); no `nonlocus` bin (§2.6). Columns: the contract's 16 stored columns plus `pos` and `source_label`; `source_record_id` is derived by the lookup macro as `gnomad-hgdp-1kg:` ‖ `variant_id` ‖ `:` ‖ `source_label`, the template recorded in `measured.ingests`; the macro returns the 17 contract columns.

| Choice | Measured, bytes per row | Whole genome (estimate) |
|---|---|---|
| Proposed: `source_record_id` derived, `source_label` stored, D18's recount | 0.640 (chr21) and 0.636 (chr2) on gnomAD's INFO counts; the recount adds 1.5% (chr11, like for like: 0.704 against 0.694); chrX 1.13 and chrY 1.23 under the recount, 1.6 and 1.7 times chr11's 0.704 on windows of like size | 8.2 GB (7.6 GiB): 0.666 B/row × 12,311,588,080; about 2.6 MB per autosomal bin, about 3.0 MB per chrX bin |
| The same without `source_label` | 0.621 (chr21), 0.617 (chr2) | 7.6 GB, before the recount and chrX adjustments |
| `source_record_id` stored (no `source_label`) | 2.465, 2.452 | 30.3 GB; about 9.8 MB per bin |
| Stored, 8,192-row groups (§2.5's default) | 3.620 | 44.6 GB; a lookup reads 1.07 MB |
| Population-major order | 15.25 | 187.8 GB |
| Only rows with ac > 0 (rejected: loses `an` for zero counts) | 8.855 on 10.8% of rows | 11.8 GB |

The proposed figure weights autosomes at 0.649 B/row (chr21's 0.640 × 1.015), chrX at 1.04 and chrY at 1.14 (chr11-relative factors) by their shares of the source bytes, 4.03% and 0.25% (an estimate of their row shares). chrX probably costs more per row because its `an` varies more between records (inference): there, low GQ refused 2.7% of calls at PASS records (432,397 of 15,961,912) against 0.4% on chr11 (56,222 of 14,261,657), and missing calls were 3.8% against 2.1%.

| Lookup (cold DuckDB 1.5.5, caches off, Range-logging server) | Bytes | Requests |
|---|---|---|
| One variant, all populations, by the macro (one file touched) | 157,518 | 9 |
| The same, direct; derived ids | 157,734; 160,146 | 10; 9 |
| Over a genome-sized 3,102-file list with partition predicates | 244,837 | 13 |
| A bounded region (APP, 291 kb, 2 bins): works, not promised | 952,261 | 28 |
| No partition predicate (why no unbounded view exists) | every file | 31,013 |

Measured on chr21:25–27 Mb (102,594 PASS variants, 7,974,942 rows, all passing `OBSERVATIONS_SCHEMA`) and chr2:100–101 Mb (52,400 variants, 4,074,868 rows), which agree within 0.6% on bytes per row, and, under D18's rule, on chr11:5.20–5.25 Mb (265,419 rows), chrX:100.0–100.1 Mb (284,954) and chrY:14.0–14.1 Mb (42,111; one row group, so small-file overhead is included); genome figures are extrapolations. The genome figures already count 80 populations per variant; the windows had 78 labels and placeholder radii, and the recount windows a 4,097-sample stand-in stage. Lookup bytes were measured without `source_label`: storing it added 5,926 B (2.8%) to a lookup on the same chr21 file (214,998 to 220,924 B), so a bin lookup should read about 162 KB (estimate).

**Build** (builder's call 38). Stream the 24 VCFs with bcftools; no credential is needed. **Jobs are 20 Mb ranges, not chromosomes:** 166 jobs of at most 20 bins, inside GitHub's 256-job matrix and 6-hour job limit ([gh-limits]); each job writes its bins with their sha256s, and a rerun skips bins already written with matching hashes, so a failed or cancelled job resumes. The count is native bcftools: `+setGT` sets calls failing item 3 of D18's rule to missing, `+fill-tags -S` counts `ac` and `an` per population (a haploid call counts once), and `+check-ploidy` audits ploidy against the karyotypes on the same stream. Measured on an Apple M3 Pro laptop, 2026-10-19 (`wg/apply-checks/`):

| Path, chr11 window (3,812 records, 103.3 MB of source bytes) unless stated | Records/s | Source MB/s |
|---|---|---|
| Decode only: `bcftools query` of GT, GQ, DP, AD, local copy (chr11; chrX) | 1,556; 1,467 | 42.2; 30.1 |
| Native count, local copy (chr11; chrX) | 1,556; 1,531 | 42.2; 31.4 |
| Python counter on `bcftools query` output, local copy (chr11; chrX) | 514; 525 | 13.9; 10.8 |
| Native count streamed from GCS, end to end (two runs) | 843–937 | 22.9–25.4 |

At 22.9–25.4 MB/s, chr2 (295.2 GB) would take 3.2–3.6 hours as one job and chr1 (280.2 GB) 3.1–3.4 hours; the Python counter would need 5.9–7.6 hours for chr2, past the 6-hour limit. The largest 20 Mb job (chr19, about 30 GB) takes about 22 minutes at 22.9 MB/s; the whole set is about 44 hours of streaming, about 2.2 hours across GitHub's 20 concurrent jobs if bandwidth scales (estimates; a runner's 4 vCPUs and its bandwidth from GCS are unmeasured, §1.4). The Python counter recounts sampled bins independently (check 12): on the chr11, chrX non-PAR and chrY windows it matched the native count on all 592,484 written cells. A job writes at most about 60 MB, within a free runner's 14 GB disk. Each bin file is validated as it is written: pandera on the chunk; `(variant_id, population_id)` unique within the bin; bins are disjoint, so derived ids are unique by construction. The current adapter (pandas over one TSV, frame-wide uniqueness) cannot run at 1.23e10 rows, and its `COHORT_ID` `gnomad-v4-hgdp-1kg` names a count set this ingest does not use; step 2.6 gives the recount its own module and `cohort_id` and names every caller it touches. This is offline batch work, never the serving path.

**Not built.** A per-population copy (whole-population scans are unsupported); one web JSON per variant (153,894,851 objects, $769 of upload operations per publish); a BigQuery copy (on trigger, D2a).

## 3. How people query and download it

**Conclusion: query first. Anonymous HTTPS lookups, one variant at a time, are the primary path; downloads name what they want; bulk is the downloader's to pay; BigQuery and a mirror open on triggers.**

### 3.1 One variant at a time: anonymous HTTPS and DuckDB

```sql
ATTACH 'https://storage.googleapis.com/genomeos-atlas-data/releases/<R>/catalog/atlas.duckdb'
  AS atlas (READ_ONLY);                       -- DuckDB CLI, Python, R or the browser shell
SELECT population_id, ac, an, lat, lon, radius_km, sampling_design, cohort_id, source_record_id
FROM atlas.measured.variant('chr11-5227002-T-A');          -- observations, every population and source
SELECT * FROM atlas.inferred.surfaces('chr11-5227002-T-A');  -- surfaces: a separate macro
SELECT * FROM atlas.measured.near('chr11-5227002-T-A', 6.5244, 3.3792, 500);  -- discs within 500 km of Lagos
```

`measured.variant` unions one computed bin file of `measured.allele_observations_binned` (only for an id on a chromosome the ingest recorded) with the listed files of the curated `measured.allele_observations`, both presenting the same 17 columns; rows from different count sets of one source stay apart by `cohort_id` and `ingest_version`. `near` counts the sampling disc (`haversine <= 500 + radius_km`) without the spatial extension, whose (latitude, longitude) order invites swaps. One cell across the 31 res-4 surfaces reads 0.32 MB with the `h3_r0` predicate the macros add. A list of variants is a loop of lookups: 1,000 variants read about 158 MB. **No inference on the serving path:** macros and the P4 API only do arithmetic over precomputed cells; regional means leave out `unknown` and `prior_dominated` cells and return the excluded fraction; credible intervals come from offline burden draws (P3). **The website** reads the same files: one variant's observations across populations from the lookup bucket by range (step 2.9), in a layer separate from surfaces; if DuckDB-WASM cannot range-read, through the P4 API. When the brake has tripped, it says so and links to gnomAD's browser.

### 3.2 fetch_data.py: every download names what it wants

- **No implicit default** (builder's call 28). With no selection, `fetch_data.py` lists what the release holds (tables, sizes, access) and how to query it, and downloads nothing.
- **Selections:** `--prefix`; `--table <name>` with a partition filter (`--where chrom=chr11,bin=5`, `source=`, `ingest_version=`), which selects files by path; `--set served|tables|all` (whole lookup sets excluded); `--urls` prints keys and URLs only. The release runbook uses `--set all`, and the builder fails if an earlier path is missing and not withdrawn.
- **Bulk is refused from free hosts.** A selection from a lookup set over 1 GiB, or a whole one, downloads nothing: it prints bytes, the list price at $0.12/GiB, the Requester Pays route once built (§3.5), and gnomAD's own files with our recount command; exit status 3.
- **Tier-aware** (step 2.4): any object whose next host is `gcs-bulk` needs `--billing-project` plus `--max-spend` (or `--yes` under $1).
- **Mirror first** (step 3.8, D3): `--source auto` tries each object's `hosts` in order, falling back on 403, 429 or 5xx; a hash mismatch falls back with a loud warning and a non-zero status. The manifest comes only from git or GCS.
- **Single file** (step 2.3): `fetch_data.pyz`, a standard-library zipapp on each GitHub release. The docs lead with querying, then downloads.

### 3.3 The free mirror, on a trigger (D3)

**An org-owned public HF dataset would hold exactly the release keys,** uploaded and sha256-verified by `sync_store.py push-release`, listed in `hosts`, named in `meta.release`. GCS stays the source of truth. It serves small-file downloads at no cost to us ([hf-pricing]) and lookups when the brake has tripped. HF limits anonymous users per IP per 5-minute fixed window in three buckets: 3,000 for Resolvers (every URL with a `/resolve/` segment), 500 for the Hub API, 100 for pages ([hf-rate]). The design assumes a DuckDB range read of a `/resolve/` URL counts as one resolver request, so a lookup's 10 requests allow about 300 lookups per IP per window; if range reads count against the API bucket, 50. This is unverified (§1.4); scans fit neither. For a non-chargeable lookup set, it is the only bulk route (R3). Catalogs and the browser read GCS: HF's CORS bug is fixed ([hf-7931]), but `hf://` in DuckDB-WASM is undocumented.

### 3.4 BigQuery: only for a genome-wide use case

**Not needed now:** one-variant lookups need no warehouse. If a genome-wide use case appears (D2a), BigQuery becomes the Google-billed SQL door (Tier 1), labelled derived and not citable. Shape: the dedicated project (D6a); a dataset per release in the US multi-region; physical (compressed) storage billing, since logical billing of the whole-genome copy (2.6–2.9 TiB) would cost us about $42–68 a month (long-term logical $0.000021918 and active logical $0.000031507 per GiB-hour, [bq-pricing]); physical billing also charges time-travel and failsafe storage, which logical does not, and its whole-genome size is unmeasured; native tables `measured_*` and `inferred_*`, joined only through `fit_inputs`, checked against manifest row counts; READER for `allAuthenticatedUsers` ([bq-iam]). `publish_bigquery.py` loads only tables whose every source is in `CHARGEABLE` without `non_commercial` (D2c) and fails loudly otherwise. The querier pays $0 to 1 TiB a month, then $6.25/TiB; "The data owner is not charged" ([bq-pricing]).

### 3.5 Requester Pays bulk bucket, on the first request

**Never on the free buckets, except D7's emergency mode under its terms condition.** A separate bucket, proposed `genomeos-atlas-bulk` (us-east1, `legacyObjectReader` for `allAuthenticatedUsers`, versioning, soft delete), provisioned by the owner when the first bulk request (an issue) or the first `at_cost` or R6 object arrives. It holds server-side copies of chargeable lookup sets: the whole-genome table costs the downloader $0.92 (7.6 GiB) and us $0.15 a month to store. Step 3.2 adds its name to the committed host constants (C8) and `COMMITTED_PUBLIC_URLS` in `tests/test_web_layout.py`. Callers without `serviceusage.services.use` on a billed project get `400 UserProjectMissing` ([rp]).

## 4. The free/paid line

**Conclusion: the line follows what serving costs us (D1), and bulk falls on the downloader (D1c).** One variant at a time is free from any table at any size; everything published so far is free for good; whole files are free for any object under `OPEN_CLASSES` at any size and any other object ≤ 1 GiB, each lookup-set file included. Bulk (a whole lookup set or a selection of one over 1 GiB, or a chargeable file over 1 GiB outside `OPEN_CLASSES` with no free mirror) is billed by Google to the downloader. D1c narrows D1 only for lookup sets. Restricted, non-commercial or unchecked data is never charged for, even at cost.

### 4.1 Tiers

| Tier | What | Who and how | Cost to them | Cost to us |
|---|---|---|---|---|
| **0 Free** | lookups, one variant at a time, from `open` and `lookup` objects; whole files of `open` objects (today all 248 of 2026-10-18, 271,494,507 B) and of single `lookup` files ≤ 1 GiB | anyone, anonymously | $0 | about $0.02 per 1,000 lookups; $0.12/GiB of downloads past the free 100 GB |
| **1 SQL** (§3.4, on trigger) | chargeable tables in BigQuery | Google sign-in; own project, or a sandbox (unverified) | $0 to 1 TiB a month, then $6.25/TiB | storage |
| **2 Downloads** (§3.5) | whole lookup sets and selections of one over 1 GiB; `at_cost` objects; GCS copies of R6 objects | Google identity on a billed project, own or a lab's (D1b) | $0.12/GiB internet, $0 within us-east1 ([gcs-pricing]) | storage |
| **3 Prepaid** (§6) | the same | GitHub or Google sign-in; ≥ $10 top-up; quote, debit, a 15-minute signed URL | list ÷ 0.89 = $0.135/GiB | allowance pool ≤ $50 a month |

### 4.2 The rule

A pure module, `genomeos/publication/access_policy.py`, evaluates every object; `build_data_release.py` writes **manifest schema version 2**: per-object `access` (`open`, `lookup` or `at_cost`) and `hosts` (ordered from `hf`, `gcs-free`, `gcs-lookup`, `gcs-bulk`), plus an `access_policy` block copying the constants. Readers take `access` from the manifest and never infer it. A v1 manifest reads as all `open`; CI recomputes every committed manifest under the `access_policy` block it records. The rule picks only the door; `INCLUDE` and the terms register decide what is published.

| Constant | Value | Why |
|---|---|---|
| `EGRESS_USD_PER_GIB` | 0.12 | GCS internet egress, 0–10 TiB |
| `OPEN_OBJECT_MAX_BYTES` | 1 GiB | a download costs us ≤ $0.12, while a $10 card top-up loses $0.59 to Stripe's 2.9% + 30¢ ([stripe-pricing]) |
| `OPEN_RELEASE_GCS_MAX_BYTES` | 2 GiB | bounds a release's free whole-file bytes that no mirror holds (≤ $0.24 to serve once), `OPEN_CLASSES` objects over 1 GiB included; R5 bytes count even when mirrored; lookup sets do not count (their single files are free, but the brake bounds them, and there is no free whole-set route) |
| `OPEN_CLASSES` | `registry/`, `sources/`, `raw/afnd_populations.tsv`, `store/artifacts/`, `store/models/`, `store/catalog-metadata.json`, `store/INVENTORY.json`, `validation/`, `manifests/`, `tables/` (lookup sets excepted: R3 fires first), `catalog/` | today's kinds of data and their query copies and models, free at any size as D1 granted |
| `LOOKUP_SETS` | the binned ingests under `tables/v1/measured/allele_observations_binned/`; `store/draws/` only once D13 is approved | read one variant at a time; each file ≤ `OPEN_OBJECT_MAX_BYTES` stays a free whole-file download; a whole set, or a selection over 1 GiB, is bulk (D1c) |
| `LOOKUP_DAILY_BYTES_MAX` | 20 GiB | the lookup bucket's brake (D16) |
| `CHARGEABLE` | `explicitly_open`, `permission_granted`, `no_restriction_found` | allowlist; `restricted`, `restriction_found`, `not_checked` and future statuses excluded |
| `ZERO_EGRESS_HOSTS` | `hf` (on D3); later `aws-odp`, `gcp-public` | egress costs us $0 |
| `ACCESS_OVERRIDES` | prefix → `open`, with reason and issue | only toward `open` |

Rules, first match wins; a derived object's sources are the computed union of its inputs' sources.
- **R0** Pickles and object-dtype `.npy` are refused.
- **R1 Once free, always free:** a path any earlier release published as `open` stays `open` and keeps `gcs-free` in `hosts`; CI fails if either shrinks. R1 never blocks a withdrawal (§2.9).
- **R2** Override → `open`.
- **R3 Lookup sets** → `lookup`, hosts `gcs-lookup` (plus `hf` once mirrored), for range reads and for whole-file downloads of any single member ≤ `OPEN_OBJECT_MAX_BYTES`. The access class bounds set-wide pulls; the brake, not the class, bounds a crawl of single files (risk 3, D16). Whole-set downloads, and selections over 1 GiB, list `gcs-bulk` only if every source is `CHARGEABLE` and none `non_commercial`; otherwise there is no bulk route until a zero-egress host holds the set. A member over 1 GiB has no free whole-file route.
- **R4** Under `OPEN_CLASSES` at any size, or ≤ 1 GiB → `open`; counted toward the release guard unless a zero-egress host holds it.
- **R5 Terms gate, on every paid door:** an object over 1 GiB with any source flagged `non_commercial` or outside `CHARGEABLE` never lists `gcs-bulk` or the broker. If a zero-egress host holds it, it is `open` with hosts `hf, gcs-free`, counted toward the guard. If not, the build fails, listing fixes: split out the restricted fields, record the terms check, declare it a lookup set if it is read one variant at a time, or an owner override.
- **R6** Mirrored and chargeable → `open`, hosts `hf, gcs-bulk`; losing the mirror moves its cost to requesters.
- **R7** Otherwise `at_cost`, from `gcs-bulk` (later also the broker).

**Release guard:** `open` bytes on no zero-egress host, plus all R5 bytes, total ≤ 2 GiB per release, or the build fails; fixes are a mirror (not for R5), declaring a lookup set, an override, or an owner PR raising the cap with the new worst case. Hard-error tests include: chargeable lookup set → `lookup`, `gcs-lookup, gcs-bulk`; `not_checked` lookup set → `lookup` with no `gcs-bulk`; a 2.6 MB lookup-set member → `lookup`, downloadable whole from `gcs-lookup`, outside the guard; a 1.5 GiB object under `OPEN_CLASSES` → `open`, counted toward the guard; `store/draws/` is not a lookup set before D13; `non_commercial`, 1.5 GiB, on `hf` → no `gcs-bulk`, counted; `not_checked`, 1.5 GiB, unmirrored → build error; `fetch_data.py` refuses a whole lookup set, or a selection of one over 1 GiB, from `gcs-lookup`.

**Hosted reads:** a P4 API (the planned hosted lookup service) serves bounded lookups anonymously behind a per-IP limit: one variant, cell, tile or catalog page, or `/aggregate` over a bounded region, each ≤ 10 MB. It runs on Cloud Run in the free project under a native spend cap (Cloud Run is eligible; GCS and BigQuery are not, [spend-caps]). No unbounded SQL runs on our compute before Tier 3 metering (D10).

### 4.3 Applied

All 248 objects of 2026-10-18 are `open` (R1, R4), including the 6 GeneReviews-linked objects (`non_commercial`), which R5 keeps off every paid door. Fit inputs, `tables/` outside lookup sets, `catalog/` and exported models (#471) are `open`. The whole-genome parts are `lookup`, each about 2.6 MB file free to download whole; their sources (gnomAD, CC0; genomeos registry rows, CC BY 4.0 under D5a) are all chargeable, so their bulk door is `gcs-bulk` once 3.2 builds it. The WorldPop 1 km grid (#472, about 870 MB) is `open` (R4) and counts toward the guard unless mirrored. gnomAD and AlphaGenome caches are `open` while each object is ≤ 1 GiB, with restricted fields shipped as separate free objects. Nothing is `at_cost` in the foreseeable releases.

## 5. Identity

**Conclusion: none for free data and lookups; the user's Google identity for Google's doors (D1b); our own sign-in only with the prepaid door.**

- **Tier 0:** no account, cookie, key or form; brakes and caps handle abuse. A login wall would also disqualify AWS Open Data ([aws-odp]).
- **Tiers 1–2:** Google IAM (Google's permission system) checks the account; we store nothing. `fetch_data.py` uses credentials only when the caller passes `--billing-project` and names a token source: `GENOMEOS_GCS_ACCESS_TOKEN` (from `gcloud auth print-access-token`), `--adc <path>` or `--metadata-server`. It never reads default credential locations or gcloud state, so an agent on the owner's machine never acts as the owner; a test checks that a set `CLOUDSDK_CONFIG` or ADC file is ignored. BigQuery Data Access audit logs "can't be disabled" ([audit-logs]); `_Default` retention goes to 1 day, and the docs say so.
- **Tier 3, when built:** Firebase Authentication with GitHub and Google, free to 50,000 monthly active users ([idp-pricing]); we keep uid, provider and a receipt email; config injected at build time, never committed; the page still reveals the project id, hence D6b. Teams invite by GitHub login or verified email, never by email domain (CVE-2022-31027). No ORCID sign-in: its terms forbid use "in connection with any revenue-generating product or service" ([orcid]).

## 6. Billing and cost recovery

**Conclusion: Google Cloud Billing does all billing until the prepaid door exists, so recovery is exactly list price and we handle no money.**

**Tiers 1–2.** Queries bill the querier; Requester Pays bills "the billing project supplied in the request" ([rp-use]). We handle no money, invoices or sales tax. Unrecouped: storage (under $5 a month at 100x) and Tier 0 egress. Docs advise payers to use a dedicated project with a budget, since Requester Pays charges "do not appear separately in your billing" ([rp]).

**Tier 3, prepaid.** Price = list ÷ 0.89 = $0.135/GiB, once per URL. On $10, 11% raises $1.10: Paddle charges $1.00 ([paddle]); Stripe Managed Payments ([stripe-mp]) $1.19 on a foreign-currency card (D8c). A seller outside the EU owes EU VAT from the first consumer sale ([eu-oss]), hence a merchant of record; Stripe's requires "all necessary rights and licenses" ([stripe-mp-elig]). Flow: quote, confirm, debit, signed URL; HTTP 402 at zero; never an overage invoice; an append-only ledger in its own project (D6b); reprice by PR outside 95–105% recovery. Google invoiced billing needs $40,000 a year of expected spend ([invoiced]).

## 7. User journeys

**First-time visitor.** The Atlas loads from the web bucket, with no sign-in or cookie wall. Searching rs334 shows its observations in every HGDP + 1KG population with called alleles there, up to 80, on the map (measured, with each sampling disc), and, as a separate layer, HbS surfaces where fits exist. "Get the data" lists `cells.parquet` (7.5 MB), its manifest and fit input, each with size, sha256, citation and **free, no account**. "Query in your browser" runs the lookup SQL in DuckDB-WASM.

**Researcher on a GPU pod with no cloud account.**
1. `python3 fetch_data.pyz` lists the release and prints the lookup snippet; nothing downloads. For 2,000 GWAS hits the researcher loops `atlas.measured.variant` (about 316 MB, free); for HbS's fit input, `--prefix store/artifacts/<HbS artifact>/`. Most researchers stop here.
2. Asking for the whole-genome table downloads nothing: the script prints "8.2 GB · about $0.92, billed by Google to your project", the Requester Pays route (once built) and gnomAD's own files with our recount command, and exits 3. With a lab's billing project, the researcher reruns with `--billing-project <lab-project> --max-spend 1` and a token from `gcloud auth print-access-token` on a laptop.
3. With the prepaid door: `fetch_data.py login`, approve on a phone, accept the quote, fetch by signed URL.

**Heavy SQL user.** One variant at a time is the supported query; a region still works through the macros. A genome-wide scan is not: the catalog offers no view that could run one, and BigQuery is built only if such a use case appears (D2a).

**Lab paying by invoice.** A project on the institution's billing account, members with Service Usage Consumer; Google waives internet egress up to 15% of monthly fees for qualifying institutions ([waiver]).

## 8. Costs now and at 100x

**Conclusion: lookups cost about $0.02 per 1,000 and never drive the bill; downloads and Atlas page traffic do, as before. The whole-genome table adds $0.15 a month of storage and about $9 a month of lookups at 100x users.**

**Prices.** GCS egress to "Worldwide destinations (excluding Asia & Australia)": $0.12/GiB for 0–10 TiB ([gcs-pricing]); Class B operations (GET, HEAD) $0.0004 per 1,000; storage $0.02/GiB-month. The free tier gives 100 GB (93.1 GiB) of North American egress and 50,000 Class B operations a month in us-east1 ([free-tier]), per billing account, shared by every project on it. **Budget as bytes:** the $300 kill switch buys about 2,780 GB a month, or about 13.9 million lookups.

| Read | Bytes | Cost to us |
|---|---|---|
| One variant across all populations (measured) | 158 KB, 10 requests | about $0.02 per 1,000 |
| Point query on surfaces, partitioned / catalog attach (measured) | 0.32 / 0.55 MB | about $0.04 / $0.06 per 1,000 |
| Atlas visit, fast-load design with its 3 MB detail tier | about 4 MB | about $0.45 per 1,000 |
| Full release today / at the guard | 0.27 GB / 2 GiB | $0.03 / $0.24 |
| A crawl of the whole-genome table (unsupported; the brake bounds it) | 8.2 GB (30.3 GB if ids stored) | $0.92 ($3.39) |
| The same as a bulk download (Requester Pays) | 8.2 GB | $0 to us; $0.92 to the downloader |

**Monthly cost to us.** No analytics exist, so traffic is assumed. Planning model: now, 1,000 Atlas visits a month at 4 MB each, 50 full downloads and 20 CI checks; "100x users" multiplies visits and downloads by 100. New: 4 lookups per visit (2 on the website, 2 by DuckDB or the API), so 4,000 now and 400,000 at 100x (63 GB, 4 million requests). The download volumes are kept from the earlier model as a ceiling: query-first, with no default download, can only lower them.

| Scenario | From our buckets | Cost | Under $200? |
|---|---|---|---|
| Now | 24 GB | **about $0** (free tier) | yes |
| 100x users, today's data, our buckets only | 1,823 GB (lookups 63) | **about $194** | barely; a spike trips the switch |
| same, mirror first (90% of downloads) | 603 GB | **about $58** | yes |
| 100x users and data, our buckets only (5,000 downloads of 0.5 GiB; CI fetching the 31 GB tree 20 times; bulk paid by requesters) | 3,763 GB | **about $416** ($411 egress and operations, $5 storage and loads) | no: over $300 every month |
| same, mirror first; CI checks the mirror | 733 GB | **about $77**, plus up to $3.5 a release for the GCS verify | yes |

**If traffic is 10 times our estimate** (1,000,000 visits a month at 100x): the website alone sends 4,000 GB, about $450 a month (3,725 GiB × $0.12), outside the kill switch (D11). The free 100 GB and 50,000 Class B operations are per billing account, and the website uses them up, so 4,000,000 lookups pay full price: 587.6 GiB × $0.12 + 40,000,000 requests × $0.0004 per 1,000 = about $87. Together, with the free tier counted once, about $520 a month. Those lookups are 133,333 a day against D16's cap of about 136,000 (2% headroom): the brake trips on most days, by design, and the free mirror (D3) is the response.

- **The brake** (D16): 20 GiB a day is about 136,000 lookups at the measured 158 KB (about 132,000 at the 162 KB estimated with `source_label`), 10.2 times the 100x model's 13,333 a day, or 2.6 crawls of the table; it costs at most $2.40 a day before tripping. It is set to trip at about 10 times the 100x traffic. At 1 Gbit/s, downloads cost about $50 an hour, so a brake that acts in minutes matters; billing-based ones act hours late.
- **If DuckDB-WASM cannot range-read,** website lookups would fetch whole bin files of about 2.6 MB: about $59 a month at 100x ($219 with stored ids), so the website uses the P4 API instead.
- **Storage and loads never drive it:** about 46 GB at 100x data is about $0.80 a month; the whole-genome table $0.15 per ingest version ($0.57 with stored ids), a bulk copy the same again; streaming gnomAD's input costs us nothing. A BigQuery copy is not built (§3.4).
- **CI** (builder's call 11): the one anonymous GCS verify per release fetches in full only keys that release first publishes ($0.92 for a whole-genome ingest) and checks reused keys by HEAD.
- **Cloud CDN:** cache egress $0.08/GiB ([cdn-pricing]) plus about $18.25 a month standing ([lb-pricing]); break-even about 570–920 GiB a month (D11). **P4 API:** inside Cloud Run's free tier at bounded sizes, under a spend cap.

## 9. Terms and licensing

**Conclusion: every source published may stay free; none of the restricted or unchecked ones may be charged for on any door; the whole-genome table's sources are all open.**

| Source (objects) | Recorded terms | Free (our buckets, mirror) | Google-billed (Tiers 1–2) | Prepaid (Tier 3) | Sponsor mirror |
|---|---|---|---|---|---|
| gnomAD HGDP + 1KG (whole-genome lookup set) | `explicitly_open`: primary data CC0 ([gnomad-terms]); users "agree to not attempt to reidentify participants"; no "gnomAD" in a tool's name; counts only, since some annotations are CC BY-NC (SpliceAI) | yes | yes | yes | yes |
| AFND (113; on 89.2% of today's bytes) | `no_restriction_found` (#117, policy #149); no licence | yes | yes | D9 | needs licence or permission (D12b) |
| MAP (20) | `no_restriction_found`: survey data unrestricted, cite sources ([map-policy]); MAP's maps CC BY 3.0 | yes | yes | D9 | ask MAP (D12b) |
| CPIC (10) | `no_restriction_found`, CC0-1.0 | yes | yes | yes | yes |
| ClinVar (6) | `no_restriction_found`; attribution asked; no licence recorded | yes | yes | D9 | once licence recorded |
| GeneReviews (6, links) | `restriction_found` (= `restricted`), `non_commercial` | yes | **never** | **never** | **never** (AWS excludes "Licenses that limit commercial use", [aws-odp]) |
| WorldPop (62; on 85.8% of bytes) | `explicitly_open`: hub's CC BY 4.0 statement ([worldpop]; D5b, evidence PR) | yes | yes | yes | yes |
| genomeos (103) | `explicitly_open`: CC BY 4.0 (D5a); Apache-2.0 covers code | yes | yes | yes | yes |

- **Linked, never ingested** (terms as found 2026-10-19; kept in the research note, since nothing of theirs is published): 1000G and IGSR, HGDP from Sanger (Fort Lauderdale; no licence; samples already in gnomAD's subset); ALFA (no re-identification of "any individual or group"); MCPS (licence forbids redistribution, sale and crawling: link only); IndiGen (academic use); GenomeAsia (unchecked: site unreachable); AADR (CC0, hg19); PGG.SNV (no terms).
- **Derived objects** carry the union of their inputs' sources, so `catalog/`, `meta.release_objects` and `meta.sources` carry every source, GeneReviews included: free everywhere, off the paid doors and AWS Open Data unless GeneReviews links are split out. The whole-genome table's inputs are only the gnomAD recount and the HGDP + 1KG registry rows; a test fails if another source enters its union.
- **Charging.** In Tiers 1–2 Google bills its own customer and we receive no money; this design still treats Google-billed doors as charging (D2c). None of this reopens #66.
- **Vocabulary:** the manifest's `restriction_found` differs from `commercial_use.py`'s `restricted`, and any non-empty status passes today; step 1.3 closes this. `non_commercial: true` is authoritative whatever the status.
- **Attribution** from the manifest's `sources` block appears on every door. **All of Us** data is never served (AGENTS.md).

## 10. What we deliberately do not use, and why

| Option | Why not |
|---|---|
| Hourly database servers | Idle bills, and none serves the public without an API we would run: Cloud SQL from about $7.67 a month ([sql-pricing]); AlloyDB from about $114 ([alloydb-machines]); Bigtable about $468–475 "even if your cluster is inactive" ([bigtable-pricing]). |
| BigQuery for lookups, or as external or Iceberg tables | Lookups need no warehouse; an account per query; external wildcards need `storage.objects.list` ([bq-external]); Iceberg managed tables garbage-collect the bucket's files ([bq-iceberg]). |
| A per-population copy; an unbounded whole-genome view | Scans are unsupported (owner, 2026-10-19); 24–31 GB more, inviting 4.9 GB scans. |
| gnomAD's published counts or API, or the phased panels, as the source | 78 merged labels; the API is rate-limited and drops zero-count populations; phasing fills genotypes. |
| Re-hosting gnomAD's VCFs; one web JSON per variant | 3.3 TiB, cited instead (D17); $769 of upload operations per publish. |
| Requester Pays on the free buckets; SQL on the web bucket | Breaks anonymous lookups; gzip transcoding makes GCS ignore `Range` ([gcs-transcoding]). |
| DuckLake, Cloud CDN, a login wall, own payments, Apigee | A persisted data path cannot change ([ducklake]); $18.25 a month standing (D11); friction that disqualifies AWS Open Data; nothing to sell yet; $365 a month. |

## 11. Build steps

PR-sized, in dependency order; every rule gets a hard-error test. A PR that publishes stays a draft until the owner has uploaded its release and the anonymous `--verify-remote` and smoke test pass (data store design §10). Agents write and test code; uploads, provisioning and tokens are the owner's (§1.5).

**Phase 1: start now.** Approving this spec approves the §2.3–2.4 and §2.10 layouts as v1; later changes come as a v2 beside them. Phase 1 ships as two releases: 1.4–1.6 (re-encodings of published bytes), then 1.7–1.12.

| # | PR | Who runs it | Gate or check |
|---|---|---|---|
| 1.1 | Land the fit-input PR (`data/fit-inputs`, with the KIR fix `228ea54`) | agent | no KIR artifact released before it |
| 1.2 | Commit this spec and copy its evidence to `docs/research/2026-10-18-atlas-data-platform/`; freeze `contract/tables/*.v1.schema.json`, with separate contracts for `measured.allele_observations` (17 stored columns) and `measured.allele_observations_binned` (16 + `pos` + `source_label`); `.sql`, `.duckdb` in `MEDIA_TYPES`; `tables`, `catalog` in `INCLUDE`; widen `_SEGMENT`; empty `WITHDRAWN.json`; a `needs-human-decision` issue for §1.2 | agent | `scripts/check_private_files.py` passes; no local paths, accounts or project ids |
| 1.3 | Close the terms vocabulary (legacy `restriction_found` read as `restricted`); evidence PRs for D5a (genomeos CC BY 4.0) and D5b (WorldPop) | agent | unknown status fails |
| 1.4 | `meta` tables (`genomeos/tables/meta.py`, `scripts/build_tables.py`); served = the web catalog's 30 | agent | |
| 1.5 | `inferred.artifacts` and the first `cells_by_cell` epoch (61 artifacts, about 170 MB) | agent; owner uploads | count, checksum, `measurement`; every artifact has `fit_input_evidence` |
| 1.6 | Catalog in two passes (`access = open`, no `hosts`); `evidence.parity_observations` | agent; owner uploads | two builds match; DuckDB 1.2.x and pinned DuckDB-WASM attach; golden counts |
| 1.7 | P0 population registry under `tables/v1/reference/`, the 80 HGDP + 1KG identities included | agent; owner uploads | anti-join empty; `afnd-2026-08` rebuilt from the released raw file; MAP as legacy alias rows |
| 1.8 | Raw harvests (#472), each new source with a recorded terms entry (gnomAD HGDP + 1KG included) | agent; owner uploads | sources rule; R4–R7 |
| 1.9 | Measured tables for the curated ingests, in the same release as their raw inputs; legacy `web-json-match` rows (§2.8) | agent; owner uploads | every ingest input is a manifest key; rows match the web JSON on counts, coordinates, radius and ascertainment fields |
| 1.10 | Web observations JSON as a projection of fit input + registry, only for artifacts released with a fit input; adds `population_id`, `rsid`, `source` and a required `measurement` (web-format MINOR) | agent; owner publishes | digest check; existing web JSON never regenerated |
| 1.11 | Artifact format 2.1 for new artifacts | agent | |
| 1.12 | Safe model export (#471) to `store/models/<artifact-id>/` | agent; owner uploads | no pickle; a release's models within the guard, or a lookup set by PR |
| 1.13 | Browser SQL: `Content-Range`, `Accept-Ranges` in `deploy/data-store-cors.json`; a "Query in your browser" panel with pinned DuckDB-WASM on GCS | agent; owner applies CORS | ranged GET 206; range reads, or the P4 fallback decided; h3 WASM loads ([h3-desc]) |
| 1.14 | Read-only cost report (`scripts/cost_report.py`): sent bytes per bucket from Cloud Monitoring, or a billing export; a monthly `needs-human-decision` check against each trigger | agent writes; owner runs | every trigger here is stated in its terms |
| 1.15 | `docs/data-access.md`, leading with lookups: URLs, quickstarts, offline mode, citing, takedowns, brake and kill-switch behaviour, audit-log note; fix `docs/cost-controls.md`'s stale cache line | agent | |

**Phase 2: query-first access and the whole-genome lookup table.**

| # | PR | Blocked by | Who runs it | Gate or check |
|---|---|---|---|---|
| 2.1 | Access rule and manifest schema v2 with `lookup` (`access_policy.py`, builder, CI recompute) | D1c | agent | each rule branch tested (§4.2); 2026-10-18 rebuilds as 248 `open` |
| 2.2 | Query-first `fetch_data.py`: listing with no selection; `--prefix`, `--table` with `--where`, `--set`, `--urls`; bulk refused from free hosts; runbook `--set all`; missing-path refusal | builder's call 28 | agent | loopback tests; no selection downloads nothing |
| 2.3 | `fetch_data.pyz` on each GitHub release | 2.2 | agent | standard library only |
| 2.4 | Tier-aware `fetch_data.py` (§3.2) with explicit credentials (§5) | 2.1 | agent | no token printed; uncommitted host refused; default credentials ignored |
| 2.5 | Lookup bucket and brake: `provision_lookup_bucket.py`; an alert on its sent bytes that triggers a function making only that bucket private; CORS for range reads | D16 | agent writes; owner provisions | drill on a test bucket; the function refuses the data and web buckets by name |
| 2.6 | Whole-genome ingest in its own module: the D18 recount streamed in 20 Mb jobs (native bcftools count, `+check-ploidy` audit, the karyotype and PAR rules, every hard error of D18), per-bin writer and validation, the binned contract, refusal counts, derived ids, its own `cohort_id`. It retires the fitted-and-curated assumption wherever it lives: `genomeos/observations/sources/gnomad_hgdp_1kg.py` (pandas over one TSV, `COHORT_ID` `gnomad-v4-hgdp-1kg`); `scripts/build_observations.py`, which requires `--gnomad <TSV>` and calls `gnomad.load(...)` unconditionally; `tests/test_gnomad_source.py`; `tests/test_build_scripts.py`; and AGENTS.md's end-to-end rebuild command (`--gnomad tests/fixtures/gnomad_hgdp_1kg_freqs.tsv`). The TSV route stays as the fixture-backed curated path, `--gnomad` becomes optional, and published whole-genome rows come only from the recount (builder's call 36) | D18 to release; code starts now, the sample stage a parameter | agent | the chr21 and chr2 windows rebuild; chrX PAR, chrX non-PAR, chrY and indel-rich windows; rs334; the pilot's hand controls plus new ones for indels, haploid calls, XX on chrY and each hard error; the independent counter matches cell for cell |
| 2.7 | Catalog macros (`measured.variant`, `inferred.surfaces`), URL computation over the recorded chromosome set only, `tables.json` listing, check 12 | 2.6 | agent | attach ≤ 0.6 MB; a lookup ≤ 300 KB and ≤ 15 requests on a 3,102-file test tree; `chrM`, `hla:` and `kir:` ids compute no URL |
| 2.8 | Whole-genome release: 166 jobs of 20 Mb, resumable per bin; owner uploads to the lookup bucket; anonymous smoke | D1c, D16, D17, 2.1, 2.5–2.7 | agent runs (no credential); owner uploads | check 12; throughput, sizes and the row count re-measured on the first jobs |
| 2.9 | Website variant lookup: one variant's observations across populations from the lookup bucket by range, or the P4 API; a layer separate from surfaces; gnomAD and Ensembl links | 1.13, 2.8 | agent; owner publishes the web | ranged reads in the browser; observations and surfaces never in one layer |

**Phase 3: on triggers; owner steps first.**

| # | PR | Blocked by; trigger | Checks |
|---|---|---|---|
| 3.1 | BigQuery: owner creates the project and a loader account (Data Editor on the dataset only); `provision_bigquery_public.py`, `publish_bigquery.py`; physical storage billing; budget; 1-day log retention | D2a, D2c, D6a; a genome-wide use case | terms gate on every load; announce only after a separate sandbox account queries it |
| 3.2 | Bulk bucket: `provision_bulk_bucket.py` (owner step); server-side copies of chargeable lookup sets; `publish_data_store.py` routes by `hosts` | the first bulk request, or the first `at_cost` or R6 object | DuckDB sends `x-goog-user-project`; trial credits |
| 3.3 | Kill switch "pay your own way": Requester Pays on at 150%; `setIamPolicy` swapped for `storage.buckets.update` (owner step) | D7; after 2.4 and 3.8 | drill on a test bucket |
| 3.4 | Scale-up: AWS Open Data, Google public datasets ("Google pays for the storage", [bq-public]), `mirror_release.py`, optional Zenodo DOI | D12a, D12b | Zenodo: 50 GB and 100 files per record ([zenodo-size]), so bundle |
| 3.5 | Website cost fix: R2, or Cloud CDN | D11 | measure object sizes |
| 3.6 | Compaction past 16 epochs; schema v3; `reference.grid_cells` after #472; bounded P4 API | D14; D10 | older catalogs stay readable; P4 spend cap |
| 3.7 | Posterior draws as a lookup set under `store/draws/` | D13 | no selection or set includes them whole |
| 3.8 | Free mirror: `ZERO_EGRESS_HOSTS`; C8 amended; `sync_store.py push-release`; `--source auto`, 429 backoff; CI verifies against it | D3 | owner creates the HF dataset and scoped token; loopback tests per host; HF asked about tens of GB |

**Phase 4: the prepaid door,** triggered by the first scheduled `at_cost` object. 4.1–4.3 handle no money and need D6b and D8a; 4.4 needs D8b, D8c and D9; the allowance waits for D8d; 4.5 needs D8e. **4.1** Broker core on Cloud Run: pure `genomeos/access/{pricing,ledger,quota}.py`, 15-minute V4 signed URLs via IAM signBlob (no stored key), idempotent debits, a spend cap; it first tests signed URLs on the Requester Pays bucket and under the kill switch. **4.2** CLI sign-in. **4.3** Account page. **4.4** Payments behind a flag. **4.5** Teams and invoices. **4.6** Reconciliation alert outside 95–105%.

## 12. Risks

1. **The data bucket's brake is all-or-nothing and late:** at 150% it goes private for everyone, hours after spend crosses it. Mitigations: query-first fetching with no default, the guard, the separate lookup bucket with a brake in minutes (D16), the mirror trigger (D3), the monthly report.
2. **The web bucket is outside every brake and the rule** (§8, D11).
3. **Crawlers on the lookup bucket:** anyone can script the 3,102 URLs in `tables.json` ($0.92 a crawl); the brake stops the bucket at 20 GiB a day, pausing lookups until the owner restores it or a mirror (D3) serves them. At 10 times the 100x traffic the brake trips on ordinary days (D16).
4. **Counts that differ from gnomAD's browser** (v4, another sample set): `cohort_id` names ours, and the website explains and links the browser. **Relatedness:** the 4,094 include 1,294 reported pairs; dependence is handled on the fitting side, never by editing observations.
5. **Extrapolated sizes, build time and an upstream that can change:** genome figures rest on two autosomal windows and three small recount windows, and build time on a laptop; step 2.8 re-measures on its first jobs. gnomAD's files are pinned by generation and md5, with the AWS copy recorded as a second source.
6. **Proof and drift:** remote reads are not hash-checked, project Editors can still overwrite or delete, and derived copies can drift; offline mode, the smoke tests and the equality gate are the proof paths, and citations resolve to the canonical artifact.
7. **DuckDB coupling:** a young view-only pattern, URL-building macros, unverified WASM range reads; `catalog.sql` and `tables.json` keep plain Parquet usable. Researchers' SQL can include `unknown` or `prior_dominated` cells or swap latitude and longitude; macros guard and docs warn.
8. **Growth:** each whole-genome ingest adds 3,102 objects and about 1.3 MB of manifest (estimate); schema v3 (D14) bounds it.
9. **Friction for bulk:** without cloud billing a researcher cannot take the whole table until the prepaid door exists; lookups and gnomAD's own files cover them meanwhile.
10. **Permanent mistakes:** R1 makes `open` permanent and the v1 layouts freeze, so both are reviewed in the release PR.
11. **Privacy and Tier 3:** audit logs record queriers, so retention is short; the door has no seller yet, and merchant review could refuse "data" products.

## 13. Builder's calls

Settled by the builder; each can be reversed by a PR.

1. Phase-1 catalogs write `access = open`, no `hosts` (added in 2.1 as a `tables.json` MINOR); check 7's access clause starts at 2.1.
2. Offline mode works from any named download (`--prefix tables/` until 2.2 adds `--table` and `--set`).
3. The smoke tests run on `evidence.parity_observations` from step 1.6 and on rs334 from 2.8.
4. `meta.release` names the manifest key, not its sha256; two-pass build (§2.6).
5. `_SEGMENT` accepts `=` after the first character, still refusing `%`, `+`, `:`; registry folders are `<release>-<sha8>`, except the two legacy registries' (call 18).
6. The changed-bytes refusal extends to `epoch=`, `ingest_version=`, `chrom=` and `bin=` parts; summary tables are re-keyed by design.
7. Served = the 30 artifacts in the web `catalog.json` until the refit pin lands; `WITHDRAWN.json` starts empty.
8. Legacy fit-input evidence: `web-json-match` only where web JSON and a published ingest exist, else `none` (§2.8).
9. Step 1.10 keeps `ac`/`an` with a required `measurement` (MINOR).
10. Takedowns rebuild affected parts into a new epoch or ingest version (§2.9).
11. CI verifies against the mirror once 3.8 exists; the per-release GCS verify fetches only new keys in full.
12. Phase-3 triggers are stated in the cost report's terms (1.14).
13. Models, raw harvests and draws get the §2.3 folders; models join `OPEN_CLASSES`; draws join `LOOKUP_SETS` only once D13 is approved, and nothing is published under `store/draws/` before; raw harvests stay under the size rule.
14. Step 1.2 copies the evidence and checks it for private paths and ids.
15. Pin `duckdb==1.5.5`, write `STORAGE_VERSION 'v1.2.0'`, test attach from DuckDB 1.2.x and the pinned WASM, build with `threads = 1`.
16. Derived sources are the computed union of inputs'; a test checks a `non_commercial` flag survives.
17. `catalog.sql` is in git; `atlas.duckdb`, `tables.json`, `tables/` are not; the bulk bucket joins `COMMITTED_PUBLIC_URLS` in 3.2, the lookup bucket in 2.5.
18. Check 5 keeps MAP's coordinates exception; `afnd-2026-08` is rebuilt from the released raw file; `map-survey-coordinates-v1` becomes legacy alias rows; each keeps its name as its registry folder.
19. R1 matches by path; CI recomputes each manifest under its own `access_policy`.
20. Credentials only with `--billing-project` and a named token source (§5).
21. A mirror hash mismatch falls back loudly with a non-zero exit (§3.2).
22. `cells_by_cell` carries `measurement` and `artifact_format` (§2.4).
23. BigQuery tables, if built, are `measured_*` and `inferred_*` (§3.4).
24. Firebase config and signer email are injected at build time.
25. Uploads, web publishes, CORS changes, bucket provisioning and HF pushes are owner steps.
26. Least privilege: the publisher account, a BigQuery loader with Data Editor on one dataset, an HF token for one dataset, a brake function that can only remove public members from the lookup bucket.
27. A BigQuery table path, if built, reaches `latest.json` from a GitHub variable.
28. **`fetch_data.py` has no implicit "everything" default.** With no selection it lists what is available and how to query it; every download names what it wants (`--prefix`, `--table` with a filter, or `--set`); the docs lead with querying. Reason, in the owner's words: "why would we need to pull the entire database each time? isnt the idea to query the database and pull just what's needed?" This supersedes D3b.
29. Lookup sets: 1 Mb bins over the ingest's recorded chromosome set (chr1–22, X and Y for gnomAD), every bin file written; no `nonlocus` bin, since ids with no locus live in curated ingests; sort `(pos, ref, alt, population_id)`, 122,880-row groups (overriding §2.5's 8,192 for them only, which measured 47% larger with 7 times the bytes per lookup).
30. The gnomAD ingest derives `source_record_id` in the lookup macro from a recorded template (8.2 GB instead of 30.3 GB); sources whose ids are not derivable keep them stored.
31. Lookup sets are reached by URL-building macros that compute a URL only for the recorded chromosome set; any other id (`chrM`, `hla:`, `kir:`, `phenotype:`) reads curated rows only; no view lists their files; `tables.json` lists every one; check 7 enumerates every computable URL.
32. A cell with `an = 0` is not an observation: counted per population in `measured.ingests`, never written and never silent; non-PASS sites likewise. Any other schema violation stops the build.
33. No per-population copy and no genome-wide view: genome-wide and whole-population scans are unsupported (owner, 2026-10-19: "we only need to look up data for one variant at a time").
34. Lookup sets are outside the release guard; the lookup brake bounds them.
35. BigQuery leaves the needed-now path; step 3.1 waits for a genome-wide use case.
36. The curated gnomAD TSV route stays, fixture-backed: `gnomad_hgdp_1kg.load` keeps serving the tests, AGENTS.md's rebuild and the fits released with it, under a `COHORT_ID` naming the count set its TSV holds; `scripts/build_observations.py` takes `--gnomad` as optional from step 2.6; published whole-genome gnomAD rows come only from the recount module, under its own `cohort_id`, so a lookup shows which count set each row is from.
37. The lookup set is its own table, `measured.allele_observations_binned`, with its own prefix and frozen contract; the curated `measured.allele_observations` keeps its 17 stored columns (§2.4).
38. The whole-genome build runs in 20 Mb jobs (166), resumable per bin, counting with native bcftools (`+setGT`, `+fill-tags`, `+check-ploidy`); the Python counter is the independent check on sampled bins (§2.10).

## 14. Evidence

**2026-10-18, local, read-only:** DuckDB 1.5.5, pyarrow 25.0.1, h3 4.5.0 over a local copy of release 2026-10-18 behind a byte-logging `Range` server, caches off: 61 `cells.parquet` (266,415,953 B); one Lagos cell across 31 res-4 surfaces read 136.7 MB today, 0.32 MB partitioned; a catalog attach read 548,868 B. Live buckets (anonymous curl): `Range` GET 206; listing refused; a gzip-stored web object ignored `Range`.

**2026-10-19, no credentials** (`wg/obs-layout/`, `wg/counts-sources/`, `wg/costs-tiers/`, `wg/decisions/`, copied in 1.2): bcftools 1.21 streamed gnomAD HGDP + 1KG regions over anonymous HTTPS (chr21:25–27 Mb, chr2:100–101 Mb, chr22:20.00–20.01 Mb, chr11:5.20–5.25 Mb); dense, sites and phased VCF headers; HEAD sizes of the 24 dense VCFs (3,631,210,123,548 B) on GCS and AWS; gnomAD API and Ensembl REST for rs334; DuckDB 1.5.5 layouts queried cold; a synthetic 12M-row cross-check (2.51 B/row at 122,880-row groups, consistent). Prices fetched the same day. One step made a single anonymous GET to a missing path in the production data bucket (a 404); no cloud command was run.

**2026-10-19 check, no credentials** (`wg/apply-checks/`, copied in 1.2): anonymous bcftools 1.21 streams of chr11:5.20–5.25 Mb, chrX:100.0–100.1 Mb, chrX PAR windows at 1.00–1.01 Mb and 155.80–155.81 Mb, chrY:14.0–14.1 Mb and both chrY PARs (0 records); karyotypes and hard filters from `gnomad.genomes.v3.1.2.hgdp_1kg_subset_sample_meta.tsv.bgz`; a Python recount and native bcftools (`+setGT`, `+fill-tags`, `+check-ploidy`) under D18's rule on a 4,097-sample stand-in stage, agreeing on 592,484 cells; timings on an Apple M3 Pro (12 cores, 18 GiB); compressed spans from the tabix indexes (the chr22 window's start offset reproduces the pilot's); layouts re-measured with `source_label` and like-for-like recount and INFO rows; a 3,102-URL catalog attached over a byte-logging Range server; the PARs of Hail 0.2.77's GRCh38 reference (the callset's `hailversion`); gnomAD's adj defaults; GitHub's Actions limits; HF's rate-limit buckets; Monitoring's alerting charges and BigQuery's storage rates re-read from saved pages. As in the pilot, step 1.2 copies scripts and aggregate outputs only: the local genotype windows (`wg/apply-checks/dl/`) and the sample lists are never copied or uploaded, and per-sample genotype and ploidy listings were deleted after counting.

**Manifest** (`data/releases/2026-10-18.json` at `e1706b4`): 248 objects, 271,494,507 B. **Code read:** `data/fit-inputs` (`f233e69` to `228ea54`); `scripts/{build_data_release,fetch_data,export_atlas_web,provision_data_store_bucket}.py`; `genomeos/observations/{schema,sources/gnomad_hgdp_1kg,sources/wbbc}.py`; `docs/{data-store,cost-controls,map-spatial-support}.md`; `docs/research/hgdp-count-pilot-2026-09-09.md`.

## Appendix A. How this design was produced

**Origins.** Two designs per topic were judged and fact-checked (91 claims: 77 confirmed, 9 unclear, 5 refuted; every correction is in the body). Data structure B (researcher-first tables, view-only catalog) won; access tiers B "recovery" won, taking the 1 GiB free line, terms allowlist, prepaid door and sponsor trigger from the others.

**Revision 2026-10-19.** The owner's answers and clarifications were applied through three research angles (sources and terms, layout, costs); real-data measurements were preferred over synthetic ones where they differed. Changes: the whole-genome lookup set (§2.10); `lookup` access and D1c; BigQuery, the per-population copy and the mirror off the needed-now path; builder's call 28 replacing D3b; D16–D18; costs re-derived for lookups. A review check the same day (2 blockers, 5 important, 8 minor findings) led to D18's rule being stated in full (indels, multi-allelic records, PARs and haploid calls, measured on chrX and chrY), D1c's whole-file line restored for `OPEN_CLASSES` and single lookup-set files, `store/draws/` held out of `LOOKUP_SETS` until D13, the binned table given its own name and contract, sizes re-measured with `source_label` (8.2 GB), the build split into 20 Mb jobs on measured throughput, the 10x costs and brake margin corrected, and smaller citation fixes (BigQuery, Monitoring, HF, the catalog probe, check 12, chrM).

## Appendix B. Terms

- **Bucket, object, project, egress:** a Cloud Storage container; a file in it; a Google Cloud unit carrying a billing account; data sent to the internet.
- **Lookup, lookup set, bin, bulk:** a read of one variant's rows; files read one variant at a time, free that way and one file at a time, bulk when pulled whole; a 1 Mb slice of a chromosome; a whole-set download (or a selection over 1 GiB), paid by the downloader.
- **Indel, MNP, ALT:** an insertion or deletion; several adjacent bases changed at once; the alternate allele a row counts.
- **PAR, haploid call, karyotype:** the pseudoautosomal regions at the ends of X and Y, inherited like autosomes; a genotype of one allele (XY samples on X and Y outside the PARs); the sex chromosomes gnomAD inferred for each sample.
- **Requester Pays:** the downloader's project pays for transfer. **Kill switch, brake:** makes the data bucket private at $300 of monthly spend; makes the lookup bucket private past its daily bytes.
- **Mirror, zero-egress host:** an identical copy on a host whose downloads cost us nothing; a sponsor pays for a sponsor mirror. **Sandbox:** BigQuery's no-card mode.
- **Parquet, row group, DuckDB, catalog, manifest:** a column table format; an independently readable chunk of one; a free SQL engine; the per-release index of tables; the committed list of published files with sha256s.
- **H3, res 4, served set:** the surfaces' hexagonal grid; its finer level; the version per variant the Atlas shows.
- **`CHARGEABLE`, C8, P0, P4, broker:** terms that may be charged for; the rule that `fetch_data.py` downloads only from committed URLs; the population registry; the planned lookup service; the prepaid seller.

## Sources

Main claims are linked inline; every other figure is cited claim by claim, with its verdict, in the fact-check files and the 2026-10-19 research notes.

Google Cloud: [gcs-pricing] [free-tier] [gcs-iam] [gcs-transcoding] [gcs-metrics] [mon-pricing] [budgets] [rp] [rp-use] [cdn-pricing] [lb-pricing] [bq-pricing] [bq-public] [bq-sandbox] [bq-external] [bq-iceberg] [bq-iam] [audit-logs] [spend-caps] [invoiced] [waiver] [idp-pricing] [sql-pricing] [alloydb-machines] [bigtable-pricing] · DuckDB: [duckdb-https] [duckdb-attach] [duckdb-viewonly] [duckdb-hive] [duckdb-storage] [ducklake] [h3-desc] [wasm-1367] · Genomics: [koenig2024] [gnomad-downloads] [gnomad-hgdp-help] [gnomad-terms] [gnomad-adj] [hail-grch38] [aws-gnomad] [ensembl-rest] · Mirrors: [hf-pricing] [hf-rate] [hf-storage] [hf-7931] [aws-odp] [zenodo-size] · Payments and terms: [stripe-pricing] [stripe-mp] [stripe-mp-elig] [paddle] [eu-oss] [orcid] [map-policy] [worldpop] · GitHub: [gh-runners] [gh-limits]

[gcs-pricing]: https://cloud.google.com/storage/pricing
[free-tier]: https://docs.cloud.google.com/free/docs/free-cloud-features
[gcs-iam]: https://docs.cloud.google.com/storage/docs/access-control/iam-roles
[gcs-transcoding]: https://docs.cloud.google.com/storage/docs/transcoding
[gcs-metrics]: https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z
[mon-pricing]: https://cloud.google.com/stackdriver/pricing
[budgets]: https://docs.cloud.google.com/billing/docs/how-to/budgets
[rp]: https://docs.cloud.google.com/storage/docs/requester-pays
[rp-use]: https://docs.cloud.google.com/storage/docs/using-requester-pays
[cdn-pricing]: https://cloud.google.com/cdn/pricing
[lb-pricing]: https://cloud.google.com/load-balancing/pricing
[bq-pricing]: https://cloud.google.com/bigquery/pricing
[bq-public]: https://docs.cloud.google.com/bigquery/public-data
[bq-sandbox]: https://docs.cloud.google.com/bigquery/docs/sandbox
[bq-external]: https://docs.cloud.google.com/bigquery/docs/external-data-cloud-storage
[bq-iceberg]: https://docs.cloud.google.com/bigquery/docs/iceberg-tables
[bq-iam]: https://docs.cloud.google.com/bigquery/docs/control-access-to-resources-iam
[audit-logs]: https://docs.cloud.google.com/logging/docs/audit/configure-data-access
[spend-caps]: https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps
[invoiced]: https://docs.cloud.google.com/billing/docs/how-to/invoiced-billing
[waiver]: https://docs.cloud.google.com/billing/docs/how-to/data-transfer-waiver
[idp-pricing]: https://cloud.google.com/identity-platform/pricing
[sql-pricing]: https://cloud.google.com/sql/pricing
[alloydb-machines]: https://docs.cloud.google.com/alloydb/docs/choose-machine-type
[bigtable-pricing]: https://cloud.google.com/bigtable/pricing
[duckdb-https]: https://duckdb.org/docs/current/core_extensions/httpfs/https
[duckdb-attach]: https://duckdb.org/docs/current/guides/network_cloud_storage/duckdb_over_https_or_s3
[duckdb-viewonly]: https://duckdb.org/2026/10/07/view-only-mode
[duckdb-hive]: https://duckdb.org/docs/current/data/partitioning/hive_partitioning
[duckdb-storage]: https://duckdb.org/docs/current/internals/storage
[ducklake]: https://ducklake.select/docs/stable/duckdb/guides/using_a_remote_data_path
[h3-desc]: https://raw.githubusercontent.com/duckdb/community-extensions/main/extensions/h3/description.yml
[wasm-1367]: https://github.com/duckdb/duckdb-wasm/issues/1367
[koenig2024]: https://pmc.ncbi.nlm.nih.gov/articles/PMC11216312/
[gnomad-downloads]: https://raw.githubusercontent.com/broadinstitute/gnomad-browser/main/browser/src/DataPage/GnomadV3Downloads.tsx
[gnomad-hgdp-help]: https://raw.githubusercontent.com/broadinstitute/gnomad-browser/main/browser/help/topics/hgdp-1kg-annotations.md
[gnomad-terms]: https://raw.githubusercontent.com/broadinstitute/gnomad-browser/main/browser/about/policies/terms.md
[gnomad-adj]: https://github.com/broadinstitute/gnomad_methods/blob/main/gnomad/utils/annotations.py
[hail-grch38]: https://github.com/hail-is/hail/blob/0.2.77/hail/src/main/resources/reference/grch38.json
[aws-gnomad]: https://registry.opendata.aws/broad-gnomad/
[ensembl-rest]: https://github.com/Ensembl/ensembl-rest/wiki/Rate-Limits
[hf-pricing]: https://huggingface.co/pricing
[hf-rate]: https://huggingface.co/docs/hub/en/rate-limits
[hf-storage]: https://huggingface.co/docs/hub/en/storage-limits
[hf-7931]: https://github.com/huggingface/datasets/issues/7931
[aws-odp]: https://aws.amazon.com/opendata/faqs/
[zenodo-size]: https://support.zenodo.org/help/en-gb/1-upload-deposit/80-what-are-the-size-limitations-of-zenodo
[stripe-pricing]: https://stripe.com/pricing
[stripe-mp]: https://stripe.com/managed-payments
[stripe-mp-elig]: https://docs.stripe.com/payments/managed-payments/eligibility
[paddle]: https://www.paddle.com/pricing
[eu-oss]: https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en
[orcid]: https://info.orcid.org/public-client-terms-of-service/
[map-policy]: https://malariaatlas.org/open-access-policy/
[worldpop]: https://hub.worldpop.org/
[gh-runners]: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
[gh-limits]: https://docs.github.com/en/actions/reference/limits
