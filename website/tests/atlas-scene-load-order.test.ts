/** The scene's post-reveal load order: borders, then the detail tier, then the starfield (spec
 * 2026-10-07 §B.6.9; #443). The real scene class runs over a mocked CesiumWidget globe, overlay,
 * layers and mark tracker, as in `atlas-render-loop.test.ts`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadProgress } from '../src/atlas/load-order';
import { createAtlasScene } from '../src/atlas/scene/atlas-scene';
import type {
  ArtifactLoad,
  AtlasMark,
  ContextStatus,
} from '../src/atlas/scene/types';
import type { AtlasWorkerClient } from '../src/atlas/worker/client';

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

const harness = vi.hoisted(() => ({
  /** The mark tracker's listeners: the scene's own and the layers'. */
  markListeners: new Set<(mark: AtlasMark) => void>(),
  queuedMarks: [] as AtlasMark[],
  overlayLoads: [] as {
    url: string;
    /** The bytes have arrived; parsing and drawing go on. */
    fetched: () => void;
    /** A body chunk has arrived. */
    progress: () => void;
    settle: (status: 'ready' | 'fallback') => void;
  }[],
  revealSky: vi.fn(),
  setArtifact: vi.fn<(load: ArtifactLoad) => Promise<void>>(),
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

// The scene renders through the engine CesiumWidget that globe-widget builds (issue #446).
vi.mock('../src/atlas/scene/globe-widget', () => ({
  createGlobeWidget: () => ({
    widget: {
      scene: {
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
    capabilities = () => ({});
    setBasemap = () => Promise.resolve(true);
  },
}));
vi.mock('../src/atlas/scene/context-overlay', () => ({
  ContextOverlay: class {
    load = (
      url: string,
      onFetched: () => void = () => {},
      onProgress: () => void = () => {},
    ) =>
      new Promise<'ready' | 'fallback'>((settle) =>
        harness.overlayLoads.push({
          fetched: onFetched,
          progress: onProgress,
          settle,
          url,
        }),
      );
  },
}));
vi.mock('../src/atlas/scene/scientific-layers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/atlas/scene/scientific-layers')
  >()),
  ScientificLayers: class {
    destroy = () => {};
    setArtifact = (load: ArtifactLoad) => harness.setArtifact(load);
  },
}));
vi.mock('../src/atlas/scene/scene-marks', () => ({
  createMarkTracker: () => ({
    destroy: () => {},
    onMark: (listener: (mark: AtlasMark) => void) => {
      harness.markListeners.add(listener);
      return () => harness.markListeners.delete(listener);
    },
    queue: (mark: AtlasMark) => harness.queuedMarks.push(mark),
  }),
}));
vi.mock('../src/atlas/scene/highlight-layer', () => ({
  HighlightLayer: class {
    collection = {};
  },
}));
vi.mock('../src/atlas/scene/camera', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/camera')>()),
  bindKeyboardCamera: () => () => {},
  setCameraState: () => {},
}));
vi.mock('../src/atlas/scene/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/picking')>()),
  bindAtlasPicking: () => () => {},
}));
vi.mock('../src/atlas/scene/scene-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/scene-policy')>()),
  hideSkyUntilReady: () => harness.revealSky,
  styleAtlasScene: () => {},
}));

/** Lets promise reactions run without moving fake time. */
const flush = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

function mark(name: AtlasMark): void {
  for (const listener of [...harness.markListeners]) listener(name);
}

const LOAD: ArtifactLoad = {
  artifactId: 'hbs-rs334',
  artifactKey: 'hbs-rs334:m2:d3',
  observations: Promise.resolve(null),
  surface: new Promise(() => undefined),
};

