/**
 * "Counts, not guesses", counted in people (round 2 spec §4.2.5, §11.1; rulings R2-15, R2-16;
 * #454). Owned by the Projects task.
 *
 * The worked example adds up as genotypes do (HBB is autosomal: every person carries two copies),
 * the Jeffreys intervals are computed on the people proportions at build time and match the spec's
 * table, the slider has six stops from 10 to 500 people, a value label never leaves the figure (it
 * flips to the left of a bar that ends past 60% of the axis), and the built figure draws one micro
 * astronaut per person, as `<use>`s of the kit's symbols, never a full astronaut per person.
 */
import { describe, expect, it } from 'vitest';

import {
  AXIS_MAX,
  GRID,
  LABEL_FLIP,
  PEOPLE_STOPS,
  SURVEY_1,
  buildCountsTable,
  carrierPositions,
  carriersOf,
  copiesOf,
  geneCopiesOf,
  labelSide,
  roomAt,
} from '../src/components/project/counts';
import { microSkins } from '../src/graphics/astro/micro';
import { jeffreys } from '../src/graphics/jeffreys';
import { builtHtml } from './helpers/dist';

const table = buildCountsTable(jeffreys);
const projects = builtHtml('projects');

/** The counts figure's outer HTML on the built Projects page. */
function figure(): string {
  const at = projects.indexOf('data-graphic="counts"');
  if (at === -1) return '';
  const start = projects.lastIndexOf('<figure', at);
  return projects.slice(start, projects.indexOf('</figure>', at) + 9);
}

describe('survey 2’s room', () => {
  it('draws the people tested and the people the next stop adds, all of them at the last stop', () => {
    expect(PEOPLE_STOPS.map((_, index) => roomAt(index))).toEqual([
      20, 50, 100, 200, 500, 500,
    ]);
    PEOPLE_STOPS.forEach((tested, index) =>
      expect(roomAt(index)).toBeGreaterThanOrEqual(tested),
    );
  });
});

describe('the worked example, in people', () => {
  it('adds up as genotypes do: 55 with one copy and 3 with two are 58 carriers and 61 copies', () => {
    expect(SURVEY_1).toEqual({ tested: 206, oneCopy: 55, twoCopies: 3 });
    expect(carriersOf(SURVEY_1)).toBe(58);
    expect(copiesOf(SURVEY_1)).toBe(61);
    expect(geneCopiesOf(SURVEY_1)).toBe(412);
    // No one is counted twice: carriers never outnumber the people tested.
    expect(carriersOf(SURVEY_1)).toBeLessThanOrEqual(SURVEY_1.tested);
  });

  it('computes the Jeffreys intervals on carriers among people, as the spec’s table', () => {
    expect(table.survey1.carriers).toBe(58);
    expect(table.survey1.tested).toBe(206);
    expect(table.survey1.lo).toBeCloseTo(0.2235, 4);
    expect(table.survey1.hi).toBeCloseTo(0.3457, 4);
    expect(table.survey1.mean).toBeCloseTo(0.2826, 4);
    expect(table.survey1.range).toBe('22.3–34.6%');
    const upper = [0.2172, 0.1166, 0.0488, 0.0247, 0.0125, 0.005];
    table.stops.forEach((stop, index) => {
      expect(stop.lo).toBe(0);
      expect(stop.hi).toBeCloseTo(upper[index], 4);
    });
    expect(table.stops.map((stop) => stop.range)).toEqual([
      '0–21.7%',
      '0–11.7%',
      '0–4.9%',
      '0–2.5%',
      '0–1.2%',
      '0–0.50%',
    ]);
  });

  it('offers six stops from 10 to 500 people, so a zero out of 500 is strong evidence', () => {
    expect(PEOPLE_STOPS).toEqual([10, 20, 50, 100, 200, 500]);
    expect(table.stops.map((stop) => stop.tested)).toEqual([...PEOPLE_STOPS]);
    // The "strong evidence" end of the copy holds: 0 of 500 leaves at most half a percent.
    expect(table.stops.at(-1)!.hi).toBeLessThanOrEqual(0.0051);
    expect(table.stops[0].hi).toBeGreaterThan(0.2);
  });

  it('writes the slider’s output and spoken value in people', () => {
    expect(table.stops[0].output).toBe(
      '0 of 10: up to 21.7% is still plausible.',
    );
    expect(table.stops[0].valuetext).toBe(
      '10 people tested, none carry it, up to 21.7 percent',
    );
    expect(table.stops.at(-1)!.output).toBe(
      '0 of 500: up to 0.50% is still plausible.',
    );
    expect(table.survey1.sentence).toBe(
      'Survey 1: 58 of 206 people tested carry the variant: 55 with one copy and 3 with two, 61 of their 412 gene copies. Plausible share of carriers 22.3 to 34.6 percent.',
    );
    for (const stop of table.stops)
      expect(stop.sentence).not.toMatch(/allele/i);
  });

  it('flips a value label to the left of a bar that ends past 60% of the axis', () => {
    expect(AXIS_MAX).toBe(0.4);
    expect(LABEL_FLIP).toBe(0.6);
    // 34.6% ends at 86% of a 0–40% axis: the label sits left of the bar.
    expect(labelSide(table.survey1.hi)).toBe('left');
    // 21.7% ends at 54%: right of it.
    expect(labelSide(table.stops[0].hi)).toBe('right');
    expect(labelSide(0.24)).toBe('right');
    expect(labelSide(0.2401)).toBe('left');
    for (const stop of table.stops) expect(labelSide(stop.hi)).toBe('right');
  });
});

