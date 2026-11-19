# Evidence for the Atlas data-platform design

The design is [`docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md`](../../superpowers/specs/2026-10-18-atlas-data-platform-design.md).
Its Status line and §14 cite this folder. Step 1.2 copied it here.

## What it is

The working records the design was written from: the two source designs, the results of the three
workflows that produced and revised it, and the probe scripts of 2026-10-19. Every file is
verbatim apart from the six substitutions below. Paths inside the files (`<scratchpad>/…`,
`<repo>/…`, `out/…`) name the folders the work ran in; none of them exist in this repository.

## Contents, mapped to the spec

| Path | What it holds | Spec |
|---|---|---|
| `data-structure-design.md` | The judged and synthesised data-structure design: researcher-first tables and a view-only catalog (design B) | Appendix A; §2, §3 |
| `data-access-tiers-design.md` | The judged and synthesised access-tiers design: B "recovery", with the 1 GiB free line, terms allowlist, prepaid door and sponsor trigger taken from the others | Appendix A; §4–§8 |
| `merge/structure-workflow-results.json` | The data-structure workflow: inventory, GCP research, three designs (integrity, cost, access), the judge's scores and synthesis, and `fact-check` | Appendix A |
| `merge/tiers-workflow-results.json` | The access-tiers workflow: research on peer providers and GCP mechanisms, three designs (leverage, friction, recovery), the judge's scores and synthesis, and `fact-check` | Appendix A |
| `merge/whole-genome-workflow-results.json` | The 2026-10-19 revision: three research angles (`research: costs`, `research: sources`, `research: layout`), `revise`, the review `check` and its `fix` (D1c, D18, D16, D17) | Appendix A; §1.2, §2.10, §9 |
| `wg/obs-layout/scripts/` | Contract-shaped rows from real gnomAD chr21 data; candidate layouts, their sizes, the bytes three query shapes read, the catalog attach and the whole-genome extrapolation | §14; §2.6, §2.10, §3.1 |
| `wg/counts-sources/scripts/` | rs334 from the gnomAD API against the dense VCF's INFO counts; the size of a long-format count table | §14; §2.10 |
| `wg/costs-tiers/scripts/` | The whole-genome cost model; the synthetic 12M-row layout measurements; the bytes typical queries read | §14; §8 |
| `wg/apply-checks/scripts/` | The 2026-10-19 check: D18's recount and its comparison with native bcftools, INFO-based rows, the layout with `source_label`, the 3,102-URL catalog, one cold lookup's bytes and the re-derived costs | §14; §1.2, §2.10, §8 |

- **Appendix A's 91 fact-checked claims** are the two `fact-check.checks` lists: 35 in the
  structure results (30 confirmed, 3 unclear, 2 refuted) and 56 in the tiers results (47, 6, 3),
  77 confirmed, 9 unclear and 5 refuted in all. Each check has `claim`, `verdict`, `evidence` and
  `source`.
- **§9's research note**, which keeps the terms of the linked-only sources, is `research: sources`
  in `merge/whole-genome-workflow-results.json`.
- **Appendix A's review check** (2 blockers, 5 important, 8 minor) is `check.issues` in the same
  file.

## The six substitutions

Applied in this order, to the three `merge/*.json` files only (no other file needed one). The JSON
still parses.

| Name | What it replaced | Replacement |
|---|---|---|
| `scratch` | An agent session's absolute scratch-folder path (per-user temp root and session id) | `<scratchpad>/` |
| `bare` | The same scratch folder written as a relative path | `<scratchpad>/` |
| `repo` | An absolute path into a git worktree under a home directory | `<repo>/` |
| `worktree` | A relative path into an agent's git worktree | `<repo>/` |
| `web` | The web bucket's base URL (the repository commits only the public data store's) | `<web-bucket-url>/` |
| `metric` | The Monitoring metric type spelled with its service host, which the bucket-URL check reads as a bucket | Cloud Storage's `network/sent_bytes_count` metric |

| File | Substitutions |
|---|---|
| `merge/structure-workflow-results.json` | scratch 5, worktree 2, web 2 |
| `merge/tiers-workflow-results.json` | scratch 2 |
| `merge/whole-genome-workflow-results.json` | scratch 30, bare 14, repo 3, metric 1 |

## What is not included

- **By design (§14):** the local genotype windows (`dl/`) and the sample lists. They were never
  copied or uploaded, and the per-sample genotype and ploidy listings were deleted after counting.
- **Missing:** `wg/decisions/` (its cost script, output and saved pricing pages), the `out/`
  outputs every script writes, and `rserve.py`, the byte-logging Range server that
  `query_bytes.py` and `run_queries.py` start. They were not recovered, so this folder shows how
  each figure was measured but cannot recompute it (F8 in
  [the phase-1 plan](../../superpowers/plans/2026-11-14-atlas-data-platform-phase-1.md)). The
  figures are in the results files and the spec.

The scripts are records, not code the repository runs: nothing imports them, and ruff skips this
folder (`extend-exclude` in `pyproject.toml`).

## Tool versions

DuckDB 1.5.5, pyarrow 25.0.1, h3 4.5.0, bcftools 1.21.
