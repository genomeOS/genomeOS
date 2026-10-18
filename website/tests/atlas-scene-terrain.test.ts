/** The scene's physical-terrain wiring (Atlas design §11; #483): the real scene class over a mocked
 * CesiumWidget, context controller and terrain shading, as in `atlas-scene-load-order.test.ts`.
 * The draping block follows the scene's draped rule (terrain draping design, "When it is active",
 * "How existing features behave" and "Failure modes"); the draped context block, the overlay, the
 * highlight and the ground following the data and the relief ("Per layer under World Terrain",
 * "Exaggeration"). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DRAPE_FAILED_WARNING } from '../src/atlas/earth-style-catalog';
import { createAtlasScene } from '../src/atlas/scene/atlas-scene';
// Every World Terrain request imports the draped runtime: loaded once here, the mocked module is
// in the registry before any test, so a scene's import settles within the test that made it.
import '../src/atlas/scene/draped/runtime';
import type { ContextWarning } from '../src/atlas/scene/context-controller';
import type { ContextOverlayOptions } from '../src/atlas/scene/context-overlay';
import { GROUND_RESAMPLE_MS } from '../src/atlas/scene/ground-heights';
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

/** An event the test raises itself, as Cesium raises the scene's and the globe's. */
const { raisable } = vi.hoisted(() => ({
  raisable() {
    const listeners = new Set<(...args: unknown[]) => void>();
    return {
      addEventListener(listener: (...args: unknown[]) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      raise(...args: unknown[]) {
        for (const listener of [...listeners]) listener(...args);
      },
      /** Forgets the listeners of earlier tests' scenes. */
      clear() {
        listeners.clear();
      },
    };
  },
}));

const harness = vi.hoisted(() => ({
  /** The fake scene's globe, a sentinel the scene hands the highlight while draped. */
  globe: {
    getHeight: () => harness.camera.ground,
    tileLoadProgressEvent: raisable(),
  },
  /** The fake scene's `postRender`, raised by the test as a rendered frame. */
  postRender: raisable(),
  /** The draped runtime the mocked runtime module exports. */
  drapedRuntime: undefined as unknown as DrapedRuntime,
  /** The options the scene gave the context overlay, and the overlay's draped calls. */
  overlayOptions: undefined as ContextOverlayOptions | undefined,
  overlay: {
    setDraped: vi.fn((_runtime: DrapedRuntime | null) => Promise.resolve()),
  },
  highlight: { setGround: vi.fn() },
  /** The ScientificLayers the scene made: its ground re-samples. */
  layers: { resampleGround: vi.fn() },
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
  layersOptions: undefined as ScientificLayersOptions | undefined,
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
  harness.drapedRuntime = {
    stats: { read: () => stats },
    version: 'atlas-draped-v1',
  } as unknown as DrapedRuntime;
  return {
    STATS: stats,
    runtimeFactory: vi.fn(() => ({ drapedRuntime: harness.drapedRuntime })),
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
        globe: harness.globe,
        mode: 3,
        postRender: harness.postRender,
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
    constructor(options: ContextOverlayOptions) {
      harness.overlayOptions = options;
    }
    load = () => new Promise(() => {});
    setDraped = harness.overlay.setDraped;
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
      harness.layersOptions = options;
    }
    destroy = () => {};
    rebuild = () => {
      harness.rebuilds += 1;
      return Promise.resolve();
    };
    resampleGround = harness.layers.resampleGround;
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
    setGround = harness.highlight.setGround;
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

/** Fake timeouts and clock; `requestAnimationFrame` stays the stub `frame()` runs. */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
  harness.layersOptions = undefined;
  harness.overlayOptions = undefined;
  harness.postRender.clear();
  harness.globe.tileLoadProgressEvent.clear();
  harness.overlay.setDraped.mockClear();
  harness.highlight.setGround.mockClear();
  harness.layers.resampleGround.mockClear();
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
  vi.useRealTimers();
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
    expect(harness.layersOptions!.style().draped).toBe(true);
    expect(rebuilds()).toBe(1);
  });

  it('falls back to chunks when World Terrain fails to load: one rebuild back', async () => {
    void atlas.setTerrain('world-terrain');
    harness.terrain[0].resolve(false);
    await flushTasks();
    expect(harness.layersOptions!.style().draped).toBe(false);
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
    expect(harness.layersOptions!.style().geometry).toBe('hexagons');
    harness.terrain[0].resolve(true);
    void atlas.setTerrain('smooth-globe');
    harness.terrain[1].resolve(true);
    await flushTasks();
    expect(harness.factors.at(-1)).toBe(3);
    expect(harness.layersOptions!.style().geometry).toBe('extruded');
  });

  it('reverts to the smooth globe with the drape warning when a raster fails, until the next choice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnings: (readonly ContextWarning[])[] = [];
    atlas.onWarning((w) => warnings.push(w));
    void atlas.setTerrain('world-terrain');
    const error = new Error('tile');
    harness.layersOptions!.onDrapeFailure(error);
    expect(harness.terrainRequests).toEqual(['world-terrain', 'smooth-globe']);
    expect(warnings.at(-1)).toContainEqual({
      id: 'drape',
      message: DRAPE_FAILED_WARNING,
    });
    expect(harness.layersOptions!.style().draped).toBe(false);
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
    // The superseded smooth globe reaches the globe first: the newest request still drapes.
    harness.terrain[1].resolve(true);
    await flushTasks();
    expect(harness.layersOptions!.style().draped).toBe(true);
    expect(rebuilds()).toBe(3);
    harness.terrain[2].resolve(true);
    await flushTasks();
    harness.terrain[0].resolve(false);
    await flushTasks();
    expect(harness.layersOptions!.style().draped).toBe(true);
    expect(rebuilds()).toBe(3);
  });

  it('loads the draped runtime once, only when asked, and removes the drape stats reader on destroy', async () => {
    // A registry of its own, so no other test's import of the runtime counts here.
    vi.resetModules();
    vi.doMock('../src/atlas/scene/draped/runtime', runtimeFactory);
    runtimeFactory.mockClear();
    expect(runtimeFactory).not.toHaveBeenCalled();
    const [a, b] = [
      harness.layersOptions!.draped(),
      harness.layersOptions!.draped(),
    ];
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
    expect(harness.layersOptions!.style().draped).toBe(true);
    expect(rebuilds()).toBe(3);
  });

  it('tries a failed draped runtime import again on the next draped build', async () => {
    const offline = vi.fn(() => {
      throw new Error('offline');
    });
    vi.doMock('../src/atlas/scene/draped/runtime', offline);
    // Vitest wraps the factory's error in its own.
    await expect(harness.layersOptions!.draped()).rejects.toThrow();
    expect(harness.removeDrapeStats).not.toHaveBeenCalled();
    vi.doMock('../src/atlas/scene/draped/runtime', runtimeFactory);
    await expect(harness.layersOptions!.draped()).resolves.toMatchObject({
      version: 'atlas-draped-v1',
    });
    expect(offline).toHaveBeenCalledTimes(1);
    atlas.destroy();
    expect(harness.removeDrapeStats).toHaveBeenCalledTimes(1);
  });

  it('rebuilds once for the URL terrain the explorer asks for twice at scene creation', () => {
    void atlas.setTerrain('world-terrain');
    void atlas.setTerrain('world-terrain');
    expect(harness.layersOptions!.style().draped).toBe(true);
    expect(rebuilds()).toBe(1);
  });

  it('only logs a raster failure heard once the scene no longer drapes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnings: (readonly ContextWarning[])[] = [];
    atlas.onWarning((w) => warnings.push(w));
    void atlas.setTerrain('world-terrain');
    void atlas.setTerrain('smooth-globe');
    const error = new Error('a tile of the outgoing surface');
    harness.layersOptions!.onDrapeFailure(error);
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
    harness.layersOptions!.onDrapeFailure(new Error('late tile'));
    expect(harness.terrainRequests).toEqual(['world-terrain']);
    expect(rebuilds()).toBe(1);
  });
});

