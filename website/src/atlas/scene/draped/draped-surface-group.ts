/**
 * `DrapedSurfaceGroup`, the inferred surface under World Terrain as the `atlas-surface` and
 * `atlas-outlines` imagery layers (terrain draping design, "Per layer under World Terrain",
 * Provider and group, and "How existing features behave", #483; Atlas design §11).
 *
 * It is the `draped` kind of surface group, so ScientificLayers drives it through the epochs,
 * cache and `animateSwap` it drives the chunks with.
 *
 * - Alpha: the surface layer draws at `DRAPED_SURFACE_ALPHA` × surface opacity × fade opacity ×
 *   the reveal wave's progress, the outlines at fade opacity × progress, independent of surface
 *   opacity, and only while cell edges are on and the raster draws supported cells (the chunk
 *   path hides edges with the surface layer). With both cell sets off both draw at alpha 0, the
 *   rasters kept, so the toggle back is instant. Every setter and every `preRender` recomputes
 *   both and writes only a changed one, so the 1 s fade follows the wave frame by frame and a
 *   frame at rest requests nothing.
 * - `prepare` prepares the surface raster and adds its layer, then the outlines' when edges are
 *   on. A raster with nothing to draw adds no layer and is ready at once. The outlines are
 *   prepared the first time edges turn on and toggled by alpha after that.
 * - A new outline style is prepared at alpha 0 above the old outlines, which keep drawing until
 *   the new layer is ready and are then destroyed in the frame that shows the new one, as a
 *   restyle keeps the outgoing surface opaque until it is retired. A style moved past before it
 *   was ready is dropped; a restyle with edges off drops the outlines, and the new style is
 *   prepared when they return.
 * - Readiness: `isReady` once the surface layer is ready (Cesium has loaded its tiles at alpha 0);
 *   `readyChunkCount` is 1 from the first drawn surface tile, so a cold reveal with nothing in
 *   view runs no wave; `outlinesReady` once the outlines are prepared and their layer is ready.
 *   Hiding the group frees its layers' tiles, so shown again it counts all three from scratch.
 * - No silent gaps: a raster that fails while `prepare` runs rejects it, a later one and every
 *   provider `errorEvent` go to `onError`, and the scene reverts to the smooth globe. `destroy`
 *   aborts every prepare in flight (a raster arriving after it is released at once), removes the
 *   layers and releases their rasters. A `prepare` whose own signal aborts rejects at once and
 *   stops the outline prepare it started; a surface layer it already added waits for `destroy`.
 *   Every setter is a no-op after `destroy`.
 * - Data elevation is off under World Terrain and Cesium drapes imagery in every scene mode, so
 *   the elevation, scene-mode and edge-hold setters do nothing.
 *
 * Lazy: only the draped runtime imports this module.
 */

import type { EdgeColorSpec } from '../../geometry/edge-buffers';
import {
  DRAPED_SURFACE_ALPHA,
  type AtlasImageryLayerName,
  type OutlineRasterSpec,
  type RasterSpec,
  type SurfaceRasterSpec,
} from '../../geometry/raster/types';
import type {
  DrapedImageryLayer,
  DrapedSurfaceGroup,
  DrapedSurfaceGroupOptions,
} from '../types';
import { addDrapedImageryLayer } from './draped-imagery-layer';
import { AtlasRasterImageryProvider } from './raster-imagery-provider';

// The surface layer's alpha at full opacity, as the chunk path's surface material. The mask
// texels divide by it, so the raster types own it.
export { DRAPED_SURFACE_ALPHA };

/** An Atlas layer this group drew, with the provider listeners it detaches on destroy. */
interface HeldLayer {
  readonly draped: DrapedImageryLayer;
  destroy(): void;
}

/** One outline style's raster: prepared to a layer, to nothing to draw, or still in flight. */
interface OutlineState {
  readonly abort: AbortController;
  done: Promise<void>;
  prepared: boolean;
  layer: HeldLayer | null;
}

function abortError(): DOMException {
  return new DOMException(
    'The draped surface was destroyed or superseded.',
    'AbortError',
  );
}

function sameEdgeColor(a: EdgeColorSpec, b: EdgeColorSpec): boolean {
  return a.mode === 'matched'
    ? b.mode === 'matched'
    : b.mode === 'fixed' && a.color === b.color;
}

function outlineSpec(
  surface: SurfaceRasterSpec,
  edgeColor: EdgeColorSpec,
): OutlineRasterSpec {
  const { artifactKey, geometry, gridSha256, metric, palette } = surface;
  return {
    artifactKey,
    edgeColor,
    geometry,
    gridSha256,
    layer: 'outlines',
    metric,
    palette,
  };
}

