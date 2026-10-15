/**
 * The astronaut poses (round 2 spec §3.1; R2-6; #454), ported from the design prototype
 * (`r2/characters/kit/rig.js`). A pose is a record of joint angles or IK hand targets; two-bone IK
 * (rig.ts `solve`) fits it to every build.
 *
 * Arms: 0 hangs down, -90 points forward (screen-right), 180 points up. Legs: negative swings
 * forward. Hand targets are functions of the figure's geometry (`Geom`), so one pose fits every
 * build. Raised hands go beside the visor, never across it (wave, idea, paint); hammer and pick ride
 * the far hand, so a wind-up passes behind the helmet.
 *
 * Every beat R2-6 names is covered: float/land, hop, walk, sit, chat, scroll a list, lightbulb
 * idea, hammer and inspect, present, think (hand on chin), nod, carry, fit a block, celebrate.
 */
import type { Build, CastMember } from './cast';

export type Point = [number, number];

/** Facial expressions; the rig swaps them instantly (opacity tracks). */
export type Expr = 'smile' | 'focus' | 'think' | 'happy' | 'talk' | 'open';

/** Props a hand can hold (rig.ts `PROP`). */
export type HeldProp =
  'hammer' | 'pick' | 'brush' | 'palette' | 'tablet' | 'clipboard';

/** The visor's box, in head coordinates about the neck pivot. */
export interface VisorBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  cx: number;
  cy: number;
  /** helmet centre relative to the neck pivot */
  hy: number;
}

/** Anchor points of one cast member's body, before hop and lean (rig.ts `geom`). */
export interface Geom {
  b: Build;
  cast: CastMember;
  legLen: number;
  hipY: number;
  top: number;
  neck: Point;
  /** helmet centre */
  hc: Point;
  tw: number;
  hr: number;
  visor: VisorBox;
  /** near and far shoulder */
  shN: Point;
  shF: Point;
  chin: Point;
  sitDrop: number;
  reach: number;
  bench: { x: number; top: number; block: number };
}

/** A pose as authored: angles in degrees, or hand targets the IK solves. */
export interface PoseSpec {
  sN?: number;
  eN?: number;
  sF?: number;
  eF?: number;
  hN?: number;
  kN?: number;
  hF?: number;
  kF?: number;
  head?: number;
  lean?: number;
  ant?: number;
  /** squash (+) or stretch (−) of the whole body */
  sq?: number;
  /** extra whole-body rotation about the hips, added to lean */
  spin?: number;
  /** height off the ground (negative is up), or 'sit' for the seat's drop */
  y?: number | 'sit';
  expr?: Expr;
  handN?: (g: Geom) => Point;
  handF?: (g: Geom) => Point;
  bendN?: number;
  bendF?: number;
  prop?: HeldProp;
  propAbs?: number;
  propF?: HeldProp;
  propFAbs?: number;
  prop2?: HeldProp;
  /** a block held in two hands, at this point */
  block?: (g: Geom) => Point;
  blockLit?: boolean;
  /** draw the workbench (and its block) beside the figure */
  bench?: boolean;
  /** draw the seat under the figure */
  seat?: boolean;
}

/** A pose after IK: every joint an angle, the height a number. */
export interface SolvedPose extends PoseSpec {
  sN: number;
  eN: number;
  sF: number;
  eF: number;
  hN: number;
  kN: number;
  hF: number;
  kF: number;
  head: number;
  lean: number;
  ant: number;
  sq: number;
  y: number;
  blockAt?: Point;
}

/** Where the hammer's hand is when its head (length `len`) meets the bench block at `abs` degrees. */
export function hammerHand(g: Geom, abs: number, len = 20): Point {
  const a = (abs * Math.PI) / 180;
  const hx = g.bench.x - 2;
  const hy = g.bench.top - g.bench.block - 5;
  return [hx - len * Math.sin(a), hy + len * Math.cos(a)];
}

const SIT = { hN: -88, kN: 86, hF: -80, kF: 80, y: 'sit', seat: true } as const;

export type PoseName =
  | 'stand'
  | 'wave'
  | 'hop'
  | 'crouch'
  | 'walkA'
  | 'walkB'
  | 'walkMid'
  | 'sit'
  | 'chat'
  | 'listen'
  | 'think'
  | 'hammerUp'
  | 'hammerHit'
  | 'inspect'
  | 'present'
  | 'carry'
  | 'give'
  | 'celebrate'
  | 'scroll'
  | 'idea'
  | 'point'
  | 'fit'
  | 'float'
  | 'mineUp'
  | 'mineHit'
  | 'push'
  | 'paint'
  | 'probe'
  | 'nod'
  | 'clipboard';

