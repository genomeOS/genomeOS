/** Cesium lifecycle and scientific-layer orchestration for Atlas design §11 (spec 2026-10-07 §B.6;
 * the reveal wave of #453, §B.6.7 as amended 2026-10-13).
 *
 * After the surface is visible, the scene runs the post-reveal load order (§B.6.9, `load-order.ts`):
 * the Natural Earth borders' download, then each displayed artifact's detail tier (`queueDetail`),
 * then the starfield, which is also held until `ready`. A failed artifact request starts the same
 * order. */

import { SceneMode, type CesiumWidget } from 'cesium';

import {
  cameraMotionTestHook,
  revealWaveTestHold,
  syntheticTerrainTestHook,
  type CameraMotionHook,
  type SyntheticTerrainHook,
} from '../e2e-hooks';
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
    this.#reliefFrame = createFrameThrottle(
      (relief: number) => this.#terrainShading.update({ relief }),
      (callback) => requestAnimationFrame(callback),
    );
    this.#contextController = new ContextController(
      this.#widget,
      options.cesiumToken ?? '',
      options.contextImageryUrl ??
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      (warning) => this.#setWarning(warning),
      {
        onTerrainApplied: (terrain) => this.#terrainShading.update({ terrain }),
        worldTerrain: this.#syntheticTerrain?.worldTerrain,
      },
    );
    this.#overlay = new ContextOverlay({
      addCredit: (credit) => this.#widget.creditDisplay.addStaticCredit(credit),
      removeCredit: (credit) =>
        this.#widget.creditDisplay.removeStaticCredit(credit),
      scene: this.#widget.scene,
      worker: options.worker,
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
      earthOpacity: this.#earthOpacity,
      edgeColorMode: this.#edgeColorMode,
      edgeFixedColor: this.#edgeFixedColor,
      elevationFactor: this.#elevationFactor,
      geometry: this.#surfaceGeometry,
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

  #setWarning(warning: ContextWarningUpdate): void {
    if (warning.message) this.#warnings.set(warning.id, warning);
    else this.#warnings.delete(warning.id);
    const current = [...this.#warnings.values()];
    for (const listener of this.#warningListeners) listener(current);
  }

  #targetElevationFactor(): number {
    return this.#elevation && this.#mode !== 'map' ? this.#exaggeration : 0;
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
    return this.#contextController.setTerrain(terrain);
  }

  capabilities(): SceneCapabilities {
    return this.#contextController.capabilities();
  }

  setLayerVisibility(layers: LayerVisibility): void {
    this.#layerVisibility = { ...layers };
    this.#layers.setVisibility(layers, this.#observationStyle.samplingAreas);
    this.#contextController.setVisible(layers.context);
    this.#overlay.setVisible(layers.countries);
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
