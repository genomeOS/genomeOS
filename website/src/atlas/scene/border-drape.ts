/**
 * The Natural Earth borders draped on World Terrain, for Atlas design §11 (terrain draping design,
 * "Per layer under World Terrain": borders; "Failure modes"; #483).
 *
 * The context overlay hands the borders to the draped runtime here once the worker has parsed the
 * context: the worker rasterises them from its copy, and the runtime drapes the raster as the
 * `atlas-borders` imagery layer at α = the country opacity. Hidden with the countries layer, the
 * layer is not shown rather than at α 0, so it frees its tiles. The colour is baked into the raster,
 * so a colour change adds a new layer at α 0 and retires the shown one only once the globe has its
 * tiles (`whenLayerReady`); with the countries hidden that wait renders nothing until they show
 * again. An opacity change is instant. A layer still preparing when a newer request supersedes it
 * is dropped, its provider destroyed. A raster or provider failure is never an empty layer: the
 * first failure of each layer still in use is reported, and the scene reverts to the smooth globe.
 * Only the types of the lazy draped modules are imported.
 */

import type { BorderRasterSpec } from '../geometry/raster/types';
import { whenLayerReady } from './scene-transition';
import { isAbortError } from './surface-groups';
import type {
  DrapedImageryLayer,
  DrapedRuntime,
  DrapedScene,
  RasterImageryProvider,
  RasterWorkerClient,
} from './types';

/** The draped borders' deepest tile level (terrain draping design, "Per layer under World Terrain"). */
export const BORDER_MAXIMUM_LEVEL = 11;

export interface BorderDrapeStyle {
  /** `#rrggbb`. */
  color: string;
  opacity: number;
  /** The countries layer is on. */
  shown: boolean;
}

export interface BorderDrapeOptions {
  scene: DrapedScene;
  worker: RasterWorkerClient;
  /** The border style now; a build and a swap read it when they add or show a layer. */
  style(): BorderDrapeStyle;
  /** The first failure of each layer still in use. */
  onFailure(error: unknown): void;
  /** The scene has gone: nothing more is added or reported. */
  isDestroyed(): boolean;
}

/** One border layer, from its provider request until it is retired. */
interface BorderLayer {
  readonly abort: AbortController;
  /** Baked into the raster. */
  readonly color: string;
  failed: boolean;
  layer: DrapedImageryLayer | null;
  removeError: (() => void) | null;
}

export class BorderDrape {
  readonly #options: BorderDrapeOptions;
  #runtime: DrapedRuntime | null = null;
  #shown: BorderLayer | null = null;
  /** A layer still preparing, or a recoloured one waiting for its tiles to replace `#shown`. */
  #next: BorderLayer | null = null;
  #added: Promise<void> = Promise.resolve();

  constructor(options: BorderDrapeOptions) {
    this.#options = options;
  }

  /** Builds `runtime`'s borders layer in the current style, retiring every other. */
  drape(runtime: DrapedRuntime): void {
    this.retire();
    this.#runtime = runtime;
    this.#added = this.#build(runtime);
  }

  /** Destroys every border layer, and drops one still preparing. */
  retire(): void {
    this.#release(this.#next);
    this.#release(this.#shown);
    this.#next = null;
    this.#shown = null;
    this.#runtime = null;
    this.#added = Promise.resolve();
  }

  /** Applies the current opacity at once; a new colour builds a layer to replace the shown one. */
  restyle(): void {
    const { color, opacity } = this.#options.style();
    this.#shown?.layer?.setAlpha(opacity);
    const latest = this.#next ?? this.#shown;
    if (this.#runtime && latest && latest.color !== color)
      this.#added = this.#build(this.#runtime);
  }

  setShown(shown: boolean): void {
    for (const entry of [this.#shown, this.#next])
      entry?.layer?.setShown(shown);
  }

  /** Settles once the latest build has added its layer, or ended without one; never rejects. */
  async settled(): Promise<void> {
    let added: Promise<void>;
    do {
      added = this.#added;
      await added;
    } while (added !== this.#added);
  }

  /**
   * Builds a layer in the current colour, superseding one still preparing. With no layer shown it is
   * added at the border opacity; otherwise at α 0, and `#swapIn` shows it once the globe has its
   * tiles. Never rejects.
   */
  async #build(runtime: DrapedRuntime): Promise<void> {
    this.#release(this.#next);
    const entry: BorderLayer = {
      abort: new AbortController(),
      color: this.#options.style().color,
      failed: false,
      layer: null,
      removeError: null,
    };
    this.#next = entry;
    const { scene, worker } = this.#options;
    const { signal } = entry.abort;
    const spec: BorderRasterSpec = {
      color: entry.color,
      layer: 'borders',
      maximumLevel: BORDER_MAXIMUM_LEVEL,
    };
    let provider: RasterImageryProvider | null = null;
    let owned = false;
    try {
      provider = await runtime.providerFromSpec(
        runtime.rasterSource(worker),
        spec,
        signal,
      );
      // Superseded, or the scene went, while the worker prepared the raster.
      if (signal.aborted || this.#options.isDestroyed()) {
        provider.destroy();
        return;
      }
      entry.removeError = provider.errorEvent.addEventListener(
        (error: unknown) => this.#report(entry, error),
      );
      const replacing = this.#shown !== null;
      const { opacity, shown } = this.#options.style();
      // The layer owns its provider from here: destroying the layer destroys it.
      entry.layer = runtime.addDrapedImageryLayer({
        alpha: replacing ? 0 : opacity,
        name: 'atlas-borders',
        provider,
        scene,
      });
      owned = true;
      entry.layer.setShown(shown);
      scene.requestRender();
      if (replacing) void this.#swapIn(entry);
      else {
        this.#next = null;
        this.#shown = entry;
      }
    } catch (error) {
      if (!owned) provider?.destroy();
      if (signal.aborted || isAbortError(error)) return;
      this.#report(entry, error);
      this.#release(entry);
      if (this.#next === entry) this.#next = null;
    }
  }

  /** Shows a recoloured layer once the globe has its tiles, then retires the one it replaces. */
  async #swapIn(entry: BorderLayer): Promise<void> {
    try {
      await whenLayerReady(
        entry.layer!,
        this.#options.scene,
        entry.abort.signal,
      );
    } catch {
      // Superseded: whatever aborted it released its layer.
      return;
    }
    // Released later in the frame that found it ready, after the wait had settled.
    if (entry.abort.signal.aborted || !entry.layer) return;
    entry.layer.setAlpha(this.#options.style().opacity);
    this.#release(this.#shown);
    this.#next = null;
    this.#shown = entry;
    this.#options.scene.requestRender();
  }

  /** Stops a build and destroys its layer, and with it the layer's provider. */
  #release(entry: BorderLayer | null): void {
    if (!entry) return;
    entry.abort.abort();
    entry.removeError?.();
    entry.removeError = null;
    entry.layer?.destroy();
    entry.layer = null;
  }

  #report(entry: BorderLayer, error: unknown): void {
    if (entry.failed || this.#options.isDestroyed()) return;
    if (entry !== this.#shown && entry !== this.#next) return;
    entry.failed = true;
    this.#options.onFailure(error);
  }
}
