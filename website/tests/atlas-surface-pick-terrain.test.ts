/** Picks under World Terrain: the cell on the rendered ground under the pointer (terrain draping
 * design, "Picking"; #483). */

import { cellToLatLng } from 'h3-js';
import {
  Cartesian2,
  Cartesian3,
  GeographicProjection,
  Ray,
  SceneMode,
} from 'cesium';
import { describe, expect, it, vi } from 'vitest';

import { observationPickId } from '../src/atlas/scene/observation-layer';
import { surfaceChunkPickId } from '../src/atlas/scene/surface-chunk-layer';
import {
  createSurfacePickResolver,
  resolveDrapedPick,
  type PickTarget,
  type SurfacePickContext,
} from '../src/atlas/scene/surface-pick';
import { rowForH3 } from '../src/atlas/surface-columns';
import { columnarSurface } from './helpers/columnar-surface';

const CELL = '84390cbffffffff'; // SYNTHETIC_PEAK's res-4 cell
const surface = columnarSurface([
  { h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' },
]);
const KEY = surface.artifactKey;
const [LAT, LON] = cellToLatLng(CELL);
const WINDOW = new Cartesian2(412, 288);
const GROUND = Cartesian3.fromDegrees(LON, LAT, 18_000); // the summit at relief 3
const BEHIND = Cartesian3.fromDegrees(LON, LAT + 0.45); // the ellipsoid ~50 km on: 84392b5ffffffff
const PICKED = {
  artifactKey: KEY,
  h3Index: CELL,
  kind: 'surface',
  row: rowForH3(surface, CELL),
};

function fakeScene(mode: SceneMode = SceneMode.SCENE3D) {
  const ray = new Ray(
    Cartesian3.fromDegrees(LON, LAT - 2.2, 100_000),
    Cartesian3.UNIT_Z,
  );
  return {
    camera: {
      getPickRay: vi.fn((_: Cartesian2) => ray as Ray | undefined),
      pickEllipsoid: vi.fn(() => BEHIND),
    },
    globe: {
      pick: vi.fn((_r: Ray, _s: unknown) => GROUND as Cartesian3 | undefined),
    },
    mapProjection: new GeographicProjection(),
    mode,
    pick: vi.fn(),
    pickPosition: vi.fn(),
    pickTranslucentDepth: false,
    ray,
  };
}
const target = (o: Partial<PickTarget> = {}): PickTarget => ({
  artifactKey: KEY,
  draped: false,
  drawn: () => true,
  hidden: [],
  surface,
  ...o,
});
const context = (o: Partial<SurfacePickContext> = {}): SurfacePickContext => ({
  draped: () => true,
  factor: () => 0,
  geometry: () => 'triangles',
  metric: () => 'post_mean',
  target: () => target(),
  ...o,
});

describe('resolveDrapedPick (#483)', () => {
  it('resolves the cell on the rendered ground under the pointer', () => {
    const scene = fakeScene();
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toEqual(PICKED);
    expect(scene.camera.getPickRay).toHaveBeenCalledWith(WINDOW);
    expect(scene.globe.pick).toHaveBeenCalledWith(scene.ray, scene);
    expect(scene.camera.pickEllipsoid).not.toHaveBeenCalled();
  });

  it('resolves nothing while the scene morphs', () => {
    const scene = fakeScene(SceneMode.MORPHING);
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
    expect(scene.globe.pick).not.toHaveBeenCalled();
  });

  it('resolves nothing where the pointer misses the rendered ground', () => {
    const scene = fakeScene();
    scene.globe.pick.mockReturnValue(undefined);
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
    scene.camera.getPickRay.mockReturnValue(undefined);
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
  });

  it('resolves nothing over ground outside the grid', () => {
    const scene = fakeScene();
    scene.globe.pick.mockReturnValue(
      Cartesian3.fromDegrees(LON + 20, LAT, 300),
    );
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
  });

  it('resolves nothing for a row the layers do not draw', () => {
    const drawn = vi.fn(() => false);
    expect(
      resolveDrapedPick(fakeScene() as never, target({ drawn }), WINDOW),
    ).toBeNull();
    expect(drawn).toHaveBeenCalledWith(PICKED.row);
  });

  it('hands globe.pick the scene in 2D and Columbus view, which projects its hit back', () => {
    for (const mode of [SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW]) {
      const scene = fakeScene(mode);
      expect(resolveDrapedPick(scene as never, target(), WINDOW)).toEqual(
        PICKED,
      );
      expect(scene.globe.pick).toHaveBeenCalledWith(scene.ray, scene);
    }
  });
});

describe('createSurfacePickResolver under World Terrain (#483)', () => {
  it('needs no surface chunk in the drill pick, since the ground can cover the surface', () => {
    const resolve = createSurfacePickResolver(fakeScene() as never, context());
    expect(resolve([], WINDOW)).toEqual(PICKED);
    expect(resolve([{ id: surfaceChunkPickId(KEY, 0) }], WINDOW)).toEqual(
      PICKED,
    );
  });

  it('lets an observation hit win first', () => {
    const scene = fakeScene();
    const observation = observationPickId('map-surveys:1135', KEY);
    expect(
      createSurfacePickResolver(scene as never, context())(
        [{ id: observation }],
        WINDOW,
      ),
    ).toEqual(observation);
    expect(scene.globe.pick).not.toHaveBeenCalled();
  });

  it('uses neither the ellipsoid, the clearance nor the translucent depth pick', () => {
    const scene = fakeScene();
    createSurfacePickResolver(scene as never, context())([], WINDOW);
    expect(scene.camera.pickEllipsoid).not.toHaveBeenCalled();
    expect(scene.pickPosition).not.toHaveBeenCalled();
    expect(scene.pick).not.toHaveBeenCalled();
    expect(scene.pickTranslucentDepth).toBe(false);
  });

  it('takes the ground branch for a draped group on any terrain', () => {
    const resolve = createSurfacePickResolver(
      fakeScene() as never,
      context({ draped: () => false, target: () => target({ draped: true }) }),
    );
    expect(resolve([], WINDOW)).toEqual(PICKED);
  });

  it('keeps the ellipsoid on the smooth globe', () => {
    const scene = fakeScene();
    scene.camera.pickEllipsoid.mockReturnValue(
      Cartesian3.fromDegrees(LON, LAT),
    );
    const resolve = createSurfacePickResolver(
      scene as never,
      context({ draped: () => false }),
    );
    expect(resolve([{ id: surfaceChunkPickId(KEY, 0) }], WINDOW)).toEqual(
      PICKED,
    );
    expect(resolve([], WINDOW)).toBeNull();
    expect(scene.globe.pick).not.toHaveBeenCalled();
  });

  it("keeps the reveal wave's word while chunks still wave, and not for a draped group", () => {
    const scene = fakeScene();
    expect(
      createSurfacePickResolver(scene as never, context({ reveal: () => 0 }))(
        [],
        WINDOW,
      ),
    ).toBeNull();
    expect(
      createSurfacePickResolver(
        scene as never,
        context({ reveal: () => 0, target: () => target({ draped: true }) }),
      )([], WINDOW),
    ).toEqual(PICKED);
  });
});
