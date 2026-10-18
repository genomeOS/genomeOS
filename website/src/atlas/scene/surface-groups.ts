/**
 * Surface-group operations per kind for ScientificLayers (Atlas design §11): worker-built chunks on
 * the smooth globe, and under World Terrain the draped imagery group (terrain draping design, "Per
 * layer under World Terrain" and "How existing features behave", #483). ScientificLayers keeps the
 * epochs, the cache and the swaps for both kinds; what differs between them lives here.
 *
 * - Chunks are built in a shown collection, streamed from the worker with their marker anchors
 *   (spec 2026-10-07 §B.6.8), and outlined by a sliced worker edge build (§B.6.9).
 * - A draped group reads a surface raster spec. Extruded drapes as hexagons, since data elevation
 *   is off under World Terrain, and the cell layers that are on choose the cells baked into its
 *   texture, so a toggle that changes them rebuilds it. Honmoon contours are not drawn yet.
 * - A draped group's outlines are waited on only while it is in view. A group drawing no supported
 *   cell has none, so they are ready at once, and a stalled wait warns but never reverts the globe:
 *   only a raster failure does.
 * - In a restyle swap the outgoing draped layer stays opaque until it is retired, so the incoming
 *   one cross-fades over it rather than both letting the ground show through.
 * - The caches' keys and a dataset switch's same-frame swap, shared by both kinds, live here too, so
 *   that ScientificLayers stays within its line cap.
 */

import { Ellipsoid, Math as CesiumMath } from 'cesium';

import type { ObservationArtifact } from '../contracts';
import type { EdgeColorSpec } from '../geometry/edge-buffers';
import type {
  DrapedGeometry,
  SurfaceRasterSpec,
} from '../geometry/raster/types';
import type { SurfaceArtifact } from '../surface-columns';
import type { LayerVisibility, SurfaceGeometry } from '../url-state';
import type { Metric, PaletteId } from '../visual-encoding';
import type { BuildChunksBody, ChunkMessage, LookAt } from '../worker/protocol';
import { createMessageQueue, scheduleChunks } from './chunk-scheduler';
import { viewCentre } from './globe-offset';
import {
  observationHeightsFromBuffers,
  type ObservationPrimitiveGroup,
  type ObservationSurfaceHeights,
} from './observation-layer';
import { REVEAL_ATTRIBUTE, type MarkTracker } from './scene-marks';
import { waitForReady, type FadeableGroup } from './scene-transition';
import type {
  ScientificLayersOptions,
  ScientificScene,
  ScientificStyle,
} from './scientific-layers';
import {
  createSurfaceChunkGroup,
  type SurfaceChunkGroup,
} from './surface-chunk-layer';
import { columnarHeightSource } from './surface-heights';
import type {
  ArtifactLoad,
  DrapedRuntime,
  DrapedSurfaceGroup,
  ObservationPresentation,
  RasterTileSource,
  SceneProgressListener,
  SurfaceGroup,
} from './types';

/** A surface group of either kind, told apart by `kind`. */
export type AnySurfaceGroup = SurfaceChunkGroup | DrapedSurfaceGroup;

/** What the per-kind operations use of ScientificLayers. */
export interface SurfaceGroupHost {
  readonly scene: ScientificScene;
  readonly worker: ScientificLayersOptions['worker'];
  readonly wave: ScientificLayersOptions['wave'];
  readonly marks: MarkTracker;
  readonly perf: NonNullable<ScientificLayersOptions['perf']>;
  readonly frameBudgetMs: number;
  /** Marker heights per surface group, from its stream's anchors; draped groups have none. */
  readonly heights: WeakMap<SurfaceGroup, ObservationSurfaceHeights>;
  style(): ScientificStyle;
  lookAt(): LookAt;
}

/** What a chunk stream and an edge build read of the displayed artifact. */
export interface DisplayedSurface {
  artifactKey: string;
  surface: SurfaceArtifact;
  group: AnySurfaceGroup | null;
  observationGroup: ObservationPrimitiveGroup | null;
  metric: Metric;
  palette: PaletteId;
  geometry: SurfaceGeometry;
}

export type EdgeSource = Pick<
  DisplayedSurface,
  'artifactKey' | 'geometry' | 'metric' | 'palette' | 'surface'
>;

