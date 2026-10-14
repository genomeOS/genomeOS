import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAtlasScene } from '../src/atlas/scene/atlas-scene';
import type { AtlasWorkerClient } from '../src/atlas/worker/client';

/** A minimal Cesium Event: listeners in order, removal through the returned function. */
type FakeEvent = ReturnType<typeof fakeEvent>;
function fakeEvent() {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addEventListener(listener: (...args: unknown[]) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    raiseEvent(...args: unknown[]) {
      for (const listener of listeners) listener(...args);
    },
  };
}

const globes = vi.hoisted(
  () =>
    [] as {
      container: unknown;
      widget: {
        scene: { renderError: FakeEvent };
        resize: ReturnType<typeof vi.fn>;
        render: ReturnType<typeof vi.fn>;
      };
      destroy: ReturnType<typeof vi.fn>;
    }[],
);

// The scene renders through the engine CesiumWidget that globe-widget builds (issue #446).
vi.mock('../src/atlas/scene/globe-widget', () => ({
  createGlobeWidget: (container: unknown) => {
    const globe = {
      container,
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
    };
    globes.push(globe);
    return globe;
  },
}));
vi.mock('../src/atlas/scene/context-controller', () => ({
  ContextController: class {
    capabilities = () => ({});
    setBasemap = () => Promise.resolve(true);
  },
}));
vi.mock('../src/atlas/scene/context-overlay', () => ({
  ContextOverlay: class {
    load = () => new Promise(() => {});
  },
}));
vi.mock('../src/atlas/scene/scientific-layers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/atlas/scene/scientific-layers')
  >()),
  ScientificLayers: class {
    destroy = () => {};
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
  },
}));
vi.mock('../src/atlas/scene/camera', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atlas/scene/camera')>()),
  bindKeyboardCamera: () => () => {},
  setCameraState: () => {},
}));
// The reveal wave (#453) as the scene drives it: the scene it was given and its teardown.
const waves = vi.hoisted(
  () =>
    [] as {
      scene: unknown;
      destroy: ReturnType<typeof vi.fn>;
    }[],
);
vi.mock('../src/atlas/scene/reveal-wave-driver', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/atlas/scene/reveal-wave-driver')
  >()),
  createRevealWave: (options: { scene: unknown }) => {
    const wave = { destroy: vi.fn(), scene: options.scene };
    waves.push(wave);
    return {
      destroy: wave.destroy,
      finish: () => {},
      onChange: () => () => {},
      reveal: () => 1,
      running: () => false,
      start: () => {},
      uniforms: {},
    };
  },
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

/** Animation frames that run only when a test advances them. */
let frames: Map<number, () => void>;
let nextFrame: number;
function runFrame(): void {
  const pending = [...frames];
  frames.clear();
  for (const [, callback] of pending) callback();
}

const container = {} as HTMLElement;

function scene() {
  const controller = createAtlasScene(container, {
    frameBudgetMs: 8,
    naturalEarthUrl: 'borders.bin',
    worker: {} as AtlasWorkerClient,
  });
  const globe = globes.at(-1)!;
  return { controller, globe, widget: globe.widget };
}

beforeEach(() => {
  globes.length = 0;
  waves.length = 0;
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames.delete(handle);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Atlas render loop (Cesium globe design §12)', () => {
  it('owns the Cesium loop and renders each animation frame', () => {
    // globe-widget turns Cesium's loop and error panel off (tests/atlas-globe-widget.test.ts).
    const { globe, widget } = scene();
    expect(globe.container).toBe(container);
    runFrame();
    runFrame();
    expect(widget.resize).toHaveBeenCalledTimes(2);
    expect(widget.render).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(1);
  });

  it('reports an error thrown outside Scene.render once and stops rendering', () => {
    // A throwing postRender or camera moveEnd listener escapes Scene.render's own catch, so
    // Cesium never raises scene.renderError for it.
    const { controller, widget } = scene();
    const failure = new Error('a postRender listener threw');
    widget.render.mockImplementation(() => {
      throw failure;
    });
    const listener = vi.fn();
    controller.onRenderError(listener);
    runFrame();
    expect(listener).toHaveBeenCalledExactlyOnceWith(failure);
    expect(frames.size).toBe(0);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('reports scene.renderError once, even when it is raised again', () => {
    const { controller, widget } = scene();
    const first = new Error('worker import failed');
    widget.render.mockImplementation(() => {
      widget.scene.renderError.raiseEvent({}, first);
      widget.scene.renderError.raiseEvent(
        {},
        new Error('the same frame again'),
      );
    });
    const listener = vi.fn();
    controller.onRenderError(listener);
    runFrame();
    runFrame();
    expect(listener).toHaveBeenCalledExactlyOnceWith(first);
    expect(widget.render).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it('replays the error to a late listener and honours unsubscribe', () => {
    const { controller, widget } = scene();
    const removed = vi.fn();
    controller.onRenderError(removed)();
    const failure = new Error('lost');
    widget.scene.renderError.raiseEvent({}, failure);
    expect(removed).not.toHaveBeenCalled();
    const late = vi.fn();
    controller.onRenderError(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('drives the reveal wave from the widget scene and tears it down before the widget (#447, #453)', () => {
    const { controller, globe, widget } = scene();
    expect(waves).toHaveLength(1);
    const [wave] = waves;
    expect(wave.scene).toBe(widget.scene);
    controller.destroy();
    expect(wave.destroy).toHaveBeenCalledOnce();
    expect(globe.destroy).toHaveBeenCalledOnce();
    // The wave unsubscribes from the scene's preUpdate and postRender while the scene still exists.
    expect(wave.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      globe.destroy.mock.invocationCallOrder[0],
    );
  });

  it('cancels its frame and reports nothing after destroy', () => {
    const { controller, globe, widget } = scene();
    const listener = vi.fn();
    controller.onRenderError(listener);
    const renderError = widget.scene.renderError;
    controller.destroy();
    expect(frames.size).toBe(0);
    expect(globe.destroy).toHaveBeenCalledOnce();
    renderError.raiseEvent({}, new Error('after destroy'));
    expect(listener).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
