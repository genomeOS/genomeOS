/** The Atlas preview's island: Home's toy globe (site redesign spec §4.1, §2.7, §6.1; round 2 spec
 * §4.1.5; rulings R2-2, R2-16 and 22–25 of the round-2 build; #454).
 *
 * The page is complete without it: AtlasPreview.astro renders the Modeled layer at rest as a
 * poster, with each label drawn on the globe beside its point, placed from the provenance sidecar.
 * This island decodes the pinned HbS (rs334) figure data once the figure nears the viewport, swaps a
 * live canvas in for the poster and adds:
 *
 *   entrance   2.8 s in evidence order (land, studs west to east, modeled cells outward from the
 *              surveys, then the hatch), the globe turning 20° to its starting view the way the
 *              Earth turns; each label lights as its marks arrive. Plays once (FigureController).
 *   rotation   after a 5 s hold on the starting view, a slow turn (4° a second, one revolution in
 *              90 s, the Earth's way: features drift west to east), easing in over 1.6 s on every
 *              start. Pointing at the stage or focusing anything in the figure eases it to a stop
 *              over 400 ms; a drag stops it at once; it turns again 4 s after the last of these
 *              ends. A Pause control (a white glyph, ruling 22) stops it until Play (WCAG 2.2.2).
 *              Never under reduced motion, in poster mode or forced colours; never while less than
 *              1% of the globe is on screen or the tab is hidden (AutoSpin).
 *   labels     each label (Measured: people tested; Modeled: estimate and range; No estimate) rides
 *              on the globe beside its own point: whole while the point is within 60° of the view
 *              centre, fading out by 72°, never leaving the disc or covering another label or point
 *              (placeLabels flips the side it sits on). They are drawn in an aria-hidden SVG, so no
 *              fading text is ever read as text (ruling 25); a visually hidden list always holds
 *              their words. On the Measured layer only the Measured label shows: the others name
 *              marks that layer does not draw.
 *   layers     Measured / Modeled, a 240 ms cross-fade (a new switch cancels the last)
 *   drag/keys  drag turns (pointer capture, inertia ≤ 1 s, latitude −60…70°); arrow keys turn 8°;
 *              Home returns to the starting view.
 *   fallback   slow frames cap the pixel ratio, then fall back to the poster; Save-Data and forced
 *              colours keep the poster (spec §2.2), so the figure is then its poster: the Modeled
 *              starting view, with its labels, no layer control and nothing that turns.
 *   hooks      the figure registers as the `atlas-preview` scene (round 2 spec §3.4): seeking maps
 *              0–2,800 ms to the entrance, then the 5 s hold, then the turn by elapsed time.
 *
 * Measured and modeled stay separate marks throughout (hexfield.ts); nothing here maps the width
 * of a range to colour (spec §6.3).
 */

import {
  prefersReducedMotion,
  type FigureController,
} from '../../graphics/figure';
import {
  decodeAreas,
  decodeSurveys,
  type Area,
  type Survey,
} from '../../graphics/figure-data';
import { HexField, type HexLayer, type Reveal } from '../../graphics/hexfield';
import { MOTION_HOOKS, registerScene } from '../../graphics/motion-hooks';
import { normalizeLon, orthographic } from '../../graphics/projection';
import {
  easeCamera,
  easeUi,
  tween,
  type FrameScheduler,
  type Tween,
} from '../../graphics/tween';
import { steadyEntrance } from './steady-entrance';

/** Entrance length (spec §4.1 motion table). */
export const ENTRANCE_MS = 2800;
/** The starting view: the globe's centre, [lon, lat]. The labels are placed for this view. */
export const REST_VIEW: readonly [number, number] = [18, 8];
/** The entrance turns the globe this far, ending at the starting view. */
export const TURN_DEG = 20;
/** The globe box is this much wider than the disc, so limb studs keep their rings. */
export const DISC_PAD = 1.04;
/** The disc radius (CSS px) whose studs are drawn at full size. */
export const STUD_REFERENCE_RADIUS = 225;

/** Rotation: degrees of longitude a second (one revolution in 90 s; round 2 spec §4.1.5). */
export const SPIN_DEG_PER_S = 4;
/** The starting view, with its labels, holds this long after the entrance. */
export const SPIN_DWELL_MS = 5000;
/** Rotation resumes this long after the visitor stops pointing at, dragging or focusing it. */
export const SPIN_IDLE_MS = 4000;
/** Each start eases up to full speed over this long. */
export const SPIN_RAMP_MS = 1600;
/** Pointing or focus eases the turn to a stop over this long; a drag stops it at once. */
export const SPIN_EASE_OUT_MS = 400;
/** The rotation draws at most 30 frames a second: at 4°/s that is still under a pixel a frame. */
export const SPIN_FRAME_MS = 1000 / 30;

/**
 * The studs' share of their full size on a disc of this radius: they shrink with the disc (a
 * phone's is about a quarter smaller), so over West Africa or India they stay points and the
 * Modeled layer shows between them (design review, round 1). Never below 0.6.
 */
export const previewStudScale = (radius: number): number =>
  Math.min(1, Math.max(0.6, radius / STUD_REFERENCE_RADIUS));

const LAT_LIMITS = [-60, 70] as const;
const KEY_STEP_DEG = 8;
const INERTIA_MS = 1000;
const LAYER_FADE_MS = 240;
const HOME_MS = 600;
const DRAG_THRESHOLD_PX = 4;
/** Frame-time fallback ladder (spec §4.1): median draw time of 10 frames, ms. */
const SLOW_FRAME_MS = 16;
const POSTER_FRAME_MS = 24;
/** Below this share of the globe on screen the rotation stops (round 2 spec §2.3). */
const ON_SCREEN_SHARE = 0.01;
const DEG = 180 / Math.PI;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampLat = (lat: number) =>
  Math.min(LAT_LIMITS[1], Math.max(LAT_LIMITS[0], lat));
/** Smoothstep: the ramp up to full speed, and the labels' fade. */
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export interface EntranceFrame {
  reveal: Reveal;
  /** Globe centre, [lon, lat]. */
  view: [number, number];
  /** Labels lit, 0–3. */
  callouts: number;
}

