/**
 * The people figure's data (round 2 spec §4.1.3, §6.1, §11.1; R2-11; #454): the one number about
 * diversity on Home comes from a pinned, cited sidecar, and the page draws exactly what the sidecar
 * says. Source: Fatumo et al., "A roadmap to increase diversity in genomic studies", Nature
 * Medicine 28(2):243–250 (2022), the GWAS Catalog as of 8 July 2021 (its Figure 1), checked against
 * the author manuscript and the PMC copy during the build (task report T2).
 */
import { describe, expect, it } from 'vitest';

import provenance from '../src/data/figures/gwas-ancestry.provenance.json';
import {
  PEOPLE_TOTAL,
  ancestryCounts,
  largestRemainder,
} from '../src/components/home/people';
import { builtHtml } from './helpers/dist';

const home = builtHtml('');
const figure =
  home.match(/<figure\b[^>]*data-graphic="people"[\s\S]*?<\/figure>/)?.[0] ??
  '';

describe('the GWAS ancestry sidecar', () => {
  it('cites the paper, its DOI and the catalogue date', () => {
    expect(provenance.source.doi).toBe('10.1038/s41591-021-01672-4');
    expect(provenance.source.url).toBe(
      'https://doi.org/10.1038/s41591-021-01672-4',
    );
    expect(provenance.source.catalog_date).toBe('2021-07-08');
    expect(provenance.source.journal).toBe('Nature Medicine');
    expect(provenance.source.year).toBe(2022);
    expect(provenance.source.citation).toMatch(/^Fatumo S/);
  });

  it('holds the source’s shares, which leave a small remainder unreported', () => {
    expect(provenance.shares_percent).toEqual({
      european: 86.3,
      east_asian: 5.9,
      african: 1.1,
      south_asian: 0.8,
      hispanic_latino: 0.08,
      multiple: 4.8,
    });
    const listed = Object.values(provenance.shares_percent).reduce(
      (sum, share) => sum + share,
      0,
    );
    expect(listed).toBeLessThan(100);
    expect(100 - listed).toBeCloseTo(1.02, 2);
    // Participants are counted per study, not deduplicated (spec §4.1.3 footnote).
    expect(provenance.unit).toMatch(/not deduplicated/);
  });

  it('rounds to whole people by the largest remainder: 86 · 1 · 13 of 100', () => {
    expect(largestRemainder([86.3, 1.1, 12.6], 100)).toEqual([86, 1, 13]);
    // Ties and an exact fit stay exact.
    expect(largestRemainder([50, 50], 100)).toEqual([50, 50]);
    expect(largestRemainder([33.4, 33.3, 33.3], 100)).toEqual([34, 33, 33]);
    const counts = ancestryCounts(provenance);
    expect(counts).toEqual({ european: 86, african: 1, other: 13 });
    expect(counts.european + counts.african + counts.other).toBe(PEOPLE_TOTAL);
    expect(provenance.drawn).toEqual(counts);
  });
});

describe('the people figure draws the sidecar', () => {
  it('places 100 closed-visor people in each layout, in the sidecar’s counts and order', () => {
    expect(figure).not.toBe('');
    const layouts = [
      ...figure.matchAll(/<svg\b[^>]*data-layout="(\w+)"[\s\S]*?<\/svg>/g),
    ];
    expect(layouts.map(([, name]) => name).sort()).toEqual(['narrow', 'wide']);
    for (const [svg, name] of layouts) {
      const people = [
        ...svg.matchAll(/<use\b[^>]*data-person="(\w+)"[^>]*>/g),
      ].map(([, group]) => group);
      expect(people, name).toHaveLength(100);
      // 86 European ancestry first, then 13 others, the one African-ancestry person last.
      expect(people.slice(0, 86).every((group) => group === 'european')).toBe(
        true,
      );
      expect(people.slice(86, 99).every((group) => group === 'other')).toBe(
        true,
      );
      expect(people[99], name).toBe('african');
      // Closed visors only: ancestry is never drawn as skin colour.
      expect(svg).not.toMatch(/micro-face-/);
    }
  });

  it('keys, notes and sources the figure in words, linking the DOI', () => {
    const text = figure
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
    expect(text).toContain(
      'Of every 100 participants in genome-wide studies, up to 2021',
    );
    expect(text).toContain(
      'Populations with the greatest genetic diversity are the least represented in research.',
    );
    // The owner breaks the note after "diversity" (2026-10-15).
    expect(figure).toMatch(
      /genetic diversity<\/span>\s*<span[^>]*>are the least/,
    );
    expect(text).toMatch(/86 European ancestry/);
    expect(text).toMatch(/13 All other ancestries, or not recorded/);
    expect(text).toMatch(/1 African ancestry/);
    expect(text).toContain('A person in several studies is counted in each.');
    // No lone word at a line's end or start: "A" keeps to "person", "each." to "in" (final
    // verification of the redesign).
    expect(figure).toContain(
      '. A&nbsp;person in several studies is counted in&nbsp;each.',
    );
    expect(figure).toMatch(
      /<a\b[^>]*href="https:\/\/doi\.org\/10\.1038\/s41591-021-01672-4"[^>]*target="_blank"[^>]*>/,
    );
    expect(figure).toContain(
      'aria-label="Of every 100 participants in genome-wide studies up to July 2021, 86 had European ancestry, 1 had African ancestry, and 13 had another ancestry or none recorded. A person in several studies is counted in each."',
    );
  });
});
