---
name: gates
description: Run the genomeOS CI gates and keep the output for the PR template. Invoke only as /gates.
disable-model-invocation: true
---

# Gates

Run the Python job's local steps from `.github/workflows/ci.yml`. Follow that job, not the shorter list in `CONTRIBUTING.md` (it omits `check_commercial_use.py`).

Work from the repository root. Run each command and keep the full output locally. The local run may be verbose. The text pasted into the pull request may not. A tick or the word `passed` alone is not evidence.

## Python

```bash
ruff check .
python scripts/freeze_contract.py --check
python scripts/check_module_size.py
python scripts/check_private_files.py
python scripts/check_commercial_use.py
python scripts/smoke.py
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1
pytest -n auto --dist loadfile -v --durations=40
```

Export the four thread variables in the same shell that runs `pytest`. They are the Python job's BLAS/OpenMP caps (issue #413).

If a schema file changed, run `python scripts/freeze_contract.py` with no `--check` and include the `contract/` diff in the same change.

Before every commit, including while the suite is still running:

```bash
python scripts/check_private_files.py
git diff --cached --name-only
```

## Website

When the change is under `website/`, also run these steps of the `validate` job in `.github/workflows/pages.yml`, from `website/`:

```bash
npm ci
npm run format:check
npm run check
npm test
```

Leave Playwright e2e on CI unless the task is an interaction bug.

## What to paste into the PR template

Paste one summary line per command. That is the tool's own one-line result, or a pytest count such as `7145 passed, 52 skipped`. The same line may be repeated inside the Output details block of `.github/PULL_REQUEST_TEMPLATE.md`. Do not paste `pytest -v` logs, tracebacks, or any other extra output.

On failure, paste that summary line plus the failing test names. Do not paste tracebacks or the verbose log.

The checklist has no line for `check_commercial_use.py` and lists a bare `pytest`. Use this text:

```
ruff check .: <one-line result>
python scripts/freeze_contract.py --check: <one-line result>
python scripts/check_module_size.py: <one-line result>
python scripts/check_private_files.py: <one-line result>
python scripts/check_commercial_use.py: <one-line result>
python scripts/smoke.py: <one-line result>
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 pytest -n auto --dist loadfile -v --durations=40: <count, such as 7145 passed, 52 skipped>
```

When `website/` changed, add one summary line each:

```
npm ci: <one-line result>
npm run format:check: <one-line result>
npm run check: <one-line result>
npm test: <one-line result>
```

When a schema changed, add one line that `python scripts/freeze_contract.py` ran and that the `contract/` diff is in the PR.
