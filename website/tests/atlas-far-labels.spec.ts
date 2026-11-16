/**
 * Country labels beyond the horizon end to end (Atlas design §11; terrain draping design, "Goals":
 * symbols and labels are never buried). Owner report, 2026-11-16: standing low in the Atlas
 * Mountains and looking north, the Country outlines layer drew Iceland, Greenland, Norway and Sweden over the
 * foreground ground, and Europe over the Ethiopian highlands on the smooth globe. A label skips
 * the depth test within up to 8,000 km of the camera, so that the ground near it never buries it;
 * near the ground the horizon is a few hundred kilometres off, and every label between the two was
 * drawn through the Earth.
 *
 * `window.__atlasCountryLabels` reports each label's text, whether it is shown, where Cesium draws
 * it and how far it is drawn. Which labels lie beyond the horizon is worked out here, from those
 * vectors and the WGS84 axes, not by the scene's own test. What each label draws is the share of
 * the pixels in its box that change when the labels alone are hidden; a box under the panel, the
 * legend or another label's box is not read. Desktop only: the phone runs the same scene.
 */

import { expect, test, type Page } from '@playwright/test';

import type { CountryLabel, CountryLabels } from '../src/atlas/e2e-hooks';
import {
  afterNextPaint,
  CHANGED_CHANNEL,
  drapeQuery,
  openDrape,
} from './atlas-terrain-helpers';

type Vector = [number, number, number];

/** WGS84's equatorial and polar radii, in metres. */
const WGS84_A = 6_378_137;
const WGS84_B = 6_356_752.314245179;

const dot = (u: Vector, v: Vector) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const distance = (u: Vector, v: Vector) =>
  Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);

/**
 * Whether the ellipsoid leaves `point` in sight of `camera`. In the space that scales the
 * ellipsoid to the unit sphere, the point is hidden when it lies past the plane of the camera's
 * horizon circle and inside the cone the camera sees the sphere in; from inside the sphere, when
 * it lies past the plane through the camera square to its position.
 */
function aboveHorizon(camera: Vector, point: Vector): boolean {
  const scaled = ([x, y, z]: Vector): Vector => [
    x / WGS84_A,
    y / WGS84_A,
    z / WGS84_B,
  ];
  const eye = scaled(camera);
  const target = scaled(point);
  const toTarget: Vector = [
    target[0] - eye[0],
    target[1] - eye[1],
    target[2] - eye[2],
  ];
  const limbSquared = dot(eye, eye) - 1;
  const along = -dot(toTarget, eye);
  if (limbSquared < 0) return along <= 0;
  return !(
    along > limbSquared &&
    (along * along) / dot(toTarget, toTarget) > limbSquared
  );
}

/** A country label's depth test is off within this distance of the camera (geographic-overlay.ts). */
const DEPTH_TEST_OFF_METRES = 8_000_000;

interface View {
  heading: number;
  height: number;
  lat: number;
  lon: number;
  pitch: number;
}

/** The owner's smooth-globe view: 45 km over the Ethiopian highlands, looking north. */
const ETHIOPIA: View = {
  heading: 0,
  height: 45_000,
  lat: 9,
  lon: 39.5,
  pitch: -20,
};
/** The owner's World Terrain view: 6 km over the Atlas Mountains, looking north. */
const MOROCCO: View = {
  heading: 0,
  height: 6_000,
  lat: 30.2,
  lon: -7.9,
  pitch: -6,
};

/**
 * The explorer at `view` on the smooth globe unless `extra` says otherwise, with HbS, the
 * inferred surface and the country outlines, and no measured points: their spheres would cover
 * labels.
 */
function labelQuery(view: View, extra: Record<string, string> = {}): string {
  return drapeQuery('nadir', 1, {
    heading: String(view.heading),
    height: String(view.height),
    lat: String(view.lat),
    layers: 'surface,support,context,countries',
    lon: String(view.lon),
    pitch: String(view.pitch),
    terrain: 'smooth-globe',
    ...extra,
  });
}

