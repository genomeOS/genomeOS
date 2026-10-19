#!/usr/bin/env bash
# The World Terrain tour at production density, by hand; never run in CI (terrain draping design,
# "Performance budget and measurement", #483; interaction design §5.2).
#
#   PUBLIC_ATLAS_DATA_BASE_URL=https://storage.googleapis.com/<bucket>/atlas/web/ \
#     bash scripts/terrain-tour-production-density.sh [playwright args...]
#
# PUBLIC_ATLAS_DATA_BASE_URL is the public web-data bucket's base, the value of the
# ATLAS_DATA_BASE_URL repository variable (docs: local development, "Atlas data"); a URL with the
# bucket's name is never committed. Playwright arguments pass through, e.g.
# --project=mobile-chromium, or --headed for the timings: a software renderer skips them.
#
# It builds the e2e bundle (the synthetic World Terrain, the drape stats and the tour's
# performance measures) over the bucket and the production catalog, then runs
# tests/atlas-terrain-performance.spec.ts, whose console prints the measures, the budgets and
# where the time went step by step. The e2e build carries its hooks only with the fixture catalog's
# path (assertE2eHooks, src/lib/catalog-build.ts; #453), so public/data/atlas/catalog.json stands in
# tests/fixtures/atlas/e2e/catalog.json for the build alone: that file is restored as soon as the
# build ends, and on every exit. Playwright serves on its usual ports, 4322 and 4323, so run no
# other Playwright run meanwhile. The exit status is the tour's: at production density it may fail
# its budgets.
set -euo pipefail

website=$(cd "$(dirname "$0")/.." && pwd)
fixture=tests/fixtures/atlas/e2e/catalog.json
production=public/data/atlas/catalog.json
base=${PUBLIC_ATLAS_DATA_BASE_URL:-}

case $base in
  https://*/) ;;
  *)
    echo "PUBLIC_ATLAS_DATA_BASE_URL must be the web-data bucket's https base ending in /, the ATLAS_DATA_BASE_URL repository variable (got '${base}')" >&2
    exit 2
    ;;
esac

cd "$website"
backup=$(mktemp "${TMPDIR:-/tmp}/atlas-fixture-catalog.XXXXXX")
cp "$fixture" "$backup"
restore() {
  [ -n "$backup" ] || return 0
  cp "$backup" "$fixture"
  if ! cmp -s "$backup" "$fixture"; then
    echo "the fixture catalog was not restored; its copy is $backup" >&2
    exit 4
  fi
  rm -f "$backup"
  backup=
}
trap restore EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$production" "$fixture"
PUBLIC_ATLAS_DATA_BASE_URL=$base PUBLIC_GA_MEASUREMENT_ID=G-TEST123 npm run build:e2e
restore
echo "built the e2e bundle over $base with the production catalog"
npx playwright test tests/atlas-terrain-performance.spec.ts "$@"
