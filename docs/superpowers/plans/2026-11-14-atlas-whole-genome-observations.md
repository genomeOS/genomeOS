# Atlas Whole-Genome Observations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recount the gnomAD v3.1.2 HGDP + 1KG genotypes under D18 into the 3,102 bin files of `measured.allele_observations_binned`. Read them one variant at a time through catalog macros that compute a URL only for the recorded chromosome set, and prove the counts with check 12. This plan covers steps 2.6 and 2.7, code only. Step 2.8 (the release) and step 2.9 (the website) are later plans.

**Architecture:**
- **Recount lane.** `genomeos/observations/sources/gnomad_recount/` states D18 as pure code and counts natively with bcftools in 166 resumable 20 Mb jobs. An independent Python counter cross-checks sampled bins. Bins are written through phase 1's pinned writer.
- **Lookup lane.** `genomeos/tables/lookup_*.py` computes bin paths and renders four macros into phase 1's catalog: `measured.variant`, `measured.near`, `measured.lookup_url` and `inferred.surfaces`. It also lists every bin in `tables.json` and runs check 12.

**Tech Stack:**
- Python 3.12, pandas, pandera, pyarrow, pytest.
- DuckDB 1.5.5 writes; attach is tested from 1.2.2.
- bcftools and htslib ≥ 1.21 (`MIN_BCFTOOLS`). CI installs bioconda 1.23.1, the version the committed native receipts pin; the spec's measurements used 1.21.

**Spec:** `docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md` ("§N"; "call N" is §13's builder's call N). This plan implements §11 rows 2.6–2.7 under §1.2 D18, §2.4–2.7, §2.9, §2.10, §3.1 and calls 15, 29–32 and 36–38.

## Global Constraints

- §1's decisions and §13's calls bind. **D18's rule (§1.2, items 1–6) is binding text. Read it in full there; this plan does not restate it.** Docstrings cite "Atlas data platform design 2026-10-18 §N".
- Observations and surfaces never share a table, file or macro, and share no column but `variant_id`. Counts only (`ac`, `an`); no frequency column anywhere.
- Schema violations are hard errors, and nothing is dropped silently. The recount raises `RecountError`; `write_bin` and `source_record_id_sql` raise `TableError`; release checks (checks 7 and 12) and macro rendering raise `dr.DataReleaseError`.
- `uncertainty_radius_km`, `sampling_design`, `disease_ascertainment_excluded` and `cohort_id` have no defaults (AGENTS.md).
- No credential anywhere, and no inference on the serving path. Agents run no cloud command; anonymous HTTPS reads of gnomAD's public objects are allowed.
- Layout and formats follow §2.3, §2.5 and §2.10 with calls 29–31 and 37:
  - the path is `tables/v1/measured/allele_observations_binned/source=<s>/ingest_version=<iv>/chrom=<c>/bin=<b>/part-0.parquet`, where `bin = pos // 1_000_000`;
  - there are 3,102 bins, all written, with no `nonlocus` bin.
- **Check 7, verbatim (§2.7):** "Every catalog URL, and every URL a macro can compute (the 3,102 bins of the recorded chromosome set; a test asserts that `chrM`, `hla:` and `kir:` ids compute none), is a manifest key with matching sha256, not withdrawn; two builds match; from step 2.1, `access` and `hosts` equal the rule's recomputation."
- **Check 12, verbatim (§2.7):** "Lookup sets: every `(chrom, bin)` file of the recorded chromosome set exists, empty ones included; refusal counts reproduce; on sampled bins, at least one autosomal bin rich in indels, one chrX PAR bin, one chrX non-PAR bin and one chrY bin among them, an independent counter matches the native bcftools recount cell for cell and `bcftools +check-ploidy` agrees with the karyotypes; an anonymous lookup of rs334 (`chr11-5227002-T-A`) returns one gnomAD row per population with `an > 0`, the per-population refusal counts in `measured.ingests` accounting for the rest, with the recorded `ac` and `an` sums. The expected row count is recorded from the first real recount, never asserted in advance (the 78-label stand-in gave 78 of 78, sum `ac` 208, sum `an` 8,188)."
- **Bucket URLs.** A tracked file, this plan included, may spell as a URL only `dr.DATA_STORE_BASE_URL`, gnomAD's public bucket and `example-*` placeholders (`tests/test_web_layout.py::test_no_concrete_bucket_url_is_tracked`). Until step 2.5 adds the lookup bucket to `COMMITTED_PUBLIC_URLS`, name it only as `genomeos-atlas-lookup` or `dr.LOOKUP_STORE_BASE_URL`. Fixtures use `https://storage.googleapis.com/example-lookup/` and `https://storage.googleapis.com/example-data/`.
- DuckDB is `duckdb==1.5.5` with `threads = 1`, through phase 1's `writer.connect()`.
- `SEED = 42` in `crosscheck.py`, the only stochastic path.
- Modules use `from __future__ import annotations` and stay ≤ 800 logical lines and ≤ 50 KiB.
- **Environment.** CI's install is `pip install --constraint requirements.lock -e '.[dev,atlas,surfaces,geo,figures]'`, and `uv run` means that environment. Never stage `uv.lock`. Type checks run as `uvx pyright <files>`, on the files the task adds. In a worktree, first check that `uv run python -c "import genomeos; print(genomeos.__file__)"` points into it.
- **Every commit:**
  - runs `uv run ruff check .`, `uv run python scripts/freeze_contract.py --check`, `uv run python scripts/check_module_size.py`, `uv run python scripts/check_private_files.py` and focused pytest;
  - stages exactly its task's **Files**, by name;
  - carries the harness attribution;
  - is followed, after each push, by `gh pr checks <n> -R genomeOS/genomeOS --watch`.
- **Before the PR,** also run `uv run python scripts/check_commercial_use.py`, `uv run python scripts/smoke.py` and `uv run pytest`.

## Review Focus

1. **A job gets the wrong inputs:** another chromosome's VCF, a `##contig` length that is not GRCh38's, a gnomAD object replaced mid-run (another generation or md5), or a stage label that is unmapped or appears under both `hgdp` and `onekg`. It fails before writing, and never writes 20 empty bins that look valid. Pinned by Task 6's `test_a_job_on_a_chromosome_the_file_lacks_fails_before_writing`, `test_a_contig_length_off_grch38_fails_before_writing`, `test_a_replaced_upstream_object_fails_before_writing` and `test_population_mapping_fails_before_any_stream`, and by Task 4's `test_an_unmapped_or_ambiguous_label_fails`.
2. **A deletion spans a bin or job boundary.** It is counted once, in its POS bin; bcftools `-r` matches by overlap by default. Pinned in Task 5 by `test_a_deletion_spanning_a_bin_boundary_is_counted_once_by_pos`.
3. **The lookup bucket's brake has tripped (403) while curated files still serve.** The lookup fails, naming the bin URL, and never returns the curated rows alone. Pinned in Task 10 by `test_a_tripped_brake_fails_the_lookup_loudly`.
4. **A malformed id** (`rs334`, `11-5227002-T-A`, lowercase alleles, a quote, `chr11-05227002-T-A`, a 10-digit position). It raises an error naming the accepted forms, never an empty result. Pinned in Task 9 by `test_a_malformed_id_is_an_error_not_an_empty_result`.
5. **Offline mode with `genomeos_local = 'data'` rather than `'data/'`,** which phase 1's views accept. The macros read the same local files either way. Pinned by Task 9's `test_offline_root_takes_either_form` and Task 10's `test_offline_mode_reads_the_downloaded_bin_with_no_http`.

## Decisions where the spec is silent

These are binding; a PR can reverse any of them.

1. **One contract change.** `measured.ingests` gets MINOR 1.1 (Task 6), adding nullable `sample_rule` and `sample_stage_sha256` for D17's "the sample rule". The binned contract is phase-1 Task 4's and does not change. `write_bin` and check 12 also enforce the bin, the recorded chromosome and a unique `(variant_id, source_label)`.
2. **Where D18's checks apply.**
   - Item 2's checks apply to every record; items 3–4 apply to PASS records only.
   - A record in a chrY PAR fails the build.
   - `AC0;AS_VQSR` counts as one FILTER key.
3. **Metadata.**
   - Population comes from the `s` and `population` columns of the pilot metadata (`gnomad_meta_updated.tsv`, `reference_cohorts.METADATA_SHA256`; §1.4 fallback; phase-1 F2).
   - Karyotype comes from the flat column `gnomad_sex_imputation.sex_karyotype` or the JSON column `gnomad_sex_imputation`.
   - Both files are cited by URL, size, md5, generation and sha256 (D17).
4. **Cohort ids.** Recount rows carry `gnomad-v3.1.2-hgdp-1kg:<stage>:d18-v1`. The curated TSV becomes `gnomad-hgdp-1kg:curated-tsv`, and no tracked data or served JSON carries the old `gnomad-v4-hgdp-1kg`.
5. **The recorded chromosome set** is the chromosomes of the cited VCF URLs, with GRCh38 lengths checked against each `##contig` line. URLs are bounded by `bin < n_bins`, so no computed URL 404s.
6. **Tallies and provenance.**
   - Per-bin tallies live in the unpublished `IngestSummary` (O7); `measured.ingests` gets the totals.
   - Each bin's `genomeos.inputs` lists the HGDP + 1KG reference parquets. Its `genomeos.sources` is their recorded union, which must equal `("genomeos", "gnomad_hgdp_1kg")` (§9; phase-1 Task 18 records both on that folder). Code adds no source.
7. **`measured.near` and the extra `measured.lookup_url(v) -> VARCHAR[]`** are owned here.

## Deviations from the spec

- **§2.9, "Views and macros anti-join `meta.withdrawn`".** Macros leave withdrawn files out at render time instead of anti-joining at query time, because an attached macro cannot reference a view or another macro (Task 9). A withdrawn bin is a build error: a takedown in a lookup set takes §2.9's new-ingest-version route.

## Open items (the implementer must not guess)

- **O1 (§2.4, AGENTS.md).** The recount rows' `sampling_design` and `disease_ascertainment_excluded` are undecided, because the HGDP + 1KG subset was not selected by gnomAD's exclusion policy. Task 4 opens a `needs-human-decision` issue. `run` requires both values as flags, and 2.8 waits for the answer.
- **O2 (phase-1 F1).** The 80 identities' radii and notices are undecided. Real jobs wait for them; code and fixtures do not.
- **O3 (D17).** D17 cites one metadata file. If the pilot's file lacks karyotype, two cited files are needed, and the owner must accept that.
- **O4 (D17 versus §14).** `reference_cohorts.qualify_real_cohorts` (through `select_cohorts`) rebuilds the 4,094 from three inputs:
  - `gnomad_meta_updated.tsv` and `pca_outliers.txt`, both public at the generations in `docs/research/hgdp-cohort-dependency-qualification-2026-09-09.md`;
  - the exclusions JSON (`EXCLUSIONS_SHA256`), which is not published.

  2.8 must say whether that JSON or its recipe is published.
- **O5 (§11, step 2.7).** The 15-request gate assumes a variant is held in at most one curated file; each further file adds 2–4 requests. 2.8 records rs334's real count, and the owner decides.
- **O6 (§1.4).** `query()`, `getvariable()` and `error()` are untested on DuckDB-WASM. Step 1.13 or 2.9 tests them, or the website computes URLs itself.
- **O10 (§11).** Task 11 needs the manifest v2 from step 2.1 and `dr.LOOKUP_STORE_BASE_URL` from step 2.5.
- **O11 (phase-1 step 1.9).** `Ingest.refusals` must hold `(reason, population_id, count)`. Do not fold the population into the reason.
- **For the PR body, not this plan:**
  - publishing the per-bin summary is 2.8's call (O7);
  - a takedown in a lookup set republishes 3,102 bins, about 8.2 GB (O8);
  - curated and recount ids are unique only together with `ingest_version`, and `measured.variant('kir:…')` is empty, for step 1.15's docs (O9);
  - the recount's speed on a 4-vCPU runner is unmeasured until 2.8 (O12).

## Interfaces consumed from sibling plans

| Source | Interfaces |
|---|---|
| Phase-1 Task 4 | `contracts.{TableError, LOCUS_VARIANT_ID_PATTERN, BINNED_OBSERVATIONS_SCHEMA, TABLE_CONTRACTS, contract_sha256}`; schema version `"1.0"` |
| Phase-1 Tasks 5–6 | `dr.assert_data_path`, which accepts `=`; `dr.validate_withdrawn` |
| Phase-1 Task 11 | `writer.{connect, write_parquet(con, select_sql, out, *, table, git_sha, inputs, sources, order_by, row_group_rows=ROW_GROUP_ROWS), write_frame, check_partitions(con, path, relative)}`; `provenance.{InputRef(key, sha256), read_kv, recorded_sources, union_sources}` |
| Phase-1 Tasks 11–12 | `tables/v1/inferred/artifacts.parquet`, `tables/v1/meta/served.parquet` |
| Phase-1 Task 13 | `catalog.{render_catalog_sql(release, files, *, base_url), render_tables_json(release, files), catalog_urls(sql), check_catalog(sql, tables_json, objects, withdrawn_keys)}`; `checks.check_release_tables`; `writer.build_catalog_db(sql, out, *, data_root)`; `build(..., catalog=True)`; `tests/test_tables_{catalog,checks}.py` |
| Phase-1 Task 14 | `scripts/build_catalog_fixture.py` (`build_fixture`, `FIXTURE_RELEASE = "2026-11-20"`, `--check`), `scripts/check_catalog_attach.py` (`check(catalog, local, expected) -> list[str]`), `tests/fixtures/catalog/**`, `tests/test_catalog_fixture.py`, and the CI step "Catalog attaches from DuckDB 1.2.x" |
| Phase-1 Task 17 | `reference.{read_reference(folder), registry_folder(v), reference_paths, reference_frames}`; `hgdp_1kg.ALIAS_SOURCES` |
| Phase-1 Task 18 | the 80-identity folder `tables/v1/reference/populations/1.0.0-<sha8>/`, with sources `["genomeos", "gnomad_hgdp_1kg"]` |
| Phase-1 Task 19 (step 1.9) | `measured.{Ingest, IngestInput, ingests_table, INGESTS_PATH, read_ingests, check_ingest_inputs(ingests, published)}` |
| Phase-1 Task 23 (step 1.11) | `genomeos.surfaces.artifacts.FORMAT_THREE_COLUMNS` (tests only) |
| Step 2.1 | `ReleaseObject.access`, `.hosts`, and the rule that recomputes them |
| Step 2.5 | `dr.LOOKUP_STORE_BASE_URL`, the `genomeos-atlas-lookup` bucket's base URL, which 2.5 adds to `COMMITTED_PUBLIC_URLS` |

## Execution and parallelism

- **Order.** Task 1 runs first, then Tasks 2 and 3 in parallel.
  - **Recount lane:** Task 5 follows Task 3; Task 4 follows Tasks 2 and 3; Task 6 follows Tasks 4 and 5; Task 7 follows Task 6. Task 8 follows Task 4 and runs beside Tasks 5–7.
  - **Lookup lane:** Task 9 follows Task 2 and phase-1 Task 14; Task 10 follows Task 9.
  - **Task 11** follows Tasks 6 and 9, plus phase-1 steps 1.6, 1.9 and 1.11 and steps 2.1 and 2.5 (O10).
  - **Task 12** comes last, after Tasks 7, 10 and 11.
- **Shared files serialize their tasks:** `tests/lookup_fixtures.py` (2 → 9 → 11), `tests/gnomad_recount_fixtures.py` (3 → 5 → 6), `scripts/recount_gnomad_hgdp_1kg.py` (6 → 7), and `scripts/build_data_release.py` and `tests/test_tables_catalog.py` (11 → 12).
- **CI.**
  - Task 5 installs bcftools 1.23.1, which Tasks 6, 7 and 12 need.
  - Task 10's fixture runs `INSTALL httpfs; LOAD httpfs` itself; it adds no CI step.
  - Task 9 extends the fixture that phase-1 Task 14's step "Catalog attaches from DuckDB 1.2.x" already checks.
- **Owner steps.** No task ends with one, and an agent runs Task 7's anonymous network tests. The first owner step is 2.8's upload. It needs 2.5's bucket and answers to O1–O4.

---

### Task 1: Lookup-set geometry and URL computation

**Files:**
- Create: `genomeos/tables/lookup_sets.py`. It is pure, and cites §2.3, §2.6, §2.10 and calls 29 and 31.
- Test: `tests/test_lookup_sets.py` (new).

**Interfaces:** consumes `dr.assert_data_path` and `dr.DataReleaseError`, and produces:

