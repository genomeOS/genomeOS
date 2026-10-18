/**
 * Shared Cesium scene contracts for Atlas design §11, with the draped-layer contracts of the
 * terrain draping design, "Per layer under World Terrain" (#483), declared here so the lazy draped
 * modules and their callers compile against one interface.
 */

import type {
  Event,
  ImageryLayer,
  ImageryProvider,
  Primitive,
  PrimitiveCollection,
  Scene,
} from 'cesium';

import type { ObservationArtifact } from '../contracts';
import type { EdgeColorSpec } from '../geometry/edge-buffers';
import type {
  AtlasImageryLayerName,
  DegreeRectangle,
  RasterSpec,
  SurfaceRasterSpec,
} from '../geometry/raster/types';
import type { LoadTask } from '../load-order';
import type { SurfaceArtifact as SurfaceColumns } from '../surface-columns';
import type {
  ObservationColorVariable,
  ObservationShape,
  ObservationSizeRange,
  ObservationSizeVariable,
} from '../observation-encoding';
import type { Metric, PaletteId } from '../visual-encoding';
import type {
  BasemapId,
  CameraState,
  EdgeColorMode,
  ExplorerSceneMode,
  LayerVisibility,
  SurfaceGeometry,
  TerrainId,
} from '../url-state';
import type { AtlasWorkerClient } from '../worker/client';
import type {
  RasterReady,
  RasterTileBody,
  RasterTileMessage,
} from '../worker/protocol';
import type { ContextWarning } from './context-controller';
import type { ObservationPick } from './observation-layer';
import type { FadeableGroup } from './scene-transition';

/** A resolved surface pick: the cell row of the artifact whose chunk was picked. */
export type SurfacePick = {
  kind: 'surface';
  artifactKey: string;
  row: number;
  h3Index: string;
};
export type AtlasPick = SurfacePick | ObservationPick;
export type AtlasPickId = SurfaceChunkPick | ObservationPick;
export interface AtlasHover {
  pick: AtlasPick;
  screenPosition: { x: number; y: number };
}

export type SurfaceChunkPick = {
  kind: 'surface-chunk';
  artifactKey: string;
  chunk: number;
};

export interface ScientificPrimitiveGroup {
  collection: PrimitiveCollection;
  primitives: Primitive[];
  isReady(): boolean;
  readyCount(): number;
  totalCount(): number;
  setOpacity(opacity: number): void;
  setSurfaceOpacity(opacity: number): void;
  setCellEdges(visible: boolean): Promise<void>;
  setElevationFactor(factor: number, force?: boolean): void;
  setSceneMode(mode: ExplorerSceneMode): Promise<void>;
  setVisibility(surface: boolean, support: boolean): void;
}

/**
 * A displayed inferred surface, as ScientificLayers drives it through its epochs, cache and
 * `animateSwap`: worker-built chunk primitives on the smooth globe, or draped imagery layers under
 * World Terrain (terrain draping design, "Per layer under World Terrain").
 */
export interface SurfaceGroup
  extends
    FadeableGroup,
    Pick<
      ScientificPrimitiveGroup,
      | 'setSurfaceOpacity'
      | 'setVisibility'
      | 'setCellEdges'
      | 'setElevationFactor'
      | 'setSceneMode'
    > {
  readonly kind: 'chunks' | 'draped';
  readonly artifactKey: string;
  totalCount(): number;
  readyChunkCount(): number;
  opacity(): number;
  /**
   * Hides the cell outlines while a reveal wave runs, whatever else would show them; a no-op for
   * the draped kind, which fades instead of running a radial wave.
   */
  setEdgesHeld(held: boolean): void;
}
export type ContextStatus = 'loading' | 'ready' | 'fallback';
export type AtlasMark =
  | 'observations-visible'
  | 'surface-first-chunk'
  | 'surface-visible'
  | 'ready'
  | 'values-ready'
  | 'edges-ready'
  | 'context-ready';

export interface SceneProgress {
  detail: string;
  progress: number | null;
}

export type SceneProgressListener = (progress: SceneProgress) => void;

export interface ArtifactLoad {
  artifactKey: string;
  artifactId: string;
  observations: Promise<ObservationArtifact | null>;
  surface: Promise<SurfaceColumns>;
  /** Degrees; the worker orders chunks nearest this point first. Defaults to the camera. */
  lookAt?: { lat: number; lon: number };
}

export interface DisplayedLayer {
  artifactKey: string;
  metric: Metric;
  palette: PaletteId;
  geometry: SurfaceGeometry;
}

