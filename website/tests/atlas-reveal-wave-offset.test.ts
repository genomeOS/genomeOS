/**
 * The reveal wave (#453) over the desktop globe offset (#452): a wave spreads from where the
 * camera's view ray meets the globe, which the offset draws at the centre of the open area beside
 * the controls panel, and it reaches every point drawn at the canvas's edge, including those
 * under the panel (fast-load design §A.1.13 and §B.6.7, both amended 2026-10-13). Real Cesium
 * cameras over a scene stand-in, as in `atlas-globe-offset.test.ts`.
 */
import {
  Camera,
  Cartesian2,
  Cartesian3,
  Ellipsoid,
  Event,
  GeographicProjection,
  Globe,
  IntersectionTests,
  Math as CesiumMath,
  Ray,
  SceneMode,
  type Scene,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installGlobeOffset,
  viewCentre,
  type GlobeOffset,
} from '../src/atlas/scene/globe-offset';
import { angleBetween, type Vec3 } from '../src/atlas/scene/reveal-wave';
import {
  waveViewOf,
  type WaveViewScene,
} from '../src/atlas/scene/reveal-wave-driver';

const WIDTH = 1280;
const HEIGHT = 720;
/** The desktop controls panel's covered width at 1280 px (§A.1.13). */
const COVERED = 468;

interface OffsetScene {
  camera: Camera;
  canvas: { clientHeight: number; clientWidth: number };
  drawingBufferHeight: number;
  drawingBufferWidth: number;
  frameState: {
    cullingVolume: unknown;
    passes: { offscreen: boolean; pick: boolean; pickVoxel: boolean };
  };
  globe: Globe;
  mapProjection: GeographicProjection;
  mode: SceneMode;
  pickPositionWorldCoordinates: () => undefined;
  preUpdate: Event;
  requestRender: () => void;
  screenSpaceCameraController: {
    _aggregator: {
      getLastMovement(): undefined;
      getMovement(): undefined;
      getStartMousePosition(): Cartesian2;
    };
    update(): void;
  };
  updateAndExecuteCommands: () => void;
}

/** A scene stand-in with a real camera looking straight down from `height` m over (lon, lat). */
function offsetScene(
  mode: SceneMode,
  lon: number,
  lat: number,
  height: number,
): OffsetScene {
  const scene = {
    canvas: { clientHeight: HEIGHT, clientWidth: WIDTH },
    drawingBufferHeight: HEIGHT,
    drawingBufferWidth: WIDTH,
    frameState: {
      cullingVolume: undefined,
      passes: { offscreen: false, pick: false, pickVoxel: false },
    },
    globe: new Globe(),
    mapProjection: new GeographicProjection(),
    mode,
    pickPositionWorldCoordinates: () => undefined,
    preUpdate: new Event(),
    requestRender: vi.fn(),
    screenSpaceCameraController: {
      _aggregator: {
        getLastMovement: () => undefined,
        getMovement: () => undefined,
        getStartMousePosition: () => new Cartesian2(),
      },
      update: () => undefined,
    },
    updateAndExecuteCommands: vi.fn(),
  } as unknown as OffsetScene;
  const camera = new Camera(scene as unknown as Scene);
  camera.frustum.near = 0.1;
  // Scene tells its camera the mode each frame; Cesium's typings leave that method out.
  (camera as unknown as { update(mode: SceneMode): void }).update(mode);
  camera.setView({
    destination: Cartesian3.fromDegrees(lon, lat, height),
    orientation: { heading: 0, pitch: CesiumMath.toRadians(-90), roll: 0 },
  });
  scene.camera = camera;
  return scene;
}

const installed: GlobeOffset[] = [];

/** The scene with the desktop panel covering `COVERED` px, as drawn from the next frame on. */
function shifted(scene: OffsetScene): OffsetScene {
  const offset = installGlobeOffset(scene as unknown as Scene);
  installed.push(offset);
  offset.setCoveredLeft(COVERED);
  scene.preUpdate.raiseEvent(scene);
  return scene;
}

afterEach(() => {
  for (const offset of installed.splice(0)) offset.destroy();
});

function vec(point: Cartesian3): Vec3 {
  return [point.x, point.y, point.z];
}

/** The ground point the camera looks at, which the offset draws at the open area's centre. */
function axisPoint(scene: OffsetScene): Cartesian3 {
  const axis = new Ray(scene.camera.positionWC, scene.camera.directionWC);
  const hit = IntersectionTests.rayEllipsoid(axis, Ellipsoid.WGS84)!;
  return Ray.getPoint(axis, hit.start);
}

const asWaveScene = (scene: OffsetScene) => scene as unknown as WaveViewScene;
const asScene = (scene: OffsetScene) => scene as unknown as Scene;

describe('reveal wave over the desktop globe offset', () => {
  it('starts on the globe at the centre of the open area, where the view ray meets it', () => {
    const scene = shifted(offsetScene(SceneMode.SCENE3D, 20, 12, 16_500_000));
    const origin = waveViewOf(asWaveScene(scene), 0).origin;
    // Within float noise of acos near 1 (1e-6 rad is 6 m), not the ~25° the shift spans here.
    expect(angleBetween(origin, vec(axisPoint(scene)))).toBeLessThan(1e-6);
    // The point drawn at the open area's centre, and not the one drawn at the canvas centre.
    const drawn = scene.camera.pickEllipsoid(viewCentre(asScene(scene)))!;
    expect(angleBetween(origin, vec(drawn))).toBeLessThan(1e-6);
    const canvasCentre = scene.camera.pickEllipsoid(
      new Cartesian2(WIDTH / 2, HEIGHT / 2),
    )!;
    expect(angleBetween(origin, vec(canvasCentre))).toBeGreaterThan(
      CesiumMath.toRadians(10),
    );
  });

  it('starts in Columbus view at the point drawn at the centre of the open area', () => {
    const scene = shifted(offsetScene(SceneMode.COLUMBUS_VIEW, 20, 12, 3e6));
    const origin = waveViewOf(asWaveScene(scene), 0).origin;
    // Straight down, the view axis meets the map below the camera.
    const below = vec(Cartesian3.fromDegrees(20, 12));
    expect(angleBetween(origin, below)).toBeLessThan(
      CesiumMath.toRadians(0.01),
    );
    const canvasCentre = scene.camera.pickEllipsoid(
      new Cartesian2(WIDTH / 2, HEIGHT / 2),
    )!;
    expect(angleBetween(below, vec(canvasCentre))).toBeGreaterThan(
      CesiumMath.toRadians(5),
    );
  });

  it('reaches every point drawn at the canvas edge, under the panel too, when the globe fills the view', () => {
    const scene = shifted(offsetScene(SceneMode.SCENE3D, -3.7, 40.4, 1e6));
    const view = waveViewOf(asWaveScene(scene), 0);
    const edge = (x: number, y: number) =>
      angleBetween(
        view.origin,
        vec(scene.camera.pickEllipsoid(new Cartesian2(x, y))!),
      );
    // The panel's side of the canvas is farther from the open area's centre than the other side.
    expect(edge(0, HEIGHT / 2)).toBeGreaterThan(edge(WIDTH, HEIGHT / 2));
    for (const [x, y] of [
      [0, 0],
      [0, HEIGHT / 2],
      [0, HEIGHT],
      [WIDTH, 0],
      [WIDTH, HEIGHT],
    ])
      expect(view.reach).toBeGreaterThanOrEqual(edge(x, y) - 1e-12);
  });
});