```python
BINNED_TABLE = "measured.allele_observations_binned"; BINNED_PREFIX = "tables/v1/measured/allele_observations_binned/"
BIN_BP = 1_000_000; PART_FILE = "part-0.parquet"
LOCUS_ID_PATTERN = r"^(chr(?:[1-9]|1[0-9]|2[0-2]|X|Y))-([1-9][0-9]{0,8})-[ACGT]+-[ACGT]+$"
GRCH38_LENGTHS: Mapping[str, int]   # Hail 0.2.77, chr1…chr22, chrX, chrY: 248956422, 242193529, 198295559, 190214555, 181538259,
    # 170805979, 159345973, 145138636, 138394717, 133797422, 135086622, 133275309, 114364328, 107043718, 101991189, 90338345,
    # 83257441, 80373285, 58617616, 64444167, 46709983, 50818468, 156040895, 57227415
class BinRef(NamedTuple-like, frozen, ordered): chrom: str; bin: int
def bin_of(pos: int) -> int; def bin_range(ref: BinRef) -> tuple[int, int]          # 1-based inclusive; ValueError outside GRCh38
class LookupSet(frozen): source: str; ingest_version: str; contig_lengths: Mapping[str, int]
    def n_bins(self, chrom: str) -> int; def bins(self) -> tuple[BinRef, ...]; prefix: str   # n_bins = length // BIN_BP + 1
def lookup_set(source: str, ingest_version: str, contig_lengths: Mapping[str, int]) -> LookupSet
def bin_path(lookup: LookupSet, ref: BinRef) -> str; def all_bin_paths(lookup: LookupSet) -> tuple[str, ...]
def variant_bin(lookup: LookupSet, v: str) -> BinRef | None; def variant_bin_path(lookup: LookupSet, v: str) -> str | None
def parse_bin_path(path: str) -> tuple[str, str, BinRef] | None      # (source, ingest_version, ref)
```

- [ ] **Step 1: Write the failing tests**

```python
IV = "gnomad-v3.1.2-hgdp-1kg-recount-test"; GNOMAD = lookup_set("gnomad_hgdp_1kg", IV, GRCH38_LENGTHS)
def test_recorded_gnomad_set_has_3102_bins_2887_autosomal():
    assert len(set(all_bin_paths(GNOMAD))) == len(GNOMAD.bins()) == 3102
    assert sum(GNOMAD.n_bins(c) for c in GRCH38_LENGTHS if c not in {"chrX", "chrY"}) == 2887
    assert [GNOMAD.n_bins(c) for c in ("chrX", "chrY", "chr11", "chr21")] == [157, 58, 136, 47]
def test_bin_edges_and_rs334():   # ValueError for bin_of(0), bin_range(BinRef("chr1", 249)), bin_range(BinRef("chrM", 0))
    assert (bin_of(1), bin_of(999_999), bin_of(1_000_000)) == (0, 0, 1)
    assert bin_range(BinRef("chr1", 0)) == (1, 999_999) and bin_range(BinRef("chr1", 248)) == (248_000_000, 248_956_422)
    assert variant_bin_path(GNOMAD, "chr11-5227002-T-A") == f"{BINNED_PREFIX}source=gnomad_hgdp_1kg/ingest_version={IV}/chrom=chr11/bin=5/part-0.parquet"
@pytest.mark.parametrize("v", ["chrM-16519-T-C", "hla:a-02-01", "kir:2dl1", "phenotype:g6pd-deficiency", "mic:a-008", "cyt:il-10-1082-g",
    "chr21-47000000-A-G", "chrY-58000000-A-G", "chr1-99999999999999999999-A-G", "rs334", "11-5227002-T-A", "chr11-5227002-t-a",
    "chr23-1-A-G", "chr11-5227002-T-*", "chr1-0-A-G", "chr11-05227002-T-A", ""])
def test_ids_off_the_set_past_the_end_or_malformed_compute_no_url(v):
    assert variant_bin(GNOMAD, v) is None and variant_bin_path(GNOMAD, v) is None
def test_contig_ends_indels_and_round_trip():
    assert all(variant_bin(GNOMAD, f"{c}-{n}-A-G") == BinRef(c, GNOMAD.n_bins(c) - 1) for c, n in GRCH38_LENGTHS.items())
    assert {variant_bin(GNOMAD, v) for v in ("chr11-5227002-TA-T", "chr11-5227002-T-TAA", "chr11-5227002-AC-GT")} == {BinRef("chr11", 5)}
    assert all(dr.assert_data_path(p) == p and bin_path(GNOMAD, parse_bin_path(p)[2]) == p for p in all_bin_paths(GNOMAD))
# test_bad_recorded_sets_are_refused: DataReleaseError matching "chrM" (chrM added), "chr1" (length 248956421), "empty" ({}),
#   "ingest_version" for each of "", "a/b", "x:y", ".hidden", "v 1", "a=b"
# test_a_grch38_subset_is_valid: lookup_set("f", IV, {"chr21": 46709983, "chr22": 50818468}).bins()[-1] == BinRef("chr22", 50)
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_lookup_sets.py -v` gives `ModuleNotFoundError: No module named 'genomeos.tables.lookup_sets'`.
- [ ] **Step 3: Implement.** A URL exists only when all three hold: the id matches `LOCUS_ID_PATTERN`, its chromosome is in `contig_lengths`, and `pos // BIN_BP < n_bins`. Paths pass through `dr.assert_data_path`, and segments must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
- [ ] **Step 4: Run the tests; they pass.** `uv run pytest tests/test_lookup_sets.py -v && uvx pyright genomeos/tables/lookup_sets.py`. Expected: PASS, then `0 errors`.
- [ ] **Step 5: Commit.** `git commit -m "feat(tables): compute lookup-set bin paths over the recorded GRCh38 chromosome set (data platform §2.6, §2.10)"`

---

### Task 2: The per-bin writer, the derived-id template and check 2 for bins

