import type { CesiumWidget, TerrainProvider } from 'cesium';
import { describe, expect, it, vi } from 'vitest';

import {
  ContextController,
  type ContextControllerOptions,
} from '../src/atlas/scene/context-controller';

function fakeWidget() {
  return {
    imageryLayers: { add: vi.fn(), remove: vi.fn() },
    scene: { requestRender: vi.fn() },
  };
}

function controllerFor(
  widget = fakeWidget(),
  token = '',
  options: ContextControllerOptions = {},
) {
  const warnings = vi.fn();
  const controller = new ContextController(
    widget as unknown as CesiumWidget,
    token,
    'https://tiles.example.org/{z}/{x}/{y}.png',
    warnings,
    options,
  );
  return { controller, widget, warnings };
}

describe('ContextController.setBasemap', () => {
  it('treats a request for the requested basemap as a no-op', async () => {
    const { controller, widget } = controllerFor();
    const first = controller.setBasemap('dark-streets');
    expect(controller.setBasemap('dark-streets')).toBe(first);
    await expect(first).resolves.toBe(true);
    await expect(controller.setBasemap('dark-streets')).resolves.toBe(true);
    expect(widget.imageryLayers.add).toHaveBeenCalledTimes(1);
  });

  it('still switches away from and back to a basemap', async () => {
    const { controller, widget } = controllerFor();
    await controller.setBasemap('dark-streets');
    await controller.setBasemap('openstreetmap');
    await controller.setBasemap('dark-streets');
    expect(widget.imageryLayers.add).toHaveBeenCalledTimes(3);
    expect(widget.imageryLayers.remove).toHaveBeenCalledTimes(2);
  });

  it('keeps the active basemap a no-op after a failed switch away from it', async () => {
    const { controller, widget } = controllerFor();
    const active = controller.setBasemap('dark-streets');
    await expect(active).resolves.toBe(true);
    await expect(controller.setBasemap('aerial')).resolves.toBe(false);
    const again = controller.setBasemap('dark-streets');
    await expect(again).resolves.toBe(true);
    expect(widget.imageryLayers.add).toHaveBeenCalledTimes(1);
    expect(widget.imageryLayers.remove).not.toHaveBeenCalled();
    expect(again).toBe(active);
  });

  it('retries a basemap whose previous request failed', async () => {
    const { controller, warnings } = controllerFor();
    await expect(controller.setBasemap('aerial')).resolves.toBe(false);
    await expect(controller.setBasemap('aerial')).resolves.toBe(false);
    expect(warnings).toHaveBeenCalledTimes(2);
  });
});

describe('ContextController terrain (#483)', () => {
  it('reports each terrain it puts on the globe, for the terrain shading', async () => {
    const onTerrainApplied = vi.fn();
    const { controller, warnings } = controllerFor(fakeWidget(), '', {
      onTerrainApplied,
    });
    await expect(controller.setTerrain('smooth-globe')).resolves.toBe(true);
    expect(onTerrainApplied).toHaveBeenCalledWith('smooth-globe');
    // No ion token: World Terrain never reaches the globe, so it is never reported.
    await expect(controller.setTerrain('world-terrain')).resolves.toBe(false);
    expect(onTerrainApplied).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'terrain' }),
    );
  });
});

