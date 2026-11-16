/**
 * Hover without a GPU pick (Atlas design §11; owner decision 2026-11-14 on #483). A mouse over the
 * globe resolves what lies under it on the CPU; only a click runs Cesium's drill pick. A GPU pick
 * reads its pick framebuffer back (`readPixels`, which waits for the GPU) and, the first time,
 * links the pick variants of the programs it draws: on a cold shader cache that first hover held
 * a frame for about 650 ms on Metal, and each later hover still waited 8–26 ms at production
 * density (42–224 ms on SwiftShader).
 *
 * The counts below hold on any renderer, so CI's software renderer asserts them: between a
 * pointer move over the globe and two frames later, the page makes no `readPixels` and no
 * `linkProgram` call, on the page's first hover and on a later one.
 *
 * A hover and a click at the same point resolve the same thing, read from the e2e build's pick
 * log (`window.__atlasPickLog`): on each marker shape, inside it and a few pixels past its drawn
 * edge, on a sampling ring and inside it; on the draped summit's ground and the sphere above it;
 * and on the tops of lifted, extruded columns seen obliquely, which the hover finds along the
 * pointer's ray and the click from the depth it read back. Desktop only: a phone has no hover.
 */

import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { expect, test, type Page } from '@playwright/test';

import { SYNTHETIC_PEAK, type AtlasPickLogEntry } from '../src/atlas/e2e-hooks';
import { heightFor } from '../src/atlas/visual-encoding';
import {
  countGlCalls,
  glCallsSince,
  glLinksSince,
  glQuiet,
} from './atlas-gl-helpers';
import {
  besideGlobeCentre,
  globeViewCentre,
  renderTierOf,
} from './atlas-globe-helpers';
import {
  INSPECTOR_CAMERA,
  waitForAtlasReady,
  waitForAtlasSettled,
  waitForRevealWave,
} from './atlas-mobile-helpers';
import {
  afterNextPaint,
  cameraSettled,
  drapeQuery,
  drapeSettled,
  openDrape,
  probe,
  summitOnGround,
  windowOf,
  type Point,
} from './atlas-terrain-helpers';

/** Opens 1,000 km over Madrid, looking down, and waits until the page stops linking and reading. */
async function openSettled(page: Page): Promise<void> {
  await page.goto(`/app/?${INSPECTOR_CAMERA}`);
  await waitForAtlasReady(page);
  await waitForRevealWave(page);
  // The cell edges, the borders and the exact values load after `ready`, linking programs.
  await waitForAtlasSettled(page);
  await cameraSettled(page);
  await glQuiet(page);
}

/**
 * Moves the mouse to `at`, and counts the GPU calls from the move to two frames later, with the
 * programs it linked.
 */
async function hoverCounts(page: Page, at: Point) {
  const since = await page.evaluate(() => performance.now());
  await page.mouse.move(at.x, at.y);
  await afterNextPaint(page);
  return {
    counts: await glCallsSince(page, since),
    linked: await glLinksSince(page, since),
  };
}

/**
 * Opens `query` with the synthetic terrain's placement readers, settled; under reduced motion, so
 * data elevation stands at its factor at once.
 */
