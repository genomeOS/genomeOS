/** The e2e build's synthetic stand-in for Cesium World Terrain (#483): CI has no ion token, so a
 * browser test asks for a cone of known height, and a Gaussian peak under supported HbS cells
 * (terrain draping design, "Test plan"), instead. Inert outside `npm run build:e2e`. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  Cartesian2,
  Cartographic,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  ImageryLayerCollection,
  Math as CesiumMath,
  SceneTransforms,
  SunLight,
  type CesiumWidget,
  type HeightmapTerrainData,
  type TerrainProvider,
} from 'cesium';
import {
  UNITS,
  cellToLatLng,
  greatCircleDistance,
  gridDisk,
  latLngToCell,
} from 'h3-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { atlasCatalogSchema } from '../src/atlas/contracts';
import { syntheticTerrainTestHook } from '../src/atlas/e2e-hooks';
import { isSupportedCode } from '../src/atlas/geometry/support-codes';
import { gridRowOf } from '../src/atlas/geometry/topology';
import { decodeGrid, decodeRender } from '../src/atlas/gosa/decode';
import { ContextController } from '../src/atlas/scene/context-controller';
import { addDrapedImageryLayer } from '../src/atlas/scene/draped/draped-imagery-layer';
import {
  SYNTHETIC_CONE,
  SYNTHETIC_PEAK,
  createSyntheticTerrain,
  publishTerrainProbe,
  syntheticConeHeight,
  syntheticTerrainHeight,
} from '../src/atlas/scene/synthetic-terrain';
import { fakeProvider } from './helpers/imagery-fakes';
import { FakeEvent } from './helpers/scene-fakes';
import { fixtureBytes, onlyGrid, toBuffer } from './support/gosa-builder';

afterEach(() => {
  vi.restoreAllMocks();
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

/** The height a level-`level` heightmap tile of the synthetic terrain serves at a point. */
async function tileHeightAt(lon: number, lat: number, level: number) {
  const provider = createSyntheticTerrain();
  expect(provider).toBeInstanceOf(CustomHeightmapTerrainProvider);
  const point = Cartographic.fromDegrees(lon, lat);
  const tile = provider.tilingScheme.positionToTileXY(point, level)!;
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
  return data.interpolateHeight(rectangle, point.longitude, point.latitude);
}

describe('createSyntheticTerrain', () => {
  it('serves the cone as heightmap tiles', async () => {
    const height = await tileHeightAt(
      SYNTHETIC_CONE.lon,
      SYNTHETIC_CONE.lat,
      8,
    );
    // Within one heightmap cell of the apex.
    expect(height).toBeGreaterThan(SYNTHETIC_CONE.peakMetres * 0.97);
    expect(height).toBeLessThanOrEqual(SYNTHETIC_CONE.peakMetres);
  });
});

describe('syntheticTerrainHeight', () => {
  it('adds a 6 km Gaussian peak, σ 40 km, under the Madrid HbS survey to the cone', () => {
    const { lat, lon, peakMetres, sigmaKm } = SYNTHETIC_PEAK;
    expect(SYNTHETIC_PEAK).toEqual({
      lat: 40.419,
      lon: -3.709,
      peakMetres: 6_000,
      sigmaKm: 40,
    });
    expect(syntheticTerrainHeight(lon, lat)).toBeCloseTo(peakMetres, 6);
    expect(syntheticTerrainHeight(lon, lat + km(sigmaKm))).toBeCloseTo(
      peakMetres * Math.exp(-0.5),
      0,
    );
    expect(syntheticTerrainHeight(lon, lat + km(2 * sigmaKm))).toBeCloseTo(
      peakMetres * Math.exp(-2),
      0,
    );
    expect(
      syntheticTerrainHeight(SYNTHETIC_CONE.lon, SYNTHETIC_CONE.lat),
    ).toBeCloseTo(SYNTHETIC_CONE.peakMetres, 6);
    expect(syntheticTerrainHeight(lon + 180, -lat)).toBeCloseTo(0, 6);
  });

  it('serves the peak as heightmap tiles', async () => {
    const height = await tileHeightAt(
      SYNTHETIC_PEAK.lon,
      SYNTHETIC_PEAK.lat,
      8,
    );
    // Within one heightmap cell of the apex.
    expect(height).toBeGreaterThan(SYNTHETIC_PEAK.peakMetres * 0.97);
    expect(height).toBeLessThanOrEqual(SYNTHETIC_PEAK.peakMetres);
  });
});

