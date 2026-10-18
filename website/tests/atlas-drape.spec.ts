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
 * neither waits nor asks the worker for tiles; the smooth globe brings the chunks, data
 * elevation and extruded columns back; and Honmoon draws its contour lines into the draped surface
 * ("Build phases" item 4).
 *
 * The context and observations on the peak ("Per layer under World Terrain", "Exaggeration"): at
 * Physical relief 6 and then 10, a sphere standing on the ground above the summit is picked and
 * Spain's country label stays 2,500 m above the peak's flank; the sampling footprints and the
 * borders drape as their own imagery layers, in the draping design's order, a footprint ring
 * shows on the summit's ground, and every Atlas layer leaves with World Terrain. Desktop only:
 * the phone runs the same scene.
 */

import { expect, test, type Page } from '@playwright/test';
import { latLngToCell } from 'h3-js';

import { SYNTHETIC_PEAK } from '../src/atlas/e2e-hooks';
import {
  apexOnPage,
  cameraSettled,
  changedShare,
  clickAbove,
  drapeQuery,
  drapeSettled,
  openDrape,
  openTerrainChooser,
  pixelsAround,
  probe,
  summitOnGround,
  summitPatch,
  surfaceVisibleAtApex,
  windowOf,
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

/**
 * The Spain surveys' sampling footprints drape onto the summit too, and in the oblique view the
 * apex survey's 1.8 km ring crosses the summit patch: off, so the surface checks see the surface
 * alone and a probe lists only the surface.
 */
const NO_FOOTPRINTS = { samplingAreas: 'false' } as const;

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
        await openDrape(page, drapeQuery(view, relief, NO_FOOTPRINTS));
        expect(await surfaceVisibleAtApex(page)).toBe(true);
      });

  test('the summit check sees the surface on the smooth globe, where nothing buries it', async ({
    page,
  }) => {
    await openDrape(
      page,
      drapeQuery('nadir', 1, { ...NO_FOOTPRINTS, terrain: 'smooth-globe' }),
    );
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
      drapeQuery('nadir', 1, {
        ...NO_FOOTPRINTS,
        layers: 'surface,support,context',
      }),
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

  test('Honmoon draws its contours on the draped surface', async ({ page }) => {
    // The posterior SD: its 2/36 contour crosses the summit's cell. The fixture's posterior mean
    // stays between its first and second contours for 1,000 km round the apex, so its Honmoon
    // draws no line in the patch.
    const shot = async (geometry: string, metric = 'post_sd') => {
      await openDrape(
        page,
        drapeQuery('nadir', 1, {
          geometry,
          height: '400000',
          metric,
          palette: 'rainbow',
        }),
      );
      await drapeSettled(page);
      return summitPatch(page, await apexOnPage(page), 160);
    };
    const triangles = await shot('triangles');
    const honmoon = await shot('honmoon');
    expect(await changedShare(page, triangles, honmoon)).toBeGreaterThan(0.2);
    // Without contours both Honmoon patches are the same faint fill (a share of 0); with them, the
    // line and its halo cross the patch (about 0.23), where the mean's Honmoon leaves the ground.
    const noLine = await shot('honmoon', 'post_mean');
    expect(await changedShare(page, noLine, honmoon)).toBeGreaterThan(0.1);
  });
});

// Values pinned by unit tests (observation-symbols, line-raster).
const SYMBOL_CLEARANCE = 650 + 7_000;
const SPHERE_RADIUS = 12_000; // obsShape=sphere, obsSize=fixed, pointMin=pointMax=12 → 12 × 1,000 m
const RING = { lat: 40.454, lon: -3.7302, radiusKm: 12.6156626101008 }; // map-surveys:892, 4.3 km from the apex
const ORDER = [
  'atlas-surface',
  'atlas-outlines',
  'atlas-borders',
  'atlas-footprints',
];
const atlasLayers = (names: string[]) =>
  names.filter((name) => name.startsWith('atlas-'));
const ALL_LAYERS = 'surface,observations,support,context,countries';

/**
 * Clicks the sphere standing on the ground above the summit until the observation panel names
 * Spain (map-surveys:1135, :966 or :892, all within 5 km). The symbols re-sample their ground as
 * tiles load and after each relief frame, so a click made before they reach it is tried again.
 */
