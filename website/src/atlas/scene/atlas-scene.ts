/** Cesium lifecycle and scientific-layer orchestration for Atlas design §11 (spec 2026-10-07 §B.6;
 * the reveal wave of #453, §B.6.7 as amended 2026-10-13).
 *
 * After the surface is visible, the scene runs the post-reveal load order (§B.6.9, `load-order.ts`):
 * the Natural Earth borders' download, then each displayed artifact's detail tier (`queueDetail`),
 * then the starfield, which is also held until `ready`. A failed artifact request starts the same
 * order.
 *
 * Under World Terrain (terrain draping design, "Picking" and "Per layer under World Terrain"; #483)
 * picks take the rendered ground once that terrain is on the globe and the data lies flat, and the
 * terrain shading hears whether a surface layer shows, so the ground atmosphere and water effect
 * stay off over the data.
 *
 * The scene drapes the surface ("When it is active", "How existing features behave") from the
 * moment World Terrain is requested, so a cold load whose URL asks for it builds no chunks first;
 * once the newest request settles, the terrain it left on the globe decides. While draped, data
 * elevation is off and extruded draws as hexagons, the URL keeping both. The draped runtime is
 * imported on the first draped build. A raster failure reverts to the smooth globe with the
 * `'drape'` warning ("Failure modes"), which the next terrain choice clears.
 *
 * The context follows ("Per layer under World Terrain", "Exaggeration"): draped, the overlay drapes
 * the borders and clamps the labels, and the highlight stands on the ground as tiles load; a border
 * failure reverts too. A relief change re-samples the ground under the observations and the
 * highlight after the frame that applies it, every 50 ms in a drag and once more at rest. */

import { SceneMode, type CesiumWidget } from 'cesium';

import {
  cameraMotionTestHook,
  drapeStatsTestHook,
  revealWaveTestHold,
  syntheticTerrainTestHook,
  type CameraMotionHook,
  type SyntheticTerrainHook,
} from '../e2e-hooks';
import {
  DRAPE_FAILED_WARNING,
  hasPhysicalRelief,
  resolveDrapedView,
  type DrapedView,
} from '../earth-style-catalog';
import { createLoadOrder, type LoadOrder, type LoadTask } from '../load-order';
import type {
  BasemapId,
  CameraState,
  EdgeColorMode,
  ExplorerSceneMode,
  LayerVisibility,
  SurfaceGeometry,
  TerrainId,
} from '../url-state';
import {
  MAX_HEIGHT_METRES,
  type Metric,
  type PaletteId,
} from '../visual-encoding';
import {
  bindKeyboardCamera,
  cameraState,
  setCameraState,
  zoomCamera,
} from './camera';
import { revealFrameBudgetMs } from './chunk-scheduler';
import {
  ContextController,
  type ContextWarning,
  type ContextWarningUpdate,
} from './context-controller';
import { ContextOverlay } from './context-overlay';
import { installGlobeOffset, type GlobeOffset } from './globe-offset';
import { createGlobeWidget, type GlobeWidget } from './globe-widget';
import {
  createReliefResampler,
  onTileLoads,
  throttleResample,
  type ReliefResampler,
} from './ground-heights';
import { HighlightLayer } from './highlight-layer';
import {
  bindAtlasPicking,
  createFrameThrottle,
  type FrameThrottle,
} from './picking';
import { RenderLoop } from './render-loop';
import {
  createRevealWave,
  waveViewOf,
  type RevealWave,
} from './reveal-wave-driver';
import { createMarkTracker, type MarkTracker } from './scene-marks';
import {
  DEFAULT_LAYERS,
  DEFAULT_OBSERVATIONS,
  HOME_CAMERA,
  applyEarthOpacity,
  applyOceanColor,
  hideSkyUntilReady,
  styleAtlasScene,
} from './scene-policy';
import { animateValue } from './scene-transition';
import { ScientificLayers, type ScientificStyle } from './scientific-layers';
import { SURFACE_CLEARANCE_METRES } from './surface-appearance';
import { createSurfacePickResolver } from './surface-pick';
import { TerrainShading } from './terrain-shading';
import type {
  ArtifactLoad,
  AtlasHover,
  AtlasMark,
  AtlasPick,
  AtlasSceneController,
  AtlasSceneOptions,
  ContextStatus,
  DisplayedLayer,
  DrapedRuntime,
  ObservationPresentation,
  SceneCapabilities,
  SceneProgressListener,
} from './types';

