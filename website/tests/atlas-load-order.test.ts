/** The post-reveal load order: borders, then the detail tier, then the starfield (spec 2026-10-07
 * §B.2, §B.6.9; #443). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOAD_STALL_MS,
  createLoadOrder,
  type LoadProgress,
} from '../src/atlas/load-order';
import { StaticAtlasDataProvider } from '../src/atlas/static-provider';

interface Held {
  /** Every call so far, in start order. */
  readonly log: string[];
  /** A task that records its start and settles only when the test says so. */
  task(name: string): (progress: LoadProgress) => Promise<void>;
  resolve(name: string): void;
  reject(name: string): void;
  progress(name: string): void;
}

function held(): Held {
  const log: string[] = [];
  const settle = new Map<
    string,
    { resolve(): void; reject(error: unknown): void; progress: LoadProgress }
  >();
  return {
    log,
    progress: (name) => settle.get(name)!.progress(),
    reject: (name) => settle.get(name)!.reject(new Error(`${name} failed`)),
    resolve: (name) => settle.get(name)!.resolve(),
    task: (name) => (progress) => {
      log.push(name);
      return new Promise<void>((resolve, reject) =>
        settle.set(name, { progress, reject, resolve }),
      );
    },
  };
}

/** Lets promise reactions run without moving fake time. */
const flush = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('post-reveal load order', () => {
  it('uses the provider’s request stall window by default', () => {
    expect(LOAD_STALL_MS).toBe(StaticAtlasDataProvider.defaultRequestStallMs);
  });

  it('refuses a stall window that is not a positive finite duration', () => {
    for (const stallMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => createLoadOrder(stallMs)).toThrow(/stall window/);
  });

  it('starts each step only when the one before it has settled', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    order.detail(steps.task('detail'));
    order.starfield(steps.task('starfield'));
    await flush();
    expect(steps.log).toEqual(['borders']);

    steps.resolve('borders');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);

    steps.resolve('detail');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail', 'starfield']);
  });

  it('starts the starfield after the borders when no detail step is queued', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    order.starfield(steps.task('starfield'));
    await flush();
    expect(steps.log).toEqual(['borders']);
    steps.resolve('borders');
    await flush();
    expect(steps.log).toEqual(['borders', 'starfield']);
  });

  it('lets a failed step release the next one', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    order.detail(steps.task('detail'));
    order.starfield(steps.task('starfield'));
    steps.reject('borders');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);
    steps.reject('detail');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail', 'starfield']);
  });

  it('treats a task that throws as a failed step', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(() => {
      throw new Error('the borders could not start');
    });
    order.detail(steps.task('detail'));
    expect(steps.log).toEqual(['detail']);
  });

  it('lets a step that returns no promise settle at once', () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    const log: string[] = [];
    order.borders(() => void log.push('borders'));
    order.detail(() => void log.push('detail'));
    order.starfield(steps.task('starfield'));
    expect(log).toEqual(['borders', 'detail']);
    expect(steps.log).toEqual(['starfield']);
  });

  it('releases the next step when a step stalls, and the stalled task keeps running', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    order.detail(steps.task('detail'));
    order.starfield(steps.task('starfield'));
    vi.advanceTimersByTime(999);
    await flush();
    expect(steps.log).toEqual(['borders']);
    vi.advanceTimersByTime(1);
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);

    // A late settlement of the stalled borders starts nothing twice.
    steps.resolve('borders');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(steps.log).toEqual(['borders', 'detail', 'starfield']);
    steps.resolve('detail');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail', 'starfield']);
  });

  it('counts a stall from the last progress report, not from the start', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    steps.resolve('borders');
    await flush();
    order.detail(steps.task('detail'));
    order.starfield(steps.task('starfield'));
    // A slow transfer that keeps sending data is not a stall.
    for (let chunk = 0; chunk < 5; chunk++) {
      vi.advanceTimersByTime(900);
      steps.progress('detail');
    }
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);
    vi.advanceTimersByTime(999);
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);
    vi.advanceTimersByTime(1);
    await flush();
    expect(steps.log).toEqual(['borders', 'detail', 'starfield']);
  });

  it('ignores progress after a step has settled', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    steps.resolve('borders');
    await flush();
    steps.progress('borders');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a later artifact’s detail step at once, because the borders have settled', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    order.detail(steps.task('detail a'));
    order.starfield(steps.task('starfield'));
    steps.resolve('borders');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail a']);

    // The user switches to B while A's detail tier is still loading: B starts in the same turn.
    order.detail(steps.task('detail b'));
    expect(steps.log).toEqual(['borders', 'detail a', 'detail b']);

    // The starfield waits for every detail step that has started.
    steps.resolve('detail a');
    await flush();
    expect(steps.log).not.toContain('starfield');
    steps.reject('detail b');
    await flush();
    expect(steps.log.at(-1)).toBe('starfield');

    order.detail(steps.task('detail c'));
    expect(steps.log.at(-1)).toBe('detail c');
  });

  it('drops a queued detail step that is cancelled before its turn', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    const cancelA = order.detail(steps.task('detail a'));
    order.detail(steps.task('detail b'));
    order.starfield(steps.task('starfield'));
    cancelA();
    steps.resolve('borders');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail b']);
    steps.resolve('detail b');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail b', 'starfield']);
  });

  it('cannot cancel a detail step that has started', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    const cancel = order.detail(steps.task('detail'));
    order.starfield(steps.task('starfield'));
    steps.resolve('borders');
    await flush();
    cancel();
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);
    steps.resolve('detail');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail', 'starfield']);
  });

  it('starts every detail step released by the borders before it considers the starfield', async () => {
    const order = createLoadOrder(1_000);
    const steps = held();
    order.borders(steps.task('borders'));
    // The first released step settles in the same turn; the second is still loading.
    order.detail(() => void steps.log.push('detail a'));
    order.detail(steps.task('detail b'));
    order.starfield(steps.task('starfield'));
    steps.resolve('borders');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail a', 'detail b']);
    steps.resolve('detail b');
    await flush();
    expect(steps.log.at(-1)).toBe('starfield');
  });

  it('runs the borders and the starfield once each', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    order.borders(steps.task('borders again'));
    order.starfield(steps.task('starfield'));
    order.starfield(steps.task('starfield again'));
    steps.resolve('borders');
    await flush();
    steps.resolve('starfield');
    await flush();
    expect(steps.log).toEqual(['borders', 'starfield']);
  });

  it('starts nothing more once destroyed mid-sequence, and leaves no timer behind', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    const cancel = order.detail(steps.task('detail'));
    order.starfield(steps.task('starfield'));
    expect(vi.getTimerCount()).toBe(1);

    order.destroy();
    expect(vi.getTimerCount()).toBe(0);
    steps.resolve('borders');
    await flush();
    vi.advanceTimersByTime(10_000);
    await flush();
    order.borders(steps.task('borders again'));
    order.detail(steps.task('detail again'));
    order.starfield(steps.task('starfield again'));
    cancel();
    order.destroy();
    expect(steps.log).toEqual(['borders']);
  });

  it('ignores a running detail step’s outcome once destroyed', async () => {
    const steps = held();
    const order = createLoadOrder(1_000);
    order.borders(steps.task('borders'));
    order.detail(steps.task('detail'));
    order.starfield(steps.task('starfield'));
    steps.resolve('borders');
    await flush();
    order.destroy();
    expect(vi.getTimerCount()).toBe(0);
    steps.resolve('detail');
    await flush();
    expect(steps.log).toEqual(['borders', 'detail']);
  });
});
