/** Scene lifecycle failure reporting (Atlas design §11; fast-load design §B.6.11, §B.7). */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The hook runs without a DOM: React's hooks are replaced by stand-ins that keep the effect, so
// each test runs it once by hand.
const mocks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  load: vi.fn(),
  stallMs: undefined as number | undefined,
  webgl: { supported: true },
}));

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    mocks.effects.push(effect);
  },
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [value, () => undefined],
}));
vi.mock('../src/atlas/boot', () => ({
  atlasRequestStallMs: () => mocks.stallMs,
  loadAtlasSceneModule: () => mocks.load(),
}));
vi.mock('../src/atlas/explorer-runtime', () => ({
  supportsWebGL: () => mocks.webgl.supported,
}));

import type { AtlasWorkerClient } from '../src/atlas/worker/client';
import {
  useAtlasSceneLifecycle,
  type SceneFailure,
} from '../src/components/atlas/useAtlasSceneLifecycle';

function runLifecycle(sceneModule: Promise<unknown>) {
  mocks.load.mockReturnValue(sceneModule);
  const onUnavailable = vi.fn<(failure: SceneFailure) => void>();
  useAtlasSceneLifecycle({
    attempt: 0,
    bind: () => () => undefined,
    cesiumToken: '',
    element: { current: {} as HTMLDivElement },
    markTarget: null,
    naturalEarthUrl: '/data/atlas/ne-50m-admin-0.geojson',
    onReset: () => undefined,
    onUnavailable,
    reducedMotion: false,
    scene: { current: null },
    // No test here builds a scene that reads it.
    worker: {} as AtlasWorkerClient,
  });
  const cleanup = mocks.effects.pop()!();
  return { cleanup: cleanup ?? (() => undefined), onUnavailable };
}

afterEach(() => {
  mocks.effects.length = 0;
  mocks.load.mockReset();
  mocks.stallMs = undefined;
  mocks.webgl.supported = true;
  vi.restoreAllMocks();
});

describe('scene lifecycle failures', () => {
  it('reports a failed scene-chunk import as a download failure and logs its error', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const error = new TypeError(
      'Failed to fetch dynamically imported module: /_astro/atlas-scene.js',
    );
    const { onUnavailable } = runLifecycle(Promise.reject(error));
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalled());
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('download');
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      'The Atlas globe scene could not be loaded.',
      error,
    );
  });

  it('reports a scene that fails to start as a WebGL failure and logs its error', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const error = new Error('WebGL initialization failed');
    const { onUnavailable } = runLifecycle(
      Promise.resolve({
        createAtlasScene: () => {
          throw error;
        },
      }),
    );
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalled());
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('webgl');
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      'The Atlas globe could not start.',
      error,
    );
  });

  it('reports missing WebGL without loading the scene chunk', () => {
    mocks.webgl.supported = false;
    const { onUnavailable } = runLifecycle(Promise.resolve({}));
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('webgl');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('stays silent when the import fails after the scene effect is cleaned up', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const sceneModule = Promise.reject(new Error('network'));
    const { cleanup, onUnavailable } = runLifecycle(sceneModule);
    cleanup();
    await sceneModule.catch(() => undefined);
    await Promise.resolve();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('scene options', () => {
  it('gives the scene’s post-reveal load order the provider’s stall window (§B.6.9)', async () => {
    mocks.stallMs = 120_000;
    const destroy = vi.fn();
    const createAtlasScene = vi.fn(() => ({ destroy }));
    const { cleanup } = runLifecycle(Promise.resolve({ createAtlasScene }));
    await vi.waitFor(() => expect(createAtlasScene).toHaveBeenCalled());
    expect(createAtlasScene.mock.calls[0]).toMatchObject([
      {},
      { loadStallMs: 120_000 },
    ]);
    cleanup();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