export { preferredAtlasPick } from './picking';
export { applyEarthOpacity } from './scene-policy';
export { applyOceanColor } from './scene-policy';
export { resolveElevationView } from './scene-policy';
export { raiseScientificOverlays } from './scientific-layers';
export { transitionProgress } from './scene-transition';
export type {
  ArtifactLoad,
  AtlasHover,
  AtlasMark,
  AtlasPick,
  AtlasSceneController,
  AtlasSceneOptions,
  ContextStatus,
  DisplayedLayer,
  ObservationPresentation,
  SceneCapabilities,
  SceneProgress,
  SceneProgressListener,
} from './types';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

class CesiumAtlasScene implements AtlasSceneController {
  readonly #globe: GlobeWidget;
  readonly #widget: CesiumWidget;
  readonly #pickListeners = new Set<(pick: AtlasPick | null) => void>();
  readonly #hoverListeners = new Set<(hover: AtlasHover | null) => void>();
  readonly #cameraListeners = new Set<(camera: CameraState) => void>();
  readonly #contextListeners = new Set<(status: ContextStatus) => void>();
  readonly #commitListeners = new Set<(artifactKey: string) => void>();
  readonly #warningListeners = new Set<
    (warnings: readonly ContextWarning[]) => void
  >();
  readonly #warnings = new Map<ContextWarning['id'], ContextWarning>();
  readonly #terrainListeners = new Set<(terrain: TerrainId) => void>();
  readonly #renderLoop: RenderLoop;
  readonly #globeOffset: GlobeOffset;
  readonly #unbindKeyboard: () => void;
  readonly #unbindPicking: () => void;
  readonly #removeMoveEnd: () => void;
  readonly #removeRenderError: () => void;
  readonly #removeMarks: () => void;
  readonly #contextController: ContextController;
  readonly #terrainShading: TerrainShading;
  /** Slider-driven relief, applied at most once per animation frame. */
  readonly #reliefFrame: FrameThrottle<number>;
  readonly #overlay: ContextOverlay;
  readonly #highlightLayer: HighlightLayer;
  readonly #marks: MarkTracker;
  readonly #wave: RevealWave;
  /** The e2e build's camera motion hook; undefined elsewhere. */
  readonly #cameraMotion: CameraMotionHook | undefined;
  /** The e2e build's World Terrain stand-in, when a test asked for it; undefined elsewhere. */
  readonly #syntheticTerrain: SyntheticTerrainHook | undefined;
  readonly #layers: ScientificLayers;
  readonly #revealSky: () => void;
  readonly #loadOrder: LoadOrder;
  readonly #naturalEarthUrl: string;
  #metric: Metric = 'post_mean';
  #palette: PaletteId = 'rainbow';
  #surfaceOpacity = 0.58;
  #surfaceGeometry: SurfaceGeometry = 'triangles';
  #earthOpacity = 1;
  #cellEdges = false;
  #edgeColorMode: EdgeColorMode = 'matched';
  #edgeFixedColor = '#b9f5ff';
  #observationStyle = { ...DEFAULT_OBSERVATIONS };
  #layerVisibility = { ...DEFAULT_LAYERS };
  #elevation = false;
  #exaggeration = 1;
  #elevationFactor = 0;
  #elevationSequence = 0;
  #mode: ExplorerSceneMode = 'globe';
  #destroyed = false;
  #contextStatus: ContextStatus = 'loading';
  /** A new globe is smooth until the context controller puts another terrain on it. */
  #appliedTerrain: TerrainId = 'smooth-globe';
  /** The scene's draped rule (#483): the requested terrain's relief, then the applied one's. */
  #drapeTerrain = false;
  /** The newest terrain request; an older one's settling decides nothing. */
  #terrainSequence = 0;
  #drapedRuntime: Promise<DrapedRuntime> | null = null;
  /** Unpublishes the e2e build's drape stats reader; undefined until the runtime loads. */
  #removeDrapeStats: (() => void) | undefined;
  /** The newest draped-context flip; an older one's runtime reaches nothing. */
  #contextSequence = 0;
  /** While draped, stops re-grounding the highlight as tiles load. */
  #removeTileFollow: (() => void) | null = null;
  readonly #reliefResampler: ReliefResampler;
  /** Re-grounds a shown highlight, at most every `GROUND_RESAMPLE_MS` unless final. */
  readonly #groundHighlight = throttleResample(() =>
    this.#highlightLayer.setGround(this.#widget.scene.globe),
  );
  #reducedMotion: boolean;

  constructor(container: HTMLElement, options: AtlasSceneOptions) {
    this.#reducedMotion = options.reducedMotion ?? false;
    this.#globe = createGlobeWidget(container);
    this.#widget = this.#globe.widget;
    this.#renderLoop = new RenderLoop(() => {
      this.#widget.resize();
      this.#widget.render();
    });
    this.#globeOffset = installGlobeOffset(this.#widget.scene);
    this.#removeRenderError = this.#widget.scene.renderError.addEventListener(
      (_scene, error: unknown) => this.#renderLoop.fail(error),
    );
    this.#revealSky = hideSkyUntilReady(this.#widget.scene);
    this.#loadOrder = createLoadOrder(options.loadStallMs);
    this.#marks = createMarkTracker(
      this.#widget.scene,
      options.markTarget ?? null,
    );
    this.#terrainShading = new TerrainShading(this.#widget.scene);
    this.#syntheticTerrain = syntheticTerrainTestHook(this.#widget);
    this.#reliefResampler = createReliefResampler(this.#widget.scene, (final) =>
      this.#resampleGround(final),
    );
    this.#reliefFrame = createFrameThrottle(
      (relief: number) => {
        this.#terrainShading.update({ relief });
        this.#followRelief();
      },
      (callback) => requestAnimationFrame(callback),
    );
    this.#contextController = new ContextController(
      this.#widget,
      options.cesiumToken ?? '',
      options.contextImageryUrl ??
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      (warning) => this.#setWarning(warning),
      {
        onTerrainApplied: (terrain) => this.#setAppliedTerrain(terrain),
        worldTerrain: this.#syntheticTerrain?.worldTerrain,
      },
    );
    this.#overlay = new ContextOverlay({
      addCredit: (credit) => this.#widget.creditDisplay.addStaticCredit(credit),
      removeCredit: (credit) =>
        this.#widget.creditDisplay.removeStaticCredit(credit),
      scene: this.#widget.scene,
      worker: options.worker,
      onDrapeFailure: (error) => this.#onDrapeFailure(error),
    });
    this.#naturalEarthUrl = options.naturalEarthUrl;
    styleAtlasScene(this.#widget);
    this.#highlightLayer = new HighlightLayer(this.#widget.scene);
    this.#widget.scene.primitives.add(this.#highlightLayer.collection);
    this.#wave = createRevealWave({
      hold: revealWaveTestHold(),
      scene: this.#widget.scene,
      // The explorer root, like the load marks; the driver writes nothing once destroyed.
      target: options.markTarget ?? null,
      // The higher of the drawn and the target exaggeration, so a raised column is never cut.
      view: () =>
        waveViewOf(
          this.#widget.scene,
          SURFACE_CLEARANCE_METRES +
            MAX_HEIGHT_METRES *
              Math.max(this.#elevationFactor, this.#targetElevationFactor()),
        ),
    });
    this.#layers = new ScientificLayers({
      frameBudgetMs:
        options.frameBudgetMs ??
        revealFrameBudgetMs(window.matchMedia('(pointer: coarse)').matches),
      highlight: this.#highlightLayer,
      marks: this.#marks,
      onCommit: (artifactKey) => this.#commit(artifactKey),
      scene: this.#widget.scene,
      style: () => this.#scientificStyle(),
      wave: this.#wave,
      worker: options.worker,
      draped: () => this.#loadDrapedRuntime(),
      onDrapeFailure: (error) => this.#onDrapeFailure(error),
    });
    this.#removeMarks = this.#marks.onMark((mark) => {
      if (mark === 'ready') this.#queueStarfield();
      if (mark === 'surface-visible') this.#startContext();
    });
    this.#unbindKeyboard = bindKeyboardCamera(this.#widget, container);
    this.#cameraMotion = cameraMotionTestHook(this.#widget.camera);
    this.#removeMoveEnd = this.#widget.camera.moveEnd.addEventListener(() => {
      const state = cameraState(this.#widget);
      if (!state) return;
      for (const listener of this.#cameraListeners) listener(state);
    });
    this.#unbindPicking = bindAtlasPicking(
      this.#widget.scene,
      (value) => {
        this.#highlightLayer.setSelection(value);
        for (const listener of this.#pickListeners) listener(value);
      },
      (value) => {
        this.#highlightLayer.setHover(value?.pick ?? null, this.#reducedMotion);
        for (const listener of this.#hoverListeners) listener(value);
      },
      createSurfacePickResolver(this.#widget.scene, {
        // The applied terrain, not the requested one: until World Terrain is on the globe, the
        // ground under the pointer is the ellipsoid. Lifted data keeps the depth pick.
        draped: () =>
          hasPhysicalRelief(this.#appliedTerrain) &&
          this.#elevationFactor === 0,
        factor: () => this.#elevationFactor,
        geometry: () =>
          this.#layers.displayedLayer()?.geometry ?? this.#surfaceGeometry,
        metric: () => this.#layers.displayedLayer()?.metric ?? this.#metric,
        reveal: (direction) => this.#wave.reveal(direction),
        target: () => this.#layers.pickTarget(),
      }),
    );
    this.setCamera(HOME_CAMERA, false);
    void this.#contextController.setBasemap('dark-streets');
    this.#renderLoop.start();
  }

  #scientificStyle(): ScientificStyle {
    return {
      cellEdges: this.#cellEdges,
      draped: this.#drapeTerrain,
      earthOpacity: this.#earthOpacity,
      edgeColorMode: this.#edgeColorMode,
      edgeFixedColor: this.#edgeFixedColor,
      elevationFactor: this.#elevationFactor,
      geometry: this.#drapedView().geometry,
      layers: this.#layerVisibility,
      metric: this.#metric,
      mode: this.#mode,
      observationStyle: this.#observationStyle,
      palette: this.#palette,
      reducedMotion: this.#reducedMotion,
      surfaceOpacity: this.#surfaceOpacity,
    };
  }

  #commit(artifactKey: string): void {
    this.#overlay.setSurface(
      artifactKey,
      this.#layers.displayedLayer()?.metric ?? this.#metric,
    );
    this.#overlay.setElevationFactor(this.#elevationFactor, true);
    for (const listener of this.#commitListeners) listener(artifactKey);
  }

  /**
   * Step 1 of the load order, once. It settles when the borders' bytes have arrived, so the detail
   * tier downloads while they are parsed and drawn, or when their load ends without them (it
   * falls back on a failed fetch; the overlay never rejects). It reports each body chunk, so only
   * a download with no new chunk for the stall window releases the detail tier early.
   */
  #startContext(): void {
    if (this.#destroyed) return;
    this.#loadOrder.borders(
      (progress) =>
        new Promise<void>((settle) => {
          const loading = this.#overlay.load(
            this.#naturalEarthUrl,
            settle,
            progress,
          );
          // A throwing status listener stays an unhandled rejection, not an outcome of the step.
          void loading.then((status) => {
            if (this.#destroyed) return;
            if (status === 'ready') this.#marks.queue('context-ready');
            this.#setContextStatus(status);
          });
          void loading.then(() => settle());
        }),
    );
  }

  /** Step 3, once: the sky-box textures load when it is shown (§B.6.9). */
  #queueStarfield(): void {
    if (this.#destroyed) return;
    // The borders start no later than this, so the starfield always has a step 1 to follow.
    this.#startContext();
    this.#loadOrder.starfield(() => this.#revealSky());
  }

  #setContextStatus(status: ContextStatus): void {
    this.#contextStatus = status;
    for (const listener of this.#contextListeners) listener(status);
  }

  #setAppliedTerrain(terrain: TerrainId): void {
    this.#appliedTerrain = terrain;
    this.#terrainShading.update({ terrain });
    for (const listener of this.#terrainListeners) listener(terrain);
  }

  #setWarning(warning: ContextWarningUpdate): void {
    if (warning.message) this.#warnings.set(warning.id, warning);
    else this.#warnings.delete(warning.id);
    const current = [...this.#warnings.values()];
    for (const listener of this.#warningListeners) listener(current);
  }

  #targetElevationFactor(): number {
    return this.#drapedView().elevationFactor;
  }

  /** What the scene draws of the user's elevation and geometry under its draped rule (#483). */
  #drapedView(): DrapedView {
    return resolveDrapedView({
      draped: this.#drapeTerrain,
      elevation: this.#elevation,
      exaggeration: this.#exaggeration,
      geometry: this.#surfaceGeometry,
      view: this.#mode,
    });
  }

  /**
   * Asks the context controller for `terrain` (#483). The scene drapes on the request's word at
   * once; when the newest request settles, on the terrain on the globe, so a World Terrain load
   * that fails brings the chunks back.
   */
  #requestTerrain(terrain: TerrainId): Promise<boolean> {
    const request = ++this.#terrainSequence;
    const result = this.#contextController.setTerrain(terrain);
    this.#setDrapeTerrain(hasPhysicalRelief(terrain));
    const settle = () => {
      if (request === this.#terrainSequence && !this.#destroyed)
        this.#setDrapeTerrain(hasPhysicalRelief(this.#appliedTerrain));
    };
    void result.then(settle, settle);
    return result;
  }

  /** A change rebuilds the surface in the other kind, and moves the data height and context. */
  #setDrapeTerrain(next: boolean): void {
    if (this.#drapeTerrain === next) return;
    this.#drapeTerrain = next;
    void this.#layers
      .rebuild()
      .catch((error: unknown) =>
        console.warn(
          'The surface could not be rebuilt for the terrain.',
          error,
        ),
      );
    void this.setElevation(this.#elevation, this.#exaggeration);
    void this.#drapeContext(next);
  }

  /**
   * Draped, the highlight stands on the ground as tiles load and the overlay drapes the borders;
   * smooth, both get their own heights back. Only the newest flip reaches the overlay, and a
   * runtime that cannot be imported reverts to the smooth globe. Never rejects.
   */
  async #drapeContext(draped: boolean): Promise<void> {
    const flip = ++this.#contextSequence;
    const { globe } = this.#widget.scene;
    this.#removeTileFollow?.();
    this.#removeTileFollow = draped
      ? onTileLoads(globe, this.#groundHighlight)
      : null;
    if (!draped) this.#reliefResampler.cancel();
    this.#highlightLayer.setGround(draped ? globe : null);
    let runtime: DrapedRuntime | null = null;
    try {
      if (draped) runtime = await this.#loadDrapedRuntime();
    } catch (error) {
      if (flip === this.#contextSequence) this.#onDrapeFailure(error);
      return;
    }
    if (flip === this.#contextSequence && !this.#destroyed)
      await this.#overlay.setDraped(runtime);
  }

  /** Draped, a relief frame re-samples the ground after the next render, and once more at rest. */
  #followRelief(): void {
    if (this.#drapeTerrain) this.#reliefResampler.changed();
  }

  /** The ground under the draped observations and the highlight, re-read after a relief frame. */
  #resampleGround(final: boolean): void {
    this.#layers.resampleGround(final);
    this.#groundHighlight(final);
  }

  /** The draped runtime, imported once (#483); an import that failed is tried again next time. */
  #loadDrapedRuntime(): Promise<DrapedRuntime> {
    this.#drapedRuntime ??= import('./draped/runtime').then(
      ({ drapedRuntime }) => {
        if (!this.#destroyed)
          this.#removeDrapeStats = drapeStatsTestHook(() =>
            drapedRuntime.stats.read(),
          );
        return drapedRuntime;
      },
      (error: unknown) => {
        this.#drapedRuntime = null;
        throw error;
      },
    );
    return this.#drapedRuntime;
  }

  /**
   * A draped raster failed (#483): the globe reverts to smooth with the `'drape'` warning, which
   * stays until the next terrain choice. A failure heard once the scene no longer drapes belongs
   * to a surface already being replaced, so it is only logged.
   */
  #onDrapeFailure(error: unknown): void {
    if (this.#destroyed) return;
    console.warn('The map data could not be draped over World Terrain.', error);
    if (!this.#drapeTerrain) return;
    this.#setWarning({ id: 'drape', message: DRAPE_FAILED_WARNING });
    void this.#requestTerrain('smooth-globe');
  }

  async setArtifact(
    load: ArtifactLoad,
    progress?: SceneProgressListener,
  ): Promise<void> {
    try {
      await this.#layers.setArtifact(load, progress);
    } catch (error) {
      if (!isAbortError(error)) this.#queueStarfield();
      throw error;
    }
  }

  async setMetric(
    metric: Metric,
    progress?: SceneProgressListener,
  ): Promise<void> {
    if (this.#metric === metric) return;
    this.#metric = metric;
    await this.#layers.rebuild(progress);
  }

  async setSurfaceStyle(
    palette: PaletteId,
    opacity: number,
    cellEdges: boolean,
    edgeColorMode: EdgeColorMode,
    edgeFixedColor: string,
    geometry: SurfaceGeometry,
    progress?: SceneProgressListener,
  ): Promise<void> {
    const rebuild =
      this.#palette !== palette || this.#surfaceGeometry !== geometry;
    const edgeStyleChanged =
      this.#edgeColorMode !== edgeColorMode ||
      this.#edgeFixedColor !== edgeFixedColor;
    this.#palette = palette;
    this.#surfaceOpacity = opacity;
    this.#cellEdges = cellEdges;
    this.#edgeColorMode = edgeColorMode;
    this.#edgeFixedColor = edgeFixedColor;
    this.#surfaceGeometry = geometry;
    this.#layers.setSurfaceOpacity(opacity);
    if (rebuild) await this.#layers.rebuild(progress);
    else if (edgeStyleChanged) await this.#layers.setEdgeStyle();
    else await this.#layers.setCellEdges(cellEdges);
    this.#widget.scene.requestRender();
  }

  async setObservationStyle(
    style: ObservationPresentation,
    progress?: SceneProgressListener,
  ): Promise<void> {
    const renderingChanged =
      this.#observationStyle.colorVariable !== style.colorVariable ||
      this.#observationStyle.solidColor !== style.solidColor ||
      this.#observationStyle.gradient.join(':') !== style.gradient.join(':') ||
      this.#observationStyle.shape !== style.shape ||
      this.#observationStyle.sizeVariable !== style.sizeVariable;
    this.#observationStyle = { ...style };
    if (renderingChanged) await this.#layers.rebuild(progress);
    else this.#layers.setObservationAppearance(style, this.#layerVisibility);
    this.#widget.scene.requestRender();
  }

  setBasemap(basemap: BasemapId): Promise<boolean> {
    return this.#contextController.setBasemap(basemap);
  }

  setTerrain(terrain: TerrainId): Promise<boolean> {
    // A new choice ends a drape failure's revert.
    if (this.#warnings.has('drape'))
      this.#setWarning({ id: 'drape', message: null });
    return this.#requestTerrain(terrain);
  }

  capabilities(): SceneCapabilities {
    return this.#contextController.capabilities();
  }

  setLayerVisibility(layers: LayerVisibility): void {
    this.#layerVisibility = { ...layers };
    this.#layers.setVisibility(layers, this.#observationStyle.samplingAreas);
    this.#contextController.setVisible(layers.context);
    this.#overlay.setVisible(layers.countries);
    this.#terrainShading.update({
      surfaceShown: layers.surface || layers.support,
    });
    this.#widget.scene.requestRender();
  }

  setMapPresentation(
    basemapOpacity: number,
    basemapBrightness: number,
    dayNightLighting: boolean,
  ): void {
    this.#contextController.setAppearance(basemapOpacity, basemapBrightness);
    // Day/night lights the smooth globe only; World Terrain keeps its hillshade (#483).
    this.#terrainShading.update({ dayNight: dayNightLighting });
    this.#widget.scene.requestRender();
  }

  setRelief(relief: number): void {
    this.#reliefFrame.queue(relief);
  }

  setEarthOpacity(opacity: number): void {
    this.#earthOpacity = Math.min(1, Math.max(0.15, opacity));
    applyEarthOpacity(this.#widget.scene.globe, this.#earthOpacity);
    this.#layers.setEarthOpacity(this.#earthOpacity);
    this.#highlightLayer.setEarthOpacity(this.#earthOpacity);
    this.#widget.scene.requestRender();
  }

  setOceanColor(color: string): void {
    applyOceanColor(this.#widget.scene.globe, color);
    this.#widget.scene.requestRender();
  }

  setCountryBorderStyle(color: string, opacity: number): void {
    this.#overlay.setBorderStyle(color, opacity);
  }

  async setElevation(enabled: boolean, exaggeration: number): Promise<void> {
    this.#elevation = enabled;
    this.#exaggeration = exaggeration;
    const target = this.#targetElevationFactor();
    const sequence = ++this.#elevationSequence;
    await animateValue(
      this.#widget,
      this.#elevationFactor,
      target,
      this.#reducedMotion,
      (factor) => {
        this.#elevationFactor = factor;
        this.#layers.setElevationFactor(factor);
        this.#highlightLayer.setElevationStyle(factor > 0, factor);
        this.#overlay.setElevationFactor(factor);
      },
      () => sequence === this.#elevationSequence && !this.#destroyed,
    );
    if (sequence === this.#elevationSequence && !this.#destroyed) {
      this.#elevationFactor = target;
      this.#layers.setElevationFactor(target, true);
      this.#highlightLayer.setElevationStyle(target > 0, target);
      this.#overlay.setElevationFactor(target, true);
      this.#widget.scene.requestRender();
    }
  }

  async setSceneMode(
    mode: ExplorerSceneMode,
    reducedMotion: boolean,
  ): Promise<void> {
    this.#reducedMotion = reducedMotion;
    const target = {
      globe: SceneMode.SCENE3D,
      map: SceneMode.SCENE2D,
      perspective: SceneMode.COLUMBUS_VIEW,
    }[mode];
    this.#mode = mode;
    this.#terrainShading.update({ mode });
    if (this.#widget.scene.mode !== target) {
      this.#widget.camera.cancelFlight();
      await this.#layers.setSceneMode('perspective');
      await this.#overlay.setSceneMode('perspective');
      await new Promise<void>((resolve) => {
        const remove = this.#widget.scene.morphComplete.addEventListener(() => {
          remove();
          resolve();
        });
        const duration = reducedMotion ? 0 : 0.8;
        if (mode === 'globe') this.#widget.scene.morphTo3D(duration);
        else if (mode === 'map') this.#widget.scene.morphTo2D(duration);
        else this.#widget.scene.morphToColumbusView(duration);
      });
    }
    await this.#layers.setSceneMode(mode);
    await this.#overlay.setSceneMode(mode);
    await this.setElevation(this.#elevation, this.#exaggeration);
  }

  setCamera(camera: CameraState, animated: boolean): void {
    setCameraState(
      this.#widget,
      camera,
      animated,
      this.#cameraMotion?.flight(),
    );
  }

  setLeftObstruction(width: number): void {
    this.#globeOffset.setCoveredLeft(width);
  }

  setSelection(pick: AtlasPick | null): void {
    this.#highlightLayer.setSelection(pick);
  }

  home(animated: boolean): void {
    setCameraState(
      this.#widget,
      HOME_CAMERA,
      animated,
      this.#cameraMotion?.flight(),
    );
  }

  zoom(direction: 'in' | 'out'): void {
    const distance = Math.max(
      50_000,
      this.#widget.camera.positionCartographic.height * 0.28,
    );
    // Never below the ground plus ZOOM_FLOOR_METRES (#483).
    zoomCamera(
      this.#widget.camera,
      this.#widget.scene.globe,
      direction,
      distance,
    );
  }

  displayedLayer(): DisplayedLayer | null {
    return this.#layers.displayedLayer();
  }

  markValuesReady(artifactKey: string): void {
    this.#layers.markValuesReady(artifactKey);
  }

  removeSurface(artifactKey: string): void {
    this.#layers.removeSurface(artifactKey);
  }

  queueDetail(task: LoadTask): () => void {
    return this.#loadOrder.detail(task);
  }

  onCommit(listener: (artifactKey: string) => void): () => void {
    this.#commitListeners.add(listener);
    return () => this.#commitListeners.delete(listener);
  }

  onMark(listener: (mark: AtlasMark) => void): () => void {
    return this.#marks.onMark(listener);
  }

  onPick(listener: (pick: AtlasPick | null) => void): () => void {
    this.#pickListeners.add(listener);
    return () => this.#pickListeners.delete(listener);
  }

  onHover(listener: (hover: AtlasHover | null) => void): () => void {
    this.#hoverListeners.add(listener);
    return () => this.#hoverListeners.delete(listener);
  }

  onCameraSettled(listener: (camera: CameraState) => void): () => void {
    this.#cameraListeners.add(listener);
    return () => this.#cameraListeners.delete(listener);
  }

  onContextStatus(listener: (status: ContextStatus) => void): () => void {
    this.#contextListeners.add(listener);
    listener(this.#contextStatus);
    return () => this.#contextListeners.delete(listener);
  }

  onWarning(
    listener: (warnings: readonly ContextWarning[]) => void,
  ): () => void {
    this.#warningListeners.add(listener);
    listener([...this.#warnings.values()]);
    return () => this.#warningListeners.delete(listener);
  }

  onTerrainApplied(listener: (terrain: TerrainId) => void): () => void {
    this.#terrainListeners.add(listener);
    listener(this.#appliedTerrain);
    return () => this.#terrainListeners.delete(listener);
  }

  onRenderError(listener: (error: unknown) => void): () => void {
    return this.#renderLoop.onError(listener);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#loadOrder.destroy();
    this.#elevationSequence += 1;
    this.#renderLoop.stop();
    this.#layers.destroy();
    this.#removeDrapeStats?.();
    this.#wave.destroy();
    this.#removeMarks();
    this.#marks.destroy();
    this.#unbindKeyboard();
    this.#unbindPicking();
    this.#removeMoveEnd();
    this.#cameraMotion?.destroy();
    this.#syntheticTerrain?.destroy();
    this.#removeRenderError();
    this.#reliefFrame.cancel();
    this.#reliefResampler.cancel();
    this.#removeTileFollow?.();
    this.#contextController.destroy();
    this.#terrainShading.destroy();
    this.#globeOffset.destroy();
    this.#globe.destroy();
  }
}

export function createAtlasScene(
  container: HTMLElement,
  options: AtlasSceneOptions,
): AtlasSceneController {
  return new CesiumAtlasScene(container, options);
}
