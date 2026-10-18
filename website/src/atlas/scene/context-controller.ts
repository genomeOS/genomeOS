/** Basemap and physical-terrain lifecycle for Atlas design §11. */

import {
  ArcGisBaseMapType,
  ArcGisMapServerImageryProvider,
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Ion,
  IonImageryProvider,
  IonWorldImageryStyle,
  OpenStreetMapImageryProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  buildModuleUrl,
  createWorldImageryAsync,
  createWorldTerrainAsync,
  type CesiumWidget,
  type TerrainProvider,
  type TileProviderError,
} from 'cesium';

import {
  availableBasemaps,
  availableTerrains,
  ION_UNAVAILABLE,
  terrainOption,
} from '../earth-style-catalog';
import type { BasemapId, TerrainId } from '../url-state';

// Cesium-free helpers moved for the lazy scene chunk (fast-load design §B.6.11); kept for callers.
export {
  availableBasemaps,
  availableTerrains,
  ionCapability,
  type SceneCapability,
} from '../earth-style-catalog';

export interface ContextWarning {
  id: 'basemap' | 'terrain';
  message: string;
}

export interface ContextWarningClear {
  id: ContextWarning['id'];
  message: null;
}

export type ContextWarningUpdate = ContextWarning | ContextWarningClear;
export type ContextWarningListener = (warning: ContextWarningUpdate) => void;

export interface ContextControllerOptions {
  /** Called with each terrain once its provider is on the globe; the terrain shading follows it. */
  onTerrainApplied?: (terrain: TerrainId) => void;
  /** Builds the World Terrain provider; defaults to Cesium ion's, with normals and water mask. */
  worldTerrain?: () => Promise<TerrainProvider>;
}

function ionWorldTerrain(): Promise<TerrainProvider> {
  return createWorldTerrainAsync({
    requestVertexNormals: true,
    requestWaterMask: true,
  });
}

export interface BasemapAppearanceTarget {
  alpha: number;
  brightness: number;
}

export function applyBasemapAppearance(
  layer: BasemapAppearanceTarget,
  opacity: number,
  brightness: number,
): void {
  layer.alpha = Math.min(1, Math.max(0, opacity));
  layer.brightness = Math.min(1, Math.max(0, brightness));
}

function publicMapLayer(url: string): ImageryLayer {
  return new ImageryLayer(
    new UrlTemplateImageryProvider({
      credit: new Credit(
        '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
        true,
      ),
      enablePickFeatures: false,
      maximumLevel: 18,
      url,
    }),
  );
}

const STADIA_CREDIT = `&copy; <a href="https://www.stadiamaps.com/" target="_blank">Stadia Maps</a>
  &copy; <a href="https://stamen.com/" target="_blank">Stamen Design</a>
  &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a>
  &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>`;

async function galleryMapLayer(
  basemap: BasemapId,
  publicImageryUrl: string,
): Promise<ImageryLayer> {
  if (basemap === 'dark-streets') return publicMapLayer(publicImageryUrl);
  if (
    basemap === 'aerial' ||
    basemap === 'aerial-labels' ||
    basemap === 'roads'
  ) {
    const style = {
      aerial: IonWorldImageryStyle.AERIAL,
      'aerial-labels': IonWorldImageryStyle.AERIAL_WITH_LABELS,
      roads: IonWorldImageryStyle.ROAD,
    }[basemap];
    return new ImageryLayer(await createWorldImageryAsync({ style }));
  }
  if (basemap === 'arcgis-imagery') {
    return new ImageryLayer(
      await ArcGisMapServerImageryProvider.fromBasemapType(
        ArcGisBaseMapType.SATELLITE,
        { enablePickFeatures: false },
      ),
    );
  }
  if (basemap === 'arcgis-hillshade') {
    return new ImageryLayer(
      await ArcGisMapServerImageryProvider.fromBasemapType(
        ArcGisBaseMapType.HILLSHADE,
        { enablePickFeatures: false },
      ),
    );
  }
  if (basemap === 'esri-ocean') {
    return new ImageryLayer(
      await ArcGisMapServerImageryProvider.fromBasemapType(
        ArcGisBaseMapType.OCEANS,
        { enablePickFeatures: false },
      ),
    );
  }
  if (basemap === 'openstreetmap') {
    return new ImageryLayer(
      new OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
      }),
    );
  }
  if (
    basemap === 'stadia-watercolor' ||
    basemap === 'stadia-toner' ||
    basemap === 'stadia-smooth' ||
    basemap === 'stadia-dark'
  ) {
    const details = {
      'stadia-dark': ['alidade_smooth_dark', 'png'],
      'stadia-smooth': ['alidade_smooth', 'png'],
      'stadia-toner': ['stamen_toner', 'png'],
      'stadia-watercolor': ['stamen_watercolor', 'jpg'],
    }[basemap];
    return new ImageryLayer(
      new OpenStreetMapImageryProvider({
        credit: STADIA_CREDIT,
        fileExtension: details[1],
        retinaTiles:
          basemap !== 'stadia-watercolor' &&
          (globalThis.devicePixelRatio ?? 1) >= 2,
        url: `https://tiles.stadiamaps.com/tiles/${details[0]}/`,
      }),
    );
  }
  if (basemap === 'natural-earth-ii') {
    return new ImageryLayer(
      await TileMapServiceImageryProvider.fromUrl(
        buildModuleUrl('Assets/Textures/NaturalEarthII'),
      ),
    );
  }
  const assetId = {
    'azure-aerial': 3891168,
    'azure-roads': 3891169,
    'blue-marble': 3845,
    'earth-at-night': 3812,
    'google-contour': 3830186,
    'google-roadmap': 3830184,
    'google-satellite': 3830182,
    'google-satellite-labels': 3830183,
    'sentinel-2': 3954,
  }[basemap];
  return new ImageryLayer(await IonImageryProvider.fromAssetId(assetId));
}

