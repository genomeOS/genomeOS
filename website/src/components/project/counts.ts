/**
 * "Counts, not guesses", counted in people (round 2 spec §4.2.5; rulings R2-15, R2-16; site
 * redesign spec §6.1 rule 2; #454): two illustrative surveys, one micro astronaut per person tested,
 * each with a Jeffreys 95% interval for the share of carriers it could plausibly have.
 *
 *   Survey 1   206 people tested: 148 with no copy, 55 with one, 3 with two. That is 58 carriers
 *              and 61 copies of 412 (AC 61 of AN 412: HBB is autosomal, two copies a person). The
 *              figure shows carriers among people, 58 of 206, never "61 people".
 *   Survey 2   no carrier among n people, n on six stops from 10 to 500: a zero out of 10 is weak
 *              evidence, a zero out of 500 strong.
 *
 * Nothing is fitted in the browser: CountsFigure.astro builds the table at build time with
 * `jeffreys.ts` (passed in, so this module never bundles the fitter) and ships it as JSON; the
 * island only looks values up. A zero is always an interval ("up to X% is still plausible"), never
 * absence, and bar 2 never collapses below 2 px.
 *
 * The grids are `<use>`s of the kit's micro astronaut symbols (src/graphics/astro/micro.ts), one per
 * person: 206 in survey 1 and 500 in survey 2, 706 in all, positioned by CSS for the wide and narrow
 * layouts (counts.css), so the slider only swaps `href`s on nodes that exist. Survey 2 draws the
 * people tested and, as faint places, the people the next stop would add (`roomAt`); the places
 * past that are not drawn, and the grid is only as tall as the room it draws. Room for all 500 at
 * every stop left ten astronauts over a void of 490 dots at the default stop (design critique of the
 * integrated build, round 2). As the room grows or shrinks the page scrolls with it, so the slider
 * and the bar under the grid stay where the visitor is looking.
 */

import {
  FigureController,
  prefersReducedMotion,
  type FigureControllerOptions,
} from '../../graphics/figure';
import { mulberry32, SEED } from '../../graphics/rng';

/** A survey's genotype counts: people tested, and how many carry one or two copies. */
export interface GenotypeCounts {
  tested: number;
  oneCopy: number;
  twoCopies: number;
}

/** Survey 1, fixed (spec §4.2.5): 206 people, 55 with one copy and 3 with two. */
export const SURVEY_1 = {
  tested: 206,
  oneCopy: 55,
  twoCopies: 3,
} as const satisfies GenotypeCounts;

/** People who carry at least one copy. */
export const carriersOf = (survey: GenotypeCounts) =>
  survey.oneCopy + survey.twoCopies;
/** Copies of the variant among the people tested: AC. */
export const copiesOf = (survey: GenotypeCounts) =>
  survey.oneCopy + 2 * survey.twoCopies;
/** Gene copies tested: AN, two a person for an autosomal gene. */
export const geneCopiesOf = (survey: GenotypeCounts) => 2 * survey.tested;

/** People tested in survey 2: six stops on a log scale (spec §4.2.5). */
export const PEOPLE_STOPS = [10, 20, 50, 100, 200, 500] as const;
/** Survey 2's places: one node for each person at the largest stop. */
export const ROW_2_ROOM = PEOPLE_STOPS[PEOPLE_STOPS.length - 1];
/**
 * The places survey 2 draws at stop `index`: the people the next stop would test (the faint ones
 * not yet), all of them at the last stop.
 */
export const roomAt = (index: number): number =>
  PEOPLE_STOPS[Math.min(Math.max(index, 0) + 1, PEOPLE_STOPS.length - 1)];
/** The shared axis runs from 0 to 40%, ticked at 0, 20 and 40. */
export const AXIS_MAX = 0.4;
export const AXIS_TICKS = [0, 0.2, 0.4] as const;
/**
 * A value label sits right of its bar, or left of it when the bar ends past this share of the
 * axis, so it never leaves the figure (the prototype overflowed at 390 px before this rule).
 */
export const LABEL_FLIP = 0.6;

export const labelSide = (hi: number): 'left' | 'right' =>
  Math.min(hi, AXIS_MAX) / AXIS_MAX > LABEL_FLIP ? 'left' : 'right';

/** A position on the shared axis, as a percentage of its width. */
export const onAxis = (value: number) =>
  `${((Math.min(Math.max(value, 0), AXIS_MAX) / AXIS_MAX) * 100).toFixed(3)}%`;

/**
 * The grids, one micro astronaut (16 × 20 units) per person, in the spec's own units: wide (figure
 * 34rem and up), 40 a row on a 20 × 24 pitch; narrow, 25 a row on a 14.2 × 17.5 pitch with an
 * 11-unit glyph (about 11 × 14 px on a 390 px phone). Both share one 800-unit-wide viewBox: the
 * narrow layout is drawn `NARROW_SCALE` times larger in it (counts.css switches by container query).
 */