describe('SYNTHETIC_PEAK on the e2e fixture', () => {
  it('stands where hbs-rs334 supports every res-4 cell within 2σ of the apex', () => {
    const directory = path.resolve(import.meta.dirname, 'fixtures/atlas/e2e');
    const catalog = atlasCatalogSchema.parse(
      JSON.parse(readFileSync(path.join(directory, 'catalog.json'), 'utf8')),
    );
    const { entry, gridSha256 } = onlyGrid(catalog);
    const grid = decodeGrid(toBuffer(fixtureBytes(directory, entry.url)), {
      entry,
      gridSha256,
    });
    const ref = catalog.artifacts.find(({ id }) => id === 'hbs-rs334')!;
    const { support } = decodeRender(
      toBuffer(fixtureBytes(directory, ref.web.render.url)),
      { grid, ref },
    );
    const apex: [number, number] = [SYNTHETIC_PEAK.lat, SYNTHETIC_PEAK.lon];
    const near = gridDisk(latLngToCell(...apex, grid.resolution), 3).filter(
      (cell) =>
        greatCircleDistance(apex, cellToLatLng(cell), UNITS.km) <=
        2 * SYNTHETIC_PEAK.sigmaKm,
    );
    expect(near.length).toBeGreaterThanOrEqual(7);
    for (const cell of near) {
      const row = gridRowOf(grid, cell);
      expect(row, cell).not.toBeNull();
      expect(isSupportedCode(support[row!]), cell).toBe(true);
    }
  });
});

