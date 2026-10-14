/**
 * Home page content (moved verbatim from content.test.ts, #454). Owned by the Home task.
 */
import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';

const home = builtHtml('');

describe('home page content', () => {
  it('leads with the higher-order mission and concrete applications', () => {
    expect(home).toContain(
      'Make the world’s genetic diversity legible and useful',
    );
    expect(home).toMatch(
      /Potential applications[\s\S]*Screening programmes[\s\S]*Diagnostic context[\s\S]*Trial planning[\s\S]*The map of what we don’t know/,
    );
    expect(home).toContain(
      'https://github.com/genomeOS/genomeOS/discussions/1',
    );
    expect(home).toMatch(/open source/i);
    expect(home).toMatch(/global community/i);
    expect(home).toMatch(/public good/i);
  });

  it('reports sourced corpus metrics with an auditable definition', () => {
    expect(home).toMatch(
      /4,392[\s\S]*Genetic variants &amp; alleles[\s\S]*6\.69M[\s\S]*People represented[\s\S]*2[\s\S]*Diseases represented/,
    );
    expect(home).toContain('How these counts are defined');
    expect(home).toContain('fc17bc1c1d96a0d0766746dcf26277ccdc669717');
    expect(home).not.toContain('Measured here.');
  });
});
