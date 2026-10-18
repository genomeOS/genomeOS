/** The scene's physical-terrain wiring (Atlas design §11; #483): the real scene class over a mocked
 * CesiumWidget, context controller and terrain shading, as in `atlas-scene-load-order.test.ts`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAtlasScene } from '../src/atlas/scene/atlas-scene';
import type { TerrainId } from '../src/atlas/url-state';
import type { AtlasWorkerClient } from '../src/atlas/worker/client';

const harness = vi.hoisted(() => ({
  contextOptions: undefined as
    { onTerrainApplied?: (terrain: TerrainId) => void } | undefined,
  setAppearance: [] as [number, number][],
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

// No globe on the fake scene: the scene must route lighting through TerrainShading.
vi.mock('../src/atlas/scene/globe-widget', () => ({
  createGlobeWidget: () => ({
    widget: {
      scene: {
        mode: 3,
        primitives: { add: vi.fn() },
        renderError: fakeEvent(),
        requestRender: vi.fn(),
      },
      camera: { moveEnd: fakeEvent() },
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

beforeEach(() => {
  harness.contextOptions = undefined;
  harness.setAppearance.length = 0;
  harness.shadingDestroyed = 0;
  harness.updates.length = 0;
  vi.stubGlobal('requestAnimationFrame', () => 1);
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

  it('tears the shading down with the scene', () => {
    scene().destroy();
    expect(harness.shadingDestroyed).toBe(1);
  });
});
