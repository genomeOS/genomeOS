/** "Counts, not guesses" (site redesign spec §4.1 H2, §6.1 rule 2; #454): two populations as allele
 * grids with Jeffreys 95% intervals, and a slider for how many alleles population B tested.
 *
 * Nothing is fitted in the browser: CountsFigure.astro builds the table at build time with
 * `jeffreys.ts` (passed in, so this module never bundles the fitter) and ships it as JSON; the
 * island only looks values up. A zero is always an interval ("up to X% is still plausible"),
 * never absence, and bar B never collapses below 2 px.
 */

import { FigureController } from '../../graphics/figure';

/** Alleles tested in B: seven stops on a log scale (spec §4.1 H2). */
export const COUNT_STOPS = [20, 50, 100, 200, 500, 1000, 2000] as const;
/** Population A, fixed: 61 of 412 alleles carry the variant. */
export const ROW_A = { ac: 61, an: 412 } as const;
/** The shared axis runs from 0 to 25%. */
export const AXIS_MAX = 0.25;
/**
 * One square per allele, in grids that span the figure (each scales to its width): wide, 80
 * columns of 8 on a 10 pitch (about 9 px squares at 1440 px, big enough to count one allele, not a
 * barcode), so 2,000 alleles are 25 rows; narrow, 80 columns of 3 on a 4 pitch. The marks carry
 * the comparison, not a corner of the figure (spec §4.1 H2; design review, rounds 1 and 2).
 */
export const GRID = {
  wide: { columns: 80, pitch: 10, size: 8 },
  narrow: { columns: 80, pitch: 4, size: 3 },
} as const;
/**
 * A tested allele that does not carry the variant: muted mixed 55% toward the orbit band, 3.5:1 on
 * that band (WCAG 1.4.11 asks 3:1 of a mark the comparison needs) and 4.7:1 under the starlight
 * carriers. Not a data-ramp colour: it says "tested", never a frequency. The room for untested
 * alleles stays well under 3:1 (a faint dot each), so the tested block visibly grows with the
 * slider (design review, round 2).
 */
export const TESTED_FILL = '#5e718a';
/** An untested allele's dot: centred in its square, at most an eighth of the pitch in radius. */
export const ghostDot = (pitch: number) => Math.max(0.5, pitch / 10);
/**
 * Row B reserves the height of the largest stop, so the slider never moves the page; the room is
 * drawn as a ghost grid of the alleles not yet tested, which the slider fills.
 */
export const ROW_B_MAX = COUNT_STOPS[COUNT_STOPS.length - 1];

export type Interval = (
  ac: number,
  an: number,
) => { lo: number; mean: number; hi: number };

/** Percent without the sign: one decimal from 1%, two below (spec §4.1 H2 table). */
export function percentText(value: number): string {
  const percent = value * 100;
  if (percent === 0) return '0';
  return percent.toFixed(percent >= 1 ? 1 : 2);
}

export interface CountsStop {
  an: number;
  lo: number;
  mean: number;
  hi: number;
  /** "11.7%" */
  upper: string;
  /** "0–11.7%" */
  range: string;
  /** The live sentence: "0 of 20: up to 11.7% is still plausible." */
  output: string;
  valuetext: string;
  /** Row B's screen-reader sentence. */
  sentence: string;
}

export interface CountsTable {
  a: {
    ac: number;
    an: number;
    lo: number;
    mean: number;
    hi: number;
    range: string;
    sentence: string;
  };
  stops: CountsStop[];
}

