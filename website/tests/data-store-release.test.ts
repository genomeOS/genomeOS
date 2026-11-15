/**
 * The release catalog the website attaches (Atlas data platform design 2026-10-18 §2.6, §3.1, step
 * 1.13): the newest committed manifest's `catalog/atlas.duckdb`, listed through Task 6's
 * `release_ids` rule, at the committed data-store URL.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ATLAS_CATALOG_PATH,
  E2E_ATLAS_CATALOG_PATH,
} from '../src/lib/catalog-build';
import {
  dataStoreBaseFrom,
  latestDataStoreCatalog,
  releaseIds,
  releaseSortKey,
} from '../src/lib/data-store-release';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
/** `data_release.DATA_STORE_BASE_URL`, read from the Python source it must equal. */
const COMMITTED_BASE = /^DATA_STORE_BASE_URL = "([^"]+)"$/m.exec(
  readFileSync(
    path.join(repositoryRoot, 'genomeos/publication/data_release.py'),
    'utf8',
  ),
)![1]!;
const BASE = 'https://x.test/store/';
const WITHDRAWN = {
  schema: 'genomeos-withdrawn',
  schema_version: 1,
  withdrawn: [],
};

function catalogObject(release: string) {
  return {
    path: 'catalog/atlas.duckdb',
    key: `releases/${release}/catalog/atlas.duckdb`,
    bytes: 274432,
    sha256: 'a'.repeat(64),
    media_type: 'application/octet-stream',
    in_git: false,
    sources: ['genomeos'],
  };
}

function manifest(release: string, catalog = true) {
  return {
    schema: 'genomeos-data-release',
    schema_version: 1,
    release,
    local_root: 'data',
    objects: catalog ? [catalogObject(release)] : [],
    sources: [],
    totals: {},
  };
}

/** A releases directory holding `files`, each written as JSON. */
function releases(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'data-store-release-'));
  for (const [name, content] of Object.entries(files))
    writeFileSync(path.join(dir, name), JSON.stringify(content));
  return dir;
}

describe('releaseIds (data_release.release_ids)', () => {
  it('releaseIds skips WITHDRAWN.json and refuses strays', () => {
    expect(
      releaseIds(['2026-11-20.json', 'WITHDRAWN.json', '2026-11-20.1.json']),
    ).toEqual(['2026-11-20', '2026-11-20.1']);
    expect(
      releaseIds(['2026-11-20.1.json', '2026-10-18.json', '2026-11-20.json']),
    ).toEqual(['2026-10-18', '2026-11-20', '2026-11-20.1']);
    for (const stray of [
      'withdrawn.json',
      'latest.json',
      '2026-11-20.0.json',
      '2026-11-20',
      '.DS_Store',
    ])
      expect(() => releaseIds(['2026-11-20.json', stray]), stray).toThrow(
        /neither/,
      );
  });

  it('sorts a second release of a day after the first', () => {
    expect(releaseSortKey('2026-10-18.2')).toEqual(['2026-10-18', 2]);
    expect(releaseSortKey('2026-10-18')).toEqual(['2026-10-18', 0]);
    expect(releaseIds(['2026-10-18.10.json', '2026-10-18.9.json'])).toEqual([
      '2026-10-18.9',
      '2026-10-18.10',
    ]);
    expect(() => releaseSortKey('2026-10-18.')).toThrow(/release id/);
  });
});

describe('latestDataStoreCatalog', () => {
  it("returns the newest release's catalog at the base", () => {
    const dir = releases({
      '2026-11-20.json': manifest('2026-11-20'),
      '2026-11-20.1.json': manifest('2026-11-20.1'),
      'WITHDRAWN.json': WITHDRAWN,
    });
    expect(latestDataStoreCatalog(dir, BASE)).toEqual({
      release: '2026-11-20.1',
      url: `${BASE}releases/2026-11-20.1/catalog/atlas.duckdb`,
      sha256: 'a'.repeat(64),
      bytes: 274432,
    });
  });

  it('gives null when no release has a catalog yet', () => {
    expect(
      latestDataStoreCatalog(releases({ 'WITHDRAWN.json': WITHDRAWN }), BASE),
    ).toBeNull();
    expect(
      latestDataStoreCatalog(
        releases({ '2026-10-17.json': manifest('2026-10-17', false) }),
        BASE,
      ),
    ).toBeNull();
  });

  it('refuses a newest release that lists no catalog after one that did', () => {
    const dir = releases({
      '2026-10-17.json': manifest('2026-10-17', false),
      '2026-11-20.json': manifest('2026-11-20'),
      '2026-12-01.json': manifest('2026-12-01', false),
    });
    expect(() => latestDataStoreCatalog(dir, BASE)).toThrow(
      /2026-12-01 lists no catalog\/atlas\.duckdb, but 2026-11-20 did/,
    );
  });

  it('fails on a malformed manifest or a stray file, never skipping it', () => {
    expect(() =>
      latestDataStoreCatalog(releases({ 'notes.json': {} }), BASE),
    ).toThrow(/neither/);
    expect(() =>
      latestDataStoreCatalog(
        releases({ '2026-11-20.json': manifest('2026-11-21') }),
        BASE,
      ),
    ).toThrow(/2026-11-20\.json/);
    const broken = manifest('2026-11-20');
    broken.objects[0]!.sha256 = 'not-a-sha';
    expect(() =>
      latestDataStoreCatalog(releases({ '2026-11-20.json': broken }), BASE),
    ).toThrow(/2026-11-20\.json/);
    const dir = releases({});
    writeFileSync(path.join(dir, '2026-11-20.json'), '{');
    expect(() => latestDataStoreCatalog(dir, BASE)).toThrow(/2026-11-20\.json/);
  });

  it("reads the e2e fixture release's manifests", () => {
    expect(
      latestDataStoreCatalog(
        path.join(import.meta.dirname, 'fixtures/data-store/manifests'),
        'http://127.0.0.1:4324/',
      ),
    ).toMatchObject({
      release: '2000-01-01',
      url: 'http://127.0.0.1:4324/releases/2000-01-01/catalog/atlas.duckdb',
    });
  });
});

describe('dataStoreBaseFrom (data_release.resolve_base_url)', () => {
  it("is data_release.py's committed base unless set", () => {
    expect(COMMITTED_BASE).toBe(
      'https://storage.googleapis.com/genomeos-atlas-data/',
    );
    for (const value of [undefined, '', COMMITTED_BASE])
      expect(dataStoreBaseFrom(value, DEFAULT_ATLAS_CATALOG_PATH)).toBe(
        COMMITTED_BASE,
      );
  });

  it('allows a loopback store only in the e2e build', () => {
    for (const loopback of [
      'http://127.0.0.1:4324/',
      'http://localhost:4324/',
    ]) {
      expect(dataStoreBaseFrom(loopback, E2E_ATLAS_CATALOG_PATH)).toBe(
        loopback,
      );
      expect(() =>
        dataStoreBaseFrom(loopback, DEFAULT_ATLAS_CATALOG_PATH),
      ).toThrow(/e2e/);
      expect(() => dataStoreBaseFrom(loopback, undefined)).toThrow(/e2e/);
    }
  });

  it('refuses any other base', () => {
    for (const other of [
      'https://storage.googleapis.com/example-bucket/',
      COMMITTED_BASE.slice(0, -1),
      'http://127.0.0.1:4324',
      'http://192.168.1.2:4324/',
      '/data-store/',
    ])
      expect(
        () => dataStoreBaseFrom(other, E2E_ATLAS_CATALOG_PATH),
        other,
      ).toThrow(/PUBLIC_DATA_STORE_BASE_URL/);
  });
});