/** A terrain provider whose tile errors the test raises. */
function fakeTerrain() {
  const listeners = new Set<(error: unknown) => void>();
  return {
    errorEvent: {
      addEventListener(listener: (error: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get numberOfListeners() {
        return listeners.size;
      },
      raiseEvent(error: unknown = {}) {
        for (const listener of [...listeners]) listener(error);
      },
    },
  };
}

function terrainController(
  worldTerrain: () => Promise<TerrainProvider>,
  onTerrainApplied = vi.fn(),
) {
  // A token makes World Terrain available; the injected factory stands in for ion.
  return {
    ...controllerFor(fakeWidget(), 'test-token', {
      onTerrainApplied,
      worldTerrain,
    }),
    onTerrainApplied,
  };
}

describe('ContextController.setTerrain (#483)', () => {
  it('reuses the in-flight request for the same terrain, so scene creation asks ion once', async () => {
    const provider = fakeTerrain();
    const worldTerrain = vi.fn(() =>
      Promise.resolve(provider as unknown as TerrainProvider),
    );
    const { controller, onTerrainApplied, widget } =
      terrainController(worldTerrain);
    const first = controller.setTerrain('world-terrain');
    expect(controller.setTerrain('world-terrain')).toBe(first);
    await expect(first).resolves.toBe(true);
    await expect(controller.setTerrain('world-terrain')).resolves.toBe(true);
    expect(worldTerrain).toHaveBeenCalledTimes(1);
    expect(onTerrainApplied).toHaveBeenCalledTimes(1);
    expect((widget as { terrainProvider?: unknown }).terrainProvider).toBe(
      provider,
    );
  });

  it('still switches away from and back to a terrain', async () => {
    const worldTerrain = vi.fn(() =>
      Promise.resolve(fakeTerrain() as unknown as TerrainProvider),
    );
    const { controller, onTerrainApplied } = terrainController(worldTerrain);
    await controller.setTerrain('world-terrain');
    await controller.setTerrain('smooth-globe');
    await controller.setTerrain('world-terrain');
    expect(worldTerrain).toHaveBeenCalledTimes(2);
    expect(onTerrainApplied.mock.calls.map(([terrain]) => terrain)).toEqual([
      'world-terrain',
      'smooth-globe',
      'world-terrain',
    ]);
  });

  it('keeps the active terrain a no-op after a failed switch away from it', async () => {
    const { controller, onTerrainApplied } = terrainController(() =>
      Promise.reject(new Error('ion is down')),
    );
    const active = controller.setTerrain('smooth-globe');
    await expect(active).resolves.toBe(true);
    await expect(controller.setTerrain('world-terrain')).resolves.toBe(false);
    expect(controller.setTerrain('smooth-globe')).toBe(active);
    expect(onTerrainApplied).toHaveBeenCalledTimes(1);
  });

  it('retries a terrain whose previous request failed', async () => {
    const worldTerrain = vi.fn(() => Promise.reject(new Error('offline')));
    const { controller, warnings } = terrainController(worldTerrain);
    await expect(controller.setTerrain('world-terrain')).resolves.toBe(false);
    await expect(controller.setTerrain('world-terrain')).resolves.toBe(false);
    expect(worldTerrain).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveBeenLastCalledWith({
      id: 'terrain',
      message:
        'world-terrain could not be loaded. The previous terrain remains active.',
    });
  });

  it('surfaces tile-load failures of the active terrain as the terrain warning, once', async () => {
    const provider = fakeTerrain();
    const { controller, warnings } = terrainController(() =>
      Promise.resolve(provider as unknown as TerrainProvider),
    );
    await controller.setTerrain('world-terrain');
    expect(provider.errorEvent.numberOfListeners).toBe(1);
    warnings.mockClear();
    provider.errorEvent.raiseEvent();
    provider.errorEvent.raiseEvent();
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith({
      id: 'terrain',
      message:
        'Some Cesium World Terrain tiles could not be loaded, so relief may be missing in places.',
    });
  });

  it('stops listening to a terrain once another replaces it', async () => {
    const provider = fakeTerrain();
    const { controller, warnings } = terrainController(() =>
      Promise.resolve(provider as unknown as TerrainProvider),
    );
    await controller.setTerrain('world-terrain');
    await controller.setTerrain('smooth-globe');
    expect(provider.errorEvent.numberOfListeners).toBe(0);
    warnings.mockClear();
    provider.errorEvent.raiseEvent();
    expect(warnings).not.toHaveBeenCalled();
  });
});
