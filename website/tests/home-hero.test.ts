/**
 * Home's hero film and Atlas preview, read from the built page, plus the pure logic of their
 * islands: the film's choices, the preview's timeline and rotation (site redesign spec §4.1, §9.1;
 * round 2 rulings R2-1, R2-2, R2-14; #454). Owned by the hero and toy-globe task (round 2 plan T1);
 * split verbatim out of home.test.ts (plan T0 step 3).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AutoSpin,
  ENTRANCE_MS,
  REST_VIEW,
  SPIN_DEG_PER_S,
  SPIN_DWELL_MS,
  SPIN_IDLE_MS,
  STUD_REFERENCE_RADIUS,
  TURN_DEG,
  entranceAt,
  formatKm,
  formatRange,
  formatShare,
  layerFader,
  previewStudScale,
  type SpinClock,
  type SpinState,
} from '../src/components/home/atlas-preview';
import {
  RECEDE_SPAN,
  pickRendition,
  posterReason,
  recedeAt,
} from '../src/components/home/hero-media';
import provenance from '../src/data/figures/hbs.provenance.json';

const homepage = path.resolve(import.meta.dirname, '../dist/index.html');
const html = existsSync(homepage) ? readFileSync(homepage, 'utf8') : '';
const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const body = html.slice(html.indexOf('<body'));

/** The opening tag and contents of the element whose opening tag matches `open`. */
function section(pattern: RegExp): string {
  const start = main.search(pattern);
  if (start === -1) return '';
  const end = main.indexOf('</section>', start);
  return main.slice(start, end);
}

