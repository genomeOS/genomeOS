/** The scale ladder (site redesign spec §4.2, the vision, #454): four frames from Earth to a cell nucleus,
 * joined by zoom wedges, and a tablist of the three levels of the vision.
 *
 * Geometry for both layouts lives here, so the server render and any test read one source:
 *
 *   row   (stage ≥ 860 px)  Earth → Population → Chromosome 11 → Cell nucleus, left to right
 *   grid  (narrower)        a 2 × 2 "U": Earth → Population across the top, down to Chromosome 11,
 *                           back across the bottom to Cell nucleus, so no wedge crosses a label
 *
 * Each frame's art is drawn once in a 170-unit square and placed by a transform. Frames 3–4 and the
 * bridge (from the HBB tick back to the population it was measured in) are violet dashed: future
 * work. The island selects a level (frames 1–2, frames 3–4, or the bridge) and plays the entrance:
 * frames fade in left to right and each wedge draws from its zoom box, once, in 1.2 s.
 */

import { FigureController } from '../../graphics/figure';
import { initTabs, type TabsChangeDetail } from '../../graphics/tabs';

export type Level = 'earth' | 'cell' | 'bridge';
export type FrameKey = 'earth' | 'population' | 'chromosome' | 'nucleus';
export type Layout = 'row' | 'grid';

export const FRAME = 170;
type Box = readonly [x: number, y: number, w: number, h: number];

/** The zoom box in each frame (local units): the small region the next frame expands. */
export const ZOOM: Record<Exclude<FrameKey, 'nucleus'>, Box> = {
  earth: [110, 74, 24, 24],
  population: [118, 88, 24, 24],
  chromosome: [73, 14, 24, 20],
};
/** The population whose genome the next frames look into, and where the bridge returns. */
export const TARGET_STUD = { x: 130, y: 100, r: 4.25, ring: 20 } as const;
/** The HBB tick on chromosome 11 (11p15.4, near the end of the short arm). */
export const HBB_TICK = { x: 85, y: 24 } as const;

export interface Placement {
  x: number;
  y: number;
  scale: number;
}

export interface LayoutGeometry {
  viewBox: readonly [number, number, number, number];
  font: number;
  frames: Record<FrameKey, Placement>;
  /** Where each frame's label sits (text-anchor middle) and its second line, if any. */
  labels: Record<FrameKey, { x: number; y: number }>;
  bridge: string;
}

export const LAYOUTS: Record<Layout, LayoutGeometry> = {
  row: {
    viewBox: [0, 0, 1000, 272],
    font: 16,
    frames: {
      earth: { x: 10, y: 40, scale: 1 },
      population: { x: 280, y: 40, scale: 1 },
      chromosome: { x: 550, y: 40, scale: 1 },
      nucleus: { x: 820, y: 40, scale: 1 },
    },
    labels: {
      earth: { x: 95, y: 238 },
      population: { x: 365, y: 238 },
      chromosome: { x: 635, y: 238 },
      nucleus: { x: 905, y: 238 },
    },
    bridge: 'M635 54C635 4 410 4 410 116',
  },
  grid: {
    viewBox: [0, 0, 300, 366],
    font: 15,
    frames: {
      earth: { x: 12, y: 30, scale: 120 / FRAME },
      population: { x: 168, y: 30, scale: 120 / FRAME },
      chromosome: { x: 168, y: 196, scale: 120 / FRAME },
      nucleus: { x: 12, y: 196, scale: 120 / FRAME },
    },
    labels: {
      earth: { x: 72, y: 20 },
      population: { x: 228, y: 20 },
      chromosome: { x: 228, y: 338 },
      nucleus: { x: 72, y: 338 },
    },
    bridge: 'M237 213H294V101H276',
  },
};

/** The wedge from frame `from`'s zoom box to the facing edge of the next frame, as two lines. */
export function wedge(
  layout: Layout,
  from: Exclude<FrameKey, 'nucleus'>,
  to: FrameKey,
): [[number, number, number, number], [number, number, number, number]] {
  const { frames } = LAYOUTS[layout];
  const a = frames[from];
  const b = frames[to];
  const [bx, by, bw, bh] = ZOOM[from];
  const box = {
    left: a.x + bx * a.scale,
    right: a.x + (bx + bw) * a.scale,
    top: a.y + by * a.scale,
    bottom: a.y + (by + bh) * a.scale,
  };
  const size = FRAME * b.scale;
  if (b.x > a.x + 1)
    // The next frame is to the right: box's right corners to its left edge.
    return [
      [box.right, box.top, b.x, b.y],
      [box.right, box.bottom, b.x, b.y + size],
    ];
  if (b.x < a.x - 1)
    // To the left: box's left corners to its right edge.
    return [
      [box.left, box.top, b.x + size, b.y],
      [box.left, box.bottom, b.x + size, b.y + size],
    ];
  // Below: box's bottom corners to its top edge.
  return [
    [box.left, box.bottom, b.x, b.y],
    [box.right, box.bottom, b.x + size, b.y],
  ];
}

export const LEVELS: readonly Level[] = ['earth', 'cell', 'bridge'];
export const ENTRANCE_MS = 1200;

export function initLadder(figure: HTMLElement): void {
  const list = figure.querySelector<HTMLElement>('[role="tablist"]');
  const stage = figure.querySelector<HTMLElement>('[data-figure-stage]');
  if (!list || !stage) return;
  const tabs = initTabs(list);
  const apply = (index: number) => {
    const tab = tabs.tabs[index];
    figure.dataset.level = tab.dataset.level ?? LEVELS[index];
    if (tab.dataset.stageLabel)
      stage.setAttribute('aria-label', tab.dataset.stageLabel);
  };
  list.addEventListener('tabs:change', (event) =>
    apply((event as CustomEvent<TabsChangeDetail>).detail.index),
  );
  apply(tabs.selected);

  new FigureController(figure, {
    duration: ENTRANCE_MS,
    arm: () => figure.classList.add('is-armed'),
    start: () => {
      figure.classList.remove('is-armed');
      figure.classList.add('is-playing');
    },
    rest: () => figure.classList.remove('is-armed', 'is-playing'),
  });
}
