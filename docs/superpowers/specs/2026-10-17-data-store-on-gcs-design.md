# genomeOS data store on GCS — Design

**Status:** builder's design under the owner's instruction (2026-10-17). Every call marked
**Builder's call** below is one the owner handed to the builder. The owner can change any of them
without a new design.

**Date:** 2026-10-17 · **Issue:** #468 · **Related:** #33 (private staging and data-version
pinning), #406 (public Atlas web-data bucket; fast-load/GCS design 2026-10-07 §C)

## 1. Intent

The owner's instruction, verbatim:

- "all data, including surfaces, belong on GCP."
- "the data (raw data, harmonized data, surfaces, trained models) should be available to everyone,
  that's the point of genomeOS Atlas."

`main` tracks 259 MB under `data/`, and 254 MB of it is `data/store/artifacts/`. That is 61
artifact directories, including the superseded v1/v2 artifacts that sit beside v3. Every clone
downloads all of it, and the `.git` pack is 477 MB.

The repository is public, so everything in `data/` is already public. Mirroring it to a public
bucket exposes nothing new.

## 2. Goals and non-goals

**Goals**

1. Every file now under `data/` is published to a public bucket. Each object sits at an
   immutable, release-versioned path and is readable by anyone over HTTPS without credentials.
2. Git keeps one manifest per release. It lists every object's path, key, bytes, sha256 and media
   type, plus the source and terms references that the repository already records. The manifest is
   the reviewable record of what was published, and readers verify against it.
3. A reader tool fetches over HTTPS, verifies sha256, fails loudly on any mismatch, and caches under
   the git-ignored `data/`. The scripts that read `data/store` resolve their inputs through it.
4. A maintainer tool uploads through `scripts/gcloud_repo.py`. It never overwrites an object and
   never deletes one.
5. `data/store/artifacts/**` and `data/validation/**` leave git tracking.

**Non-goals**

- **Rewriting history.** Reclaiming the 477 MB pack is a separate decision, which the owner has
  deferred. Old commits keep the files.
- **Trained models.** They exist only as pickles, so they are not published (§8).
- **Raw third-party harvests that are not in git** (MAP WFS exports, AFND frequencies, gnomAD,
  WorldPop and others). Publishing them is phase 2, a follow-up issue.
- **Changing the Atlas web-data bucket.** Its settings, layout and deploy gate stay exactly as they
  are.
- **Data governance.** Questions such as #66 are decided. This design carries the existing terms
  metadata unchanged and does not re-adjudicate it.

## 3. Builder's calls

| # | Call | Why | Change it by |
|---|---|---|---|
| C1 | **A dedicated bucket** in the existing project, separate from the web-data bucket. | The consumers differ: the web bucket serves the browser, with gzip transport encoding, content-addressed names and a CORS policy pinned to the site's origins. The data store serves people and scripts, with raw bytes (so the sha256 is of exactly what `curl` saves), human-readable release paths and open CORS. Keeping them apart also separates egress accounting and budget alerts, and keeps the web provisioner's `genomeos-purpose=atlas-web` adoption guard meaningful. Reusing the web bucket under a prefix would save one bucket but couple two lifecycles. | Pass a different `--bucket`; the scripts do not care which bucket it is. |
| C2 | **Uniform bucket-level access, `allUsers` → `roles/storage.objectViewer`, us-east1, no object versioning, default soft delete, label `genomeos-purpose=data-store`.** | This mirrors fast-load §C.2. Keys are immutable and uploads refuse to overwrite, so versioning would add cost without adding safety. | `scripts/provision_data_store_bucket.py`. |
| C3 | **Open CORS** (`GET`, `HEAD` from `*`). | The data is public. Browser tools such as DuckDB-WASM or Observable can read parquet over HTTP only if CORS allows it. | `deploy/data-store-cors.json`. |
| C4 | **Release-versioned keys**: `releases/<release>/<path>`, where `<path>` is relative to `data/`. A later release may reuse an earlier release's key for a byte-identical file, so unchanged files are not uploaded twice. | Keys are readable and never change meaning. Deduplication comes without content-addressed filenames. | The manifest `key` field (§5). |
| C5 | **Raw bytes, no `Content-Encoding`. `Cache-Control: public, max-age=31536000, immutable`. Custom metadata `sha256=<hex>`.** | What a reader downloads is exactly what the manifest hashes. Immutable keys make the year-long cache safe. | `genomeos/publication/data_release.py`. |
| C6 | **No-overwrite upload.** Each object is described first. If absent, it is uploaded with `--if-generation-match=0`. If present, its metadata sha256 and size are compared: a match is skipped, and anything else is a hard error. A 412 response triggers the same comparison. After upload, the size, md5 and sha256 metadata must equal what was sent. | This is the guard #406 already proved. Nothing is ever deleted. | `scripts/publish_data_store.py`. |
| C7 | **Stays in git and is also published:** the hand-curated inputs reviewed by diff (`data/registry/**`, `data/sources/**`, `data/raw/afnd_populations.tsv`), plus `data/store/catalog-metadata.json` and `data/store/INVENTORY.json`. **Leaves git:** `data/store/artifacts/**` and `data/validation/**`. | A diff of a reviewed input is the review surface, and these files are small (about 1 MB together). The outputs are large, or are generated evidence. | `.gitignore` and the `in_git` field. |
| C8 | **The public base URL is a variable, `GENOMEOS_DATA_BASE_URL`** (for example `https://storage.googleapis.com/<bucket>/`). It is never committed. | Repository rule (`docs/repo-gcloud-auth.md`; fast-load §C.1.4). | §9: the discoverability decision is the owner's. |
| C9 | **The fetch cache is `data/` itself**, at each file's logical path. | The scripts' existing default paths keep working after a fetch. Everything except the in-git inputs is git-ignored there. | `--dest`. |
| C10 | **Release id = the build date, `YYYY-MM-DD`** (optionally `.N`), so release ids sort chronologically. | Releases sort by date, and the newest committed manifest is the default. | `--release`. |
| C11 | **Pickles are never published.** The builder refuses `.pkl`, `.pickle` and `.joblib` files, and any `.npy` file with an object dtype. | Loading a pickle from the public internet executes code (§8). | Not configurable, on purpose. |