describe('homepage figures', () => {
  it('draws the Atlas preview from the pinned HbS data, with its note and provenance', () => {
    const atlas = section(/<section\b[^>]*\bid="atlas"/);
    expect(atlas).toMatch(/data-graphic="atlas-preview"/);
    // Ruling R2-14: no scare label. A plain note says what this is, beside the way to the Atlas.
    expect(atlas).not.toContain('Not yet validated');
    expect(atlas).not.toContain('data-status="not-validated"');
    const words = atlas.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    expect(words).toContain('A simplified preview with sample data.');
    expect(atlas).toMatch(
      /<a class="atlas-open" href="\/app\/">[\s\S]*Open the <span class="brand-name">genomeOS<\/span> Atlas/,
    );
    // One two-option toggle; no Evidence layer, steps or readout (ruling R2-2).
    for (const layer of ['measured', 'modeled'])
      expect(atlas).toMatch(new RegExp(`data-value="${layer}"`));
    expect(atlas).not.toContain('data-value="evidence"');
    expect(atlas).not.toContain('data-legend="evidence"');
    expect(atlas).not.toMatch(/hg-step|data-readout|hg-reset/);
    expect(atlas).not.toMatch(/Uncertainty<\/button>/);
    // A Pause control for the rotation (WCAG 2.2.2), hidden until the globe can turn.
    expect(atlas).toMatch(
      /<button[^>]*class="hg-spin"[^>]*data-spin-toggle[^>]*hidden/,
    );
    // Callout 1 is a real survey, in people tested (AN / 2), never alleles.
    const [survey, modeled] = provenance.callouts;
    expect(survey.people).toBe(survey.an! / 2);
    expect(words).toContain(
      `Measured: ${survey.people!.toLocaleString('en-US')} people tested`,
    );
    expect(words).not.toMatch(/\balleles\b/);
    expect(words).toContain(
      `Modeled: about ${formatShare(modeled.mean!)} (95%: ${formatRange(modeled.lo!, modeled.hi!)})`,
    );
    expect(words).toContain('No estimate: no survey in range');
    // Provenance and the same view in the Atlas.
    const revision = provenance.hf_revision.slice(0, 7);
    expect(atlas).toMatch(
      new RegExp(
        `HbS \\(rs334\\) · model v3 · data map-2026-08 · revision ${revision} · coarsened for display`,
      ),
    );
    expect(atlas).toContain('href="/app/?entity=hbs-rs334&amp;palette=genome"');
    // Below the hero, the no-JS poster loads lazily: the film's poster is the LCP now.
    expect(atlas).toMatch(
      /<img\b[^>]*class="hg-poster"[^>]*\bwidth="640"[^>]*\bheight="640"/,
    );
    expect(atlas).toMatch(/<img\b[^>]*class="hg-poster"[^>]*loading="lazy"/);
    expect(atlas).not.toMatch(/class="hg-poster"[^>]*fetchpriority/);
    // The data-derived alt text.
    expect(atlas).toContain(provenance.alt);
    // Studs in three sizes in the legend.
    for (const size of ['sm', 'md', 'lg'])
      expect(atlas).toContain(`#glyph-stud-${size}`);
  });

  it('lists the Atlas preview data as a table', () => {
    const atlas = section(/<section\b[^>]*\bid="atlas"/);
    expect(atlas).toMatch(/<summary>View as table<\/summary>/);
    for (const area of provenance.table.top_areas)
      expect(atlas).toContain(formatRange(area.lo, area.hi));
    expect(atlas).toContain(provenance.counts.surveys.toLocaleString('en-US'));
  });

  it('draws the hero film: a poster first, then a deferred, muted loop', () => {
    const hero = section(/<section\b[^>]*\bid="hero"/);
    // The poster is the LCP: AVIF and WebP srcsets, explicit dimensions, high priority, never lazy.
    const picture = hero.match(/<picture>[\s\S]*?<\/picture>/)![0];
    expect(picture).toMatch(
      /<source type="image\/avif" srcset="[^"]*hero-poster[^"]*\.avif 640w[^"]*2560w" sizes="100vw"/,
    );
    expect(picture).toMatch(
      /<source type="image\/webp" srcset="[^"]*\.webp 640w/,
    );
    // A portrait screen crops the frame's middle: its poster is as wide as the film it will play
    // (720p up to 640 px, 1080p wider), never an upscaled one the film's first frame would outsize.
    for (const [media, width] of [
      ['(orientation: portrait) and (max-width: 40em)', 1280],
      ['(orientation: portrait)', 1920],
    ] as const) {
      const source = picture.match(
        new RegExp(
          `<source type="image/avif" media="${media.replace(/[()]/g, '\\$&')}" srcset="([^"]+)">`,
        ),
      );
      expect(source?.[1], media).toMatch(/hero-poster[^ ,]*\.avif$/);
      expect(picture, media).toContain(`${source![1]} ${width}w`);
    }
    const img = picture.match(/<img\b[^>]*>/)![0];
    expect(img).toContain('class="hero-media__poster"');
    expect(img).toMatch(/\bwidth="2560"/);
    expect(img).toMatch(/\bheight="1440"/);
    expect(img).toContain('fetchpriority="high"');
    expect(img).toContain('loading="eager"');
    expect(img).toContain('alt=""');
    // The film: decorative, muted, looping, inline, nothing fetched until the island says so.
    const video = hero.match(/<video\b[^>]*>/)![0];
    for (const attribute of ['muted', 'loop', 'playsinline'])
      expect(video).toMatch(new RegExp(`\\b${attribute}\\b`));
    expect(video).toContain('preload="none"');
    expect(video).not.toMatch(/\bautoplay\b|\bsrc=/);
    expect(hero).not.toMatch(/<source\b[^>]*\.mp4/);
    expect(hero).toMatch(
      /<div class="hero-media__backdrop" data-hero-backdrop aria-hidden="true">/,
    );
    // Within each width, AV1 first, then HEVC (hvc1), with the encodes' own codec strings.
    const sources = JSON.parse(
      video.match(/data-sources="([^"]+)"/)![1].replace(/&quot;/g, '"'),
    ) as { src: string; type: string; width: number }[];
    expect(sources.map((source) => [source.width, source.type])).toEqual([
      [1280, 'video/mp4; codecs="av01.0.05M.10"'],
      [1280, 'video/mp4; codecs="hvc1.1.6.L93.90"'],
      [1920, 'video/mp4; codecs="av01.0.08M.10"'],
      [1920, 'video/mp4; codecs="hvc1.1.6.L120.90"'],
    ]);
    // Only the AV1 and HEVC 720p and 1080p encodes are shipped, and the 1080p AV1 is ≤ 4 MB.
    for (const { src } of sources) {
      const file = path.resolve(import.meta.dirname, '../dist', src.slice(1));
      expect(existsSync(file), src).toBe(true);
    }
    const av1 = statSync(
      path.resolve(import.meta.dirname, '../dist/media/hero/hero-1080.av1.mp4'),
    ).size;
    expect(av1).toBeLessThanOrEqual(4 * 1024 * 1024);
    // The Pause control follows the text, so the calls to action are reached first.
    expect(hero.indexOf('data-video-toggle')).toBeGreaterThan(
      hero.indexOf('home-hero__actions'),
    );
  });

  it('loads no decorative raster but the hero film’s poster; the banner stays in the social meta', () => {
    expect(body).not.toContain('genomeos-banner.png');
    expect(html).toMatch(/og:image" content="[^"]*genomeos-banner\.png"/);
    const rasters = [
      ...main.matchAll(/[\w./-]+\.(?:webp|png|avif|jpe?g)\b/g),
    ].map(([url]) => url);
    expect(rasters.length).toBeGreaterThan(0);
    for (const url of rasters) expect(url).toMatch(/\/_astro\/hero-poster\./);
  });

  it('keeps the modeled range on one line in its callout', () => {
    const modeled = provenance.callouts.find(
      (callout) => callout.kind === 'modeled',
    )!;
    const range = `(95%: ${formatRange(modeled.lo!, modeled.hi!)})`;
    const atlas = section(/<section\b[^>]*\bid="atlas"/);
    expect(
      atlas.split(`<span class="hg-nowrap">${range}</span>`).length - 1,
    ).toBe(1);
  });

  it('orders the hero as it reads: heading, lede, calls to action, then the film’s control', () => {
    // WCAG 2.4.3: the DOM order is the focus order, so the calls to action precede the film's
    // Pause control, and the Atlas preview's controls come after the hero.
    const hero = section(/<section\b[^>]*\bid="hero"/);
    const at = (needle: string) => hero.indexOf(needle);
    expect(at('<h1')).toBeGreaterThan(-1);
    expect(at('home-hero__lede')).toBeGreaterThan(at('<h1'));
    expect(at('home-hero__actions')).toBeGreaterThan(at('home-hero__lede'));
    expect(at('data-video-toggle')).toBeGreaterThan(at('home-hero__actions'));
    expect(main.indexOf('data-graphic="atlas-preview"')).toBeGreaterThan(
      main.indexOf('id="hero"'),
    );
    // The globe is below the hero now: no pre-paint arming script is left in the head.
    expect(html.slice(0, html.indexOf('</head>'))).not.toContain(
      'data-arm-hero',
    );
  });
});