/**
 * The entrance at `t` ms (spec §4.1): 0–0.3 s land, 0.3–1.0 s studs (label 1 at 1.0 s), 1.0–2.4 s
 * modeled cells (label 2 at 2.4 s), 2.4–2.8 s hatch (label 3 at 2.8 s); the globe turns 20° to its
 * starting view on the camera ease throughout, the Earth's way (its centre's longitude falls), as
 * the rotation that follows does.
 */
export function entranceAt(t: number): EntranceFrame {
  const turn = easeCamera(clamp01(t / ENTRANCE_MS));
  return {
    reveal: {
      land: clamp01(t / 300),
      studs: clamp01((t - 300) / 700),
      surface: clamp01((t - 1000) / 1400),
      hatch: clamp01((t - 2400) / 400),
    },
    view: [REST_VIEW[0] + TURN_DEG * (1 - turn), REST_VIEW[1]],
    callouts: t >= ENTRANCE_MS ? 3 : t >= 2400 ? 2 : t >= 1000 ? 1 : 0,
  };
}

/**
 * Degrees the rotation has turned `elapsed` ms after it starts: the speed times the smoothstep
 * ramp, integrated. Past the ramp, half the ramp's length is lost and the rest runs at full speed.
 */
export function spinAngleAt(
  elapsed: number,
  speed = SPIN_DEG_PER_S,
  rampMs = SPIN_RAMP_MS,
): number {
  const perMs = speed / 1000;
  if (elapsed <= 0) return 0;
  if (elapsed >= rampMs) return perMs * (rampMs / 2 + (elapsed - rampMs));
  const u = elapsed / rampMs;
  return perMs * rampMs * (u ** 3 - u ** 4 / 2);
}

/** A share as a number of percent: whole from 10%, one decimal from 1%, two below. */
export function formatPercent(value: number): string {
  const percent = value * 100;
  if (percent === 0) return '0';
  if (percent >= 10) return String(Math.round(percent));
  return percent.toFixed(percent >= 1 ? 1 : 2);
}

export const formatShare = (value: number): string =>
  `${formatPercent(value)}%`;

/** A 95% range as "7.2–28%". */
export const formatRange = (lo: number, hi: number): string =>
  `${formatPercent(lo)}–${formatPercent(hi)}%`;

export const formatKm = (km: number): string =>
  `${Math.round(km).toLocaleString('en-US')} km`;

/**
 * Layer switches cross-fade over 240 ms (spec §4.1). A switch inside a running fade cancels it, so
 * two quick switches never draw alternate layers on alternate frames. Reduced motion, or an
 * `instant` switch (the poster's return to Modeled), switches at once.
 */
export function layerFader(
  apply: (layer: HexLayer, amount: number) => void,
  options: { reduced?: boolean; schedule?: FrameScheduler } = {},
): (next: HexLayer, instant?: boolean) => void {
  let running: Tween | null = null;
  return (next, instant = false) => {
    running?.cancel();
    running = null;
    if (options.reduced || instant) {
      apply(next, 1);
      return;
    }
    apply(next, 0);
    running = tween(
      LAYER_FADE_MS,
      (amount) => apply(next, amount),
      easeUi,
      options.schedule,
    );
  };
}

/* ------------------------------------------------------------------ the labels */

export type LabelKind = 'survey' | 'modeled' | 'unknown';
/**
 * Where a label's text sits beside its point: on a side (right, left, below, above), and along it
 * centred (the bare side), or for right and left hanging `down` from the point (its first line level
 * with it) or rising `up` (its last line level with it), or for below and above running off to the
 * `right` or `left` from the point's ring.
 */
export type LabelSide =
  | 'right'
  | 'right-down'
  | 'right-up'
  | 'left'
  | 'left-down'
  | 'left-up'
  | 'below'
  | 'below-right'
  | 'below-left'
  | 'above'
  | 'above-right'
  | 'above-left';
/**
 * The order a label tries its places in, after the one it is on (which it keeps while it fits):
 * beside the point first, the cartographer's habit, then under or over it.
 */
export const LABEL_SIDES: readonly LabelSide[] = [
  'right',
  'left',
  'right-down',
  'right-up',
  'left-down',
  'left-up',
  'below',
  'above',
  'below-right',
  'below-left',
  'above-right',
  'above-left',
];

/** Label geometry, CSS px (atlas-preview.css draws the same). */
export const LABEL_GEOMETRY = {
  /** From the point to the near edge of its text: past the ring, its halo and the plate's edge. */
  gap: 16,
  /** Line height; the text is 13 px (spec §2.3's label floor). */
  line: 16,
  /** The first baseline below the top of a line box. */
  baseline: 12.5,
  /** The plate behind the text reaches this far past it, across and down. */
  plate: [6, 3] as const,
  /** At least this much space between two labels' plates. */
  gutter: 2,
  /** The ring round the point; the box another label keeps out of is 2 px wider. */
  ring: 6,
  /** A plate stays this far inside the disc's edge. */
  edge: 2,
} as const;

/** A label is whole while its point is within 60° of the view centre, and gone past 72°. */
export const LABEL_FACING_DEG = [60, 72] as const;
const FACING_COSC = LABEL_FACING_DEG.map((degrees) =>
  Math.cos(degrees / DEG),
) as [number, number];

/**
 * The smallest disc a label must fit at rest: the compact form at a 320 px screen (a 288 px globe
 * box, radius 138 px), with a little to spare. AtlasPreview.astro places the rest labels for it.
 */
export const LABEL_MIN_RADIUS = 136;

/** The facing opacity of a label whose point has this cosine of its angle from the view centre. */
export function labelAlpha(cosc: number): number {
  const [whole, gone] = FACING_COSC;
  if (cosc >= whole) return 1;
  if (cosc <= gone) return 0;
  return smooth((cosc - gone) / (whole - gone));
}

export interface LabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far a below/above label running right or left starts behind its point: past the ring. */
const RUN_BACK = LABEL_GEOMETRY.ring + 2;

