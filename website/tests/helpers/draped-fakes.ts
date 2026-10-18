/**
 * A fake draped runtime for the ScientificLayers tests (terrain draping design, "Per layer under
 * World Terrain" and "How existing features behave", #483). Every callable member is a `vi.fn`.
 * Each surface group it creates records its options and the opacities it is given, spies its
 * setters, and holds `prepare()` behind a `prepared` deferred; like the real group, an aborted
 * `prepare` rejects with an AbortError. `ready`, `empty` and `outlines` stand for the globe having
 * loaded its tiles, a raster with nothing to draw, and outlines ready.
 *
 * For the borders and footprints (terrain draping design, "Per layer under World Terrain" and
 * "Failure modes"), `providerFromSpec` records a fake provider per spec in `providers`, and
 * `addDrapedImageryLayer` a fake layer per call in `layers`. A layer's `ready` stands for the globe
 * having loaded its tiles with it in place (or the 3 s cap), and destroying it destroys its
 * provider once, as the real layer does.
 */

import type { ImageryLayer } from 'cesium';
import { vi, type Mock, type Mocked } from 'vitest';

import type {
  AtlasImageryLayerName,
  RasterSpec,
} from '../../src/atlas/geometry/raster/types';
import type {
  DrapedImageryLayer,
  DrapedRuntime,
  DrapedSurfaceGroup,
  DrapedSurfaceGroupOptions,
  RasterImageryProvider,
  RasterTileSource,
} from '../../src/atlas/scene/types';
import type { RasterTileMessage } from '../../src/atlas/worker/protocol';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

type Spy<K extends keyof DrapedSurfaceGroup> = Mock<
  Extract<DrapedSurfaceGroup[K], (...args: never[]) => unknown>
>;

export interface FakeDrapedGroup extends DrapedSurfaceGroup {
  readonly options: DrapedSurfaceGroupOptions;
  /** Every `setOpacity` value, in order. */
  readonly opacities: number[];
  /** Settles `prepare()`. */
  readonly prepared: Deferred<void>;
  /** `isReady()`: the globe has loaded the group's tiles. */
  ready: boolean;
  /** The raster has nothing to draw: no layer and no drawn tile. */
  empty: boolean;
  /** `outlinesReady()`. */
  outlines: boolean;
  readonly destroy: Spy<'destroy'>;
  readonly prepare: Spy<'prepare'>;
  readonly setCellEdges: Spy<'setCellEdges'>;
  readonly setEdgesHeld: Spy<'setEdgesHeld'>;
  readonly setElevationFactor: Spy<'setElevationFactor'>;
  readonly setOpacity: Spy<'setOpacity'>;
  readonly setOutlineStyle: Spy<'setOutlineStyle'>;
  readonly setSceneMode: Spy<'setSceneMode'>;
  readonly setSurfaceOpacity: Spy<'setSurfaceOpacity'>;
  readonly setVisibility: Spy<'setVisibility'>;
}

function fakeDrapedGroup(options: DrapedSurfaceGroupOptions): FakeDrapedGroup {
  let opacity = 1;
  const prepared = deferred<void>();
  const group: FakeDrapedGroup = {
    artifactKey: options.artifactKey,
    cells: options.surface.cells,
    collection: { show: true },
    destroy: vi.fn<DrapedSurfaceGroup['destroy']>(),
    empty: false,
    isReady: () => group.ready,
    kind: 'draped',
    opacities: [],
    opacity: () => opacity,
    options,
    outlines: false,
    outlinesReady: () => group.outlines,
    prepare: vi.fn<DrapedSurfaceGroup['prepare']>(
      (signal) =>
        new Promise<void>((resolve, reject) => {
          const abort = () =>
            reject(new DOMException('cancelled', 'AbortError'));
          if (signal.aborted) abort();
          signal.addEventListener('abort', abort, { once: true });
          prepared.promise.then(resolve, reject);
        }),
    ),
    prepared,
    readyChunkCount: () => (group.ready && !group.empty ? 1 : 0),
    readyCount: () => +group.isReady(),
    ready: false,
    setCellEdges: vi.fn<DrapedSurfaceGroup['setCellEdges']>(async () => {}),
    setEdgesHeld: vi.fn<DrapedSurfaceGroup['setEdgesHeld']>(),
    setElevationFactor: vi.fn<DrapedSurfaceGroup['setElevationFactor']>(),
    setOpacity: vi.fn<DrapedSurfaceGroup['setOpacity']>((value) => {
      opacity = value;
      group.opacities.push(value);
    }),
    setOutlineStyle: vi.fn<DrapedSurfaceGroup['setOutlineStyle']>(
      async () => {},
    ),
    setSceneMode: vi.fn<DrapedSurfaceGroup['setSceneMode']>(async () => {}),
    setSurfaceOpacity: vi.fn<DrapedSurfaceGroup['setSurfaceOpacity']>(),
    setVisibility: vi.fn<DrapedSurfaceGroup['setVisibility']>(),
    totalCount: () => 1,
  };
  return group;
}