export interface ArtifactSceneApi {
  setArtifact(
    load: ArtifactLoad,
    progress?: SceneProgressListener,
  ): Promise<void>;
  onCommit(listener: (artifactKey: string) => void): () => void;
  onMark(listener: (mark: AtlasMark) => void): () => void;
  displayedLayer(): DisplayedLayer | null;
  markValuesReady(artifactKey: string): void;
  removeSurface(artifactKey: string): void;
  /**
   * Runs a detail-tier load as step 2 of the post-reveal load order (spec 2026-10-07 §B.6.9): once
   * the Natural Earth borders have settled, and at once when they already have. The task settles
   * when its request does and reports body progress, so a slow transfer is not a stall. Returns a
   * cancel that drops the load if it has not started.
   */
  queueDetail(task: LoadTask): () => void;
}

export interface SceneCapabilities {
  basemaps: Record<BasemapId, boolean>;
  terrains: Record<TerrainId, boolean>;
}

export interface ObservationPresentation {
  colorVariable: ObservationColorVariable;
  gradient: readonly [string, string, string];
  opacity: number;
  samplingAreaColor: string;
  sizeRange: ObservationSizeRange;
  samplingAreas: boolean;
  shape: ObservationShape;
  sizeVariable: ObservationSizeVariable;
  solidColor: string;
}

export interface AtlasSceneOptions {
  cesiumToken?: string;
  contextImageryUrl?: string;
  naturalEarthUrl: string;
  reducedMotion?: boolean;
  /** The provider's worker: it already holds each artifact's decoded grid and render tier. */
  worker: AtlasWorkerClient;
  /** `.atlas-explorer`, which receives the readiness attributes. */
  markTarget?: { setAttribute(name: string, value: string): void } | null;
  frameBudgetMs?: number;
  /** The post-reveal load order's stall window; defaults to the provider's (§B.6.2, §B.6.9). */
  loadStallMs?: number;
}

export interface AtlasSceneController extends ArtifactSceneApi {
  setMetric(metric: Metric, progress?: SceneProgressListener): Promise<void>;
  setSurfaceStyle(
    palette: PaletteId,
    opacity: number,
    cellEdges: boolean,
    edgeColorMode: EdgeColorMode,
    edgeFixedColor: string,
    geometry: SurfaceGeometry,
    progress?: SceneProgressListener,
  ): Promise<void>;
  setObservationStyle(
    style: ObservationPresentation,
    progress?: SceneProgressListener,
  ): Promise<void>;
  setBasemap(basemap: BasemapId): Promise<boolean>;
  setTerrain(terrain: TerrainId): Promise<boolean>;
  capabilities(): SceneCapabilities;
  setLayerVisibility(layers: LayerVisibility): void;
  setMapPresentation(
    basemapOpacity: number,
    basemapBrightness: number,
    dayNightLighting: boolean,
  ): void;
  /**
   * Vertical exaggeration of physical terrain (`scene.verticalExaggeration`, from sea level), in
   * `RELIEF_RANGE`. It applies only to World Terrain outside the 2D map, and never scales the
   * data: that is `setElevation`'s exaggeration (#483).
   */
  setRelief(relief: number): void;
  setEarthOpacity(opacity: number): void;
  setOceanColor(color: string): void;
  setCountryBorderStyle(color: string, opacity: number): void;
  setElevation(enabled: boolean, exaggeration: number): Promise<void>;
  setSceneMode(mode: ExplorerSceneMode, reducedMotion: boolean): Promise<void>;
  setCamera(camera: CameraState, animated: boolean): void;
  /**
   * CSS px of the canvas, measured from its left edge, that the persistent controls panel covers
   * (0 when it is hidden or a phone's bottom sheet). The globe is drawn centred in the rest by
   * shifting the projection centre; the camera does not move (fast-load design §A.1.13, amended
   * 2026-10-13; #452).
   */
  setLeftObstruction(width: number): void;
  setSelection(pick: AtlasPick | null): void;
  home(animated: boolean): void;
  zoom(direction: 'in' | 'out'): void;
  onPick(listener: (pick: AtlasPick | null) => void): () => void;
  onHover(listener: (hover: AtlasHover | null) => void): () => void;
  onCameraSettled(listener: (camera: CameraState) => void): () => void;
  onContextStatus(listener: (status: ContextStatus) => void): () => void;
  onWarning(
    listener: (warnings: readonly ContextWarning[]) => void,
  ): () => void;
  /**
   * The terrain on the globe: called now, and again each time another terrain's provider reaches
   * the globe. A requested World Terrain that is still loading, or failed, is not on it (#483).
   */
  onTerrainApplied(listener: (terrain: TerrainId) => void): () => void;
  /**
   * A frame threw, inside Scene.render or in any listener, tick or resize the Atlas render loop
   * runs, and rendering stopped for good (Cesium globe design §12), so listeners offer a retry.
   * The error is reported once, a late listener still hears it, and none is reported after
   * destroy.
   */
  onRenderError(listener: (error: unknown) => void): () => void;
  destroy(): void;
}

