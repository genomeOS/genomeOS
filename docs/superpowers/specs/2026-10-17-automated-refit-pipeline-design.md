# Automated refit pipeline — Design

2026-10-17 · draft for owner review. Implements v1 design §5, §8 and §12
(`docs/superpowers/specs/2026-08-22-genome-os-atlas-v1-design.md`). Builds on the PR #474 data store
(`docs/superpowers/specs/2026-10-17-data-store-on-gcs-design.md`), PR #475 and #472.

## 1. Intent and why

When a reviewed data change merges, each affected surface should refit, check itself and show what
changed. It should then wait for one person to say "publish". Today every step is manual. Version
labels are typed by hand (`scripts/build_surfaces.py:56`), and nothing triggers a refit. Diagnostics
are discarded (`genomeos/surfaces/fit.py:740`), no old-vs-new comparison exists, uploads are run by
hand, and RunPod pods stay open (`scripts/runpod_fit.py:186-190`).

**Governing rule.** Only the bytes the approver reviewed can reach a public bucket, and only after
they approve.

## 2. Goals, non-goals, anti-goals

**Goals.**
- No human step from merge through refit, QC, report and notification.
- No human step after approval: upload, verification, merge, site deploy and API pickup are
  automatic.
- Every served surface can be traced to its inputs, config, code, run and approver.

**Non-goals.**
- Wiring fitting to the P1 observation store (gap 3, separate issue).
- rs334 before a qualified curated MAP HbS CSV is in the data store (§10, phase 4).
- Scheduled re-harvesting from upstream, GPU, burden layers.
- Publishing fits (#471).

**Anti-goals.**
- Candidate bytes in a bucket before approval.
- Credentials in any job that runs science code.
- Overrides such as `--overwrite`, a QC-override label or `force`.
- AI agents in the pipeline.
- Compute that keeps running.

## 3. Constraints and invariants

- **AGENTS.md invariants.** Observations and surfaces stay separate, in figures and in keys.
  Promotion only copies and verifies; no inference on the serving path. Schema violations are hard
  errors. Artifacts are immutable, keyed by `(variant_id, model_version, data_version)`
  (`genomeos/surfaces/artifacts.py:202` refuses an overwrite). Counts, not frequencies. `SEED = 42`.
- **Code layout.** Pure logic under `genomeos/refit/`, I/O in `scripts/`.
- **Public repo.** PR branches and Actions artifacts are readable by anyone signed in. No project ids
  in git (`docs/repo-gcloud-auth.md`).
- **Rulesets.** "Protect main" needs one code-owner approval (`.github/CODEOWNERS`) and dismisses
  stale approvals; admins may bypass it for PRs only. "main: required checks" has no bypass: `test`
  and `tracked-files`.
- **Workflow triggers.** No `pull_request_target` or `workflow_run`, and no credentials in
  `pull_request` jobs.
- **Budget.** A $200/month budget with alerts at 50/90/forecast-100/150% already exists (created
  2026-10-17). The 150% kill switch, which makes the data bucket private, is built separately, not
  in this pipeline. This pipeline creates no standing GCP resources.

## 4. The flow, end to end

**1. Trigger.** New data enters in one of two ways (B16):
- a code-owner-approved PR to in-git inputs: registry or source rows, or literature evidence ledgers
  once committed;
- a #472 harvest PR. A maintainer uploads a release that adds or refreshes a raw harvest; the PR
  adds its manifest and re-pins the affected specs (`refit_plan.py --repin`).

The push to main runs `.github/workflows/refit.yml`, filtered to `data/datasets/**`,
`data/registry/**`, `data/sources/**` and `data/raw/afnd_populations.tsv`. `workflow_dispatch`
reruns named datasets; the dispatching code owner decides.

**2. Dataset detection.** `scripts/refit_plan.py` wraps the pure `genomeos/refit/spec.py` and
`plan.py`.
- **Spec.** `data/datasets/<dataset_id>.toml`, one per id in
  `website/src/atlas/public-artifacts.json` (30 today).
  - Fields: `variant_id` (via `data/registry/variant_normalization.tsv`), `measurement`, `adapter`
    (`map_hbs | map_g6pd | afnd`), `inputs` `[{path | key, sha256, source}]`,
    `target_grid {h3_res, key, sha256}`, `model_version`, spatial 5-fold `cv`, and every
    `FitConfig` field (`genomeos/surfaces/config.py:91-176`). `lengthscale_sigma` replaces
    `scripts/build_surfaces.py:48`. `seed` must be 42.
  - A git-ignored input path is a hard error, so #472 is a prerequisite for any dataset whose
    inputs include a raw harvest.
- **Served record.** The bot writes `data/datasets/<dataset_id>.served.json`: `artifact_id`,
  `inputs_hash`, `model_fingerprint`, `release`, `run_id`, `deciders`, `self_merged`, bundle and
  file sha256s, and `rejected` keys (§4.11). The 30 current v3 artifacts start as `adopted`.
- **Derived values.**
  - `inputs_hash` = sha256 of the spec (minus `model_version`), input sha256s, `registry_version`
    and grid sha256.
  - `data_version` = `<source>-<YYYY-MM>-<inputs_hash[:8]>`, e.g. `afnd-2026-11-3f9c2a1b`, with the
    prefix `ARTIFACT_DATA_SOURCES` in `scripts/build_data_release.py` requires. `YYYY-MM` is the
    trigger merge commit's date (on a dispatch, the last commit that changed the spec or its
    inputs), never the run date, so a rerun gives the same key.
  - `model_fingerprint` = sha256 of `FitConfig`, priors, `FIT_FORMAT` and `ARTIFACT_FORMAT`. A
    change without a `model_version` bump is a hard error. Code changes alone never refit.