function scene() {
  const controller = createAtlasScene({} as HTMLElement, {
    frameBudgetMs: 8,
    loadStallMs: 1_000,
    naturalEarthUrl: 'borders.bin',
    worker: {} as AtlasWorkerClient,
  });
  const statuses: ContextStatus[] = [];
  controller.onContextStatus((status) => statuses.push(status));
  /** A detail-tier load whose request the test settles. */
  const detail = () => {
    const request = deferred<void>();
    const started = vi.fn<(progress: LoadProgress) => void>();
    const cancel = controller.queueDetail((progress) => {
      started(progress);
      return request.promise;
    });
    return { cancel, request, started };
  };
  return { controller, detail, statuses };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  harness.markListeners.clear();
  harness.queuedMarks.length = 0;
  harness.overlayLoads.length = 0;
  harness.revealSky.mockReset();
  harness.setArtifact.mockReset();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('scene post-reveal load order (spec 2026-10-07 §B.6.9)', () => {
  it('starts the borders at surface-visible, as before', () => {
    const { controller } = scene();
    expect(harness.overlayLoads).toHaveLength(0);
    mark('surface-visible');
    expect(harness.overlayLoads.map((load) => load.url)).toEqual([
      'borders.bin',
    ]);
    mark('surface-visible');
    expect(harness.overlayLoads).toHaveLength(1);
    controller.destroy();
  });

  it('runs the borders, then the detail tier, then the starfield, each once the one before settles', async () => {
    const { controller, detail, statuses } = scene();
    mark('surface-visible');
    const first = detail();
    mark('ready');
    await flush();
    expect(first.started).not.toHaveBeenCalled();
    expect(harness.revealSky).not.toHaveBeenCalled();

    // The borders no longer need the network once their bytes have arrived; the detail tier
    // downloads while they are parsed and drawn.
    harness.overlayLoads[0].fetched();
    await flush();
    expect(first.started).toHaveBeenCalledTimes(1);
    expect(harness.queuedMarks).toEqual([]);
    expect(statuses).toEqual(['loading']);
    harness.overlayLoads[0].settle('ready');
    await flush();
    expect(harness.queuedMarks).toEqual(['context-ready']);
    expect(statuses).toEqual(['loading', 'ready']);
    expect(harness.revealSky).not.toHaveBeenCalled();

    first.request.resolve();
    await flush();
    expect(harness.revealSky).toHaveBeenCalledTimes(1);

    // A later artifact switch starts its detail tier as soon as its surface is visible.
    mark('surface-visible');
    const next = detail();
    expect(next.started).toHaveBeenCalledTimes(1);
    mark('ready');
    expect(harness.revealSky).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('starts the detail tier when the borders are drawn before their arrival is reported', async () => {
    const { controller, detail } = scene();
    mark('surface-visible');
    const first = detail();
    harness.overlayLoads[0].settle('ready');
    await flush();
    expect(first.started).toHaveBeenCalledTimes(1);
    // A late arrival report starts nothing twice.
    harness.overlayLoads[0].fetched();
    await flush();
    expect(first.started).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('keeps the starfield hidden until ready, even when every load has settled', async () => {
    const { controller, detail } = scene();
    mark('surface-visible');
    const first = detail();
    harness.overlayLoads[0].fetched();
    harness.overlayLoads[0].settle('ready');
    await flush();
    first.request.resolve();
    await flush();
    expect(harness.revealSky).not.toHaveBeenCalled();
    mark('ready');
    expect(harness.revealSky).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('lets borders that fail to download and a failed detail tier release the next step', async () => {
    const { controller, detail, statuses } = scene();
    mark('surface-visible');
    const first = detail();
    mark('ready');
    // A failed fetch falls back without reporting arrival.
    harness.overlayLoads[0].settle('fallback');
    await flush();
    expect(harness.queuedMarks).toEqual([]);
    expect(statuses).toEqual(['loading', 'fallback']);
    expect(first.started).toHaveBeenCalledTimes(1);
    first.request.reject(new Error('Atlas request failed with HTTP 503'));
    await flush();
    expect(harness.revealSky).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('releases the detail tier and then the starfield when each stalls', async () => {
    const { controller, detail } = scene();
    mark('surface-visible');
    const first = detail();
    mark('ready');
    vi.advanceTimersByTime(999);
    await flush();
    expect(first.started).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(first.started).toHaveBeenCalledTimes(1);

    // Body chunks postpone the detail tier's stall.
    vi.advanceTimersByTime(900);
    first.started.mock.calls[0][0]();
    vi.advanceTimersByTime(900);
    await flush();
    expect(harness.revealSky).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await flush();
    expect(harness.revealSky).toHaveBeenCalledTimes(1);

    // The stalled borders still finish drawing and report their status.
    harness.overlayLoads[0].settle('ready');
    await flush();
    expect(harness.queuedMarks).toEqual(['context-ready']);
    controller.destroy();
  });

  it('postpones the borders’ stall while their body chunks arrive', async () => {
    const { controller, detail } = scene();
    mark('surface-visible');
    const first = detail();
    vi.advanceTimersByTime(900);
    harness.overlayLoads[0].progress();
    vi.advanceTimersByTime(900);
    await flush();
    expect(first.started).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await flush();
    expect(first.started).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('starts the borders and then the starfield after a failed artifact request', async () => {
    const { controller } = scene();
    harness.setArtifact.mockRejectedValueOnce(
      new Error('render tier failed its checksum'),
    );
    await expect(controller.setArtifact(LOAD)).rejects.toThrow(
      'render tier failed its checksum',
    );
    expect(harness.overlayLoads).toHaveLength(1);
    expect(harness.revealSky).not.toHaveBeenCalled();
    harness.overlayLoads[0].fetched();
    await flush();
    expect(harness.revealSky).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('starts nothing for an aborted artifact request', async () => {
    const { controller } = scene();
    harness.setArtifact.mockRejectedValueOnce(
      new DOMException('Aborted', 'AbortError'),
    );
    await expect(controller.setArtifact(LOAD)).rejects.toThrow('Aborted');
    expect(harness.overlayLoads).toHaveLength(0);
    controller.destroy();
  });

  it('starts nothing more once destroyed mid-sequence', async () => {
    const { controller, detail, statuses } = scene();
    mark('surface-visible');
    const first = detail();
    mark('ready');
    controller.destroy();
    harness.overlayLoads[0].fetched();
    harness.overlayLoads[0].settle('ready');
    await flush();
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(first.started).not.toHaveBeenCalled();
    expect(harness.revealSky).not.toHaveBeenCalled();
    expect(harness.queuedMarks).toEqual([]);
    expect(statuses).toEqual(['loading']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
