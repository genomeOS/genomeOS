/**
 * The shifted projection centre that draws the desktop globe in the open area beside the controls
 * panel (fast-load design §A.1.13, amended 2026-10-13; #452). Only the frustum's projection centre
 * moves, never the camera, so the URL view, fly-to, zoom, keyboard controls and every pick keep
 * their meaning.
 *
 * Cesium 1.145 has `PerspectiveFrustum.xOffset`, but a frame does not honour it end to end. This
 * module closes the five gaps, each pinned by tests/atlas-globe-offset.test.ts:
 *
 * 1. `xOffset` is in near-plane metres, and Scene draws each frustum of a frame through a working
 *    clone whose near plane it moves, so a fixed offset would scale with that near plane; and
 *    `PerspectiveFrustum.clone` drops `xOffset` altogether. `ShiftedPerspectiveFrustum` derives its
 *    offset from a fraction of its own width (`projectionShift`, in normalised device coordinates)
 *    at any near plane, and its clones, including those into Cesium's scratch frustums, keep it.
 * 2. `Camera.getPickRay` builds a centred ray. The camera's override casts it through what the
 *    shifted projection draws under the pointer, which `pickEllipsoid`, the surface resolver and
 *    the reveal order all go through.
 * 3. The pick passes behind `scene.pick`, `drillPick` and the translucent depth pick render through
 *    the shifted working frustum but cull to a pick volume built without the shift, around the
 *    point drawn the shift further right. While shifted, each pick pass culls to the camera
 *    frustum's sub-volume behind its own scissor rectangle instead.
 * 4. Beyond `Globe.nightFadeOutDistance` the globe computes its ground atmosphere per fragment and
 *    rebuilds the view ray from `gl_FragCoord` for a centred frustum, which paints the far limb
 *    white. The globe's fragment shader is patched to rebuild it from the frustum planes, which is
 *    the same ray for a centred frustum.
 * 5. `ScreenSpaceCameraController` takes the canvas centre for the view axis: above 1,000 km it
 *    zooms to the cursor by turning the globe towards the ground at the canvas centre, and its tilt
 *    and Columbus-view zoom pivot there, so wheel zoom drifted the ground under the cursor towards
 *    the panel. Each of its updates runs in the frame of a centred view instead: the projection is
 *    centred for the update, the pointer positions it reads move left by the shift, and the depth
 *    it reads is fetched where the shifted frame drew it. Its drag rates are unchanged.
 *
 * The flat map (2D) keeps Cesium's centred orthographic frustum.
 */

import {
  Cartesian2,
  type Cartesian3,
  PerspectiveFrustum,
  PerspectiveOffCenterFrustum,
  SceneMode,
  type Camera,
  type CullingVolume,
  type Globe,
  type Ray,
  type Scene,
} from 'cesium';

import { globeShiftPx, projectionShift } from '../view-offset';

type FrustumOptions = ConstructorParameters<typeof PerspectiveFrustum>[0];

/** Each Cesium scratch frustum gets one shifted stand-in, so per-frame clones allocate nothing. */
const scratchStandIns = new WeakMap<
  PerspectiveFrustum,
  ShiftedPerspectiveFrustum
>();

/** A perspective frustum whose projection centre is shifted sideways by a fraction of its width. */
export class ShiftedPerspectiveFrustum extends PerspectiveFrustum {
  /** In normalised device coordinates (the canvas is 2 wide); positive draws the scene further right. */
  declare projectionShift: number;
  /** An `xOffset` set directly, in near-plane units, which Cesium's own frustum would hold. */
  declare baseXOffset: number;

  constructor(options?: FrustumOptions) {
    super(options);
    this.projectionShift = 0;
  }

  static from(frustum: PerspectiveFrustum): ShiftedPerspectiveFrustum {
    return new ShiftedPerspectiveFrustum({
      aspectRatio: frustum.aspectRatio,
      far: frustum.far,
      fov: frustum.fov,
      near: frustum.near,
      xOffset: frustum.xOffset,
      yOffset: frustum.yOffset,
    });
  }

  override clone(result?: PerspectiveFrustum): ShiftedPerspectiveFrustum {
    let target: ShiftedPerspectiveFrustum;
    if (result instanceof ShiftedPerspectiveFrustum) target = result;
    else if (result) {
      target = scratchStandIns.get(result) ?? new ShiftedPerspectiveFrustum();
      scratchStandIns.set(result, target);
    } else target = new ShiftedPerspectiveFrustum();
    super.clone(target);
    target.projectionShift = this.projectionShift;
    target.baseXOffset = this.baseXOffset;
    target.yOffset = this.yOffset;
    return target;
  }
}

