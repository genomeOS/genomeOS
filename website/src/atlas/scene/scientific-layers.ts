/** Cold progressive reveal and atomic swaps of scientific layers for Atlas design §11
 * (spec 2026-10-07 §B.6.8; Cesium explorer design §9 and §12; the reveal wave of #453, §B.6.7
 * and §B.6.9 item 8 as amended 2026-10-13).
 *
 * When nothing scientific is displayed (the cold load, or a scene recreated
 * by "Retry globe") observations appear first and surface chunks appear with
 * their masks as the scheduler admits them; the reveal wave starts with the
 * first chunk, so a hexagon shows once its chunk is added and the wave has
 * reached it. Whenever a layer is displayed, every replacement is built in a
 * shown collection at opacity 0. A restyle of the displayed artifact (metric,
 * palette, geometry, markers) becomes visible in one `animateSwap` that also
 * retires the outgoing surface, support and observations. A dataset switch
 * retires the outgoing groups at its commit and shows the incoming ones at
 * once, growing the surface from the centre with a new wave, so two datasets
 * never share one legend. The commit callback fires at that swap, so the
 * legend, inspector and readiness attributes change with the pixels. Cell
 * outlines are built only once a wave has passed and are held hidden while
 * one runs.
 *
 * Under World Terrain (terrain draping design, "Per layer under World
 * Terrain" and "How existing features behave", #483) the surface is a draped
 * imagery group, driven through the same epochs, cache and swaps: a cold one
 * fades in on the wave's timeline once its tiles are loaded, a restyle
 * cross-fades over an outgoing layer held opaque, a toggle that changes the
 * cells baked into its texture rebuilds it, and a raster failure reverts the
 * globe through `onDrapeFailure`. The per-kind operations are in
 * `surface-groups.ts`.
 */

import type { PrimitiveCollection, Scene } from 'cesium';

import type { ObservationArtifact } from '../contracts';
import type { SurfaceRasterSpec } from '../geometry/raster/types';
import { isSupportedCode } from '../geometry/support-codes';
import type { SurfaceArtifact } from '../surface-columns';
import type {
  EdgeColorMode,
  ExplorerSceneMode,
  LayerVisibility,
  SurfaceGeometry,
} from '../url-state';
import type { Metric, PaletteId } from '../visual-encoding';
import type { AtlasWorkerClient } from '../worker/client';
import { LayerCache } from './layer-cache';
import {
  buildObservationLayer,
  type ObservationPrimitiveGroup,
  type ObservationSurfaceHeights,
} from './observation-layer';
import type { RevealWave } from './reveal-wave-driver';
import type { MarkTracker } from './scene-marks';
import { animateSwap, fadeTogether, waitForReady } from './scene-transition';
import type { SurfaceChunkGroup } from './surface-chunk-layer';
import {
  buildChunkEdges,
  createChunkGroup,
  createDrapedGroup,
  disposeSurfaceGroup,
  DrapeFailure,
  drapedCells,
  drapedOutlinesReady,
  edgeColorOf,
  edgeStyleKey,
  isAbortError,
  isDrapedGroup,
  opaqueUntilRetired,
  streamChunks,
  surfaceKeyFor,
  viewLookAt,
  waitForDrapedOutlines,
  type AnySurfaceGroup,
  type DisplayedSurface,
  type SurfaceGroupHost,
} from './surface-groups';
import {
  columnarHeightSource,
  type SurfaceHeightSource,
} from './surface-heights';
import type { PickTarget } from './surface-pick';
import type {
  ArtifactLoad,
  AtlasMark,
  DisplayedLayer,
  DrapedRuntime,
  DrapedSurfaceGroup,
  ObservationPresentation,
  RasterTileSource,
  RasterWorkerClient,
  SceneProgressListener,
  SurfaceGroup,
} from './types';

export interface ScientificStyle {
  metric: Metric;
  palette: PaletteId;
  geometry: SurfaceGeometry;
  surfaceOpacity: number;
  cellEdges: boolean;
  edgeColorMode: EdgeColorMode;
  edgeFixedColor: string;
  observationStyle: ObservationPresentation;
  layers: LayerVisibility;
  mode: ExplorerSceneMode;
  elevationFactor: number;
  earthOpacity: number;
  reducedMotion: boolean;
  /** World Terrain is requested, so the surface drapes onto the ground (#483); absent is smooth. */
  draped?: boolean;
}

export interface ScientificHighlight {
  readonly collection: PrimitiveCollection;
  setArtifacts(
    surface: SurfaceHeightSource | null,
    observations: ObservationArtifact | null,
    metric: Metric,
    elevation: boolean,
    exaggeration: number,
  ): void;
}

