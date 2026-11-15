# Data access

**TL;DR.** Every Atlas release is free to query, and everything published so far is free to
download, with no account. Query first: attach a release's catalog in DuckDB, from the CLI, Python, R
or the Atlas page, and read only what you need. Download only what you name. Measured observations
and inferred surfaces always stay apart.

This page is for readers. How releases are built and published is in [`data-store.md`](data-store.md),
and the design behind both is the
[Atlas data platform design 2026-10-18](superpowers/specs/2026-10-18-atlas-data-platform-design.md)
(§3 to §5). Steps 2.2 (downloads that name what they want), 2.5 (the lookup bucket and its brake) and
2.7 (the lookup macros) extend this page.

## Look up one variant

The main way in is one variant at a time, read anonymously over HTTPS (design §3.1). Attach the newest
release's catalog, a small views-only DuckDB file, read-only. This works from DuckDB's CLI, Python or R,
with any DuckDB from 1.2:

```sql
ATTACH 'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/catalog/atlas.duckdb' AS atlas (READ_ONLY);
```

Then ask for one variant's observations, from every population and source:

```sql
SELECT population_id, ac, an, lat, lon, radius_km, sampling_design, cohort_id, source_record_id
FROM atlas.measured.variant('chr11-5227002-T-A');
```

Its surfaces come from a separate macro:

```sql
SELECT * FROM atlas.inferred.surfaces('chr11-5227002-T-A');
```

**Not yet.** `measured.variant` and `inferred.surfaces` are macros that step 2.7 adds to the catalog.
The whole-genome table that `measured.variant` reads arrives in step 2.8: gnomAD's HGDP + 1KG callset,
recounted per population, one file per chromosome and 1 Mb bin. Until then the catalog has neither
macro, and both statements fail with `Catalog Error: Table Function with name variant does not exist!`
(or `surfaces`). Step 2.7 also adds `measured.near(variant_id, lat, lon, km)`: the observations whose
sampling discs come within `km` of a point.

Today the catalog answers for a map's artifact, the released model output behind one Atlas map:

```sql
SELECT * FROM atlas.inferred.artifacts WHERE variant_id = 'chr11-5227002-T-A' AND model_version = 'v3' AND data_version = 'map-2026-08';
```

Observations are counts, never frequencies. `ac` is how many copies of the allele were seen, out of
`an` alleles called. An `ac` of 0 out of 200 is weak evidence, not absence, and only `an` says how
weak. Observations (`measured`) and surfaces (`inferred`) live in separate schemas, and no view joins
them.

## Query in your browser

The Atlas at <https://genome-os.org/app/> runs the same SQL in your browser. Select a map and open
**Query in your browser**, below **Download this dataset**. The pinned DuckDB-WASM (1.32.0) then
attaches the same catalog read-only, reading only the byte ranges it needs, with no account. The
panel offers the examples above for the selected map, but only those whose objects the catalog has.
Today that is the artifact query and this one, the parity check's HbS surveys within 500 km of Lagos:

```sql
SELECT count(*) AS observations, sum(an) AS an, sum(ac) AS ac FROM atlas.evidence.parity_observations
WHERE 2 * 6371.0088 * asin(sqrt(pow(sin(radians(lat - 6.5244) / 2), 2) + cos(radians(6.5244)) * cos(radians(lat)) * pow(sin(radians(lon - 3.3792) / 2), 2))) <= 500 + radius_km;
```

The haversine counts a survey when its sampling disc (`radius_km`) reaches within 500 km of Lagos. On
release 2026-11-15 it returns 40 surveys, `an` 52,340 and `ac` 6,459, the golden counts the release's
smoke test checks (design §2.7, check 8).

An example's result shows under **Measured** or **Inferred**, never both. You can edit the SQL (one
statement) and run it again; a result stops at 1,000 rows and says so. **Copy for DuckDB** copies the
`ATTACH` and the query, ready for the CLI, Python or R. Without WebAssembly and Web Workers the panel
cannot run, so copy the query instead.

