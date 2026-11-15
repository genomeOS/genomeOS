/**
 * One browser SQL session through the e2e build's `window.__atlasBrowserSql` hook (Atlas data
 * platform design 2026-10-18 §3.1, step 1.13), shared by the fixture and live browser specs.
 */
import type { Page } from '@playwright/test';

import type { QueryResult } from '../src/atlas/browser-sql/engine';
import { installAtlasBrowserFixture } from './atlas-browser-fixture';

export interface Session {
  objects: string[];
  results: QueryResult[];
  error: string | null;
}

/** Opens `/app/` with the e2e fixture and waits for the browser SQL hook. */
export async function openBrowserSqlPage(page: Page): Promise<void> {
  await installAtlasBrowserFixture(page);
  await page.goto('/app/');
  await page.waitForFunction(() => window.__atlasBrowserSql !== undefined);
}

/**
 * Opens DuckDB-WASM in the page, attaches `attach` when given, runs each query and closes it. A
 * failure comes back as its message, so a test can assert it.
 */
export async function inBrowser(
  page: Page,
  queries: string[],
  attach?: string,
): Promise<Session> {
  return page.evaluate(
    async ({ queries, attach }) => {
      const sql = await window.__atlasBrowserSql!.open();
      try {
        const results = [];
        if (attach !== undefined) await sql.attachCatalog(attach);
        const objects = attach === undefined ? [] : await sql.catalogObjects();
        for (const query of queries) results.push(await sql.run(query));
        return { objects, results, error: null };
      } catch (error) {
        return { objects: [], results: [], error: String(error) };
      } finally {
        await sql.close();
      }
    },
    { queries, attach },
  );
}
