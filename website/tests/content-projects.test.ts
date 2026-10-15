/**
 * Projects page content (round 2 spec §4.2, §6, §11.1; rulings R2-4, R2-14, R2-15, R2-16, 35–39;
 * the owner's restructure of 2026-10-15; #454). Owned by the Projects task.
 *
 * The built page opens on the project index (the genomeOS Atlas, live and in development, and an
 * honest "more to come"), then the Atlas chapter: an overview of the essentials (about 80 words, the
 * pill, the mark and its key, three pinned totals), and four sections closed by default, each a
 * summary row with an icon, an h3 and a teaser: hemoglobin S, applications, how it works (join-up,
 * counts, pipeline, safeguards) and where it stands. Eight concept sections with one figure each;
 * round 1's ids; counts in people; no validation caveat or status tag but "Example"; US English.
 * The HbS threshold figure's outline classes are checked against the decoded figure data.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  classifyArea,
  describeHit,
  formatPercent,
  sameHit,
  thresholdCounts,
  valueText,
} from '../src/components/project/hbs-map';
import {
  DEFAULT_STOP,
  GENOTYPE_ORDER,
  RECOLOUR_MS,
  THRESHOLD_STOPS,
  areaFill,
  genotypeArea,
  genotypeDomain,
  genotypeShare,
  muteColor,
  rangeLabel,
  shareInterval,
  stopText,
  thresholdLabel,
} from '../src/components/project/hbs-genotypes';
import { ENC, vsupColor } from '../src/graphics/encoding';
import {
  decodeAreas,
  decodeSurveys,
  type Area,
  type Survey,
} from '../src/graphics/figure-data';
import { corpusMetrics } from '../src/data/corpusMetrics';
import { builtHtml } from './helpers/dist';

const project = builtHtml('projects');
const corpusRevision = corpusMetrics.sourceRevision;
const website = path.resolve(import.meta.dirname, '..');
const figures = path.join(website, 'src/data/figures');
const provenance = JSON.parse(
  readFileSync(path.join(figures, 'hbs.provenance.json'), 'utf8'),
) as {
  hf_revision: string;
  tier_limits_km: { weak: number };
  metric_domain: { post_mean: [number, number] };
  files: Record<string, { name: string }>;
  table: {
    region_thresholds: {
      threshold: number;
      confidently_above: number;
      possibly_above: number;
    }[];
  };
};
const catalog = JSON.parse(
  readFileSync(path.join(website, 'public/data/atlas/catalog.json'), 'utf8'),
) as { artifacts: unknown[] };

/** The outer HTML of the figure whose data-graphic is `name` (figures never nest). */
function figure(name: string): string {
  const at = project.indexOf(`data-graphic="${name}"`);
  if (at === -1) return '';
  const start = project.lastIndexOf('<figure', at);
  const end = project.indexOf('</figure>', at);
  return project.slice(start, end + '</figure>'.length);
}

/** A collapsed section of the Atlas chapter, by its data-acc name. */
function section(name: string): string {
  const at = project.indexOf(`data-acc="${name}"`);
  if (at === -1) return '';
  const start = project.lastIndexOf('<details', at);
  // Sections never nest, but a section holds inner <details> ("View as table"): count them.
  let depth = 0;
  const tag = /<(\/?)details\b/g;
  tag.lastIndex = start;
  for (let match = tag.exec(project); match; match = tag.exec(project)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0)
      return project.slice(start, match.index + '</details>'.length);
  }
  return '';
}

/** Every section's summary row, in order. */
const summaries = () =>
  [
    ...project.matchAll(/<summary class="acc__summary">([\s\S]*?)<\/summary>/g),
  ].map(([, inner]) => inner);

/** The Atlas overview, from the chapter's start to its first section. */
const overviewHtml = () => {
  const start = project.indexOf('class="atlas-ov"');
  const end = project.indexOf('class="acc-list"');
  return start === -1 || end === -1 ? '' : project.slice(start, end);
};

/** Text a reader sees or hears: tags, scripts and styles removed, character references decoded. */
const text = (html: string) =>
  html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

