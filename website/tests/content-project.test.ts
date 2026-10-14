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
  thresholdCounts,
} from '../src/components/project/hbs-map';
import { decodeAreas, type Area } from '../src/graphics/figure-data';
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
    expect(project).toContain('Why haemoglobin S makes the mission tangible');
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
    // The no-JS count and the table come from the pinned data.
    const at10 = provenance.table.region_thresholds.find(
      (row) => row.threshold === 0.1,
    )!;
    expect(text(hbs)).toContain(
      `${at10.confidently_above} confidently above · ${at10.possibly_above} possibly above`,
    );
    expect(hbs).toMatch(/type="range"[^>]*min="1"[^>]*max="15"/);
    expect(hbs).toContain('aria-valuetext="10 percent:');
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
  const noEstimateKm = provenance.tier_limits_km.weak;
  const read = (area: Area) =>
    describeHit({ type: 'area', area, x: 0, y: 0 }, { noEstimateKm });
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

  it('never claims a wider survey-free radius than an area’s own distance', () => {
    // Majority coarsening can leave an unknown area nearer a survey than the no-estimate limit.
    expect(read(unknown(1352))).toBe(
      'No estimate · — · No survey within 1,350 km',
    );
    expect(read(unknown(2400))).toBe(
      'No estimate · — · No survey within 1,360 km',
    );
    for (const area of areas.filter((entry) => entry.support === 'unknown')) {
      const [, within] = /within ([\d,]+) km/.exec(read(area)!)!;
      expect(Number(within.replace(/,/g, ''))).toBeLessThanOrEqual(
        Math.min(area.distanceKm, noEstimateKm),
      );
    }
  });
});
