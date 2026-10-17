/**
 * Build-time catalog loading for the `/app/` page (fast-load design §B.6.1). Node-only: imported by
 * `app.astro` frontmatter, never by client code. A catalog that fails the strict browser schema, or
 * whose `format_version` this client cannot read (docs/web-data-format.md), fails the build. A newer
 * MINOR builds, with a warning that the keys it adds are ignored.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { parseAtlasCatalog, type AtlasCatalog } from '../atlas/contracts';
import {
  ATLAS_WEB_FORMAT_VERSION,
  AtlasFormatVersionError,
  catalogReadMode,
} from '../atlas/format-version';
import { escapeInlineJson } from '../atlas/inline-catalog';

export const DEFAULT_ATLAS_CATALOG_PATH = 'public/data/atlas/catalog.json';

export function loadPageCatalog(
  catalogPath: string | undefined = DEFAULT_ATLAS_CATALOG_PATH,
  cwd: string = process.cwd(),
): { catalog: AtlasCatalog; json: string } {
  const resolved = path.resolve(cwd, catalogPath || DEFAULT_ATLAS_CATALOG_PATH);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(
      `Atlas catalog ${resolved} could not be read as JSON: ${(error as Error).message}`,
    );
  }
  let catalog: AtlasCatalog;
  try {
    catalog = parseAtlasCatalog(raw);
  } catch (error) {
    if (error instanceof AtlasFormatVersionError)
      throw new Error(`Atlas catalog ${resolved}: ${error.message}`);
    if (error instanceof z.ZodError)
      throw new Error(
        `Atlas catalog ${resolved} fails atlasCatalogSchema:\n${z.prettifyError(error)}`,
      );
    throw error;
  }
  if (catalogReadMode(raw) === 'newer-minor')
    console.warn(
      `Atlas catalog ${resolved} is format ${catalog.format_version}, newer than this site's ${ATLAS_WEB_FORMAT_VERSION}: catalog keys this site does not know are ignored (docs/web-data-format.md).`,
    );
  return { catalog, json: escapeInlineJson(JSON.stringify(raw)) };
}

/** The committed e2e fixture catalog, relative to `website/` (Task 21 (B1.7)). */
export const E2E_ATLAS_CATALOG_PATH = 'tests/fixtures/atlas/e2e/catalog.json';

/**
 * fast-load design §B.2: production keeps the 15 s stall window. Only the e2e build, which
 * inlines the e2e fixture catalog, may stretch it (`PUBLIC_ATLAS_REQUEST_STALL_MS`), so a browser
 * test can hold a tier until it releases it. Any other build that sets it fails here.
 */
export function assertRequestStallOverride(
  catalogPath: string | undefined,
  override: string | undefined,
): void {
  if (override === undefined || override === '') return;
  if (catalogPath !== E2E_ATLAS_CATALOG_PATH)
    throw new Error(
      `PUBLIC_ATLAS_REQUEST_STALL_MS is only allowed in the e2e build (npm run build:e2e, ATLAS_CATALOG_PATH=${E2E_ATLAS_CATALOG_PATH}); production keeps the 15 s stall window (fast-load design §B.2).`,
    );
  if (!/^[1-9]\d*$/.test(override))
    throw new Error(
      `PUBLIC_ATLAS_REQUEST_STALL_MS must be a positive whole number of milliseconds, not ${JSON.stringify(override)}.`,
    );
}

/**
 * #453: e2e builds may enable test-only hooks (`src/atlas/e2e-hooks.ts`), such as holding the
 * reveal wave at a progress so a browser test samples a frame mid-wave. Like the stall override,
 * only the e2e build, which inlines the e2e fixture catalog, may set the flag; any other build
 * that sets it fails here.
 */
export function assertE2eHooks(
  catalogPath: string | undefined,
  flag: string | undefined,
): void {
  if (flag === undefined || flag === '') return;
  if (catalogPath !== E2E_ATLAS_CATALOG_PATH)
    throw new Error(
      `PUBLIC_ATLAS_E2E_HOOKS is only allowed in the e2e build (npm run build:e2e, ATLAS_CATALOG_PATH=${E2E_ATLAS_CATALOG_PATH}); production builds carry no test hooks (#453).`,
    );
  if (flag !== '1')
    throw new Error(
      `PUBLIC_ATLAS_E2E_HOOKS must be 1 when set, not ${JSON.stringify(flag)}.`,
    );
}