export class ContextController {
  readonly #widget: CesiumWidget;
  readonly #token: string;
  readonly #publicImageryUrl: string;
  readonly #onWarning: ContextWarningListener;
  readonly #options: ContextControllerOptions;
  #activeLayer: ImageryLayer | null = null;
  // The requested basemap and its load; a repeat request for the same id reuses it.
  #basemapRequest: { basemap: BasemapId; result: Promise<boolean> } | null =
    null;
  // The request whose layer is on the globe; a failed request falls back to it.
  #basemapApplied: { basemap: BasemapId; result: Promise<boolean> } | null =
    null;
  #basemapBrightness = 0.5;
  #basemapOpacity = 1;
  #basemapSequence = 0;
  // As for basemaps: the requested terrain and its load, and the request whose provider is on
  // the globe. Scene creation asks for the URL's terrain twice (applySceneStyle and the
  // explorer's terrain effect); the second reuses the first, so ion is asked once (#483).
  #terrainRequest: { terrain: TerrainId; result: Promise<boolean> } | null =
    null;
  #terrainApplied: { terrain: TerrainId; result: Promise<boolean> } | null =
    null;
  #terrainSequence = 0;
  #removeTerrainErrors: (() => void) | null = null;

  constructor(
    widget: CesiumWidget,
    token: string,
    publicImageryUrl: string,
    onWarning: ContextWarningListener,
    options: ContextControllerOptions = {},
  ) {
    this.#widget = widget;
    this.#token = token.trim();
    this.#publicImageryUrl = publicImageryUrl;
    this.#onWarning = onWarning;
    this.#options = options;
    if (this.#token) Ion.defaultAccessToken = this.#token;
  }

  capabilities(): {
    basemaps: Record<BasemapId, boolean>;
    terrains: Record<TerrainId, boolean>;
  } {
    return {
      basemaps: availableBasemaps(this.#token),
      terrains: this.#terrains(),
    };
  }

  /** An injected World Terrain factory (the e2e build's stand-in) needs no ion token. */
  #terrains(): Record<TerrainId, boolean> {
    const terrains = availableTerrains(this.#token);
    return this.#options.worldTerrain
      ? { ...terrains, 'world-terrain': true }
      : terrains;
  }

  setBasemap(basemap: BasemapId): Promise<boolean> {
    if (this.#basemapRequest?.basemap === basemap) {
      return this.#basemapRequest.result;
    }
    const result = this.#loadBasemap(basemap);
    const request = { basemap, result };
    this.#basemapRequest = request;
    void result.then((applied) => {
      if (applied) this.#basemapApplied = request;
      else if (this.#basemapRequest === request)
        this.#basemapRequest = this.#basemapApplied;
    });
    return result;
  }

  async #loadBasemap(basemap: BasemapId): Promise<boolean> {
    const sequence = ++this.#basemapSequence;
    if (!availableBasemaps(this.#token)[basemap]) {
      this.#onWarning({
        id: 'basemap',
        message: `${ION_UNAVAILABLE} The previous basemap remains active.`,
      });
      return false;
    }
    try {
      const incoming = await galleryMapLayer(basemap, this.#publicImageryUrl);
      if (sequence !== this.#basemapSequence) return false;
      applyBasemapAppearance(
        incoming,
        this.#basemapOpacity,
        this.#basemapBrightness,
      );
      const previous = this.#activeLayer;
      this.#widget.imageryLayers.add(incoming, 0);
      this.#activeLayer = incoming;
      if (previous) this.#widget.imageryLayers.remove(previous, true);
      incoming.errorEvent.addEventListener(() => {
        if (this.#activeLayer !== incoming) return;
        this.#onWarning({
          id: 'basemap',
          message: `${basemap} map tiles could not be loaded. Try another basemap.`,
        });
      });
      this.#onWarning({ id: 'basemap', message: null });
      this.#widget.scene.requestRender();
      return true;
    } catch {
      if (sequence === this.#basemapSequence) {
        this.#onWarning({
          id: 'basemap',
          message: `${basemap} could not be loaded. The previous basemap remains active.`,
        });
      }
      return false;
    }
  }

