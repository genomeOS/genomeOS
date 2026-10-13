/**
 * The shifted projection centre that draws the desktop globe beside the controls panel, and the
 * Cesium paths that must honour it (fast-load design §A.1.13, amended 2026-10-13; #452).
 */
import {
  BoundingSphere,
  Camera,
  CameraEventAggregator,
  Cartesian2,
  Cartesian3,
  Cartesian4,
  Ellipsoid,
  Event,
  GeographicProjection,
  Globe,
  Intersect,
  IntersectionTests,
  Material,
  Math as CesiumMath,
  Matrix4,
  OrthographicOffCenterFrustum,
  PerspectiveFrustum,
  Ray,
  SceneMode,
  ScreenSpaceCameraController,
  type Scene,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installGlobeOffset,
  patchGlobeFragmentShader,
  ShiftedPerspectiveFrustum,
  viewCentre,
} from '../src/atlas/scene/globe-offset';
import { projectionShift } from '../src/atlas/view-offset';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';

const WIDTH = 1280;
const HEIGHT = 720;
const COVERED = 468;
const SHIFT_PX = COVERED / 2;
const SHIFT_NDC = projectionShift(SHIFT_PX, WIDTH);

function frustumPair(near: number, aspect = WIDTH / HEIGHT) {
  const options = {
    aspectRatio: aspect,
    far: 1e10,
    fov: CesiumMath.toRadians(60),
    near,
  };
  const plain = new PerspectiveFrustum(options);
  const shifted = new ShiftedPerspectiveFrustum(options);
  shifted.projectionShift = SHIFT_NDC;
  return { plain, shifted };
}

/** Normalised device coordinates of an eye-space point. */
function ndc(
  frustum: { projectionMatrix: Matrix4 },
  eye: Cartesian3,
): Cartesian2 {
  const clip = Matrix4.multiplyByVector(
    frustum.projectionMatrix,
    new Cartesian4(eye.x, eye.y, eye.z, 1),
    new Cartesian4(),
  );
  return new Cartesian2(clip.x / clip.w, clip.y / clip.w);
}

const EYE_POINTS = [
  new Cartesian3(0, 0, -1e7),
  new Cartesian3(3e6, 1e6, -2e7),
  new Cartesian3(-5e6, -2e6, -1.5e7),
];

describe('ShiftedPerspectiveFrustum', () => {
  it('draws every point the same fraction of the canvas further right', () => {
    const { plain, shifted } = frustumPair(0.1);
    for (const eye of EYE_POINTS) {
      const before = ndc(plain, eye);
      const after = ndc(shifted, eye);
      expect(after.x - before.x).toBeCloseTo(SHIFT_NDC, 9);
      expect(after.y).toBeCloseTo(before.y, 12);
    }
  });

  it('keeps the shift at any near plane, as Cesium renders each frustum of a frame', () => {
    for (const near of [0.1, 1, 1.3e7]) {
      const { plain, shifted } = frustumPair(near);
      for (const eye of EYE_POINTS.slice(1)) {
        expect(ndc(shifted, eye).x - ndc(plain, eye).x).toBeCloseTo(
          SHIFT_NDC,
          9,
        );
      }
    }
  });

  it('keeps the shift in a portrait canvas', () => {
    const { plain, shifted } = frustumPair(1, 390 / 844);
    const eye = EYE_POINTS[1];
    expect(ndc(shifted, eye).x - ndc(plain, eye).x).toBeCloseTo(SHIFT_NDC, 9);
  });

  it('survives the working copies Cesium clones into its own scratch frustums', () => {
    // Cesium 1.145's PerspectiveFrustum.clone drops xOffset, which is why a subclass is needed.
    const offset = new PerspectiveFrustum({
      aspectRatio: 1,
      fov: 1,
      xOffset: 0.01,
    });
    expect(offset.clone().xOffset).toBe(0);

    const { plain, shifted } = frustumPair(0.1);
    const cesiumScratch = new PerspectiveFrustum();
    const copy = shifted.clone(cesiumScratch);
    expect(copy).toBeInstanceOf(ShiftedPerspectiveFrustum);
    expect(copy.projectionShift).toBe(SHIFT_NDC);
    expect(shifted.clone(cesiumScratch)).toBe(copy);
    // The scene moves each working copy's near plane to the frustum it renders.
    copy.near = 2.5e6;
    plain.near = 2.5e6;
    const eye = EYE_POINTS[1];
    expect(ndc(copy, eye).x - ndc(plain, eye).x).toBeCloseTo(SHIFT_NDC, 9);
    expect(shifted.clone()).toBeInstanceOf(ShiftedPerspectiveFrustum);
    expect(shifted.clone().projectionShift).toBe(SHIFT_NDC);
  });

  it('copies a plain frustum and keeps a directly set xOffset', () => {
    const plain = new PerspectiveFrustum({
      aspectRatio: 2,
      far: 1234,
      fov: 1,
      near: 3,
      xOffset: 0.5,
    });
    const copy = ShiftedPerspectiveFrustum.from(plain);
    expect([copy.fov, copy.aspectRatio, copy.near, copy.far]).toEqual([
      1, 2, 3, 1234,
    ]);
    expect(copy.projectionShift).toBe(0);
    expect(copy.xOffset).toBe(0.5);
    expect(copy.projectionMatrix).toEqual(plain.projectionMatrix);
  });
});

