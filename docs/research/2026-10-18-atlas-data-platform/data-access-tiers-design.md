# genomeOS Atlas: data access tiers, identity and billing

**Status:** recommendation for the owner. Nothing here is built.
**Date:** 2026-10-18.
**Inputs:** three independent designs (the "friction", "recovery" and "leverage" angles), two research passes (GCP mechanisms; peer providers and patterns), and a read-only look at `origin/main` (release manifest `data/releases/2026-10-18.json`, `docs/data-store.md`, `docs/cost-controls.md`, the data store design 2026-10-17, `genomeos/publication/{data_release,commercial_use}.py`, `scripts/{fetch_data,build_data_release,sync_store}.py`, `deploy/data-store-cors.json`).
**Scope:** the access, identity and billing layer, and where the free/paid line falls. A parallel design is choosing the storage and query layer. This document assumes Parquet/GeoParquet files on GCS stay the source of truth, with a SQL layer such as BigQuery or DuckDB over them. Section 10 lists what this design needs from that one.
**Method note:** no cloud commands were run and no resources were created. Every price or feature claim carries a source URL. Appendix A says which pages were re-read on 2026-10-18 and which figures come from the input research, which read the same pages on the same day.

---

## 1. Summary in plain language

**Everything published today stays free, with no account, exactly as it is now.** The website, plain links, `scripts/fetch_data.py` and DuckDB over the Parquet all keep working with no sign-in. The release builder will enforce this promise, not just document it.

**The free/paid line follows what a download costs us, not what the data is.** An object is free if it belongs to one of today's kinds of data, if one download costs us 12 cents or less (1 GiB at Google's $0.12/GiB), or if a mirror that costs us nothing carries it. Only large objects that would put real money on our bill are "at cost". Data whose terms are restricted, non-commercial or not yet checked is never put behind a payment. It is free, or it is split so the restricted part is free, or it does not ship.

**At first, the paid door is Google's, not ours.** At-cost files go in a separate "Requester Pays" bucket. SQL goes in a public BigQuery dataset. In both, the login is the user's Google account, and Google bills the user's own Google Cloud account, or their lab's, at list price. We take no money, keep no user accounts, issue no invoices and register for no sales tax. That is "just enough to recoup", by construction.

**SQL is free for almost everyone.** It runs in the browser or in DuckDB over the free files, reading only the bytes a query needs. Or it runs in BigQuery, where the person querying pays, the first 1 TiB a month is free, and the sandbox needs no card.

**The weak spot is a researcher with no Google Cloud billing who needs a big at-cost file.** For them, this document fully specifies a prepaid door: one GitHub or Google sign-in, a $10 card top-up, every charge quoted first, and access that stops at zero, so there is never a bill afterwards. We build it when two things are true: the first at-cost object is about to ship, and the owner has named the legal seller. Before that there is nothing to sell. The rule in this document keeps the at-cost set empty for the foreseeable releases.

**The real budget threat is the free tier becoming popular, not the paid tier.** At 100 times today's traffic, free downloads served only from GCS would cost about $186 a month. One spike would trip the kill switch and take the data offline. Sending `fetch_data.py` to a free mirror first (the existing Hugging Face mirror now, and sponsor programs later) brings that to about $49. It also keeps downloads working if the kill switch fires.

**Cost to us:** about $0 to $3 a month now. About $49 a month at 100 times today's users with the mirror. About $68 a month at 100 times the users and the data with the mirror, and about $338 without it, which is over budget.

**First build:** three repository-only PRs that change nothing a user sees (closing the terms vocabulary, the access rule with manifest v2, and mirror-first fetching), plus a docs PR. The cloud pieces are owner steps, and they ship when they are needed.

---

## 2. Verdict

### 2.1 Scores

Each design was scored from 0 to 10 on each criterion. Higher is better: for cost, higher means cheaper and more predictable; for effort, higher means less work.

| Criterion | A: friction ("open by default, pay at cost by exception") | B: recovery ("Google bills heavy users directly") | C: leverage ("borrow-first: sponsors pay free, users' clouds pay paid") |
|---|---|---|---|
| Friction for a newcomer, and for a researcher with no cloud account | **9.** Anonymous by default. Paying takes one GitHub sign-in and a $10 Apple Pay top-up, and a device code works on pods. | **6.** Newcomers: perfect. At-cost objects need a card, a project and an IAM role. The low 64 MiB line puts that wall in front of cheap objects too. | **7.** As B, but sponsors make more data free. The paid path is still a cloud billing account. |
| Heavy use pays for itself | **8.** Cost plus 11% with quarterly true-up. The allowance pool and free egress are not recovered. | **8.** Exactly Google's list price. Storage and free egress are not recovered. | **8.** As B, and sponsors absorb free egress. |
| Our monthly cost, and how predictable it is | **7.** Prepaid-only issuance in a second project, a mirror, and a capped $50 pool. More moving parts. | **7.** About $0 now. At 100x the free egress (about $62 to $155) is the only variable, and the kill switch is its only brake. | **6.** Lowest if sponsors accept us (about $25 to $60 at 100x). Acceptance is discretionary, and without it the design's own figure is about $596. |
| Build and operating effort for a tiny team | **3.** 14 PRs, a legal seller, a merchant of record, a ledger, device flow, teams and invoices, refunds, support and GDPR, all built while nothing is for sale. | **9.** About 5 to 7 PRs, mostly repository-only. Nothing to run, no money handled. | **6.** 8 PRs plus outreach (AFND, MAP), a dedicated AWS account, several mirrors kept in sync, and multi-host fetching. |
| Compatibility with each source's terms | **7.** The allowlist is sound. But we collect money, and the merchant of record makes us attest that we "hold all necessary rights and licenses to distribute the product" (https://docs.stripe.com/payments/managed-payments/eligibility), which is hard for sources with no licence. | **9.** We never collect money. Restricted and unchecked sources are open-only or a hard error. | **9.** As B, and it is explicit about the licences sponsors need. |
| Fit with today's data store | **7.** Manifest v2 fits well. Mirror-first fetching amends C8 without saying so, and an in-house device-login flow adds a second auth path. | **9.** A tier field, a second bucket, and a standard-library token. Committing the BigQuery project id needs a rule amendment. | **7.** A per-object host list and multi-host fetching widen what `fetch_data.py` trusts (C8). |
| **Mean** | **6.8** | **8.0** | **7.2** |
| Mean with friction counted twice (the owner stressed it) | 7.1 | 7.7 | 7.1 |

**Winner: B, the recovery angle, as the base.** It is the only design a tiny team can ship in full now. It meets "just enough to recoup" exactly, because Google bills its own customer at list price. It touches the current data store least, and it never puts us in the position of selling third-party-derived data. Counting friction twice does not change the result.

**Why not A as the base.** A gives the best experience to a researcher who wants to pay, and Phase 3 below adopts its prepaid door almost unchanged. But as a starting point it builds a payments business (a legal seller, merchant-of-record review, a ledger, refunds, support, privacy compliance) to sell objects that do not exist. Its own rule puts all 248 current objects in the free tier. A also says to build the paid tier only once a metered object exists, and this design takes that as its trigger.