**Files:**
- Create: `genomeos/tables/binned.py`, citing §2.4, §2.5, §2.7 check 2, §2.10 and calls 15, 29 and 30.
- Modify: `genomeos/tables/writer.py::check_partitions`. For a path under `BINNED_PREFIX`, the in-file value of `chrom` is `split_part(variant_id, '-', 1)` and that of `bin` is `pos // 1000000`. `source` and `ingest_version` are compared in-file, as for every table. Without this, phase-1 check 2 finds no `chrom` or `bin` column in any bin.
- Create: `tests/lookup_fixtures.py`, holding `binned_row(**overrides) -> pd.DataFrame` (one row, with the defaults below) and `W: dict[str, object]` (the shared `write_bin` keywords).
- Test: `tests/test_binned_writer.py` (new) and `tests/test_tables_writer.py` (phase 1's).

**Interfaces:** consumes Task 1 and phase 1's `contracts`, `writer.connect`, `writer.write_parquet`, `InputRef` and `read_kv`, and produces:

```python
BINNED_COLUMNS: tuple[str, ...]   # OBSERVATIONS_SCHEMA's columns without source_record_id, in its order, then "pos", "source_label"
LOOKUP_ROW_GROUP_ROWS = 122_880
SOURCE_RECORD_ID_TEMPLATE = "gnomad-hgdp-1kg:{variant_id}:{source_label}"
def source_record_id_sql(template: str) -> str    # TableError "template" unless its fields are exactly {variant_id}, {source_label} and it has no "'"
class BinFile(frozen): path: str; sha256: str; bytes: int; rows: int
def write_bin(rows: pd.DataFrame, out_root: Path, lookup: LookupSet, ref: BinRef, *, git_sha: str,
              inputs: Sequence[InputRef], sources: Sequence[str]) -> BinFile
def read_bin_cells(path: Path) -> pd.DataFrame     # variant_id, source_label, ac, an
```

`binned_row()` defaults:
- `variant_id="chr11-5227002-T-A"`, `rsid="rs334"`, `pos=5227002`
- `population_id="hgdp-han"`, `source_label="Han"`, `lat=32.27`, `lon=114.02`, `radius_km=25.0`
- `ac=3`, `an=4`
- `source="gnomad_hgdp_1kg"`, `assay="genome"`, `date_lower=date_upper=0`
- `sampling_design="healthy_reference"`, `disease_ascertainment_excluded=True` (test values only; O1)
- `cohort_id="gnomad-v3.1.2-hgdp-1kg:fixture-8:d18-v1"`, `ingest_version="fixture-1"`

- [ ] **Step 1: Write the failing tests**

```python
LOOKUP = lookup_set("gnomad_hgdp_1kg", "fixture-1", GRCH38_LENGTHS)
W = dict(git_sha="0" * 40, sources=["genomeos", "gnomad_hgdp_1kg"],   # in tests/lookup_fixtures.py
         inputs=[InputRef("releases/2026-12-01/tables/v1/reference/populations/1.0.0-0a1b2c3d/populations.parquet", "a" * 64)])
def test_write_bin_sorts_compresses_and_labels_its_file(tmp_path):
    assert set(BINNED_COLUMNS) == set(BINNED_OBSERVATIONS_SCHEMA.columns)
    assert BINNED_COLUMNS == tuple(c for c in OBSERVATIONS_SCHEMA.columns if c != "source_record_id") + ("pos", "source_label")
    rows = pd.concat([binned_row(variant_id="chr11-5227002-T-G"), binned_row(population_id="hgdp-northernhan", source_label="NorthernHan"),
                      binned_row(), binned_row(variant_id="chr11-5227002-TA-T"), binned_row(variant_id="chr11-5200000-C-T", pos=5200000)])
    written = write_bin(rows, tmp_path, LOOKUP, BinRef("chr11", 5), **W); path = tmp_path / written.path
    assert written == BinFile(bin_path(LOOKUP, BinRef("chr11", 5)), hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size, 5)
    t = pq.read_table(path)
    assert tuple(t.column_names) == BINNED_COLUMNS
    assert list(zip(t["variant_id"].to_pylist(), t["population_id"].to_pylist())) == [("chr11-5200000-C-T", "hgdp-han"),
        ("chr11-5227002-T-A", "hgdp-han"), ("chr11-5227002-T-A", "hgdp-northernhan"), ("chr11-5227002-T-G", "hgdp-han"), ("chr11-5227002-TA-T", "hgdp-han")]
    kv = read_kv(path)
    assert (kv["genomeos.table"], kv["genomeos.schema_version"], kv["genomeos.contract_sha256"]) == (BINNED_TABLE, "1.0", contract_sha256(BINNED_TABLE))
    assert json.loads(kv["genomeos.sources"]) == W["sources"] and pq.ParquetFile(path).metadata.row_group(0).column(0).compression == "ZSTD"
@pytest.mark.parametrize("rows, match", [(lambda: binned_row(variant_id="chr11-6000000-A-G", pos=6000000), "bin"),
    (lambda: binned_row(variant_id="chr12-5227002-T-A"), "chrom"), (lambda: binned_row(ingest_version="other-1"), "ingest_version"),
    (lambda: pd.concat([binned_row(), binned_row(population_id="hgdp-northernhan")]), "source_label"),
    (lambda: binned_row(ac=0, an=0), r"'an'.*greater_than")])
def test_rows_that_do_not_belong_are_refused_and_leave_no_file(tmp_path, rows, match):
    with pytest.raises((TableError, SchemaError, SchemaErrors), match=match):
        write_bin(rows(), tmp_path, LOOKUP, BinRef("chr11", 5), **W)
    assert not any(tmp_path.rglob("*.parquet*"))
def test_source_record_id_sql():
    assert source_record_id_sql(SOURCE_RECORD_ID_TEMPLATE) == "'gnomad-hgdp-1kg:' || variant_id || ':' || source_label"
    # TableError "template" for "x:{population_id}" and "it's {variant_id}:{source_label}"
# test_row_groups_hold_122880_rows: 122,881 rows give (num_row_groups, rows in group 0) == (2, 122_880)
# test_an_empty_bin_has_the_full_schema: bin chr11:6 with rows == 0 has the same pq.read_schema as a full bin
# test_write_bin_is_byte_deterministic: writing to two out_roots gives equal sha256s
# tests/test_tables_writer.py test_check2_computes_chrom_and_bin_for_a_binned_file: chr11/bin=5 from write_bin passes check_partitions;
#   the same file copied under bin=6, or under chrom=chr12, fails "check 2"; an empty bin passes
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_binned_writer.py tests/test_tables_writer.py -k "bin or source_record_id" -v` gives `ModuleNotFoundError` and a "check 2" assertion failure.
- [ ] **Step 3: Implement.**
  1. Validate the rows with `BINNED_OBSERVATIONS_SCHEMA`.
  2. Raise `TableError` for a row on another chromosome ("chrom"), for `pos // BIN_BP ≠ ref.bin` ("bin"), for a `source` or `ingest_version` other than the lookup set's, and for a duplicate `(variant_id, source_label)`.
  3. Register the frame on `writer.connect()`. CAST every column explicitly (DOUBLE for the coordinates; BIGINT for the counts, dates and `pos`; BOOLEAN for the flag; VARCHAR otherwise), so that an empty frame keeps the schema.
  4. Call `writer.write_parquet(..., table=BINNED_TABLE, order_by=("pos", "variant_id", "population_id"), row_group_rows=LOOKUP_ROW_GROUP_ROWS)`. This order equals `(pos, ref, alt, population_id)`, because `-` sorts below the bases. The writer writes atomically and refuses files over 150 MiB.
- [ ] **Step 4: Run the tests; they pass.** `uv run pytest tests/test_binned_writer.py tests/test_tables_writer.py -v && uvx pyright genomeos/tables/binned.py`.
- [ ] **Step 5: Commit.** `git commit -m "feat(tables): write one lookup-set bin through the pinned writer (data platform §2.5, §2.10)"`

---

### Task 3: D18's rule and the independent Python counter

**Files:**
- Create: `genomeos/observations/sources/gnomad_recount/{__init__,rule,counter}.py`. `__init__` holds the package docstring (§1.2 D18, §2.10) and the module map.
- Create: `tests/gnomad_recount_fixtures.py`, and `tests/fixtures/gnomad_recount/{windows.vcf,metadata.tsv,karyotypes.tsv,stage.txt,populations.tsv}`.
- Test: `tests/test_gnomad_recount_rule.py` (new).

**Interfaces:** consumes Task 1's `BinRef` and `GRCH38_LENGTHS`, and `genomeos.validation.reference_cohorts.{PAPER_STAGE, PAPER_SAMPLES_SHA256, METADATA_SHA256}`. Produces:

```python
# rule.py
GNOMAD_RELEASE = "v3.1.2"; RULE_ID = "d18-v1"; GQ_MIN, DP_MIN_DIPLOID, DP_MIN_HAPLOID = 20, 10, 5
GNOMAD_VCF_URL = "https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1.2/vcf/genomes/gnomad.genomes.v3.1.2.hgdp_tgp.{chrom}.vcf.bgz"
METADATA_URL = "https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1/secondary_analyses/hgdp_1kg_v2/metadata_and_qc/gnomad_meta_updated.tsv"
SAMPLE_META_URL = "https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1.2/vcf/genomes/gnomad.genomes.v3.1.2.hgdp_1kg_subset_sample_meta.tsv.bgz"
X_PARS = ((10_001, 2_781_479), (155_701_383, 156_030_895)); Y_PARS = ((10_001, 2_781_479), (56_887_903, 57_217_415))
KARYOTYPES = ("XX", "XY"); REFUSAL_REASONS = ("missing", "low_gq", "low_dp", "low_allele_balance")
class RecountError(ValueError)
class StageSample(frozen): sample_id: str; population: str; karyotype: str
class Stage(frozen): name: str; samples: tuple[StageSample, ...]; ids_sha256: str
    # .sample_ids sorted; .populations = sorted literal labels = the order of every ac/an tuple
def read_stage(metadata: bytes, karyotypes: bytes, stage_ids: bytes, *, name: str) -> Stage
def segment(chrom: str, pos: int) -> Literal["autosome", "x_par", "x_nonpar", "y_par", "y_nonpar"]
def bin_region(ref: BinRef) -> Literal["autosome", "par", "nonpar", "straddles_par"]
def expected_ploidy(seg: str, karyotype: str) -> int; def denominators(stage: Stage, seg: str) -> tuple[int, ...]
def check_record(chrom: str, pos: int, ref: str, alt: str) -> None
class CallOutcome(frozen): alleles: int; dosage: int; refusal: str | None
def assess_call(gt: str, gq: str, dp: str, ad: str, *, expected: int) -> CallOutcome
class SiteCounts(frozen): chrom: str; pos: int; ref: str; alt: str; rsid: str | None; ac: tuple[int, ...]; an: tuple[int, ...]   # .variant_id
class Tally: non_pass: Counter[str]; pass_records: int; pass_non_snv: int; monomorphic_in_stage: int; written_sites: int
    refusals: Counter[tuple[str, str]]; an_zero: Counter[str]      # keyed by source_label; every field defaults to empty or 0
    def record_filtered(self, filter_: str); def record_pass(self, site, refusals, populations) -> bool; def merge(self, other) -> Tally
    def to_json(self) -> dict; @classmethod from_json(cls, d) -> Tally
# counter.py
PY_QUERY_FORMAT = "%CHROM\t%POS\t%ID\t%REF\t%ALT\t%FILTER[\t%GT\t%GQ\t%DP\t%AD]\n"
def parse_query_header(line: str) -> tuple[str, ...]
def recount_python(lines: Iterable[str], stage: Stage) -> tuple[tuple[SiteCounts, ...], Tally]
# tests/gnomad_recount_fixtures.py
FIXTURES = Path("tests/fixtures/gnomad_recount"); def fixture_stage() -> Stage   # read_stage over the fixture files, name "fixture-8"
def record(chrom, pos, ref, alt, *, filter_="PASS", calls: Mapping[str, str] | None = None, default="0/0:30:30:30,0", rsid=".") -> str
    # one VCF line over SYN01–09
def vcf_with(records: Sequence[str]) -> str                 # windows.vcf's header plus these records
def query_lines(vcf_text: str, sample_ids: Sequence[str]) -> list[str]   # pure-Python `bcftools query -H -f PY_QUERY_FORMAT -S`
HARD: list[tuple[str, str]]                                 # (record, D18 item), below
```

- [ ] **Step 1: Write the fixtures.**
  - **`stage.txt`:** `SYN01`…`SYN08`, sorted and LF-terminated. `+fill-tags -S` refused ids like `s1`.
  - **`metadata.tsv`** (`s`, `population`): SYN01–02 Han, 03–04 NorthernHan, 05–06 PapuanHighlands, 07–08 PapuanSepik, 09 Han.
  - **`karyotypes.tsv`** (`s`, `gnomad_sex_imputation`): JSON `{"sex_karyotype": …}`. Odd-numbered samples are XX and even-numbered XY; 09 is `XXY`.
  - **`populations.tsv`** (`hgdp.load` format, provenance `synthetic:gnomad-recount-fixture-v1#row-N`):
    - Han: 32.27/114.02, r25
    - NorthernHan: 39.90/116.40, r50
    - PapuanHighlands: -6.08/145.39, r100
    - PapuanSepik: -4.20/143.50, r100
  - **`windows.vcf`** (VCFv4.2):
    - FILTER lines PASS, AC0 and AS_VQSR;
    - 24 `##contig` lines at `GRCH38_LENGTHS`;
    - FORMAT GT, GQ, DP and AD (AD `Number=R`);
    - samples SYN01–09; QUAL and INFO are `.`;
    - an unlisted call is `0/0:30:30:30,0`. In the table, `h` = `0/1:30:30:15,15` and `H` = `1/1:30:30:0,30`.

| # | CHROM POS ID REF ALT FILTER | Calls |
|---|---|---|
| R1 | chr1 1000 rs9001 A G PASS | 01 `0/1:20:10:2,8`, 02 `1/1:19:20:0,20`, 03 `./.:.:.:.`, 04 `0/1:30:10:1,9`, 05 `0/1:.:12:6,6`, 06 `0/1:25:.:6,6`, 07 `0/1:25:12:.,.`, 08 `0/0:25:9:9,0`, 09 H |
| R2 | chr1 1000 . A T PASS | 01 h |
| R3 | chr1 2000 . ATCT A PASS | 03 h, 04 H |
| R4 | chr1 2500 . A AGG PASS | 05 h |
| R5 | chr1 3000 . AC GT PASS | 07 h |
| R6 | chr1 4000 . G C PASS | 01 `0/1:19:30:15,15`, 09 H |
| R7 | chr1 5000 . C T AC0 | 01 h |
| R8 | chr1 5100 . C A AC0;AS_VQSR | 02 h |
| R9 | chr1 6000 . T C PASS | 01 h; 07, 08 `./.:.:.:.` |
| R10 | chr1 19999998 . ATTTT A PASS | 02 h |
| R11 | chr1 20000001 . G A PASS | 04 h |
| R12 | chr11 5227002 rs334 T A PASS | 01 h, 02 H |
| R13 | chrX 1500000 . C G PASS | 02 h, 04 h |
| R14 | chrX 100000000 . A G PASS | 01 h, 02 `1:30:5:0,5`, 03 `0/0:30:9:9,0`, 04 `1:30:4:0,4`, 05 H, 06 `0:30:30:30,0`, 08 `.:.:.:.`, 09 `./.:.:.:.` |
| R15 | chrX 155800000 . T C PASS | 08 h |
| R16 | chrY 14000000 . G T PASS | XX and 09 `.:.:.:.`; 02 `1:30:30:0,30`; 04, 06 `0:30:30:30,0`; 08 `.:.:.:.` |

- [ ] **Step 2: Write the failing tests**

```python
# Port the pilot controls with expected=2:
#   - The 12 cases of test_reference_genotypes.py::test_preserved_lazy_dispositions, renaming
#     missing_gt→missing; missing_gq, low_gq→low_gq; missing_dp, low_dp→low_dp; missing_het_ad, low_het_balance→low_allele_balance.
#     An accepted call becomes CallOutcome(2, dosage, None); a refused one becomes CallOutcome(0, 0, reason).
#   - The 9 cases of test_encountered_invalid_encodings_refuse, each now raising RecountError.
# New cases, (gt, gq, dp, ad), expected → outcome:
#   ("1","20","5","."),1 → (1,1,None); ("0","20","9","."),1 → (1,0,None); ("1","20","4","0,4"),1 → (0,0,"low_dp");
#   ("0/1","20","15","3,12"),2 → (2,1,None); (".",".",".","."),0 → (0,0,None); (".",".",".","."),1 → (0,0,"missing")
# Hard errors, as RecountError(match):
#   "partial genotype": ./1, 0|.
#   "allele index above 1": 0/2, and "2" with expected 1
#   "ploidy": 0/1 with expected 1; "1" with expected 2; 0/1/1; "0" with expected 0
#   "GQ": -1, 20.0;  "DP": x;  "AD": 2,bad and 2,8,0
def test_segments_regions_ploidy_and_denominators():
    assert [segment("chrX", p) for p in (10_000, 10_001, 2_781_479, 2_781_480, 155_701_382, 155_701_383, 156_030_895)] == [
        "x_nonpar", "x_par", "x_par", "x_nonpar", "x_nonpar", "x_par", "x_par"]
    assert [segment("chrY", p) for p in (2_781_479, 2_781_480, 56_887_903)] == ["y_par", "y_nonpar", "y_par"]
    assert [bin_region(BinRef(c, b)) for c, b in (("chrX", 1), ("chrX", 0), ("chrX", 2), ("chrX", 155), ("chrX", 100), ("chrY", 56), ("chrY", 14),
        ("chr11", 5))] == ["par", "straddles_par", "straddles_par", "straddles_par", "nonpar", "straddles_par", "nonpar", "autosome"]
    assert [expected_ploidy(s, k) for s in ("autosome", "x_par", "x_nonpar", "y_nonpar") for k in KARYOTYPES] == [2, 2, 2, 2, 2, 1, 0, 1]
    assert denominators(fixture_stage(), "y_nonpar") == (1, 1, 1, 1) and denominators(fixture_stage(), "x_nonpar") == (2, 2, 2, 2)
    # expected_ploidy("y_par", "XY") and segment("chrM", 1) raise "D18 item 4"; check_record refuses "G,T" ("second ALT"), "*" and REF "N"
def test_the_counter_on_the_fixture_windows():
    sites, tally = recount_python(query_lines((FIXTURES / "windows.vcf").read_text(), fixture_stage().sample_ids), fixture_stage())
    assert [s.variant_id for s in sites] == ["chr1-1000-A-G", "chr1-1000-A-T", "chr1-2000-ATCT-A", "chr1-2500-A-AGG", "chr1-3000-AC-GT",
        "chr1-6000-T-C", "chr1-19999998-ATTTT-A", "chr1-20000001-G-A", "chr11-5227002-T-A", "chrX-1500000-C-G", "chrX-100000000-A-G",
        "chrX-155800000-T-C", "chrY-14000000-G-T"]
    by = {s.variant_id: (s.ac, s.an) for s in sites}
    assert by["chr1-1000-A-G"] == ((1, 0, 0, 0), (2, 0, 0, 0)) and by["chrX-100000000-A-G"] == ((2, 0, 2, 0), (3, 0, 3, 2))
    assert by["chrY-14000000-G-T"] == ((1, 0, 0, 0), (1, 1, 1, 0))
    assert (tally.pass_records, tally.pass_non_snv, tally.monomorphic_in_stage, tally.written_sites) == (14, 4, 1, 13)
    assert tally.non_pass == Counter({"AC0": 1, "AC0;AS_VQSR": 1})
    assert tally.an_zero == Counter({"NorthernHan": 2, "PapuanHighlands": 1, "PapuanSepik": 3})
    assert tally.refusals == Counter({("Han", "low_gq"): 2, ("NorthernHan", "missing"): 1, ("NorthernHan", "low_allele_balance"): 1,
        ("NorthernHan", "low_dp"): 2, ("PapuanHighlands", "low_gq"): 1, ("PapuanHighlands", "low_dp"): 1,
        ("PapuanSepik", "low_allele_balance"): 1, ("PapuanSepik", "low_dp"): 1, ("PapuanSepik", "missing"): 4})
HARD = [(record("chr1", 7000, "A", "G,T"), "D18 item 2"), (record("chr1", 7000, "A", "*"), "D18 item 2"),   # in tests/gnomad_recount_fixtures.py
    (record("chr1", 7000, "A", "G", calls={"SYN01": "0/2:30:30:15,15"}), "D18 item 2"),
    (record("chr1", 7000, "A", "G", calls={"SYN01": "./1:30:30:15,15"}), "D18 item 3"),
    (record("chr1", 7000, "A", "G", calls={"SYN01": "1:30:30:0,30"}), "D18 item 4"),
    (record("chrX", 100000500, "A", "G", default="0:30:30:30,0", calls={f"SYN0{i}": "0/0:30:30:30,0" for i in (1, 3, 5, 7)} | {"SYN02": "0/1:30:30:15,15"}), "D18 item 4"),
    (record("chrY", 14000500, "G", "T", default=".:.:.:.", calls={"SYN01": "0:30:30:30,0"}), "D18 item 4"),
    (record("chrY", 100000, "G", "T", default=".:.:.:."), "D18 item 4")]
@pytest.mark.parametrize("rec,item", HARD)
def test_hard_errors_name_the_record_and_the_d18_item_never_a_sample(rec, item):
    with pytest.raises(RecountError, match=rf"{rec.split()[0]}:{rec.split()[1]}.*{item}") as err:
        recount_python(query_lines(vcf_with([rec]), fixture_stage().sample_ids), fixture_stage())
    assert "SYN0" not in str(err.value)
# test_stage_reads_both_karyotype_forms: populations == ("Han", "NorthernHan", "PapuanHighlands", "PapuanSepik"); karyotypes == ["XX", "XY"] * 4;
#   a flat-column file gives an equal Stage; ids_sha256 == sha256(stage.txt bytes)
# test_stage_refusals (RecountError match): "XXY.*D18 item 4" for SYN01–09 (with "SYN09" not in the message); "sorted"; "unique";
#   "metadata" (SYN99); "stage name" ("Fixture One");
#   "PAPER_SAMPLES_SHA256": name=PAPER_STAGE over 4,094 sorted ids SYN0001…SYN4094 (the right size, another digest);
#   "METADATA_SHA256": the same, with rule.PAPER_SAMPLES_SHA256 monkeypatched to that list's digest
# test_counts_join_by_sample_id: reversed sample columns give an equal result; dropping SYN08 → "stage"
# test_partial_genotype_on_non_pass_is_counted: AC0 with "./1" gives non_pass == Counter({"AC0": 1})
# test_tally_round_trips_and_merges: Tally.from_json(t.to_json()) == t; merge adds every field
```

- [ ] **Step 3: Run the tests; they fail.** `uv run pytest tests/test_gnomad_recount_rule.py -v` gives `ModuleNotFoundError`.
- [ ] **Step 4: Implement.**
  - **`assess_call`** follows `reference_genotypes.assess_call`'s order and laziness: GT, then GQ, then DP, then AD for a heterozygote.
    - **GT.** `.`, `./.` and `.|.` are missing, and with `expected == 0` such a call is `(0, 0, None)`. A lone `.` among called alleles is item 3. An allele other than 0 or 1 is item 2. An allele count ≠ `expected`, or any called sample where `expected == 0`, is item 4.
    - **GQ, DP.** A missing GQ or DP counts as `low_gq` or `low_dp`; the prototype did this and matched native on 592,484 cells. The DP floor is 5 when `expected == 1`.
    - **AD.** A `.` anywhere is `low_allele_balance`. Otherwise the arity must be 2, or it is an error. Then take the tokens in order: each must match `[0-9]+` (else an error), and gives `low_allele_balance` if `5 * value < DP`. Haploid calls never read AD.
  - **`read_stage`.**
    - Never read `hgdp_tgp_meta`. Refuse a header that has both karyotype forms.
    - Report counts, never ids. The name must match `^[a-z0-9][a-z0-9_-]*$`.
    - When `name == PAPER_STAGE`, first require `sha256(stage_ids) == PAPER_SAMPLES_SHA256`, then `sha256(metadata) == METADATA_SHA256`, before any other check.
  - **`recount_python`** requires the header's samples to equal the stage, and prefixes every error with `f"{chrom}:{pos}: "`.
  - **`record_pass`.** A site is non-SNV when `len(ref) != 1 or len(alt) != 1`. If `sum(ac) == 0`, it counts as monomorphic and returns False. Otherwise it counts as written, adds `an_zero` for each `an == 0`, and returns True.
  - **`SAMPLE_META_URL`.** Before committing it, run one anonymous `curl -sI` against it; it must return 200.
- [ ] **Step 5: Run the tests; they pass.** `uv run pytest tests/test_gnomad_recount_rule.py tests/test_reference_genotypes.py -v && uvx pyright genomeos/observations/sources/gnomad_recount`.
- [ ] **Step 6: Commit.** `git commit -m "feat: state D18's recount rule as code with an independent Python counter (data platform §1.2)"`

---

### Task 4: Binned rows: registry join, `cohort_id` and derived ids

**Files:**
- Create: `genomeos/observations/sources/gnomad_recount/rows.py`
- Test: `tests/test_gnomad_recount_rows.py` (new). Its `registry` fixture is `build_registry([hgdp.load(FIXTURES / "populations.tsv", "0.1.0")])`.

**Interfaces:** consumes Tasks 2–3 (`BINNED_COLUMNS`, `SOURCE_RECORD_ID_TEMPLATE`, `source_record_id_sql`, `write_bin`, `W`) and `gnomad_hgdp_1kg.{SOURCE, ALIAS_SOURCES, UnmappedPopulationError}`, and produces:

```python
ASSAY = "genome"
def recount_cohort_id(stage_name: str) -> str
def derive_source_record_id(variant_id: str, source_label: str) -> str     # SOURCE_RECORD_ID_TEMPLATE.format(...)
def population_table(stage: Stage, populations: pd.DataFrame, aliases: pd.DataFrame) -> pd.DataFrame   # source_label, population_id, lat, lon, radius_km
def binned_rows(sites: Sequence[SiteCounts], table: pd.DataFrame, *, cohort_id: str, ingest_version: str,
                sampling_design: str, disease_ascertainment_excluded: bool) -> pd.DataFrame   # BINNED_COLUMNS; cells with an > 0 only
def with_derived_ids(rows: pd.DataFrame) -> pd.DataFrame                   # the 17 OBSERVATIONS_SCHEMA columns
```

- [ ] **Step 1: Write the failing tests**

```python
SITES = (SiteCounts("chr1", 1000, "A", "G", "rs9001", (1, 0, 0, 0), (2, 0, 0, 0)), SiteCounts("chr1", 6000, "T", "C", None, (1, 0, 0, 0), (4, 4, 4, 0)))
ASC = dict(sampling_design="healthy_reference", disease_ascertainment_excluded=True)   # test values; the real ones wait for O1
def test_cohort_id_and_population_table(registry):
    assert recount_cohort_id("paper_ancestry_exclusion_4094") == "gnomad-v3.1.2-hgdp-1kg:paper_ancestry_exclusion_4094:d18-v1"  # RecountError: "", "Paper Stage", "a:b"
    table = population_table(fixture_stage(), *registry)
    assert table["population_id"].tolist() == ["hgdp-han", "hgdp-northernhan", "hgdp-papuanhighlands", "hgdp-papuansepik"]
    assert table.loc[1, ["lat", "lon", "radius_km"]].tolist() == [39.90, 116.40, 50.0]
def test_an_unmapped_or_ambiguous_label_fails(registry):
    populations, aliases = registry
    with pytest.raises(gnomad_hgdp_1kg.UnmappedPopulationError, match="PapuanSepik"):
        population_table(fixture_stage(), populations, aliases[aliases["label"] != "PapuanSepik"])
    with pytest.raises(RecountError, match="ambiguous.*Han"):
        population_table(fixture_stage(), populations, pd.concat([aliases, aliases[aliases["label"] == "Han"].assign(source="onekg")]))
def test_rows_keep_zero_counts_drop_unobserved_cells_and_derive_ids(tmp_path, registry):
    rows = binned_rows(SITES, population_table(fixture_stage(), *registry), cohort_id=recount_cohort_id("fixture-8"), ingest_version="fixture-1", **ASC)
    assert tuple(rows.columns) == BINNED_COLUMNS and rows["ac"].tolist() == [1, 1, 0, 0] and (rows["an"] > 0).all()
    assert set(rows["sampling_design"]) == {"healthy_reference"} and rows["disease_ascertainment_excluded"].all()
    full = OBSERVATIONS_SCHEMA.validate(with_derived_ids(rows))
    written = write_bin(rows, tmp_path, lookup_set("gnomad_hgdp_1kg", "fixture-1", GRCH38_LENGTHS), BinRef("chr1", 0), **W)
    sql = source_record_id_sql(SOURCE_RECORD_ID_TEMPLATE)
    ids = duckdb.sql(f"SELECT {sql} FROM read_parquet('{tmp_path / written.path}') ORDER BY 1").fetchall()
    assert [r[0] for r in ids] == sorted(full["source_record_id"])
    assert derive_source_record_id("chr11-5227002-T-A", "Yoruba") == "gnomad-hgdp-1kg:chr11-5227002-T-A:Yoruba"
# test_ascertainment_has_no_default: for both names, inspect.signature(binned_rows).parameters[name].default is inspect.Parameter.empty
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_gnomad_recount_rows.py -v` gives `ImportError`.
- [ ] **Step 3: Implement.**
  - Filter the aliases to `ALIAS_SOURCES`. A label listed twice raises "ambiguous", naming it.
  - `radius_km` comes from `uncertainty_radius_km` and has no default.
  - `binned_rows` is vectorised with numpy, because bins hold up to about 4.1M rows.
  - The module docstring records O1 and its issue.
- [ ] **Step 4: Open O1.** Run `gh issue create --label needs-human-decision --title "Sampling design and disease-ascertainment flag of the gnomAD HGDP + 1KG recount rows (step 2.6)" --body "<O1; link this plan>"`. Expected: an issue URL, which the docstring then cites.
- [ ] **Step 5: Run the tests; they pass.** `uv run pytest tests/test_gnomad_recount_rows.py -v`.
- [ ] **Step 6: Commit.** `git commit -m "feat: build binned recount rows with their own cohort_id and derived ids (data platform §2.10)"`

---

### Task 5: Native bcftools count, ploidy audit and partial-genotype guard

**Files:**
- Create: `genomeos/observations/sources/gnomad_recount/native.py`.
- Modify: `tests/gnomad_recount_fixtures.py`. Add:
  - `indexed_vcf(tmp_path: Path, text: str) -> Path`, which bgzips and tabix-indexes;
  - `requires_native = pytest.mark.skipif(native_tools() is None and os.environ.get("CI") != "true", reason="bcftools, bgzip and tabix are unavailable")`, built on `tests.reference_tbi_fixture.native_tools()`, so CI never skips.
- Modify: `.github/workflows/ci.yml`. In the `test` job, before `Install`, install bioconda `bcftools=1.23.1 htslib=1.23.1` through `mamba-org/setup-micromamba` (pinned to a release tag), put its `bin` on `GITHUB_PATH`, and add a `bcftools --version | head -1` step. 1.23.1 is the version that `tests/fixtures/reference_windows/native/expected-queries.json` and `test_live_native_full_and_sparse_controls` pin; both stop skipping once it is installed.
- Test: `tests/test_gnomad_recount_native.py` (new).

**Interfaces:** consumes Tasks 1 and 3, and produces:

```python
MIN_BCFTOOLS = (1, 21)
QC_LOW_GQ = 'FMT/GQ="." | FMT/GQ<20'
QC_LOW_DP = 'FMT/DP="." | (GT="hap" & FMT/DP<5) | (GT!="hap" & FMT/DP<10)'
QC_LOW_ALLELE_BALANCE = 'GT="het" & (FMT/AD[:0]="." | FMT/AD[:1]="." | FMT/AD[:0]/FMT/DP<0.2 | FMT/AD[:1]/FMT/DP<0.2)'
PARTIAL_GENOTYPE = r'FILTER="PASS" & (GT~"[01][/|]\." | GT~"\.[/|][01]")'
def parse_bcftools_version(text: str) -> tuple[int, int]; def bcftools_version() -> str          # refuses < MIN_BCFTOOLS
def groups_file(stage: Stage, prefix: str) -> str            # f"{sample_id}\t{prefix}{index:02d}" per sample
def native_query_format(n_populations: int) -> str
def parse_native_line(line: str, stage: Stage) -> tuple[str, SiteCounts | None, dict[tuple[str, str], int]]
def audit_ploidy(report: str, stage: Stage) -> int           # runs checked
def indexed_contigs(vcf: str) -> tuple[str, ...]; def header_contig_lengths(vcf: str) -> dict[str, int]
class NativeBin(frozen): sites: tuple[SiteCounts, ...]; tally: Tally; ploidy_runs: int
def native_region(vcf: str, chrom: str, start: int, end: int, stage: Stage, workdir: Path) -> NativeBin
def native_bin(vcf: str, ref: BinRef, stage: Stage, workdir: Path) -> NativeBin
def query_region(vcf: str, chrom: str, start: int, end: int, stage: Stage, workdir: Path) -> tuple[tuple[SiteCounts, ...], Tally]
def query_bin(vcf: str, ref: BinRef, stage: Stage, workdir: Path) -> tuple[tuple[SiteCounts, ...], Tally]   # view | query → recount_python
```

The pipeline runs once per region, as `subprocess.Popen` processes joined by two FIFOs, with no shell. The audits finish before a bin is recorded. Every plugin stage is written in full, with its own options after `--`:

```text
[view]   bcftools view --regions-overlap pos -r CHR:START-END -S stage.txt -Ou VCF
[tee]    → fifo_ploidy, fifo_partial; stdout → [c]
[audit]  bcftools +check-ploidy -i 'FILTER="PASS"' fifo_ploidy > ploidy.tsv
[guard]  bcftools query -i '<PARTIAL_GENOTYPE>' -f '%CHROM:%POS\n' fifo_partial > partial.txt
[c]      bcftools +fill-tags -Ou - -- -S groups_c.txt -t NS
[gq]     bcftools +setGT -Ou - -- -t q -n . -i '<QC_LOW_GQ>'
[g]      bcftools +fill-tags -Ou - -- -S groups_g.txt -t NS
[dp]     bcftools +setGT -Ou - -- -t q -n . -i '<QC_LOW_DP>'
[d]      bcftools +fill-tags -Ou - -- -S groups_d.txt -t NS
[ab]     bcftools +setGT -Ou - -- -t q -n . -i '<QC_LOW_ALLELE_BALANCE>'
[p]      bcftools +fill-tags -Ou - -- -S groups_p.txt -t NS,AC,AN
[query]  bcftools query -f '<native_query_format(n)>' -
```

- **A non-zero exit** raises `RecountError` naming the stage (e.g. `[p]`) with the last 2 KB of stderr. `+fill-tags` exits 255 on "Incorrect allele" (item 2).
- **A non-empty `partial.txt`** raises `"<first>: partial genotype (D18 item 3)"`.
- **On each PASS line,** run `check_record`, then derive the refusals:
  - `missing = denominator − NS_c`
  - `low_gq = NS_c − NS_g`
  - `low_dp = NS_g − NS_d`
  - `low_allele_balance = NS_d − NS_p`
- **Consistency.** Raise "native counts inconsistent" unless every population satisfies:
  - `0 ≤ NS_p ≤ NS_d ≤ NS_g ≤ NS_c ≤ denominator`;
  - `AN == 2·NS_p` on autosomes and `x_par`, `AN == NS_p` on `y_nonpar`, and `NS_p ≤ AN ≤ 2·NS_p` on `x_nonpar`;
  - `0 ≤ AC ≤ AN`.
- **Ploidy audit.** A run passes only if `expected_ploidy` matches it in every segment it touches.

- [ ] **Step 1: Write the failing tests**

```python
pytestmark = requires_native
BINS = [BinRef("chr1", 0), BinRef("chr1", 19), BinRef("chr1", 20), BinRef("chr11", 5), BinRef("chrX", 1), BinRef("chrX", 100),
        BinRef("chrX", 155), BinRef("chrY", 14), BinRef("chr1", 7)]
def test_version_floor_and_exact_formats():
    assert parse_bcftools_version("bcftools 1.21\nUsing htslib 1.21\n") == (1, 21)
    assert parse_bcftools_version("bcftools 1.23.1\nUsing htslib 1.23.1\n") == (1, 23)   # "1.20" → RecountError naming MIN_BCFTOOLS
    assert groups_file(fixture_stage(), "p").splitlines()[:3] == ["SYN01\tp00", "SYN02\tp00", "SYN03\tp01"]
    assert native_query_format(2) == ("%CHROM\t%POS\t%ID\t%REF\t%ALT\t%FILTER\t%INFO/NS_c00,%INFO/NS_c01\t%INFO/NS_g00,%INFO/NS_g01"
        "\t%INFO/NS_d00,%INFO/NS_d01\t%INFO/NS_p00,%INFO/NS_p01\t%INFO/AC_p00,%INFO/AC_p01\t%INFO/AN_p00,%INFO/AN_p01\n")
@pytest.mark.parametrize("ref", BINS)
def test_native_counts_equal_the_independent_counter(tmp_path, ref):
    vcf = str(indexed_vcf(tmp_path, (FIXTURES / "windows.vcf").read_text()))
    native = native_bin(vcf, ref, fixture_stage(), tmp_path / "n")
    assert (native.sites, native.tally) == query_bin(vcf, ref, fixture_stage(), tmp_path / "q")
def test_a_deletion_spanning_a_bin_boundary_is_counted_once_by_pos(tmp_path):
    vcf = str(indexed_vcf(tmp_path, (FIXTURES / "windows.vcf").read_text()))
    assert [s.variant_id for s in native_bin(vcf, BinRef("chr1", 19), fixture_stage(), tmp_path / "a").sites] == ["chr1-19999998-ATTTT-A"]
    assert [s.variant_id for s in native_bin(vcf, BinRef("chr1", 20), fixture_stage(), tmp_path / "b").sites] == ["chr1-20000001-G-A"]
def test_xx_on_chry_counts_no_missing_refusal_natively(tmp_path):
    t = native_bin(str(indexed_vcf(tmp_path, (FIXTURES / "windows.vcf").read_text())), BinRef("chrY", 14), fixture_stage(), tmp_path / "y").tally
    assert {k: v for k, v in t.refusals.items() if k[1] == "missing"} == {("PapuanSepik", "missing"): 1}
@pytest.mark.parametrize("rec,match", zip([r for r, _ in HARD], ["second ALT", r"\*", r"\[p\]|\[c\]", "partial genotype", "ploidy", "ploidy", "ploidy", "D18 item 4"]))
def test_every_record_and_call_hard_error_stops_the_native_path(tmp_path, rec, match):
    chrom, pos = rec.split()[0], int(rec.split()[1])
    with pytest.raises(RecountError, match=match):
        native_bin(str(indexed_vcf(tmp_path, vcf_with([rec]))), BinRef(chrom, pos // 1_000_000), fixture_stage(), tmp_path / "w")
# test_a_stage_sample_missing_from_the_vcf_fails: a stage with SYN10 → RecountError matching r"\[view\]"
# test_audit_ploidy_reads_runs_by_segment (header "# [1]Sample\t[2]Chromosome\t[3]Region Start\t[4]Region End\t[5]Ploidy"):
#   "SYN01 chrX 1500000 100000000 2" plus "SYN02 chrX 100000000 100000000 1" → 2.
#   "ploidy" errors: SYN02 chrX 1500000–100000000 at 2; SYN01 chrY 14000000 at 1; SYN02 chr1 1000 at 1.
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_gnomad_recount_native.py -v` gives `ImportError`. The tests skip only outside CI, on a machine without bcftools.
- [ ] **Step 3: Implement `native.py`** exactly as the pipeline above.
- [ ] **Step 4: Run the tests; they pass.**
  1. Locally: `bcftools --version | head -1 && uv run pytest tests/test_gnomad_recount_native.py tests/test_gnomad_recount_rule.py -v`. Expected: a version ≥ 1.21, then PASS.
  2. In the PR's `test` job (CI's 1.23.1 pin), the step prints `bcftools 1.23.1`, and `tests/test_reference_tbi.py` and `tests/test_reference_window_io.py` pass with `test_native_reference_tbi_oracle` and `test_live_native_full_and_sparse_controls` reported PASSED, not SKIPPED. Under a local 1.21 those two still fail as before; that is not a regression.