const GLOBE_FS_MARKER = 'vec3 computeEllipsoidPosition()';

interface FakeScene {
  camera: Camera;
  canvas: { clientWidth: number; clientHeight: number };
  drawingBufferHeight: number;
  drawingBufferWidth: number;
  frameState: {
    cullingVolume: unknown;
    passes: { pick: boolean; pickVoxel: boolean };
  };
  globe: Globe;
  mapProjection: GeographicProjection;
  mode: SceneMode;
  pickPositionWorldCoordinates: (
    position: Cartesian2,
    result?: Cartesian3,
  ) => Cartesian3 | undefined;
  preUpdate: Event;
  requestRender: () => void;
  screenSpaceCameraController: FakeController;
  updateAndExecuteCommands: (passState: unknown, background: unknown) => void;
}

interface Movement {
  startPosition: Cartesian2;
  endPosition: Cartesian2;
}

/** Cesium's camera controller as the offset sees it: its private input aggregator and update. */
interface FakeController {
  _aggregator: {
    getLastMovement(type: number, modifier?: number): Movement | undefined;
    getMovement(type: number, modifier?: number): Movement | undefined;
    getStartMousePosition(type: number, modifier?: number): Cartesian2;
  };
  update(): void;
}

function fakeController(onUpdate: () => void): FakeController {
  const drag = () => ({
    endPosition: new Cartesian2(710, 305),
    startPosition: new Cartesian2(700, 300),
  });
  return {
    _aggregator: {
      getLastMovement: drag,
      getMovement: drag,
      getStartMousePosition: () => new Cartesian2(700, 300),
    },
    update: onUpdate,
  };
}

function fakeScene(): FakeScene {
  const scene = {
    canvas: { clientHeight: HEIGHT, clientWidth: WIDTH },
    drawingBufferHeight: HEIGHT,
    drawingBufferWidth: WIDTH,
    frameState: {
      cullingVolume: undefined,
      passes: { pick: false, pickVoxel: false },
    },
    globe: new Globe(),
    mapProjection: new GeographicProjection(),
    mode: SceneMode.SCENE3D,
    pickPositionWorldCoordinates: vi.fn(() => undefined),
    preUpdate: new Event(),
    requestRender: vi.fn(),
    screenSpaceCameraController: fakeController(() => undefined),
    updateAndExecuteCommands: vi.fn(),
  } as unknown as FakeScene;
  const camera = new Camera(scene as unknown as Scene);
  camera.frustum.near = 0.1;
  camera.setView({
    destination: Cartesian3.fromDegrees(20, 12, 16_500_000),
    orientation: {
      heading: 0,
      pitch: CesiumMath.toRadians(-90),
      roll: 0,
    },
  });
  scene.camera = camera;
  return scene;
}

