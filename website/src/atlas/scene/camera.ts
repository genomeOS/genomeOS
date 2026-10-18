/** Camera serialization and focus-scoped keyboard controls for Atlas design §11. */

import {
  Cartesian3,
  Math as CesiumMath,
  type Cartographic,
  type CesiumWidget,
} from 'cesium';

import type { CameraState } from '../url-state';

export type KeyboardCommand =
  | 'pan-left'
  | 'pan-right'
  | 'pan-up'
  | 'pan-down'
  | 'look-up'
  | 'look-down'
  | 'zoom-in'
  | 'zoom-out';

interface KeyboardInput {
  key: string;
  target: EventTarget | null;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

function canonicalCameraNumber(value: number): number {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isEditable(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as HTMLElement;
  return (
    element.isContentEditable ||
    ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(element.tagName)
  );
}

export function keyboardCommandFor(
  input: KeyboardInput,
): KeyboardCommand | null {
  if (
    isEditable(input.target) ||
    input.altKey ||
    input.ctrlKey ||
    input.metaKey
  )
    return null;
  const commandByKey: Record<string, KeyboardCommand> = {
    '+': 'zoom-in',
    '=': 'zoom-in',
    '-': 'zoom-out',
    ArrowDown: 'pan-down',
    ArrowLeft: 'pan-left',
    ArrowRight: 'pan-right',
    ArrowUp: 'pan-up',
    a: 'pan-left',
    d: 'pan-right',
    e: 'look-down',
    q: 'look-up',
    s: 'pan-down',
    w: 'pan-up',
  };
  return (
    commandByKey[input.key] ?? commandByKey[input.key.toLowerCase()] ?? null
  );
}

export function cameraState(widget: CesiumWidget): CameraState | null {
  const cartographic = widget.camera.positionCartographic;
  const radians = [
    cartographic?.latitude,
    cartographic?.longitude,
    widget.camera.heading,
    widget.camera.pitch,
  ];
  if (
    !cartographic ||
    !Number.isFinite(cartographic.height) ||
    radians.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }
  return {
    heading: canonicalCameraNumber(CesiumMath.toDegrees(widget.camera.heading)),
    height: canonicalCameraNumber(cartographic.height),
    lat: canonicalCameraNumber(CesiumMath.toDegrees(cartographic.latitude)),
    lon: canonicalCameraNumber(CesiumMath.toDegrees(cartographic.longitude)),
    pitch: canonicalCameraNumber(CesiumMath.toDegrees(widget.camera.pitch)),
  };
}

/**
 * Moves the camera to `state`, in a 1.2 s flight when `animated`. `settled` runs once the camera
 * stands there, or once the flight is cancelled (a newer flight or a scene morph cancels it).
 */
export function setCameraState(
  widget: CesiumWidget,
  state: CameraState,
  animated: boolean,
  settled?: () => void,
): void {
  const destination = Cartesian3.fromDegrees(
    state.lon,
    state.lat,
    state.height,
  );
  const orientation = {
    heading: CesiumMath.toRadians(state.heading),
    pitch: CesiumMath.toRadians(state.pitch),
    roll: 0,
  };
  if (animated)
    widget.camera.flyTo({
      destination,
      duration: 1.2,
      orientation,
      ...(settled && { cancel: settled, complete: settled }),
    });
  else {
    widget.camera.setView({ destination, orientation });
    settled?.();
  }
}

/**
 * The lowest the zoom-in button and keys take the camera: this far above the ground under it
 * (#483). Their steps are fixed fractions of the height (at least 50 km and 20 km), so a step
 * from a few tens of kilometres went underground, where Cesium's collision handling left the
 * camera about a metre above one tile, a grey screen. A kilometre keeps a readable view of the
 * landscape below. Mouse-wheel and pinch zoom keep Cesium's own behaviour.
 */
export const ZOOM_FLOOR_METRES = 1_000;

/**
 * How far a zoom-in may move along the view direction: `requested`, cut so the camera ends at
 * least `floor` above `ground`. `descent` is the height lost per metre travelled (the sine of
 * the downward pitch); a camera that is not looking down is not limited, and one already at or
 * below the floor does not descend.
 */
export function zoomInDistance({
  descent,
  floor = ZOOM_FLOOR_METRES,
  ground,
  height,
  requested,
}: {
  descent: number;
  floor?: number;
  ground: number;
  height: number;
  requested: number;
}): number {
  if (descent <= 0) return requested;
  return Math.min(requested, Math.max(0, height - ground - floor) / descent);
}

export interface ZoomCamera {
  readonly pitch: number;
  readonly positionCartographic: Cartographic;
  zoomIn(amount: number): void;
  zoomOut(amount: number): void;
}

export interface ZoomGlobe {
  getHeight(cartographic: Cartographic): number | undefined;
}

/**
 * A button or keyboard zoom of `requested` metres that never ends below `ZOOM_FLOOR_METRES` above
 * the ground under the camera, on the smooth globe and on terrain (ground not yet loaded counts as
 * sea level). Ground ahead of a tilted camera can rise above the ground it started over, so the
 * camera backs off along its view line if it lands below the floor there.
 */
export function zoomCamera(
  camera: ZoomCamera,
  globe: ZoomGlobe | undefined,
  direction: 'in' | 'out',
  requested: number,
): void {
  if (direction === 'out') {
    camera.zoomOut(requested);
    return;
  }
  const ground = () => globe?.getHeight(camera.positionCartographic) ?? 0;
  const descent = Math.sin(-camera.pitch);
  const distance = zoomInDistance({
    descent,
    ground: ground(),
    height: camera.positionCartographic.height,
    requested,
  });
  if (distance <= 0) return;
  camera.zoomIn(distance);
  const shortfall =
    ground() + ZOOM_FLOOR_METRES - camera.positionCartographic.height;
  if (shortfall > 0 && descent > 0)
    camera.zoomOut(Math.min(distance, shortfall / descent));
}

function runCommand(widget: CesiumWidget, command: KeyboardCommand): void {
  const distance = Math.max(
    20_000,
    widget.camera.positionCartographic.height * 0.06,
  );
  const angle = CesiumMath.toRadians(3);
  const actions: Record<KeyboardCommand, () => void> = {
    'pan-down': () => widget.camera.moveDown(distance),
    'pan-left': () => widget.camera.moveLeft(distance),
    'pan-right': () => widget.camera.moveRight(distance),
    'pan-up': () => widget.camera.moveUp(distance),
    'look-down': () => widget.camera.lookDown(angle),
    'look-up': () => widget.camera.lookUp(angle),
    'zoom-in': () =>
      zoomCamera(widget.camera, widget.scene.globe, 'in', distance),
    'zoom-out': () =>
      zoomCamera(widget.camera, widget.scene.globe, 'out', distance),
  };
  actions[command]();
}

export function bindKeyboardCamera(
  widget: CesiumWidget,
  container: HTMLElement,
): () => void {
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
  const listener = (event: KeyboardEvent) => {
    const command = keyboardCommandFor(event);
    if (command === null) return;
    event.preventDefault();
    runCommand(widget, command);
  };
  container.addEventListener('keydown', listener);
  return () => container.removeEventListener('keydown', listener);
}