- **Selection.** A dataset refits when its spec or an in-git input changed in `before..after`, its
  derived key differs from `served.json`, and no committed `data/releases/*.json` holds the key. A
  closed refit PR therefore never retriggers.
- **Cap.** Above 3 selected datasets, the plan is commented on the trigger PR and waits for a code
  owner's dispatch.
- **Decider.** The code owner whose latest review is `APPROVED` on the merged PR's final head SHA
  (`GET /repos/genomeOS/genomeOS/commits/{sha}/pulls`). With no approver (admin self-merge), it is
  `merged_by`, and `served.json` and the report record `self_merged: true`. On dispatch, it is
  `github.actor`, a code owner.

**3. Refit compute.** Free GitHub-hosted `ubuntu-24.04` runners (4 vCPU, 16 GB, 6 h limit).
- **Matrix.** Dataset × (`fit`, `cv-0..cv-4`), `max-parallel: 12` (GitHub Free runs 20 jobs at
  once). Each job has `contents: read`, no credentials, a 330-minute timeout and
  `pip install --constraint requirements.lock`.
- **Concurrency.** Group `refit-<dataset_id>-<part>`, without cancel: a dataset never fits twice at
  once. If GitHub drops a pending job for a newer run, `notify` names the unstaged datasets on the
  trigger PR.
