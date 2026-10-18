/**
 * The Atlas data on physical terrain end to end (Atlas design §11; terrain draping design, "Test
 * plan"; #483). CI has no Cesium ion token, so the e2e build stands a synthetic terrain in for
 * World Terrain (src/atlas/e2e-hooks.ts): here, its 6 km Gaussian peak, σ 40 km, under the HbS
 * Spain survey, where the e2e grid supports every res-4 cell within 2σ of the apex.
 *
 * The #483 repro: the summit must show the inferred surface, seen at nadir and obliquely, at
 * relief 1 and 3. Draped onto the ground as the `atlas-surface` imagery layer, the surface follows
 * the summit up, where at a fixed 650 m it was buried. A control runs the repro's own check on the
 * smooth globe, where nothing buries the surface, so the check is shown not to be blind. The pick
 * and lighting tests take the same path through `openDrape`, `probe` and `apexOnPage`.
 *
 * The draped surface's behaviour ("How existing features behave", "2D and Columbus"): a cold load
 * that asks for World Terrain drapes without building chunks first; the data stays visible and
 * pickable after each morph; a palette restyle swaps the draped layer, and the outlines toggle
 * neither waits nor asks the worker for tiles; and the smooth globe brings the chunks, data
 * elevation and extruded columns back. Desktop only: the phone runs the same scene.
 */

import { expect, test, type Page } from '@playwright/test';
import { latLngToCell } from 'h3-js';

import { SYNTHETIC_PEAK } from '../src/atlas/e2e-hooks';
import {
  apexOnPage,
  cameraSettled,
  changedShare,
  drapeQuery,
  openDrape,
  openTerrainChooser,
  probe,
  summitPatch,
  surfaceVisibleAtApex,
} from './atlas-terrain-helpers';

/** `performance` marks of surface chunks the page added: none while the data is draped. */
function chunkAdds(page: Page): Promise<number> {
  return page.evaluate(
    () => performance.getEntriesByName('atlas:chunk-add').length,
  );
}

/**
 * How many `atlas-surface` layers the probe lists: drawn (two while a restyle cross-fades), or on
 * the globe at all, hidden or at alpha 0.
 */
async function surfaceLayers(
  page: Page,
  list: 'imageryLayers' | 'layerStack' = 'imageryLayers',
): Promise<number> {
  return (await probe(page))[list].filter((name) => name === 'atlas-surface')
    .length;
}

/**
 * The drape stats' tile requests once they have settled: every tile in view loaded, none queued,
 * and no new request over a second. An outline layer reads as shown from its add, before the
 * globe has rendered the frames that ask for its tiles, so `tilesLoaded` alone can be stale.
 */
async function settledRequests(page: Page): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() =>
          window.__atlasTerrainProbe!().tilesLoaded &&
          window.__atlasDrapeStats!().queueDepth === 0
            ? window.__atlasDrapeStats!().requested
            : -1,
        );
        const settled = now >= 0 && now === last;
        last = now;
        return settled;
      },
      { intervals: [1_000], timeout: 60_000 },
    )
    .toBe(true);
  return last;
}

