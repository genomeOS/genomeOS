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
import { ENC, vsupColor } from '../src/graphics/encoding';

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
    const names = readdirSync(figures).filter(
      (name) => name !== 'hbs.provenance.json',
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

  it('stays inside the transfer budgets', () => {
    expect(kb(file('globe'))).toBeLessThanOrEqual(45);
    expect(kb(file('region'))).toBeLessThanOrEqual(85);
    expect(kb(file('surveys'))).toBeLessThanOrEqual(12);
    expect(kb(file('poster'))).toBeLessThanOrEqual(25);
  });

  it('picks the hero callouts by their stated rules, with real counts', () => {
    const [survey, modeled, unknown] = provenance.callouts as Record<
      string,
      unknown
    >[];
    expect(survey.kind).toBe('survey');
    const surveys = decodeSurveys(file('surveys'));
    const chosen = surveys[survey.survey_index as number];
    expect([chosen.ac, chosen.an]).toEqual([survey.ac, survey.an]);
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

  it('writes the hero alt text from the data', () => {
    expect(provenance.alt).toContain('1,071 measured surveys');
    expect(provenance.alt).toMatch(/^Globe of the sickle-cell variant HbS\./);
    expect(JSON.stringify(provenance)).not.toMatch(
      /googleapis|storage\.|gs:\/\//,
    );
  });
});
