/**
 * Home's hero film and Atlas preview, read from the built page, plus the pure logic of their
 * islands: the preview's timeline, rotation and on-globe labels (round 2 spec §4.1.1, §4.1.5,
 * §11.1; rulings R2-1, R2-2, R2-14, R2-16 and 21–25 of the round-2 build; #454). Owned by the hero
 * and toy-globe task (round 2 plan T1). The film's choices are in hero-media.test.ts.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AutoSpin,
  ENTRANCE_MS,
  LABEL_FACING_DEG,
  LABEL_GEOMETRY,
  LABEL_MIN_RADIUS,
  REST_VIEW,
  SPIN_DEG_PER_S,
  SPIN_DWELL_MS,
  SPIN_EASE_OUT_MS,
  SPIN_IDLE_MS,
  SPIN_RAMP_MS,
  STUD_REFERENCE_RADIUS,
  TURN_DEG,
  entranceAt,
  estimateLabelWidth,
  formatKm,
  formatRange,
  formatShare,
  labelAlpha,
  labelBox,
  labelLines,
  layerFader,
  placeLabels,
  previewStudScale,
  spinAngleAt,
  type LabelBox,
  type LabelInput,
  type SpinClock,
  type SpinState,
} from '../src/components/home/atlas-preview';
import provenance from '../src/data/figures/hbs.provenance.json';

const homepage = path.resolve(import.meta.dirname, '../dist/index.html');
const html = existsSync(homepage) ? readFileSync(homepage, 'utf8') : '';
const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const body = html.slice(html.indexOf('<body'));

/** The opening tag and contents of the section whose opening tag matches `pattern`. */
function section(pattern: RegExp): string {
  const start = main.search(pattern);
  if (start === -1) return '';
  const end = main.indexOf('</section>', start);
  return main.slice(start, end);
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const callout = (kind: 'survey' | 'modeled' | 'unknown') =>
  provenance.callouts.find((entry) => entry.kind === kind)!;

describe('the Atlas preview, as built', () => {
  const atlas = section(/<section\b[^>]*\bid="atlas"/);
  const figure = atlas.slice(atlas.indexOf('<figure'));

  it('says what it is in a plain note, beside a large pill to the same map in the Atlas', () => {
    expect(figure).toMatch(/data-graphic="atlas-preview"/);
    // Ruling R2-14: no scare label.
    expect(figure).not.toContain('Not yet validated');
    expect(figure).not.toContain('data-status="not-validated"');
    expect(figure).not.toContain('kit-status-tag');
    const note = figure.match(
      /<div class="figure-note hg-note"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(note, 'the note').not.toBeNull();
    expect(text(note![1])).toContain(
      'A simplified preview, made from a sample of real Atlas data.',
    );
    // The pill opens the map the preview shows (round 2 spec §4.1.5, owner question 2).
    expect(note![1]).toMatch(
      /<a class="atlas-open" href="\/app\/\?entity=hbs-rs334&amp;palette=genome">[\s\S]*Open the <span class="brand-name">genomeOS<\/span> Atlas/,
    );
    // The footnote is provenance only: the pill is the way to the Atlas.
    const footnote = figure.match(
      /<p class="kit-figure__footnote"[^>]*>([\s\S]*?)<\/p>/,
    )![1];
    expect(footnote).not.toContain('<a');
    const revision = provenance.hf_revision.slice(0, 7);
    expect(text(footnote).trim()).toBe(
      `HbS (rs334) · model v3 · data map-2026-08 · revision ${revision} · coarsened for display`,
    );
  });

  it('keeps one Measured · Modeled toggle and a rotation Pause, an icon hidden until it can turn', () => {
    for (const layer of ['measured', 'modeled'])
      expect(figure).toMatch(new RegExp(`data-value="${layer}"`));
    expect(figure).not.toContain('data-value="evidence"');
    expect(figure).not.toMatch(/hg-step|data-readout|hg-reset/);
    // The kit's scene control (ruling 22): a white glyph, no visible label, named for its action,
    // aria-pressed when paused, hidden until the island takes it.
    const toggle = figure.match(
      /<button[^>]*data-scene-toggle[^>]*>[\s\S]*?<\/button>/,
    )![0];
    expect(toggle).toMatch(/class="kit-scene-control"/);
    expect(toggle).toMatch(/aria-pressed="false"/);
    expect(toggle).toMatch(/\bhidden\b/);
    expect(text(toggle).trim()).toBe('Pause the rotation');
    expect(toggle).toMatch(
      /<span class="visually-hidden">Pause the rotation<\/span>/,
    );
    // In a group of independent toggles, so the figure contract does not ask for one pressed.
    expect(figure).toMatch(
      /class="kit-scene-controls"[^>]*data-select="multiple"/,
    );
  });

  it('draws its labels on the globe in an aria-hidden SVG, and lists them for screen readers', () => {
    // Ruling 23: no corner boxes, no leader lines, no numbered key.
    expect(figure).not.toMatch(
      /hg-callouts|hg-callout\b|hg-leader|hg-marker|data-n=/,
    );
    const layer = figure.match(/<svg class="hg-labels"[^>]*>[\s\S]*?<\/svg>/);
    expect(layer, 'the label layer').not.toBeNull();
    expect(layer![0]).toMatch(
      /^<svg class="hg-labels" aria-hidden="true" focusable="false"/,
    );
    // Inside the globe box, so it shares the disc's geometry.
    const globe = figure.slice(figure.indexOf('class="hg-globe"'));
    expect(globe.indexOf('class="hg-labels"')).toBeLessThan(
      globe.indexOf('</div>'),
    );
    const survey = callout('survey');
    const modeled = callout('modeled');
    const groups = [
      ...layer![0].matchAll(
        /<g class="hg-label" data-label="(\w+)"[^>]*>([\s\S]*?)<\/g>\s*<\/g>/g,
      ),
    ];
    expect(groups.map(([, kind]) => kind)).toEqual([
      'survey',
      'modeled',
      'unknown',
    ]);
    const lines = (kind: string) =>
      [
        ...groups
          .find(([, k]) => k === kind)![2]
          .matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g),
      ].map(([, line]) => line.replace(/&amp;/g, '&'));
    // Counts in people (AN / 2), never alleles; the modeled range in lay words.
    expect(lines('survey')).toEqual([
      'Measured',
      `${survey.people!.toLocaleString('en-US')} people tested`,
    ]);
    expect(lines('modeled')).toEqual([
      'Modeled',
      `about ${formatShare(modeled.mean!)},`,
      `likely ${formatRange(modeled.lo!, modeled.hi!)}`,
    ]);
    expect(lines('unknown')).toEqual(['No estimate', 'no survey in range']);
    expect(text(figure)).not.toMatch(/\balleles\b/);
    // Each label rides on its own point: a ring at the point, the text beside it, on a side the
    // build chose so it fits the smallest disc.
    for (const [, kind, inner] of groups) {
      expect(inner, kind).toMatch(/<circle class="hg-label__ring"/);
      expect(groups.find(([, k]) => k === kind)![0], kind).toMatch(
        /data-side="(right|left|below|above)(-(down|up|right|left))?"/,
      );
    }
    // The text twin screen readers get, always present (ruling 25).
    const list = figure.match(
      /<ul class="visually-hidden" id="atlas-preview-labels"[^>]*>([\s\S]*?)<\/ul>/,
    );
    expect(list, 'the visually hidden list').not.toBeNull();
    const items = [...list![1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
      ([, item]) => text(item).trim(),
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(
      new RegExp(
        `^Measured: ${survey.people!.toLocaleString('en-US')} people tested, at \\d+\\.\\d°[NS] \\d+\\.\\d°[EW]\\.$`,
      ),
    );
    expect(items[1]).toMatch(
      new RegExp(
        `^Modeled: about ${formatShare(modeled.mean!).replace('.', '\\.')}, likely ${formatRange(modeled.lo!, modeled.hi!).replace(/\./g, '\\.')}, at `,
      ),
    );
    expect(items[2]).toMatch(/^No estimate: no survey in range, at /);
  });

  it('places each label at rest on the side the layout rule picks for the smallest disc', () => {
    const layer = figure.match(
      /<svg class="hg-labels"[^>]*>[\s\S]*?<\/svg>/,
    )![0];
    const inputs: LabelInput[] = (
      ['survey', 'modeled', 'unknown'] as const
    ).map((kind) => {
      const lines = labelLines(kind, provenance);
      const [x, y] = callout(kind).disc as [number, number];
      return {
        kind,
        x: x * LABEL_MIN_RADIUS,
        y: y * LABEL_MIN_RADIUS,
        cosc: Math.sqrt(Math.max(0, 1 - x * x - y * y)),
        width: estimateLabelWidth(lines),
        height: lines.length * LABEL_GEOMETRY.line,
      };
    });
    const placed = placeLabels(inputs, LABEL_MIN_RADIUS);
    for (const placement of placed) {
      expect(placement.fits, placement.kind).toBe(true);
      expect(placement.alpha, placement.kind).toBe(1);
      expect(layer).toMatch(
        new RegExp(
          `data-label="${placement.kind}"[^>]*data-side="${placement.side}"`,
        ),
      );
    }
  });

  it('names the globe from the data and tells keyboard users how to turn it', () => {
    expect(provenance.alt).toMatch(
      /^Preview of the Atlas with sample data: a slowly turning globe of the sickle-cell variant HbS\. /,
    );
    expect(figure).toContain(`aria-label="${provenance.alt}"`);
    const hint = figure.match(
      /<p class="visually-hidden" id="atlas-preview-keys">([^<]*)<\/p>/,
    );
    expect(hint?.[1].replace(/\s+/g, ' ').trim()).toBe(
      'Arrow keys turn the globe; Home returns it to its starting view. Focus pauses it.',
    );
  });

  it('leads its legend with what is shown, then the marks of each layer', () => {
    const legend = figure.match(
      /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/,
    )![1];
    const words = text(legend).trim();
    expect(words.startsWith('Shown: the sickle-cell variant, HbS.')).toBe(true);
    expect(legend).toMatch(/^\s*<strong[^>]*>Shown:/);
    const modeled = text(
      legend.match(/data-legend="modeled"[^>]*>([\s\S]*?)<\/div>\s*<div/)![1],
    );
    expect(modeled).toContain('Surveys, sized by people tested');
    expect(modeled).toContain('Modeled share, 0–17% of gene copies');
    expect(modeled).toContain('Fades away from surveys');
    expect(modeled).toContain('No estimate');
    const measured = text(
      legend.slice(legend.indexOf('data-legend="measured"')),
    );
    expect(measured).toContain('Surveys, sized by people tested');
    expect(measured).toContain('Model grid, no values drawn');
    for (const size of ['sm', 'md', 'lg'])
      expect(legend).toContain(`#glyph-stud-${size}`);
  });

  it('lists the preview’s data as a table', () => {
    expect(figure).toMatch(/<summary>View as table<\/summary>/);
    for (const area of provenance.table.top_areas)
      expect(figure).toContain(formatRange(area.lo, area.hi));
    expect(figure).toContain(provenance.counts.surveys.toLocaleString('en-US'));
  });

  it('loads its poster lazily, below the hero', () => {
    expect(figure).toMatch(
      /<img\b[^>]*class="hg-poster"[^>]*\bwidth="640"[^>]*\bheight="640"/,
    );
    expect(figure).toMatch(/<img\b[^>]*class="hg-poster"[^>]*loading="lazy"/);
    expect(figure).not.toMatch(/class="hg-poster"[^>]*fetchpriority/);
  });
});

describe('the hero film, as built', () => {
  const hero = section(/<section\b[^>]*\bid="hero"/);

  it('draws a poster first, then a deferred, muted loop', () => {
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
    // Only the AV1 and HEVC 720p and 1080p encodes are shipped, the 1080p AV1 within 4 MB and the
    // 720p AV1 within 2 MB (round 2 spec §7's deferred-media caps).
    for (const { src } of sources) {
      const file = path.resolve(import.meta.dirname, '../dist', src.slice(1));
      expect(existsSync(file), src).toBe(true);
    }
    const size = (name: string) =>
      statSync(path.resolve(import.meta.dirname, '../dist/media/hero', name))
        .size;
    expect(size('hero-1080.av1.mp4')).toBeLessThanOrEqual(4000 * 1024);
    expect(size('hero-720.av1.mp4')).toBeLessThanOrEqual(2000 * 1024);
  });

  it('offers a white Pause glyph after the calls to action, its name in words, hidden until the film plays', () => {
    // WCAG 2.4.3: the DOM order is the focus order, so the calls to action precede the film's
    // control, and the Atlas preview's controls come after the hero.
    const at = (needle: string) => hero.indexOf(needle);
    expect(at('<h1')).toBeGreaterThan(-1);
    expect(at('home-hero__lede')).toBeGreaterThan(at('<h1'));
    expect(at('home-hero__actions')).toBeGreaterThan(at('home-hero__lede'));
    expect(at('data-video-toggle')).toBeGreaterThan(at('home-hero__actions'));
    // One of each (round 2 spec §0.3 #16).
    expect(hero.match(/<h1\b/g)).toHaveLength(1);
    expect(hero.match(/class="home-hero__lede"/g)).toHaveLength(1);
    expect(hero.match(/class="home-hero__actions"/g)).toHaveLength(1);
    const toggle = hero.match(
      /<button[^>]*data-video-toggle[^>]*>[\s\S]*?<\/button>/,
    )![0];
    expect(toggle).toMatch(/class="hero-media__toggle kit-scene-control"/);
    expect(toggle).toMatch(/\bhidden\b/);
    expect(toggle).toMatch(/data-state="playing"/);
    // Ruling 22: no visible text, only the glyph; the name is visually hidden.
    expect(text(toggle).trim()).toBe('Pause the background video');
    expect(toggle).toMatch(
      /<span class="visually-hidden" data-video-toggle-text>Pause the background video<\/span>/,
    );
    expect(toggle).toMatch(/<svg viewBox="0 0 20 20" aria-hidden="true"/);
    expect(main.indexOf('data-graphic="atlas-preview"')).toBeGreaterThan(
      main.indexOf('id="hero"'),
    );
  });

  it('loads no decorative raster but the film’s poster; the banner stays in the social meta', () => {
    expect(body).not.toContain('genomeos-banner.png');
    expect(html).toMatch(/og:image" content="[^"]*genomeos-banner\.png"/);
    const rasters = [
      ...main.matchAll(/[\w./-]+\.(?:webp|png|avif|jpe?g)\b/g),
    ].map(([url]) => url);
    expect(rasters.length).toBeGreaterThan(0);
    for (const url of rasters) expect(url).toMatch(/\/_astro\/hero-poster\./);
    // The globe sits below the hero: no pre-paint arming script is left in the head.
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
    // Each label lights as its marks arrive.
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

  it('turns 4° a second once up to speed, one revolution in 90 s, easing in over 1.6 s', () => {
    expect(SPIN_DEG_PER_S).toBe(4);
    expect(SPIN_RAMP_MS).toBe(1600);
    expect(spinAngleAt(0)).toBe(0);
    // Smoothstep ease-in: a quarter of the way through the ramp it has barely moved.
    expect(spinAngleAt(400)).toBeGreaterThan(0);
    expect(spinAngleAt(400)).toBeLessThan(0.4 * 0.25 * 4);
    // Past the ramp: half the ramp's length lost, then full speed.
    expect(spinAngleAt(SPIN_RAMP_MS)).toBeCloseTo(4 * 0.8, 6);
    expect(spinAngleAt(12_000) - spinAngleAt(2000)).toBeCloseTo(40, 6);
    expect(spinAngleAt(90_000 + 800)).toBeCloseTo(360, 6);
    // Continuous and never falling.
    let previous = -1;
    for (let t = 0; t <= 4000; t += 50) {
      expect(spinAngleAt(t)).toBeGreaterThanOrEqual(previous);
      previous = spinAngleAt(t);
    }
  });

  it('formats shares and distances for labels and the table', () => {
    expect(formatShare(0.1603)).toBe('16%');
    expect(formatShare(0.0716)).toBe('7.2%');
    expect(formatShare(0.0042)).toBe('0.42%');
    expect(formatShare(0)).toBe('0%');
    expect(formatRange(0.0134, 0.0612)).toBe('1.3–6.1%');
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

describe('the on-globe labels (ruling 23)', () => {
  const deg = (degrees: number) => Math.cos((degrees * Math.PI) / 180);
  const inside = (box: LabelBox, radius: number) =>
    [
      [box.left, box.top],
      [box.right, box.top],
      [box.left, box.bottom],
      [box.right, box.bottom],
    ].every(([x, y]) => Math.hypot(x, y) <= radius);
  const overlap = (a: LabelBox, b: LabelBox) =>
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom &&
    b.top < a.bottom;
  const label = (
    kind: LabelInput['kind'],
    x: number,
    y: number,
    extra: Partial<LabelInput> = {},
  ): LabelInput => ({
    kind,
    x,
    y,
    cosc: Math.sqrt(Math.max(0, 1 - (x * x + y * y) / 200 ** 2)),
    width: 110,
    height: 32,
    ...extra,
  });

  it('show whole while their point is within 60° of the view centre, and are gone past 72°', () => {
    expect(LABEL_FACING_DEG).toEqual([60, 72]);
    expect(labelAlpha(1)).toBe(1);
    expect(labelAlpha(deg(45))).toBe(1);
    expect(labelAlpha(deg(60))).toBe(1);
    expect(labelAlpha(deg(66))).toBeGreaterThan(0.2);
    expect(labelAlpha(deg(66))).toBeLessThan(0.8);
    expect(labelAlpha(deg(72))).toBe(0);
    expect(labelAlpha(deg(90))).toBe(0);
    expect(labelAlpha(-0.5)).toBe(0);
    let previous = 1;
    for (let angle = 50; angle <= 80; angle += 1) {
      expect(labelAlpha(deg(angle))).toBeLessThanOrEqual(previous);
      previous = labelAlpha(deg(angle));
    }
  });

  it('set their text beside the point’s ring, on any of four sides', () => {
    const { gap } = LABEL_GEOMETRY;
    expect(labelBox(10, 20, 'right', 100, 32)).toEqual({
      left: 10 + gap,
      right: 10 + gap + 100,
      top: 4,
      bottom: 36,
    });
    expect(labelBox(10, 20, 'left', 100, 32)).toEqual({
      left: 10 - gap - 100,
      right: 10 - gap,
      top: 4,
      bottom: 36,
    });
    expect(labelBox(10, 20, 'below', 100, 32)).toEqual({
      left: -40,
      right: 60,
      top: 20 + gap,
      bottom: 20 + gap + 32,
    });
    expect(labelBox(10, 20, 'above', 100, 32)).toEqual({
      left: -40,
      right: 60,
      top: 20 - gap - 32,
      bottom: 20 - gap,
    });
  });

  it('stay inside the disc: a point near the right limb takes its label to the left', () => {
    const [placed] = placeLabels([label('survey', 150, 0)], 200);
    expect(placed.side).toBe('left');
    expect(placed.fits).toBe(true);
    expect(inside(placed.box!, 200)).toBe(true);
    // Near the top edge, below.
    const [top] = placeLabels([label('unknown', 10, -170)], 200);
    expect(top.side).toBe('below');
    expect(inside(top.box!, 200)).toBe(true);
  });

  it('never overlap each other or cover another label’s point', () => {
    const placed = placeLabels(
      [label('survey', -40, 0), label('modeled', -20, -8)],
      220,
    );
    expect(placed.every((entry) => entry.fits)).toBe(true);
    expect(overlap(placed[0].box!, placed[1].box!)).toBe(false);
    const ring = (x: number, y: number) => ({
      left: x - 8,
      right: x + 8,
      top: y - 8,
      bottom: y + 8,
    });
    expect(overlap(placed[0].box!, ring(-20, -8))).toBe(false);
    expect(overlap(placed[1].box!, ring(-40, 0))).toBe(false);
  });

  it('find a layout for all of them when one exists, even if the first label must move', () => {
    // The three points of the preview at rest on the smallest disc (radius 136 px): a greedy pass
    // that put the first label on its first free side would leave the third no room.
    const placed = placeLabels(
      [
        label('survey', -32.9, 0.9, { width: 128, height: 32, cosc: 0.97 }),
        label('modeled', 6.3, -35.5, { width: 96, height: 48, cosc: 0.96 }),
        label('unknown', 61.6, -88.9, { width: 115, height: 32, cosc: 0.6 }),
      ],
      LABEL_MIN_RADIUS,
    );
    expect(placed.map((entry) => entry.fits)).toEqual([true, true, true]);
    for (const [index, entry] of placed.entries()) {
      expect(inside(entry.box!, LABEL_MIN_RADIUS)).toBe(true);
      for (const other of placed.slice(index + 1))
        expect(overlap(entry.box!, other.box!)).toBe(false);
    }
  });

  it('keep the side they are on while it still fits, so they do not jump as the globe turns', () => {
    const [kept] = placeLabels([label('survey', 0, 0, { side: 'left' })], 200);
    expect(kept.side).toBe('left');
    const [moved] = placeLabels(
      [label('survey', -150, 0, { side: 'left' })],
      200,
    );
    expect(moved.side).toBe('right');
  });

  it('hide when no side fits, when facing away, or when their layer is off', () => {
    // A disc too small for the text.
    const [cramped] = placeLabels([label('survey', 0, 0, { width: 400 })], 120);
    expect(cramped.fits).toBe(false);
    // Turned past 72°: no place is looked for.
    const [away] = placeLabels([label('survey', 0, 0, { cosc: deg(80) })], 200);
    expect(away.alpha).toBe(0);
    expect(away.fits).toBe(false);
    // Measured layer: the Modeled label names a mark that is not drawn.
    const [off] = placeLabels([label('modeled', 0, 0, { shown: false })], 200);
    expect(off.fits).toBe(false);
    // A hidden label is no obstacle to the others.
    const placed = placeLabels(
      [label('survey', 0, 0, { shown: false }), label('modeled', 0, 0)],
      200,
    );
    expect(placed[1].fits).toBe(true);
  });

  it('estimate text widths on the generous side, for the build’s rest layout', () => {
    // Measured in the browser, Figtree 13 px with tabular numerals: 58.3 (650), 120.0, 88.3 and
    // 106.7 px (500).
    const measured = ['Measured', '9,506 people tested'];
    expect(estimateLabelWidth(measured)).toBeGreaterThanOrEqual(120);
    expect(estimateLabelWidth(measured)).toBeLessThanOrEqual(132);
    expect(
      estimateLabelWidth(['Modeled', 'about 2.8%,', 'likely 1.3–6.1%']),
    ).toBeGreaterThanOrEqual(89);
    expect(
      estimateLabelWidth(['No estimate', 'no survey in range']),
    ).toBeGreaterThanOrEqual(107);
    // A glyph the table does not hold counts as wide as an m.
    expect(estimateLabelWidth(['é'])).toBeGreaterThanOrEqual(11);
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

  it('holds the starting view, then turns 4° a second, the Earth’s way', () => {
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
    // After the ramp, 10 s turn 40° (the centre's longitude falls: features drift eastward).
    run(3000);
    const before = turned();
    run(10_000);
    expect(turned() - before).toBeCloseTo(-SPIN_DEG_PER_S * 10, 0);
    expect(states).toEqual(['waiting', 'running']);
  });

  it('eases out over 400 ms when pointed at or focused, stops at once for a drag', () => {
    expect(SPIN_EASE_OUT_MS).toBe(400);
    const { spin, run, turned, pendingFrames } = setup();
    spin.setOnScreen(true);
    spin.enable();
    run(SPIN_DWELL_MS + 3000);
    spin.hold('hover');
    expect(spin.state).toBe('held');
    const at = turned();
    run(100);
    const early = turned() - at;
    // Still turning a little, slower than full speed.
    expect(early).toBeLessThan(0);
    expect(Math.abs(early)).toBeLessThan((SPIN_DEG_PER_S * 100) / 1000);
    run(SPIN_EASE_OUT_MS);
    const stopped = turned();
    expect(pendingFrames()).toBe(0);
    run(5000);
    expect(turned()).toBe(stopped);
    // A drag holds at once: no tail under the visitor's finger.
    spin.release('hover');
    run(SPIN_IDLE_MS + 3000);
    expect(spin.state).toBe('running');
    spin.hold('drag');
    const dragged = turned();
    expect(pendingFrames()).toBe(0);
    run(500);
    expect(turned()).toBe(dragged);
  });

  it('turns again 4 s after the last hold ends', () => {
    const { spin, run, turned } = setup();
    spin.setOnScreen(true);
    spin.enable();
    run(SPIN_DWELL_MS + 2000);
    spin.hold('hover');
    spin.hold('focus');
    expect(spin.state).toBe('held');
    run(SPIN_EASE_OUT_MS + 32);
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
    const { spin, run, turned, pendingFrames } = setup();
    spin.setOnScreen(true);
    spin.enable();
    run(SPIN_DWELL_MS + 1000);
    spin.setPaused(true);
    expect(spin.state).toBe('paused');
    expect(pendingFrames()).toBe(0);
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