describe('Atlas preview logic', () => {
  it('shrinks the studs with a smaller disc, never below 0.6 of full size', () => {
    // A 390 px phone's disc (radius about 172 px) is a quarter smaller than the 1440 px one, and
    // its studs shrink with it, so they stop merging into blobs (design review, round 1).
    expect(previewStudScale(STUD_REFERENCE_RADIUS)).toBe(1);
    expect(previewStudScale(260)).toBe(1);
    expect(previewStudScale(172)).toBeCloseTo(0.76, 2);
    expect(previewStudScale(100)).toBe(0.6);
  });

  it('plays in evidence order over 2.8 s and turns 20° to rest, the way the Earth turns', () => {
    expect(ENTRANCE_MS).toBe(2800);
    expect(REST_VIEW).toEqual([18, 8]);
    const start = entranceAt(0);
    expect(start.reveal).toEqual({ land: 0, studs: 0, surface: 0, hatch: 0 });
    expect(start.view[0]).toBeCloseTo(REST_VIEW[0] + TURN_DEG, 6);
    expect(entranceAt(300).reveal.land).toBe(1);
    expect(entranceAt(300).reveal.studs).toBe(0);
    expect(entranceAt(1000).reveal.studs).toBe(1);
    expect(entranceAt(1000).reveal.surface).toBe(0);
    expect(entranceAt(2400).reveal.surface).toBe(1);
    expect(entranceAt(2400).reveal.hatch).toBe(0);
    expect(entranceAt(ENTRANCE_MS).reveal.hatch).toBe(1);
    // Each callout lights as its marks arrive.
    expect(
      [999, 1000, 2399, 2400, 2799, 2800].map((t) => entranceAt(t).callouts),
    ).toEqual([0, 1, 1, 2, 2, 3]);
    expect(entranceAt(ENTRANCE_MS).view).toEqual([18, 8]);
    // The view centre's longitude only ever falls: features drift west to east, as the rotation
    // that follows turns them.
    let previous = Infinity;
    for (let t = 0; t <= ENTRANCE_MS; t += 100) {
      const lon = entranceAt(t).view[0];
      expect(lon).toBeLessThanOrEqual(previous);
      previous = lon;
    }
  });

  it('formats shares and distances for readouts', () => {
    expect(formatShare(0.1603)).toBe('16%');
    expect(formatShare(0.0716)).toBe('7.2%');
    expect(formatShare(0.0042)).toBe('0.42%');
    expect(formatShare(0)).toBe('0%');
    expect(formatKm(95)).toBe('95 km');
    expect(formatKm(1360.6)).toBe('1,361 km');
  });

  it('cancels a running layer cross-fade when the layer changes again', () => {
    const queue: FrameRequestCallback[] = [];
    const schedule = (callback: FrameRequestCallback) => queue.push(callback);
    let now = 0;
    const frame = () => {
      now += 16;
      for (const callback of queue.splice(0)) callback(now);
    };
    const calls: [string, number][] = [];
    const fade = layerFader((layer, amount) => calls.push([layer, amount]), {
      schedule,
    });

    fade('modeled');
    frame();
    frame();
    expect(calls.at(-1)?.[0]).toBe('modeled');
    // A second switch inside the 240 ms fade: from here on only the new layer is drawn.
    fade('measured');
    const after = calls.length;
    for (let index = 0; index < 30; index += 1) frame();
    const later = calls.slice(after - 1);
    expect(new Set(later.map(([layer]) => layer))).toEqual(
      new Set(['measured']),
    );
    expect(later[0]).toEqual(['measured', 0]);
    expect(calls.at(-1)).toEqual(['measured', 1]);
    // Then it rests: nothing left scheduled.
    expect(queue).toHaveLength(0);
  });

  it('switches at once when asked, cancelling a running fade (the poster’s Modeled reset)', () => {
    const queue: FrameRequestCallback[] = [];
    let now = 0;
    const calls: [string, number][] = [];
    const fade = layerFader((layer, amount) => calls.push([layer, amount]), {
      schedule: (callback) => queue.push(callback),
    });
    fade('measured');
    for (const callback of queue.splice(0)) callback((now += 16));
    fade('modeled', true);
    expect(calls.at(-1)).toEqual(['modeled', 1]);
    // The cancelled fade never draws Measured again.
    const after = calls.length;
    for (let index = 0; index < 30; index += 1)
      for (const callback of queue.splice(0)) callback((now += 16));
    expect(calls.slice(after)).toEqual([]);
  });

  it('switches layers at once under reduced motion', () => {
    const calls: [string, number][] = [];
    const queue: FrameRequestCallback[] = [];
    const fade = layerFader((layer, amount) => calls.push([layer, amount]), {
      reduced: true,
      schedule: (callback) => queue.push(callback),
    });
    fade('measured');
    expect(calls).toEqual([['measured', 1]]);
    expect(queue).toHaveLength(0);
  });
});

