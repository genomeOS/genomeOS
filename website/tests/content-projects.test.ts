/**
 * Projects page content (round 2 spec §4.2, §6, §11.1; rulings R2-4, R2-14, R2-15, R2-16; #454).
 * Owned by the Projects task.
 *
 * The built page opens on the project index (the genomeOS Atlas, live and in development, and an
 * honest "more to come"), then the Atlas's chapter: Purpose (HbS, applications), Process (join-up,
 * counts, pipeline, safeguards) and Status, with eight concept sections and one figure each. It
 * keeps round 1's ids, writes counts in people, carries no "Not yet validated" tag (a plain note and
 * a link to the Atlas instead) and speaks US English. The HbS threshold figure's two outline classes
 * are checked against the decoded figure data at every slider stop.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  THRESHOLD_STOPS,
  classifyArea,
  describeHit,
  sameHit,
  thresholdCounts,
} from '../src/components/project/hbs-map';
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
  it('opens with one h1, the Atlas chapter’s h2 and an h3 for each of its sections', () => {
    expect(project.match(/<h1\b/g) ?? []).toHaveLength(1);
    const h1 = project.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)![1];
    expect(text(h1).trim()).toBe('What we’re building');
    const h2s = [...project.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map(
      ([, inner]) => text(inner).trim(),
    );
    expect(h2s).toEqual(['genomeOS Atlas', 'Follow the work']);
    const h3s = [...project.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].map(
      ([, inner]) => text(inner).trim(),
    );
    expect(h3s).toEqual([
      'Why hemoglobin S makes the mission tangible',
      'From scattered evidence to better decisions.',
      'From scattered tables to placed evidence',
      'Counts, not guesses.',
      'From evidence to an explorable map',
      'Six rules the interface cannot hide',
      'What exists—and what comes later',
    ]);
    // The chapter's wordmark is set in the brand face.
    expect(project).toMatch(
      /<h2\b[^>]*>\s*<span class="brand-name">genomeOS<\/span> Atlas\s*<\/h2>/,
    );
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
  });

  it('indexes the projects: the Atlas, live and in development, then more to come', () => {
    const index = figure('project-index');
    const words = text(index);
    expect(words).toContain('genomeOS Atlas');
    expect(words).toContain('Live, in development');
    expect(words).toContain(
      'Genetic data sit scattered in papers and databases. The Atlas places them, models what they support and shows the gaps.',
    );
    expect(words).toContain('Next project');
    expect(words).toContain('More to come');
    expect(words).toContain('Every project starts as a community idea.');
    expect(index).toMatch(/href="\/app\/"[^>]*>\s*Open the Atlas/);
    expect(index).toMatch(/href="#atlas"[^>]*>\s*Read more/);
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

  it('jumps to Purpose, Process and Status from the chapter opener', () => {
    const nav = project.match(
      /<nav\b[^>]*aria-label="genomeOS Atlas sections"[^>]*>([\s\S]*?)<\/nav>/,
    )![1];
    const links = [...nav.matchAll(/href="([^"]+)"[^>]*>([^<]+)</g)].map(
      ([, href, label]) => `${label.trim()} ${href}`,
    );
    expect(links).toEqual([
      'Purpose #hbs',
      'Process #join-up',
      'Status #status',
    ]);
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
      /Why hemoglobin(?:&nbsp;|&#160;| )S makes the mission tangible/,
    );
    expect(project).toMatch(/population-location registry/i);
    expect(project).toMatch(/interactive public map/i);
    // The HbS gate line is cut; the Pipeline's gate node and the status rail carry the bar.
    expect(project).not.toContain('A plausible map is not success');
    expect(project).not.toMatch(/not yet validated/i);
    expect(project).not.toContain('data-status="not-validated"');
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
    // The no-JS count and the table come from the pinned data. The default threshold is 5%: at
    // 10% no area's whole conservative range clears it, so the solid outline and its legend key
    // would show nothing at rest.
    const atDefault = provenance.table.region_thresholds.find(
      (row) => row.threshold === 0.05,
    )!;
    expect(atDefault.confidently_above).toBeGreaterThan(0);
    expect(text(hbs)).toContain(
      `${atDefault.confidently_above} confidently above · ${atDefault.possibly_above} possibly above`,
    );
    expect(hbs).toMatch(/type="range"[^>]*min="1"[^>]*max="15"/);
    expect(hbs).toMatch(/type="range"[^>]*value="5"/);
    expect(hbs).toContain('aria-valuetext="5 percent:');
    // Each clause of the count is its own span, so a line breaks only at the " · ".
    expect(hbs).toMatch(
      /data-hbs-count[^>]*>\s*<span[^>]*>[\d,]+ confidently above<\/span> · <span[^>]*>[\d,]+ possibly above<\/span>\s*<\/p>/,
    );
    expect(text(hbs)).toContain('Usual hemoglobin');
  });

  it('keys the HbS fill by value and by distance from surveys, and the studs by people', () => {
    const hbs = text(figure('hbs-threshold'));
    // The VSUP wedge: low frequency and little evidence are told apart (spec §0, correction 2).
    expect(hbs).toContain('Modeled frequency, 0–17% Fades away from surveys');
    expect(hbs).toContain('Survey, sized by people tested');
    expect(hbs).not.toContain('AC of AN');
    expect(hbs).toContain('Tap to inspect.');
  });

  it('counts the Atlas markers from the catalog', () => {
    expect(text(project)).toContain(
      `The Atlas: observations and surfaces for ${catalog.artifacts.length} markers`,
    );
  });

  it('heads the status rail with the evidence totals and how they are counted', () => {
    const rail = figure('status-rail');
    const totals = [...rail.matchAll(/<data\b([^>]*)>([^<]*)<\/data>/g)];
    expect(totals.map((match) => match[2])).toEqual(['4,392', '6.69M', '2']);
    for (const [, attributes] of totals) {
      expect(attributes).not.toContain('aria-hidden');
      expect(attributes).not.toContain('data-count-to');
    }
    const words = text(rail);
    expect(words).toContain('Genetic variants & alleles');
    expect(words).toContain('People represented, not deduplicated');
    expect(words).toContain('Diseases represented');
    expect(rail).toMatch(/<summary[^>]*>\s*How we count\s*<\/summary>/);
    expect(rail).toContain(corpusRevision);
    // The composition bars retire with EvidenceBase.
    expect(rail).not.toContain('eb-bar');
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
    expect(text(apps)).toContain(
      'Population evidence is context, not a diagnosis.',
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

  it('offers the slider stops 1–15%', () => {
    expect(THRESHOLD_STOPS).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
  });

  it('never outlines an area with no estimate, at any stop', () => {
    for (const stop of THRESHOLD_STOPS)
      for (const area of areas.filter((entry) => entry.support === 'unknown'))
        expect(classifyArea(area, stop / 100)).toBeNull();
  });

  it('keeps confidently above inside "the estimate is above", and apart from possibly above', () => {
    for (const stop of THRESHOLD_STOPS) {
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
  const read = (area: Area) => describeHit({ type: 'area', area, x: 0, y: 0 });
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

  it('writes shares, ranges and distances as the Home hero readouts do', () => {
    expect(read(modeled(0.064, 0.018, 0.2, 1234.4, 'strong'))).toBe(
      'Modeled estimate about 6.4% · 95% credible range across this area 1.8–20% · Nearest survey about 1,234 km',
    );
    expect(read(modeled(0.004, 0.0004, 0.012, 88, 'partial'))).toBe(
      'Modeled estimate about 0.40% · 95% credible range across this area 0.04–1.2% · Nearest survey about 88 km',
    );
    expect(read(modeled(0.12, 0, 0.31, 2500, 'weak'))).toBe(
      'Modeled estimate about 12% · 95% credible range across this area 0–31% · Nearest survey about 2,500 km. Far from surveys: this range leans on the model’s assumptions.',
    );
    for (const area of areas.filter((entry) => entry.mean !== null)) {
      const line = read(area)!;
      // One percent sign closes the range, and nothing below 1% rounds to "0.0".
      expect(line).toMatch(/range across this area [\d.]+–[\d.]+% · /);
      expect(line).not.toMatch(/\b0\.0(?!\d)/);
    }
  });

  it('reads out surveys in people tested, keeping the copies as counts (R2-16)', () => {
    // HBB is autosomal: AN gene copies are AN/2 people, exactly. No carrier count is derived
    // from AC, which counts copies, not people.
    expect(
      describeHit({ type: 'surveys', surveys: [survey(3, 100)], x: 0, y: 0 }),
    ).toBe(
      'Measured survey · 50 people tested; 3 of their 100 gene copies carry HbS · Location within ±25 km',
    );
    expect(
      describeHit({
        type: 'surveys',
        surveys: [survey(3, 100), survey(5, 2000)],
        x: 0,
        y: 0,
      }),
    ).toBe('2 surveys here · 50 people tested · 1,000');
    expect(
      describeHit({
        type: 'surveys',
        surveys: [1, 2, 3, 4].map((ac) => survey(ac, 50)),
        x: 0,
        y: 0,
      }),
    ).toBe('4 surveys here · 25 people tested · 25 · 25 · …');
    for (const line of [
      describeHit({ type: 'surveys', surveys: [survey(1, 4)], x: 0, y: 0 }),
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
