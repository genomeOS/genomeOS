/** Worker-decoded Natural Earth borders and labels for Atlas design §11 (spec 2026-10-07 §B.6.9,
 * §B.10).
 *
 * Replaces GeoJsonDataSource, whose single onload task exceeded every
 * long-task budget. The compact GOBD borders (§B.10, issue #445) are decoded
 * in the data worker; borders and labels are added in frame-budgeted slices;
 * the surface-following height adjustment is skipped at elevation 0 and
 * computed in the worker from render-tier rows on the first non-zero factor,
 * or once the worker has decoded the context when that factor came first.
 *
 * Calls may land between slices. The renderer for the latest view is built
 * and shown; an elevation or style change reaches the rings and labels added
 * so far, and later ones are added at the height and colour their renderer is
 * drawn with. When the scene is destroyed (unmount, "Retry globe") the load
 * stops at its next yield without a warning.
 *
 * The Natural Earth credit is shown from construction, not once the deferred
 * load has parsed: on phones the credit block docks the legend strip, and a
 * credit that arrived after the reveal wrapped the credit text to a second
 * line and moved the strip up 4 px (#430). A load that falls back before the
 * context is parsed withdraws it, so it stays exactly when it used to appear.
 *
 * Cesium copies a new label glyph into its texture atlas only after an await,
 * so the frame that created the glyph can find the atlas queue empty and ask
 * for no further frame; in requestRenderMode the labels would then stay
 * undrawn. Once the labels are added, the overlay requests frames until the
 * LabelCollection reports every glyph ready (at most LABEL_READY_MAX_FRAMES).
 *
 * Under World Terrain (terrain draping design, "Per layer under World Terrain": borders, labels;
 * #483) `setDraped` hands the borders to the draped runtime as the `atlas-borders` imagery layer
 * (`border-drape.ts`) once the worker has parsed the context, and neither line renderer is built or
 * shown; the data elevation is ignored. The labels take `HeightReference.RELATIVE_TO_GROUND`
 * 2,500 m above the ground, which a LabelCollection built with the scene re-clamps as terrain tiles
 * load and as Physical relief changes; on the smooth globe their reference is `NONE`, where the
 * scene changes nothing. Per "Failure modes", the first failure of each draped layer goes to
 * `onDrapeFailure`, and the scene reverts to the smooth globe. The scene's teardown calls
 * `destroy()` before the globe's, which releases the border layers and their worker raster.
 */

import {
  BufferPolyline,
  BufferPolylineCollection,
  BufferPolylineMaterial,
  Cartesian3,
  Cartographic,
  Color,
  ComponentDatatype,
  Credit,
  DistanceDisplayCondition,
  Ellipsoid,
  HeightReference,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  PolylineCollection,
  PrimitiveCollection,
  type Polyline,
  type Scene,
  VerticalOrigin,
} from 'cesium';

import type { ExplorerSceneMode } from '../url-state';
import type { Metric } from '../visual-encoding';
import type { AtlasWorkerClient } from '../worker/client';
import type { ContextHeights, NaturalEarthBuffers } from '../worker/protocol';
import { BorderDrape } from './border-drape';
import {
  countryLabelDepthTestDistance,
  countryLabelDistanceForScale,
  countryLabelHeight,
} from './geographic-overlay';
import {
  abortError,
  cartesiansOf,
  edgeRendererForMode,
  runSliced,
  SharedColorMaterial,
  yieldToEventLoop,
  type SliceOptions,
} from './sliced-lines';
import type { DrapedRuntime, DrapedScene, RasterWorkerClient } from './types';

export { BORDER_MAXIMUM_LEVEL } from './border-drape';

