import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const EXPLORER = path.resolve(
  import.meta.dirname,
  '../src/components/atlas/AtlasExplorer.tsx',
);

describe('explorer module size (mobile sheets design §A.2)', () => {
  const lines = () => readFileSync(EXPLORER, 'utf8').trimEnd().split('\n');

  // The spec's measure: "AtlasExplorer.tsx (755 logical lines) does not grow". Logical lines are
  // non-blank lines, as scripts/check_module_size.py counts them, so deleting blank lines can
  // never pay for new code.
  it('keeps AtlasExplorer.tsx at or below its 755 logical-line starting size', () => {
    expect(
      lines().filter((line) => line.trim() !== '').length,
    ).toBeLessThanOrEqual(755);
  });

  it('keeps AtlasExplorer.tsx at or below its 784 physical-line starting size', () => {
    expect(lines().length).toBeLessThanOrEqual(784);
  });
});

/** Non-blank lines, as above. */
function logicalLines(relative: string): number {
  return readFileSync(path.resolve(import.meta.dirname, relative), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '').length;
}

describe('scene module size (terrain draping design, #483)', () => {
  // Already past the 800-line split threshold when the draped surface arrived, so the per-kind
  // surface-group operations moved to `surface-groups.ts` and the file may not grow again.
  it('keeps scientific-layers.ts at or below its 986 logical lines (AGENTS.md: split before adding)', () => {
    expect(
      logicalLines('../src/atlas/scene/scientific-layers.ts'),
    ).toBeLessThanOrEqual(986);
  });
});
