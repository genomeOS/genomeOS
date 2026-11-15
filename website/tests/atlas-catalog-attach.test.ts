import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type * as DuckDBBlocking from '@duckdb/duckdb-wasm/blocking';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATALOG_OBJECTS } from '../src/atlas/browser-sql/engine';

/**
 * The pinned DuckDB-WASM attaches a release catalog (Atlas data platform design 2026-10-18 §2.6, call
 * 15, step 1.6). The fixture is release 2026-11-20 of the Python tests' `catalog_tree`, written by the
 * pinned DuckDB 1.5.5 in storage version v1.2.0; `python scripts/build_catalog_fixture.py` rebuilds it,
 * and CI attaches it from DuckDB 1.2.2 too. When `expected.json` carries `macros`, the lookup macros
 * run here too, with the calls `scripts/check_catalog_attach.py` makes (open question O6: `query()`,
 * `getvariable()` and `error()` under the pinned DuckDB-WASM).
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

/** `expected.json`: each view's rows, and what the lookup macros return when the catalog has them. */
interface Expected {
  release: string;
  views: Record<string, number>;
  macros?: {
    variant: [string, number, number, number][];
    lookup_url_chrM: string[];
    surfaces_rows: number;
  };
}

const expected = JSON.parse(
  readFileSync(path.join(fixture, 'expected.json'), 'utf8'),
) as Expected;
/** The ids `scripts/check_catalog_attach.py` looks up: rs334, and a chrM id no lookup set computes. */
const RS334 = 'chr11-5227002-T-A';
const CHRM = 'chrM-16519-T-C';

/** The fixture catalog attached as `atlas` by the blocking build, offline from its `data/` copies. */
async function attachFixture(): Promise<DuckDBBlocking.DuckDBConnection> {
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
    db.registerFileBuffer(`data/${file}`, readFileSync(path.join(data, file)));
  }
  const con = db.connect();
  con.query("SET VARIABLE genomeos_local = 'data/'");
  con.query("ATTACH 'atlas.duckdb' AS atlas (READ_ONLY)");
  return con;
}

describe('the pinned DuckDB-WASM (data platform call 15)', () => {
  let con: DuckDBBlocking.DuckDBConnection;

  beforeAll(async () => {
    con = await attachFixture();
  });

  afterAll(() => {
    con.close();
  });

  it('the DuckDB-WASM pin is exact', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the pinned DuckDB-WASM attaches the fixture catalog read-only', () => {
    const version = String(one(con, 'SELECT version()'));
    console.log(`${PACKAGE} ${pinned} bundles DuckDB ${version} (F6)`);
    expect(version).toMatch(SUPPORTED_DUCKDB);
    const counts = Object.fromEntries(
      Object.keys(expected.views).map((view) => [
        view,
        Number(one(con, `SELECT count(*) FROM atlas.${view}`)),
      ]),
    );
    expect(counts).toEqual(expected.views);
  });

  // O6 (whole-genome plan; data platform §1.4): query(), getvariable() and error() inside the lookup
  // macros, under the pinned DuckDB-WASM. These are scripts/check_catalog_attach.py's MACRO_CALLS.
  describe.runIf(expected.macros !== undefined)(
    'the lookup macros (O6)',
    () => {
      it('measured.variant returns the fixture rows by cohort', () => {
        const rows = con
          .query(
            `SELECT cohort_id, count(*) AS n, sum(ac) AS ac, sum(an) AS an FROM atlas.measured.variant('${RS334}') GROUP BY 1 ORDER BY 1`,
          )
          .toArray()
          .map((row) => [
            String(row.cohort_id),
            Number(row.n),
            Number(row.ac),
            Number(row.an),
          ]);
        expect(rows).toEqual(expected.macros?.variant);
      });

      it('measured.lookup_url computes no URL for a chrM id', () => {
        const urls = one(
          con,
          `SELECT atlas.measured.lookup_url('${CHRM}')`,
        ) as {
          toArray(): unknown[];
        };
        expect([...urls.toArray()].map(String)).toEqual(
          expected.macros?.lookup_url_chrM,
        );
      });

      it('inferred.surfaces reads no rows for rs334 in the fixture', () => {
        expect(
          Number(
            one(
              con,
              `SELECT count(*) FROM atlas.inferred.surfaces('${RS334}')`,
            ),
          ),
        ).toBe(expected.macros?.surfaces_rows);
      });

      it("a malformed id raises the macro's error() guard", () => {
        expect(() =>
          con.query("SELECT * FROM atlas.measured.variant('rs334')"),
        ).toThrow(/measured\.variant takes a GRCh38 chr-pos-ref-alt id/);
      });

      it("the panel's catalog-objects query lists the macros beside the views", () => {
        const names = con
          .query(CATALOG_OBJECTS)
          .toArray()
          .map((row) => String(row.name));
        expect(names).toEqual(
          expect.arrayContaining([
            'measured.lookup_url',
            'measured.near',
            'measured.variant',
            'inferred.surfaces',
            ...Object.keys(expected.views),
          ]),
        );
      });
    },
  );
});
