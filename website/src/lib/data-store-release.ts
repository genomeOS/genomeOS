/**
 * The data-store release the website queries (Atlas data platform design 2026-10-18 §2.6, §3.1,
 * step 1.13): the newest committed manifest in `data/releases/` and the `catalog/atlas.duckdb` it
 * lists, at the committed data-store URL. Node-only: `app.astro`'s frontmatter reads it at build
 * time, so a malformed manifest fails the build and the page carries one fixed catalog URL.
 *
 * The directory is listed through `releaseIds`, which mirrors `data_release.release_ids` (Task 6):
 * `WITHDRAWN.json` is skipped and any other name that is not `<release>.json` is refused, so a stray
 * file fails the build rather than being read or ignored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { E2E_ATLAS_CATALOG_PATH } from './catalog-build';

/** `data_release.DATA_STORE_BASE_URL`: the public data store, committed by owner decision. */
export const DATA_STORE_BASE_URL =
  'https://storage.googleapis.com/genomeos-atlas-data/';
/** `data_release.WITHDRAWN_FILE`: the withdrawn keys, beside the manifests but not a release. */
export const WITHDRAWN_FILE = 'WITHDRAWN.json';
/** The views-only catalog a release lists (`genomeos.tables.catalog.CATALOG_DB`). */
export const CATALOG_DB = 'catalog/atlas.duckdb';

/** `data_release._RELEASE`: `YYYY-MM-DD`, with `.N` (N ≥ 1) for a later release that day. */
const RELEASE = /^(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?$/;
/** `data_release.release_key(<release>, CATALOG_DB)`: this release's key, or an earlier one reused. */
const CATALOG_KEY =
  /^releases\/\d{4}-\d{2}-\d{2}(?:\.[1-9]\d*)?\/catalog\/atlas\.duckdb$/;
const LOOPBACK_BASE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/$/;

/** What the website reads of a manifest; `data_release.py` validates the rest when it writes one. */
const manifestSchema = z.object({
  schema: z.literal('genomeos-data-release'),
  schema_version: z.literal(1),
  release: z.string(),
  objects: z.array(
    z.object({
      path: z.string().min(1),
      key: z.string().startsWith('releases/'),
      bytes: z.int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

/** One release's catalog: where the browser attaches it, and the bytes it must be. */
export interface DataStoreCatalogRef {
  release: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** `data_release.release_sort_key`: a release's day, then its `.N` (0 for the day's first). */
export function releaseSortKey(release: string): [string, number] {
  const match = RELEASE.exec(release);
  if (!match)
    throw new Error(
      `invalid release id ${JSON.stringify(release)}: expected YYYY-MM-DD or YYYY-MM-DD.N`,
    );
  return [match[1]!, Number(match[2] ?? 0)];
}

/**
 * `data_release.release_ids`: the releases among the file names of `data/releases/`, oldest first.
 * `WITHDRAWN.json` is skipped; any other name that is not `<release>.json` is refused.
 */
export function releaseIds(fileNames: string[]): string[] {
  const found: string[] = [];
  for (const name of fileNames) {
    if (name === WITHDRAWN_FILE) continue;
    const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (!RELEASE.test(stem))
      throw new Error(
        `${JSON.stringify(name)} in releases/ is neither a release manifest (YYYY-MM-DD[.N].json) nor ${WITHDRAWN_FILE}`,
      );
    found.push(stem);
  }
  return found.sort((a, b) => {
    const [dayA, nA] = releaseSortKey(a);
    const [dayB, nB] = releaseSortKey(b);
    return dayA === dayB ? nA - nB : dayA < dayB ? -1 : 1;
  });
}

/** The catalog object of release `release`'s manifest in `releasesDir`, or null if it lists none. */
function catalogObject(releasesDir: string, release: string) {
  const file = path.join(releasesDir, `${release}.json`);
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(
      `Data-store manifest ${file} is malformed: ${(error as Error).message}`,
    );
  }
  if (manifest.release !== release)
    throw new Error(
      `Data-store manifest ${file} names release ${JSON.stringify(manifest.release)}, not ${release}`,
    );
  const catalog = manifest.objects.find((object) => object.path === CATALOG_DB);
  if (catalog && !CATALOG_KEY.test(catalog.key))
    throw new Error(
      `Data-store manifest ${file} lists ${CATALOG_DB} under key ${JSON.stringify(catalog.key)}, not releases/<release>/${CATALOG_DB}`,
    );
  return catalog ?? null;
}

/**
 * The newest release's catalog at `baseUrl`, reading only the manifests `releaseIds` lists; null
 * while no release has one. Every manifest is read, so any malformed one fails the build; a newest
 * release without a catalog after one that had it is refused, never answered with an older catalog.
 */
export function latestDataStoreCatalog(
  releasesDir: string,
  baseUrl: string,
): DataStoreCatalogRef | null {
  const releases = releaseIds(readdirSync(releasesDir));
  const catalogs = releases.map((release) =>
    catalogObject(releasesDir, release),
  );
  const index = catalogs.findLastIndex((catalog) => catalog !== null);
  if (index < 0) return null;
  const release = releases[index]!;
  if (index !== releases.length - 1)
    throw new Error(
      `${releases.at(-1)} lists no ${CATALOG_DB}, but ${release} did: the website never attaches an older release's catalog`,
    );
  const { key, sha256, bytes } = catalogs[index]!;
  return { release, url: `${baseUrl}${key}`, sha256, bytes };
}

/**
 * `data_release.resolve_base_url` for the website build: the committed data-store URL, unless
 * `value` (`PUBLIC_DATA_STORE_BASE_URL`) is it, or a loopback stand-in in the e2e build (whose
 * `ATLAS_CATALOG_PATH`, `catalogPath`, is the e2e catalog). Anything else is refused: the committed
 * value is the truth, so no build can point readers at another store.
 */
export function dataStoreBaseFrom(
  value: string | undefined,
  catalogPath: string | undefined,
): string {
  if (value === undefined || value === '' || value === DATA_STORE_BASE_URL)
    return DATA_STORE_BASE_URL;
  if (!LOOPBACK_BASE.test(value))
    throw new Error(
      `PUBLIC_DATA_STORE_BASE_URL ${JSON.stringify(value)} differs from the committed data-store URL ${DATA_STORE_BASE_URL}; only the e2e build may name a loopback store (http://127.0.0.1:<port>/).`,
    );
  if (catalogPath !== E2E_ATLAS_CATALOG_PATH)
    throw new Error(
      `PUBLIC_DATA_STORE_BASE_URL ${JSON.stringify(value)} is a loopback store, which only the e2e build may use (npm run build:e2e, ATLAS_CATALOG_PATH=${E2E_ATLAS_CATALOG_PATH}).`,
    );
  return value;
}