## 4. Layout

```
gs://<bucket>/                                   (name never committed)
  releases/<release>/<path>                      every object, raw bytes, immutable
  manifests/<release>.json                       byte-identical copy of the committed manifest

data/releases/<release>.json                     committed manifest (git)
data/<path>                                      fetch cache at the logical path (git-ignored
                                                 except the in-git inputs of C7)
```

The bucket describes itself. Anyone who knows the base URL can read `manifests/<release>.json` and
verify every object, without the repository.

## 5. Manifest schema (version 1)

```json
{
  "schema": "genomeos-data-release",
  "schema_version": 1,
  "release": "2026-10-17",
  "local_root": "data",
  "objects": [
    {
      "path": "store/artifacts/chr11-5227002-T-A__v3__map-2026-08/cells.parquet",
      "key": "releases/2026-10-17/store/artifacts/chr11-5227002-T-A__v3__map-2026-08/cells.parquet",
      "bytes": 1234567,
      "sha256": "<64 hex>",
      "media_type": "application/vnd.apache.parquet",
      "in_git": false,
      "sources": ["map", "worldpop"]
    }
  ],
  "sources": {
    "afnd": {
      "name": "Allele Frequency Net Database (AFND)",
      "citation": "...",
      "terms": {
        "status": "no_restriction_found",
        "checked_at": "2026-08-25",
        "terms_url": "https://...",
        "recorded_in": "https://github.com/genomeOS/genomeOS/issues/117"
      },
      "non_commercial": false
    }
  },
  "totals": {"objects": 245, "bytes": 0, "in_git_objects": 16, "in_git_bytes": 0}
}
```

The validator in `genomeos/publication/data_release.py` is pure: no I/O and no network. Any
violation is a hard error (§12).

- **Objects.** Objects are sorted by path. Paths and keys are unique. A path is relative and
  safe: no `..`, no leading `/`, no backslash, no empty segment.
- **Keys.** A key is either `releases/<this release>/<path>` or `releases/<earlier release>/<path>`
  for the same path. The second form is reuse under C4.
- **Values.** `sha256` is 64 lower-case hex digits. `bytes` is a non-negative int (never a bool).
  `media_type` comes from a closed extension table, so an unknown extension is refused rather than
  guessed.
- **Pickles.** Pickle suffixes are refused (C11).
- **Sources.** Every object names at least one declared source, and every declared source is used.
- **Totals.** `totals` equals the recomputed sums.

**Terms are carried, not adjudicated.** `status` is copied verbatim from the record named in
`recorded_in`: for example `no_restriction_found` from #117, or `restriction_found` from
`data/sources/curated/SOURCE.json`. A source the repository holds no terms check for is
`not_checked`, which is the publication-evidence safeguard's honest state. A status other than
`not_checked` must name `recorded_in`.

