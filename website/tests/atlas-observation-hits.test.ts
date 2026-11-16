/**
 * The CPU hit test of a hover over the displayed observations (Atlas design §11; owner decision
 * 2026-11-14 on #483): each marker as drawn, from its projected position and its drawn size, the
 * pick window's slack around it, nothing the globe hides, and the nearest of several. The scene's
 * own view (`createHitView`) reads the click's pick window and what the globe hides: the horizon
 * and the rendered ground, neither on a see-through Earth.
 */
import { cellToLatLng } from 'h3-js';
import {
  Cartesian2,
  Cartesian3,
  Color,
  EllipsoidTerrainProvider,
  Matrix4,
  Ray,
  SceneMode,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObservationArtifact } from '../src/atlas/contracts';
import {
  createHitView,
  type HitView,
} from '../src/atlas/scene/observation-hits';
import {
  buildObservationLayer,
  observationPickId,
  type ObservationLayerOptions,
} from '../src/atlas/scene/observation-layer';
import {
  SPHERE_METRES_PER_SIZE_UNIT,
  STUD_ASPECT_RATIO,
} from '../src/atlas/scene/observation-symbols';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';
import { nadirView as nadirAt } from './helpers/nadir-view';

const KEY = 'fixture-artifact:v3:map-2026-08';
const [LAT, LON] = cellToLatLng('83754efffffffff');
/** The fixed size of every marker: the middle of [12, 32]. */
const SIZE = 22;
/** Metres per CSS px of the nadir view below. */
const MPP = 1_000;
const CENTRE = new Cartesian2(400, 300);

function observation(id: string, lat: number, lon: number, radiusKm = 12) {
  return {
    ac: 25,
    an: 100,
    assay: 'genotype',
    citation_text: 'Example publication.',
    cohort_id: 'map-study-1',
    disease_ascertainment_excluded: true,
    ingest_version: 'map-2026-08',
    lat,
    lon,
    population_label: 'Example population',
    radius_km: radiusKm,
    sampling_design: 'population_random',
    source_locator: `MAP survey ${id}`,
    source_record_id: `map-surveys:${id}`,
    source_url: 'https://example.org/source',
    study_id: 'map-study-1',
    study_label: 'Example study',
  };
}

function artifact(
  ...observations: ReturnType<typeof observation>[]
): ObservationArtifact {
  return { artifact: {}, observations } as unknown as ObservationArtifact;
}

function layer(
  observations: ObservationArtifact,
  overrides: Partial<ObservationLayerOptions> = {},
) {
  stubCesiumBrowserImageTypes();
  return buildObservationLayer(observations, {
    artifactKey: KEY,
    colorVariable: 'solid',
    elevation: false,
    exaggeration: 1,
    gradient: ['#24144b', '#ad8bff', '#f4c86a'],
    heights: null,
    opacity: 1,
    samplingAreaColor: '#9af9e2',
    samplingAreas: false,
    shape: 'circle',
    sizeRange: [12, 32],
    sizeVariable: 'fixed',
    solidColor: '#f4fbff',
    ...overrides,
  });
}

/** Straight down on (LAT, LON), drawn at `CENTRE`, 1 km per CSS px. */
function nadirView(overrides: Partial<HitView> = {}): HitView {
  return nadirAt(LAT, LON, MPP, CENTRE, overrides);
}

/** `CENTRE` moved by (`dx`, `dy`) CSS px. */
function at(dx: number, dy = 0): Cartesian2 {
  return new Cartesian2(CENTRE.x + dx, CENTRE.y + dy);
}

const ONE = artifact(observation('1', LAT, LON));
const PICK = observationPickId('map-surveys:1', KEY);

afterEach(() => vi.unstubAllGlobals());