  setTerrain(terrain: TerrainId): Promise<boolean> {
    if (this.#terrainRequest?.terrain === terrain) {
      return this.#terrainRequest.result;
    }
    const result = this.#loadTerrain(terrain);
    const request = { result, terrain };
    this.#terrainRequest = request;
    void result.then((applied) => {
      if (applied) this.#terrainApplied = request;
      else if (this.#terrainRequest === request)
        this.#terrainRequest = this.#terrainApplied;
    });
    return result;
  }

  async #loadTerrain(terrain: TerrainId): Promise<boolean> {
    const sequence = ++this.#terrainSequence;
    if (!this.#terrains()[terrain]) {
      this.#onWarning({
        id: 'terrain',
        message: `${ION_UNAVAILABLE} The smooth globe remains active.`,
      });
      return false;
    }
    try {
      const provider =
        terrain === 'smooth-globe'
          ? new EllipsoidTerrainProvider()
          : await (this.#options.worldTerrain ?? ionWorldTerrain)();
      if (sequence !== this.#terrainSequence) return false;
      this.#widget.terrainProvider = provider;
      this.#watchTerrainErrors(terrain, provider);
      this.#options.onTerrainApplied?.(terrain);
      this.#onWarning({ id: 'terrain', message: null });
      this.#widget.scene.requestRender();
      return true;
    } catch {
      if (sequence === this.#terrainSequence) {
        this.#onWarning({
          id: 'terrain',
          message: `${terrain} could not be loaded. The previous terrain remains active.`,
        });
      }
      return false;
    }
  }

  /**
   * Tile-level failures of the terrain on the globe (an ion outage after the provider loaded, a
   * blocked tile request) raise the terrain warning, once per provider; a replaced provider's
   * failures are no longer heard. Cesium logs a tile failure to the console only while nothing
   * listens for it, so each one is still logged here.
   */
  #watchTerrainErrors(terrain: TerrainId, provider: TerrainProvider): void {
    this.#removeTerrainErrors?.();
    const { label } = terrainOption(terrain);
    let warned = false;
    this.#removeTerrainErrors =
      provider.errorEvent?.addEventListener((error: TileProviderError) => {
        console.warn(`A ${label} tile could not be loaded.`, error.message);
        if (warned) return;
        warned = true;
        this.#onWarning({
          id: 'terrain',
          message: `Some ${label} tiles could not be loaded, so relief may be missing in places.`,
        });
      }) ?? null;
  }

  /**
   * Stops listening to the terrain on the globe, and drops a terrain still loading, when the
   * scene is torn down.
   */
  destroy(): void {
    this.#terrainSequence += 1;
    this.#removeTerrainErrors?.();
    this.#removeTerrainErrors = null;
  }

  setVisible(visible: boolean): void {
    if (this.#activeLayer) this.#activeLayer.show = visible;
  }

  setAppearance(opacity: number, brightness: number): void {
    this.#basemapOpacity = opacity;
    this.#basemapBrightness = brightness;
    if (this.#activeLayer)
      applyBasemapAppearance(this.#activeLayer, opacity, brightness);
    this.#widget.scene.requestRender();
  }
}