/** The top of a label's text block for `side`, relative to its point (y down). */
function blockTop(side: LabelSide, height: number): number {
  const { gap, line } = LABEL_GEOMETRY;
  if (side.startsWith('below')) return gap;
  if (side.startsWith('above')) return -gap - height;
  if (side.endsWith('-down')) return -line / 2;
  if (side.endsWith('-up')) return line / 2 - height;
  return -height / 2;
}

/** The text block of a label at (x, y) on `side`, in px relative to the same origin. */
export function labelBox(
  x: number,
  y: number,
  side: LabelSide,
  width: number,
  height: number,
): LabelBox {
  const { gap } = LABEL_GEOMETRY;
  const top = y + blockTop(side, height);
  let left: number;
  if (side.startsWith('right')) left = x + gap;
  else if (side.startsWith('left')) left = x - gap - width;
  else if (side.endsWith('-right')) left = x - RUN_BACK;
  else if (side.endsWith('-left')) left = x + RUN_BACK - width;
  else left = x - width / 2;
  return { left, right: left + width, top, bottom: top + height };
}

/** Where a label's lines go for `side`: the anchor, x and each baseline, relative to its point. */
export function labelText(
  side: LabelSide,
  lines: number,
): { anchor: 'start' | 'end' | 'middle'; x: number; ys: number[] } {
  const { gap, line, baseline } = LABEL_GEOMETRY;
  const top = blockTop(side, lines * line);
  const [anchor, x]: ['start' | 'end' | 'middle', number] = side.startsWith(
    'right',
  )
    ? ['start', gap]
    : side.startsWith('left')
      ? ['end', -gap]
      : side.endsWith('-right')
        ? ['start', -RUN_BACK]
        : side.endsWith('-left')
          ? ['end', RUN_BACK]
          : ['middle', 0];
  return {
    anchor,
    x,
    ys: Array.from(
      { length: lines },
      (_, index) => top + baseline + index * line,
    ),
  };
}

/** The plate behind a label's text for `side`, relative to its point. */
export function labelPlate(
  side: LabelSide,
  width: number,
  lines: number,
): { x: number; y: number; width: number; height: number } {
  const [across, down] = LABEL_GEOMETRY.plate;
  const box = labelBox(0, 0, side, width, lines * LABEL_GEOMETRY.line);
  return {
    x: box.left - across,
    y: box.top - down,
    width: box.right - box.left + 2 * across,
    height: box.bottom - box.top + 2 * down,
  };
}

/** A label's lines, from the sidecar's callouts: a bold kind, then its value in words. */
export function labelLines(
  kind: LabelKind,
  sidecar: {
    callouts: readonly {
      kind: string;
      people?: number;
      mean?: number;
      lo?: number;
      hi?: number;
    }[];
  },
): string[] {
  const entry = sidecar.callouts.find((callout) => callout.kind === kind)!;
  switch (kind) {
    case 'survey':
      // Counts in people (R2-16): HBB is autosomal, so AN / 2 people were tested, exactly.
      return [
        'Measured',
        `${entry.people!.toLocaleString('en-US')} people tested`,
      ];
    case 'modeled':
      return [
        'Modeled',
        `about ${formatShare(entry.mean!)},`,
        `likely ${formatRange(entry.lo!, entry.hi!)}`,
      ];
    case 'unknown':
      return ['No estimate', 'no survey in range'];
  }
}

/** Figtree's advance widths at 13 px, tabular numerals: the wider of the label's two weights. */
const GLYPHS =
  ' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,.%–-:()';
const GLYPH_PX = [
  3.2, 6.7, 7.6, 6.9, 7.6, 7.0, 5.1, 7.6, 7.4, 3.4, 3.8, 6.9, 3.2, 11.3, 7.4,
  7.4, 7.7, 7.5, 4.9, 6.1, 5.2, 7.4, 7.2, 10.8, 6.9, 7.4, 6.4, 9.2, 8.0, 9.5,
  9.1, 7.7, 7.2, 9.9, 9.8, 3.7, 7.1, 8.6, 7.0, 11.2, 10.1, 10.2, 7.8, 10.3, 8.4,
  8.0, 7.6, 9.2, 9.4, 12.8, 8.7, 8.3, 8.3, 8.2, 8.2, 8.2, 8.2, 8.2, 8.2, 8.2,
  8.2, 8.2, 8.2, 3.3, 3.2, 10.5, 7.2, 5.4, 3.8, 4.9, 4.9,
];

/**
 * A generous width for a label's lines, for the build's rest layout (the island measures the real
 * one once the font is in): the sum of each glyph's advance, 6% and 2 px over. Sums run within 3%
 * of what the browser lays out (kerning only tightens them); a glyph not in the table counts as
 * wide as an m.
 */
export function estimateLabelWidth(lines: readonly string[]): number {
  return Math.ceil(
    Math.max(
      ...lines.map(
        (line) =>
          [...line].reduce((sum, glyph) => {
            const index = GLYPHS.indexOf(glyph);
            return sum + (index === -1 ? 11.3 : GLYPH_PX[index]);
          }, 0) *
            1.06 +
          2,
      ),
    ),
  );
}

export interface LabelInput {
  kind: LabelKind;
  /** The point, px from the disc's centre (y down). */
  x: number;
  y: number;
  /** Cosine of the point's angle from the view centre. */
  cosc: number;
  /** The text block, px. */
  width: number;
  height: number;
  /** The side it is on now, kept while it still fits. */
  side?: LabelSide | null;
  /** False when the label's layer is off (it names marks not drawn). */
  shown?: boolean;
}

export interface LabelPlacement {
  kind: LabelKind;
  side: LabelSide | null;
  /** The facing opacity (labelAlpha). */
  alpha: number;
  /** A side was found that keeps it inside the disc and clear of the others. */
  fits: boolean;
  box: LabelBox | null;
}

const grow = (box: LabelBox, x: number, y = x): LabelBox => ({
  left: box.left - x,
  top: box.top - y,
  right: box.right + x,
  bottom: box.bottom + y,
});

