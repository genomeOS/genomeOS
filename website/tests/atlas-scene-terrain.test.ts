/** The scene's physical-terrain wiring (Atlas design §11; #483): the real scene class over a mocked
 * CesiumWidget, context controller and terrain shading, as in `atlas-scene-load-order.test.ts`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAtlasScene } from '../src/atlas/scene/atlas-scene';
import type { TerrainId } from '../src/atlas/url-state';
import type { AtlasWorkerClient } from '../src/atlas/worker/client';

const harness = vi.hoisted(() => ({
  /** The fake camera's height and the ground under it, and its zoom calls. */
  camera: { ground: 0 as number | undefined, height: 29_600 },
  zooms: [] as ['in' | 'out', number][],
  contextOptions: undefined as
    { onTerrainApplied?: (terrain: TerrainId) => void } | undefined,
  setAppearance: [] as [number, number][],
  contextDestroyed: 0,
  shadingDestroyed: 0,
  updates: [] as Record<string, unknown>[],
}));

function fakeEvent() {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addEventListener(listener: (...args: unknown[]) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// The fake globe has no lighting fields: the scene must route lighting through TerrainShading.
vi.mock('../src/atlas/scene/globe-widget', () => ({
  createGlobeWidget: () => ({
    widget: {
      scene: {
        globe: { getHeight: () => harness.camera.ground },
        mode: 3,
        primitives: { add: vi.fn() },
        renderError: fakeEvent(),
        requestRender: vi.fn(),
      },
      camera: {
        moveEnd: fakeEvent(),
        pitch: -Math.PI / 2,
        get positionCartographic() {
          return { height: harness.camera.height };
        },
        zoomIn: (amount: number) => {
          harness.zooms.push(['in', amount]);
          harness.camera.height -= amount;
        },
        zoomOut: (amount: number) => {
          harness.zooms.push(['out', amount]);
          harness.camera.height += amount;
        },
      },
      resize: vi.fn(),
      render: vi.fn(),
    },
    destroy: vi.fn(),
  }),
}));
vi.mock('../src/atlas/scene/context-controller', () => ({
  ContextController: class {
    constructor(
      _widget: unknown,
      _token: string,
      _url: string,
      _onWarning: unknown,
      options: typeof harness.contextOptions,
    ) {
      harness.contextOptions = options;
    }
    capabilities = () => ({});
    setAppearance = (opacity: number, brightness: number) =>
      harness.setAppearance.push([opacity, brightness]);
    setBasemap = () => Promise.resolve(true);
    destroy = () => {
      harness.contextDestroyed += 1;
    };
  },
}));
vi.mock('../src/atlas/scene/terrain-shading', () => ({
  TerrainShading: class {
    update = (change: Record<string, unknown>) => harness.updates.push(change);
    destroy = () => {
      harness.shadingDestroyed += 1;
    };
  },
}));
vi.mock('../src/atlas/scene/context-overlay', () => ({
  ContextOverlay: class {
    load = () => new Promise(() => {});
    setElevationFactor = () => {};
    setSceneMode = () => Promise.resolve();
  },
}));
vi.mock('../src/atlas/scene/scientific-layers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/atlas/scene/scientific-layers')
  >()),
  ScientificLayers: class {
    destroy = () => {};
    setElevationFactor = () => {};
    setSceneMode = () => Promise.resolve();
  },
}));
vi.mock('../src/atlas/scene/scene-marks', () => ({
  createMarkTracker: () => ({
    destroy: () => {},
    onMark: () => () => {},
    queue: () => {},
  }),
}));
vi.mock('../src/atlas/scene/highlight-layer', () => ({
  HighlightLayer: class {
    collection = {};
    setElevationStyle = () => {};
  },
}));
vi.mock('../src/atlas/scene/camera', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/camera')>()),
  bindKeyboardCamera: () => () => {},
  setCameraState: () => {},
}));
vi.mock('../src/atlas/scene/globe-offset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/globe-offset')>()),
  installGlobeOffset: () => ({ destroy: () => {}, setCoveredLeft: () => {} }),
}));
vi.mock('../src/atlas/scene/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/picking')>()),
  bindAtlasPicking: () => () => {},
}));
vi.mock('../src/atlas/scene/scene-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/scene-policy')>()),
  hideSkyUntilReady: () => () => {},
  styleAtlasScene: () => {},
}));

