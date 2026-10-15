/**
 * The Home page contract (site redesign spec §4.1, §9.1; round 2 rulings R2-1, R2-2, R2-14; #454),
 * read from the built page, plus the pure logic of its islands (the hero film's choices, the Atlas
 * preview's timeline and rotation, the counts table).
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
import {
  COUNT_STOPS,
  GRID,
  TESTED_FILL,
  buildCountsTable,
} from '../src/components/home/counts';
import provenance from '../src/data/figures/hbs.provenance.json';
import { jeffreys } from '../src/graphics/jeffreys';

const homepage = path.resolve(import.meta.dirname, '../dist/index.html');
const html = existsSync(homepage) ? readFileSync(homepage, 'utf8') : '';
const visibleText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const body = html.slice(html.indexOf('<body'));
const tokens = readFileSync(
  path.resolve(import.meta.dirname, '../src/styles/tokens.css'),
  'utf8',
);

/** A colour token's hex value from tokens.css. */
const token = (name: string) =>
  tokens.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1];

/** WCAG 2 contrast ratio of two hex colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = hex
      .slice(1)
      .match(/../g)!
      .map((pair) => {
        const c = parseInt(pair, 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** The first mark inside a grid's `<pattern id="…{suffix}">`. */
const pattern = (svg: string, suffix: string) =>
  svg
    .match(
      new RegExp(
        `<pattern\\b[^>]*id="[^"]*${suffix}"[^>]*>([\\s\\S]*?)</pattern>`,
      ),
    )?.[1]
    .trim() ?? '';

/** The opening tag and contents of the element whose opening tag matches `open`. */
function section(pattern: RegExp): string {
  const start = main.search(pattern);
  if (start === -1) return '';
  const end = main.indexOf('</section>', start);
  return main.slice(start, end);
}

