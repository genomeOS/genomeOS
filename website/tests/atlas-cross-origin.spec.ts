/**
 * Cross-origin Atlas data (design 2026-10-07 §C.1.2, §C.3). The e2e build points
 * PUBLIC_ATLAS_DATA_BASE_URL at a second local origin (127.0.0.1:4323) that serves
 * the committed e2e tree with gzip and the bucket's CORS policy. Artifact objects
 * must come from that origin; Natural Earth borders, populated places and the
 * external caches must still come from the site, whose origin is the project's
 * baseURL (127.0.0.1:4322 unless PLAYWRIGHT_PORT moves it, #411).
 */
import { expect, test, type Page, type Request } from '@playwright/test';

import { resolveDataUrl } from '../src/lib/data-url';
import { installAtlasBrowserFixture } from './atlas-browser-fixture';

const DATA_BASE = 'http://127.0.0.1:4323/';
const OFFSETS = [
  [0, 0],
  [-18, 0],
  [18, 0],
  [0, -18],
  [0, 18],
  [-18, -18],
  [18, -18],
  [-18, 18],
  [18, 18],
] as const;

interface InlineCatalog {
  artifacts: {
    external_resources: { cache_url: string }[];
    id: string;
    observations_url: string | null;
    web: { grid_sha256: string; render: { url: string } };
  }[];
  context_sources: { id: string; url: string }[];
  grids: Record<string, { url: string }>;
}

/** The site origin the project serves `/app/` from. */
function siteOriginOf(baseURL: string | undefined): string {
  if (baseURL === undefined)
    throw new Error('The Playwright project sets no baseURL.');
  return new URL(baseURL).origin;
}

async function inlineJson<T>(page: Page, id: string): Promise<T> {
  const value: unknown = await page
    .locator(`#${id}`)
    .evaluate((element) => JSON.parse(element.textContent ?? 'null'));
  return value as T;
}

function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  return requests;
}

async function preloadHrefs(page: Page): Promise<string[]> {
  return page
    .locator('link[rel="preload"][as="fetch"]')
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLLinkElement).href),
    );
}

async function chooseAtlasMap(page: Page, id: string): Promise<void> {
  await page
    .getByRole('button', { name: /Select dataset\. Current dataset:/ })
    .click();
  await page.locator(`[role="option"][data-map-id="${id}"]`).click();
}