// PerspectiveFrustum reads `xOffset` whenever it rebuilds its projection, so an accessor keeps the
// shift a fixed fraction of the frustum's width at whatever near plane it is given. (Declared on
// the prototype: TypeScript does not let a subclass turn a property into an accessor.)
Object.defineProperty(ShiftedPerspectiveFrustum.prototype, 'xOffset', {
  configurable: true,
  enumerable: true,
  get(this: ShiftedPerspectiveFrustum): number {
    // Both fields are still undefined while the PerspectiveFrustum constructor runs.
    const base = this.baseXOffset || 0;
    const shift = this.projectionShift || 0;
    const { aspectRatio, fov, near } = this;
    if (shift === 0 || aspectRatio === undefined || fov === undefined)
      return base;
    // The near plane's half-width: PerspectiveFrustum spans `fov` across the wider side.
    return base - shift * near * Math.tan(fov / 2) * Math.min(1, aspectRatio);
  },
  set(this: ShiftedPerspectiveFrustum, value: number) {
    this.baseXOffset = value;
  },
});

function shiftPxOf(camera: Camera, canvasWidth: number): number {
  const { frustum } = camera;
  return frustum instanceof ShiftedPerspectiveFrustum
    ? (frustum.projectionShift * canvasWidth) / 2
    : 0;
}

/**
 * The window position (CSS px) where the camera's view axis is drawn: the canvas centre moved by
 * the current shift, which is the centre of the open area beside the panel.
 */
export function viewCentre(
  scene: Pick<Scene, 'camera' | 'canvas'>,
  result = new Cartesian2(),
): Cartesian2 {
  const { clientHeight, clientWidth } = scene.canvas;
  result.x = clientWidth / 2 + shiftPxOf(scene.camera, clientWidth);
  result.y = clientHeight / 2;
  return result;
}

interface PickRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

const pickFrustum = new PerspectiveOffCenterFrustum();

/**
 * The camera frustum's sub-volume behind a drawing-buffer rectangle (GL origin at the bottom left),
 * one pixel wider on each side. It replaces Cesium's pick volume, which is centred on the pointer
 * as if the projection were not shifted (Picking.js `getPickPerspectiveCullingVolume`).
 */
function pickRegionCullingVolume(
  camera: Camera,
  frustum: ShiftedPerspectiveFrustum,
  rectangle: PickRectangle,
  bufferWidth: number,
  bufferHeight: number,
): CullingVolume {
  const halfHeight = frustum.near * Math.tan((frustum.fovy ?? 0) * 0.5);
  const halfWidth = (frustum.aspectRatio ?? 1) * halfHeight;
  const left = -halfWidth + frustum.xOffset;
  const bottom = -halfHeight + frustum.yOffset;
  const x = (px: number) => left + (px / bufferWidth) * 2 * halfWidth;
  const y = (px: number) => bottom + (px / bufferHeight) * 2 * halfHeight;
  pickFrustum.left = x(rectangle.x - 1);
  pickFrustum.right = x(rectangle.x + rectangle.width + 1);
  pickFrustum.bottom = y(rectangle.y - 1);
  pickFrustum.top = y(rectangle.y + rectangle.height + 1);
  pickFrustum.near = frustum.near;
  pickFrustum.far = frustum.far;
  return pickFrustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );
}

const GLOBE_FS_FUNCTION = 'vec3 computeEllipsoidPosition()';
const PATCH_MARKER = 'Atlas #452';
const CENTRED_RAY =
  /float mpp = czm_metersPerPixel\(vec4\(0\.0, 0\.0, -czm_currentFrustum\.x, 1\.0\), 1\.0\);\s*vec2 xy = gl_FragCoord\.xy \/ czm_viewport\.zw \* 2\.0 - vec2\(1\.0\);\s*xy \*= czm_viewport\.zw \* mpp \* 0\.5;/;
const FRUSTUM_RAY = `// ${PATCH_MARKER}: the near-plane point under this fragment, from the frustum planes,
    // which also holds for a frustum whose projection centre is shifted.
    vec2 ndc = gl_FragCoord.xy / czm_viewport.zw * 2.0 - vec2(1.0);
    vec2 xy = 0.5 * vec2(
        ndc.x * (czm_frustumPlanes.w - czm_frustumPlanes.z) + czm_frustumPlanes.z + czm_frustumPlanes.w,
        ndc.y * (czm_frustumPlanes.x - czm_frustumPlanes.y) + czm_frustumPlanes.y + czm_frustumPlanes.x);`;

/**
 * Cesium's GlobeFS with `computeEllipsoidPosition` taking its view ray from the frustum planes
 * instead of a centred frustum; other sources pass through. A GlobeFS this does not recognise
 * throws, so a Cesium upgrade that changes it fails the unit tests instead of drawing a white limb.
 */
