/**
 * What the "Query in your browser" panel prints (Atlas data platform design 2026-10-18 §3.1, step
 * 1.13): result cells written exactly, as the pinned DuckDB-WASM returns them, and errors explained
 * for what a reader can do: a paused store, a withdrawn file or their own SQL.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

import type * as DuckDBBlocking from '@duckdb/duckdb-wasm/blocking';
import { describe, expect, it, vi } from 'vitest';

import {
  explainQueryError,
  gnomadBrowserUrl,
  NO_WASM_TEXT,
  QUERY_ERROR_DOCS,
  storeObjectUrl,
  withStoreStatus,
} from '../src/atlas/browser-sql/errors';
import { formatCell } from '../src/atlas/browser-sql/format';

const require = createRequire(import.meta.url);
const BLOCKING = '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs';

const PAUSED =
  'The public data store is paused: a spending brake made it private, so its files cannot be read now. Lookups resume when the maintainer restores access.';
const WITHDRAWN =
  "A file this release's catalog names is gone, most likely withdrawn. Reload the page for the newest catalog.";
const CATALOG = 'https://x.test/releases/2026-11-20/catalog/atlas.duckdb';
const PARQUET =
  'https://x.test/releases/2026-11-20/tables/v1/inferred/artifacts.parquet';
/** DuckDB-WASM's messages for a catalog, or a file it reads, that the store refused. */
const ATTACH_FAILED = `IO Error: Cannot open database "${CATALOG}" in read-only mode: database does not exist`;
const READ_FAILED = `IO Error: No files found that match the pattern "${PARQUET}"`;
const PARSER_ERROR =
  '{"exception_type":"Parser","exception_message":"syntax error at or near \\"SELEC\\"\\n\\nLINE 1: SELEC 1\\n        ^","error_subtype":"SYNTAX_ERROR","position":"0"}';

let database: Promise<DuckDBBlocking.DuckDBBindings> | undefined;

/** The pinned DuckDB-WASM's blocking build, which runs in this thread with no worker. */
function pinnedDuckDb(): Promise<DuckDBBlocking.DuckDBBindings> {
  database ??= (async () => {
    const duckdb = require(BLOCKING) as typeof DuckDBBlocking;
    const dist = path.dirname(require.resolve(BLOCKING));
    const bundle = (name: string) => ({
      mainModule: path.join(dist, `duckdb-${name}.wasm`),
      mainWorker: '',
    });
    const db = await duckdb.createDuckDB(
      { mvp: bundle('mvp'), eh: bundle('eh') },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    );
    await db.instantiate();
    return db;
  })();
  return database;
}

/** Each column of `sql`'s one row, as the panel prints it. */
async function printedRow(sql: string): Promise<Record<string, string>> {
  const con = (await pinnedDuckDb()).connect();
  try {
    const table = con.query(sql);
    return Object.fromEntries(
      table.schema.fields.map((field, index) => [
        field.name,
        formatCell(table.getChildAt(index)!.get(0), field.type),
      ]),
    );
  } finally {
    con.close();
  }
}

describe('formatCell', () => {
  it('writes integers exactly, NULL for a null, and nested values as JSON', () => {
    expect(formatCell(52340n)).toBe('52340');
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(undefined)).toBe('NULL');
    expect(formatCell({ ac: 1n, labels: ['a'] })).toBe(
      '{"ac":"1","labels":["a"]}',
    );
    expect(formatCell('x')).toBe('x');
    expect(formatCell(0.5)).toBe('0.5');
    expect(formatCell(false)).toBe('false');
  });

  it("writes DuckDB-WASM's BIGINT, HUGEINT and DECIMAL values exactly", async () => {
    expect(
      await printedRow(`
        SELECT sum(an) AS an, 52340::BIGINT AS big, 2::UBIGINT AS unsigned,
          170141183460469231731687303715884105727::HUGEINT AS hugeint_max,
          (-170141183460469231731687303715884105727)::HUGEINT AS hugeint_min,
          12.345::DECIMAL(9,3) AS decimal, -0.05::DECIMAL(4,2) AS negative,
          123456789012345678901234567.89::DECIMAL(38,2) AS wide,
          1.5 AS literal
        FROM (SELECT 52340 AS an)`),
    ).toEqual({
      an: '52340',
      big: '52340',
      unsigned: '2',
      hugeint_max: '170141183460469231731687303715884105727',
      hugeint_min: '-170141183460469231731687303715884105727',
      decimal: '12.345',
      negative: '-0.05',
      wide: '123456789012345678901234567.89',
      literal: '1.5',
    });
  });

  it('writes lists, structs and maps as JSON, their integers and decimals exact', async () => {
    expect(
      await printedRow(`
        SELECT [1.25, NULL, -2.5] AS decimals, [2::BIGINT, 3] AS bigints,
          {'ac': 1::BIGINT, 'labels': ['a'], 'q': 0.75} AS struct,
          MAP {'HbS': 6::BIGINT} AS counts,
          MAP {'d': 1.5} AS decimal_values`),
    ).toEqual({
      decimals: '["1.25",null,"-2.50"]',
      bigints: '["2","3"]',
      struct: '{"ac":"1","labels":["a"],"q":"0.75"}',
      counts: '{"HbS":"6"}',
      decimal_values: '{"d":"1.5"}',
    });
  });
});

