/**
 * The hero film's choices, as pure functions (round 2 spec §4.1.1, §0.3 #17 and #19, §11.1; rulings
 * R2-1 and 21; #454): which rendition a screen takes, when the poster stays, how the poster's own
 * download decides on browsers without NetworkInformation, the scroll fade's fallback, and the
 * visitor's remembered Pause.
 */
import { describe, expect, it } from 'vitest';

import {
  HERO_MOTION_KEY,
  RECEDE_SPAN,
  SLOW_KBPS,
  pickRendition,
  posterReason,
  recedeAt,
  rememberPause,
  rememberedPause,
  throughputKbps,
} from '../src/components/home/hero-media';

describe('the rendition a screen takes', () => {
  const sources = [
    { src: '720.av1', type: 'av1', width: 1280 },
    { src: '720.hevc', type: 'hevc', width: 1280 },
    { src: '1080.av1', type: 'av1', width: 1920 },
    { src: '1080.hevc', type: 'hevc', width: 1920 },
  ];
  const pick = (width: number, dpr: number) =>
    pickRendition(sources, width, dpr).map((source) => source.src);

  it('takes the 720p film on phones and small laptops, 1080p on desktops, AV1 first', () => {
    expect(pick(320, 2)).toEqual(['720.av1', '720.hevc']);
    expect(pick(390, 3)).toEqual(['720.av1', '720.hevc']);
    expect(pick(430, 3)).toEqual(['720.av1', '720.hevc']);
    expect(pick(412, 2.625)).toEqual(['720.av1', '720.hevc']);
    expect(pick(640, 2)).toEqual(['720.av1', '720.hevc']);
    expect(pick(1280, 1)).toEqual(['720.av1', '720.hevc']);
    expect(pick(1366, 1)).toEqual(['1080.av1', '1080.hevc']);
    expect(pick(1440, 1)).toEqual(['1080.av1', '1080.hevc']);
    expect(pick(1440, 2)).toEqual(['1080.av1', '1080.hevc']);
    expect(pick(2560, 1)).toEqual(['1080.av1', '1080.hevc']);
    // A pixel ratio under 1 counts as 1; past 2 it counts as 2.
    expect(pick(1300, 0.5)).toEqual(['1080.av1', '1080.hevc']);
    expect(pick(700, 3)).toEqual(['1080.av1', '1080.hevc']);
    expect(pickRendition([], 1440, 1)).toEqual([]);
  });
});

describe('when the poster stays', () => {
  const allowed = { reducedMotion: false, networkInfo: true, playable: 2 };

  it('keeps the poster under reduced motion, Save-Data and slow connections', () => {
    expect(posterReason({ ...allowed, reducedMotion: true })).toBe(
      'reduced-motion',
    );
    expect(posterReason({ ...allowed, saveData: true })).toBe('save-data');
    for (const effectiveType of ['slow-2g', '2g', '3g'])
      expect(posterReason({ ...allowed, effectiveType })).toBe(
        'slow-connection',
      );
    expect(posterReason({ ...allowed, effectiveType: '4g' })).toBe(null);
    expect(posterReason(allowed)).toBe(null);
  });

  it('keeps the poster when no source can play', () => {
    expect(posterReason({ ...allowed, playable: 0 })).toBe('unsupported');
    // Reduced motion and Save-Data are named first: no source is even looked at.
    expect(posterReason({ ...allowed, reducedMotion: true, playable: 0 })).toBe(
      'reduced-motion',
    );
  });

  it('reads the poster’s own download where NetworkInformation is missing (Safari, Firefox)', () => {
    const noInfo = { ...allowed, networkInfo: false };
    expect(SLOW_KBPS).toBe(1500);
    expect(posterReason({ ...noInfo, throughputKbps: 900 })).toBe(
      'slow-connection',
    );
    expect(posterReason({ ...noInfo, throughputKbps: 1499 })).toBe(
      'slow-connection',
    );
    expect(posterReason({ ...noInfo, throughputKbps: 1500 })).toBe(null);
    expect(posterReason({ ...noInfo, throughputKbps: 40_000 })).toBe(null);
    // Unknown (a cached poster, no timing): never blocks the film.
    expect(posterReason({ ...noInfo, throughputKbps: null })).toBe(null);
    expect(posterReason(noInfo)).toBe(null);
    // Where NetworkInformation answers, it decides, not the poster.
    expect(posterReason({ ...allowed, throughputKbps: 900 })).toBe(null);
  });
});

describe('the poster’s throughput', () => {
  it('is its transferred bits over the time from request to response end, in kbit/s', () => {
    // 100,000 bytes in 600 ms: 1,333 kbit/s.
    expect(
      throughputKbps({
        transferSize: 100_000,
        startTime: 40,
        requestStart: 100,
        responseEnd: 700,
      }),
    ).toBeCloseTo(1333.3, 1);
    // Without a request start (a cross-origin entry without Timing-Allow-Origin), from the
    // entry's start.
    expect(
      throughputKbps({
        transferSize: 100_000,
        startTime: 50,
        requestStart: 0,
        responseEnd: 300,
      }),
    ).toBeCloseTo(3200, 6);
  });

  it('is unknown for a cached poster or an entry without timing, so it never blocks', () => {
    expect(
      throughputKbps({
        transferSize: 0,
        startTime: 10,
        requestStart: 20,
        responseEnd: 9000,
      }),
    ).toBeNull();
    expect(throughputKbps({ startTime: 10, responseEnd: 9000 })).toBeNull();
    expect(
      throughputKbps({ transferSize: 5000, startTime: 10, responseEnd: 10 }),
    ).toBeNull();
    expect(throughputKbps(undefined)).toBeNull();
    expect(throughputKbps(null)).toBeNull();
  });
});

describe('the visitor’s remembered Pause', () => {
  const memory = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
  };

  it('is stored under genomeos:hero-motion as “paused”, and forgotten on Play', () => {
    expect(HERO_MOTION_KEY).toBe('genomeos:hero-motion');
    const storage = memory();
    expect(rememberedPause(storage)).toBe(false);
    rememberPause(storage, true);
    expect(storage.items.get('genomeos:hero-motion')).toBe('paused');
    expect(rememberedPause(storage)).toBe(true);
    rememberPause(storage, false);
    expect(storage.items.has('genomeos:hero-motion')).toBe(false);
    expect(rememberedPause(storage)).toBe(false);
    storage.items.set('genomeos:hero-motion', 'playing');
    expect(rememberedPause(storage)).toBe(false);
  });

  it('never throws: blocked or missing storage reads as “not paused” and writes nothing', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    expect(rememberedPause(blocked)).toBe(false);
    expect(() => rememberPause(blocked, true)).not.toThrow();
    expect(() => rememberPause(blocked, false)).not.toThrow();
    expect(rememberedPause(null)).toBe(false);
    expect(rememberedPause(undefined)).toBe(false);
    expect(() => rememberPause(null, true)).not.toThrow();
  });
});

describe('the scroll fade’s fallback', () => {
  it('recedes from the hero’s top to three quarters of its height', () => {
    expect(RECEDE_SPAN).toBe(0.75);
    expect(recedeAt(0, 100, 800)).toBe(0);
    expect(recedeAt(100, 100, 800)).toBe(0);
    expect(recedeAt(400, 100, 800)).toBeCloseTo(0.5, 6);
    expect(recedeAt(700, 100, 800)).toBe(1);
    expect(recedeAt(5000, 100, 800)).toBe(1);
    expect(recedeAt(500, 100, 0)).toBe(0);
  });
});