describe('homepage contract', () => {
  it('leads with the public-good mission and current evidence scale', () => {
    expect(html).toMatch(/<h1[^>]*>Explore genomes across the world\.<\/h1>/);
    expect(html).toMatch(/open source/i);
    expect(html).toMatch(/global community/i);
    expect(html).toMatch(/public good/i);
    expect(html).toMatch(/4,392[\s\S]*6\.69M[\s\S]*disease/);
    expect(html).toContain(
      'Location matters because a genetic variant can be common',
    );
    expect(html).not.toContain(
      'Place matters because a genetic variant can be common',
    );
  });

  it('introduces the mission before explaining the delivery process', () => {
    expect(visibleText).toMatch(
      /Why genomeOS[\s\S]*How genomeOS works[\s\S]*Aggregate the evidence[\s\S]*Model what the evidence supports[\s\S]*Open it to the world[\s\S]*Potential applications[\s\S]*Built in the open/,
    );
  });

  // Design review, round 2: the teaser's zoom squares sat on each frame's right edge over 40 px
  // icons, so its wedges read as connectors. It now draws Project's ladder frames at teaser scale:
  // the same art, zoom boxes on the content they magnify, and the same wedge geometry.
  it('draws the vision teaser with the Project ladder’s frame art and zoom boxes', () => {
    const vision = section(/<section\b[^>]*\bid="vision"/);
    const project = readFileSync(
      path.resolve(import.meta.dirname, '../dist/projects/index.html'),
      'utf8',
    );
    const ladder = project.match(
      /<figure\b[^>]*data-graphic="scale-ladder"[\s\S]*?<\/figure>/,
    )![0];
    const land = (markup: string) =>
      new Set(
        [...markup.matchAll(/<path class="ladder__land" d="([^"]+)"/g)].map(
          ([, d]) => d,
        ),
      );
    expect(land(vision).size).toBeGreaterThan(20);
    expect(land(vision)).toEqual(land(ladder));
    for (const svg of vision.match(/<svg\b[^>]*vs-svg[\s\S]*?<\/svg>/g)!) {
      expect(svg.match(/class="ladder__zoom"/g)).toHaveLength(3);
      expect(
        svg.match(/<g class="vs-wedge [^"]*"[^>]*data-wedge="\d"/g),
      ).toHaveLength(3);
    }
    expect(vision).not.toContain('vs-frame__focus');
    // Its studs and footprint look like data but hold none (spec §2.6).
    expect(vision).toMatch(/class="kit-status-tag" data-status="schematic"/);
  });

  // Design review, round 2: the closing field was a 650 × 290 px mass of saturated ramp hexes, a
  // map with no data. It is small, mostly the grid's no-value footprint, and its focus is the
  // hatched cell that a contribution fills.
  it('keeps the closing field small and quiet, focused on the hatched cell', () => {
    const open = section(/<section\b[^>]*\bid="open"/);
    const svg = open.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/)![0];
    const cells = [
      ...svg.matchAll(
        /<path d="[^"]+" (?:fill="([^"]+)"|style="fill:([^"]+)")/g,
      ),
    ]
      .map(([, fill, style]) => fill ?? style)
      .filter((fill) => !fill.startsWith('url('));
    const land = cells.filter((fill) => fill.includes('--enc-land')).length;
    const ramp = cells.length - land;
    expect(land / cells.length).toBeGreaterThanOrEqual(0.65);
    expect(ramp).toBeGreaterThanOrEqual(3);
    expect(ramp).toBeLessThanOrEqual(12);
    expect(svg).toContain('url(#of-hatch)');
    expect(open).toMatch(/class="kit-status-tag" data-status="schematic"/);
  });

  it('leads into the larger vision with the scale strip, not images', () => {
    expect(html).not.toContain('/images/vision-earth.webp');
    expect(html).not.toContain(
      'alt="A luminous globe showing genetic evidence',
    );
    expect(html).toContain('Explore the larger vision');
    expect(html).toMatch(/href="\/projects\/#vision"/);
    expect(html).not.toContain('/images/vision-cell.webp');
    expect(html).not.toContain('/images/vision-bridge.webp');
  });

  it('does not duplicate detailed subpage content', () => {
    expect(html).not.toContain('How work moves');
    expect(html).not.toContain('What exists—and what comes later');
    expect(html).not.toContain('Browse matching issues');
    expect(html).not.toContain('Why haemoglobin S makes the mission tangible');
    expect(html).not.toContain('Three groups are forming');
    expect(html).not.toContain('Six rules the interface cannot hide');
  });

  it('makes the GitHub community entry points prominent', () => {
    expect(html).toContain(
      'https://github.com/genomeOS/genomeOS/discussions/76',
    );
    expect(html).toContain('https://github.com/genomeOS/genomeOS/issues');
    expect(html).toContain('https://github.com/orgs/genomeOS/projects/1');
    expect(
      html.match(/class="[^"]*github-cta/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
  });

  it('names the header Atlas link genomeOS Atlas and describes it with its caption', () => {
    const link = html.match(/<a class="launch-atlas-cta"[^>]*>[\s\S]*?<\/a>/);
    expect(link?.[0]).toContain('href="/app/"');
    expect(link?.[0]).toContain('aria-describedby="launch-atlas-caption"');
    // Its text is its name alone, for crawlers and plain-text copies too.
    expect(
      link?.[0]
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe('genomeOS Atlas');
    // The caption follows the link: the description only, hidden from the
    // name and read once.
    expect(html).toMatch(
      /<\/a>\s*<span class="launch-atlas-cta__caption" id="launch-atlas-caption" aria-hidden="true">Explore the interactive app<\/span>/,
    );
    // The Menu's copy, in the wordmark type like every visible genomeOS.
    expect(html).toMatch(
      /<li class="mobile-nav__launch"><a href="\/app\/">\s*<span class="brand-name">genomeOS<\/span> Atlas\s*<\/a><\/li>/,
    );
    expect(visibleText).not.toContain('Launch Atlas');
  });

  it('offers keyboard bypass and an accessible repository link', () => {
    expect(html).toContain('Skip to main content');
    expect(html).toContain('aria-label="View genomeOS on GitHub"');
    expect(html).toContain('https://github.com/genomeOS/genomeOS');
    expect(visibleText).toMatch(/© \d{4} genomeOS/);
    expect(html).not.toContain('Population geography is context');
  });
});

