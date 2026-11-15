/**
 * Browser SQL on the pinned DuckDB-WASM against a local data store (Atlas data platform design
 * 2026-10-18 §1.4, §3.1, step 1.13). The e2e build publishes `window.__atlasBrowserSql`; Playwright
 * serves `tests/fixtures/data-store/` (scripts/build_browser_sql_fixture.py) on 127.0.0.1:4324
 * with GCS's range and CORS behaviour and a request log. These tests measure whether DuckDB-WASM
 * reads the store by HTTP range, the decision `WEBSITE_LOOKUP_ROUTE` records, and drive the "Query
 * in your browser" panel on the fixture release (`npm run test:e2e` builds it against that store).
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

import type * as engine from '../src/atlas/browser-sql/engine';
import {
  gnomadBrowserUrl,
  NO_WASM_TEXT,
  PAUSED_TEXT,
  QUERY_ERROR_DOCS,
  WITHDRAWN_TEXT,
} from '../src/atlas/browser-sql/errors';
import { attachStatement } from '../src/atlas/browser-sql/examples';
import {
  ALLOWED_EXTENSION_HOSTS,
  WEBSITE_LOOKUP_ROUTE,
} from '../src/atlas/browser-sql/route';
import {
  extractArtifactDataBase,
  GTAG_SCRIPT_PATTERN,
  installAtlasBrowserFixture,
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

/** The HbS map, whose catalog row the fixture release holds. */
const HBS_PAGE = '/app/?entity=hbs-rs334';
/**
 * How long the panel may take to start DuckDB-WASM or answer: each test's fresh browser context
 * downloads and compiles the 34 MB module again, and a Parquet read autoloads the extension.
 */
const DUCKDB_MS = 30_000;
/** What the page fetches for DuckDB: the engine, the library, its bundles and the store. */
const isDuckDbRequest = (url: string) =>
  /\/_astro\/(?:engine|duckdb-)/.test(url) || url.startsWith(STORE);

function queryPanel(page: Page): Locator {
  return page.locator('details.atlas-browser-sql');
}

/** Opens the panel on the HbS map and waits for its examples. */
async function openQueryPanel(page: Page): Promise<Locator> {
  await page.goto(HBS_PAGE);
  const panel = queryPanel(page);
  await panel.locator('summary').click();
  await expect(
    panel.getByRole('group', { name: 'Example queries' }),
  ).toBeVisible({ timeout: DUCKDB_MS });
  return panel;
}

/** The result the panel shows: its heading and its rows' cells. */
async function shownResult(
  panel: Locator,
): Promise<{ heading: string; rows: string[][] }> {
  const result = panel.locator('.atlas-browser-sql__result');
  await expect(result).toBeVisible({ timeout: DUCKDB_MS });
  const rows = await result
    .locator('tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''),
      ),
    );
  return {
    heading: (await result.getByRole('heading').textContent()) ?? '',
    rows,
  };
}

