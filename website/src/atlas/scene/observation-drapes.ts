/**
 * Observations on World Terrain for Atlas design §11 (terrain draping design, "Per layer under
 * World Terrain": sampling footprints and observation symbols; "2D and Columbus"; "Failure modes";
 * #483).
 *
 * While the scene drapes, each observation group in view stands on the rendered ground and drapes
 * its sampling footprints:
 * - Ground: one `GroundHeights` per group samples `globe.getHeight` under its observations, and
 *   each change lifts the symbols by it, today's clearance kept. It re-samples as terrain tiles
 *   load, after each morph between views, and whenever `resample` is called (a relief change).
 * - Footprints: the worker rasterises the group's circles in its sampling colour as the
 *   `atlas-footprints` imagery layer, never part of the surface texture. The layer is added at
 *   α 0 and handed to the group, which then hides its rings, once the globe has its tiles
 *   (`whenLayerReady`): the rings stay until the ground shows the footprints. The colour is baked
 *   into the raster, so a new colour builds a new layer and the old one stays until it is
 *   replaced. A build still preparing when a newer one, the smooth globe or a release supersedes
 *   it is dropped, its provider destroyed.
 * - Failures: a raster or provider failure is never an empty layer. The first failure of each
 *   build still in use is reported, and the scene reverts to the smooth globe.
 * - Release: on the smooth globe, out of view or pruned, a group loses its footprints and ground
 *   and returns to its rings and today's heights. Out of view it would only keep re-sampling, and
 *   its hidden footprints have freed their tiles anyway (only a shown layer keeps tiles resident).
 *
 * Only the types of the lazy draped modules are imported.
 */

import type { Observation } from '../contracts';
import { createGroundHeights, type GroundHeights } from './ground-heights';
import {
  footprintSpec,
  type ObservationPrimitiveGroup,
} from './observation-layer';
import { whenLayerReady } from './scene-transition';
import type { ScientificScene } from './scientific-layers';
import {
  isAbortError,
  observationPoints,
  sharedRasterSource,
} from './surface-groups';
import type {
  DrapedImageryLayer,
  DrapedRuntime,
  RasterImageryProvider,
  RasterTileSource,
  RasterWorkerClient,
} from './types';

export interface ObservationDrapesOptions {
  scene: Pick<
    ScientificScene,
    | 'globe'
    | 'imageryLayers'
    | 'morphComplete'
    | 'preRender'
    | 'postRender'
    | 'requestRender'
  >;
  worker: RasterWorkerClient;
  /** The raster source the footprints read; by default one over `worker`, made once. */
  rasterSource?(runtime: DrapedRuntime): RasterTileSource;
  /** The lazily imported draped runtime. */
  draped(): Promise<DrapedRuntime>;
  /** A footprint raster failed; the scene reverts to the smooth globe. */
  onDrapeFailure(error: unknown): void;
}

/** One footprint layer, from its provider request until newer footprints replace it. */
interface FootprintBuild {
  readonly abort: AbortController;
  layer: DrapedImageryLayer | null;
  failed: boolean;
}

/** A draped observation group: what its footprints are built from, its ground and its builds. */
interface Tracked {
  readonly artifactKey: string;
  readonly observations: readonly Observation[];
  readonly ground: GroundHeights;
  /** The sampling colour of the newest footprints: shown, preparing or failed. */
  color: string | null;
  /** The footprints the group holds. */
  shown: FootprintBuild | null;
  /** Footprints preparing, or waiting for their tiles to replace `shown`. */
  next: FootprintBuild | null;
}

export class ObservationDrapes {
  readonly #options: ObservationDrapesOptions;
  readonly #tracked = new Map<ObservationPrimitiveGroup, Tracked>();
  readonly #rasterSource: (runtime: DrapedRuntime) => RasterTileSource;
  #destroyed = false;

  constructor(options: ObservationDrapesOptions) {
    this.#options = options;
    this.#rasterSource =
      options.rasterSource ?? sharedRasterSource(options.worker);
  }

  /**
   * Draped: ground heights once per group, footprints rebuilt when the colour differs. Smooth:
   * release.
   */
  sync(
    group: ObservationPrimitiveGroup,
    observations: readonly Observation[],
    artifactKey: string,
    style: { draped: boolean; samplingAreaColor: string },
  ): void {
    if (!style.draped || this.#destroyed) return this.release(group);
    if (!this.#tracked.has(group)) {
      const ground = createGroundHeights(
        this.#options.scene,
        observationPoints({ observations })!,
      );
      this.#tracked.set(group, {
        artifactKey,
        color: null,
        ground,
        next: null,
        observations,
        shown: null,
      });
      ground.onChange((heights) => this.#lift(group, heights));
      this.#lift(group, ground.heights());
    }
    this.restyle(group, style.samplingAreaColor);
  }

