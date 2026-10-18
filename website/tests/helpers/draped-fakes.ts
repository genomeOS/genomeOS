/**
 * A fake draped runtime for the ScientificLayers tests (terrain draping design, "Per layer under
 * World Terrain" and "How existing features behave", #483). Every callable member is a `vi.fn`.
 * Each surface group it creates records its options and the opacities it is given, spies its
 * setters, and holds `prepare()` behind a `prepared` deferred; like the real group, an aborted
 * `prepare` rejects with an AbortError. `ready`, `empty` and `outlines` stand for the globe having
 * loaded its tiles, a raster with nothing to draw, and outlines ready.
 */

import { vi, type Mock, type Mocked } from 'vitest';

import type {
  DrapedRuntime,
  DrapedSurfaceGroup,
  DrapedSurfaceGroupOptions,
  RasterTileSource,
} from '../../src/atlas/scene/types';

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

export function fakeDrapedRuntime(): {
  runtime: Mocked<DrapedRuntime>;
  groups: FakeDrapedGroup[];
} {
  const groups: FakeDrapedGroup[] = [];
  const source: RasterTileSource = {
    prepare: vi.fn(),
    release: vi.fn(),
    tile: vi.fn(),
  };
  const runtime: Mocked<DrapedRuntime> = {
    addDrapedImageryLayer: vi.fn<DrapedRuntime['addDrapedImageryLayer']>(),
    createDrapedSurfaceGroup: vi.fn<DrapedRuntime['createDrapedSurfaceGroup']>(
      (options) => {
        const group = fakeDrapedGroup(options);
        groups.push(group);
        return group;
      },
    ),
    providerFromSpec: vi.fn<DrapedRuntime['providerFromSpec']>(),
    rasterSource: vi.fn<DrapedRuntime['rasterSource']>(() => source),
    stats: {
      read: vi.fn(),
      source: vi.fn((inner: RasterTileSource) => inner),
      watchLayer: vi.fn(() => () => {}),
    },
    version: 'atlas-draped-v1',
  };
  return { groups, runtime };
}
