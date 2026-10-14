/**
 * Project page content (site redesign spec §4.2, §6, §9.1; #454). Owned by the Project task.
 *
 * The built page keeps its pinned copy (status order, the HbS → G6PD → screening bar, the
 * registry, the public map, the roadmap), drops the retired vision images, opens six concept
 * sections with one figure each, and keeps its schematic figures free of numbers. The HbS
 * threshold figure's two outline classes are checked against the decoded figure data at every
 * slider stop.
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
  type Area,
  type Survey,
} from '../src/graphics/figure-data';
import { builtHtml } from './helpers/dist';

const project = builtHtml('project');
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

describe('project page content', () => {
  it('labels current work, active work, and future ideas separately', () => {
    expect(project).toMatch(
      /Available now[\s\S]*In active development[\s\S]*Future exploration/,
    );
    expect(project).toMatch(
      /Future exploration[\s\S]*privacy[\s\S]*consent[\s\S]*governance/,
    );
    expect(project).toContain('ancient-DNA time slider');
  });

  it('states the scientific publication bar', () => {
    expect(project).toMatch(/HbS[\s\S]*G6PD[\s\S]*screening/);
    expect(text(project)).toContain(
      'Why haemoglobin S makes the mission tangible',
    );
    // "haemoglobin S" is one name: a no-break space keeps the S off the start of a line.
    expect(project).toMatch(
      /Why haemoglobin(?:&nbsp;|&#160;| )S makes the mission tangible/,
    );
    expect(project).toMatch(/population-location registry/i);
    expect(project).toMatch(/interactive public map/i);
    expect(text(project)).toContain(
      'A plausible map is not success. Until genomeOS reproduces published HbS, G6PD and carrier-screening results, every surface says “not yet validated”.',
    );
  });

  it('retires the three vision images', () => {
    expect(project).not.toMatch(/\/images\/vision-[a-z]+\.webp/);
    expect(project).not.toContain('vision-card');
  });

  it('opens six concept sections, each holding one figure', () => {
    const concepts = project.match(/\bdata-concept\b/g) ?? [];
    expect(concepts).toHaveLength(6);
    for (const name of [
      'join-up',
      'hbs-threshold',
      'scale-ladder',
      'safeguards',
      'pipeline',
      'status-rail',
    ])
      expect(figure(name), name).not.toBe('');
  });

  it('opens on the join-up schematic: five outcomes, no numbers', () => {
    const joinUp = figure('join-up');
    expect(joinUp).toContain('data-status="schematic"');
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

  it('tags the HbS map as not yet validated and cites its provenance', () => {
    const hbs = figure('hbs-threshold');
    expect(hbs).toContain('data-status="not-validated"');
    expect(hbs).toContain(provenance.hf_revision.slice(0, 7));
    expect(hbs).toContain('/app/?entity=hbs-rs334&amp;palette=genome');
    expect(text(hbs)).toContain('coarsened for display');
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
  });

  it('keys the HbS fill by value and by distance from surveys, in the deck’s words', () => {
    const hbs = text(figure('hbs-threshold'));
    // The VSUP wedge: low frequency and little evidence are told apart (spec §0, correction 2).
    expect(hbs).toContain('Modeled frequency, 0–17% Fades away from surveys');
    expect(hbs).toContain('Tap to inspect.');
  });

  it('tags the scale ladder as a schematic: its studs and footprint hold no data', () => {
    expect(figure('scale-ladder')).toContain('data-status="schematic"');
  });

  it('counts the Atlas markers from the catalog', () => {
    expect(text(project)).toContain(
      `The Atlas: observations and surfaces for ${catalog.artifacts.length} markers`,
    );
  });

  it('sets the wordmark apart from the next word in the lede', () => {
    expect(project).toMatch(/<span class="brand-name">genomeOS<\/span> places/);
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

  it('reads out surveys as the Home hero readouts do', () => {
    expect(
      describeHit({ type: 'surveys', surveys: [survey(3, 100)], x: 0, y: 0 }),
    ).toBe(
      'Measured survey · 3 of 100 alleles carry HbS · Location within ±25 km',
    );
    expect(
      describeHit({
        type: 'surveys',
        surveys: [survey(3, 100), survey(5, 2000)],
        x: 0,
        y: 0,
      }),
    ).toBe('2 surveys here · 3 of 100 alleles · 5 of 2,000');
    expect(
      describeHit({
        type: 'surveys',
        surveys: [1, 2, 3, 4].map((ac) => survey(ac, 50)),
        x: 0,
        y: 0,
      }),
    ).toBe('4 surveys here · 1 of 50 alleles · 2 of 50 · 3 of 50 · …');
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