export const GRID = {
  wide: { columns: 40, pitchX: 20, pitchY: 24, glyph: 16 },
  narrow: { columns: 25, pitchX: 14.2, pitchY: 17.5, glyph: 11 },
} as const;
export const GLYPH = { width: 16, height: 20 } as const;
export const VIEW_WIDTH = GRID.wide.columns * GRID.wide.pitchX;
const NARROW_SCALE = VIEW_WIDTH / (GRID.narrow.columns * GRID.narrow.pitchX);

/** One layout's numbers in viewBox units, for counts.css. */
export const layoutUnits = {
  wide: {
    pitchX: GRID.wide.pitchX,
    pitchY: GRID.wide.pitchY,
    scale: GRID.wide.glyph / GLYPH.width,
  },
  narrow: {
    pitchX: +(GRID.narrow.pitchX * NARROW_SCALE).toFixed(3),
    pitchY: +(GRID.narrow.pitchY * NARROW_SCALE).toFixed(3),
    scale: +((GRID.narrow.glyph / GLYPH.width) * NARROW_SCALE).toFixed(4),
  },
} as const;

/** A grid of `capacity` people: each layout's row count and height in viewBox units. */
export function gridBox(capacity: number) {
  const rows = {
    wide: Math.ceil(capacity / GRID.wide.columns),
    narrow: Math.ceil(capacity / GRID.narrow.columns),
  };
  return {
    rows,
    height: {
      wide: rows.wide * layoutUnits.wide.pitchY,
      narrow: +(rows.narrow * layoutUnits.narrow.pitchY).toFixed(2),
    },
  };
}

/** Person `index`'s column and row in each layout. */
export const cellOf = (index: number) => ({
  c: index % GRID.wide.columns,
  r: Math.floor(index / GRID.wide.columns),
  n: index % GRID.narrow.columns,
  m: Math.floor(index / GRID.narrow.columns),
});

/**
 * Survey 1's carriers: `count` distinct people among `tested`, chosen by a Fisher–Yates shuffle
 * seeded with mulberry32(SEED), so every build draws them in the same places. Faces are seeded per
 * position by the kit (`microSkins`), separately, and no skin tone gathers the carriers
 * (tests/counts-people.test.ts).
 */
export function carrierPositions(
  tested: number = SURVEY_1.tested,
  count: number = carriersOf(SURVEY_1),
  seed: number = SEED,
): number[] {
  const random = mulberry32(seed);
  const order = Array.from({ length: tested }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [order[index], order[pick]] = [order[pick], order[index]];
  }
  return order.slice(0, count).sort((a, b) => a - b);
}

export type Interval = (
  ac: number,
  an: number,
) => { lo: number; mean: number; hi: number };

/** Percent without the sign: one decimal from 1%, two below (spec §4.2.5 table). */
export function percentText(value: number): string {
  const percent = value * 100;
  if (percent === 0) return '0';
  return percent.toFixed(percent >= 1 ? 1 : 2);
}

const whole = (value: number) => value.toLocaleString('en-US');

export interface CountsStop {
  tested: number;
  lo: number;
  mean: number;
  hi: number;
  /** "0–21.7%" */
  range: string;
  /** The live sentence: "0 of 10: up to 21.7% is still plausible." */
  output: string;
  valuetext: string;
  /** Survey 2's screen-reader sentence. */
  sentence: string;
}

export interface CountsTable {
  survey1: {
    tested: number;
    carriers: number;
    oneCopy: number;
    twoCopies: number;
    copies: number;
    geneCopies: number;
    lo: number;
    mean: number;
    hi: number;
    range: string;
    sentence: string;
  };
  stops: CountsStop[];
}

/** The figure's table: Jeffreys intervals on carriers among people, survey 1 and every stop. */
export function buildCountsTable(interval: Interval): CountsTable {
  const carriers = carriersOf(SURVEY_1);
  const copies = copiesOf(SURVEY_1);
  const geneCopies = geneCopiesOf(SURVEY_1);
  const one = interval(carriers, SURVEY_1.tested);
  const range = `${percentText(one.lo)}–${percentText(one.hi)}%`;
  return {
    survey1: {
      ...SURVEY_1,
      carriers,
      copies,
      geneCopies,
      ...one,
      range,
      sentence: `Survey 1: ${carriers} of ${whole(SURVEY_1.tested)} people tested carry the variant: ${SURVEY_1.oneCopy} with one copy and ${SURVEY_1.twoCopies} with two, ${copies} of their ${whole(geneCopies)} gene copies. Plausible share of carriers ${percentText(one.lo)} to ${percentText(one.hi)} percent.`,
    },
    stops: PEOPLE_STOPS.map((tested) => {
      const { lo, mean, hi } = interval(0, tested);
      const n = whole(tested);
      const upper = `${percentText(hi)}%`;
      return {
        tested,
        lo,
        mean,
        hi,
        range: `${percentText(lo)}–${upper}`,
        output: `0 of ${n}: up to ${upper} is still plausible.`,
        valuetext: `${n} people tested, none carry it, up to ${percentText(hi)} percent`,
        sentence: `Survey 2: none of ${n} people tested carry the variant. Plausible share of carriers 0 to ${percentText(hi)} percent.`,
      };
    }),
  };
}