export interface ChunkStreamInput {
  cold: boolean;
  group: SurfaceChunkGroup;
  load: ArtifactLoad;
  observationGroup: ObservationPrimitiveGroup | null;
  observations: ObservationArtifact | null;
  progress?: SceneProgressListener;
  signal: AbortSignal;
  style: ScientificStyle;
  surface: SurfaceArtifact;
  /** The artifact on screen as the stream starts, whose marker heights a recolour keeps. */
  displayed: DisplayedSurface | null;
}

/** A raster or runtime failure while a draped group was prepared; the globe reverts to smooth. */
export class DrapeFailure extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('The draped surface could not be prepared.', { cause });
    this.name = 'DrapeFailure';
    this.cause = cause;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isDrapedGroup(
  group: SurfaceGroup | null | undefined,
): group is DrapedSurfaceGroup {
  return group?.kind === 'draped';
}

export function edgeColorOf(
  style: Pick<ScientificStyle, 'edgeColorMode' | 'edgeFixedColor'>,
): EdgeColorSpec {
  return style.edgeColorMode === 'matched'
    ? { mode: 'matched' }
    : { color: style.edgeFixedColor, mode: 'fixed' };
}

/** A surface group's cache key; a draped one's also names the cells baked into its texture. */
export function surfaceKeyFor(
  artifactKey: string,
  style: ScientificStyle,
): string {
  const { layers } = style;
  const kind = style.draped
    ? `draped:${+layers.surface}${+layers.support}`
    : 'chunks';
  return [artifactKey, style.metric, style.palette, style.geometry, kind].join(
    ':',
  );
}

