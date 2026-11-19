# Atlas data platform, phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 1 (steps 1.1–1.15) of the approved Atlas data platform:
- land the fit inputs and freeze the v1 layout;
- publish the derived `meta`, `inferred`, `reference` and `measured` tables, with a views-only DuckDB catalog, in two releases;
- project the web observations from the fit inputs;
- write artifact format 4 and safe model exports;
- add browser SQL, a cost report and the data-access docs.

**Architecture:**
- `store/artifacts/` stays canonical, and everything under `tables/v1/` is derived.
- One pinned DuckDB writes the derived files through `genomeos/tables/writer.py`, stamping each with its contract digest, git SHA, inputs and sources.
- Hard-error checks run before `scripts/build_data_release.py` keys the release, and a second pass writes `catalog/`.
- Pure modules hold the rules; scripts do the I/O; the owner does every upload, CORS change and web publish.

**Tech Stack:** Python 3.12 (pandas, pyarrow, pandera, h3, PyMC), DuckDB 1.5.5, Astro/TypeScript/zod, vitest, Playwright, `@duckdb/duckdb-wasm`, GitHub Actions, `gh`.

**Spec:** `docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md` ("§N"; "call N" is §13's builder's call N).

## Global Constraints

- §1's decisions and §13's calls bind. Docstrings cite "Atlas data platform design 2026-10-18 §N".
- Measured and inferred never share a table, file, layer, statement or `tables/` prefix. Allele and carrier counts are separate. Only `measured.fit_inputs` (keys) links them.
- Counts, never frequencies.
- Schema violations are hard errors, and nothing is dropped silently.
- No default for `uncertainty_radius_km` or the ascertainment fields, and no invented coordinate, radius or identity.
- Keys: `https://storage.googleapis.com/genomeos-atlas-data/releases/<R>/<path>`, where `<R>` is the first-publishing release. Reads are by key only. This is the only project bucket URL a tracked file may hold; `test_no_concrete_bucket_url_is_tracked` also admits the third-party `gcp-public-data--gnomad`, which Task 18 reads.
- No project id, billing id, e-mail, token or local path in a tracked file. `check_private_files.py` passes before every commit.
- Write-once (call 6): `epoch=`, `ingest_version=`, `chrom=` and `bin=` parts. This plan extends the same refusal to registry folders `tables/v1/reference/populations/<release>-<sha8>/` (calls 5 and 6 together; Task 17). Summary tables (`meta.*`, `inferred.artifacts`, `measured.ingests`) get a new key each release.
- DuckDB: `duckdb==1.5.5`, `threads = 1`. Catalogs use `STORAGE_VERSION 'v1.2.0'`. Attach is tested from 1.2.2 and the pinned WASM (call 15).
- `tables/` files:
  - zstd and 8,192-row groups;
  - §2.5's target of 1–50 MB per file, with the hard cap `MAX_FILE_BYTES = 150 MiB` ("never above about 150 MB", gcloud's composite-upload threshold);
  - metadata keys `genomeos.table`, `.schema_version` (`"1.0"`), `.contract_sha256`, `.git_sha`, `.inputs`, `.sources`.
- Contracts:
  - path `contract/tables/<schema>.<name>.v<MAJOR>.schema.json`;
  - MINOR is additive, and MAJOR goes to `tables/v2/`;
  - `contract/{observations,carrier_observations}.schema.json` never change.
- Phase-1 catalogs:
  - `access = "open"`, no `hosts`;
  - `catalog.sql` is in git; `atlas.duckdb`, `tables.json` and `tables/` are not;
  - macros call `read_parquet`, and so does every anti-join; no view or macro body names another view.
- Terms statuses are the five `COMMERCIAL_USE_FINDINGS`. `restriction_found` reads as `restricted`; others fail. `non_commercial: true` is authoritative.
- Golden smoke (check 8), verified 2026-11-14 on the parity file (sha256 `466034e22015ce5f4e0b90067adb2232491b625591d50c8ac83d955565345b4b`):
  - 994 rows, `an` 11,359,130, `ac` 175,878;
  - the discs `2 × 6371.0088 × asin(√hav) ≤ 500 + radius_km` from Lagos (6.5244, 3.3792): 40 rows, `an` 52,340, `ac` 6,459.
- Agents run no cloud command and hold no credentials. The owner uploads, publishes the web and applies CORS. The agent merges #491 (§11 1.1 "agent"); the owner approves it if review is required. A publishing PR stays a draft until the owner has uploaded it and the anonymous `--verify-remote` and smoke pass.
- Two releases: Task 15 (1.4–1.6) and Task 27 (1.7–1.12).
- No task adds a stochastic path.
- Modules: `from __future__ import annotations`, ≤ 800 logical lines, ≤ 50 KiB. Pure modules do no I/O, and the release builder never imports the surface stack.
- Environment: AGENTS.md "Reproducing the environment exactly", built inside the task's worktree:
  - `uv venv --python 3.12 && source .venv/bin/activate && uv pip install -r requirements.lock && python -m pip install -e . --no-deps`;
  - then `python -c "import genomeos; print(genomeos.__file__)"` must print the worktree's path.
  - Commands are `python -m pytest <files> -q`, `.venv/bin/ruff check .` and `python scripts/<x>.py`. Never `uv run` inside the project: `pyproject.toml` has no dependency groups and no `uv.lock` is tracked, so it would resolve a fresh environment without pytest or duckdb and write a `uv.lock`. The one exception is Task 14's isolated `uv run --no-project`.
  - CI's test job installs with `python -m pip install -e '.[dev,atlas,surfaces,geo,figures]'` (no constraint); the lock reproduces it locally.
- Every commit:
  - runs CI's gates: `.venv/bin/ruff check .`, `python scripts/freeze_contract.py --check`, `python scripts/check_module_size.py`, `python scripts/check_private_files.py`, `python scripts/check_commercial_use.py`, `python scripts/smoke.py` and the task's focused pytest;
  - stages files by name, never `uv.lock` or `.venv`;
  - carries the harness attribution;
  - is followed, after each push, by `gh pr checks <n> -R genomeOS/genomeOS --watch`.

## Review Focus

1. **A `data/releases/` directory holding `WITHDRAWN.json`, read by something other than `dr.release_ids`** (the website build, the CORS probe).
   - Expected: the file is skipped, never parsed or sorted as a release; any other stray name fails loudly.
   - Tests: Task 6 `test_release_ids_skip_the_withdrawn_list_and_refuse_strays`, Task 28 `test_main_skips_the_withdrawn_list`, Task 30 `releaseIds skips WITHDRAWN.json and refuses strays` and its e2e manifests fixture, which carries a `WITHDRAWN.json`.
2. **A release built from a `data/` tree that lacks a listed file.**
   - Expected: it stops, naming the path and `fetch_data.py --prefix`, and never binds a view over HTTPS (views bind at creation).
   - Tests: Task 13 `test_building_the_catalog_reads_only_local_copies`, Task 12 `test_an_earlier_epoch_listed_but_not_fetched_is_refused`, Task 16 `test_a_harvest_root_that_is_absent_locally_is_a_hard_error`.
3. **A rerun on a later commit (new git SHA).**
   - Expected: it never rewrites a released part or registry folder.
   - Tests: Task 12 `test_a_later_release_writes_only_new_artifacts_and_never_touches_an_earlier_epoch` and `test_a_released_partition_part_whose_bytes_changed_is_refused`, Task 17 `test_a_published_folder_is_verified_not_rewritten`, Task 19 `test_a_published_part_is_verified_not_rewritten`.
4. **Readers on DuckDB 1.2.2, the pinned 1.5.5 and WASM.**
   - Expected: they agree. `epoch` stays VARCHAR, offline mode takes `'data'` or `'data/'`, `catalog.sql` has no arrow lambdas, and sums are exact in the browser.
   - Tests: Task 13 `test_the_catalog_attaches_under_an_alias_and_reads_local_copies` and `test_catalog_sql_has_no_arrow_lambdas`, Task 14's CI step and WASM attach, Task 30's `formatCell` and Lagos tests.
5. **AFND adapter drift against a served web JSON.**
   - Expected: it stops, naming the artifact, the record and the field (exact float equality). It is never silently `none`.
   - Tests: Task 20 `test_an_unlisted_mismatch_stops_the_build_and_a_listed_one_is_none` and `test_radius_is_compared_exactly_not_rounded`.

## Decisions fixed here, and flagged gaps

**Resolved:**
- **Contracts.** Every `TableContract` lives in `genomeos/tables/contracts.py`. Its file wraps pandera's JSON with the table, version, key and partitions, because `to_json` drops metadata. `measured.ingests` is frozen as an Arrow schema.
- **Media types.** `.duckdb` is `application/octet-stream` (`vnd.duckdb` is unregistered), and `.sql` is `application/sql`.
- **`WITHDRAWN.json`** is `{schema, schema_version, withdrawn}`. Python readers of `data/releases/*.json` go through `dr.release_ids`; the website's TypeScript reader goes through `releaseIds` in `website/src/lib/data-store-release.ts` (Task 30), which mirrors it.
- **`OPTIONAL_ROOTS`.** An optional root is listed in both `INCLUDE` and `OPTIONAL_ROOTS` (`catalog` and `tables` in Task 5, `store/external` in Task 16, `store/models` in Task 26). It may be absent until a release publishes under it.
- **Build stages** run in the order `meta`, `reference`, `measured`, `fit_inputs`, `inferred`, each taking a `BuildContext`.
- **Inputs.** `genomeos.inputs` lists data only: store keys, `manifests/<R>.json` and `git:<path>`. Code never adds a source. A `git:` input's sources come from the reviewed `provenance.GIT_INPUT_SOURCES`, and an unlisted git path fails.
- **Check 9 (was F3).** It accepts a committed `manifests/<R>.json` and a `git:<path>` whose sha256 is that file at the stamped `genomeos.git_sha`. Task 11 amends §2.7 check 9 in its own commit.
- **Sources of `meta/` (§9).** `meta.release_objects` and `meta.sources` take the manifests as inputs, so they carry every source. `meta.served` also takes each served artifact's `manifest.json` key, so it carries those artifacts' sources plus `genomeos`. `meta.withdrawn` carries `genomeos` plus its listed objects' sources. Task 11's amendment commit narrows §9's "`catalog/` and `meta/` carry every source" to `catalog/`, `meta.release_objects` and `meta.sources`.
- **Step order.** 1.8 (Task 16) runs before 1.7 (Tasks 17–18), which read its harvests. Step 1.5 publishes nothing on its own.
- **`measured.ingests` key** is `(table, source, ingest_version)`, because two AFND adapters emit `afnd`/`afnd-2026-08` (cytokine alleles and KIR carriers). Task 19 amends §2.4 in its own commit.
- **Withdrawals (§2.9, was F11).** Every view over files reads `read_parquet(<files>, filename = true)` and anti-joins the withdrawn files' URLs or local paths. The `inferred` views also anti-join by withdrawn `cells.parquet` path. Check 7 still refuses a catalog that lists a withdrawn key, so the file-level anti-join guards old catalogs and a regressed check 7.
- **"Format 2.1"** is integer format 4: #491 writes 3, and readers refuse non-integers.
- **`access_policy.py`** comes in Task 16 with the §4.2 constants. Task 26 adds the guard, and step 2.1 extends it.
- **CORS** also lists `Range`.
- **`cite_as`** is `genomeOS Atlas data, release <R>. https://storage.googleapis.com/genomeos-atlas-data/manifests/<R>.json`, and `mirror` is NULL until 3.8.
- **Partition keys are columns.** `cells_by_cell` stores `epoch`, `res` and `h3_r0`, and `measured.fit_inputs` stores `epoch`, for check 2. Only the binned table's `chrom` and `bin` are derived, from `variant_id` and `pos`. A res-3 cell is its own `h3_parent_r3`.
- **G6PD v1** is `allele_frequency`, from its v3 manifest, not the web's `phenotype_frequency`. The owner confirms in Task 15.
- **Web format 1.1 (was F5).** The client accepts the four keys first (Task 21), then 1.1 ships (Task 22), which amends `docs/web-data-format.md`'s MINOR rule. Format 4 reaches the website only after a web MAJOR (Task 23 refuses it).
- **The per-release verify (call 11)** fetches only this release's keys in full and checks reused keys by HEAD (Task 15).
- **Task 7's issue** records the approvals already given and asks the one scope question step 1.8 needs.

**Flagged** (spec section, and what not to guess; F3, F5 and F11 are resolved above):
- **F1 (§1.2 D18, §2.4).** No rule gives the 80 HGDP + 1KG identities' radii, the `location_type` of the 1KG diaspora sites, or the `onekg` notice. Task 18 opens a `needs-human-decision` issue; it gates 2.6 and 2.8. Never use the synthetic radii.
- **F2 (§1.4).** Task 18 reads `gnomad_meta_updated.tsv` (`reference_cohorts.METADATA_SHA256`), taking its columns from the header. If it holds fewer than 80 populations, stop.
- **F4 (§2.4, §2.5), out of phase 1.** `cells_by_cell` v1 holds formats 1–2. Formats 3 and 4 need contract 1.1 (a nullable `prior_frequency_sd`, read with `union_by_name`), which must land before the first artifact with a fit input ships. No such artifact ships in phase 1 (Task 27 expects none), so phase 1 adds no 1.1, and Task 12's refusal holds the line. Until then no `fit-record` or model export reaches a release.
- **F6 (§1.4).** No WASM version is named; Task 14 pins one and Task 29 measures it. If the result is `'p4-api'`, step 2.9 has no route until 3.6; tell the owner.
- **F7 (1.14).** Monitoring's two-month retention is unverified. D3's "data egress" and D12's "free egress" are both measured as the data and lookup buckets. Nothing schedules the monthly run.
- **F8 (§9, §14).** The "research note" is `research: sources` in the whole-genome results. `wg/decisions/`, `out/` and `rserve.py` were not recovered.
- **F9 (call 18).** Legacy registries keep their names as folders. MAP legacy rows are alias-only (`map-hbs-<id>`, `map-g6pd-<id>`); the owner confirms.
- **F10 (D5a).** Only `genomeos` objects record CC BY 4.0. `docs/hf-dataset-card.md` still says `license: other`.
- **F12 (§4.2, §4.3, §11 1.8).** Task 16 publishes the AFND, MAP and WorldPop harvests and the three `store/external/` caches. The WorldPop res-4 grid parquet becomes `reference.grid_cells` in step 3.6 (§11), so 1.8 publishes only its rasters. `data/raw/gnomad_hgdp_1kg_freqs.tsv` is on no mirror and no record gives its upstream, and #472 leaves the AFND page caches open; Task 7's issue asks the owner about both. Per-sample gnomAD metadata is never hosted. The 2 GiB guard applies from Task 26, and release 2 (WorldPop rasters, about 870 MB) nears it.

## Execution and parallelism

- **Serial:** 1 (agent merges; owner approves if review is required) → 2–6 (one PR) → 7 → 8 → {9 ∥ 10} → 11 → 12 → 13 → 14 → 15 (owner uploads release 1).
- **Lanes after Task 13:**
  - A: 16 → 17 → {18 (its TSV waits on F1), 19 → 20}. Task 19 needs Task 17's `require_same_rows` and the `afnd-2026-08` registry; Task 20 also needs 12.
  - B: 21 → 22 (needs 17) → 23; in parallel, 24 → 25 → 26 (needs 16). Task 23 follows 22 because `scripts/export_atlas_web.py` is at 798 of 800 logical lines on #491 until Task 22 moves the serializer out, and both edit `genomeos/publication/web_format.py`, `website/src/atlas/contracts.ts` and `docs/data-store.md`.
  - C: 28 (owner applies CORS) → 29 (needs 13, 14; its live gate needs the CORS change) → 30 (needs 6; its live check needs release 1).
  - D: 31 (needs 16) → 32 (needs 28–31).
- **Release 2:** Task 27 follows 16–26 and the F1 answer. It ends with the owner's upload and web publish.
- **Blocking owner steps:** Task 1's approval (only if `BLOCKED`); Task 15's upload (blocks Task 30's live check); Task 18's answer (blocks Task 27); Task 28's CORS change (blocks Task 29's live gate). Task 7's scope question blocks nothing: without an answer, Task 16 publishes everything else.

---

### Task 1 (step 1.1): Land PR #491, checking that no KIR artifact was released before it

**Files:** none. #491 (`data/fit-inputs`, head `3513f1f`, KIR fix `228ea54`) lands as reviewed, never rebased.

**Interfaces** (on `main` afterwards):
- `artifact_inputs.{INPUT_FILE = "observations.parquet", CONTRACT_REVISIONS, check_artifact_inputs}`
- `dr.artifact_directory`
- `build_data_release.{build(data_root, release, *, tracked, released_without_input, previous=()), check_inputs, sources_for, _RULES, RELEASED_WITHOUT_INPUT}`
- `surfaces.artifacts.{ARTIFACT_FORMAT = 3, ARTIFACT_COLUMNS (15), read_observations, _validate_current}`
- `tests/observation_fixtures.observation_rows(n=6, *, variant_id="chr11-5227002-T-A")`
- `tests/test_build_data_release.py`: `_write`, `_build`, `_paths`, `tree`, `RELEASE = "2026-10-17"`