export function buildCountsTable(interval: Interval): CountsTable {
  const a = interval(ROW_A.ac, ROW_A.an);
  return {
    a: {
      ...ROW_A,
      ...a,
      range: `${percentText(a.lo)}–${percentText(a.hi)}%`,
      sentence: `Population A: ${ROW_A.ac} of ${ROW_A.an} sampled alleles carry the variant; plausible share ${percentText(a.lo)} to ${percentText(a.hi)} percent.`,
    },
    stops: COUNT_STOPS.map((an) => {
      const { lo, mean, hi } = interval(0, an);
      const n = an.toLocaleString('en-US');
      const upper = `${percentText(hi)}%`;
      return {
        an,
        lo,
        mean,
        hi,
        upper,
        range: `${percentText(lo)}–${upper}`,
        output: `0 of ${n}: up to ${upper} is still plausible.`,
        valuetext: `${n} alleles tested, none carry it, up to ${percentText(hi)} percent`,
        sentence: `Population B: 0 of ${n} sampled alleles carry the variant; plausible share 0 to ${percentText(hi)} percent.`,
      };
    }),
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The first `n` squares in reading order as two rects: the full rows, then the partial row. */
export function gridRects(
  n: number,
  columns: number,
  pitch: number,
): [Rect, Rect] {
  const full = Math.floor(n / columns);
  const rest = n - full * columns;
  return [
    { x: 0, y: 0, width: full ? columns * pitch : 0, height: full * pitch },
    {
      x: 0,
      y: full * pitch,
      width: rest * pitch,
      height: rest ? pitch : 0,
    },
  ];
}

export const gridHeight = (n: number, columns: number, pitch: number) =>
  Math.ceil(n / columns) * pitch;

/** A position on the shared 0–25% axis, as a percentage of its width. */
export const onAxis = (value: number) =>
  `${((Math.min(value, AXIS_MAX) / AXIS_MAX) * 100).toFixed(3)}%`;

type ClientStop = Pick<
  CountsStop,
  'an' | 'mean' | 'hi' | 'range' | 'output' | 'valuetext' | 'sentence'
>;

export function initCounts(figure: HTMLElement): void {
  const stage = figure.querySelector<HTMLElement>('[data-counts]');
  const slider = figure.querySelector<HTMLInputElement>('input[type="range"]');
  const output = figure.querySelector<HTMLOutputElement>('output');
  if (!stage || !slider || !output) return;
  const { stops } = JSON.parse(stage.dataset.counts!) as {
    stops: ClientStop[];
  };
  const n = figure.querySelector<HTMLElement>('[data-count-n]');
  const bar = figure.querySelector<HTMLElement>('[data-bar="b"]');
  const range = bar?.querySelector<HTMLElement>('.cf-bar__range');
  const mean = bar?.querySelector<HTMLElement>('.cf-bar__mean');
  const value = bar?.querySelector<HTMLElement>('.cf-bar__value');
  const sentence = figure.querySelector<HTMLElement>('[data-row-sentence="b"]');
  const grids = figure.querySelectorAll<SVGSVGElement>('[data-grid="b"]');

  // A CSS-only entrance (counts.css): grid A fills row by row, its carriers light, bar A grows from
  // its mean; row B follows. Under 1.6 s, then rest. Moving the slider ends it at once.
  const controller = new FigureController(figure, {
    duration: 1600,
    rest() {},
  });

  const update = () => {
    if (controller.state !== 'rest') controller.finish();
    const stop = stops[Number(slider.value)] ?? stops[0];
    if (n) n.textContent = stop.an.toLocaleString('en-US');
    if (range) range.style.width = onAxis(stop.hi);
    if (mean) mean.style.left = onAxis(stop.mean);
    if (value) value.textContent = stop.range;
    if (sentence) sentence.textContent = stop.sentence;
    output.textContent = stop.output;
    slider.setAttribute('aria-valuetext', stop.valuetext);
    for (const grid of grids) {
      const rects = gridRects(
        stop.an,
        Number(grid.dataset.columns),
        Number(grid.dataset.pitch),
      );
      grid
        .querySelectorAll<SVGRectElement>('[data-squares]')
        .forEach((rect, index) => {
          const { y, width, height } = rects[index];
          rect.style.y = `${y}px`;
          rect.style.width = `${width}px`;
          rect.style.height = `${height}px`;
        });
    }
  };
  slider.addEventListener('input', update);
}