describe('the hover’s observation hit test (#483)', () => {
  it('hits a circle out to its drawn radius, its outline and the pick window, and no further', () => {
    const group = layer(ONE);
    const view = nadirView();
    // The point's 22 px disc, its 2 px outline, its 1.5 px anti-aliasing pad, then the pick
    // window's 1 px.
    const reach = SIZE / 2 + 2 + 1.5 + 1;
    expect(group.observationAt(view, at(0))).toEqual(PICK);
    expect(group.observationAt(view, at(reach - 0.01))).toEqual(PICK);
    expect(group.observationAt(view, at(0, -(reach - 0.01)))).toEqual(PICK);
    expect(group.observationAt(view, at(reach + 0.01))).toBeNull();
    expect(group.observationAt(view, at(0, reach + 0.01))).toBeNull();
  });

  it('hits a sphere where the pointer’s ray meets it, plus the pick window', () => {
    const group = layer(ONE, { shape: 'sphere' });
    const view = nadirView();
    // 22 km of radius at 1 km per px, and the window's 1 px.
    const reach = (SIZE * SPHERE_METRES_PER_SIZE_UNIT) / MPP + 1;
    expect(group.observationAt(view, at(0))).toEqual(PICK);
    expect(group.observationAt(view, at(reach - 0.01))).toEqual(PICK);
    expect(group.observationAt(view, at(reach + 0.01))).toBeNull();
  });

  it('draws a sphere only on the globe: none in Columbus view or 2D', () => {
    const group = layer(ONE, { shape: 'sphere' });
    for (const mode of [SceneMode.COLUMBUS_VIEW, SceneMode.SCENE2D])
      expect(group.observationAt(nadirView({ mode }), at(0))).toBeNull();
  });

  it('hits a stud above its anchor, where its image stands, not below it', () => {
    const group = layer(ONE, { shape: 'hemisphere' });
    const view = nadirView();
    const height = SIZE * STUD_ASPECT_RATIO;
    // Bottom-anchored: the image spans from the anchor up `height` px.
    expect(group.observationAt(view, at(0, -height / 2))).toEqual(PICK);
    expect(group.observationAt(view, at(0, -(height + 1) + 0.01))).toEqual(
      PICK,
    );
    expect(group.observationAt(view, at(0, -(height + 1) - 0.01))).toBeNull();
    expect(group.observationAt(view, at(0, 2))).toBeNull();
    expect(
      group.observationAt(view, at(SIZE / 2 + 1 - 0.01, -height / 2)),
    ).toEqual(PICK);
    expect(
      group.observationAt(view, at(SIZE / 2 + 1 + 0.01, -height / 2)),
    ).toBeNull();
  });

  it('turns a pin about its centre with the surface normal, as Cesium’s aligned axis does', () => {
    const group = layer(ONE, { shape: 'pin' });
    // Seen with the normal pointing right on screen, the pin lies on its side: Cesium turns it a
    // quarter turn about its centre, which stays half its height above the anchor.
    const view = nadirView({ eyeDirection: () => ({ x: 1, y: 0 }) });
    const height = SIZE * 1.45;
    const centre = -height / 2;
    expect(group.observationAt(view, at(height / 2 - 0.5, centre))).toEqual(
      PICK,
    );
    expect(
      group.observationAt(view, at(0, centre - SIZE / 2 - 1.5)),
    ).toBeNull();
    // Upright, the same point lies inside it.
    expect(
      layer(ONE, { shape: 'pin' }).observationAt(
        nadirView({ eyeDirection: () => ({ x: 0, y: 1 }) }),
        at(0, centre - SIZE / 2 - 1.5),
      ),
    ).toEqual(PICK);
  });

  it('reads a pin’s own pixels, turned with it: an image’s transparent part is not hit', () => {
    // Only the left half of the image opaque.
    const group = layer(ONE, { shape: 'pin' });
    const canvas = globalThis.HTMLCanvasElement.prototype as unknown as {
      getContext(kind: string): Record<string, unknown>;
    };
    const getContext = canvas.getContext;
    canvas.getContext = function (this: unknown, kind: string) {
      return {
        ...getContext.call(this, kind),
        getImageData: (
          _x: number,
          _y: number,
          width: number,
          height: number,
        ) => {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row += 1)
            for (let column = 0; column < width / 2; column += 1)
              data[(row * width + column) * 4 + 3] = 255;
          return { data };
        },
      };
    };
    const centre = -(SIZE * 1.45) / 2;
    // Upright, the left half is the screen's left.
    const upright = nadirView({ eyeDirection: () => ({ x: 0, y: 1 }) });
    expect(group.observationAt(upright, at(-5, centre))).toEqual(PICK);
    expect(group.observationAt(upright, at(5, centre))).toBeNull();
    // Turned a quarter with its axis to the right, the image's left lies up the screen.
    const turned = nadirView({ eyeDirection: () => ({ x: 1, y: 0 }) });
    expect(group.observationAt(turned, at(0, centre - 5))).toEqual(PICK);
    expect(group.observationAt(turned, at(0, centre + 5))).toBeNull();
  });

  it('skips a marker behind the horizon', () => {
    for (const shape of ['circle', 'sphere', 'pin', 'hemisphere'] as const) {
      const group = layer(ONE, { shape });
      expect(
        group.observationAt(nadirView({ visible: () => false }), at(0, -5)),
        shape,
      ).toBeNull();
    }
  });

  it('finds nothing while the symbols, or the whole group, are hidden', () => {
    const group = layer(ONE);
    group.setVisibility(false, false);
    expect(group.observationAt(nadirView(), at(0))).toBeNull();
    group.setVisibility(true, false);
    group.collection.show = false;
    expect(group.observationAt(nadirView(), at(0))).toBeNull();
  });

  it('hits a sampling ring along its drawn line, and only while the rings show', () => {
    const group = layer(ONE, { samplingAreas: true });
    group.setVisibility(false, true);
    const view = nadirView();
    // 12 km of radius at 1 km per px; the ring is drawn 2 px wide, which the shader widens by
    // half a pixel, and the pick window reaches 1 px past it.
    expect(group.observationAt(view, at(12))).toEqual(PICK);
    expect(group.observationAt(view, at(0, -12))).toEqual(PICK);
    expect(group.observationAt(view, at(12 + 1.25 + 1 - 0.1))).toEqual(PICK);
    expect(group.observationAt(view, at(6))).toBeNull();
    expect(group.observationAt(view, at(12 + 1.25 + 1 + 0.2))).toBeNull();
    group.setVisibility(false, false);
    expect(group.observationAt(view, at(12))).toBeNull();
  });

  it('takes the marker under the pointer over one the pick window only grazes, then the nearest', () => {
    const view = nadirView();
    const east = view.toWindow(Cartesian3.fromDegrees(LON + 0.2, LAT))!.x;
    const reach = SIZE / 2 + 2 + 1.5 + 1;
    // Two circles about 22 px apart: the pointer is inside the second and in the first's window.
    const apart = layer(
      artifact(observation('1', LAT, LON), observation('2', LAT, LON + 0.2)),
    );
    const pointer = at(reach - 0.5);
    expect(east - pointer.x).toBeLessThan(SIZE / 2 + 2 + 1.5);
    expect(apart.observationAt(view, pointer)).toEqual(
      observationPickId('map-surveys:2', KEY),
    );
    // Two circles 4 px apart, both under the pointer: the one nearer the camera.
    const stacked = layer(
      artifact(observation('1', LAT, LON), observation('2', LAT, LON + 0.05)),
    );
    const eastward = (point: Cartesian3) => view.toWindow(point)!.x;
    expect(
      stacked.observationAt(
        nadirView({ depth: (point) => eastward(point) }),
        at(2),
      ),
    ).toEqual(PICK);
    expect(
      stacked.observationAt(
        nadirView({ depth: (point) => -eastward(point) }),
        at(2),
      ),
    ).toEqual(observationPickId('map-surveys:2', KEY));
  });
});

