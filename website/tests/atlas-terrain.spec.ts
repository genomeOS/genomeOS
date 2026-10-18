/**
 * Physical terrain end to end (Atlas design §11, interaction design §5.2; #483). World Terrain,
 * chosen through the basemap and terrain chooser, is shaded by the fixed hillshade light rather
 * than the sun, raised by Relief ×, and the zoom-in button and key stop a kilometre above it.
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

test.describe('physical terrain @desktop-chromium', () => {
  test('World Terrain is hillshaded, raised by Relief × and floors the zoom', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => {
      window.__atlasSyntheticTerrain = true;
    });
    await page.goto(`/app/?${START}`);
    await expect(page.locator('[data-atlas-ready="true"]')).toBeVisible({
      timeout: 45_000,
    });
    await cameraSettled(page);

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
    await expect(chooser.getByLabel('Relief ×')).toBeDisabled();
    await chooser
      .getByRole('radio', { name: 'Cesium World Terrain terrain' })
      .click();
    await expect(page).toHaveURL(/terrain=world-terrain/);

    // World Terrain: lit by the fixed hillshade light, whatever day/night says.
    await expect
      .poll(async () => (await probe(page)).provider, { timeout: 30_000 })
      .toBe('synthetic');
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
    const relief = chooser.getByLabel('Relief ×');
    await expect(relief).toBeEnabled();
    await relief.fill(String(RELIEF));
    await expect(page).toHaveURL(new RegExp(`relief=${RELIEF}(&|$)`));
    await expect(
      chooser.getByText('Raised relief can hide map data on high ground.'),
    ).toBeVisible();
    await expect
      .poll(async () => (await probe(page)).verticalExaggeration)
      .toBe(RELIEF);
    expect((await probe(page)).verticalExaggerationRelativeHeight).toBe(0);
    await page.keyboard.press('Escape');
    await expect(chooser).toHaveCount(0);
    // The ground itself is raised, from sea level.
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

    // From the global view the hillshade has faded out: World Terrain is drawn unlit, with no
    // night side, and still not by the sun (#483 review).
    await page.getByRole('button', { name: 'Home' }).click();
    await cameraSettled(page);
    expect(await probe(page)).toMatchObject({
      enableLighting: false,
      provider: 'synthetic',
      sunLight: false,
    });
    expect((await probe(page)).cameraHeight).toBeGreaterThan(3_000_000);

    // Back on the smooth globe: the sun, day/night and true scale return.
    chooser = await openTerrainChooser(page);
    await chooser.getByRole('radio', { name: 'Smooth Globe terrain' }).click();
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