/** An observation group's cache key: what its primitives bake in. */
export function observationKeyFor(
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

export function edgeStyleKey(
  style: Pick<ScientificStyle, 'edgeColorMode' | 'edgeFixedColor'>,
): string {
  return `${style.edgeColorMode}:${style.edgeFixedColor}`;
}

/** The cells a draped surface draws: supported ones with the surface layer, masked with support. */
export function drapedCells(
  layers: Pick<LayerVisibility, 'support' | 'surface'>,
): SurfaceRasterSpec['cells'] {
  return { masked: layers.support, supported: layers.surface };
}

export function drapedSurfaceSpec(
  load: Pick<ArtifactLoad, 'artifactKey'>,
  surface: SurfaceArtifact,
  style: ScientificStyle,
): SurfaceRasterSpec {
  const geometry: DrapedGeometry =
    style.geometry === 'extruded' ? 'hexagons' : style.geometry;
  return {
    artifactKey: load.artifactKey,
    cells: drapedCells(style.layers),
    contours: false,
    geometry,
    gridSha256: surface.grid.gridSha256,
    layer: 'surface',
    metric: style.metric,
    palette: style.palette,
  };
}

/**
 * The outgoing draped group of a swap: opaque until it is retired, then gone. Imagery layers blend
 * with the ground, so fading it out under the incoming layer would show the ground mid-swap.
 */
export function opaqueUntilRetired(group: SurfaceGroup): FadeableGroup {
  return {
    collection: group.collection,
    isReady: () => group.isReady(),
    readyCount: () => group.readyCount(),
    setOpacity: (opacity) => group.setOpacity(opacity > 0 ? 1 : 0),
    totalCount: () => group.totalCount(),
  };
}

/** The outgoing dataset goes and the incoming one shows, in the same frame (#453). */
export function switchAtOnce(
  group: AnySurfaceGroup,
  observationGroup: ObservationPrimitiveGroup | null,
  outgoing: Pick<DisplayedSurface, 'group' | 'observationGroup'>,
): void {
  for (const leaving of [outgoing.group, outgoing.observationGroup])
    if (leaving && leaving !== group && leaving !== observationGroup) {
      leaving.setOpacity(0);
      leaving.collection.show = false;
    }
  group.setOpacity(1);
  observationGroup?.setOpacity(1);
}

/** A draped group's outlines are drawn: ready, or none to draw with its supported cells off. */
export function drapedOutlinesReady(group: DrapedSurfaceGroup): boolean {
  return !group.cells.supported || group.outlinesReady();
}

/**
 * Waits until a draped group's outlines are drawn, resolving true if the group is still in view.
 * The group leaving the view, or `signal`, ends the wait with false. A wait that stalls is not a
 * raster failure, so it only warns, and the collection it would hide is detached from the surface.
 */
export function waitForDrapedOutlines(
  { scene }: Pick<SurfaceGroupHost, 'scene'>,
  group: DrapedSurfaceGroup,
  { inView, signal }: { inView(): boolean; signal: AbortSignal },
): Promise<boolean> {
  const outlines: FadeableGroup = {
    collection: { show: true },
    isReady: () => !inView() || drapedOutlinesReady(group),
    readyCount: () => +drapedOutlinesReady(group),
    setOpacity() {},
  };
  return waitForReady({ scene }, outlines, undefined, { signal }).then(
    () => inView(),
    (error: unknown) => {
      if (!isAbortError(error))
        console.warn('Cell outlines did not become ready.', error);
      return false;
    },
  );
}

export function disposeSurfaceGroup(
  scene: ScientificScene,
  group: SurfaceGroup,
): void {
  if (isDrapedGroup(group)) group.destroy();
  else scene.primitives.remove(group.collection);
}

/** A chunk group for `load` in a shown collection, at opacity 1 for a cold reveal, else 0. */
export function createChunkGroup(
  host: SurfaceGroupHost,
  load: ArtifactLoad,
  style: ScientificStyle,
  cold: boolean,
): SurfaceChunkGroup {
  const group = createSurfaceChunkGroup({
    artifactKey: load.artifactKey,
    cellEdges: style.cellEdges,
    elevationFactor: 0,
    geometry: style.geometry,
    requestRender: () => host.scene.requestRender(),
    surfaceOpacity: style.surfaceOpacity,
    wave: host.wave.uniforms,
  });
  group.setOpacity(cold ? 1 : 0);
  group.setVisibility(style.layers.surface, style.layers.support);
  group.collection.show = true;
  host.scene.primitives.add(group.collection);
  return group;
}

/**
 * A draped group for `load` at opacity 0; it fades in once its tiles are loaded. A failure of its
 * layers is reported once, and only while `inView` says the group is displayed or incoming.
 */
export function createDrapedGroup(
  host: SurfaceGroupHost,
  runtime: DrapedRuntime,
  input: {
    load: ArtifactLoad;
    surface: SurfaceArtifact;
    style: ScientificStyle;
    source: RasterTileSource;
    inView(group: DrapedSurfaceGroup): boolean;
    onFailure(error: unknown): void;
  },
): DrapedSurfaceGroup {
  const { load, style } = input;
  let reported = false;
  const group: DrapedSurfaceGroup = runtime.createDrapedSurfaceGroup({
    artifactKey: load.artifactKey,
    cellEdges: style.cellEdges,
    edgeColor: edgeColorOf(style),
    onError: (error) => {
      if (reported || !input.inView(group)) return;
      reported = true;
      input.onFailure(error);
    },
    scene: host.scene,
    source: input.source,
    surface: drapedSurfaceSpec(load, input.surface, style),
    surfaceOpacity: style.surfaceOpacity,
    wave: host.wave,
  });
  group.setOpacity(0);
  group.setVisibility(style.layers.surface, style.layers.support);
  group.collection.show = true;
  return group;
}

export function observationPoints(
  observations: ObservationArtifact | null,
): Float64Array | null {
  return observations
    ? Float64Array.from(
        observations.observations.flatMap(({ lat, lon }) => [lon, lat]),
      )
    : null;
}

/** Streams a chunk group's chunks from the worker into the scene, frame-budgeted. */
export async function streamChunks(
  host: SurfaceGroupHost,
  input: ChunkStreamInput,
): Promise<void> {
  const {
    cold,
    displayed,
    group,
    load,
    observationGroup,
    observations,
    progress,
    signal,
    style,
    surface,
  } = input;
  // A recolour streams no anchors (the worker rebuilds each chunk from its cached topology,
  // chunk plan and vertex means and sends none), so it is taken only when the displayed
  // group's marker heights exist to copy onto the new group; otherwise (no heights, e.g. after
  // removeSurface) a full build brings the anchors back. An artifact without observations has
  // no markers and needs no heights.
  const sourceHeights = displayed?.group
    ? host.heights.get(displayed.group)
    : undefined;
  const recolour =
    (sourceHeights !== undefined || observations === null) &&
    displayed?.artifactKey === load.artifactKey &&
    displayed.metric === style.metric &&
    displayed.geometry === style.geometry &&
    displayed.palette !== style.palette;
  if (recolour) {
    if (sourceHeights) host.heights.set(group, sourceHeights);
    group.setElevationFactor(host.style().elevationFactor, true);
  }
  const request: BuildChunksBody = {
    artifactKey: load.artifactKey,
    geometry: style.geometry,
    gridSha256: surface.grid.gridSha256,
    lookAt: load.lookAt ?? host.lookAt(),
    metric: style.metric,
    observationPoints: observationPoints(observations),
    palette: style.palette,
  };
  const queue = createMessageQueue<ChunkMessage>();
  const worker = host.worker;
  const onChunk = (message: ChunkMessage) => queue.push(message);
  const producer = (
    recolour
      ? worker.recolour(request, onChunk, signal)
      : worker.buildChunks(request, onChunk, signal)
  ).then(
    () => queue.end(),
    (error: unknown) => queue.fail(error),
  );
  const sharedObservations =
    observationGroup !== null &&
    observationGroup === displayed?.observationGroup;
  let added = 0;
  progress?.({ detail: 'Building surface geometry', progress: null });
  const stats = await scheduleChunks(host.scene, group, queue, {
    frameBudgetMs: host.frameBudgetMs,
    onAdded: (message) => {
      added += 1;
      // The cold reveal's wave starts with its first chunk (#453).
      if (cold && added === 1) host.wave.start(style.reducedMotion);
      host.perf.mark('atlas:chunk-add', {
        detail: { artifactKey: load.artifactKey, chunk: message.chunk },
      });
      progress?.({
        detail: 'Preparing surface geometry',
        progress: message.total > 0 ? Math.min(1, added / message.total) : null,
      });
    },
    onBeforeAdd: (message) => {
      if (!observations) {
        // No markers to anchor, so nothing waits on anchors: raise the group before its first
        // chunk is added (§B.6.8) rather than at the commit.
        if (added === 0)
          group.setElevationFactor(host.style().elevationFactor, true);
        return;
      }
      if (!message.anchors) return;
      const heights = observationHeightsFromBuffers(
        message.anchors,
        observations.observations,
        columnarHeightSource(surface),
        style.metric,
      );
      host.heights.set(group, heights);
      if (observationGroup && !sharedObservations)
        observationGroup.setSurfaceHeights(heights);
      group.setElevationFactor(host.style().elevationFactor, true);
    },
    order: [],
    signal,
  });
  await producer;
  // A cold reveal with no chunk (no supported cell) started no wave; it reads `done` so that
  // nothing waits on one (#453).
  if (cold && added === 0 && !signal.aborted) host.wave.finish();
  host.marks.setAttribute(REVEAL_ATTRIBUTE, JSON.stringify(stats));
}

/** A chunk group's outlines from the worker, at exaggeration 1 (the edge layer scales them). */
export function buildChunkEdges(
  host: SurfaceGroupHost,
  displayed: EdgeSource,
  group: SurfaceChunkGroup,
  signal: AbortSignal,
): Promise<void> {
  const style = host.style();
  return group.edges.build(
    (onChunk, edgeSignal) =>
      host.worker.buildEdges(
        {
          artifactKey: displayed.artifactKey,
          edgeColor: edgeColorOf(style),
          factor: 1,
          geometry: displayed.geometry,
          gridSha256: displayed.surface.grid.gridSha256,
          lookAt: host.lookAt(),
          metric: displayed.metric,
          palette: displayed.palette,
        },
        onChunk,
        edgeSignal,
      ),
    style.edgeFixedColor,
    style.mode,
    style.elevationFactor,
    signal,
  );
}

/** The ground point at the centre of the open area, where the desktop globe is drawn (#452). */
export function viewLookAt(scene: ScientificScene): LookAt {
  const { camera } = scene;
  const hit = camera.pickEllipsoid(viewCentre(scene), Ellipsoid.WGS84);
  const point =
    (hit ? Ellipsoid.WGS84.cartesianToCartographic(hit) : undefined) ??
    camera.positionCartographic;
  return {
    lat: CesiumMath.toDegrees(point.latitude),
    lon: CesiumMath.toDegrees(point.longitude),
  };
}