/**
 * The scene `createHitView` reads: a camera 10,000 km over (LAT, LON), an 800 × 600 px canvas at
 * `pixelRatio`, the Earth's opacity as `applyEarthOpacity` sets it, and World Terrain's rendered
 * ground (`ground`, where `globe.pick` meets it) or the smooth globe.
 */
function hitScene({
  ground = null,
  opacity = 1,
  pixelRatio = 1,
}: {
  ground?: ((ray: Ray) => Cartesian3 | undefined) | null;
  opacity?: number;
  pixelRatio?: number;
} = {}) {
  const pick = vi.fn((ray: Ray) => ground?.(ray));
  return {
    pick,
    scene: {
      camera: { positionWC: Cartesian3.fromDegrees(LON, LAT, 10_000_000) },
      canvas: { clientHeight: 600, clientWidth: 800 },
      context: { uniformState: { view3D: Matrix4.IDENTITY } },
      drawingBufferHeight: 600 * pixelRatio,
      drawingBufferWidth: 800 * pixelRatio,
      globe: {
        baseColor: Color.fromCssColorString('#071b35'),
        pick,
        terrainProvider: ground ? {} : new EllipsoidTerrainProvider(),
        translucency: {
          backFaceAlpha: opacity,
          enabled: opacity < 1,
          frontFaceAlpha: opacity,
        },
      },
      mode: SceneMode.SCENE3D,
      pixelRatio,
    },
  };
}

