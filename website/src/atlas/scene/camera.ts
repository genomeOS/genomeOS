/** Camera serialization and focus-scoped keyboard controls for Atlas design §11. */

import { Cartesian3, Math as CesiumMath, type CesiumWidget } from 'cesium';

import type { CameraState } from '../url-state';

export type KeyboardCommand =
  | 'pan-left'
  | 'pan-right'
  | 'pan-up'
  | 'pan-down'
  | 'tilt-up'
  | 'tilt-down'
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
    e: 'tilt-down',
    q: 'tilt-up',
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
    'tilt-down': () => widget.camera.lookDown(angle),
    'tilt-up': () => widget.camera.lookUp(angle),
    'zoom-in': () => widget.camera.zoomIn(distance),
    'zoom-out': () => widget.camera.zoomOut(distance),
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
