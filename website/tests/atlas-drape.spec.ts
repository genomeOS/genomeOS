/**
 * The Atlas data on physical terrain end to end (Atlas design §11; terrain draping design, "Test
 * plan"; #483). CI has no Cesium ion token, so the e2e build stands a synthetic terrain in for
 * World Terrain (src/atlas/e2e-hooks.ts): here, its 6 km Gaussian peak, σ 40 km, under the HbS
 * Spain survey, where the e2e grid supports every res-4 cell within 2σ of the apex.
 *
 * The #483 repro: the summit must show the inferred surface, seen at nadir and obliquely, at
 * relief 1 and 3. Until the data is draped onto the ground (phase 2) the surface floats at a fixed
 * 650 m, the summit buries it, and the repro is held under `test.fail`. The pick and lighting
 * tests take the same path through `openDrape`, `probe` and `apexOnPage`, so a broken harness
 * fails them rather than hiding under that marker. Desktop only: the phone runs the same scene.
 */

import { expect, test } from '@playwright/test';
import { latLngToCell } from 'h3-js';

import { SYNTHETIC_PEAK } from '../src/atlas/e2e-hooks';
import {
  apexOnPage,
  drapeQuery,
  openDrape,
  probe,
  surfaceVisibleAtApex,
} from './atlas-terrain-helpers';

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
        test.fail(
          true,
          'Phase 1: the surface sits at 650 m, so the 6 km summit buries it; Task 17 drapes it (#483).',
        );
        await openDrape(page, drapeQuery(view, relief));
        expect(await surfaceVisibleAtApex(page)).toBe(true);
      });

  test("an oblique pick at the summit names the summit's cell, not the ground behind it", async ({
    page,
  }) => {
    await openDrape(page, drapeQuery('oblique', 3));
    expect(await probe(page)).toMatchObject({ verticalExaggeration: 3 });
    const apex = await apexOnPage(page);
    await page.mouse.click(apex.x, apex.y);
    const inspector = page.getByRole('complementary', {
      name: 'Selected map cell',
    });
    // 84390cbffffffff; the ellipsoid on the same ray lies about 50 km on, in 84392b5ffffffff.
    await expect(inspector).toContainText(
      latLngToCell(SYNTHETIC_PEAK.lat, SYNTHETIC_PEAK.lon, 4),
    );
    await expect(inspector).not.toContainText('84392b5ffffffff');
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
});
