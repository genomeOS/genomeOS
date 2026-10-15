/**
 * The scene timeline's pure parts (round 2 spec §3.2, §11.1; R2-7): the planner that turns tracks
 * into Web Animations (delays, iterations, fills, composite order), the idle-chunk split of track
 * creation, and the typing cadence. The browser behaviour (seek, offscreen pause, reduced motion)
 * is tests/kit.spec.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  CHUNK_TRACKS,
  EASE,
  chunkTracks,
  planTracks,
  toKeyframes,
  type TrackRequest,
} from '../src/graphics/timeline';
import { splitTyped, typeFrames, TYPE_CPS } from '../src/graphics/typing';

const el = (name: string) => ({ name }) as unknown as Element;

describe('keyframes', () => {
  it('turns ms frames into offsets over the track, holding the first and last values', () => {
    expect(
      toKeyframes(
        [
          [500, 'translateY(-4px)', EASE.out],
          [1500, 'translateY(0px)'],
        ],
        2000,
      ),
    ).toEqual([
      { offset: 0, easing: 'linear', transform: 'translateY(-4px)' },
      { offset: 0.25, easing: EASE.out, transform: 'translateY(-4px)' },
      { offset: 0.75, easing: 'linear', transform: 'translateY(0px)' },
      { offset: 1, easing: 'linear', transform: 'translateY(0px)' },
    ]);
  });

  it('uses an object as the keyframe, and sorts frames by time', () => {
    expect(
      toKeyframes(
        [
          [1000, { opacity: 1 }],
          [0, { opacity: 0 }, EASE.step],
        ],
        1000,
      ),
    ).toEqual([
      { offset: 0, easing: EASE.step, opacity: 0 },
      { offset: 1, easing: 'linear', opacity: 1 },
    ]);
  });
});

describe('the planner', () => {
  const requests: TrackRequest[] = [
    { phase: 'loop', el: el('a'), frames: [[0, { opacity: 1 }]] },
    { phase: 'story', el: el('a'), frames: [[0, { opacity: 0 }]] },
    {
      phase: 'ambient',
      el: el('b'),
      frames: [[0, 'rotate(0deg)']],
      period: 16000,
    },
    {
      phase: 'story',
      el: el('c'),
      frames: [[0, { opacity: 0 }]],
      composite: 'add',
    },
    {
      phase: 'loop',
      el: el('d'),
      frames: [[0, { opacity: 1 }]],
      period: 24000,
    },
  ];
  const plan = planTracks(requests, { story: 32000, loop: 8000 });

  it('creates story tracks, then ambient, then loop, so a loop composites above its story', () => {
    expect(plan.map((track) => track.phase)).toEqual([
      'story',
      'story',
      'ambient',
      'loop',
      'loop',
    ]);
    // Within a phase, tracks keep the order the scene authored them in.
    expect(
      plan.map((track) => (track.el as unknown as { name: string }).name),
    ).toEqual(['a', 'c', 'b', 'a', 'd']);
  });

  it('plays a story once over its length and holds its end', () => {
    const [story] = plan;
    expect(story.options).toEqual({
      duration: 32000,
      iterations: 1,
      fill: 'both',
    });
    expect(plan[1].options.composite).toBe('add');
  });

  it('starts every loop exactly at the story’s end and fills nothing before it', () => {
    for (const track of plan.filter((item) => item.phase === 'loop')) {
      expect(track.options.delay).toBe(32000);
      expect(track.options.iterations).toBe(Infinity);
      expect(track.options.fill).toBe('none');
    }
    expect(plan[3].options.duration).toBe(8000);
    expect(plan[4].options.duration).toBe(24000);
  });

  it('runs ambient tracks from 0, forever', () => {
    expect(plan[2].options).toEqual({
      duration: 16000,
      iterations: Infinity,
      fill: 'both',
    });
  });

  it('refuses loop and ambient periods that are not whole multiples of the loop', () => {
    expect(() =>
      planTracks(
        [
          {
            phase: 'ambient',
            el: el('x'),
            frames: [[0, 'none']],
            period: 12000,
          },
        ],
        { story: 32000, loop: 8000 },
      ),
    ).toThrow(/multiple of the 8000 ms loop/);
    expect(() =>
      planTracks(
        [{ phase: 'loop', el: el('x'), frames: [[0, 'none']], period: 3000 }],
        { story: 32000, loop: 8000 },
      ),
    ).toThrow(/multiple of the 8000 ms loop/);
  });

  it('treats a story without a loop as its own loop length', () => {
    const [track] = planTracks(
      [{ phase: 'loop', el: el('x'), frames: [[0, 'none']] }],
      { story: 4000 },
    );
    expect(track.options.duration).toBe(4000);
    expect(track.options.delay).toBe(4000);
  });
});

describe('idle chunks', () => {
  const many = (phase: TrackRequest['phase'], count: number) =>
    Array.from({ length: count }, (_, index): TrackRequest => ({
      phase,
      el: el(`${phase}${index}`),
      frames: [[0, { opacity: 1 }]],
    }));

  it('creates tracks in chunks of at most CHUNK_TRACKS, one phase per chunk, in order', () => {
    const plan = planTracks(
      [...many('loop', 150), ...many('story', 250), ...many('ambient', 9)],
      { story: 32000, loop: 8000 },
    );
    const chunks = chunkTracks(plan);
    expect(chunks.flat()).toEqual(plan);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_TRACKS);
      expect(new Set(chunk.map((track) => track.phase)).size).toBe(1);
    }
    expect(chunks.map((chunk) => chunk[0].phase)).toEqual([
      'story',
      'story',
      'story',
      'ambient',
      'loop',
      'loop',
    ]);
  });
});

describe('typing', () => {
  const at = (frames: ReturnType<typeof typeFrames>, n: number) =>
    frames.find(([, value]) => (value as { '--n': number })['--n'] === n)![0];

  it(`types ${TYPE_CPS} characters a second`, () => {
    expect(TYPE_CPS).toBe(62);
    const frames = typeFrames('abcdef', { start: 1000 });
    expect(frames[0]).toEqual([1000, { '--n': 0 }]);
    expect(at(frames, 6)).toBeCloseTo(1000 + (6 * 1000) / 62, 6);
  });

  it('pauses 240 ms after a full stop, semicolon or colon, and 110 ms after a comma', () => {
    const per = 1000 / 62;
    for (const mark of ['.', ';', ':']) {
      const frames = typeFrames(`ab${mark} cd`, { start: 0 });
      const end = frames[frames.length - 3][0];
      expect(end, mark).toBeCloseTo(6 * per + 240, 6);
    }
    const comma = typeFrames('ab, cd', { start: 0 });
    expect(comma[comma.length - 3][0]).toBeCloseTo(6 * per + 110, 6);
  });

  it('holds the caret, then hides it, at the end', () => {
    const frames = typeFrames('ab', { start: 0, hold: 500 });
    const [typed, held, gone] = frames.slice(-3);
    expect(held[0] - typed[0]).toBe(500);
    expect(gone[1]).toEqual({ '--n': 3 });
    expect(gone[0] - held[0]).toBe(1);
  });

  it('keeps the whole sentence as text for assistive tech, and the twin out of it', () => {
    const { sr, twin } = splitTyped('Hi & bye.');
    expect(sr).toBe('<span class="visually-hidden">Hi &amp; bye.</span>');
    expect(twin.startsWith('<span class="typed" aria-hidden="true">')).toBe(
      true,
    );
    expect(twin.match(/<span style="--i:\d+">/g)).toHaveLength(9);
    expect(twin).toContain('<span style="--i:3">&amp;</span>');
  });

  it('can set a lead-in in bold', () => {
    const { twin } = splitTyped('For example: x', { lead: 12 });
    expect(twin.match(/class="b"/g)).toHaveLength(12);
  });
});
