/**
 * Browser SQL on the pinned DuckDB-WASM against a local data store (Atlas data platform design
 * 2026-10-18 §1.4, §3.1, step 1.13). The e2e build publishes `window.__atlasBrowserSql`; Playwright
 * serves `tests/fixtures/data-store/` (scripts/build_browser_sql_fixture.py) on 127.0.0.1:4324
 * with GCS's range and CORS behaviour and a request log. These tests measure whether DuckDB-WASM
 * reads the store by HTTP range, the decision `WEBSITE_LOOKUP_ROUTE` records.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type Request,
} from '@playwright/test';

import type * as engine from '../src/atlas/browser-sql/engine';
import {
  ALLOWED_EXTENSION_HOSTS,
  WEBSITE_LOOKUP_ROUTE,
} from '../src/atlas/browser-sql/route';
import {
  extractArtifactDataBase,
  GTAG_SCRIPT_PATTERN,
} from './atlas-browser-fixture';
import { inBrowser, openBrowserSqlPage } from './browser-sql-session';

// engine.ts imports DuckDB-WASM's bundles as Vite `?url` assets, which Node cannot load, so the
// row cap is restated, typed to the engine's literal: `npm run check` fails if the two differ.
const MAX_RESULT_ROWS: typeof engine.MAX_RESULT_ROWS = 1000;
const STORE = 'http://127.0.0.1:4324/';
const RELEASE = 'releases/2000-01-01';
const PROBE = `${RELEASE}/range_probe.parquet`;
const PROBE_BYTES = statSync(
  path.join(import.meta.dirname, 'fixtures', 'data-store', PROBE),
).size;
const CATALOG = `${STORE}${RELEASE}/catalog/atlas.duckdb`;
/** Row 0xe000 of the probe; one row group of twelve holds it. */
const probeQuery = (url: string) =>
  `SELECT count(*)::VARCHAR, max(post_mean)::VARCHAR FROM read_parquet('${url}') WHERE h3_index = '80000000000e000'`;
/** Hosts the explorer page itself contacts, whatever DuckDB does: its tiles and analytics. */
const EXPLORER_HOSTS = [
  'tile.openstreetmap.org',
  new URL(GTAG_SCRIPT_PATTERN.replace('/**', '/')).host,
];

interface StoreRequest {
  method: string;
  path: string;
  range: string | null;
  status: number;
  bytes: number;
}

/** The store's request log since the last read, which the read clears. */
async function storeRequests(
  request: APIRequestContext,
): Promise<StoreRequest[]> {
  return (await (
    await request.get(`${STORE}__requests`)
  ).json()) as StoreRequest[];
}