const intersects = (a: LabelBox, b: LabelBox) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const insideDisc = (box: LabelBox, radius: number) =>
  [
    [box.left, box.top],
    [box.right, box.top],
    [box.left, box.bottom],
    [box.right, box.bottom],
  ].every(([x, y]) => Math.hypot(x, y) <= radius);

/**
 * Place the labels so each one's plate sits inside the disc, clear of the other plates and of every
 * shown label's point. A small search: each label tries the place it is on first (so nothing jumps
 * while its place still works), then LABEL_SIDES in order; earlier labels win a contested spot.
 * Only when no layout holds them all is a label hidden, the last ones first. A label facing away
 * (labelAlpha 0) or whose layer is off is out of the layout altogether.
 */
export function placeLabels(
  labels: readonly LabelInput[],
  radius: number,
): LabelPlacement[] {
  const {
    plate: [across, down],
    gutter,
    ring,
    edge,
  } = LABEL_GEOMETRY;
  const alphas = labels.map((label) =>
    label.shown === false ? 0 : labelAlpha(label.cosc),
  );
  const active = labels
    .map((_, index) => index)
    .filter((index) => alphas[index] > 0);
  const rings = labels.map((label) => ({
    left: label.x - ring - 2,
    right: label.x + ring + 2,
    top: label.y - ring - 2,
    bottom: label.y + ring + 2,
  }));
  /** Each active label's places whose plate fits the disc and clears every other shown point. */
  const options = new Map(
    active.map((index) => {
      const label = labels[index];
      const order = [
        ...new Set([...(label.side ? [label.side] : []), ...LABEL_SIDES]),
      ];
      return [
        index,
        order
          .map((side) => {
            const box = labelBox(
              label.x,
              label.y,
              side,
              label.width,
              label.height,
            );
            return { side, box, plate: grow(box, across, down) };
          })
          .filter(
            ({ plate }) =>
              insideDisc(plate, radius - edge) &&
              active.every(
                (other) => other === index || !intersects(plate, rings[other]),
              ),
          ),
      ] as const;
    }),
  );
  const chosen = new Map<
    number,
    { side: LabelSide; box: LabelBox; plate: LabelBox }
  >();
  /** Depth-first over the labels in order; `hidden` of them may be left out. */
  const search = (position: number, hidden: number): boolean => {
    if (position === active.length) return true;
    const index = active[position];
    for (const option of options.get(index)!) {
      const reach = grow(option.plate, gutter);
      if ([...chosen.values()].some(({ plate }) => intersects(reach, plate)))
        continue;
      chosen.set(index, option);
      if (search(position + 1, hidden)) return true;
      chosen.delete(index);
    }
    // Leave this one out only if a later choice cannot make room for it.
    return hidden > 0 && search(position + 1, hidden - 1);
  };
  for (let hidden = 0; hidden <= active.length; hidden += 1) {
    chosen.clear();
    if (search(0, hidden)) break;
  }
  return labels.map((label, index) => {
    const place = chosen.get(index);
    return {
      kind: label.kind,
      side: place?.side ?? label.side ?? null,
      alpha: alphas[index],
      fits: Boolean(place),
      box: place?.box ?? null,
    };
  });
}

/* ------------------------------------------------------------------ the rotation */

/**
 * What the rotation is doing:
 *   off       not allowed (no live globe yet, the poster, or reduced motion)
 *   paused    the visitor pressed Pause
 *   held      the visitor is pointing at, dragging or focusing the figure
 *   waiting   the hold on the starting view, or the idle wait after a hold
 *   stopped   off screen, or the tab is hidden
 *   running   turning
 */
export type SpinState =
  'off' | 'paused' | 'held' | 'waiting' | 'stopped' | 'running';

/** The clock the rotation runs on; tests drive a fake one. */
export interface SpinClock {
  now(): number;
  frame(callback: (now: number) => void): number;
  cancelFrame(id: number): void;
  timer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
}

const browserClock: SpinClock = {
  now: () => performance.now(),
  frame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  timer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (id) => window.clearTimeout(id),
};

/** Holds that ease the turn to a stop; any other (a drag) stops it at once. */
const EASED_HOLDS: ReadonlySet<string> = new Set(['hover', 'focus']);

export interface AutoSpinOptions {
  onState?(state: SpinState): void;
  clock?: SpinClock;
  speed?: number;
  dwellMs?: number;
  idleMs?: number;
  rampMs?: number;
  easeOutMs?: number;
  frameMs?: number;
}

/**
 * The toy globe's slow rotation (ruling R2-2). It turns only when allowed (`enable`), on screen,
 * in a visible tab, not paused by the visitor, not held, and once its wait is over: the hold on the
 * starting view after `enable`, or the idle wait after the last hold ends. Frames are scheduled only
 * while it runs (and for the 400 ms a pointing or focus hold takes to ease it to a stop), at most
 * one per `frameMs`, and each start eases up to speed.
 */
export class AutoSpin {
  state: SpinState = 'off';
  private enabled = false;
  private paused = false;
  private onScreen = false;
  private pageShown = true;
  private ready = false;
  private readonly holds = new Set<string>();
  private wait = 0;
  private raf = 0;
  private last = 0;
  private began = 0;
  /** The ease-out after a pointing or focus hold: when it began, and the speed share it began at. */
  private easing: { from: number; share: number } | null = null;
  private readonly clock: SpinClock;
  private readonly speed: number;
  private readonly dwellMs: number;
  private readonly idleMs: number;
  private readonly rampMs: number;
  private readonly easeOutMs: number;
  private readonly frameMs: number;

  constructor(
    private readonly turn: (degrees: number) => void,
    private readonly options: AutoSpinOptions = {},
  ) {
    this.clock = options.clock ?? browserClock;
    this.speed = options.speed ?? SPIN_DEG_PER_S;
    this.dwellMs = options.dwellMs ?? SPIN_DWELL_MS;
    this.idleMs = options.idleMs ?? SPIN_IDLE_MS;
    this.rampMs = options.rampMs ?? SPIN_RAMP_MS;
    this.easeOutMs = options.easeOutMs ?? SPIN_EASE_OUT_MS;
    this.frameMs = options.frameMs ?? SPIN_FRAME_MS;
  }