/** A signal that aborts with either input; `detach` lets go of both. */
function eitherSignal(
  a: AbortSignal,
  b: AbortSignal,
): { signal: AbortSignal; detach(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const detach = () => {
    a.removeEventListener('abort', abort);
    b.removeEventListener('abort', abort);
  };
  if (a.aborted || b.aborted) abort();
  else {
    a.addEventListener('abort', abort, { once: true });
    b.addEventListener('abort', abort, { once: true });
  }
  return { detach, signal: controller.signal };
}

export function createDrapedSurfaceGroup(
  o: DrapedSurfaceGroupOptions,
): DrapedSurfaceGroup {
  const { scene, source, surface: surfaceSpec, wave } = o;
  const { cells } = surfaceSpec;
  const lifetime = new AbortController();
  let edgeColor = o.edgeColor;
  let cellEdges = o.cellEdges;
  let surfaceOpacity = o.surfaceOpacity;
  let fadeOpacity = 1;
  let hidden = false;
  let shown = true;
  let destroyed = false;
  let firstTileDrawn = false;
  let preparing: Promise<void> | null = null;
  let prepareState: 'idle' | 'pending' | 'settled' | 'failed' = 'idle';
  let pendingFailure: { error: unknown } | null = null;
  /** The surface layer once prepared; null inside when it has nothing to draw. */
  let surface: { layer: HeldLayer | null } | null = null;
  let outline: OutlineState | null = null;
  /** Outlines of an earlier style, drawn until the current style's layer is ready. */
  let retiring: HeldLayer | null = null;

  const surfaceAlpha = (progress: number) =>
    hidden ? 0 : DRAPED_SURFACE_ALPHA * surfaceOpacity * fadeOpacity * progress;
  const outlineAlpha = (progress: number) =>
    hidden || !cellEdges || !cells.supported ? 0 : fadeOpacity * progress;

  const apply = () => {
    if (destroyed) return;
    const progress = wave.progress();
    surface?.layer?.draped.setAlpha(surfaceAlpha(progress));
    const edges = outlineAlpha(progress);
    if (retiring) {
      retiring.draped.setAlpha(edges);
      outline?.layer?.draped.setAlpha(0);
    } else outline?.layer?.draped.setAlpha(edges);
  };

  /** Retires the old outlines once the current style's are ready to take their place. */
  const settleOutlineSwap = () => {
    if (!retiring || !outline?.prepared) return;
    if (outline.layer && !outline.layer.draped.isReady()) {
      // The new layer requests frames until it is ready, then none: this frame asks for the
      // one after it, in which the swap is drawn.
      scene.requestRender();
      return;
    }
    retiring.destroy();
    retiring = null;
  };

  const removePreRender = scene.preRender.addEventListener(() => {
    settleOutlineSwap();
    apply();
  });

  /** A raster that failed: `prepare` rejects with it while it runs, `onError` hears it after. */
  const fail = (error: unknown) => {
    if (destroyed) return;
    if (prepareState === 'pending') pendingFailure ??= { error };
    else o.onError(error);
  };

  /** Prepares `spec` and adds its layer at alpha 0; null when the raster has nothing to draw. */
  const drape = async (
    spec: RasterSpec,
    name: AtlasImageryLayerName,
    signal: AbortSignal,
  ): Promise<HeldLayer | null> => {
    const provider = await AtlasRasterImageryProvider.fromSpec(
      source,
      spec,
      signal,
    );
    if (signal.aborted || destroyed) {
      provider.destroy();
      throw abortError();
    }
    if (provider.bounds === null) {
      provider.destroy();
      return null;
    }
    const removeError = provider.errorEvent.addEventListener(
      (error: unknown) => {
        if (!destroyed) o.onError(error);
      },
    );
    const removeTile =
      name === 'atlas-surface'
        ? provider.tileLoaded.addEventListener((message) => {
            if (message.bitmap !== null) firstTileDrawn = true;
          })
        : () => {};
    const draped = addDrapedImageryLayer({ alpha: 0, name, provider, scene });
    draped.setShown(shown);
    return {
      destroy() {
        removeError();
        removeTile();
        draped.destroy();
      },
      draped,
    };
  };

  /** The current style's outlines: the prepare in flight or done, else a new one. */
  const startOutlines = (): Promise<void> => {
    if (outline) return outline.done;
    const abort = new AbortController();
    const state: OutlineState = {
      abort,
      done: Promise.resolve(),
      layer: null,
      prepared: false,
    };
    outline = state;
    state.done = drape(
      outlineSpec(surfaceSpec, edgeColor),
      'atlas-outlines',
      abort.signal,
    ).then(
      (layer) => {
        if (destroyed || outline !== state) {
          layer?.destroy();
          return;
        }
        state.layer = layer;
        state.prepared = true;
        apply();
        if (retiring) scene.requestRender();
      },
      (error: unknown) => {
        if (destroyed || abort.signal.aborted) return;
        fail(error);
      },
    );
    return state.done;
  };

  /** `startOutlines` for `prepare`: settles with them, or drops them once `signal` aborts. */
  const outlinesUntil = (signal: AbortSignal): Promise<void> => {
    const done = startOutlines();
    const state = outline;
    return new Promise<void>((resolve) => {
      const stop = () => {
        if (state && outline === state && !state.prepared) dropOutlines(false);
        resolve();
      };
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      void done.then(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      });
    });
  };

  /** Drops the current style's outlines; with `keepDrawn`, its drawn layer retires instead. */
  const dropOutlines = (keepDrawn: boolean) => {
    const old = outline;
    outline = null;
    if (!old) return;
    old.abort.abort();
    if (!old.layer) return;
    if (keepDrawn && !retiring) retiring = old.layer;
    else old.layer.destroy();
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    prepareState = 'pending';
    const link = eitherSignal(signal, lifetime.signal);
    try {
      const layer = await drape(surfaceSpec, 'atlas-surface', link.signal);
      if (destroyed) {
        layer?.destroy();
        throw abortError();
      }
      surface = { layer };
      apply();
      if (cellEdges && cells.supported) await outlinesUntil(link.signal);
      if (destroyed || signal.aborted) throw abortError();
      if (pendingFailure) throw pendingFailure.error;
      prepareState = 'settled';
    } catch (error) {
      prepareState = 'failed';
      throw error;
    } finally {
      link.detach();
    }
  };

  const heldLayers = (): HeldLayer[] =>
    [surface?.layer, outline?.layer, retiring].filter(
      (layer): layer is HeldLayer => layer != null,
    );

  const isReady = () =>
    !destroyed &&
    surface !== null &&
    (surface.layer === null || surface.layer.draped.isReady());

  return {
    artifactKey: o.artifactKey,
    cells,
    collection: {
      get show() {
        return shown;
      },
      set show(value: boolean) {
        // Hidden, the layers lost their tiles: shown again, a drawn tile counts from here.
        if (value && !shown) firstTileDrawn = false;
        shown = value;
        for (const layer of heldLayers()) layer.draped.setShown(value);
      },
    },
    kind: 'draped',
    prepare(signal: AbortSignal): Promise<void> {
      if (destroyed) return Promise.reject(abortError());
      preparing ??= run(signal);
      return preparing;
    },
    isReady,
    readyCount: () => +isReady(),
    totalCount: () => 1,
    readyChunkCount: () => +firstTileDrawn,
    opacity: () => fadeOpacity,
    outlinesReady(): boolean {
      if (destroyed) return false;
      if (!cells.supported) return true;
      return (
        outline !== null &&
        outline.prepared &&
        (outline.layer === null || outline.layer.draped.isReady())
      );
    },
    setOpacity(opacity: number): void {
      fadeOpacity = opacity;
      apply();
    },
    setSurfaceOpacity(opacity: number): void {
      surfaceOpacity = opacity;
      apply();
    },
    setVisibility(surfaceShown: boolean, supportShown: boolean): void {
      hidden = !surfaceShown && !supportShown;
      apply();
    },
    async setCellEdges(visible: boolean): Promise<void> {
      if (destroyed) return;
      cellEdges = visible;
      apply();
      if (visible && cells.supported && prepareState !== 'idle')
        await startOutlines();
    },
    async setOutlineStyle(c: EdgeColorSpec): Promise<void> {
      if (destroyed || sameEdgeColor(c, edgeColor)) return;
      edgeColor = c;
      const live = cellEdges && cells.supported && prepareState !== 'idle';
      dropOutlines(live);
      if (!live) {
        retiring?.destroy();
        retiring = null;
      }
      apply();
      if (live) await startOutlines();
    },
    setEdgesHeld(): void {},
    setElevationFactor(): void {},
    setSceneMode: () => Promise.resolve(),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      lifetime.abort();
      removePreRender();
      for (const layer of heldLayers()) layer.destroy();
      outline?.abort.abort();
      surface = null;
      outline = null;
      retiring = null;
    },
  };
}