When a query fails, the panel says why:

- **The store is paused** (HTTP 403). A spending brake has made it private. See
  [When access stops](#when-access-stops-the-brake-and-the-kill-switch); meanwhile the panel links
  gnomAD's browser for the variant.
- **A file is gone** (HTTP 404), most likely withdrawn. Reload the page for the newest catalog
  ([Takedowns](#takedowns)).
- **Anything else** is the SQL's own error, as DuckDB wrote it.

## URLs

Today everything on this page comes from one public bucket. Its URL is committed, and the code
refuses any other value: `https://storage.googleapis.com/genomeos-atlas-data/`.

| What | URL |
|---|---|
| A file of a release | `https://storage.googleapis.com/genomeos-atlas-data/<key>`, with `<key>` from the manifest |
| A release's manifest | `https://storage.googleapis.com/genomeos-atlas-data/manifests/<release>.json` |
| A release's catalog | `https://storage.googleapis.com/genomeos-atlas-data/releases/<release>/catalog/atlas.duckdb` |
| Every file the catalog reads | `https://storage.googleapis.com/genomeos-atlas-data/releases/<release>/catalog/tables.json` |

- A key is `releases/<release>/<path>`. A later release reuses an earlier key for a byte-identical
  file, so a key can name an earlier release than the one that lists it. A key never changes bytes.
- Nobody can list the bucket. Keys come from the manifest, which git also holds as
  `data/releases/<release>.json`, or from `tables.json`. Both give each file's sha256.
- Every object is served with `Cache-Control: public, max-age=3600`. Caches may keep a copy for up to
  an hour, so a takedown, or the kill switch, reaches every reader within the hour.
- Any website may `GET` and `HEAD` the objects and read `Content-Range` and `Accept-Ranges`, so a
  browser can read byte ranges.
- From step 2.5, the whole-genome lookup files live in a bucket of their own, `genomeos-atlas-lookup`,
  so that its brake can stop lookups without touching anything else. The catalog's macros build those
  URLs; you never type one.

## Quickstarts

The DuckDB CLI:

```bash
duckdb -c "ATTACH 'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/catalog/atlas.duckdb' AS atlas (READ_ONLY); SELECT * FROM atlas.meta.release;"
```

Python (`pip install duckdb`):

```python
import duckdb

duckdb.sql("ATTACH 'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/catalog/atlas.duckdb' AS atlas (READ_ONLY)")
duckdb.sql("SELECT * FROM atlas.meta.release").show()
```

R (`install.packages("duckdb")`):

```r
con <- DBI::dbConnect(duckdb::duckdb())
DBI::dbExecute(con, "ATTACH 'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/catalog/atlas.duckdb' AS atlas (READ_ONLY)")
DBI::dbGetQuery(con, "SELECT * FROM atlas.meta.release")
```

DuckDB installs its `httpfs` extension the first time it reads an HTTPS URL. Release 2026-11-15's
catalog holds these views (`SHOW ALL TABLES` lists them):

| View | Rows |
|---|---|
| `meta.release` | the release id, its manifest's key, `cite_as` and `mirror` |
| `meta.release_objects` | every file of the release: path, key, bytes, sha256, sources |
| `meta.sources` | every source: name, citation, URL, licence, terms status, `non_commercial` |
| `meta.served` | the 30 artifacts the Atlas website serves |
| `meta.withdrawn` | withdrawn files ([Takedowns](#takedowns)) |
| `inferred.artifacts` | the 61 released artifacts, one per map |
| `inferred.cells_by_cell` | every artifact's H3 cells, partitioned by `res` and `h3_r0` |
| `evidence.parity_observations` | the 994 MAP HbS surveys of the parity check; their radii fail the sampling-disc contract, so they are not `measured` rows (design §2.8) |

A filter on `h3_r0` skips the files and row groups it rules out.

pandas, Polars or anything else that reads Parquet can skip DuckDB: `tables.json` lists, for each
view, every file with its `key`, `url`, `sha256`, `bytes`, `rows` and `access`.

```python
import json
import urllib.request

import pandas as pd

TABLES = "https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/catalog/tables.json"
with urllib.request.urlopen(TABLES) as response:
    tables = json.load(response)["tables"]
artifacts = pd.concat(pd.read_parquet(file["url"]) for file in tables["inferred.artifacts"])
```

Polars reads the same URLs with `pl.read_parquet(file["url"])`. Reading files directly skips the
catalog's views, so it also skips their `meta.withdrawn` filter. With `curl`, check what you got:

```bash
curl -fO https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/artifacts.parquet
shasum -a 256 artifacts.parquet     # must equal the sha256 that tables.json and the manifest list
```

## Downloads

`scripts/fetch_data.py`, in a clone of this repository, downloads what a release lists. It needs no
credentials and only Python's standard library. Each file streams into `data/.fetch-partial/`, is
checked against the manifest's byte count and sha256, and only then moves into `data/`. A local file
that differs is a hard error and is never overwritten. Today's options:

```bash
python scripts/fetch_data.py --list                                # the newest release's files; no network
python scripts/fetch_data.py --prefix catalog/ --prefix tables/    # only paths under these prefixes
python scripts/fetch_data.py --release 2026-10-18 --list           # an earlier release
python scripts/fetch_data.py --prefix validation/ --dest atlas-data/   # somewhere other than data/
python scripts/fetch_data.py --verify-local                        # hash local files against the manifest
python scripts/fetch_data.py --verify-remote                       # hash the release over HTTPS; writes nothing
python scripts/fetch_data.py                                       # the whole newest release
```

- **With no selection, today's script downloads the whole newest release.** For 2026-11-15 that is
  414 files, 444,012,805 bytes, outside the files git already holds; `--list` shows it first. Step 2.2
  turns this around: with no selection the script will only list, and a download names what it wants.
- Files git already tracks are skipped unless you pass `--include-git-tracked`.
- `--base-url` (or `GENOMEOS_DATA_BASE_URL`) may only repeat the committed URL or name a mirror on
  your own machine (`http://127.0.0.1:<port>/`). Anything else is refused.
- `--verify-remote` downloads and hashes the files the release first published, and sends a `HEAD`
  for keys reused from an earlier release.
- Without the repository, the manifest at `manifests/<release>.json` lists every key with its sha256,
  and `curl` with a sha256 check does the same job.

Everything published so far is free to download whole. The whole-genome table's single files will be
free too. A whole lookup set, or a selection of one over 1 GiB, is bulk, which the downloader pays
for (design §4): step 2.2 refuses it from the free buckets.

## Offline mode

Remote reads are not hash-checked: HTTPS protects them in transit, nothing more. To query copies whose
sha256 you have checked, download what the catalog reads:

```bash
python scripts/fetch_data.py --prefix catalog/ --prefix tables/ --prefix validation/
```

For 2026-11-15 that is 292 files, 177,563,861 bytes. Then point the catalog at them, from the folder
that holds `data/` (the paths are relative):

```sql
SET VARIABLE genomeos_local = 'data/';
ATTACH 'data/catalog/atlas.duckdb' AS atlas (READ_ONLY);
SELECT * FROM atlas.meta.release;
```

Every view then reads `data/<path>` instead of its URL. `'data'` works too. Keep `=` out of the
folder's path, which DuckDB would read as a partition. `RESET VARIABLE genomeos_local` goes back to
HTTPS. Offline mode keeps working when the store is paused.

## Citing

Cite a release the way its catalog says:

```sql
SELECT cite_as FROM atlas.meta.release;
```

For release 2026-11-15 that is: genomeOS Atlas data, release 2026-11-15.
https://storage.googleapis.com/genomeos-atlas-data/manifests/2026-11-15.json

The manifest it names lists every file of the release with its sha256, so the citation pins the
exact bytes. The catalog cannot carry the manifest's own sha256, because the manifest lists the
catalog. If you want it in your methods, hash the manifest yourself. `mirror` stays empty until a free
mirror exists (step 3.8).

Cite the sources you use as well. `meta.sources` gives each source's citation, URL, licence and terms
status. A source with `non_commercial` true allows non-commercial use only
([`non-commercial-data.md`](non-commercial-data.md)).

## Takedowns

The catalog's views (and, from step 2.7, its macros) leave out the files that `meta.withdrawn` lists
(design §2.9). When bytes must go:

1. The affected parts are rebuilt without those rows, into a new epoch (or a new ingest version, for a
   whole-genome lookup set), and a new release publishes a new catalog.
2. The superseded files are listed in `data/releases/WITHDRAWN.json`, each with its key, sha256,
   reason, issue, date and who decided.
3. The owner deletes them from the bucket.

After that, an older catalog that names a deleted file fails loudly. DuckDB reports HTTP 404 for the
file's URL, the browser panel says the file is gone and asks you to reload, and the old rows are never
served. Attach the newest release's catalog instead. Caches may serve a deleted file for up to an hour
(`max-age=3600`).

To ask for a takedown, open an issue at <https://github.com/genomeOS/genomeOS/issues>. If the request
itself is sensitive, write through <https://genome-os.org/contact> instead.

## When access stops: the brake and the kill switch

Two switches stop anonymous reads when traffic costs too much. Neither deletes anything, and access
stays off until the owner restores it.

**The brake, from step 2.5 (not built yet).** The whole-genome lookup files get their own bucket,
`genomeos-atlas-lookup`, with a Cloud Monitoring alert on the bytes it sends. Past 20 GiB in a day,
about 136,000 lookups, a function makes that bucket private within minutes. It touches only the
lookup bucket. `measured.variant` then fails with HTTP 403, and the Atlas panel says so and links
gnomAD's browser for the variant. Catalogs, artifacts, downloads and the website keep working. Once a
free mirror exists (step 3.8, on a trigger), lookups can fall back to it.

**The kill switch.** The project has a $200 monthly budget. When actual spend reaches $300 (150%), a
function removes public access to the data bucket, `genomeos-atlas-data`. Every catalog and download
on this page comes from it, so queries and downloads then get an HTTP 403, and `fetch_data.py` fails.
Billing data lags by hours, so the switch fires hours after spend crosses $300. Objects carry
`Cache-Control: public, max-age=3600`, so copies already cached by Google's network, a proxy or your
browser may still be served for up to an hour after it fires. The web bucket, `genomeos-atlas-web`,
is untouched: the Atlas website and its maps keep working, and only the query panel stops. Local
copies keep working in [offline mode](#offline-mode). How the switch works is in
[`cost-controls.md`](cost-controls.md).

## Audit logs and privacy

- **Tier 0, the free tier, is anonymous.** Everything on this page (lookups, the browser panel,
  downloads) needs no account, cookie, key or form. The project reads only how many bytes each bucket sent each day, from
  Cloud Monitoring (`scripts/cost_report.py`; the brake will watch the same count). That count names
  no reader.
- The query panel sends nothing to the website's analytics. What genome-os.org's analytics collect is
  on its privacy page, <https://genome-os.org/privacy>.
- **If BigQuery opens** (step 3.1, only for a genome-wide use case), querying it will need a Google
  sign-in. BigQuery's Data Access audit logs "can't be disabled"
  ([Google](https://docs.cloud.google.com/logging/docs/audit/configure-data-access)), so the project's
  logs will record the Google account behind each query. Step 3.1 sets the `_Default` log bucket's
  retention to 1 day, the shortest Google allows (its default is 30 days).
- Paid bulk downloads (step 3.2, on the first request) will bill your own Google project. Google
  checks your account, and the project stores nothing about you.
