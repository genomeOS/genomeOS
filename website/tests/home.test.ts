/**
 * The Home page contract (site redesign spec §4.1, §9.1; #454), read from the built page, plus the
 * pure logic of its figure islands (hero globe readouts and timeline, the counts table).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENTRANCE_MS,
  REST_VIEW,
  STUD_REFERENCE_RADIUS,
  describeHit,
  heroStudScale,
  entranceAt,
  formatKm,
  formatRange,
  formatShare,
  layerFader,
} from '../src/components/home/hero-globe';
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
      path.resolve(import.meta.dirname, '../dist/project/index.html'),
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
    expect(html).toMatch(/href="\/project\/#vision"/);
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
      'hero',
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

  it('draws the hero from the pinned HbS data, with its status and provenance', () => {
    const hero = section(/<section\b[^>]*\bid="hero"/);
    expect(hero).toMatch(/data-graphic="hero-globe"/);
    // Status inside the figure, not only in a footnote.
    expect(hero).toContain('Not yet validated');
    // The three layers; nothing maps the width of a range to colour (spec §6.3).
    for (const layer of ['Measured', 'Modeled', 'Evidence'])
      expect(hero).toMatch(new RegExp(`data-value="${layer.toLowerCase()}"`));
    expect(hero).not.toMatch(/Uncertainty<\/button>/);
    // Callout 1 is a real survey: AC of AN alleles.
    const [survey, modeled] = provenance.callouts;
    const words = hero.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    expect(words).toContain(
      `Measured: ${survey.ac!.toLocaleString('en-US')} of ${survey.an!.toLocaleString('en-US')} alleles`,
    );
    expect(hero).toContain(
      `${survey.ac!.toLocaleString('en-US')} of ${survey.an!.toLocaleString('en-US')} alleles`,
    );
    expect(words).toContain(
      `Modeled: about ${formatShare(modeled.mean!)} (95%: ${formatRange(modeled.lo!, modeled.hi!)})`,
    );
    expect(words).toContain('No estimate: no survey in range');
    // Provenance and the same view in the Atlas.
    const revision = provenance.hf_revision.slice(0, 7);
    expect(hero).toMatch(
      new RegExp(
        `HbS \\(rs334\\) · model v3 · data map-2026-08 · revision ${revision} · coarsened for display`,
      ),
    );
    expect(hero).toContain('href="/app/?entity=hbs-rs334&amp;palette=genome"');
    // The no-JS poster is the LCP candidate: sized, high priority.
    expect(hero).toMatch(
      /<img\b[^>]*class="hg-poster"[^>]*\bwidth="640"[^>]*\bheight="640"/,
    );
    expect(hero).toMatch(
      /<img\b[^>]*class="hg-poster"[^>]*fetchpriority="high"/,
    );
    // The data-derived alt text.
    expect(hero).toContain(provenance.alt);
    // Studs in three sizes in the legend.
    for (const size of ['sm', 'md', 'lg'])
      expect(hero).toContain(`#glyph-stud-${size}`);
  });

  it('lists the hero data as a table', () => {
    const hero = section(/<section\b[^>]*\bid="hero"/);
    expect(hero).toMatch(/<summary>View as table<\/summary>/);
    for (const area of provenance.table.top_areas)
      expect(hero).toContain(formatRange(area.lo, area.hi));
    expect(hero).toContain(provenance.counts.surveys.toLocaleString('en-US'));
  });

  it('loads no decorative raster: the banner stays in the social meta only', () => {
    expect(body).not.toContain('genomeos-banner.png');
    expect(html).toMatch(/og:image" content="[^"]*genomeos-banner\.png"/);
    expect(main).not.toMatch(/\.webp|\.png/);
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
    const hero = section(/<section\b[^>]*\bid="hero"/);
    expect(hero.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).toContain(
      'Survey (AC of AN)',
    );
  });

  it('keeps the modeled range on one line in its callout and its step', () => {
    const modeled = provenance.callouts.find(
      (callout) => callout.kind === 'modeled',
    )!;
    const range = `(95%: ${formatRange(modeled.lo!, modeled.hi!)})`;
    const hero = section(/<section\b[^>]*\bid="hero"/);
    expect(
      hero.split(`<span class="hg-nowrap">${range}</span>`).length - 1,
    ).toBe(2);
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

  it('orders the hero as it reads: heading, lede, calls to action, then the figure', () => {
    // WCAG 2.4.3: the DOM order is the focus order, so the calls to action precede the globe's
    // nine controls (design review, round 1).
    const hero = section(/<section\b[^>]*\bid="hero"/);
    const at = (needle: string) => hero.indexOf(needle);
    expect(at('<h1')).toBeGreaterThan(-1);
    expect(at('home-hero__lede')).toBeGreaterThan(at('<h1'));
    expect(at('home-hero__actions')).toBeGreaterThan(at('home-hero__lede'));
    expect(at('data-graphic="hero-globe"')).toBeGreaterThan(
      at('home-hero__actions'),
    );
  });

  it('arms the hero before its first paint, and only when motion is allowed', () => {
    // Spec §2.7 rule 5: a head script marks the hero armed before any of it paints, so the rest
    // state never shows and then blanks; it stands down at 1,200 ms if the island has not begun.
    const head = html.slice(0, html.indexOf('</head>'));
    const script = head.match(
      /<script>((?:(?!<\/script>)[\s\S])*data-arm-hero(?:(?!<\/script>)[\s\S])*)<\/script>/,
    )?.[1];
    expect(script).toBeDefined();
    expect(script).toContain('prefers-reduced-motion: reduce');
    expect(script).toContain('forced-colors: active');
    expect(script).toContain('saveData');
    expect(script).toContain('1200');
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

describe('hero globe logic', () => {
  it('shrinks the studs with a smaller disc, never below 0.6 of full size', () => {
    // A 390 px phone's disc (radius about 172 px) is a quarter smaller than the 1440 px one, and
    // its studs shrink with it, so they stop merging into blobs (design review, round 1).
    expect(heroStudScale(STUD_REFERENCE_RADIUS)).toBe(1);
    expect(heroStudScale(260)).toBe(1);
    expect(heroStudScale(172)).toBeCloseTo(0.76, 2);
    expect(heroStudScale(100)).toBe(0.6);
  });

  it('plays in evidence order over 2.8 s and turns 20° east to rest', () => {
    expect(ENTRANCE_MS).toBe(2800);
    expect(REST_VIEW).toEqual([18, 8]);
    const start = entranceAt(0);
    expect(start.reveal).toEqual({ land: 0, studs: 0, surface: 0, hatch: 0 });
    expect(start.view[0]).toBeCloseTo(-2, 6);
    expect(entranceAt(300).reveal.land).toBe(1);
    expect(entranceAt(300).reveal.studs).toBe(0);
    expect(entranceAt(1000).reveal.studs).toBe(1);
    expect(entranceAt(1000).reveal.surface).toBe(0);
    expect(entranceAt(2400).reveal.surface).toBe(1);
    expect(entranceAt(2400).reveal.hatch).toBe(0);
    expect(entranceAt(ENTRANCE_MS).reveal.hatch).toBe(1);
    // Steps light as their marks arrive; each callout follows its step.
    expect([0, 299, 300, 1000, 2400].map((t) => entranceAt(t).steps)).toEqual([
      0, 0, 1, 2, 3,
    ]);
    expect(
      [999, 1000, 2399, 2400, 2799, 2800].map((t) => entranceAt(t).callouts),
    ).toEqual([0, 1, 1, 2, 2, 3]);
    expect(entranceAt(ENTRANCE_MS).view).toEqual([18, 8]);
    // The turn only ever moves east.
    let previous = -Infinity;
    for (let t = 0; t <= ENTRANCE_MS; t += 100) {
      const lon = entranceAt(t).view[0];
      expect(lon).toBeGreaterThanOrEqual(previous);
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

  it('reads a survey as counts, never a frequency', () => {
    const survey = { lat: 7.38, lon: 3.9, ac: 3028, an: 19012, radiusKm: 6 };
    const text = describeHit(
      { type: 'surveys', surveys: [survey], x: 0, y: 0 },
      'modeled',
    );
    expect(text).toBe(
      'Measured survey · 3,028 of 19,012 alleles carry HbS · Location within ±6 km',
    );
    const many = describeHit(
      {
        type: 'surveys',
        surveys: [survey, { ...survey, ac: 0, an: 40 }, survey, survey],
        x: 0,
        y: 0,
      },
      'modeled',
    );
    expect(many).toBe(
      '4 surveys here · 3,028 of 19,012 alleles · 0 of 40 · 3,028 of 19,012 · …',
    );
  });

  it('gives a modeled area its range and distance, and no number where there is no estimate', () => {
    const area = {
      boundary: [],
      center: [17.5, -8.4] as [number, number],
      mean: 0.1603,
      lo: 0.0716,
      hi: 0.2804,
      distanceKm: 95,
      support: 'interpolated' as const,
      tier: 'strong' as const,
    };
    expect(describeHit({ type: 'area', area, x: 0, y: 0 }, 'modeled')).toBe(
      'Modeled estimate about 16% · 95% credible range across this area 7.2–28% · Nearest survey about 95 km',
    );
    expect(
      describeHit(
        {
          type: 'area',
          area: { ...area, tier: 'weak', distanceKm: 1100 },
          x: 0,
          y: 0,
        },
        'modeled',
      ),
    ).toContain(
      'Far from surveys: this range leans on the model’s assumptions.',
    );
    const unknown = {
      ...area,
      mean: null,
      lo: null,
      hi: null,
      support: 'unknown' as const,
      tier: 'none' as const,
      distanceKm: 1555,
    };
    for (const layer of ['measured', 'modeled', 'evidence'] as const)
      expect(
        describeHit({ type: 'area', area: unknown, x: 0, y: 0 }, layer),
      ).toBe('No estimate · — · Nearest survey about 1,555 km');
    // A coarsened area can be mostly unsupported while its median distance is just inside the
    // weak tier (3 of the globe’s 649, at 1,312–1,349 km): its readout states its own distance, never a rule
    // it does not meet.
    const edge = { ...unknown, tier: 'weak' as const, distanceKm: 1312 };
    expect(
      describeHit({ type: 'area', area: edge, x: 0, y: 0 }, 'modeled'),
    ).toBe('No estimate · — · Nearest survey about 1,312 km');
    // The measured layer draws no values, so its readout gives none.
    expect(
      describeHit({ type: 'area', area, x: 0, y: 0 }, 'measured'),
    ).not.toMatch(/\d%/);
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

    fade('evidence');
    frame();
    frame();
    expect(calls.at(-1)?.[0]).toBe('evidence');
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
    fade('evidence');
    for (const callback of queue.splice(0)) callback((now += 16));
    fade('modeled', true);
    expect(calls.at(-1)).toEqual(['modeled', 1]);
    // The cancelled fade never draws Evidence again.
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
    fade('evidence');
    expect(calls).toEqual([['evidence', 1]]);
    expect(queue).toHaveLength(0);
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