- [ ] **Step 5: Commit.** `git commit -m "feat: count the D18 recount natively with bcftools and audit ploidy per bin (data platform §2.10)"`

---

### Task 6: 20 Mb jobs, ledgers, per-bin resume and the ingest row

**Files:**
- Create: `genomeos/observations/sources/gnomad_recount/jobs.py` and `scripts/recount_gnomad_hgdp_1kg.py` (`plan`, `cite`, `run`, `combine`).
- Modify: `genomeos/tables/measured.py`. The URL form of `IngestInput` (`url` + `md5` + `generation`) takes an optional `sha256`, which `check_ingest_inputs` records and never looks up as a manifest key. `Ingest` gains `sample_rule: str | None = None` and `sample_stage_sha256: str | None = None`, D17's "the sample rule", which stays null for curated ingests.
- Modify: `genomeos/tables/contracts.py` (MINOR 1.1 of `measured.ingests` adds the two nullable columns) and the generated `contract/tables/measured.ingests.v1.schema.json`.
- Modify: `tests/gnomad_recount_fixtures.py`, adding `JobEnv`, `job_env` and `synthetic_complete_ledger`.
- Test: `tests/test_gnomad_recount_jobs.py` (new) and `tests/test_measured_tables.py` (phase 1's).

**Interfaces:** consumes Tasks 1–5 and phase 1's `InputRef`, `recorded_sources`, `measured.{Ingest, IngestInput, check_ingest_inputs}`, `reference.read_reference` and `hgdp_1kg.ALIAS_SOURCES`, and produces:

```python
JOB_SPAN = 20_000_000
RECOUNT_SOURCES = ("genomeos", "gnomad_hgdp_1kg")      # §9: no other source may enter the union
class Job(frozen): chrom: str; index: int; start: int; end: int; bins: tuple[int, ...]   # .job_id = f"{chrom}-{index:02d}"
    # job k spans max(1, k*JOB_SPAN) .. min(length, (k+1)*JOB_SPAN - 1)
def plan_jobs() -> tuple[Job, ...]; def job_by_id(job_id: str) -> Job
class CitedFile(frozen): url: str; size: int; md5: str; generation: int; sha256: str | None   # md5 as 32 hex; sha256 None only for a VCF
def head_identity(url: str) -> CitedFile        # anonymous HEAD: Content-Length, md5 from x-goog-hash (base64 → hex), x-goog-generation
class JobIdentity(frozen): vcf: CitedFile; metadata: CitedFile; karyotypes: CitedFile; stage_name: str; stage_sha256: str
    registry_version: str; registry_inputs: tuple[InputRef, ...]; sources: tuple[str, ...]
    populations: tuple[tuple[str, str], ...]                 # (source_label, population_id)
    cohort_id: str; ingest_version: str; sampling_design: str; disease_ascertainment_excluded: bool
    rule: str; git_sha: str; bcftools: str; duckdb: str
class BinEntry(frozen): file: BinFile; tally: Tally; ploidy_runs: int
class Ledger: job: Job; identity: JobIdentity; bins: dict[int, BinEntry]        # .complete
def read_ledger(path: Path) -> Ledger | None; def write_ledger(path: Path, ledger: Ledger) -> None   # atomic; "gnomad_recount_job_v1"; sorted keys; no timestamps
def run_job(job: Job, identity: JobIdentity, *, source: str, stage: Stage, table: pd.DataFrame, out_root: Path,
            ledger_path: Path, workdir: Path) -> Ledger     # source: what bcftools reads (identity.vcf.url, or a local copy)
class IngestSummary(frozen): identity: JobIdentity; inputs: dict[str, CitedFile]; bins: dict[BinRef, BinEntry]; tally: Tally
    ploidy_runs: int; rows: int; source_record_id_template: str   # identity = chr1-00's; inputs = each chromosome's VCF
def combine_ledgers(ledgers: Sequence[Ledger]) -> IngestSummary
def write_summary(path: Path, s: IngestSummary) -> None; def read_summary(path: Path) -> IngestSummary   # "gnomad_recount_ingest_v1"
def recount_ingest(summary: IngestSummary) -> measured.Ingest
# tests/gnomad_recount_fixtures.py
class JobEnv(frozen): vcf: str; stage: Stage; table: pd.DataFrame; identity: JobIdentity
    def paths(self, out: Path) -> dict    # run_job keywords: source=vcf, stage, table, out_root=out/"bins", ledger_path=out/"ledger.json", workdir=out/"work"
def job_env(tmp_path: Path) -> JobEnv     # a plain function, not a pytest fixture; it indexes windows.vcf, so its callers are @requires_native
def synthetic_complete_ledger(job: Job, *, ingest_version: str = "2026-12-recount") -> Ledger
```

**Fixtures.**
- `job_env`'s identity uses the fixture stage, `RECOUNT_SOURCES` and O1's test values. Its `vcf.url` is the local VCF path, which is never HEADed.
- `synthetic_complete_ledger(job)` carries `SYNTHETIC_IDENTITY`: the fixture's populations, cohort `recount_cohort_id("fixture-8")`, `registry_version = "1.0.0+sha256." + "d" * 64`, `vcf=CitedFile(GNOMAD_VCF_URL.format(chrom=job.chrom), 1, "0" * 32, 1, None)`, and the metadata and karyotypes cited at `METADATA_URL` and `SAMPLE_META_URL` with sha256 `"b" * 64` and `"c" * 64`.
  - Every bin is `BinEntry(BinFile(<its bin_path>, "a" * 64, 1, 1), Tally(pass_records=1, written_sites=1), 1)`.
  - chr11-00's bin 5 also carries refusals `{("Han", "low_gq"): 2}`, `an_zero {"NorthernHan": 1}`, `non_pass {"AC0": 1}` and `monomorphic_in_stage = 1`.

**`recount_ingest`** sets `adapter="genomeos.observations.sources.gnomad_recount"`. The test pins its other fields.
- **`inputs`,** built by keyword: each VCF is `IngestInput(bytes=f.size, url=f.url, md5=f.md5, generation=f.generation)`. The metadata and karyotype files are the same plus `sha256=`, as one entry if they are one file (O3). The stage list is never an input; `sample_rule` and `sample_stage_sha256` record it.
- **`refusals`:** `(reason, population_id, n)` for the four reasons and for `an_zero`, `(f"non_pass:{FILTER}", None, n)`, and `("monomorphic_in_stage", None, n)`.

**`run_job`, before streaming,** refuses unless all of these hold:
- `cohort_id == recount_cohort_id(stage.name)`, `rule == RULE_ID` and `stage_sha256 == stage.ids_sha256`;
- `sources == RECOUNT_SOURCES`. If not, it names the other source.
- `table` covers the stage and equals `populations`;
- `job.chrom` is among `indexed_contigs(source)`. If not, it raises "… has no records on chrN: wrong file for this job?";
- `header_contig_lengths(source)[chrom]` is the GRCh38 length;
- for an http(s) `vcf.url`, `head_identity(vcf.url)` matches `vcf`'s size, md5 and generation, naming the field. This is checked again after the last bin, before the ledger is marked complete;
- any existing ledger's identity is equal. If not, it raises `RecountError` naming the field and touches no file.

**`run_job`, per bin:**
- Skip the bin if its sha256 is already recorded.
- Otherwise run `native_bin`, `binned_rows` (with the identity's ascertainment values) and `write_bin(inputs=identity.registry_inputs, sources=identity.sources)`.
- A rewrite must reproduce the recorded hash ("non-deterministic rewrite").
- Write the ledger after each bin.

**`combine_ledgers`** refuses, listing every problem at once; `test_combine_refuses` names the cases.

**CLI:**
- `plan` prints `{"jobs": [166 ids]}`.
- `cite --chrom C` prints `{"vcf", "metadata", "karyotypes"}` from anonymous `head_identity` calls on `GNOMAD_VCF_URL.format(chrom=C)`, `METADATA_URL` and `SAMPLE_META_URL`.
- `run` takes `--job`, `--cited <json from cite>`, `[--vcf PATH]`, `--metadata`, `--karyotypes`, `--stage`, `--stage-name`, `--registry <reference folder>`, `--registry-release R`, `--ingest-version`, `--sampling-design`, `--disease-ascertainment-excluded {true,false}`, `--out`, `--ledger-dir` and `--workdir`.
  - `cited.vcf.url` must equal `GNOMAD_VCF_URL.format(chrom=…)`. If not, it fails with "not the gnomAD v3.1.2 URL for chr11". `--vcf` reads a local copy instead, for tests and offline reruns.
  - The sha256s of the local metadata and karyotype files fill `cited.*.sha256`. `.bgz` and `.gz` files are read through gzip.
  - `--registry` is read through `reference.read_reference` and filtered to `hgdp_1kg.ALIAS_SOURCES`. `registry_inputs` are the folder's parquet keys under `releases/<R>/` with their sha256s, and `sources` is the union of `provenance.recorded_sources` over them.
  - `git_sha` is `git rev-parse HEAD`, plus `-dirty` if `git status --porcelain --untracked-files=no` is non-empty.
  - Neither ascertainment flag has a default (O1).
- `combine --ledger-dir --out-summary`.

- [ ] **Step 1: Write the failing tests**

```python
def test_the_genome_is_166_jobs_of_at_most_20_bins():
    jobs = plan_jobs()
    assert len(jobs) == len({j.job_id for j in jobs}) == 166 and (sum(j.chrom == "chrX" for j in jobs), sum(j.chrom == "chrY" for j in jobs)) == (8, 3)
    assert job_by_id("chr1-00") == Job("chr1", 0, 1, 19_999_999, tuple(range(20)))
    assert job_by_id("chr1-12") == Job("chr1", 12, 240_000_000, 248_956_422, tuple(range(240, 249)))
    assert sorted(BinRef(j.chrom, b) for j in jobs for b in j.bins) == sorted(lookup_set("s", "v", GRCH38_LENGTHS).bins())
@requires_native
def test_a_job_writes_every_bin_and_its_tallies(tmp_path):
    env = job_env(tmp_path); ledger = run_job(job_by_id("chr1-00"), env.identity, **env.paths(tmp_path))
    assert ledger.complete and [ledger.bins[b].file.rows for b in (0, 19)] == [20, 4] and all(ledger.bins[b].file.rows == 0 for b in range(1, 19))
    total = functools.reduce(Tally.merge, (e.tally for e in ledger.bins.values()))
    assert (total.pass_records, total.written_sites, total.monomorphic_in_stage) == (8, 7, 1)
    assert total.an_zero == Counter({"NorthernHan": 1, "PapuanHighlands": 1, "PapuanSepik": 2})
    assert (total.refusals[("PapuanSepik", "missing")], total.refusals[("Han", "low_gq")]) == (2, 2)
    assert {tuple(json.loads(read_kv(tmp_path / "bins" / e.file.path)["genomeos.sources"])) for e in ledger.bins.values()} == {RECOUNT_SOURCES}
@requires_native
def test_population_mapping_fails_before_any_stream(tmp_path, monkeypatch):
    env = job_env(tmp_path); monkeypatch.setattr(jobs.native, "native_bin", lambda *a: pytest.fail("streamed"))
    with pytest.raises(RecountError, match="PapuanSepik"):
        run_job(job_by_id("chr1-00"), env.identity, **env.paths(tmp_path) | {"table": env.table.iloc[:3]})
    with pytest.raises(RecountError, match="afnd"):
        run_job(job_by_id("chr1-00"), dataclasses.replace(env.identity, sources=("afnd", *RECOUNT_SOURCES)), **env.paths(tmp_path))
def test_combine_and_the_ingest_row(tmp_path):
    summary = combine_ledgers([synthetic_complete_ledger(job) for job in plan_jobs()])
    assert (len(summary.bins), len(summary.inputs), summary.rows) == (3102, 24, 3102)
    write_summary(tmp_path / "s.json", summary); assert read_summary(tmp_path / "s.json") == summary
    ingest, ident = recount_ingest(summary), summary.identity
    assert (ingest.table, ingest.source, ingest.ingest_version, ingest.registry_version, ingest.adapter_git_sha, ingest.n_rows) == (
        "measured.allele_observations_binned", "gnomad_hgdp_1kg", "2026-12-recount", ident.registry_version, ident.git_sha, summary.rows)
    assert (ingest.source_record_id_template, ingest.sample_rule, ingest.sample_stage_sha256) == (
        SOURCE_RECORD_ID_TEMPLATE, ident.cohort_id, ident.stage_sha256)
    assert len(ingest.inputs) == 26 and all(i.key is None and i.url and i.md5 and i.generation for i in ingest.inputs)
    assert {i.url for i in ingest.inputs if i.sha256} == {METADATA_URL, SAMPLE_META_URL}
    assert {("low_gq", "hgdp-han", 2), ("an_zero", "hgdp-northernhan", 1), ("non_pass:AC0", None, 1),
            ("monomorphic_in_stage", None, 1)} <= set(ingest.refusals)
    measured.check_ingest_inputs([ingest], published=())          # check 9: every input is a cited URL with md5 and generation
# test_a_cited_input_without_generation_fails_check_9: one input's generation set to None → "generation"
# test_combine_refuses (parametrized over the synthetic ledgers; RecountError match): chrY-02 dropped → r"missing jobs: \['chrY-02'\]";
#   an extra Job("chr1", 13, …) → "unexpected jobs"; chr1-00 without bin 3 → "incomplete.*chr1-00"; chr2-00 with another stage_sha256 →
#   "stage_sha256"; chr1-01 with another VCF md5 → "two VCFs for chr1"; chr3-00 with a "-dirty" sha → "dirty"; chr3-00 with another sha → "git_sha"
# tests/test_measured_tables.py: sample_rule and sample_stage_sha256 round-trip through ingests_table and read_ingests, and read back None
#   for a curated ingest; IngestInput(bytes=1, url=…, md5=…, generation=…, sha256="b" * 64) passes; sha256 alone (no key, no url) raises
# @requires_native:
#   test_two_runs_give_identical_bins_and_ledgers
#   test_an_interrupted_job_resumes_at_the_first_unwritten_bin: OSError on the first visit to bin 7 leaves bins 0–6 in the ledger;
#     a rerun streams bins 7–19 only, and the final sha256s equal a clean run's
#   test_a_damaged_bin_is_rewritten_to_its_recorded_hash
#   test_a_changed_identity_refuses_to_resume, for "git_sha", "stage_sha256", "ingest_version", "populations", "sampling_design": RecountError(field); mtimes unchanged
#   test_a_job_on_a_chromosome_the_file_lacks_fails_before_writing: chr2-00 → "no records on chr2"; no *.parquet
#   test_a_contig_length_off_grch38_fails_before_writing: ##contig chr1 length=248956421 → "248956421"; no *.parquet
#   test_a_replaced_upstream_object_fails_before_writing: identity.vcf.url = GNOMAD_VCF_URL for chr1, source = the local copy,
#     jobs.head_identity monkeypatched to return generation + 1 → "generation"; no *.parquet
#   test_cli_plan_cite_and_run: plan prints 166 ids; cite (head_identity monkeypatched) prints the three URLs; a cited VCF url of
#     https://example.org/x.vcf.gz exits non-zero with "not the gnomAD v3.1.2 URL for chr11"; --vcf on the fixture exits 0;
#     no --sampling-design exits 2
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_gnomad_recount_jobs.py tests/test_measured_tables.py -k "recount or sample_rule or IngestInput" -v` gives `ImportError`.
- [ ] **Step 3: Implement `jobs.py`, the four subcommands and the `measured.ingests` 1.1 fields.** Then regenerate the contracts with `uv run python scripts/freeze_contract.py`.
- [ ] **Step 4: Run the tests; they pass.** `uv run pytest tests/test_gnomad_recount_jobs.py tests/test_measured_tables.py -v && uv run python scripts/freeze_contract.py --check && uv run python scripts/check_module_size.py && uvx pyright genomeos/observations/sources/gnomad_recount/jobs.py scripts/recount_gnomad_hgdp_1kg.py`.
- [ ] **Step 5: Commit.** `git commit -m "feat: run the whole-genome recount in 166 resumable 20 Mb jobs that cite their inputs (data platform §2.10, D17)"`

---

### Task 7: Independent cross-check on sampled bins and measured windows

**Files:**
- Create: `genomeos/observations/sources/gnomad_recount/crosscheck.py`.
- Modify: `scripts/recount_gnomad_hgdp_1kg.py`, adding `compare --region chr:start-end --vcf …`, which writes no files.
- Modify: `pyproject.toml`. Under `[tool.pytest.ini_options]`, set `markers = ["network: streams public gnomAD bytes anonymously; run with -m network"]` and `addopts = "-q -m 'not network'"`.
- Test: `tests/test_gnomad_recount_crosscheck.py` (new), and `tests/test_gnomad_recount_network.py` (new, with `pytestmark = pytest.mark.network`).

**Interfaces:** consumes Tasks 2–6, and produces:

```python
SEED = 42
REQUIRED_BINS = (BinRef("chr11", 5), BinRef("chrX", 1), BinRef("chrX", 100), BinRef("chrX", 155), BinRef("chrY", 14))
def choose_check_bins(bins: Mapping[BinRef, Tally], *, extra: int = 3, seed: int = SEED) -> tuple[BinRef, ...]
def site_cells(sites: Sequence[SiteCounts], stage: Stage) -> pd.DataFrame          # variant_id, source_label, ac, an (an > 0)
def compare_cells(label: str, expected: pd.DataFrame, actual: pd.DataFrame) -> list[str]
class CrosscheckResult(frozen): chrom: str; start: int; end: int; cells: int; identical: int; tally_equal: bool; pass_non_snv: int
def crosscheck_bin(entry: BinEntry, ref: BinRef, *, vcf: str, stage: Stage, out_root: Path, workdir: Path) -> CrosscheckResult
def compare_counters(vcf: str, chrom: str, start: int, end: int, stage: Stage, workdir: Path) -> CrosscheckResult
# tests/test_gnomad_recount_crosscheck.py: _tallies_with_non_snv(m) → {ref: Tally(pass_records=1, written_sites=1, pass_non_snv=m.get(ref, 0))}
#   for every bin of GRCH38_LENGTHS; CELLS = 6 cells (2 variants × Han, NorthernHan, PapuanSepik), index 0–5
# tests/test_gnomad_recount_network.py: stand_in_stage(sample_meta: bytes) -> Stage; module fixture stand_in
```

- **`choose_check_bins`** returns these, without duplicates:
  1. `REQUIRED_BINS`, each of which must have `pass_records > 0` or the function raises an error naming it;
  2. the autosomal bin with the most `pass_non_snv`, ties going to the earliest bin in GRCh38 order;
  3. `extra` bins drawn with `random.Random(seed).sample` from the other autosomal bins with `written_sites > 0`, sorted before the draw.
- **`crosscheck_bin`** requires all of these, or raises `RecountError` listing up to 5 cells:
  - published cells = native cells;
  - independent cells and tally = native;
  - the recorded tally = native;
  - `ploidy_runs > 0` wherever there are PASS records.
- **`stand_in_stage`** reproduces the spec's measured stand-in:
  1. decode the bgzipped sample-meta TSV and keep the `high_quality` samples (assert 4,097);
  2. write `s\tpopulation` bytes, with population = `hgdp_tgp_meta.population` (78 labels);
  3. keep `s` and the `gnomad_sex_imputation` JSON as the karyotype bytes;
  4. return `read_stage(metadata, karyotypes, <sorted LF-terminated ids>, name="stand-in-high-quality")`.

  The `stand_in` module fixture applies it to `urllib.request.urlopen(SAMPLE_META_URL).read()`.

- [ ] **Step 1: Write the failing tests**

```python
def test_sampling_covers_every_check_12_class_and_is_reproducible():
    assert [bin_region(r) for r in REQUIRED_BINS] == ["autosome", "par", "nonpar", "straddles_par", "nonpar"]
    bins = _tallies_with_non_snv({BinRef("chr7", 3): 900, BinRef("chr2", 100): 40})   # every bin has PASS records
    chosen = choose_check_bins(bins, extra=3)
    assert chosen[:6] == (*REQUIRED_BINS, BinRef("chr7", 3)) and len(chosen) == len(set(chosen)) == 9
    assert chosen == choose_check_bins(dict(reversed(list(bins.items()))), extra=3) and chosen[6:] != choose_check_bins(bins, extra=3, seed=7)[6:]
    with pytest.raises(RecountError, match="chrY"):
        choose_check_bins(bins | {BinRef("chrY", 14): Tally()}, extra=0)
def test_compare_cells_ignores_order_and_names_differences():
    assert compare_cells("independent", CELLS, CELLS.sample(frac=1, random_state=SEED)) == []
    problems = compare_cells("independent", CELLS, CELLS.iloc[1:].assign(an=lambda d: d["an"].where(d.index != 3, d["an"] + 1)))
    assert len(problems) == 2 and any("only in" in p for p in problems) and CELLS.loc[3, "variant_id"] in " ".join(problems)
@requires_native
def test_a_clean_bin_matches_cell_for_cell(tmp_path):
    env = job_env(tmp_path); ledger = run_job(job_by_id("chr1-00"), env.identity, **env.paths(tmp_path))
    assert crosscheck_bin(ledger.bins[0], BinRef("chr1", 0), vcf=env.vcf, stage=env.stage, out_root=tmp_path / "bins",
                          workdir=tmp_path / "w") == CrosscheckResult("chr1", 1, 999_999, 20, 20, True, 3)
# @requires_native test_a_wrong_count_or_tally_is_caught: an extra ac at chr1:2000 → "chr1-2000-ATCT-A"; one extra ("Han", "low_gq") → "low_gq"
MEASURED = {("chr11", 5_200_000, 5_250_000): 265_419, ("chrX", 100_000_000, 100_100_000): 284_954,   # tests/test_gnomad_recount_network.py
            ("chrY", 14_000_000, 14_100_000): 42_111}                                                  # §2.10; 592,484 in all
OTHER = [("chrX", 1_000_000, 1_010_000), ("chrX", 155_800_000, 155_810_000), ("chr21", 25_000_000, 26_999_999), ("chr2", 100_000_000, 100_999_999)]
@pytest.mark.parametrize("window", MEASURED)
def test_counters_reproduce_the_measured_cells(tmp_path, stand_in, window):
    result = compare_counters(GNOMAD_VCF_URL.format(chrom=window[0]), *window, stand_in, tmp_path); print(result)
    assert (result.cells, result.identical, result.tally_equal) == (MEASURED[window], MEASURED[window], True)
    assert window[0] != "chr11" or result.pass_non_snv > 0          # chr11 is the indel-rich window (560 of 3,812 records not SNVs)
@pytest.mark.parametrize("window", OTHER)
def test_counters_agree_on_the_other_windows(tmp_path, stand_in, window):     # counts go in the PR; never asserted
    result = compare_counters(GNOMAD_VCF_URL.format(chrom=window[0]), *window, stand_in, tmp_path); print(result)
    assert result.cells > 0 and result.identical == result.cells and result.tally_equal
def test_rs334_under_the_stand_in(tmp_path, stand_in):
    sites, _ = query_region(GNOMAD_VCF_URL.format(chrom="chr11"), "chr11", 5_227_002, 5_227_002, stand_in, tmp_path)
    cells = site_cells([s for s in sites if s.variant_id == "chr11-5227002-T-A"], stand_in)
    assert (len(cells), int(cells["ac"].sum()), int(cells["an"].sum())) == (78, 208, 8188)
```

The windows are §2.10's regions as written (`chr11:5200000-5250000`, and so on). If a measured count differs, stop and report it with the region. Never edit the expected value.

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_gnomad_recount_crosscheck.py -v` gives `ImportError`.
- [ ] **Step 3: Implement `crosscheck.py` and `compare`.**
- [ ] **Step 4: Run the tests offline; they pass.** `uv run pytest tests/test_gnomad_recount_crosscheck.py -v && uv run pytest --collect-only -m network tests/test_gnomad_recount_network.py`. Expected: PASS, then `8 tests collected` with exit code 0.
- [ ] **Step 5: Verify against the real windows** (anonymous, about 20 minutes). Run `uv run pytest -m network tests/test_gnomad_recount_network.py -v -s`. Expected: 8 passed. Paste the printed results into the PR.
- [ ] **Step 6: Commit.** `git commit -m "feat: cross-check the native recount with the independent counter on sampled bins (data platform §2.7 check 12)"`

---

### Task 8: Retire the fitted-and-curated assumption (builder's call 36)

**Files:**
- **`genomeos/observations/sources/gnomad_hgdp_1kg.py`.** The docstring says this is the curated TSV route: fixture-backed, not the 4,094 callset, with whole-genome rows coming only from `gnomad_recount`. Set `COHORT_ID = "gnomad-hgdp-1kg:curated-tsv"`.
- **`scripts/build_observations.py`.**
  - `--gnomad` becomes optional, with the help text "curated per-population TSV (fixture-backed); published whole-genome rows come from scripts/recount_gnomad_hgdp_1kg.py".
  - The script calls `gnomad.load` only when the flag is given.
  - It prints `gnomAD HGDP+1KG curated TSV: <n> rows (cohort <COHORT_ID>)` or `… curated TSV: not supplied`.
  - Update the usage text.
- **`AGENTS.md`.**
  - Below the end-to-end rebuild, which keeps `--gnomad`, add one sentence: the TSV is the optional curated route, and whole-genome rows come only from `scripts/recount_gnomad_hgdp_1kg.py` (§2.10, D18).
  - Under "Repository layout", add `observations/sources/gnomad_recount/`.
  - Under "Commands", note bcftools ≥ 1.21, bgzip and tabix, and `-m network`.
- **Test:** `tests/test_gnomad_source.py`, `tests/test_build_scripts.py`.

**Interfaces:**
- Consumes: `recount_cohort_id` and `reference_cohorts.PAPER_STAGE`.
- Produces: `gnomad_hgdp_1kg.COHORT_ID == "gnomad-hgdp-1kg:curated-tsv"`. The signature of `load` is unchanged.

- [ ] **Step 1: Write the failing tests**

```python
def test_cohort_id_names_the_curated_tsv_count_set_not_a_gnomad_release(registry):            # tests/test_gnomad_source.py
    obs = gnomad.load(FIXTURES / "gnomad_hgdp_1kg_freqs.tsv", *registry, "0.1.0")
    assert set(obs["cohort_id"]) == {"gnomad-hgdp-1kg:curated-tsv"} and gnomad.COHORT_ID != recount_cohort_id(PAPER_STAGE)
def test_build_observations_runs_without_the_curated_gnomad_tsv(tmp_path):                   # tests/test_build_scripts.py
    registry, out = tmp_path / "registry", tmp_path / "observations"; _write_registry(registry)
    command = _command(registry, out); flag = command.index("--gnomad"); del command[flag : flag + 2]
    completed = _run(command)
    assert completed.returncode == 0, completed.stderr
    assert "gnomAD HGDP+1KG curated TSV: not supplied" in completed.stdout and "gnomad_hgdp_1kg" not in set(read_observations(out)["source"])
# test_build_observations_reports_the_curated_tsv_cohort: with --gnomad, stdout has "gnomAD HGDP+1KG curated TSV: 4 rows (cohort gnomad-hgdp-1kg:curated-tsv)"
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_gnomad_source.py tests/test_build_scripts.py -v`. Expected: the 3 new tests FAIL.
- [ ] **Step 3: Make the changes.**
- [ ] **Step 4: Verify.**
  1. Run the two test files.
  2. Run AGENTS.md's rebuild unchanged.
  3. Run `uv run ruff check . && uv run python scripts/check_private_files.py && uv run python scripts/smoke.py && uv run pytest`.
  4. Run `git grep -n "gnomad-v4-hgdp-1kg" -- genomeos scripts tests AGENTS.md`.

  Expected: everything passes, the rebuild prints `… 4 rows (cohort gnomad-hgdp-1kg:curated-tsv)`, and the grep prints nothing.
- [ ] **Step 5: Commit.** `git commit -m "fix: keep the gnomAD TSV as the fixture-backed curated route and name its count set (builder's call 36)"`

---

### Task 9: The four lookup macros, rendered as SQL, and their 1.2.2 attach

**Files:**
- Create: `genomeos/tables/lookup_macros.py`. It is pure strings: it imports neither duckdb nor `genomeos.surfaces`. It cites §2.2 rule 3, §2.6, §2.9, §3.1 and calls 30–31.
- Modify: `tests/lookup_fixtures.py`, adding the fixture helpers below.
- Modify: `scripts/build_catalog_fixture.py`, `scripts/check_catalog_attach.py`, `tests/fixtures/catalog/**` (regenerated) and `tests/test_catalog_fixture.py`, for call 15's 1.2.2 attach.
- Test: `tests/test_lookup_macros.py` (new).

**Interfaces:**
- Consumes:
  - Task 1;
  - Task 2's `SOURCE_RECORD_ID_TEMPLATE`, `source_record_id_sql` and `write_bin`;
  - `schema.VARIANT_ID_PATTERN` and `contracts.LOCUS_VARIANT_ID_PATTERN`;
  - phase 1's `writer.build_catalog_db` and `writer.write_frame`, and phase-1 Task 14's fixture.

  The tests also use `OBSERVATIONS_SCHEMA` and `artifacts.FORMAT_THREE_COLUMNS`.
- Produces:

```python
OBSERVATION_COLUMNS: tuple[tuple[str, str], ...]   # variant_id, rsid, population_id VARCHAR; lat, lon, radius_km DOUBLE; ac, an BIGINT;
    # source_record_id, source, assay VARCHAR; date_lower, date_upper BIGINT; sampling_design VARCHAR;
    # disease_ascertainment_excluded BOOLEAN; cohort_id, ingest_version VARCHAR
SURFACE_COLUMNS: tuple[tuple[str, str], ...]       # FORMAT_THREE_COLUMNS typed, then measurement VARCHAR, artifact_format INTEGER, served BOOLEAN
EARTH_RADIUS_KM = 6371.0088; MAX_MACRO_BYTES = 131_072
STRICT_LOCUS_PATTERN = r"^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$"
class FileRef(frozen): path: str; url: str
class PublishedLookupSet(frozen): lookup: LookupSet; url_prefix: str; source_record_id_template: str   # url_prefix = <lookup base>releases/<R>/
class CuratedFile(frozen): file: FileRef; keys: frozenset[str]
class SurfaceFile(frozen): file: FileRef; variant_id: str; model_version: str; data_version: str; measurement: str
    artifact_format: int; served: bool; columns: frozenset[str]
def curated_key(variant_id: str) -> str   # v if re.fullmatch(LOCUS_VARIANT_ID_PATTERN, v) else v.split(":", 1)[0] + ":"
def file_sql(ref: FileRef) -> str         # coalesce(rtrim(getvariable('genomeos_local'), '/') || '/<path>', '<url>')
def lookup_statements(lookups: Sequence[PublishedLookupSet], curated: Sequence[CuratedFile],
                      surfaces: Sequence[SurfaceFile]) -> tuple[str, str, str, str]
    # CREATE MACRO measured.lookup_url(v), measured.variant(v), measured.near(v, lat0, lon0, km), inferred.surfaces(v); DataReleaseError on refusal
# tests/lookup_fixtures.py
LOOKUP_TEST_BASE = "https://storage.googleapis.com/example-lookup/"; DATA_TEST_BASE = "https://storage.googleapis.com/example-data/"
RECOUNT = "gnomad-v3.1.2-hgdp-1kg:fixture-3:d18-v1"
class MacroRelease(frozen): data_root: Path; lookups: tuple[PublishedLookupSet, ...]; curated: tuple[CuratedFile, ...]; surfaces: tuple[SurfaceFile, ...]
def macro_release(root: Path) -> MacroRelease            # writes the fixture below under root/"data"
def write_curated(path: Path, rows: pd.DataFrame, *, url: str) -> CuratedFile
def write_cells(path: Path, rows: pd.DataFrame, *, with_prior_sd: bool) -> None
def attach_local(statements: Sequence[str], data_root: Path, local: str) -> duckdb.DuckDBPyConnection
    # builds a catalog with build_catalog_db, attaches it read-only as atlas, then SET VARIABLE genomeos_local = local
# tests/test_lookup_macros.py (module-scope fixtures): release = macro_release(...); local = f"{release.data_root}/";
#   atlas = attach_local(lookup_statements(release.lookups, release.curated, release.surfaces), release.data_root, local);
#   atlas_without_binned_tree = the same over a copy with the binned tree deleted
```

**Fixture (`macro_release`).** It writes under `root/data/` and always sets `genomeos_local`, so the `LOOKUP_TEST_BASE` and `DATA_TEST_BASE` URLs are never contacted.
- **Lookup set:** `lookup_set("gnomad_hgdp_1kg", "2026-12-recount", GRCH38_LENGTHS)`, with url_prefix `LOOKUP_TEST_BASE + "releases/2026-12-01/"` and `SOURCE_RECORD_ID_TEMPLATE`. Rows carry cohort `RECOUNT`.
- **Bin chr11/5 (the only bin written):** rs334 for Yoruba (7/210), Han (0/66) and NorthernHan (0/20), and `chr11-5227003-C-T` for the same three populations.
- **Curated A** (`gnomad_hgdp_1kg`, `tsv-fixture`): 2 rs334 rows with cohort `gnomad-hgdp-1kg:curated-tsv` (5/200 and 1/100), and 4 `hla:a-02-01` rows.
- **Curated B** (`publications`, `pub-fixture`): 2 `chrM-16519-T-C` rows, and 2 `chr11-5227010-G-A` rows at 11.2009, 3.3792 (520 km north of Lagos): `near-in` with r30 and `near-out` with r10.
- **Cells:**
  - HbS v1: 4 cells, no `prior_frequency_sd`, format 1, not served.
  - HbS v3: 5 cells, format 3, served.
  - `kir:2dl1` v3: 3 cells, `carrier_frequency`.

- [ ] **Step 1: Write the failing tests**

```python
def test_variant_returns_17_contract_columns_and_unions_recount_and_curated_apart(atlas):
    described = atlas.execute("DESCRIBE SELECT * FROM atlas.measured.variant('chr11-5227002-T-A')").fetchall()
    assert [(r[0], r[1]) for r in described] == list(OBSERVATION_COLUMNS) and [n for n, _ in OBSERVATION_COLUMNS] == list(OBSERVATIONS_SCHEMA.columns)
    assert atlas.execute("SELECT cohort_id, count(*), sum(ac), sum(an) FROM atlas.measured.variant('chr11-5227002-T-A') GROUP BY 1 ORDER BY 1"
                         ).fetchall() == [("gnomad-hgdp-1kg:curated-tsv", 2, 6, 300), (RECOUNT, 3, 7, 296)]
    assert {r[0] for r in atlas.execute("SELECT source_record_id FROM atlas.measured.variant('chr11-5227002-T-A') WHERE cohort_id = ?", [RECOUNT]).fetchall()
            } == {f"gnomad-hgdp-1kg:chr11-5227002-T-A:{x}" for x in ("Yoruba", "Han", "NorthernHan")}
@pytest.mark.parametrize("v, rows", [("chrM-16519-T-C", 2), ("hla:a-02-01", 4), ("kir:2dl1", 0), ("phenotype:g6pd-deficiency", 0), ("chr21-47000001-A-G", 0)])
def test_ids_off_the_recorded_set_read_curated_rows_only(atlas_without_binned_tree, v, rows):   # any computed path would raise
    assert atlas_without_binned_tree.execute("SELECT count(*) FROM atlas.measured.variant(?)", [v]).fetchone() == (rows,)
    assert atlas_without_binned_tree.execute("SELECT atlas.measured.lookup_url(?)", [v]).fetchone() == ([],)
def test_lookup_url_macro_agrees_with_python_at_every_contig_edge(atlas, release, local):
    lookup = release.lookups[0].lookup
    for chrom, length in GRCH38_LENGTHS.items():
        for pos in (1, length, lookup.n_bins(chrom) * BIN_BP):
            v = f"{chrom}-{pos}-A-G"; expected = variant_bin_path(lookup, v)
            assert atlas.execute("SELECT atlas.measured.lookup_url(?)", [v]).fetchone()[0] == ([] if expected is None else [local + expected])
@pytest.mark.parametrize("slash", ["", "/"])
def test_offline_root_takes_either_form(release, slash):
    con = attach_local(lookup_statements(release.lookups, release.curated, release.surfaces), release.data_root, str(release.data_root) + slash)
    assert con.execute("SELECT count(*) FROM atlas.measured.variant('chr11-5227002-T-A')").fetchone() == (5,)
    assert con.execute("SELECT atlas.measured.lookup_url('chr11-5227002-T-A')").fetchone()[0] == [
        f"{release.data_root}/{variant_bin_path(release.lookups[0].lookup, 'chr11-5227002-T-A')}"]
@pytest.mark.parametrize("bad", ["rs334", "11-5227002-T-A", "chr11-5227002-t-a", "chr11-5227002-T-A' OR '1'='1", "chr11-05227002-T-A",
                                 "chr11-1234567890-T-A", None])
def test_a_malformed_id_is_an_error_not_an_empty_result(atlas, bad):
    for call in ("measured.variant(?)", "measured.near(?, 6.5, 3.4, 500)", "inferred.surfaces(?)"):
        with pytest.raises(duckdb.InvalidInputException, match="chr-pos-ref-alt"):
            atlas.execute(f"SELECT * FROM atlas.{call}", [bad]).fetchall()
def test_near_and_surfaces(atlas):
    assert atlas.execute("SELECT population_id FROM atlas.measured.near('chr11-5227010-G-A', 6.5244, 3.3792, 500)").fetchall() == [("near-in",)]
    assert atlas.execute("SELECT model_version, measurement, artifact_format, served, count(*), count(prior_frequency_sd) "
                         "FROM atlas.inferred.surfaces('chr11-5227002-T-A') GROUP BY ALL ORDER BY 1").fetchall() == [
        ("v1", "allele_frequency", 1, False, 4, 0), ("v3", "allele_frequency", 3, True, 5, 5)]
    obs = {r[0] for r in atlas.execute("DESCRIBE SELECT * FROM atlas.measured.variant('chr11-5227002-T-A')").fetchall()}
    surf = {r[0] for r in atlas.execute("DESCRIBE SELECT * FROM atlas.inferred.surfaces('chr11-5227002-T-A')").fetchall()}
    assert obs & surf == {"variant_id"} and not any("freq" in c for c in obs)
    assert [n for n, _ in SURFACE_COLUMNS][: len(FORMAT_THREE_COLUMNS)] == list(FORMAT_THREE_COLUMNS)
def test_rendering_is_order_independent_bounded_and_safe(release):
    lookups, curated, surfaces = release.lookups, release.curated, release.surfaces
    assert lookup_statements(lookups, curated, surfaces) == lookup_statements(lookups, curated[::-1], surfaces[::-1])
    assert curated_key("chrM-16519-T-C") == "chrM-16519-T-C" and curated_key("hla:a-02-01") == "hla:"
    with pytest.raises(dr.DataReleaseError, match="MAX_MACRO_BYTES"):
        lookup_statements(lookups, [CuratedFile(curated[0].file, frozenset(f"chr1-{i}-A-G" for i in range(1, 20_000)))], surfaces)
    # DataReleaseError also matches "quote" (a ' in a URL), "variant id" (a ' in a surface id) and "measurement" ('frequency')
# test_kir_surfaces_are_carrier_frequency: DISTINCT measurement for 'kir:2dl1' == [("carrier_frequency",)]
# test_curated_files_without_the_key_are_never_opened: with curated B deleted, 'hla:a-02-01' still gives 4 rows
# test_surfaces_of_an_id_without_artifacts_open_nothing: with the cells deleted, 'chr1-1000-A-G' gives 0 rows
# test_a_release_without_curated_files_renders_a_runnable_variant_macro: rs334 gives 3 recount rows
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_lookup_macros.py -v` gives `ModuleNotFoundError`.
- [ ] **Step 3: Implement it in this shape, which the tests do not fix.** Macros pick their SQL at bind time with `query(CASE … END)`, because on DuckDB 1.5.5 and 1.2.2 (measured 2026-11-14) `read_parquet([])` fails and an attached macro cannot call another macro.

```sql
CREATE MACRO measured.variant(v) AS TABLE
SELECT * FROM query(CASE WHEN NOT coalesce(regexp_full_match(v, '<VARIANT_ID_PATTERN>')
                                          AND (NOT starts_with(v, 'chr') OR regexp_full_match(v, '<STRICT_LOCUS_PATTERN>')), false)
  THEN 'SELECT error(''measured.variant takes a GRCh38 chr-pos-ref-alt id or a phenotype:, hla:, kir:, mic: or cyt: id'')::VARCHAR AS variant_id, <16 typed NULLs>'
  ELSE '<typed 17-column SELECT … WHERE false>' END)
UNION ALL  -- per published lookup set
SELECT * FROM query(CASE WHEN regexp_full_match(v, '<LOCUS_ID_PATTERN over the recorded contigs>')
     AND CAST(split_part(v, '-', 2) AS BIGINT) // 1000000 < CASE split_part(v, '-', 1) WHEN 'chr1' THEN 249 … END
  THEN 'SELECT <17 cast columns; source_record_id from source_record_id_sql(template)> FROM read_parquet('''
       || coalesce(rtrim(getvariable('genomeos_local'), '/') || '/', '<url_prefix>')
       || '<prefix>chrom=' || <chrom> || '/bin=' || <bin> || '/part-0.parquet'') WHERE pos = ' || split_part(v, '-', 2) || ' AND variant_id = ''' || v || ''''
  ELSE '<typed empty>' END)
UNION ALL  -- per non-withdrawn curated file
SELECT * FROM query(CASE WHEN <curated_key(v)> IN (<its sorted keys>) THEN 'SELECT <17 cast columns> FROM read_parquet(''' || <file_sql>
       || ''') WHERE variant_id = ''' || v || '''' ELSE '<typed empty>' END)
```

  - `v` is spliced in only after it matches a pattern that admits no quote. Any literal containing `'` is refused.
  - `lookup_url` collects the same URL expression into a list.
  - `near` applies `2 * 6371.0088 * asin(sqrt(<haversine>)) <= km + radius_km` to the same union.
  - `inferred.surfaces` returns every live version's cells. It uses the same guard, then `query(CASE v WHEN '<id>' THEN '<UNION ALL per SurfaceFile>' … ELSE '<typed empty>' END)`. Each branch projects `SURFACE_COLUMNS`, with typed NULLs for absent columns and literals for `measurement`, `artifact_format` and `served`.
  - Each curated file's key set holds the exact id for a locus, or the namespace for any other id (`curated_key`). Withdrawn files are left out at render time (see the Deviations). The four statements total at most `MAX_MACRO_BYTES`.
  - All output is sorted.
- [ ] **Step 4: Run the tests; they pass.** `uv run pytest tests/test_lookup_macros.py -v && uv run pytest tests/test_web_layout.py -k bucket -q && uvx pyright genomeos/tables/lookup_macros.py`.
- [ ] **Step 5: Write the failing attach test (call 15).** In `tests/test_catalog_fixture.py`, `test_the_attach_check_runs_the_macros`: under 1.5.5, `check(...)` on the committed fixture returns `[]`, and an `expected.json` claiming 4 recount rows gives a problem naming `measured.variant`. Run `uv run pytest tests/test_catalog_fixture.py -q`. Expected: FAIL, because the fixture has no macros.
- [ ] **Step 6: Extend phase-1 Task 14's committed fixture.**
  - **`build_fixture`,** under 1.5.5, also writes two files:
    - Bin chr11/5's three rs334 rows, through `write_bin` on `lookup_set("gnomad_hgdp_1kg", "2026-12-recount", {"chr11": GRCH38_LENGTHS["chr11"]})`;
    - Curated A's 2 rs334 rows, through `writer.write_frame` (table `measured.allele_observations`).

    It then appends `lookup_statements(...)` (url_prefix `https://storage.googleapis.com/example-lookup/releases/2026-11-20/`, no surfaces) to `catalog.sql` before `build_catalog_db`. `--check` also compares the macro SQL.
  - **`expected.json`** gains `"macros": {"variant": [["gnomad-hgdp-1kg:curated-tsv", 2, 6, 300], ["gnomad-v3.1.2-hgdp-1kg:fixture-3:d18-v1", 3, 7, 296]], "lookup_url_chrM": [], "surfaces_rows": 0}`.
  - **`check`** compares three queries with it: `measured.variant('chr11-5227002-T-A')` grouped by `cohort_id` (rows, Σac, Σan), `measured.lookup_url('chrM-16519-T-C')`, and the row count of `inferred.surfaces('chr11-5227002-T-A')`. It then prints `macros: rs334 2 curated + 3 recount rows; chrM-16519-T-C computes no URL`.
- [ ] **Step 7: Verify on the oldest client.** Run `uv run python scripts/build_catalog_fixture.py && uv run pytest tests/test_catalog_fixture.py -q && uv run --no-project --with duckdb==1.2.2 python -I scripts/check_catalog_attach.py --catalog tests/fixtures/catalog/atlas.duckdb --local tests/fixtures/catalog/data --expect tests/fixtures/catalog/expected.json`. Expected: PASS, then the phase-1 line `DuckDB 1.2.2: tests/fixtures/catalog/atlas.duckdb attached read-only; <n> views read offline`, then `macros: rs334 2 curated + 3 recount rows; chrM-16519-T-C computes no URL`. CI's existing step "Catalog attaches from DuckDB 1.2.x" runs the same check.
- [ ] **Step 8: Commit.** `git commit -m "feat(tables): render measured.variant, measured.near, measured.lookup_url and inferred.surfaces, attachable from DuckDB 1.2.2 (data platform §2.6, §3.1)"`

---

### Task 10: The gate over loopback HTTP on a 3,102-file tree

**Files:**
- Create: `tests/range_server.py`.
- Test: `tests/test_lookup_gate.py` (new).

**Interfaces:**
- Consumes: Tasks 1, 2 and 9, and phase 1's `writer.build_catalog_db`.
- Produces `Request(method: str, path: str, bytes: int)` and `serve(root: Path) -> RangeServer`:
  - `RangeServer` is a context manager with `base: str`, `requests() -> list[Request]`, `clear()` and `deny(prefix: str)`.
  - It runs a `ThreadingHTTPServer` on 127.0.0.1:0, built like `tests/test_fetch_data.py::store`.
  - HEAD returns 200 with `Content-Length` and `Accept-Ranges: bytes`.
  - Requests for `bytes=a-b` and `bytes=a-` return 206 with `Content-Range`.
  - A missing path returns 404, and a denied prefix returns 403 with `Content-Length: 0`.
  - Each request is logged before its body is written.
- Produces, in the test module, `GATE_VARIANT` and the module-scope `gate` fixture: a `Gate` with `server: RangeServer`, `root: Path`, `uncurated_variant: str`, `attach() -> list[Request]` (a cold connection attaches the catalog), `attached() -> duckdb.DuckDBPyConnection` (cold and attached, requests cleared), `lookup(v: str) -> list[Request]` (the requests of `measured.variant(v)`) and `path_of(chrom: str, bin: int) -> str` (the bin's server path).

**Gate fixture** (module scope, serving `tmp/releases/2026-12-01/`):
- **The chr11:5 bin:** 49,152 variants at 5,000,000 + 20·i, every 7th an indel, × 80 populations, for 3,932,160 rows.
  - About 90% of `ac` are 0 (chosen by `hash(i, j)`), and `an` is 90–100.
  - The file is about 2.9 MB, and `GATE_VARIANT` is i = 24,576.
- **Other bins:** the other 3,101 are symlinks to one empty bin.
- **Curated files:** 3 files of 2,000 rows over 700 ids. `GATE_VARIANT` is in exactly one, and `uncurated_variant` is in none.
- **Surfaces:** 61 `SurfaceFile`s. Curated keys are padded until the statements total `MAX_MACRO_BYTES − 1 KiB`.
- **Catalog:** `build_catalog_db` writes `catalog/atlas.duckdb`. Every URL is on `server.base`, and the lookup url_prefix is `f"{server.base}releases/2026-12-01/"`.
- **Connections:** cold, with `INSTALL httpfs; LOAD httpfs` run by the fixture itself (no CI step), and `enable_http_metadata_cache`, `enable_external_file_cache` and `parquet_metadata_cache` all false. If `INSTALL httpfs` fails, the test fails; it is never skipped.

- [ ] **Step 1: Write the failing tests**

```python
BINNED = "/allele_observations_binned/"
def test_attach_reads_at_most_0_6_mb(gate):
    assert sum(r.bytes for r in gate.attach()) <= 600_000
def test_one_lookup_reads_at_most_300_kb_in_at_most_15_requests(gate):
    con = gate.attached(); gate.server.clear()
    rows = dict(con.execute("SELECT source, count(*) FROM atlas.measured.variant(?) GROUP BY 1", [GATE_VARIANT]).fetchall()); reqs = gate.server.requests()
    assert rows["gnomad_hgdp_1kg"] == 80 and sum(r.bytes for r in reqs) <= 300_000 and len(reqs) <= 15
    assert {r.path for r in reqs if BINNED in r.path} == {gate.path_of("chr11", 5)} and len({r.path for r in reqs if "/allele_observations/" in r.path}) == 1
def test_a_variant_in_no_curated_file_touches_only_its_bin(gate):
    reqs = gate.lookup(gate.uncurated_variant)
    assert not [r for r in reqs if "/allele_observations/" in r.path] and sum(r.bytes for r in reqs) <= 300_000 and len(reqs) <= 15
@pytest.mark.parametrize("v", ["chrM-16519-T-C", "hla:a-02-01", "kir:2dl1", "chr21-47000001-A-G"])
def test_ids_off_the_recorded_set_make_no_lookup_bucket_request(gate, v):
    assert not [r for r in gate.lookup(v) if BINNED in r.path]
def test_a_tripped_brake_fails_the_lookup_loudly(gate):
    gate.server.deny("/releases/2026-12-01/tables/v1/measured/allele_observations_binned/")
    with pytest.raises(duckdb.HTTPException, match=r"allele_observations_binned/.*chrom=chr11/bin=5/part-0\.parquet"):
        gate.attached().execute("SELECT * FROM atlas.measured.variant(?)", [GATE_VARIANT]).fetchall()
@pytest.mark.parametrize("slash", ["", "/"])
def test_offline_mode_reads_the_downloaded_bin_with_no_http(gate, slash):
    con = gate.attached(); con.execute(f"SET VARIABLE genomeos_local = '{gate.root}/releases/2026-12-01{slash}'"); gate.server.clear()
    assert con.execute("SELECT count(*) FROM atlas.measured.variant(?) WHERE source = 'gnomad_hgdp_1kg'", [GATE_VARIANT]).fetchone() == (80,)
    assert gate.server.requests() == []
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_lookup_gate.py -v` gives `ModuleNotFoundError: No module named 'tests.range_server'`.
- [ ] **Step 3: Implement the server and the fixture.**
- [ ] **Step 4: Run the tests; they pass.** `uv run pytest tests/test_lookup_gate.py -v --durations=5`. The probe measured attach at about 548,868 B and a lookup at about 204 KB in 11 requests.
- [ ] **Step 5: Commit.** `git commit -m "test(tables): gate a one-variant lookup at 300 KB and 15 requests on a 3,102-file tree (data platform §11 step 2.7)"`

---

### Task 11: Catalog wiring: check 7, `tables.json` and the indexes

**Files:**
- Create: `genomeos/tables/lookup_catalog.py`, citing §2.6, §2.7 check 7, §2.9 and calls 1, 17 and 31.
- Modify: `genomeos/publication/data_release.py`, adding `LOOKUP_BASE_URL_VARIABLE` and `resolve_lookup_base_url`.
- Modify: `genomeos/tables/catalog.py`:
  - `render_catalog_sql(..., macros: Sequence[str] = ())` appends the macros after the views;
  - `render_tables_json(..., extra_entries: Mapping[str, Sequence[Mapping[str, object]]] | None = None)`;
  - `check_catalog(..., *, lookup_sets: Sequence[PublishedLookupSet] = ())`, through `catalog_urls`. Its SQL/`tables.json` equality leaves out three things: `tables.json`'s `BINNED_TABLE` entries, URLs under a lookup set's `url_prefix`, and the `inferred.surfaces` cells URLs. Every remaining URL is still a live manifest key with matching sha256. The `BINNED_TABLE` entries must equal `all_bin_paths` over the lookup sets.
- Modify: `scripts/build_data_release.py::build`, pass 2.
- Modify: `tests/lookup_fixtures.py`, adding `LookupRelease(data_root: Path, releases: Path, objects: tuple[ReleaseObject, ...], ingests: tuple[measured.Ingest, ...])` and `lookup_release(root: Path) -> LookupRelease`, the fixture below.
- Test: `tests/test_lookup_catalog.py` (new), plus additions to `tests/test_data_release.py` and `tests/test_tables_catalog.py`.

**Interfaces:**
- Consumes:
  - Tasks 1, 3 (`GNOMAD_VCF_URL`), 6 (`recount_ingest`, `combine_ledgers`, `synthetic_complete_ledger`) and 9;
  - phase 1's `read_ingests`, `INGESTS_PATH`, `artifacts.parquet` and `served.parquet`;
  - 2.1's `access`, `hosts` and their recomputation;
  - 2.5's `dr.LOOKUP_STORE_BASE_URL`.
- Produces:

```python
dr.LOOKUP_BASE_URL_VARIABLE = "GENOMEOS_LOOKUP_BASE_URL"
def dr.resolve_lookup_base_url(value: str | None) -> str      # None → dr.LOOKUP_STORE_BASE_URL; loopback http(s) passes; else DataReleaseError
EXPECTED_CONTIGS: Mapping[str, tuple[str, ...]] = {"gnomad_hgdp_1kg": tuple(GRCH38_LENGTHS)}
def recorded_contigs(ingest: measured.Ingest) -> dict[str, int]         # from input URLs matching GNOMAD_VCF_URL
def published_lookup_sets(objects, ingests, lookup_base: str, *, withdrawn: Collection[str], data_root: Path) -> tuple[PublishedLookupSet, ...]
def curated_files(objects, data_root: Path, base: str, *, withdrawn: Collection[str]) -> tuple[CuratedFile, ...]
def surface_files(objects, data_root: Path, base: str, *, withdrawn: Collection[str]) -> tuple[SurfaceFile, ...]
def tables_json_lookup_entries(published, objects, data_root: Path) -> dict[str, list[dict[str, object]]]
    # {BINNED_TABLE: [{key, url, sha256, bytes, rows, access, hosts}]}
# tests/test_lookup_catalog.py: fixtures objects and data_root (from lookup_release); INGEST = recount_ingest(combine_ledgers(
#   [synthetic_complete_ledger(j) for j in plan_jobs()])); LOOKUP_BASE = dr.LOOKUP_STORE_BASE_URL;
#   mutators, each (objects, ingests) -> (objects, ingests) with a .withdrawn tuple: drop(chrom, bin), add(chrom, bin), rekey(chrom, bin, release),
#   withdraw(chrom, bin), set_access(chrom, bin, access), set_hosts(chrom, bin, hosts), resha(chrom, bin), ingest_without(chrom), v1_manifest()
# tests/test_tables_catalog.py: fixture release_with_lookup_set (lookup_release); build_twice(release) -> tuple[str, str] runs
#   build(..., catalog=True) twice and returns (catalog.sql, tables.json) text after asserting both builds are equal
```

**Check 7.** `published_lookup_sets` raises `DataReleaseError` naming every problem; the parametrized test gives each clause's message. "hosts" compares with step 2.1's recomputation, "sha256" compares the manifest with the local file, and a recorded set other than `EXPECTED_CONTIGS` names the chromosome.

**Pass 2:**
1. `read_ingests`.
2. `published_lookup_sets`. Task 12 adds `check_bin_files` here.
3. `macros=lookup_statements(…)`.
4. `extra_entries=tables_json_lookup_entries(…)`.
5. `check_catalog(..., lookup_sets=…)`.

The base URL comes from `resolve_lookup_base_url(os.environ.get(LOOKUP_BASE_URL_VARIABLE))`.

**Fixture (`lookup_release`).** Under `releases/2026-12-01/` it writes four things:
- a real `chr11/bin=5` holding rs334 for Han (2/8), PapuanHighlands (0/4) and PapuanSepik (1/4) under `SYNTHETIC_IDENTITY.cohort_id`; NorthernHan is the `an = 0` cell the synthetic ingest records;
- 3,101 empty bins, symlinked to one empty bin;
- the fixture registry folder for `SYNTHETIC_IDENTITY.registry_version`, through phase 1's `reference.reference_paths` and `reference_frames`, over `tests/fixtures/gnomad_recount/populations.tsv`;
- `measured.ingests` holding `INGEST`, and a manifest v2 whose objects carry `access` and `hosts` as step 2.1's rule computes them.

- [ ] **Step 1: Write the failing tests**

```python
LOOKUP_BASE = dr.LOOKUP_STORE_BASE_URL
def test_published_set_carries_the_recorded_set_one_release_and_the_template(objects, data_root):
    (p,) = published_lookup_sets(objects, [INGEST], LOOKUP_BASE, withdrawn=(), data_root=data_root)
    assert p.lookup.bins()[-1] == BinRef("chrY", 57) and len(p.lookup.bins()) == 3102
    assert p.url_prefix == LOOKUP_BASE + "releases/2026-12-01/" and p.source_record_id_template == "gnomad-hgdp-1kg:{variant_id}:{source_label}"
@pytest.mark.parametrize("mutate, match", [(drop("chr11", 5), r"missing .*chrom=chr11/bin=5"), (add("chrM", 0), r"not computable .*chrom=chrM"),
    (add("chr21", 47), r"not computable .*bin=47"), (rekey("chr1", 0, "2026-12-02"), "one release"), (withdraw("chr11", 5), "withdrawn"),
    (set_access("chr11", 5, "open"), "access"), (set_hosts("chr11", 5, ("gcs-free",)), "hosts"), (resha("chr11", 5), "sha256"),
    (ingest_without("chrY"), "chrY"), (v1_manifest(), "schema v2")])
def test_check7_every_computable_url_is_a_live_manifest_key(objects, data_root, mutate, match):
    with pytest.raises(dr.DataReleaseError, match=match):
        published_lookup_sets(*mutate(objects, [INGEST]), LOOKUP_BASE, withdrawn=mutate.withdrawn, data_root=data_root)
def test_tables_json_lists_every_bin_from_the_lookup_bucket(objects, data_root):
    (p,) = published_lookup_sets(objects, [INGEST], LOOKUP_BASE, withdrawn=(), data_root=data_root)
    entries = tables_json_lookup_entries([p], objects, data_root)["measured.allele_observations_binned"]
    assert len(entries) == 3102 and set(entries[0]) == {"key", "url", "sha256", "bytes", "rows", "access", "hosts"}
    assert all(e["url"] == LOOKUP_BASE + e["key"] for e in entries) and {e["access"] for e in entries} == {"lookup"}
    assert [e["rows"] for e in entries if e["key"].endswith("chrom=chr11/bin=5/part-0.parquet")] == [3] and sum(e["rows"] == 0 for e in entries) == 3101
def test_catalog_with_a_lookup_set_lists_no_bin_and_builds_identically_twice(release_with_lookup_set):   # tests/test_tables_catalog.py
    sql_a, tables_a = build_twice(release_with_lookup_set)
    assert re.search(r"bin=\d", sql_a) is None and "CREATE MACRO measured.variant" in sql_a and (sql_a, tables_a) == build_twice(release_with_lookup_set)
# tests/test_tables_catalog.py test_check_catalog_with_a_lookup_set: check_catalog passes on release_with_lookup_set; with one curated
#   URL's entry removed from tables.json it still fails "lists different files"
# tests/test_data_release.py: resolve_lookup_base_url(None) == dr.LOOKUP_STORE_BASE_URL; "http://127.0.0.1:8000/" passes; dr.DATA_STORE_BASE_URL is refused
# test_curated_and_surface_indexes_omit_withdrawn_files: withdrawn curated and cells keys are absent; HbS v3 .served is True and v1 False;
#   an artifact with no artifacts.parquet row → DataReleaseError
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_lookup_catalog.py tests/test_data_release.py tests/test_tables_catalog.py -k "lookup" -v` gives `ModuleNotFoundError` and `AttributeError`.
- [ ] **Step 3: Implement the module, the new keywords, the `check_catalog` exclusion and pass 2.**
- [ ] **Step 4: Run the tests; they pass.** `uv run pytest tests/test_lookup_catalog.py tests/test_data_release.py tests/test_tables_catalog.py tests/test_tables_checks.py tests/test_build_data_release.py -v && uv run pytest tests/test_web_layout.py -k bucket -q && uvx pyright genomeos/tables/lookup_catalog.py genomeos/tables/catalog.py`.
- [ ] **Step 5: Commit.** `git commit -m "feat(tables): compute lookup URLs only for manifest keys and list every bin in tables.json (data platform §2.6, §2.7 check 7)"`

---

### Task 12: Check 12 at release build: bin files, sampled recount and the anonymous rs334 smoke

**Files:**
- Create: `genomeos/tables/lookup_checks.py`, citing §2.7 checks 7 and 12, §1.2 D18 item 5 and call 29.
- Create: `scripts/check_lookup_set.py` (`files`, `recount`, `smoke`, `all`).
- Modify: `scripts/build_data_release.py::build` pass 2, to call `check_bin_files` for each published lookup set after `published_lookup_sets`.
- Modify: `docs/data-store.md`. Add "Checking a lookup set (check 12)". It names `all` as check 12 and the other three subcommands as diagnostics. None needs a credential, and `recount` streams the cited VCFs anonymously.
- Test: `tests/test_lookup_checks.py` and `tests/test_check_lookup_set.py` (new); `tests/test_tables_catalog.py`.

**Interfaces:**
- Consumes:
  - Tasks 1, 6, 7 and 11;
  - phase 1's `read_ingests`, `reference.read_reference`, `reference.registry_folder` and `hgdp_1kg.ALIAS_SOURCES`;
  - `fetch_data`'s `load_release`, `sha256_file` and `_report` pattern.
- Produces:

```python
RS334 = "chr11-5227002-T-A"
class LookupTotals(frozen): rows: int; sum_ac: int; sum_an: int
RS334_RECORDED: Mapping[str, LookupTotals] = MappingProxyType({})   # by cohort_id; 2.8 records the first real recount's totals, never in advance
def check_bin_files(lookup: LookupSet, data_root: Path, *, summary: IngestSummary | None = None) -> None
def lookup_totals(rows: pd.DataFrame) -> LookupTotals
def registry_population_ids(aliases: pd.DataFrame) -> frozenset[str]     # population_id where source ∈ ALIAS_SOURCES
def check_rs334(rows: pd.DataFrame, ingest: measured.Ingest, local: LookupTotals, *, population_ids: frozenset[str]) -> list[str]
# scripts/check_lookup_set.py: main(argv) -> int; exit 0 = pass, 1 = any "error:" line, 2 = usage; hidden --releases on every subcommand
#   files   --release R --data DIR [--summary PATH]
#   recount --release R --data DIR --summary PATH --metadata PATH --karyotypes PATH --stage PATH --workdir DIR [--bins chr11:5,…]
#   smoke   --release R --data DIR
#   all     the flags of recount: files, then recount (chr11:5 always among its bins), then smoke; check 12 passes only here
# tests/test_lookup_checks.py: tree (module fixture: GNOMAD's 3,102 files, chr11:5 real, 3,101 empty); damage helpers remove, extra, row_at,
#   row_id, untagged, row_group_rows, each (tree) -> None; POPULATIONS_80 (80 ids); ROWS_78 (78 of them, Σac 208, Σan 8,188);
#   INGEST_TWO_AN_ZERO (the synthetic ingest with ("an_zero", id, 1) for the other two ids); INGEST_ONE_AN_ZERO (only one of them);
#   CURATED_TSV_ROWS (2 curated rs334 rows); with_duplicate (row 0 twice), with_an_zero_row (row 0's an set to 0),
#   with_population(rows, id) (row 0 renamed)
# tests/test_check_lookup_set.py: served (Task 11's lookup_release over tests/range_server.serve; .base, .data, .releases)
```

**`check_bin_files`** reads footers only and raises `DataReleaseError` naming every problem:
- a missing file, or a file outside `bins()`;
- `genomeos.table ≠ BINNED_TABLE`;
- a row group over 122,880 rows;
- a `pos` statistic outside `[bin·1e6, (bin+1)·1e6)`;
- a `variant_id` statistic without the `chrom-` prefix;
- with `summary`, a sha256 that differs from `summary.bins[ref].file.sha256` ("sha256 differs from the ingest summary"). This is check 7's matching-sha256 clause against the recount's own record; the release build never sees the unpublished summary.

**`check_rs334`** reads only the rows whose `source` is `gnomad_hgdp_1kg` and whose `cohort_id` is `ingest.sample_rule`. It requires:
- `population_id` unique ("twice"), `an > 0` everywhere ("an = 0"), and every id in `population_ids` ("not in the registry");
- for every id in `population_ids` with no row, `("an_zero", id, n ≥ 1)` in `ingest.refusals` ("no row and no recorded an = 0"). These are §2.7's per-population refusal counts in `measured.ingests` accounting for the rest. `all`'s recount of chr11:5 in the same run shows rs334's missing cells natively.
- totals equal to `local`, and to `RS334_RECORDED[cohort]` if that is present ("rows", "sum_ac", "sum_an").

**The subcommands:**
- **`recount`** first verifies `--metadata`, `--karyotypes` and `--stage` against `summary.identity.metadata.sha256`, `.karyotypes.sha256` and `.stage_sha256`, naming the field. It then builds the Stage with `read_stage(..., name=identity.stage_name)` and runs `crosscheck_bin` on `--bins`, or else on `choose_check_bins({r: e.tally for r, e in summary.bins.items()})`. Each bin's VCF streams from `summary.inputs[chrom].url`, and its cells come from the sha256-verified local copy.
- **`smoke`** runs four steps:
  1. it totals the local rs334 rows (offline, through `genomeos_local`);
  2. with caches off and no credential, it ATTACHes `<dr.resolve_base_url(...)>releases/<R>/catalog/atlas.duckdb` read-only and queries `measured.variant(RS334)`;
  3. it reads the ingest with `read_ingests`, and the population ids through `reference.read_reference` on the folder `reference.registry_folder(ingest.registry_version)`;
  4. it runs `check_rs334` and prints `rs334: <rows> rows, sum ac <n>, sum an <n>` for 2.8 to record.

- [ ] **Step 1: Write the failing tests**

```python
GNOMAD = lookup_set("gnomad_hgdp_1kg", "2026-12-recount", GRCH38_LENGTHS)
def test_a_complete_set_with_empty_bins_passes(tree):
    check_bin_files(GNOMAD, tree)
@pytest.mark.parametrize("damage, match", [(remove("chrY", 57), r"chrom=chrY/bin=57"), (extra("chr21", 47), "not in the recorded set"),
    (row_at("chr11", 5, pos=6_000_000), r"bin=5.*pos"), (row_id("chr11", 5, "chr12-5227002-T-A"), r"chrom=chr11"),
    (untagged("chr11", 5), "genomeos.table"), (row_group_rows("chr11", 5, 200_000), "122880")])
def test_a_damaged_bin_set_fails(tree, damage, match):
    damage(tree)
    with pytest.raises(dr.DataReleaseError, match=match):
        check_bin_files(GNOMAD, tree)
def test_rs334_checks():
    assert lookup_totals(ROWS_78) == LookupTotals(rows=78, sum_ac=208, sum_an=8188)
    assert check_rs334(ROWS_78, INGEST_TWO_AN_ZERO, lookup_totals(ROWS_78), population_ids=POPULATIONS_80) == []
    assert check_rs334(pd.concat([ROWS_78, CURATED_TSV_ROWS]), INGEST_TWO_AN_ZERO, lookup_totals(ROWS_78), population_ids=POPULATIONS_80) == []
@pytest.mark.parametrize("rows, ingest, match", [(ROWS_78, INGEST_ONE_AN_ZERO, "no row and no recorded an = 0"),
    (with_duplicate(ROWS_78), INGEST_TWO_AN_ZERO, "twice"), (with_an_zero_row(ROWS_78), INGEST_TWO_AN_ZERO, "an = 0"),
    (with_population(ROWS_78, "hgdp-atlantis"), INGEST_TWO_AN_ZERO, "not in the registry"),
    (ROWS_78.assign(ac=ROWS_78["ac"] + 1), INGEST_TWO_AN_ZERO, "sum_ac")])
def test_rs334_failures_are_named(rows, ingest, match):
    assert any(re.search(match, p) for p in check_rs334(rows, ingest, lookup_totals(ROWS_78), population_ids=POPULATIONS_80))
def test_smoke_passes_anonymously_over_loopback(served, capsys, monkeypatch):     # tests/test_check_lookup_set.py
    monkeypatch.setenv(dr.BASE_URL_VARIABLE, served.base); monkeypatch.setenv(dr.LOOKUP_BASE_URL_VARIABLE, served.base)
    assert cls.main(["smoke", "--release", "2026-12-01", "--data", str(served.data), "--releases", str(served.releases)]) == 0
    assert "rs334: 3 rows, sum ac 3, sum an 16" in capsys.readouterr().out
# test_registry_population_ids_reads_the_alias_sources: phase-1 Task 17's tests/fixtures/hgdp_1kg_populations.tsv through hgdp_1kg.load → 7 ids
#   (six hgdp-…, "onekg-gbr")
# test_rs334_compares_recorded_totals: setitem(RS334_RECORDED, cohort, LookupTotals(78, 209, 8188)) gives a "sum_ac" problem
# test_files_compares_the_summary: a bin rewritten after its job → exit 1, "sha256 differs from the ingest summary"
# test_recount_refuses_a_stage_with_another_digest: a stage file with one id dropped → exit 1, "stage_sha256", and nothing streamed
# test_all_recounts_chr11_bin_5_before_the_smoke: with crosscheck_bin and the smoke monkeypatched to record calls, `all --bins chr1:0`
#   recounts chr1:0 and chr11:5, and the smoke runs last; a failing chr11:5 crosscheck → exit 1
# test_smoke_fails_when_the_served_bin_differs → exit 1, "sum_ac"; test_files_fails_on_a_missing_bin → exit 1, "bin=57"
# @requires_native test_recount_crosschecks_the_chosen_bins: an IngestSummary built directly from job_env's chr1-00 ledger,
#   `recount --bins chr1:0,chr1:19` → exit 0
# tests/test_tables_catalog.py test_build_refuses_a_lookup_set_missing_a_bin: build(..., catalog=True) raises DataReleaseError matching "bin=57"
```

- [ ] **Step 2: Run the tests; they fail.** `uv run pytest tests/test_lookup_checks.py tests/test_check_lookup_set.py tests/test_tables_catalog.py -k "lookup or rs334 or bin" -v` gives `ModuleNotFoundError`.
- [ ] **Step 3: Implement.** The script stays a thin argparse layer over `lookup_checks` and `crosscheck`, and reports every problem, not just the first.
- [ ] **Step 4: Run the full gate.** `uv run pytest tests/test_lookup_checks.py tests/test_check_lookup_set.py -v && uv run ruff check . && uvx pyright genomeos/tables/lookup_checks.py scripts/check_lookup_set.py && uv run python scripts/freeze_contract.py --check && uv run python scripts/check_module_size.py && uv run python scripts/check_private_files.py && uv run python scripts/check_commercial_use.py && uv run python scripts/smoke.py && uv run pytest`. Expected: everything passes.
- [ ] **Step 5: Commit.** `git commit -m "feat(tables): check 12 refuses a lookup set missing a bin, recounts sampled bins and smoke-tests rs334 anonymously"`