/** Where a world point is drawn, in CSS window pixels, through the camera's current frustum. */
function windowPosition(scene: FakeScene, world: Cartesian3): Cartesian2 {
  const eye = Matrix4.multiplyByPoint(
    scene.camera.viewMatrix,
    world,
    new Cartesian3(),
  );
  const device = ndc(scene.camera.frustum as PerspectiveFrustum, eye);
  return new Cartesian2(
    ((device.x + 1) / 2) * WIDTH,
    ((1 - device.y) / 2) * HEIGHT,
  );
}

/** The ground point on the camera's view axis, which the projection shift must not move. */
function axisPoint(scene: FakeScene): Cartesian3 {
  const axis = new Ray(scene.camera.positionWC, scene.camera.directionWC);
  const hit = IntersectionTests.rayEllipsoid(axis, Ellipsoid.WGS84)!;
  return Ray.getPoint(axis, hit.start);
}

function expectRayThrough(
  scene: FakeScene,
  window: Cartesian2,
  world: Cartesian3,
) {
  const ray = scene.camera.getPickRay(window)!;
  const toWorld = Cartesian3.normalize(
    Cartesian3.subtract(world, ray.origin, new Cartesian3()),
    new Cartesian3(),
  );
  expect(Cartesian3.dot(ray.direction, toWorld)).toBeGreaterThan(1 - 1e-12);
}

const installed: { destroy(): void }[] = [];
function install(scene: FakeScene) {
  const offset = installGlobeOffset(scene as unknown as Scene);
  installed.push(offset);
  return offset;
}

afterEach(() => {
  for (const offset of installed.splice(0)) offset.destroy();
});