**Why not C as the base.** Sponsor mirrors are the right way to scale the free tier, and they are grafted in below as a trigger-driven track. But C's cost case rests on acceptance that sponsors grant at their discretion, and on licence fixes that cover most of the bytes. WorldPop (`not_checked`) is a source of 62 objects and 85.8% of release 2026-10-18's bytes. AFND (no licence) is a source of 113 objects and 89.2%. The AWS Open Data program accepts only data "usable for any purpose", and excludes "Licenses that limit commercial use (e.g., CC BY-NC)" (https://aws.amazon.com/opendata/faqs/).

### 2.2 What is grafted in, and from where

| Idea | From | Where it lands |
|---|---|---|
| Free line set by cost: ≤ 1 GiB per object (≤ $0.12 a download), so billing never costs more than it recovers | A | §3.2 R4 |
| `CHARGEABLE` as an allowlist, so an unknown status can never be charged | A | §3.2 R5 |
| An object on a zero-egress mirror is free at any size | A | §3.2 R4 |
| Mirror-first `fetch_data.py` with unchanged sha256 checks, so the free tier survives the kill switch | A, C | §3.3, PR 4 |
| The GCS copy of a large, mirror-only free object lives in the Requester Pays bucket, so losing the mirror can never become a budget bomb | C | §3.2, §3.3 |
| The manifest is read only from git or GCS, never from a mirror | C | §3.3 |
| Closing the `terms.status` vocabulary, and the split between `restriction_found` and `restricted` | B, C | PR 2 |
| "Once free, always free", because an immutable public copy can't be withdrawn | B | §3.2 R1 |
| A release guard on free bytes served only from GCS | A, B, C (cap from C) | §3.2 |
| BigQuery in the US multi-region, so users can join with `bigquery-public-data` | B | §3.1 Tier 1 |
| A dedicated public project for BigQuery, because a shared table's path exposes the project id | B | §12 D4 |
| Kill switch "pay your own way" mode: turn Requester Pays on instead of going private | B | PR 10, §12 D6 |
| Browser SQL (DuckDB-WASM) and the CORS change it needs | A | PR 6 |
| A single-file stdlib fetcher (`fetch_data.pyz`) | A | PR 5 |
| No-surprise rules: quote before any charge, `--max-spend`, exit code 3, never postpaid | A | §5, PR 7 |
| The prepaid door: GitHub or Google sign-in, device code, $10 top-ups through a merchant of record, a second project | A | Phase 3, §4–§5 |
| Zenodo DOIs, ATTRIBUTION files beside mirrors, sponsor applications as the scale trigger | C | PR 11 |
| Phase 3 triggers on the first at-cost object, not on a count of complaints | A | §10 |

### 2.3 Corrections to the inputs found while judging

- **WorldPop is not on "every surface".** It is a source of the 62 format-2 artifact objects, out of 122 under `store/artifacts/`. The other 56 artifact objects are AFND-only, and 4 are MAP-only (computed from the manifest).
- **B's 64 MiB line contradicts its own research**, which says to "keep anything under about 1 GB in the free tier". It would also make WorldPop's 1 km grid (about 870 MB, per A) a hard error: the grid is over 64 MiB, sits outside the open classes, and its source is `not_checked`. Under the merged rule it is simply free (R4).
- **C's BigQuery dataset in us-east1 would cut users off from `bigquery-public-data`.** "Single-region locations don't match multi-region locations", and a join across them becomes a global query (https://docs.cloud.google.com/bigquery/docs/locations). Global queries need an opt-in in both the querying project and the data project, plus a permission that only BigQuery Admin holds among predefined roles (https://docs.cloud.google.com/bigquery/docs/global-queries). Public users cannot be expected to set that up.
- **A's mirror-first fetch amends C8**, the rule that the committed URL is the only one `fetch_data.py` accepts (data store design 2026-10-17 §3). A does not say so. The current Hugging Face mirror also sits under a personal account and holds pickled fits (`scripts/sync_store.py`). The mirror for releases should be an org-owned dataset that holds exactly the release keys.
- **A's 10 GiB cap on GCS-only free bytes per release is too loose for $200.** A full free download would cost $1.20. This design uses 2 GiB, which caps a full download at $0.24.
- **Demand-count triggers (B: 5 users a quarter; C: 10) undercount.** A researcher who hits a card-and-project wall usually leaves without filing an issue.
- **Noticed while reading:** `docs/cost-controls.md` still says data-store objects carry `public, max-age=31536000, immutable`. `docs/data-store.md` and data store design §9.6 say `public, max-age=3600` (#473). The cost-controls line looks stale. That is out of scope here, but it affects what "private" means after the kill switch fires.

---

## 3. The tiers and the free/paid rule

### 3.1 Tiers

| Tier | What | Who | How | Cost to them | Cost to us |
|---|---|---|---|---|---|
| **0. Free** (anonymous, for good) | Every object the rule marks `open`. Today that is all 248 objects in release 2026-10-18 (271,494,507 bytes, about 0.25 GiB; the largest is a 7.5 MB `cells.parquet`): registries, sources, `raw/afnd_populations.tsv`, surfaces and their manifests, validation evidence, catalog metadata, the inventory and the manifests. Observation tables join this class when they are published. | Anyone | The Atlas site; `https://storage.googleapis.com/genomeos-atlas-data/<key>`; `fetch_data.py` (standard library, sha256-checked, mirror first after PR 4); `fetch_data.pyz` (PR 5); DuckDB over HTTP range reads, which fetch only the columns and row groups a query needs (https://duckdb.org/docs/current/core_extensions/httpfs/https.html), including `hf://` paths on the mirror (https://duckdb.org/docs/current/core_extensions/httpfs/hugging_face.html) and DuckDB-WASM in the browser (PR 6). | $0 | GCS egress of $0.12/GiB (0–10 TiB) after 100 GB a month of Always Free egress from North America (https://cloud.google.com/storage/pricing, https://cloud.google.com/free/docs/free-cloud-features). $0 for bytes the mirror serves. |
| **1. Free SQL** (Google sign-in) | The Tier 0 tables as native BigQuery tables in the **US multi-region**: one dataset per immutable release, plus `latest` views. | Anyone with a Google account, which can use any email address (https://support.google.com/accounts/answer/27441). | The dataset grants READER to `allAuthenticatedUsers` (https://cloud.google.com/bigquery/docs/control-access-to-resources-iam). The BigQuery console, the `bq` CLI or a client library, from the user's own project. The sandbox needs no "credit card or creating a billing account" (https://docs.cloud.google.com/bigquery/docs/sandbox). An optional free BigQuery sharing listing aids discovery: "There's no additional cost for managing data exchanges or listings" (https://docs.cloud.google.com/bigquery/docs/analytics-hub-introduction). | $0 within 1 TiB processed a month, then $6.25/TiB, with at least 10 MB billed per table referenced (https://cloud.google.com/bigquery/pricing). | Storage only. The first 10 GiB is free, then about $0.023/GiB-month active storage. "The data owner is not charged when their data is accessed" (https://cloud.google.com/bigquery/pricing). |
| **2. At cost, billed by Google** | Objects the rule marks `at_cost`. None exist, and none are foreseen in the next releases (§3.4). Also the GCS copy of any large object that is free only because a mirror carries it. | Any Google identity holding `serviceusage.services.use` (Service Usage Consumer) on a project with billing (https://docs.cloud.google.com/storage/docs/requester-pays). That can be the user's own project, or a role their PI grants on the lab's project. | A separate bucket (proposed name `genomeos-atlas-bulk`) with Requester Pays on, readable by key (no listing). `fetch_data.py --billing-project P` sends `x-goog-user-project`, or `userProject` on the JSON API (https://docs.cloud.google.com/storage/docs/using-requester-pays). `gcloud storage cp --billing-project` also works. | Google list price on their own bill: $0.12/GiB to the internet, $0.02/GiB to another North American region, $0 within us-east1, and Class B reads at $0.0004 per 1,000 (https://cloud.google.com/storage/pricing). | Storage only, about $0.02/GiB-month Standard ("Data storage charges … are always applied to the project that contains the bucket", https://docs.cloud.google.com/storage/docs/requester-pays). |
| **3. At cost, prepaid by card** (Phase 3: designed here, built on the trigger in §10) | The same `at_cost` objects. Later, if the parallel design ships one, metered SQL on a hosted endpoint. | Anyone with a GitHub or Google account. No cloud account needed. | Sign in once, with a device code on pods. Top up at least $10 through a merchant of record. Each request is quoted, then debited, and the user gets a 15-minute signed URL; the bytes come straight from GCS (https://cloud.google.com/storage/docs/access-control/signed-urls). | List cost ÷ 0.89, so $0.135/GiB, which covers payment fees. Nothing more. | Payment fees are covered by the margin. Our only unrecovered spend is the optional allowance pool (at most $50 a month). |
| **Labs** | Tier 2 now, Tier 3 team wallets later. | A PI or research computing group. | Now: the institution's existing Google Cloud billing, through a reseller, Internet2 NET+ or Google invoiced billing (https://docs.cloud.google.com/billing/docs/how-to/invoiced-billing). Later: a prepaid team block bought by invoice. | List price on the institution's Google invoice. The data transfer waiver can cover internet egress up to 15% of the institution's monthly Google Cloud fees (https://docs.cloud.google.com/billing/docs/how-to/data-transfer-waiver). | $0 |

Heavy users and CI can also choose to pay their own way on the **free** bucket: "Buckets that have Requester Pays disabled still accept requests that include a billing project", and the charges go to that project (https://docs.cloud.google.com/storage/docs/using-requester-pays, re-read 2026-10-18). So `--billing-project` works on both buckets.

### 3.2 The rule (applied by the release builder, recorded in the manifest)

A pure module, `genomeos/publication/access_policy.py`, has no HTTP dependency (per AGENTS.md) and cites this design's section. `scripts/build_data_release.py` calls it for every object and writes the result into manifest **schema version 2**:

- a per-object `access` field, `open` or `at_cost`;
- a per-object `hosts` field: the ordered host ids `fetch_data.py` tries;
- a top-level `access_policy` block that copies the constants.

Fetchers, the website and (later) the broker read `access` from the manifest. They never infer it. A v1 manifest reads as all `open`. CI recomputes the access of every committed manifest and fails on any difference.

The rule only decides *which door* a published object goes through. `INCLUDE` and the terms register still decide *whether* it is published.

**Constants.** They are changed only by a reviewed PR, like the kill switch's 150%.

| Constant | Value | Why |
|---|---|---|
| `EGRESS_USD_PER_GIB` | 0.12 | GCS internet egress for 0–10 TiB (https://cloud.google.com/storage/pricing) |
| `OPEN_OBJECT_MAX_BYTES` | 1 GiB | One GCS download costs at most $0.12. The cheapest charge we could ever collect, a $10 card top-up, loses $0.59 to fees (2.9% + 30¢, https://stripe.com/pricing). Billing below this line costs more than it recovers. |
| `OPEN_RELEASE_GCS_MAX_BYTES` | 2 GiB | Caps the cost of one full free download from GCS at $0.24. Today the release is about 0.25 GiB. |
| `OPEN_CLASSES` | `registry/`, `sources/`, `raw/afnd_populations.tsv`, `store/artifacts/`, `store/catalog-metadata.json`, `store/INVENTORY.json`, `validation/`, `manifests/`, plus the observation tables when they publish | The owner's "our current datasets are fine to distribute this way" |
| `CHARGEABLE` | `explicitly_open`, `permission_granted`, `no_restriction_found` | An allowlist. `restricted`, the legacy `restriction_found`, `not_checked` and any status added later are all excluded. |
| `ZERO_EGRESS_HOSTS` | `hf` (an org-owned Hugging Face dataset holding exactly the release keys). Later `aws-odp` or `gcp-public` if accepted. | Hosts whose egress costs us $0 |
| `ACCESS_OVERRIDES` | path prefix → `open`, with a reason and an issue URL | Lets the owner keep something free on purpose. It can only move an object toward `open`. |

**Rules. They are evaluated in order, and the first match wins.**

- **R0 (unchanged).** Pickles and object-dtype `.npy` files are refused.
- **R1 Once free, always free.** If an earlier release published the same key as `open`, the object is `open`. An `at_cost` object may become `open` later. The reverse is never allowed, because an immutable public copy can't be withdrawn.
- **R2 Override.** If an `ACCESS_OVERRIDES` entry matches, the object is `open`.
- **R3 Class.** If the path is under `OPEN_CLASSES`, the object is `open`, whatever its size.
- **R4 Cheap.** If `bytes ≤ OPEN_OBJECT_MAX_BYTES`, or the object is held on a committed zero-egress host, the object is `open`.
- **R5 Terms gate.** The object would otherwise be `at_cost`. If any of its sources has `non_commercial: true`, or a terms status outside `CHARGEABLE`, the build stops with a hard error. The message lists the fixes:
  - mirror the object on a zero-egress host, which makes it free under R4;
  - split the restricted fields into their own free object (the `KNOWN_NON_COMMERCIAL_FIELDS` tripwire already forces those fields to be declared);
  - record the missing terms check;
  - or add an owner-approved override to `open`.

  Restricted, non-commercial or unchecked material never goes behind a payment of any kind.
- **R6 Otherwise** the object is `at_cost`. It is served from the Requester Pays bucket, and later also through the broker.

**Release guard.** The `open` bytes in a release that are held on no zero-egress host must total at most `OPEN_RELEASE_GCS_MAX_BYTES`. Otherwise the build stops with a hard error. Only three things resolve it: a mirror, an override, or an owner PR that raises the constant and states the new worst-case cost of one full free download.

**Where an object's bytes live.** The `hosts` field follows from the rule:

| Object | `hosts`, in fetch order | Why |
|---|---|---|
| `open`, within the guard | `hf`, then `gcs-free` | A mirror miss falls back to our bucket, which the guard keeps cheap. |
| `open` only because a mirror holds it (over 1 GiB, or over the guard) | `hf`, then `gcs-bulk` (Requester Pays) | If the mirror ever drops it, the object becomes effectively at cost, not a surprise on our bill (C's idea). |
| `at_cost` | `gcs-bulk` (and the broker in Phase 3) | |

GCS stays the source of truth for every object: the free bucket or the bulk bucket.

**Operations.**
- Anonymous GETs and range reads of `open` objects are free.
- BigQuery SQL is billed to the querier.
- Client-side DuckDB costs us only the bytes it reads.
- If the parallel design ships a hosted read API, bounded lookups stay anonymous and free with a per-IP rate limit: one variant, one cell, one tile or one catalog page, with a response of at most 10 MB.
- No unbounded SQL runs on our compute until Phase 3 metering exists (§10).

### 3.3 Mirror-first fetching and C8

`fetch_data.py` keeps reading the manifest only from git, or from the GCS `manifests/` key. It never reads the manifest from a mirror, so a mirror can never change which bytes are expected. It tries each object's hosts in order and checks every byte count and sha256 exactly as now. It falls back to the next host on a 403, a 5xx, a 429 or a hash mismatch.

C8 is amended by a PR: the committed truth becomes "the data-store URL plus the committed zero-egress host URLs". Any other value is still refused.

Hugging Face serves downloads for free, but with rate limits per 5-minute window: 3,000 resolver requests per anonymous IP and 5,000 per free user (https://huggingface.co/docs/hub/en/rate-limits, re-read 2026-10-18). So `fetch_data.py` honours HTTP 429 with backoff, and accepts an optional `HF_TOKEN`.

The website keeps reading from GCS. Hugging Face's cross-host redirect breaks browser CORS preflight (https://github.com/huggingface/datasets/issues/7931).

### 3.4 Applied today and to what is coming

| Object | Result | Rule |
|---|---|---|
| All 248 objects of 2026-10-18 | `open` | R3; R4 would admit them too |
| The 6 GeneReviews-linked objects (links only, about 316 KB) | `open` | R3. They could never be `at_cost` (R5). |
| WorldPop 1 km grid, about 870 MB (phase 2, #472; size per design A) | `open` | R4. It counts toward the guard unless mirrored. As `not_checked` it could never be `at_cost`. |
| Exported fits (#471), if they are about the size of today's pickles (about 100 MB each; 50 pickles total about 0.7 GB, per data store design §8) | `open` per object | R4. Together with the grid they approach the 2 GiB guard, so mirror them. Their sources (genomeos, worldpop) are `not_checked`, so they can never be `at_cost` until the owner records a data licence and a WorldPop check. |
| gnomAD and AlphaGenome caches (phase 2) | `open` while each object stays ≤ 1 GiB | R4. Their SpliceAI and `top_attributions` fields ship as separate objects, so a permissive remainder that grows past 1 GiB can be `at_cost` (`commercial_use.KNOWN_NON_COMMERCIAL_FIELDS`). |
| A future raw harvest over 1 GiB, with positive terms, that no mirror holds | `at_cost` | R6 |

In practice, the at-cost tier stays empty until a single object exceeds 1 GiB and cannot be mirrored.

---

## 4. Identity

**Tier 0: no identity at all.** No account, cookie, key or form. Abuse is controlled by mirrors, caps and the kill switch, not by a login wall. A wall would also disqualify the data from AWS Open Data, which says "Restricting access by asking for email or contact information is not in line with the program requirements" (https://aws.amazon.com/opendata/faqs/).

**Tiers 1 and 2: the user's Google account, enforced by Google IAM.** We store no users, emails, passwords or tokens.

- BigQuery checks `allAuthenticatedUsers` on the dataset.
- The bulk bucket requires an authenticated request that names a billing project on which the caller holds `serviceusage.services.use`. Requests without one fail with `400 UserProjectMissing` (https://docs.cloud.google.com/storage/docs/requester-pays).

`fetch_data.py` stays standard-library only and gets a token in one of three ways:

1. from `GENOMEOS_GCS_ACCESS_TOKEN`, filled by `gcloud auth print-access-token` (lasts about an hour);
2. by refreshing the `authorized_user` ADC file that `gcloud auth application-default login --no-launch-browser` writes. It POSTs the refresh token to `https://oauth2.googleapis.com/token` with `urllib` (https://cloud.google.com/docs/authentication/application-default-credentials, https://developers.google.com/identity/protocols/oauth2/native-app);
3. from the GCE or Cloud Run metadata server.

A service-account JSON key needs an RS256 signature, which the standard library cannot make, so that route needs `gcloud`. Tokens are never logged, printed or written.

**Privacy for Tiers 1 and 2.** BigQuery Data Access audit logs "can't be disabled" (https://docs.cloud.google.com/logging/docs/audit/configure-data-access), so the principals who query appear in the public project's logs. Set a short retention or an exclusion filter. `_Default` keeps logs 30 days, and that can be lowered to 1 day (https://docs.cloud.google.com/logging/quotas). Say so on the data-access page.

**Tier 3 (Phase 3), adopted from design A.**

- **Sign-in.** Firebase Authentication on Identity Platform, with GitHub and Google as providers. These "Social" providers are free for the first 50,000 monthly active users, then $0.0055 each (https://cloud.google.com/identity-platform/pricing). There are no passwords, so there are no reset or breach flows. We keep the Firebase uid, the provider and an email address for receipts, and nothing else.
- **Pods and CI.** `fetch_data.py login` runs a device flow in the RFC 8628 shape: it prints a URL and an 8-character code, then polls, the way GitHub documents its own flow (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps). Alternatively, paste a key into `GENOMEOS_API_KEY`.
- **Keys.** 256 random bits, prefixed `gos_` so secret scanners can match them. Shown once and stored as SHA-256. Each is named after its device and carries scopes and a monthly cap. Revocable. The CLI stores its key at `~/.config/genomeos/credentials` with mode 0600.
- **Teams.** Invite members by GitHub login or verified email. Never grant team rights by email domain alone. A JupyterHub CILogon authenticator advisory found it checked only the email address, not which provider issued it (https://www.miggo.io/vulnerability-database/cve/CVE-2022-31027).

**Not used: ORCID sign-in.** Its Public API terms say "you may not make use of the public APIs in connection with any revenue-generating product or service", and that "you may not charge any re-use fees" (https://info.orcid.org/public-client-terms-of-service/, re-read 2026-10-18). "Link your ORCID iD" for attribution can come later, if ORCID confirms that is acceptable next to a cost-recovery service.

---

## 5. Billing

**Phases 1 and 2: Google Cloud Billing does all of it.**

- BigQuery queries are billed to the querier, and "The data owner is not charged" (https://cloud.google.com/bigquery/pricing).
- Requester Pays operations and network charges go to "the billing project supplied in the request" (https://docs.cloud.google.com/storage/docs/using-requester-pays).

So we set no prices, hold no money, issue no invoices or receipts, keep no ledger, handle no refunds or bad debt, and file no sales tax or VAT. Recovery of the cost each request causes is 100% at list price, with zero markup and zero card fees.

We do not recoup two things:

1. Storage, about $0 to $3 a month even at 100x.
2. Tier 0 egress, which is the deliberate free tier. The release guard, mirror-first fetching and the kill switch bound it.

**No-surprise rules, which apply from Phase 2 onward.** `fetch_data.py` never downloads an `at_cost` object unasked. It prints the bytes, the cost at Google's list price for internet egress and the ways to pay, then exits with status 3 ("needs a billing project or credit"). Downloading needs `--billing-project` plus either `--max-spend <USD>` or, under $1, `--yes`.

The docs warn that egress to China ($0.23/GiB) and Australia ($0.19/GiB) costs more (https://cloud.google.com/storage/pricing). They also recommend a dedicated project with a budget, because Requester Pays charges are not itemized per bucket on the requester's bill.

For BigQuery, the docs recommend the custom `QueryUsagePerDay` quota, which refuses a query in advance if it would exceed the quota (https://docs.cloud.google.com/bigquery/docs/custom-quotas).

**Phase 3: prepaid only, priced in dollars, at cost plus payment fees (from design A).**

- **Price** = list cost ÷ 0.89. Transfer is $0.12/GiB ÷ 0.89 = $0.135/GiB, charged on the whole object once per issued URL, so ranged reads can't make the price unpredictable. Compute, if a hosted query endpoint exists, is the Cloud Run list rate ÷ 0.89. Storage is never charged.
- **Why 11%.** It covers the worst merchant-of-record fee on a $10 top-up. Paddle charges "5% + 50¢" per checkout transaction, which is $1.00 on $10, and offers bespoke pricing for products under $10 (https://www.paddle.com/pricing, re-read 2026-10-18). Stripe Managed Payments "adds 3.5% per successful transaction to your standard Stripe processing fees" (https://stripe.com/managed-payments, re-read 2026-10-18). With 2.9% + 30¢ (https://stripe.com/pricing), that is about $0.94 on $10.
- **Why a merchant of record.** A seller outside the EU owes EU VAT on electronic services to consumers through the non-Union scheme. The €10,000 threshold applies only to suppliers established in a single Member State (https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en). A merchant of record files that tax for us.
- **Stripe Managed Payments eligibility.** It supports US-based businesses. Its "Electronically Delivered Information Services" tax code excludes "data brokering". Products must meet "You hold all necessary rights and licenses to distribute the product". It does not sell to buyers in China, among other restricted countries. Stripe "can issue refunds within 60 days of purchase" (https://docs.stripe.com/payments/managed-payments/eligibility, re-read 2026-10-18).
- **Paddle** covers both card checkout and manually collected invoices carrying a PO number and payment terms (https://developer.paddle.com/build/invoices/create-issue-invoices/). So Paddle is the default, and Stripe Managed Payments is the fallback for card top-ups. Either needs the provider's eligibility review, which is owner decision D7.
- **Flow.** Quote, then confirm (`--max-spend`, or the price on the button), then debit, then a signed URL. At zero balance the broker returns HTTP 402 with a top-up link. Emails go out at 50%, 80% and 100% of a key's cap. Auto-recharge is off unless the user opts in. A paid object can be re-issued twice within 7 days at no charge, for interrupted downloads. Balances are refundable on request and valid for 24 months after the last top-up. There is never an overage invoice.
- **Ledger.** Firestore, append-only: top-up, debit, refund, re-issue and allowance entries. Debits are idempotent on (key, quote_id, object) and are written before a URL is issued. At our size it fits the free quota of 50,000 reads and 20,000 writes a day (https://firebase.google.com/docs/firestore/quotas).
- **Isolation.** The bulk bucket, the broker, Identity Platform and the ledger live outside the free tier's project, so paid egress can never trip the free tier's kill switch. Budgets are scoped by project (https://docs.cloud.google.com/billing/docs/how-to/budgets). Signed URLs keep working after the kill switch removes `allUsers`, because they authorize as the signing service account (an inference). The broker's prepaid-only issuance is therefore its spending cap.
- **Optional allowance** (owner decision D7): $1 a month per signed-in account, spent before the balance, from a pool capped at $50 a month. It lets someone try an at-cost object before entering a card.
- **Reconciliation.** A monthly job compares the billing export with ledger revenue. If recovery stays above 105% for a quarter, the price comes down; if it stays below 95%, it goes up. Either change is a PR to `genomeos/access/pricing.py`.

**Institutions.**
- **Now:** they pay Google as they already do. Google invoiced billing needs at least one year of business registration and expected spend of at least $40,000 a year (https://docs.cloud.google.com/billing/docs/how-to/invoiced-billing). That is why labs ride on their institution's contract or a reseller.
- **Phase 3+:** prepaid team blocks bought by quote, PO and invoice, through Paddle manual collection or Stripe Invoicing at 0.4% per paid invoice (https://stripe.com/invoicing/pricing).

---

## 6. The four user journeys

### 6.1 First-time visitor (never signs in)

1. Opens the Atlas site. The map loads from the public web bucket, with no sign-in prompt and no cookie wall.
2. Clicks HbS. The "Get the data" panel lists `cells.parquet` (7.5 MB), its manifest and the observations. Each entry shows its size, its sha256, the citation built from the manifest's `sources` block (MAP: Piel 2013 and Howes 2012; WorldPop), and the label **free, no account**.
3. Clicks "Query in your browser" (PR 6). DuckDB-WASM runs example SQL over the free Parquet and fetches only the byte ranges it needs.
4. Clicks "Get everything". The page shows `curl -LO <release>/fetch_data.pyz && python3 fetch_data.pyz` (PR 5), or the clone route. 0.25 GiB downloads, mostly from the mirror, and every sha256 is checked.
5. If a later release has an at-cost object, its entry shows the price before anything else. For example: "42 GiB · about $5.04 at Google's list price, billed by Google to your own project · how" (and, after Phase 3, "or top up $10 by card"). Nothing asks for a card unless the visitor chooses to.

Cost to them: $0. Cost to us: about $0.001 per surface and about $0.03 per full release from GCS (https://cloud.google.com/storage/pricing), or $0 from the mirror or inside Always Free.

### 6.2 Researcher on a GPU pod with no cloud account

1. On the pod: `git clone --filter=blob:none https://github.com/genomeOS/genomeOS && python3 scripts/fetch_data.py`. Every free object streams anonymously, from the mirror first with GCS as the fallback. The standard library is enough. **This covers everything published today, and everything the rule foresees for the next releases**, so most researchers stop here.
2. Later they ask for an at-cost object: `fetch_data.py --prefix raw/<harvest>/`. Nothing downloads. The script prints the object count, the GiB, an estimate such as "about $5.04 to this machine at $0.12/GiB, billed by Google to your project", and these routes, then exits with status 3:
   - **(a) Easiest: a PI grants Service Usage Consumer on the lab's project.** The researcher needs no card. On a laptop they run `gcloud auth print-access-token`, paste the token into `GENOMEOS_GCS_ACCESS_TOKEN` on the pod, then run `fetch_data.py --billing-project <lab-project> --max-spend 6`. For long jobs, `gcloud auth application-default login --no-launch-browser` on the pod lets `fetch_data.py` refresh the token itself.
   - **(b) Their own Google Cloud project.** The $300 trial needs a payment method to verify identity (https://cloud.google.com/signup-faqs; per the input research, because the page did not render here). Then route (a).
   - **(c) Google Cloud research credits.** Available to faculty, postdocs and PhD students at eligible institutions; they expire 365 days after redemption (https://edu.google.com/programs/credits/research/).
3. **After Phase 3** the route is shorter:
   - Run `fetch_data.py login`. It prints a URL and a code.
   - On a phone, sign in with GitHub in one click and approve the device "runpod-a100-1", with a $10/month cap.
   - The key is saved with mode 0600.
   - Re-run the fetch. It prints "Quote $5.69: allowance $1.00, balance $0.00, $4.69 short" and a top-up link. Pay $10 by Apple Pay.
   - Run `--max-spend 6`. Each object is debited, then fetched by signed URL and sha256-checked.
   - If the pod is pre-empted, re-issue is free for 7 days. The balance left is $5.31.

Honest note: until Phase 3, step 2 is the weakest point of this design. The rule keeps it rare.

### 6.3 Heavy SQL user

1. With no sign-in, in DuckDB, they run `SELECT … FROM read_parquet('hf://datasets/<org>/<dataset>/releases/<release>/store/artifacts/*/cells.parquet')`, using the mirror's `hf://` path (https://duckdb.org/docs/current/core_extensions/httpfs/hugging_face.html), or the GCS URL. Column and row-group pruning keep reads small. The docs suggest downloading once for repeated full scans, so that scans run locally.
2. For scans across every variant and release, or joins with gnomAD or 1000 Genomes in `bigquery-public-data`: they sign in to the BigQuery console and create a sandbox project, with no card. Managed academic accounts "must select an organization" (https://docs.cloud.google.com/bigquery/docs/sandbox).
3. They query `<public-project>.atlas_<release>.<table>` or the `latest` views. A dry run shows the bytes it will scan. Tables are clustered as the parallel storage design decides (for example by variant and H3 parent), so a filtered query scans megabytes. The datasets are in the US multi-region, so joins with `bigquery-public-data` tables stored in `US` work directly (https://docs.cloud.google.com/bigquery/docs/locations).
4. The free 1 TiB a month covers about 100,000 minimum-size queries (10 MB per table, https://cloud.google.com/bigquery/pricing). Past that, they enable billing and pay $6.25/TiB on their own bill, ideally with the `QueryUsagePerDay` quota set first.
5. Optionally they subscribe to the free BigQuery sharing listing, which creates a linked dataset in their own project. A shared dataset can have at most 1,000 linked datasets (per the input research, from https://docs.cloud.google.com/bigquery/docs/analytics-hub-introduction), so direct `allAuthenticatedUsers` access stays as well.

Cost to us: $0 compute, and storage inside the 10 GiB free tier. Whether a sandbox project can query a third party's `allAuthenticatedUsers` dataset is **not verified**. PR 8 tests it before announcing.

### 6.4 Lab paying by invoice

**Phases 1 and 2 (Google bills; we never invoice).**

1. The PI asks research computing for a Google Cloud project on the institution's billing account. In the US that is usually a reseller or Internet2 NET+ on a PO. Google invoiced billing is the alternative, by check or wire (https://docs.cloud.google.com/billing/docs/how-to/invoiced-billing).
2. IT creates a dedicated project such as "genomeos-access", so the charges can be identified on the invoice. It grants members Service Usage Consumer (for the bulk tier) and BigQuery Job User, and sets a budget on the project.
3. For procurement, `fetch_data.py --estimate --prefix …` prints the bytes and the list-price cost.
4. Members run `--billing-project <lab-project>` and BigQuery jobs in that project.
5. The charges appear on the institution's monthly Google or reseller invoice. Institutions on Internet2 NET+, GÉANT or reseller contracts can have internet egress waived up to 15% of their monthly Google Cloud fees. The waiver "isn't available for pay-as-you-go customers (for example, when paid with credit card)" (https://docs.cloud.google.com/billing/docs/how-to/data-transfer-waiver, re-read 2026-10-18). For such a lab, the bulk tier is often free in practice.

**Phase 3+ (for labs with no cloud contract).**

1. The PI signs in, creates the team "Lab X", and asks for a quote for a $500 block. That is about 3.6 TiB at $0.135/GiB.
2. We issue an invoice through Paddle manual collection, with the PO number and net-30 terms, or through Stripe Invoicing.
3. Credit lands on payment, or provisionally on the PO (owner decision D7).
4. The PI invites members by GitHub login and sets caps for each member.
5. Members work as in §6.2. The PI gets emails at 50%, 80% and 100% of the block. At zero, at-cost access stops and Tier 0 keeps working.
6. A monthly CSV statement (member, object, bytes, cost, citations) supports grant reporting.

---

## 7. Costs, now and at 100x

**Prices used:**
- GCS internet egress: $0.12/GiB for 0–10 TiB; Standard storage about $0.02/GiB-month (https://cloud.google.com/storage/pricing).
- Always Free: 100 GB/month of egress from North America (about 93.1 GiB) and 5 GB-months of storage in us-east1, us-central1 and us-west1 (https://cloud.google.com/free/docs/free-cloud-features).
- BigQuery: 10 GiB of storage free, then about $0.023/GiB-month (https://cloud.google.com/bigquery/pricing).
- Cloud Run (Phase 3): 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds free per month (https://cloud.google.com/run/pricing).
- Hugging Face egress: $0 (https://huggingface.co/docs/hub/en/rate-limits).

**Traffic assumptions.** The data store has no analytics yet, so every traffic figure is assumed.

| | Now | 100x users, today's data | 100x users and about 100x data |
|---|---|---|---|
| Full or prefix fetches | 50 full a month × 0.2528 GiB = 12.6 GiB | 5,000 full = 1,264 GiB | Open tier: 5,000 prefix fetches averaging 0.5 GiB = 2,500 GiB. At cost: 200 users × 20 GiB = 4,000 GiB. |
| Atlas visits (web bucket, about 4 MB each, the fast-load design's upper figure) | 1,000 = 3.7 GiB | 100,000 = 372.5 GiB | 100,000 = 372.5 GiB |
| CI `--verify-remote` | 20 = 5.1 GiB | 5.1 GiB | 5.1 GiB |
| Stored | under 1 GiB | under 1 GiB | 2 GiB open per release, plus 23 GiB at cost per release. About 150 GiB at cost after 12 releases if half the bytes are new each time. BigQuery 50 GiB. |

**Our monthly cost.**

| Line | Now | 100x users, GCS only | 100x users, mirror first (90% from HF) | 100x users and data, GCS only | 100x users and data, mirror first |
|---|---|---|---|---|---|
| Free-tier egress on GCS, net of 93.1 GiB free | 21.4 GiB, inside the free allowance → **$0** (billed in full it would be $2.57) | 1,548.7 GiB → **$185.84** | 410.9 GiB → **$49.31** | 2,784.5 GiB → **$334.13** (over budget; trips the switch) | 534.5 GiB → **$64.13** |
| Of which web bucket (outside the kill switch) | 3.7 GiB | 372.5 GiB ($44.70) | 372.5 GiB ($44.70) | 372.5 GiB | 372.5 GiB |
| Storage, free bucket and web bucket | $0 (inside 5 GB-months) | $0 | $0 | about $0.10 | about $0.10 |
| Bulk bucket (Requester Pays) storage | $0 (empty) | $0 | $0 | $2.99 Standard ($0.60 on Coldline) | $2.99 ($0.60) |
| Bulk-tier egress (4,000 GiB) | — | — | — | $0 (requesters pay) | $0 |
| BigQuery storage | $0 (under 10 GiB) | $0 | $0 | $0.92 | $0.92 |
| BigQuery loads from the us-east1 bucket into US | about $0.005 a release (about 0.25 GiB × $0.02/GiB inter-region; colocation rule, https://docs.cloud.google.com/bigquery/docs/locations) | same | same | about $0.04 a release | same |
| Mirror | $0 | $0 | $0 | $0 | $0 |
| **Total** | **about $0–3** | **about $186** | **about $49** | **about $338** | **about $68** |

**If Phase 3 is live at 100x data** and the 4,000 GiB at-cost goes through the broker instead of Requester Pays:
- Egress on the paid project: $480.
- Prepaid revenue: $539.33 gross.
- Merchant fees: about $38 to $54.
- Net: about +$6 to +$21, which the quarterly reconciliation trues up.
- The allowance pool adds at most $50.
- Identity Platform (5,000 social MAU), Cloud Run and Firestore: $0 at that scale (sources above).

None of this touches the free tier's $200 budget, because it lives in another project.

**If a sponsor accepts the free tier** (AWS Open Data covers "Amazon S3 storage costs" and outbound transfer, https://aws.amazon.com/opendata/faqs/; Google's program says "Google pays for the storage", https://docs.cloud.google.com/bigquery/public-data), the GCS share falls toward the web bucket alone.

**Cost to users.**
- Free tier: $0.
- BigQuery: $0 within 1 TiB a month, then $6.25/TiB.
- At cost through Requester Pays: 20 GiB is $2.40 to the internet, $0 into us-east1 compute, and possibly $0 under the education waiver.
- At cost through the Phase 3 broker: 20 GiB is $2.70. A $10 top-up buys about 74 GiB.

**Takeaways.**
1. The free tier's popularity, not the paid tier, is what threatens $200.
2. Mirror-first fetching is the cheapest fix. Ship it first.
3. At 100x, the web bucket becomes the largest line we can't mirror, and the kill switch doesn't cover it. The fast-load work and, if needed, a zero-egress host for web data are its levers. Cloudflare R2 has free egress and $0.015/GB-month storage (https://developers.cloudflare.com/r2/pricing/, re-read 2026-10-18), but production use needs a custom domain, because `r2.dev` is rate-limited (https://developers.cloudflare.com/r2/buckets/public-buckets/).
4. At the 150% kill switch ($300 actual), the free bucket alone covers about 10,250 full downloads of today's release a month, counting the free allowance.

---

## 8. Terms

What each source in release 2026-10-18 means under this design (statuses copied from the manifest):

| Source | Recorded | Free (Tier 0/1) | At cost via Google (Tier 2) | Prepaid broker (Tier 3) | Sponsor mirror (ODP) |
|---|---|---|---|---|---|
| AFND (113 objects, 89.2% of bytes) | `no_restriction_found` (2026-08-25, #117, policy #149), no licence | yes | yes, if an object ever needs it | owner decision D8 | not until a licence or written permission is recorded |
| MAP (20 objects) | `no_restriction_found` (2026-10-18). The policy says there are no restrictions on public survey data, and asks users to cite the original sources (https://malariaatlas.org/open-access-policy/). | yes | yes | D8 | ask MAP whether its policy counts as an open licence |
| CPIC (10) | `no_restriction_found`, CC0-1.0 | yes | yes | yes | yes |
| ClinVar (6) | `no_restriction_found`; asks for attribution | yes | yes | yes | after the licence is recorded |
| GeneReviews (6; links only) | `restriction_found`, `non_commercial: true` | yes (R3) | **never** (R5) | **never** | **never** (ODP excludes "Licenses that limit commercial use", https://aws.amazon.com/opendata/faqs/) |
| WorldPop (62) | `not_checked` | yes | **no** until a check is recorded | no | no until recorded. The hub states CC BY 4.0 (https://hub.worldpop.org/), but the builder must not assume it. |
| genomeos, project-authored (103) | `not_checked`; Apache-2.0 covers code only | yes | **no** until the owner picks a data licence | no | no until then. CC BY 4.0 is what ODP recommends (https://aws.amazon.com/opendata/faqs/). |

**How charging interacts with terms.** In Tiers 1 and 2, genomeOS receives no money. Google bills its own customer for transport and compute. Creative Commons defines NonCommercial as "not primarily intended for or directed towards commercial advantage or monetary compensation" (https://creativecommons.org/licenses/by-nc/4.0/legalcode.en). Pure pass-through billing by a third party is the strongest position available under such terms. The rule still never relies on that argument: R5 keeps non-commercial, restricted and unchecked material off every charged path.

In Tier 3 we collect money. The merchant of record then makes us attest that we "hold all necessary rights and licenses to distribute the product" (https://docs.stripe.com/payments/managed-payments/eligibility). Decision D8 asks whether the broker may sell objects whose sources are `no_restriction_found` with no licence, or only objects with a recorded grant. This is a contract question for the payment provider. It does not reopen the owner's position on publishing derived surfaces, which stays as decided (#66).

**Field-level restrictions.** `KNOWN_NON_COMMERCIAL_FIELDS` (`gnomad.spliceai`, `alphagenome.top_attributions`) appear in no payload today. When they do, they ship as their own free-only objects. If that breaks the release guard, the build fails, and the fix is field-level extraction (`commercial_use.py`) or written permission.

**Vocabulary.** `data_release.py` accepts any non-empty `terms.status`, and the release manifest uses `restriction_found` where `commercial_use.COMMERCIAL_USE_FINDINGS` uses `restricted`. PR 2 closes the vocabulary to the five findings. It reads the legacy `restriction_found` from immutable old manifests as `restricted`, and an unknown status is a hard error. The access rule treats `non_commercial: true` as authoritative regardless of status.

**Attribution on every door.**
- The manifest's `sources` block (name, citation, `terms_url`, status, note) is carried into the Download panel, `fetch_data.py` output, an `ATTRIBUTION.md` beside every mirrored release, BigQuery dataset, table and column descriptions plus a `sources` table, and (Phase 3) every quote, receipt and statement.
- The terms of service and every Phase 3 receipt say: "You are paying for network transfer and compute at cost. No fee is charged for the data or for a licence. Each dataset remains under its source's terms; cite as listed."

**All of Us** is never served in any tier, per AGENTS.md.

---

## 9. What we deliberately do not use, and why

| Not used | Why |
|---|---|
| Requester Pays on the existing free bucket | Anonymous requests fail with `400 UserProjectMissing` (https://docs.cloud.google.com/storage/docs/requester-pays). That would break every link, every clone and the stdlib fetch, and end the owner's free tier. The only exception is the optional emergency mode (PR 10). |
| A login wall on free data (HF gated datasets, GBIF-style accounts, required API keys) | Each step down the friction ladder loses users. Gating also disqualifies AWS Open Data (https://aws.amazon.com/opendata/faqs/). Gated HF datasets are a login wall, not billing (https://huggingface.co/docs/hub/en/datasets-gated). |
| Our own payments now (design A's Tiers 1–3 as a first build) | Built to sell nothing. It needs a legal seller and merchant review, and it brings support, refunds and privacy work. Deferred to Phase 3 behind a concrete trigger. |
| Postpaid usage billing (Stripe Billing usage pricing, 0.7% of volume, https://stripe.com/billing/pricing) | Surprise bills and bad debt, on a $200 budget. Prepaid only. |
| Charging per download by card | The 30¢ fixed fee is ten times the $0.03 cost of a full release (https://stripe.com/pricing). |
| Subscriptions, flat plans, or a Cloud Marketplace data product | They ask for commitment before exploration and are not "just enough to recoup". Marketplace needs Partner Network membership, takes a 3% revenue share, and documents flat subscription pricing rather than metering (https://cloud.google.com/bigquery/docs/analytics-hub-cloud-marketplace, https://cloud.google.com/terms/marketplace-revenue-share-schedule, https://docs.cloud.google.com/marketplace/docs/partners/data). |
| Apigee monetization | Pay-as-you-go environments start at $365/month, more than the whole budget. Monetization needs a Subscription, and settlement is still ours (https://cloud.google.com/apigee/pricing, https://cloud.google.com/apigee/docs/api-platform/monetization/overview). |
| API Gateway or Cloud Endpoints quotas | They count and throttle but bill nobody. Every consumer needs their own GCP project and an API key (https://cloud.google.com/endpoints/docs/openapi/quotas-overview). |
| Cloud CDN in front of the free bucket, now | A fixed forwarding-rule cost (about $18/month) that pays back only above roughly 500 GiB/month (https://cloud.google.com/cdn/pricing). The mirror removes the egress at $0. Revisit for the web bucket at scale. |
| A hosted, unbounded SQL server on our compute (DuckDB, Postgres or an API) | It puts query compute and abuse on our bill, and needs our own auth and metering. BigQuery gives querier-pays for free (https://cloud.google.com/bigquery/pricing). Bounded lookups only, until Phase 3. |
| Credits or token units instead of dollars | They hide the price. OpenAlex prices in dollars, with $1 a day of usage on a free key (https://help.openalex.org/access/pricing/, re-read 2026-10-18). |
| ORCID as the sign-in | It forbids use "in connection with any revenue-generating product or service" (https://info.orcid.org/public-client-terms-of-service/). |
| Earth Engine-style "add a card to unlock more free quota" (https://developers.google.com/earth-engine/guides/noncommercial_tiers) | It puts a card in front of free use. The free tier here is generous without one, and caps and mirrors control abuse. |
| Our own Stripe account plus Stripe Tax, with no merchant of record (Phase 3) | Cheaper per transaction, but we would owe EU VAT from the first consumer sale (https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en), plus sales tax and disputes. Revisit only at volume. |
| Sponsor programs as the whole design | They can't host a paid or login tier, acceptance is discretionary, and they can end. Azure dropped gnomAD's genomic datasets in 2025 (https://gnomad.broadinstitute.org/news/2025-07-azure-open-datasets-deprecation). They are a scale-up trigger, not the access layer. |
| BigQuery in us-east1, or external tables over the bucket | Users couldn't join `bigquery-public-data` without global queries (https://docs.cloud.google.com/bigquery/docs/global-queries). External tables read across locations on every query, and those reads would land on our bill (https://docs.cloud.google.com/bigquery/docs/locations). |
| Platforms like Terra/AnVIL or UK Biobank's RAP | Analysis-in-place for controlled individual-level data, far heavier than open aggregate counts need (https://www.ukbiobank.ac.uk/use-our-data/fees/). |

---

## 10. Build steps (PR-sized)

Module docstrings cite this design's section numbers, per AGENTS.md. Every new rule has a hard-error test, and nothing defaults silently.

**Phase 1: harden the free tier. Repository-only, no user-visible change except docs. Start now.**

1. **Docs and the owner-decision issue.** `docs/data-access.md` gives the tiers, the rule in plain words, worked costs, the citation block, links to the sandbox, research credits, the education waiver and institutional procurement, the audit-log privacy notice, and when the kill switch fires. It amends `docs/data-store.md` to record that Requester Pays is a separate bucket, never the free one. A `needs-human-decision` issue lists §12.
2. **Close the terms vocabulary.** In `genomeos/publication/data_release.py`, `terms.status` must be one of `commercial_use.COMMERCIAL_USE_FINDINGS`. The legacy `restriction_found` is read from old immutable manifests as `restricted`, and new builds write `restricted`. Tests cover the vocabulary. Recording the WorldPop check is a separate evidence PR, made when someone does the check.
3. **Access rule and manifest v2.** This adds:
   - `genomeos/publication/access_policy.py`: R0–R6, the release guard, the constants and `ACCESS_OVERRIDES` (pure, no HTTP);
   - schema v2 in `data_release.py`, with per-object `access` and `hosts`, the `access_policy` block, and v1 read as all open;
   - integration in `build_data_release.py`;
   - a CI job that recomputes every committed manifest;
   - tests for each branch: non-commercial over 1 GiB is an error; `not_checked` over 1 GiB with no mirror is an error; a reused open key stays open; the guard fails above its cap; an override can only open.

   Acceptance: rebuilding 2026-10-18 gives all 248 objects `open`.
4. **Mirror-first fetching.**
   - The owner creates an org-owned public HF dataset that holds exactly the release keys (D5).
   - Commit `ZERO_EGRESS_HOSTS` and amend C8 in the data store design and `docs/repo-gcloud-auth.md`.
   - Add `sync_store.py push-release`, which uploads each release under its exact keys and verifies the sha256s afterwards.
   - Add `fetch_data.py --source auto|gcs|hf`. `auto` tries hosts in manifest order, with fallback on 403, 429, 5xx or a hash mismatch. The manifest is read only from git or GCS.
   - Add a CI job that runs `--verify-remote --source hf`.
   - Tests use a loopback server for each host.
5. **Single-file fetcher.** CI builds `fetch_data.pyz`, a stdlib zipapp that vendors `data_release.py` and the newest manifest, and attaches it to each GitHub release.
6. **Browser and CLI SQL.**
   - 6a: Add `Content-Range` and `Accept-Ranges` to `responseHeader` in `deploy/data-store-cors.json`, which today exposes only `Content-Length`, `Content-Type` and `ETag`. Verify that a ranged GET returns 206; recent DuckDB-WASM versions are reported to need `Content-Range` (https://github.com/duckdb/duckdb-wasm/issues/1852). Add DuckDB examples to the docs.
   - 6b: A separate PR adds a "Query in your browser" panel to the Atlas with a pinned DuckDB-WASM, reading from GCS, not HF (§3.3).

**Phase 2: the Google-billed doors. Owner steps first. Each ships when it is needed.**

7. **Tier-aware `fetch_data.py`, still standard library.**
   - It skips `at_cost` objects by default and prints the estimate, then exits with status 3.
   - New flags: `--billing-project`, `--estimate`, `--max-spend` and `--yes`.
   - Token sources: the environment variable, an ADC refresh, or the metadata server.
   - It sends `Authorization` and `x-goog-user-project`, and explains a `UserProjectMissing` response in plain words.
   - The same flag also works on the free bucket.
   - Tests: no token is ever printed, and a host that isn't committed is refused.
8. **BigQuery lane.**
   - Owner step: create a dedicated public project (D4) and amend `docs/repo-gcloud-auth.md` to allow committing that one project id.
   - Then add `scripts/provision_bigquery_public.py` (idempotent, `--dry-run`) and `scripts/publish_bigquery.py`.
   - One dataset per release in the US multi-region, with native tables loaded with `WRITE_EMPTY`, partitioning and clustering from the parallel storage design, a `sources` table, descriptions and `latest` views.
   - The dataset grants READER to `allAuthenticatedUsers`.
   - Data Access logs get a short retention or an exclusion filter, and the project goes under a budget.
   - A smoke test runs from a separate sandbox account; this is the main untested assumption.
   - Check first whether the project would sit under an organization that enforces domain-restricted sharing (§11).
9. **Bulk bucket (Requester Pays).**
   - This ships with the first `at_cost` object, or the first object that is free only because a mirror holds it.
   - Add `scripts/provision_bulk_bucket.py`, in the style of `provision_data_store_bucket.py`. It creates `genomeos-atlas-bulk` in us-east1 with uniform access, Requester Pays, `roles/storage.legacyObjectReader` for `allAuthenticatedUsers`, versioning and soft delete, and Standard or Coldline by class.
   - The publisher gets object create and read on it.
   - `publish_data_store.py` routes each object by `hosts`.
   - The bucket needs no kill switch, because its egress is not ours.
10. **(Optional, D6) Kill switch "pay your own way" mode.** At 150%, the switch turns Requester Pays on for `genomeos-atlas-data` instead of removing `allUsers`. Anonymous reads then pause, while anyone with a billing project can continue. The custom role swaps `setIamPolicy` for `storage.buckets.update`, and `publish_data_store.py` passes our billing project while the mode is on.
11. **Scale-up track.** It starts on a trigger: free GCS egress over $50 a month for two months, or any PR that raises `OPEN_RELEASE_GCS_MAX_BYTES`.
    - Apply to AWS Open Data (https://aws.amazon.com/opendata/open-data-sponsorship-program/; this needs a dedicated AWS account) and to Google's program (bq-public-data@google.com, https://docs.cloud.google.com/bigquery/public-data). Both exclude non-commercial objects.
    - Add `scripts/mirror_release.py`, which verifies sha256 after each copy, writes `ATTRIBUTION.md` and records each acceptance.
    - Optionally, deposit each citable release on Zenodo for a DOI (50 GB per record, https://support.zenodo.org/help/en-gb/1-upload-deposit/80-what-are-the-size-limitations-of-zenodo).

**Phase 3: the prepaid card door. Triggered when the first `at_cost` object is scheduled for a release AND the owner has decided D7.** Steps 12–14 can start on the first condition alone, running on the allowance with no payments.

12. **Broker core, no money.**
    - `services/access_broker/`: FastAPI on Cloud Run in the paid-access project.
    - Pure modules `genomeos/access/{pricing,ledger,quota}.py`, with no HTTP, unit-tested directly.
    - Firebase ID-token verification and hashed keys.
    - `/v1/quote` and `/v1/fetch` return 15-minute V4 signed URLs, signed through IAM signBlob with no stored key. Test first whether a signed URL against the Requester Pays bucket needs `userProject` in the signed request; if it fails, the broker gets its own non-RP copy.
    - Idempotent debits, the allowance and its pool, caps per key, and re-issue.
13. **CLI sign-in.** `fetch_data.py login` (device flow), `GENOMEOS_API_KEY`, the 0600 credential file, routing through the broker, and exit code 3.
14. **Website account page and download panel.** GitHub and Google sign-in. Keys can be created, named, capped and revoked. It shows the allowance and balance, a history with citations, and the price table.
15. **Payments, behind a flag.** Merchant-of-record checkout for top-ups of at least $10, a webhook that credits the ledger idempotently, receipts carrying the terms sentence, and refunds. No stored card by default.
16. **Teams and invoices.** Team wallets, invites by GitHub login or verified email, caps per member, quote to invoice, and statement CSVs.
17. **Reconciliation.** A monthly join of the billing export with the ledger, a published cost-recovery report, and an alert outside 95–105%.

**What this needs from the parallel storage/query design.**
1. Every published object, including new derived tables, goes through the access rule.
2. Any hosted endpoint on our compute stays bounded and anonymous, or waits for Phase 3 metering.
3. BigQuery tables are native and in the US multi-region.
4. The Parquet layout supports range-read pruning: row groups sorted by variant and H3 cell.

---

## 11. Risks

1. **The free tier's growth.** At 100x with GCS only, free egress is about $186 a month, and one spike reaches the 150% switch. That takes the free bucket offline for everyone, and it happens hours late because billing data lags (docs/cost-controls.md). *Mitigations:* mirror first (PR 4), the release guard, the scale-up track, and optionally the PR 10 switch mode.
2. **Hugging Face is "best-effort".** Free public storage is best-effort, and HF asks that large uploads be "as useful to the community as possible" (https://huggingface.co/docs/hub/en/storage-limits, re-read 2026-10-18). Its rate limits may change, and anonymous and free limits are "subject to change" (https://huggingface.co/docs/hub/en/rate-limits). *Mitigations:* GCS stays canonical, and objects that are free only because of the mirror keep their GCS copy in the bulk bucket, so losing HF means cost moves to requesters, not to us. Plan B is R2 or a sponsor.
3. **The web bucket is outside both the kill switch and this rule.** At 100x it is about $45 a month and grows with visits. *Mitigations:* fast-load sizing, and if needed a zero-egress host for web data.
4. **Friction for people with no cloud account, before Phase 3.** A billing account needs a payment method even for the trial, and some institution-managed accounts cannot create projects (https://docs.cloud.google.com/bigquery/docs/sandbox). *Mitigations:* the rule keeps the at-cost set empty for now, a PI can grant a role, research credits, the education waiver, and the Phase 3 trigger. Phase 3 triggers on the first at-cost object rather than on complaints, because people who bounce don't file issues.
5. **A BigQuery dataset path exposes a project id**, which the repository rule forbids committing today (`docs/repo-gcloud-auth.md`). *Mitigation:* a dedicated public project and an owner amendment (D4).
6. **Domain-restricted sharing.** For an organization created on or after 2024-05-03, `iam.allowedPolicyMemberDomains` is enforced by default, and exceptions need custom organization policies (https://docs.cloud.google.com/resource-manager/docs/organization-policy/restricting-domains, re-read 2026-10-18). If any project here sits under such an organization, `allUsers` and `allAuthenticatedUsers` grants may be blocked.
7. **Unverified, and each has a test step:**
   - whether a BigQuery sandbox can query a third party's `allAuthenticatedUsers` dataset, or subscribe to a sharing listing;
   - whether DuckDB-WASM range reads work against GCS after the CORS change;
   - whether DuckDB-WASM's HEAD probe fails on GET-only signed URLs (https://github.com/duckdb/duckdb-wasm/issues/1367);
   - whether DuckDB can send `x-goog-user-project` to a Requester Pays bucket;
   - whether a signed URL against a Requester Pays bucket needs `userProject` signed in;
   - whether trial credits cover Requester Pays egress;
   - whether Google bills for responses served from its edge caches (already open in docs/cost-controls.md).
8. **Immutability makes a misclassification permanent (R1).** Access is reviewed in the release PR, before the first upload.
9. **Terms mistakes.** The vocabulary split, and new restricted fields that the tripwire doesn't yet know. *Mitigations:* the closed vocabulary (PR 2), the `CHARGEABLE` allowlist, and `docs/non-commercial-data.md` checks for each new source.
10. **Privacy.** BigQuery audit logs record queriers' principals and can't be disabled. Phase 3 download logs would show which variants a researcher studies. *Mitigations:* short log retention, minimal fields, 13-month retention of statement rows, no third-party analytics, and a privacy notice. EU users need GDPR-grade handling.
11. **Phase 3 specific.**
    - There is no seller yet.
    - Merchant eligibility review could refuse "data" products. Stripe's information-services codes exclude "data brokering" (https://docs.stripe.com/payments/managed-payments/eligibility).
    - Ledger bugs. *Mitigations:* pure, tested modules, idempotency and reconciliation.
    - Allowance abuse with throwaway accounts. The $50 pool bounds it; after that, require an account older than 30 days or a first top-up.
    - Leaked signed URLs, mitigated by a 15-minute expiry and a charge per URL issued.
    - Liability for prepaid balances and consumer law. The merchant of record applies cooling-off rules.
12. **Requester surprise bills.** Egress to China or Australia costs more, and charges aren't itemized per bucket. *Mitigations:* the estimate, `--max-spend` and the dedicated-project advice.
13. **Storage is never recouped.** At terabyte scale, Standard storage costs about $20 per TB-month (https://cloud.google.com/storage/pricing). *Mitigations:* Coldline for cold at-cost classes (the requester pays retrieval), deduplicated keys, and pruning old BigQuery releases.
14. **The PR 10 switch mode needs `storage.buckets.update`**, which is as powerful as today's `setIamPolicy`. That is the owner's call.

---

## 12. Decisions only the owner can make

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve the free/paid rule and its constants: `OPEN_CLASSES` as today's roots, at any size; 1 GiB per object; 2 GiB GCS-only per release; the `CHARGEABLE` allowlist; overrides that can only open. | Approve. Changes go only through reviewed PRs. |
| D2 | A data licence for project-authored data and outputs. Apache-2.0 covers code only. | CC BY 4.0. It is a prerequisite for ever charging for exported fits (#471) and for any sponsor mirror. |
| D3 | Record WorldPop's terms check, and, optionally, ask AFND and MAP for written permission covering third-party mirrors. | Record WorldPop (the hub states CC BY 4.0); a PR records the evidence. Ask AFND and MAP only if the scale-up track triggers. |
| D4 | Create a dedicated public project for BigQuery, and allow committing that one project id. Optionally, the same project also holds the bulk bucket and, later, the broker, kept apart from the free tier's kill-switch project. | Yes, one new "public access" project for BigQuery and the bulk bucket. Decide in Phase 3 whether the broker and ledger join it or get a third project whose id stays uncommitted. |
| D5 | Create an org-owned Hugging Face dataset for release mirroring, and amend C8 to admit committed zero-egress hosts. | Yes, now. It is the cheapest protection for the $200 budget. |
| D6 | Kill switch behaviour at 150%: make the bucket private (today), or turn Requester Pays on so billed users can continue (PR 10). | Requester Pays mode, once PR 7 exists, so there is a client that can use it. |
| D7 | Phase 3: go or no-go, and its trigger. Who the legal seller is. Which merchant of record (Paddle or Stripe Managed Payments). The allowance pool ($0 or up to $50 a month). Team credit on PO or on payment. | The trigger is the first scheduled `at_cost` object. Paddle, because one merchant of record handles both checkout and PO invoices. A $50 pool. Credit on payment. |
| D8 | Which statuses the Phase 3 broker may sell, given the merchant's "all necessary rights and licenses" attestation: the full `CHARGEABLE` allowlist, or only sources with a recorded licence or permission. | Only a recorded licence or permission, for the broker. Requester Pays, where we take no money, may use the full allowlist. |
| D9 | Whether the parallel design may run any unbounded query endpoint on our compute before Phase 3. | No. Bounded lookups only; heavy SQL goes to BigQuery or the client. |
| D10 | The scale-up trigger, and the dedicated AWS account an AWS Open Data application needs. | Free GCS egress over $50 a month for two months, or any PR that raises the release guard. |

---

## Appendix A: sources

**Re-read on 2026-10-18 while judging (quotes above come from these pages):**
- https://docs.cloud.google.com/storage/docs/using-requester-pays (last updated 2026-10-13)
- https://docs.cloud.google.com/bigquery/docs/sandbox (last updated 2026-10-15)
- https://docs.cloud.google.com/bigquery/docs/locations
- https://docs.cloud.google.com/bigquery/docs/global-queries (via search results)
- https://docs.cloud.google.com/bigquery/public-data
- https://docs.cloud.google.com/billing/docs/how-to/data-transfer-waiver
- https://docs.cloud.google.com/resource-manager/docs/organization-policy/restricting-domains
- https://stripe.com/managed-payments
- https://docs.stripe.com/payments/managed-payments/eligibility
- https://www.paddle.com/pricing
- https://info.orcid.org/public-client-terms-of-service/
- https://aws.amazon.com/opendata/faqs/
- https://huggingface.co/docs/hub/en/rate-limits
- https://huggingface.co/docs/hub/en/storage-limits
- https://help.openalex.org/access/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://duckdb.org/docs/current/core_extensions/httpfs/hugging_face.html
- https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en

**Did not render here, so the figures are carried from the input research pass, which read them on 2026-10-18:**
- https://cloud.google.com/storage/pricing
- https://cloud.google.com/bigquery/pricing
- https://cloud.google.com/identity-platform/pricing
- https://cloud.google.com/signup-faqs

**Carried from the input designs and research, all read 2026-10-18:**
- Google Cloud:
  - https://cloud.google.com/free/docs/free-cloud-features
  - https://cloud.google.com/run/pricing
  - https://cloud.google.com/storage/docs/access-control/signed-urls
  - https://docs.cloud.google.com/storage/docs/requester-pays
  - https://cloud.google.com/bigquery/docs/control-access-to-resources-iam
  - https://docs.cloud.google.com/bigquery/docs/analytics-hub-introduction
  - https://docs.cloud.google.com/bigquery/docs/custom-quotas
  - https://docs.cloud.google.com/logging/docs/audit/configure-data-access
  - https://docs.cloud.google.com/logging/quotas
  - https://docs.cloud.google.com/billing/docs/how-to/invoiced-billing
  - https://docs.cloud.google.com/billing/docs/how-to/budgets
  - https://cloud.google.com/docs/authentication/application-default-credentials
  - https://developers.google.com/identity/protocols/oauth2/native-app
  - https://edu.google.com/programs/credits/research/
  - https://support.google.com/accounts/answer/27441
- Payments: https://stripe.com/pricing, https://stripe.com/billing/pricing, https://stripe.com/invoicing/pricing, https://developer.paddle.com/build/invoices/create-issue-invoices/
- Identity and storage services: https://firebase.google.com/docs/firestore/quotas, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps, https://developers.cloudflare.com/r2/buckets/public-buckets/
- DuckDB and Hugging Face: https://duckdb.org/docs/current/core_extensions/httpfs/https.html, https://github.com/duckdb/duckdb-wasm/issues/1852, https://github.com/duckdb/duckdb-wasm/issues/1367, https://github.com/huggingface/datasets/issues/7931, https://huggingface.co/docs/hub/en/datasets-gated
- Sponsors and archives: https://aws.amazon.com/opendata/open-data-sponsorship-program/, https://support.zenodo.org/help/en-gb/1-upload-deposit/80-what-are-the-size-limitations-of-zenodo, https://gnomad.broadinstitute.org/news/2025-07-azure-open-datasets-deprecation
- Products ruled out (§9):
  - https://cloud.google.com/apigee/pricing
  - https://cloud.google.com/apigee/docs/api-platform/monetization/overview
  - https://cloud.google.com/bigquery/docs/analytics-hub-cloud-marketplace
  - https://cloud.google.com/terms/marketplace-revenue-share-schedule
  - https://docs.cloud.google.com/marketplace/docs/partners/data
  - https://cloud.google.com/endpoints/docs/openapi/quotas-overview
  - https://cloud.google.com/cdn/pricing
  - https://developers.google.com/earth-engine/guides/noncommercial_tiers
  - https://www.ukbiobank.ac.uk/use-our-data/fees/
- Terms and security: https://creativecommons.org/licenses/by-nc/4.0/legalcode.en, https://malariaatlas.org/open-access-policy/, https://hub.worldpop.org/, https://www.miggo.io/vulnerability-database/cve/CVE-2022-31027

**Repository facts** come from `origin/main` at `e1706b4`. They were computed from `data/releases/2026-10-18.json`:
- 248 objects and 271,494,507 bytes; the largest object is 7,517,799 bytes;
- by source: AFND 113 objects (89.2% of bytes), WorldPop 62 (85.8%), genomeos 103, MAP 20, CPIC 10, ClinVar 6, GeneReviews 6.
