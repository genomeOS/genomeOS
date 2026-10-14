import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { atlasDataTarget, LOCAL_DATA_BASE } from './support/atlas-data-target';

const page = (artifact: string): string =>
  `<script type="application/json" id="atlas-data-bases">${JSON.stringify({
    artifact,
    site: '/data/atlas/',
  })}</script>`;
const BUCKET = 'https://storage.googleapis.com/example-bucket/atlas/web/';

describe('atlasDataTarget', () => {
  it('reads a bucket build', () => {
    expect(atlasDataTarget(page(BUCKET), undefined)).toEqual({
      kind: 'bucket',
      base: BUCKET,
    });
  });

  it('requires ATLAS_DATA_DIR for the local data origin', () => {
    expect(() => atlasDataTarget(page(LOCAL_DATA_BASE), undefined)).toThrow(
      /ATLAS_DATA_DIR/,
    );
    expect(atlasDataTarget(page(LOCAL_DATA_BASE), '/tmp/staging')).toEqual({
      kind: 'local',
      base: LOCAL_DATA_BASE,
      directory: '/tmp/staging',
    });
  });

  it('refuses a same-origin build and a page without the bases', () => {
    expect(() => atlasDataTarget(page('/data/atlas/'), undefined)).toThrow(
      /PUBLIC_ATLAS_DATA_BASE_URL/,
    );
    expect(() => atlasDataTarget('<html></html>', undefined)).toThrow(
      /atlas-data-bases/,
    );
  });

  it('refuses the unit-test build, which has no per-artifact data', () => {
    const html = readFileSync(
      path.resolve(import.meta.dirname, '../dist/app/index.html'),
      'utf8',
    );
    expect(() => atlasDataTarget(html, undefined)).toThrow(
      /PUBLIC_ATLAS_DATA_BASE_URL/,
    );
  });
});
