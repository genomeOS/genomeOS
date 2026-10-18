import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AtlasWorkerClient,
  AtlasWorkerError,
  isArtifactValidationError,
  startAtlasWorker,
  type StepTiming,
} from '../src/atlas/worker/client';
import type { HandlerRegistry } from '../src/atlas/worker/dispatcher';
import { ATLAS_WORKER_HANDLERS } from '../src/atlas/worker/handlers';
import { SURFACE_SPEC } from './helpers/raster-specs';
import { flushTasks } from './helpers/scene-fakes';
import {
  goldenBytes,
  goldenCatalog,
  goldenSurfaceJson,
  onlyGrid,
  toBuffer,
} from './support/gosa-builder';
import { InProcessWorker } from './support/in-process-worker';

const catalog = goldenCatalog();
const { entry, gridSha256 } = onlyGrid(catalog);
const ref = catalog.artifacts[0];

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(worker = new InProcessWorker()) {
  return { client: new AtlasWorkerClient(worker.asWorker()), worker };
}

describe('AtlasWorkerClient', () => {
  it('transfers each tier to the worker and resolves the decoded columns', async () => {
    const { client: atlas } = client();
    const gridBuffer = toBuffer(goldenBytes(entry.url));
    const grid = await atlas.loadGrid(gridBuffer, { entry, gridSha256 });
    expect(gridBuffer.byteLength).toBe(0);
    expect(grid.n).toBe(entry.n_cells);
    const render = await atlas.loadRender(
      toBuffer(goldenBytes(ref.web.render.url)),
      ref,
    );
    const detail = await atlas.loadDetail(
      toBuffer(goldenBytes(ref.web.detail.url)),
      ref,
    );
    expect(render.post_mean.length).toBe(grid.n);
    expect(Array.from(detail.post_mean)).toEqual(
      goldenSurfaceJson(ref).cells.map(({ post_mean }) => post_mean),
    );
  });

  it('reports checksum failures as artifact validation errors', async () => {
    const { client: atlas } = client();
    await atlas.loadGrid(toBuffer(goldenBytes(entry.url)), {
      entry,
      gridSha256,
    });
    const flipped = goldenBytes(ref.web.render.url);
    flipped[0] ^= 0xff;
    const failure = atlas.loadRender(toBuffer(flipped), ref);
    await expect(failure).rejects.toBeInstanceOf(AtlasWorkerError);
    await expect(failure).rejects.toMatchObject({
      code: 'checksum',
      gosaCode: 'container_sha256',
    });
    expect(
      isArtifactValidationError(await failure.catch((error: unknown) => error)),
    ).toBe(true);
    expect(isArtifactValidationError(new Error('network'))).toBe(false);
  });

  it('refuses a detail tier whose render tier was never loaded', async () => {
    const { client: atlas } = client();
    await expect(
      atlas.loadDetail(toBuffer(goldenBytes(ref.web.detail.url)), ref),
    ).rejects.toThrow(`Load the ${ref.id} render tier before its detail tier`);
  });

  it('cancels a superseded request by id', async () => {
    const gate = Promise.withResolvers<void>();
    const worker = new InProcessWorker({
      ...ATLAS_WORKER_HANDLERS,
      'load-grid': async (_request, context) => {
        await gate.promise;
        context.signal.throwIfAborted();
      },
    });
    const { client: atlas } = client(worker);
    const controller = new AbortController();
    const request = atlas.loadGrid(
      toBuffer(goldenBytes(entry.url)),
      { entry, gridSha256 },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [load, cancel] = worker.received;
    expect(cancel).toEqual({ id: load.id, type: 'cancel' });
  });

  it('rejects an already-aborted request without posting it', async () => {
    const { client: atlas, worker } = client();
    const controller = new AbortController();
    controller.abort();
    await expect(
      atlas.loadGrid(
        toBuffer(goldenBytes(entry.url)),
        { entry, gridSha256 },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.received).toHaveLength(0);
  });

  it('converts worker step timings to the page clock and records measures', async () => {
    const { client: atlas } = client();
    const timings: StepTiming[] = [];
    const stop = atlas.onStepTiming((timing) => timings.push(timing));
    const before = performance.now();
    await atlas.loadGrid(toBuffer(goldenBytes(entry.url)), {
      entry,
      gridSha256,
    });
    stop();
    // The geometry handlers add a `topology` step after grid-ready; only the data steps are pinned here.
    const data = timings.filter(({ step }) => step !== 'topology');
    expect(data.map(({ step }) => step)).toEqual([
      'verify-grid',
      'decode-grid',
    ]);
    expect(
      data.every(
        ({ artifactKey, chunk }) => artifactKey === null && chunk === null,
      ),
    ).toBe(true);
    for (const timing of data) {
      expect(timing.start).toBeGreaterThanOrEqual(before - 1);
      expect(timing.end).toBeGreaterThanOrEqual(timing.start);
      expect(timing.end).toBeLessThanOrEqual(performance.now() + 1);
    }
    const measures = performance.getEntriesByName(
      'atlas:worker:decode-grid',
      'measure',
    );
    expect(measures.length).toBeGreaterThan(0);
    expect((measures.at(-1) as PerformanceMeasure).detail).toEqual({
      artifactKey: null,
      chunk: null,
      step: 'decode-grid',
    });
  });

  it('settles prepare, tile and release on their terminal raster responses', async () => {
    const handlers: HandlerRegistry = {
      ...ATLAS_WORKER_HANDLERS,
      'prepare-raster': (r, c) =>
        c.post({
          bounds: null,
          id: r.id,
          rasterId: r.id,
          type: 'raster-ready',
        }),
      'raster-tile': (r, c) =>
        c.post({
          bitmap: null,
          id: r.id,
          level: r.level,
          rasterId: r.rasterId,
          rasterMs: 0.5,
          type: 'tile-ready',
          x: r.x,
          y: r.y,
        }),
      'release-raster': (r, c) =>
        c.post({ id: r.id, rasterId: r.rasterId, type: 'raster-released' }),
    };
    const { client: atlas } = client(new InProcessWorker(handlers));
    const ready = await atlas.prepareRaster(SURFACE_SPEC);
    expect(ready).toEqual({ bounds: null, rasterId: expect.any(Number) });
    expect(
      await atlas.rasterTile({
        level: 3,
        rasterId: ready.rasterId,
        x: 9,
        y: 2,
      }),
    ).toMatchObject({
      bitmap: null,
      level: 3,
      rasterId: ready.rasterId,
      rasterMs: 0.5,
      x: 9,
      y: 2,
    });
    await expect(atlas.releaseRaster(ready.rasterId)).resolves.toBeUndefined();
  });

  it('releases the raster of a prepare aborted after the worker stored it', async () => {
    // The worker's answer crosses the abort and is dropped, so only the client can free it.
    const stored = new Set<number>();
    let answer = () => {};
    const handlers: HandlerRegistry = {
      ...ATLAS_WORKER_HANDLERS,
      'prepare-raster': (r, c) => {
        stored.add(r.id);
        answer = () =>
          c.post({
            bounds: null,
            id: r.id,
            rasterId: r.id,
            type: 'raster-ready',
          });
      },
      'release-raster': (r, c) => {
        stored.delete(r.rasterId);
        c.post({ id: r.id, rasterId: r.rasterId, type: 'raster-released' });
      },
    };
    const { client: atlas } = client(new InProcessWorker(handlers));
    const controller = new AbortController();
    const preparing = atlas.prepareRaster(SURFACE_SPEC, controller.signal);
    await flushTasks();
    expect(stored.size).toBe(1);
    controller.abort();
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    answer();
    await flushTasks();
    expect(stored.size).toBe(0);
  });

  it('releases nothing for a prepare aborted before it was sent, or after it settled', async () => {
    const worker = new InProcessWorker({
      ...ATLAS_WORKER_HANDLERS,
      'prepare-raster': (r, c) =>
        c.post({
          bounds: null,
          id: r.id,
          rasterId: r.id,
          type: 'raster-ready',
        }),
    });
    const { client: atlas } = client(worker);
    await expect(
      atlas.prepareRaster(SURFACE_SPEC, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    await atlas.prepareRaster(SURFACE_SPEC, controller.signal);
    controller.abort(); // the caller owns the raster now, and releases it itself
    await flushTasks();
    expect(worker.received.map(({ type }) => type)).toEqual(['prepare-raster']);
  });

  it('fails every pending request when the worker crashes', async () => {
    // The provider runs grid, render and context requests at once; a crash must end all of
    // them, or the ones left pending show "Loading" forever (RF5).
    const never = () => new Promise<void>(() => undefined);
    const worker = new InProcessWorker({
      ...ATLAS_WORKER_HANDLERS,
      'load-grid': never,
      'load-render': never,
      'parse-context': never,
    });
    const { client: atlas } = client(worker);
    const requests = [
      atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 }),
      atlas.loadRender(toBuffer(goldenBytes(ref.web.render.url)), ref),
      atlas.parseContext(new TextEncoder().encode('{}').buffer),
    ];
    const outcomes: (string | null)[] = requests.map(() => null);
    requests.forEach((request, index) =>
      request.catch((error: Error) => {
        outcomes[index] = error.message;
      }),
    );
    await Promise.resolve();
    expect(worker.received).toHaveLength(3);
    worker.crash('boom');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcomes).toEqual(
      requests.map(() => 'Atlas data worker failed: boom'),
    );
  });

  it('reports a crash once, to every listener, including one added afterwards', async () => {
    // A dead worker cannot recover in this document, so the explorer routes it to the reload
    // panel (final review spec-3; Cesium design §12).
    const worker = new InProcessWorker();
    const { client: atlas } = client(worker);
    const early = vi.fn();
    const removed = vi.fn();
    atlas.onCrash(early);
    atlas.onCrash(removed)();
    worker.crash('boom');
    worker.crash('again');
    expect(early).toHaveBeenCalledTimes(1);
    expect(early.mock.calls[0][0]).toMatchObject({
      message: 'Atlas data worker failed: boom',
    });
    expect(removed).not.toHaveBeenCalled();
    const late = vi.fn();
    atlas.onCrash(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('never reports a crash for a worker that could not start, whose requests fail instead', async () => {
    const atlas = AtlasWorkerClient.unavailable(new Error('blocked by CSP'));
    const crashed = vi.fn();
    atlas.onCrash(crashed);
    await expect(
      atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 }),
    ).rejects.toThrow('could not start: blocked by CSP');
    expect(crashed).not.toHaveBeenCalled();
  });

  it('fails a retry after a worker crash instead of posting it to the dead worker', async () => {
    const worker = new InProcessWorker({
      ...ATLAS_WORKER_HANDLERS,
      'load-grid': () => new Promise<void>(() => undefined),
    });
    const { client: atlas } = client(worker);
    const load = () =>
      atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 });
    const first = load();
    await Promise.resolve();
    worker.crash('boom');
    await expect(first).rejects.toThrow('Atlas data worker failed: boom');
    expect(worker.terminated).toBe(true);
    // RF5: "Retry data" must end in another failure, not an endless "Loading".
    await expect(load()).rejects.toThrow('Atlas data worker failed: boom');
    expect(worker.received).toHaveLength(1);
  });

  it('fails every request once the worker script failed to load', async () => {
    // A blocked (CSP `worker-src`) or unsupported module worker fires one bare `error` event
    // and never answers (RF5).
    const worker = new InProcessWorker({
      ...ATLAS_WORKER_HANDLERS,
      'load-grid': () => new Promise<void>(() => undefined),
    });
    const { client: atlas } = client(worker);
    worker.dispatchEvent(new Event('error'));
    await expect(
      atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 }),
    ).rejects.toThrow('Atlas data worker failed: unknown error');
    expect(worker.received).toHaveLength(0);
  });

  it('fails every request after terminate() without posting it', async () => {
    const { client: atlas, worker } = client();
    atlas.terminate();
    expect(worker.terminated).toBe(true);
    await expect(
      atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 }),
    ).rejects.toThrow('Atlas data worker terminated');
    expect(worker.received).toHaveLength(0);
  });

  it('keeps failing retries when the Worker cannot start', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('blocked by policy');
        }
      },
    );
    const atlas = startAtlasWorker();
    const load = () =>
      atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 });
    await expect(load()).rejects.toThrow(/could not start: blocked by policy/);
    await expect(load()).rejects.toThrow(/could not start: blocked by policy/);
  });

  it('yields a failing client when the Worker cannot start', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('blocked by policy');
        }
      },
    );
    const atlas = startAtlasWorker();
    await expect(
      atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 }),
    ).rejects.toThrow(/could not start: blocked by policy/);
  });
});