async function pickSummitSphere(page: Page): Promise<void> {
  const observation = page.getByRole('complementary', {
    name: 'Selected observation',
  });
  await expect(async () => {
    await clickAbove(page, SYMBOL_CLEARANCE + SPHERE_RADIUS);
    await expect(observation).toContainText('Spain', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(observation).toBeHidden();
}

/** Spain's label anchor is 42 km from the apex, on the peak's flank: 2,500 m above its ground. */
async function spainLabelClamped(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__atlasLabelClearance!('Spain')), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(2_499);
}

test.describe('context and observations on World Terrain @desktop-chromium', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => {
      window.__atlasSyntheticTerrain = true;
    });
  });

  // The end state of a relief change: the symbols and labels stand on the new ground. That they
  // re-sample only after the frame that applies the change (Review Focus 4) is pinned by unit tests
  // (atlas-scene-terrain, atlas-ground-heights): here tile loads re-sample them as well.
  test('symbols and labels stand above the summit at Physical relief 6, and follow it to 10', async ({
    page,
  }) => {
    // 120 km south of the apex, 160 km up, looking 42° down: the summit spheres and Spain's label
    // are in view, and the view stops short of the horizon, whose tiles keep CI's software WebGL
    // rendering for minutes. A sphere left on the relief-6 ground lies 24 km under the point
    // clicked at relief 10, about 20 km off the ray: missed.
    await openDrape(
      page,
      drapeQuery('oblique', 6, {
        height: '160000',
        lat: String(SYNTHETIC_PEAK.lat - 120 / 111.195),
        layers: ALL_LAYERS,
        obsShape: 'sphere',
        obsSize: 'fixed',
        pitch: '-42',
        pointMax: '12',
        pointMin: '12',
      }),
    );
    await expect.poll(async () => (await probe(page)).draped).toBe(true);
    await summitOnGround(page);
    // At 6× the 36 km summit buries today's spheres (centre 19.65 km); a grounded one is picked here.
    await pickSummitSphere(page);
    await spainLabelClamped(page);

    // The chooser opens from the Map controls.
    await page.locator('summary').filter({ hasText: /^Map$/ }).click();
    const chooser = await openTerrainChooser(page);
    await chooser.getByLabel('Physical relief ×').fill('10');
    await expect(page).toHaveURL(/relief=10(&|$)/);
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await probe(page)).verticalExaggeration)
      .toBe(10);
    // Fresh after the relief frame: the summit's tile now stands at 10 × its height.
    await summitOnGround(page);
    await pickSummitSphere(page); // the 60 km summit: the spheres followed it
    await spainLabelClamped(page);
  });

  test('sampling footprints and borders drape onto the summit, and leave with World Terrain', async ({
    page,
  }) => {
    // Straight down from 120 km at relief 6; the smallest circles (12 px), no surface, so the
    // 12.6 km ring's north point is clear.
    await openDrape(
      page,
      drapeQuery('nadir', 6, {
        height: '120000',
        layers: 'observations,context,countries',
        obsShape: 'circle',
        obsSize: 'fixed',
        pointMax: '12',
        pointMin: '12',
        samplingAreas: 'true',
        samplingColor: '#ff00ff',
      }),
    );
    await expect
      .poll(async () => atlasLayers((await probe(page)).imageryLayers), {
        timeout: 30_000,
      })
      .toEqual(expect.arrayContaining(['atlas-borders', 'atlas-footprints']));
    const names = atlasLayers((await probe(page)).imageryLayers);
    expect(names).toEqual(ORDER.filter((name) => names.includes(name)));
    await expect
      .poll(async () => (await probe(page)).tilesLoaded, { timeout: 30_000 })
      .toBe(true);
    // Today's rings sit 4 km above sea level, under the ~33 km ground there; the draped ring lies on it.
    const north = await windowOf(
      page,
      RING.lon,
      RING.lat + RING.radiusKm / 111.195,
      0,
    );
    expect(
      (await pixelsAround(page, north!, 2)).some(
        ([r, g, b]) => r >= 150 && b >= 150 && g <= 110,
      ),
    ).toBe(true);

    await page.locator('summary').filter({ hasText: /^Map$/ }).click();
    const chooser = await openTerrainChooser(page);
    await chooser.getByRole('radio', { name: 'Smooth Globe terrain' }).click();
    await expect
      .poll(async () => (await probe(page)).provider, { timeout: 30_000 })
      .toBe('ellipsoid');
    // No Atlas layer is left on the smooth globe, hidden or at alpha 0, nor the base guard.
    await expect
      .poll(async () => (await probe(page)).layerStack, { timeout: 30_000 })
      .toEqual(['basemap']);
  });
});
