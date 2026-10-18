/**
 * Physical terrain end to end (Atlas design §11, interaction design §5.2; #483). World Terrain,
 * chosen through the basemap and terrain chooser, is shaded by the fixed hillshade light rather
 * than the sun and raised by Physical relief ×; the zoom-in button and key stop a kilometre above
 * it; and from the global view it is drawn unlit, with no night side.
 *
 * CI has no Cesium ion token, so the e2e build stands a synthetic cone in for World Terrain when a
 * test sets `window.__atlasSyntheticTerrain` (src/atlas/e2e-hooks.ts), and reports the scene
 * through `window.__atlasTerrainProbe`. Desktop only: the chooser and the camera buttons are the
 * same components on a phone, behind the bottom sheet.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  SYNTHETIC_CONE,
  type CameraMotion,
  type TerrainProbe,
} from '../src/atlas/e2e-hooks';

/** `ZOOM_FLOOR_METRES` (src/atlas/scene/camera.ts; its unit test pins the value). */
const ZOOM_FLOOR_METRES = 1_000;
/** 50 km due south of the apex, on the cone's straight flank: a third of the way down. */
const FLANK_KM = 50;
const FLANK_LAT = SYNTHETIC_CONE.lat - FLANK_KM / 111.195;
const FLANK_GROUND =
  SYNTHETIC_CONE.peakMetres * (1 - FLANK_KM / SYNTHETIC_CONE.radiusKm);
const RELIEF = 3;
const HIDDEN_DATA =
  'World Terrain can hide map data on high ground, and raised relief hides more.';

const START = new URLSearchParams({
  dayNight: 'false',
  heading: '0',
  height: '60000',
  lat: String(FLANK_LAT),
  lon: String(SYNTHETIC_CONE.lon),
  pitch: '-90',
}).toString();

async function probe(page: Page): Promise<TerrainProbe> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__atlasTerrainProbe))
    .toBe('function');
  return page.evaluate(() => window.__atlasTerrainProbe!());
}

/** The camera has finished the explorer's flight to the linked view. */
async function cameraSettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const read = (
            window as Window & { __atlasCameraMotion?: () => CameraMotion }
          ).__atlasCameraMotion;
          return read ? !read().flying && !read().moving : false;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Waits until the ground under the camera has loaded at `expected` metres (± 2%). */
async function groundLoaded(page: Page, expected: number): Promise<number> {
  await expect
    .poll(async () => (await probe(page)).groundHeight ?? 0, {
      timeout: 30_000,
    })
    .toBeGreaterThan(expected * 0.98);
  const { groundHeight } = await probe(page);
  expect(groundHeight!).toBeLessThan(expected * 1.02);
  return groundHeight!;
}