`non_commercial: true` carries an existing explicit non-commercial marker. Today that is
GeneReviews, whose reproduction terms are non-commercial: `manual_candidates.tsv` stores links and
identifiers only. The builder marks the flag with `NON-COMMERCIAL:` so that
`grep -rn "NON-COMMERCIAL:"` finds it.

The builder (`scripts/build_data_release.py`) maps paths to sources with a reviewed table:

| Path | Sources |
|---|---|
| `store/artifacts/<id>__<model>__<data>/…` | `map` or `afnd`, from the `data_version` prefix; plus `worldpop` when the artifact's `manifest.json` declares a WorldPop target grid |
| `validation/crossval_*` | `map` |
| `validation/b0h-timing-*` | `genomeos` (prior-simulated data, no third-party input) |
| `raw/afnd_populations.tsv` | `afnd` |
| `sources/cpic/**` | `cpic` |
| `sources/curated/**` | `clinvar`, `genereviews` |
| `registry/curated-v1-candidate.1/**` | `cpic`, `clinvar`, `genereviews` |
| `registry/variant_normalization.tsv`, `store/*.json` | `genomeos` |

A path that matches no rule is a hard error. It is never silently given a source.

**Immutability across releases.** Building release N+1 with `--previous` reuses a key for every
byte-identical file. Any `store/artifacts/**` path whose bytes changed since an earlier release is
refused: artifacts are immutable (AGENTS invariant; design §5). A new model publishes a new
`model_version` directory. It never replaces one.

## 6. Fetch flow (readers, no credentials)

`scripts/fetch_data.py` uses only the standard library (`urllib`).

```bash
export GENOMEOS_DATA_BASE_URL=https://storage.googleapis.com/<bucket>/
python scripts/fetch_data.py                                   # whole newest release into data/
python scripts/fetch_data.py --prefix store/artifacts/chr11-5227002-T-A__v3__map-2026-08/
python scripts/fetch_data.py --list                            # plan only, no network
python scripts/fetch_data.py --verify-local                    # hash local files, no network
python scripts/fetch_data.py --verify-remote                   # GET + sha256 every object, no writes
```

For each selected object:

- **Present locally with the right sha256:** skipped.
- **Present with a different sha256:** a hard error. The local file is never overwritten.
- **Absent:** streamed into `data/.fetch-partial/`, and its byte count and sha256 are checked. A
  match is renamed atomically into place. A mismatch is deleted and reported. Nothing unverified
  ever lands at a logical path.

In-git objects are skipped by default, because they arrive with the clone. A missing base URL is a
hard error, and the message names the variable.

Scripts call `fetch_data.require_local(path)`. It ensures every manifest object under that `data/`
path is present and verified, fetching what is missing, and returns the path. The scripts that touch
`data/store` (a grep finds six) are switched as follows:

| Script | `data/store` use | Change |
|---|---|---|
| `build_atlas_catalog.py` | reads `store/artifacts` (default `--source`) | resolves the default through `require_local` |
| `sync_store.py` | `push-atlas-release` uploads 30 artifact directories to the HF mirror | resolves each through `require_local` |
| `publish_artifacts.py` | writes new directories into `store/artifacts` | refuses a directory already in the newest release, even with `--overwrite`, so immutability no longer depends on the local tree being complete |
| `store_inventory.py` | inventories local `data/` | none needed; the docstring now points at the release manifest as the published record |
| `plot_registry_refusal.py`, `screen_alleles.py` | read and write `store/screen` fits (pickles) | none: fits are not in the data store (§8) |

`scripts/export_atlas_web.py --store` also reads artifacts. It is in the files another branch is
changing (the web format version), so it is not edited here. Its runbook runs
`fetch_data.py --prefix store/` first. No test reads `data/store/artifacts`; a grep of `tests/`
confirms this.

## 7. Upload flow (maintainer)

```bash
python scripts/gcloud_repo.py auth login
python scripts/gcloud_repo.py init --account <account> --project <project>
export GENOMEOS_GCP_PROJECT=<project> GENOMEOS_DATA_BUCKET=<bucket>
python scripts/provision_data_store_bucket.py --bucket "$GENOMEOS_DATA_BUCKET" --dry-run
python scripts/provision_data_store_bucket.py --bucket "$GENOMEOS_DATA_BUCKET"
python scripts/publish_data_store.py --bucket "$GENOMEOS_DATA_BUCKET" --dry-run
python scripts/publish_data_store.py --bucket "$GENOMEOS_DATA_BUCKET"
GENOMEOS_DATA_BASE_URL="https://storage.googleapis.com/$GENOMEOS_DATA_BUCKET/" \
  python scripts/fetch_data.py --verify-remote --include-git-tracked
```