  /** A draped group's footprints follow a new sampling colour; one on the smooth globe has none. */
  restyle(group: ObservationPrimitiveGroup, samplingAreaColor: string): void {
    const entry = this.#tracked.get(group);
    if (entry && entry.color !== samplingAreaColor)
      void this.#build(group, entry, samplingAreaColor);
  }

  /** Releases every draped group but `groups`, the observation groups still in view. */
  retain(groups: readonly ObservationPrimitiveGroup[]): void {
    for (const group of [...this.#tracked.keys()])
      if (!groups.includes(group)) this.release(group);
  }

  /**
   * Aborts the footprint build and clears the footprints and the ground, so the rings and today's
   * heights return.
   */
  release(group: ObservationPrimitiveGroup): void {
    const entry = this.#tracked.get(group);
    if (!entry) return;
    this.#tracked.delete(group);
    this.#drop(entry);
    group.setFootprints(null);
    group.setGroundHeights(null);
    this.#options.scene.requestRender();
  }

  /** Re-samples every draped group's ground heights (see `GroundHeights.resample`). */
  resample(final?: boolean): void {
    for (const { ground } of this.#tracked.values()) ground.resample(final);
  }

  /** Destroys every footprint layer, releasing its raster, and stops sampling for good. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const [group, entry] of this.#tracked) {
      this.#drop(entry);
      group.setFootprints(null);
    }
    this.#tracked.clear();
  }

  #lift(group: ObservationPrimitiveGroup, heights: Float64Array): void {
    group.setGroundHeights(heights);
    this.#options.scene.requestRender();
  }

  /**
   * Builds the footprints in `color`, superseding a build still preparing, and hands them to the
   * group once the globe has their tiles. Never rejects.
   */
  async #build(
    group: ObservationPrimitiveGroup,
    entry: Tracked,
    color: string,
  ): Promise<void> {
    this.#dropNext(entry);
    const build: FootprintBuild = {
      abort: new AbortController(),
      failed: false,
      layer: null,
    };
    entry.color = color;
    entry.next = build;
    const { scene } = this.#options;
    const { signal } = build.abort;
    let provider: RasterImageryProvider | null = null;
    try {
      const runtime = await this.#options.draped();
      if (signal.aborted) return;
      provider = await runtime.providerFromSpec(
        this.#rasterSource(runtime),
        footprintSpec(entry.artifactKey, entry.observations, color),
        signal,
      );
      // Superseded, released or destroyed while the worker prepared the raster.
      if (signal.aborted) return;
      provider.errorEvent.addEventListener((error: unknown) =>
        this.#report(build, error),
      );
      build.layer = runtime.addDrapedImageryLayer({
        alpha: 0,
        name: 'atlas-footprints',
        provider,
        scene,
      });
      // The layer owns its provider from here: destroying the layer destroys it.
      provider = null;
      scene.requestRender();
      await whenLayerReady(build.layer, scene, signal);
      // Released later in the frame that found it ready, after the wait had settled.
      if (signal.aborted) return;
      entry.shown?.abort.abort();
      entry.shown = build;
      entry.next = null;
      // The group destroys the footprints this replaces, and hides its rings.
      group.setFootprints(build.layer);
      scene.requestRender();
    } catch (error) {
      // Superseded or released: whatever aborted it released its layer.
      if (signal.aborted) return;
      if (!isAbortError(error)) this.#report(build, error);
      if (entry.next === build) this.#dropNext(entry);
    } finally {
      provider?.destroy();
    }
  }

  /** Stops the footprints still preparing and destroys their layer, and with it their provider. */
  #dropNext(entry: Tracked): void {
    entry.next?.abort.abort();
    entry.next?.layer?.destroy();
    entry.next = null;
  }

  /** Stops sampling and every build; the group still holds, and destroys, the shown layer. */
  #drop(entry: Tracked): void {
    entry.ground.destroy();
    this.#dropNext(entry);
    entry.shown?.abort.abort();
    entry.shown = null;
  }

  #report(build: FootprintBuild, error: unknown): void {
    if (build.failed || build.abort.signal.aborted || this.#destroyed) return;
    build.failed = true;
    this.#options.onDrapeFailure(error);
  }
}