  /** The globe is live at its starting view: hold it there, then turn. */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.waitFor(this.dwellMs);
  }

  /** Back to off (the poster took over, or reduced motion). */
  disable(): void {
    this.enabled = false;
    this.clearWait();
    this.update();
  }

  /** The visitor's Pause (true) or Play (false). Play turns at once. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.clearWait();
      this.ready = true;
    }
    this.update();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  hold(reason: string): void {
    const wasRunning = this.state === 'running';
    const share = this.share(this.clock.now());
    this.holds.add(reason);
    this.clearWait();
    this.ready = false;
    if (wasRunning && EASED_HOLDS.has(reason))
      this.easing = { from: this.clock.now(), share };
    else if (!EASED_HOLDS.has(reason)) this.easing = null;
    this.update();
  }

  release(reason: string): void {
    if (!this.holds.delete(reason)) return;
    if (this.holds.size === 0) this.waitFor(this.idleMs);
    else this.update();
  }

  setOnScreen(onScreen: boolean): void {
    this.onScreen = onScreen;
    this.update();
  }

  setPageShown(shown: boolean): void {
    this.pageShown = shown;
    this.update();
  }

  /** The share of full speed at `now`: the ramp while running, the ease-out while easing. */
  private share(now: number): number {
    if (this.state === 'running')
      return smooth((now - this.began) / this.rampMs);
    if (this.state === 'held' && this.easing) {
      const p = clamp01((now - this.easing.from) / this.easeOutMs);
      return this.easing.share * (1 - p) ** 2;
    }
    return 0;
  }

  private clearWait(): void {
    if (this.wait) this.clock.clearTimer(this.wait);
    this.wait = 0;
  }

  private waitFor(ms: number): void {
    this.clearWait();
    this.ready = false;
    this.wait = this.clock.timer(() => {
      this.wait = 0;
      this.ready = true;
      this.update();
    }, ms);
    this.update();
  }

  private update(): void {
    const next: SpinState = !this.enabled
      ? 'off'
      : this.paused
        ? 'paused'
        : this.holds.size > 0
          ? 'held'
          : !this.ready
            ? 'waiting'
            : !this.onScreen || !this.pageShown
              ? 'stopped'
              : 'running';
    if (next !== this.state) {
      this.state = next;
      this.options.onState?.(next);
    }
    if (next !== 'held') this.easing = null;
    const moving = next === 'running' || (next === 'held' && this.easing);
    if (moving && !this.raf) {
      this.last = this.clock.now();
      if (next === 'running') this.began = this.last;
      this.raf = this.clock.frame(this.tick);
    } else if (!moving && this.raf) {
      this.clock.cancelFrame(this.raf);
      this.raf = 0;
    }
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    const easing = this.state === 'held' && this.easing;
    if (this.state !== 'running' && !easing) return;
    const dt = now - this.last;
    if (dt >= this.frameMs - 1) {
      // A long gap (a stalled tab) never jumps the globe.
      const step = Math.min(dt, 100);
      this.last = now;
      this.turn(-((this.speed * step) / 1000) * this.share(now));
    }
    if (easing && now - this.easing!.from >= this.easeOutMs) {
      this.easing = null;
      return;
    }
    this.raf = this.clock.frame(this.tick);
  };
}

/* ------------------------------------------------------------------ the island */

interface PreviewConfig {
  domain: [number, number];
  /** The labels' objects, by index into the decoded surveys and areas. */
  survey: number;
  modeled: number;
  unknown: number;
}

interface PreviewData {
  areas: Area[];
  surveys: Survey[];
}

const BINARIES = import.meta.glob(
  [
    '../../data/figures/hbs-globe.*.bin',
    '../../data/figures/hbs-surveys.*.bin',
  ],
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>;

const binary = (prefix: string) =>
  Object.entries(BINARIES).find(([path]) => path.includes(`/${prefix}.`))![1];

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

/** Decode off the critical path (spec §7: globe init ≤ 30 ms desktop). */
const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: 300 });
    else setTimeout(resolve, 0);
  });

async function loadData(): Promise<PreviewData> {
  const [globe, surveys] = await Promise.all([
    fetchBytes(binary('hbs-globe')),
    fetchBytes(binary('hbs-surveys')),
  ]);
  await idle();
  return { areas: decodeAreas(globe), surveys: decodeSurveys(surveys) };
}

function saveData(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return Boolean(connection?.saveData);
}

/** The figure's data load starts this far ahead of the viewport. */
const LOAD_AHEAD = '600px 0px';

/** One on-globe label as the island holds it. */
interface Label {
  kind: LabelKind;
  order: number;
  group: SVGGElement;
  body: SVGGElement;
  text: SVGTextElement;
  plate: SVGRectElement;
  lines: SVGTSpanElement[];
  side: LabelSide;
  /** The side the build placed it on for the starting view. */
  restSide: LabelSide;
  width: number;
  /** Its object, [lon, lat], once the data are in. */
  target: [number, number] | null;
}

