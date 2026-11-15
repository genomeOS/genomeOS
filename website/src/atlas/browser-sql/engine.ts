/**
 * The pinned DuckDB-WASM in the browser (Atlas data platform design 2026-10-18 §3.1, step 1.13;
 * builder's call 15): it attaches a release's views-only `atlas.duckdb` and reads the files its
 * views name from the public data store, by HTTP range unless `WEBSITE_LOOKUP_ROUTE` says the
 * browser cannot.
 *
 * DuckDB-WASM loads only through `openBrowserSql`'s dynamic `import()`, so no page pays for it
 * before a query. Its two bundles (the WebAssembly-exceptions build and the MVP fallback) are
 * self-hosted: Vite copies the `.wasm` modules and their worker scripts into the build through
 * `?url` imports, and nothing is fetched from a CDN.
 */
import type * as DuckDB from '@duckdb/duckdb-wasm';
import ehModule from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import mvpModule from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';

import { attachStatement } from './examples';
import { formatCell } from './format';
import { WEBSITE_LOOKUP_ROUTE } from './route';

/** The most rows a query returns; a longer result is cut there and marked `truncated`. */
export const MAX_RESULT_ROWS = 1000;

export interface QueryResult {
  columns: string[];
  /** Each row's cells as text (`formatCell`), `NULL` for a null. */
  rows: string[][];
  /** The query had more than `MAX_RESULT_ROWS` rows; the rest were never read. */
  truncated: boolean;
}

export interface BrowserSql {
  /** Attaches the catalog at `url` read-only as `atlas`, replacing any catalog attached before. */
  attachCatalog(url: string): Promise<void>;
  /** The attached catalog's views and macros, as sorted `schema.name`. */
  catalogObjects(): Promise<string[]>;
  /** Runs one statement, streaming its rows and stopping after `MAX_RESULT_ROWS`. */
  run(sql: string): Promise<QueryResult>;
  /** Closes the connection and stops DuckDB's worker. */
  close(): Promise<void>;
}

const BUNDLES: DuckDB.DuckDBBundles = {
  mvp: { mainModule: mvpModule, mainWorker: mvpWorker },
  eh: { mainModule: ehModule, mainWorker: ehWorker },
};

const CATALOG_OBJECTS = `
SELECT schema_name || '.' || view_name AS name
FROM duckdb_views() WHERE database_name = 'atlas' AND NOT internal
UNION
SELECT schema_name || '.' || function_name
FROM duckdb_functions()
WHERE database_name = 'atlas' AND NOT internal AND function_type IN ('macro', 'table_macro')
ORDER BY name`;

/** Starts DuckDB-WASM in a worker with the filesystem `WEBSITE_LOOKUP_ROUTE` calls for. */
export async function openBrowserSql(): Promise<BrowserSql> {
  const duckdb = await import('@duckdb/duckdb-wasm');
  const bundle = await duckdb.selectBundle(BUNDLES);
  if (bundle.mainWorker === null)
    throw new Error('The DuckDB-WASM bundle has no worker script.');
  const db = new duckdb.AsyncDuckDB(
    new duckdb.VoidLogger(),
    new Worker(bundle.mainWorker),
  );
  let connection: DuckDB.AsyncDuckDBConnection;
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    // DuckDB-WASM 1.32.0 reads every HTTP file whole unless forceFullHTTPReads is false: left
    // unset, a read is one GET of the whole object, or, with full reads disallowed, a failed
    // open (route.ts). 'range' never falls back to a whole file, so a store that ignores Range
    // fails loudly instead of costing a full download per lookup (§1.4).
    const wholeFiles = WEBSITE_LOOKUP_ROUTE === 'p4-api';
    await db.open({
      filesystem: {
        reliableHeadRequests: true,
        allowFullHTTPReads: wholeFiles,
        forceFullHTTPReads: wholeFiles,
      },
    });
    connection = await db.connect();
  } catch (error) {
    await db.terminate();
    throw error;
  }
  const conn = connection;

  return {
    async attachCatalog(url) {
      await conn.query('DETACH DATABASE IF EXISTS atlas');
      // The statement "Copy for DuckDB" gives the CLI, Python or R.
      await conn.query(attachStatement(url));
    },
    async catalogObjects() {
      const table = await conn.query(CATALOG_OBJECTS);
      return table.toArray().map((row) => String(row.name));
    },
    async run(sql) {
      const reader = await (await conn.send(sql, true)).open();
      const fields = reader.schema?.fields ?? [];
      const columns = fields.map((field) => field.name);
      const rows: string[][] = [];
      let truncated = false;
      for await (const batch of reader) {
        const vectors = columns.map((_, index) => batch.getChildAt(index));
        for (let row = 0; row < batch.numRows && !truncated; row += 1) {
          if (rows.length === MAX_RESULT_ROWS) truncated = true;
          else
            rows.push(
              vectors.map((vector, index) =>
                formatCell(vector?.get(row), fields[index]!.type),
              ),
            );
        }
        if (truncated) break;
      }
      if (truncated) await conn.cancelSent();
      return { columns, rows, truncated };
    },
    async close() {
      try {
        await conn.close();
      } finally {
        await db.terminate();
      }
    },
  };
}
