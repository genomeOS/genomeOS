/**
 * The page manifests after the round-2 integration (round 2 plan T7, spec §7 and §10; #454).
 *
 * Every page's words and figure contract are enforced, every budget the spec caps stays within its
 * cap, and the budgets are numbers, not placeholders: a page task that turns a flag off again, or
 * lifts a budget past spec §7, fails here before any browser runs.
 */
import { describe, expect, it } from 'vitest';

import { pageManifests } from './helpers/pages';

/** Spec §7's caps (round 2), gzip KB, and §10's word budgets. */
const CAPS: Record<
  string,
  {
    words: number;
    jsKbGz?: number;
    dataKbGz?: number;
    imagesKbGz?: number;
    transferKbGz?: number;
    lazyJsKbGz?: Record<string, number>;
    deferredMediaKb?: { desktop: number; phone: number };
  }
> = {
  home: {
    words: 425,
    jsKbGz: 24,
    dataKbGz: 60,
    imagesKbGz: 110,
    transferKbGz: 360,
    lazyJsKbGz: { 'atlas-preview': 18, 'how-it-works': 8, crew: 6, people: 3 },
    deferredMediaKb: { desktop: 4000, phone: 2000 },
  },
  projects: { words: 600, jsKbGz: 28, dataKbGz: 100, transferKbGz: 300 },
  contribute: {
    words: 380,
    jsKbGz: 10,
    dataKbGz: 0,
    transferKbGz: 220,
    lazyJsKbGz: { orbit: 40, board: 40 },
  },
};

describe('page manifests', () => {
  it.each(pageManifests.map((page) => [page.name, page] as const))(
    '%s enforces its words and its figure contract',
    (_, page) => {
      expect(page.wordsEnforced).toBe(true);
      expect(page.conceptsEnforced).toBe(true);
      expect(page).not.toHaveProperty('sectionsPending');
    },
  );

  it.each(Object.entries(CAPS))(
    '%s stays within the spec’s caps',
    (name, cap) => {
      const page = pageManifests.find((entry) => entry.name === name)!;
      expect(page, name).toBeDefined();
      expect(page.words).toBeLessThanOrEqual(cap.words);
      for (const key of [
        'jsKbGz',
        'dataKbGz',
        'imagesKbGz',
        'transferKbGz',
      ] as const)
        if (cap[key] !== undefined) {
          expect(page[key], `${name} ${key}`).not.toBeNull();
          expect(page[key], `${name} ${key}`).toBeLessThanOrEqual(cap[key]);
        }
      for (const [chunk, budget] of Object.entries(cap.lazyJsKbGz ?? {})) {
        expect(page.lazyJsKbGz?.[chunk], `${name} ${chunk}`).toBeDefined();
        expect(page.lazyJsKbGz![chunk]).toBeLessThanOrEqual(budget);
      }
      if (cap.deferredMediaKb) {
        expect(page.deferredMediaKb!.desktop).toBeLessThanOrEqual(
          cap.deferredMediaKb.desktop,
        );
        expect(page.deferredMediaKb!.phone).toBeLessThanOrEqual(
          cap.deferredMediaKb.phone,
        );
      }
      // Per-section budgets, so no section can grow into another's room (spec §10; the page
      // total stays the hard limit).
      expect(
        Object.keys(page.sections ?? {}).length,
        `${name} has section budgets`,
      ).toBeGreaterThan(0);
    },
  );

  it('budgets Projects by what shows before a section opens (ruling 42)', () => {
    const projects = pageManifests.find((entry) => entry.name === 'projects')!;
    expect(projects.sections).toEqual({
      '#projects': 62,
      '.atlas-ov': 75,
      '.acc-list': 61,
    });
  });
});