export function initAtlasPreview(figure: HTMLElement): void {
  // One island per figure, whoever starts it (AtlasPreview.astro's loader, or a page script).
  if (figure.hasAttribute('data-island')) return;
  figure.setAttribute('data-island', '');
  const globe = figure.querySelector<HTMLElement>('.hg-globe');
  const canvas = globe?.querySelector<HTMLCanvasElement>('.hg-canvas');
  const stage = figure.querySelector<HTMLElement>('[data-figure-stage]');
  const spinToggle =
    figure.querySelector<HTMLButtonElement>('[data-spin-toggle]');
  if (!globe || !canvas || !stage || !spinToggle) return;

  const config = JSON.parse(globe.dataset.config ?? '{}') as PreviewConfig;
  const reduced = prefersReducedMotion();

  let loading: Promise<PreviewData> | null = null;
  let field: HexField | null = null;
  let controller: FigureController | null = null;
  let layer: HexLayer = 'modeled';
  let view: [number, number] = [REST_VIEW[0], REST_VIEW[1]];
  let posterOnly = false;
  let probed = false;
  let motion: Tween | null = null;
  let inertia = 0;
  const projection = orthographic({
    center: REST_VIEW,
    scale: 1,
    translate: [0, 0],
  });

  figure.dataset.view = 'rest';
  figure.dataset.spin = 'off';
  // Printing shows the final state (spec §8) at the starting view, as the poster draws it.
  let printing =
    typeof matchMedia === 'function' && matchMedia('print').matches;

  /* ---- the labels ---- */

  const labels: Label[] = [
    ...figure.querySelectorAll<SVGGElement>('.hg-label'),
  ].map((group) => ({
    kind: group.dataset.label as LabelKind,
    order: Number(group.dataset.order),
    group,
    body: group.querySelector<SVGGElement>('.hg-label__body')!,
    text: group.querySelector<SVGTextElement>('.hg-label__text')!,
    plate: group.querySelector<SVGRectElement>('.hg-label__plate')!,
    lines: [...group.querySelectorAll<SVGTSpanElement>('tspan')],
    side: group.dataset.side as LabelSide,
    restSide: group.dataset.side as LabelSide,
    width: Number(group.dataset.width),
    target: null,
  }));
  /** Labels lit by the entrance (all of them at rest). */
  let lit = 3;

  /** Set a label's text and plate for its side and width. */
  const layout = (label: Label) => {
    label.group.dataset.side = label.side;
    const text = labelText(label.side, label.lines.length);
    label.text.setAttribute('text-anchor', text.anchor);
    label.lines.forEach((line, index) => {
      line.setAttribute('x', String(text.x));
      line.setAttribute('y', String(text.ys[index]));
    });
    const plate = labelPlate(label.side, label.width, label.lines.length);
    for (const [name, value] of Object.entries(plate))
      label.plate.setAttribute(name, String(value));
  };

  /** The real widths, once the site's font is in: the build only estimated them. */
  const measure = () => {
    for (const label of labels) {
      const widths = label.lines.map((line) => line.getComputedTextLength());
      if (!widths.every((width) => width > 0)) continue;
      const width = Math.ceil(Math.max(...widths));
      if (width === label.width) continue;
      label.width = width;
      layout(label);
    }
  };

  const setSide = (label: Label, side: LabelSide) => {
    if (label.side === side) return;
    label.side = side;
    layout(label);
  };

  /** Each label beside its point at the current view, faded by how far the point has turned. */
  const renderLabels = () => {
    if (!field) return;
    const width = globe.clientWidth;
    const height = globe.clientHeight;
    if (width === 0) return;
    const radius = width / 2 / DISC_PAD;
    const allShown = printing || posterOnly;
    const inputs: LabelInput[] = labels.map((label) => {
      const [x, y, cosc] = label.target
        ? projection.project(label.target[0], label.target[1])
        : [width / 2, height / 2, -1];
      return {
        kind: label.kind,
        x: x - width / 2,
        y: y - height / 2,
        cosc,
        width: label.width,
        height: label.lines.length * LABEL_GEOMETRY.line,
        // During the entrance and at the starting view a label prefers the side the build gave
        // it, so the rest picture is the same with motion or without; as the globe turns it keeps
        // the side it is on, so it does not jump back and forth.
        side: atRest() || entering ? label.restSide : label.side,
        // The Measured layer draws no estimates, so the Modeled label names nothing there; the
        // hatch for areas with no estimate is drawn on both layers, so its label stays (review of
        // T1). A label the entrance has not lit yet takes no room, or a lit one would take a side
        // and then jump to its rest side when the next lights (review of T1, 320 × 640).
        shown:
          allShown ||
          ((layer === 'modeled' || label.kind !== 'modeled') &&
            !(entering && label.order > lit)),
      };
    });
    placeLabels(inputs, radius).forEach((placement, index) => {
      const label = labels[index];
      const input = inputs[index];
      if (placement.side) setSide(label, placement.side);
      label.group.style.setProperty(
        '--lx',
        `${(input.x + width / 2).toFixed(1)}px`,
      );
      label.group.style.setProperty(
        '--ly',
        `${(input.y + height / 2).toFixed(1)}px`,
      );
      label.group.style.opacity = placement.alpha.toFixed(3);
      label.body.classList.toggle(
        'is-off',
        !placement.fits || (!allShown && label.order > lit),
      );
    });
  };

  /* ---- the rotation and its control ---- */

  const spin = new AutoSpin(
    (degrees) => {
      setView(view[0] + degrees, view[1]);
      probe();
    },
    {
      onState(state) {
        figure.dataset.spin = state;
        spinToggle.hidden = state === 'off';
        const paused = spin.isPaused;
        spinToggle.setAttribute('aria-pressed', String(paused));
        spinToggle.dataset.state = paused ? 'paused' : 'playing';
      },
    },
  );
  spinToggle.addEventListener('click', () => spin.setPaused(!spin.isPaused));
  new IntersectionObserver(
    ([entry]) =>
      spin.setOnScreen(
        entry.isIntersecting && entry.intersectionRatio >= ON_SCREEN_SHARE,
      ),
    { threshold: [0, ON_SCREEN_SHARE] },
  ).observe(globe);
  document.addEventListener('visibilitychange', () =>
    spin.setPageShown(!document.hidden),
  );

  /* ---- view ---- */

  const atRest = () =>
    Math.abs(normalizeLon(view[0] - REST_VIEW[0])) < 1e-6 &&
    Math.abs(view[1] - REST_VIEW[1]) < 1e-6;
  /** True while the entrance turns the globe. */
  let entering = false;
  /**
   * Turn to [lon, lat]. data-view is `rest` at the starting view, `entering` during the entrance
   * and `moved` otherwise.
   */
  const setView = (lon: number, lat: number) => {
    view = [normalizeLon(lon), clampLat(lat)];
    projection.rotate(view);
    field?.draw();
    figure.dataset.view = atRest() ? 'rest' : entering ? 'entering' : 'moved';
    if (MOTION_HOOKS) {
      figure.dataset.viewLon = view[0].toFixed(2);
      figure.dataset.viewLat = view[1].toFixed(2);
    }
    renderLabels();
  };
  const stopMotion = () => {
    motion?.cancel();
    motion = null;
    if (inertia) cancelAnimationFrame(inertia);
    inertia = 0;
  };
  const finishEntrance = () => {
    if (controller && controller.state !== 'rest') controller.finish();
    entering = false;
  };

  /** Back to the starting view. */
  const goHome = (animate = !reduced) => {
    stopMotion();
    const [lon0, lat0] = view;
    const dLon = normalizeLon(REST_VIEW[0] - lon0);
    const dLat = REST_VIEW[1] - lat0;
    if (!animate || atRest()) {
      setView(REST_VIEW[0], REST_VIEW[1]);
      return;
    }
    motion = tween(
      HOME_MS,
      (eased) =>
        eased >= 1
          ? setView(REST_VIEW[0], REST_VIEW[1])
          : setView(lon0 + dLon * eased, lat0 + dLat * eased),
      easeCamera,
    );
  };

  /* ---- layers ---- */

  // Layers cross-fade; the legend swaps to the layer's own marks.
  const fadeTo = layerFader((next, amount) => field?.setLayer(next, amount), {
    reduced,
  });
  const layerButtons = [
    ...figure.querySelectorAll<HTMLButtonElement>('.hg-layers button'),
  ];
  /** Show `next`: its pressed segment, its legend, its labels and (live) its marks. */
  const selectLayer = (next: HexLayer, instant = false) => {
    layer = next;
    for (const button of layerButtons)
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.value === next),
      );
    for (const legend of figure.querySelectorAll<HTMLElement>('[data-legend]'))
      legend.toggleAttribute('data-active', legend.dataset.legend === next);
    if (field) fadeTo(next, instant);
    renderLabels();
  };

  /* ---- live canvas or poster ---- */

  const forcedColours =
    typeof matchMedia === 'function'
      ? matchMedia('(forced-colors: active)')
      : null;
  /** Slow frames, Save-Data or missing data hold the poster for good; forced colours can end. */
  let posterHeld = false;

  const goLive = () => {
    if (!posterOnly) figure.dataset.live = '';
  };
  /** The poster is the Modeled layer at the starting view: the legend, labels and view match it. */
  const usePoster = (hold = true) => {
    posterHeld ||= hold;
    posterOnly = true;
    spin.disable();
    stopMotion();
    finishEntrance();
    figure.dataset.mode = 'poster';
    delete figure.dataset.live;
    if (drag) {
      drag = null;
      delete figure.dataset.dragging;
    }
    if (layer !== 'modeled') selectLayer('modeled', true);
    lit = 3;
    setView(REST_VIEW[0], REST_VIEW[1]);
  };
  /** Forced colours ended: the live globe returns at its starting view, unless the poster is held. */
  const leavePoster = () => {
    if (!posterOnly || posterHeld) return;
    posterOnly = false;
    delete figure.dataset.mode;
    void ensureData().then(() => {
      if (posterOnly) return;
      restState();
      goLive();
      allowSpin();
    });
  };
  /** The fallback ladder (spec §4.1): read once, after 10 frames of the entrance, a drag or a turn. */
  const probe = () => {
    if (!field || probed || !field.probe.full) return;
    probed = true;
    const median = field.probe.median();
    if (median > POSTER_FRAME_MS) usePoster();
    else if (median > SLOW_FRAME_MS) {
      field.graticule = false;
      field.capPixelRatio(1);
    }
  };

  const restState = () => {
    field!.reveal = { land: 1, studs: 1, surface: 1, hatch: 1 };
    lit = 3;
    setView(REST_VIEW[0], REST_VIEW[1]);
  };
  /** The rotation, wherever motion is allowed and the globe is live. */
  const allowSpin = () => {
    if (!reduced && !posterOnly) spin.enable();
  };

  const build = (loaded: PreviewData) => {
    field = new HexField(canvas, {
      areas: loaded.areas,
      surveys: loaded.surveys,
      projection,
      domain: config.domain,
      layer,
      globe: true,
      studScale: (width) => previewStudScale(width / 2 / DISC_PAD),
      fit(width, height, target) {
        target.scale = width / 2 / DISC_PAD;
        target.translate = [width / 2, height / 2];
      },
    });
    const survey = loaded.surveys[config.survey];
    const targets: Record<LabelKind, [number, number]> = {
      survey: [survey.lon, survey.lat],
      modeled: loaded.areas[config.modeled].center,
      unknown: loaded.areas[config.unknown].center,
    };
    for (const label of labels) label.target = targets[label.kind];
    void document.fonts?.ready.then(() => {
      measure();
      renderLabels();
    });
    measure();
    new ResizeObserver(() => {
      field?.resize();
      renderLabels();
    }).observe(globe);
  };

  let builtResolve: () => void = () => {};
  const built = new Promise<void>((resolve) => (builtResolve = resolve));

  const ensureData = (): Promise<PreviewData> => {
    loading ??= loadData().then((loaded) => {
      build(loaded);
      if (posterOnly) restState();
      return loaded;
    });
    return loading;
  };

  const start = async () => {
    await ensureData();
    if (posterOnly) {
      builtResolve();
      return;
    }
    // The controller holds the figure's state (armed, playing or rest). It plays when 35% of the
    // figure is in view (MotionController), or rests at once under reduced motion or when the data
    // arrive with the figure already on screen.
    controller = steadyEntrance(
      figure,
      {
        duration: ENTRANCE_MS,
        arm() {
          goLive();
          entering = true;
          const frame = entranceAt(0);
          field!.reveal = frame.reveal;
          lit = frame.callouts;
          setView(frame.view[0], frame.view[1]);
        },
        render(t) {
          const frame = entranceAt(t);
          field!.reveal = frame.reveal;
          lit = frame.callouts;
          setView(frame.view[0], frame.view[1]);
          probe();
        },
        rest() {
          entering = false;
          goLive();
          restState();
          allowSpin();
        },
      },
      {
        // The preview registers its own "atlas-preview" scene (entrance, hold and turn) below.
        register: false,
      },
    );
    registerPreview();
    builtResolve();
    if (printing) controller.finish();
  };

  /** The preview as a scrubbable scene (motion hooks; a no-op in the deployed build). */
  let scrubbed = 0;
  const registerPreview = () => {
    if (!MOTION_HOOKS) return;
    const dwellEnd = ENTRANCE_MS + SPIN_DWELL_MS;
    registerScene({
      name: 'atlas-preview',
      story: ENTRANCE_MS,
      ready: () => built,
      seek(ms) {
        scrubbed = ms;
        if (posterOnly || !field) return;
        stopMotion();
        // The entrance rests (its own frames stop); the rotation is held, not paused, so the
        // visitor's control still offers Pause. The requested moment is then drawn.
        finishEntrance();
        spin.hold('scrub');
        if (ms < ENTRANCE_MS) {
          const frame = entranceAt(ms);
          field.reveal = frame.reveal;
          lit = frame.callouts;
          entering = true;
          setView(frame.view[0], frame.view[1]);
          entering = false;
          return;
        }
        restState();
        if (ms > dwellEnd)
          setView(REST_VIEW[0] - spinAngleAt(ms - dwellEnd), REST_VIEW[1]);
      },
      pause: () => spin.setPaused(true),
      play: () => {
        spin.release('scrub');
        spin.setPaused(false);
      },
      get time() {
        return scrubbed;
      },
    });
  };

  window.addEventListener('beforeprint', () => {
    printing = true;
    if (field) {
      lit = 3;
      setView(REST_VIEW[0], REST_VIEW[1]);
    }
  });
  window.addEventListener('afterprint', () => {
    printing = false;
    setView(view[0], view[1]);
  });

  /* ---- interaction ---- */

  let drag: {
    id: number;
    x: number;
    y: number;
    from: [number, number];
    moved: boolean;
    lastX: number;
    lastT: number;
    speed: number;
  } | null = null;
  const radius = () => canvas.clientWidth / 2 / DISC_PAD;
  const turns = () => Boolean(field) && !posterOnly;

  // Pointing at the stage holds the rotation (a mouse: a touch's hold is its drag).
  stage.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') spin.hold('hover');
  });
  stage.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') spin.release('hover');
  });

  globe.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !turns()) return;
    spin.hold('drag');
    finishEntrance();
    stopMotion();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: [view[0], view[1]],
      moved: false,
      lastX: event.clientX,
      lastT: event.timeStamp,
      speed: 0,
    };
  });

  globe.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
      globe.setPointerCapture(event.pointerId);
      figure.dataset.dragging = '';
    }
    if (!drag.moved) return;
    const r = radius();
    setView(drag.from[0] - (dx / r) * DEG, drag.from[1] + (dy / r) * DEG);
    const dt = Math.max(1, event.timeStamp - drag.lastT);
    drag.speed = ((-(event.clientX - drag.lastX) / r) * DEG) / dt;
    drag.lastX = event.clientX;
    drag.lastT = event.timeStamp;
    probe();
  });

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, speed, lastT } = drag;
    drag = null;
    delete figure.dataset.dragging;
    spin.release('drag');
    // Inertia: at most 1 s, and none under reduced motion.
    const recent = event.timeStamp - lastT < 80;
    if (!moved || reduced || !recent || Math.abs(speed) < 0.01) return;
    let velocity = speed;
    let last = performance.now();
    const began = last;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      velocity *= Math.pow(0.9, dt / 16);
      setView(view[0] + velocity * dt, view[1]);
      if (
        now - began < INERTIA_MS &&
        Math.abs(velocity) > 0.004 &&
        !document.hidden
      )
        inertia = requestAnimationFrame(step);
      else inertia = 0;
    };
    inertia = requestAnimationFrame(step);
  };
  globe.addEventListener('pointerup', endDrag);
  globe.addEventListener('pointercancel', (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    delete figure.dataset.dragging;
    spin.release('drag');
  });

  // Keyboard (or scripted) focus anywhere in the figure holds the rotation while it lasts; the
  // focus a click or tap gives does not, or a mouse visitor's globe would stay still until they
  // clicked elsewhere.
  let pressed = false;
  figure.addEventListener('pointerdown', () => (pressed = true), {
    capture: true,
  });
  figure.addEventListener('focusin', () => {
    if (!pressed) spin.hold('focus');
    pressed = false;
  });
  figure.addEventListener('focusout', (event) => {
    pressed = false;
    const next = event.relatedTarget;
    if (next instanceof Node && figure.contains(next)) return;
    spin.release('focus');
  });
  globe.addEventListener('keydown', (event) => {
    const turn: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP_DEG, 0],
      ArrowRight: [KEY_STEP_DEG, 0],
      ArrowUp: [0, KEY_STEP_DEG],
      ArrowDown: [0, -KEY_STEP_DEG],
    };
    if (event.key in turn) {
      event.preventDefault();
      if (!turns()) return;
      finishEntrance();
      stopMotion();
      const [dLon, dLat] = turn[event.key];
      setView(view[0] + dLon, view[1] + dLat);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (!turns()) return;
      finishEntrance();
      goHome(false);
    }
  });

  figure.addEventListener('segmented:change', (event) => {
    selectLayer((event as CustomEvent<{ value: HexLayer }>).detail.value);
  });

  forcedColours?.addEventListener('change', () => {
    if (forcedColours.matches) usePoster(false);
    else leavePoster();
  });

  if (saveData()) {
    // Save-Data: the poster stays, and no figure data is fetched.
    usePoster();
    builtResolve();
    return;
  }
  if (forcedColours?.matches) {
    usePoster(false);
    builtResolve();
    return;
  }
  // The data load waits until the figure nears the viewport: it is below the hero.
  const near = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      near.disconnect();
      void start().catch(() => {
        // No data, no canvas: the poster and its labels already tell the story.
        usePoster();
        builtResolve();
      });
    },
    { rootMargin: LOAD_AHEAD },
  );
  near.observe(figure);
}
