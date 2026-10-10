import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) =>
  readFileSync(path.join(repositoryRoot, relative), 'utf8');

/** Since Part C the encoder runs before publishing, not in CI (design 2026-10-07 §C.3). */
describe('Atlas web-object encoding prerequisites (fast-load spec §B.5)', () => {
  it('keeps generated objects out of git and documents the prerequisite', () => {
    const ignored = read('.gitignore').split('\n');
    expect(ignored).toContain('website/public/data/atlas/grids/');
    expect(ignored).toContain('website/public/data/atlas/surfaces/');
    const sentence =
      '`export_atlas_web.py` output is an intermediate; the site build fails until `encode_atlas_web.py`';
    for (const doc of [
      'website/src/content/docs/docs/local-development.md',
      'docs/data-store.md',
    ]) {
      const text = read(doc).replace(/\s+/g, ' ');
      expect(text, doc).toContain(sentence);
      expect(text, doc).toContain('python scripts/encode_atlas_web.py');
    }
  });

  // Kept from Task 20 (B1.6): whoever re-encodes installs h3-py from the lock (spec §B.3).
  it('pins h3-py to the H3 core of the website h3-js', () => {
    const lock = read('requirements.lock')
      .split('\n')
      .find((line) => line.startsWith('h3=='));
    const h3js = (
      JSON.parse(read('website/package.json')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies['h3-js'];
    expect(lock).toBe(`h3==${h3js}`);
  });
});
