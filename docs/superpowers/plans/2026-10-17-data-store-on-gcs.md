# Data store on GCS — Implementation Plan

**Goal:** Publish everything under `data/` to a public, immutable, release-versioned GCS data store.
Commit one manifest per release, give readers a credential-free fetch-and-verify tool, and stop
tracking `data/store/artifacts/**` and `data/validation/**`.

**Spec:** `docs/superpowers/specs/2026-10-17-data-store-on-gcs-design.md`, cited below as "spec
§N". **Issue:** #468.

**Rules:**

- Every gcloud call goes through `scripts/gcloud_repo.py`.
- Never commit a project id or account. Tests write `example-*` names. The owner later decided to
  commit the public data-store URL and bucket name (spec §3 C8).
- Tests use no network and no GCP. Fetch tests use a local `http.server` on 127.0.0.1. Upload and
  provisioning tests reuse `tests/fake_gcloud.py`.
- Before every commit, run `scripts/check_private_files.py` and `git diff --cached --name-only`.
- Commits end with a blank line and the `Co-Authored-By` line.

## Tasks

1. **Pure release module.** Create `genomeos/publication/data_release.py` with tests in
   `tests/test_data_release.py` (spec §5).
   - Validation covers: object shape; sorted, unique paths and keys; safe relative paths; the key
     rule, including reuse of an earlier release's key; the sha256 and bytes types; the closed
     media-type table; refusal of pickle suffixes; the source references and terms rule; totals.
   - `build_manifest(records, sources, release, previous)` covers reuse and the immutable-artifact
     refusal.
   - It also provides `public_url(base, key)` and the base-URL check.
   - RED first: each rule gets a failing test before its code.
2. **Manifest builder.** Create `scripts/build_data_release.py` and its tests (spec §5).
   - It walks the explicit include roots under `data/` and hashes each file.
   - It refuses `.npy` files with an object dtype.
   - It maps paths to sources with the reviewed table, and an unmatched path is a hard error.
   - It reads `data_version` and `target_grid_source` from each artifact's `manifest.json`.
   - It writes `data/releases/<release>.json` deterministically (no clock).
   - A test cross-checks the CPIC and curated source entries against their committed `SOURCE.json`.
3. **Fetch tool.** Create `scripts/fetch_data.py` and its tests (spec §6). The modes are fetch,
   `--list`, `--verify-local` and `--verify-remote`.
   - Downloads are atomic, through a partial directory.
   - Any mismatch is a hard error, and an existing file is never overwritten.
   - The library entry point is `require_local`.
   - Tests serve a tmp tree over 127.0.0.1. They cover a tampered object, a truncated object, a
     differing local file, an unset base URL and a skipped identical file.
4. **Upload guard.** Create `scripts/publish_data_store.py` and its tests (spec §7).
   - It describes every key first. An absent key is uploaded with `--if-generation-match=0`, an
     identical one is skipped, and a different one is a hard error. A 412 response is compared the
     same way.
   - A post-upload check compares size, md5 and sha256 metadata.
   - The manifest is uploaded last. `--dry-run` prints every command and the byte totals.
   - Tests use the fake gcloud.
5. **Bucket provisioning.** Create `scripts/provision_data_store_bucket.py`,
   `deploy/data-store-cors.json` and their tests (spec §3 C1–C3, §7).
   - It is idempotent, honours the label guard and reports org policies.
   - The fake gcloud covers dry-run, create, adoption, refusal of an unlabelled bucket, and enforced
     public-access prevention.
6. **Switch the store readers.**
   - `build_atlas_catalog.py`: the default `--source` resolves through `require_local`.
   - `sync_store.py push-atlas-release`: resolves through `require_local`.
   - `publish_artifacts.py`: refuses a released directory.
   - `store_inventory.py`: docstring update.
   - Each change gets a test.
7. **Generate the release.** Run `build_data_release.py --release 2026-10-17` and commit
   `data/releases/2026-10-17.json`. Run `publish_data_store.py --dry-run` against a placeholder
   bucket and record the object and byte totals.
8. **Untrack.**
   - Run `git rm -r --cached data/store/artifacts data/validation`; the files stay on disk for the
     upload.
   - In `.gitignore`, drop those two exceptions and add `!data/releases/`.
   - Repoint the research docs' links to `data/validation/` to the data store.
9. **Docs.** Update `docs/data-store.md` (layout, the durable table, the runbook),
   `docs/hf-dataset-card.md`, AGENTS.md, README and CONTRIBUTING, including clone advice:
   `git clone --filter=blob:none`.
10. **Follow-up issues.** File one for a safe export format for fits (spec §8) and one for the
    phase-2 raw harvests, listing each source with its recorded terms (spec §2).
11. **Gates.** Run ruff, `freeze_contract --check`, `check_module_size`, `check_private_files`,
    `check_commercial_use`, `smoke.py`, focused pytest, and the tests of the touched scripts.
12. **Cloud step** (spec §10).
    - If repository-local credentials exist: provision, publish, then `--verify-remote` every
      object anonymously, and mark the PR ready.
    - Otherwise open the PR as a draft headed "do not merge until uploaded and verified", with the
      exact commands to run.
13. **PR and CI.** The PR follows the template, leads with a TL;DR and closes #468. Watch
    `gh pr checks --watch` and fix any failure.