export const POSES: Record<PoseName, PoseSpec> = {
  stand: { sN: -8, eN: -12, sF: 8, eF: -10, ant: -14 },
  wave: {
    handN: (g) => [g.shN[0] + 21, g.top - 10],
    bendN: 1,
    sF: 8,
    eF: -10,
    head: -6,
    ant: -6,
    expr: 'happy',
  },
  hop: {
    handN: (g) => [g.shN[0] + 22, g.shN[1] - 12],
    handF: (g) => [g.shF[0] - 22, g.shF[1] - 12],
    bendF: -1,
    hN: -30,
    kN: 52,
    hF: 10,
    kF: 42,
    head: -6,
    lean: -8,
    y: -34,
    ant: 16,
    expr: 'happy',
    sq: 0.05,
  },
  crouch: {
    handN: (g) => [g.shN[0] - 10, g.shN[1] + 18],
    handF: (g) => [g.shF[0] - 14, g.shF[1] + 16],
    hN: -40,
    kN: 70,
    hF: -30,
    kF: 62,
    head: 6,
    lean: 10,
    y: 6,
    ant: -30,
    sq: -0.08,
  },
  walkA: {
    sN: 30,
    eN: -24,
    sF: -28,
    eF: -24,
    hN: -28,
    kN: 10,
    hF: 24,
    kF: 24,
    head: 2,
    lean: 4,
    y: -1,
    ant: -22,
  },
  walkB: {
    sN: -26,
    eN: -20,
    sF: 26,
    eF: -18,
    hN: 22,
    kN: 22,
    hF: -24,
    kF: 8,
    head: 2,
    lean: 4,
    y: -1,
    ant: -18,
  },
  walkMid: {
    sN: 2,
    eN: -14,
    sF: 0,
    eF: -14,
    hN: -2,
    kN: 18,
    hF: 4,
    kF: 2,
    head: 1,
    lean: 3,
    y: -3.5,
    ant: -26,
  },
  sit: {
    ...SIT,
    handN: (g) => [g.tw / 2 + 11, g.hipY - 3],
    handF: (g) => [g.tw / 2 + 3, g.hipY - 1],
    head: 4,
    ant: -12,
  },
  chat: {
    handN: (g) => [g.shN[0] + 17, g.shN[1] - 6],
    sF: 6,
    eF: -10,
    head: -5,
    lean: -3,
    ant: -18,
    expr: 'talk',
  },
  listen: { sN: -6, eN: -40, sF: 10, eF: -30, head: 6, lean: 2, ant: -10 },
  think: {
    handN: (g) => g.chin,
    bendN: 1,
    handF: (g) => [g.shF[0] + 4, g.hipY + 2],
    bendF: -1,
    head: -8,
    lean: 2,
    ant: -6,
    expr: 'think',
  },
  hammerUp: {
    ...SIT,
    bench: true,
    propF: 'hammer',
    propFAbs: -20,
    handF: (g) => [g.shF[0] - 2, g.top - 16],
    bendF: -1,
    handN: (g) => [g.bench.x - 11, g.bench.top - 6],
    head: 6,
    lean: -4,
    ant: -6,
    expr: 'focus',
  },
  hammerHit: {
    ...SIT,
    bench: true,
    propF: 'hammer',
    propFAbs: 96,
    handF: (g) => hammerHand(g, 96),
    handN: (g) => [g.bench.x - 11, g.bench.top - 6],
    head: 14,
    lean: 10,
    ant: -26,
    expr: 'focus',
  },
  inspect: {
    ...SIT,
    bench: true,
    propF: 'hammer',
    propFAbs: 8,
    handF: (g) => [g.tw / 2 + 4, g.hipY - 9],
    handN: (g) => [g.bench.x - 6, g.bench.top - 9],
    head: 18,
    lean: 16,
    ant: -30,
    expr: 'focus',
  },
  present: {
    handN: (g) => [g.shN[0] + 16, g.top - 22],
    handF: (g) => [g.shF[0] - 18, g.shF[1] - 8],
    bendF: -1,
    block: (g) => [g.shN[0] + 18, g.top - 34],
    blockLit: true,
    hN: -4,
    kN: 4,
    hF: 6,
    kF: 6,
    head: -12,
    lean: -6,
    ant: -2,
    expr: 'happy',
  },
  carry: {
    block: (g) => [g.tw / 2 + 10, g.top + 14],
    handN: (g) => [g.tw / 2 + 15, g.top + 18],
    handF: (g) => [g.tw / 2 + 4, g.top + 14],
    hN: -14,
    kN: 10,
    hF: 14,
    kF: 18,
    head: 5,
    lean: -3,
    y: -1,
    ant: -20,
  },
  give: {
    block: (g) => [g.tw / 2 + 20, g.top + 4],
    blockLit: true,
    handN: (g) => [g.tw / 2 + 25, g.top + 9],
    handF: (g) => [g.tw / 2 + 13, g.top + 5],
    head: 4,
    lean: 3,
    ant: -14,
    expr: 'happy',
  },
  celebrate: {
    handN: (g) => [g.shN[0] + 18, g.shN[1] - 24],
    handF: (g) => [g.shF[0] - 18, g.shF[1] - 24],
    bendF: -1,
    bendN: -1,
    hN: -24,
    kN: 50,
    hF: 20,
    kF: 56,
    head: -8,
    lean: -3,
    y: -30,
    ant: 22,
    expr: 'happy',
    sq: 0.06,
  },
  scroll: {
    handN: (g) => [g.shN[0] + 14, g.top + 15],
    prop: 'tablet',
    propAbs: 16,
    sF: 6,
    eF: -12,
    head: 12,
    lean: 2,
    ant: -16,
    expr: 'focus',
  },
  idea: {
    handN: (g) => [g.shN[0] + 21, g.top - 6],
    bendN: 1,
    sF: 8,
    eF: -12,
    head: -12,
    lean: -4,
    ant: 8,
    expr: 'open',
  },
  point: {
    handN: (g) => [g.shN[0] + 26, g.shN[1] - 8],
    sF: 8,
    eF: -12,
    head: -4,
    lean: -2,
    ant: -8,
    expr: 'happy',
  },
  fit: {
    block: (g) => [g.tw / 2 + 24, g.top - 2],
    blockLit: true,
    handN: (g) => [g.tw / 2 + 15, g.top + 3],
    handF: (g) => [g.tw / 2 + 13, g.top - 6],
    hN: 18,
    kN: 6,
    hF: -14,
    kF: 8,
    head: 2,
    lean: 9,
    ant: -26,
    expr: 'focus',
  },
  float: {
    handN: (g) => [g.shN[0] + 22, g.shN[1] - 3],
    handF: (g) => [g.shF[0] - 22, g.shF[1] - 3],
    bendF: -1,
    hN: -12,
    kN: 32,
    hF: 16,
    kF: 44,
    head: -4,
    lean: -12,
    y: -26,
    ant: 24,
  },
  mineUp: {
    propF: 'pick',
    propFAbs: -30,
    handF: (g) => [g.shF[0] - 4, g.top - 14],
    bendF: -1,
    handN: (g) => [g.shN[0] + 14, g.top + 14],
    hN: -16,
    kN: 12,
    hF: 16,
    kF: 10,
    head: -2,
    lean: -8,
    ant: 10,
    expr: 'focus',
  },
  mineHit: {
    propF: 'pick',
    propFAbs: 118,
    handF: (g) => [g.tw / 2 + 6, g.top + 14],
    handN: (g) => [g.tw / 2 + 12, g.top + 18],
    hN: -18,
    kN: 16,
    hF: 18,
    kF: 12,
    head: 12,
    lean: 16,
    ant: -28,
    expr: 'focus',
  },
  push: {
    handN: (g) => [g.tw / 2 + 18, g.top + 10],
    handF: (g) => [g.tw / 2 + 14, g.top + 6],
    hN: -26,
    kN: 14,
    hF: 30,
    kF: 26,
    head: 6,
    lean: 16,
    ant: -30,
    expr: 'focus',
  },
  paint: {
    prop: 'brush',
    propAbs: 70,
    handN: (g) => [g.shN[0] + 22, g.top + 2],
    prop2: 'palette',
    handF: (g) => [g.shF[0] + 6, g.top + 20],
    head: -2,
    lean: -2,
    ant: -10,
    expr: 'happy',
  },
  probe: {
    handN: (g) => [g.tw / 2 + 12, g.top + 18],
    handF: (g) => [g.tw / 2 + 8, g.top + 12],
    hN: -10,
    kN: 20,
    hF: 14,
    kF: 20,
    head: 14,
    lean: 12,
    y: 2,
    ant: -26,
    expr: 'focus',
  },
  nod: { sN: -8, eN: -12, sF: 8, eF: -10, head: 14, ant: -26, expr: 'happy' },
  clipboard: {
    handN: (g) => [g.tw / 2 + 8, g.top + 12],
    prop: 'clipboard',
    propAbs: 12,
    sF: 8,
    eF: -12,
    head: 8,
    ant: -12,
  },
};

export const POSE_NAMES = Object.keys(POSES) as PoseName[];