/** A clock the rotation runs on, advanced by hand: frames every 16 ms, timers on time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, (now: number) => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: SpinClock = {
    now: () => now,
    frame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    timer(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
  };
  /** Advance by `ms` in 16 ms frames, firing timers that come due. */
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 16);
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      const due = [...frames];
      frames.clear();
      for (const [, callback] of due) callback(now);
    }
  };
  return { clock, run, pendingFrames: () => frames.size };
}

describe('the Atlas preview’s rotation', () => {
  const setup = () => {
    const { clock, run, pendingFrames } = fakeClock();
    let turned = 0;
    const states: SpinState[] = [];
    const spin = new AutoSpin((degrees) => (turned += degrees), {
      clock,
      onState: (state) => states.push(state),
    });
    return { spin, run, pendingFrames, states, turned: () => turned };
  };

  it('holds the starting view, then turns a revolution a minute, the Earth’s way', () => {
    const { spin, run, turned, states, pendingFrames } = setup();
    spin.setOnScreen(true);
    expect(spin.state).toBe('off');
    spin.enable();
    expect(spin.state).toBe('waiting');
    run(SPIN_DWELL_MS - 20);
    expect(turned()).toBe(0);
    expect(pendingFrames()).toBe(0);
    run(40);
    expect(spin.state).toBe('running');
    // After the ramp, 10 s turn 60° (the centre's longitude falls: features drift eastward).
    run(3000);
    const before = turned();
    run(10_000);
    expect(turned() - before).toBeCloseTo(-SPIN_DEG_PER_S * 10, 0);
    expect(states).toEqual(['waiting', 'running']);
  });

  it('pauses while held, and turns again 4 s after the last hold ends', () => {
    const { spin, run, turned } = setup();
    spin.setOnScreen(true);
    spin.enable();
    run(SPIN_DWELL_MS + 2000);
    spin.hold('hover');
    spin.hold('focus');
    expect(spin.state).toBe('held');
    const held = turned();
    run(20_000);
    expect(turned()).toBe(held);
    spin.release('hover');
    run(SPIN_IDLE_MS + 100);
    expect(spin.state).toBe('held');
    spin.release('focus');
    expect(spin.state).toBe('waiting');
    run(SPIN_IDLE_MS - 100);
    expect(turned()).toBe(held);
    run(200);
    expect(spin.state).toBe('running');
    run(2000);
    expect(turned()).toBeLessThan(held);
  });

  it('stops off screen and in a hidden tab, scheduling no frames, and starts again on return', () => {
    const { spin, run, turned, pendingFrames } = setup();
    spin.setOnScreen(true);
    spin.enable();
    run(SPIN_DWELL_MS + 1000);
    expect(pendingFrames()).toBe(1);
    spin.setOnScreen(false);
    expect(spin.state).toBe('stopped');
    expect(pendingFrames()).toBe(0);
    const away = turned();
    run(10_000);
    expect(turned()).toBe(away);
    spin.setOnScreen(true);
    expect(spin.state).toBe('running');
    spin.setPageShown(false);
    expect(spin.state).toBe('stopped');
    expect(pendingFrames()).toBe(0);
  });

  it('stays paused after Pause, whatever the visitor does, until Play', () => {
    const { spin, run, turned } = setup();
    spin.setOnScreen(true);
    spin.enable();
    run(SPIN_DWELL_MS + 1000);
    spin.setPaused(true);
    expect(spin.state).toBe('paused');
    spin.hold('hover');
    spin.release('hover');
    run(SPIN_IDLE_MS * 3);
    const paused = turned();
    expect(spin.state).toBe('paused');
    run(5000);
    expect(turned()).toBe(paused);
    // Play turns at once, easing up to speed.
    spin.setPaused(false);
    expect(spin.state).toBe('running');
    run(100);
    expect(turned()).toBeLessThan(paused);
  });

  it('never turns until enabled, and stops for good when disabled (the poster, reduced motion)', () => {
    const { spin, run, turned, pendingFrames } = setup();
    spin.setOnScreen(true);
    run(30_000);
    expect(spin.state).toBe('off');
    expect(turned()).toBe(0);
    spin.enable();
    run(SPIN_DWELL_MS + 1000);
    spin.disable();
    expect(spin.state).toBe('off');
    expect(pendingFrames()).toBe(0);
  });
});