describe('installGlobeOffset', () => {
  it('shifts the projection by half the covered width at the next frame and asks for one', () => {
    const scene = fakeScene();
    const offset = install(scene);
    expect(scene.camera.frustum).toBeInstanceOf(ShiftedPerspectiveFrustum);
    offset.setCoveredLeft(COVERED);
    expect(scene.requestRender).toHaveBeenCalled();
    scene.preUpdate.raiseEvent(scene);
    const frustum = scene.camera.frustum as ShiftedPerspectiveFrustum;
    expect(frustum.projectionShift).toBeCloseTo(SHIFT_NDC, 12);
    // The point on the view axis is drawn at the centre of the open area.
    const drawn = windowPosition(scene, axisPoint(scene));
    expect(drawn.x).toBeCloseTo((COVERED + WIDTH) / 2, 6);
    expect(drawn.y).toBeCloseTo(HEIGHT / 2, 6);
    expect(viewCentre(scene as unknown as Scene)).toEqual(
      new Cartesian2(WIDTH / 2 + SHIFT_PX, HEIGHT / 2),
    );
  });

  it('recomputes the shift when the canvas resizes', () => {
    const scene = fakeScene();
    const offset = install(scene);
    offset.setCoveredLeft(COVERED);
    scene.preUpdate.raiseEvent(scene);
    scene.canvas.clientWidth = 1000;
    scene.preUpdate.raiseEvent(scene);
    expect(
      (scene.camera.frustum as ShiftedPerspectiveFrustum).projectionShift,
    ).toBeCloseTo(projectionShift(SHIFT_PX, 1000), 12);
  });

  it('centres the globe again when nothing is covered', () => {
    const scene = fakeScene();
    const offset = install(scene);
    offset.setCoveredLeft(COVERED);
    scene.preUpdate.raiseEvent(scene);
    offset.setCoveredLeft(0);
    scene.preUpdate.raiseEvent(scene);
    expect(
      (scene.camera.frustum as ShiftedPerspectiveFrustum).projectionShift,
    ).toBe(0);
    expect(windowPosition(scene, axisPoint(scene)).x).toBeCloseTo(WIDTH / 2, 6);
    expect(viewCentre(scene as unknown as Scene)).toEqual(
      new Cartesian2(WIDTH / 2, HEIGHT / 2),
    );
  });

  it('casts pick rays through what is drawn under the pointer', () => {
    const scene = fakeScene();
    const offset = install(scene);
    offset.setCoveredLeft(COVERED);
    scene.preUpdate.raiseEvent(scene);
    for (const [lon, lat] of [
      [20, 12],
      [35, -5],
      [0, 30],
    ]) {
      const world = Cartesian3.fromDegrees(lon, lat);
      expectRayThrough(scene, windowPosition(scene, world), world);
    }
    const hit = scene.camera.pickEllipsoid(
      viewCentre(scene as unknown as Scene),
    )!;
    // Within a metre from 16,500 km: float noise, not the 234 px (thousands of km) of the shift.
    expect(Cartesian3.distance(hit, axisPoint(scene))).toBeLessThan(1);
  });

  it('upgrades a frustum Cesium swaps in after a morph, but not mid-morph or in 2D', () => {
    const scene = fakeScene();
    const offset = install(scene);
    offset.setCoveredLeft(COVERED);
    const plain = new PerspectiveFrustum({
      aspectRatio: WIDTH / HEIGHT,
      far: 5e8,
      fov: 1.1,
      near: 2,
    });
    scene.mode = SceneMode.MORPHING;
    scene.camera.frustum = plain;
    scene.preUpdate.raiseEvent(scene);
    expect(scene.camera.frustum).toBe(plain);

    scene.mode = SceneMode.COLUMBUS_VIEW;
    scene.preUpdate.raiseEvent(scene);
    const upgraded = scene.camera.frustum as ShiftedPerspectiveFrustum;
    expect(upgraded).toBeInstanceOf(ShiftedPerspectiveFrustum);
    expect([upgraded.fov, upgraded.near, upgraded.far]).toEqual([1.1, 2, 5e8]);
    expect(upgraded.projectionShift).toBeCloseTo(SHIFT_NDC, 12);

    const flat = new OrthographicOffCenterFrustum({
      bottom: -1,
      left: -2,
      right: 2,
      top: 1,
    });
    scene.mode = SceneMode.SCENE2D;
    // Cesium's typings omit the off-centre orthographic frustum it uses in 2D.
    (scene.camera as { frustum: unknown }).frustum = flat;
    scene.preUpdate.raiseEvent(scene);
    expect(scene.camera.frustum).toBe(flat);
    expect(viewCentre(scene as unknown as Scene)).toEqual(
      new Cartesian2(WIDTH / 2, HEIGHT / 2),
    );
  });

  it('culls each pick pass to what is drawn in its scissor rectangle', () => {
    const scene = fakeScene();
    const original = scene.updateAndExecuteCommands;
    const offset = install(scene);
    offset.setCoveredLeft(COVERED);
    scene.preUpdate.raiseEvent(scene);
    const target = Cartesian3.fromDegrees(35, -5);
    const drawn = windowPosition(scene, target);
    // Cesium's own pick volume ignores the shift: it would hold the point drawn SHIFT_PX further
    // right, the point whose unshifted projection lies under the pointer.
    const elsewhere = scene.camera.pickEllipsoid(
      new Cartesian2(drawn.x + SHIFT_PX, drawn.y),
    )!;
    const sentinel = { sentinel: true };
    const rectangle = {
      height: 3,
      width: 3,
      x: Math.round(drawn.x) - 1,
      y: HEIGHT - Math.round(drawn.y) - 1,
    };
    const passState = { scissorTest: { enabled: true, rectangle } };
    const background = {};

    scene.frameState.passes.pick = true;
    scene.frameState.cullingVolume = sentinel;
    scene.updateAndExecuteCommands(passState, background);
    expect(original).toHaveBeenCalledWith(passState, background);
    const culling = scene.frameState.cullingVolume as {
      computeVisibility(sphere: BoundingSphere): Intersect;
    };
    expect(culling).not.toBe(sentinel);
    expect(
      culling.computeVisibility(new BoundingSphere(target, 2_000)),
    ).not.toBe(Intersect.OUTSIDE);
    expect(
      culling.computeVisibility(new BoundingSphere(elsewhere, 2_000)),
    ).toBe(Intersect.OUTSIDE);

    // Ordinary frames and unshifted picks keep Cesium's own volume.
    scene.frameState.passes.pick = false;
    scene.frameState.cullingVolume = sentinel;
    scene.updateAndExecuteCommands(passState, background);
    expect(scene.frameState.cullingVolume).toBe(sentinel);
    offset.setCoveredLeft(0);
    scene.preUpdate.raiseEvent(scene);
    scene.frameState.passes.pick = true;
    scene.updateAndExecuteCommands(passState, background);
    expect(scene.frameState.cullingVolume).toBe(sentinel);
  });

  it('patches the globe shader for the shift, including after Cesium rebuilds it', () => {
    const scene = fakeScene();
    install(scene);
    const shaderSet = (
      scene.globe as unknown as {
        _surfaceShaderSet: { baseFragmentShaderSource: { sources: string[] } };
      }
    )._surfaceShaderSet;
    const globeSource = () =>
      shaderSet.baseFragmentShaderSource.sources.find((source) =>
        source.includes(GLOBE_FS_MARKER),
      )!;
    expect(globeSource()).toContain('czm_frustumPlanes');
    // A new material (or terrain) makes Cesium rebuild the globe's shader sources.
    stubCesiumBrowserImageTypes();
    try {
      scene.globe.material = Material.fromType('Color');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globeSource()).toContain('czm_frustumPlanes');
  });

  it("runs Cesium's camera controller in the frame of a centred view, where its canvas centre is the view axis", () => {
    const scene = fakeScene();
    const seen: Record<string, unknown> = {};
    const depthQueries: { position: Cartesian2; shift: number }[] = [];
    scene.pickPositionWorldCoordinates = (position) => {
      depthQueries.push({
        position: Cartesian2.clone(position),
        shift: (scene.camera.frustum as ShiftedPerspectiveFrustum)
          .projectionShift,
      });
      return undefined;
    };
    const controller = fakeController(() => {
      const aggregator = controller._aggregator;
      seen.shift = (
        scene.camera.frustum as ShiftedPerspectiveFrustum
      ).projectionShift;
      seen.movement = aggregator.getMovement(1);
      seen.last = aggregator.getLastMovement(1);
      seen.start = aggregator.getStartMousePosition(1);
      // Cesium's tilt pivot and high-altitude zoom read the ground at the canvas centre.
      seen.centreRay = scene.camera.getPickRay(
        new Cartesian2(WIDTH / 2, HEIGHT / 2),
      );
      scene.pickPositionWorldCoordinates(new Cartesian2(WIDTH / 2, 300));
    });
    scene.screenSpaceCameraController = controller;
    const offset = install(scene);
    offset.setCoveredLeft(COVERED);
    scene.preUpdate.raiseEvent(scene);

    scene.screenSpaceCameraController.update();
    expect(seen.shift).toBe(0);
    expect(seen.movement).toEqual({
      endPosition: new Cartesian2(710 - SHIFT_PX, 305),
      startPosition: new Cartesian2(700 - SHIFT_PX, 300),
    });
    expect(seen.last).toEqual(seen.movement);
    expect(seen.start).toEqual(new Cartesian2(700 - SHIFT_PX, 300));
    expect(
      Cartesian3.dot(
        (seen.centreRay as Ray).direction,
        scene.camera.directionWC,
      ),
    ).toBeGreaterThan(1 - 1e-12);
    // The depth it reads was drawn shifted, so it is read where it was drawn, with that frustum.
    expect(depthQueries).toEqual([
      { position: new Cartesian2(WIDTH / 2 + SHIFT_PX, 300), shift: SHIFT_NDC },
    ]);
    // Afterwards the scene is drawn shifted again and other callers see the drawn frame.
    expect(
      (scene.camera.frustum as ShiftedPerspectiveFrustum).projectionShift,
    ).toBeCloseTo(SHIFT_NDC, 12);
    expect(controller._aggregator.getStartMousePosition(1)).toEqual(
      new Cartesian2(700, 300),
    );
    scene.pickPositionWorldCoordinates(new Cartesian2(10, 20));
    expect(depthQueries.at(-1)!.position).toEqual(new Cartesian2(10, 20));
  });

  it('leaves the camera controller alone while nothing is covered', () => {
    const scene = fakeScene();
    const seen: unknown[] = [];
    const controller = fakeController(() => {
      seen.push(controller._aggregator.getStartMousePosition(1));
    });
    scene.screenSpaceCameraController = controller;
    install(scene);
    scene.preUpdate.raiseEvent(scene);
    scene.screenSpaceCameraController.update();
    expect(seen).toEqual([new Cartesian2(700, 300)]);
  });

  it('pins the private Cesium members the offset relies on', () => {
    expect(
      typeof (
        ScreenSpaceCameraController.prototype as unknown as Record<
          string,
          unknown
        >
      ).update,
    ).toBe('function');
    const aggregator = CameraEventAggregator.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const method of [
      'getLastMovement',
      'getMovement',
      'getStartMousePosition',
    ])
      expect(typeof aggregator[method]).toBe('function');
  });

  it('restores Cesium on destroy', () => {
    const scene = fakeScene();
    const original = scene.updateAndExecuteCommands;
    const controller = scene.screenSpaceCameraController;
    const { update } = controller;
    const { getMovement } = controller._aggregator;
    const pickWorld = scene.pickPositionWorldCoordinates;
    const offset = installGlobeOffset(scene as unknown as Scene);
    offset.setCoveredLeft(COVERED);
    scene.preUpdate.raiseEvent(scene);
    expect(controller.update).not.toBe(update);
    offset.destroy();
    expect(Object.hasOwn(scene.camera, 'getPickRay')).toBe(false);
    expect(scene.updateAndExecuteCommands).toBe(original);
    expect(controller.update).toBe(update);
    expect(controller._aggregator.getMovement).toBe(getMovement);
    expect(scene.pickPositionWorldCoordinates).toBe(pickWorld);
    expect(scene.preUpdate.numberOfListeners).toBe(0);
  });
});