/** Opens `query` and waits for the country labels, and two frames more. */
async function openLabels(page: Page, query: string): Promise<CountryLabels> {
  await openDrape(page, query);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window.__atlasCountryLabels?.().labels.length ?? 0) > 0,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await afterNextPaint(page);
  await afterNextPaint(page);
  return countryLabels(page);
}

function countryLabels(page: Page): Promise<CountryLabels> {
  return page.evaluate(() => window.__atlasCountryLabels!());
}

/** The labels within their display distance, which Cesium draws while they are shown. */
const inRange = ({ camera, labels }: CountryLabels): CountryLabel[] =>
  labels.filter(({ far, position }) => distance(camera, position) <= far);

/** The shown labels within their display distance that lie beyond the horizon. */
function shownBeyondHorizon(state: CountryLabels): string[] {
  return inRange(state)
    .filter(
      ({ position, show }) => show && !aboveHorizon(state.camera, position),
    )
    .map(({ text }) => text);
}

/**
 * The labels drawn through the Earth: shown, beyond the horizon, and within both their display
 * distance and the distance the depth test is skipped in. Past that distance the globe's depth
 * hides a label behind it.
 */
function throughTheEarth(state: CountryLabels): string[] {
  return inRange(state)
    .filter(
      ({ position, show }) =>
        show &&
        distance(state.camera, position) <= DEPTH_TEST_OFF_METRES &&
        !aboveHorizon(state.camera, position),
    )
    .map(({ text }) => text);
}

/**
 * Waits for no label to be drawn through the Earth, or fails naming those that are; then holds
 * the horizon test's own rule, that no label beyond the horizon is shown at all.
 */
async function expectNoneThroughTheEarth(page: Page): Promise<CountryLabels> {
  await expect
    .poll(async () => throughTheEarth(await countryLabels(page)), {
      timeout: 10_000,
    })
    .toEqual([]);
  const state = await countryLabels(page);
  expect(shownBeyondHorizon(state)).toEqual([]);
  return state;
}

/** What one label draws: its share of changed pixels, and whether its whole box shows bare canvas. */
interface Drawn {
  share: number;
  /** The box lies on the canvas, with no panel, legend or other chrome over it. */
  bare: boolean;
}

async function canvasShot(
  page: Page,
  clip: { height: number; width: number; x: number; y: number },
): Promise<string> {
  return (await page.screenshot({ clip, scale: 'css' })).toString('base64');
}

/**
 * What each label in `labels` draws: the share of the pixels in its box that change when the
 * country labels alone are hidden, the borders kept. A label without a box (behind the camera)
 * reads as drawing nothing on bare canvas: false.
 */