/** The worker client's raster requests, which the draped runtime is handed. */
export interface RasterWorkerClient extends Pick<
  AtlasWorkerClient,
  'prepareRaster' | 'rasterTile' | 'releaseRaster'
> {}

/** Where draped providers get their tiles: the worker client, or the stats recorder around it. */
export interface RasterTileSource {
  prepare(s: RasterSpec, signal: AbortSignal): Promise<RasterReady>;
  tile(b: RasterTileBody): Promise<RasterTileMessage>;
  release(id: number): void;
}

/** The scene members the draped layers use. */
export type DrapedScene = Pick<
  Scene,
  'globe' | 'imageryLayers' | 'preRender' | 'postRender' | 'requestRender'
>;

/**
 * A worker-backed imagery provider. `bounds` is the drawn data's extent (null: nothing to draw);
 * `tileLoaded` fires for each delivered tile, since worker tiles bypass Cesium's RequestScheduler
 * and so request no render of their own.
 */
export type RasterImageryProvider = ImageryProvider & {
  readonly bounds: DegreeRectangle | null;
  readonly tileLoaded: Event<(message: RasterTileMessage) => void>;
  destroy(): void;
  isDestroyed(): boolean;
};

/** One Atlas imagery layer, kept in `ATLAS_IMAGERY_LAYER_ORDER` above the basemap. */
export interface DrapedImageryLayer {
  readonly name: AtlasImageryLayerName;
  readonly layer: ImageryLayer;
  setAlpha(a: number): void;
  setShown(s: boolean): void;
  /**
   * True once the globe has loaded its tiles with the layer in place, or `DRAPED_READY_CAP_MS`
   * after it was added or last shown; until then the shown layer asks for a frame each frame.
   * Never while hidden, and a hidden layer asks for no frame: Cesium frees a hidden layer's tiles,
   * so a layer shown again is ready only once they have loaded anew.
   */
  isReady(): boolean;
  destroy(): void;
}

export interface DrapedImageryLayerOptions {
  scene: DrapedScene;
  provider: RasterImageryProvider;
  name: AtlasImageryLayerName;
  alpha: number;
}

export type AddDrapedImageryLayer = (
  o: DrapedImageryLayerOptions,
) => DrapedImageryLayer;

/** The reveal timeline a draped group fades in on. */
export interface DrapeWave {
  progress(): number;
  running(): boolean;
}

export interface DrapedSurfaceGroupOptions {
  artifactKey: string;
  scene: DrapedScene;
  source: RasterTileSource;
  surface: SurfaceRasterSpec;
  edgeColor: EdgeColorSpec;
  cellEdges: boolean;
  surfaceOpacity: number;
  wave: DrapeWave;
  /** A raster or provider failure; the scene reverts to the smooth globe. */
  onError(e: unknown): void;
}

/** The surface under World Terrain: the `atlas-surface` and `atlas-outlines` imagery layers. */
export interface DrapedSurfaceGroup extends SurfaceGroup {
  readonly kind: 'draped';
  readonly cells: SurfaceRasterSpec['cells'];
  readonly collection: { show: boolean };
  prepare(signal: AbortSignal): Promise<void>;
  setOutlineStyle(c: EdgeColorSpec): Promise<void>;
  outlinesReady(): boolean;
  isReady(): boolean;
  /** Removes its layers and releases their rasters; every setter after it is a no-op. */
  destroy(): void;
}

/** Tile counts, raster times and resident imagery bytes for the World Terrain budgets. */
export interface DrapeStats {
  requested: number;
  delivered: number;
  empty: number;
  queueDepth: number;
  /** Raster time per tile at level ≥ 3; `upperMs` 0.5, 1, 2, 4, 8, 16, Infinity. */
  rasterMs: { upperMs: readonly number[]; counts: number[] };
  /** Non-empty cached tiles × `RESIDENT_TILE_BYTES`. */
  residentBytes: number;
}

export interface DrapeStatsRecorder {
  source(inner: RasterTileSource): RasterTileSource;
  watchLayer(layer: ImageryLayer): () => void;
  read(): DrapeStats;
}

/** The lazily imported draped runtime (`scene/draped/runtime`). */
export interface DrapedRuntime {
  readonly version: 'atlas-draped-v1';
  createDrapedSurfaceGroup(o: DrapedSurfaceGroupOptions): DrapedSurfaceGroup;
  addDrapedImageryLayer: AddDrapedImageryLayer;
  providerFromSpec(
    src: RasterTileSource,
    spec: RasterSpec,
    signal: AbortSignal,
  ): Promise<RasterImageryProvider>;
  rasterSource(w: RasterWorkerClient): RasterTileSource;
  stats: DrapeStatsRecorder;
}
