# genomeOS Atlas data structure — Design

2026-10-18 · draft for owner review. This design answers the question "as the database grows, which
of GCP's queryable database formats fits our data?" It builds on the data store design
(`docs/superpowers/specs/2026-10-17-data-store-on-gcs-design.md`), the automated refit design
(branch `docs/automated-refit-design`) and the v1 design (§3, §5, §6, §10, §12). Proposed home:
`docs/superpowers/specs/2026-10-18-atlas-data-structure-design.md`.

## Summary

**Don't add a database server. Keep the files.** Use the GCP product we already use, Cloud Storage,
holding Parquet files. Give those files a principled structure: named tables, each with a frozen
contract, laid out so that a query reads only the few kilobytes it needs. Publish a small catalog
file with every release, so that anyone can open the whole Atlas in DuckDB with one line and no
account.

Why: our data is small (0.27 GB today, roughly 45 GB at 100 times the size). It is written once and
never changed, and it is read mostly by people who have no cloud account. Cloud SQL, AlloyDB,
Spanner and Bigtable bill by the hour whether or not anyone queries them, from about $8 to about
$475 a month. Firestore bills every public document read to us. None of them can serve the public
without an API that we would also have to build, run and pay for. BigQuery is the one GCP database worth keeping in mind,
but every BigQuery query needs a Google account and a Cloud project. So it can only ever be an
optional mirror, added later if observations reach whole-genome scale. It cannot be the main path.

What has to change is the *shape* of the files. Today's 61 surface files each hold one block of
77,844 rows. Asking "what is every surface's value at Lagos?" therefore reads **136.7 MB** across
the 31 res-4 surfaces. With a cell-major copy split by H3 base cell, the same answer reads
**0.32 MB**, about 430 times less (measured, §11). At 100x, that difference decides whether we stay
inside the $200 budget. The one first-class table we still lack is the observations table. The fit
input now being added to each artifact (`observations.parquet`) is the right start, with one fix
for KIR, which has to land before the first KIR artifact is released under the new rule (§7).

---

## 1. The question, and the short answer

The owner asked which of GCP's queryable database formats makes the most sense as the data grows.
The answer depends on four properties of our data:

1. **Written once, read many times.** Artifacts are immutable and keyed by
   `(variant_id, model_version, data_version)`. Release keys are create-only. Nothing is ever
   updated in place, so no workload needs transactions.
2. **Small, and growing in steps.** 0.27 GB now. About 45 GB at 100x: around 3,000 res-4 surface
   versions, curated-scale observations, and the web objects. Only the literal "whole genome,
   always available" reading of §10/§11 (about 1.2e10 observation rows) is large, and §10 below
   argues against mirroring it.