// Terrain draping design, "Per layer under World Terrain" and "Exaggeration": the context overlay,
// the highlight and the ground under the observations follow the draped data and the relief.
describe('draped context and relief (#483)', () => {
  it('drapes the context overlay and the highlight with the data, and lets them go on the smooth globe', async () => {
    const controller = scene();
    void controller.setTerrain('world-terrain');
    await flushTasks();
    expect(harness.overlay.setDraped).toHaveBeenLastCalledWith(
      harness.drapedRuntime,
    );
    expect(harness.highlight.setGround).toHaveBeenLastCalledWith(harness.globe);
    void controller.setTerrain('smooth-globe');
    await flushTasks();
    expect(harness.overlay.setDraped).toHaveBeenLastCalledWith(null);
    expect(harness.highlight.setGround).toHaveBeenLastCalledWith(null);
  });

  it('hands the overlay nothing from a flip the smooth globe has already superseded', async () => {
    const controller = scene();
    void controller.setTerrain('world-terrain');
    void controller.setTerrain('smooth-globe');
    await flushTasks();
    expect(harness.overlay.setDraped.mock.calls).toEqual([[null]]);
    expect(harness.highlight.setGround).toHaveBeenLastCalledWith(null);
  });

  it('resamples the ground after the frame that applies relief, and once more when the slider rests', async () => {
    useFakeClock();
    const controller = scene();
    void controller.setTerrain('world-terrain');
    await vi.advanceTimersByTimeAsync(0);
    harness.highlight.setGround.mockClear();
    controller.setRelief(3);
    frame(); // the relief frame: TerrainShading sets scene.verticalExaggeration
    // Cesium re-exaggerates loaded tiles in the next render (GlobeSurfaceTileProvider.js:555-575).
    expect(harness.layers.resampleGround).not.toHaveBeenCalled();
    harness.postRender.raise();
    expect(harness.layers.resampleGround.mock.calls).toEqual([[false]]);
    vi.advanceTimersByTime(GROUND_RESAMPLE_MS);
    harness.postRender.raise();
    expect(harness.layers.resampleGround.mock.calls).toEqual([[false], [true]]);
    expect(harness.highlight.setGround).toHaveBeenLastCalledWith(harness.globe);
    vi.useRealTimers();
  });

  it('leaves the smooth globe alone when relief is set', () => {
    const controller = scene();
    controller.setRelief(3);
    frame();
    harness.postRender.raise();
    expect(harness.layers.resampleGround).not.toHaveBeenCalled();
  });

  it('re-grounds the highlight as World Terrain tiles load, at most every 50 ms and once the queue empties', () => {
    useFakeClock();
    const controller = scene();
    const tiles = harness.globe.tileLoadProgressEvent;
    tiles.raise(4); // the smooth globe: the highlight keeps its own heights
    expect(harness.highlight.setGround).not.toHaveBeenCalled();
    void controller.setTerrain('world-terrain');
    harness.highlight.setGround.mockClear();
    tiles.raise(6);
    tiles.raise(5); // within GROUND_RESAMPLE_MS of the last
    expect(harness.highlight.setGround.mock.calls).toEqual([[harness.globe]]);
    tiles.raise(0); // the queue is empty: final
    expect(harness.highlight.setGround).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(GROUND_RESAMPLE_MS);
    tiles.raise(3);
    expect(harness.highlight.setGround).toHaveBeenCalledTimes(3);
    void controller.setTerrain('smooth-globe');
    harness.highlight.setGround.mockClear();
    vi.advanceTimersByTime(GROUND_RESAMPLE_MS);
    tiles.raise(2);
    tiles.raise(0);
    expect(harness.highlight.setGround).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('reverts to the smooth globe when the borders cannot be draped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = scene();
    const warnings = vi.fn();
    controller.onWarning(warnings);
    // A failure counts while the scene drapes (Task 16's rule); on the smooth globe it is logged.
    void controller.setTerrain('world-terrain');
    harness.overlayOptions!.onDrapeFailure!(new Error('raster worker failed'));
    expect(harness.terrainRequests.at(-1)).toBe('smooth-globe');
    expect(warnings).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'drape' })]),
    );
    warn.mockRestore();
  });

  it('stops relief resampling once the scene is destroyed', async () => {
    useFakeClock();
    const controller = scene();
    void controller.setTerrain('world-terrain');
    await vi.advanceTimersByTimeAsync(0);
    controller.setRelief(3);
    frame();
    controller.destroy();
    harness.postRender.raise();
    vi.advanceTimersByTime(GROUND_RESAMPLE_MS);
    harness.postRender.raise();
    expect(harness.layers.resampleGround).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