function scene() {
  return createAtlasScene({} as HTMLElement, {
    frameBudgetMs: 8,
    naturalEarthUrl: 'borders.bin',
    worker: {} as AtlasWorkerClient,
  });
}

const frames: FrameRequestCallback[] = [];

/** Runs the animation frames requested so far. */
function frame(): void {
  for (const callback of frames.splice(0)) callback(0);
}

beforeEach(() => {
  harness.camera.ground = 0;
  harness.camera.height = 29_600;
  harness.zooms.length = 0;
  harness.contextOptions = undefined;
  harness.setAppearance.length = 0;
  harness.contextDestroyed = 0;
  harness.shadingDestroyed = 0;
  harness.updates.length = 0;
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scene terrain wiring (#483)', () => {
  it('routes day/night through the terrain shading, not straight to the globe', () => {
    const controller = scene();
    controller.setMapPresentation(0.8, 0.6, false);
    expect(harness.setAppearance).toEqual([[0.8, 0.6]]);
    expect(harness.updates).toContainEqual({ dayNight: false });
  });

  it('tells the shading which terrain the context controller put on the globe', () => {
    scene();
    harness.contextOptions?.onTerrainApplied?.('world-terrain');
    expect(harness.updates).toContainEqual({ terrain: 'world-terrain' });
  });

  it('tells its listeners which terrain is on the globe, now and as it changes', () => {
    const controller = scene();
    const applied: TerrainId[] = [];
    const remove = controller.onTerrainApplied((terrain) =>
      applied.push(terrain),
    );
    // A new globe starts smooth: World Terrain counts only once its provider is on the globe.
    expect(applied).toEqual(['smooth-globe']);
    harness.contextOptions?.onTerrainApplied?.('world-terrain');
    expect(applied).toEqual(['smooth-globe', 'world-terrain']);
    remove();
    harness.contextOptions?.onTerrainApplied?.('smooth-globe');
    expect(applied).toHaveLength(2);
    // A late listener hears the current terrain.
    const late: TerrainId[] = [];
    harness.contextOptions?.onTerrainApplied?.('world-terrain');
    controller.onTerrainApplied((terrain) => late.push(terrain));
    expect(late).toEqual(['world-terrain']);
  });

  it('tears the shading and the context controller down with the scene', () => {
    scene().destroy();
    expect(harness.shadingDestroyed).toBe(1);
    expect(harness.contextDestroyed).toBe(1);
  });

  it('applies relief once per frame, with the latest slider value', () => {
    const controller = scene();
    controller.setRelief(2);
    controller.setRelief(2.5);
    controller.setRelief(3);
    expect(harness.updates).not.toContainEqual(
      expect.objectContaining({ relief: expect.anything() }),
    );
    frame();
    expect(harness.updates.filter((change) => 'relief' in change)).toEqual([
      { relief: 3 },
    ]);
  });

  it('tells the shading the view, so the 2D map stays at true scale', async () => {
    const controller = scene();
    await controller.setSceneMode('globe', true);
    expect(harness.updates).toContainEqual({ mode: 'globe' });
  });

  it('stops the zoom-in button a kilometre above the ground (#483)', () => {
    const controller = scene();
    controller.zoom('in');
    expect(harness.zooms).toEqual([['in', 28_600]]);
    controller.zoom('in');
    expect(harness.zooms).toHaveLength(1);
    harness.camera.ground = undefined;
    harness.camera.height = 200_000;
    controller.zoom('in');
    expect(harness.zooms[1][0]).toBe('in');
    expect(harness.zooms[1][1]).toBeCloseTo(56_000, 6);
    controller.zoom('out');
    expect(harness.zooms[2][0]).toBe('out');
  });
});