3. **Read by everyone, including people with no cloud account.** GPU pods that see only the public
   repo (#45), researchers with `curl`, browsers. The project's stated value is open access.
4. **Two kinds of reads.** Key-value reads (the website, `fetch_data.py`, the refit pipeline), and
   analytic reads (spatial filters, cross-variant scans, joins with the registry). No point
   lookups need millisecond latency at high write rates.

Analytic, append-only, read-mostly, public data with a small footprint is the textbook case for
columnar files on object storage, read by an embedded engine. The v1 design already chose this for
the interactive path: "DuckDB-on-Cloud-Run over parquet in GCS" (§3, §10). This design keeps that
choice. It makes the files queryable by the public as well as by our API, and it says when (and
when not) BigQuery should join.

## 2. How the three candidate designs scored

Each was scored 0–10 on six criteria: fit to our data and queries; cost now and at 100x; access
for everyone; integrity (immutability, provenance, invariants); operational burden for a tiny
team; and migration effort from today.

| Design | Fit | Cost | Access | Integrity | Ops | Migration | **Overall** |
|---|---|---|---|---|---|---|---|
| A. Cost: files only, partition-pruned derived tables, catalog file | 7 | 9 | 8 | 7 | 8 | 8 | **7.5** |
| **B. Access: researcher-first tables + view-only DuckDB catalog + `tables.json`** | **9** | **8** | **10** | **8** | **7** | **8** | **8.5** |
| C. Integrity: measured/inferred prefixes, frozen table contracts, `catalog.sql` | 8 | 8 | 8 | 10 | 6 | 6 | **7.5** |

**Why A loses points.** It rebuilds one cell-major table of *every* version on every release. On
14 GB free runners ([GitHub runners][gh-runners]) that rebuild stops fitting before 100x. Every
release would also re-upload the whole table under new keys. Its observation key lacks
`ingest_version`, its registry tables are not keyed by `registry_version`, and it gives non-DuckDB
users no list of URLs. Its cost analysis is the best of the three, and it measured the payoff of
H3 res-0 partitioning.

**Why B wins.** It is the only design that treats "for everyone" as a requirement and not an
aside. It has:
- observation files per `(source, ingest_version)` that describe themselves;
- a `fit_inputs` link table, so observations are never copied next to surfaces;
- append-only cell-major *delta* parts, so nothing is rewritten;
- registry tables keyed by `registry_version`;
- `meta.release` with a `cite_as` string;
- `tables.json` for Polars, pandas and R users;
- a verified offline mode;
- a golden-count smoke test after each upload.

Two details needed fixing:
- Its single-file delta parts read about 2.6 MB per point query. Partitioning each part by H3 base
  cell (A's idea) cuts that to 0.32 MB.
- Its table macros, as written, fail when the catalog is attached under an alias (§3.5, tested).

**Why C loses points.** Its integrity ideas are the best of the three, and most are grafted below.
But it moves new artifacts to a new path (`tables/inferred/surface_cells/v3/entity=…`). That would
split the citable artifact across two layouts and touch `publish_artifacts.py`, the
`ARTIFACT_PREFIX` rule in `build_data_release.py`, the refit design and the fit-input step now in
flight. It also partitions about 10K observation rows three levels deep, and it rebuilds a full
cell index on every change of the served pin.

**Winner: B, with these grafts.**
- From C: physical and catalog separation into `measured/`, `inferred/`, `reference/`,
  `evidence/` and `meta/`; frozen per-table contracts stamped into Parquet metadata; a build check
  that partition values equal the values in the file; `catalog.sql` as the canonical, diffable
  catalog; a stability test for `source_record_id`; the web observations JSON regenerated as a
  projection, never a second source.
- From A: H3 res-0 partitioning; zstd and row-group rules; budgeting as a byte allowance with a
  "mean query under 1 MB" target; Cloud CDN only past a stated break-even; BigQuery native tables
  as a later, labelled mirror.

## 3. The structure

### 3.1 Five rules

1. **The canonical artifact does not move.** `store/artifacts/<variant>__<model>__<data>/` stays
   the citable unit: `cells.parquet`, `observations.parquet` (new, §7) and `manifest.json`. Its
   keys never change.
2. **Everything else is a derived table that can be rebuilt.** It lives under `tables/v1/`, is
   built deterministically from released bytes only, and records the sha256 of its inputs. A
   derived table is never cited, and never the only copy of a fact.
3. **What was measured and what was inferred never share a table, a file or a prefix.** The
   catalog exposes them as different schemas, and no view joins them except through the
   `fit_inputs` link of keys. Allele counts and carrier counts are separate tables too (§4, §7.1b).
4. **Append-only.** A table file, once released, is never rewritten. Growth arrives as new files
   (a new `ingest_version`, a new epoch of cells), so a later release reuses the earlier keys
   unchanged, as `build_data_release.py` already does.
5. **Every read is by key, with no listing.** The bucket grants `allUsers` only
   `legacyObjectReader`, which is exactly `storage.objects.get` and cannot list
   ([GCS IAM roles][gcs-iam]). So the catalog names every file explicitly. Keys use only
   `[A-Za-z0-9._=/-]`. `:` becomes `__` as today, and no `%` escape appears in any key.

### 3.2 Layout

Bucket and key rule unchanged: `https://storage.googleapis.com/genomeos-atlas-data/releases/<R>/<path>`,
plus `manifests/<R>.json`. Below, `<R>` is the release that *first* published the file.

```
store/artifacts/<variant>__<model>__<data>/          CANONICAL, unchanged keys
    cells.parquet                                     the citable surface
    observations.parquet                              NEW: the exact table the fit consumed (§7)
    manifest.json                                     records both files' identity

tables/v1/                                            DERIVED, query-shaped, rebuildable
  measured/
    allele_observations/source=<s>/ingest_version=<iv>/part-0.parquet
    carrier_observations/source=<s>/ingest_version=<iv>/part-0.parquet
    ingests.parquet                                   (source, ingest_version) -> registry_version, input sha256s, n_rows
    fit_inputs/epoch=<R>/part-0.parquet               keys only: artifact -> (ingest_version, source_record_id)
  inferred/
    artifacts.parquet                                 one row per artifact version (from manifest.json)
    cells_by_cell/epoch=<R>/res=<k>/h3_r0=<cell>/part-0.parquet
    burden_cells/epoch=<R>/res=<k>/h3_r0=<cell>/part-0.parquet      (P3, when it exists)
  reference/
    populations/<registry_release>/{populations,population_aliases}.parquet
    variants/<registry_set>/variants.parquet          curated set + variant_normalization
    grid_cells/<grid_sha8>/part-0.parquet             WorldPop res-4 rollup (after #472)
  evidence/
    crossval.parquet, refit_qc.parquet                flattened from validation/**
  meta/
    release_objects.parquet, sources.parquet, served.parquet, withdrawn.parquet

catalog/
  catalog.sql                                         CANONICAL catalog: CREATE VIEW over exact URLs
  atlas.duckdb                                        convenience build of catalog.sql (~270 KB)
  tables.json                                         table -> [{key, url, sha256, bytes, rows}]
```

What changes from today: only additions. `validation/`, `registry/`, `raw/` and `sources/` keep
their keys, and the catalog adds views over them. The web bucket is not part of this structure. It
stays a key-value store for the browser. It is also unsuitable for queries: its objects are
gzip-encoded, and Cloud Storage silently ignores `Range` on transcoded objects and bills the whole
object ([GCS transcoding][gcs-transcoding]).

### 3.3 Tables, keys and partitioning

| Table (catalog name) | Primary key | Partitioned by | Sorted by | Notes |
|---|---|---|---|---|
| `measured.allele_observations` | `(ingest_version, source_record_id)` | `source=`, `ingest_version=` | `variant_id, population_id, source_record_id` | Exactly the 17 `OBSERVATIONS_SCHEMA` columns. No frequency column exists, and no view derives `ac/an`. |
| `measured.carrier_observations` | same | same | same | `CARRIER_OBSERVATIONS_SCHEMA` (`carriers`, `n_individuals`). Never unioned with allele counts. |
| `measured.ingests` | `(source, ingest_version)` | — | — | `registry_version`, adapter git SHA, input `{path,sha256}` list, `n_rows`. |
| `measured.fit_inputs` | `(variant_id, model_version, data_version, ingest_version, source_record_id)` | `epoch=` | artifact key | Keys only. `evidence` = `fit-record` (from `observations.parquet`) or `web-json-match` (legacy rebuild, §8 step 6). |
| `inferred.artifacts` | `(variant_id, model_version, data_version)` | — | key | Every `manifest.json` field, plus `cells_key`, `cells_sha256`, `observations_sha256`, `first_release`, `measurement`. |
| `inferred.cells_by_cell` | `(variant_id, model_version, data_version, res, h3_index)` | `epoch=`, `res=`, `h3_r0=` | `h3_index, variant_id, model_version, data_version` | Today's 14 columns plus `h3_r0`, `h3_parent_r3` (res ≥ 4) and `measurement`. Columns added in later formats are NULL for older artifacts, and `artifact_format` says which. |
| `reference.populations` | `(registry_version, population_id)` | registry release in path | `population_id` | `uncertainty_radius_km` has no default; `location_type`, `provenance`, `biocultural_notice` as in P0. |
| `reference.population_aliases` | `(registry_version, source, label)` | same | — | Joins today's web JSON `population_label` until `population_id` is carried. Explicit legacy rows for `afnd-2026-08` and `map-survey-coordinates-v1`. |
| `reference.variants` | `(registry_set, variant_id)` | set in path | — | `curated_variants.tsv` and `variant_normalization.tsv`. |
| `reference.grid_cells` | `(grid_sha, h3_index)` | grid in path | `h3_index` | `h3_r0`, `lat`, `lon`, `worldpop_pop`. Needed for any population-weighted aggregate. |
| `meta.release_objects` | `(release, path)` | — | — | Every committed manifest, flattened: `key`, `bytes`, `sha256`, `media_type`, `in_git`, `sources[]`. |
| `meta.sources` / `served` / `withdrawn` | source id / artifact key / key | — | — | Terms status and `non_commercial`; the served pin; `WITHDRAWN.json`. |

**Why these partition keys.**
- `h3_r0` is the H3 resolution-0 parent. It is a prefix of the index, free to compute and stable
  forever. The served res-4 grid has 93 non-empty base cells: at most 2,387 cells per partition,
  median 631 (measured). Finer `h3_r1` partitions (458 files) read the same bytes in the test and
  only multiply objects, so res 0 is the choice.
- `res=` keeps the res-3 (v1/v2) and res-4 (v3) grids apart. Res 5 and 6 slot in as new values
  when they are emitted.
- `epoch=` is the release that first published a part. It makes the table append-only: a release
  writes cells only for the artifacts it adds. **Compaction** merges epochs into a new epoch when
  more than 16 accumulate. It runs one `h3_r0` partition at a time, so it fits a 14 GB runner even
  at 100x. Older catalogs keep naming their own parts, so they keep working.
- Observations are partitioned by `source=` and `ingest_version=`, because an ingest is published
  whole and once, so its file never changes. Within a file, row-group min/max on `variant_id`
  prunes per-variant reads. A further `chrom=` level is added only to an ingest that passes about
  1 GB, such as a genome-scale gnomAD ingest. That generalises `ingest.py`'s `chrom=` without its
  `chrom=phenotype%3Ag6pd` escape in a URL.
- Partition values also stay as columns inside each file, so a single file fetched with `curl`
  keeps its provenance. A build check refuses any file whose path value differs from its contents.
  DuckDB accepts a hive column that is also in the file (tested).

### 3.4 Formats and encoding rules

- Parquet only, written by one pinned DuckDB version. **zstd** compression for `tables/` (egress
  is the bill: −29% on a surface, measured).
- **Row groups of 8,192 rows for surface tables; never one row group per file.** That single change
  is what lets HTTP range reads skip data. DuckDB fetches only what the Parquet metadata says a
  query needs ([DuckDB HTTPS][duckdb-https]).
- `h3_index` stays the hex string (as in today's artifacts and the web GOSA objects). `lat`, `lon`
  and `radius_km` / `uncertainty_radius_km` stay explicit DOUBLE columns, never folded into a
  geometry, so the extent stays visible (§6). GeoParquet geometry ([GeoParquet][geoparquet]) can
  be added later as an additive column.
- Files of 1–50 MB; never above ~150 MB (composite uploads have no md5).
- Each file carries Parquet key-value metadata: `genomeos.table`, `genomeos.schema_version`
  (MAJOR.MINOR), `genomeos.contract_sha256` and the producing git SHA. Contracts live in
  `contract/tables/<table>.v<MAJOR>.schema.json`, frozen from the pandera schemas as
  `scripts/freeze_contract.py` already does. A MINOR change is additive. A MAJOR change is a new
  `tables/v2/` directory beside `v1`, which stays listed.
- New artifacts (format 2.1) keep their path and columns but use zstd and 8,192-row groups and add
  `h3_parent_*` columns. This helps the P4 API's per-variant viewport reads.
- Add `.sql` (`application/sql`) and `.duckdb` (`application/vnd.duckdb`) to `MEDIA_TYPES`
  deliberately.

### 3.5 The catalog

`catalog/catalog.sql` is the canonical catalog. It is plain text, `CREATE SCHEMA` / `CREATE VIEW` /
`CREATE MACRO` over the exact HTTPS URLs that the release manifest lists. It is reviewed by diff.
From it the build makes:
- `atlas.duckdb`: a view-only DuckDB database file, the pattern DuckDB documented on 2026-10-07
  ([DuckDB view-only][duckdb-viewonly]). Readers attach it read-only over HTTPS
  ([DuckDB over HTTPS][duckdb-attach]).
- `tables.json`, for any Parquet reader.

Readers then have three paths, none of which needs an account:

```sql
-- 1. DuckDB CLI, Python, R or the WASM shell
ATTACH 'https://storage.googleapis.com/genomeos-atlas-data/releases/<R>/catalog/atlas.duckdb' AS atlas (READ_ONLY);
SELECT * FROM atlas.measured.allele_observations WHERE variant_id = 'chr11-5227002-T-A';
-- 2. any DuckDB: run catalog.sql, then the same SELECT
-- 3. Polars / pandas / arrow: read the URLs listed in tables.json
```

**Verified offline mode** (from B). After `fetch_data.py --set tables` has fetched and
sha256-checked the files, `SET VARIABLE genomeos_local = 'data/'` makes every view read the local
copies. Remote reads are not hash-checked by DuckDB or Polars. A reader who needs proof uses this
mode.

**Catalog gotchas, tested (§11):**
- Views that read other views work through `ATTACH`.
- A **table macro that names a catalog view fails** when the file is attached under an alias
  (`schema "measured" does not exist`), unless the reader first runs `USE atlas`. So macros must
  read `read_parquet([...])` directly. The builder generates them that way.
- Two builds of the same `.duckdb` with the same DuckDB version were byte-identical, with and
  without `STORAGE_VERSION 'v1.2.0'`. The two storage versions differ from each other. Design C
  observed a 2-byte difference in its own builds. So `catalog.sql` is canonical, the `.duckdb` is
  pinned by sha256, and CI builds it twice and compares.
- DuckDB reads files written by older versions. Reading a file written by a newer version is
  "best-effort" ([DuckDB storage][duckdb-storage]). So pin the writer, and test that the oldest
  supported client can still attach.
- HTTP paths cannot be globbed and the bucket cannot be listed, so every view lists its files
  explicitly (`read_parquet([...], hive_partitioning = true)`). DuckDB skips files whose partition
  values do not match ([DuckDB hive][duckdb-hive]). In the test it opened 2 of 93 files: the
  first, for the schema, and the match.
- **No stable "latest" pointer in the bucket.** That would be an overwrite. The Pages site serves
  `/data/releases/latest.json`, naming the newest catalog URL, and `meta.release` inside every
  catalog names its own release, manifest sha256 and a `cite_as` string.

### 3.6 Build-time integrity checks (all hard errors, §12)

1. Each table file matches its frozen contract (columns, types, key-value metadata).
2. Path partition values equal the in-file values. No file sits under both `measured/` and
   `inferred/`.
3. Measured:
   - pandera validation on write;
   - `(ingest_version, source_record_id)` is unique;
   - every row of every artifact's `observations.parquet` appears, identical, in its ingest file
     (fit input ⊆ ingest);
   - the allele and carrier tables are routed by contract, never by column guessing.
4. Re-ingesting the same raw input yields the same `source_record_id` set (per-adapter contract
   test; `stable_source_record_id` already hashes source-native keys).
5. Every `population_id` resolves in its pinned `registry_version`, so the anti-join is empty.
   Sources that carry their own coordinates (MAP) are marked, and their coordinates stay
   authoritative.
6. For each artifact, the rows in `cells_by_cell` equal the canonical `cells.parquet`: the row
   count, plus an order-independent checksum. Each artifact sits in exactly one epoch.
7. Every URL in `catalog.sql` and `tables.json` is a manifest key with a matching sha256. No key
   is in `WITHDRAWN.json`. Every view binds against the local copies. Two builds give the same
   `atlas.duckdb`.
8. After upload and `verify-remote`, an anonymous smoke test attaches the new catalog and checks
   golden counts. Example: on the parity set, observations whose disc reaches within 500 km of
   Lagos give 40 rows, sum `an` 52,340, sum `ac` 6,459.

## 4. How the likely queries run

Numbers marked *measured* come from §11. Prefix `atlas.` is omitted.

**Q1. Observations of V within 500 km of a point, counting the disc.**
```sql
SELECT population_id, ac, an, radius_km, sampling_design, disease_ascertainment_excluded,
       cohort_id, assay, source_record_id
FROM measured.near('chr11-5227002-T-A', 6.5244, 3.3792, 500);
-- expands to: WHERE variant_id = V AND gc_km(lat, lon, :lat, :lon) <= 500 + radius_km
```
It uses a haversine macro (R = 6371.0088 km) and needs no spatial extension. That matters, because
DuckDB spatial's spheroid functions take `(lat, lon)` order, and design B saw a 40-to-39 row error
from swapping them. Row-group statistics on `variant_id` skip other variants.
*Measured* on the 994-row parity parquet: 53 KB in 4 requests, 40 rows.

**Q2. Every surface at one cell, across all variants and versions, mapping res 4 to res 3.**
```sql
SELECT variant_id, model_version, data_version, res, post_median, q025, q975, support,
       posterior_contraction, dist_nearest_obs_km
FROM inferred.cells_by_cell
WHERE h3_r0 = :r0 AND (h3_index = :c4 OR h3_index = :c3_parent);
```
Then LEFT JOIN `inferred.artifacts`, so an artifact whose grid lacks the cell comes back with
`on_grid = false` rather than vanishing. Design B found that 10.1% of res-4 cells have no res-3
parent row.

*Measured*, all 31 res-4 surfaces, Lagos `84589c9ffffffff`:

| Layout | Read | Requests |
|---|---|---|
| Today's files | 136.7 MB | 218 |
| One cell-major file | 2.6 MB | 12 |
| Cell-major, partitioned by `h3_r0` | 0.32 MB | 11 |

Readers without the h3 extension can use `h3_parent_r3` and plain string equality.

**Q3. Observations joined to the registry, with the ascertainment mix.**
```sql
SELECT p.location_type, o.sampling_design, o.disease_ascertainment_excluded, o.assay,
       count(*) n, sum(o.an) sum_an, sum(o.ac) sum_ac
FROM measured.allele_observations o
JOIN measured.ingests i USING (source, ingest_version)
LEFT JOIN reference.populations p
  ON p.population_id = o.population_id AND p.registry_version = i.registry_version
WHERE o.variant_id = 'hla:a-02-01' GROUP BY ALL;
```
To restrict this to the rows behind one surface, add
`JOIN measured.fit_inputs f USING (ingest_version, source_record_id)`. Under 1 MB: the registry is
about 2K rows. This needs §8 steps 5–6.

**Other likely queries:**
- **Release diff, and "does this derived key exist in any release?"** (the refit selection rule):
  one statement over `meta.release_objects` (FULL OUTER JOIN on `path` of R1 against R2;
  `EXISTS ... WHERE path LIKE 'store/artifacts/<key>/%'`).
- **Old versus new surface (refit QC):** unchanged. The refit pipeline reads the two canonical
  `cells.parquet` files and joins on `h3_index`. Grids are identical by rule.
- **Observation diff between two data_versions:** FULL OUTER JOIN of the two artifacts'
  `fit_inputs` on `source_record_id`, classified as added, removed or changed, and grouped by
  `source`, `sampling_design` and `cohort_id`. Both sides are byte-identified inputs, not two
  rebuilds.
- **Population-weighted mean over a region (`/aggregate`):** `inferred.cells_by_cell` joined to
  `reference.grid_cells` over the region's cells. It excludes `unknown` and `prior_dominated` and
  returns the excluded fraction. It runs in the P4 API (DuckDB over the same files) or on a laptop.
- **Coverage gaps:** cells where every artifact's `support` is `unknown` (GROUP BY `h3_index`
  HAVING `bool_and`).
- **Counts by source, design or assay; sum of `an` near a cell; registry populations with no
  observations:** GROUP BYs and anti-joins on the measured and reference tables.
- **Terms filter:** `meta.release_objects` joined to `meta.sources` on
  `terms_status`/`non_commercial`.
- **Every version of V, its first release, the served pin, withdrawal:** `inferred.artifacts`
  joined to `meta.served` and `meta.withdrawn`.
- **Burden draw by draw:** stays offline batch (P3). Draw matrices are not in `tables/` (§10).
- **Website:** unchanged: key-value reads from the web bucket.

## 5. Cost now and at 100x

**Prices used.** Cloud Storage Standard in us-east1 is $0.020/GB-month. Class B operations cost
$0.0004 per 1,000. Internet egress to the Americas and EMEA is $0.12/GB up to 1 TB, then
$0.11/GB ([GCS pricing examples][gcs-examples]). Always Free gives, per billing account and shared
with the web bucket: 5 GB-months of storage in us-east1/us-west1/us-central1, 50,000 Class B
operations, and 100 GB of egress from North America each month ([Free tier][free-tier]). There is
no compute: builds run on free GitHub-hosted runners ([GitHub runners][gh-runners]). **Idle cost is
$0.**

**The budget as bytes.** $200 a month buys about **1.75 TB of egress**: 100 GB free plus about
1.65 TB at ≤ $0.12. The 150% kill switch ($300) corresponds to about 2.6 TB. So the design target
is a mean SQL query under 1 MB, and that the default download must not be the whole tree.

**Measured unit costs:**

| Read | Bytes | Cost |
|---|---|---|
| A point query on the partitioned table | 0.32 MB | ~$0.04 per 1,000 |
| A catalog attach | 0.55 MB | ~$0.07 per 1,000 |
| An Atlas session (critical path, fast-load spec target) | ~0.43 MB; ~1.5 MB with detail and observations | ~$0.18 per 1,000 |
| A full release download today | 0.27 GB | $0.03 |

**Now**

| Item | Assumption (per month) | Amount | Cost |
|---|---|---|---|
| Storage | data store 0.27 GB + tables 0.17 GB + web 0.29 GB | 0.73 GB | $0 (list ≈ $0.015) |
| Egress | 10,000 Atlas sessions (15 GB) + 20 full downloads (5.4 GB) + 2,000 queries (0.6 GB) + 500 attaches (0.3 GB) + CI/refit (2 GB) | ≈ 23 GB | $0 (list ≈ $2.80) |
| Class B ops | ≈ 110K GETs | — | ≈ $0.02 |
| Compute | none | — | $0 |
| **Total** | | | **≈ $0** |

**At 100x.**
- Data: about 3,000 res-4 surface versions × 5.3 MB (zstd) ≈ 16 GB canonical; cell-major deltas
  ≈ 14 GB (0.9x the zstd surfaces, measured); fit inputs ≈ 0.15 GB; measured tables ≤ 1 GB; web
  objects ≈ 15 GB. That is about **46 GB**, ≈ **$0.80/month**. Storage is never the driver: optional
  posterior draws (698 × ~150–311 MB) would add only about $2–4/month of storage, but each
  full download of them would cost $12–26.
- Traffic: two scenarios, because "100x" can mean data or users.

| Scenario | Egress | Monthly cost | Verdict |
|---|---|---|---|
| (a) 100x data, 10x users: 100K sessions (150 GB), 20K queries (20 GB), 200 served-set downloads × 4 GB (800 GB), CI (20 GB) | ≈ 1.0 TB | ≈ **$110** | Inside budget; bulk downloads are 80% of it. |
| (b) 100x data, 100x users, same mix | ≈ 9.7 TB | ≈ **$1,050** | Over budget. The kill switch makes the data store private at $300, but the web bucket keeps billing. |
| (b) with bulk moved to a free mirror and the Atlas behind Cloud CDN | 1.5 TB Atlas via CDN + 0.1 TB queries | ≈ **$155** | Inside budget. |

CDN arithmetic: cache egress is $0.08/GiB in North America under 10 TiB and cache fill $0.01/GiB
([Cloud CDN pricing][cdn-pricing]). That beats $0.12, but needs a forwarding rule at $0.025/hour,
about $18/month ([Load balancing pricing][lb-pricing]). Break-even is about 450 GiB/month of cached
egress.

**What this means.** The structure keeps *queries* cheap at any plausible scale. What threatens the
budget is *bulk downloads* and *Atlas traffic*, and a database would not fix either: it would only
add an idle bill on top. Three levers handle them:
1. `fetch_data.py` defaults to the served set plus the small tables, and the full tree becomes
   opt-in.
2. A hash-identical bulk mirror (the existing HF dataset, whose public storage is free on a
   best-effort basis ([HF storage][hf-storage])) is named in `meta.release`.
3. Cloud CDN in front of the web bucket once Atlas egress passes about 450 GiB/month. This is an
   owner decision, because it is a standing resource.

**If a BigQuery mirror is added later.** Our cost is storage only: 10 GiB free, then about
$0.02/GiB active and about half that after 90 days unmodified ([BigQuery pricing][bq-pricing];
[Free tier][free-tier]). That is under $1/month at 100x. Queries bill the querier's project at
$6.25/TiB after 1 TiB free ([BigQuery pricing][bq-pricing]).

## 6. What we deliberately do not use, and why

| Option | Why not (now) |
|---|---|
| **BigQuery native tables as the main path** | Every query needs a Google account and a project. Public datasets require you to "create or select a project", and the querier pays ([BigQuery public data][bq-public]). Even the sandbox needs a Google account, and its tables expire after 60 days ([BigQuery sandbox][bq-sandbox]). It is also a second, mutable copy that must be re-proven against the manifest. And it has no built-in H3. Keep it as an optional, labelled mirror (owner decision 2). |
| **BigQuery external / BigLake tables over our files** | No copy, but still account-gated. A wildcard URI needs `storage.objects.list`, which our public role lacks, and the bucket must be in the dataset's location ([BigQuery external tables][bq-external]). BigLake adds a connection resource, which is standing state the refit design rules out. |
| **BigQuery Iceberg managed tables** | Disqualified by mechanism. BigQuery compacts and garbage-collects the data files in the bucket and warns that changing them outside BigQuery "can cause query failure or data loss". GEOGRAPHY is unsupported, and partitioning is DATE/DATETIME/TIMESTAMP only ([BigQuery Iceberg][bq-iceberg]). That is the opposite of a create-only, hash-pinned store. |
| **The BigQuery batch path of v1 §3/§10** | The refit design runs fits on GitHub runners and rejected GCP-native compute. H3 rollups and GADM precomputation are small DuckDB jobs in CI. We propose retiring it (owner decision 3). |
| **Cloud SQL for PostgreSQL + PostGIS** | It bills by the hour while running, from about $8/month for the smallest shared-core instance ([Cloud SQL pricing][sql-pricing]; [aggregator][sql-agg]). It has no anonymous access, so we would run and pay for a public API. Its real strength, CHECK and foreign keys, is reproduced at build time (§3.6). It conflicts with "no standing GCP resources". The Pan-UKB evidence index may still use it; that is a separate layer. |
| **AlloyDB** | Same server model, about $227/month for the smallest 2 vCPU/16 GB shape ([AlloyDB pricing][alloydb-pricing]; [aggregator][alloydb-agg]). That is over the whole budget, for a sub-GB, read-mostly corpus. |
| **Spanner** | Built for globally distributed transactional writes, which we do not have. It bills provisioned compute capacity by the hour, with a one-hour minimum ([Spanner pricing][spanner-pricing]). |
| **Bigtable** | $0.65 per node-hour in Iowa, charged "even if your cluster is inactive", about $475/month for one node ([Bigtable pricing][bigtable-pricing]). It is a key-value store with no joins. |
| **Firestore** | Billed per document read, with 50,000 free reads a day ([Firestore pricing][firestore-pricing]). One surface is 77,844 documents, so one full read is 1.6 days of free quota, and every public read lands on our bill. |
| **Requester Pays** | Removes our egress risk but breaks credential-free reads: requests without a billing project fail with `400 UserProjectMissing` ([Requester Pays][requester-pays]). Already rejected (data store design §9.2). |
| **SQL against the web bucket** | gzip transcoding ignores `Range` and bills the whole object ([GCS transcoding][gcs-transcoding]), and its CORS is limited to the site's origins. |
| **DuckLake as the catalog (now)** | Attractive later: typed tables, snapshots, file-level statistics over existing files. But a persisted `DATA_PATH` cannot be changed after creation ([DuckLake remote data path][ducklake-path]), and it adds a second versioning system beside our manifests. Revisit once the layout settles. |
| **Mirroring whole-genome gnomAD** | gnomAD is already hosted in Cloud Storage and BigQuery as a Google public dataset ([gnomAD on GCP][gnomad-gcp]), and Azure hosting ended in 2025 ([gnomAD notice][gnomad-azure]). Our table should hold harmonised, ascertainment-labelled evidence at fitted and curated scope, and link to upstream for the rest (owner decision 1). |
| **Cloud CDN (now)** | A standing load balancer at about $18/month, for savings that start only near 450 GiB/month (§5). Revisit when the 50% budget alert fires twice. The v1 design (§10) already expects a CDN eventually. |

## 7. The per-artifact fit input (`observations.parquet`): does it fit?

**Yes. It is the canonical half of the observation layer, and it belongs exactly where it is.** The
artifact directory is the unit of citation and immutability. The fit input completes it, so that
a cell can be checked against the rows that produced it (#45). The release rule now being added
also fits this design's rule 1: a released artifact is a closed set of files and cannot gain one.
Here is how the rest of the structure uses it:

- `measured.fit_inputs` is derived from it: the artifact key plus
  `(ingest_version, source_record_id)`, with `evidence = fit-record`.
- The integrity check in §3.6 (fit input ⊆ ingest) reads it.
- The web observations JSON becomes a projection of it plus the registry, checked by digest, and
  never a second source.
- Keep it as written: the strict contract, deterministic bytes, the fit's own row order (derived
  tables do the sorting), and no hive layout inside the artifact.

**One change, before any KIR artifact is published under the new rule.**
`scripts/publish_artifacts.py` fits KIR through `afnd_carriers.as_binomial`, which renames
`carriers`/`n_individuals` to `ac`/`an`. `publish()` then records that frame as the fit input under
`contract/observations.schema.json`, the *allele-count* contract. So a KIR
`observations.parquet` would hold carrier counts in columns named `ac`/`an`, and only the
manifest's `measurement` field would say otherwise. A reader who fetches the file alone, or any
table built by unioning fit inputs, would mix carrier counts into allele counts. That breaks the
invariant that the two are separate tables.

The fix is small and costs nothing today, because no KIR artifact has been released with an input
yet. Once one is released it is immutable. For `measurement == "carrier_frequency"`:
1. Invert the rename and write the frame validated by `CARRIER_OBSERVATIONS_SCHEMA`. Record
   `schema: contract/carrier_observations.schema.json`, with columns `carriers`, `n_individuals`.
2. Teach `genomeos/publication/artifact_inputs.py` to accept that contract (counts `carriers` and
   `n_individuals`) when the manifest says `carrier_frequency`, and to refuse the allele contract
   there.

Optionally, also stamp `genomeos.table` and `genomeos.contract_sha256` into the file's Parquet
key-value metadata (§3.4), so the file identifies itself without its manifest.

## 8. Migration in small, PR-sized steps

Each step is additive, keeps every existing key, and is useful on its own.

| # | PR | Unblocks |
|---|---|---|
| 0 | **In the fit-inputs PR now:** KIR fit inputs under the carrier contract (§7). | The allele/carrier split survives into every table. |
| 1 | **Contracts and docs.** `contract/tables/*.v1.schema.json` frozen from pandera; `.sql` and `.duckdb` in `MEDIA_TYPES`; this spec committed; `docs/cost-controls.md` updated (it still says objects carry a one-year cache; live objects return `max-age=3600`, §11). | Every later step. |
| 2 | **`meta` tables.** Pure `genomeos/tables/meta.py` + `scripts/build_tables.py`, which flatten committed manifests, `WITHDRAWN.json` and the served pin into `meta/*.parquet`. No science. | Release diffs and the refit "key exists" rule become one SQL statement. |
| 3 | **`inferred.artifacts` + first `cells_by_cell` epoch** for the 61 existing artifacts: 93 partitions per resolution, about 170 MB, built in seconds. Gate: per-artifact count + checksum equality (§3.6.6). | Q2 at 0.32 MB instead of 137 MB. |
| 4 | **Catalog.** `catalog.sql` → `atlas.duckdb` + `tables.json`, written last in `build_data_release.py`; CI builds twice and compares; post-upload anonymous smoke test with golden counts. | No-account SQL for everyone. |
| 5 | **P0 registry release** under `tables/v1/reference/` via `genomeos/registry/publication.py`, with legacy `registry_version` rows for `afnd-2026-08` and `map-survey-coordinates-v1`. Gate: the anti-join is empty. | Q3, and exact registry joins. |
| 6 | **Measured tables.** The adapters' complete validated output per `(source, ingest_version)`, published once, whole (closes "no first-class observation table"). Until #472 publishes the raw inputs, a maintainer builds it where they exist. Gate: for each served artifact, rows match the published web observations JSON by `source_record_id` (count, `ac`, `an`, `lat`, `lon`, `radius_km`, `sampling_design`, `disease_ascertainment_excluded`, `cohort_id`); `fit_inputs` rows for these legacy artifacts carry `evidence = web-json-match`. | Q1, Q3, the observation diff. |
| 7 | **`fetch_data.py`** (standard library only): `--set served|tables|all`, defaulting to served + tables; `--urls` prints URLs for Polars and `curl`. | Caps bulk egress (§5). |
| 8 | **Web observations JSON as a projection** of the fit input + registry, adding `population_id`, `rsid`, `source` and the date fields under a web-format MINOR bump. | Website downloads join the registry. |
| 9 | **Artifact format 2.1** for new artifacts (zstd, 8,192-row groups, `h3_parent_*`); same path. | Cheaper per-variant viewport reads in P4. |
| 10 | **`reference.grid_cells`** from the WorldPop res-4 grid once #472 publishes it. | `/aggregate`, burden joins. |
| 11 | **P4 API on the catalog** (same files, sha256-checked `/tmp` cache, served pointer); `docs/data-access.md` with DuckDB/Python/R/WASM and Polars quickstarts, the offline mode and how to cite. | One schema for the API and the public. |
| 12 | **Triggered, not scheduled:** compact epochs at more than 16; manifest v2 (inherit from a parent release) when a manifest passes about 2 MB; Cloud CDN at about 450 GiB/month; a BigQuery mirror if whole-genome observations land. | Growth. |

## 9. Risks

- **The kill switch is all-or-nothing.** At $300 every anonymous query, fetch, GPU-pod job and
  refit staging fetch fails at once, while the web bucket keeps billing. Mitigations: the bulk
  mirror named in `meta.release`; the default-scope change (step 7); and treating the 50% alert as
  a call to investigate.
- **Bulk downloads, not queries, can trip the budget** (§5, scenario b). A scripted loop over the
  full tree is the realistic trigger.
- **Remote reads are not hash-checked.** Integrity over HTTPS rests on create-only uploads, and
  project Editors can still overwrite or delete (`cost-controls.md`). The offline mode and the
  smoke test are the proof paths.
- **Derived copies can drift.** The cell-major table duplicates 0.63x of the surface bytes. The
  equality gate is mandatory, and citations always resolve to the canonical artifact.
- **DuckDB coupling.**
  - View-only catalogs are new (2026-10-07).
  - Reading a file written by a newer DuckDB version is best-effort.
  - The h3 community extension ([DuckDB h3][duckdb-h3]) is untested on WASM.

  Mitigations: `catalog.sql` and `tables.json` keep plain Parquet readable by anything; pin
  versions; give recipes that work by string equality on `h3_index`.
- **Researchers' own SQL can include `unknown` or `prior_dominated` cells, or swap lat/lon.** The
  shipped macros exclude and report them, but raw views cannot stop it. The docs say so first.
- **Manifest growth.** Every release lists the full logical tree, and partitioning multiplies
  objects: about 14K at 100x, several MB of JSON per release in git. Mitigation: manifest v2 at a
  stated trigger.
- **Small files over time.** Each epoch adds up to 93 files per resolution. Compaction at 16
  epochs bounds the request count per point query (about 3 per epoch).
- **Observation identity.** Diffs and joins depend on `source_record_id` staying stable across
  ingests. A per-adapter contract test guards it (§3.6.4).
- **Scope creep toward a gnomAD mirror.** The layout scales to it, but that would turn harmonised
  evidence into an upstream copy, and one full download would cost $20–40.
- **Terms.** Queryable tables make reuse easy. GeneReviews is `non_commercial`, and `genomeos`,
  `worldpop` and others are `not_checked`. Every table carries `source` so that `meta.sources`
  can filter.

## 10. Decisions only the owner can make

1. **What "observations layer: whole genome, always available" (§10/§11) means.** Fitted and
   curated scope (recommended: about 56K rows from HGDP+1KG for the 698 candidates), or every
   gnomAD variant (about 1.2e10 rows)? If the latter, should we link to gnomAD's own GCS/BigQuery
   copy rather than mirror it? This single answer decides whether a warehouse is ever needed.
2. **Is "no account" a hard requirement for SQL?** Recommended: yes for the primary path, with any
   BigQuery mirror optional and labelled "derived, not citable".
3. **Retire the BigQuery batch path in v1 §3/§10?** Fits now run on GitHub runners, and the refit
   design rejects GCP-native compute.
4. **Default download scope and bulk mirrors.** Should `fetch_data.py` default to served + tables?
   Should the HF dataset (and/or a Zenodo record per release, where each version gets its own DOI
   ([Zenodo][zenodo])) become an official second home for bulk snapshots?
5. **Licence for project-authored data and model outputs** (`genomeos` and `worldpop` are
   `not_checked`). Queryable tables invite reuse, and a table without a licence cannot be reused.
6. **Posterior draw matrices** (about 311 MB per variant at res 4): publish them, and if so under a
   separate prefix excluded from the default fetch, or not at all?
7. **Cloud CDN + load balancer** (about $18/month standing) once Atlas egress passes about
   450 GiB/month. It conflicts with "no standing GCP resources".
8. **When to adopt manifest v2** (a release that inherits from its parent) instead of listing the
   full logical tree in every release.
9. **Confirm the Pan-UKB evidence index (PostgreSQL, Cloud SQL planned) stays a separate layer**,
   sharing neither storage nor query infrastructure with the Atlas tables.

## 11. Evidence: what was measured, and how

Measured locally on 2026-10-18, read only, with DuckDB 1.5.5, pyarrow 25.0.1 and h3 4.5.0. The
local copies of the release bytes were served by a byte-logging HTTP server that supports `Range`,
with DuckDB's HTTP metadata and file caches turned off. No cloud commands were run.

- **Today's surfaces.** 61 `cells.parquet` files, 2,763,564 rows, 266,415,953 B. Every file is one
  row group, snappy. 31 res-4 files hold 77,844 rows each (232,956,447 B); 30 res-3 files hold
  11,680 each.
- **Grid.** The res-4 grid has 93 res-0 parents (max 2,387 cells, median 631), 458 res-1 parents
  and 2,332 res-2 parents.
- **Point query** (Lagos `84589c9ffffffff`, 9 columns, 31 res-4 surfaces):

  | Layout | Read | Requests |
  |---|---|---|
  | Today's files | 136,697,644 B | 31 HEAD + 187 GET |
  | Same files, zstd + 8,192-row groups (165.0 MB, −29%) | 10,272,703 B | 218 |
  | One cell-major file, 65,536-row groups (147.3 MB, −37%) | 2,645,971 B | 12 |
  | Cell-major, hive by `h3_r0` (93 explicit URLs, 148.4 MB) | 318,873 B | 11; 2 files opened |
  | Cell-major, hive by `h3_r1` (458 URLs) | 319,269 B | 11 |
  | One surface today | 4,428,265 B | 8 |

  Re-encoding all 31 surfaces took about 4 s.
- **Catalog.** A view-only `.duckdb` file is 274,432 B, and attaching it remotely read about
  0.55 MB. Through the remote attach, the parity totals came back exact: 994 rows, sum `an`
  11,359,130, sum `ac` 175,878. The disc query returned 40 rows, sum `an` 52,340, sum `ac` 6,459,
  matching design B. View-on-view worked; the macro-naming-a-view failure and the determinism
  results are as given in §3.5.
- **The real bucket, anonymously.**
  - A `Range` GET returned 206.
  - A listing request returned 403.
  - Objects from both 2026-10-17 and 2026-10-18 return `cache-control: public, max-age=3600`.
    So the cache conflict in the inventory is resolved in practice, and `cost-controls.md` is stale.
- **Code read.**
  - The fit-input commit (`f233e69` on `data/fit-inputs`, with follow-ups `a197602`, `4efbc5d`,
    `e95edb0`).
  - `scripts/publish_artifacts.py`'s KIR path (`as_binomial`).
  - `genomeos/observations/{schema,ingest,source_ids}.py`.
  - `genomeos/publication/{data_release,artifact_inputs}.py`.

## Sources

[gcs-examples]: https://cloud.google.com/storage/pricing-examples
[free-tier]: https://docs.cloud.google.com/free/docs/free-cloud-features
[gcs-iam]: https://docs.cloud.google.com/storage/docs/access-control/iam-roles
[gcs-transcoding]: https://docs.cloud.google.com/storage/docs/transcoding
[requester-pays]: https://docs.cloud.google.com/storage/docs/requester-pays
[cdn-pricing]: https://cloud.google.com/cdn/pricing
[lb-pricing]: https://cloud.google.com/load-balancing/pricing
[bq-pricing]: https://cloud.google.com/bigquery/pricing
[bq-public]: https://docs.cloud.google.com/bigquery/public-data
[bq-sandbox]: https://docs.cloud.google.com/bigquery/docs/sandbox
[bq-external]: https://docs.cloud.google.com/bigquery/docs/external-data-cloud-storage
[bq-iceberg]: https://docs.cloud.google.com/bigquery/docs/iceberg-tables
[sql-pricing]: https://cloud.google.com/sql/pricing
[sql-agg]: https://www.bytebase.com/dbcost/cloudsql-pricing/
[alloydb-pricing]: https://cloud.google.com/alloydb/pricing
[alloydb-agg]: https://www.bytebase.com/dbcost/alloydb-pricing/
[spanner-pricing]: https://cloud.google.com/spanner/pricing
[bigtable-pricing]: https://cloud.google.com/bigtable/pricing
[firestore-pricing]: https://cloud.google.com/firestore/pricing
[gh-runners]: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
[hf-storage]: https://huggingface.co/docs/hub/storage-limits
[zenodo]: https://help.zenodo.org/docs/deposit/about-records/
[duckdb-https]: https://duckdb.org/docs/current/core_extensions/httpfs/https
[duckdb-attach]: https://duckdb.org/docs/current/guides/network_cloud_storage/duckdb_over_https_or_s3
[duckdb-viewonly]: https://duckdb.org/2026/10/07/view-only-mode
[duckdb-hive]: https://duckdb.org/docs/current/data/partitioning/hive_partitioning
[duckdb-storage]: https://duckdb.org/docs/current/internals/storage
[duckdb-h3]: https://duckdb.org/community_extensions/extensions/h3
[ducklake-path]: https://ducklake.select/docs/stable/duckdb/guides/using_a_remote_data_path
[geoparquet]: https://geoparquet.org/
[gnomad-gcp]: https://cloud.google.com/life-sciences/docs/resources/public-datasets/gnomad
[gnomad-azure]: https://gnomad.broadinstitute.org/news/2025-07-azure-open-datasets-deprecation

- Cloud Storage prices (Standard us-east1, Class B, egress tiers): <https://cloud.google.com/storage/pricing-examples>
- Always Free limits (GCS 5 GB-months, 50K Class B, 100 GB egress; BigQuery 1 TiB + 10 GiB; per billing account): <https://docs.cloud.google.com/free/docs/free-cloud-features>
- `legacyObjectReader` = `storage.objects.get` only; `objectViewer` can list: <https://docs.cloud.google.com/storage/docs/access-control/iam-roles>
- Range ignored on transcoded objects: <https://docs.cloud.google.com/storage/docs/transcoding>
- Requester Pays `400 UserProjectMissing`: <https://docs.cloud.google.com/storage/docs/requester-pays>
- Cloud CDN cache egress $0.08/GiB NA <10 TiB, cache fill $0.01/GiB: <https://cloud.google.com/cdn/pricing>
- Forwarding rule $0.025/hour: <https://cloud.google.com/load-balancing/pricing>
- BigQuery $6.25/TiB on demand, 1 TiB free; storage pricing: <https://cloud.google.com/bigquery/pricing>
- BigQuery public datasets need a project; the querier pays: <https://docs.cloud.google.com/bigquery/public-data>
- BigQuery sandbox needs a Google account; 60-day expiry: <https://docs.cloud.google.com/bigquery/docs/sandbox>
- External tables: wildcard needs `storage.objects.list`; colocation: <https://docs.cloud.google.com/bigquery/docs/external-data-cloud-storage>
- Iceberg managed tables: compaction, GC, data-loss warning, no GEOGRAPHY: <https://docs.cloud.google.com/bigquery/docs/iceberg-tables>
- Cloud SQL (about $8/month db-f1-micro, aggregator, July 2026): <https://cloud.google.com/sql/pricing>, <https://www.bytebase.com/dbcost/cloudsql-pricing/>
- AlloyDB (about $227/month 2 vCPU/16 GB, aggregator, July 2026): <https://cloud.google.com/alloydb/pricing>, <https://www.bytebase.com/dbcost/alloydb-pricing/>
- Spanner hourly capacity billing, one-hour minimum: <https://cloud.google.com/spanner/pricing>
- Bigtable $0.65/node-hour Iowa, billed when inactive: <https://cloud.google.com/bigtable/pricing>
- Firestore 50,000 free reads/day: <https://cloud.google.com/firestore/pricing>
- GitHub-hosted runners: 4 vCPU, 16 GB, 14 GB SSD, free for public repos: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Hugging Face public storage best-effort free: <https://huggingface.co/docs/hub/storage-limits>
- Zenodo: each version is a new record with its own identifier: <https://help.zenodo.org/docs/deposit/about-records/>
- DuckDB partial Parquet reads over HTTPS, explicit multi-file lists: <https://duckdb.org/docs/current/core_extensions/httpfs/https>
- DuckDB read-only ATTACH over HTTPS: <https://duckdb.org/docs/current/guides/network_cloud_storage/duckdb_over_https_or_s3>
- DuckDB view-only catalog (2026-10-07): <https://duckdb.org/2026/10/07/view-only-mode>
- DuckDB hive filter pushdown skips files: <https://duckdb.org/docs/current/data/partitioning/hive_partitioning>
- DuckDB storage version compatibility: <https://duckdb.org/docs/current/internals/storage>
- DuckDB h3 community extension: <https://duckdb.org/community_extensions/extensions/h3>
- DuckLake persisted DATA_PATH cannot change: <https://ducklake.select/docs/stable/duckdb/guides/using_a_remote_data_path>
- GeoParquet: <https://geoparquet.org/>
- gnomAD on Google Cloud (GCS + BigQuery): <https://cloud.google.com/life-sciences/docs/resources/public-datasets/gnomad>
- gnomAD Azure deprecation: <https://gnomad.broadinstitute.org/news/2025-07-azure-open-datasets-deprecation>