test.describe('terrain draping @desktop-chromium', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => {
      window.__atlasSyntheticTerrain = true;
    });
  });

  for (const view of ['nadir', 'oblique'] as const)
    for (const relief of [1, 3])
      test(`#483 repro: the summit shows the surface (${view}, relief ${relief})`, async ({
        page,
      }) => {
        await openDrape(page, drapeQuery(view, relief));
        expect(await surfaceVisibleAtApex(page)).toBe(true);
      });

  test('the summit check sees the surface on the smooth globe, where nothing buries it', async ({
    page,
  }) => {
    await openDrape(page, drapeQuery('nadir', 1, { terrain: 'smooth-globe' }));
    expect(await surfaceVisibleAtApex(page)).toBe(true);
  });

  test("an oblique click at the summit selects the summit's own cell", async ({
    page,
  }) => {
    await openDrape(page, drapeQuery('oblique', 3));
    expect(await probe(page)).toMatchObject({ verticalExaggeration: 3 });
    const apex = await apexOnPage(page);
    await page.mouse.click(apex.x, apex.y);
    const inspector = page.getByRole('complementary', {
      name: 'Selected map cell',
    });
    // 84390cbffffffff, found on the rendered ground. Before the data was draped, the pick started
    // from a surface chunk in the drill pick, and the summit hid every chunk there.
    await expect(inspector).toContainText(
      latLngToCell(SYNTHETIC_PEAK.lat, SYNTHETIC_PEAK.lon, 4),
    );
  });

  test('World Terrain sets the hillshade terms, and drops atmosphere and water while the surface shows', async ({
    page,
  }) => {
    await openDrape(page, drapeQuery('nadir', 1));
    await expect
      .poll(() => probe(page))
      .toMatchObject({
        enableLighting: true,
        lambertDiffuseMultiplier: 0.9,
        showGroundAtmosphere: false,
        showWaterEffect: false,
        sunLight: false,
        vertexShadowDarkness: 0.45,
      });
    for (const name of ['Inferred surface', 'Evidence support'])
      await page.getByRole('checkbox', { exact: true, name }).uncheck();
    await expect
      .poll(() => probe(page))
      .toMatchObject({ showGroundAtmosphere: true, showWaterEffect: true });
    await page
      .getByRole('checkbox', { exact: true, name: 'Evidence support' })
      .check();
    await expect
      .poll(() => probe(page))
      .toMatchObject({ showGroundAtmosphere: false, showWaterEffect: false });
  });

  test('a cold load with terrain=world-terrain drapes without building chunks first', async ({
    page,
  }) => {
    // Context on, so the basemap is shown and the probe sees the surface above it.
    await openDrape(
      page,
      drapeQuery('nadir', 1, { layers: 'surface,support,context' }),
    );
    expect(await probe(page)).toMatchObject({
      draped: true,
      imageryLayers: ['basemap', 'atlas-surface'],
      provider: 'synthetic',
    });
    expect(await chunkAdds(page)).toBe(0);
  });

  test('the draped surface stays visible and pickable after each morph', async ({
    page,
  }) => {
    // Cesium's animated morphs to the map and to Perspective frame the whole globe from above
    // (0°, 0°) (SceneTransitioner.js), where the summit is a pixel; an instant morph keeps the
    // camera over its own ground point. So the camera stands over the summit, and reduced motion
    // makes each morph instant.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDrape(page, drapeQuery('nadir', 1));
    await page.locator('summary').filter({ hasText: /^Map$/ }).click();
    for (const view of ['Map', 'Perspective', 'Globe']) {
      await page.getByRole('radio', { name: view }).check();
      await cameraSettled(page);
      await expect
        .poll(() => surfaceVisibleAtApex(page), { timeout: 30_000 })
        .toBe(true);
      const apex = await apexOnPage(page);
      await page.mouse.click(apex.x, apex.y);
      const inspector = page.getByRole('complementary', {
        name: 'Selected map cell',
      });
      await expect(
        inspector
          .locator('dt', { hasText: 'Cell ID' })
          .locator('..')
          .locator('dd'),
      ).toHaveText(latLngToCell(SYNTHETIC_PEAK.lat, SYNTHETIC_PEAK.lon, 4));
      // Closed again, so the next view's pick is its own.
      await page.getByRole('button', { name: 'Close inspector' }).click();
      await expect(inspector).toHaveCount(0);
    }
  });

  test('a palette restyle swaps the draped layer, and the outlines toggle is instant', async ({
    page,
  }) => {
    await openDrape(page, drapeQuery('nadir', 1));
    const before = await summitPatch(page, await apexOnPage(page));
    await page
      .locator('summary')
      .filter({ hasText: /^Inferred surface$/ })
      .click();
    await page
      .getByLabel('Surface palette', { exact: true })
      .selectOption('viridis');
    // The new palette shows at the summit, and the layer it cross-faded over is retired.
    await expect
      .poll(
        async () =>
          changedShare(
            page,
            before,
            await summitPatch(page, await apexOnPage(page)),
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(0.5);
    await expect.poll(() => surfaceLayers(page), { timeout: 30_000 }).toBe(1);
    // Retired, not hidden: a hidden layer keeps no tiles, so nothing keeps it.
    expect(await surfaceLayers(page, 'layerStack')).toBe(1);

    const outlines = page.getByRole('checkbox', {
      exact: true,
      name: 'Cell outlines',
    });
    await outlines.check();
    await expect
      .poll(async () => (await probe(page)).imageryLayers, { timeout: 30_000 })
      .toContain('atlas-outlines');
    const requested = await settledRequests(page);
    // Instant: the toggle only changes the layer's alpha, so it asks the worker for no tile. Under
    // CI's software WebGL one frame can take a second, so the toggle's own frame gets 10 s.
    await outlines.uncheck();
    await expect
      .poll(async () => (await probe(page)).imageryLayers, { timeout: 10_000 })
      .not.toContain('atlas-outlines');
    await outlines.check();
    await expect
      .poll(async () => (await probe(page)).imageryLayers, { timeout: 10_000 })
      .toContain('atlas-outlines');
    expect(
      await page.evaluate(() => window.__atlasDrapeStats!().requested),
    ).toBe(requested);
  });

  test('returning to the smooth globe restores chunks, data elevation and extruded columns', async ({
    page,
  }) => {
    await openDrape(
      page,
      drapeQuery('nadir', 1, {
        elevation: 'true',
        exaggeration: '2',
        geometry: 'extruded',
        // Context on, so the basemap is what the smooth globe keeps.
        layers: 'surface,support,context',
      }),
    );
    await page
      .locator('summary')
      .filter({ hasText: /^Inferred surface$/ })
      .click();
    await expect(
      page.getByText('Not available with World Terrain'),
    ).toBeVisible();
    await expect(
      page.locator('#atlas-surface-geometry option[value="extruded"]'),
    ).toHaveText('Columns (smooth globe only)');
    await expect(page.locator('#atlas-statistical-elevation')).toBeDisabled();
    await expect(page).toHaveURL(/elevation=true/);
    await page.locator('summary').filter({ hasText: /^Map$/ }).click();
    const chooser = await openTerrainChooser(page);
    await chooser.getByRole('radio', { name: 'Smooth Globe terrain' }).click();
    await expect
      .poll(async () => (await probe(page)).imageryLayers, { timeout: 30_000 })
      .toEqual(['basemap']);
    // No Atlas layer is left on the smooth globe, hidden or at alpha 0, nor the base guard.
    expect((await probe(page)).layerStack).toEqual(['basemap']);
    await expect.poll(() => chunkAdds(page)).toBeGreaterThan(0);
    await expect(page.locator('#atlas-statistical-elevation')).toBeEnabled();
    await expect(
      page.locator('#atlas-surface-geometry option[value="extruded"]'),
    ).toHaveText('Extruded hexagons');
  });
});