describe('homepage figures', () => {
  it('has seven concept sections, in the storyboard order, each with one figure', () => {
    const concepts = [
      ...main.matchAll(/<section\b[^>]*\bdata-concept\b[^>]*>/g),
    ].map((match) => match[0].match(/\bid="([^"]+)"/)?.[1] ?? '?');
    expect(concepts).toEqual([
      'atlas',
      'why',
      'how',
      'metrics',
      'applications',
      'vision',
      'open',
    ]);
    const parts = main.split(/<section\b[^>]*\bdata-concept\b[^>]*>/).slice(1);
    for (const part of parts) {
      const own = part.slice(0, part.indexOf('</section>'));
      expect(own.match(/<figure\b[^>]*\bdata-graphic\b/g) ?? []).toHaveLength(
        1,
      );
    }
  });

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

  it('ships the counts figure its precomputed Jeffreys table, never a fitter', () => {
    const why = section(/<section\b[^>]*\bid="why"/);
    expect(why).toContain('Worked example');
    expect(why).toContain('A · 61 of 412 alleles carry it');
    expect(why).toContain('11.6–18.5%');
    expect(why).toContain('0 of 20: up to 11.7% is still plausible.');
    expect(why).toContain(
      'aria-valuetext="20 alleles tested, none carry it, up to 11.7 percent"',
    );
    expect(why).toMatch(/class="mission-copy"[\s\S]*?<p[^>]*>Location matters/);
    // Grids are pattern rects, never one node per allele.
    expect((why.match(/<rect\b/g) ?? []).length).toBeLessThan(60);
  });

  it('keeps repository part codes out of the raw HTML (text, ids, classes, labels)', () => {
    expect(main).not.toMatch(/\bP[0-5]\b/);
  });

  it('never runs a word into the inline element after it', () => {
    // copy-spacing.test checks the closing side ("</span>word"); this is the opening side, where
    // a formatter's line break can vanish: "Survey (AC of AN)" once rendered "ofAN".
    const glued = [
      ...main.matchAll(/\p{L}<(?:abbr|a|b|em|strong|span)\b/gu),
    ].map((match) =>
      main.slice(Math.max(0, match.index - 30), match.index + 20),
    );
    expect(glued).toEqual([]);
    const atlas = section(/<section\b[^>]*\bid="atlas"/);
    expect(atlas.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).toContain(
      'Survey, sized by people tested',
    );
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

  it('shows each corpus total as its real value, never a count from zero', () => {
    // A statistic never reads as zero on screen (design review, round 1): the totals are static
    // text that sight and assistive technology read alike; only the composition bars animate.
    const metrics = section(/<section\b[^>]*\bid="metrics"/);
    const totals = [...metrics.matchAll(/<data\b([^>]*)>([^<]*)<\/data>/g)];
    expect(totals.map((match) => match[2])).toEqual(['4,392', '6.69M', '2']);
    for (const [, attributes] of totals) {
      expect(attributes).not.toContain('aria-hidden');
      expect(attributes).not.toContain('data-count-to');
    }
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

  it('draws row B’s untested alleles as faint dots, never an empty box', () => {
    const why = section(/<section\b[^>]*\bid="why"/);
    expect(why).not.toContain('cf-grid__room');
    const grids = [
      ...why.matchAll(/<svg\b[^>]*data-grid="b"[^>]*>[\s\S]*?<\/svg>/g),
    ].map(([svg]) => svg);
    expect(grids).toHaveLength(2);
    for (const svg of grids) {
      const columns = Number(svg.match(/data-columns="(\d+)"/)![1]);
      const pitch = Number(svg.match(/data-pitch="([\d.]+)"/)![1]);
      const ghost = svg.match(/<rect\b[^>]*data-ghost[^>]*>/)?.[0] ?? '';
      // All 2,000 squares, as whole rows: the room the slider fills.
      expect(Number(ghost.match(/\bwidth="([\d.]+)"/)?.[1])).toBe(
        columns * pitch,
      );
      expect(Number(ghost.match(/\bheight="([\d.]+)"/)?.[1])).toBe(
        Math.ceil(2000 / columns) * pitch,
      );
      // Each untested allele is a dot well inside its cell, not an outline that reads as a
      // tested square (design review, round 2).
      const mark = pattern(svg, '-ghost');
      expect(mark).toMatch(/^<circle\b/);
      expect(mark).not.toMatch(/stroke/);
      expect(Number(mark.match(/\br="([\d.]+)"/)![1])).toBeLessThanOrEqual(
        pitch / 8,
      );
    }
  });

  // Design review, round 2: tested non-carriers were --enc-land on orbit, about 1.25:1, and read
  // as the same texture as the room for untested alleles. WCAG 1.4.11 asks 3:1 of a meaningful mark.
  it('draws tested alleles at 3:1 or more on the band, distinct from carriers', () => {
    const why = section(/<section\b[^>]*\bid="why"/);
    const orbit = token('--color-orbit');
    const starlight = token('--color-starlight');
    expect(contrast(TESTED_FILL, orbit)).toBeGreaterThanOrEqual(3);
    expect(contrast(TESTED_FILL, starlight)).toBeGreaterThanOrEqual(3);
    const grids = [
      ...why.matchAll(/<svg\b[^>]*data-grid="[ab]"[^>]*>[\s\S]*?<\/svg>/g),
    ].map(([svg]) => svg);
    expect(grids).toHaveLength(4);
    for (const svg of grids) {
      expect(pattern(svg, '-off')).toContain(`fill: ${TESTED_FILL}`);
      expect(pattern(svg, '-off')).not.toContain('--enc-land');
    }
  });

  it('sets one allele as a square big enough to count on a wide figure', () => {
    // About 80 columns of 8 on a 10 pitch: single alleles read, not a barcode.
    expect(GRID.wide).toEqual({ columns: 80, pitch: 10, size: 8 });
    expect(GRID.narrow.size / GRID.narrow.pitch).toBeGreaterThanOrEqual(0.75);
  });

  it('colours each corpus source the same way in every tile', () => {
    const metrics = section(/<section\b[^>]*\bid="metrics"/);
    const marks = [
      ...metrics.matchAll(
        /<(?:span|i)\b[^>]*class="eb-(?:bar__segment|swatch)"[^>]*>/g,
      ),
    ].map(([tag]) => ({
      source: tag.match(/data-source="([^"]+)"/)?.[1],
      tone: tag.match(/data-tone="([^"]+)"/)?.[1],
    }));
    // Two bars and their two keys: 2 + 3 segments, 2 + 3 swatches.
    expect(marks).toHaveLength(10);
    const tones = new Map<string, Set<string>>();
    for (const { source, tone } of marks) {
      expect(source).toBeDefined();
      expect(tone).toBeDefined();
      tones.set(source!, (tones.get(source!) ?? new Set()).add(tone!));
    }
    expect([...tones.keys()].sort()).toEqual(['afnd', 'g6pd', 'hbs']);
    for (const set of tones.values()) expect(set.size).toBe(1);
    // AFND and HbS appear in both tiles; G6PD only among people.
    expect(new Set([...tones.values()].map((set) => [...set][0])).size).toBe(3);
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

describe('counts figure table', () => {
  const table = buildCountsTable(jeffreys);

  it('matches the spec’s Jeffreys values at every stop', () => {
    expect(COUNT_STOPS).toEqual([20, 50, 100, 200, 500, 1000, 2000]);
    expect(table.stops.map((stop) => stop.upper)).toEqual([
      '11.7%',
      '4.9%',
      '2.5%',
      '1.2%',
      '0.50%',
      '0.25%',
      '0.13%',
    ]);
    expect(table.stops[0].output).toBe(
      '0 of 20: up to 11.7% is still plausible.',
    );
    expect(table.stops[6].output).toBe(
      '0 of 2,000: up to 0.13% is still plausible.',
    );
    expect(table.stops[0].valuetext).toBe(
      '20 alleles tested, none carry it, up to 11.7 percent',
    );
    expect(table.a.range).toBe('11.6–18.5%');
    expect(table.a.mean).toBeCloseTo(0.1489, 4);
  });

  it('never lets an interval collapse to absence', () => {
    for (const stop of table.stops) {
      expect(stop.hi).toBeGreaterThan(0);
      expect(stop.lo).toBe(0);
    }
  });
});
