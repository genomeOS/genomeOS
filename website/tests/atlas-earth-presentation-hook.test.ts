/** The explorer's basemap, terrain and relief effects (Atlas design §11; #483), run without a
 * DOM: `useEffect` is replaced by a stand-in that runs an effect, after its previous cleanup,
 * whenever its dependencies change between renders. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AtlasCatalog } from '../src/atlas/contracts';
import type { AtlasSceneController } from '../src/atlas/scene/types';
import {
  parseExplorerState,
  type ExplorerState,
  type TerrainId,
} from '../src/atlas/url-state';

const react = vi.hoisted(() => {
  const slots: {
    cleanup?: () => void;
    deps?: readonly unknown[];
    value?: unknown;
  }[] = [];
  let index = 0;
  return {
    render(run: () => void) {
      index = 0;
      run();
    },
    reset() {
      slots.length = 0;
    },
    useState<T>(initial: T): [T, (value: T) => void] {
      const slot = (slots[index] ??= { value: initial });
      index += 1;
      return [
        slot.value as T,
        (value: T) => {
          slot.value = value;
        },
      ];
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const slot = (slots[index] ??= {});
      index += 1;
      if (
        slot.deps &&
        deps &&
        slot.deps.length === deps.length &&
        slot.deps.every((value, at) => Object.is(value, deps[at]))
      )
        return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
  };
});

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: react.useEffect,
  useState: react.useState,
}));

const { useEarthPresentation } =
  await import('../src/components/atlas/useEarthPresentation');

const catalog = {
  artifacts: [
    { data_version: 'map-2026-08', id: 'hbs-rs334', model_version: 'v1' },
  ],
} as AtlasCatalog;

function fakeController() {
  const terrainListeners = new Set<(terrain: TerrainId) => void>();
  let applied: TerrainId = 'smooth-globe';
  return {
    /** Puts `terrain` on the globe, as the scene's context controller would. */
    applyTerrain(terrain: TerrainId) {
      applied = terrain;
      for (const listener of terrainListeners) listener(terrain);
    },
    onTerrainApplied: vi.fn((listener: (terrain: TerrainId) => void) => {
      terrainListeners.add(listener);
      listener(applied);
      return () => terrainListeners.delete(listener);
    }),
    setBasemap: vi.fn(() => Promise.resolve(true)),
    setMapPresentation: vi.fn(),
    setRelief: vi.fn(),
    setTerrain: vi.fn(() => Promise.resolve(true)),
  };
}

function harness(hasArtifact = false) {
  const controller = fakeController();
  const scene = {
    current: controller as unknown as AtlasSceneController,
  };
  const runSceneActivity = vi.fn(
    (
      _label: string,
      _detail: string,
      operation: (controller: AtlasSceneController) => Promise<unknown>,
    ) => {
      void operation(scene.current);
      return undefined;
    },
  );
  let applied: TerrainId | undefined;
  const render = (state: ExplorerState) => {
    react.render(() => {
      applied = useEarthPresentation({
        runSceneActivity: runSceneActivity as never,
        scene,
        sceneAttempt: 0,
        sceneController: scene.current,
        sceneHasArtifact: () => hasArtifact,
        state,
      });
    });
    return applied;
  };
  return { controller, render, runSceneActivity };
}

function state(query: string): ExplorerState {
  return parseExplorerState(query, catalog).state;
}

beforeEach(() => react.reset());

describe('useEarthPresentation', () => {
  it('pushes relief to the scene as it changes, and only then', () => {
    const { controller, render } = harness();
    const first = state('?relief=1');
    render(first);
    expect(controller.setRelief).toHaveBeenLastCalledWith(1);
    render({ ...first, relief: 3 });
    expect(controller.setRelief).toHaveBeenLastCalledWith(3);
    render({ ...first, relief: 3, basemapOpacity: 0.5 });
    expect(controller.setRelief).toHaveBeenCalledTimes(2);
  });

  it('keeps the basemap, presentation and terrain effects it took over', () => {
    const { controller, render, runSceneActivity } = harness(true);
    render(
      state('?terrain=world-terrain&dayNight=false&basemap=openstreetmap'),
    );
    expect(controller.setMapPresentation).toHaveBeenCalledWith(1, 0.5, false);
    // With an artifact displayed, a basemap or terrain change shows as scene activity.
    expect(runSceneActivity.mock.calls.map(([label]) => label)).toEqual([
      'Changing basemap',
      'Changing terrain',
    ]);
    expect(controller.setBasemap).toHaveBeenCalledWith('openstreetmap');
    expect(controller.setTerrain).toHaveBeenCalledWith('world-terrain');
  });

  it('reports the terrain the scene put on the globe, not the one requested (#483 review)', () => {
    const { controller, render } = harness();
    const requested = state('?terrain=world-terrain');
    // Until World Terrain loads (or when it fails), the smooth globe and its sun are in charge.
    render(requested);
    expect(render(requested)).toBe('smooth-globe');
    controller.applyTerrain('world-terrain');
    expect(render(requested)).toBe('world-terrain');
    expect(controller.onTerrainApplied).toHaveBeenCalledTimes(1);
  });

  it('sets basemap and terrain directly before anything is displayed', () => {
    const { controller, render, runSceneActivity } = harness(false);
    render(state('?terrain=world-terrain'));
    expect(runSceneActivity).not.toHaveBeenCalled();
    expect(controller.setTerrain).toHaveBeenCalledWith('world-terrain');
    expect(controller.setBasemap).toHaveBeenCalledWith('dark-streets');
  });
});
