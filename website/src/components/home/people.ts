/**
 * The people figure (round 2 spec §4.1.3, §3.3, §11; R2-11, R2-15; #454): of every 100 participants
 * in genome-wide studies up to July 2021, 86 had European ancestry, 1 had African ancestry and 13
 * another ancestry or none recorded (gwas-ancestry.provenance.json, from Fatumo et al. 2022).
 *
 * Two halves in one small module:
 *
 *   counts    pure, used by PeopleFigure.astro at build time and by tests/gwas-ancestry.test.ts:
 *             the sidecar's shares rounded to whole people by the largest remainder.
 *   entrance  client, imported lazily as the figure approaches (pages/index.astro): people appear
 *             in a diagonal wave, the 13 and the 1 settle from the tested grey to their own tones,
 *             the ring draws round the one African-ancestry person, its leader drops and the note
 *             unrolls under it. One 2.1 s story on the scene timeline (src/graphics/timeline.ts),
 *             registered with the motion hooks as `people`, played once at 35% visible, then rest.
 *             Under reduced motion nothing is built: the server-rendered figure is the final state.
 *
 * The note is text, so it never fades (axe reads text at any instant, rulings item 25): it unrolls
 * behind a clip at full contrast.
 */
import { EASE, sceneController } from '../../graphics/timeline';

/** Participants drawn: one micro astronaut each. */
export const PEOPLE_TOTAL = 100;

/**
 * Whole parts of `total` in proportion to `values`: each takes its floor, then the parts with the
 * largest remainders take one more each until the parts add up to `total` (ties go to the first).
 */
export function largestRemainder(values: number[], total: number): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  const exact = values.map((value) => (value / sum) * total);
  const parts = exact.map((value) => Math.floor(value + 1e-9));
  const order = exact
    .map((value, index) => ({ index, rest: value - parts[index] }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  let left = total - parts.reduce((a, b) => a + b, 0);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] += 1;
    left -= 1;
  }
  return parts;
}

export interface AncestryCounts {
  european: number;
  african: number;
  other: number;
}

/** The sidecar's shares as people out of 100, in the figure's three groups. */
export function ancestryCounts(sidecar: {
  shares_percent: { european: number; african: number };
}): AncestryCounts {
  const { european, african } = sidecar.shares_percent;
  const [e, a, o] = largestRemainder(
    [european, african, 100 - european - african],
    PEOPLE_TOTAL,
  );
  return { european: e, african: a, other: o };
}

/* ------------------------------------------------------------------------------- entrance */

/** The entrance's length, ms (spec §4.1.3: ≤ 2.1 s). */
export const PEOPLE_STORY = 2100;
const WAVE_STEP = 22;
const WAVE_MS = 420;

export function initPeople(figure: HTMLElement): void {
  sceneController(
    figure,
    (tl) => {
      // Only the layout on screen moves; the other keeps its final state.
      const svg = [
        ...figure.querySelectorAll<SVGSVGElement>('svg[data-layout]'),
      ].find((candidate) => candidate.getClientRects().length > 0);
      if (!svg) return;
      for (const person of svg.querySelectorAll<SVGElement>('.people__p')) {
        const at =
          WAVE_STEP * (Number(person.dataset.c) + Number(person.dataset.r));
        tl.story(person, [
          [at, { opacity: 0, transform: 'scale(0.4)' }, EASE.out],
          [at + WAVE_MS, { opacity: 1, transform: 'scale(1)' }],
        ]);
      }
      for (const tone of svg.querySelectorAll('.people__tone'))
        tl.story(tone, [
          [950, { opacity: 0 }, EASE.inOut],
          [1500, { opacity: 1 }],
        ]);
      tl.story(svg.querySelector('.people__ring'), [
        [1350, { opacity: 0, transform: 'scale(1.6)' }, EASE.out],
        [1770, { opacity: 1, transform: 'scale(1)' }],
      ]);
      tl.story(svg.querySelector('.people__leader'), [
        [1650, { transform: 'scaleY(0)' }, EASE.out],
        [1890, { transform: 'scaleY(1)' }],
      ]);
      tl.story(figure.querySelector('.people__note'), [
        [1700, { clipPath: 'inset(0 0 100% 0)' }, EASE.out],
        [PEOPLE_STORY, { clipPath: 'inset(0 0 0% 0)' }],
      ]);
    },
    { name: 'people', timeline: { story: PEOPLE_STORY } },
  );
}
