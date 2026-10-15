/**
 * The committed figure data (site redesign spec §5, §9.2; #454): it decodes, it is honest, and it
 * belongs to the artifact the catalog pins. If the catalog's HbS artifact changes, this fails until
 * `node scripts/build-site-figures.mjs` is re-run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  SURVEY_BYTES,
  decodeAreas,
  decodeSurveys,
  type Area,
} from '../src/graphics/figure-data';
import {
  ENC,
  STUD_RADIUS,
  STUD_RING,
  vsupColor,
} from '../src/graphics/encoding';
import { haversineKm, orthographic } from '../src/graphics/projection';

const website = path.resolve(import.meta.dirname, '..');
const figures = path.join(website, 'src/data/figures');
const catalog = JSON.parse(
  readFileSync(path.join(website, 'public/data/atlas/catalog.json'), 'utf8'),
) as {
  artifacts: Record<string, unknown>[];
};
const artifact = catalog.artifacts.find((entry) => entry.id === 'hbs-rs334')!;
const provenance = JSON.parse(
  readFileSync(path.join(figures, 'hbs.provenance.json'), 'utf8'),
) as {
  files: Record<
    string,
    { name: string; sha256: string; records: number | null }
  >;
  [key: string]: unknown;
};

const file = (key: string) => {
  const { name } = provenance.files[key];
  return readFileSync(path.join(figures, name));
};
const kb = (bytes: Buffer) => gzipSync(bytes, { level: 9 }).length / 1024;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

describe('committed figure data', () => {
  it('names each file by its content and keeps no stale copy', () => {
    // The HbS outputs only: the people figure's sidecar (gwas-ancestry.provenance.json, Home
    // §4.1.3) sits beside them and is checked by gwas-ancestry.test.ts.
    const names = readdirSync(figures).filter((name) =>
      name.startsWith('hbs-'),
    );
    expect(names.sort()).toEqual(
      Object.values(provenance.files)
        .map(({ name }) => name)
        .sort(),
    );
    for (const { name, sha256 } of Object.values(provenance.files))
      expect(name).toContain(sha256.slice(0, 16));
  });

  it('records the artifact the catalog pins', () => {
    for (const key of [
      'model_version',
      'data_version',
      'hf_dataset',
      'hf_revision',
      'observations_sha256',
      'surface_sha256',
      'variant_id',
      'label',
      'correlation_range_km',
    ])
      expect(provenance[key], key).toEqual(artifact[key]);
    expect(provenance.artifact_id).toBe('hbs-rs334');
    expect(provenance.source_resolution).toBe(artifact.resolution);
    expect(provenance.resolutions).toEqual({ globe: 2, region: 3 });
    expect(
      (provenance.metric_domain as { post_mean: unknown }).post_mean,
    ).toEqual((artifact.metric_domains as { post_mean: unknown }).post_mean);
  });

  it('stores the 1,071 surveys as integer counts, with no frequency field', () => {
    const bytes = file('surveys');
    expect((bytes.length - 12) / 1071).toBe(SURVEY_BYTES);
    const surveys = decodeSurveys(bytes);
    expect(surveys).toHaveLength(1071);
    expect(surveys).toHaveLength(artifact.n_observations as number);
    for (const survey of surveys) {
      // Counted in people on the site (round 2 spec §6.2): HBB is autosomal, so AN is even and
      // AN / 2 is the number of people tested, exactly.
      expect(survey.an % 2, `AN ${survey.an}`).toBe(0);
      expect(Object.keys(survey).sort()).toEqual(
        ['ac', 'an', 'lat', 'lon', 'radiusKm'].sort(),
      );
      expect(Number.isInteger(survey.ac) && Number.isInteger(survey.an)).toBe(
        true,
      );
      expect(survey.ac).toBeGreaterThanOrEqual(0);
      expect(survey.ac).toBeLessThanOrEqual(survey.an);
      expect(survey.radiusKm).toBeGreaterThan(0);
    }
  });

  it.each(['globe', 'region'])(
    'keeps every %s interval honest and every unknown area valueless',
    (key) => {
      const areas = decodeAreas(file(key));
      expect(areas).toHaveLength(provenance.files[key].records!);
      for (const area of areas) {
        if (area.support === 'unknown') {
          expect([area.mean, area.lo, area.hi]).toEqual([null, null, null]);
          continue;
        }
        expect(area.lo).not.toBeNull();
        expect(area.lo!).toBeLessThanOrEqual(area.mean!);
        expect(area.mean!).toBeLessThanOrEqual(area.hi!);
      }
      const byTier = (tier: Area['tier']) =>
        median(
          areas
            .filter((area) => area.tier === tier)
            .map((area) => area.distanceKm),
        );
      expect(byTier('strong')).toBeLessThan(byTier('partial'));
      expect(byTier('partial')).toBeLessThan(byTier('weak'));
    },
  );

  it('covers the whole model grid on the globe and only the window in the region', () => {
    const globe = decodeAreas(file('globe'));
    expect(globe.length).toBeGreaterThan(2000);
    const region = decodeAreas(file('region'));
    const window = provenance.region_window as Record<string, number>;
    for (const { center } of region) {
      expect(center[0]).toBeGreaterThanOrEqual(window.west - 1);
      expect(center[0]).toBeLessThanOrEqual(window.east + 1);
      expect(center[1]).toBeGreaterThanOrEqual(window.south - 1);
      expect(center[1]).toBeLessThanOrEqual(window.north + 1);
    }
  });

  it('draws the poster from VSUP colours and never fills a hatched area with one', () => {
    const svg = file('poster').toString('utf8');
    const domain = (artifact.metric_domains as { post_mean: [number, number] })
      .post_mean;
    const allowed = new Set([...ENC.mean, ...ENC.meanPartial, ENC.meanWeak]);
    const fills = [...svg.matchAll(/<path fill="(#[0-9a-f]{6})"/g)].map(
      (match) => match[1],
    );
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.length).toBeLessThanOrEqual(12);
    for (const fill of fills) expect(allowed.has(fill)).toBe(true);
    const hatched = [
      ...svg.matchAll(/<path data-support="unknown" fill="([^"]+)"/g),
    ].map((match) => match[1]);
    expect(hatched).toEqual([ENC.land, 'url(#h)']);
    expect(vsupColor(0.1, 'none', domain)).toBeNull();
  });

  it('hatches the poster like the canvas: 45° strokes 1.4 px wide, 5 px apart', () => {
    const svg = file('poster').toString('utf8');
    const pattern = svg.match(/<pattern id="h"([^>]*)>(.*?)<\/pattern>/);
    expect(pattern).not.toBeNull();
    const attr = (source: string, name: string) =>
      source.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
    const [, attrs, body] = pattern!;
    expect(attr(attrs, 'patternTransform')).toBe('rotate(45)');
    // One stroke per tile, so the tile's width is the pitch.
    expect(Number(attr(attrs, 'width'))).toBe(ENC.hatchPitch);
    expect(Number(attr(attrs, 'height'))).toBe(ENC.hatchPitch);
    const stroke = body.match(/<path d="M([\d.]+) 0V([\d.]+)"/);
    expect(stroke).not.toBeNull();
    const width = Number(attr(body, 'stroke-width'));
    expect(width).toBe(ENC.hatchWidth);
    // The tile clips its content: the stroke sits inside it, never cut to half its width.
    const x = Number(stroke![1]);
    expect(x - width / 2).toBeGreaterThanOrEqual(0);
    expect(x + width / 2).toBeLessThanOrEqual(ENC.hatchPitch);
  });

  it('draws studs like the canvas: small to large, each size a void ring 1.5 px out, then white', () => {
    const svg = file('poster').toString('utf8');
    expect(svg).toMatch(/<g fill="none" stroke-linecap="round">/);
    const uses = [
      ...svg.matchAll(
        /<use href="#s(sm|md|lg)" stroke="([^"]+)" stroke-width="([^"]+)"\/>/g,
      ),
    ].map(([, size, stroke, width]) => ({
      size,
      stroke,
      width: Number(width),
    }));
    const sizes = ['sm', 'md', 'lg'] as const;
    const present = sizes.filter((size) => svg.includes(`id="s${size}"`));
    expect(present.length).toBeGreaterThan(1);
    // A round cap on a zero-length segment is a disc whose diameter is the stroke width.
    expect(uses).toEqual(
      present.flatMap((size) => [
        { size, stroke: '#020712', width: 2 * (STUD_RADIUS[size] + STUD_RING) },
        { size, stroke: ENC.obs, width: 2 * STUD_RADIUS[size] },
      ]),
    );
  });

  it('stays inside the transfer budgets', () => {
    expect(kb(file('globe'))).toBeLessThanOrEqual(45);
    expect(kb(file('region'))).toBeLessThanOrEqual(85);
    expect(kb(file('surveys'))).toBeLessThanOrEqual(12);
    expect(kb(file('poster'))).toBeLessThanOrEqual(25);
  });

  it('picks the callouts by their stated rules, with real counts', () => {
    const [survey, modeled, unknown] = provenance.callouts as Record<
      string,
      unknown
    >[];
    expect(survey.kind).toBe('survey');
    const surveys = decodeSurveys(file('surveys'));
    const chosen = surveys[survey.survey_index as number];
    expect([chosen.ac, chosen.an]).toEqual([survey.ac, survey.an]);
    // Counted in people (owner review, round 2): HBB is autosomal, two alleles a person.
    expect(chosen.an % 2).toBe(0);
    expect(survey.people).toBe(chosen.an / 2);
    expect(modeled.kind).toBe('modeled');
    expect(modeled.lo as number).toBeLessThanOrEqual(modeled.mean as number);
    expect(modeled.mean as number).toBeLessThanOrEqual(modeled.hi as number);
    expect(unknown.kind).toBe('unknown');
    const globe = decodeAreas(file('globe'));
    expect(globe[unknown.area_index as number].support).toBe('unknown');
    for (const callout of [survey, modeled, unknown]) {
      const [x, y] = callout.disc as [number, number];
      expect(Math.hypot(x, y)).toBeLessThan(1);
    }
  });

  // Owner review, round 2: the Modeled callout pointed at a Central African area among the studs,
  // so it showed measuring, not modeling. Its area is now clear of every stud at rest, far from
  // any survey, drawn with a value, and its text is that area's own estimate and range.
  it('points the Modeled callout at an estimated area clear of every stud', () => {
    const modeled = (provenance.callouts as Record<string, unknown>[]).find(
      (callout) => callout.kind === 'modeled',
    )!;
    const area = decodeAreas(file('globe'))[modeled.area_index as number];
    expect(area.mean).not.toBeNull();
    expect(['strong', 'partial']).toContain(area.tier);
    expect(modeled.mean).toBeCloseTo(area.mean!, 6);
    expect(modeled.lo).toBeCloseTo(area.lo!, 6);
    expect(modeled.hi).toBeCloseTo(area.hi!, 6);
    expect(area.distanceKm).toBeGreaterThanOrEqual(400);
    const rest = provenance.rest as { lon: number; lat: number };
    const { size, radius } = provenance.poster as {
      size: number;
      radius: number;
    };
    const atRest = orthographic({
      center: [rest.lon, rest.lat],
      scale: radius,
      translate: [size / 2, size / 2],
    });
    const [ax, ay, cosc] = atRest.project(...area.center);
    // Facing the viewer at rest, and at least 24 poster units (≈ px on a desktop disc) from every
    // stud drawn there.
    expect(cosc).toBeGreaterThanOrEqual(Math.cos((25 * Math.PI) / 180));
    let nearest = Infinity;
    for (const survey of decodeSurveys(file('surveys'))) {
      const [x, y, c] = atRest.project(survey.lon, survey.lat);
      if (c > 0) nearest = Math.min(nearest, Math.hypot(x - ax, y - ay));
    }
    expect(nearest).toBeGreaterThanOrEqual(24);
  });

  // R2-16 and round 2 spec §11.1: the Modeled label names modeling, so no survey lies within the
  // strong tier of its cell (the distance at which a survey would dominate the estimate).
  it('anchors the Modeled label on an estimated cell with no survey within the strong tier', () => {
    const modeled = (provenance.callouts as Record<string, unknown>[]).find(
      (callout) => callout.kind === 'modeled',
    )!;
    const area = decodeAreas(file('globe'))[modeled.area_index as number];
    expect(area.mean).not.toBeNull();
    const strong = (provenance.tier_limits_km as { strong: number }).strong;
    const nearest = Math.min(
      ...decodeSurveys(file('surveys')).map((survey) =>
        haversineKm(area.center, [survey.lon, survey.lat]),
      ),
    );
    expect(nearest).toBeGreaterThan(strong);
  });

  // Ruling 23: at the starting view every label shows at its point, so each point faces the viewer
  // (within 60° of the view centre, where a label is drawn whole).
  it('puts every label’s point on the visible face at the starting view', () => {
    const rest = provenance.rest as { lon: number; lat: number };
    const atRest = orthographic({
      center: [rest.lon, rest.lat],
      scale: 1,
      translate: [0, 0],
    });
    for (const callout of provenance.callouts as Record<string, unknown>[]) {
      const [, , cosc] = atRest.project(
        callout.lon as number,
        callout.lat as number,
      );
      expect(cosc, callout.kind as string).toBeGreaterThanOrEqual(
        Math.cos((55 * Math.PI) / 180),
      );
    }
  });

  it('writes the preview’s alt text from the data', () => {
    expect(provenance.alt).toContain('1,071 measured surveys');
    expect(provenance.alt).toMatch(
      /^Preview of the Atlas with sample data: a slowly turning globe of the sickle-cell variant HbS\. White dots are 1,071 measured surveys/,
    );
    expect(provenance.alt).toMatch(
      /Color shows the modeled frequency, highest, about \d+ percent, in parts of [A-Z][a-z]+( Africa)?, and fades away from surveys\./,
    );
    expect(provenance.alt).toMatch(/Stripes mark areas with no estimate\.$/);
    // US spelling (round 2 spec §0.1 item 10).
    expect(provenance.alt).not.toMatch(/colour/i);
    expect(JSON.stringify(provenance)).not.toMatch(
      /googleapis|storage\.|gs:\/\//,
    );
  });
});