export function patchGlobeFragmentShader(source: string): string {
  if (!source.includes(GLOBE_FS_FUNCTION) || source.includes(PATCH_MARKER))
    return source;
  if (!CENTRED_RAY.test(source))
    throw new Error(
      `Cesium's ${GLOBE_FS_FUNCTION} changed; the globe offset (#452) cannot patch its ground-atmosphere ray.`,
    );
  return source.replace(CENTRED_RAY, FRUSTUM_RAY);
}

interface ShaderSourceLike {
  sources: string[];
}

/** Patches the globe's fragment shader now and whenever Cesium rebuilds it (terrain, material). */
function patchGlobeShaders(globe: Globe | undefined): () => void {
  if (!globe) return () => undefined;
  const shaderSet = (
    globe as unknown as {
      _surfaceShaderSet?: { baseFragmentShaderSource?: ShaderSourceLike };
    }
  )._surfaceShaderSet;
  if (!shaderSet)
    throw new Error(
      "Cesium's globe has no surface shader set; the globe offset (#452) cannot patch it.",
    );
  const patch = (source: ShaderSourceLike | undefined) => {
    if (source) source.sources = source.sources.map(patchGlobeFragmentShader);
    return source;
  };
  let current = patch(shaderSet.baseFragmentShaderSource);
  Object.defineProperty(shaderSet, 'baseFragmentShaderSource', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (source: ShaderSourceLike | undefined) => {
      current = patch(source);
    },
  });
  return () => {
    Object.defineProperty(shaderSet, 'baseFragmentShaderSource', {
      configurable: true,
      enumerable: true,
      value: current,
      writable: true,
    });
  };
}

/** Replaces one member of a Cesium object and returns the undo, own or inherited alike. */
function override<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  target[key] = value;
  return () => {
    if (own) Object.defineProperty(target, key, own);
    else Reflect.deleteProperty(target, key);
  };
}

interface PickPassState {
  scissorTest?: { enabled: boolean; rectangle: PickRectangle };
}

/** Scene members Cesium 1.145 marks private: the pick passes' frame state and their render entry. */
interface SceneInternals {
  frameState: {
    cullingVolume: CullingVolume;
    passes: { pick?: boolean; pickVoxel?: boolean };
  };
  updateAndExecuteCommands(
    passState: PickPassState,
    backgroundColor: unknown,
  ): void;
}

interface PointerMovement {
  startPosition?: Cartesian2;
  endPosition?: Cartesian2;
}

/** Cesium 1.145's private `CameraEventAggregator` methods that hand the controller window positions. */
interface CameraInputs {
  getLastMovement(type: number, modifier?: number): PointerMovement | undefined;
  getMovement(type: number, modifier?: number): PointerMovement | undefined;
  getStartMousePosition(type: number, modifier?: number): Cartesian2;
}

interface CameraControllerInternals {
  _aggregator: CameraInputs;
  update(): void;
}

interface DepthPickScene {
  pickPositionWorldCoordinates(
    windowPosition: Cartesian2,
    result?: Cartesian3,
  ): Cartesian3 | undefined;
}

function movedLeft(position: Cartesian2, px: number): Cartesian2 {
  return new Cartesian2(position.x - px, position.y);
}

/**
 * Gap 5: runs each update of Cesium's camera controller in the frame of a centred view, where its
 * canvas centre is the view axis again. Returns the undo.
 */
