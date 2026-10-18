/** The scene's physical-terrain wiring (Atlas design §11; #483): the real scene class over a mocked
 * CesiumWidget, context controller and terrain shading, as in `atlas-scene-load-order.test.ts`.
 * The draping block follows the scene's draped rule (terrain draping design, "When it is active",
 * "How existing features behave" and "Failure modes"). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DRAPE_FAILED_WARNING } from '../src/atlas/earth-style-catalog';
import { createAtlasScene } from '../src/atlas/scene/atlas-scene';
import type { ContextWarning } from '../src/atlas/scene/context-controller';
import { DEFAULT_LAYERS } from '../src/atlas/scene/scene-policy';
import type { ScientificLayersOptions } from '../src/atlas/scene/scientific-layers';
import type { SurfacePickContext } from '../src/atlas/scene/surface-pick';
import type {
  AtlasSceneController,
  DrapedRuntime,
  DrapeStats,
} from '../src/atlas/scene/types';
import type { TerrainId } from '../src/atlas/url-state';
import type { AtlasWorkerClient } from '../src/atlas/worker/client';
import { flushTasks } from './helpers/scene-fakes';

/** A terrain request the test settles; settled true, its terrain is on the globe. */
interface TerrainRequest {
  resolve(applied: boolean): void;
}

const harness = vi.hoisted(() => ({
  /** The fake camera's height and the ground under it, and its zoom calls. */
  camera: { ground: 0 as number | undefined, height: 29_600 },
  zooms: [] as ['in' | 'out', number][],
  contextOptions: undefined as
    { onTerrainApplied?: (terrain: TerrainId) => void } | undefined,
  /** The context the scene handed the surface pick resolver. */
  pickContext: undefined as SurfacePickContext | undefined,
  setAppearance: [] as [number, number][],
  contextDestroyed: 0,
  shadingDestroyed: 0,
  updates: [] as Record<string, unknown>[],
  /** Each terrain the scene asked the context controller for, and its pending request. */
  terrainRequests: [] as TerrainId[],
  terrain: [] as TerrainRequest[],
  /**
   * A pending request for `terrain`. As in the real controller, a request that settles true has
   * put its terrain on the globe first (`onTerrainApplied`); one that settles false has not.
   */
  nextTerrain(terrain: TerrainId): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      harness.terrain.push({
        resolve(applied) {
          if (applied) harness.contextOptions?.onTerrainApplied?.(terrain);
          resolve(applied);
        },
      });
    });
  },
  /** The options the scene gave ScientificLayers, its rebuilds and the factors it was given. */
  layers: undefined as ScientificLayersOptions | undefined,
  rebuilds: 0,
  factors: [] as number[],
  /** The drape stats reader the scene published, and the spy that unpublishes it. */
  drapeStatsRead: undefined as (() => DrapeStats) | undefined,
  removeDrapeStats: vi.fn(),
}));