test.beforeEach(async ({ page }) => installAtlasBrowserFixture(page));
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// Origin routing does not depend on the viewport: the tag keeps these tests out of the mobile
// project at collection time, so `--shard` never hands them a slot there.
test.describe('cross-origin Atlas data', { tag: '@desktop-chromium' }, () => {
  test('artifact objects load cross-origin with gzip, CORS and matched preloads', async ({
    page,
    baseURL,
    isMobile,
  }) => {
    test.skip(isMobile, 'origin routing does not depend on the viewport');
    test.setTimeout(120_000);
    const siteOrigin = siteOriginOf(baseURL);
    const requests = recordRequests(page);
    await page.goto('/app/');
    await expect(page.locator('[data-atlas-ready="true"]')).toBeVisible({
      timeout: 45_000,
    });

    const bases = await inlineJson<{ artifact: string; site: string }>(
      page,
      'atlas-data-bases',
    );
    expect(bases).toEqual({ artifact: DATA_BASE, site: '/data/atlas/' });
    const catalog = await inlineJson<InlineCatalog>(page, 'atlas-catalog');
    const reference = catalog.artifacts[0]!;
    const critical = [
      catalog.grids[reference.web.grid_sha256]!.url,
      reference.web.render.url,
      reference.observations_url!,
    ].map((key) => resolveDataUrl(key, bases.artifact, page.url()));

    for (const url of critical) {
      const matching = requests.filter((request) => request.url() === url);
      expect(matching, `${url} fetched once (preload consumed)`).toHaveLength(
        1,
      );
      const response = await matching[0]!.response();
      expect(response?.status(), url).toBe(200);
      const headers = await response!.allHeaders();
      expect(headers['content-encoding'], url).toBe('gzip');
      expect(headers['access-control-allow-origin'], url).toBe(siteOrigin);
      expect(headers['cache-control'], url).toBe(
        'public, max-age=31536000, immutable',
      );
    }
    expect((await preloadHrefs(page)).sort()).toEqual([...critical].sort());
    await expect(
      page.locator(
        'link[rel="preload"][as="fetch"]:not([crossorigin="anonymous"])',
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(`link[rel="preconnect"][href^="http://127.0.0.1:4323"]`),
    ).toHaveCount(1);

    await expect(page.locator('[data-atlas-context-ready="true"]')).toHaveCount(
      1,
      { timeout: 45_000 },
    );
    const borders = catalog.context_sources.find(
      ({ id }) => id === 'natural-earth-admin-0',
    )!;
    const bordersUrl = `${siteOrigin}/data/atlas/${borders.url}`;
    const bordersRequest = requests.find(
      (request) => request.url() === bordersUrl,
    );
    expect(bordersRequest, bordersUrl).toBeDefined();
    expect((await bordersRequest!.response())?.status()).toBe(200);
    expect(
      requests
        .map((request) => request.url())
        .filter((url) => url.startsWith(DATA_BASE) && url.includes('ne-50m-')),
    ).toEqual([]);

    await chooseAtlasMap(page, 'g6pd-deficiency');
    const g6pd = catalog.artifacts.find(({ id }) => id === 'g6pd-deficiency')!;
    const g6pdRender = resolveDataUrl(
      g6pd.web.render.url,
      bases.artifact,
      page.url(),
    );
    await expect
      .poll(() => requests.some((request) => request.url() === g6pdRender), {
        timeout: 30_000,
      })
      .toBe(true);
  });

  test('a shared link preloads only the URL-selected artifact', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'origin routing does not depend on the viewport');
    await page.goto('/app/?entity=g6pd-deficiency');
    const bases = await inlineJson<{ artifact: string }>(
      page,
      'atlas-data-bases',
    );
    const catalog = await inlineJson<InlineCatalog>(page, 'atlas-catalog');
    const renderOf = (id: string): string =>
      resolveDataUrl(
        catalog.artifacts.find((artifact) => artifact.id === id)!.web.render
          .url,
        bases.artifact,
        page.url(),
      );
    const hrefs = await preloadHrefs(page);
    expect(hrefs).toContain(renderOf('g6pd-deficiency'));
    expect(hrefs).not.toContain(renderOf('hbs-rs334'));
  });

  test('populated places and external caches stay on the site origin', async ({
    page,
    baseURL,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      'coordinate-sensitive canvas picking is covered in the desktop project',
    );
    test.setTimeout(120_000);
    const siteOrigin = siteOriginOf(baseURL);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const query = new URLSearchParams({
      heading: '0',
      height: '1000000',
      lat: '40.4407',
      lon: '-3.7201',
      pitch: '-90',
    });
    await page.goto(`/app/?${query}`);
    await expect(page.locator('[data-atlas-ready="true"]')).toBeVisible({
      timeout: 45_000,
    });
    const catalog = await inlineJson<InlineCatalog>(page, 'atlas-catalog');
    const places = catalog.context_sources.find(
      ({ id }) => id === 'natural-earth-populated-places',
    )!;
    const placesResponse = page.waitForResponse(
      (response) => response.url().endsWith(`/data/atlas/${places.url}`),
      { timeout: 60_000 },
    );

    await page
      .getByRole('checkbox', { name: 'Inferred surface', exact: true })
      .uncheck();
    // Wait on state, not time: once the URL drops the surface layer, hovers can only land on
    // observations, whose preview is what fetches the populated places.
    await expect
      .poll(() => new URL(page.url()).searchParams.get('layers'))
      .not.toContain('surface');
    const canvas = page.locator('.atlas-scene canvas').first();
    const hoverPreview = page.locator('.atlas-hover-preview');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    for (const [x, y] of OFFSETS) {
      await page.mouse.move(
        box!.x + box!.width / 2 + x,
        box!.y + box!.height / 2 + y,
      );
      if (await hoverPreview.isVisible()) break;
    }
    await expect(hoverPreview).toBeVisible();
    const placesFetched = await placesResponse;
    expect(new URL(placesFetched.url()).origin).toBe(siteOrigin);
    expect(placesFetched.status()).toBe(200);

    const hbs = catalog.artifacts.find(({ id }) => id === 'hbs-rs334')!;
    const externalResponse = page.waitForResponse(
      (response) =>
        hbs.external_resources.some(({ cache_url }) =>
          response.url().endsWith(`/data/atlas/${cache_url}`),
        ),
      { timeout: 60_000 },
    );
    await page.getByRole('button', { name: 'More info' }).click();
    const externalPanel = page.getByRole('complementary', {
      name: 'External variant information',
    });
    await expect(externalPanel).toBeVisible();
    await externalPanel.getByRole('button', { name: 'gnomAD' }).click();
    await expect(externalPanel).toContainText('Allele frequency');
    const external = await externalResponse;
    expect(new URL(external.url()).origin).toBe(siteOrigin);
    expect(external.status()).toBe(200);
  });
});
