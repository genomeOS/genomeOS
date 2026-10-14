/** The e2e build's camera motion hook (fast-load design §B.8; #453). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cameraMotionTestHook } from '../src/atlas/e2e-hooks';

/** A Cesium-like camera whose move events the test raises. */
function camera() {
  const listeners = {
    moveEnd: new Set<() => void>(),
    moveStart: new Set<() => void>(),
  };
  const event = (name: keyof typeof listeners) => ({
    addEventListener(listener: () => void) {
      listeners[name].add(listener);
      return () => {
        listeners[name].delete(listener);
      };
    },
    raise() {
      for (const listener of listeners[name]) listener();
    },
    count: () => listeners[name].size,
  });
  return { moveEnd: event('moveEnd'), moveStart: event('moveStart') };
}

function published(): Window {
  const page = {} as Window;
  vi.stubGlobal('window', page);
  return page;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cameraMotionTestHook', () => {
  it('publishes nothing outside the e2e build', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '');
    const moves = camera();
    expect(cameraMotionTestHook(moves)).toBeUndefined();
    expect(page.__atlasCameraMotion).toBeUndefined();
    expect(moves.moveStart.count()).toBe(0);
  });

  it('reads a flight as flying from the call that starts it until it settles', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const hook = cameraMotionTestHook(camera())!;
    const read = () => page.__atlasCameraMotion!();
    expect(read()).toEqual({ flying: false, moving: false });
    // Before the flight's first frame has moved the camera.
    const settle = hook.flight();
    expect(read()).toEqual({ flying: true, moving: false });
    settle();
    expect(read()).toEqual({ flying: false, moving: false });
  });

  it('waits for the newest flight when one cancels another', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const hook = cameraMotionTestHook(camera())!;
    const first = hook.flight();
    const second = hook.flight();
    // Cesium cancels the first flight as the second starts.
    first();
    expect(page.__atlasCameraMotion!().flying).toBe(true);
    second();
    expect(page.__atlasCameraMotion!().flying).toBe(false);
  });

  it("reads the camera as moving from Cesium's moveStart to its moveEnd", () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const moves = camera();
    cameraMotionTestHook(moves);
    moves.moveStart.raise();
    expect(page.__atlasCameraMotion!()).toEqual({
      flying: false,
      moving: true,
    });
    moves.moveEnd.raise();
    expect(page.__atlasCameraMotion!()).toEqual({
      flying: false,
      moving: false,
    });
  });

  it('removes its listeners and only its own reader when destroyed', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const oldMoves = camera();
    const old = cameraMotionTestHook(oldMoves)!;
    const newer = cameraMotionTestHook(camera())!;
    const reader = page.__atlasCameraMotion;
    old.destroy();
    expect(oldMoves.moveStart.count()).toBe(0);
    expect(oldMoves.moveEnd.count()).toBe(0);
    expect(page.__atlasCameraMotion).toBe(reader);
    newer.destroy();
    expect(page.__atlasCameraMotion).toBeUndefined();
  });
});