describe('the hero film’s choices', () => {
  const sources = [
    { src: '720.av1', type: 'av1', width: 1280 },
    { src: '720.hevc', type: 'hevc', width: 1280 },
    { src: '1080.av1', type: 'av1', width: 1920 },
    { src: '1080.hevc', type: 'hevc', width: 1920 },
  ];
  const pick = (width: number, dpr: number) =>
    pickRendition(sources, width, dpr).map((source) => source.src);

  it('takes the 720p film on phones and small laptops, 1080p on desktops, AV1 first', () => {
    expect(pick(390, 3)).toEqual(['720.av1', '720.hevc']);
    expect(pick(430, 3)).toEqual(['720.av1', '720.hevc']);
    expect(pick(412, 2.625)).toEqual(['720.av1', '720.hevc']);
    expect(pick(1280, 1)).toEqual(['720.av1', '720.hevc']);
    expect(pick(1366, 1)).toEqual(['1080.av1', '1080.hevc']);
    expect(pick(1440, 1)).toEqual(['1080.av1', '1080.hevc']);
    expect(pick(1440, 2)).toEqual(['1080.av1', '1080.hevc']);
    expect(pick(2560, 1)).toEqual(['1080.av1', '1080.hevc']);
    expect(pickRendition([], 1440, 1)).toEqual([]);
  });

  it('keeps the poster under reduced motion, Save-Data and slow connections', () => {
    expect(posterReason({ reducedMotion: true })).toBe('reduced-motion');
    expect(posterReason({ reducedMotion: false, saveData: true })).toBe(
      'save-data',
    );
    for (const effectiveType of ['slow-2g', '2g', '3g'])
      expect(posterReason({ reducedMotion: false, effectiveType })).toBe(
        'slow-connection',
      );
    expect(posterReason({ reducedMotion: false, effectiveType: '4g' })).toBe(
      null,
    );
    expect(posterReason({ reducedMotion: false })).toBe(null);
  });

  it('recedes from the hero’s top to three quarters of its height (the scroll fade’s fallback)', () => {
    expect(RECEDE_SPAN).toBe(0.75);
    expect(recedeAt(0, 100, 800)).toBe(0);
    expect(recedeAt(100, 100, 800)).toBe(0);
    expect(recedeAt(400, 100, 800)).toBeCloseTo(0.5, 6);
    expect(recedeAt(700, 100, 800)).toBe(1);
    expect(recedeAt(5000, 100, 800)).toBe(1);
    expect(recedeAt(500, 100, 0)).toBe(0);
  });
});
