/**
 * How the website reads one variant from the data store (Atlas data platform design 2026-10-18
 * §1.4, §3.1, step 1.13): by HTTP range with the pinned DuckDB-WASM, or, when it cannot
 * range-read, through the P4 API.
 *
 * Measured 2026-11-15 by tests/browser-sql.spec.ts in Playwright's Chromium 153, with
 * @duckdb/duckdb-wasm 1.32.0 (DuckDB v1.4.3) reading a local store that answers like GCS:
 * - It range-reads only when opened with `forceFullHTTPReads: false`. Left unset, it reads every
 *   HTTP file whole: one 200 GET of the object, or, with full reads disallowed, a failed open. That
 *   default is the whole-file fetching [wasm-1367] reports from v1.30.0.
 * - With it, one row of the 963,225-byte probe (12 row groups) took 5 requests: a HEAD (200), the
 *   HEAD with `Range: bytes=0-` that opens the file (206, as the data store answers it, observed
 *   anonymously the same day) and three ranged GETs (206), 94,873 bytes in all (9.8%, under the
 *   quarter the test holds it to). A lookup costs a fixed ~96 KiB of 16 KiB blocks and a 64 KiB
 *   read-ahead, whatever the object's size: 97,638 bytes (59.7%) of the probe before its unread
 *   padding column (163,507 bytes) and 120,048 bytes (6.7%) of a 1.79 MB copy.
 * - A store that ignores Range fails the open loudly; nothing is read whole.
 *
 * So the route is 'range'. `BROWSER_SQL_LIVE=1` (tests/browser-sql-live.spec.ts) measures the
 * bucket itself once its CORS exposes the range headers; where it disagrees, it wins (F6).
 */
export const WEBSITE_LOOKUP_ROUTE: 'range' | 'p4-api' = 'range';

/**
 * Hosts DuckDB-WASM may fetch extensions from. The pinned bundles do not build `parquet` in: it
 * autoloads from https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm
 * (measured 2026-11-15).
 */
export const ALLOWED_EXTENSION_HOSTS: readonly string[] = [
  'extensions.duckdb.org',
];
