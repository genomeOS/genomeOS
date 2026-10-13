/** Unit tests for the performance specs' production-build guard (fast-load design §B.1, §C.2). */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertProductionBuild } from './support/production-build';

const BASE_URL = 'http://127.0.0.1:4322';
const websiteRoot = path.resolve(import.meta.dirname, '..');

interface CatalogJson {
  grids: Record<string, unknown>;
  artifacts: {
    id: string;
    surface_url: string;
    observations_url: string | null;
    downloads: Record<string, { sha256: string; url: string } | null>;
    web: { render: { sha256: string; url: string } };
  }[];
}

const readCatalog = (relative: string): CatalogJson =>
  JSON.parse(
    readFileSync(path.join(websiteRoot, relative), 'utf8'),
  ) as CatalogJson;
const production = (): CatalogJson =>
  readCatalog('public/data/atlas/catalog.json');

function serve(catalog: unknown, status = 200): void {
  const json = JSON.stringify(catalog).replace(/</g, '\\u003c');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          `<!doctype html><script type="application/json" id="atlas-catalog">${json}</script>`,
          { status },
        ),
    ),
  );
}

/**
 * The catalog with its canonical JSON files back at Part B's flat keys (`<id>.<kind>.json`) and
 * every sha256 unchanged. The repository catalog has held the bucket keys since Part C (design
 * §C.1.3), so this is the variant whose keys differ from it.
 */
function withFlatDownloadKeys(catalog: CatalogJson): CatalogJson {
  for (const artifact of catalog.artifacts) {
    for (const [kind, entry] of Object.entries(artifact.downloads))
      if (entry !== null) entry.url = `${artifact.id}.${kind}.json`;
    artifact.surface_url = artifact.downloads.surface!.url;
    if (artifact.observations_url !== null)
      artifact.observations_url = artifact.downloads.observations!.url;
  }
  return catalog;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertProductionBuild', () => {
  it('accepts /app/ when it inlines the repository catalog', async () => {
    serve(production());
    await expect(assertProductionBuild(BASE_URL)).resolves.toEqual(
      production(),
    );
  });

  it('compares content, not the keys of the canonical JSON files (same sha256)', async () => {
    const moved = withFlatDownloadKeys(production());
    expect(moved.artifacts[0].surface_url).not.toBe(
      production().artifacts[0].surface_url,
    );
    serve(moved);
    await expect(assertProductionBuild(BASE_URL)).resolves.toEqual(moved);
  });

  it('rejects a subset catalog on the production grid', async () => {
    const subset = production();
    subset.artifacts = subset.artifacts.slice(0, 2);
    serve(subset);
    await expect(assertProductionBuild(BASE_URL)).rejects.toThrow(
      /does not inline public\/data\/atlas\/catalog\.json \(artifacts differ\)/,
    );
  });

  it('rejects a stale build whose render tier is not the repository one', async () => {
    const stale = production();
    stale.artifacts[1].web.render = {
      ...stale.artifacts[1].web.render,
      sha256: '0'.repeat(64),
      url: 'surfaces/g6pd-deficiency/v3/map-2026-08/render.0000000000000000.gosa',
    };
    serve(stale);
    await expect(assertProductionBuild(BASE_URL)).rejects.toThrow(
      /\(artifacts differ\)/,
    );
  });

  it('rejects a stale build with a different canonical JSON file', async () => {
    const stale = production();
    stale.artifacts[0].downloads.surface!.sha256 = '0'.repeat(64);
    serve(stale);
    await expect(assertProductionBuild(BASE_URL)).rejects.toThrow(
      /\(artifacts differ\)/,
    );
  });

  it('rejects the e2e build', async () => {
    serve(readCatalog('tests/fixtures/atlas/e2e/catalog.json'));
    await expect(assertProductionBuild(BASE_URL)).rejects.toThrow(
      /does not inline public\/data\/atlas\/catalog\.json \(.*grids.*\)\. Performance specs measure full data/,
    );
  });

  it('rejects a failed /app/ response', async () => {
    serve(production(), 404);
    await expect(assertProductionBuild(BASE_URL)).rejects.toThrow(
      'GET http://127.0.0.1:4322/app/ returned HTTP 404.',
    );
  });
});