test.describe('browser SQL', { tag: '@desktop-chromium' }, () => {
  test.beforeEach(async ({ page, request }) => {
    await request.get(`${STORE}__control?force=off`);
    await openBrowserSqlPage(page);
    await storeRequests(request);
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test(`reads the probe as WEBSITE_LOOKUP_ROUTE '${WEBSITE_LOOKUP_ROUTE}' records`, async ({
    page,
    request,
  }) => {
    const session = await inBrowser(page, [probeQuery(`${STORE}${PROBE}`)]);
    const log = await storeRequests(request);
    const sent = log.reduce((total, entry) => total + entry.bytes, 0);
    // The measurement route.ts records (F6), printed whether or not the read succeeded.
    console.log(
      `${WEBSITE_LOOKUP_ROUTE}: ${log.length} requests, ${sent} of ${PROBE_BYTES} bytes (${((100 * sent) / PROBE_BYTES).toFixed(1)}%):`,
      JSON.stringify(log),
    );
    expect(session.error).toBeNull();
    expect(session.results[0]!.rows).toEqual([['1', '0.5833333333333334']]);
    expect(session.results[0]!.truncated).toBe(false);
    expect(new Set(log.map((entry) => entry.path))).toEqual(
      new Set([`/${PROBE}`]),
    );
    if (WEBSITE_LOOKUP_ROUTE === 'range') {
      for (const entry of log) {
        expect(
          entry.method === 'HEAD' ||
            (entry.status === 206 && entry.range !== null),
          JSON.stringify(entry),
        ).toBe(true);
      }
      // DuckDB-WASM's lookup costs a fixed ~96 KiB of blocks and read-ahead; the probe's unread
      // padding column makes the file at least eight times that (tests/test_browser_sql_fixture.py).
      expect(sent).toBeLessThan(PROBE_BYTES / 4);
    } else {
      const whole = log.filter((entry) => entry.status === 200 && entry.bytes);
      expect(whole).toHaveLength(1);
      expect(whole[0]!.bytes).toBe(PROBE_BYTES);
    }
  });

  test('a store that ignores Range fails the read loudly', async ({ page }) => {
    test.skip(
      WEBSITE_LOOKUP_ROUTE !== 'range',
      "the 'p4-api' route reads whole files by design",
    );
    const session = await inBrowser(page, [
      probeQuery(`${STORE}no-range/${PROBE}`),
    ]);
    expect(session.results).toEqual([]);
    expect(session.error).toContain(`no-range/${PROBE}`);
  });

  test('cuts a result at MAX_RESULT_ROWS and keeps the connection usable', async ({
    page,
  }) => {
    const session = await inBrowser(page, [
      `SELECT range FROM range(${MAX_RESULT_ROWS + 1})`,
      `SELECT range FROM range(${MAX_RESULT_ROWS})`,
      'SELECT 42 AS answer, NULL AS nothing',
    ]);
    expect(session.error).toBeNull();
    const [cut, whole, after] = session.results;
    expect([cut!.rows.length, cut!.truncated]).toEqual([MAX_RESULT_ROWS, true]);
    expect(cut!.rows.at(-1)).toEqual([String(MAX_RESULT_ROWS - 1)]);
    expect([whole!.rows.length, whole!.truncated]).toEqual([
      MAX_RESULT_ROWS,
      false,
    ]);
    expect(after).toEqual({
      columns: ['answer', 'nothing'],
      rows: [['42', 'NULL']],
      truncated: false,
    });
  });

  test('contacts only the site, the store and the allowed extension hosts', async ({
    page,
    baseURL,
  }) => {
    const html = await (await page.request.get('/app/')).text();
    const explorer = new Set([
      ...EXPLORER_HOSTS,
      new URL(extractArtifactDataBase(html) ?? '/', baseURL).host,
    ]);
    const contacted: Request[] = [];
    page.context().on('request', (request) => contacted.push(request));
    const session = await inBrowser(
      page,
      [
        probeQuery(`${STORE}${PROBE}`),
        'SELECT count(*) FROM atlas.evidence.parity_observations',
      ],
      CATALOG,
    );
    expect(session.error).toBeNull();
    const allowed = new Set([
      new URL(baseURL!).host,
      new URL(STORE).host,
      ...ALLOWED_EXTENSION_HOSTS,
    ]);
    const urls = contacted
      .map((request) => new URL(request.url()))
      .filter((url) => !explorer.has(url.host));
    expect(
      urls.filter((url) => !allowed.has(url.host)).map((url) => url.href),
    ).toEqual([]);
    expect(urls.map((url) => url.host)).toContain(new URL(STORE).host);
  });

  test('attaches the fixture catalog read-only', async ({ page }) => {
    const session = await inBrowser(
      page,
      [
        'SELECT variant_id, model_version, data_version FROM atlas.inferred.artifacts',
      ],
      CATALOG,
    );
    expect(session.error).toBeNull();
    expect(session.objects).toEqual([
      'evidence.parity_observations',
      'inferred.artifacts',
      'meta.release',
      'meta.withdrawn',
    ]);
    expect(session.results[0]!.rows).toEqual([
      ['chr11-5227002-T-A', 'v3', 'map-2026-08'],
    ]);
  });
});