/** A Cesium Event raised with one argument; `listeners` are the subscribed callbacks. */
export class ArgEvent<T> {
  readonly listeners = new Set<(arg: T) => void>();

  addEventListener(listener: (arg: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  removeEventListener(listener: (arg: T) => void): boolean {
    return this.listeners.delete(listener);
  }

  raiseEvent(arg: T): void {
    for (const listener of [...this.listeners]) listener(arg);
  }

  get numberOfListeners(): number {
    return this.listeners.size;
  }
}

/** A worker-backed provider as `providerFromSpec` resolves it; `spec` is what it was built for. */
export interface FakeRasterProvider {
  readonly spec: RasterSpec | undefined;
  readonly bounds: null;
  readonly errorEvent: ArgEvent<unknown>;
  readonly tileLoaded: ArgEvent<RasterTileMessage>;
  readonly destroy: Mock<() => void>;
  isDestroyed(): boolean;
}

export function fakeRasterProvider(spec?: RasterSpec): FakeRasterProvider {
  let destroyed = false;
  return {
    bounds: null,
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    errorEvent: new ArgEvent<unknown>(),
    isDestroyed: () => destroyed,
    spec,
    tileLoaded: new ArgEvent<RasterTileMessage>(),
  };
}

/** One `addDrapedImageryLayer` call: its options, and the alpha and shown state it is given. */
export interface FakeDrapedLayer extends DrapedImageryLayer {
  readonly name: AtlasImageryLayerName;
  readonly provider: FakeRasterProvider;
  alpha: number;
  shown: boolean;
  /** `isReady()`: the globe has loaded the layer's tiles, or 3 s have passed. */
  ready: boolean;
  readonly destroy: Mock<DrapedImageryLayer['destroy']>;
  readonly setAlpha: Mock<DrapedImageryLayer['setAlpha']>;
  readonly setShown: Mock<DrapedImageryLayer['setShown']>;
}

export function fakeDrapedRuntime(): {
  runtime: Mocked<DrapedRuntime>;
  groups: FakeDrapedGroup[];
  layers: FakeDrapedLayer[];
  providers: FakeRasterProvider[];
} {
  const groups: FakeDrapedGroup[] = [];
  const layers: FakeDrapedLayer[] = [];
  const providers: FakeRasterProvider[] = [];
  const source: RasterTileSource = {
    prepare: vi.fn(),
    release: vi.fn(),
    tile: vi.fn(),
  };
  const runtime: Mocked<DrapedRuntime> = {
    addDrapedImageryLayer: vi.fn<DrapedRuntime['addDrapedImageryLayer']>(
      ({ alpha, name, provider }) => {
        const owned = provider as unknown as FakeRasterProvider;
        let destroyed = false;
        const layer: FakeDrapedLayer = {
          alpha,
          destroy: vi.fn(() => {
            if (destroyed) return;
            destroyed = true;
            owned.destroy();
          }),
          isReady: () => layer.ready,
          layer: {} as ImageryLayer,
          name,
          provider: owned,
          ready: false,
          setAlpha: vi.fn((value: number) => {
            layer.alpha = value;
          }),
          setShown: vi.fn((value: boolean) => {
            layer.shown = value;
          }),
          shown: true,
        };
        layers.push(layer);
        return layer;
      },
    ),
    createDrapedSurfaceGroup: vi.fn<DrapedRuntime['createDrapedSurfaceGroup']>(
      (options) => {
        const group = fakeDrapedGroup(options);
        groups.push(group);
        return group;
      },
    ),
    providerFromSpec: vi.fn<DrapedRuntime['providerFromSpec']>(
      async (_source, spec) => {
        const provider = fakeRasterProvider(spec);
        providers.push(provider);
        return provider as unknown as RasterImageryProvider;
      },
    ),
    rasterSource: vi.fn<DrapedRuntime['rasterSource']>(() => source),
    stats: {
      read: vi.fn(),
      source: vi.fn((inner: RasterTileSource) => inner),
      watchLayer: vi.fn(() => () => {}),
    },
    version: 'atlas-draped-v1',
  };
  return { groups, layers, providers, runtime };
}