describe('patchGlobeFragmentShader', () => {
  const globeFs = () =>
    new Globe() as unknown as {
      _surfaceShaderSet: { baseFragmentShaderSource: { sources: string[] } };
    };

  it('rebuilds the per-fragment ground-atmosphere ray from the frustum planes', () => {
    const source =
      globeFs()._surfaceShaderSet.baseFragmentShaderSource.sources.find(
        (candidate) => candidate.includes(GLOBE_FS_MARKER),
      )!;
    expect(source).toContain('xy *= czm_viewport.zw * mpp * 0.5;');
    const patched = patchGlobeFragmentShader(source);
    const body = patched
      .slice(patched.indexOf(GLOBE_FS_MARKER))
      .split('\n}')[0];
    expect(body).not.toContain('czm_viewport.zw * mpp');
    expect(body).toContain('czm_frustumPlanes');
    expect(patchGlobeFragmentShader(patched)).toBe(patched);
  });

  it('leaves other shader sources alone and refuses a GlobeFS it does not recognise', () => {
    expect(patchGlobeFragmentShader('void main() {}')).toBe('void main() {}');
    expect(() =>
      patchGlobeFragmentShader(`${GLOBE_FS_MARKER}\n{\n  return vec3(0.0);\n}`),
    ).toThrow(/computeEllipsoidPosition/);
  });
});