export type ScientificScene = Pick<
  Scene,
  | 'camera'
  | 'canvas'
  | 'globe'
  | 'imageryLayers'
  | 'postRender'
  | 'preRender'
  | 'preUpdate'
  | 'primitives'
  | 'requestRender'
>;

export interface ScientificLayersOptions {
  scene: ScientificScene;
  worker: Pick<AtlasWorkerClient, 'buildChunks' | 'buildEdges' | 'recolour'> &
    RasterWorkerClient;
  highlight: ScientificHighlight;
  marks: MarkTracker;
  style: () => ScientificStyle;
  frameBudgetMs: number;
  onCommit: (artifactKey: string) => void;
  /** The scene's reveal wave (#453): its uniforms are every chunk's, its runs our triggers'. */
  wave: Pick<
    RevealWave,
    'finish' | 'onChange' | 'progress' | 'running' | 'start' | 'uniforms'
  >;
  perf?: { mark(name: string, options?: PerformanceMarkOptions): unknown };
  /** The lazily imported draped runtime, for a draped style (#483). */
  draped?: () => Promise<DrapedRuntime>;
  /** A draped raster failed for the surface in view; the scene reverts to the smooth globe. */
  onDrapeFailure?: (error: unknown) => void;
}

interface Displayed extends DisplayedSurface {
  artifactId: string;
  observations: ObservationArtifact | null;
}

interface Epoch {
  artifactKey: string;
  group: AnySurfaceGroup | null;
  observationGroup: ObservationPrimitiveGroup | null;
  streamDone: boolean;
  /** The cells a draped build draws, once its style is read; null for chunks. */
  cells?: SurfaceRasterSpec['cells'] | null;
}

interface LiveGroup {
  collection: { show: boolean };
  opacity(): number;
}

class SupersededBuild extends Error {
  constructor() {
    super('Scientific layer build was superseded');
    this.name = 'AbortError';
  }
}

export function raiseScientificOverlays(
  primitives: PrimitiveCollection,
  observationLayer: PrimitiveCollection | null,
  highlightLayer: PrimitiveCollection,
): void {
  if (observationLayer?.isDestroyed() === false)
    primitives.raiseToTop(observationLayer);
  if (!highlightLayer.isDestroyed()) primitives.raiseToTop(highlightLayer);
}

function shown(group: LiveGroup): boolean {
  return group.collection.show && group.opacity() > 0;
}

function observationKeyFor(
  artifactKey: string,
  style: ObservationPresentation,
): string {
  return [
    artifactKey,
    style.shape,
    style.colorVariable,
    style.solidColor,
    ...style.gradient,
    style.sizeVariable,
  ].join(':');
}

export class ScientificLayers {
  readonly #options: ScientificLayersOptions;
  readonly #perf: NonNullable<ScientificLayersOptions['perf']>;
  readonly #host: SurfaceGroupHost;
  readonly #surfaces = new LayerCache<AnySurfaceGroup>(4);
  readonly #observations = new LayerCache<ObservationPrimitiveGroup>(3);
  readonly #heights = new WeakMap<SurfaceGroup, ObservationSurfaceHeights>();
  readonly #edgeStyles = new WeakMap<SurfaceGroup, string>();
  /** Every draped group not yet disposed: their worker rasters outlive the scene otherwise. */
  readonly #draped = new Set<DrapedSurfaceGroup>();
  #rasterSource: RasterTileSource | null = null;
  readonly #ids = new Map<LiveGroup, string>();
  readonly #valuesReady = new Set<string>();
  readonly #removeMarkListener: () => void;
  readonly #removeWaveListener: () => void;
  #displayed: Displayed | null = null;
  #epoch: Epoch | null = null;
  /** The cold epoch being revealed, picked until it commits or is discarded. */
  #revealing: { epoch: Epoch; surface: SurfaceArtifact | null } | null = null;
  /**
   * What `rebuild()` replays: the latest request, pending or not, so a style
   * change during a swap rebuilds the incoming artifact. Once that request
   * fails it falls back to the displayed artifact.
   */
  #current: Omit<ArtifactLoad, 'lookAt'> | null = null;
  /**
   * The newest `setArtifact` call's outcome. A call that a later call for the same artifact
   * supersedes (a restyle's `rebuild()` replays the pending request) settles with that later
   * call, so its caller never sees success while the replacement alone carries the outcome.
   */
  #newest: { artifactKey: string; outcome: Promise<void> } | null = null;
  #sequence = 0;
  #build: AbortController | null = null;
  #edgeBuild: AbortController | null = null;
  #destroyed = false;

