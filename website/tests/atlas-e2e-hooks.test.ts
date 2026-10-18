/** The e2e build's camera motion hook (fast-load design §B.8; #453) and drape stats reader
 * (terrain draping design, "Performance budget and measurement"; #483). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CAMERA_QUIET_MS,
  CAMERA_STILL_TOLERANCE,
  cameraMotionTestHook,
  drapeStatsTestHook,
} from '../src/atlas/e2e-hooks';
import type { DrapeStats } from '../src/atlas/scene/types';

const STATS: DrapeStats = {
  delivered: 3,
  empty: 1,
  queueDepth: 0,
  rasterMs: {
    counts: [1, 1, 0, 0, 0, 0, 0],
    upperMs: [0.5, 1, 2, 4, 8, 16, Infinity],
  },
  requested: 4,
  residentBytes: 349_525,
};

/** A Cesium-like scene whose frames the test draws: its camera's pose and its `postRender`. */
function scene() {
  const listeners = new Set<() => void>();
  const camera = {
    directionWC: { x: -1, y: 0, z: 0 },
    frustum: { fov: 1 } as {
      fov?: number;
      right?: number;
      top?: number;
      width?: number;
    },
    positionWC: { x: 6_778_137, y: 0, z: 0 },
    upWC: { x: 0, y: 0, z: 1 },
  };
  return {
    camera,
    postRender: {
      addEventListener(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    count: () => listeners.size,
    draw() {
      for (const listener of [...listeners]) listener();
    },
  };
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
    const frames = scene();
    expect(cameraMotionTestHook(frames)).toBeUndefined();
    expect(page.__atlasCameraMotion).toBeUndefined();
    expect(frames.count()).toBe(0);
  });

  it('reads a flight as flying from the call that starts it until it settles', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const hook = cameraMotionTestHook(scene())!;
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
    const hook = cameraMotionTestHook(scene())!;
    const first = hook.flight();
    const second = hook.flight();
    // Cesium cancels the first flight as the second starts.
    first();
    expect(page.__atlasCameraMotion!().flying).toBe(true);
    second();
    expect(page.__atlasCameraMotion!().flying).toBe(false);
  });

  it('reads the camera as moving for half a second after a drawn frame moves it', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    let now = 1_000;
    const frames = scene();
    cameraMotionTestHook(frames, () => now);
    const moving = () => page.__atlasCameraMotion!().moving;
    frames.draw();
    expect(moving()).toBe(false);
    frames.camera.positionWC = { x: 6_778_137, y: 1_000, z: 0 };
    now = 1_016;
    frames.draw();
    expect(moving()).toBe(true);
    expect(CAMERA_QUIET_MS).toBe(500);
    // At rest from then on, with or without another frame.
    now = 1_515;
    frames.draw();
    expect(moving()).toBe(true);
    now = 1_516;
    expect(moving()).toBe(false);
  });

  it("reads the camera's float drift as still, though it crosses Cesium's moveEnd epsilon", () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    let now = 0;
    const frames = scene();
    cameraMotionTestHook(frames, () => now);
    frames.draw();
    // About what Cesium's per-frame heading and roll reads leave behind (1e-15 at EPSILON15).
    for (let frame = 1; frame <= 60; frame += 1) {
      now = frame * 8;
      const sign = frame % 2 === 0 ? 1 : -1;
      frames.camera.directionWC = { x: -1, y: sign * 1.2e-15, z: 0 };
      frames.camera.positionWC = {
        x: 6_778_137 * (1 + sign * 2e-15),
        y: 0,
        z: 0,
      };
      frames.draw();
      expect(page.__atlasCameraMotion!().moving, `frame ${frame}`).toBe(false);
    }
    expect(CAMERA_STILL_TOLERANCE).toBe(1e-12);
  });

  it('reads a turn, a tilt and a 2D zoom, which moves only the frustum, as moves', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    let now = 0;
    const frames = scene();
    cameraMotionTestHook(frames, () => now);
    frames.draw();
    const moves: (() => void)[] = [
      () => (frames.camera.directionWC = { x: -0.99, y: 0.141, z: 0 }),
      () => (frames.camera.upWC = { x: 0.01, y: 0, z: 0.99995 }),
      () => (frames.camera.frustum = { right: 2e6, top: 1e6 }),
      () => (frames.camera.frustum = { right: 1.9e6, top: 0.95e6 }),
    ];
    for (const move of moves) {
      now += 1_000;
      move();
      frames.draw();
      expect(page.__atlasCameraMotion!().moving).toBe(true);
    }
  });

  it('removes its listener and only its own reader when destroyed', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const oldFrames = scene();
    const old = cameraMotionTestHook(oldFrames)!;
    const newer = cameraMotionTestHook(scene())!;
    const reader = page.__atlasCameraMotion;
    old.destroy();
    expect(oldFrames.count()).toBe(0);
    expect(page.__atlasCameraMotion).toBe(reader);
    newer.destroy();
    expect(page.__atlasCameraMotion).toBeUndefined();
  });
});

describe('drapeStatsTestHook', () => {
  it('publishes nothing outside the e2e build', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '');
    expect(drapeStatsTestHook(() => STATS)).toBeUndefined();
    expect(page.__atlasDrapeStats).toBeUndefined();
  });

  it('publishes the reader and removes only its own', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const remove = drapeStatsTestHook(() => STATS)!;
    expect(page.__atlasDrapeStats!()).toBe(STATS);
    const newer = () => STATS;
    page.__atlasDrapeStats = newer;
    remove();
    expect(page.__atlasDrapeStats).toBe(newer);
  });

  it('unpublishes its own reader', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    drapeStatsTestHook(() => STATS)!();
    expect(page.__atlasDrapeStats).toBeUndefined();
  });
});
