/**
 * Published Atlas data (design 2026-10-07 §C.1.3, §C.3). The repository keeps
 * catalog.json, the Natural Earth context and the external caches; per-artifact
 * objects live in the public bucket. The catalog contract always runs. Set
 * ATLAS_DATA_DIR to a staging tree (encode_atlas_web.py --with-downloads --out
 * DIR, or a bucket download) to verify every published object.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitLongToH3Index } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  atlasCatalogSchema,
  observationArtifactSchema,
  surfaceArtifactSchema,
} from '../src/atlas/contracts';
import {
  decodeDetail,
  decodeGrid,
  decodeRender,
} from '../src/atlas/gosa/decode';
import { populatedPlaceCatalogSchema } from '../src/atlas/place-context';

const siteData = fileURLToPath(
  new URL('../public/data/atlas/', import.meta.url),
);
const websiteRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDirectory = process.env.ATLAS_DATA_DIR;

const POPULATED_ISLAND_CELLS = {
  Azores: '84351b5ffffffff',
  'Cook Islands': '84b4c59ffffffff',
  Madeira: '843466bffffffff',
  Malta: '843f305ffffffff',
  Praia: '845494bffffffff',
  Tenerife: '84344cdffffffff',
} as const;

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const short = (digest: string): string => digest.slice(0, 16);
const arrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
const catalog = atlasCatalogSchema.parse(
  JSON.parse(readFileSync(path.join(siteData, 'catalog.json'), 'utf8')),
);

describe('published Atlas catalog (repository copy)', () => {
  it('publishes validated public-domain city and region context', () => {
    const places = populatedPlaceCatalogSchema.parse(
      JSON.parse(
        readFileSync(
          path.join(siteData, 'ne-50m-populated-places.json'),
          'utf8',
        ),
      ),
    );
    expect(places.places.length).toBeGreaterThan(1_000);
    expect(places.places).toContainEqual(
      expect.objectContaining({
        country: 'Australia',
        name: 'Sydney',
        region: 'New South Wales',
      }),
    );
  });

  it('lists the thirty allowlisted maps on the shared resolution-4 WorldPop grid', () => {
    expect(catalog.artifacts).toHaveLength(30);
    const grids = Object.entries(catalog.grids);
    expect(grids).toHaveLength(1);
    const [gridSha256, grid] = grids[0]!;
    expect(grid.resolution).toBe(4);
    for (const reference of catalog.artifacts) {
      expect(reference.resolution, reference.id).toBe(4);
      expect(reference.target_grid_source, reference.id).toBe(
        'worldpop-1km-unconstrained',
      );
      expect(reference.target_grid_version, reference.id).toContain(
        'Global_2000_2020/2020/0_Mosaicked',
      );
      expect(reference.web.grid_sha256, reference.id).toBe(gridSha256);
      expect(reference.n_cells, reference.id).toBe(grid.n_cells);
      expect(reference.observations_available, reference.id).toBe(true);
      expect(reference.observations_bytes, reference.id).toBeGreaterThan(0);
    }
  });

  it('names every artifact object by the bucket layout and its content digest', () => {
    const [, grid] = Object.entries(catalog.grids)[0]!;
    expect(grid.url).toBe(
      `grids/h3-r${grid.resolution}.${short(grid.sha256)}.gosa`,
    );
    for (const reference of catalog.artifacts) {
      const prefix = `${reference.id}/${reference.model_version}/${reference.data_version}`;
      expect(reference.web.render.url).toBe(
        `surfaces/${prefix}/render.${short(reference.web.render.sha256)}.gosa`,
      );
      expect(reference.web.detail.url).toBe(
        `surfaces/${prefix}/detail.${short(reference.web.detail.sha256)}.gosa`,
      );
      for (const kind of ['manifest', 'observations', 'surface'] as const) {
        const download = reference.downloads[kind];
        expect(download, `${reference.id} ${kind}`).not.toBeNull();
        expect(download!.url).toBe(
          `downloads/${prefix}/${reference.id}.${kind}.${short(download!.sha256)}.json`,
        );
      }
      expect(reference.surface_url).toBe(reference.downloads.surface.url);
      expect(reference.downloads.surface.sha256).toBe(reference.surface_sha256);
      expect(reference.observations_url).toBe(
        reference.downloads.observations!.url,
      );
      expect(reference.downloads.observations!.sha256).toBe(
        reference.observations_sha256,
      );
    }
  });

  it('keeps site-base files in the Pages bundle and per-artifact files out of git', () => {
    for (const source of catalog.context_sources)
      expect(existsSync(path.join(siteData, source.url)), source.id).toBe(true);
    for (const reference of catalog.artifacts)
      for (const resource of reference.external_resources)
        expect(
          sha256(readFileSync(path.join(siteData, resource.cache_url))),
          resource.cache_url,
        ).toBe(resource.cache_sha256);
    const tracked = execFileSync('git', ['ls-files', 'public/data/atlas'], {
      cwd: websiteRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(
      tracked.filter((file) =>
        /\.(surface|observations|manifest)\.json$|\.gosa$/.test(file),
      ),
    ).toEqual([]);
  });
});

describe.skipIf(!dataDirectory)(
  'published Atlas objects in ATLAS_DATA_DIR',
  () => {
    const read = (key: string): Buffer =>
      readFileSync(path.join(dataDirectory!, key));
    const checked = (object: {
      bytes: number;
      sha256: string;
      url: string;
    }): ArrayBuffer => {
      const bytes = read(object.url);
      expect(sha256(bytes), object.url).toBe(object.sha256);
      expect(bytes.byteLength, object.url).toBe(object.bytes);
      return arrayBuffer(bytes);
    };

    it('every object matches its digest, decodes, and aligns with the shared grid', () => {
      const [gridSha256, entry] = Object.entries(catalog.grids)[0]!;
      const grid = decodeGrid(checked(entry), { gridSha256, entry });
      const gridH3 = Array.from({ length: grid.n }, (_, row) =>
        splitLongToH3Index(grid.h3Lo[row]!, grid.h3Hi[row]!),
      );
      const gridCells = new Set(gridH3);
      for (const [island, h3Index] of Object.entries(POPULATED_ISLAND_CELLS))
        expect(gridCells.has(h3Index), island).toBe(true);

      for (const reference of catalog.artifacts) {
        const render = decodeRender(checked(reference.web.render), {
          ref: reference,
          grid,
        });
        decodeDetail(checked(reference.web.detail), {
          ref: reference,
          grid,
          render,
        });

        const surfaceBytes = read(reference.surface_url);
        expect(sha256(surfaceBytes), reference.id).toBe(
          reference.surface_sha256,
        );
        const surface = surfaceArtifactSchema.parse(
          JSON.parse(surfaceBytes.toString('utf8')),
        );
        expect(surface.artifact.id, reference.id).toBe(reference.id);
        expect(surface.cells, reference.id).toHaveLength(reference.n_cells);
        expect(
          surface.cells.findIndex((cell, row) => cell.h3_index !== gridH3[row]),
          `${reference.id}: first row whose h3 differs from the grid`,
        ).toBe(-1);

        const observationBytes = read(reference.observations_url!);
        expect(sha256(observationBytes), reference.id).toBe(
          reference.observations_sha256,
        );
        expect(observationBytes.byteLength, reference.id).toBe(
          reference.observations_bytes,
        );
        const observations = observationArtifactSchema.parse(
          JSON.parse(observationBytes.toString('utf8')),
        );
        expect(observations.artifact.id, reference.id).toBe(reference.id);
        expect(observations.observations, reference.id).toHaveLength(
          reference.n_observations,
        );

        expect(
          sha256(read(reference.downloads.manifest.url)),
          reference.id,
        ).toBe(reference.downloads.manifest.sha256);
      }

      // Moved from site.spec.ts: the complete default map (77,844 cells, 1,071 observations),
      // whose files the loop above has just parsed to these lengths.
      const hbs = catalog.artifacts.find(({ id }) => id === 'hbs-rs334')!;
      expect(hbs.n_cells).toBe(77_844);
      expect(hbs.n_observations).toBe(1_071);
    }, 900_000);
  },
);