- [ ] **Confirm the head.** `git rev-parse origin/data/fit-inputs` → `3513f1f3943091efeffd0ece9b2e000ba84db7b6`, and `git merge-base --is-ancestor 228ea549 origin/data/fit-inputs` exits 0.
- [ ] **Check the gate.** Write a short `git show` script over `origin/main:data/releases/*.json` and the PR head's `RELEASED_WITHOUT_INPUT`. Expected, exactly:
```
releases: 2026-10-17 2026-10-18
kir dirs: 8 kir__2dl1__v2__afnd-2026-08 kir__2dl1__v3__afnd-2026-08 kir__2dl2__v2__afnd-2026-08 kir__2dl2__v3__afnd-2026-08 kir__2ds1__v2__afnd-2026-08 kir__2ds1__v3__afnd-2026-08 kir__3ds1__v2__afnd-2026-08 kir__3ds1__v3__afnd-2026-08
with observations.parquet: []
not in RELEASED_WITHOUT_INPUT: []
```
On any difference, stop and open a `needs-human-decision` issue.
- [ ] **Check the PRs.**
  - No open PR touches `data/releases/` (`gh pr list -R genomeOS/genomeOS --state open --json number,files`).
  - `gh pr checks 491 -R genomeOS/genomeOS` passes.
  - `gh pr view 491 -R genomeOS/genomeOS --json mergeable,mergeStateStatus`:
    - `MERGEABLE` `CLEAN` → merge;
    - `BLOCKED` (a required review or check is pending) → ask the owner to approve, then check again;
    - `BEHIND` → ask the owner (#491 is never rebased);
    - any other state → stop and report it.
- [ ] **Merge** (agent, §11 1.1): `gh pr merge 491 -R genomeOS/genomeOS --squash`.
- [ ] **Verify.** The subject ends `(#491)`; `gh run list -R genomeOS/genomeOS --branch main --limit 1` shows `success`; and in a fresh environment `python -m pytest tests/test_fit_input.py tests/test_build_data_release.py tests/test_data_release.py -q` passes.

---

### Task 2 (step 1.2): The private-file gate reports agent session paths

**PR:** Tasks 2–6 are one PR, `data/platform-v1-layout`, with one commit each. Branch from `main` after #491 and #502 (this spec) have merged.

**Files:** `scripts/check_private_files.py` (`PERSONAL_PATH_PATTERNS`); `tests/test_check_private_files.py`.

**Interfaces:** `personal_paths(text) -> list[tuple[int, str]]`, unchanged.

- [ ] **Test** (concatenated literals, so no tracked file holds a session path):
```python
SESSION_ROOT = "/private/tmp/" + "claude-501"
@pytest.mark.parametrize(("text", "expected"), [
    (f"x {SESSION_ROOT}/-Users-someperson-Desktop-proj/0a1b/scratchpad/x.py", f"{SESSION_ROOT}/-Users-someperson-Desktop-proj"),
    ("x /tmp/" + "claude-1000/-home-someperson-src-proj/out.txt", "/tmp/" + "claude-1000/-home-someperson-src-proj"),
    ("x ~/.claude/projects/" + "-Users-someperson-Desktop-proj/memory", ".claude/projects/" + "-Users-someperson-Desktop-proj")])
def test_an_agent_session_path_is_reported(text, expected): assert [m for _, m in personal_paths(text)] == [expected]
@pytest.mark.parametrize("text", ["MPLCONFIGDIR=/private/tmp/genomeos-cache-20260911/mpl", "/tmp/claude-<uid>/<project>/scratchpad",
                                  "OUT=$TMPDIR/claude-501/out", "under .claude/worktrees/data-platform-design"])
def test_ordinary_temp_dirs_and_placeholders_are_not_session_paths(text): assert personal_paths(text) == []
```
- [ ] **Run** `python -m pytest tests/test_check_private_files.py -q`. Expected: `3 failed`, the three session paths.
- [ ] **Implement.** Append the two patterns below, with a comment that a session folder's name is the home path with `/` written as `-`:
  - `(?<![\w.\-])/(?:private/)?tmp/claude-\d+/[^\\/\s"'`)\]]+`
  - `\.claude/projects/-(?:Users|home)-[^\\/\s"'`)\]]+`
- [ ] **Run** the same command, then `python scripts/check_private_files.py`. Expected: all pass, and `private-file check passed (<n> tracked files)`.
- [ ] **Commit:** `chore: report agent session paths in the private-file gate (step 1.2)`

---

### Task 3 (step 1.2): Copy the evidence into `docs/research/2026-10-18-atlas-data-platform/`

**Files:**
- The folder: the 25 recovered files (2 designs, 3 `merge/*.json`, 20 `wg/*/scripts/*.py`), sanitised, plus a `README.md`.
- `pyproject.toml` (`[tool.ruff] extend-exclude`).

**Interfaces:** the folder the spec's Status line and §14 cite.

- [ ] **Copy.** `cp -R "$RECOVERED"/. "$DEST"/`, where the owner names the recovered folder; never write that path into the repository. Expected: 25 files.
- [ ] **Sanitise.** Use an uncommitted script that applies these in order and prints the per-file counts in that order:
```python
SUBS = [("scratch", r"/private/tmp/claude-\d+/[^/\"\s]+/[0-9a-f-]{36}/scratchpad/", "<scratchpad>/"),
        ("bare", r"(?<![\w/<>])scratchpad/", "<scratchpad>/"),
        ("repo", r"/Users/[^/]+/Desktop/genomeOS/\.claude/worktrees/[^/]+/", "<repo>/"),
        ("worktree", r"(?<![\w/<])\.claude/worktrees/[^/\"\s]+/", "<repo>/"),
        ("web", r"https://storage\.googleapis\.com/genomeos-atlas-web/", "<web-bucket-url>/"),
        ("metric", r"`storage\.googleapis\.com/network/sent_bytes_count`", "Cloud Storage's `network/sent_bytes_count` metric")]
```
Expected, exactly (dry-run on the recovered files 2026-11-14), with the JSON still parsing:
```
merge/structure-workflow-results.json {'scratch': 5, 'worktree': 2, 'web': 2}
merge/tiers-workflow-results.json {'scratch': 2}
merge/whole-genome-workflow-results.json {'scratch': 30, 'bare': 14, 'repo': 3, 'metric': 1}
```
The two `worktree` hits are relative paths (`on .claude/worktrees/hbs-parity-input/data/store/artifacts`), which `repo` does not match.
- [ ] **README.**
  - What it is: verbatim apart from the substitutions.
  - Contents mapped to spec sections: the 35 + 56 fact-checks are Appendix A's 91, and `research: sources` is §9's research note.
  - The six substitutions, by name and replacement.
  - What is not included:
    - by design (§14): `dl/` and the sample lists;
    - missing: `wg/decisions/`, the `out/` outputs and `rserve.py`, so it cannot recompute (F8).
  - Tool versions: DuckDB 1.5.5, pyarrow 25.0.1, h3 4.5.0, bcftools 1.21.
- [ ] **Lint.** Add `extend-exclude = ["docs/research/2026-10-18-atlas-data-platform"]`; without it there are 119 ruff errors.
- [ ] **Gates.**
  - `python scripts/check_private_files.py`, `python -m pytest tests/test_web_layout.py::test_no_concrete_bucket_url_is_tracked -q` and `.venv/bin/ruff check .` pass.
  - `git grep -nIE "gserviceaccount|billingAccounts/|/tmp/claude-[0-9]|\.claude/(projects|worktrees)/|[^<]scratchpad/" -- "$DEST"` prints nothing, and neither does a grep for the project id (given on the command line).
  - The only e-mails left are Google's `bq-public-data@`, `gcp-public-data@` and `public-data-help@`.
- [ ] **Commit:** `docs: copy the Atlas data-platform design's evidence (step 1.2)`

---

### Task 4 (step 1.2): The contract registry, with both allele contracts frozen

**Files:**
- Create `genomeos/tables/{__init__,contracts}.py` (cites §2.4, §2.5, calls 30, 37).
- `scripts/freeze_contract.py` renders every `TABLE_CONTRACTS` entry; `--check` fails on a stray file in `contract/tables/`.
- Generate `contract/tables/measured.allele_observations{,_binned}.v1.schema.json`.
- Test: `tests/test_table_contracts.py` (new) and `tests/test_contract_frozen.py`.

**Interfaces** (every later table registers here):
- `class TableError(ValueError)`.
- `LOCUS_VARIANT_ID_PATTERN = r"^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y)-\d+-[ACGT]+-[ACGT]+$"`: D18's chromosome set; there is no chrM file (§1.2 item 1, §2.6).
- `@dataclass(frozen=True) class TableContract(table: str, major: int, minor: int, key: tuple[str, ...], partitions: tuple[str, ...], schema: pandera.DataFrameSchema | None = None, arrow_schema: pyarrow.Schema | None = None)`: exactly one schema; `.schema_version -> str` (`"1.0"`); `.path -> str`.
- `ALLELE_OBSERVATIONS`, `ALLELE_OBSERVATIONS_BINNED`, `BINNED_OBSERVATIONS_SCHEMA`, `TABLE_CONTRACTS: Mapping[str, TableContract]`.
- `render(table: str) -> str`, `contract_sha256(table: str) -> str`, `columns(table: str) -> tuple[str, ...]`, `table_of(path: str) -> str`.
- `table_path(table: str) -> str`: `tables/v1/<schema>/<name>/` for a contract with partitions, `tables/v1/<schema>/<name>.parquet` without; a table with no contract raises `TableError` naming "contract".

- [ ] **Test:**
```python
def test_the_curated_allele_table_stores_the_17_observation_columns():
    c = TABLE_CONTRACTS["measured.allele_observations"]
    assert set(c.schema.columns) == set(OBSERVATIONS_SCHEMA.columns) and len(c.schema.columns) == 17
    assert (c.key, c.partitions, c.path) == (("ingest_version", "source_record_id"), ("source", "ingest_version"),
                                             "contract/tables/measured.allele_observations.v1.schema.json")
def test_the_binned_table_stores_16_contract_columns_plus_pos_and_source_label():
    c = TABLE_CONTRACTS["measured.allele_observations_binned"]
    assert set(c.schema.columns) == (set(OBSERVATIONS_SCHEMA.columns) - {"source_record_id"}) | {"pos", "source_label"}
    assert (c.key, c.partitions) == (("ingest_version", "variant_id", "population_id"), ("source", "ingest_version", "chrom", "bin"))
def test_table_paths_and_names_round_trip():
    assert table_of("tables/v1/measured/allele_observations/source=afnd/ingest_version=afnd-2026-08/part-0.parquet") == "measured.allele_observations"
    assert table_path("measured.allele_observations_binned") == "tables/v1/measured/allele_observations_binned/"
    with pytest.raises(TableError, match="contract"): table_path("meta.nothing")
# _binned(n=2): observation_rows(n) without source_record_id, with pos = 5227002 and source_label = "YRI"
@pytest.mark.parametrize(("edit", "message"), [
    (lambda f: f.assign(source_record_id="x"), "column 'source_record_id' not in DataFrameSchema"),
    (lambda f: f.assign(af=0.1), "column 'af' not in DataFrameSchema"),
    (lambda f: f.assign(variant_id="hla:a*02:01"), "str_matches"),
    (lambda f: f.assign(variant_id="phenotype:g6pd-deficiency"), "str_matches"),
    (lambda f: f.assign(variant_id="chrM-73-A-G", pos=73), "str_matches"),
    (lambda f: f.assign(pos=5227003), "pos must be the position in variant_id"),
    (lambda f: pd.concat([f.iloc[:1], f.iloc[:1]]), "not unique"),
    (lambda f: f.assign(ac=0, an=0), "greater_than"),
    (lambda f: f.assign(ac=f["an"] + 1), "ac must not exceed an"),
    (lambda f: f.drop(columns="radius_km"), "column 'radius_km' not in dataframe"),
    (lambda f: f.drop(columns="sampling_design"), "column 'sampling_design' not in dataframe")])
def test_a_binned_row_the_contract_refuses_is_a_hard_error(edit, message):
    with pytest.raises(pandera.errors.SchemaError, match=message): BINNED_OBSERVATIONS_SCHEMA.validate(edit(_binned()))
```
  - `test_no_measured_table_has_a_frequency_column`: for every `measured.*` contract, no column is `af` or contains `freq`.
  - `test_each_frozen_file_is_its_rendered_contract`: `(ROOT / c.path).read_text() == render(t)` for every entry.
  - `test_the_fit_input_contracts_are_untouched`: the sha256 of `contract/observations.schema.json` and `contract/carrier_observations.schema.json` is in `artifact_inputs.CONTRACT_REVISIONS[path]`.
  - `test_the_table_contracts_are_exactly_the_registered_ones`: `sorted(p.name for p in (ROOT / "contract/tables").iterdir()) == sorted(Path(c.path).name for c in TABLE_CONTRACTS.values())`.
- [ ] **Run** `python -m pytest tests/test_table_contracts.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.tables'`.
- [ ] **Implement.**
  - The curated table copies `OBSERVATIONS_SCHEMA`.
  - The binned table drops `source_record_id`, puts `variant_id` on the locus pattern, and adds:
    - `pos: Column("Int64", Check.ge(1))` and `source_label: Column(str, REVIEWABLE_TEXT)`;
    - the checks `ac_le_an`, `date_lower_le_upper` and `pos_matches_variant_id`, the last registered `vectorized` so `to_json` keeps it;
    - `unique=["ingest_version", "variant_id", "population_id"]`.
  - `render` is `json.dumps({"contract": "genomeos-table", "table", "schema_version", "key", "partitions", "pandera"|"arrow"}, indent=2, sort_keys=True) + "\n"`.
- [ ] **Freeze and run.** `python scripts/freeze_contract.py` prints `wrote 14 schemas` (12 + 2), and only `contract/tables/` is new. `python -m pytest tests/test_table_contracts.py tests/test_contract_frozen.py tests/test_fit_input.py -q` passes, and `--check` prints `contract up to date`.
- [ ] **Commit:** `feat(data): freeze the v1 contracts of the curated and binned allele tables (step 1.2)`

---

### Task 5 (step 1.2): `=` segments, catalog media types and optional roots

**Files:** `data_release.py` (`_SEGMENT`, `MEDIA_TYPES`); `build_data_release.py` (`INCLUDE`, `OPTIONAL_ROOTS`, `included_files`, `collect`, `build`); `tests/test_data_release.py`; `tests/test_build_data_release.py`.

**Interfaces:**
- `dr._SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._=-]*")`.
- `.sql` → `application/sql`; `.duckdb` → `application/octet-stream`.
- `INCLUDE` adds `catalog` and `tables`; `OPTIONAL_ROOTS: tuple[str, ...] = ("catalog", "tables")`. Every optional root is also in `INCLUDE`.
- `included_files(data_root: Path, *, published: Collection[str] = ()) -> list[str]` and `collect(data_root: Path, tracked: set[str], *, published: Collection[str] = ()) -> list[dr.FileRecord]`.

- [ ] **Test.**
  - `test_hive_partition_folders_are_data_paths`: `…/chrom=chr11/bin=5/part-0.parquet`, `…/epoch=2026-10-18/res=4/h3_r0=8001fffffffffff/…` and `tables/v1/reference/populations/2026-10-18-0a1b2c3d/populations.parquet` all pass `assert_data_path`.
  - `test_a_segment_may_not_start_with_equals_or_carry_percent_plus_or_colon`: `=chr11`, `%3A`, `a+b` and `a:b` each raise "path".
  - `test_catalog_files_have_deliberate_media_types`: `media_type_for("catalog/catalog.sql") == "application/sql"` and `media_type_for("catalog/atlas.duckdb") == "application/octet-stream"`.
  - `test_optional_roots_may_be_absent_until_a_release_publishes_under_them`: a tree without `data/tables` builds.
  - `test_an_optional_root_is_required_once_a_release_published_under_it`: with `published={"tables/v1/meta/served.parquet"}` → "include root data/tables is missing".
  - `test_an_optional_root_file_needs_a_reviewed_source_rule`: `data/catalog/x.txt` → "no reviewed source rule".
- [ ] **Run** `python -m pytest tests/test_data_release.py tests/test_build_data_release.py -q`. Expected: exactly the six new tests fail.
- [ ] **Implement.** An absent optional root is skipped only while nothing under it was published.
- [ ] **Run** the same files plus `tests/test_fetch_data.py tests/test_publish_data_store.py`. Expected: PASS.
- [ ] **Commit:** `feat(data): accept the v1 table layout in the data store (step 1.2)`

---

### Task 6 (step 1.2): An empty, validated `data/releases/WITHDRAWN.json` that every reader skips

**Files:**
- Create `data/releases/WITHDRAWN.json`.
- Modify:
  - `data_release.py`;
  - `fetch_data.py` (`newest_release`, `released_artifact_dirs`);
  - `publish_data_store.py` (`_newest_manifest`);
  - `build_data_release.py` (`earlier_releases`);
  - one Layout line in `docs/data-store.md`.
- Test: `tests/test_data_release.py`, `test_fetch_data.py`, `test_publish_data_store.py` and `test_build_data_release.py`. The two tests that globbed now use `release_ids`.

**Interfaces:**
- `WITHDRAWN_FILE = "WITHDRAWN.json"`, `WITHDRAWN_SCHEMA = "genomeos-withdrawn"`, `WITHDRAWN_SCHEMA_VERSION = 1`.
- `@dataclass(frozen=True) class Withdrawal(key: str, sha256: str, reason: str, issue: str, date: str, decided_by: str)`.
- `validate_withdrawn(document: object) -> tuple[Withdrawal, ...]`:
  - the header and fields are closed;
  - `key` is `releases/<R>/<path>`;
  - `sha256` is 64 lowercase hex characters;
  - `reason` and `decided_by` are non-blank;
  - `issue` is an `https://` URL;
  - `date` is `YYYY-MM-DD`;
  - entries are sorted and unique.
- `release_ids(file_names: Iterable[str]) -> list[str]`: oldest first, skips `WITHDRAWN.json`, and raises "neither" on any other name.
- `_newest_manifest(releases: Path = RELEASES) -> Path`.

- [ ] **Test** (`EMPTY = {"schema": "genomeos-withdrawn", "schema_version": 1, "withdrawn": []}`).
  - `test_withdrawals_validate`: one valid entry round-trips to a `Withdrawal`.
  - `test_a_malformed_withdrawal_is_a_hard_error`, parametrized over a key outside `releases/`, `"A"*64`, a blank reason, an `http://` issue, `14 Nov 2026` and an empty decider; each raises naming the field.
  - `test_withdrawal_fields_and_header_are_closed_sorted_and_unique`: an extra field → "field"; a repeated entry → "twice"; two entries out of order → "sorted".
  - `test_release_ids_skip_the_withdrawn_list_and_refuse_strays`: `["2026-10-18.json", "WITHDRAWN.json", "2026-10-17.1.json", "2026-10-17.json"]` → `["2026-10-17", "2026-10-17.1", "2026-10-18"]`; `latest.json`, `withdrawn.json` and `2026-10-18 .json` raise "neither".
  - `test_the_committed_withdrawn_list_is_empty_and_canonical`: the file's bytes are `canonical_bytes(EMPTY)`.
  - `test_earlier_releases_skip_the_withdrawn_list`, `test_the_withdrawn_list_beside_the_manifests_is_not_a_release` (fetch) and `test_the_newest_manifest_is_never_the_withdrawn_list` (publish): each over a releases dir holding `WITHDRAWN.json`.
- [ ] **Run** the four test files. Expected: `AttributeError: … has no attribute 'release_ids'` and `FileNotFoundError: … WITHDRAWN.json`.
- [ ] **Implement.**
  - Route the four readers through `release_ids`.
  - Write `canonical_bytes(EMPTY)`.
  - Add the Layout line `releases/WITHDRAWN.json   committed: keys withdrawn from serving, for the owner to delete (starts empty)`.
- [ ] **Run** the four test files, then `python scripts/fetch_data.py --list | tail -1`. Expected: PASS, and `release 2026-10-18: …`.
- [ ] **Commit:** `feat(data): add an empty, validated WITHDRAWN.json beside the release manifests (step 1.2)`

---

### Task 7 (step 1.2): Record the §1.2 decisions, ask step 1.8's scope, and open the PR

**Files:** none. **Interfaces:** issue `N`.

- [ ] **Open the issue:** `gh issue create -R genomeOS/genomeOS --title "Owner decisions D1c, D18, D16 and D17 for the Atlas data platform (approved 2026-11-14), and step 1.8's scope" --label needs-human-decision --label type:governance --label P1:observations --label skill:governance --label priority:high`. The body has two parts.
  - **Part A, the record:**
    - the four §1.2 questions were approved as recommended on 2026-11-14, and §1.2 binds;
    - D1c gates 2.1 and 2.8, D18 2.6 and 2.8, D16 2.5 and 2.8, and D17 2.8;
    - the §1.3 decisions stay open, each on its trigger.
  - **Part B, one question before step 1.8 (#472):**
    - `data/raw/gnomad_hgdp_1kg_freqs.tsv` is on no mirror, and no record gives its upstream URL or retrieval date. Recommended: leave it out of 1.8, since call 36 keeps it as the fixture-backed route and published whole-genome rows come only from the D18 recount (2.8). Otherwise, supply the file and its upstream, and Task 16 adds it as a `raw/gnomad_hgdp_1kg/<version>/` harvest whose columns may not include `spliceai`.
    - The AFND page caches (`afnd_cache/` and `afnd_freq_cache/`, 35.7 MB and 178.6 MB in `store/INVENTORY.json`), which #472 leaves open. Recommended: not in phase 1, since `afnd_frequencies.tsv` is their derived table.
    - The WorldPop res-4 grid parquet is not a question: it becomes `reference.grid_cells` in step 3.6 (§11).
  - It ends: "**Owner:** please confirm part A matches what you approved and answer part B, then close the issue as completed. Without an answer, step 1.8 publishes everything else and nothing in part B."
- [ ] **Open the PR** `data: freeze the v1 table layout and copy the data-platform evidence (step 1.2)`. Its body holds one bullet per task, `Records the §1.2 approvals: #N`, Task 3's gate output and the attribution.
- [ ] **Watch CI.** `gh pr checks <n> -R genomeOS/genomeOS --watch`: `changes`, `tracked-files` and `test` pass.

---

### Task 8 (step 1.3): Close the terms vocabulary

**Files:** `data_release.py` (`_validate_source`, `build_manifest`; cites §9); `docs/data-store.md`; `tests/test_data_release.py`, `tests/test_build_data_release.py`. Branch: `data/terms-vocabulary`.

**Interfaces:**
- `dr.LEGACY_TERMS_STATUSES: Mapping[str, str] = {"restriction_found": "restricted"}`.
- `dr.terms_status(value: object, *, where: str) -> str`.
- New manifests write the normalised status, and step 2.1's `CHARGEABLE` reads it.

- [ ] **Test.**
  - `test_every_finding_is_accepted_and_the_legacy_one_reads_as_restricted`: each of the five `COMMERCIAL_USE_FINDINGS` returns itself; `"restriction_found"` returns `"restricted"`.
  - `test_an_unknown_terms_status_is_a_hard_error`: `"open"`, `"Restricted"`, `"restricted "`, `"cc-by-4.0"`, `"unknown"`, `3` and `None` each raise "status".
  - `test_a_new_manifest_writes_restricted_and_keeps_non_commercial`: GeneReviews' `(terms.status, non_commercial)` in a built manifest is `("restricted", True)`.
  - `test_the_released_manifests_keep_their_legacy_status_and_validate`: both committed manifests validate unchanged.
- [ ] **Run** `python -m pytest tests/test_data_release.py tests/test_build_data_release.py -q`. Expected: `AttributeError: … 'terms_status'` and "DID NOT RAISE".
- [ ] **Implement.** Add the doc sentence: "A source's `terms.status` is one of the five findings in `docs/non-commercial-data.md`; manifests written before step 1.3 may carry `restriction_found`, which reads as `restricted`."
- [ ] **Run** the same command. Expected: PASS.
- [ ] **Commit:** `fix(data): close the terms vocabulary; restriction_found reads as restricted (step 1.3)`

---

### Task 9 (step 1.3, D5a evidence PR): Project data is CC BY 4.0

**Files:** `README.md` (`## License`); `REVIEWED_SOURCES["genomeos"]["terms"]`; `tests/test_build_data_release.py`. Runs in parallel with Task 10.

**Interfaces:** the terms are:
- `{"status": "explicitly_open", "checked_at": "2026-10-19", "terms_url": "https://creativecommons.org/licenses/by/4.0/", "licence": "CC-BY-4.0", "recorded_in": "README.md"}`;
- plus the note "Project-authored data and outputs are CC BY 4.0 by the owner's decision D5a (2026-10-19; docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md §1.1). Apache-2.0 covers source code and documentation."

- [ ] **Test.** `test_project_data_is_recorded_as_cc_by_4` checks those five values and `"[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)"` in `README.md`. Run `python -m pytest tests/test_build_data_release.py -k cc_by -q`: `'not_checked' != 'explicitly_open'`.
- [ ] **Implement.** Add after the Apache sentence: "Data the project makes (every object a data-store release lists with the source `genomeos`) is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (owner decision D5a, 2026-10-19; [design §1.1](docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md))." Run the same command: PASS.
- [ ] **Commit:** `data: record project data as CC BY 4.0 (D5a, step 1.3)`

---

### Task 10 (step 1.3, D5b evidence PR): WorldPop is `explicitly_open`

**Files:** `docs/audits/worldpop-commercial-use.md` (new, modelled on `gnomad-dbsnp-commercial-use.md`); `REVIEWED_SOURCES["worldpop"]["terms"]`; `tests/test_build_data_release.py`, which drops its `worldpop … NOT_CHECKED` line.

**Interfaces:** `{"status": "explicitly_open", "checked_at": <date read>, "terms_url": "https://hub.worldpop.org/", "licence": "CC-BY-4.0", "recorded_in": "docs/audits/worldpop-commercial-use.md", "note": <D5b>}`, covering 62 objects.

- [ ] **Read the terms.** Read https://hub.worldpop.org/ and the page behind https://doi.org/10.5258/SOTON/WP00647. Quote them with the date. If either page no longer states CC BY 4.0, open a `needs-human-decision` issue and stop.
- [ ] **Test.** `test_worldpop_is_recorded_as_explicitly_open_from_its_hub` checks the four values, and that the audit contains `checked_at`, `"CC BY 4.0"` and the hub URL. Run `python -m pytest tests/test_build_data_release.py -k worldpop -q`: FAIL.
- [ ] **Implement.** The audit holds a TL;DR, the pages, the quotes, the finding, the attribution and D5b. Run the same command and `python scripts/check_private_files.py`: PASS.
- [ ] **Commit:** `data: record WorldPop as explicitly open from its hub's CC BY 4.0 statement (D5b, step 1.3)`

---

### Task 11 (step 1.4): Pinned writer, provenance and the `meta` tables

**Files:**
- `pyproject.toml`: `atlas` takes `duckdb==1.5.5`; `read` takes `duckdb>=1.2`.
- New: `genomeos/tables/{writer,provenance,meta}.py` (cite §2.4–§2.9; calls 4, 7, 15, 16) and `scripts/build_tables.py`.
- `contracts.py`: the 4 `meta.*` contracts.
- `_RULES`: `tables/` → `provenance.recorded_sources`.
- The spec: §2.7 check 9 and §9's sources sentence (one docs commit).
- Tests (new): `tests/tables_fixtures.py`, `tests/test_tables_{writer,provenance,meta}.py`, `tests/test_build_tables.py`. Also extends `tests/test_build_data_release.py`.

**Interfaces:**
- `writer`:
  - `DUCKDB_VERSION = "1.5.5"`, `STORAGE_VERSION = "v1.2.0"`, `ROW_GROUP_ROWS = 8192`, `MAX_FILE_BYTES = 150 * 1024 * 1024`
  - `connect() -> duckdb.DuckDBPyConnection`
  - `write_parquet(con: duckdb.DuckDBPyConnection, select_sql: str, out: Path, *, table: str, git_sha: str, inputs: Sequence[InputRef], sources: Sequence[str], order_by: Sequence[str], row_group_rows: int = ROW_GROUP_ROWS) -> Path`
  - `write_frame(con, frame: pd.DataFrame, out: Path, *, table: str, git_sha: str, inputs: Sequence[InputRef], sources: Sequence[str], order_by: Sequence[str]) -> Path`
  - `check_table_file(path: Path, table: str) -> None` (check 1)
  - `check_partitions(con, path: Path, relative: str) -> None` (check 2): each `key=value` segment equals the file's column of that name, which must exist ("partition key <k> is not a column"); only `chrom` and `bin` are derived, from `variant_id` and `pos // 1_000_000`.
- `provenance`:
  - `@dataclass(frozen=True, order=True) class InputRef(key: str, sha256: str)`; `key` ∈ `releases/<R>/<path>` | `manifests/<R>.json` | `git:<path>`
  - `GIT_INPUT_SOURCES: Mapping[str, tuple[str, ...]] = {"website/public/data/atlas/catalog.json": ("genomeos",), "data/releases/WITHDRAWN.json": ("genomeos",)}`
  - `encode_inputs(refs: Iterable[InputRef]) -> str`, `decode_inputs(text: str) -> tuple[InputRef, ...]`, `read_kv(path: Path) -> dict[str, str]`
  - `recorded_sources(data_root: Path, path: str) -> tuple[str, ...]`: a `tables/` file's `genomeos.sources` (a `_RULES` callable)
  - `sources_of(ref: InputRef, *, manifests: Mapping[str, Mapping[str, Any]], new_sources: Mapping[str, tuple[str, ...]]) -> tuple[str, ...]`: a released key → the sources its publishing manifest records (or `new_sources[path]` for this release's keys); a manifest → the union of its objects' sources; `git:<path>` → `GIT_INPUT_SOURCES[path]`, else `TableError` "no reviewed sources for git:<path>"
  - `union_sources(refs: Iterable[InputRef], *, manifests, new_sources) -> tuple[str, ...]`, sorted and unique
- `meta`:
  - `release_objects_frame(manifests: Sequence[Mapping[str, Any]]) -> pd.DataFrame` and `sources_frame(manifests: Sequence[Mapping[str, Any]]) -> pd.DataFrame`
  - `served_frame(web_catalog: Mapping[str, Any], *, released_artifacts: Mapping[str, str]) -> pd.DataFrame` and `served_inputs(web_catalog: Mapping[str, Any], catalog_sha256: str, *, published: Mapping[str, dr.ReleaseObject]) -> tuple[InputRef, ...]` (the git catalog plus each served artifact's `manifest.json` key)
  - `withdrawn_frame(entries: Sequence[dr.Withdrawal], *, published: Mapping[str, dr.ReleaseObject]) -> pd.DataFrame`
  - `artifact_directory_name(variant_id: str, model_version: str, data_version: str) -> str`: `:` → `__`, then `__model__data`
- `build_tables`:
  - `@dataclass(frozen=True) class BuildContext(data_root: Path, out_root: Path, release: str, git_sha: str, manifests: tuple[Mapping[str, Any], ...], published: Mapping[str, dr.ReleaseObject], repo_root: Path)`, `STAGES = ("meta", "reference", "measured", "fit_inputs", "inferred")`, `build_meta(ctx: BuildContext) -> dict[str, int]`
  - `main(argv: Sequence[str] | None = None) -> int`, with `--release`, `--data`, `--git-sha` (default `HEAD`) and repeatable `--stage`; hidden `--releases`, `--web-catalog`, `--withdrawn`
- `tests/tables_fixtures.py`: `GIT_SHA = "0" * 40`; `LAGOS_R4 = "84589c9ffffffff"`, `LONDON_R4 = "84194adffffffff"`, `LAGOS_R3 = "83589cfffffffff"`, `LONDON_R3 = "83194afffffffff"`, `R0_LAGOS = "8059fffffffffff"`, `R0_LONDON = "8019fffffffffff"`.

**Tables** (strict, ordered; `?` = nullable):
- `meta.release_objects`: release, path, key, bytes, sha256, media_type, in_git, sources list. Unique on (release, path).
- `meta.sources`: release, source, name, citation?, url?, terms_status, terms_checked_at?, terms_url?, licence?, recorded_in?, note?, non_commercial. Unique on (release, source).
  - Both read `manifests/<R0>.json` of each earlier release.
- `meta.served`: artifact, variant_id, model_version, data_version, pinned_by, pinned_sha256. Reads `git:website/public/data/atlas/catalog.json` and the served artifacts' manifests.
- `meta.withdrawn`: key, path, sha256, reason, issue, date, decided_by. Reads `git:data/releases/WITHDRAWN.json` and the keys it lists.

- [ ] **Pin and reinstall.**
  - Run `uv pip compile pyproject.toml --universal --extra dev --extra atlas --extra surfaces --extra geo --extra figures --python-version 3.12 --output-file requirements.lock`, the lock header's own command, without `--upgrade`. The lock already pins `duckdb==1.5.5`; this only proves the narrowed bound resolves to it, so AGENTS.md's `--upgrade` (for widened bounds) does not apply.
  - Expected: `git diff --stat requirements.lock` prints nothing.
  - Reinstall with `uv pip install -r requirements.lock && python -m pip install -e . --no-deps`; `python -c "import duckdb; print(duckdb.__version__)"` prints `1.5.5`.
- [ ] **Test:**
```python
def test_write_parquet_stamps_provenance_zstd_8192_row_groups_and_is_deterministic(tmp_path):
    # 20,000 meta.served rows written twice (a, b) with one git: input
    assert sha256(a) == sha256(b)
    kv = provenance.read_kv(a)
    assert (kv["genomeos.table"], kv["genomeos.schema_version"], kv["genomeos.git_sha"]) == ("meta.served", "1.0", GIT_SHA)
    assert kv["genomeos.contract_sha256"] == contracts.contract_sha256("meta.served") and json.loads(kv["genomeos.sources"]) == ["genomeos"]
    assert [md.row_group(i).num_rows for i in range(md.num_row_groups)] == [8192, 8192, 3616] and md.row_group(0).column(0).compression == "ZSTD"
def test_inputs_encode_canonically_and_round_trip():
    refs = [InputRef("releases/2026-10-18/x.parquet", "b" * 64), InputRef("manifests/2026-10-17.json", "a" * 64)]
    text = provenance.encode_inputs(refs)
    assert text == f'[{{"key":"manifests/2026-10-17.json","sha256":"{"a"*64}"}},{{"key":"releases/2026-10-18/x.parquet","sha256":"{"b"*64}"}}]'
    assert provenance.decode_inputs(text) == tuple(sorted(refs))
```
  - `tests/test_tables_writer.py`:
    - `test_connect_refuses_another_duckdb`: `monkeypatch.setattr(duckdb, "__version__", "1.5.6")` → `TableError` matching "1.5.5".
    - `test_connect_uses_one_thread`: `con.execute("SELECT current_setting('threads')").fetchone() == (1,)`.
    - `test_an_oversize_file_is_refused`: `monkeypatch.setattr(writer, "MAX_FILE_BYTES", 10)` → "MiB", and neither `out` nor `out.partial` exists.
    - `test_a_table_with_no_contract_is_refused`: `table="meta.nothing"` → "contract".
    - `test_a_bad_git_sha_or_a_quote_in_metadata_is_refused`: `git_sha="abc"` → "git_sha"; `sources=["it's"]` → "quote".
    - `test_check_table_file_refuses_columns_other_than_its_contract`: a `meta.served` file with an extra column → "contract".
    - `test_a_partition_value_differing_from_the_file_is_refused`: a `measured.allele_observations` part written at `…/source=map/ingest_version=afnd-2026-08/part-0.parquet` with in-file `source` `afnd` → "source".
    - `test_a_partition_key_missing_from_the_file_is_refused`: the same part without its `ingest_version` column → "partition key ingest_version is not a column".
    - `test_check_partitions_derives_chrom_and_bin_for_the_binned_table`: a row at `chr11-5227002-T-A`, pos 5227002, passes under `chrom=chr11/bin=5/` and fails under `bin=4/` ("bin").
  - `tests/test_tables_provenance.py`:
    - `test_an_input_ref_outside_the_three_forms_is_refused`: `gs://b/x`, `releases/x/y`, `manifests/latest.json`, `git:/abs` and `""` each raise "input".
    - `test_a_manifest_ref_carries_every_source_of_its_manifest`: `manifests/2026-10-18.json` → `("afnd", "clinvar", "cpic", "genereviews", "genomeos", "map", "worldpop")`.
    - `test_a_released_key_carries_the_sources_its_manifest_records`: `releases/2026-10-17/raw/afnd_populations.tsv` → `("afnd",)`.
    - `test_a_git_ref_takes_its_reviewed_sources_and_an_unlisted_one_is_refused`: `git:website/public/data/atlas/catalog.json` → `("genomeos",)`; `git:README.md` → "no reviewed sources".
    - `test_a_non_commercial_source_survives_the_union` (call 16): the union over a GeneReviews-linked key and a `git:` ref includes `"genereviews"`.
  - `tests/test_tables_meta.py`, over the committed manifests and web catalog:
    - `test_release_objects_lists_every_earlier_object_under_its_first_key`: 245 + 248 rows; the row `(2026-10-18, raw/afnd_populations.tsv)` has key `releases/2026-10-17/raw/afnd_populations.tsv` and sources `["afnd"]`.
    - `test_sources_lists_each_release_source`: 14 rows; GeneReviews has `non_commercial` true.
    - `test_served_is_the_web_catalogs_30`: 30 rows, including `phenotype:g6pd-deficiency`.
    - `test_withdrawn_is_empty_for_the_committed_list`: 0 rows.
    - `test_artifact_directory_name`: `("kir:2dl1", "v3", "afnd-2026-08")` → `"kir__2dl1__v3__afnd-2026-08"`.
  - `tests/test_build_tables.py`:
    - `test_build_meta_writes_four_byte_identical_files`: stdout has `meta.release_objects: 493 rows`, and a rerun leaves all four files byte-identical.
    - `test_a_release_already_committed_is_refused`: `--release 2026-10-18` exits 1.
  - `tests/test_build_data_release.py`:
    - `test_meta_files_carry_their_inputs_sources`: `served.parquet` → `["afnd", "genomeos", "map", "worldpop"]`; `release_objects.parquet` and `sources.parquet` include `"genereviews"` (call 16); `withdrawn.parquet` → `["genomeos"]`.
    - `test_an_unstamped_tables_file_is_refused`: a `tables/` file without `genomeos.sources` → "genomeos.sources".
- [ ] **Run** `python -m pytest tests/test_tables_writer.py tests/test_tables_provenance.py tests/test_tables_meta.py tests/test_build_tables.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.tables.writer'`.
- [ ] **Implement:**
  - `connect` checks the version, then sets `threads = 1`, `auto*_known_extensions = false` and `preserve_insertion_order = true`.
  - `write_parquet` validates `git_sha` (40 lowercase hex) and refuses `'` in KV values. It runs `COPY (<sql> ORDER BY …) TO '<out>.partial' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE n, KV_METADATA {…})`, refuses an oversize file, then `os.replace`s.
  - A file's sources are `union_sources(inputs)`.
  - `build_meta` prints `<table>: <n> rows`.
  - `main` exits 1 on `TableError`, `DataReleaseError` or `OSError`.
  - Freeze 4 contracts: `wrote 18 schemas`.
- [ ] **Run** the same command plus `tests/test_build_data_release.py`. Expected: PASS. Then `python scripts/build_tables.py --release 2026-11-20 --data "$SCRATCH/data"` → `meta.release_objects: 493 rows`, `meta.sources: 14 rows`, `meta.served: 30 rows`, `meta.withdrawn: 0 rows`.
- [ ] **Commit:** `feat(tables): pin DuckDB 1.5.5 and build the meta tables (data platform §2.4, step 1.4)`
- [ ] **Amend the spec.** In §2.7, check 9 becomes: "(9) Every recorded input sha256 is a manifest key in this or an earlier release, a committed `manifests/<R>.json`, a `git:<path>` whose sha256 is that file at the stamped `genomeos.git_sha`, or a cited upstream URL with md5 and generation (D17)." In §9, "so `catalog/` and `meta/` carry every source" becomes "so `catalog/`, `meta.release_objects` and `meta.sources` carry every source". Commit: `docs: amend design §2.7 check 9 and §9 for committed inputs (step 1.4)`.

---

### Task 12 (step 1.5): `inferred.artifacts`, the first `cells_by_cell` epoch, write-once parts

**Files:**
- New: `genomeos/tables/{inferred,write_once}.py` (cite §2.4, §2.7, §2.8; calls 6, 8, 22). `inferred` does not import `genomeos.surfaces`.
- Also touches `contracts.py`, the `inferred` stage and `dr.build_manifest`.
- Tests: `tests/test_tables_inferred.py` (new), `tests/test_build_tables.py`, `tests/test_data_release.py`.

**Interfaces:**
- Consumes: Task 11's `writer.*`, `provenance.InputRef`, `BuildContext`; Task 6's `dr.release_ids`.
- `inferred`:
  - `CELLS_COLUMNS = ("h3_index", "variant_id", "post_median", "post_mean", "post_sd", "q025", "q975", "q25", "q75", "support", "posterior_contraction", "dist_nearest_obs_km", "model_version", "data_version")`: the 14 columns of a format-1 or format-2 `cells.parquet`, as a literal.
  - `CELLS_BY_CELL_COLUMNS = CELLS_COLUMNS + ("h3_r0", "h3_parent_r3", "measurement", "artifact_format", "epoch", "res")`
  - `READABLE_FORMATS = frozenset({1, 2})`
  - `EPOCH_ROOT = "tables/v1/inferred/cells_by_cell"`
  - `REVIEWED_MEASUREMENTS: Mapping[str, tuple[str, str]]`: `chr11-5227002-T-A__v1__map-2026-08` and `phenotype__g6pd-deficiency__v1__map-2026-08` both map to `"allele_frequency"`. Each reason says the format-1 manifest predates the field and cites the v3 manifest.
  - `@dataclass(frozen=True) class ArtifactRecord(artifact, manifest, cells_path, cells_key, cells_sha256, manifest_key, manifest_sha256, observations_key, observations_sha256, first_release)`
  - `measurement_of(artifact: str, manifest: Mapping[str, Any]) -> tuple[str, str]`, returning (value, `manifest` | `reviewed_table`)
  - `fit_input_evidence(artifact: str, *, has_input: bool, released_without_input: Mapping[str, str], web_json_matches: frozenset[str] = frozenset(), web_json_refused: Mapping[str, str] | None = None) -> tuple[str, str | None]`
  - `artifacts_frame(records: Sequence[ArtifactRecord], *, epochs: Mapping[str, str], evidence: Mapping[str, tuple[str, str | None]]) -> pd.DataFrame`
  - `new_epoch_artifacts(artifacts: Sequence[str], earlier: Mapping[str, str]) -> tuple[str, ...]`
  - `write_epoch(con, records: Sequence[ArtifactRecord], *, epoch: str, out_root: Path, git_sha: str) -> tuple[str, ...]`
  - `cells_checksum(con, source_sql: str) -> tuple[int, int]` and `check_cells_equal(con, records: Sequence[ArtifactRecord], parts: Sequence[Path]) -> None` (check 6)
- `write_once`:
  - `published_paths(manifests: Sequence[Mapping[str, Any]]) -> dict[str, dr.ReleaseObject]` (path → its first publication)
  - `require_published_local(data_root: Path, path: str, sha256: str) -> Path`. It raises "… fetch it first: python scripts/fetch_data.py --prefix tables/".
- `dr.PARTITION_KEYS = ("epoch", "ingest_version", "chrom", "bin")` and `dr.is_write_once(path: str) -> bool`.
- `build_inferred(ctx: BuildContext, *, web_json_matches: frozenset[str] = frozenset(), web_json_refused: Mapping[str, str] | None = None) -> dict[str, int]`.
- Fixture `fixture_tree` (in `tests/tables_fixtures.py`), release 2026-10-17:
  - HbS v1: format 1, res 3, unmarked; cells `LAGOS_R3`, `LONDON_R3`.
  - HbS v3: format 2, res 4; cells `LAGOS_R4`, `LONDON_R4`.
  - `kir__2dl1__v3__afnd-2026-08`: format 2, res 4, carrier; cells `LAGOS_R4`, `LONDON_R4`.
- `inferred.artifacts` carries:
  - the manifest fields, `measurement` and `measurement_from`;
  - `support_counts`, `first_release` and `epoch`;
  - the key and sha256 of the cells, manifest and observations;
  - `fit_input_evidence`, with a reason exactly when it is `none`.
- Parts: `EPOCH_ROOT/epoch=<R>/res=<k>/h3_r0=<cell>/part-0.parquet`, sorted by `h3_index, variant_id, model_version, data_version`.

- [ ] **Test** (`tests/test_tables_inferred.py`):
```python
PARTS = tuple(f"tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res={k}/h3_r0={r0}/part-0.parquet"
              for k, r0 in ((3, R0_LONDON), (3, R0_LAGOS), (4, R0_LONDON), (4, R0_LAGOS)))
def test_the_first_epoch_partitions_cells_by_res_and_base_cell(fixture):
    assert inferred.write_epoch(con, records, epoch="2026-11-20", out_root=data, git_sha=GIT_SHA) == PARTS
    lagos = pd.read_parquet(data / PARTS[3])
    assert list(lagos.columns) == list(inferred.CELLS_BY_CELL_COLUMNS)
    assert lagos[["h3_index", "variant_id"]].values.tolist() == [[LAGOS_R4, "chr11-5227002-T-A"], [LAGOS_R4, "kir:2dl1"]]
    assert set(lagos["h3_parent_r3"]) == {LAGOS_R3} and pd.read_parquet(data / PARTS[1])["h3_parent_r3"].tolist() == [LAGOS_R3]
```
  - `test_cells_columns_are_the_14_released_columns`: `len(inferred.CELLS_COLUMNS) == 14` and `"prior_frequency_sd" not in inferred.CELLS_COLUMNS`.
  - `test_measurement_of_reads_the_manifest_or_the_reviewed_table`: HbS v1 → `("allele_frequency", "reviewed_table")`; kir v3 → `("carrier_frequency", "manifest")`; a format-1 kir manifest without `measurement` → "measurement".
  - `test_fit_input_evidence_is_never_null`: `has_input=True` → `("fit-record", None)`; `web_json_matches={"a"}` → `("web-json-match", None)`; `released_without_input={"a": "released 2026-10-17 before fit inputs"}` → `("none", "released 2026-10-17 before fit inputs")`; `web_json_refused={"a": "ac differs"}` → `("none", "ac differs")`; a blank reason → "reason"; no input and in no map → "fit_input_evidence".
  - `test_check_6_compares_count_checksum_measurement_and_artifact_format`, parametrized over a kir part edit: `post_mean += 1e-9` → `"kir__2dl1__v3__afnd-2026-08.*checksum"`; one row dropped → "count"; `measurement = "allele_frequency"` → `"kir__2dl1__v3__afnd-2026-08.*measurement"`; `artifact_format = 1` → `"kir__2dl1__v3__afnd-2026-08.*artifact_format"`.
  - `test_check_6_is_order_independent`: the same part with its rows reversed passes.
  - `test_write_epoch_refuses_formats_3_and_4`: → `"prior_frequency_sd.*1.1"`.
  - `test_write_epoch_refuses_a_column_outside_CELLS_COLUMNS`: a `cells.parquet` with an extra `prior_frequency_sd` column in a format-2 manifest → "columns".
  - `test_write_epoch_refuses_an_identity_that_is_not_its_directory`: cells whose `model_version` is `v2` under a `__v3__` directory → "directory".
  - `test_write_epoch_refuses_a_cell_off_the_manifest_resolution`: a res-3 cell in a res-4 artifact → "resolution".
  - `test_write_epoch_refuses_a_cell_count_other_than_n_cells_or_a_duplicate_cell`: `n_cells` 3 over 2 cells → "n_cells"; a repeated cell → "duplicate".
  - `test_artifacts_record_their_first_release_keys`: kir v3's `cells_key == "releases/2026-10-17/store/artifacts/kir__2dl1__v3__afnd-2026-08/cells.parquet"`.
  - `test_a_released_partition_part_whose_bytes_changed_is_refused`: a published `epoch=` part rebuilt with other bytes → "immutable".
  - `test_a_summary_table_gets_a_new_key_instead`: `inferred/artifacts.parquet` published earlier with other bytes is keyed `releases/<R>/…`, with no error.
  - `test_is_write_once`: `dr.is_write_once(PARTS[0])` is true and `dr.is_write_once("tables/v1/inferred/artifacts.parquet")` false.
  - `tests/test_build_tables.py`:
    - `test_build_inferred_reports_the_fixture`: stdout has `inferred.artifacts: 3 rows; fit_input_evidence none 3` and `inferred.cells_by_cell epoch=2026-11-20: 3 artifacts, 6 rows, 4 parts (res 3: 2, res 4: 2)`.
    - `test_a_later_release_writes_only_new_artifacts_and_never_touches_an_earlier_epoch`: a second release with another `--git-sha` and one new artifact writes only its parts under the new epoch, and the earlier parts' sha256s are unchanged.
    - `test_an_earlier_epoch_listed_but_not_fetched_is_refused`: exit 1, and stderr has "fetch_data.py --prefix tables/".
- [ ] **Run** `python -m pytest tests/test_tables_inferred.py tests/test_build_tables.py tests/test_data_release.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.tables.inferred'`.
- [ ] **Implement:**
  - **Write-once.** A `tables/` path with a `<key>=` segment from `PARTITION_KEYS`, published earlier with other bytes, raises "a released part is immutable (data platform builder's call 6); write a new epoch or ingest version".
  - **`write_epoch` refuses** before writing anything: formats 3 and 4 (F4); columns other than `CELLS_COLUMNS`; an identity that is not its directory; a cell off the manifest resolution; a cell count other than `n_cells`, or a duplicate cell.
  - **`write_epoch` then** writes one part per `(res, h3_r0)`, only under `epoch=<epoch>`.
  - **`cells_checksum`** is `count(*)` plus `coalesce(sum(hash(<CELLS_COLUMNS>)::HUGEINT), 0)`. `check_cells_equal` compares each artifact's count and checksum with its `cells.parquet`, and its parts' distinct `measurement` and `artifact_format` with `measurement_of(...)[0]` and the manifest's `artifact_format`; every error names the artifact.
  - **The stage** keys from the committed manifests, otherwise `dr.release_key`. It reads earlier epochs through `require_published_local` and runs checks 1, 2, 6 and 10.
  - **Freeze** 2 contracts: `wrote 20 schemas`.
- [ ] **Run** the same command. Expected: PASS.
- [ ] **Real check.** Run `python scripts/fetch_data.py --prefix store/artifacts/`, then `python scripts/build_tables.py --release 2026-11-20 --stage inferred`. Every released format-1/2 `cells.parquet` passes the `CELLS_COLUMNS` refusal. Expected:
  - `inferred.artifacts: 61 rows; fit_input_evidence none 61; measurement allele_frequency 53 (2 from the reviewed table), carrier_frequency 8`
  - `inferred.cells_by_cell epoch=2026-11-20: 61 artifacts, 2,763,564 rows, 175 parts (res 3: 82, res 4: 93)`, about 170 MB

  Delete `data/tables/` afterwards.
- [ ] **Commit** (publishes nothing): `feat(tables): inferred.artifacts and the first cells_by_cell epoch (data platform §2.4, step 1.5)`

---

### Task 13 (step 1.6): The catalog in two passes, `evidence.parity_observations` and the parity smoke

**Files:**
- New: `genomeos/tables/{catalog,checks}.py` (cite §2.6, §2.7, §2.9; calls 1, 4, 17) and `scripts/smoke_catalog.py`.
- `writer.build_catalog_db`; `build_data_release.py` runs two passes.
- `.gitignore`: `!data/catalog/`, `data/catalog/*`, `!data/catalog/catalog.sql`.
- `docs/data-store.md`: the runbook gains `build_tables.py` and the smoke; add a "Query a release" section.
- Tests: `tests/test_tables_{catalog,checks}.py` and `tests/test_smoke_catalog.py` (new); `tests/test_build_data_release.py`.

**Interfaces:**
- Consumes: Tasks 11–12's tables, `write_once.published_paths`, `dr.validate_withdrawn`.
- `catalog`:
  - `PARITY_FILE = "validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet"`
  - `HIVE_TYPES: dict[str, dict[str, str]] = {"inferred.cells_by_cell": {"epoch": "VARCHAR", "res": "INTEGER", "h3_r0": "VARCHAR"}}`
  - `@dataclass(frozen=True) class CatalogFile(table: str, path: str, key: str, sha256: str, bytes: int, rows: int)`, `cite_as(release: str) -> str`, `catalog_files(objects: Sequence[dr.ReleaseObject], rows: Mapping[str, int]) -> tuple[CatalogFile, ...]`
  - `render_catalog_sql(release: str, files: Sequence[CatalogFile], *, base_url: str = dr.DATA_STORE_BASE_URL) -> str`, `render_tables_json(release: str, files: Sequence[CatalogFile]) -> bytes`
  - `catalog_urls(sql: str) -> tuple[str, ...]`, `catalog_local_paths(sql: str) -> tuple[str, ...]`
  - `check_catalog(sql: str, tables_json: bytes, objects: Mapping[str, dr.ReleaseObject], withdrawn_keys: frozenset[str]) -> None` (check 7)
- `checks.check_release_tables(data_root: Path, objects: Sequence[dr.ReleaseObject], *, manifests: Sequence[Mapping[str, Any]], repo_root: Path, new_sources: Mapping[str, tuple[str, ...]]) -> None`: checks 1, 2, 6, 9 and 10; each error reads "check <n>: <file>: …".
- `writer.build_catalog_db(sql: str, out: Path, *, data_root: Path) -> Path`.
- `build(..., catalog: bool = False)`; `main` passes `True`.
- `smoke_catalog`:
  - `GOLDEN = {"rows": 994, "sum_an": 11_359_130, "sum_ac": 175_878, "disc_rows": 40, "disc_sum_an": 52_340, "disc_sum_ac": 6_459}`
  - `LAGOS = (6.5244, 3.3792)`, `DISC_KM = 500`, `EARTH_RADIUS_KM = 6371.0088`
  - `catalog_url(release: str, base: str | None = None) -> str`, `parity_counts(con, *, alias: str = "atlas") -> dict[str, int]`
  - `main(argv: Sequence[str] | None = None) -> int`: either `--release R` or `--catalog PATH --local DIR`.
- Fixture `catalog_tree` (in `tests/tables_fixtures.py`): `fixture_tree` plus a 3-row parity file and `sources/curated/SOURCE.json`, giving 8 objects and 5 sources.

**`catalog.sql`:**
- Sorted schemas, then `meta.release`, then the views by name. `meta.release` is `SELECT '<R>' AS release, 'manifests/<R>.json' AS manifest_key, '<cite_as>' AS cite_as, NULL::VARCHAR AS mirror`.
- No `->` lambdas, and no view body names another view (§2.6: a macro naming a view fails under an alias).
- `<files>` is each view's file list (verified on 1.5.5 under an alias, with `'data'` and `'data/'`):
```sql
(CASE WHEN getvariable('genomeos_local') IS NULL THEN ['<base_url><key>', …]
 ELSE [rtrim(getvariable('genomeos_local'), '/') || '/<path>', …] END)
```
- Every view except `meta.withdrawn` and `meta.release` is `SELECT * EXCLUDE (filename) FROM read_parquet(<files>, filename = true[, hive_partitioning = true, hive_types = {…}]) WHERE filename NOT IN (SELECT <where>(key, path) FROM read_parquet(<meta.withdrawn files>))`, where `<where>(key, path)` is `CASE WHEN getvariable('genomeos_local') IS NULL THEN '<base_url>' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END`. `HIVE_TYPES` tables add the hive options.
- The `inferred` views also anti-join the withdrawn `path`s on `'store/artifacts/' || <dir> || '/cells.parquet'`, where `<dir>` is `artifact`, or `replace(variant_id, ':', '__') || '__' || model_version || '__' || data_version`.
- `tables.json` is `{release, schema: "genomeos-tables", schema_version: "1.0", tables: {name: [{access: "open", bytes, key, rows, sha256, url}]}}`.

**Build passes:**
1. Key everything outside `catalog/`, after the checks.
2. Write `catalog.sql`.
3. Build `atlas.duckdb` twice. Identical bytes are required ("two builds differ").
4. Write `tables.json`, then run check 7.
5. Refuse a stray `catalog/` file.
6. `catalog.sql` goes in git, with the union of the sources of what it lists.
7. Write the final manifest.

`main` prints `catalog: <n> views over <m> files; atlas.duckdb <bytes:,> bytes, identical over two builds`.

- [ ] **Test:**
```python
COUNTS = {"evidence.parity_observations": 3, "inferred.artifacts": 3, "inferred.cells_by_cell": 6, "meta.release": 1,
          "meta.release_objects": 8, "meta.served": 2, "meta.sources": 5, "meta.withdrawn": 0}
@pytest.mark.parametrize("local", ["data", "data/"])
def test_the_catalog_attaches_under_an_alias_and_reads_local_copies(built, local):
    assert {v: count(v) for v in COUNTS} == COUNTS
    assert con.execute("SELECT DISTINCT typeof(epoch), typeof(res) FROM atlas.inferred.cells_by_cell").fetchall() == [("VARCHAR", "INTEGER")]
def test_the_disc_counts_the_sampling_radius(built):   # PARITY_ROWS (lat, lon, r, an, ac): (6.5244, 3.3792, 1, 100, 10);
    # (11.9203, 3.3792, 150, 200, 20); (11.9203, 3.3792, 50, 400, 40): 600 km north, inside 500+150, outside 500+50
    assert smoke.parity_counts(con) == {"rows": 3, "sum_an": 700, "sum_ac": 70, "disc_rows": 2, "disc_sum_an": 300, "disc_sum_ac": 30}
def test_building_the_catalog_reads_only_local_copies(catalog_tree):
    (catalog_tree / "data" / PARITY_FILE).unlink()
    with pytest.raises(TableError) as error: _build(catalog_tree)
    assert PARITY_FILE in str(error.value) and "fetch_data.py --prefix" in str(error.value) and "https://" not in str(error.value)
```
  - `tests/test_tables_catalog.py`:
    - `test_meta_release_names_the_manifest_key_and_cite_as`: the row is `("2026-11-20", "manifests/2026-11-20.json", cite_as("2026-11-20"), None)`.
    - `test_catalog_sql_has_no_arrow_lambdas`: `"->" not in sql`.
    - `test_two_builds_are_byte_identical`.
    - `test_withdrawing_an_artifact_drops_it_from_the_inferred_views`: with kir's `cells.parquet` in `meta.withdrawn`, `inferred.artifacts` has 2 rows and `inferred.cells_by_cell` 4.
    - `test_every_view_anti_joins_the_withdrawn_files`: `build_catalog_db(render_catalog_sql(...))` run directly (skipping check 7) over a tree whose `meta.withdrawn` lists `PARITY_FILE` gives `evidence.parity_observations` 0 rows and the other counts unchanged; `build` on the same tree fails check 7 with "withdrawn".
    - `test_check_catalog_refuses`, parametrized: a URL that is not a manifest key → "not a manifest key"; a withdrawn key → "withdrawn"; a wrong sha256 in `tables.json` → "sha256"; `tables.json` listing another file set than `catalog.sql` → "lists different files"; a local path outside the `CASE` → "local path".
  - `tests/test_tables_checks.py`, `test_check_release_tables_refuses`, parametrized:
    - a file whose columns differ from its contract → `"check 1: .*contract"`;
    - `tables/v1/other/x.parquet` → `"check 2: .*measured"` (the message lists the five allowed schemas);
    - one sha256 under both `measured/` and `inferred/` → `"check 2: .*both"`;
    - a part at `h3_r0=8019fffffffffff` holding a Lagos row → `"check 2: .*h3_r0"`;
    - a `cells_by_cell` part with one `post_mean` changed → `"check 6: .*checksum"`;
    - an input key in no manifest → `"check 9: .*releases/"`;
    - a file without `genomeos.sources` → `"check 9: .*genomeos.sources"`;
    - an artifact row whose `fit_input_evidence` is null → `"check 10: .*fit_input_evidence"`.
  - `tests/test_build_data_release.py`:
    - `test_the_release_lists_the_catalog`: `catalog/catalog.sql` is `application/sql` and in git; `catalog/atlas.duckdb` is `application/octet-stream` and not; every URL in `catalog.sql` is a manifest key; `catalog.sql`'s sources include `genereviews`, `non_commercial` (call 16).
    - `test_a_stray_catalog_file_is_refused`: `data/catalog/notes.txt` → "catalog/".
    - `test_two_differing_catalog_builds_are_refused`: `writer.build_catalog_db` monkeypatched to append a byte on its second call → "two builds differ".
  - `tests/test_smoke_catalog.py`:
    - `test_the_smoke_names_the_first_differing_count`: `main(["--catalog", <fixture atlas.duckdb>, "--local", <data>])` exits 1, and stderr has "disc_rows 2, expected 40".
    - `test_catalog_url`: `catalog_url("2026-11-20") == "https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/catalog/atlas.duckdb"`.
- [ ] **Run** `python -m pytest tests/test_tables_catalog.py tests/test_tables_checks.py tests/test_smoke_catalog.py tests/test_build_data_release.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.tables.catalog'`.
- [ ] **Implement:**
  - `build_catalog_db` runs `SET VARIABLE genomeos_local = '<data_root>/'` before any `CREATE VIEW`, because views bind at creation.
  - It then runs `ATTACH '<out>' AS atlas_build (STORAGE_VERSION 'v1.2.0')`, `USE`, the statements, `USE memory`, `DETACH`.
  - It wraps DuckDB errors in a `TableError` naming the data path and "fetch it first: python scripts/fetch_data.py --prefix <dir>/".
  - Check 2 limits `tables/v1/` to measured, inferred, reference, evidence and meta, and refuses one sha256 under both `measured/` and `inferred/`.
  - The smoke filter is `2 * 6371.0088 * asin(sqrt(sin(radians(lat - 6.5244) / 2)^2 + cos(radians(6.5244)) * cos(radians(lat)) * sin(radians(lon - 3.3792) / 2)^2)) <= 500 + radius_km`.
  - `--release` uses `dr.resolve_base_url`, requires `meta.release.release == R`, and prints `parity smoke: golden`.
- [ ] **Run** the same command. Expected: PASS.
- [ ] **Commit:** `feat(catalog): catalog.sql, atlas.duckdb and tables.json in two passes, with the parity smoke (data platform §2.6, step 1.6)`

---

### Task 14 (step 1.6): Attach from DuckDB 1.2.2 and the pinned DuckDB-WASM

**Files:**
- Create:
  - `scripts/build_catalog_fixture.py`;
  - `scripts/check_catalog_attach.py` (stdlib and `duckdb` only; runs under `python -I`);
  - the committed fixture `tests/fixtures/catalog/{catalog.sql, atlas.duckdb, expected.json, data/**}`.
- `.github/workflows/ci.yml` gains one step. `.github/workflows/pages.yml` adds `"tests/fixtures/catalog/**"` to both `paths`.
- `website/package.json` and its lockfile pin an exact `@duckdb/duckdb-wasm` in `dependencies`. This is the one pin, and Task 29 ships it.
- Test: `website/tests/atlas-catalog-attach.test.ts` and `tests/test_catalog_fixture.py`.

**Interfaces:**
- Consumes: Task 13's `build(..., catalog=True)` and `catalog_tree`.
- `build_catalog_fixture`: `FIXTURE_RELEASE = "2026-11-20"`, `build_fixture(out: Path) -> None`, and `main(argv)` with `--check`. The check compares the Parquet files byte for byte, and `atlas.duckdb` by its view SQL, because the fixture is built on macOS and checked on Linux.
- `check_catalog_attach`: `check(catalog: Path, local: Path, *, expected: Mapping[str, int] | None = None, expect_views: int | None = None) -> list[str]`; `main(argv)` takes `--catalog`, `--local`, and exactly one of `--expect <expected.json>` (each view's row count) or `--expect-views N` (the view count, each view read once).
- `expected.json` is `{"release": "2026-11-20", "views": <Task 13's COUNTS>}`.

- [ ] **Test.**
  - `test_the_committed_catalog_fixture_is_current`: `build_catalog_fixture.main(["--check"]) == 0`.
  - `test_the_attach_check_passes_on_the_fixture_under_the_pinned_duckdb`: stdout has `DuckDB 1.5.5:` and `8 views`.
  - `test_the_attach_check_fails_on_a_wrong_count`: an `expected.json` with `meta.release: 2` → exit 1, naming `meta.release`; `--expect-views 9` → exit 1.
  - `test_the_attach_check_imports_only_duckdb_and_the_standard_library`: its imports are `duckdb` or in `sys.stdlib_module_names`.
  - vitest `the DuckDB-WASM pin is exact`: `pkg.dependencies['@duckdb/duckdb-wasm']` matches `/^\d+\.\d+\.\d+$/`.
  - vitest `the pinned DuckDB-WASM attaches the fixture catalog read-only`, in Node through the package's blocking build:
    - `createDuckDB` from `@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs`, with the package's `duckdb-mvp.wasm`/`duckdb-eh.wasm` bundles and `NODE_RUNTIME`;
    - `registerFileBuffer('atlas.duckdb', <bytes>)`, and every file under `tests/fixtures/catalog/data/` registered as `data/<path>`;
    - `SET VARIABLE genomeos_local = 'data/'`, then `ATTACH 'atlas.duckdb' AS atlas (READ_ONLY)`;
    - each view's `count(*)` equals `expected.views`, and `SELECT version()` matches `/^v1\.(?:[2-9]|[1-9]\d)\.\d+$/`; the test logs the version for the PR (F6).
- [ ] **Run** `python -m pytest tests/test_catalog_fixture.py -q` and `(cd website && npx vitest run tests/atlas-catalog-attach.test.ts)`. Expected: `FileNotFoundError` for the scripts, and the vitest import of `@duckdb/duckdb-wasm` fails.
- [ ] **Implement.**
  - `build_fixture` runs `build(..., catalog=True)` on `catalog_tree`.
  - `check` prints `DuckDB <v>: <catalog> attached read-only; <n> views read offline`.
  - Pin the newest `@duckdb/duckdb-wasm` whose bundled DuckDB is ≥ 1.2 and attaches the v1.2.0 fixture in the vitest above. Record that DuckDB version in the PR (F6).
  - Add the CI step "Catalog attaches from DuckDB 1.2.x": a venv with `duckdb==1.2.2`, then `python -I scripts/check_catalog_attach.py --catalog tests/fixtures/catalog/atlas.duckdb --local tests/fixtures/catalog/data --expect tests/fixtures/catalog/expected.json`.
- [ ] **Verify.**
  - `python -m pytest tests/test_catalog_fixture.py -q` passes.
  - `uv run --no-project --python 3.12 --with duckdb==1.2.2 python -I scripts/check_catalog_attach.py --catalog tests/fixtures/catalog/atlas.duckdb --local tests/fixtures/catalog/data --expect tests/fixtures/catalog/expected.json` prints `DuckDB 1.2.2: tests/fixtures/catalog/atlas.duckdb attached read-only; 8 views read offline`. The `--python 3.12` matters: duckdb 1.2.2 has no wheel for the newer interpreters on this machine.
  - `(cd website && npx vitest run && npm run format:check)` passes.
- [ ] **Commit:** `test(catalog): attach from DuckDB 1.2.2 and the pinned DuckDB-WASM (builder's call 15, step 1.6)`

---

### Task 15 (steps 1.4–1.6): Verify by HEAD where keys are reused, then cut release 1; the owner uploads

**Files:** `scripts/fetch_data.py` (`verify_remote`, `main`'s success line); `tests/test_fetch_data.py`; `data/releases/<R>.json` (`<R>` is today's date, and so is `epoch=<R>`); `data/catalog/catalog.sql`. **Interfaces:** release `<R>`; `verify_remote(objects, base, release, releases=RELEASES) -> list[str]`, unchanged in signature.

- [ ] **Test the verify (call 11).** In `tests/test_fetch_data.py`, over the loopback server, which logs each request's method and path:
  - `test_verify_remote_fetches_only_this_releases_keys_in_full`: a release whose manifest reuses an earlier key → a `GET` for each `releases/<R>/` key and a `HEAD`, never a `GET`, for the reused one; stdout reads `release <R>: <n> objects verified over HTTPS (<f> in full, <h> by HEAD)`.
  - `test_verify_remote_refuses_a_reused_key_whose_length_differs`: the reused object served with other bytes → "Content-Length".
  - Run `python -m pytest tests/test_fetch_data.py -q`: these two fail.
- [ ] **Implement.** `verify_remote` streams a key in full only when it starts with `releases/<release>/`; it sends `HEAD` for the rest, requiring 200, `Content-Length` equal to the manifest's `bytes` and no `Content-Encoding`. Run the same command: PASS. Commit: `feat(data): verify reused keys by HEAD and only new keys in full (builder's call 11)`.
- [ ] **Fetch and build.**
  - `python scripts/fetch_data.py`.
  - `python scripts/build_tables.py --release <R>`. Expected: Task 11's four lines, and Task 12's two lines at `epoch=<R>`.
  - `python scripts/build_data_release.py --release <R>`. Expected:
    - `catalog: 8 views over 181 files; atlas.duckdb <n> bytes, identical over two builds` (the spec measured 274,432 B; record the actual size);
    - 431 objects (248 + 4 + 1 + 175 + 3), 17 of them in git, 183 under `releases/<R>/`;
    - a rerun prints `unchanged`.
- [ ] **Smoke.**
  - `python scripts/smoke_catalog.py --catalog data/catalog/atlas.duckdb --local data/` → `parity smoke: golden`.
  - `uv run --no-project --python 3.12 --with duckdb==1.2.2 python -I scripts/check_catalog_attach.py --catalog data/catalog/atlas.duckdb --local data --expect-views 8` → `DuckDB 1.2.2: data/catalog/atlas.duckdb attached read-only; 8 views read offline`.
  - The Global Constraints' gates pass.
- [ ] **Commit and draft PR.** Commit `data: release <R> with the meta and inferred tables and the first catalog (data platform steps 1.4-1.6)`. Open a draft PR asking the owner to confirm `cite_as` and G6PD v1.
- [ ] **(owner)** Follow `docs/data-store.md` "For every release":
  - `publish_data_store.py --dry-run`, then for real;
  - `python scripts/fetch_data.py --verify-remote` → `release <R>: 431 objects verified over HTTPS (183 in full, 248 by HEAD)`;
  - `python scripts/smoke_catalog.py --release <R>` → `parity smoke: golden`.
- [ ] **Merge.** Mark the PR ready and merge after CI.

---

### Task 16 (step 1.8): Raw harvests and external caches with their terms, and the §4.2 constants

**Files:**
- New: `genomeos/publication/{raw_harvests,access_policy}.py` (cite §2.1, §2.3, §4.2, §4.3).
- `MEDIA_TYPES[".tif"] = "image/tiff"`.
- `build_data_release.py`:
  - `raw_harvests` passes through `included_files`, `collect`, `build` and `main`;
  - `INCLUDE` and `OPTIONAL_ROOTS` gain `store/external`;
  - `_RULES` adds `raw/<source>/…` → `(source,)`, ahead of the legacy rule, and `store/external/<source>/…` → `(source,)` for `gnomad`, `dbsnp` and `alphagenome`;
  - `REVIEWED_SOURCES` gains `gnomad_hgdp_1kg`, `gnomad`, `dbsnp` and `alphagenome`.
- `docs/data-store.md`: two layout lines.
- Tests: `tests/test_raw_harvests.py` and `tests/test_access_policy.py` (new); `tests/test_build_data_release.py`.

**Interfaces:**
- `access_policy`: `EGRESS_USD_PER_GIB = Decimal("0.12")`, `OPEN_OBJECT_MAX_BYTES = 1 << 30`, `OPEN_RELEASE_GCS_MAX_BYTES = 2 << 30`, `LOOKUP_DAILY_BYTES_MAX = 20 << 30`.
- `rh` (`raw_harvests`):
  - `LEGACY_RAW = ("raw/afnd_populations.tsv",)` and `NOT_RECORDED = "not_recorded"`.
  - `@dataclass(frozen=True) class RawHarvest(source: str, harvest_version: str, files: tuple[tuple[str, str], ...], upstream_url: str, copied_from: str | None, retrieved_at: str, fetch_command: str)`, whose `.root` is `raw/<source>/<harvest_version>`. `files` holds `(name, sha256)` pairs.
  - Field rules, each a hard error naming the field: `source` is a `REVIEWED_SOURCES` key; `harvest_version` is `YYYY-MM` or `YYYY`; `files` is non-empty, sorted by name and unique, each name one path segment and each sha256 64 lowercase hex; `upstream_url` is `https://`; `copied_from` is `None` or `hf://datasets/bschilder/genomeos-data@<40 hex>/<path>`; `retrieved_at` is `YYYY-MM-DD` or `NOT_RECORDED`; `fetch_command` is non-blank.
  - `harvest_path(harvest: RawHarvest, name: str) -> str`, `RAW_HARVESTS: tuple[RawHarvest, ...]` and `check_raw_harvests(records: Sequence[dr.FileRecord], harvests: Sequence[RawHarvest]) -> None`.
  - `EXTERNAL_CACHE_SOURCES = ("alphagenome", "dbsnp", "gnomad")` and `check_external_cache(path: str, document: object) -> None`, which refuses any key from `commercial_use.KNOWN_NON_COMMERCIAL_FIELDS[source]` at any depth: "split out <field> before publishing (R5, design §4.3)".
- `build(..., raw_harvests: Sequence[RawHarvest] = (), catalog: bool = False)`; `main` passes `rh.RAW_HARVESTS`.

- [ ] **Test:**
```python
def test_the_real_harvest_roster():
    assert {h.root: [name for name, _ in h.files] for h in rh.RAW_HARVESTS} == {"raw/afnd/2026-08": ["afnd_frequencies.tsv"],
        "raw/map/2026-08": ["map_g6pd_surveys.csv", "map_hbs_surveys.csv"],
        "raw/worldpop/2020": ["cok_ppp_2020_UNadj.tif", "ppp_2020_1km_Aggregated.tif"]}
```
  - `tests/test_raw_harvests.py`:
    - `test_a_refetch_with_other_bytes_needs_a_new_harvest_version` → "new harvest_version".
    - `test_a_listed_harvest_file_missing_locally_is_refused` → "missing".
    - `test_an_unlisted_raw_file_is_refused` → "no reviewed raw harvest".
    - `test_a_harvest_field_outside_its_rule_is_refused`, one case per field: `source="nope"`, `harvest_version="Aug 2026"`, `files=()`, unsorted `files`, `upstream_url="http://x"`, `copied_from="hf://datasets/other/x@main/y"`, `retrieved_at="2026"`, `fetch_command=" "`; each raises naming the field.
    - `test_the_legacy_afnd_table_is_not_a_harvest`.
    - `test_every_real_harvest_has_64_hex_digests_and_recorded_terms`.
    - `test_an_external_cache_carrying_a_non_commercial_field_is_refused`: an `alphagenome` document with `top_attributions` → "top_attributions"; a `gnomad` one with `spliceai` → "spliceai".
  - `tests/test_access_policy.py`:
    - `test_the_section_4_2_constants`: the four values above.
    - `test_an_object_over_1_gib_is_refused_from_a_harvest`: `(1 << 30) + 1` bytes → "R5–R7", while `1 << 30` passes.
  - `tests/test_build_data_release.py`:
    - `test_harvests_and_caches_carry_their_sources`: the AFND TSV → `["afnd"]`; a raster → `image/tiff` and `["worldpop"]`; `store/external/{gnomad,dbsnp,alphagenome}/…` → `["gnomad"]`, `["dbsnp"]`, `["alphagenome"]`; `store/external/other/x.json` → "no reviewed source rule".
    - `test_a_harvest_root_that_is_absent_locally_is_a_hard_error` → "fetch it first".
    - `test_the_gnomad_hgdp_1kg_terms_are_recorded`: `explicitly_open`; `CC0-1.0`; the note has "reidentify", "SpliceAI" and "tool's name"; `non_commercial` false.
    - `test_the_external_cache_terms_copy_the_web_catalogs_commercial_use`: for each cache source, `terms.status`, `checked_at`, `terms_url` and `recorded_in` equal the `commercial_use` block in `website/src/atlas/public-artifacts.json`.
- [ ] **Run** `python -m pytest tests/test_raw_harvests.py tests/test_access_policy.py tests/test_build_data_release.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.publication.raw_harvests'`.
- [ ] **Implement.** Add the source verbatim:
```python
"gnomad_hgdp_1kg": {"name": "gnomAD v3.1.2 HGDP + 1KG callset",
 "citation": "Koenig et al. (2024), Genome Research; https://pmc.ncbi.nlm.nih.gov/articles/PMC11216312/",
 "url": "https://gnomad.broadinstitute.org/",
 "terms": {"status": "explicitly_open", "checked_at": "2026-09-15", "terms_url": "https://gnomad.broadinstitute.org/policies",
           "licence": "CC0-1.0", "recorded_in": "docs/audits/gnomad-dbsnp-commercial-use.md",
           "note": "Primary data CC0. Users agree to not attempt to reidentify participants; bundled annotations such as SpliceAI "
                   "are CC BY-NC, so only counts and population coordinates are taken. Do not use 'gnomAD' or 'Genome "
                   "Aggregation Database' in a tool's name, or the logo, without permission."},
 "non_commercial": False},
```
  The `gnomad`, `dbsnp` and `alphagenome` entries copy each `commercial_use` block's `finding` (as `status`), `checked_at`, `terms_url` and `recorded_in` from `website/src/atlas/public-artifacts.json`; their `non_commercial` is false because each block's `restricted_fields` is empty and `check_external_cache` refuses a restricted field. Run with `-k "not real"`: PASS.
- [ ] **Pin the real files from evidence:**
  - AFND and MAP: `raw/{afnd_frequencies.tsv, map_hbs_surveys.csv, map_g6pd_surveys.csv}` from HF `bschilder/genomeos-data` at `6e77ef278e71fbb86dafd252f4cecc824388f5fc`, the revision the served catalog cites. Their sha256s must equal the released `store/INVENTORY.json`'s (`2436932578…`, `ab92edd3…`, `ad473661…`).
  - WorldPop: read the grid manifest `store/population/worldpop-res4-2020-plus-cok.parquet.manifest.json` from HF at the same revision; its sha256 must be `0571f6d668f6a062ce47ee177ab1902ad4a71d970b866608a725ce6539fecb39` (1,218 B), as `store/INVENTORY.json` records. Fetch the rasters through `scripts/fetch_worldpop.py`, pinned to its `input_rasters[]`. Stop on a mismatch.
  - External caches: `store/external/{gnomad/chr11-5227002-t-a.json, dbsnp/rs334.json, alphagenome/chr11-5227002-t-a.json}` from HF at the same revision, the three `cache_file`s `public-artifacts.json` names. gnomAD's and dbSNP's sha256s must equal INVENTORY's (`52bfeade…`, `49ef3850…`); AlphaGenome's postdates it, so record its sha256 in the PR.
  - `retrieved_at`: a date only where a committed record states one.
  - Part B of Task 7's issue: add the gnomAD TSV harvest only if the owner supplied the file and its upstream; otherwise nothing from part B.
- [ ] **Verify.** `python scripts/build_data_release.py --release 2099-01-01 --out "$SCRATCH/release.json" --no-git`. Each harvest and cache has its source, and every object is ≤ 1,073,741,824 B.
- [ ] **Commit:** `feat: publish the AFND, MAP and WorldPop raw harvests and the external caches with recorded terms (advances #472)`. If the module-size check trips, move `REVIEWED_SOURCES` to `genomeos/publication/source_terms.py`.

---

### Task 17 (step 1.7): Reference tables, the legacy registry rows and the HGDP + 1KG adapter

**Files:**
- New: `genomeos/registry/sources/hgdp_1kg.py`, `genomeos/tables/reference.py` (cites §2.3, §2.4, check 5, calls 5 and 18), and the fixture `tests/fixtures/hgdp_1kg_populations.tsv`.
- Changed:
  - `genomeos/tables/write_once.py`: new `require_same_rows`.
  - `genomeos/registry/publication.py`: new `registry_release`.
  - `map_surveys.py` and `map_g6pd.py`: `_population_id` → `population_id`.
  - `contracts.py` and the `reference` stage.
  - `dr.is_write_once`, which now also covers `tables/v1/reference/populations/`.
- Tests: `tests/test_hgdp_1kg_registry_source.py` and `tests/test_reference_tables.py` (new); `tests/test_build_data_release.py`.

**Interfaces:**
- Consumes: Task 16's `rh.RAW_HARVESTS` (the MAP harvest), Task 11's writer and `BuildContext`.
- `hgdp_1kg`:
  - `ALIAS_SOURCES = ("hgdp", "onekg")`
  - `REQUIRED_COLUMNS = ("alias_source", "population", "latitude", "longitude", "uncertainty_radius_km", "location_type", "provenance", "biocultural_notice")`
  - `population_id(alias_source: str, label: str) -> str`, giving `hgdp-<slug>` or `onekg-<slug>`
  - `load(path: Path, registry_version: str) -> tuple[pd.DataFrame, pd.DataFrame]`
- `registry/publication.registry_release(populations: pd.DataFrame, aliases: pd.DataFrame, *, inputs: tuple[RegistryInput, ...], release_version: str) -> RegistryRelease`, defined as `prepare_registry_release(populations, aliases, _publication_inputs(inputs), release_version)`: the identity `publish_registry` writes.
- `write_once.require_same_rows(published: Path, rebuilt: pd.DataFrame, *, key: Sequence[str]) -> None`: raises "a released part is immutable (data platform builder's call 6): <path> differs from its rebuild in <n> rows".
- `reference`:
  - `AFND_LEGACY = "afnd-2026-08"` and `MAP_LEGACY = "map-survey-coordinates-v1"`
  - `registry_folder(version: str) -> str`: `R+sha256.<hex>` → `R-<hex[:8]>`; the two legacy names unchanged; anything else raises
  - `reference_paths(version: str) -> tuple[str, str]`, `reference_frames(populations, aliases, *, registry_version: str) -> tuple[pd.DataFrame | None, pd.DataFrame]`
  - `afnd_legacy(tsv: Path) -> tuple[pd.DataFrame, pd.DataFrame]` and `map_legacy_aliases(hbs_csv: Path, g6pd_csv: Path) -> pd.DataFrame`
  - `read_reference(folder: Path) -> tuple[pd.DataFrame | None, pd.DataFrame]`
  - `require_resolved(ids: Iterable[str], populations: pd.DataFrame | None, aliases: pd.DataFrame, *, registry_version: str) -> None` and `require_registry_coordinates(observations: pd.DataFrame, populations: pd.DataFrame, *, registry_version: str) -> None` (check 5)
- Contracts:
  - `reference.populations` has the `POPULATIONS_SCHEMA` columns.
  - `reference.population_aliases` has the `ALIASES_SCHEMA` columns plus `registry_version`, unique on `(registry_version, source, label)`.
- `build_reference(ctx: BuildContext) -> list[str]`.

- [ ] **Fixture.**
  - Six `hgdp` rows (Yoruba, Sardinian, Han, NorthernHan, PapuanHighlands, PapuanSepik): `ancestral`, with `hgdp.BIOCULTURAL_NOTICE`.
  - One `onekg` `GBR` row: `sampling`, with a blank notice.
  - Provenance `synthetic:hgdp-1kg-fixture-v1#row-N`.
- [ ] **Test.**
  - `tests/test_hgdp_1kg_registry_source.py`:
    - `test_colliding_labels_stay_four_identities`: Han, NorthernHan, PapuanHighlands and PapuanSepik → `hgdp-han`, `hgdp-northernhan`, `hgdp-papuanhighlands`, `hgdp-papuansepik`; GBR → `("onekg", "onekg-gbr")`.
    - `test_location_type_is_read_never_defaulted`: the fixture's values pass through; a blank one → "location_type".
    - `test_a_blank_required_value_is_refused`, parametrized over `REQUIRED_COLUMNS` except `biocultural_notice` → the column's name.
    - `test_an_hgdp_row_needs_the_biocultural_notice` → "biocultural_notice"; an `onekg` blank becomes null.
    - `test_an_unknown_alias_source_is_refused`: `tgp` → "alias_source".
    - `test_the_gnomad_adapter_resolves_through_the_new_ids`: `{"hgdp-yoruba", "hgdp-sardinian", "hgdp-han"}`.
    - `test_registry_release_is_publish_registrys_identity`: `registry_release(p, a, inputs=I, release_version="1.0.0").registry_version == publish_registry(p, a, inputs=I, release_version="1.0.0", out=tmp_path / "r").registry_version`.
  - `tests/test_reference_tables.py`:
    - `test_registry_folder_names`: `"1.0.0+sha256.0123abcd" + "0" * 56` → `"1.0.0-0123abcd"`; `afnd-2026-08` and `map-survey-coordinates-v1` unchanged; `afnd-2026-09` raises.
    - `test_afnd_legacy_equals_the_released_registry`: `afnd_legacy(data/raw/afnd_populations.tsv)` equals `afnd_registry.load` on the same file.
    - `test_map_legacy_rows_are_aliases_only`: they include `("map_surveys", "404", "map-hbs-404")` and `("map_g6pd", "659", "map-g6pd-659")`; a duplicate id → "duplicate".
    - `test_require_resolved_names_the_missing_id`: `["afnd-999999"]` → "afnd-999999".
    - `test_registry_coordinates_must_match`: a lat offset of 0.01 → "lat"; under `MAP_LEGACY` it passes.
    - `test_build_reference_is_deterministic`: two builds are byte-identical.
    - `test_a_published_folder_is_verified_not_rewritten`: a rebuild with another git SHA leaves the bytes and the first writer's `genomeos.git_sha`.
    - `test_require_same_rows_refuses_a_published_folder_with_other_rows`: one changed row → "a released part is immutable".
  - `tests/test_build_data_release.py`, `test_reference_folders_carry_their_sources`: `afnd-2026-08` → `["afnd"]`, `map-survey-coordinates-v1` → `["map"]`; changed bytes in a published folder → "immutable".
- [ ] **Run** `python -m pytest tests/test_hgdp_1kg_registry_source.py tests/test_reference_tables.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.registry.sources.hgdp_1kg'`.
- [ ] **Implement:**
  - `hgdp_1kg.load` reuses `hgdp._read_input`'s refusals. An `hgdp` row needs `BIOCULTURAL_NOTICE`; an `onekg` blank becomes null.
  - Coordinates compare exactly.
  - `build_reference` writes `afnd-2026-08` from the released raw file, and `map-survey-coordinates-v1` (aliases only) from Task 16's harvest. A published folder is verified through `require_same_rows`.
  - Freeze 2 contracts: `wrote 22 schemas`.
- [ ] **Run** the same command plus `tests/test_map_surveys.py tests/test_map_g6pd.py tests/test_registry_publication.py tests/test_build_data_release.py`. Expected: PASS.
- [ ] **Commit:** `feat: publish the population registry under tables/v1/reference with the legacy AFND and MAP rows (advances #7)`

---

### Task 18 (step 1.7): The 80 HGDP + 1KG identities that D18 needs

**Files:**
- Create `scripts/curate_hgdp_1kg_registry.py` (cites §1.2 D18 item 1) and `data/registry/hgdp_1kg/1.0.0/populations.tsv`, which is committed.
- `.gitignore` adds `!data/registry/hgdp_1kg/`.
- The `reference` stage loads the TSV, and `_RULES` maps `registry/hgdp_1kg/` → `("genomeos", "gnomad_hgdp_1kg")`.
- `docs/hgdp-registry-input.md`.
- Test: `tests/test_curate_hgdp_1kg_registry.py` (new).

**Interfaces:**
- Consumes: Task 17's `hgdp_1kg.load`, `registry_release` and `reference.registry_folder`.
- `METADATA_SHA256 = reference_cohorts.METADATA_SHA256`.
- `PROJECTS`, `HEADER`, and the column constants.
- `curate(metadata: bytes, *, expected_sha256: str = METADATA_SHA256) -> pd.DataFrame`, with sorted columns `alias_source, population, latitude, longitude`.
- `main(argv: Sequence[str] | None = None) -> int` takes `--metadata` and `--check <tsv>`.
- `HGDP_1KG_REGISTRY = "registry/hgdp_1kg/1.0.0/populations.tsv"`.
- The folder is `tables/v1/reference/populations/1.0.0-<sha8>/`.

- [ ] **Open the F1 issue.** Title: "Radius, location_type and notice rule for the 80 HGDP + 1KG identities (step 1.7, D18)", label `needs-human-decision`. The coordinates come from `gnomad_meta_updated.tsv` (sha256 `e18e7a29d0567b8063edc1a714bd31e57dc422823ba51af2c63fecef0dbc3cf1`). Ask for:
  - the radius rule, with a locator per row;
  - `location_type` for diaspora sites;
  - the `onekg` notice.
- [ ] **Test the curation** (a synthetic six-sample metadata built in the test, its digest passed as `expected_sha256`).
  - `test_curate_writes_one_row_per_literal_population`: → `[["hgdp", "Han"], ["hgdp", "NorthernHan"], ["onekg", "GBR"]]`.
  - `test_curate_refuses_another_digest` → "sha256".
  - `test_two_coordinates_for_one_population_are_refused` → "Han"; they are never averaged.
  - `test_an_unknown_project_or_blank_population_is_refused`: `tgp`, `""` and `NA` each raise.
  - `test_the_pinned_digest_is_the_full_hash`: `METADATA_SHA256` is the full hash above.
  - Run `python -m pytest tests/test_curate_hgdp_1kg_registry.py -q`: `FileNotFoundError` for the script.
- [ ] **Implement.** Use `csv` and write population-level rows only. Run the same command: PASS.
- [ ] **Run on the real metadata.** Download `https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1/secondary_analyses/hgdp_1kg_v2/metadata_and_qc/gnomad_meta_updated.tsv` into `$SCRATCH`; it is per-sample, so never commit it. Expected: the pinned digest and `80 populations`. If there are fewer, stop (F2).
- [ ] **(after the answer) Write the TSV:** coordinates from the curation; the rule's radius, `location_type` and notice; provenance naming the sha256 and the radius locator.
- [ ] **Test the committed file.**
  - `test_the_committed_registry_holds_80_identities`: 80 populations and 80 aliases, unique, including the four colliding labels.
  - `test_every_coordinate_cites_the_pinned_metadata`: each provenance contains `METADATA_SHA256`.
  - `test_the_registry_folder_carries_genomeos_and_gnomad_hgdp_1kg`: its sources are `["genomeos", "gnomad_hgdp_1kg"]`, never `afnd`.
  - `test_the_registry_version_and_folder`: `registry_version` matches `^1\.0\.0\+sha256\.[0-9a-f]{64}$`, and the folder starts `tables/v1/reference/populations/1.0.0-`.
- [ ] **Implement.** Add the TSV through `registry_release`. `python scripts/curate_hgdp_1kg_registry.py --metadata "$SCRATCH/gnomad_meta_updated.tsv" --check data/registry/hgdp_1kg/1.0.0/populations.tsv` prints `80 populations match the pinned metadata`, and the tests pass.
- [ ] **Commit:** `data: add the 80 HGDP + 1KG identities to the population registry (advances #7)`

---

### Task 19 (step 1.9): Measured tables for the curated AFND ingests

**Files:**
- Create `genomeos/tables/measured.py` (cites §2.4, checks 2–5 and 9, call 6).
- Create the fixture `tests/fixtures/afnd_frequencies_mixed.tsv`: 2 `hla` rows; a `cyt` triple `IL-6/ - 174` (CC, CG, GG); KIR presence `2DL1`/`2DL1`; KIR allele `3DL1*007`.
- `contracts.py` gains `measured.carrier_observations` and `measured.ingests` (an Arrow contract).
- `HIVE_TYPES` gains `source` and `ingest_version` as VARCHAR.
- Add the `measured` stage. `build` calls `check_ingest_inputs` when `INGESTS_PATH` is present.
- The spec: §2.4's `measured.ingests` key (one docs commit).
- Tests: `tests/test_measured_tables.py` (new), `tests/test_build_data_release.py`.

**Interfaces:**
- Consumes:
  - `write_once.require_same_rows(published: Path, rebuilt: pd.DataFrame, *, key: Sequence[str]) -> None` (Task 17);
  - `reference.require_resolved(ids, populations, aliases, *, registry_version) -> None` and `reference.afnd_legacy(tsv) -> tuple[pd.DataFrame, pd.DataFrame]` (Task 17);
  - `writer.write_frame` and `BuildContext` (Task 11); `fetch_data.require_local`.
- Constants: `ALLELE_TABLE = "measured.allele_observations"`, `CARRIER_TABLE = "measured.carrier_observations"`, `SORT_KEY = ("variant_id", "population_id", "source_record_id")`, `INGESTS_PATH = "tables/v1/measured/ingests.parquet"`.
- `SPATIAL_SUPPORT_ADAPTERS: Mapping[str, str] = {"map_surveys": "genomeos/observations/sources/map_surveys.py"}`: the only source with a spatial-support contract (`sampling_bounding_disc`, `docs/map-spatial-support.md`). Its rows enter only through that adapter, whose `_explicit_radii` enforces it. AFND has no such contract, so pandera alone applies to its parts (check 3).
- `part_path(table: str, source: str, ingest_version: str) -> str`.
- `@dataclass(frozen=True) class IngestInput(bytes: int, key: str | None = None, sha256: str | None = None, url: str | None = None, md5: str | None = None, generation: int | None = None)`: either `key` + `sha256`, or `url` + `md5` + `generation`.
- `@dataclass(frozen=True) class Ingest(table, source, ingest_version, registry_version, adapter, adapter_git_sha, inputs: tuple[IngestInput, ...], n_rows: int, refusals: Mapping[str, int], source_record_id_template: str | None)`.
- Functions:
  - `ingest_part(rows: pd.DataFrame, *, table: str) -> pd.DataFrame`, `check_partition_values(path: str, frame: pd.DataFrame) -> None`.
  - `ingests_table(ingests: Sequence[Ingest]) -> pyarrow.Table`, keyed and sorted by `(table, source, ingest_version)`.
  - `read_ingests(path: Path) -> tuple[Ingest, ...]`, `check_ingest_inputs(ingests: Sequence[Ingest], published: Mapping[str, dr.ReleaseObject]) -> None` (check 9), `reingest_matches(part: pd.DataFrame, rebuilt: pd.DataFrame) -> None` (check 4).
- `@dataclass(frozen=True) class CuratedIngest(table, source, ingest_version, registry_version, adapter, inputs: tuple[str, ...], load: Callable[..., tuple[pd.DataFrame, Any]])`.
- `CURATED_INGESTS`: three entries at `afnd-2026-08`, each with inputs `raw/afnd/2026-08/afnd_frequencies.tsv` and `raw/afnd_populations.tsv`:
  - `(ALLELE_TABLE, "afnd_frequencies", afnd_frequencies.load)`
  - `(ALLELE_TABLE, "afnd", afnd_cytokines.load)`
  - `(CARRIER_TABLE, "afnd", afnd_carriers.load)`
- `build_measured(ctx: BuildContext, ingests: Sequence[CuratedIngest] = CURATED_INGESTS) -> tuple[Ingest, ...]`.

- [ ] **Test** (`AF`, `CYT` and `KIR` are the `…/source=<s>/ingest_version=afnd-2026-08/part-0.parquet` parts of the fixture build `built`):
```python
def test_kir_presence_is_carriers_over_individuals_never_allele_rows(built):
    names = pq.read_schema(built.out / KIR).names
    assert {"carriers", "n_individuals"} <= set(names) and not {"ac", "an"} & set(names)
    assert "kir:2dl1" not in set(pd.read_parquet(built.out / AF)["variant_id"]) | set(pd.read_parquet(built.out / CYT)["variant_id"])
def test_ingests_has_one_row_per_table_source_and_version(built):
    rows = pq.read_table(built.out / INGESTS_PATH).to_pylist()
    assert [(r["table"], r["source"], r["ingest_version"]) for r in rows] == [
        (ALLELE_TABLE, "afnd", "afnd-2026-08"), (ALLELE_TABLE, "afnd_frequencies", "afnd-2026-08"), (CARRIER_TABLE, "afnd", "afnd-2026-08")]
    assert {r["registry_version"] for r in rows} == {"afnd-2026-08"} and all(r["source_record_id_template"] is None for r in rows)
    assert rows[1]["adapter"] == "genomeos/observations/sources/afnd_frequencies.py"
```
  - `test_allele_parts_store_the_17_observation_columns_sorted`: `pq.read_schema(AF).names == list(OBSERVATIONS_SCHEMA.columns)`, no column contains `freq`, and rows are sorted by `SORT_KEY`.
  - `test_a_part_holds_one_source_and_one_ingest_version`: rows with two `ingest_version`s → "ingest_version"; a duplicate `source_record_id` → "source_record_id"; `check_partition_values("…/source=map/ingest_version=afnd-2026-08/part-0.parquet", <afnd rows>)` → "source".
  - `test_ingest_inputs_and_refusals_are_recorded`: each row's inputs are the two keys with their sha256s, and its `refusals` equal the adapter's own report.
  - `test_the_same_ingest_twice_is_refused` → "twice".
  - `test_check_9_refuses_inputs_that_are_not_released_or_cited`: a key in no manifest → "not a manifest key"; a wrong sha256 → "sha256"; a `url` input without `generation` → "generation".
  - `test_check_4_reingest_must_give_the_same_record_ids`: a rebuilt part one row short → "source_record_id".
  - `test_check_5_every_population_resolves_in_afnd_2026_08`: a part with `population_id` `afnd-999999` → "afnd-999999".
  - `test_map_rows_need_their_spatial_support_adapter`: a `CuratedIngest(ALLELE_TABLE, "map_surveys", "map-2026-08", …, adapter="tests/x.py", load=<the 3 parity-fixture rows with area-class radii>)` → "spatial-support contract".
  - `test_a_published_part_is_verified_not_rewritten`: a rebuild with another git SHA keeps the bytes and the first writer's KV; two builds are identical.
  - `test_no_measured_view_divides_counts`: `re.search(r"\b(ac|carriers)\s*/\s*(an|n_individuals)\b", catalog_sql) is None`.
  - `test_a_withdrawn_measured_part_reads_no_rows` (§2.9): Task 13's anti-join over a catalog whose `meta.withdrawn` lists `AF` (built with `build_catalog_db` directly) gives `measured.allele_observations` only the `CYT` rows.
  - `tests/test_build_data_release.py`: `test_measured_objects_carry_afnd`; `test_new_bytes_at_an_ingest_version_part_are_refused` ("immutable"); `test_an_ingest_input_absent_from_every_manifest_is_refused` ("not a manifest key").
- [ ] **Run** `python -m pytest tests/test_measured_tables.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.tables.measured'`.
- [ ] **Implement.**
  - `ingest_part` validates against the schema, requires one source and version and unique ids, and sorts.
  - `build_measured` refuses a `SPATIAL_SUPPORT_ADAPTERS` source whose `adapter` is not its listed module. It resolves inputs through `fetch_data.require_local`. It re-ingests a published part and verifies it (`reingest_matches`, then `require_same_rows`) instead of writing; new parts go through `write_frame`.
  - `adapter_git_sha` is `ctx.git_sha`.
  - Freeze 2 contracts: `wrote 24 schemas`.
- [ ] **Run** the same command plus `tests/test_build_data_release.py`. Expected: PASS. `python scripts/build_tables.py --release 2099-01-01 --data "$SCRATCH/data" --stage measured` gives three parts of 1–50 MB and prints each refusal reason with its count.
- [ ] **Commit:** `feat: publish the curated AFND ingests as measured tables beside their raw inputs`
- [ ] **Amend the spec.** In §2.4's table, `measured.ingests`'s key becomes `(table, source, ingest_version)`, with the note "two AFND adapters share `afnd`/`afnd-2026-08`". Commit: `docs: amend design §2.4's measured.ingests key (step 1.9)`.

---

### Task 20 (step 1.9): `measured.fit_inputs` and the legacy `web-json-match` evidence

**Files:**
- Create `genomeos/tables/fit_inputs.py` (cites §2.4, check 3, §2.8, call 8).
- `contracts.py` gains `measured.fit_inputs`; `HIVE_TYPES` gains `epoch` as VARCHAR.
- Add the `fit_inputs` stage (it feeds `build_inferred`) and `--web-observations <dir>`.
- Document the anonymous download of the 30 served JSON in the runbook.
- `tests/tables_fixtures.py` gains `allele_part`, `carrier_part`, `afnd_aliases`, `web_payload` and `served_tree`.
- Tests: `tests/test_fit_inputs_table.py` (new), `tests/test_tables_inferred.py`.

**Interfaces:**
- Consumes: Task 19's `ALLELE_TABLE`, `CARRIER_TABLE`, parts and `CURATED_INGESTS`; Task 17's `afnd_legacy`; Task 12's `build_inferred(ctx, *, web_json_matches, web_json_refused)`.
- `FIT_INPUTS_SCHEMA`: `epoch, artifact, variant_id, model_version, data_version, measurement, source, ingest_version, source_record_id, evidence`. `epoch` is in-file for check 2.
- `MATCHED_FIELDS = ("ac", "an", "lat", "lon", "radius_km", "sampling_design", "disease_ascertainment_excluded", "cohort_id", "assay", "ingest_version")`.
- `fit_inputs_path(epoch: str) -> str` → `tables/v1/measured/fit_inputs/epoch=<R>/part-0.parquet`.
- `class WebJsonMismatch(ValueError)` and `@dataclass(frozen=True) class WebObservations(artifact, variant_id, model_version, data_version, measurement, registry_version, rows: pd.DataFrame)`.
- Functions:
  - `parse_web_observations(payload: bytes, *, expected_sha256: str) -> WebObservations`.
  - `ingest_key_for(variant_id: str, measurement: str, data_version: str) -> tuple[str, str, str] | None`: `None` when `data_version` is not in `INGEST_FOR_DATA_VERSION`; under a listed one, `hla:` → `(ALLELE_TABLE, "afnd_frequencies", iv)`, `cyt:` → `(ALLELE_TABLE, "afnd", iv)`, `kir:` with `carrier_frequency` → `(CARRIER_TABLE, "afnd", iv)`; `kir:` with `allele_frequency` raises "carrier"; any other prefix raises "no reviewed ingest".
  - `match_web_json(web: WebObservations, part: pd.DataFrame, *, aliases: pd.DataFrame) -> pd.DataFrame`.
  - `fit_record_rows(artifact: str, observations: pd.DataFrame, *, measurement: str, part: pd.DataFrame, epoch: str) -> pd.DataFrame` (check 3).
  - `new_rows(rows: pd.DataFrame, *, already: frozenset[str]) -> pd.DataFrame`, `matched_artifacts(rows: pd.DataFrame) -> frozenset[str]`.
- `build_tables`:
  - `INGEST_FOR_DATA_VERSION = {"afnd-2026-08": "afnd-2026-08"}`; `WEB_JSON_REFUSED: dict[str, str] = {}` (reviewed).
  - `load_served_web_observations(catalog: Mapping[str, Any], root: Path) -> tuple[WebObservations, ...]`.
  - `build_fit_inputs(ctx: BuildContext, *, web: Sequence[WebObservations], web_json_refused: Mapping[str, str] = WEB_JSON_REFUSED) -> pd.DataFrame`.
- Fixtures (`tests/tables_fixtures.py`):
  - `allele_part`, `carrier_part`: Task 19's AF and KIR parts over `tests/fixtures/afnd_frequencies_mixed.tsv`;
  - `afnd_aliases`: the alias frame of `reference.afnd_legacy(data/raw/afnd_populations.tsv)`;
  - `web_payload(part, variant_id, *, edit: tuple[int, str] | None = None) -> WebObservations`: the JSON as `export_atlas_web` serves it, KIR counts through `as_binomial`, with `edit=(row, field)` changing that value;
  - `served_tree`: `fixture_tree` plus `ART = "hla__dqb1-03-01__v3__afnd-2026-08"` (format 2, res 4) and the AF part, with `.ctx` (its `BuildContext`), `.web` (a one-element tuple: ART's `web_payload`) and `.drifted_web` (the same with row 0's `ac` + 1).

- [ ] **Test** (`tests/test_fit_inputs_table.py`):
```python
@pytest.mark.parametrize("field", fit_inputs.MATCHED_FIELDS)
def test_any_differing_field_is_a_mismatch(allele_part, afnd_aliases, field):
    with pytest.raises(fit_inputs.WebJsonMismatch, match=field):
        fit_inputs.match_web_json(web_payload(allele_part, "hla:dqb1-03-01", edit=(0, field)), allele_part, aliases=afnd_aliases)
def test_an_unlisted_mismatch_stops_the_build_and_a_listed_one_is_none(served_tree):
    with pytest.raises(fit_inputs.WebJsonMismatch): build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.drifted_web)
    rows = build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.drifted_web, web_json_refused={ART: "AFND re-ingest differs from the served JSON in ac"})
    assert ART not in set(rows["artifact"])
```
  - `test_ingest_key_routes_by_prefix`: `("hla:dqb1-03-01", "allele_frequency", "afnd-2026-08")` → `(ALLELE_TABLE, "afnd_frequencies", "afnd-2026-08")`; `("cyt:il-6-174-c", …)` → `(ALLELE_TABLE, "afnd", "afnd-2026-08")`; `("kir:2dl1", "carrier_frequency", …)` → `(CARRIER_TABLE, "afnd", "afnd-2026-08")`; `("kir:2dl1", "allele_frequency", …)` → "carrier"; `("chr11-5227002-T-A", "allele_frequency", "afnd-2026-08")` → "no reviewed ingest"; `("chr11-5227002-T-A", "allele_frequency", "map-2026-08")` → `None`.
  - `test_a_web_json_whose_digest_differs_is_refused` → "sha256".
  - `test_radius_is_compared_exactly_not_rounded`: `radius_km + 1e-9` → "radius_km".
  - `test_a_missing_record_is_a_mismatch`: one row dropped → "count".
  - `test_a_population_label_must_resolve`: an unknown label → "population_label".
  - `test_kir_matches_its_carrier_part_and_not_the_allele_part`: matched against `carrier_part` it passes; against `allele_part` → "carrier".
  - `test_check_3_fit_records_must_appear_identically`: `ac + 1` in the observations → "ac".
  - `test_new_rows_skip_matched_artifacts`: `new_rows(rows, already=frozenset({ART}))` is empty.
  - `test_check_2_compares_the_fit_inputs_epoch`: a part at `epoch=2026-11-20/` holding rows with `epoch` `2026-11-21` → "epoch".
  - `tests/test_tables_inferred.py`, `test_inferred_evidence_comes_from_the_matches`: after `build_fit_inputs`, ART's `fit_input_evidence` is `web-json-match`, and no artifact's is null.
- [ ] **Run** `python -m pytest tests/test_fit_inputs_table.py tests/test_tables_inferred.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.tables.fit_inputs'`.
- [ ] **Implement.**
  - `match_web_json` takes the part `ingest_key_for` routes to; carriers compare against `carriers`/`n_individuals`.
  - It requires the exact record set and compares `MATCHED_FIELDS` with `==` on parsed values.
  - It resolves labels through the `afnd-2026-08` aliases. Every error names the artifact, the record and the field.
  - `build_fit_inputs` verifies each file against `observations_sha256` (a missing file is an error). An artifact whose `ingest_key_for` is `None` gets `none` with "no published ingest for <data_version>"; refused artifacts get `none` with the stated reason.
  - Freeze 1 contract: `wrote 25 schemas`.
- [ ] **Run** the same command. Expected: PASS.
- [ ] **Real check:** download the served JSON into `$SCRATCH/web`, then `python scripts/build_tables.py --release 2099-01-01 --data "$SCRATCH/data" --web-observations "$SCRATCH/web"`. Expected: `web-json-match: 28 artifacts (24 allele_frequency, 4 carrier_frequency)` (20 `hla:` through `afnd_frequencies`, 4 `cyt:` and 4 `kir:` through `afnd`) and `none: 33 artifacts, each with a reason`. On a mismatch, never loosen the comparison; list the artifact in `WEB_JSON_REFUSED` in its own reviewed commit.
- [ ] **Commit:** `feat: record legacy web-json-match fit inputs and every artifact's fit_input_evidence (advances #45)`

---

### Task 21 (step 1.10): The browser accepts projected observation rows

**Files:** `website/src/atlas/contracts.ts`; `website/tests/atlas-contracts.test.ts`.

**Interfaces:**
- `observationSchema` stays strict, with optional `measurement` (`'allele_frequency' | 'carrier_frequency'`), `population_id`, `rsid` (nullable) and `source`.
- `observationArtifactSchema` refines:
  - every row has all four keys, or none does;
  - a row is `carrier_frequency` exactly when the artifact is.

- [ ] **Test** with `projected = {...observation, measurement: 'allele_frequency', population_id: 'afnd-albania-pop-2', rsid: 'rs334', source: 'map_surveys'}`:
  - `accepts projected rows, including rsid null`;
  - `refuses a mix of projected and legacy rows`: → `/every row/`;
  - `refuses a carrier mismatch either way`: → `/carrier_frequency/`;
  - `refuses an unknown key and phenotype_frequency`: `freq: 0.1` throws, and so does `measurement: 'phenotype_frequency'`.
- [ ] **Run** `(cd website && npx vitest run tests/atlas-contracts.test.ts)`. Expected: FAIL, an unrecognized key.
- [ ] **Implement** with `superRefine` and these messages:
  - `'a projected observations object carries population_id, rsid, source and measurement on every row'`;
  - `'observation rows count carrier_frequency exactly when the artifact measurement is carrier_frequency'`.
- [ ] **Run** `(cd website && npx vitest run tests/atlas-contracts.test.ts tests/atlas-public-data.test.ts && npm run check)`. Expected: PASS.
- [ ] **Commit:** `feat(web): accept projected observation rows (population_id, rsid, source, measurement)`

---

### Task 22 (step 1.10): Observations JSON as a projection of the fit input and the registry (web format 1.1)

**Files:**
- New: `genomeos/publication/web_observations.py` (cites §2.8, call 9).
- `scripts/export_atlas_web.py`:
  - `_serialize_observations` moves out (the file is at 798 logical lines);
  - `export_catalog` gains keyword-only `registry`, `released_inputs` and `published_catalog`;
  - new flags `--registry` and `--published-catalog`.
- `WEB_FORMAT_VERSION = "1.1"` and `ATLAS_WEB_FORMAT_VERSION = '1.1'`; only `format_version` changes in `website/public/data/atlas/catalog.json`.
- Regenerate the two fixture catalogs (`tests/fixtures/atlas-web/regenerate.py`).
- `docs/web-data-format.md` and `docs/data-store.md`.
- Tests: `tests/test_web_observations.py` (new), `tests/test_export_atlas_web.py`.

**Interfaces:**
- Consumes: Task 21's client; Task 17's `reference.read_reference`.
- Constants: `LEGACY_ROW_FIELDS` (17), `PROJECTION_FIELDS = ("measurement", "population_id", "rsid", "source")`, `ROW_MEASUREMENTS = ("allele_frequency", "carrier_frequency")`.
- `@dataclass(frozen=True) class PinnedRegistry(version: str, population_ids: frozenset[str])`.
- `pinned_registry(populations: pd.DataFrame | None, aliases: pd.DataFrame) -> PinnedRegistry`: the single `registry_version`, with ids from both frames.
- `serialize_rows(observations: pd.DataFrame, evidence, *, source_url: str, dataset: str, revision: str) -> list[dict[str, Any]]`.
- `project_rows(consumed: pd.DataFrame, evidence, *, measurement: str, registry: PinnedRegistry, source_url: str, dataset: str, revision: str) -> list[dict[str, Any]]`.
- `released_inputs(manifests: Sequence[Mapping[str, Any]]) -> dict[str, str]`.
- `require_published_digests(published_catalog: Mapping[str, Any], *, variant_id: str, model_version: str, data_version: str, digests: Mapping[str, str]) -> None`.
- `--registry` takes a reference folder, read with `reference.read_reference`.

- [ ] **Test:**
```python
def test_a_projected_row_is_the_legacy_row_plus_four_fields():
    legacy, projected = wo.serialize_rows(rows, ev, **WHERE), wo.project_rows(rows, ev, measurement="allele_frequency", registry=REGISTRY, **WHERE)
    assert len(wo.LEGACY_ROW_FIELDS) == 17 and [{k: r[k] for k in wo.LEGACY_ROW_FIELDS} for r in projected] == legacy
    assert projected[1] == {**legacy[1], "measurement": "allele_frequency", "population_id": "pop-1", "rsid": None, "source": "map_hbs"}
```
  - `tests/test_web_observations.py`:
    - `test_projected_rows_keep_integer_counts_and_no_surface_value`: `ac`/`an` are `int`, and no key starts with `post_`.
    - `test_a_carrier_projection_keeps_ac_and_an`.
    - `test_projection_requires_a_row_measurement`: `None`, `""` and `"phenotype_frequency"` each raise "measurement".
    - `test_a_population_outside_the_registry_is_refused`: → `r"pop-5.*not in population registry 2026-11-20\+sha256\.ab12"`.
    - `test_projection_keeps_the_fit_input_order`.
    - `test_pinned_registry_has_one_registry_version`: two versions → "registry_version".
    - `test_released_inputs_of_the_committed_manifests_is_empty`: `== {}`.
    - `test_a_published_observations_json_is_never_regenerated`: other digests → `r"never regenerated.*observations_sha256"`.
  - `tests/test_export_atlas_web.py`:
    - `test_an_artifact_with_a_fit_input_serves_its_projection`: the row carries the four fields and its radius 73.25.
    - `test_an_artifact_without_a_fit_input_serves_legacy_rows_only`: each row's keys are `LEGACY_ROW_FIELDS`.
    - `test_a_projection_without_a_registry_writes_nothing`: → "--registry", and no file is written.
    - `test_a_projection_under_another_registry_is_refused`: the message names both versions.
    - `test_a_projection_needs_a_committed_release`: → "no committed release".
    - `test_a_carrier_artifact_projects_carrier_rows` and `test_a_contradicting_measurement_is_refused` ("carrier_frequency").
    - `test_a_changed_reexport_is_refused`: → "never regenerated".
- [ ] **Run** `python -m pytest tests/test_web_observations.py tests/test_export_atlas_web.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.publication.web_observations'`.
- [ ] **Implement:**
  - `serialize_rows` is the moved serializer, unchanged.
  - The projection runs when the manifest records `observations`. Before any write it requires, in order:
    1. a registry;
    2. an equal `registry_version`;
    3. `released_inputs[dir]` equal to the manifest's sha256;
    4. agreement on `carrier_frequency`.
  - Check `require_published_digests` before each write.
  - `export_catalog` prints `projected observations: <n>`.
  - Raise both versions to 1.1. Regenerating changes only `format_version` in the two fixture catalogs.
  - `docs/web-data-format.md` gains the 1.1 rule (F5's amendment):
    - all four keys or none, with `measurement` required;
    - the client accepted the keys first;
    - this is the only per-object MINOR;
    - `schema_version` stays 1.
- [ ] **Run** the same command, `(cd website && npx vitest run tests/atlas-format-version.test.ts tests/atlas-contracts.test.ts tests/atlas-fixture-catalogs.test.ts)` and `python scripts/check_module_size.py`. Expected: PASS, with `export_atlas_web.py` under 800.
- [ ] **Commit:** `feat(web): serve an artifact's observations as a projection of its fit input (web format 1.1)`

---

### Task 23 (step 1.11): Artifact format 4: zstd, 8,192-row groups, `h3_r0` and `h3_parent_r3`

**Files:**
- `genomeos/surfaces/artifacts.py` (cites §2.5):
  - the constants;
  - `ArtifactManifest.__post_init__`, `cell_table`, `publish` and `read`;
  - `_validate_current` (existing): checks `FORMAT_THREE_COLUMNS` instead of `ARTIFACT_COLUMNS`, and runs for formats 3 and 4;
  - new `_validate_h3_parents(frame: pd.DataFrame, resolution: int, *, context: str) -> None` and `_require_cells_encoding(path: Path, *, context: str) -> None`, for format 4 only.
- `genomeos/publication/web_format.py` and `export_atlas_web._validated_surface`; `docs/data-store.md`.
- Test: `tests/test_artifacts.py`, `tests/test_web_format.py` and `tests/test_export_atlas_web.py`.

**Interfaces:**
- Consumes: Task 22's `export_atlas_web.py` (after the serializer moved out) and `web_format.py` at 1.1.
- `ARTIFACT_FORMAT = 4` and `READABLE_ARTIFACT_FORMATS = frozenset({1, 2, 3, 4})`.
- `FORMAT_THREE_COLUMNS` (today's 15) and `H3_PARENT_COLUMNS = ("h3_r0", "h3_parent_r3")`; `ARTIFACT_COLUMNS = FORMAT_THREE_COLUMNS + H3_PARENT_COLUMNS`.
- `CELLS_COMPRESSION = "zstd"`, `CELLS_ROW_GROUP_ROWS = 8192`, `MIN_FORMAT_FOUR_RESOLUTION = 3`.
- `web_format.WEB_ARTIFACT_FORMATS = frozenset({1, 2, 3})` and `require_web_artifact_format(value: object) -> int`.

- [ ] **Test.** `_frame(n, variant_id)` keeps its signature for format-3 tests. New `_valid_frame(res: int = 4, n: int | None = None) -> pd.DataFrame` uses the first `n` of `sorted(grid_disk(latlng_to_cell(9.0, -1.5, res), 60))` (10,420 cells at res 4).
  - `test_a_new_artifact_is_format_4_with_h3_parents`: columns `FORMAT_THREE_COLUMNS + ("h3_r0", "h3_parent_r3")`; at res 3, `h3_parent_r3 == h3_index`.
  - `test_format_4_writes_zstd_8192_row_groups`: `_valid_frame(4, 8_292)` gives row groups `[8_192, 100]`, all ZSTD.
  - `test_cell_table_writes_the_parents`.
  - `test_bad_parents_are_refused_before_any_file_exists` → "h3_r0".
  - `test_an_off_resolution_cell_or_resolution_2_is_refused` → "resolution".
  - `test_a_format_4_file_rewritten_as_snappy_is_refused_on_read` → "zstd".
  - `test_format_3_stays_readable_without_the_parents`.
  - `tests/test_web_format.py`, `test_the_web_knows_formats_1_to_3`: `4`, `True`, `3.0` and `"3"` raise "artifact_format", and the set equals the `z.literal`s in `contracts.ts`.
  - `tests/test_export_atlas_web.py`, `test_the_exporter_refuses_format_4_before_writing`: → `r"artifact_format 4.*docs/web-data-format\.md"`, and no JSON is written.
- [ ] **Run** `python -m pytest tests/test_artifacts.py tests/test_web_format.py tests/test_export_atlas_web.py -q`. Expected: `ImportError: cannot import name 'FORMAT_THREE_COLUMNS'`.
- [ ] **Implement.**
  - `cell_table` adds `cell_to_parent(cell, 0)` and `cell_to_parent(cell, 3)`.
  - `publish` validates first, then writes with `compression=CELLS_COMPRESSION, row_group_size=CELLS_ROW_GROUP_ROWS`.
  - `_require_cells_encoding`: all chunks are ZSTD, and every row group but the last holds 8,192 rows.
  - `_validated_surface` calls `require_web_artifact_format` first, and the grid test `in {2, 3}` becomes `>= 2`.
- [ ] **Run** the same command plus `tests/test_publish_artifacts.py tests/test_atlas_web_fixtures.py`, and `python scripts/check_module_size.py`. Expected: PASS.
- [ ] **Commit:** `feat(surfaces): write new artifacts as format 4 (zstd, 8,192-row groups, h3 parents)`

---

### Task 24 (step 1.12): Build the surface model without sampling it

**Files:**
- `genomeos/surfaces/fit.py`: `SurfaceModel`, `build_surface_model` and `free_variable_shapes`. `fit_surface` keeps its signature and seed.
- `tests/surface_fixtures.py` (new) takes `FAST_CONFIG`, `HBS` and `_observations` (renamed `synthetic_observations`) out of `tests/test_surface_fit.py`, which imports them back.
- Test: `tests/test_surface_model.py` (new).

**Interfaces:**
- `@dataclass(frozen=True) class SurfaceModel(model: pm.Model, observations: pd.DataFrame, design_levels: tuple[str, ...], beta_design_applied: bool, beta_cohort_applied: bool, cohorts: tuple[str, ...], lengthscale_prior_km: float, inducing: np.ndarray, footprint_metadata: Mapping[str, Any])`. `design_levels` puts the reference first, and `inducing` is `(0, 3)` under hsgp.
- `build_surface_model(observations: pd.DataFrame, config: FitConfig, *, observation_support=None) -> SurfaceModel`.
- `free_variable_shapes(model: pm.Model) -> dict[str, tuple[int, ...]]`.
- `FAST_CONFIG = FitConfig(draws=800, tune=1000, chains=4)`.

- [ ] **Test.**
  - `test_building_the_model_never_samples`: with `pm.sample` patched to fail, `design_levels == ("population_random", "healthy_reference")` and the inducing shape is `(0, 3)`.
  - `test_the_built_model_is_the_fits_model`: the same free-variable shapes, an equal `compile_logp()` at `initial_point(random_seed=SEED)`, equal observations, and `design_levels[1:]` matching.
  - `test_inducing_points_rebuild_exactly`: for `h3` and `kmeans` with 12.
- [ ] **Run** `python -m pytest tests/test_surface_model.py -q`. Expected: `ImportError: cannot import name 'build_surface_model'`.
- [ ] **Implement.** Move everything from validation to the end of the `with pm.Model()` block, except `pm.sample`. Add no new seed.
- [ ] **Run** the same command and `tests/test_surface_fit.py` (including `test_fit_is_deterministic_given_the_same_seed`). Expected: PASS.
- [ ] **Commit:** `refactor(surfaces): build a surface's PyMC model without sampling it (#471)`

---

### Task 25 (step 1.12): A safe model export, and a loader that never unpickles (#471)

**Files:**
- Create `genomeos/surfaces/model_export.py` (cites §2.1, §2.3, #471) and `scripts/export_models.py`.
- `fetch_data.released_dirs`.
- `tests/surface_fixtures.py`.
- Tests: `tests/test_model_export.py` and `tests/test_export_models.py` (new), `tests/test_fetch_data.py`.

**Interfaces:**
- Consumes: Task 24's `build_surface_model` and `free_variable_shapes`.
- Constants:
  - `EXPORT_SCHEMA = "genomeos-model-export"`, `EXPORT_FORMAT = 1`.
  - `MODEL_MANIFEST = "manifest.json"`, written last; `MODEL_FILE = "model.json"`; `INDUCING_FILE = "inducing_points.npy"`.
  - `POSTERIOR_DIR = "posterior"`, holding one float64 `.npy` per free variable, `(chains, draws, *shape)`.
  - `REPRODUCTION_SAMPLE = 64`, `REPRODUCTION_ATOL = 1e-6`.
- `export_model(fit: SurfaceFit, artifact_dir: Path, out_root: Path) -> Path`, `load_model_export(model_dir: Path, artifact_dir: Path) -> SurfaceFit`, `require_reproduces_cells(fit: SurfaceFit, cells: pd.DataFrame) -> None`.
- Manifest keys: `schema, export_format, artifact, fit_input_sha256, files, software`.
- `model.json` keys: `variant_id, config, beta_design_applied, beta_cohort_applied, design_levels, lengthscale_prior_km, inducing_spacing_ratio, correlation_range_km, free_variables`. Canonical JSON with `allow_nan=False`.
- `fit_path_for(fits: Path, variant_id: str) -> Path`. `main` takes `--fits`, `--artifacts`, `--out` (default `data/store/models`) and repeatable `--artifact`.
- `fetch_data.released_dirs(prefix: str, releases: Path = RELEASES) -> dict[str, str]`.
- `tests/surface_fixtures.published_artifact(fit, root, *, measurement="allele_frequency", observations=None) -> Path`: `v9`, `map-test`, res 3.

- [ ] **Test.**
```python
def test_an_exported_fit_predicts_what_the_fit_predicts(fit, exported):
    loaded = load_model_export(*exported)
    for column in ("post_median", "post_mean", "post_sd", "q025", "q975"):
        np.testing.assert_allclose(fit.predict(lat=LAT, lon=LON)[column], loaded.predict(lat=LAT, lon=LON)[column])
def test_loading_refuses_a_posterior_whose_variables_are_not_the_rebuilt_models(exported, tmp_path):
    # rename posterior/amplitude.npy → amplitude_renamed.npy; rewrite model.json and the manifest digests to match
    with pytest.raises(ValueError, match=r"missing \['amplitude'\].*unknown \['amplitude_renamed'\]"): load_model_export(model_dir, artifact)
```
  - `test_an_export_holds_only_json_and_float64_npy`: posterior stems are the free RVs (no `f`, `p` or `freq_pred`); two exports are byte-identical; with `pickle.load`/`pickle.loads` patched to fail, loading succeeds.
  - `test_loading_refuses_a_tampered_export`, parametrized: a changed byte → "sha256"; an extra file → "not listed"; `seed` dropped from `config` → "config"; another fit input → "fit input".
  - `test_exporting_refuses_a_fit_that_is_not_the_artifacts`, parametrized: another input → "not the fit input"; another range → "correlation_range_km"; another seed → "seed"; other levels → "design_levels"; no input → "fit input"; a footprint → "footprint"; an existing target → `FileExistsError`.
  - `test_cells_reproduce_and_a_drift_is_named`: `post_median + 1e-3` → "post_median".
  - `test_a_carrier_artifact_round_trips`.
  - `tests/test_export_models.py`: `test_the_cli_names_its_flags` ("--artifacts" in `--help`); `test_the_cli_refuses_a_released_artifact` ("already published"); `test_the_cli_refuses_an_artifact_without_a_fit_input` ("fit input").
  - `tests/test_fetch_data.py`, `test_released_dirs_maps_each_directory_to_its_first_release`: → `{"a__v4__map-x": "2026-12-01"}`.
- [ ] **Run** `python -m pytest tests/test_model_export.py tests/test_export_models.py tests/test_fetch_data.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.surfaces.model_export'`.
- [ ] **Implement `export_model`.** Before writing anything, it requires:
  - the fit input (through `as_binomial` for carriers) equals `fit.observations`;
  - the manifest's variant, likelihood, sigma, seed and range equal the fit's;
  - `build_surface_model` reproduces the levels, flags, prior and shapes;
  - the target directory does not exist.

  Arrays are written with `write_array(..., version=(1, 0), allow_pickle=False)`.
- [ ] **Implement `load_model_export`.** It verifies in order:
  1. the closed manifest, the file set and the digests;
  2. the input sha256;
  3. `config` against exactly the `FitConfig` fields;
  4. the rebuilt model against `model.json` and the inducing points;
  5. the posterior stems against the free variables, naming the missing and the unknown.

  It loads with `allow_pickle=False`, then `az.from_dict`.
- [ ] **Implement the rest.** `require_reproduces_cells` compares the first 64 cells at `rtol=0, atol=1e-6`. The CLI refuses released or input-less artifacts and deletes only what it created.
- [ ] **Run** the same command. Expected: PASS.
- [ ] **Commit:** `feat(surfaces): export a fitted surface without pickle and rebuild it from code (#471)`

---

### Task 26 (step 1.12): Release `store/models/`: R0, closed directories, the fit-input binding and the release guard

**Files:**
- Create `genomeos/publication/model_exports.py` (pure; cites §2.1, §4.2 R0).
- `access_policy.check_release_guard`.
- `data_release.py`: `MODEL_PREFIX` and `closed_directory`; the closed-directory rules now apply to both prefixes.
- `build_data_release.py`:
  - `INCLUDE += ("store/models",)` and `OPTIONAL_ROOTS += ("store/models",)`;
  - a `_RULES` entry giving each model its artifact's data source;
  - `check_models`;
  - the guard, after `build_manifest`.
- `export_models.py` uses `dr.MODEL_PREFIX`.
- `docs/data-store.md`: the layout, the durability row, the runbook's `export_models.py` line and the guard.
- Test: `tests/test_model_exports.py` (new), `tests/test_access_policy.py`, `tests/test_build_data_release.py` and `tests/test_data_release.py`.

**Interfaces:**
- Consumes: Task 16's `access_policy` constants; Task 25's layout constants.
- `dr.MODEL_PREFIX = "store/models/"` and `dr.closed_directory(path: str) -> tuple[str, str] | None`.
- `model_exports`: the layout constants, `EXPORT_FORMATS = frozenset({1})`, `@dataclass(frozen=True) class ModelFile(sha256: str, bytes: int)` and `check_model_exports(manifests: Mapping[str, Mapping[str, Any]], files: Mapping[str, ModelFile], *, artifact_inputs: Mapping[str, str]) -> None`.
- `check_release_guard(objects: Sequence[Mapping[str, Any]]) -> int`. In phase 1 every object is open and unmirrored, so it sums all the bytes; over the cap it raises "guard", naming the total, the 2 GiB cap and the fixes.
- `check_models(data_root: Path, records: Sequence[dr.FileRecord], previous: Sequence[Mapping[str, Any]]) -> None`.

- [ ] **Test.** `_model(root, artifact, *, fit_input_sha256=None)` writes a model with numpy only.
  - `test_a_model_ships_beside_its_artifact`: sources `{("map",)}`.
  - `test_a_model_is_refused`, parametrized:
    - a model without its artifact → "no artifact";
    - another input, or an artifact released without one → "fit input";
    - an unlisted file → "not listed";
    - wrong bytes → "sha256";
    - a `.pkl`, or an object-dtype `.npy` → "pickle";
    - a missing models root after one was published → "store/models is missing";
    - a released directory that gains a file → "cannot gain".
  - `test_the_release_guard`: the cap is `2_147_483_648`; exactly at it passes, one byte over fails with "2 GiB"; with the cap monkeypatched to 100 a release fails with "guard"; every committed release is within it, and its total equals `totals.bytes`.
  - `test_the_layout_constants_are_model_exports`: they equal `genomeos.surfaces.model_export`'s, and an `export_model` output passes the rule.
  - `test_a_misdescribed_manifest_is_refused`: `export_format` 2, a wrong `artifact`, or an extra field.
  - `test_closed_directory`: `closed_directory("store/models/a__v4__map-x/posterior/lengthscale.npy") == ("store/models/", "a__v4__map-x")`, and `validation/x.json` → `None`.
- [ ] **Run** `python -m pytest tests/test_model_exports.py tests/test_access_policy.py tests/test_build_data_release.py tests/test_data_release.py -q`. Expected: `ModuleNotFoundError: No module named 'genomeos.publication.model_exports'`.
- [ ] **Implement.**
  - `check_model_exports` requires: closed keys; a known schema and format; `artifact` equal to the directory; an artifact with an input ("no artifact with a fit input …"); an equal input sha256; files equal to the manifest's.
  - `collect` keeps the R0 refusals before hashing.
  - `artifact_inputs` comes from this release's and earlier manifests' `observations.parquet` digests.
- [ ] **Run** the same command. Expected: PASS.
- [ ] **Commit:** `feat(data): release safe model exports under store/models within the release guard (#471)`

---

### Task 27 (steps 1.7–1.12): Cut release 2; the owner uploads and publishes the web

**Files:** `data/releases/<R2>.json` and `data/catalog/catalog.sql`.

**Interfaces:** release `<R2>`. Step 2.6 reads `1.0.0-<sha8>`'s `registry_version`.

- [ ] **Preconditions.**
  - Tasks 16–26 have merged.
  - Task 18's TSV is committed, or the owner has written that release 2 ships without it (then 2.6 waits).
  - Release 1 verifies remotely.
- [ ] **Build.**
  - Fetch, place the harvests and caches as in Task 16, and download the served JSON into `$SCRATCH/web`.
  - `python scripts/build_tables.py --release <R2> --web-observations "$SCRATCH/web"`. Expected:
    - `meta.release_objects` has 245 + 248 + 431 rows, and `meta.sources` 21;
    - three reference folders, three measured parts plus `ingests`;
    - `web-json-match: 28 artifacts (24 allele_frequency, 4 carrier_frequency)`;
    - `inferred.artifacts: 61 rows; fit_input_evidence web-json-match 28, none 33`;
    - an epoch with 0 artifacts.
  - `python scripts/build_data_release.py --release <R2>`: `catalog: 14 views …, identical over two builds`; the guard total is ≤ 2 GiB; a rerun prints `unchanged`.
  - Also expected, because no released artifact has a fit input:
    - `store/models: absent (no released artifact has a fit input)`: `data/store/models` does not exist, and the manifest lists nothing under it;
    - `projected observations: 0`, printed by the 1.10 export (`export_atlas_web.py` with `--registry` and `--published-catalog`), which writes no projected observations JSON.
- [ ] **Smoke.** `python scripts/smoke_catalog.py --catalog data/catalog/atlas.duckdb --local data/` is golden, and `uv run --no-project --python 3.12 --with duckdb==1.2.2 python -I scripts/check_catalog_attach.py --catalog data/catalog/atlas.duckdb --local data --expect-views 14` prints `14 views read offline`. The gates pass. Commit `data: release <R2> with the registry, the measured tables and their raw inputs (data platform steps 1.7-1.12)` and open a draft PR whose body tells the owner that the upload holds no `store/models/` and the web publish changes only `format_version`.
- [ ] **(owner)** The publish runbook, `--verify-remote` and `smoke_catalog.py --release <R2>`; then `publish_atlas_web.py` for `format_version` 1.1 (step 1.10).
- [ ] **Merge.** Mark the PR ready and merge after CI.

---

### Task 28 (step 1.13): Data-store CORS for range reads, and an anonymous probe

**Files:**
- `deploy/data-store-cors.json`.
- `scripts/provision_data_store_bucket.py` (`cors_policy`; cites 1.13).
- `scripts/check_data_store_cors.py` (new).
- A CORS bullet in `docs/data-store.md`.
- Test: `tests/test_provision_data_store_bucket.py` and `tests/test_check_data_store_cors.py` (new).

**Interfaces:**
- Consumes: Task 6's `dr.release_ids`.
- `cors_policy() -> list[dict[str, Any]]` returns `[{"origin": ["*"], "method": ["GET", "HEAD"], "responseHeader": ["Content-Length", "Content-Type", "ETag", "Content-Range", "Accept-Ranges", "Range"], "maxAgeSeconds": 3600}]`, which equals the file.
- `check_data_store_cors.py`:
  - `RANGE_PROBE_BYTES = 1024` and `PROBE_ORIGIN = web_layout.PRODUCTION_ORIGINS[0]`;
  - `range_problems(status: int, headers: Mapping[str, str], body_length: int, expected_bytes: int) -> list[str]` and `preflight_problems(status: int, headers: Mapping[str, str]) -> list[str]`;
  - `probe(base: str, key: str, expected_bytes: int, *, origin: str) -> list[str]`;
  - `main(argv: Sequence[str] | None = None) -> int`, with `--path`, `--base-url` (through `fetch_data.base_url`), `--release` and `--releases`. The newest release comes from `dr.release_ids`.

- [ ] **Test.**
  - `test_the_policy_is_the_committed_file`.
  - `test_a_bucket_with_the_old_cors_gets_one_mutation`: exactly `["storage", "buckets", "update", f"gs://{BUCKET}", "--cors-file=deploy/data-store-cors.json"]`, and the output reads "CORS: set from deploy/data-store-cors.json".
  - `test_probe_against_loopback_buckets`, parametrized:
    - a good bucket → `[]`;
    - one that ignores Range → "ranged GET returned 200, not 206";
    - one that hides Content-Range → "Access-Control-Expose-Headers lacks Content-Range";
    - a wrong total → "Content-Range is 'bytes 0-1023/4000', expected 'bytes 0-1023/4096'";
    - a refused preflight → "preflight does not allow the Range request header".
  - `test_main_probes_the_newest_catalog`: `catalog/atlas.duckdb` of the newest manifest, else its first `.parquet`.
  - `test_main_skips_the_withdrawn_list`: a releases dir holding `WITHDRAWN.json` probes the newest real release.
  - `test_another_host_exits_1`.
- [ ] **Run** `python -m pytest tests/test_provision_data_store_bucket.py tests/test_check_data_store_cors.py -q`. Expected: the policy test fails, and `FileNotFoundError` for the new script.
- [ ] **Implement `probe`** with the standard library only and no caching, sending:
  - an `OPTIONS` with `GET` and the `range` header;
  - `GET Range: bytes=0-1023`, which must return 206, `bytes 0-1023/<manifest bytes>` and 1,024 bytes, with ACAO `*` or the origin and ACEH including `Content-Range` and `Accept-Ranges` (case-insensitive);
  - a `HEAD`, which must return `Accept-Ranges: bytes`.
- [ ] **Run** the same command and `tests/test_web_layout.py`. Expected: PASS.
- [ ] **Commit:** `data: expose range headers on the data store for browser SQL (spec 1.13)`
- [ ] **(owner)** Run `provision_data_store_bucket.py`, then `check_data_store_cors.py`. Expected: only `CORS: set from …` changes, and every line is ok. This is the gate "ranged GET 206".

---

### Task 29 (step 1.13): The pinned DuckDB-WASM engine and the range-read decision

**Files:**
- Create `website/src/atlas/browser-sql/{engine,route}.ts` and `website/scripts/serve-data-store.mjs`. Modify `e2e-hooks.ts` and `boot.ts`.
- Create `scripts/build_browser_sql_fixture.py` and its output, `website/tests/fixtures/data-store/`.
- `package.json` gains `serve:data-store`.
- Playwright:
  - `playwright.config.ts`: a webServer on 4324, and `testMatch` gains `browser-sql.spec.ts`.
  - `playwright.live.config.ts` (new), never run in CI.
- `pages.yml` adds `deploy/data-store-cors.json` to its paths.
- Tests: `website/tests/{data-store-server.test.ts, browser-sql.spec.ts, browser-sql-live.spec.ts}`, `tests/test_browser_sql_fixture.py`.

**Interfaces:**
- Consumes: Task 14's pin; Task 13's `render_catalog_sql` and `build_catalog_db`.
- `engine.ts`: `MAX_RESULT_ROWS = 1000`; `QueryResult {columns: string[], rows: string[][], truncated: boolean}`; `BrowserSql {attachCatalog(url: string): Promise<void>, catalogObjects(): Promise<string[]>, run(sql: string): Promise<QueryResult>, close(): Promise<void>}`; `openBrowserSql(): Promise<BrowserSql>`.
- `route.ts`: `WEBSITE_LOOKUP_ROUTE: 'range' | 'p4-api'` (read by step 2.9) and `ALLOWED_EXTENSION_HOSTS: readonly string[]`.
- `createDataStoreServer({ root, corsFile })`:
  - `/__requests` returns and clears a `{method, path, range, status, bytes}` log;
  - `/__control?force=403|404|off`;
  - `/no-range/<path>` serves the whole object.
- `build_browser_sql_fixture.py`:
  - `FIXTURE_RELEASE = "2000-01-01"`, `FIXTURE_BASE_URL = "http://127.0.0.1:4324/"`, `PROBE_KEY = "80000000000e000"` (a sort key, not an H3 cell).
  - `build_fixture(out: Path, base_url: str) -> None`, through `render_catalog_sql(..., base_url=…)` and `build_catalog_db`.
- Fixture:
  - `range_probe.parquet` at `releases/2000-01-01/range_probe.parquet`: 98,304 rows (`h3_index = '8' || format('{:014x}', i)`, `post_mean = i / 98304.0`), 12 zstd groups of 8,192. It is in the manifest but no view.
  - A one-row `artifacts.parquet` (`inferred.artifacts`: HbS's `chr11-5227002-T-A`, `v3`, `map-2026-08`) and a 5-row parity file (`evidence.parity_observations`), the fixture's only two views. The parity rows, at lon 3.3792, as `lat/radius_km/(ac, an)`: `6.5244/10/(1,10)`, `10.5244/10/(2,20)`, `11.1244/20/(3,30)`, `11.1244/5/(4,40)`, `0.5244/100/(5,50)`. The disc rule admits the first three: 3 rows, `an` 60, `ac` 6.
  - The probe query: `SELECT count(*)::VARCHAR, max(post_mean)::VARCHAR FROM read_parquet('http://127.0.0.1:4324/releases/2000-01-01/range_probe.parquet') WHERE h3_index = '80000000000e000'` (row 0xe000 = 57,344; 57,344 / 98,304 = 0.5833…).

- [ ] **Server tests** (a 4,096-byte object). `(cd website && npx vitest run tests/data-store-server.test.ts)` fails, then passes.
  - A ranged GET returns 206 with `bytes 0-1023/4096` and 1,024 bytes, ACAO `*`, ACEH `Content-Length, Content-Type, ETag, Content-Range, Accept-Ranges, Range`, and `Cache-Control: public, max-age=3600`.
  - Suffix and open ranges return `bytes 3996-4095/4096` and `bytes 4000-4095/4096`.
  - Unsatisfiable or multi-part ranges return 416, and HEAD carries `Accept-Ranges: bytes`.
  - A `range` preflight is granted; `x-custom` gets no ACAO.
  - `no-range/` returns 200 with the whole object.
  - The log and forced statuses work, and a CORS document without `*` throws `/origin/`.
- [ ] **Fixture tests** (`python -m pytest tests/test_browser_sql_fixture.py -q` fails, then passes): `(98_304, 12)` rows and groups in ZSTD; exactly the two views; the manifest lists every file; a Parquet rebuild is byte-identical, and the `.duckdb` matches by view SQL.
- [ ] **Browser tests** (desktop-chromium).
  - The probe query returns `[['1', '0.5833333333333334']]`.
    - Under `'range'`: every logged request is a HEAD or a ranged 206, and under a quarter of the file is sent.
    - Under `'p4-api'`: one 200 carries the whole file.
  - A server that ignores Range fails loudly under `'range'`.
  - Only the site, the store and `ALLOWED_EXTENSION_HOSTS` are contacted.
  - The fixture catalog attaches.

  Run `(cd website && npm run test:e2e -- tests/browser-sql.spec.ts)`. Expected: FAIL, the hook is undefined.
- [ ] **Implement.**
  - Load by dynamic `import()` only, from bundles self-hosted through Vite `?url` imports of `duckdb-{mvp,eh}.wasm` and `duckdb-browser-{mvp,eh}.worker.js`; never a CDN.
  - `selectBundle`, then `instantiate`, then `open({ filesystem: { reliableHeadRequests: true, allowFullHTTPReads: WEBSITE_LOOKUP_ROUTE === 'p4-api' } })`.
  - `ATTACH … AS atlas (READ_ONLY)`.
  - Start with `'range'`. If it fails, set `'p4-api'` and record the bytes, requests, version and date in `route.ts` (cite §1.4, §3.1).
  - `ALLOWED_EXTENSION_HOSTS` starts empty. Add `extensions.duckdb.org` only if `parquet` autoloads, and say so in the PR.
- [ ] **Run** `(cd website && npm run test:e2e -- tests/browser-sql.spec.ts && npx vitest run && npm run check && npm run format:check)`. Expected: PASS.
- [ ] **Live spec** (`BROWSER_SQL_LIVE=1`):
  - The largest released `cells.parquet` reads as 206s totalling under a quarter of the object (or the route is `'p4-api'`).
  - `INSTALL h3 FROM community; LOAD h3`; `h3_h3_to_string(h3_latlng_to_cell(6.5244, 3.3792, 4))` equals h3-js.
- [ ] **Commit:** `feat(atlas): pin DuckDB-WASM and record whether it range-reads the data store (spec 1.13)`
- [ ] **(after Task 28's owner step)** `(cd website && BROWSER_SQL_LIVE=1 npx playwright test --config playwright.live.config.ts)`: 2 passed. If this disagrees with `WEBSITE_LOOKUP_ROUTE`, the live result wins (F6). The PR stays a draft until then.

---

### Task 30 (step 1.13): The "Query in your browser" panel

**Files:**
- Create `website/src/atlas/browser-sql/{examples,format,errors}.ts`, `website/src/lib/data-store-release.ts`, `website/src/components/atlas/BrowserQueryPanel.tsx` and `website/tests/fixtures/browser-sql.ts` (exports `ALL` and `HBS`).
- Modify `app.astro`, `AtlasExplorer.tsx` (`dataStoreCatalog`), `ExplorerControls.tsx` (after "Download this dataset"), `atlas.css` and `engine.ts` (`formatCell`).
- `website/tests/fixtures/data-store/manifests/` holds the fixture release's manifest and a `WITHDRAWN.json`.
- `package.json`: `build:e2e` sets `DATA_STORE_RELEASES_DIR=tests/fixtures/data-store/manifests`; `test:e2e` sets `PUBLIC_DATA_STORE_BASE_URL=http://127.0.0.1:4324/`.
- `pages.yml` adds `data/releases/**` to its paths.
- Tests: `website/tests/{browser-sql-examples,browser-sql-format,data-store-release}.test.ts` (new), `atlas-bundle.test.ts`, both specs.

**Interfaces:**
- Consumes: Task 29's `openBrowserSql`, `QueryResult`, fixture and server; Task 6's `release_ids` rule.
- `data-store-release.ts`:
  - `releaseIds(fileNames: string[]): string[]`: mirrors `dr.release_ids`; oldest first, skips `WITHDRAWN.json`, throws "neither" on any other name.
  - `DataStoreCatalogRef {release: string, url: string, sha256: string, bytes: number}`.
  - `latestDataStoreCatalog(releasesDir: string, baseUrl: string): DataStoreCatalogRef | null`, reading only `releaseIds(readdirSync(releasesDir))`.
  - `releaseSortKey(release: string): [string, number]` and `dataStoreBaseFrom(value: string | undefined, catalogPath: string): string`.
- `browserSqlExamples(objects: readonly string[], artifact: {variantId: string, modelVersion: string, dataVersion: string}): BrowserSqlExample[]`, where an example is `{id: 'observations' | 'surfaces' | 'artifact' | 'parity-near-lagos', kind: 'measured' | 'inferred', label: string, requires: string, sql: string}`.
- `sqlString(value: string): string`, `attachStatement(url: string): string`, `formatCell(value: unknown): string`.
- `explainQueryError(message: string): {kind: 'paused' | 'withdrawn' | 'sql', text: string}`.
- `NO_WASM_TEXT`, `gnomadBrowserUrl(variantId: string, dataset: string): string`.
- `BrowserQueryPanel({ catalog, artifact })`.
- `website/tests/fixtures/browser-sql.ts`: `ALL` (the four `requires` objects) and `HBS` (`{variantId: 'chr11-5227002-T-A', modelVersion: 'v3', dataVersion: 'map-2026-08'}`).

The example SQL is exact. The first two are §3.1's lookups; `<v>`, `<m>` and `<d>` come from `sqlString`.
```sql
SELECT population_id, ac, an, lat, lon, radius_km, sampling_design, cohort_id, source_record_id
FROM atlas.measured.variant(<v>);                                                  -- observations; measured; needs measured.variant
SELECT * FROM atlas.inferred.surfaces(<v>);                                         -- surfaces; inferred; needs inferred.surfaces
SELECT * FROM atlas.inferred.artifacts WHERE variant_id = <v> AND model_version = <m> AND data_version = <d>;   -- artifact; inferred
SELECT count(*) AS observations, sum(an) AS an, sum(ac) AS ac FROM atlas.evidence.parity_observations
WHERE 2 * 6371.0088 * asin(sqrt(pow(sin(radians(lat - 6.5244) / 2), 2) + cos(radians(6.5244)) * cos(radians(lat)) * pow(sin(radians(lon - 3.3792) / 2), 2))) <= 500 + radius_km;   -- parity-near-lagos; measured
```

Copy the tests assert, verbatim:
- Paused: "The public data store is paused: a spending brake made it private, so its files cannot be read now. Lookups resume when the maintainer restores access."
- Withdrawn: "A file this release's catalog names is gone, most likely withdrawn. Reload the page for the newest catalog."
- `NO_WASM_TEXT`: "This browser cannot run DuckDB here (it needs WebAssembly and Web Workers). Copy the query and run it in the DuckDB CLI, Python or R."

- [ ] **Unit tests.**
  - `releaseIds skips WITHDRAWN.json and refuses strays`: `['2026-11-20.json', 'WITHDRAWN.json', '2026-11-20.1.json']` → `['2026-11-20', '2026-11-20.1']`; `withdrawn.json` and `latest.json` throw `/neither/`.
  - Catalogs: `2026-11-20.1` beats `2026-11-20`; a dir with only `WITHDRAWN.json` gives `null`; `/2026-12-01 lists no catalog\/atlas\.duckdb, but 2026-11-20 did/`; `releaseSortKey('2026-10-18.2')` → `['2026-10-18', 2]`; loopback is allowed only in e2e, and the base equals `data_release.py`'s.
  - Examples: only examples whose objects exist are offered (`ALL` gives four, `['inferred.artifacts']` gives `['artifact']`, `[]` gives `[]`); the exact SQL above for `HBS`; no example names a measured and an inferred object together.
  - Quoting: `sqlString("a'b") === "'a''b'"`; `attachStatement('https://x/c.duckdb') === "ATTACH 'https://x/c.duckdb' AS atlas (READ_ONLY);"`.
  - `formatCell`: `52340n` → `'52340'`, `null` → `'NULL'`, and `{ac: 1n, labels: ['a']}` → `'{"ac":"1","labels":["a"]}'`.
  - Errors: a 403 message → `paused`, a 404 → `withdrawn`, a parser error → `sql` with the message verbatim.
  - `gnomadBrowserUrl('chr11-5227002-T-A', 'gnomad_r4')` → `https://gnomad.broadinstitute.org/variant/chr11-5227002-T-A?dataset=gnomad_r4`.
  - Bundle: DuckDB-WASM loads only by dynamic import, self-hosted, with no preload.

  Run `(cd website && npx vitest run tests/browser-sql-examples.test.ts tests/browser-sql-format.test.ts tests/data-store-release.test.ts tests/atlas-bundle.test.ts)`: FAIL, the modules are missing.
- [ ] **Implement.**
  - `app.astro` calls `latestDataStoreCatalog(process.env.DATA_STORE_RELEASES_DIR ?? '../data/releases', dataStoreBaseFrom(...))`. A malformed manifest fails the build; `null` renders no panel.
  - `formatCell` writes bigint, Decimal and HUGEINT exactly.
  - Errors link their `docs/data-access.md` sections; a pause also links gnomAD.

  Run the same command: PASS.
- [ ] **Build the panel:** `<details className="atlas-control-sheet atlas-browser-sql">`, titled "Query in your browser". On first open it checks WebAssembly and Worker, then attaches the catalog. It holds example buttons, a textarea, Run, and "Copy for DuckDB" (`attachStatement(url) + '\n' + sql`); results show under a Measured or Inferred heading, cut at `MAX_RESULT_ROWS`. It shows no cost figures.
- [ ] **E2e on `hbs-rs334`:**
  - no DuckDB request before the panel opens;
  - the artifact example shows `chr11-5227002-T-A` under Inferred;
  - the parity example shows `3`, `60` and `6`;
  - `force=403` shows the paused text with a gnomAD link; `force=404` shows the withdrawn text;
  - without WebAssembly, `NO_WASM_TEXT`, and the clipboard starts `ATTACH 'http://127.0.0.1:4324/releases/2000-01-01/catalog/atlas.duckdb' AS atlas (READ_ONLY);`;
  - live: `40`, `52340` and `6459`.

  Run `(cd website && npm run test:e2e -- tests/browser-sql.spec.ts)`: FAIL, then PASS.
- [ ] **Commit:** `feat(atlas): query the data store in the browser (spec 1.13, §7)`
- [ ] **(after release 1)** `(cd website && BROWSER_SQL_LIVE=1 npx playwright test --config playwright.live.config.ts)`: 3 passed.

---

### Task 31 (step 1.14): A read-only cost report and its monthly trigger check

**Files:**
- Create `genomeos/publication/cost_triggers.py` (pure; cites §1.3, §8, call 12) and `scripts/cost_report.py`.
- `tests/fake_gcloud.py`: `auth print-access-token` prints `ya29.fake-cost-report-token`.
- `docs/cost-controls.md` gains "Monthly cost report".
- Tests: `tests/test_cost_triggers.py`, `tests/test_cost_report.py` (new).

**Interfaces:**
- Consumes: Task 16's `access_policy.EGRESS_USD_PER_GIB` and `LOOKUP_DAILY_BYTES_MAX`.
- Constants: `MONTHLY_TRIGGER_USD = Decimal("50")`, `TRIGGER_MONTHS = 2`, `KILL_SWITCH_USD = Decimal("300")`.
- Types:
  - `BucketRole = Literal["data", "lookup", "web", "other"]`.
  - `BucketDay(bucket: str, day: date, sent_bytes: int)`.
  - `Trigger(id: str, decisions: tuple[str, ...], steps: tuple[str, ...], spec_trigger: str, terms: str, recommendation: str, measure: str)`.
  - `TriggerResult(trigger: Trigger, status: Literal["fired", "not_fired", "not_measurable", "by_hand"], evidence: str)`.
- Functions: `egress_usd(sent_bytes: int) -> Decimal`, `complete_months(today: date, count: int = 2) -> tuple[str, ...]`, `window_start(today: date) -> date`, `evaluate(days: Sequence[BucketDay], roles: Mapping[str, BucketRole], today: date) -> tuple[TriggerResult, ...]`, `issue_for(result: TriggerResult) -> tuple[str, str]`.
- `TRIGGERS`, one per entry below (`id`: decisions; steps; measure). `spec_trigger` and `recommendation` hold §1.3's text verbatim.
  - `D3-egress`: D3; 3.8; free egress, two months. `D3-brake`: D3; 3.8; lookup bytes per day.
  - `D12-egress`: D12a, D12b; 3.4; free egress, two months. `D12-guard`: D12a, D12b; 3.4; by hand.
  - `D11-web`: D11; 3.5; web egress, two months.
  - By hand: `D2a` (D2a, D2c, D6a; 3.1), `3.2` (—; 3.2), `D7` (D7; 3.3), `D13` (D13; 3.7), `D14` (D14, D10; 3.6), `D2b` (D2b, D15; —), `D6b` (D6b, D8a–D8e, D9; 4.1–4.5).
- `cost_report.py`:
  - `SENT_BYTES_METRIC`: Cloud Storage's Monitoring metric type for bytes sent (service `storage`, metric `network/sent_bytes_count`; see the GCS metrics page cited as [gcs-metrics] in the spec), `EXIT_FIRED = 3`, `class CostReportError(RuntimeError)`.
  - The bucket-URL hygiene test (`tests/test_web_layout.py::test_no_concrete_bucket_url_is_tracked`) reads a Monitoring metric type as a bucket URL, because it has the storage API host and a path. In this task, extend `_without_committed_public_urls` (or add a sibling filter) so that a scheme-less `<host>/network/<metric>` metric type, with that exact host and no `https://`, is not a bucket name. Pin it with a parametrized case in `test_bucket_url_hygiene_passes_placeholders_and_third_party_data` that spells the metric type, and a case showing the URL form `https://<host>/network/x` is still caught. This plan never spells the metric type, so the test passes on it today.
  - `time_series_url(project: str, start: datetime, end: datetime, page_token: str | None = None) -> str`, `parse_time_series(pages: Sequence[Mapping[str, Any]]) -> list[BucketDay]`, `fetch_json(url: str, token: str) -> dict[str, Any]`, `access_token(gcloud: str) -> str`, `bucket_roles(data: str, lookup: str | None, web: str) -> dict[str, BucketRole]`.
  - `open_issue(title: str, body: str) -> None` uses `gh`, or `GENOMEOS_GH_EXECUTABLE`.
  - `main(argv: Sequence[str] | None = None) -> int` takes `--project`/`$GENOMEOS_GCP_PROJECT`, `--web-bucket`/`$ATLAS_DATA_BUCKET`, `--lookup-bucket`, `--today`, `--dry-run` and `--open-issue`.

- [ ] **Pure tests** (roles: `genomeos-atlas-data` data, `example-lookup` lookup, `example-web` web).
  - `test_egress_price`: 1 GiB costs `Decimal("0.12")`.
  - `test_complete_months`: `complete_months(date(2026, 12, 3)) == ("2026-10", "2026-11")`; January 15, 2026 → `("2025-11", "2025-12")`.
  - `test_the_50_dollar_triggers`: 417 GiB in each month ($50.04) fires D3-egress and D12-egress; 416 GiB in November ($49.92) fires neither; data and lookup egress add together; web egress fires D11 only.
  - `test_the_brake`: it fires at `20 * GIB` in one UTC day and not at one byte less; with no lookup bucket it is `not_measurable`.
  - `test_an_idle_month_is_named`: "2026-10: no data points (idle bucket, or outside Monitoring's retention)".
  - `test_every_decision_and_phase_3_step_has_a_trigger`: all 20 decisions and steps 3.1–3.8; D3-egress's `spec_trigger` is "Data egress over $50 a month for two months (cost report, 1.14), or the brake's first trip".
  - `test_the_issue_for_a_fired_trigger`: title "Cost trigger D3-egress fired: free data egress over $50 in 2026-10 and 2026-11"; body contains `$50.04` and `needs-human-decision`, and no project id.

  Run `python -m pytest tests/test_cost_triggers.py -q`: `ModuleNotFoundError: No module named 'genomeos.publication.cost_triggers'`.
- [ ] **Implement:** a trigger fires only when the cost is strictly over $50 in both complete UTC months; the brake fires at ≥ 20 GiB in any UTC day; free egress is data plus lookup, and web egress is web only; `other` buckets are reported, never counted. Run the same command: PASS.
- [ ] **Script tests.**
  - `test_the_time_series_url`: host `monitoring.googleapis.com`, path `/v3/projects/example-project/timeSeries`; filter `metric.type = "<SENT_BYTES_METRIC>" AND resource.type = "gcs_bucket"`, with the constant substituted; `86400s`, `ALIGN_SUM`, `REDUCE_SUM`, grouped by `resource.label.bucket_name`.
  - `test_a_point_counts_for_the_day_it_ends`: a point ending `2026-11-15T00:00:00Z` counts for `date(2026, 11, 14)`.
  - `test_malformed_data_is_a_hard_error` → `CostReportError`.
  - `test_a_run_with_a_fired_trigger`: exits `EXIT_FIRED`; makes one gcloud call, `auth print-access-token`; follows `pageToken=p2` with GETs only; never prints the token.
  - `test_dry_run_calls_nothing`; `test_a_missing_web_bucket_names_its_variable` (`ATLAS_DATA_BUCKET`); `test_an_existing_issue_title_is_skipped`.

  Run `python -m pytest tests/test_cost_report.py -q`: `FileNotFoundError` for the script.
- [ ] **Implement.** The script prints, per bucket and month, the role, GiB and dollars; then month-to-date spend against $300; then the triggers and the issues for any that fired. The docs cover what it reads (`roles/monitoring.viewer`), its commands and exit codes, and the triggers, with the billing export as a cross-check. Run the same command: PASS.
- [ ] **Commit:** `feat: monthly read-only cost report against the platform's triggers (spec 1.14)`
- [ ] **(owner, monthly)** `python scripts/cost_report.py --open-issue`. Expect exit 0, or exit 3 with one issue per fired trigger and no duplicates.

---

### Task 32 (step 1.15): `docs/data-access.md`, and the stale cache line in `docs/cost-controls.md`

**Files:**
- `docs/data-access.md` (new).
- `docs/cost-controls.md` ("What private means for readers").
- `docs/data-store.md` (link it from "Reading").
- Test: `tests/test_data_access_docs.py` and `website/tests/data-access-doc.test.ts` (new).

**Interfaces:**
- Consumes: Task 30's `attachStatement`, `browserSqlExamples` and `website/tests/fixtures/browser-sql.ts` (`ALL`, `HBS`); Task 31's `KILL_SWITCH_USD`; Task 16's `LOOKUP_DAILY_BYTES_MAX`.
- The H2 sections, in order:
  1. "Look up one variant"
  2. "Query in your browser"
  3. "URLs"
  4. "Quickstarts"
  5. "Downloads"
  6. "Offline mode"
  7. "Citing"
  8. "Takedowns"
  9. "When access stops: the brake and the kill switch"
  10. "Audit logs and privacy"

  Steps 2.2, 2.5 and 2.7 extend it.
- Rules:
  - Lead with §3.1's SQL, noting that the macros come in 2.7 and the whole-genome table in 2.8.
  - Name `genomeos-atlas-lookup` in prose only.
  - Document today's `fetch_data.py` flags.
  - Offline mode: `SET VARIABLE genomeos_local = 'data/'`.
  - Citing follows `cite_as`; takedowns follow §2.9.
  - The brake: 20 GiB a day, lookup bucket only, from 2.5.
  - The kill switch: $300. The data bucket goes private, cached copies last an hour, and the web bucket is untouched.
  - Tier 0 is anonymous. BigQuery audit logs "can't be disabled", and the `_Default` retention is 1 day (if 3.1 opens).

- [ ] **Test.**
  - `test_the_sections_are_in_order`: the exact H2 list.
  - `test_every_storage_url_is_the_committed_base`.
  - `test_every_fetch_command_parses`: each `python scripts/fetch_data.py` line parses with `build_parser()`.
  - `test_the_numbers_match_the_code`: `Cache-Control: {dr.CACHE_CONTROL}`, `$300` and `20 GiB` appear; `LOOKUP_DAILY_BYTES_MAX == 20 * 1024**3` and `KILL_SWITCH_USD == 300`.
  - `test_the_stale_cache_line_is_gone`: `docs/cost-controls.md` has no `max-age=31536000` and no "up to a year".
  - `test_data_store_links_data_access`: `docs/data-store.md` contains `(data-access.md)`.
  - vitest `the documented SQL is the panel's`: the SQL blocks in the first two sections equal `attachStatement(<catalog URL>)` plus each `browserSqlExamples(ALL, HBS)` statement.
- [ ] **Run** `python -m pytest tests/test_data_access_docs.py -q` and `(cd website && npx vitest run tests/data-access-doc.test.ts)`. Expected: FAIL, `docs/data-access.md` is missing.
- [ ] **Write the docs.** In `docs/cost-controls.md`: objects carry `Cache-Control: public, max-age=3600` (#473, #482), so caches may serve them for up to an hour after the switch fires.
- [ ] **Run** the same commands, `python -m pytest tests/test_web_layout.py -q` and `python scripts/check_private_files.py`. Expected: PASS.
- [ ] **Commit:** `docs: data access, leading with lookups; fix the stale cache line (spec 1.15)`