async function openPlaced(page: Page, query: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/app/?${query}`);
  await waitForAtlasReady(page);
  await waitForRevealWave(page);
  await cameraSettled(page);
  await probe(page);
}

/**
 * What the scene resolved for a hover at `at`, then for a click there, from the pick log; the
 * inspector the click opened is closed again, so the next point is bare canvas.
 */
async function hoverThenClick(
  page: Page,
  at: Point,
): Promise<{
  click: AtlasPickLogEntry['pick'];
  hover: AtlasPickLogEntry['pick'];
}> {
  const since = await page.evaluate(() => performance.now());
  await page.mouse.move(at.x, at.y);
  await afterNextPaint(page);
  await page.mouse.click(at.x, at.y);
  let entries: AtlasPickLogEntry[] = [];
  await expect
    .poll(async () => {
      entries = await page.evaluate(
        (since) =>
          (window.__atlasPickLog ?? []).filter((entry) => entry.at >= since),
        since,
      );
      return entries.some((entry) => entry.source === 'click');
    })
    .toBe(true);
  const click = entries.find((entry) => entry.source === 'click')!;
  const hovers = entries.filter(
    (entry) => entry.source === 'hover' && entry.at <= click.at,
  );
  expect(hovers.length, `a hover at ${at.x}, ${at.y}`).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.atlas-inspector')).toBeHidden();
  return { click: click.pick, hover: hovers.at(-1)!.pick };
}

/** A point `metres` above the ground at (`lon`, `lat`), moved (`dx`, `dy`) CSS px on the page. */
interface Place {
  lon: number;
  lat: number;
  metres: number;
  dx?: number;
  dy?: number;
}

const moved = (place: Place, dx: number, dy: number): Place => ({
  ...place,
  dx: (place.dx ?? 0) + dx,
  dy: (place.dy ?? 0) + dy,
});

/**
 * At each place, located on the page just before its hover, a hover and a click agree; returns
 * what they resolved, by kind (null for nothing). Each point and its result go to the log.
 */
async function agreeAt(page: Page, places: Record<string, Place>) {
  await stillOnPage(page, Object.values(places)[0]);
  const kinds: Record<string, string | null> = {};
  for (const [name, place] of Object.entries(places)) {
    const drawn = await windowOf(page, place.lon, place.lat, place.metres);
    expect(drawn, `${name} is on screen`).not.toBeNull();
    const at = offset(drawn!, place.dx ?? 0, place.dy ?? 0);
    const { click, hover } = await hoverThenClick(page, at);
    console.log(
      `hover and click at ${name} (${at.x.toFixed(1)}, ${at.y.toFixed(1)}): ${JSON.stringify(hover)}`,
    );
    expect(hover, name).toEqual(click);
    kinds[name] = hover?.kind ?? null;
  }
  return kinds;
}

/**
 * Waits until `place` stays put on the page for half a second. After the camera settles, a
 * place can still move on the page for a second or so as the view's layout settles, and a hover
 * and a click made across such a move are made at different points of the scene.
 */
async function stillOnPage(page: Page, place: Place): Promise<void> {
  let last: Point | null = null;
  await expect
    .poll(
      async () => {
        const at = await windowOf(page, place.lon, place.lat, place.metres);
        const still =
          at !== null &&
          last !== null &&
          Math.hypot(at.x - last.x, at.y - last.y) < 0.1;
        last = at;
        return still;
      },
      { intervals: [500], message: 'the view is still', timeout: 30_000 },
    )
    .toBe(true);
}

function offset(at: Point, dx: number, dy: number): Point {
  return { x: at.x + dx, y: at.y + dy };
}

/** map-surveys:1179 (Riyadh): its nearest neighbour lies 400 km away, its ring 12.6 km out. */
const LONE = { lat: 24.7132, lon: 46.6214, ringKm: 12.6 };
/** Markers of 24 px, or spheres of 24 km: `obsSize=fixed` takes the middle of 24–24. */
const SIZE = 24;
/** The anchor of a marker: 650 m of clearance and 7,000 m of symbol clearance. */
const SYMBOL_CLEARANCE = 650 + 7_000;
const RING_CLEARANCE = 4_000;
/** Kilometres per degree of latitude. */
const KM_PER_DEGREE = 111.195;

/** Straight down on the lone survey from 200 km, every marker 24 px or 24 km. */
function loneQuery(shape: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    heading: '0',
    height: '200000',
    lat: String(LONE.lat),
    lon: String(LONE.lon),
    obsShape: shape,
    obsSize: 'fixed',
    pitch: '-90',
    pointMax: String(SIZE),
    pointMin: String(SIZE),
    ...extra,
  }).toString();
}

test.describe('hover without a GPU pick @desktop-chromium', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await countGlCalls(page);
    await page.addInitScript(() => {
      window.__atlasSyntheticTerrain = true;
    });
  });

  test('a hover over the globe reads no pixels back and links no program', async ({
    page,
  }) => {
    await openSettled(page);
    const preview = page.locator('.atlas-hover-preview');
    // Madrid's surveys stand at the camera target; 60 px west lies an HbS cell.
    const first = await hoverCounts(page, await globeViewCentre(page));
    expect(
      first.counts,
      `the first hover linked ${first.linked.join('; ')}`,
    ).toEqual({
      linkProgram: 0,
      readPixels: 0,
    });
    // The hover resolved: its preview shows what lies under the pointer.
    await expect(preview).toContainText('Measured observation');
    const later = await hoverCounts(page, await besideGlobeCentre(page));
    expect(
      later.counts,
      `a later hover linked ${later.linked.join('; ')}`,
    ).toEqual({
      linkProgram: 0,
      readPixels: 0,
    });
    await expect(preview).toContainText('Modeled estimate');
  });

  test('a hover and a click agree on a circle, a stud and their sampling ring', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    for (const shape of ['circle', 'hemisphere'] as const) {
      await openPlaced(page, loneQuery(shape));
      const anchor: Place = { ...LONE, metres: SYMBOL_CLEARANCE };
      const ring: Place = {
        lat: LONE.lat + LONE.ringKm / KM_PER_DEGREE,
        lon: LONE.lon,
        metres: RING_CLEARANCE,
      };
      // A circle's 24 px disc and 2 px outline about its anchor; a stud's 24 × 17 px image on it.
      const points: Record<string, Place> =
        shape === 'circle'
          ? {
              'on the circle': anchor,
              'inside its edge': moved(anchor, 10, 0),
              'past its edge': moved(anchor, 20, 0),
            }
          : {
              'on the stud': moved(anchor, 0, -8),
              'beside it': moved(anchor, 17, -8),
              'below it': moved(anchor, 0, 6),
              // Inside its image's rectangle, where the dome leaves the image transparent.
              'over its shoulder': moved(anchor, -10, -15),
            };
      expect(
        await agreeAt(page, {
          ...points,
          'on the ring': ring,
          'past the ring': moved(ring, 0, -7),
        }),
        shape,
      ).toMatchObject({
        'on the ring': 'observation',
        'past the ring': null,
        ...(shape === 'circle'
          ? {
              'inside its edge': 'observation',
              'on the circle': 'observation',
              'past its edge': null,
            }
          : {
              'below it': null,
              'beside it': null,
              'on the stud': 'observation',
              'over its shoulder': null,
            }),
      });
    }
  });

  test('a hover and a click agree on a sphere and an upright pin', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openPlaced(page, loneQuery('sphere'));
    const radius = SIZE * 1_000;
    const centre: Place = { ...LONE, metres: SYMBOL_CLEARANCE + radius };
    // East of its centre at its height, a share of its radius out: from 168 km away its silhouette
    // lies within 2 px of one radius.
    const east = (share: number): Place => ({
      ...centre,
      lon:
        LONE.lon +
        (share * radius) /
          1_000 /
          (KM_PER_DEGREE * Math.cos((LONE.lat * Math.PI) / 180)),
    });
    expect(
      await agreeAt(page, {
        'on the sphere': centre,
        'inside its edge': east(0.9),
        'past its edge': east(1.15),
      }),
    ).toEqual({
      'inside its edge': 'observation',
      'on the sphere': 'observation',
      'past its edge': null,
    });

    // From the south, 45° down: the pin stands up the screen on its anchor. No sampling ring,
    // which passes beside the pin's head here.
    await openPlaced(
      page,
      loneQuery('pin', {
        lat: String(LONE.lat - 200 / KM_PER_DEGREE),
        pitch: '-45',
        samplingAreas: 'false',
      }),
    );
    const anchor: Place = { ...LONE, metres: SYMBOL_CLEARANCE };
    // A 24 × 35 px pin above its anchor: a head 18 px across, 21 px up, on a tapering stem.
    expect(
      await agreeAt(page, {
        'on the pin': moved(anchor, 0, -17),
        'on its head': moved(anchor, 6, -21),
        // Inside its image's rectangle, beside the head, where the image is transparent.
        'beside its head': moved(anchor, 13, -21),
        'below it': moved(anchor, 0, 7),
      }),
    ).toEqual({
      'below it': null,
      'beside its head': null,
      'on its head': 'observation',
      'on the pin': 'observation',
    });
  });

  test('a hover and a click agree on a marker seen through a see-through Earth', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // 15,000 km over the lone survey's antipode, looking down: the survey stands behind the Earth.
    // Seen through it below opacity 1, a click picks it (or a marker beside it); an opaque Earth
    // hides them all, and the ocean before them holds no cell.
    const throughEarth: Place = { ...LONE, metres: SYMBOL_CLEARANCE };
    const kinds: Record<string, string | null> = {};
    for (const earthOpacity of ['0.2', '1']) {
      await openPlaced(
        page,
        loneQuery('circle', {
          earthOpacity,
          height: '15000000',
          lat: String(-LONE.lat),
          lon: String(LONE.lon - 180),
        }),
      );
      const agreed = await agreeAt(page, {
        [`at Earth opacity ${earthOpacity}`]: throughEarth,
      });
      Object.assign(kinds, agreed);
    }
    expect(kinds).toEqual({
      'at Earth opacity 0.2': 'observation',
      'at Earth opacity 1': null,
    });
  });

  test('a hover and a click agree on the draped summit and the sphere above it', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openDrape(
      page,
      drapeQuery('oblique', 6, {
        height: '160000',
        lat: String(SYNTHETIC_PEAK.lat - 120 / KM_PER_DEGREE),
        layers: 'surface,observations,support,context,countries',
        obsShape: 'sphere',
        obsSize: 'fixed',
        pitch: '-42',
        pointMax: '12',
        pointMin: '12',
      }),
    );
    await expect.poll(async () => (await probe(page)).draped).toBe(true);
    await summitOnGround(page);
    await drapeSettled(page);
    expect(
      await agreeAt(page, {
        'the sphere above the summit': {
          lat: SYNTHETIC_PEAK.lat,
          lon: SYNTHETIC_PEAK.lon,
          metres: SYMBOL_CLEARANCE + 12_000,
        },
        // 20 km south of the summit, on its flank: below the spheres on screen, inside the grid.
        'the summit’s flank': {
          lat: SYNTHETIC_PEAK.lat - 20 / KM_PER_DEGREE,
          lon: SYNTHETIC_PEAK.lon,
          metres: 0,
        },
      }),
    ).toEqual({
      'the sphere above the summit': 'observation',
      'the summit’s flank': 'surface',
    });
  });

  test('a hover and a click agree on lifted, extruded columns seen obliquely', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const madrid = latLngToCell(40.4407, -3.7201, 4);
    const exaggeration = 3;
    // From 900 km south of Madrid, 1,000 km up, looking 40° down: the walls of the columns show.
    await openPlaced(
      page,
      new URLSearchParams({
        elevation: 'true',
        exaggeration: String(exaggeration),
        geometry: 'extruded',
        heading: '0',
        height: '1000000',
        lat: String(40.4407 - 900 / KM_PER_DEGREE),
        layers: 'surface,support',
        lon: '-3.7201',
        pitch: '-40',
        // No sampling rings: a ring that passes a top's centre wins over the cell.
        samplingAreas: 'false',
      }).toString(),
    );
    const { cells, domain } = renderTierOf('hbs-rs334');
    const points: Record<string, Place> = {};
    for (const cell of gridDisk(madrid, 1)) {
      const value = cells.get(cell);
      if (!value) continue;
      const [lat, lon] = cellToLatLng(cell);
      // The top's centre: the 650 m clearance, the 1 m extrusion, then the column.
      const metres =
        650 +
        1 +
        heightFor(value.support, value.postMean, domain, exaggeration);
      if (await windowOf(page, lon, lat, metres))
        points[cell] = { lat, lon, metres };
    }
    expect(Object.keys(points).length, 'columns in view').toBeGreaterThan(3);
    const kinds = await agreeAt(page, points);
    expect(Object.values(kinds)).toContain('surface');
  });
});