- **Inputs** come from `scripts/fetch_data.py` over public HTTPS. A sha256 mismatch is a hard error.
- **`fit`** runs `run_batch` → `fit_surface` (`fit.py:507`) → `publish_artifacts.py` (never
  `--overwrite`). With the fit in memory, it writes what downstream needs, so no pickle leaves the
  runner (#474 C11): the diagnostics `_check_convergence` (`fit.py:473`) now returns, E-BFMI, the
  in-sample PPC (`genomeos/validation/predictive.py:609`), scalar draws as `.npz`, and
  `provenance.json` (`FitConfig`, git SHA, lock sha256, runner image, CPU, `scripts/env_report.py`).
- **`cv-k`** runs one spatial fold in the new `scripts/refit_fold.py`
  (`genomeos/validation/crossval.py:213,255`). The skill gate (`genomeos/surfaces/batch.py:149`)
  reuses those fits. Each job takes about 0.5–1.5 h.

**4. QC.** A non-fitting `qc` job writes one `qc.json` per dataset with the pure
`genomeos/refit/qc.py` (§5).

**5. Report.** `scripts/build_refit_report.py` writes one report, a section per dataset, and the
receipt (§6). The old side is the served `cells.parquet`, fetched by release manifest.
`genomeos/refit/compare.py` and a new `genomeos/viz/h3_render.py` read only `cells.parquet`.

**6. Staging, without the cloud.**
- **Bundle.** `qc` packs a deterministic tar (`--sort=name --mtime=@0 --owner=0 --group=0`) into the
  Actions artifact `refit-<run_id>`, kept 30 days. For each passing dataset it holds
  `store/artifacts/<artifact_id>/`; `validation/refits/<artifact_id>/` with the report;
  `serving/<artifact_id>/surfaces.parquet` for the API (`genomeos/artifacts/build.py`);
  `atlas-web/` (`export_atlas_web.py --allowlist`, then `encode_atlas_web.py --with-downloads`, only
  keys new to main's catalog, plus `catalog.json`); and `promotion/`, the exact bytes of the PR's
  files. A dataset with any FAIL gets only its report: no `served.json` and no `promotion/` files.
- **Stage.** The `stage` job holds the only write token and runs no science code. It picks release
  id `<date>.N`, the first neither committed nor publicly readable at `manifests/<release>.json`. It
  pushes a new branch `refit/<run_id>`, never force-pushing, that touches only:
  - each passing dataset's `served.json`;
  - one new `data/releases/<release>.json` (`build_data_release.py` reuses earlier keys);
  - **the pin**, the committed files that select what is served:
    `website/src/atlas/public-artifacts.json`, `website/public/data/atlas/catalog.json` and the
    API's new `data/serving/atlas.json`;
  - at most 2 MB of figures per dataset under `docs/figures/refits/<artifact_id>/`.
- **PR.** One trigger gives one PR (`atlas-refit`) and one release. Stage dispatches `ci.yml` and
  `release-objects.yml` on it, because `GITHUB_TOKEN` PRs get no `pull_request` runs. If nothing
  passed, the PR is a draft titled `[QC FAILED] …`. Stage closes any open refit PR it supersedes,
  with a comment, carrying that PR's other datasets over from its verified bundle.
- **Restage mode** (`refit.yml -f restage=<pr>`) rebuilds the release, the pin and `served.json`
  from the same verified bundle, with no refit, after another promotion landed first. It keeps the
  deciders, and the new PR needs a fresh approval.

**7. Notification** goes through GitHub alone, with no email secret.
- Stage runs `gh pr edit --add-reviewer <deciders> --add-assignee <deciders>`. The PR body opens:
  *"@decider: you approved #N. Approving this PR publishes this refit; closing it publishes
  nothing."* The trigger PR gets the same @mention, or the run link after an earlier failure.
- The daily `refit-sweep.yml` reminds deciders on days 7 and 21 and closes the PR with a comment on
  day 30, when the bundle expires. Any code owner can re-dispatch and become the decider.
- The actor is the bot, so a decider who started the run is still emailed.

**8. Review.** The decider reads the PR, optionally downloads the bundle, and approves or closes it.
Approval of the head SHA is the upload decision. Any later push dismisses it.

**9. Promotion.**
- **Dispatch.** `promote-dispatch.yml` (`pull_request_review: submitted`, `actions: write` only) runs
  `gh workflow run promote.yml --ref main -f pr=<n>` when an approval lands on a bot-authored,
  same-repo `refit/*` PR. It carries no authority.
- **Verify, before any upload.** `promote.yml` runs on `workflow_dispatch`, concurrency
  `atlas-promote`, no cancel. Its `verify` job has no `id-token` and refuses unless:
  - (a) the PR is open, not a draft, and `reviewDecision` is `APPROVED`, by a decider who is a
    current code owner, on the head SHA;
  - (b) only allowlisted paths changed, all in bot commits;
  - (c) the producing run is a successful `refit.yml` run on main, and the bundle and every file
    match `served.json` and the PR byte for byte;
  - (d) the release base is newest, the previous pin current, nothing withdrawn, and the release id
    absent from the bucket;
  - (e) `test` and `tracked-files` passed on the head SHA and the PR is `MERGEABLE`
    (`mergeStateStatus` cannot be `CLEAN` until `release-objects-present` passes after upload);
  - (f) no promoted dataset's `qc.json` has a FAIL.

  If (d) fails because another promotion landed, promote comments and dispatches restage mode.
- **Upload.** The `upload` job (environment `atlas-publish`, the only `id-token`) checks out main,
  never the PR. No `cache:`, no installs: the upload scripts are standard-library only, and gcloud
  comes from a SHA-pinned action. Any future install must use `--require-hashes`. Through WIF it
  runs `publish_data_store.py --manifest data/releases/<release>.json` and
  `publish_atlas_web.py --staging bundle/atlas-web` (create-only, safe to re-run), then
  `fetch_data.py --verify-remote --prefix <new keys>`.
- **Site and merge.** `site` (no `id-token`) builds the site and runs
  `check_atlas_web_data.py --production` on the PR catalog. `merge` re-runs
  `release-objects-present`, requires `CLEAN`, runs `gh pr merge --squash --match-head-commit <sha>`,
  dispatches `pages.yml` and `ci.yml`, and comments the live link on both PRs. Objects exist before
  main references them, and one merge flips the pin for every dataset.
- **Nothing dropped silently.** GitHub replaces a pending run when another queues. Every refusal,
  and every cancelled run that started, comments on the PR. A run dropped while pending cannot, so
  the daily sweep re-dispatches approved, unpromoted refit PRs.
- **Merge guard.** The required check `release-objects-present` (`release-objects.yml`, no
  credentials) runs on every PR. If the PR adds a release manifest or changes `catalog.json`, it
  runs an anonymous HEAD, then GET and sha256, on every new key. So a human cannot merge an
  unpromoted refit PR.

**10. Serving.** No inference happens anywhere on this path.
- **Atlas.** Pages deploys the merged `catalog.json`; its objects come from the web bucket.
- **Data users** read the newest release manifest.
- **API (B15).** The Cloud Run API resolves what it serves at runtime, so promotion needs no deploy
  identity. It reads `data/serving/atlas.json` from main over public HTTPS
  (`raw.githubusercontent.com`, as `scripts/render_coverage_badge.py:12` does) with a 300 s TTL
  cache, keeping the last good copy if a read fails. The parquet files it names are data-store
  keys, fetched once, sha256-checked and cached in `/tmp`.
- **API change.** Today the API loads `ATLAS_ARTIFACT_ROOT` (`genomeos/config.py:16`) once
  (`genomeos/atlas_api.py:22`, `genomeos/artifacts/catalog.py:54-56`) from a gcsfuse mount
  (`deploy/cloudrun-service.yaml:29-49`). The change:
  1. Catalog schema 3 moves `data_version` and `model_version` onto each `VariantEntry`
     (`genomeos/artifacts/manifest.py`) and drops the one-version rule
     (`genomeos/artifacts/build.py:97`), which cannot even hold today's `map-2026-08` and
     `afnd-2026-08` artifacts together.
  2. `ArtifactCatalog` gains a remote mode, with settings `ATLAS_CATALOG_URL` and
     `ATLAS_CATALOG_TTL_S`. `ATLAS_ARTIFACT_ROOT` stays for the synthetic catalog and tests.
  3. The gcsfuse volume goes, and `docs/deployment-gcp.md:81-84` is rewritten.

  Code changes still deploy by hand. The production API is not live yet (#49).

**11. Versioning, rollback, takedown.**
- **Versions** live in artifact keys, immutable release keys (Object Versioning and a 30-day soft
  delete, #474 C2), content-addressed web keys and the pin's git history.
- **Rollback** is a forward PR that changes only the pin and `served.json`, recording the abandoned
  key under `rejected`. It never reverts `data/releases/**`: CI refuses changes to existing files
  there, except new `WITHDRAWN.json` entries. Pages redeploys, the API follows within the TTL, and no
  cloud write is needed.
- **Takedown.**
  - A code-owner PR appends `{key, sha256, reason, issue, date, decided_by}` to
    `data/releases/WITHDRAWN.json` and rolls the pin back. `fetch_data.py`, `build_data_release.py`,
    `export_atlas_web.py`, `check_atlas_web_data.py` and `promote.yml` refuse withdrawn keys.
  - Delete the bundle (`gh api -X DELETE /repos/genomeOS/genomeOS/actions/artifacts/<id>`). The
    Owner deletes bucket objects, which the publisher cannot. Figures pushed to a PR stay readable
    under `refs/pull/<N>` after the branch is deleted; only GitHub Support can purge them.
  - Refit outputs use `Cache-Control: public, max-age=3600` (#474 §9.6 option b).

## 5. QC statistics

FAIL blocks promotion and has no override. WARN is shown in red, and approval counts as
acknowledging it. Thresholds are constants in `genomeos/refit/qc.py`, recorded in `qc.json`, and
changed only by PR.

| Check | FAIL | WARN | Where |
|---|---|---|---|
| Inputs | sha256 mismatch; missing `uncertainty_radius_km`/`sampling_design`; not 0 ≤ ac ≤ an, an > 0; rows in ≠ used + excluded (`EXCLUSION_REASONS`, `batch.py:40`); used < 5 | — | plan, fit |
| Convergence | rank R-hat > 1.05; bulk ESS < 200 (`config.py:171,175`); **new:** tail ESS < 200, divergences > 0, E-BFMI < 0.3 in any chain | treedepth hits > 1%; inducing spacing < `MIN_SPACING_FRACTION` (`fit.py:753`) | fit |
| Spatial skill | < 60% of folds beat the constant baseline; < 3 of 5 folds scored | any fold failed | cv, qc |
| Artifact | invalid manifest; NaN in a non-`unknown` cell; quantiles unordered or outside [0,1]; `post_sd` ≤ 0; bad support state or `support_counts` ≠ recount (`mask.py`); grid ≠ shared web grid; encode round trip not bit-exact; key already released; pickle or object `.npy`; withdrawn key | — | qc |
| In-sample PPC | — | randomized-PIT KS D > 0.1; 95% interval covers < 90% of observed `ac` | fit |
| CV vs previous `qc.json` | — | 95% predictive coverage drops > 0.05; log-score gain over baseline drops > 0.02/obs | qc |
| Change | — | > 5% of jointly supported cells have \|z\| > 2, z = Δmedian/√(sd_old²+sd_new²); \|Δρ\|/ρ_old > 25%; any supported cell becomes masked; > 10% of cells have sd_new > 1.2·sd_old; WorldPop-weighted mean \|Δmedian\| > 0.01 | qc |
| HbS parity | — | share inside Piel IQR < 0.80 (§8 blocks burden, not surfaces) | qc |
| Environment | — | runner image, CPU or lock differs from the previous run | qc |

Recorded but not gated: the observation diff by source and `sampling_design`, 4×4 support
transitions, hyperparameter CIs, Δmedian quantiles, top-10 countries by Δ masked mean, per-fold
coverage, MAE and RMSE, and wall time. Legacy artifacts report "no baseline" for regression rows.

## 6. Report, and how the reviewer sees it

**Figures.** Every figure is rendered from `cells.parquet` and titled `CANDIDATE (unreviewed)`. They
follow AGENTS.md: no-data cells are always drawn, ramps run low to high, and surfaces and
observations are never shown in one layer.
1. Old and new median on one shared scale.
2. Δmedian on a diverging, zero-centred scale. Cells masked in either version are marked "not
   compared".
3. A z map with |z| > 2 outlined, beside log2(sd_new/sd_old).
4. The support transitions, as a map and a table.
5. Observations (old-only, new-only, both) as a separate figure.
6. Diagnostics: posteriors vs priors with R-hat and ESS, PIT, and CV by fold.

If the grids differ, figures 2–4 become a note. Tables cover gates, hyperparameters, countries, the
observation diff, exclusions and provenance. A receipt hashes every input, output and figure, in the
pattern of `scripts/build_calibration_report_demo.py`.

**Where the reviewer reads it.** The PR body has a section per dataset: a header (old → new key,
trigger PR, deciders, `self_merged`, run, bundle sha256), the gate table, and figures 1–4 embedded by
raw URL pinned to the head SHA (the AGENTS.md "Show the map" rule). The bundle holds the full
`report.html`. Promotion publishes the report to `validation/refits/<artifact_id>/`; that and
`serving/` need new source rules in `build_data_release.py`.

**Injection safety.** The PR body and report contain only numbers from `qc.json`, regex-checked
identifiers and fixed template text, all HTML-escaped. `${{ github.event.* }}` is never placed in a
`run:` step; values pass through `env`.

**What "not public" means** (decided, §11). Anyone signed in to GitHub may see the report, figures
and bundle before approval; they are labelled unreviewed and built only from public, merged inputs.
Before approval nothing is in either bucket, in a release on main, in the Atlas or in the API.

## 7. Identities, permissions and settings

**GitHub.** Every workflow starts from `permissions: {}`. Actions in `promote.yml` are pinned by SHA.
- **`refit.yml`.** `plan` and `notify`: `contents: read`, `pull-requests: write`. `fit`, `cv` and
  `qc`: `contents: read`. `stage`: `contents`, `pull-requests` and `actions` write. No environment,
  no `id-token`.
- **`promote.yml`.** `verify` and `site` read only. `merge` has `contents`, `pull-requests` and
  `actions` write. `upload` runs in environment `atlas-publish` (main only, no secrets; variables
  `GCP_WIF_PROVIDER`, `ATLAS_DATA_BUCKET`, `ATLAS_DATA_BASE_URL`) with `actions: read` and
  `id-token: write`. Besides the Pages deploy, it is the only job that mints OIDC.
- **Others.** `promote-dispatch.yml`: `actions: write`. `release-objects.yml`: `contents: read`.
  `refit-sweep.yml` (daily): `pull-requests` and `actions` write.
- **Settings.**
  - Enable "Allow GitHub Actions to create and approve pull requests". The bot is not a code owner,
    so its approval never counts.
  - Add `workflow_dispatch` to `ci.yml`; its `changes` classifier treats a dispatch as a push.
  - `.gitignore` and `tracked-files` admit `data/datasets/**`, `data/serving/atlas.json` and
    `docs/figures/refits/**`. `tracked-files` makes `data/releases/**` append-only.
  - The owner adds `release-objects-present` to "main: required checks".

**GCP.** The owner creates these by hand with `scripts/gcloud_repo.py` on their own machine, never
where agents run.
- **WIF.** Pool `github`, provider `github-actions`, issuer
  `https://token.actions.githubusercontent.com`. Mapping: `google.subject=assertion.sub`,
  `attribute.environment=assertion.environment`, `attribute.repository_id=assertion.repository_id`.
  Condition:
  ```
  assertion.repository_owner_id == '333042141' && assertion.repository_id == '1343109935' &&
  assertion.ref == 'refs/heads/main' && assertion.environment == 'atlas-publish' &&
  assertion.event_name == 'workflow_dispatch' && assertion.runner_environment == 'github-hosted' &&
  assertion.workflow_ref == 'genomeOS/genomeOS/.github/workflows/promote.yml@refs/heads/main'
  ```
- **Publisher.** Direct-WIF `principalSet://…/attribute.environment/atlas-publish`, so there is no
  service-account key.
  - On `genomeos-atlas-data`: `roles/storage.objectCreator`, with `resource.name` conditioned to
    `…/objects/releases/` or `…/objects/manifests/`. Plus `roles/storage.objectViewer`, which adds
    only `list`, so an absent object describes as 404, not 403.
  - On the web bucket: `objectCreator` conditioned to `…/objects/atlas/web/`. `allUsers` already
    has `objectViewer` there (`scripts/provision_atlas_web_bucket.py:50`).
  - No delete, update or project role, so it cannot overwrite or delete. Composite uploads need
    delete, so set `CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False`.
  - Fallback: one `atlas-publisher` SA with the same bindings, impersonable only by this
    principalSet.
- **Nothing else.** No compute identity, staging bucket, API deploy identity or key.

**People.** `@bschilder` and `@dwgoblue` decide and dispatch. Read and triage collaborators cannot
trigger anything. Fork content runs only after a code owner merges it.

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Input mismatch, schema violation, fetch 403 (kill switch) | Fails before staging; comments on the trigger PR. |
| FAIL gate | That dataset stages nothing; promote refuses any FAIL; the old surface stays live. |
| Job hits 330 min | Fails; the comment points to the phase 5 escalation. |
| Decider never reviews | Reminders on days 7 and 21; closed on day 30; a rerun gives the same key. |
| Push after approval | Approval dismissed; the authorship and SHA checks fail. |
| Another promotion lands first | Staleness guard refuses; restage mode. |
| Pending promote run dropped | The daily sweep re-dispatches it. |
| Upload, merge or Pages fails | Re-dispatch; identical objects are skipped; main and the site are unchanged until verification passes. |
| Bad surface or terms problem later | Rollback PR, or `WITHDRAWN.json` (§4.11). |

## 9. Cost

- **Compute: $0.** Standard GitHub-hosted runners are free for public repos; a refit takes about 6
  job-hours per dataset.
- **Bundles.** About 10–50 MB per dataset, kept 30 days. Confirm in phase 0 that this fits the free
  allowance.
- **GCS.** About 10–20 MB per promoted dataset, under $0.01 a month. Egress is unchanged (#474
  §9.2), apart from each API instance fetching each served parquet once.
- **Phase 5 escalation.** Roughly $1–7 per HbS-scale refit.
- **Budget.** A $200/month budget with alerts at 50/90/forecast-100/150% already exists (created
  2026-10-17). The 150% kill switch, which makes the data bucket private, is built separately, not
  in this pipeline. This pipeline creates no standing GCP resources.

## 10. Build phases (smallest useful slice first)

0. **Prerequisites.**
   - Merge #474 and #475.
   - Through #472, publish the AFND frequency table and the WorldPop res-4 grid parquet (not the
     870 MB raster). The AFND pilot needs both: the table is git-ignored (`.gitignore:258`) and its
     upstream is a moving `main` file (`scripts/runpod_fit.py:135-136`), and the grid is a required
     input (`scripts/publish_artifacts.py:92`).
   - In a scratch repo, confirm that dispatched `ci.yml` and `release-objects.yml` runs satisfy the
     required checks on a `GITHUB_TOKEN` PR, that `pull_request_review` can dispatch a workflow, and
     that a `GITHUB_TOKEN` merge with `--match-head-commit` passes the rulesets.
   - The owner tests the publisher bindings on a scratch bucket.
1. **Local refit and report** (no CI, no cloud). Build `genomeos/refit/{spec,plan,qc,compare}.py`,
   `genomeos/viz/h3_render.py`, the new `FitConfig` gates, kept diagnostics, `refit_fold.py`,
   `build_refit_report.py` and `scripts/refit.py --dataset <id>`. Write specs and `served.json` for
   the 30 artifacts. Tests use `tests/fixtures/map_hbs_curated_synthetic.csv` and golden report
   bytes.
2. **CI refit to a review PR** (no credentials). `refit.yml` with batching, the cap, notification
   and draft-on-failure, plus the `ci.yml` dispatch and `tracked-files` rules. Pilot on
   `hla-a-02-01`; upload stays manual.
3. **Automated promotion and API pickup.** WIF, `atlas-publish`, the promote workflows,
   `release-objects.yml`, `refit-sweep.yml`, `WITHDRAWN.json` enforcement, `max-age=3600`, catalog
   schema 3, the API's remote mode, and serving parquet for the 30 adopted artifacts. Rehearse a
   rollback and a restage.
4. **rs334.** #190 is closed. The real blocker: no qualified curated MAP HbS CSV exists. The raw
   MAP export intentionally fails the HbS adapter, and the repository "does not currently contain
   or claim a qualified real curated MAP source" (`docs/data-store.md:128-134`). No issue tracks
   one yet. Curate it under `docs/map-spatial-support.md` and publish it with the raw MAP harvest
   through #472, which lists only the raw exports. Then the national-draws exporter, HbS parity
   and rs334.
5. **Deferred.** Observation-store wiring, larger runners or GPU, scheduled re-harvesting and a
   same-seed replay check.

## 11. Decided by the owner

> "the goal is to make this as automated as possible, while still ensuring quality checks. when new
> data is added to a particular dataset (say rs334) compute should be launched to refit it, upload
> the new data and surface to GCP (which should be version controlled, i think GCP has a feature for
> this), so that it can then be served via the API and Atlas to users."

> "we need to build in automated QC statistics generation, a report including new vs old map
> visualizations, and a automated notifcation sent to whichever member approved the PR. the final
> upload will be up them after reviewing the report."

Also decided:
- **Candidate privacy.** "Yes, PR visibility is fine". The candidate report and maps may appear in a
  public PR before approval. Nothing reaches a bucket, the Atlas or the API before approval.
- **Pilot order.** "AFND allele first, then rs334".
- **Data store.** Public GCS with Object Versioning, soft delete, immutable paths and a committed URL
  (#474 C2, C4, C8).
- **Pickles.** Unpublished until #471.
- **Credentials.** WIF with no secrets. Nothing runs on fork-triggered events. Environments carry
  branch policies. Owner credentials stay away from agents.
- **Branch protection** now exists: the code-owner ruleset plus a no-bypass required-checks ruleset
  for `test` and `tracked-files`.
- **Budget** now exists: $200/month with alerts at 50/90/forecast-100/150% (created 2026-10-17).

## 12. Builder's calls

None of these was decided by the owner.

- **B1 [Builder's call]** Free GitHub-hosted CPU runners only; GPU and Cloud Batch deferred.
- **B2 [Builder's call]** No cloud staging: a run-scoped Actions artifact, verified by API run check
  plus sha256. No Sigstore attestation.
- **B3 [Builder's call]** Approval triggers the upload, before merge; the bot merges with
  `--match-head-commit`.
- **B4 [Builder's call]** The decider is the trigger PR's code-owner approver; else the merger
  (`self_merged: true`); else the dispatcher.
- **B5 [Builder's call]** `data_version` = `<source>-<YYYY-MM>-<hash8>`, dated by the trigger merge
  commit. Hand-bumped, fingerprint-enforced `model_version`. Code and lock changes are recorded, not
  keyed, and never refit on their own.
- **B6 [Builder's call]** Two QC tiers. CV regression, change size and parity are WARN.
- **B7 [Builder's call]** A FAIL dataset stages nothing; if all fail, the PR is a draft. Promote
  re-reads `qc.json` and refuses any FAIL.
- **B8 [Builder's call]** The comparator requires identical grids.
- **B9 [Builder's call]** At most 2 MB of downscaled figures per dataset in git.
- **B10 [Builder's call]** The publisher is a direct-WIF principalSet with prefix-conditioned
  `objectCreator`.
- **B11 [Builder's call]** Refit data-store objects get `max-age=3600`; web objects stay immutable.
  Takedown follows §4.11.
- **B12 [Builder's call]** 30-day bundles; reminders on days 7 and 21, closure on day 30; any code
  owner can re-dispatch and decide.
- **B13 [Builder's call]** Pilot `hla-a-02-01` on today's adapters, after #472 publishes the AFND
  table and WorldPop grid. The rs334 track adds the MAP harvest and a curated CSV.
- **B14 [Builder's call]** GitHub-native notifications only. No failure issue. No replay or control
  refit: posterior-SD z-scores absorb sampler noise.
- **B15 [Builder's call]** The API resolves the served catalog at runtime from a committed pointer,
  read with a 300 s TTL, and the public data store. Promotion needs no deploy identity.
- **B16 [Builder's call]** New data enters by a code-owner PR to in-git inputs or a #472 harvest PR
  whose merge re-pins specs. Specs pin inputs by path or key plus sha256. #472 gates raw-harvest
  datasets. Scheduled re-harvesting is deferred.
- **B17 [Builder's call]** One trigger, one PR, one release, a section per dataset; atomic promotion.
- **B18 [Builder's call]** Above 3 datasets, wait for an explicit dispatch. `max-parallel: 12`.
- **B19 [Builder's call]** Restage from the same verified bundle, with a fresh approval.
- **B20 [Builder's call]** Refused or cancelled promotions comment; a daily sweep re-dispatches.
- **B21 [Builder's call]** `release-objects-present`, a credential-free required check.
- **B22 [Builder's call]** The §4.9 checks run before any upload; stage picks the release id against
  the bucket.
- **B23 [Builder's call]** Split `promote.yml`: only `upload` has `id-token`, runs main's scripts, no
  cache, no installs.
- **B24 [Builder's call]** Group `refit-<dataset_id>-<part>`, run id in the branch, no force-push,
  superseded PRs closed.
- **B25 [Builder's call]** Rollback is a forward pin PR; `data/releases/**` is append-only; rejected
  keys are recorded.

## 13. Open questions for the owner

1. **Cache lifetime of data-store objects (#473).** The 2026-10-17 release objects carry
   `public, max-age=31536000, immutable`. This design assumes refit outputs get
   `public, max-age=3600` (B11), so a takedown takes effect within an hour. If the owner keeps the
   one-year lifetime, B11 changes one constant and takedowns rely on the withdrawn list alone.

## 14. Alternatives considered

| Design (1–10) | Safety | Simplicity | Review | Cost | #474 fit |
|---|---|---|---|---|---|
| 1. GitHub-native + Cloud Batch GPU | 8 | 5 | 9 | 9 | 9 |
| **2. Attested candidate (base)** | **9** | **7** | **9** | **10** | **9** |

- **Base.** Design 2, for its byte-identity chain and its single create-only identity.
- **Taken from Design 1.** Regression checks, drafts on failure, the self-merge decider, a dated
  `data_version`, parity as WARN, and GPU deferred.
- **Dropped from Design 2.** Attestation, the replay leg, absolute CV flags, checkbox
  acknowledgements, the failure issue, and the code-tree fingerprint.
- **Rejected: GCP-native** (Cloud Batch compute plus a private staging bucket). The owner accepted
  candidate visibility in PRs (§11), and it would put credentials in science jobs.