async function openTerrainChooser(page: Page) {
  await page
    .getByRole('button', { name: 'Choose basemap and terrain' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Basemap and terrain' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Opens the explorer at `query`, with the synthetic cone standing in for World Terrain. */
async function openExplorer(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => {
    window.__atlasSyntheticTerrain = true;
  });
  await page.goto(`/app/?${query}`);
  await expect(page.locator('[data-atlas-ready="true"]')).toBeVisible({
    timeout: 45_000,
  });
  await cameraSettled(page);
}

async function worldTerrainApplied(page: Page): Promise<void> {
  await expect
    .poll(async () => (await probe(page)).provider, { timeout: 30_000 })
    .toBe('synthetic');
}

// Three tests rather than one flow: under CI's software WebGL each page load and terrain switch
// costs tens of seconds, and one long flow overran a single test's budget.
test.describe('physical terrain @desktop-chromium', () => {
  test('World Terrain is hillshaded and raised by Physical relief ×, chosen in the chooser', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openExplorer(page, START);

    // The smooth globe keeps the sun, and day/night (off in this URL) decides its lighting.
    expect(await probe(page)).toMatchObject({
      enableLighting: false,
      provider: 'ellipsoid',
      sunLight: true,
      verticalExaggeration: 1,
    });

    await page.locator('summary').filter({ hasText: /^Map$/ }).click();
    const dayNight = page.getByRole('checkbox', {
      exact: true,
      name: 'Day/night lighting',
    });
    await expect(dayNight).toBeEnabled();
    let chooser = await openTerrainChooser(page);
    await expect(chooser.getByLabel('Physical relief ×')).toBeDisabled();
    await expect(chooser.getByText(HIDDEN_DATA)).toHaveCount(0);
    await chooser
      .getByRole('radio', { name: 'Cesium World Terrain terrain' })
      .click();
    await expect(page).toHaveURL(/terrain=world-terrain/);

    // World Terrain: lit by the fixed hillshade light, whatever day/night says.
    await worldTerrainApplied(page);
    expect(await probe(page)).toMatchObject({
      enableLighting: true,
      sunLight: false,
    });
    await expect(dayNight).toBeDisabled();
    await expect(
      page.getByText('a fixed light from the north-west shades the relief'),
    ).toBeVisible();
    await groundLoaded(page, FLANK_GROUND);

    chooser = await openTerrainChooser(page);
    const relief = chooser.getByLabel('Physical relief ×');
    await expect(relief).toBeEnabled();
    // At true scale too, World Terrain's high ground can hide the data, and the control says so.
    await expect(chooser.getByRole('status')).toHaveText(HIDDEN_DATA);
    await relief.fill(String(RELIEF));
    await expect(page).toHaveURL(new RegExp(`relief=${RELIEF}(&|$)`));
    await expect(chooser.getByRole('status')).toHaveText(HIDDEN_DATA);
    await expect
      .poll(async () => (await probe(page)).verticalExaggeration)
      .toBe(RELIEF);
    expect((await probe(page)).verticalExaggerationRelativeHeight).toBe(0);
    // The ground itself is raised, from sea level.
    await groundLoaded(page, FLANK_GROUND * RELIEF);

    // Back on the smooth globe (choosing a terrain closes the chooser): the sun, day/night and
    // true scale return.
    await chooser.getByRole('radio', { name: 'Smooth Globe terrain' }).click();
    await expect(chooser).toHaveCount(0);
    await expect
      .poll(async () => (await probe(page)).provider, { timeout: 30_000 })
      .toBe('ellipsoid');
    expect(await probe(page)).toMatchObject({
      enableLighting: false,
      sunLight: true,
      verticalExaggeration: 1,
    });
    await expect(dayNight).toBeEnabled();
  });

  test('the zoom-in button and + key stop a kilometre above raised World Terrain', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openExplorer(page, `${START}&terrain=world-terrain&relief=${RELIEF}`);
    await worldTerrainApplied(page);
    expect((await probe(page)).verticalExaggeration).toBe(RELIEF);
    const ground = await groundLoaded(page, FLANK_GROUND * RELIEF);

    // From 60 km a step is 50 km, which went 2 km underground before #483.
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    for (let step = 0; step < 4; step++) {
      await zoomIn.click();
      const { cameraHeight, groundHeight } = await probe(page);
      expect(cameraHeight - (groundHeight ?? ground)).toBeGreaterThanOrEqual(
        ZOOM_FLOOR_METRES - 1,
      );
    }
    // At the floor, within the ground's refinement as finer tiles load (< 50 m).
    expect((await probe(page)).cameraHeight).toBeCloseTo(
      ground + ZOOM_FLOOR_METRES,
      -2,
    );

    // The + key stops at the same floor.
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.locator('.atlas-scene').focus();
    for (let step = 0; step < 6; step++) await page.keyboard.press('+');
    const { cameraHeight, groundHeight } = await probe(page);
    expect(cameraHeight - (groundHeight ?? ground)).toBeGreaterThanOrEqual(
      ZOOM_FLOOR_METRES - 1,
    );
  });

  test('World Terrain seen from the global view is unlit, with no night side', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // The default view: the hillshade has faded out, and the sun still has no say (#483 review).
    await openExplorer(page, 'terrain=world-terrain');
    await worldTerrainApplied(page);
    const far = await probe(page);
    expect(far.cameraHeight).toBeGreaterThan(3_000_000);
    expect(far).toMatchObject({ enableLighting: false, sunLight: false });
  });

  test('the Keys help says how to tilt, inside the controls panel', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto('/app/');
    await expect(page.locator('[data-atlas-ready="true"]')).toBeVisible({
      timeout: 45_000,
    });
    await page.getByText('Keys', { exact: true }).click();
    const help = page.locator('.atlas-keyboard-help p');
    await expect(help).toContainText('Q/E to look up or down');
    await expect(help).toContainText('Ctrl+drag');
    const [box, panel] = await Promise.all([
      help.boundingBox(),
      page.locator('aside.atlas-controls').boundingBox(),
    ]);
    // Not clipped by the panel's edge.
    expect(box!.x).toBeGreaterThanOrEqual(panel!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
  });
});