function centreCameraController(scene: Scene): () => void {
  const { camera } = scene;
  const controller =
    scene.screenSpaceCameraController as unknown as CameraControllerInternals;
  const inputs = controller._aggregator;
  const depthScene = scene as unknown as DepthPickScene;
  // Non-zero only while the controller updates: the shift its frame leaves out, in CSS px and NDC.
  let shiftPx = 0;
  let drawnShift = 0;

  const centredMovement = (movement: PointerMovement | undefined) => {
    if (!movement || shiftPx === 0) return movement;
    const copy = { ...movement };
    if (movement.startPosition)
      copy.startPosition = movedLeft(movement.startPosition, shiftPx);
    if (movement.endPosition)
      copy.endPosition = movedLeft(movement.endPosition, shiftPx);
    return copy;
  };
  const { getLastMovement, getMovement, getStartMousePosition } = inputs;
  const restoreInputs = [
    override(inputs, 'getLastMovement', (type, modifier) =>
      centredMovement(getLastMovement.call(inputs, type, modifier)),
    ),
    override(inputs, 'getMovement', (type, modifier) =>
      centredMovement(getMovement.call(inputs, type, modifier)),
    ),
    override(inputs, 'getStartMousePosition', (type, modifier) => {
      const position = getStartMousePosition.call(inputs, type, modifier);
      return shiftPx === 0 ? position : movedLeft(position, shiftPx);
    }),
  ];

  const pickWorld = depthScene.pickPositionWorldCoordinates;
  const drawnPosition = new Cartesian2();
  const restorePickWorld = override(
    depthScene,
    'pickPositionWorldCoordinates',
    function (
      this: DepthPickScene,
      windowPosition: Cartesian2,
      result?: Cartesian3,
    ) {
      const { frustum } = camera;
      if (shiftPx === 0 || !(frustum instanceof ShiftedPerspectiveFrustum))
        return pickWorld.call(this, windowPosition, result);
      // The depth was drawn through the shifted frustum: read it there, and unproject with it.
      drawnPosition.x = windowPosition.x + shiftPx;
      drawnPosition.y = windowPosition.y;
      frustum.projectionShift = drawnShift;
      try {
        return pickWorld.call(this, drawnPosition, result);
      } finally {
        frustum.projectionShift = 0;
      }
    },
  );

  const update = controller.update;
  const restoreUpdate = override(
    controller,
    'update',
    function (this: CameraControllerInternals) {
      const { frustum } = camera;
      const px = shiftPxOf(camera, scene.canvas.clientWidth);
      if (px === 0 || !(frustum instanceof ShiftedPerspectiveFrustum)) {
        update.call(this);
        return;
      }
      drawnShift = frustum.projectionShift;
      shiftPx = px;
      frustum.projectionShift = 0;
      try {
        update.call(this);
      } finally {
        frustum.projectionShift = drawnShift;
        shiftPx = 0;
      }
    },
  );

  return () => {
    restoreUpdate();
    restorePickWorld();
    for (const restore of restoreInputs) restore();
  };
}

export interface GlobeOffset {
  /** CSS px of the canvas, measured from its left edge, under the controls panel; 0 when none. */
  setCoveredLeft(width: number): void;
  destroy(): void;
}

export function installGlobeOffset(scene: Scene): GlobeOffset {
  const { camera } = scene;
  const internals = scene as unknown as SceneInternals;
  let covered = 0;

  // Cesium swaps in a plain frustum when it morphs between views; the next frame upgrades it. A
  // frustum is left alone mid-morph, where the transition animates the one it holds.
  const applyShift = () => {
    let { frustum } = camera;
    if (
      !(frustum instanceof ShiftedPerspectiveFrustum) &&
      frustum instanceof PerspectiveFrustum &&
      scene.mode !== SceneMode.MORPHING
    ) {
      frustum = ShiftedPerspectiveFrustum.from(frustum);
      camera.frustum = frustum;
    }
    if (frustum instanceof ShiftedPerspectiveFrustum) {
      const width = scene.canvas.clientWidth;
      frustum.projectionShift = projectionShift(
        globeShiftPx(covered, width),
        width,
      );
    }
  };

  const centredPickRay = camera.getPickRay;
  const shiftedPosition = new Cartesian2();
  const restorePickRay = override(
    camera,
    'getPickRay',
    function (this: Camera, windowPosition: Cartesian2, result?: Ray) {
      const shiftPx = shiftPxOf(camera, scene.canvas.clientWidth);
      if (shiftPx === 0)
        return centredPickRay.call(this, windowPosition, result);
      shiftedPosition.x = windowPosition.x - shiftPx;
      shiftedPosition.y = windowPosition.y;
      return centredPickRay.call(this, shiftedPosition, result);
    },
  );

  const execute = internals.updateAndExecuteCommands;
  const restoreExecute = override(
    internals,
    'updateAndExecuteCommands',
    function (
      this: SceneInternals,
      passState: PickPassState,
      backgroundColor: unknown,
    ) {
      const { frameState } = internals;
      const { frustum } = camera;
      const scissor = passState?.scissorTest;
      if (
        (frameState.passes.pick || frameState.passes.pickVoxel) &&
        scissor?.enabled &&
        frustum instanceof ShiftedPerspectiveFrustum &&
        frustum.projectionShift !== 0
      )
        frameState.cullingVolume = pickRegionCullingVolume(
          camera,
          frustum,
          scissor.rectangle,
          scene.drawingBufferWidth,
          scene.drawingBufferHeight,
        );
      execute.call(this, passState, backgroundColor);
    },
  );

  const restoreShaders = patchGlobeShaders(scene.globe);
  const restoreController = centreCameraController(scene);
  const removeListener = scene.preUpdate.addEventListener(applyShift);
  applyShift();

  return {
    setCoveredLeft(width) {
      const next = Number.isFinite(width) ? Math.max(0, width) : 0;
      if (next === covered) return;
      covered = next;
      applyShift();
      scene.requestRender();
    },
    destroy() {
      removeListener();
      restorePickRay();
      restoreExecute();
      restoreShaders();
      restoreController();
    },
  };
}
