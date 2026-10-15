/**
 * Home page content (moved from content.test.ts, #454; site redesign spec §4.1). Owned by the Home
 * task.
 */
import { describe, expect, it } from 'vitest';

import { corpusMetrics } from '../src/data/corpusMetrics';
import { builtHtml } from './helpers/dist';

const home = builtHtml('');

describe('home page content', () => {
  it('leads with the higher-order mission and concrete applications', () => {
    expect(home).toContain(
      'Data, models and tools built in the open, with anyone, for everyone.',
    );
    expect(home).toMatch(
      /Potential applications[\s\S]*Screening programmes[\s\S]*Diagnostic context[\s\S]*Trial planning[\s\S]*The map of what we don’t know[\s\S]*Medicines and drug response[\s\S]*Research and discovery/,
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

  it('shows what each corpus total is made of, and that people are not deduplicated', () => {
    expect(corpusMetrics.people.isDeduplicated).toBe(false);
    expect(home).toMatch(/AFND 4,391[\s\S]*HbS 1/);
    expect(home).toMatch(
      /HbS 5\.72M[\s\S]*AFND 0\.66M[\s\S]*G6PD 0\.32M[\s\S]*not deduplicated/,
    );
    expect(home).toMatch(/Sickle-cell disease[\s\S]*G6PD deficiency/);
    // Each segment names its full source for assistive technology and on hover.
    for (const name of [
      'AFND allele identifiers',
      'HbS-typed participants',
      'G6PD-tested hemizygous males',
    ])
      expect(home).toContain(name);
  });

  it('gives every application a horizon in words, and one rule for all of them', () => {
    for (const horizon of [
      'First-release direction',
      'Clinical validation needed',
      'Study planning',
      'Headline output',
      'Future exploration',
      'Hypothesis generation',
    ])
      expect(home).toContain(horizon);
    expect(home).toContain('Population evidence is context, not a diagnosis.');
  });

  it('closes with one invitation band and its four routes', () => {
    expect(home).toContain(
      'A global community can build what no single lab can.',
    );
    expect(home).toContain('Open source, for the public good.');
    expect(home).toMatch(/href="\/contribute\/#working-groups"/);
    // Discussion #76 once on Home (spec §1.3).
    expect(
      home.match(/github\.com\/genomeOS\/genomeOS\/discussions\/76/g),
    ).toHaveLength(1);
  });
});
