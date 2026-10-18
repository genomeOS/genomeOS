/** The zoom floor of the button and keyboard zoom (Atlas design §11; #483): they never take the
 * camera below the ground under it plus `ZOOM_FLOOR_METRES`, on the smooth globe and on terrain. */
import { Cartographic, Math as CesiumMath, type CesiumWidget } from 'cesium';
import { describe, expect, it, vi } from 'vitest';

import {
  ZOOM_FLOOR_METRES,
  bindKeyboardCamera,
  zoomCamera,
  zoomInDistance,
} from '../src/atlas/scene/camera';

describe('zoomInDistance', () => {
  it('keeps the floor at a kilometre', () => {
    expect(ZOOM_FLOOR_METRES).toBe(1_000);
  });

  it('stops a straight-down zoom at the floor (the live 29.6 km → −20.4 km case)', () => {
    expect(
      zoomInDistance({
        descent: 1,
        ground: 0,
        height: 29_600,
        requested: 50_000,
      }),
    ).toBe(28_600);
  });

  it('measures the floor from the ground, not sea level', () => {
    expect(
      zoomInDistance({
        descent: 1,
        ground: 6_000,
        height: 7_500,
        requested: 50_000,
      }),
    ).toBe(500);
  });

  it('leaves a zoom that stays above the floor alone', () => {
    expect(
      zoomInDistance({
        descent: 1,
        ground: 2_000,
        height: 500_000,
        requested: 140_000,
      }),
    ).toBe(140_000);
  });

  it('does not descend from at or below the floor', () => {
    for (const height of [1_000, 800, -20])
      expect(
        zoomInDistance({ descent: 1, ground: 0, height, requested: 50_000 }),
      ).toBe(0);
  });

  it('lets a tilted camera travel further for the same drop', () => {
    expect(
      zoomInDistance({
        descent: Math.sin(CesiumMath.toRadians(30)),
        ground: 0,
        height: 10_000,
        requested: 50_000,
      }),
    ).toBeCloseTo(18_000, 6);
  });

  it('never limits a camera that is not looking down', () => {
    expect(
      zoomInDistance({ descent: 0, ground: 0, height: 900, requested: 20_000 }),
    ).toBe(20_000);
  });
});

/** A camera whose zoom moves it along its view direction, as Cesium's does in 3D. */
function fakeCamera(height: number, pitchDegrees = -90) {
  const camera = {
    pitch: CesiumMath.toRadians(pitchDegrees),
    positionCartographic: Cartographic.fromDegrees(86.9, 27.98, height),
    zoomIn: vi.fn((amount: number) => {
      camera.positionCartographic.height -= amount * Math.sin(-camera.pitch);
    }),
    zoomOut: vi.fn((amount: number) => {
      camera.positionCartographic.height += amount * Math.sin(-camera.pitch);
    }),
  };
  return camera;
}

describe('zoomCamera', () => {
  it('zooms in no lower than the floor above the ground under the camera', () => {
    const camera = fakeCamera(29_600);
    const globe = { getHeight: vi.fn(() => 8_000) };
    zoomCamera(camera, globe, 'in', 50_000);
    expect(globe.getHeight).toHaveBeenCalledWith(camera.positionCartographic);
    expect(camera.zoomIn).toHaveBeenCalledWith(20_600);
    expect(camera.positionCartographic.height).toBe(9_000);
  });

  it('treats unloaded ground as sea level', () => {
    const camera = fakeCamera(29_600);
    zoomCamera(camera, { getHeight: () => undefined }, 'in', 50_000);
    expect(camera.positionCartographic.height).toBe(ZOOM_FLOOR_METRES);
  });

  it('does nothing at the floor', () => {
    const camera = fakeCamera(1_000);
    zoomCamera(camera, { getHeight: () => 0 }, 'in', 50_000);
    expect(camera.zoomIn).not.toHaveBeenCalled();
  });

  it('backs off when the ground ahead of a tilted camera rises above the floor', () => {
    const camera = fakeCamera(12_000, -30);
    // Flat ground under the start, a 7 km ridge under where the zoom lands.
    const globe = {
      getHeight: vi.fn(() =>
        camera.zoomIn.mock.calls.length === 0 ? 0 : 7_000,
      ),
    };
    zoomCamera(camera, globe, 'in', 50_000);
    expect(camera.zoomIn.mock.calls[0][0]).toBeCloseTo(22_000, 6);
    expect(camera.positionCartographic.height).toBeCloseTo(8_000, 6);
  });

  it('ignores a zoom-in while the scene morphs between views, rather than zooming by NaN', () => {
    // Cesium's Camera.pitch is undefined while the scene is MORPHING; the buttons and keys stay
    // live through the morph, and the morph rewrites the camera each frame anyway.
    const camera = {
      ...fakeCamera(29_600),
      pitch: undefined as unknown as number,
    };
    zoomCamera(camera, { getHeight: () => 0 }, 'in', 50_000);
    expect(camera.zoomIn).not.toHaveBeenCalled();
    expect(camera.zoomOut).not.toHaveBeenCalled();
  });

  it('never limits zooming out', () => {
    const camera = fakeCamera(1_000);
    zoomCamera(camera, { getHeight: () => 900 }, 'out', 50_000);
    expect(camera.zoomOut).toHaveBeenCalledWith(50_000);
  });
});

describe('keyboard zoom', () => {
  function keyboard(height: number, ground: number) {
    let listener: ((event: KeyboardEvent) => void) | undefined;
    const container = {
      addEventListener: (_type: string, added: typeof listener) => {
        listener = added;
      },
      hasAttribute: () => true,
      removeEventListener: () => {},
    };
    const camera = fakeCamera(height);
    const widget = {
      camera,
      scene: { globe: { getHeight: () => ground } },
    };
    bindKeyboardCamera(
      widget as unknown as CesiumWidget,
      container as unknown as HTMLElement,
    );
    const press = (key: string) =>
      listener?.({
        key,
        preventDefault: () => {},
        target: null,
      } as unknown as KeyboardEvent);
    return { camera, press };
  }

  it('stops + at the floor above the ground', () => {
    const { camera, press } = keyboard(25_000, 4_000);
    for (let step = 0; step < 20; step++) press('+');
    expect(camera.positionCartographic.height).toBeCloseTo(
      4_000 + ZOOM_FLOOR_METRES,
      6,
    );
  });

  it('still zooms out with -', () => {
    const { camera, press } = keyboard(5_000, 4_000);
    press('-');
    expect(camera.positionCartographic.height).toBe(25_000);
  });
});