describe('projects page content', () => {
  it('opens with one h1, the Atlas chapter’s h2, and an h3 in each section’s summary', () => {
    expect(project.match(/<h1\b/g) ?? []).toHaveLength(1);
    const h1 = project.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)![1];
    // Sentence-style headlines end with a period (rulings, item 27; design critique of the
    // integrated build).
    expect(text(h1).trim()).toBe('What we’re building.');
    const h2s = [...project.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map(
      ([, inner]) => text(inner).trim(),
    );
    expect(h2s).toEqual(['genomeOS Atlas', 'Follow the work.']);
    const h3s = [...project.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].map(
      ([, inner]) => text(inner).trim(),
    );
    expect(h3s).toEqual([
      'Why hemoglobin S makes it tangible',
      'What it could be used for',
      'How it works',
      'Where it stands',
    ]);
    // Each section's h3 is its summary's title, so the outline survives the rows being closed.
    for (const summary of summaries())
      expect(summary).toMatch(/<h3\b[^>]*class="acc__title"/);
    // How it works holds its four parts as h4s, in order.
    const how = section('how');
    const parts = [
      ...how.matchAll(/<h4\b[^>]*class="h4-section"[^>]*>([\s\S]*?)<\/h4>/g),
    ].map(([, inner]) => text(inner).trim());
    expect(parts).toEqual([
      'From scattered tables to placed evidence',
      'Counts, not guesses',
      'From evidence to an explorable map',
      'Six rules the interface cannot hide',
    ]);
    // The chapter's wordmark is set in the brand face.
    expect(project).toMatch(
      /<h2\b[^>]*>\s*<span class="brand-name">genomeOS<\/span> Atlas\s*<\/h2>/,
    );
  });

  it('keeps the chapter’s detail in four sections, closed by default, each a summary row', () => {
    const tags = [...project.matchAll(/<details\b[^>]*class="acc"[^>]*>/g)].map(
      ([tag]) => tag,
    );
    expect(tags.map((tag) => tag.match(/data-acc="([^"]+)"/)?.[1])).toEqual([
      'hbs',
      'uses',
      'how',
      'status',
    ]);
    for (const tag of tags) expect(tag).not.toMatch(/\bopen\b/);
    const rows = summaries().map((summary) => ({
      icon: /<span class="acc__icon" aria-hidden="true">\s*<svg\b/.test(
        summary,
      ),
      chevron: /<svg class="acc__chevron"[^>]*aria-hidden="true"/.test(summary),
      teaser: text(
        summary.match(/<span class="acc__teaser">([\s\S]*?)<\/span>/)![1],
      ).trim(),
    }));
    expect(rows).toEqual([
      {
        icon: true,
        chevron: true,
        teaser:
          'One variant, three genotypes, and where each is expected among births.',
      },
      {
        icon: true,
        chevron: true,
        teaser: 'Screening, diagnosis, trials, and where to sample next.',
      },
      {
        icon: true,
        chevron: true,
        teaser:
          'From scattered tables to a map, with rules that keep it honest.',
      },
      {
        icon: true,
        chevron: true,
        teaser: 'What is available now, in development and further out.',
      },
    ]);
    // The old chapter chips are gone: the rows are the chapter's navigation.
    expect(project).not.toContain('aria-label="genomeOS Atlas sections"');
  });

  it('opens the Atlas chapter on an overview of the essentials, in about 80 words', () => {
    const overview = text(
      overviewHtml().replace(/<details\b[\s\S]*?<\/details>/, (block) =>
        block.replace(/<div>[\s\S]*<\/div>/, ''),
      ),
    ).trim();
    const words = overview.match(/[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu) ?? [];
    expect(words.length, overview).toBeLessThanOrEqual(80);
    for (const line of [
      'Project 1',
      'Where a genetic variant is common shapes who is offered screening, how a test result is read and where a study can recruit.',
      'The Atlas maps variants on an interactive globe. Pick one, inspect any place and see where evidence is thin.',
      'The live Atlas: HbS frequency, low to high.',
      'How we count',
    ])
      expect(overview).toContain(line);
    // The pill opens the Atlas on the HbS map the picture shows, as Home's pill does (design
    // critique of the integrated build, round 2).
    expect(overviewHtml()).toMatch(
      /<a class="atlas-open" href="\/app\/\?entity=hbs-rs334&amp;palette=genome">[\s\S]*?Open the <span class="brand-name">genomeOS<\/span> Atlas/,
    );
    // The one visual is the product itself (design critique of the integrated build): a still of
    // the live Atlas on its HbS map, a WebP sized to its column, loaded lazily, described in
    // its alt text; not the index's mark again.
    const visual = overviewHtml().match(
      /<figure class="atlas-ov__visual"[\s\S]*?<\/figure>/,
    )![0];
    expect(visual).toMatch(/<source[^>]*type="image\/webp"/);
    expect(visual).not.toMatch(/\.png\b/);
    const still = visual.match(/<img\b[^>]*>/)![0];
    expect(still).toContain('loading="lazy"');
    expect(still).toMatch(
      /\bwidth="\d+"[^>]*\bheight="\d+"|\bheight="\d+"[^>]*\bwidth="\d+"/,
    );
    expect(still).toMatch(
      /alt="The genomeOS Atlas showing the sickle-cell variant HbS[^"]+"/,
    );
    // Nothing in it looks clickable but is not: the picture opens the map it shows, and its key is
    // a line of HTML, not app chrome baked into the image (round 2 of that critique).
    expect(visual).toMatch(
      /<a class="atlas-ov__still-link" href="\/app\/\?entity=hbs-rs334&amp;palette=genome">\s*<picture\b/,
    );
    expect(visual).toMatch(/<span class="atlas-ov__ramp">/);
    expect(overviewHtml()).not.toContain('atlas-mark');
  });

  // Design critique 3: the still sat in a black box. It is the globe's disc now, with alpha, so it
  // sits on the band with no rectangle round it.
  it('cuts the still to the globe’s disc: clear corners, a whole globe', async () => {
    const { data, info } = await sharp(
      path.resolve(
        import.meta.dirname,
        '../src/assets/projects/atlas-hbs.webp',
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(info.height);
    const alpha = (x: number, y: number) =>
      data[(y * info.width + x) * info.channels + 3];
    const last = info.width - 1;
    for (const [x, y] of [
      [0, 0],
      [last, 0],
      [0, last],
      [last, last],
    ])
      expect(alpha(x, y), `corner ${x},${y}`).toBe(0);
    const middle = Math.floor(info.width / 2);
    expect(alpha(middle, middle)).toBe(255);
    // The disc reaches its box: opaque a few pixels in from each edge's midpoint.
    for (const [x, y] of [
      [middle, 4],
      [middle, last - 4],
      [4, middle],
      [last - 4, middle],
    ])
      expect(alpha(x, y), `edge ${x},${y}`).toBe(255);
  });

  it('gives three key facts, pinned to the corpus revision, and how they are counted', () => {
    const totals = [
      ...overviewHtml().matchAll(/<data\b([^>]*)>([^<]*)<\/data>/g),
    ];
    expect(totals.map((match) => match[2])).toEqual(['4,392', '6.69M', '2']);
    for (const [, attributes] of totals) {
      expect(attributes).not.toContain('aria-hidden');
      expect(attributes).not.toContain('data-count-to');
    }
    const words = text(overviewHtml());
    // Qualified, so it is not read against the status rail's markers with modeled maps (design
    // critique of the integrated build).
    expect(words).toContain('Variants & alleles in the source tables');
    expect(words).toContain('People represented, not deduplicated');
    expect(words).toContain('Diseases represented');
    expect(overviewHtml()).toMatch(
      /<summary[^>]*>\s*How we count\s*<\/summary>/,
    );
    expect(overviewHtml()).toContain(corpusRevision);
    // Stated once: the status rail no longer repeats them.
    expect(figure('status-rail')).not.toContain('<data');
  });

  it('keeps every round-1 fragment the /project/ redirect forwards', () => {
    for (const id of [
      'projects',
      'atlas',
      'hbs',
      'hbs-title',
      'applications',
      'join-up',
      'counts',
      'safeguards',
      'safeguards-title',
      'pipeline',
      'pipeline-title',
      'process-title',
      'status',
      'status-title',
      'follow-title',
    ])
      expect(project, id).toContain(`id="${id}"`);
    expect(project).not.toContain('id="vision"');
  });

  it('opens eight concept sections in the chapter’s order, each holding one figure', () => {
    const sections = [
      ...project.matchAll(/<(?:section|div)\b[^>]*\bdata-concept\b[^>]*>/g),
    ].map(([tag]) => tag.match(/\bid="([^"]+)"/)?.[1]);
    expect(sections).toEqual([
      'projects',
      'hbs',
      'applications',
      'join-up',
      'counts',
      'pipeline',
      'safeguards',
      'status',
    ]);
    for (const name of [
      'project-index',
      'hbs-threshold',
      'applications',
      'join-up',
      'counts',
      'pipeline',
      'safeguards',
      'status-rail',
    ])
      expect(figure(name), name).not.toBe('');
    expect(project).not.toContain('data-graphic="scale-ladder"');
    // Every concept but the index sits inside its collapsed section.
    for (const [name, ids] of [
      ['hbs', ['hbs']],
      ['uses', ['applications']],
      ['how', ['join-up', 'counts', 'pipeline', 'safeguards']],
      ['status', ['status']],
    ] as const)
      for (const id of ids) expect(section(name), id).toContain(`id="${id}"`);
  });

  // Design critique of the integrated build: the index repeated the overview right below it (the
  // mark, the name, an Open button and "Read more"). It is a compact list: each project's name, its
  // status and one line, and "Share an idea" for the next one.
  it('indexes the projects in a compact list: the Atlas, live and in development, then more to come', () => {
    const index = figure('project-index');
    const words = text(index);
    expect(words).toContain('genomeOS Atlas');
    expect(words).toContain('Live, in development');
    expect(words).toContain(
      'Scattered genetic data, placed and modeled on one open map.',
    );
    expect(words).toContain('Next project');
    expect(words).toContain('More to come');
    expect(words).toContain('Every project starts as a community idea.');
    // No mark, no Open button and no "Read more": the Atlas's name links to its chapter.
    expect(index).not.toMatch(/<svg class="atlas-mark/);
    expect(index).not.toMatch(/Open the Atlas|Read more/);
    expect(index).not.toMatch(/href="\/app\/"/);
    expect(index).toMatch(
      /<a href="#atlas"><span class="brand-name">genomeOS<\/span> Atlas<\/a>/,
    );
    expect(index).toMatch(
      /href="https:\/\/github\.com\/genomeOS\/genomeOS\/discussions"[^>]*target="_blank"[^>]*>\s*Share an idea/,
    );
    // Card titles are styled paragraphs, so "genomeOS Atlas" is not a second heading.
    expect(index).not.toMatch(/<h[1-6]\b/);
    // No wordmark inside a call to action (round 1 §2.3).
    expect(index).not.toMatch(
      /class="button-link"[^>]*>[^<]*<span class="brand-name"/,
    );
  });

  it('labels current work, active work, and future ideas separately', () => {
    expect(project).toMatch(
      /Available now[\s\S]*In active development[\s\S]*Future exploration/,
    );
    expect(project).toMatch(
      /Future exploration[\s\S]*privacy[\s\S]*consent[\s\S]*governance/,
    );
    expect(project).toContain('ancient-DNA time slider');
    expect(text(figure('status-rail'))).toContain('Agentic literature search');
    expect(project).not.toContain('Literature evidence');
  });

  it('states the scientific publication bar without a scare label', () => {
    expect(project).toMatch(/HbS[\s\S]*G6PD[\s\S]*screening/);
    // "hemoglobin S" is one name: a no-break space keeps the S off the start of a line.
    expect(project).toMatch(
      /Why hemoglobin(?:&nbsp;|&#160;|\u00a0)S makes it tangible/,
    );
    expect(project).toMatch(/population-location registry/i);
    expect(project).toMatch(/interactive public map/i);
    // The HbS gate line is cut; the Pipeline's gate node and the status rail carry the bar.
    expect(project).not.toContain('A plausible map is not success');
    expect(project).not.toMatch(/not yet validated/i);
    expect(project).not.toContain('data-status="not-validated"');
  });

  it('replays the Pipeline from a glyph with a hidden name, never visible “Replay” (ruling 35)', () => {
    const pipeline = figure('pipeline');
    const [button, inner] = pipeline.match(
      /<button\b[^>]*data-pipeline-replay[^>]*>([\s\S]*?)<\/button>/,
    )!;
    expect(button).toContain('kit-scene-control');
    expect(inner).toMatch(/<svg\b[^>]*aria-hidden="true"/);
    expect(inner).toMatch(
      /<span class="visually-hidden">Replay the pipeline animation<\/span>/,
    );
    // No button on the page shows Pause, Play, Replay or Resume as text.
    const shown = [...project.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
      .map(([, html]) =>
        text(
          html.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, ''),
        ).trim(),
      )
      .filter((label) => /\b(Pause|Play|Replay|Resume)\b/.test(label));
    expect(shown).toEqual([]);
  });

  it('names the model plainly and describes the gate as R2-14 asks', () => {
    // "Machine learning" under Frequency modeling (round 2 spec §4.2.6), so Home's "Build AI
    // models" step has a visible referent here.
    expect(text(figure('pipeline'))).toMatch(
      /Frequency modeling\s+Machine learning/,
    );
    expect(project).toContain(
      'Results are checked against published HbS, G6PD and carrier-screening estimates.',
    );
    // No limitation announcements on a marketing page (ruling 37): no validation caveat anywhere.
    expect(text(project)).not.toMatch(/validated/i);
    expect(project).toContain(
      'Bayesian spatial models, a kind of machine learning, are fitted ahead of time and published as versioned results.',
    );
  });

  it('speaks US English', () => {
    for (const word of [/haemoglobin/i, /programmes/i, /Behaviour/, /coloured/])
      expect(text(project)).not.toMatch(word);
    expect(text(project)).toContain('Screening programs');
    expect(text(project)).toContain('Behavior');
    expect(text(project)).toContain(
      'Too little evidence is hatched, never colored.',
    );
  });

  it('opens Process on the join-up: five outcomes, no numbers, no label saying what it is', () => {
    const joinUp = figure('join-up');
    // The owner (2026-10-15): a drawing needs no "Schematic" tag to say so.
    expect(joinUp).not.toContain('kit-status-tag');
    expect(text(joinUp)).not.toContain('Schematic');
    expect(joinUp).toContain('From scattered tables to placed evidence');
    for (const outcome of [
      'Placed',
      'Placed, country-wide',
      'Context only, not a place',
      'Refused: no count',
      'Build fails: no place',
    ])
      expect(text(joinUp)).toContain(outcome);
    expect(joinUp).toContain('title="allele count"');
    expect(joinUp).toContain('title="alleles tested"');
    // A schematic holds no data, so it shows no number at all (spec §6.1 rule 9).
    expect(text(joinUp)).not.toMatch(/\d/);
  });

  it('notes that the HbS map is simplified, links the live map and cites its provenance', () => {
    const hbs = figure('hbs-threshold');
    expect(hbs).not.toContain('kit-status-tag');
    const note = hbs.match(
      /<div class="figure-note\b[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    )![1];
    expect(text(note)).toContain('Simplified from the Atlas’s HbS data.');
    expect(note).toMatch(
      /href="\/app\/\?entity=hbs-rs334&amp;palette=genome"[^>]*>\s*See it live in the Atlas/,
    );
    const footnote = hbs.match(
      /<p class="kit-figure__footnote"[^>]*>([\s\S]*?)<\/p>/,
    )![1];
    expect(footnote).toContain(provenance.hf_revision.slice(0, 7));
    expect(text(footnote)).toContain('coarsened for display');
    expect(footnote).not.toContain('<a');
    // Server-rendered for AS, the triad's default: its slider at 10% of births (stop 9 of 0–19)
    // and the count there, from the pinned data.
    const regionAreas = decodeAreas(
      readFileSync(path.join(figures, provenance.files.region.name)),
    );
    const atDefault = thresholdCounts(
      regionAreas.map((area) => genotypeArea(area, 'AS')),
      DEFAULT_STOP.AS / 100,
    );
    expect(atDefault.confident).toBeGreaterThan(0);
    expect(text(hbs)).toMatch(
      new RegExp(
        `${atDefault.confident} confidently above ?, ${atDefault.possible} possibly above`,
      ),
    );
    expect(hbs).toMatch(/type="range"[^>]*min="0"[^>]*max="19"/);
    expect(hbs).toMatch(/type="range"[^>]*value="9"/);
    expect(hbs).toContain('aria-valuetext="10 percent:');
    expect(hbs).toMatch(/data-hbs-genotype="AS"/);
    expect(text(hbs)).toContain('Show areas where AS births are at least 10%');
    // As the label reads, tags dropped without adding spaces: every word stands apart, and the
    // threshold ends the sentence (design critique of the integrated build, round 2).
    const label = hbs.match(
      /<label class="hbs__slider-label"[^>]*>([\s\S]*?)<\/label>/,
    )![1];
    expect(
      label
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe('Show areas where AS births are at least 10%');
    // Each clause of the count is a line of its own, its number in a fixed column, so a new number
    // never moves the words (ruling 36).
    expect(hbs).toMatch(
      /data-hbs-count[^>]*>\s*<span class="hbs__clause"><b>[\d,]+<\/b> confidently above<span class="visually-hidden">, <\/span>\s*<\/span>\s*<span class="hbs__clause"><b>[\d,]+<\/b> possibly above<\/span>\s*<\/p>/,
    );
    expect(text(hbs)).toContain('Usual hemoglobin');
  });

  it('keys the HbS fill by genotype, value and distance from surveys, and the studs by people', () => {
    const html = figure('hbs-threshold');
    const hbs = text(html);
    // One plain caption says what the map shows (ruling 36).
    expect(hbs).toContain(
      'Expected share of births, from the modeled frequency',
    );
    // Each genotype keys its own ramp and range, rounded from the data; the VSUP wedge still tells
    // low share and little evidence apart.
    for (const line of [
      'AA: 68–100% of births',
      'AS: 0–29% of births',
      'SS: 0–3% of births',
    ])
      expect(hbs).toContain(line);
    expect(hbs).toContain('Fades away from surveys');
    expect(hbs).not.toContain('Modeled frequency, 0–17%');
    // The muted state, in words as well as grey.
    expect(html).toMatch(/data-hbs-muted-key[^>]*>Below 10%</);
    expect(hbs).toContain('No estimate');
    expect(hbs).toContain('Survey, sized by people tested');
    expect(hbs).not.toContain('AC of AN');
    expect(hbs).toContain('Tap to inspect.');
  });

  it('describes each genotype’s map, and tables it, with the random-mating assumption', () => {
    const html = figure('hbs-threshold');
    const map = html.match(/<div class="hbs__map"[^>]*>/)![0];
    const alt = (genotype: string) =>
      map.match(new RegExp(`data-alt-${genotype.toLowerCase()}="([^"]+)"`))![1];
    expect(map).toMatch(/aria-label="[^"]*\(AS\)[^"]*"/);
    for (const genotype of ['AA', 'AS', 'SS']) {
      expect(alt(genotype)).toContain(`(${genotype})`);
      expect(alt(genotype)).toContain('assuming random mating');
      expect(alt(genotype)).toContain('measured surveys');
      expect(alt(genotype)).toMatch(/hatched/);
    }
    expect(alt('AS')).toMatch(/highest, about 28 percent, in Central Africa/);
    expect(alt('AA')).toMatch(/lowest, about 69 percent, in Central Africa/);
    const tables = [
      ...html.matchAll(
        /<table\b[^>]*data-variant="(A[AS]|SS)"[\s\S]*?<\/table>/g,
      ),
    ];
    expect(tables.map((match) => match[1])).toEqual(['AA', 'AS', 'SS']);
    for (const [table, genotype] of tables) {
      const caption = text(
        table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)![1],
      );
      expect(caption).toContain(`(${genotype})`);
      expect(caption).toContain('assuming random mating (Hardy–Weinberg)');
      expect(table.match(/<tr>/g) ?? []).toHaveLength(4);
    }
  });

  it('counts the Atlas markers from the catalog', () => {
    expect(text(project)).toContain(
      `The Atlas: observations and surfaces for ${catalog.artifacts.length} markers`,
    );
  });

  it('lists six applications, with horizons only where a status applies', () => {
    const apps = figure('applications');
    const cards = [...apps.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(
      ([card]) => text(card).trim(),
    );
    expect(cards).toEqual([
      'Screening programs First release Where carrier screening would help most.',
      'Diagnostic context Clinical validation needed Regional context before a genetic test.',
      'Trial planning Where a study could find enough carriers.',
      'The map of what we don’t know Where the next sample matters most.',
      'Medicines and drug response Future exploration Variants that change a dose.',
      'Research and discovery Patterns worth testing.',
    ]);
    // No caveat line over the cards (rulings, item 37; design critique of the integrated build):
    // the figure's caption only says what it shows.
    expect(text(apps)).not.toContain('context, not a diagnosis');
    expect(apps).toMatch(
      /<figcaption class="visually-hidden">\s*Six uses for the Atlas, from screening programs to research\.\s*<\/figcaption>/,
    );
    expect(project).toMatch(
      /href="https:\/\/github\.com\/genomeOS\/genomeOS\/discussions\/1"[\s\S]{0,200}Suggest an application/,
    );
  });

  it('replaces the old safeguard 4 with the Docs rule it can back', () => {
    const safeguards = text(figure('safeguards'));
    expect(safeguards).toContain('Assumptions remain explicit');
    expect(safeguards).toContain(
      'No convenient defaults for places, recruitment or denominators.',
    );
    expect(safeguards).toContain('No default');
    expect(safeguards).not.toContain('Sampling corrections');
    expect(project).toMatch(
      /href="\/docs\/scientific-safeguards\/"[^>]*>\s*Safeguards in Docs/,
    );
  });
});

describe('HbS threshold outlines', () => {
  const areas = decodeAreas(
    readFileSync(path.join(figures, provenance.files.region.name)),
  );

  it('never outlines an area with no estimate, at any stop', () => {
    for (const stop of THRESHOLD_STOPS.AS)
      for (const area of areas.filter((entry) => entry.support === 'unknown'))
        expect(classifyArea(area, stop / 100)).toBeNull();
  });

  it('keeps confidently above inside "the estimate is above", and apart from possibly above', () => {
    for (const stop of THRESHOLD_STOPS.AS) {
      const t = stop / 100;
      for (const area of areas) {
        const kind = classifyArea(area, t);
        if (kind === 'confident') {
          expect(area.lo!).toBeGreaterThanOrEqual(t);
          expect(area.mean!).toBeGreaterThanOrEqual(t);
        } else if (kind === 'possible') {
          expect(area.mean!).toBeGreaterThanOrEqual(t);
          expect(area.lo!).toBeLessThan(t);
        } else if (area.mean !== null) {
          expect(area.mean).toBeLessThan(t);
        }
      }
      const counts = thresholdCounts(areas, t);
      const above = areas.filter(
        (area) => area.mean !== null && area.mean >= t,
      ).length;
      expect(counts.confident + counts.possible).toBe(above);
    }
  });

  it('matches the counts pinned in the figure provenance', () => {
    for (const row of provenance.table.region_thresholds)
      expect(thresholdCounts(areas, row.threshold)).toEqual({
        confident: row.confidently_above,
        possible: row.possibly_above,
      });
  });
});

describe('HbS readouts', () => {
  const areas = decodeAreas(
    readFileSync(path.join(figures, provenance.files.region.name)),
  );
  const read = (area: Area, genotype: 'AA' | 'AS' | 'SS' = 'AS') =>
    describeHit({ type: 'area', area, x: 0, y: 0 }, genotype);
  const unknown = (distanceKm: number): Area => ({
    boundary: [],
    center: [0, 0],
    mean: null,
    lo: null,
    hi: null,
    distanceKm,
    support: 'unknown',
    tier: 'none',
  });
  const modeled = (
    mean: number,
    lo: number,
    hi: number,
    distanceKm: number,
    tier: Area['tier'],
  ): Area => ({
    boundary: [],
    center: [0, 0],
    mean,
    lo,
    hi,
    distanceKm,
    support: 'interpolated',
    tier,
  });
  const survey = (ac: number, an: number, radiusKm = 25): Survey => ({
    lat: 0,
    lon: 0,
    ac,
    an,
    radiusKm,
  });

  it('gives an area with no estimate its own distance, never a survey-free radius', () => {
    // A coarsened area takes its children's majority support and their median distance, so a
    // minority child can sit nearer a survey: only "about" the area's own distance is safe
    // (copy deck, readout-unknown).
    expect(read(unknown(1352))).toBe(
      'No estimate · — · Nearest survey about 1,352 km',
    );
    for (const area of areas.filter((entry) => entry.support === 'unknown')) {
      expect(read(area)).toBe(
        `No estimate · — · Nearest survey about ${Math.round(area.distanceKm).toLocaleString('en-US')} km`,
      );
    }
  });

  it('reads an area out as the selected genotype’s expected share of births (ruling 36)', () => {
    const area = modeled(0.064, 0.018, 0.2, 1234.4, 'strong');
    // AS 2q(1 − q), SS q², AA (1 − q)²; for AA the range's ends swap.
    expect(read(area, 'AS')).toBe(
      'Modeled: AS in about 12% of births · 95% credible range across this area 3.5–32% · HbS frequency about 6.4% · Nearest survey about 1,234 km',
    );
    expect(read(area, 'SS')).toBe(
      'Modeled: SS in about 0.41% of births · 95% credible range across this area 0.03–4.0% · HbS frequency about 6.4% · Nearest survey about 1,234 km',
    );
    expect(read(area, 'AA')).toBe(
      'Modeled: AA in about 88% of births · 95% credible range across this area 64–96% · HbS frequency about 6.4% · Nearest survey about 1,234 km',
    );
    expect(read(modeled(0.12, 0, 0.31, 2500, 'weak'), 'AS')).toBe(
      'Modeled: AS in about 21% of births · 95% credible range across this area 0–43% · HbS frequency about 12% · Nearest survey about 2,500 km. Far from surveys: this range leans on the model’s assumptions.',
    );
    for (const genotype of GENOTYPE_ORDER)
      for (const entry of areas.filter(
        (candidate) => candidate.mean !== null,
      )) {
        const line = read(entry, genotype)!;
        // One percent sign closes the range, and nothing rounds to a bare "0.0" or a false 100.
        expect(line).toMatch(/range across this area [<>\d.]+–[<>\d.]+% · /);
        expect(line).not.toMatch(/\b0\.0(?!\d)/);
        expect(line).not.toMatch(/about 100%/);
      }
  });

  it('keeps an area with no estimate, and every survey, the same for every genotype', () => {
    for (const genotype of GENOTYPE_ORDER) {
      expect(read(unknown(1352), genotype)).toBe(
        'No estimate · — · Nearest survey about 1,352 km',
      );
      // Surveys are counts of gene copies, never genotypes: no share of births is derived.
      expect(
        describeHit(
          { type: 'surveys', surveys: [survey(3, 100)], x: 0, y: 0 },
          genotype,
        ),
      ).toBe(
        'Measured survey · 50 people tested; 3 of their 100 gene copies carry HbS · Location within ±25 km',
      );
    }
  });

  it('writes tiny and near-total shares without a false zero or a false 100', () => {
    expect(formatPercent(0)).toBe('0');
    expect(formatPercent(0.00004)).toBe('<0.01');
    expect(formatPercent(0.0041)).toBe('0.41');
    expect(formatPercent(0.064)).toBe('6.4');
    expect(formatPercent(0.876)).toBe('88');
    expect(formatPercent(0.9984)).toBe('99.8');
    expect(formatPercent(0.99996)).toBe('>99.9');
    expect(formatPercent(1)).toBe('100');
  });

  it('reads out surveys in people tested, keeping the copies as counts (R2-16)', () => {
    // HBB is autosomal: AN gene copies are AN/2 people, exactly. No carrier count is derived
    // from AC, which counts copies, not people.
    expect(
      describeHit(
        { type: 'surveys', surveys: [survey(3, 100)], x: 0, y: 0 },
        'AS',
      ),
    ).toBe(
      'Measured survey · 50 people tested; 3 of their 100 gene copies carry HbS · Location within ±25 km',
    );
    expect(
      describeHit(
        {
          type: 'surveys',
          surveys: [survey(3, 100), survey(5, 2000)],
          x: 0,
          y: 0,
        },
        'AS',
      ),
    ).toBe('2 surveys here · 50 and 1,000 people tested');
    expect(
      describeHit(
        {
          type: 'surveys',
          surveys: [1, 2, 3, 4].map((ac) => survey(ac, 50)),
          x: 0,
          y: 0,
        },
        'AS',
      ),
    ).toBe('4 surveys here · 25, 25 and 25 people tested · …');
    // Every number a multi-survey readout lists says what it counts (design review, round 3).
    expect(
      describeHit(
        {
          type: 'surveys',
          surveys: [survey(3, 1106), survey(5, 4026), survey(1, 2684)],
          x: 0,
          y: 0,
        },
        'AS',
      ),
    ).toBe('3 surveys here · 553, 2,013 and 1,342 people tested');
    for (const line of [
      describeHit(
        { type: 'surveys', surveys: [survey(1, 4)], x: 0, y: 0 },
        'AS',
      ),
    ])
      expect(line).not.toMatch(/alleles/);
  });

  it('only ever halves an even AN: every pinned survey counts whole people', () => {
    const surveys = decodeSurveys(
      readFileSync(path.join(figures, provenance.files.surveys.name)),
    );
    expect(surveys.length).toBeGreaterThan(1000);
    for (const entry of surveys) expect(entry.an % 2, `${entry.an}`).toBe(0);
  });

  it('treats the pointer as unmoved while it stays over the same area or studs', () => {
    const [a, b] = areas;
    const one = [survey(3, 100), survey(5, 200)];
    expect(sameHit(null, null)).toBe(true);
    expect(
      sameHit(
        { type: 'area', area: a, x: 1, y: 1 },
        { type: 'area', area: a, x: 9, y: 4 },
      ),
    ).toBe(true);
    expect(
      sameHit(
        { type: 'area', area: a, x: 1, y: 1 },
        { type: 'area', area: b, x: 1, y: 1 },
      ),
    ).toBe(false);
    expect(sameHit({ type: 'area', area: a, x: 1, y: 1 }, null)).toBe(false);
    expect(
      sameHit(
        { type: 'surveys', surveys: one, x: 5, y: 5 },
        { type: 'surveys', surveys: [...one], x: 5, y: 5 },
      ),
    ).toBe(true);
    // A different nearest stud, or another stud joining it, is a new readout.
    expect(
      sameHit(
        { type: 'surveys', surveys: one, x: 5, y: 5 },
        { type: 'surveys', surveys: [one[1], one[0]], x: 6, y: 5 },
      ),
    ).toBe(false);
    expect(
      sameHit(
        { type: 'surveys', surveys: one, x: 5, y: 5 },
        { type: 'surveys', surveys: [one[0]], x: 5, y: 5 },
      ),
    ).toBe(false);
    expect(
      sameHit(
        { type: 'surveys', surveys: one, x: 5, y: 5 },
        { type: 'area', area: a, x: 5, y: 5 },
      ),
    ).toBe(false);
  });
});

describe('HbS genotypes on the map (ruling 36)', () => {
  const areas = decodeAreas(
    readFileSync(path.join(figures, provenance.files.region.name)),
  );
  const domain = provenance.metric_domain.post_mean;

  it('gives each genotype its expected share of births from q, under random mating', () => {
    expect(genotypeShare('AA', 0.1)).toBeCloseTo(0.81, 12);
    expect(genotypeShare('AS', 0.1)).toBeCloseTo(0.18, 12);
    expect(genotypeShare('SS', 0.1)).toBeCloseTo(0.01, 12);
    for (const q of [0, 0.0008, 0.05, 0.173, 0.284, 0.5, 0.9, 1])
      expect(
        genotypeShare('AA', q) +
          genotypeShare('AS', q) +
          genotypeShare('SS', q),
      ).toBeCloseTo(1, 12);
    // The edges: no HbS at all, and the most mixed population.
    expect(GENOTYPE_ORDER.map((g) => genotypeShare(g, 0))).toEqual([1, 0, 0]);
    expect(GENOTYPE_ORDER.map((g) => genotypeShare(g, 0.5))).toEqual([
      0.25, 0.5, 0.25,
    ]);
    for (const q of [-0.01, 1.01, Number.NaN])
      expect(() => genotypeShare('AS', q)).toThrow(RangeError);
  });

  it('puts every range through the same transform: monotone below q = 0.5, the ends swapped for AA', () => {
    const [lo, hi] = [0.02, 0.1];
    expect(shareInterval('AS', lo, hi)).toEqual([
      genotypeShare('AS', lo),
      genotypeShare('AS', hi),
    ]);
    expect(shareInterval('SS', lo, hi)).toEqual([
      genotypeShare('SS', lo),
      genotypeShare('SS', hi),
    ]);
    expect(shareInterval('AA', lo, hi)).toEqual([
      genotypeShare('AA', hi),
      genotypeShare('AA', lo),
    ]);
    // q = 0 at the low end: AA reaches 100%, AS and SS start at 0.
    expect(shareInterval('AA', 0, 0.1)).toEqual([genotypeShare('AA', 0.1), 1]);
    expect(shareInterval('AS', 0, 0.1)[0]).toBe(0);
    // A range across q = 0.5 peaks at AS = 0.5 (not reached by these data, but exact).
    expect(shareInterval('AS', 0.4, 0.6)).toEqual([
      genotypeShare('AS', 0.4),
      0.5,
    ]);
    expect(shareInterval('AS', 0.5, 0.5)).toEqual([0.5, 0.5]);
    expect(() => shareInterval('AS', 0.2, 0.1)).toThrow(RangeError);
  });

  it('transforms every area of the pinned data, keeping lo ≤ mean ≤ hi and no estimate as none', () => {
    for (const genotype of GENOTYPE_ORDER)
      for (const area of areas) {
        const shown = genotypeArea(area, genotype);
        if (area.mean === null) {
          expect([shown.mean, shown.lo, shown.hi]).toEqual([null, null, null]);
          continue;
        }
        expect(shown.mean).toBeCloseTo(genotypeShare(genotype, area.mean), 12);
        expect(shown.lo!).toBeLessThanOrEqual(shown.mean! + 1e-12);
        expect(shown.mean!).toBeLessThanOrEqual(shown.hi! + 1e-12);
        expect([shown.lo, shown.hi]).toEqual(
          shareInterval(genotype, area.lo!, area.hi!),
        );
        // Geometry, support, tier and distance are the area's own.
        expect(shown.boundary).toBe(area.boundary);
        expect([shown.support, shown.tier, shown.distanceKm]).toEqual([
          area.support,
          area.tier,
          area.distanceKm,
        ]);
      }
    // The pinned data never reach q = 0.5, so every transform is monotone on them.
    expect(Math.max(...areas.map((area) => area.hi ?? 0))).toBeLessThan(0.5);
  });

  it('gives each genotype its own legend range, rounded from the data', () => {
    expect(rangeLabel(genotypeDomain('AA', domain))).toBe('68–100%');
    expect(rangeLabel(genotypeDomain('AS', domain))).toBe('0–29%');
    expect(rangeLabel(genotypeDomain('SS', domain))).toBe('0–3%');
  });

  it('offers per-genotype stops that never show an empty or an all-muted map', () => {
    expect(THRESHOLD_STOPS.AS).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(THRESHOLD_STOPS.SS.map(stopText)).toEqual(
      Array.from({ length: 20 }, (_, index) => stopText((index + 1) / 10)),
    );
    expect(THRESHOLD_STOPS.AA).toEqual(
      Array.from({ length: 20 }, (_, index) => 80 + index),
    );
    expect(DEFAULT_STOP).toEqual({ AA: 90, AS: 10, SS: 0.5 });
    for (const genotype of GENOTYPE_ORDER) {
      expect(THRESHOLD_STOPS[genotype]).toContain(DEFAULT_STOP[genotype]);
      // The same number of stops for every genotype: the slider never changes size.
      expect(THRESHOLD_STOPS[genotype]).toHaveLength(20);
      const shown = areas.map((area) => genotypeArea(area, genotype));
      for (const stop of THRESHOLD_STOPS[genotype]) {
        const t = stop / 100;
        const counts = thresholdCounts(shown, t);
        const muted = shown.filter(
          (area) => area.mean !== null && area.mean < t,
        ).length;
        expect(
          counts.confident + counts.possible,
          `${genotype} ${stop}`,
        ).toBeGreaterThan(0);
        expect(muted, `${genotype} ${stop}`).toBeGreaterThan(0);
      }
    }
  });

  it('labels the threshold in words true for the measure shown', () => {
    expect(thresholdLabel('AS', 10)).toBe(
      'Show areas where AS births are at least 10%',
    );
    expect(thresholdLabel('SS', 0.5)).toBe(
      'Show areas where SS births are at least 0.5%',
    );
    expect(thresholdLabel('SS', 1)).toBe(
      'Show areas where SS births are at least 1%',
    );
    expect(thresholdLabel('AA', 90)).toBe(
      'Show areas where AA births are at least 90%',
    );
    expect(valueText(0.5, { confident: 68, possible: 520 })).toBe(
      '0.5 percent: 68 areas confidently above, 520 possibly above',
    );
  });

  it('mutes areas below the threshold in a grey of the ramp, keeps the rest in colour, and never colors no estimate', () => {
    const t = DEFAULT_STOP.AS / 100;
    const shownDomain = genotypeDomain('AS', domain);
    let muted = 0;
    let full = 0;
    for (const area of areas) {
      const shown = genotypeArea(area, 'AS');
      const paint = areaFill(shown, t, shownDomain);
      if (shown.mean === null) {
        expect(paint).toEqual({ fill: null, muted: false });
        continue;
      }
      const ramp = vsupColor(
        shown.mean,
        shown.tier === 'none' ? 'weak' : shown.tier,
        shownDomain,
      )!;
      if (shown.mean < t) {
        expect(paint).toEqual({ fill: muteColor(ramp), muted: true });
        muted += 1;
      } else {
        expect(paint).toEqual({ fill: ramp, muted: false });
        full += 1;
      }
    }
    expect(muted).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
  });

  it('draws the muted state as a clearly greyer, darker version of each ramp colour', () => {
    const rgb = (hex: string) =>
      [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    const spread = (hex: string) =>
      Math.max(...rgb(hex)) - Math.min(...rgb(hex));
    const luminance = (hex: string) => {
      const [r, g, b] = rgb(hex).map((value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const colours = [...ENC.mean, ...ENC.meanPartial, ENC.meanWeak];
    for (const colour of colours) {
      const muted = muteColor(colour);
      expect(muted).toMatch(/^#[0-9a-f]{6}$/);
      expect(spread(muted), colour).toBeLessThanOrEqual(12);
      expect(spread(colour), colour).toBeGreaterThanOrEqual(40);
      expect(luminance(muted), colour).toBeLessThan(luminance(colour));
      // Never the hatch's grey, which means "no estimate".
      expect(muted).not.toBe(ENC.hatch);
      expect(luminance(muted)).toBeLessThan(luminance(ENC.hatch) / 2);
    }
    // The muted ramp keeps the ramp's order, faintly.
    const greys = ENC.mean.map((colour) => luminance(muteColor(colour)));
    for (let index = 1; index < greys.length; index += 1)
      expect(greys[index]).toBeGreaterThan(greys[index - 1]);
  });

  it('recolours within 300 ms', () => {
    expect(RECOLOUR_MS).toBeGreaterThan(0);
    expect(RECOLOUR_MS).toBeLessThanOrEqual(300);
  });
});