function viewOf(scene: ReturnType<typeof hitScene>['scene']): HitView {
  return createHitView(scene as never);
}

describe('the scene’s view for a hover (#483)', () => {
  const near = Cartesian3.fromDegrees(LON, LAT, 7_650);
  const farSide = Cartesian3.fromDegrees(LON + 180, -LAT, 7_650);

  it('hides a marker behind the horizon of an opaque Earth, and none through a see-through one', () => {
    const opaque = viewOf(hitScene().scene);
    expect(opaque.visible(near)).toBe(true);
    expect(opaque.visible(farSide)).toBe(false);
    // Earth opacity under 1: Cesium culls nothing behind the horizon (Scene.js `getOccluder`) and
    // the globe writes no depth, so a click picks the far side's markers through it.
    const seeThrough = viewOf(hitScene({ opacity: 0.2 }).scene);
    expect(seeThrough.visible(near)).toBe(true);
    expect(seeThrough.visible(farSide)).toBe(true);
  });

  it('hides a marker the rendered ground stands in front of, under World Terrain only', () => {
    const camera = Cartesian3.fromDegrees(LON, LAT, 10_000_000);
    /** The ground `share` of the way from the camera to the marker. */
    const groundAt = (share: number) => () =>
      Cartesian3.lerp(camera, near, share, new Cartesian3());
    const before = hitScene({ ground: groundAt(0.99) });
    expect(viewOf(before.scene).visible(near)).toBe(false);
    expect(before.pick).toHaveBeenCalledOnce();
    // The ray from the camera toward the marker, which the ground is tested along.
    const [ray] = before.pick.mock.calls[0];
    expect(Cartesian3.equalsEpsilon(ray.origin, camera, 1e-6)).toBe(true);
    expect(
      Cartesian3.equalsEpsilon(
        ray.direction,
        Cartesian3.normalize(
          Cartesian3.subtract(near, camera, new Cartesian3()),
          new Cartesian3(),
        ),
        1e-9,
      ),
    ).toBe(true);
    expect(
      viewOf(hitScene({ ground: groundAt(1.01) }).scene).visible(near),
    ).toBe(true);
    expect(
      viewOf(hitScene({ ground: () => undefined }).scene).visible(near),
    ).toBe(true);
    // A see-through Earth's ground hides nothing either.
    const seeThrough = hitScene({ ground: groundAt(0.99), opacity: 0.2 });
    expect(viewOf(seeThrough.scene).visible(near)).toBe(true);
    // The smooth globe has no ground to stand in front: it is never asked.
    const smooth = hitScene();
    expect(viewOf(smooth.scene).visible(near)).toBe(true);
    expect(smooth.pick).not.toHaveBeenCalled();
  });

  it('tests the nine drawing-buffer pixels a click reads, the pointer’s first', () => {
    // At 2 drawing-buffer px per CSS px, the pointer lies in the pixel whose centre is
    // (100.25, 200.75) CSS px; its neighbours' centres lie half a CSS px on.
    const window = viewOf(hitScene({ pixelRatio: 2 }).scene).pickWindow(
      new Cartesian2(100.3, 200.7),
    );
    expect(window[0]).toEqual(new Cartesian2(100.25, 200.75));
    const xs = [99.75, 100.25, 100.75];
    const ys = [200.25, 200.75, 201.25];
    expect(window.map(({ x, y }) => `${x},${y}`).sort()).toEqual(
      xs.flatMap((x) => ys.map((y) => `${x},${y}`)).sort(),
    );
  });
});
