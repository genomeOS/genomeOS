# Data store

What this project holds, where, and which parts are durable. Written because three separate pod
runs had their output destroyed, and because most of what the pipeline produces is deliberately
not in git.

**Everything published lives in the public GCS data store** (data store design 2026-10-17, #468).
Anyone can download and verify it without credentials:

```bash
python scripts/fetch_data.py              # newest release into data/, every file sha256-checked
```

The store's committed public URL is `https://storage.googleapis.com/genomeos-atlas-data/` (owner decision; `docs/repo-gcloud-auth.md`).

Git keeps one manifest per release, `data/releases/<release>.json`, listing every object's path,
bytes, sha256 and source terms. Clone with `git clone --filter=blob:none` to skip the data blobs
that older commits still carry (history was not rewritten).

## Layout

```
data/
  releases/<release>.json               committed: the data-store manifest for each release
  raw/                                  fetched sources — gitignored, re-fetchable by script
    map_hbs_surveys.csv                 scripts/fetch_map_hbs.py --layer hbs
    map_g6pd_surveys.csv                scripts/fetch_map_hbs.py --layer g6pd
    afnd_populations.tsv                scripts/fetch_afnd.py
    afnd_cache/                         one HTML page per AFND population, so a re-run is free
  curated/                              immutable, versioned operator-reviewed inputs
    map_hbs_surveys.csv                 HbS rows plus explicit bounding-disc support evidence
  store/
    fits/       <variant>.fit.pkl       trained models — a CACHE, not an artifact (see below)
    artifacts/  <variant>__<model>__<data>/      in the data store; fetched, not tracked
                  cells.parquet         the citable per-cell surface (§5, §6)
                  observations.parquet  the exact observation table its fit consumed (#45)
                  manifest.json         what was published, and under what assumptions; written last
    INVENTORY.json                      checksums of what was on the publishing machine
  validation/                           held-out validation evidence; in the data store
reference/                              committed: Natural Earth countries (1:110m, and the 1:50m
                                        admin-0 source of the Atlas borders), Piel 2013 estimates
tests/fixtures/                         committed: tiny, hand-checkable inputs
docs/figures/                           committed: review figures
```

## What is durable and what is not

| | in git | in the data store | notes |
|---|---|---|---|
| `reference/`, `tests/fixtures/`, `docs/figures/` | **yes** | no | small, reviewable, diffable |
| `data/releases/*.json` | **yes** | **yes** (`manifests/`) | the record of what each release published |
| `data/registry/`, `data/sources/`, `data/raw/afnd_populations.tsv`, `data/store/{catalog-metadata,INVENTORY}.json` | **yes** | **yes** | hand-curated inputs, reviewed by diff |
| `data/store/artifacts/` | no (since 2026-10-17) | **yes** | the citable output; immutable once released |
| `data/store/artifacts/*/observations.parquet` | no | **yes** | each artifact's fit input, hash-pinned in its manifest; required for every new artifact. The 61 released 2026-10-17 have none and are listed (below) |
| `data/validation/` | no (since 2026-10-17) | **yes** | held-out validation evidence |
| `data/raw/` (other files) | no | not yet (phase 2) | sources are versioned upstream; re-fetchable by script |
| `data/store/fits/*.pkl` | no | **never** | pickles: environment-coupled, and loading one executes code. Format 3 also holds the fit's input, which is how it reaches the artifact |

## A fit is not an artifact

`surfaces.fit.save_fit` pickles the PyMC graph alongside the posterior so predictions are cheap to
repeat. That is a **cache**: pickle is coupled to the installed PyMC and pytensor, and it executes
arbitrary code on load, so it can be neither archival nor shared. It is also large — the HbS fit is
**121 MB** against a **1.1 MB** artifact, a 110x difference, because the posterior carries a draw
of `f`, `p` and `freq_pred` for every observation. The fits stay local and are **never** published to
the data store (`build_data_release.py` refuses a pickle); the artifacts are. Publishing trained
models needs a safe export format first (data store design §8).

The artifact is `store/artifacts/.../cells.parquet` — per-cell posterior summaries in plain
columns, readable by anything that reads parquet, and what §5 means when it says the read API
"reads precomputed artifacts and aggregates them; it never computes science".

Every row carries its `support` state, `posterior_contraction` and `dist_nearest_obs_km`. That is
not padding: §4's defence against a persuasive-but-unfounded cline is that a consumer can tell
measured from inferred without going back to the model, and the distance is carried so a stricter
threshold can be applied without refitting.

## Inputs travel with outputs

A surface can only be checked against the rows it was fitted to, and an input that lives anywhere
else can be lost: the 2026-09-16 HbS parity run pinned the sha256 of its 994 input surveys, but no
copy of the rows survived, and they had to be rebuilt from a fresh MAP export a month later (#45).
So every artifact carries its own input.

- `fit_surface` keeps the schema-validated observation frame it consumed on the fit
  (`SurfaceFit.observations`), and `save_fit` writes it into the cache (fit format 3).
- `publish_artifacts.py` writes **that** frame, not a reload, as `observations.parquet` beside
  `cells.parquet` (`genomeos/surfaces/fit_input.py`). It is exactly the rows and columns the fit
  consumed, in its row order: the strict `contract/observations.schema.json` table, so counts
  (`ac`, `an`) and never frequencies. The bytes are deterministic in the locked environment.
- The artifact's `manifest.json` records the file's `sha256`, `bytes`, `row_count` (equal to
  `n_observations`), its `columns` and the contract file with its `schema_sha256`, and is written
  last.
- `publish_artifacts.py` refuses a fit cached before format 3 (what it consumed is unknown: refit
  it), and refuses flags that supply rows other than the fit's own.
- `build_data_release.py` refuses an artifact without `observations.parquet`, or whose recorded
  hash, size, row count or columns do not match the file. Nothing is skipped.

Artifacts released before this rule cannot gain the file, because a released artifact is
immutable: the builder also refuses any new file inside a released artifact directory. They are
named one by one, each with a reason, in `RELEASED_WITHOUT_INPUT` in
`scripts/build_data_release.py`: the 61 artifacts of release 2026-10-17. Nothing is exempt by
default. A released artifact missing from that table fails the build, and an entry that no earlier
release holds is refused, so the table can never admit a new artifact. Recovering one of their inputs
means publishing it under a new key (a `validation/` record, or a refit under a new
`model_version`), never adding a file to a cited directory.

## Building the P4 serving catalog

P2 publishes one immutable directory per entity. The P4 API reads one version-pinned catalog and
must not infer labels, measurement meaning, eligibility, or assumptions from directory names.
Those reviewed decisions live in `data/store/catalog-metadata.json`; build a local serving catalog
with:

```bash
python scripts/build_atlas_catalog.py --source data/store/artifacts \
    --metadata data/store/catalog-metadata.json --out data/serving/atlas-v1
```

A `--source` under `data/` is resolved through the data store first: every released artifact under it
is fetched from the committed URL and sha256-verified.
`export_atlas_web.py --store data/store` does not fetch by itself; run
`python scripts/fetch_data.py --prefix store/` before it.

The command refuses to replace an existing output, validates entity IDs, row counts and H3
resolutions, adds only mechanical H3 centre coordinates, checks that the catalog pins exactly one
data/model version, and writes `manifest.json` last. Missing observations or burden artifacts stay
explicitly unavailable; the builder never manufactures them from a surface.

`contract/atlas_catalog.schema.json` is the frozen review surface for this serving boundary. Run
`python scripts/freeze_contract.py` after an intentional catalog-contract change.

## Building the static web export

The `/app/` explorer reads `catalog.json` from the site (`website/public/data/atlas/`) and every
per-artifact object from the public web data bucket. `scripts/export_atlas_web.py` writes the
canonical, citable JSON (surface, observations and manifest per artifact, plus `catalog.json`) to
an export directory. `export_atlas_web.py` output is an intermediate; the site build fails until
`encode_atlas_web.py` has run on it and the result is published:

```bash
python scripts/encode_atlas_web.py --in <export-dir> --out data/atlas-web --with-downloads
```

The encoder takes the first artifact's H3 sequence as the shared grid and refuses any surface
whose cells differ, writes content-addressed GOSA objects under `grids/` and `surfaces/`, decodes
every object it wrote and compares it with the JSON cell by cell, and only then adds `grids`, `web`
and `observations_bytes` to `catalog.json`. It is byte-deterministic. The objects are git-ignored;
with `--with-downloads` they and the canonical JSON are published to the public bucket (the "Public
web data bucket" section below), the JSON stays the citable download, and only `catalog.json` is
committed.

The explorer's country borders are derived too. `scripts/encode_natural_earth_borders.py` reads
`reference/ne_50m_admin_0_countries.geojson`, refuses it unless its sha256 is the pinned
revision's, and writes the committed `website/public/data/atlas/ne-50m-admin-0.borders.bin`
(positions on a 0.0001° lattice, shared borders stored once; fast-load spec §B.10). A vertex that
rounding would move into another H3 cell is snapped back into its own, at every resolution of
`catalog.json`'s `grids`, so border heights over a surface are exact. The site no longer ships the
GeoJSON. Re-run the script after changing the source, the format or the catalog's grid
resolutions; `--check` fails when the committed file is stale, and the Python tests check it byte
for byte.

## Immutability is enforced, not just documented

Artifacts are keyed `(variant_id, model_version, data_version)` and `publish()` **refuses to
overwrite**. A refit publishes under a new `model_version` and coexists with what it supersedes,
so an older citation keeps resolving. A silent overwrite is exactly the failure that guarantee
exists to prevent.

## Rebuilding from nothing

```bash
python scripts/fetch_map_hbs.py --layer hbs  --out data/raw/map_hbs_surveys.csv
python scripts/fetch_map_hbs.py --layer g6pd --out data/raw/map_g6pd_surveys.csv
python scripts/fetch_afnd.py --out data/raw/afnd_populations.tsv --cache data/raw/afnd_cache

python scripts/build_surfaces.py --hbs data/curated/map_hbs_surveys.csv \
    --g6pd data/raw/map_g6pd_surveys.csv --out data/store/fits --draws 1200
python scripts/publish_artifacts.py --fits data/store/fits --out data/store/artifacts \
    --hbs data/curated/map_hbs_surveys.csv --g6pd data/raw/map_g6pd_surveys.csv
python scripts/store_inventory.py --root data --out data/store/INVENTORY.json
python scripts/fetch_data.py                              # every released file, so the new release
python scripts/build_data_release.py --release <YYYY-MM-DD>   # lists them all; then "Public data store"
```

`publish_artifacts.py` refuses an artifact directory that any committed release already holds, even
with `--overwrite`: a released artifact is cited, so a refit publishes under a new `model_version`.
Pass it the same `--hbs`/`--g6pd`/`--afnd` inputs the fits were made from: it publishes each fit's own
record of its input and refuses rows that differ from it.

The HbS fetch command retains the untouched vendor export as raw evidence. That area-only export
intentionally fails the HbS adapter: an area class cannot establish a bounding radius from the
reported coordinate. A separately retained, immutable and versioned curated CSV must supply the
four fields defined in [the MAP spatial-support contract](map-spatial-support.md). There is no
automatic raw-to-curated conversion, and this repository does not currently contain or claim a
qualified real curated MAP source. For a runnable synthetic demonstration, use
`tests/fixtures/map_hbs_curated_synthetic.csv`. The exact 994 observations of the 2026-09-16 HbS
parity run predate that contract (their radii come from MAP's area class). They are in the data
store under `validation/hbs-piel-parity-2026-09-16/`, with their rebuild recipe in
`docs/research/hbs-piel-parity-2026-09-16.md`.

Fitting is ~20 min per variant on a laptop. **Do not run it on a pod expecting the output back**:
nothing copies `/workspace` off a pod, and that is how three runs' fits were lost. A pod can render
figures and push them to a branch (`runpod_fit.py --job surfaces` does), but a 6 MB fit has to be
produced where it will be kept.

## Public web data bucket

The website's per-artifact data is published to a public bucket that is separate from #33's
private artifact staging: it serves only encoded site data and neither pins nor replaces the citable
artifacts above. Run the steps from a checkout, with the repository-local gcloud configuration
initialised first:

```bash
python scripts/gcloud_repo.py init --account <account> --project <project>
export GENOMEOS_GCP_PROJECT=<project> ATLAS_DATA_BUCKET=<bucket>
export ATLAS_DATA_BASE_URL="https://storage.googleapis.com/$ATLAS_DATA_BUCKET/atlas/web/"
python scripts/provision_atlas_web_bucket.py --mode edge --bucket "$ATLAS_DATA_BUCKET" --dry-run
python scripts/provision_atlas_web_bucket.py --mode edge --bucket "$ATLAS_DATA_BUCKET"
python scripts/encode_atlas_web.py --in <export-dir> --out data/atlas-web --with-downloads
python scripts/publish_atlas_web.py --staging data/atlas-web --bucket "$ATLAS_DATA_BUCKET" --dry-run
python scripts/publish_atlas_web.py --staging data/atlas-web --bucket "$ATLAS_DATA_BUCKET"
cp data/atlas-web/catalog.json website/public/data/atlas/catalog.json
gh variable set ATLAS_DATA_BUCKET --body "$ATLAS_DATA_BUCKET"
gh variable set ATLAS_DATA_BASE_URL --body "$ATLAS_DATA_BASE_URL"
(cd website && PUBLIC_ATLAS_DATA_BASE_URL="$ATLAS_DATA_BASE_URL" npm run build)
python scripts/check_atlas_web_data.py --production --catalog website/public/data/atlas/catalog.json \
    --base "$ATLAS_DATA_BASE_URL" --bucket "$ATLAS_DATA_BUCKET" --dist website/dist
```

`encode_atlas_web.py --with-downloads` copies each canonical JSON byte-for-byte to its
content-addressed `downloads/` key and rewrites `surface_url`, `observations_url` and
`downloads.*.url`; every SHA-256 is unchanged. Publishing compresses each file itself (gzip level 9,
mtime 0), uploads with `--if-generation-match=0`, and treats the decoded SHA-256 and size in object
metadata as identity: an identical object is skipped and a different one is a hard error, never an
overwrite, so a second run skips everything. The catalog commit comes last, after the deploy gate
passes against the bucket.

If provisioning stops right after creating the bucket (the ownership label is a separate update),
confirm that `gs://<bucket>` is the bucket just created (same project, no objects), run
`python scripts/gcloud_repo.py run storage buckets update gs://<bucket> --update-labels=genomeos-purpose=atlas-web`,
then re-run provisioning. If publishing reports a failed post-upload verification, resolve that
object with the owner before any re-run, because a re-run does not repair it: it skips the object
as identical when the object's identity metadata matches the catalog, and stops with a hard error
when it does not.

### Re-encoding after the per-artifact files left the repository

`main` tracks only `catalog.json`. To re-encode (after a codec change, say), first rebuild an export
tree, either with a full `scripts/export_atlas_web.py` run from the store, or by downloading the
published tree and adding the repository catalog (its keys already name the downloaded files):

```bash
python scripts/gcloud_repo.py run storage cp -r "gs://$ATLAS_DATA_BUCKET/atlas/web/*" <export-dir>/
cp website/public/data/atlas/catalog.json <export-dir>/catalog.json
(cd website && ATLAS_DATA_DIR=<export-dir> npx vitest run tests/atlas-public-data.test.ts)
```

The integrity test runs from `website/`, so `<export-dir>` must be an absolute path there. It
proves the download decompressed to the catalog's bytes. Then run
`encode_atlas_web.py --in <export-dir> --out <staging> --with-downloads`, publish, and copy only
`<staging>/catalog.json` back into the repository. The surface and observations JSON must stay
byte-identical: their SHA-256 values are in the catalog and in every citation, and a changed digest
is a new publication, not a re-encode. `scripts/build_atlas_e2e_fixture.py --from-dir <export-dir>`
regenerates the browser-test fixture from the same tree.

## Public data store

Every file a release lists is served from a dedicated public bucket, separate from the web-data bucket
above (data store design 2026-10-17 §3): `https://storage.googleapis.com/genomeos-atlas-data/`. Each object is raw bytes at
`releases/<release>/<path>`, with the manifest copy at `manifests/<release>.json`,
`Cache-Control: public, max-age=3600`, so a takedown reaches readers within an hour (#473), and the sha256 in object
metadata. Keys never change meaning: a later release reuses an earlier key for a byte-identical file,
and the builder refuses a released artifact whose bytes changed.

- Anyone may read an object by key (`roles/storage.legacyObjectReader`), but nobody may list the
  bucket. The keys come from the manifest.
- Object versioning and a 30-day soft delete back up the no-overwrite uploads. They are not a
  substitute for them.
- The bucket's URL and name are committed in `genomeos/publication/data_release.py`, and any other
  value is refused. The project id is never committed (`docs/repo-gcloud-auth.md`).

**Reading** needs no credentials: run `scripts/fetch_data.py`. Downloads stream into
`data/.fetch-partial/`, are checked against the manifest's byte count and sha256, and only then are
renamed into place; a local file that differs is a hard error and is never overwritten. Without the
repository, `manifests/<release>.json` in the bucket is the same manifest.

```bash
python scripts/fetch_data.py --list                      # what the newest release holds
python scripts/fetch_data.py --prefix validation/        # one subtree
python scripts/fetch_data.py --verify-local              # hash local files against the manifest
python scripts/fetch_data.py --verify-remote             # GET and hash every object; writes nothing
```

**Publishing a release.** A maintainer uploads as the service account `data-store-publisher`,
impersonated from their repository-local login. Provisioning never creates a key for it. On this
bucket it holds `roles/storage.objectCreator` plus the custom role `dataStoreReader` (exactly
`storage.objects.get` and `storage.objects.list`). So it can add new objects, read objects and list
their names, but it cannot overwrite or delete an object or change a setting. The list permission is
needed because `gcloud storage cp` lists the destination key as a prefix before every upload of a new
key, and that listing fails without it. The get permission covers `publish_data_store.py`'s metadata
reads and post-upload checks, so publishing does not depend on the public read grant. Project
editors and owners can still do more than this ([`cost-controls.md`](cost-controls.md), "Project-wide
access"). This is the current mechanism and the
base for the planned automation, in which CI refits when a dataset changes and uploads through
GitHub→GCP Workload Identity Federation (data store design §7). That automation is not built yet.

Once, as the owner (admin rights; `<maintainer>` is the account that will publish):

```bash
export GENOMEOS_GCP_PROJECT=<project>
python scripts/provision_data_store_bucket.py --dry-run            # idempotent; changes only what differs
python scripts/provision_data_store_bucket.py
python scripts/provision_data_store_publisher.py --account <maintainer> --dry-run
python scripts/provision_data_store_publisher.py --account <maintainer>
```

For every release, as the maintainer:

```bash
python scripts/gcloud_repo.py auth login
python scripts/gcloud_repo.py init --account <maintainer> --project <project>
export GENOMEOS_GCP_PROJECT=<project>
python scripts/fetch_data.py                                       # the previous release, locally
python scripts/build_data_release.py --release <YYYY-MM-DD>        # commit data/releases/<release>.json
export CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=data-store-publisher@$GENOMEOS_GCP_PROJECT.iam.gserviceaccount.com
python scripts/publish_data_store.py --dry-run
python scripts/publish_data_store.py                               # gcloud warns it is impersonating; expected
unset CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
python scripts/fetch_data.py --verify-remote                       # anonymous, every object
```

Merge the release manifest only after publishing and the anonymous `--verify-remote` pass:
`fetch_data.py` reads the newest committed manifest, so a merged manifest whose objects are not yet
uploaded breaks every fetch on `main`.

Publishing checks every local file against the manifest, describes every key before uploading
anything, uploads absent objects with `--if-generation-match=0`, skips identical ones, treats any
other existing object as a hard error, verifies size, md5 and metadata after each upload, and uploads
the manifest copy last. Nothing is ever deleted or overwritten. The identity enforces this as well:
even without the precondition, replacing an object needs `storage.objects.delete`, which the
publisher does not have.

If the budget kill switch has made the bucket private ([`cost-controls.md`](cost-controls.md)),
publishing still works, because the publisher reads through its own role. The anonymous
`fetch_data.py --verify-remote` check fails until the owner re-enables public access.

**What is not published yet.** Fits are pickles and are never published until a safe export format
exists. The raw third-party harvests (MAP WFS exports, AFND frequencies and page caches, gnomAD, the
WorldPop grid, the external caches) are phase 2. Until then they live locally and in the interim
Hugging Face mirror (`scripts/sync_store.py`).