export const BORDER_CLEARANCE_METRES = 1_800;
export const BORDER_WIDTH_PIXELS = 1.65;
/**
 * The buffer renderer's border width. PolylineCollection and the entity polyline appearances draw
 * every line 0.5 px wider than its width (PolylineVS, PolylineColorAppearanceVS), so the legacy
 * GeoJsonDataSource borders, 1.65 px entity polylines, were 2.15 px on screen.
 * BufferPolylineMaterialVS draws the width as given, so it gets the extra 0.5 px here.
 */
const BUFFER_BORDER_WIDTH_PIXELS = BORDER_WIDTH_PIXELS + 0.5;
const ELEVATION_THROTTLE_MS = 50;
/** Frames requested for the label glyphs to reach the texture atlas; a glyph that fails to load never
 * makes the collection ready. A normal load needs two or three. */
export const LABEL_READY_MAX_FRAMES = 120;
const HEIGHT_CACHE_SIZE = 4;
const NATURAL_EARTH_CREDIT =
  '<a href="https://www.naturalearthdata.com/" target="_blank">Natural Earth</a> (public domain)';

export type ContextLoadStatus = 'ready' | 'fallback';
/** `ready` is a @private LabelCollection getter, absent from Cesium's typings: true once every glyph
 * of every shown label is in the texture atlas. */
type LabelSink = Pick<LabelCollection, 'add' | 'show'> & {
  readonly ready: boolean;
};
type SurfaceRef = { artifactKey: string; metric: Metric };
type PlacedLabel = { position: Cartesian3; heightReference: HeightReference };

/** Surface heights and the factor they are drawn at; `heights: null` is the flat clearance. */
interface Elevation {
  factor: number;
  heights: ContextHeights | null;
}

const FLAT: Elevation = { factor: 0, heights: null };

const sameElevation = (a: Elevation, b: Elevation): boolean =>
  a.factor === b.factor && a.heights === b.heights;

const surfaceKey = ({ artifactKey, metric }: SurfaceRef): string =>
  `${artifactKey}:${metric}`;

/** The scene members the overlay and its draped borders use; atlas-scene hands it the real Scene. */
export type ContextOverlayScene = DrapedScene & Pick<Scene, 'primitives'>;

export interface ContextOverlayOptions {
  worker: Pick<AtlasWorkerClient, 'contextHeights' | 'parseContext'> &
    RasterWorkerClient;
  scene: ContextOverlayScene;
  /** The first failure of each draped border layer; the scene reverts to the smooth globe. */
  onDrapeFailure?: (error: unknown) => void;
  addCredit: (credit: Credit) => void;
  removeCredit: (credit: Credit) => void;
  /** Fetches the borders, calling `onProgress` once per body chunk. */
  fetchBytes?: (url: string, onProgress?: () => void) => Promise<ArrayBuffer>;
  createLabels?: () => LabelSink;
  slice?: Omit<SliceOptions, 'onSlice' | 'signal'>;
  now?: () => number;
}

/**
 * Reads the body chunk by chunk and reports each one, so the post-reveal load order sees a slow
 * download making progress rather than a stall (spec 2026-10-07 §B.6.9).
 */