/** A widget over the cone, with a real ImageryLayerCollection under `scene.imageryLayers`. */
function fakeWidget(terrainProvider: unknown = new EllipsoidTerrainProvider()) {
  return {
    camera: {
      positionCartographic: Cartographic.fromDegrees(
        SYNTHETIC_CONE.lon,
        SYNTHETIC_CONE.lat,
        20_000,
      ),
    },
    scene: {
      canvas: { clientHeight: 600, clientWidth: 800 },
      globe: {
        enableLighting: true,
        getHeight: vi.fn(() => 5_000 as number | undefined),
        lambertDiffuseMultiplier: 0.9,
        showGroundAtmosphere: false,
        showWaterEffect: false,
        tilesLoaded: true,
        vertexShadowDarkness: 0.45,
      },
      imageryLayers: new ImageryLayerCollection(),
      light: new SunLight() as unknown,
      preRender: new FakeEvent(),
      requestRender: vi.fn(),
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
    const toWindow = vi
      .spyOn(SceneTransforms, 'worldToWindowCoordinates')
      .mockReturnValue(new Cartesian2(412, 288));
    const widget = fakeWidget(new EllipsoidTerrainProvider());
    const unpublish = publishTerrainProbe(widget as unknown as CesiumWidget);
    expect(page.__atlasTerrainProbe!()).toEqual({
      apexGround: 5_000,
      apexWindow: { x: 412, y: 288 },
      cameraHeight: expect.closeTo(20_000, 6),
      draped: false,
      enableLighting: true,
      groundHeight: 5_000,
      imageryLayers: [],
      lambertDiffuseMultiplier: 0.9,
      layerStack: [],
      provider: 'ellipsoid',
      showGroundAtmosphere: false,
      showWaterEffect: false,
      sunLight: true,
      tilesLoaded: true,
      verticalExaggeration: 2,
      verticalExaggerationRelativeHeight: 0,
      vertexShadowDarkness: 0.45,
    });
    // The summit on the rendered ground: the peak's apex at the height the globe reports there.
    expect(toWindow.mock.lastCall![0]).toBe(widget.scene);
    const summit = Cartographic.fromCartesian(toWindow.mock.lastCall![1]);
    expect(summit.longitude).toBeCloseTo(
      CesiumMath.toRadians(SYNTHETIC_PEAK.lon),
      9,
    );
    expect(summit.latitude).toBeCloseTo(
      CesiumMath.toRadians(SYNTHETIC_PEAK.lat),
      9,
    );
    expect(summit.height).toBeCloseTo(5_000, 3);
    expect(widget.scene.globe.getHeight).toHaveBeenCalledWith(
      expect.objectContaining({
        latitude: expect.closeTo(CesiumMath.toRadians(SYNTHETIC_PEAK.lat), 12),
        longitude: expect.closeTo(CesiumMath.toRadians(SYNTHETIC_PEAK.lon), 12),
      }),
    );

    // Off the canvas, the summit has no window position.
    toWindow.mockReturnValueOnce(new Cartesian2(-1, 288));
    expect(page.__atlasTerrainProbe!().apexWindow).toBeNull();
    toWindow.mockReturnValueOnce(new Cartesian2(412, 600));
    expect(page.__atlasTerrainProbe!().apexWindow).toBeNull();
    // Behind the camera, Cesium returns none.
    toWindow.mockReturnValueOnce(undefined as unknown as Cartesian2);
    expect(page.__atlasTerrainProbe!().apexWindow).toBeNull();

    widget.terrainProvider = createSyntheticTerrain();
    widget.scene.light = {};
    widget.scene.globe.getHeight.mockReturnValue(undefined);
    toWindow.mockClear();
    expect(page.__atlasTerrainProbe!()).toMatchObject({
      apexGround: null,
      apexWindow: null,
      groundHeight: null,
      provider: 'synthetic',
      sunLight: false,
    });
    // No ground under the summit yet: nothing to place on the window.
    expect(toWindow).not.toHaveBeenCalled();
    widget.scene.globe.getHeight.mockReturnValue(5_000);
    toWindow.mockReturnValue(undefined as unknown as Cartesian2);
    expect(page.__atlasTerrainProbe!()).toMatchObject({
      apexGround: 5_000,
      apexWindow: null,
      groundHeight: 5_000,
    });
    unpublish();
    expect(page.__atlasTerrainProbe).toBeUndefined();
  });

  it('lists the shown imagery layers and every layer bottom to top, and says whether the surface is draped', () => {
    const page = {} as Window;
    vi.stubGlobal('window', page);
    vi.spyOn(SceneTransforms, 'worldToWindowCoordinates').mockReturnValue(
      new Cartesian2(412, 288),
    );
    const widget = fakeWidget(); // a real ImageryLayerCollection under scene.imageryLayers
    const { scene } = widget as unknown as CesiumWidget;
    const basemap =
      widget.scene.imageryLayers.addImageryProvider(fakeProvider());
    const surface = addDrapedImageryLayer({
      alpha: 0.5,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    const outlines = addDrapedImageryLayer({
      alpha: 0,
      name: 'atlas-outlines',
      provider: fakeProvider(),
      scene,
    });
    const unpublish = publishTerrainProbe(widget as never);
    expect(window.__atlasTerrainProbe!()).toMatchObject({
      draped: true,
      imageryLayers: ['basemap', 'atlas-surface'],
      // Every layer on the collection, the base guard and the layer at alpha 0 included.
      layerStack: ['basemap', 'guard', 'atlas-surface', 'atlas-outlines'],
    });

    // Bottom to top, each shown layer at alpha > 0; a hidden or transparent surface is not draped.
    outlines.setAlpha(0.92);
    expect(page.__atlasTerrainProbe!().imageryLayers).toEqual([
      'basemap',
      'atlas-surface',
      'atlas-outlines',
    ]);
    surface.setShown(false);
    basemap.show = false;
    expect(page.__atlasTerrainProbe!()).toMatchObject({
      draped: false,
      imageryLayers: ['atlas-outlines'],
      layerStack: ['basemap', 'guard', 'atlas-surface', 'atlas-outlines'],
    });
    surface.setShown(true);
    surface.setAlpha(0);
    expect(page.__atlasTerrainProbe!()).toMatchObject({
      draped: false,
      imageryLayers: ['atlas-outlines'],
    });
    outlines.destroy();
    surface.destroy();
    basemap.show = true;
    expect(page.__atlasTerrainProbe!()).toMatchObject({
      draped: false,
      imageryLayers: ['basemap'],
      layerStack: ['basemap'],
    });
    unpublish();
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