test.describe(
  'the "Query in your browser" panel',
  { tag: '@desktop-chromium' },
  () => {
    test.describe.configure({ timeout: 90_000 });
    test.beforeEach(async ({ page, request }) => {
      await request.get(`${STORE}__control?force=off`);
      await installAtlasBrowserFixture(page);
    });
    test.afterEach(async ({ page, request }) => {
      await request.get(`${STORE}__control?force=off`);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    test('loads nothing of DuckDB until the panel opens', async ({ page }) => {
      const requested: string[] = [];
      page.context().on('request', (request) => requested.push(request.url()));
      await page.goto(HBS_PAGE);
      await expect(page.locator('[data-atlas-ready="true"]')).toBeVisible({
        timeout: 45_000,
      });
      const panel = queryPanel(page);
      await expect(panel.locator('summary')).toHaveText(
        'Query in your browser',
      );
      expect(requested.filter(isDuckDbRequest)).toEqual([]);
      await panel.locator('summary').click();
      await expect(
        panel.getByRole('group', { name: 'Example queries' }),
      ).toBeVisible({ timeout: DUCKDB_MS });
      expect(requested.filter(isDuckDbRequest)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/\/_astro\/engine\.[\w-]+\.js$/),
          `${STORE}releases/2000-01-01/catalog/atlas.duckdb`,
        ]),
      );
    });

    test("runs the artifact example and shows HbS's row under Inferred", async ({
      page,
    }) => {
      const panel = await openQueryPanel(page);
      // The fixture catalog has no lookup macros yet (step 2.7): only its two views' examples.
      await expect(
        panel
          .getByRole('group', { name: 'Example queries' })
          .getByRole('button'),
      ).toHaveText([
        /^This map's artifact/,
        /^HbS surveys within 500 km of Lagos/,
      ]);
      await panel.getByRole('button', { name: /artifact/ }).click();
      const { heading, rows } = await shownResult(panel);
      expect(heading).toBe('Inferred');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('chr11-5227002-T-A');
      expect(rows[0]).toContain('v3');
      const { violations } = await new AxeBuilder({ page })
        .include('details.atlas-browser-sql')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        violations.filter(({ impact }) =>
          ['serious', 'critical'].includes(impact ?? ''),
        ),
      ).toEqual([]);
    });

    test('runs the parity example: 3 surveys, an 60 and ac 6, under Measured', async ({
      page,
    }) => {
      const panel = await openQueryPanel(page);
      await panel.getByRole('button', { name: /Lagos/ }).click();
      const { heading, rows } = await shownResult(panel);
      expect(heading).toBe('Measured');
      expect(rows).toEqual([['3', '60', '6']]);
      await expect(
        panel.locator('.atlas-browser-sql__result thead th'),
      ).toHaveText(['observations', 'an', 'ac']);
    });

    test('says the store is paused and links gnomAD when the store answers 403', async ({
      page,
      request,
    }) => {
      await request.get(`${STORE}__control?force=403`);
      await page.goto(HBS_PAGE);
      const panel = queryPanel(page);
      await panel.locator('summary').click();
      const alert = panel.getByRole('alert');
      await expect(alert.locator('p').first()).toHaveText(PAUSED_TEXT, {
        timeout: DUCKDB_MS,
      });
      await expect(alert.getByRole('link', { name: /gnomAD/ })).toHaveAttribute(
        'href',
        gnomadBrowserUrl('chr11-5227002-T-A', 'gnomad_r4'),
      );
      await expect(
        alert.getByRole('link', { name: QUERY_ERROR_DOCS.paused.label }),
      ).toHaveAttribute('href', QUERY_ERROR_DOCS.paused.href);
    });

    /** Opens the panel while the store answers 403, so its first start fails, then lifts the 403. */
    async function failFirstStart(
      page: Page,
      request: APIRequestContext,
    ): Promise<Locator> {
      await request.get(`${STORE}__control?force=403`);
      await page.goto(HBS_PAGE);
      const panel = queryPanel(page);
      await panel.locator('summary').click();
      await expect(panel.getByRole('alert').locator('p').first()).toHaveText(
        PAUSED_TEXT,
        { timeout: DUCKDB_MS },
      );
      await expect(
        panel.getByRole('group', { name: 'Example queries' }),
      ).toHaveCount(0);
      await request.get(`${STORE}__control?force=off`);
      return panel;
    }

    test('a failed start is tried again when the panel is reopened', async ({
      page,
      request,
    }) => {
      const panel = await failFirstStart(page, request);
      await panel.locator('summary').click();
      await expect(panel).not.toHaveAttribute('open');
      await panel.locator('summary').click();
      await expect(
        panel.getByRole('group', { name: 'Example queries' }),
      ).toBeVisible({ timeout: DUCKDB_MS });
      await expect(panel.getByRole('alert')).toHaveCount(0);
    });

    test('a failed start is tried again from its "Try again" button', async ({
      page,
      request,
    }) => {
      const panel = await failFirstStart(page, request);
      await panel.getByRole('button', { name: 'Try again' }).click();
      await expect(
        panel.getByRole('group', { name: 'Example queries' }),
      ).toBeVisible({ timeout: DUCKDB_MS });
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(
        panel.getByRole('button', { name: 'Try again' }),
      ).toHaveCount(0);
    });

    test('says a file is withdrawn when the store answers 404 for it', async ({
      page,
      request,
    }) => {
      const panel = await openQueryPanel(page);
      await request.get(`${STORE}__control?force=404`);
      await panel.getByRole('button', { name: /Lagos/ }).click();
      const alert = panel.getByRole('alert');
      await expect(alert.locator('p').first()).toHaveText(WITHDRAWN_TEXT, {
        timeout: DUCKDB_MS,
      });
      await expect(alert.getByRole('link', { name: /gnomAD/ })).toHaveCount(0);
      await expect(panel.locator('.atlas-browser-sql__result')).toHaveCount(0);
    });

    test('shows SQL errors verbatim', async ({ page }) => {
      const panel = await openQueryPanel(page);
      await panel.getByRole('textbox').fill('SELECT * FROM atlas.nope');
      await panel.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(panel.getByRole('alert').locator('pre')).toContainText(
        'atlas.nope',
        { timeout: DUCKDB_MS },
      );
    });

    test('without WebAssembly, says so and still copies the query for DuckDB', async ({
      page,
    }) => {
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto(HBS_PAGE);
      const panel = queryPanel(page);
      await expect(panel).toBeAttached();
      await page.evaluate(() => {
        Reflect.deleteProperty(globalThis, 'WebAssembly');
      });
      await panel.locator('summary').click();
      await expect(panel.getByRole('status').first()).toHaveText(NO_WASM_TEXT);
      await expect(
        panel.getByRole('group', { name: 'Example queries' }),
      ).toHaveCount(0);
      await panel
        .getByRole('textbox')
        .fill('SELECT * FROM atlas.meta.release;');
      await panel.getByRole('button', { name: 'Copy for DuckDB' }).click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(
        `${attachStatement(CATALOG)}\nSELECT * FROM atlas.meta.release;`,
      );
      expect(
        copied.startsWith(
          "ATTACH 'http://127.0.0.1:4324/releases/2000-01-01/catalog/atlas.duckdb' AS atlas (READ_ONLY);",
        ),
      ).toBe(true);
    });
  },
);