describe('explainQueryError', () => {
  it('reads a 403 from the store as the paused store', () => {
    expect(
      explainQueryError(`${ATTACH_FAILED} (HTTP 403 for ${CATALOG})`),
    ).toEqual({ kind: 'paused', text: PAUSED });
    // DuckDB-WASM's own message when a range read of an open file is refused.
    expect(
      explainQueryError(
        `Range request for ${CATALOG} did returned non-success status: 403 "Forbidden"`,
      ),
    ).toEqual({ kind: 'paused', text: PAUSED });
  });

  it('reads a 404 of a file the catalog names as a withdrawal', () => {
    expect(
      explainQueryError(`${READ_FAILED} (HTTP 404 for ${PARQUET})`),
    ).toEqual({ kind: 'withdrawn', text: WITHDRAWN });
    expect(
      explainQueryError(`${ATTACH_FAILED} (HTTP 404 for ${CATALOG})`).kind,
    ).toBe('withdrawn');
  });

  it("does not read a 404 of the catalog's .wal, which DuckDB always asks for, as a withdrawal", () => {
    const wal = `HTTP 404 for ${CATALOG}.wal`;
    expect(explainQueryError(wal)).toEqual({ kind: 'sql', text: wal });
  });

  it('passes every other message through verbatim', () => {
    for (const message of [
      PARSER_ERROR,
      READ_FAILED,
      'Catalog Error: Table with name nope does not exist!',
      // A status other than the store's, or digits inside a key, are not the store's answer.
      `${READ_FAILED} (HTTP 500 for ${PARQUET})`,
      'IO Error: No files found that match the pattern "https://x.test/releases/r/chr11-404-403.parquet"',
      'HTTP 403 for https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm',
    ])
      expect(explainQueryError(message)).toEqual({
        kind: 'sql',
        text: message,
      });
  });
});

describe('withStoreStatus', () => {
  it('asks the store about the file a message names and adds its refusal', async () => {
    const head = vi.fn(async () => 404);
    expect(await withStoreStatus(READ_FAILED, head)).toBe(
      `${READ_FAILED} (HTTP 404 for ${PARQUET})`,
    );
    expect(head).toHaveBeenCalledWith(PARQUET);
    expect(storeObjectUrl(ATTACH_FAILED)).toBe(CATALOG);
  });

  it('leaves the message alone when the file reads, the probe fails or no file is named', async () => {
    expect(await withStoreStatus(READ_FAILED, async () => 206)).toBe(
      READ_FAILED,
    );
    expect(
      await withStoreStatus(READ_FAILED, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe(READ_FAILED);
    const head = vi.fn(async () => 403);
    expect(await withStoreStatus(PARSER_ERROR, head)).toBe(PARSER_ERROR);
    expect(await withStoreStatus(`HTTP 404 for ${CATALOG}.wal`, head)).toBe(
      `HTTP 404 for ${CATALOG}.wal`,
    );
    expect(head).not.toHaveBeenCalled();
  });
});

describe('the panel copy', () => {
  it('says what to do without WebAssembly', () => {
    expect(NO_WASM_TEXT).toBe(
      'This browser cannot run DuckDB here (it needs WebAssembly and Web Workers). Copy the query and run it in the DuckDB CLI, Python or R.',
    );
  });

  it("links gnomAD's browser for the variant", () => {
    expect(gnomadBrowserUrl('chr11-5227002-T-A', 'gnomad_r4')).toBe(
      'https://gnomad.broadinstitute.org/variant/chr11-5227002-T-A?dataset=gnomad_r4',
    );
  });

  it("links each error to its section of docs/data-access.md (step 1.15's headings)", () => {
    const doc =
      'https://github.com/genomeOS/genomeOS/blob/main/docs/data-access.md';
    expect(
      Object.fromEntries(
        Object.entries(QUERY_ERROR_DOCS).map(([kind, link]) => [
          kind,
          link.href,
        ]),
      ),
    ).toEqual({
      paused: `${doc}#when-access-stops-the-brake-and-the-kill-switch`,
      withdrawn: `${doc}#takedowns`,
      sql: `${doc}#query-in-your-browser`,
    });
  });
});