  constructor(options: ScientificLayersOptions) {
    this.#options = options;
    this.#perf = options.perf ?? performance;
    this.#host = {
      frameBudgetMs: options.frameBudgetMs,
      heights: this.#heights,
      lookAt: () => viewLookAt(options.scene),
      marks: options.marks,
      perf: this.#perf,
      scene: options.scene,
      style: () => options.style(),
      wave: options.wave,
      worker: options.worker,
    };
    options.marks.setProbe(() => this.#probe());
    options.marks.setDisplayed(() =>
      [...this.#ids].filter(([group]) => shown(group)).map(([, id]) => id),
    );
    this.#removeMarkListener = options.marks.onMark((mark) => {
      if (mark === 'surface-visible') this.#startEdges();
    });
    this.#removeWaveListener = options.wave.onChange((running) => {
      this.#displayed?.group?.setEdgesHeld(running);
      // Outlines deferred while the wave ran are built now, sliced as usual.
      if (!running) this.#startEdges();
    });
  }

  displayedLayer(): DisplayedLayer | null {
    const displayed = this.#displayed;
    return displayed
      ? {
          artifactKey: displayed.artifactKey,
          geometry: displayed.geometry,
          metric: displayed.metric,
          palette: displayed.palette,
        }
      : null;
  }

  pickTarget(): PickTarget | null {
    const displayed = this.#displayed;
    if (displayed) {
      // The incoming groups sit at opacity 0, but a translucent depth pick writes depth
      // whatever the alpha, so both are hidden for that pass (§B.6.6).
      const hidden: PrimitiveCollection[] = [];
      const incoming = this.#epoch?.group;
      // Draped imagery writes no depth of its own.
      if (incoming && incoming !== displayed.group && !isDrapedGroup(incoming))
        hidden.push(incoming.collection);
      const incomingObservations = this.#epoch?.observationGroup;
      if (
        incomingObservations &&
        incomingObservations !== displayed.observationGroup
      )
        hidden.push(incomingObservations.collection);
      return {
        artifactKey: displayed.artifactKey,
        draped: isDrapedGroup(displayed.group),
        drawn: this.#drawn(() => displayed.group, displayed.surface),
        hidden,
        surface: displayed.surface,
      };
    }
    const revealing = this.#revealing;
    return revealing?.surface
      ? {
          artifactKey: revealing.epoch.artifactKey,
          draped: isDrapedGroup(revealing.epoch.group),
          drawn: this.#drawn(() => revealing.epoch.group, revealing.surface),
          hidden: [],
          surface: revealing.surface,
        }
      : null;
  }

  /**
   * Whether the layers draw `row` at call time: its cell layer is on and the group shown, and a
   * draped group's fade has drawn a frame.
   */
  #drawn(group: () => AnySurfaceGroup | null, surface: SurfaceArtifact) {
    return (row: number): boolean => {
      const live = group();
      if (!live || !shown(live)) return false;
      if (isDrapedGroup(live) && this.#options.wave.progress() <= 0)
        return false;
      const { layers } = this.#options.style();
      return isSupportedCode(surface.support[row])
        ? layers.surface
        : layers.support;
    };
  }

  /**
   * Shows `load`. A call superseded by a call for another artifact resolves; one superseded by a
   * call for the same artifact (a rebuild) settles with the newest such call.
   */
  setArtifact(
    load: ArtifactLoad,
    progress?: SceneProgressListener,
  ): Promise<void> {
    const outcome: Promise<void> = this.#show(load, progress).then(
      (superseded) => {
        const newest = this.#newest;
        if (
          superseded &&
          !this.#destroyed &&
          newest &&
          newest.outcome !== outcome &&
          newest.artifactKey === load.artifactKey
        )
          return newest.outcome;
      },
    );
    this.#newest = { artifactKey: load.artifactKey, outcome };
    return outcome;
  }

  /** Resolves true when a newer call superseded this one, false once it is shown. */
  async #show(
    load: ArtifactLoad,
    progress?: SceneProgressListener,
  ): Promise<boolean> {
    const sequence = ++this.#sequence;
    this.#build?.abort();
    const abort = new AbortController();
    this.#build = abort;
    const cold = this.#displayed === null;
    const epoch: Epoch = {
      artifactKey: load.artifactKey,
      group: null,
      observationGroup: null,
      streamDone: false,
    };
    this.#epoch = epoch;
    this.#current = {
      artifactId: load.artifactId,
      artifactKey: load.artifactKey,
      observations: load.observations,
      surface: load.surface,
    };
    this.#options.marks.beginEpoch();
    let partial: AnySurfaceGroup | null = null;
    const assertCurrent = () => {
      if (this.#destroyed || sequence !== this.#sequence)
        throw new SupersededBuild();
    };
    try {
      progress?.({ detail: 'Building measured points', progress: null });
      const observations = await load.observations;
      assertCurrent();
      const observationGroup = observations
        ? this.#observationGroupFor(load, observations)
        : null;
      epoch.observationGroup = observationGroup;
      if (
        observationGroup &&
        observationGroup !== this.#displayed?.observationGroup
      ) {
        observationGroup.collection.show = true;
        observationGroup.setOpacity(cold ? 1 : 0);
        if (cold) {
          const style = this.#options.style();
          observationGroup.setVisibility(
            style.layers.observations,
            style.observationStyle.samplingAreas,
          );
          this.#revealing = { epoch, surface: null };
        }
      }
      this.#raiseOverlays(observationGroup);
      this.#options.scene.requestRender();

      const surface = await load.surface;
      assertCurrent();
      if (cold) this.#revealing = { epoch, surface };
      const style = this.#options.style();
      const key = surfaceKeyFor(load.artifactKey, style);
      epoch.cells = style.draped ? drapedCells(style.layers) : null;
      let group = this.#surfaces.get(key) ?? null;
      if (group) {
        epoch.group = group;
        if (group !== this.#displayed?.group) {
          // Every chunk is already there, so the cold reveal's wave starts now; a draped group
          // fades in once its tiles are loaded (below).
          const reveal = cold && !isDrapedGroup(group);
          group.collection.show = true;
          group.setOpacity(reveal ? 1 : 0);
          if (reveal) this.#options.wave.start(style.reducedMotion);
        }
        const heights = this.#heights.get(group);
        if (
          heights &&
          observationGroup &&
          observationGroup !== this.#displayed?.observationGroup
        )
          observationGroup.setSurfaceHeights(heights);
      } else if (style.draped) {
        const draped =
          (group =
          partial =
            await this.#createDraped(load, surface, style, abort.signal));
        epoch.group = draped;
        await draped.prepare(abort.signal).catch((error: unknown) => {
          throw isAbortError(error) ? error : new DrapeFailure(error);
        });
        assertCurrent();
        this.#surfaces.set(key, group);
        partial = null;
      } else {
        group = partial = createChunkGroup(this.#host, load, style, cold);
        this.#ids.set(group, load.artifactId);
        this.#raiseOverlays(this.#epoch?.observationGroup ?? null);
        epoch.group = group;
        await streamChunks(this.#host, {
          cold,
          displayed: this.#displayed,
          group,
          load,
          observationGroup,
          observations,
          progress,
          signal: abort.signal,
          style,
          surface,
        });
        assertCurrent();
        this.#surfaces.set(key, group);
        partial = null;
      }
      epoch.streamDone = true;
      this.#options.scene.requestRender();
      const report = (value: number) =>
        progress?.({ detail: 'Preparing surface geometry', progress: value });
      await waitForReady({ scene: this.#options.scene }, group, report, {
        signal: abort.signal,
      });
      assertCurrent();
      // A cold draped surface fades in from here; with no tile drawn there is nothing to fade.
      if (cold && isDrapedGroup(group)) {
        group.setOpacity(1);
        if (group.readyChunkCount() > 0)
          this.#options.wave.start(style.reducedMotion);
        else this.#options.wave.finish();
      }
      await this.#commit({
        cold,
        group,
        load,
        observationGroup,
        observations,
        progress,
        surface,
      });
      // A request made during the swap animation began a new epoch; this `ready` is not its own.
      if (sequence === this.#sequence) this.#options.marks.queue('ready');
      return false;
    } catch (error) {
      this.#discard(epoch, partial);
      if (
        error instanceof SupersededBuild ||
        (sequence !== this.#sequence && isAbortError(error))
      )
        return true;
      if (error instanceof DrapeFailure) {
        // Nothing reverts once destroyed. Otherwise the scene reverts to the smooth globe, whose
        // rebuild of this request settles this call.
        if (this.#destroyed) return true;
        if (sequence === this.#sequence)
          this.#options.onDrapeFailure?.(error.cause);
        if (sequence !== this.#sequence) return true;
        error = error.cause;
      }
      // A rebuild must not replay a request that failed; it restyles what is displayed.
      if (sequence === this.#sequence) this.#current = this.#displayedLoad();
      throw error;
    }
  }

  async rebuild(progress?: SceneProgressListener): Promise<void> {
    const current = this.#current;
    if (!current) return;
    await this.setArtifact({ ...current }, progress);
  }

  setSurfaceOpacity(opacity: number): void {
    this.#displayed?.group?.setSurfaceOpacity(opacity);
    this.#options.scene.requestRender();
  }

  setVisibility(layers: LayerVisibility, samplingAreas: boolean): void {
    const displayed = this.#displayed;
    const epoch = this.#epoch;
    for (const group of new Set([displayed?.group, epoch?.group]))
      group?.setVisibility(layers.surface, layers.support);
    const observationGroup = displayed
      ? displayed.observationGroup
      : epoch?.observationGroup;
    observationGroup?.setVisibility(layers.observations, samplingAreas);
    // A draped texture bakes in the cells it draws: a toggle that changes those of the newest
    // request rebuilds it, unless both are off, which only hides it (#483).
    const group = displayed?.group;
    const cells = epoch ? epoch.cells : isDrapedGroup(group) && group.cells;
    if (
      cells &&
      (layers.surface || layers.support) &&
      (cells.supported !== layers.surface || cells.masked !== layers.support)
    )
      void this.rebuild().catch((error: unknown) =>
        console.warn('The draped surface could not be rebuilt.', error),
      );
    this.#options.scene.requestRender();
  }

  setObservationAppearance(
    style: ObservationPresentation,
    layers: LayerVisibility,
  ): void {
    for (const group of this.#observationGroupsInView()) {
      group.setStyleOpacity(style.opacity);
      group.setSamplingAreaColor(style.samplingAreaColor);
      group.setSizeRange(style.sizeRange);
      group.setVisibility(layers.observations, style.samplingAreas);
    }
    this.#options.scene.requestRender();
  }

  setEarthOpacity(opacity: number): void {
    for (const group of this.#observationGroupsInView())
      group.setEarthOpacity(opacity);
  }

  setElevationFactor(factor: number, force = false): void {
    const displayed = this.#displayed;
    if (displayed) {
      displayed.group?.setElevationFactor(factor, force);
      displayed.observationGroup?.setElevationFactor(factor, force);
      return;
    }
    const epoch = this.#epoch;
    // A cold epoch's group follows the factor once its marker heights are applied, or at once
    // when the artifact has no observations (`epoch.group` is set only after observations
    // resolve, so a null observation group then means there are none).
    if (
      epoch?.group &&
      (this.#heights.has(epoch.group) || epoch.observationGroup === null)
    )
      epoch.group.setElevationFactor(factor, force);
    epoch?.observationGroup?.setElevationFactor(factor, force);
  }

  async setSceneMode(mode: ExplorerSceneMode): Promise<void> {
    await this.#displayed?.group?.setSceneMode(mode);
  }

  async setCellEdges(visible: boolean): Promise<void> {
    const displayed = this.#displayed;
    const group = displayed?.group;
    if (!displayed || !group) return;
    if (isDrapedGroup(group)) return this.#drapedEdges(group, visible);
    await group.setCellEdges(visible);
    if (visible) await this.#buildEdges(displayed, group);
    else this.#options.marks.clear('edges-ready');
  }

  async setEdgeStyle(): Promise<void> {
    const displayed = this.#displayed;
    const group = displayed?.group;
    if (!displayed || !group) return;
    const style = this.#options.style();
    if (this.#edgeStyles.get(group) === edgeStyleKey(style)) return;
    if (isDrapedGroup(group)) return this.#drapedEdges(group);
    group.edges.reset();
    this.#edgeStyles.delete(group);
    this.#options.marks.clear('edges-ready');
    if (style.cellEdges) await this.#buildEdges(displayed, group);
  }

  markValuesReady(artifactKey: string): void {
    this.#valuesReady.add(artifactKey);
    if (this.#displayed?.artifactKey === artifactKey)
      this.#options.marks.queue('values-ready');
  }

  removeSurface(artifactKey: string): void {
    const displayed = this.#displayed;
    const group = displayed?.group;
    if (!displayed || displayed.artifactKey !== artifactKey || !group) return;
    displayed.group = null;
    this.#surfaces.delete(group);
    this.#dispose(group);
    this.#options.marks.clear('values-ready');
    this.#options.marks.clear('edges-ready');
    this.#options.highlight.setArtifacts(
      null,
      displayed.observations,
      displayed.metric,
      false,
      0,
    );
    this.#options.scene.requestRender();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#build?.abort();
    this.#edgeBuild?.abort();
    this.#removeMarkListener();
    this.#removeWaveListener();
    // Their worker rasters would outlive the scene, which destroys no imagery provider (#483).
    for (const group of this.#draped) group.destroy();
    this.#draped.clear();
  }

  #probe(): AtlasMark[] {
    const epoch = this.#epoch;
    if (!epoch) return [];
    const marks: AtlasMark[] = [];
    if (epoch.observationGroup && shown(epoch.observationGroup))
      marks.push('observations-visible');
    const group = epoch.group;
    if (group && shown(group) && group.readyChunkCount() > 0)
      marks.push('surface-first-chunk');
    if (group && epoch.streamDone && shown(group) && group.isReady())
      marks.push('surface-visible');
    return marks;
  }

  /** The displayed observation group and, during a swap or a cold reveal, the incoming one. */
  #observationGroupsInView(): ObservationPrimitiveGroup[] {
    const groups = new Set<ObservationPrimitiveGroup>();
    if (this.#displayed?.observationGroup)
      groups.add(this.#displayed.observationGroup);
    if (this.#epoch?.observationGroup) groups.add(this.#epoch.observationGroup);
    return [...groups];
  }

  #displayedLoad(): Omit<ArtifactLoad, 'lookAt'> | null {
    const displayed = this.#displayed;
    return displayed
      ? {
          artifactId: displayed.artifactId,
          artifactKey: displayed.artifactKey,
          observations: Promise.resolve(displayed.observations),
          surface: Promise.resolve(displayed.surface),
        }
      : null;
  }

  #observationGroupFor(
    load: ArtifactLoad,
    observations: ObservationArtifact,
  ): ObservationPrimitiveGroup {
    const style = this.#options.style();
    const presentation = style.observationStyle;
    const key = observationKeyFor(load.artifactKey, presentation);
    let group = this.#observations.get(key);
    if (!group) {
      group = buildObservationLayer(observations, {
        artifactKey: load.artifactKey,
        colorVariable: presentation.colorVariable,
        elevation: style.elevationFactor > 0,
        exaggeration: style.elevationFactor,
        gradient: presentation.gradient,
        heights: null,
        opacity: presentation.opacity,
        samplingAreaColor: presentation.samplingAreaColor,
        samplingAreas: presentation.samplingAreas,
        shape: presentation.shape,
        sizeRange: presentation.sizeRange,
        sizeVariable: presentation.sizeVariable,
        solidColor: presentation.solidColor,
      });
      this.#observations.set(key, group);
      this.#ids.set(group, load.artifactId);
      this.#options.scene.primitives.add(group.collection);
    }
    group.setSizeRange(presentation.sizeRange);
    group.setSamplingAreaColor(presentation.samplingAreaColor);
    group.setElevationFactor(style.elevationFactor, true);
    group.setEarthOpacity(style.earthOpacity);
    group.setStyleOpacity(presentation.opacity);
    return group;
  }

  /** The draped runtime and a group for `load` from it, sharing one raster source (#483). */
  async #createDraped(
    load: ArtifactLoad,
    surface: SurfaceArtifact,
    style: ScientificStyle,
    signal: AbortSignal,
  ): Promise<DrapedSurfaceGroup> {
    let runtime: DrapedRuntime;
    try {
      runtime = await this.#options.draped!();
    } catch (error) {
      throw new DrapeFailure(error);
    }
    if (signal.aborted) throw new SupersededBuild();
    this.#rasterSource ??= runtime.rasterSource(this.#options.worker);
    const group = createDrapedGroup(this.#host, runtime, {
      inView: (candidate) =>
        !this.#destroyed &&
        (candidate === this.#displayed?.group ||
          candidate === this.#epoch?.group),
      load,
      onFailure: (error) => this.#options.onDrapeFailure?.(error),
      source: this.#rasterSource,
      style,
      surface,
    });
    this.#draped.add(group);
    this.#ids.set(group, load.artifactId);
    this.#edgeStyles.set(group, edgeStyleKey(style));
    return group;
  }

  async #commit(input: {
    cold: boolean;
    group: AnySurfaceGroup;
    load: ArtifactLoad;
    observationGroup: ObservationPrimitiveGroup | null;
    observations: ObservationArtifact | null;
    progress?: SceneProgressListener;
    surface: SurfaceArtifact;
  }): Promise<void> {
    const {
      cold,
      group,
      load,
      observationGroup,
      observations,
      progress,
      surface,
    } = input;
    const style = this.#options.style();
    const outgoing = this.#displayed;
    const factor = style.elevationFactor;
    group.setElevationFactor(factor, true);
    group.setSurfaceOpacity(style.surfaceOpacity);
    group.setVisibility(style.layers.surface, style.layers.support);
    if (isDrapedGroup(group)) void this.#drapedEdges(group);
    else void group.setCellEdges(style.cellEdges);
    void group.setSceneMode(style.mode);
    if (observationGroup) {
      const presentation = style.observationStyle;
      observationGroup.setSurfaceHeights(this.#heights.get(group) ?? null);
      observationGroup.setElevationFactor(factor, true);
      observationGroup.setSizeRange(presentation.sizeRange);
      observationGroup.setSamplingAreaColor(presentation.samplingAreaColor);
      observationGroup.setStyleOpacity(presentation.opacity);
      observationGroup.setEarthOpacity(style.earthOpacity);
      observationGroup.setVisibility(
        style.layers.observations,
        presentation.samplingAreas,
      );
    }
    this.#displayed = {
      artifactId: load.artifactId,
      artifactKey: load.artifactKey,
      geometry: style.geometry,
      group,
      metric: style.metric,
      observationGroup,
      observations,
      palette: style.palette,
      surface,
    };
    this.#revealing = null;
    this.#options.highlight.setArtifacts(
      columnarHeightSource(surface),
      observations,
      style.metric,
      factor > 0,
      factor,
    );
    this.#syncDisplayedMarks(group, style);
    this.#raiseOverlays(observationGroup);
    this.#options.onCommit(load.artifactKey);
    // A dataset switch, unlike a restyle of the displayed artifact, grows by a new wave.
    const switching =
      !cold && outgoing !== null && outgoing.artifactKey !== load.artifactKey;
    if (switching) {
      this.#switchAtOnce(group, observationGroup, outgoing);
      this.#options.wave.start(style.reducedMotion);
    }
    group.setEdgesHeld(this.#options.wave.running());
    if (!cold && !switching) {
      const incoming = fadeTogether(
        group !== outgoing?.group ? group : null,
        observationGroup !== outgoing?.observationGroup
          ? observationGroup
          : null,
      );
      const retired =
        outgoing?.group && outgoing.group !== group ? outgoing.group : null;
      const leaving = fadeTogether(
        isDrapedGroup(retired) ? opaqueUntilRetired(retired) : retired,
        outgoing?.observationGroup &&
          outgoing.observationGroup !== observationGroup
          ? outgoing.observationGroup
          : null,
      );
      if (incoming)
        await animateSwap(
          { scene: this.#options.scene },
          incoming,
          leaving,
          style.reducedMotion,
          true,
          (value) =>
            progress?.({ detail: 'Blending the new surface', progress: value }),
        );
      else if (leaving) {
        leaving.setOpacity(0);
        leaving.collection.show = false;
      }
    }
    if (this.#displayed?.group === group) group.setOpacity(1);
    if (
      observationGroup &&
      this.#displayed?.observationGroup === observationGroup
    )
      observationGroup.setOpacity(1);
    this.#prune();
    this.#options.scene.requestRender();
  }

  /** The outgoing dataset goes and the incoming one shows, in the same frame (#453). */
  #switchAtOnce(
    group: AnySurfaceGroup,
    observationGroup: ObservationPrimitiveGroup | null,
    outgoing: Displayed,
  ): void {
    for (const leaving of [outgoing.group, outgoing.observationGroup])
      if (leaving && leaving !== group && leaving !== observationGroup) {
        leaving.setOpacity(0);
        leaving.collection.show = false;
      }
    group.setOpacity(1);
    observationGroup?.setOpacity(1);
  }

  #syncDisplayedMarks(group: AnySurfaceGroup, style: ScientificStyle): void {
    const marks = this.#options.marks;
    marks.clear('values-ready');
    if (this.#valuesReady.has(group.artifactKey)) marks.queue('values-ready');
    marks.clear('edges-ready');
    if (
      style.cellEdges &&
      (isDrapedGroup(group)
        ? drapedOutlinesReady(group)
        : group.edges.isBuilt()) &&
      this.#edgeStyles.get(group) === edgeStyleKey(style)
    )
      marks.queue('edges-ready');
  }

  #startEdges(): void {
    const displayed = this.#displayed;
    const group = displayed?.group;
    if (!displayed || !group || !this.#options.style().cellEdges) return;
    if (isDrapedGroup(group)) void this.#drapedEdges(group);
    else void this.#buildEdges(displayed, group);
  }

  /**
   * Builds the displayed group's outlines in frame-budgeted slices (§B.6.9). While a reveal wave
   * runs, the build waits for its end (the wave listener restarts it): a hidden collection is not
   * updated, so rings added under the wave would all be packed and uploaded in the one frame
   * that shows them (#451).
   */
  async #buildEdges(
    displayed: Displayed,
    group: SurfaceChunkGroup,
  ): Promise<void> {
    if (this.#options.wave.running()) return;
    const style = this.#options.style();
    const key = edgeStyleKey(style);
    if (group.edges.isBuilt() && this.#edgeStyles.get(group) === key) {
      if (this.#displayed?.group === group)
        this.#options.marks.queue('edges-ready');
      return;
    }
    if (group.edges.isBuilt()) group.edges.reset();
    this.#edgeBuild?.abort();
    const abort = new AbortController();
    this.#edgeBuild = abort;
    try {
      await buildChunkEdges(this.#host, displayed, group, abort.signal);
      this.#edgeStyles.set(group, key);
      await group.setCellEdges(this.#options.style().cellEdges);
      if (this.#displayed?.group === group)
        this.#options.marks.queue('edges-ready');
    } catch (error) {
      if (!isAbortError(error))
        console.warn('Cell outlines could not be built.', error);
    }
  }

  /**
   * A draped group's outlines (#483): their colour follows the style, then they show or hide, and
   * `edges-ready` follows their layer. No wave holds them: they fade in with the surface. A newer
   * edge request or `destroy()` ends the wait for their tiles; only a raster failure reverts.
   */
  async #drapedEdges(
    group: DrapedSurfaceGroup,
    visible = this.#options.style().cellEdges,
  ): Promise<void> {
    const style = this.#options.style();
    const key = edgeStyleKey(style);
    this.#edgeBuild?.abort();
    const { signal } = (this.#edgeBuild = new AbortController());
    const inView = () => !this.#destroyed && this.#displayed?.group === group;
    try {
      if (this.#edgeStyles.get(group) !== key) {
        this.#edgeStyles.set(group, key);
        this.#options.marks.clear('edges-ready');
        await group.setOutlineStyle(edgeColorOf(style));
      }
      await group.setCellEdges(visible);
    } catch (error) {
      if (isAbortError(error)) return;
      console.warn('Cell outlines could not be built.', error);
      // An outline raster is a raster: its failure reverts the globe too.
      if (inView()) this.#options.onDrapeFailure?.(error);
      return;
    }
    // A newer request owns the marks now.
    if (signal.aborted) return;
    if (!visible) return this.#options.marks.clear('edges-ready');
    if (await waitForDrapedOutlines(this.#host, group, { inView, signal }))
      this.#options.marks.queue('edges-ready');
  }

  #discard(epoch: Epoch, partial: AnySurfaceGroup | null): void {
    const newer = this.#epoch === epoch ? null : this.#epoch;
    const displayed = this.#displayed;
    const keep = (group: object | null) =>
      group !== null &&
      (group === displayed?.group ||
        group === displayed?.observationGroup ||
        group === newer?.group ||
        group === newer?.observationGroup);
    if (partial && !keep(partial)) this.#dispose(partial);
    else if (epoch.group && !keep(epoch.group)) {
      epoch.group.setOpacity(0);
      epoch.group.collection.show = false;
    }
    if (epoch.observationGroup && !keep(epoch.observationGroup)) {
      epoch.observationGroup.setOpacity(0);
      epoch.observationGroup.collection.show = false;
    }
    if (this.#epoch === epoch) this.#epoch = null;
    // Superseded or failed, this epoch's reveal is no longer what picks resolve against.
    if (this.#revealing?.epoch === epoch) this.#revealing = null;
    this.#options.scene.requestRender();
  }

  #dispose(group: AnySurfaceGroup | ObservationPrimitiveGroup): void {
    this.#ids.delete(group);
    if (!('kind' in group))
      this.#options.scene.primitives.remove(group.collection);
    // destroy() has already destroyed every draped group it held.
    else if (!isDrapedGroup(group) || this.#draped.delete(group))
      disposeSurfaceGroup(this.#options.scene, group);
  }

  #prune(): void {
    const displayed = this.#displayed;
    if (displayed?.group)
      this.#surfaces.prune(displayed.group, (group) => this.#dispose(group));
    if (displayed?.observationGroup)
      this.#observations.prune(displayed.observationGroup, (group) =>
        this.#dispose(group),
      );
  }

  #raiseOverlays(observationGroup: ObservationPrimitiveGroup | null): void {
    raiseScientificOverlays(
      this.#options.scene.primitives,
      (observationGroup ?? this.#displayed?.observationGroup)?.collection ??
        null,
      this.#options.highlight.collection,
    );
  }
}