/** The draped runtime module's factory, a spy so a test can see when it loads, and its stats. */
const { runtimeFactory, STATS } = vi.hoisted(() => {
  const stats = {
    delivered: 2,
    empty: 1,
    queueDepth: 0,
    rasterMs: {
      counts: [1, 0, 0, 0, 0, 0, 0],
      upperMs: [0.5, 1, 2, 4, 8, 16, Infinity],
    },
    requested: 2,
    residentBytes: 349_525,
  };
  const runtime = { stats: { read: () => stats }, version: 'atlas-draped-v1' };
  return {
    STATS: stats,
    runtimeFactory: vi.fn(() => ({
      drapedRuntime: runtime as unknown as DrapedRuntime,
    })),
  };
});

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
    /** A pending request per call; until a test settles it, the provider is not on the globe. */
    setTerrain = (terrain: TerrainId) => {
      harness.terrainRequests.push(terrain);
      return harness.nextTerrain(terrain);
    };
    setVisible = () => {};
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
    setVisible = () => {};
  },
}));
vi.mock('../src/atlas/scene/scientific-layers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/atlas/scene/scientific-layers')
  >()),
  ScientificLayers: class {
    constructor(options: ScientificLayersOptions) {
      harness.layers = options;
    }
    destroy = () => {};
    rebuild = () => {
      harness.rebuilds += 1;
      return Promise.resolve();
    };
    setCellEdges = () => Promise.resolve();
    setEdgeStyle = () => Promise.resolve();
    setElevationFactor = (factor: number) => harness.factors.push(factor);
    setSceneMode = () => Promise.resolve();
    setSurfaceOpacity = () => {};
    setVisibility = () => {};
  },
}));
vi.mock('../src/atlas/scene/draped/runtime', runtimeFactory);
vi.mock('../src/atlas/e2e-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/e2e-hooks')>()),
  drapeStatsTestHook: (read: () => DrapeStats) => {
    harness.drapeStatsRead = read;
    return harness.removeDrapeStats;
  },
}));
vi.mock('../src/atlas/scene/surface-pick', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/surface-pick')>()),
  createSurfacePickResolver: (_scene: unknown, context: SurfacePickContext) => {
    harness.pickContext = context;
    return () => null;
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

function scene(reducedMotion = false) {
  return createAtlasScene({} as HTMLElement, {
    frameBudgetMs: 8,
    naturalEarthUrl: 'borders.bin',
    reducedMotion,
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
  harness.pickContext = undefined;
  harness.setAppearance.length = 0;
  harness.contextDestroyed = 0;
  harness.shadingDestroyed = 0;
  harness.updates.length = 0;
  harness.terrainRequests.length = 0;
  harness.terrain.length = 0;
  harness.layers = undefined;
  harness.rebuilds = 0;
  harness.factors.length = 0;
  harness.drapeStatsRead = undefined;
  harness.removeDrapeStats.mockClear();
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

  it('picks on the ground once World Terrain is on the globe, and on the ellipsoid on the smooth globe', () => {
    scene();
    expect(harness.pickContext!.draped()).toBe(false);
    harness.contextOptions?.onTerrainApplied?.('world-terrain');
    expect(harness.pickContext!.draped()).toBe(true);
    harness.contextOptions?.onTerrainApplied?.('smooth-globe');
    expect(harness.pickContext!.draped()).toBe(false);
  });

  it('keeps the smooth pick while a requested World Terrain has not reached the globe', () => {
    void scene().setTerrain('world-terrain'); // left pending: never on the globe
    expect(harness.pickContext!.draped()).toBe(false);
  });

  it('keeps the depth pick while data elevation lifts the surface under World Terrain', async () => {
    const controller = scene(true);
    harness.contextOptions?.onTerrainApplied?.('world-terrain');
    await controller.setElevation(true, 2);
    expect(harness.pickContext!.draped()).toBe(false);
    await controller.setElevation(false, 2);
    expect(harness.pickContext!.draped()).toBe(true);
  });

  it('tells the shading whether any surface layer is shown', () => {
    const controller = scene();
    controller.setLayerVisibility({
      ...DEFAULT_LAYERS,
      support: false,
      surface: false,
    });
    expect(harness.updates).toContainEqual({ surfaceShown: false });
    controller.setLayerVisibility({ ...DEFAULT_LAYERS, surface: false });
    expect(harness.updates.at(-1)).toEqual({ surfaceShown: true });
  });
});

describe('draping (#483)', () => {
  const rebuilds = () => harness.rebuilds;
  let atlas: AtlasSceneController;
  beforeEach(() => {
    atlas = scene(true);
  });

  it("drapes on the requested terrain at once, so the URL's World Terrain builds no chunks first", () => {
    void atlas.setTerrain('world-terrain');
    expect(harness.layers!.style().draped).toBe(true);
    expect(rebuilds()).toBe(1);
  });

  it('falls back to chunks when World Terrain fails to load: one rebuild back', async () => {
    void atlas.setTerrain('world-terrain');
    harness.terrain[0].resolve(false);
    await flushTasks();
    expect(harness.layers!.style().draped).toBe(false);
    expect(rebuilds()).toBe(2);
  });

  it('forces data elevation to 0 and extruded to hexagons while draped, restoring them after', async () => {
    await atlas.setElevation(true, 3); // reducedMotion: true
    void atlas.setTerrain('world-terrain');
    await flushTasks();
    expect(harness.factors.at(-1)).toBe(0);
    await atlas.setSurfaceStyle(
      'rainbow',
      0.58,
      false,
      'matched',
      '#b9f5ff',
      'extruded',
    );
    expect(harness.layers!.style().geometry).toBe('hexagons');
    harness.terrain[0].resolve(true);
    void atlas.setTerrain('smooth-globe');
    harness.terrain[1].resolve(true);
    await flushTasks();
    expect(harness.factors.at(-1)).toBe(3);
    expect(harness.layers!.style().geometry).toBe('extruded');
  });

  it('reverts to the smooth globe with the drape warning when a raster fails, until the next choice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnings: (readonly ContextWarning[])[] = [];
    atlas.onWarning((w) => warnings.push(w));
    void atlas.setTerrain('world-terrain');
    const error = new Error('tile');
    harness.layers!.onDrapeFailure(error);
    expect(harness.terrainRequests).toEqual(['world-terrain', 'smooth-globe']);
    expect(warnings.at(-1)).toContainEqual({
      id: 'drape',
      message: DRAPE_FAILED_WARNING,
    });
    expect(harness.layers!.style().draped).toBe(false);
    // Never silent: the failure itself is logged.
    expect(warn.mock.calls.some((call) => call.includes(error))).toBe(true);
    void atlas.setTerrain('world-terrain');
    expect(warnings.at(-1)!.some(({ id }) => id === 'drape')).toBe(false);
    warn.mockRestore();
  });

  it('keeps the newest of rapid World Terrain, smooth and World Terrain requests', async () => {
    void atlas.setTerrain('world-terrain');
    void atlas.setTerrain('smooth-globe');
    void atlas.setTerrain('world-terrain');
    harness.terrain[1].resolve(true);
    harness.terrain[2].resolve(true);
    harness.terrain[0].resolve(false);
    await flushTasks();
    expect(harness.layers!.style().draped).toBe(true);
    expect(rebuilds()).toBe(3);
  });

  // The first test here to import the runtime: the module registry keeps that import for the rest.
  it('loads the draped runtime once, only when asked, and removes the drape stats reader on destroy', async () => {
    expect(runtimeFactory).not.toHaveBeenCalled();
    const [a, b] = [harness.layers!.draped(), harness.layers!.draped()];
    expect(a).toBe(b);
    await a;
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    // The e2e reader reads the runtime's own stats.
    expect(harness.drapeStatsRead!()).toBe(STATS);
    atlas.destroy();
    expect(harness.removeDrapeStats).toHaveBeenCalledTimes(1);
  });

  it('keeps draping on a World Terrain request still loading when an older request settles', async () => {
    void atlas.setTerrain('world-terrain');
    void atlas.setTerrain('smooth-globe');
    void atlas.setTerrain('world-terrain');
    harness.terrain[1].resolve(true); // the smooth globe, superseded, is on the globe for now
    await flushTasks();
    expect(harness.layers!.style().draped).toBe(true);
    expect(rebuilds()).toBe(3);
  });

  it('tries a failed draped runtime import again on the next draped build', async () => {
    const offline = vi.fn(() => {
      throw new Error('offline');
    });
    vi.doMock('../src/atlas/scene/draped/runtime', offline);
    // Vitest wraps the factory's error in its own.
    await expect(harness.layers!.draped()).rejects.toThrow();
    expect(harness.removeDrapeStats).not.toHaveBeenCalled();
    vi.doMock('../src/atlas/scene/draped/runtime', runtimeFactory);
    await expect(harness.layers!.draped()).resolves.toMatchObject({
      version: 'atlas-draped-v1',
    });
    expect(offline).toHaveBeenCalledTimes(1);
    atlas.destroy();
    expect(harness.removeDrapeStats).toHaveBeenCalledTimes(1);
  });

  it('rebuilds once for the URL terrain the explorer asks for twice at scene creation', () => {
    void atlas.setTerrain('world-terrain');
    void atlas.setTerrain('world-terrain');
    expect(harness.layers!.style().draped).toBe(true);
    expect(rebuilds()).toBe(1);
  });

  it('only logs a raster failure heard once the scene no longer drapes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnings: (readonly ContextWarning[])[] = [];
    atlas.onWarning((w) => warnings.push(w));
    void atlas.setTerrain('world-terrain');
    void atlas.setTerrain('smooth-globe');
    const error = new Error('a tile of the outgoing surface');
    harness.layers!.onDrapeFailure(error);
    expect(harness.terrainRequests).toEqual(['world-terrain', 'smooth-globe']);
    expect(warnings.at(-1)!.some(({ id }) => id === 'drape')).toBe(false);
    expect(warn.mock.calls.some((call) => call.includes(error))).toBe(true);
    expect(rebuilds()).toBe(2);
    warn.mockRestore();
  });

  it('neither reverts nor rebuilds once destroyed', async () => {
    void atlas.setTerrain('world-terrain');
    atlas.destroy();
    harness.terrain[0].resolve(false);
    await flushTasks();
    harness.layers!.onDrapeFailure(new Error('late tile'));
    expect(harness.terrainRequests).toEqual(['world-terrain']);
    expect(rebuilds()).toBe(1);
  });
});