async function labelPixels(
  page: Page,
  labels: CountryLabel[],
): Promise<Map<string, Drawn>> {
  // Two frames of a view still loading tiles differ beyond the labels.
  await expect
    .poll(
      () => page.evaluate(() => window.__atlasCountryLabels!().tilesLoaded),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  await afterNextPaint(page);
  const clip = await page.evaluate(() => {
    const { height, left, top, width } = document
      .querySelector('.atlas-scene canvas')!
      .getBoundingClientRect();
    return { height, width, x: left, y: top };
  });
  const drawn = await canvasShot(page, clip);
  await page.evaluate(() => window.__atlasDrawCountryLabels!(false));
  await afterNextPaint(page);
  await afterNextPaint(page);
  const bare = await canvasShot(page, clip);
  await page.evaluate(() => window.__atlasDrawCountryLabels!(true));
  await afterNextPaint(page);
  const results = await page.evaluate(
    async ({ bare, boxes, clip, drawn, threshold }) => {
      const pixels = async (base64: string): Promise<ImageData> => {
        const bytes = Uint8Array.from(atob(base64), (char) =>
          char.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: 'image/png' }),
          { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [withLabels, without] = await Promise.all([
        pixels(drawn),
        pixels(bare),
      ]);
      const onCanvas = (x: number, y: number) =>
        document
          .elementFromPoint(clip.x + x, clip.y + y)
          ?.matches('.atlas-scene canvas') ?? false;
      return boxes.map((box) => {
        if (!box) return { bare: false, share: 0 };
        const left = Math.max(0, Math.floor(box.x));
        const top = Math.max(0, Math.floor(box.y));
        const right = Math.min(withLabels.width, Math.ceil(box.x + box.width));
        const bottom = Math.min(
          withLabels.height,
          Math.ceil(box.y + box.height),
        );
        const inside =
          left === Math.floor(box.x) &&
          top === Math.floor(box.y) &&
          right === Math.ceil(box.x + box.width) &&
          bottom === Math.ceil(box.y + box.height) &&
          right > left &&
          bottom > top;
        if (!inside) return { bare: false, share: 0 };
        let changed = 0;
        for (let y = top; y < bottom; y += 1)
          for (let x = left; x < right; x += 1) {
            const offset = (y * withLabels.width + x) * 4;
            for (let channel = 0; channel < 4; channel += 1)
              if (
                Math.abs(
                  withLabels.data[offset + channel] -
                    without.data[offset + channel],
                ) > threshold
              ) {
                changed += 1;
                break;
              }
          }
        const inset = 2;
        const bareCanvas = [
          [(left + right) / 2, (top + bottom) / 2],
          [left + inset, top + inset],
          [right - inset, top + inset],
          [left + inset, bottom - inset],
          [right - inset, bottom - inset],
        ].every(([x, y]) => onCanvas(x, y));
        return {
          bare: bareCanvas,
          share: changed / ((right - left) * (bottom - top)),
        };
      });
    },
    {
      bare,
      boxes: labels.map(({ box }) => box),
      clip,
      drawn,
      threshold: CHANGED_CHANNEL,
    },
  );
  return new Map(labels.map(({ text }, index) => [text, results[index]]));
}

/** Two boxes meet, each grown by the labels' 5 px outline. */
function boxesMeet(a: CountryLabel['box'], b: CountryLabel['box']): boolean {
  if (!a || !b) return false;
  const grow = 5;
  return (
    a.x - grow < b.x + b.width + grow &&
    b.x - grow < a.x + a.width + grow &&
    a.y - grow < b.y + b.height + grow &&
    b.y - grow < a.y + a.height + grow
  );
}

/**
 * The labels beyond the horizon within their display distance whose boxes lie on bare canvas and
 * clear of every label in front: there, any changed pixel is drawn by the far label itself.
 */
function readableFarLabels(
  state: CountryLabels,
  drawn: Map<string, Drawn>,
): CountryLabel[] {
  const range = inRange(state);
  const front = range.filter(({ position }) =>
    aboveHorizon(state.camera, position),
  );
  return range.filter(
    (label) =>
      !aboveHorizon(state.camera, label.position) &&
      drawn.get(label.text)!.bare &&
      !front.some(({ box }) => boxesMeet(box, label.box)),
  );
}

test.describe('country labels beyond the horizon @desktop-chromium', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    // World Terrain stands in as the synthetic terrain; the smooth globe is the ellipsoid.
    await page.addInitScript(() => {
      window.__atlasSyntheticTerrain = true;
    });
  });

  test('none draws over the Ethiopian highlands from 45 km up; Eritrea, in front, still does', async ({
    page,
  }) => {
    await openLabels(page, labelQuery(ETHIOPIA));
    const state = await expectNoneThroughTheEarth(page);
    const eritrea = state.labels.find(({ text }) => text === 'Eritrea')!;
    expect(eritrea.show).toBe(true);
    expect(aboveHorizon(state.camera, eritrea.position)).toBe(true);

    const drawn = await labelPixels(page, state.labels);
    expect(drawn.get('Eritrea')!.share).toBeGreaterThan(0);
    const far = readableFarLabels(state, drawn);
    expect(far.length).toBeGreaterThan(0);
    expect(
      far
        .filter(({ text }) => drawn.get(text)!.share > 0)
        .map(({ text }) => text),
    ).toEqual([]);
  });

  test('none draws over the Atlas Mountains from 6 km up; Morocco stays shown', async ({
    page,
  }) => {
    await openLabels(page, labelQuery(MOROCCO));
    const state = await expectNoneThroughTheEarth(page);
    const morocco = state.labels.find(({ text }) => text === 'Morocco')!;
    expect(morocco.show).toBe(true);
    const drawn = await labelPixels(page, state.labels);
    expect(
      readableFarLabels(state, drawn)
        .filter(({ text }) => drawn.get(text)!.share > 0)
        .map(({ text }) => text),
    ).toEqual([]);
  });

  test('a see-through Earth shows every label, the far side’s through it', async ({
    page,
  }) => {
    const state = await openLabels(
      page,
      labelQuery(ETHIOPIA, { earthOpacity: '0.4' }),
    );
    expect(
      state.labels.filter(({ show }) => !show).map(({ text }) => text),
    ).toEqual([]);
    const drawn = await labelPixels(page, state.labels);
    expect(
      readableFarLabels(state, drawn).some(
        ({ text }) => drawn.get(text)!.share > 0,
      ),
    ).toBe(true);
  });

  test('from 5,000 km up, the front hemisphere’s labels are all shown, as before', async ({
    page,
  }) => {
    const state = await openLabels(
      page,
      labelQuery({ ...ETHIOPIA, height: 5_000_000, pitch: -90 }),
    );
    const range = inRange(state);
    // Above the ~3,700 km at which the horizon passes the depth test's reach: no label the depth
    // test skips lies beyond the horizon, so before the horizon test the same labels drew.
    expect(
      range
        .filter(
          ({ position }) =>
            distance(state.camera, position) <= DEPTH_TEST_OFF_METRES &&
            !aboveHorizon(state.camera, position),
        )
        .map(({ text }) => text),
    ).toEqual([]);
    expect(throughTheEarth(state)).toEqual([]);
    const front = range.filter(({ position }) =>
      aboveHorizon(state.camera, position),
    );
    expect(front.length).toBeGreaterThan(0);
    expect(front.filter(({ show }) => !show).map(({ text }) => text)).toEqual(
      [],
    );
  });

  test('from 3,000 km up, the front labels are shown and drawn', async ({
    page,
  }) => {
    const state = await openLabels(
      page,
      labelQuery({ ...ETHIOPIA, height: 3_000_000, pitch: -90 }),
    );
    const front = inRange(state).filter(({ position }) =>
      aboveHorizon(state.camera, position),
    );
    expect(front.map(({ text }) => text)).toContain('Ethiopia');
    expect(front.filter(({ show }) => !show).map(({ text }) => text)).toEqual(
      [],
    );
    const drawn = await labelPixels(page, front);
    expect(drawn.get('Ethiopia')).toMatchObject({ bare: true });
    expect(drawn.get('Ethiopia')!.share).toBeGreaterThan(0);
  });

  // The owner's path: the labels clamped 2,500 m above the ground (`RELATIVE_TO_GROUND`), each
  // read where Cesium clamped it. `openDrape` waits for the synthetic terrain to reach the globe.
  test('none draws through the Earth under World Terrain, the labels clamped to the ground', async ({
    page,
  }) => {
    await openLabels(
      page,
      labelQuery(MOROCCO, { relief: '1', terrain: 'world-terrain' }),
    );
    const state = await expectNoneThroughTheEarth(page);
    expect(state.labels.find(({ text }) => text === 'Morocco')!.show).toBe(
      true,
    );
  });

  test('the 2D map shows every label', async ({ page }) => {
    const state = await openLabels(page, labelQuery(ETHIOPIA, { view: 'map' }));
    expect(
      state.labels.filter(({ show }) => !show).map(({ text }) => text),
    ).toEqual([]);
  });
});
