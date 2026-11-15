/**
 * Hover without a GPU pick (Atlas design §11; owner decision 2026-11-14 on #483): the hover
 * resolves on the CPU, and only a click runs the drill pick. The cell comes from the ellipsoid on
 * the smooth globe and from the rendered ground under World Terrain, kept where a layer draws it
 * and the wave has reached it; an observation of the displayed artifact under the pointer wins.
 * At the same point, a hover and a click resolve the same thing.
 */
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import {
  Cartesian2,
  Cartesian3,
  Ellipsoid,
  GeographicProjection,
  Math as CesiumMath,
  Ray,
  SceneMode,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObservationArtifact } from '../src/atlas/contracts';
import { createHoverResolver } from '../src/atlas/scene/hover-pick';
import type { HitView } from '../src/atlas/scene/observation-hits';
import {
  buildObservationLayer,
  observationPickId,
  type ObservationPick,
} from '../src/atlas/scene/observation-layer';
import { surfaceChunkPickId } from '../src/atlas/scene/surface-chunk-layer';
import {
  createSurfacePickResolver,
  type PickTarget,
  type SurfacePickContext,
} from '../src/atlas/scene/surface-pick';
import { SURFACE_CLEARANCE_METRES } from '../src/atlas/scene/surface-appearance';
import { rowForH3 } from '../src/atlas/surface-columns';
import { heightFor } from '../src/atlas/visual-encoding';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';
import { columnarSurface } from './helpers/columnar-surface';
import { nadirView, type NadirView } from './helpers/nadir-view';

const CELL = '84390cbffffffff';
const [LAT, LON] = cellToLatLng(CELL);
const NEAR = gridDisk(CELL, 1).filter((cell) => cell !== CELL);
const surface = columnarSurface(
  [CELL, ...NEAR].map((h3) => ({
    h3,
    post_mean: 0.5,
    post_sd: 0.1,
    support: 'observed' as const,
  })),
);
const KEY = surface.artifactKey;
const CENTRE = new Cartesian2(400, 300);
/** 1 km per CSS px: a res-4 cell, about 45 km across, spans about 45 px. */
const MPP = 1_000;
const OBSERVATION = observationPickId('map-surveys:1', KEY);
const PICKED = {
  artifactKey: KEY,
  h3Index: CELL,
  kind: 'surface' as const,
  row: rowForH3(surface, CELL),
};

/** The hover's scene: the ground under the pointer from the nadir view, and spies on every GPU pick. */
function fakeScene(view: NadirView, mode = SceneMode.SCENE3D) {
  return {
    camera: {
      getPickRay: vi.fn((position: Cartesian2) => view.pickRay(position)),
      pickEllipsoid: vi.fn(
        (position: Cartesian2) =>
          view.groundAt(position) as Cartesian3 | undefined,
      ),
    },
    drillPick: vi.fn(),
    globe: {
      pick: vi.fn(
        (ray: Ray, _scene: unknown) =>
          Cartesian3.add(
            ray.origin,
            Cartesian3.multiplyByScalar(ray.direction, 1e6, new Cartesian3()),
            new Cartesian3(),
          ) as Cartesian3 | undefined,
      ),
    },
    mapProjection: new GeographicProjection(),
    mode,
    pick: vi.fn(),
    pickPosition: vi.fn(),
    pickTranslucentDepth: false,
  };
}

function target(overrides: Partial<PickTarget> = {}): PickTarget {
  return {
    artifactKey: KEY,
    draped: false,
    drawn: () => true,
    hidden: [],
    observations: null,
    surface,
    ...overrides,
  };
}

function context(
  overrides: Partial<SurfacePickContext> = {},
  pickTarget: PickTarget | null = target(),
): SurfacePickContext {
  return {
    draped: () => false,
    factor: () => 0,
    geometry: () => 'triangles',
    metric: () => 'post_mean',
    target: () => pickTarget,
    ...overrides,
  };
}

/** One circle of the displayed artifact, 10 km east of the cell's centre. */
function observations(): ObservationArtifact {
  return {
    artifact: {},
    observations: [
      {
        ac: 25,
        an: 100,
        assay: 'genotype',
        citation_text: 'Example publication.',
        cohort_id: 'map-study-1',
        disease_ascertainment_excluded: true,
        ingest_version: 'map-2026-08',
        lat: LAT,
        lon: LON + 0.118,
        population_label: 'Example population',
        radius_km: 2,
        sampling_design: 'population_random',
        source_locator: 'MAP survey 1',
        source_record_id: 'map-surveys:1',
        source_url: 'https://example.org/source',
        study_id: 'map-study-1',
        study_label: 'Example study',
      },
    ],
  } as unknown as ObservationArtifact;
}