**Provisioning** mirrors `provision_atlas_web_bucket.py --mode edge`, which is reused through its
org-policy check:

1. Report any blocking org policy and stop before making changes.
2. Create the bucket with uniform bucket-level access and public-access prevention not enforced.
3. Label it, so that an existing bucket without the label is refused before any change
   (needs-human-decision).
4. Grant `allUsers` read.
5. Set CORS.

Every step is idempotent. Public-access prevention is never lifted on an existing bucket.

**Publishing** runs in this order:

1. Check every local file against the manifest.
2. Describe every key, settling every identity before the first upload.
3. Upload the absent objects.
4. Upload the manifest last, at `manifests/<release>.json`.

A reused key from an earlier release must already exist with matching identity; it is never
re-uploaded. `--dry-run` prints every command and the totals of objects and bytes to upload.

**Verification** fetches every object anonymously over public HTTPS and checks its sha256 against
the committed manifest. Only then is the PR ready to merge.

## 8. Trained models

`genomeos.surfaces.persistence.save_fit` writes pickles, `*.fit.pkl`, which hold the PyMC graph and
the posterior. They are git-ignored under `data/store/{fits,screen,screen_v2}` and exist in the
interim Hugging Face dataset: 2 + 20 + 28 = 50 pickles, about 0.7 GB.

No fit exists in a safe format, so **no fit is published to the data store**. Loading a pickle
fetched from the public internet executes whatever code it contains. A follow-up issue covers
exporting each fit to a safe format, for example the posterior as ArviZ netCDF plus a JSON config
plus npz prediction state, with a loader that never unpickles. Once that exists, fits publish like
any other object.

The parquet artifacts already carry every per-cell posterior summary a consumer needs.

## 9. Owner decisions and follow-ups

1. **Discoverability of the base URL.** Under the repository rule, the URL cannot be committed. The
   options:
   - **(a)** Keep the rule. Publish the URL on the site and in the release notes at deploy time from a
     repository variable. Optionally have the site serve a small `data-store.json` pointer that
     `fetch_data.py` could read from the already-public site domain.
   - **(b)** A custom domain, `data.genome-os.org`. HTTPS on a custom domain needs the load balancer
     and managed certificate already scripted for the web bucket (`cloud-cdn` mode), plus a DNS
     record at the registrar, which is a human step with a recurring cost. A plain CNAME to
     `c.storage.googleapis.com` serves HTTP only.
   - **(c)** Carve an exception to the rule for this one public bucket.

   This builder changed no DNS.
2. **Egress and budget.** The release is about 0.27 GB. Internet egress from us-east1 Standard
   storage is about $0.12/GB, so one full download costs about $0.03 and 1,000 full downloads about
   $30. Storage costs well under $0.01 a month. Setting a budget alert on the project needs billing
   permissions, so it is the owner's step. Requester-pays would break credential-free reads, so it is
   not used.
3. **Terms gaps the manifest makes visible.** These are carried as `not_checked` because the
   repository records no check: MAP (the HbS and G6PD survey databases), WorldPop (the target grid),
   and the licence of project-authored data and model outputs. The README's Apache-2.0 notice covers
   only code and docs.
4. **History rewrite.** Deferred by the owner. After this change, `git clone --filter=blob:none`
   avoids downloading old data blobs until they are needed.
5. **Follow-up issues:** a safe export format for fits (§8), and phase 2 for the raw third-party
   harvests.
6. **A CI check of the remote store.** For example, a cheap HEAD and metadata check of the newest
   manifest when the variable is set. Not built here.

## 10. Rollout

1. **The PR.** It contains the design, the plan, the code and tests, the release manifest, the
   untracking and the docs. Until upload and verification it is opened as a draft headed "do not
   merge until uploaded and verified".
2. **An authenticated maintainer runs §7**, ending with the anonymous `--verify-remote`. If this
   session has credentials, the builder runs it.
3. **The PR is marked ready, and the owner merges.** Until the merge, `main` still tracks the files.
   After the merge, history still holds them and the bucket serves them. No step deletes anything,
   anywhere.
