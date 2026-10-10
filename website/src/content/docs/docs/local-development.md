---
title: Local development
description: Reproduce the Python and Astro environments and run the checks required before a genomeOS pull request.
sidebar:
  order: 7
---

The scientific package and website are separate runtimes in one repository.

## Python environment

Use Python 3.12 and the repository lock:

```bash
uv venv --python 3.12
source .venv/bin/activate
uv pip install -r requirements.lock
python -m pip install -e '.' --no-deps
```

Run the required gates:

```bash
ruff check .
python scripts/freeze_contract.py --check
python scripts/check_module_size.py
python scripts/check_private_files.py
python scripts/smoke.py
pytest
```

## Atlas data

The repository keeps the Atlas catalog, the Natural Earth context and the external caches.
Per-artifact data lives in the public bucket, so `npm run dev` needs a data base. Set
`PUBLIC_ATLAS_DATA_BASE_URL` in the repository-root `.env.development` (Vite reads `.env*` from the
repository root) to the bucket base — the value of the `ATLAS_DATA_BASE_URL` repository variable,
`https://storage.googleapis.com/<bucket>/atlas/web/` — or to `http://127.0.0.1:4323/` while
serving a local staging tree:

```bash
cd website
node scripts/serve-atlas-data.mjs --root /path/to/staging   # serves http://127.0.0.1:4323/
```

The tests do not need the bucket. `npm test` builds with the variable set to `''`, and
`npm run test:e2e` builds against `http://127.0.0.1:4323/` while Playwright serves the committed
fixture tree `tests/fixtures/atlas/e2e/` there with gzip and the bucket's CORS policy, so every
browser test exercises the cross-origin path.

Full-data checks are opt-in. `ATLAS_DATA_DIR` names a staging tree (written by
`encode_atlas_web.py --with-downloads --out DIR`, or downloaded from the bucket):

```bash
ATLAS_DATA_DIR=/path/to/staging npx vitest run tests/atlas-public-data.test.ts
ATLAS_DATA_DIR=/path/to/staging npx vitest run tests/atlas-geometry-full-grid.test.ts tests/atlas-render-precision.test.ts
PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ npm run build
ATLAS_DATA_DIR=/path/to/staging npm run test:performance
```

The second line runs the full-grid chunk acceptance and the f32 precision report; both read the
surfaces through the staging tree's `catalog.json` `surface_url` and skip without data.

To measure against the bucket instead, build with the bucket base and run
`npm run test:performance` without `ATLAS_DATA_DIR`. The fixture-backed captures (`capture:atlas`,
`capture:atlas-mobile`, `capture:studs`) need no data base: they build the e2e catalog and the
browser fixture serves its objects. The full-data captures (`capture:progress`, `capture:gnomad`,
`capture:fast-load`) serve the built site on port 4323, so run them with
`PUBLIC_ATLAS_DATA_BASE_URL` set to the bucket base.

To publish new data, `export_atlas_web.py` output is an intermediate; the site build fails until
`encode_atlas_web.py` has run on it. Encode into a staging tree, publish it, and commit only its
catalog (see `docs/data-store.md`):

```bash
python scripts/encode_atlas_web.py --in <export-dir> --out data/atlas-web --with-downloads
```

## Website environment

Use Node 24 and the committed npm lock:

```bash
cd website
npm ci
npm run dev
```

Before a pull request:

```bash
npm run format:check
npm run check
npm test
npm run build
npm run build:fallback
npm run test:e2e
```

`npm run test:e2e` matches CI: one Playwright worker against a server on `127.0.0.1:4322`. Two
environment variables change that locally. `PLAYWRIGHT_WORKERS` (a positive integer, default 1)
sets the worker count. Pass `--fully-parallel` with it, or each file stays on one worker.
`PLAYWRIGHT_PORT` (1 to 65535, default 4322) moves the test server that `npm run serve:test` starts
for both `test:e2e` and `test:performance`, for example
`PLAYWRIGHT_PORT=4352 PLAYWRIGHT_WORKERS=4 npm run test:e2e -- --fully-parallel`. The Atlas data
server does not move: it stays on `127.0.0.1:4323`, the base the e2e build bakes in, and grants a
site port outside the bucket's CORS list through its test-only `--allow-origin`. Only one checkout
at a time can therefore run `test:e2e`, or `test:performance` against a staging tree. CI sets
neither variable; it splits the suite across four runners with `--shard` instead.

The custom-domain build assumes `/`; the fallback build assumes `/genomeOS`. Both must work so a
domain transition cannot hide broken internal paths.

The `/app/` page inlines the Atlas catalog at build time from `public/data/atlas/catalog.json`.
Set `ATLAS_CATALOG_PATH` (relative to `website/`) to build against another catalog, for example
`ATLAS_CATALOG_PATH=tests/fixtures/atlas/e2e/catalog.json npm run build`. The build fails if that
catalog does not pass the strict browser schema.

## Atlas cold-load measurement

`tests/atlas-cold-load.spec.ts` measures the default HbS map in headed Chrome on a hardware GPU
(fast-load design §B.1). It needs a production build with a data base, and the data behind it.
The commands below use a staging tree (see "Atlas data" above); to measure the bucket, build with
the bucket base and drop `ATLAS_DATA_DIR`:

```bash
cd website
PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ npm run build
ATLAS_DATA_DIR=/path/to/staging npm run test:performance -- atlas-cold-load
```

Each profile — desktop 1440×900, and 390×844 at DPR 3 with 4× CPU on DevTools Fast 4G and Slow 4G —
runs three times in fresh contexts. The JSON report and bytes ledger are written to `test-results/`
and attached to the Playwright report. The `observations-visible`, `surface-visible` and reveal
budgets are asserted on the median of the three runs. The Atlas long-frame cap (200 ms on desktop,
800 ms on mobile) applies to every run, and so do the transport checks and "no request timeout or
error". Budgets are skipped on software renderers. To measure an older build, serve its `dist/` and
set `ATLAS_COLD_LOAD_BASELINE=1` and `ATLAS_COLD_LOAD_BASE_URL`; a baseline reports observed times.
The harness still reads this checkout's `dist/app/index.html` to choose its data origin, so build it
as above first.

The spec launches its own Chrome with DevTools on port 9333 (`ATLAS_COLD_LOAD_CDP_PORT` picks
another). It fails before launching if that port is taken, for example by a Chrome left from an
interrupted run.