/** What the island needs of each stop. */
export type ClientStop = Pick<
  CountsStop,
  'tested' | 'range' | 'output' | 'valuetext' | 'sentence'
> & { hi: string; side: 'left' | 'right' };

export const clientStop = (stop: CountsStop): ClientStop => ({
  tested: stop.tested,
  hi: onAxis(stop.hi),
  side: labelSide(stop.hi),
  range: stop.range,
  output: stop.output,
  valuetext: stop.valuetext,
  sentence: stop.sentence,
});

/** The micro astronaut a survey-2 place shows: a tested face, or the faint untested dot. */
export const placeHref = (tested: boolean, skin: string) =>
  tested ? `#micro-face-tested-${skin}` : '#micro-untested';

/** Survey 2's grid style for a room of `room` places (counts.css reads it). */
export const roomStyle = (room: number) => {
  const box = gridBox(room);
  return {
    '--wide-h': String(box.height.wide),
    '--narrow-h': String(box.height.narrow),
    '--wide-rows': String(box.rows.wide),
    '--narrow-rows': String(box.rows.narrow),
  };
};

/**
 * The island: the entrance (CSS, counts.css, once at 35%, under 1.6 s) and the slider. Moving the
 * slider ends the entrance at once, then updates survey 2's count, bar, value, sentence, output
 * and spoken value, and swaps the grid's `href`s; people newly tested fade in over 240 ms (at once
 * under reduced motion).
 */
export function initCounts(
  figure: HTMLElement,
  options?: FigureControllerOptions,
): void {
  const stage = figure.querySelector<HTMLElement>('[data-counts]');
  const slider = figure.querySelector<HTMLInputElement>('input[type="range"]');
  const output = figure.querySelector<HTMLOutputElement>('output');
  if (!stage || !slider || !output) return;
  const { stops } = JSON.parse(stage.dataset.counts!) as {
    stops: ClientStop[];
  };
  const count = figure.querySelector<HTMLElement>('[data-count-n]');
  const bar = figure.querySelector<HTMLElement>('[data-bar="2"]');
  const value = bar?.querySelector<HTMLElement>('.cf-bar__value');
  const sentence = figure.querySelector<HTMLElement>('[data-row-sentence="2"]');
  const grid = figure.querySelector<SVGSVGElement>('[data-grid="2"]');
  const places = [
    ...figure.querySelectorAll<SVGUseElement>('[data-grid="2"] use[data-s]'),
  ];
  let shown = stops[Number(slider.value)]?.tested ?? stops[0].tested;
  let room = roomAt(Number(slider.value));

  const controller = new FigureController(
    figure,
    { duration: 1600, rest() {} },
    options,
  );

  const update = () => {
    if (controller.state !== 'rest') controller.finish();
    const stop = stops[Number(slider.value)] ?? stops[0];
    if (count) count.textContent = stop.tested.toLocaleString('en-US');
    if (bar) {
      bar.style.setProperty('--hi', stop.hi);
      bar.dataset.side = stop.side;
    }
    if (value) value.textContent = stop.range;
    if (sentence) sentence.textContent = stop.sentence;
    output.textContent = stop.output;
    slider.setAttribute('aria-valuetext', stop.valuetext);
    const fade = !prefersReducedMotion();
    const next = roomAt(Number(slider.value));
    // Where the slider stands before the room changes: the page scrolls back to it after.
    const before = next === room ? 0 : slider.getBoundingClientRect().top;
    places.forEach((place, index) => {
      const drawn = index < next;
      if (drawn !== index < room) place.toggleAttribute('data-off', !drawn);
      const tested = index < stop.tested;
      if (tested === index < shown) return;
      place.setAttribute('href', placeHref(tested, place.dataset.s!));
      if (tested && fade)
        place.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 240,
          easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
        });
    });
    if (next !== room && grid) {
      for (const [name, value] of Object.entries(roomStyle(next)))
        grid.style.setProperty(name, value);
      const moved = slider.getBoundingClientRect().top - before;
      if (Math.abs(moved) >= 0.5)
        window.scrollBy({ top: moved, behavior: 'instant' });
    }
    room = next;
    shown = stop.tested;
  };
  slider.addEventListener('input', update);
}
