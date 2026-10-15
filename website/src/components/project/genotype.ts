/** The genotype triad (site redesign spec §4.2, HbS, #454): AA, AS and SS, two allele dots each,
 * and one shared frame that draws the red cell of the selected genotype. Pressing one also tells
 * the HbS map, with a bubbling `genotype:change` event, to show that genotype's expected share of
 * births (ruling 36): one control, one state.
 *
 * Sickling is drawn on the cell (the phenotype), never on the alleles. AA and AS cells are the same
 * round, biconcave disc, because a carrier's red cells look like anyone else's; only SS morphs into
 * a sickle (600 ms, `--ease-camera`; instant under reduced motion). The outline is one polygon of
 * the same number of points in every shape, so the morph is a straight interpolation.
 */

import { prefersReducedMotion } from '../../graphics/figure';
import { easeCamera, tween, type Tween } from '../../graphics/tween';

export type Genotype = 'AA' | 'AS' | 'SS';

const N = 48;
const HALF = N / 2;
const MORPH_MS = 600;

type Point = [number, number];

/** A round red cell: the upper half of the rim, then the lower half back. */
export function discOutline(cx = 60, cy = 60, r = 38): Point[] {
  return Array.from({ length: N }, (_, k) => {
    const angle = Math.PI + (2 * Math.PI * k) / N;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });
}

/**
 * A sickled cell: a crescent between two circles, the outer rim tip to tip over the top, then the
 * inner rim back. The circles meet at the tips, so the crescent tapers to points.
 */
export function sickleOutline(): Point[] {
  const outer = { cx: 60, cy: 64, r: 44 };
  const inner = { cx: 60, cy: 80, r: 40 };
  // Where the rims meet (solved once for these circles): the tips at y = 82.5.
  const tipY = 82.5;
  const tipX = Math.sqrt(outer.r ** 2 - (tipY - outer.cy) ** 2);
  const outerFrom = Math.atan2(tipY - outer.cy, -tipX);
  const outerTo = Math.atan2(tipY - outer.cy, tipX) + 2 * Math.PI;
  const innerFrom = Math.atan2(tipY - inner.cy, tipX) + 2 * Math.PI;
  const innerTo = Math.atan2(tipY - inner.cy, -tipX);
  return Array.from({ length: N }, (_, k): Point => {
    if (k <= HALF) {
      const angle = outerFrom + ((outerTo - outerFrom) * k) / HALF;
      return [
        outer.cx + outer.r * Math.cos(angle),
        outer.cy + outer.r * Math.sin(angle),
      ];
    }
    const angle = innerFrom + ((innerTo - innerFrom) * (k - HALF)) / HALF;
    return [
      inner.cx + inner.r * Math.cos(angle),
      inner.cy + inner.r * Math.sin(angle),
    ];
  });
}

export const OUTLINE: Record<Genotype, Point[]> = {
  AA: discOutline(),
  AS: discOutline(),
  SS: sickleOutline(),
};

export function pathOf(points: readonly Point[]): string {
  return (
    points
      .map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`)
      .join('') + 'Z'
  );
}

const mix = (from: readonly Point[], to: readonly Point[], amount: number) =>
  from.map(([x, y], k): Point => [
    x + (to[k][0] - x) * amount,
    y + (to[k][1] - y) * amount,
  ]);

export function initGenotype(root: HTMLElement): void {
  const frame = root.querySelector<HTMLElement>('[data-genotype]');
  const cell = root.querySelector<SVGPathElement>('[data-cell-outline]');
  const buttons = [
    ...root.querySelectorAll<HTMLButtonElement>('button[data-value]'),
  ];
  if (!frame || !cell || buttons.length === 0) return;
  let current = (frame.dataset.genotype ?? 'AS') as Genotype;
  let shown: Point[] = OUTLINE[current];
  let running: Tween | null = null;

  const select = (next: Genotype) => {
    if (next === current) return;
    for (const button of buttons)
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.value === next),
      );
    frame.dataset.genotype = next;
    current = next;
    // The map listens (hbs-map.ts): the pressed button is the one state both show (ruling 36).
    root.dispatchEvent(
      new CustomEvent('genotype:change', {
        bubbles: true,
        detail: { genotype: next },
      }),
    );
    // One brief outline pulse (CSS, motion allowed only): AA and AS draw the same disc, so the
    // press needs an answer in the frame beyond the allele pair under the cell.
    frame.classList.remove('is-pulse');
    void frame.getBoundingClientRect();
    frame.classList.add('is-pulse');
    running?.cancel();
    const from = shown;
    const to = OUTLINE[next];
    if (prefersReducedMotion()) {
      shown = to;
      cell.setAttribute('d', pathOf(to));
      return;
    }
    running = tween(
      MORPH_MS,
      (eased) => {
        shown = mix(from, to, eased);
        cell.setAttribute('d', pathOf(shown));
      },
      easeCamera,
    );
  };
  for (const button of buttons)
    button.addEventListener('click', () =>
      select(button.dataset.value as Genotype),
    );
  frame.addEventListener('animationend', (event) => {
    if (event.animationName === 'triad-pulse')
      frame.classList.remove('is-pulse');
  });
}
