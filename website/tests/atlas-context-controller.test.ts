import type { CesiumWidget } from 'cesium';
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
