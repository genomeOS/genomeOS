import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type * as DuckDBBlocking from '@duckdb/duckdb-wasm/blocking';
import { describe, expect, it } from 'vitest';

/**
 * The pinned DuckDB-WASM attaches a release catalog (Atlas data platform design 2026-10-18 §2.6, call
 * 15, step 1.6). The fixture is release 2026-11-20 of the Python tests' `catalog_tree`, written by the
 * pinned DuckDB 1.5.5 in storage version v1.2.0; `python scripts/build_catalog_fixture.py` rebuilds it,
 * and CI attaches it from DuckDB 1.2.2 too.
 */
const require = createRequire(import.meta.url);
const websiteRoot = path.resolve(import.meta.dirname, '..');
const fixture = path.resolve(websiteRoot, '../tests/fixtures/catalog');
const PACKAGE = '@duckdb/duckdb-wasm';
const BLOCKING = `${PACKAGE}/dist/duckdb-node-blocking.cjs`;
/** DuckDB 1.2 or newer, 2.x included: DuckDB 1.2 is the oldest that attaches storage v1.2.0. */
const SUPPORTED_DUCKDB =
  /^v(?:1\.(?:[2-9]|[1-9]\d)|[2-9]\.\d+|[1-9]\d+\.\d+)\.\d+$/;

const pinned = (
  JSON.parse(readFileSync(path.join(websiteRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  }
).dependencies[PACKAGE];

/** Every file under `root`, as a path relative to it with `/` separators. */
function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    )
    .sort();
}

/** The first column of the first row of `sql`. */
function one(con: DuckDBBlocking.DuckDBConnection, sql: string): unknown {
  const [row] = con.query(sql).toArray();
  return Object.values(row)[0];
}

describe('the pinned DuckDB-WASM (data platform call 15)', () => {
  it('the DuckDB-WASM pin is exact', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the pinned DuckDB-WASM attaches the fixture catalog read-only', async () => {
    const duckdb = require(BLOCKING) as typeof DuckDBBlocking;
    const dist = path.dirname(require.resolve(BLOCKING));
    // The blocking build runs in this thread, so it starts no worker.
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
    db.registerFileBuffer(
      'atlas.duckdb',
      readFileSync(path.join(fixture, 'atlas.duckdb')),
    );
    const data = path.join(fixture, 'data');
    for (const file of files(data)) {
      db.registerFileBuffer(
        `data/${file}`,
        readFileSync(path.join(data, file)),
      );
    }
    const con = db.connect();
    try {
      con.query("SET VARIABLE genomeos_local = 'data/'");
      con.query("ATTACH 'atlas.duckdb' AS atlas (READ_ONLY)");
      const version = String(one(con, 'SELECT version()'));
      console.log(`${PACKAGE} ${pinned} bundles DuckDB ${version} (F6)`);
      expect(version).toMatch(SUPPORTED_DUCKDB);
      const expected = JSON.parse(
        readFileSync(path.join(fixture, 'expected.json'), 'utf8'),
      ) as { release: string; views: Record<string, number> };
      const counts = Object.fromEntries(
        Object.keys(expected.views).map((view) => [
          view,
          Number(one(con, `SELECT count(*) FROM atlas.${view}`)),
        ]),
      );
      expect(counts).toEqual(expected.views);
    } finally {
      con.close();
    }
  });
});