async function fetchArrayBuffer(
  url: string,
  onProgress?: () => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `Natural Earth request failed with HTTP ${response.status}`,
    );
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      onProgress?.();
    }
  } catch (error) {
    // A failed read or a throwing listener releases the body rather than leaving it downloading.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export class ContextOverlay {
  readonly collection = new PrimitiveCollection();
  readonly #options: ContextOverlayOptions;
  readonly #credit = new Credit(NATURAL_EARTH_CREDIT, true);
  readonly #now: () => number;
  readonly #heights = new Map<string, ContextHeights>();
  readonly #pendingHeights = new Set<string>();
  #parsed: NaturalEarthBuffers | null = null;
  #ground = new Float64Array(0);
  #up = new Float64Array(0);
  #scratch = new Float64Array(0);
  #labels: PlacedLabel[] = [];
  #buffer: BufferPolylineCollection | null = null;
  #projected: PolylineCollection | null = null;
  #projectedLines: Polyline[] = [];
  #projectedMaterial: SharedColorMaterial | null = null;
  #borderColor = Color.WHITE.withAlpha(0.5);
  // Rings added in later slices read this, so a style change mid-build reaches them too.
  #bufferMaterial = new BufferPolylineMaterial({
    color: this.#borderColor,
    width: BUFFER_BORDER_WIDTH_PIXELS,
  });
  // The elevation each renderer and the labels are drawn at. Items added in later slices use it, so
  // none mixes heights; #applyElevation moves all three to the current elevation.
  #bufferElevation = FLAT;
  #projectedElevation = FLAT;
  #labelElevation = FLAT;
  #mode: ExplorerSceneMode = 'globe';
  #factor = 0;
  #surface: SurfaceRef | null = null;
  #loading: Promise<ContextLoadStatus> | null = null;
  #ready = false;
  #lastElevationUpdate = Number.NEGATIVE_INFINITY;
  // Under World Terrain: the draped runtime, and the border style its rasters are drawn in.
  #draped: DrapedRuntime | null = null;
  #borderCss = '#ffffff';
  #borderOpacity = 0.5;
  readonly #borders: BorderDrape;
  #destroyed = false;

  constructor(options: ContextOverlayOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    this.#borders = new BorderDrape({
      isDestroyed: () => this.#isDestroyed(),
      onFailure: (error) => this.#reportDrapeFailure(error),
      scene: options.scene,
      style: () => ({
        color: this.#borderCss,
        opacity: this.#borderOpacity,
        shown: this.collection.show,
      }),
      worker: options.worker,
    });
    options.scene.primitives.add(this.collection);
    options.addCredit(this.#credit);
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Loads once; a later call returns the first call's promise. `onProgress` hears each body chunk,
   * and `onFetched` hears when the bytes have arrived, before they are parsed and drawn: the
   * borders no longer need the network, so the next post-reveal load may start (spec 2026-10-07
   * §B.6.9). A failed fetch never calls `onFetched`.
   */
  load(
    url: string,
    onFetched?: () => void,
    onProgress?: () => void,
  ): Promise<ContextLoadStatus> {
    this.#loading ??= this.#load(url, onFetched, onProgress);
    return this.#loading;
  }

  setSurface(artifactKey: string | null, metric: Metric): void {
    if (this.#isDestroyed()) return;
    this.#surface = artifactKey ? { artifactKey, metric } : null;
    this.#requestHeights();
    this.#applyElevation(true);
  }

  setElevationFactor(factor: number, force = false): void {
    if (this.#isDestroyed()) return;
    const safeFactor = Math.max(0, factor);
    const changed = safeFactor !== this.#factor;
    this.#factor = safeFactor;
    this.#requestHeights();
    if (changed || force) this.#applyElevation(force);
  }

  async setSceneMode(mode: ExplorerSceneMode): Promise<void> {
    this.#mode = mode;
    // Until the load is ready, its own renderer passes pick up the latest mode.
    if (!this.#ready || this.#isDestroyed()) return;
    try {
      await this.#ensureRenderer();
    } catch (error) {
      // The scene was destroyed while the renderer was being built.
      if (this.#isDestroyed()) return;
      throw error;
    }
  }

  setVisible(visible: boolean): void {
    if (this.#isDestroyed()) return;
    this.collection.show = visible;
    // A hidden imagery layer frees its tiles; one at α 0 would still load them.
    this.#borders.setShown(visible);
    this.#options.scene.requestRender();
  }

  /**
   * Drapes the borders as `runtime`'s `atlas-borders` layer and clamps the labels 2,500 m above the
   * ground, or with null returns to the lines and the labels' own heights. Resolves once the borders
   * layer is added, or at once when there is nothing to add (no parsed context yet: the load drapes
   * them); never rejects. A newer call drops a layer still preparing.
   */
  async setDraped(runtime: DrapedRuntime | null): Promise<void> {
    if (this.#isDestroyed()) return;
    if (runtime !== this.#draped) {
      this.#draped = runtime;
      this.#borders.retire();
      if (runtime) this.#hideLines();
      this.#applyLabelReference();
      this.#requestHeights();
      this.#applyElevation(true);
      if (runtime && this.#parsed) this.#borders.drape(runtime);
      // Until the load is ready, its own renderer passes pick up the latest state.
      if (this.#ready)
        try {
          await this.#ensureRenderer();
        } catch (error) {
          if (!this.#isDestroyed())
            console.warn('Country borders could not be redrawn.', error);
        }
    }
    await this.#borders.settled();
  }

  setBorderStyle(cssColor: string, opacity: number): void {
    if (this.#isDestroyed()) return;
    this.#borderOpacity = Math.min(1, Math.max(0, opacity));
    this.#borderColor = Color.fromCssColorString(cssColor).withAlpha(
      this.#borderOpacity,
    );
    // The border raster takes `#rrggbb`; the draped layer's alpha carries the opacity.
    this.#borderCss = this.#borderColor.withAlpha(1).toCssHexString();
    this.#bufferMaterial = new BufferPolylineMaterial({
      color: this.#borderColor,
      width: BUFFER_BORDER_WIDTH_PIXELS,
    });
    if (this.#buffer) {
      const polyline = new BufferPolyline();
      for (let index = 0; index < this.#buffer.primitiveCount; index += 1) {
        this.#buffer.get(index, polyline);
        polyline.setMaterial(this.#bufferMaterial);
      }
    }
    if (this.#projectedMaterial)
      this.#projectedMaterial.uniforms.color = this.#borderColor.clone();
    // An opacity change is instant; a colour, baked into the raster, needs a new layer.
    this.#borders.restyle();
    this.#options.scene.requestRender();
  }

  /** The first failure of each draped border layer still in use. */
  #reportDrapeFailure(error: unknown): void {
    if (this.#options.onDrapeFailure) this.#options.onDrapeFailure(error);
    else
      console.warn(
        'Country borders could not be draped on the terrain.',
        error,
      );
  }

  /** Draped, the borders are an imagery layer: neither line renderer shows. */
  #hideLines(): void {
    if (this.#buffer) this.#buffer.show = false;
    if (this.#projected) this.#projected.show = false;
  }

  #labelReference(): HeightReference {
    return this.#draped
      ? HeightReference.RELATIVE_TO_GROUND
      : HeightReference.NONE;
  }

  /** Every label added so far takes the current height reference; later ones are added with it. */
  #applyLabelReference(): void {
    const reference = this.#labelReference();
    for (const label of this.#labels) label.heightReference = reference;
  }

  async #load(
    url: string,
    onFetched?: () => void,
    onProgress?: () => void,
  ): Promise<ContextLoadStatus> {
    try {
      const bytes = await (this.#options.fetchBytes ?? fetchArrayBuffer)(
        url,
        onProgress,
      );
      onFetched?.();
      this.#throwIfDestroyed();
      const parsed = await this.#options.worker.parseContext(bytes);
      this.#throwIfDestroyed();
      this.#parsed = parsed;
      // The worker computes heights from the context it has just parsed, so a factor set before
      // this point is served now.
      this.#requestHeights();
      // Draped first: the worker rasterises the borders from the context it has just parsed.
      if (this.#draped) this.#borders.drape(this.#draped);
      const vertices = parsed.lonLat.length / 2;
      this.#ground = new Float64Array(vertices * 3);
      this.#up = new Float64Array(vertices * 3);
      await runSliced(
        vertices,
        (index) => this.#prepareVertex(index),
        this.#slice(),
      );
      await this.#ensureRenderer();
      await this.#addLabels(parsed);
      await this.#borders.settled();
      // A view switch or a drape that landed while the labels or the borders layer were added;
      // nothing awaits between here and ready.
      await this.#ensureRenderer();
      this.#ready = true;
      this.#applyElevation(true);
      return 'ready';
    } catch (error) {
      // Unmount and "Retry globe" destroy the scene (and stop the worker), and the
      // CesiumWidget's credits with it: not a load failure.
      if (!this.#isDestroyed()) {
        console.warn(
          'Geographic reference overlay could not be loaded.',
          error,
        );
        // Nothing was drawn without the parsed context.
        if (!this.#parsed) this.#options.removeCredit(this.#credit);
      }
      return 'fallback';
    }
  }

  /**
   * Releases the draped borders while the globe's imagery layers are still live (unmount, "Retry
   * globe"): Cesium's teardown destroys no imagery provider, and the data worker outlives the
   * scene, so their raster would stay in it. A layer still preparing is dropped when it resolves.
   * Nothing is built, shown or reported after; the primitives go with the CesiumWidget.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#borders.retire();
  }

  /** CesiumWidget.destroy() destroys the scene's primitives, this collection among them. */
  #isDestroyed(): boolean {
    return this.#destroyed || this.collection.isDestroyed();
  }

  #throwIfDestroyed(): void {
    if (this.#isDestroyed())
      throw abortError(
        'The Natural Earth overlay was destroyed with its scene',
      );
  }

  #slice(): SliceOptions {
    const yieldFn = this.#options.slice?.yieldFn ?? yieldToEventLoop;
    return {
      ...this.#options.slice,
      onSlice: () => this.#options.scene.requestRender(),
      // The scene can be destroyed only between slices; stop before the next one touches it.
      yieldFn: async () => {
        await yieldFn();
        this.#throwIfDestroyed();
      },
    };
  }

  #prepareVertex(index: number): void {
    const lonLat = this.#parsed!.lonLat;
    const lon = lonLat[index * 2];
    const lat = lonLat[index * 2 + 1];
    const ground = Cartesian3.fromDegrees(lon, lat, 0, Ellipsoid.WGS84);
    const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(
      Cartographic.fromDegrees(lon, lat),
    );
    this.#ground.set([ground.x, ground.y, ground.z], index * 3);
    this.#up.set([up.x, up.y, up.z], index * 3);
  }

  /**
   * Where rings and labels belong now: flat until the current surface's heights have arrived, and
   * flat while draped, where the labels follow the ground and the lines are hidden.
   */
  #elevation(): Elevation {
    const surface = this.#surface;
    if (this.#draped || !surface || this.#factor === 0) return FLAT;
    const heights = this.#heights.get(surfaceKey(surface));
    return heights ? { factor: this.#factor, heights } : FLAT;
  }

  #ringPositions(ring: number, { factor, heights }: Elevation): Float64Array {
    const offsets = this.#parsed!.ringOffsets;
    const start = offsets[ring];
    const end = offsets[ring + 1];
    const length = (end - start) * 3;
    if (this.#scratch.length < length) this.#scratch = new Float64Array(length);
    for (let index = start; index < end; index += 1) {
      const height =
        (heights?.borderHeights[index] ?? 0) * factor + BORDER_CLEARANCE_METRES;
      const target = (index - start) * 3;
      for (let axis = 0; axis < 3; axis += 1)
        this.#scratch[target + axis] =
          this.#ground[index * 3 + axis] + this.#up[index * 3 + axis] * height;
    }
    return this.#scratch.subarray(0, length);
  }

  #labelPosition(index: number, { factor, heights }: Elevation): Cartesian3 {
    const label = this.#parsed!.labels[index];
    return Cartesian3.fromDegrees(
      label.lon,
      label.lat,
      countryLabelHeight(heights?.labelHeights[index] ?? 0, factor),
    );
  }

  // Re-reads the mode after every await: a view switch that lands while a renderer is being built is
  // honoured when that build ends, and the last switch decides which renderer is shown. Draped, the
  // borders are an imagery layer, so neither renderer is built or shown.
  async #ensureRenderer(): Promise<void> {
    for (;;) {
      this.#throwIfDestroyed();
      const renderer = this.#draped ? null : edgeRendererForMode(this.#mode);
      if (renderer === 'buffer' && !this.#buffer) await this.#addBuffer();
      else if (renderer === 'projected' && !this.#projected)
        await this.#addProjected();
      else {
        if (this.#buffer) this.#buffer.show = renderer === 'buffer';
        if (this.#projected) this.#projected.show = renderer === 'projected';
        this.#options.scene.requestRender();
        return;
      }
    }
  }

  async #addBuffer(): Promise<void> {
    const parsed = this.#parsed!;
    const rings = parsed.ringOffsets.length - 1;
    const target = new BufferPolylineCollection({
      allowPicking: false,
      positionDatatype: ComponentDatatype.DOUBLE,
      primitiveCountMax: Math.max(1, rings),
      vertexCountMax: Math.max(1, parsed.lonLat.length / 2),
    });
    this.collection.add(target);
    this.#buffer = target;
    this.#bufferElevation = this.#elevation();
    const polyline = new BufferPolyline();
    await runSliced(
      rings,
      (ring) =>
        target.add(
          {
            material: this.#bufferMaterial,
            positions: this.#ringPositions(ring, this.#bufferElevation),
          },
          polyline,
        ),
      this.#slice(),
    );
  }

  // Hidden until every ring is added, like the cell outlines (edge-layer.ts): a shown
  // PolylineCollection rebuilds every polyline added so far on each render after an add.
  // #ensureRenderer shows it once it is complete.
  async #addProjected(): Promise<void> {
    const rings = this.#parsed!.ringOffsets.length - 1;
    const target = new PolylineCollection({ show: false });
    const lines: Polyline[] = [];
    this.collection.add(target);
    this.#projected = target;
    this.#projectedLines = lines;
    // One material for every border; setBorderStyle recolours it in place.
    const material = new SharedColorMaterial(this.#borderColor.clone());
    this.#projectedMaterial = material;
    this.#projectedElevation = this.#elevation();
    await runSliced(
      rings,
      (ring) => {
        lines.push(
          target.add({
            material,
            positions: cartesiansOf(
              this.#ringPositions(ring, this.#projectedElevation),
            ),
            width: BORDER_WIDTH_PIXELS,
          }),
        );
      },
      this.#slice(),
    );
  }

  async #addLabels(parsed: NaturalEarthBuffers): Promise<void> {
    // Built with the scene, so a label clamped to the ground follows the terrain; with
    // HeightReference.NONE the scene changes nothing (Billboard.js:1121-1150, BillboardCollection.js:324).
    const labels = (
      this.#options.createLabels ??
      (() =>
        new LabelCollection({
          scene: this.#options.scene as Scene,
        }) as LabelCollection & LabelSink)
    )();
    this.collection.add(labels);
    this.#labels = [];
    const outlineColor = Color.fromCssColorString('#020712').withAlpha(0.98);
    this.#labelElevation = this.#elevation();
    await runSliced(
      parsed.labels.length,
      (index) => {
        const { minLabel, text } = parsed.labels[index];
        this.#labels.push(
          labels.add({
            disableDepthTestDistance: countryLabelDepthTestDistance(minLabel),
            distanceDisplayCondition: new DistanceDisplayCondition(
              0,
              countryLabelDistanceForScale(minLabel),
            ),
            fillColor: Color.WHITE,
            font: '600 17px Inter, system-ui, sans-serif',
            heightReference: this.#labelReference(),
            // Label defaults to LEFT/BASELINE; the legacy entity labels (LabelVisualizer) were centred.
            horizontalOrigin: HorizontalOrigin.CENTER,
            outlineColor,
            outlineWidth: 5,
            position: this.#labelPosition(index, this.#labelElevation),
            scaleByDistance: new NearFarScalar(
              1_000_000,
              1.08,
              24_000_000,
              0.76,
            ),
            style: LabelStyle.FILL_AND_OUTLINE,
            text,
            verticalOrigin: VerticalOrigin.CENTER,
          }),
        );
      },
      this.#slice(),
    );
    this.#renderUntilLabelsReady(labels);
  }

  /** Requests frames until the labels' glyphs are in the texture atlas, so they are drawn. */
  #renderUntilLabelsReady(labels: LabelSink): void {
    const { scene } = this.#options;
    let frames = 0;
    // Cesium raises postRender outside its try/catch, and a throw there stops its render loop: the
    // destroyed check comes first, because a destroyed LabelCollection throws from `ready`.
    const remove = scene.postRender.addEventListener(() => {
      if (
        this.#isDestroyed() ||
        labels.ready ||
        frames >= LABEL_READY_MAX_FRAMES
      ) {
        remove();
        return;
      }
      // A hidden collection does not update its labels; showing it again requests a frame.
      if (!this.collection.show) return;
      frames += 1;
      scene.requestRender();
    });
    scene.requestRender();
  }

  #requestHeights(): void {
    const surface = this.#surface;
    // The worker computes heights from the parsed context; #load asks once it has parsed. Draped,
    // nothing reads them; undraping asks again.
    if (this.#draped || !surface || this.#factor === 0 || !this.#parsed) return;
    const key = surfaceKey(surface);
    if (this.#heights.has(key) || this.#pendingHeights.has(key)) return;
    this.#pendingHeights.add(key);
    this.#options.worker
      .contextHeights({
        artifactKey: surface.artifactKey,
        metric: surface.metric,
      })
      .then((heights) => {
        this.#pendingHeights.delete(key);
        this.#heights.set(key, heights);
        while (this.#heights.size > HEIGHT_CACHE_SIZE)
          this.#heights.delete(this.#heights.keys().next().value!);
        const current = this.#surface;
        if (current && surfaceKey(current) === key) this.#applyElevation(true);
      })
      .catch((error: unknown) => {
        this.#pendingHeights.delete(key);
        // The worker stops with a destroyed scene; that is not a failure to report.
        if (!this.#isDestroyed())
          console.warn('Country outlines could not follow the surface.', error);
      });
  }

  /** Moves every ring and label added so far, in both renderers, to the current elevation. */
  #applyElevation(force: boolean): void {
    if (this.#isDestroyed()) return;
    // Nothing added yet: each renderer and the labels start at the elevation current when built.
    if (!this.#buffer && !this.#projected && this.#labels.length === 0) return;
    const time = this.#now();
    if (
      !force &&
      this.#factor !== 0 &&
      time - this.#lastElevationUpdate < ELEVATION_THROTTLE_MS
    )
      return;
    this.#lastElevationUpdate = time;
    const elevation = this.#elevation();
    let moved = false;
    if (this.#buffer && !sameElevation(this.#bufferElevation, elevation)) {
      const polyline = new BufferPolyline();
      for (let ring = 0; ring < this.#buffer.primitiveCount; ring += 1) {
        this.#buffer.get(ring, polyline);
        polyline.setPositions(this.#ringPositions(ring, elevation));
      }
      this.#bufferElevation = elevation;
      moved = true;
    }
    if (
      this.#projected &&
      !sameElevation(this.#projectedElevation, elevation)
    ) {
      this.#projectedLines.forEach((line, ring) => {
        line.positions = cartesiansOf(this.#ringPositions(ring, elevation));
      });
      this.#projectedElevation = elevation;
      moved = true;
    }
    if (!sameElevation(this.#labelElevation, elevation)) {
      this.#labels.forEach((label, index) => {
        label.position = this.#labelPosition(index, elevation);
      });
      this.#labelElevation = elevation;
      moved = true;
    }
    if (moved) this.#options.scene.requestRender();
  }
}
