/**
 * The live gate of browser SQL (Atlas data platform design 2026-10-18 §1.4, §3.1, step 1.13; F6):
 * the pinned DuckDB-WASM against the public data store and DuckDB's community extensions, from
 * the e2e build's hook, and the "Query in your browser" parity example on the newest committed
 * release's catalog (§2.7 check 8's Lagos disc). Never in CI: the owner runs it once the bucket's
 * CORS exposes the range headers (deploy/data-store-cors.json) and that release is uploaded,
 *
 *   cd website && BROWSER_SQL_LIVE=1 npx playwright test --config playwright.live.config.ts
 *
 * and where it disagrees with `WEBSITE_LOOKUP_ROUTE`, it wins.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Response } from '@playwright/test';
import { latLngToCell } from 'h3-js';

import { browserSqlExamples } from '../src/atlas/browser-sql/examples';
import { WEBSITE_LOOKUP_ROUTE } from '../src/atlas/browser-sql/route';
import {
  DATA_STORE_BASE_URL,
  latestDataStoreCatalog,
} from '../src/lib/data-store-release';
import { inBrowser, openBrowserSqlPage } from './browser-sql-session';
import { ALL, HBS } from './fixtures/browser-sql';

const RELEASES = path.resolve(import.meta.dirname, '../../data/releases');
const WITHDRAWN = 'WITHDRAWN.json';
/** Lagos, the parity smoke's centre (check 8). */
const LAGOS = [6.5244, 3.3792] as const;

interface ReleaseObject {
  key: string;
  path: string;
  bytes: number;
}

/** The largest cells.parquet a committed release lists and none withdrew. */
function largestCells(): ReleaseObject {
  const names = readdirSync(RELEASES);
  const withdrawn = new Set(
    names.includes(WITHDRAWN)
      ? (
          JSON.parse(readFileSync(path.join(RELEASES, WITHDRAWN), 'utf8')) as {
            withdrawn: { key: string }[];
          }
        ).withdrawn.map((entry) => entry.key)
      : [],
  );
  const cells = names
    .filter((name) => name !== WITHDRAWN)
    .flatMap(
      (name) =>
        (
          JSON.parse(readFileSync(path.join(RELEASES, name), 'utf8')) as {
            objects: ReleaseObject[];
          }
        ).objects,
    )
    .filter(
      (item) =>
        item.path.endsWith('/cells.parquet') && !withdrawn.has(item.key),
    )
    .sort((a, b) => b.bytes - a.bytes);
  if (cells.length === 0)
    throw new Error(`No release in ${RELEASES} lists a cells.parquet.`);
  return cells[0]!;
}

test.describe('browser SQL, live', { tag: '@desktop-chromium' }, () => {
  test.skip(
    process.env.BROWSER_SQL_LIVE !== '1',
    'the live gate reads the public bucket: set BROWSER_SQL_LIVE=1',
  );
  test.beforeEach(async ({ page }) => openBrowserSqlPage(page));
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the largest released cells.parquet reads by range', async ({
    page,
  }) => {
    test.skip(
      WEBSITE_LOOKUP_ROUTE !== 'range',
      "the 'p4-api' route reads whole files by design",
    );
    const cells = largestCells();
    const url = `${DATA_STORE_BASE_URL}${cells.key}`;
    const responses: Response[] = [];
    page.on('response', (response) => {
      if (response.url() === url) responses.push(response);
    });
    const session = await inBrowser(page, [
      `SELECT count(*) FROM read_parquet('${url}') WHERE h3_index = '${latLngToCell(...LAGOS, 4)}'`,
    ]);
    const reads = await Promise.all(
      responses.map(async (response) => ({
        method: response.request().method(),
        status: response.status(),
        range: (await response.request().allHeaders()).range ?? null,
        bytes:
          response.request().method() === 'HEAD'
            ? 0
            : Number((await response.allHeaders())['content-length']),
      })),
    );
    const sent = reads.reduce((total, read) => total + read.bytes, 0);
    console.log(
      `${cells.key}: ${reads.length} requests, ${sent} of ${cells.bytes} bytes (${((100 * sent) / cells.bytes).toFixed(1)}%):`,
      JSON.stringify(reads),
    );
    expect(session.error).toBeNull();
    for (const read of reads) {
      expect(
        read.method === 'HEAD' || (read.status === 206 && read.range !== null),
        JSON.stringify(read),
      ).toBe(true);
    }
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(cells.bytes / 4);
  });

  test('the h3 community extension loads and agrees with h3-js', async ({
    page,
  }) => {
    const session = await inBrowser(page, [
      'INSTALL h3 FROM community',
      'LOAD h3',
      `SELECT h3_h3_to_string(h3_latlng_to_cell(${LAGOS[0]}, ${LAGOS[1]}, 4))`,
    ]);
    expect(session.error).toBeNull();
    expect(session.results[2]!.rows).toEqual([[latLngToCell(...LAGOS, 4)]]);
  });

  test("the panel's parity example gives check 8's golden Lagos counts", async ({
    page,
  }) => {
    // The catalog the production build bakes into the panel, and the example the panel runs.
    const catalog = latestDataStoreCatalog(RELEASES, DATA_STORE_BASE_URL);
    if (catalog === null)
      throw new Error(`No release in ${RELEASES} lists a catalog.`);
    const parity = browserSqlExamples(ALL, HBS).find(
      (example) => example.id === 'parity-near-lagos',
    )!;
    const session = await inBrowser(page, [parity.sql], catalog.url);
    expect(session.error).toBeNull();
    // scripts/smoke_catalog.py's GOLDEN: 40 discs, sum an 52,340, sum ac 6,459.
    expect(session.results[0]!.rows).toEqual([['40', '52340', '6459']]);
  });
});
