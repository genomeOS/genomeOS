/** The e2e build's synthetic stand-in for Cesium World Terrain (#483): CI has no ion token, so a
 * browser test asks for a cone of known height instead. Inert outside `npm run build:e2e`. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  Cartographic,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  SunLight,
  type CesiumWidget,
  type HeightmapTerrainData,
  type TerrainProvider,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { syntheticTerrainTestHook } from '../src/atlas/e2e-hooks';
import { ContextController } from '../src/atlas/scene/context-controller';
import {
  SYNTHETIC_CONE,
  createSyntheticTerrain,
  publishTerrainProbe,
  syntheticConeHeight,
} from '../src/atlas/scene/synthetic-terrain';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Kilometres along the meridian, as degrees of latitude. */
const km = (distance: number) => distance / 111.195;

describe('syntheticConeHeight', () => {
  it('peaks at the apex and falls linearly to sea level at its radius', () => {
    const { lat, lon, peakMetres, radiusKm } = SYNTHETIC_CONE;
    expect(syntheticConeHeight(lon, lat)).toBe(peakMetres);
    expect(syntheticConeHeight(lon, lat + km(radiusKm / 2))).toBeCloseTo(
      peakMetres / 2,
      -1,
    );
    expect(syntheticConeHeight(lon, lat + km(radiusKm * 1.5))).toBe(0);
    expect(syntheticConeHeight(lon + 180, -lat)).toBe(0);
  });
});

describe('createSyntheticTerrain', () => {
  it('serves the cone as heightmap tiles', async () => {
    const provider = createSyntheticTerrain();
    expect(provider).toBeInstanceOf(CustomHeightmapTerrainProvider);
    const level = 8;
    const apex = Cartographic.fromDegrees(
      SYNTHETIC_CONE.lon,
      SYNTHETIC_CONE.lat,
    );
    const tile = provider.tilingScheme.positionToTileXY(apex, level)!;
    const data = (await provider.requestTileGeometry(
      tile.x,
      tile.y,
      level,
    )) as HeightmapTerrainData;
    const rectangle = provider.tilingScheme.tileXYToRectangle(
      tile.x,
      tile.y,
      level,
    );
    const height = data.interpolateHeight(
      rectangle,
      apex.longitude,
      apex.latitude,
    );
    // Within one heightmap cell of the apex.
    expect(height).toBeGreaterThan(SYNTHETIC_CONE.peakMetres * 0.97);
    expect(height).toBeLessThanOrEqual(SYNTHETIC_CONE.peakMetres);
  });
});

function fakeWidget(terrainProvider: unknown) {
  return {
    camera: {
      positionCartographic: Cartographic.fromDegrees(
        SYNTHETIC_CONE.lon,
        SYNTHETIC_CONE.lat,
        20_000,
      ),
    },
    scene: {
      globe: {
        enableLighting: true,
        getHeight: vi.fn(() => 5_000 as number | undefined),
        tilesLoaded: true,
      },
      light: new SunLight() as unknown,
      verticalExaggeration: 2,
      verticalExaggerationRelativeHeight: 0,
    },
    terrainProvider,
  };
}

describe('publishTerrainProbe', () => {
  it('reports what the browser test asserts, and unpublishes', () => {
    const page = {} as Window;
    vi.stubGlobal('window', page);
    const widget = fakeWidget(new EllipsoidTerrainProvider());
    const unpublish = publishTerrainProbe(widget as unknown as CesiumWidget);
    expect(page.__atlasTerrainProbe!()).toEqual({
      cameraHeight: expect.closeTo(20_000, 6),
      enableLighting: true,
      groundHeight: 5_000,
      provider: 'ellipsoid',
      sunLight: true,
      tilesLoaded: true,
      verticalExaggeration: 2,
      verticalExaggerationRelativeHeight: 0,
    });
    widget.terrainProvider = createSyntheticTerrain();
    widget.scene.light = {};
    widget.scene.globe.getHeight.mockReturnValue(undefined);
    expect(page.__atlasTerrainProbe!()).toMatchObject({
      groundHeight: null,
      provider: 'synthetic',
      sunLight: false,
    });
    unpublish();
    expect(page.__atlasTerrainProbe).toBeUndefined();
  });
});

describe('syntheticTerrainTestHook', () => {
  const widget = fakeWidget(null) as unknown as CesiumWidget;

  it('is inert outside the e2e build, even when a page asks', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '');
    vi.stubGlobal('window', { __atlasSyntheticTerrain: true });
    expect(syntheticTerrainTestHook(widget)).toBeUndefined();
  });

  it('is inert in the e2e build unless the test asks for it', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    vi.stubGlobal('window', {});
    expect(syntheticTerrainTestHook(widget)).toBeUndefined();
  });

  it('stands the cone in for World Terrain and publishes the probe', async () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const page = { __atlasSyntheticTerrain: true } as Window;
    vi.stubGlobal('window', page);
    const hook = syntheticTerrainTestHook(widget)!;
    expect(hook).toBeDefined();
    await expect(hook.worldTerrain()).resolves.toBeInstanceOf(
      CustomHeightmapTerrainProvider,
    );
    expect(typeof page.__atlasTerrainProbe).toBe('function');
    hook.destroy();
    expect(page.__atlasTerrainProbe).toBeUndefined();
  });
});

describe('ContextController with a World Terrain stand-in', () => {
  it('offers and loads World Terrain without an ion token', async () => {
    const provider = createSyntheticTerrain();
    const widget = {
      imageryLayers: { add: vi.fn(), remove: vi.fn() },
      scene: { requestRender: vi.fn() },
      terrainProvider: undefined as unknown,
    };
    const controller = new ContextController(
      widget as unknown as CesiumWidget,
      '',
      'https://tiles.example.org/{z}/{x}/{y}.png',
      vi.fn(),
      { worldTerrain: () => Promise.resolve(provider as TerrainProvider) },
    );
    expect(controller.capabilities().terrains['world-terrain']).toBe(true);
    // Basemaps still need ion: only the terrain has a stand-in.
    expect(controller.capabilities().basemaps.aerial).toBe(false);
    await expect(controller.setTerrain('world-terrain')).resolves.toBe(true);
    expect(widget.terrainProvider).toBe(provider);
  });
});

describe('production build', () => {
  it('carries no synthetic terrain', () => {
    const assets = path.resolve(import.meta.dirname, '../dist/_astro');
    for (const file of readdirSync(assets).filter((name) =>
      name.endsWith('.js'),
    )) {
      const source = readFileSync(path.join(assets, file), 'utf8');
      expect(source, file).not.toContain('__atlasSyntheticTerrain');
      expect(source, file).not.toContain('__atlasTerrainProbe');
    }
  });
});