describe('the micro astronaut grids', () => {
  it('sets 40 people a row wide and 25 narrow, a glyph to a person', () => {
    expect(GRID.wide).toMatchObject({ columns: 40, pitchX: 20, pitchY: 24 });
    expect(GRID.narrow).toMatchObject({ columns: 25 });
    // Row 1 is 6 rows wide and 9 narrow; row 2 reserves 13 and 20 rows for 500 people.
    expect(Math.ceil(206 / GRID.wide.columns)).toBe(6);
    expect(Math.ceil(500 / GRID.wide.columns)).toBe(13);
    expect(Math.ceil(206 / GRID.narrow.columns)).toBe(9);
    expect(Math.ceil(500 / GRID.narrow.columns)).toBe(20);
  });

  it('seeds 58 distinct carriers among the 206, the same on every build', () => {
    const carriers = carrierPositions();
    expect(carriers).toHaveLength(58);
    expect(new Set(carriers).size).toBe(58);
    for (const index of carriers) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(206);
    }
    expect(carrierPositions()).toEqual(carriers);
  });

  it('never ties carrying the variant to a face’s skin tone', () => {
    // Faces are seeded per position and carriers per position, separately: in every skin tone the
    // share of carriers stays close to the share overall (58 of 206), so no tone reads as "carrier".
    const skins = microSkins(206);
    const carriers = new Set(carrierPositions());
    const overall = 58 / 206;
    for (const tone of new Set(skins)) {
      const people = skins.flatMap((skin, index) =>
        skin === tone ? [index] : [],
      );
      const share =
        people.filter((index) => carriers.has(index)).length / people.length;
      expect(Math.abs(share - overall), tone).toBeLessThan(0.1);
    }
  });
});

describe.skipIf(!projects)('the counts figure on the built page', () => {
  const html = figure();
  const uses = html.match(/<use\b[^>]*>/g) ?? [];

  it('is tagged "Example" and names its rows plainly, never by bare letters', () => {
    expect(html).toContain('data-status="worked-example"');
    expect(html).toContain('>Example<');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Survey 1');
    expect(text).toContain('58 of 206 people carry it');
    expect(text).toContain('Survey 2');
    expect(text).toMatch(/0 of 10 people carry it/);
    expect(text).not.toMatch(/\b[AB] · /);
    expect(text).not.toMatch(/alleles carry it/);
    expect(text).toContain('Carrier');
    expect(text).toContain('Not a carrier');
    expect(text).toContain('Not tested');
    expect(text).toContain('Illustrative surveys; 95% Jeffreys intervals.');
    // The figure's lesson stands under the part's heading, beside the figure, so the split's text
    // column holds more than a heading (design review, round 3).
    const column = projects.match(
      /<div class="layout-figure-split__text proj-counts__text">([\s\S]*?)<\/div>/,
    )![1];
    const words = column.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(words).toContain('Counts, not guesses');
    expect(words).toContain('Zero is weak evidence, not absence.');
    expect(words).toContain(
      'Each person carries two copies of the gene; the Atlas counts copies.',
    );
  });

  it('draws one micro astronaut per person: 706 uses at most, none of them a full astronaut', () => {
    const people = uses.filter((use) => /href="#micro-/.test(use));
    // Row 1 (206) plus row 2's room for 500, and the three legend keys.
    expect(people.length).toBeLessThanOrEqual(706 + 3);
    expect(people.length).toBeGreaterThanOrEqual(706);
    const carriers = people.filter((use) => /micro-face-carrier-/.test(use));
    expect(carriers).toHaveLength(58 + 1);
    // Row 2 at its default stop: 10 tested people, the rest of the room untested.
    expect(
      people.filter((use) => /href="#micro-untested"/.test(use)),
    ).toHaveLength(490 + 1);
    // Drawn: the 10 tested and the 10 more the next stop tests; the other 480 places are not
    // (design critique of the integrated build, round 2).
    expect(people.filter((use) => /\sdata-off\b/.test(use))).toHaveLength(480);
    // The kit's symbols, defined once in the figure.
    expect(html.match(/<symbol\b/g) ?? []).toHaveLength(13);
    expect(html).not.toMatch(/class="astro\b/);
  });

  it('ships the precomputed people table, never a fitter', () => {
    expect(html).toContain('22.3–34.6%');
    expect(html).toContain('0 of 10: up to 21.7% is still plausible.');
    expect(html).toContain(
      'aria-valuetext="10 people tested, none carry it, up to 21.7 percent"',
    );
    expect(html).toMatch(/type="range"[^>]*min="0"[^>]*max="5"/);
    expect(html).not.toContain('betaQuantile');
    // The table lists both surveys, every stop, and the copies behind survey 1.
    const rows = html.match(/<tr>/g) ?? [];
    expect(rows).toHaveLength(1 + 1 + PEOPLE_STOPS.length);
    expect(html).toContain('61 of 412');
  });
});