function circles() {
  stubCesiumBrowserImageTypes();
  return buildObservationLayer(observations(), {
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
  });
}

function hover(
  scene: ReturnType<typeof fakeScene>,
  pickContext: SurfacePickContext,
  view: HitView,
) {
  return createHoverResolver(scene as never, pickContext, () => view);
}

afterEach(() => vi.unstubAllGlobals());

describe('the hover resolves on the CPU (#483)', () => {
  it('takes the smooth globe’s cell from the ellipsoid, and makes no GPU pick', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    const scene = fakeScene(view);
    expect(hover(scene, context(), view)(CENTRE)).toEqual(PICKED);
    expect(scene.camera.pickEllipsoid).toHaveBeenCalledWith(
      CENTRE,
      Ellipsoid.WGS84,
    );
    expect(scene.globe.pick).not.toHaveBeenCalled();
    for (const gpu of [scene.drillPick, scene.pick, scene.pickPosition])
      expect(gpu).not.toHaveBeenCalled();
  });

  it('takes World Terrain’s cell from the rendered ground, not the ellipsoid', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    for (const pickContext of [
      context({ draped: () => true }),
      context({}, target({ draped: true })),
    ]) {
      const scene = fakeScene(view);
      expect(hover(scene, pickContext, view)(CENTRE)).toEqual(PICKED);
      expect(scene.globe.pick).toHaveBeenCalledTimes(1);
      expect(scene.camera.pickEllipsoid).not.toHaveBeenCalled();
      for (const gpu of [scene.drillPick, scene.pick, scene.pickPosition])
        expect(gpu).not.toHaveBeenCalled();
    }
  });

  it('keeps a cell only where a layer draws it and the wave has reached it', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    expect(
      hover(
        fakeScene(view),
        context({}, target({ drawn: () => false })),
        view,
      )(CENTRE),
    ).toBeNull();
    expect(
      hover(fakeScene(view), context({ reveal: () => 0 }), view)(CENTRE),
    ).toBeNull();
    // Off the grid, and off the globe.
    const off = nadirView(LAT + 3, LON, MPP, CENTRE);
    expect(hover(fakeScene(off), context(), off)(CENTRE)).toBeNull();
    const space = fakeScene(view);
    space.camera.pickEllipsoid.mockReturnValue(undefined);
    expect(hover(space, context(), view)(CENTRE)).toBeNull();
  });

  it('under World Terrain keeps a chunk’s cell only where the wave has reached it; a draped group has no wave', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    // Chunks on World Terrain's ground while the data lies flat still grow with the wave.
    const unreached = context({ draped: () => true, reveal: () => 0 });
    expect(hover(fakeScene(view), unreached, view)(CENTRE)).toBeNull();
    expect(
      hover(
        fakeScene(view),
        context({ draped: () => true, reveal: () => 1 }),
        view,
      )(CENTRE),
    ).toEqual(PICKED);
    // A draped group fades in on the wave's timeline instead (`drawn`); its cells have no wave.
    expect(
      hover(
        fakeScene(view),
        context({ reveal: () => 0 }, target({ draped: true })),
        view,
      )(CENTRE),
    ).toEqual(PICKED);
  });

  it('with data elevation, takes the first drawn cell along the pick ray, with no GPU pick', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    const lifted = context({ factor: () => 3 });
    const scene = fakeScene(view);
    expect(hover(scene, lifted, view)(CENTRE)).toEqual(PICKED);
    expect(scene.camera.getPickRay).toHaveBeenCalledWith(CENTRE);
    for (const gpu of [scene.drillPick, scene.pick, scene.pickPosition])
      expect(gpu).not.toHaveBeenCalled();
    // A lifted cell no layer draws, or the wave has not reached, lets the ray pass.
    expect(
      hover(
        fakeScene(view),
        context({ factor: () => 3 }, target({ drawn: () => false })),
        view,
      )(CENTRE),
    ).toBeNull();
    expect(
      hover(
        fakeScene(view),
        context({ factor: () => 3, reveal: () => 0 }),
        view,
      )(CENTRE),
    ).toBeNull();
    // Mid-morph the lifted surface is drawn between both frames: nothing.
    expect(
      hover(fakeScene(view, SceneMode.MORPHING), lifted, view)(CENTRE),
    ).toBeNull();
  });

  it('with data elevation in Columbus view, follows the ray in the map frame', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    const scene = fakeScene(view, SceneMode.COLUMBUS_VIEW);
    // The world frame holds (height, x, y), x = lon·a and y = lat·a, and the shader moves a
    // vertex lifted S by S times its ECEF normal (x, y, z) in that frame's (height, x, y) order:
    // straight down onto the cell's centre where it is drawn, 0.65 S north of its base.
    const a = 6378137;
    const lift = heightFor('observed', 0.5, [0, 1], 1) * 3;
    const normal = Cartesian3.normalize(
      Cartesian3.fromDegrees(LON, LAT, SURFACE_CLEARANCE_METRES),
      new Cartesian3(),
    );
    scene.camera.getPickRay.mockReturnValue(
      new Ray(
        new Cartesian3(
          2_000_000,
          CesiumMath.toRadians(LON) * a + normal.y * lift,
          CesiumMath.toRadians(LAT) * a + normal.z * lift,
        ),
        new Cartesian3(-1, 0, 0),
      ),
    );
    expect(hover(scene, context({ factor: () => 3 }), view)(CENTRE)).toEqual(
      PICKED,
    );
  });

  it('lets the displayed artifact’s observation under the pointer win over the cell', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    const group = circles();
    const marker = new Cartesian2(CENTRE.x + 10, CENTRE.y);
    const resolve = hover(
      fakeScene(view),
      context({}, target({ observations: group })),
      view,
    );
    expect(resolve(marker)).toEqual(OBSERVATION);
    // Beside the marker, the cell under it.
    expect(resolve(new Cartesian2(CENTRE.x - 10, CENTRE.y))).toEqual(PICKED);
  });

  it('asks only the pick target’s observations, so nothing answers without a displayed artifact', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    const observationAt = vi.fn((): ObservationPick | null => OBSERVATION);
    let pickTarget: PickTarget | null = null;
    const resolve = hover(
      fakeScene(view),
      { ...context(), target: () => pickTarget },
      view,
    );
    expect(resolve(CENTRE)).toBeNull();
    expect(observationAt).not.toHaveBeenCalled();
    // Once there is a target, its own observations answer, asked with the hit view and the pointer.
    pickTarget = target({ observations: { artifactKey: KEY, observationAt } });
    expect(resolve(CENTRE)).toEqual(OBSERVATION);
    expect(observationAt).toHaveBeenCalledExactlyOnceWith(view, CENTRE);
    // An answer naming another artifact is not the displayed one's: it is refused.
    const other = observationPickId(
      'map-surveys:1',
      'g6pd-deficiency:v3:map-2026-08',
    );
    expect(() =>
      hover(
        fakeScene(view),
        context(
          {},
          target({
            observations: { artifactKey: KEY, observationAt: () => other },
          }),
        ),
        view,
      )(CENTRE),
    ).toThrow(/g6pd-deficiency/);
  });

  it('agrees with the click at the same points', () => {
    const view = nadirView(LAT, LON, MPP, CENTRE);
    const group = circles();
    const scene = fakeScene(view);
    const pickContext = context({}, target({ observations: group }));
    const reach = 22 / 2 + 2 + 1.5 + 1;
    const marker = view.toWindow(Cartesian3.fromDegrees(LON + 0.118, LAT))!;
    // What the GPU's 3 × 3 drill pick finds at a point: the circle within its drawn reach, then
    // the surface chunk of any grid cell under the pointer.
    scene.drillPick.mockImplementation((position: Cartesian2) => {
      const picks: { id: unknown }[] = [];
      if (Cartesian2.distance(position, marker) <= reach)
        picks.push({ id: OBSERVATION });
      const ground = Ellipsoid.WGS84.cartesianToCartographic(
        view.groundAt(position),
      );
      const row = rowForH3(
        surface,
        latLngToCell(
          CesiumMath.toDegrees(ground.latitude),
          CesiumMath.toDegrees(ground.longitude),
          4,
        ),
      );
      if (row !== null) picks.push({ id: surfaceChunkPickId(KEY, 0) });
      return picks;
    });
    const click = createSurfacePickResolver(scene as never, pickContext);
    const resolveHover = hover(scene, pickContext, view);
    const points = [
      marker,
      new Cartesian2(marker.x + reach - 0.5, marker.y),
      new Cartesian2(marker.x + reach + 0.5, marker.y),
      new Cartesian2(CENTRE.x - 20, CENTRE.y),
      new Cartesian2(CENTRE.x, CENTRE.y + 400),
    ];
    const hovered = points.map((point) => resolveHover(point));
    expect(hovered.map((pick) => pick?.kind ?? null)).toEqual([
      'observation',
      'observation',
      'surface',
      'surface',
      null,
    ]);
    expect(
      points.map((point) =>
        click(scene.drillPick(point, 12) as unknown[], point),
      ),
    ).toEqual(hovered);
  });
});
