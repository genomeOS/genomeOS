/**
 * The astronaut rig (round 2 spec §3.1; R2-6, R2-7; #454): one parametric astronaut, ported from
 * the design prototype (`r2/characters/kit/rig.js`, direction B refined with the judge's grafts and
 * fixes). A cast record sets skin, hair, build, accent and outfit; a pose record sets joint angles
 * or IK hand targets. Output is plain SVG markup (strings, no DOM), so the same code runs at build
 * time (final-state SVG) and in the browser. The output is byte-identical to the prototype's for
 * every cast × pose (tests/astro-kit.test.ts holds the sha256 table).
 *
 * Coordinates: character-local, origin on the ground under the hips, +y down, facing screen-right.
 * Every joint is two groups: a static placement (SVG transform attribute) wrapping a rotation group
 * (`.j`, CSS transform, the Web Animations target). `KIT_CSS` (`.astro .j{transform-box:view-box;
 * transform-origin:0 0}`) makes each joint turn about its own local origin.
 *
 * Hierarchy: .astro › .j-move (x travel) › .j-shadow | .j-turn (facing) › .j-hop (height, squash)
 * › hip › .j-lean › far arm (+ far prop), far leg, pack, near leg, torso or coat, .j-head (helmet,
 * rim light, visor, .j-face with .j-eyes / .j-eyes-h / .j-mouth / .j-mouth-o, .j-ant), .j-held
 * (two-handed block), near arm (+ near prop).
 *
 * Weight: about 81 elements and 6.3 KB per full astronaut (≤ 85 and ≤ 6.5 KB, tested); `lod:
 * 'lite'` (40–60 px figures) drops knee pads, cuffs, chest lights and patches; below 40 px use
 * `helmet()`. Deterministic: no randomness here (SEED = 42 lives with anything seeded, rng.ts).
 */
import { ACCENT, C, HAIR, SKIN } from './palette';
import { BUILDS, CAST, type Build, type CastId, type CastMember } from './cast';
import {
  POSES,
  type Expr,
  type Geom,
  type HeldProp,
  type Point,
  type PoseName,
  type PoseSpec,
  type SolvedPose,
  type VisorBox,
} from './poses';

export const SEED = 42;

const f = (n: number | string) => +(+n).toFixed(2);
const R2D = 180 / Math.PI;

/* ------------------------------------------------------------------------------- shared defs */

/**
 * One `<defs>` block per page (or per scene sprite): two-tone fills as hard-stop gradients in
 * objectBoundingBox units, so a limb is one shape that keeps its shade side as it rotates, and the
 * visor clips shared per build. This is how an astronaut stays near 80 elements.
 */
export function kitDefs(): string {
  const lin = (id: string, shade: string, lit: string, at = 0.3) =>
    `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="${at}" stop-color="${shade}"/><stop offset="${at}" stop-color="${lit}"/></linearGradient>`;
  const clips = Object.entries(BUILDS)
    .map(([k, b]) => {
      const v = visorBox(b);
      return `<clipPath id="kv-${k}"><rect x="${f(v.x)}" y="${f(v.y)}" width="${f(v.w)}" height="${f(v.h)}" rx="${f(v.rx)}"/></clipPath>`;
    })
    .join('');
  return (
    `<defs>` +
    lin('kSuit', C.suitShade, C.suit, 0.32) +
    lin('kSuitFar', '#a9b9d0', C.suitShade, 0.32) +
    lin('kCoat', C.coatShade, C.coat, 0.3) +
    lin('kCoatFar', '#b3c2d7', C.coatShade, 0.3) +
    lin('kUnder', C.underShade, C.under, 0.32) +
    lin('kTorso', C.suitShade, C.suit, 0.16) +
    lin('kPack', '#a9b9d0', C.suitShade, 0.4) +
    `<radialGradient id="kHelm" cx=".565" cy=".435" r=".42"><stop offset=".97" stop-color="${C.suit}"/><stop offset="1" stop-color="${C.suitShade}"/></radialGradient>` +
    `<radialGradient id="kGlass" cx=".22" cy=".2" r="1"><stop offset="0" stop-color="#3a5d8f"/><stop offset=".55" stop-color="#22406b"/><stop offset="1" stop-color="#16305a"/></radialGradient>` +
    clips +
    `</defs>`
  );
}

/** Each joint turns about its own local origin. One copy per page that animates astronauts. */
export const KIT_CSS = `.astro .j{transform-box:view-box;transform-origin:0 0}`;

/* ---------------------------------------------------------------------------------- geometry */

function visorBox(b: Build): VisorBox {
  const r = b.hr;
  const hy = -r + 3; // helmet centre relative to the neck pivot
  const w = r * 1.5;
  const h = r * 1.24;
  const cx = 4.5;
  const cy = hy + 2.6;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rx: h * 0.46, cx, cy, hy };
}

/** Anchor points per cast, in body coordinates (before hop and lean). Poses aim hands at these. */
export function geom(castId: CastId): Geom {
  const cast = CAST[castId];
  const b = BUILDS[cast.build];
  const legLen = b.thigh + b.shin + 5;
  const hipY = -legLen;
  const top = hipY - b.th;
  const neck: Point = [2, top + 2];
  const v = visorBox(b);
  const hc: Point = [neck[0], neck[1] + v.hy]; // helmet centre
  return {
    b,
    cast,
    legLen,
    hipY,
    top,
    neck,
    hc,
    tw: b.tw,
    hr: b.hr,
    visor: v,
    shN: [b.tw / 2 - 7.5, top + 8],
    shF: [-b.tw / 2 + 8, top + 8],
    chin: [neck[0] + v.cx + 6, neck[1] + v.cy + v.h / 2 - 1],
    sitDrop: b.thigh * 0.94,
    reach: b.ua + b.fa + 1.5,
    bench: { x: b.tw / 2 + 22, top: hipY - 3, block: 15 },
  };
}

/**
 * Two-bone IK. rotate(t) sends (0, L) to (-L sin t, L cos t). bend +1 puts the elbow clockwise of
 * the shoulder-target line (below it when reaching forward). Returns [shoulder, elbow] degrees.
 */
export function ik(
  S: Point,
  T: Point,
  L1: number,
  L2: number,
  bend = 1,
): [number, number] {
  const dx = T[0] - S[0];
  const dy = T[1] - S[1];
  const raw = Math.hypot(dx, dy) || 1e-6;
  const d = Math.min(L1 + L2 - 0.05, Math.max(Math.abs(L1 - L2) + 0.05, raw));
  const phi = Math.atan2(-dx, dy);
  const a = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d));
  const t1 = phi + bend * a;
  const ex = S[0] - L1 * Math.sin(t1);
  const ey = S[1] + L1 * Math.cos(t1);
  const tx = S[0] + (dx / raw) * d;
  const ty = S[1] + (dy / raw) * d;
  const t2 = Math.atan2(-(tx - ex), ty - ey);
  let rel = (t2 - t1) * R2D;
  while (rel > 180) rel -= 360;
  while (rel <= -180) rel += 360;
  return [t1 * R2D, rel];
}

/* ------------------------------------------------------------------------------------- poses */

/** Resolve a pose to plain joint angles (what the timeline keyframes). */
export function solve(castId: CastId, pose: PoseSpec): SolvedPose {
  const g = geom(castId);
  const p = {
    hN: 0,
    kN: 0,
    hF: 0,
    kF: 0,
    head: 0,
    lean: 0,
    y: 0,
    ant: -14,
    sN: 0,
    eN: 0,
    sF: 0,
    eF: 0,
    sq: 0,
    ...pose,
  } as Omit<SolvedPose, 'y'> & { y: number | 'sit' };
  const b = g.b;
  if (p.handN)
    [p.sN, p.eN] = ik(g.shN, p.handN(g), b.ua, b.fa + 1.5, p.bendN ?? 1);
  if (p.handF)
    [p.sF, p.eF] = ik(g.shF, p.handF(g), b.ua, b.fa + 1.5, p.bendF ?? 1);
  if (p.y === 'sit') p.y = g.sitDrop;
  if (p.block) p.blockAt = p.block(g);
  return p as SolvedPose;
}

export interface Anchors {
  pose: SolvedPose;
  handN: Point;
  handF: Point;
  helmet: Point;
  /** the top of the helmet: speech bubbles and bulbs anchor here */
  headTop: Point;
  visor: Point;
  block: Point | null;
  hr: number;
}

/**
 * Forward kinematics: where hands, helmet and visor land for a pose, in the astronaut's placement
 * space (after lean, hop and squash; before the scene's own scale or flip). Bubbles are placed from
 * `headTop`, so their tails point at the speaker; a hand-off passes the block at one point.
 */
export function anchors(castId: CastId, pose: PoseSpec | SolvedPose): Anchors {
  const g = geom(castId);
  const p =
    pose.sN === undefined || typeof pose.handN === 'function'
      ? solve(castId, pose)
      : (pose as SolvedPose);
  const b = g.b;
  const rot = (deg: number, [x, y]: Point): Point => {
    const r = (deg * Math.PI) / 180;
    return [
      x * Math.cos(r) - y * Math.sin(r),
      x * Math.sin(r) + y * Math.cos(r),
    ];
  };
  const add = (u: Point, v: Point): Point => [u[0] + v[0], u[1] + v[1]];
  const sq = p.sq || 0;
  const body = (pt: Point): Point => {
    const lean = (p.lean || 0) + (p.spin || 0);
    const l = add([0, g.hipY], rot(lean, [pt[0], pt[1] - g.hipY]));
    return [f(l[0] * (1 - sq)), f(l[1] * (1 + sq) + ((p.y as number) || 0))];
  };
  const hand = (sh: Point, s: number, e: number, len: number) =>
    add(add(sh, rot(s, [0, b.ua])), rot(s + e, [0, len]));
  const head = (pt: Point) =>
    add(g.neck, rot(p.head || 0, [pt[0] - g.neck[0], pt[1] - g.neck[1]]));
  return {
    pose: p,
    handN: body(hand(g.shN, p.sN, p.eN, b.fa + 1.5)),
    handF: body(hand(g.shF, p.sF, p.eF, b.fa + 1.5)),
    helmet: body(head(g.hc)),
    headTop: body(head([g.hc[0], g.hc[1] - g.hr])),
    visor: body(head([g.neck[0] + g.visor.cx, g.neck[1] + g.visor.cy])),
    block: p.blockAt ? body(p.blockAt) : null,
    hr: g.hr,
  };
}

/* ----------------------------------------------------------------------------- face and hair */

function hairBack(style: string, col: string): string {
  switch (style) {
    case 'afro':
      return `<path d="M-15 12 C-22 10 -25 2 -22 -4 C-26 -10 -21 -18 -15 -18 C-13 -25 -4 -26 0 -22 C4 -27 13 -25 14 -19 C20 -20 23 -13 19 -8 L12 4 L-12 14Z" fill="${col}"/>`;
    case 'long':
      return `<path d="M-14 -6 C-16 -18 -6 -22 2 -22 C11 -22 18 -16 17 -4 L17 4 L-6 10 L-12 24 L-22 24 C-23 12 -20 2 -14 -6Z" fill="${col}"/>`;
    case 'scarf':
      return `<ellipse cx="0.5" cy="1" rx="18.5" ry="19.5" fill="${col}"/><path d="M-17 4 C-15 15 -7 21 1 21 C9 21 16 15 18 4 C15 16 8 19 1 19 C-6 19 -13 16 -17 4Z" fill="#000" opacity=".22"/>`;
    case 'bob':
      return `<path d="M-14 -5 C-15 -17 -6 -21 2 -21 C11 -21 17 -15 16 -4 L8 0 L-8 12 C-14 13 -20 11 -21 6 C-21 0 -18 -4 -14 -5Z" fill="${col}"/>`;
    case 'bun':
      return `<path d="M-14 -4 C-15 -16 -6 -20 2 -20 C11 -20 17 -14 16 -4 L-6 8 L-14 8Z" fill="${col}"/><circle cx="-15" cy="-11" r="6.5" fill="${col}"/>`;
    default:
      return '';
  }
}

function hairFront(style: string, col: string): string {
  switch (style) {
    case 'crop':
      return `<path d="M-14.5 -3 C-15.5 -14 -6 -19 2 -18.5 C11 -18 16.5 -12 15.5 -4 C13 -8.5 9 -10.5 4 -9 C1 -11.5 -4 -11 -7.5 -8.5 C-10.5 -8 -13 -6.5 -14.5 -3Z" fill="${col}"/>`;
    case 'coily':
      return `<path d="M-14.5 -2 C-17 -9 -12 -16 -6 -16 C-3 -20 4 -20 7 -17 C12 -18 17 -12 15.5 -4 C13 -9 9 -10 5 -9.5 C1 -11 -4 -11 -8 -9 C-11 -8 -13 -5.5 -14.5 -2Z" fill="${col}"/><path d="M-9 -12.5 h.01 M-3 -14.5 h.01 M3 -14.5 h.01 M9 -13 h.01" stroke="#3a3542" stroke-width="2.2" stroke-linecap="round"/>`;
    case 'long':
      return `<path d="M-14 -2 C-15 -14 -5 -18.5 3 -18 C11 -17.5 16.5 -11 15 -3 C11 -9.5 3 -12 -5 -8 C-9 -6 -12 -3.5 -14 -2Z" fill="${col}"/>`;
    case 'bun':
      return `<path d="M-14 -2 C-15 -14 -5 -18.5 3 -18 C11 -17.5 16.5 -11 15 -3 C12 -8 6 -10.5 0 -10 C-6 -9.5 -11 -6 -14 -2Z" fill="${col}"/>`;
    case 'sweep':
      return `<path d="M-14.5 -1 C-16 -13 -6 -19 3 -18 C12 -17 17 -11 15.5 -2 C12 -6 9 -12 2 -11 C-4 -10 -10 -5 -14.5 -1Z" fill="${col}"/>`;
    case 'bob':
      return `<path d="M-14 -3 C-15 -14 -6 -18.5 2 -18 C10 -17.5 15.5 -12.5 14.5 -3.5 C9 -8 3 -6.5 -2 -9 C-6 -6 -10 -4.5 -14 -3Z" fill="${col}"/>`;
    case 'curly':
      return `<path d="M-15 -1 C-18 -4 -17 -9 -13.5 -10.5 C-13 -15 -8 -17.5 -4 -15.5 C-1 -19 5 -19 7.5 -15.5 C11.5 -16.5 15.5 -13 14.5 -9 C17.5 -7 17.5 -3 15.5 -1 C13 -5 9 -7 5 -6.5 C1 -8.5 -4 -8.5 -8 -6.5 C-11 -6 -13.5 -4 -15 -1Z" fill="${col}"/>`;
    case 'scarf':
      return `<path d="M-14 -3 C-12.5 -13 -5 -16 1 -16 C7.5 -16 14 -12.5 15 -3 C11 -9.5 5 -11.5 0.5 -11.5 C-5 -11.5 -10.5 -8.5 -14 -3Z" fill="#fff" opacity=".18"/>`;
    case 'beard':
      return (
        `<path d="M-13 -6 C-12 -14 -3 -17 3 -16.5 C10 -16 15 -12 15 -6 C12 -10 7 -11 2 -10.5 C-4 -11 -9 -9.5 -13 -6Z" fill="${col}"/>` +
        `<path d="M-12.5 1.5 C-12 11 -5 16 1.5 16 C8.5 16 14 11 14 2 C11 6.5 7 7 1.5 6.5 C-3 7 -8 6.5 -12.5 1.5Z M-1.5 4.2 C0.5 2.7 4.5 2.7 6.5 4.2 C5 5.4 0 5.4 -1.5 4.2Z" fill="${col}" fill-rule="evenodd"/>`
      );
    case 'afro':
      return `<path d="M-14 -4 C-11 -11 -3 -13.5 3 -13 C9 -12.5 13.5 -9.5 15 -5 C11 -8.5 5 -9.5 -0.5 -9 C-6 -8.5 -10.5 -7 -14 -4Z" fill="${col}"/>`;
    default:
      return '';
  }
}

/** A soft highlight on dark hair, so it separates from the visor glass at small sizes. */
const SHEEN: Partial<Record<string, string>> = {
  afro: 'M-16 -10 C-14 -16 -7 -19 -1 -18',
  crop: 'M-11 -9 C-8 -13 -2 -15 3 -14.5',
  coily: 'M-11 -11 C-8 -14 -3 -15.5 2 -15',
  long: 'M-12 -8 C-9 -13 -3 -15.5 3 -15',
  bun: 'M-11 -8 C-8 -13 -3 -15 3 -14.5 M-18 -13 C-17 -15 -15 -16.5 -13 -16.5',
  curly: 'M-12 -10 C-9 -14 -4 -15.5 1 -15',
};
const EYES = `M-4.2 -3.6 a2.05 2.75 0 1 0 0.01 0Z M6.6 -3.8 a2.2 2.9 0 1 0 0.01 0Z`;
const CATCH = `M-3.4 -2.2 a.8 .8 0 1 0 .01 0Z M7.5 -2.4 a.85 .85 0 1 0 .01 0Z`;
const MOUTH = {
  smile: `<path d="M-0.6 5 Q2.2 7.8 5 5" fill="none" stroke="${C.mouth}" stroke-width="1.6" stroke-linecap="round"/>`,
  flat: `<path d="M0.4 5.6 L4.4 5.4" fill="none" stroke="${C.mouth}" stroke-width="1.6" stroke-linecap="round"/>`,
  hmm: `<path d="M1.4 5.8 Q3.6 4.6 5.6 5.5" fill="none" stroke="${C.mouth}" stroke-width="1.6" stroke-linecap="round"/>`,
  o: `<ellipse cx="2.4" cy="5.6" rx="1.8" ry="2.1" fill="${C.mouth}"/>`,
};
const OPEN = `<path d="M-1.2 4 Q2.2 11 5.8 4 Z" fill="${C.mouth}"/><path d="M0.5 7.3 Q2.3 9.1 4.1 7.3 Q2.3 6.4 0.5 7.3Z" fill="${C.tongue}"/>`;

function face(cast: CastMember, expr: Expr): string {
  const [sk, skS, skL] = SKIN[cast.skin];
  const hc = HAIR[cast.hairColor] || HAIR.black;
  const scarf = cast.hair === 'scarf';
  const rx = scarf ? 13.2 : 14.8;
  const ry = scarf ? 12.4 : 13.6;
  const mouthKey =
    ({ focus: 'flat', think: 'hmm', talk: 'o' } as const)[
      expr as 'focus' | 'think' | 'talk'
    ] || 'smile';
  const happy = expr === 'happy' || expr === 'open';
  const up = expr === 'think' ? -1.2 : 0;
  const squint = expr === 'focus';
  const brows =
    expr === 'think'
      ? `<path d="M-6.4 -8.2 Q-4.2 -9.4 -2.2 -8.4 M4.4 -9.6 Q7 -11.2 9.4 -9.4" fill="none" stroke="${C.eye}" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>`
      : squint
        ? `<path d="M-6.4 -6.8 L-2.2 -6 M4.4 -6.2 L9.2 -7.2" fill="none" stroke="${C.eye}" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>`
        : '';
  const freckles = cast.freckles
    ? `<path d="M-8.6 2.8h.01M-6.6 3.8h.01M-9.4 4.6h.01M10 2.6h.01M12 3.6h.01M10.6 4.6h.01" stroke="${skS}" stroke-width="1.3" stroke-linecap="round"/>`
    : '';
  const glasses = cast.glasses
    ? `<path d="M-8.2 -1.6 a4.2 4.2 0 1 0 8.4 0 a4.2 4.2 0 1 0 -8.4 0Z M2.2 -1.8 a4.4 4.4 0 1 0 8.8 0 a4.4 4.4 0 1 0 -8.8 0Z M0.2 -2 Q1.2 -3 2.2 -2" fill="${C.catch}" fill-opacity=".12" stroke="${C.eye}" stroke-width="1.15"/>`
    : '';
  const eyeT = up ? ` transform="translate(0 ${up})"` : '';
  const sheen = SHEEN[cast.hair];
  return (
    hairBack(cast.hair, hc) +
    // the face, then its shade (lower left) and a light rim on the lit side: deep tones read
    `<ellipse cx="0" cy="0" rx="${rx}" ry="${ry}" fill="${sk}"/>` +
    `<path d="M${-rx} 0 A${rx} ${ry} 0 0 0 1 ${ry} C${-rx * 0.55} ${ry - 3} ${-rx + 2} 6 ${-rx} 0Z" fill="${skS}"/>` +
    `<path d="M${rx - 1.2} -5 A${rx - 0.6} ${ry - 0.6} 0 0 1 ${rx - 3.8} 8.5" fill="none" stroke="${skL}" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>` +
    `<path d="M-11.2 4.6 a3 1.8 0 1 0 6 0 a3 1.8 0 1 0 -6 0Z M8 4.4 a3.2 1.9 0 1 0 6.4 0 a3.2 1.9 0 1 0 -6.4 0Z" fill="${C.blush}" opacity=".42"/>` +
    freckles +
    `<g class="j-eyes" style="transform-box:fill-box;transform-origin:center${happy ? ';opacity:0' : ''}"${eyeT}><path d="${EYES}" fill="${C.eye}"${squint ? ' transform="translate(0 0.9) scale(1 .62)"' : ''}/>${squint ? '' : `<path d="${CATCH}" fill="${C.catch}"/>`}</g>` +
    `<path class="j-eyes-h" d="M-6.6 -0.6 Q-4.2 -3.8 -1.8 -0.6 M4.2 -0.8 Q6.8 -4.2 9.4 -0.8" fill="none" stroke="${C.eye}" stroke-width="1.7" stroke-linecap="round"${happy ? '' : ' opacity="0"'}/>` +
    brows +
    `<g class="j-mouth"${happy ? ' opacity="0"' : ''}>${MOUTH[mouthKey]}</g>` +
    `<g class="j-mouth-o"${happy ? '' : ' opacity="0"'}>${OPEN}</g>` +
    hairFront(cast.hair, hc) +
    (sheen && (cast.hairColor === 'black' || cast.hairColor === 'brown')
      ? `<path d="${sheen}" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity=".28"/>`
      : '') +
    glasses
  );
}

/* ---------------------------------------------------------------------------------- the head */

function head(
  cast: CastMember,
  b: Build,
  expr: Expr,
  opt: { noAntenna?: boolean } = {},
): string {
  const r = b.hr;
  const v = visorBox(b);
  const hy = v.hy;
  const [acc] = ACCENT[cast.accent];
  const buildKey = cast.build;
  const rr = r - 2.1;
  const pt = (deg: number) => [
    f(rr * Math.sin((deg * Math.PI) / 180)),
    f(hy - rr * Math.cos((deg * Math.PI) / 180)),
  ];
  const [ax, ay] = pt(-4);
  const [bx, by] = pt(112);
  const ant = opt.noAntenna
    ? ''
    : `<g transform="translate(${f(-r * 0.55)} ${f(hy - r * 0.78)})"><g class="j j-ant" style="transform:rotate(-14deg)"><path d="M0 0 V-11" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round"/><circle cx="0" cy="-12.5" r="3.4" fill="${acc}" stroke="${C.ink}" stroke-width="1.8"/></g></g>`;
  return (
    ant +
    `<circle cx="0" cy="${f(hy)}" r="${r}" fill="url(#kHelm)" stroke="${C.ink}" stroke-width="2.4"/>` +
    // the one site colour on a figure: an ion rim light on the helmet's lit edge
    `<path d="M${ax} ${ay} A${f(rr)} ${f(rr)} 0 0 1 ${bx} ${by}" fill="none" stroke="${C.rim}" stroke-width="1.7" stroke-linecap="round" opacity=".8"/>` +
    `<rect x="${f(-r - 2.5)}" y="${f(hy - 6)}" width="7" height="13" rx="3.5" fill="${C.joint}" stroke="${C.ink}" stroke-width="2"/>` +
    `<rect x="${f(v.x - 2.6)}" y="${f(v.y - 2.6)}" width="${f(v.w + 5.2)}" height="${f(v.h + 5.2)}" rx="${f(v.rx + 2.6)}" fill="${C.visorRim}" stroke="${C.ink}" stroke-width="2.2"/>` +
    `<g clip-path="url(#kv-${buildKey})"><rect x="${f(v.x)}" y="${f(v.y)}" width="${f(v.w)}" height="${f(v.h)}" fill="url(#kGlass)"/>` +
    `<g class="j-face" transform="translate(${f(v.cx + 2.2)} ${f(v.cy + 4.2)})">${face(cast, expr)}</g></g>` +
    `<path d="M${f(v.cx + 4)} ${f(v.y + 3.6)} Q${f(v.x + v.w - 4)} ${f(v.y + 3.2)} ${f(v.x + v.w - 3.2)} ${f(v.cy - 1)}" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>` +
    `<rect x="${f(v.x)}" y="${f(v.y)}" width="${f(v.w)}" height="${f(v.h)}" rx="${f(v.rx)}" fill="none" stroke="${C.ink}" stroke-width="1.6"/>`
  );
}

/* -------------------------------------------------------------------------------- held props */

/**
 * The tablet's screen: four rows of a list, or (`glyph`) a short label such as `</>` for the coder
 * (round 2 spec §3.1, Home's crew).
 */
function tabletArt(glyph?: string): string {
  const screen = glyph
    ? `<text x="0" y="3.6" text-anchor="middle" font-size="9.5" font-weight="700" fill="${C.rim}">${escapeText(glyph)}</text>`
    : `<g class="tablet-rows" fill="#cfe9ff"><rect x="-6" y="-7.5" width="12" height="2.2" rx="1.1"/><rect x="-6" y="-3.3" width="9" height="2.2" rx="1.1" fill="${C.rim}"/><rect x="-6" y="0.9" width="10.5" height="2.2" rx="1.1"/><rect x="-6" y="5.1" width="7" height="2.2" rx="1.1"/></g>`;
  return `<g class="prop-tablet"><rect x="-9" y="-11" width="18" height="22" rx="2.5" fill="#1d3354" stroke="${C.ink}" stroke-width="2"/>${screen}</g>`;
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const PROP = {
  /** A bigger mallet than direction B's, so strikes read at 80 px. */
  hammer: () =>
    `<g class="prop-hammer"><rect x="-2.2" y="-16" width="4.4" height="21" rx="2.2" fill="#c9905d" stroke="${C.ink}" stroke-width="1.8"/>` +
    `<rect x="-9.5" y="-25" width="19" height="10.5" rx="2.6" fill="${C.joint}" stroke="${C.ink}" stroke-width="2"/><path d="M-9.5 -18 h19" stroke="${C.jointShade}" stroke-width="3"/></g>`,
  pick: () =>
    `<g class="prop-pick"><rect x="-2" y="-20" width="4" height="26" rx="2" fill="#c9905d" stroke="${C.ink}" stroke-width="1.8"/>` +
    `<path d="M-15 -17 Q0 -27 15 -17 L13 -14 Q0 -21 -13 -14Z" fill="${C.joint}" stroke="${C.ink}" stroke-width="1.9" stroke-linejoin="round"/></g>`,
  brush: () =>
    `<g class="prop-brush"><rect x="-1.7" y="-17" width="3.4" height="19" rx="1.7" fill="#c9905d" stroke="${C.ink}" stroke-width="1.6"/>` +
    `<path d="M-3 -17 L3 -17 L2.4 -23 Q0 -27 -2.4 -23Z" fill="${ACCENT.pink[0]}" stroke="${C.ink}" stroke-width="1.5" stroke-linejoin="round"/></g>`,
  palette: () =>
    `<g class="prop-palette"><path d="M-9 -2 C-12 -10 -3 -15 5 -12 C11 -10 12 -3 7 0 C4 2 6 5 2 6 C-4 7 -7 3 -9 -2Z" fill="#e8d5b7" stroke="${C.ink}" stroke-width="1.6"/>` +
    `<path d="M-5 -7h.01M0 -9.5h.01M5 -7.5h.01" stroke-width="3.2" stroke-linecap="round" stroke="${ACCENT.royal[0]}"/><path d="M-6 -2h.01" stroke-width="3.2" stroke-linecap="round" stroke="${ACCENT.coral[0]}"/></g>`,
  tablet: (glyph?: string) => tabletArt(glyph),
  clipboard: () =>
    `<g class="prop-clipboard"><rect x="-8.5" y="-11" width="17" height="21" rx="2" fill="#c9905d" stroke="${C.ink}" stroke-width="1.8"/><rect x="-6.5" y="-8" width="13" height="16" fill="#f4f8fd"/>` +
    `<path d="M-4.5 -4h9M-4.5 -0.5h9M-4.5 3h6" stroke="#8194b3" stroke-width="1.3"/><rect x="-3.5" y="-13" width="7" height="4" rx="1.2" fill="${C.joint}" stroke="${C.ink}" stroke-width="1.4"/></g>`,
  /** The unit of work: raw (slate, chiselled) or lit (finished). Centre at the origin. */
  block: (s = 18, lit = false) => {
    const h = s / 2;
    const d = s * 0.32;
    const [top, front, side] = lit
      ? [C.litTop, C.litFront, C.litSide]
      : [C.blockTop, C.blockFront, C.blockSide];
    return (
      `<g class="prop-block">` +
      `<path d="M${-h} ${-h} L${f(-h + d)} ${f(-h - d)} L${f(h + d)} ${f(-h - d)} L${h} ${-h}Z" fill="${top}"/>` +
      `<path d="M${h} ${-h} L${f(h + d)} ${f(-h - d)} L${f(h + d)} ${f(h - d)} L${h} ${h}Z" fill="${side}"/>` +
      `<rect x="${-h}" y="${-h}" width="${s}" height="${s}" fill="${front}"/>` +
      `<path d="M0 ${f(-s * 0.26)} L${f(s * 0.225)} ${f(-s * 0.13)} L${f(s * 0.225)} ${f(s * 0.13)} L0 ${f(s * 0.26)} L${f(-s * 0.225)} ${f(s * 0.13)} L${f(-s * 0.225)} ${f(-s * 0.13)}Z" fill="${lit ? '#fff' : 'none'}" fill-opacity=".55" stroke="${lit ? '#2a8fb0' : '#3c4d70'}" stroke-width="1.3" stroke-linejoin="round"/>` +
      `<path d="M${-h} ${-h} L${f(-h + d)} ${f(-h - d)} L${f(h + d)} ${f(-h - d)} L${f(h + d)} ${f(h - d)} L${h} ${h} L${-h} ${h}Z M${h} ${-h} L${-h} ${-h} M${h} ${-h} L${f(h + d)} ${f(-h - d)} M${h} ${-h} L${h} ${h}" fill="none" stroke="${C.ink}" stroke-width="1.9" stroke-linejoin="round"/>` +
      `</g>`
    );
  },
  lightbulb: () =>
    `<g class="prop-bulb">` +
    `<g class="bulb-rays" stroke="${C.bulb}" stroke-width="2.2" stroke-linecap="round"><path d="M0 -16 V-21 M11.3 -11.3 L14.8 -14.8 M-11.3 -11.3 L-14.8 -14.8 M16 0 H21 M-16 0 H-21"/></g>` +
    `<path d="M-7.5 2 C-11 -2 -10 -11 0 -11 C10 -11 11 -2 7.5 2 C5.5 4 5 5.5 5 8 L-5 8 C-5 5.5 -5.5 4 -7.5 2Z" fill="${C.bulb}" stroke="${C.ink}" stroke-width="2"/>` +
    `<path d="M-3 -6 C-5 -5 -6 -3 -5.5 -1" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>` +
    `<rect x="-5" y="8" width="10" height="6" rx="1.5" fill="${C.joint}" stroke="${C.ink}" stroke-width="1.8"/></g>`,
};

/** A four-point sparkle path (no fill set: the caller's group sets it). */
export function sparkle(x: number, y: number, r: number): string {
  const k = r * 0.28;
  return `<path d="M${f(x)} ${f(y - r)} Q${f(x + k)} ${f(y - k)} ${f(x + r)} ${f(y)} Q${f(x + k)} ${f(y + k)} ${f(x)} ${f(y + r)} Q${f(x - k)} ${f(y + k)} ${f(x - r)} ${f(y)} Q${f(x - k)} ${f(y - k)} ${f(x)} ${f(y - r)}Z"/>`;
}

/* ------------------------------------------------------------------------ seats and benches */

/**
 * A low supply box: it shows behind the pack and between the legs, so "sit" reads as sitting.
 * `seatY` is the seat's height in ground coordinates (negative is up).
 */
export function stool(seatY: number): string {
  const t = f(seatY - 1);
  return (
    `<g class="prop-seat"><rect x="-23" y="${t}" width="27" height="${f(-t)}" rx="2.5" fill="${C.suitShade}" stroke="${C.ink}" stroke-width="2.2"/>` +
    `<path d="M-19 ${f(t + 4.5)} H0" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".75"/><path d="M-19 ${f(t / 2)} H0" stroke="#8fa2bf" stroke-width="1.6" stroke-linecap="round"/></g>`
  );
}

/** The workbench beside a seated figure (its geometry `g`), with a raw or lit block on it. */
export function workCrate(g: Geom, withBlock = true, lit = false): string {
  const bt = g.bench.top + g.sitDrop; // ground coordinates of the bench top
  const s = g.bench.block;
  return (
    `<g class="prop-crate" transform="translate(${f(g.bench.x)} 0)">` +
    `<path d="M-12 ${f(bt + 4)} L-10 0 M12 ${f(bt + 4)} L10 0" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/><path d="M-12 ${f(bt + 4)} L-10 0 M12 ${f(bt + 4)} L10 0" stroke="${C.joint}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<rect x="-17" y="${f(bt)}" width="34" height="7" rx="2.5" fill="${C.suitShade}" stroke="${C.ink}" stroke-width="2.2"/><path d="M-13 ${f(bt + 2.4)} H11" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity=".7"/>` +
    (withBlock
      ? `<g class="crate-block" transform="translate(-1 ${f(bt - s / 2 - 0.9)})"><g class="j j-blk" style="transform-box:fill-box;transform-origin:50% 100%">${PROP.block(s, lit)}</g></g>`
      : '') +
    `</g>`
  );
}

/* --------------------------------------------------------------------------------- astronaut */

export interface AstronautOptions {
  /** Overrides on the named pose (angles, targets, y …). */
  pose?: PoseSpec;
  expr?: Expr;
  /** 'lite' (figures 40 to 60 px tall) drops knee pads, cuffs, chest lights and the pack patch. */
  lod?: 'full' | 'lite';
  /** Travel along x (the `.j-move` group's starting translateX). */
  x?: number;
  /** -1 faces screen-left. */
  face?: 1 | -1;
  noShadow?: boolean;
  /** A near or far held-prop slot for a scene that hands a figure a prop later (hidden until used). */
  propN?: HeldProp;
  propFar?: HeldProp;
  /** Keep a hidden two-handed block ready ('lit' for a finished one). */
  holdBlock?: boolean | 'lit';
  /** The workbench: false leaves its block off; true lights it. */
  crateBlock?: boolean;
  crateLit?: boolean;
  /** Draw this glyph on a held tablet instead of the list rows (e.g. '</>' for the coder). */
  tabletGlyph?: string;
  /** Markup to hold in two hands instead of the block (e.g. props.ts `chartCard()`). */
  held?: string;
}

/**
 * One astronaut as an SVG `<g>`, at the origin (on the ground under the hips). The page holds one
 * `kitDefs()` and one `KIT_CSS` for every SVG of astronauts.
 */
export function astronaut(
  castId: CastId,
  poseName: PoseName = 'stand',
  opt: AstronautOptions = {},
): string {
  const cast = CAST[castId];
  const g = geom(castId);
  const b = g.b;
  const p = solve(castId, { ...POSES[poseName], ...(opt.pose || {}) });
  const lite = opt.lod === 'lite';
  const expr = opt.expr || p.expr || 'smile';
  const [acc] = ACCENT[cast.accent];
  const coat = !!cast.coat;
  const { hipY, top, tw } = g;
  const rx = f(Math.min(13, tw / 2.6));

  const limb = (len: number, w: number, fill: string) =>
    `<rect x="${f(-w / 2)}" y="${f(-w / 2)}" width="${f(w)}" height="${f(len + w)}" rx="${f(w / 2)}" fill="${fill}" stroke="${C.ink}" stroke-width="2.2"/>`;
  const jt = (cls: string, x: number, y: number, deg: number, inner: string) =>
    `<g transform="translate(${f(x)} ${f(y)})"><g class="j ${cls}" style="transform:rotate(${f(deg || 0)}deg)">${inner}</g></g>`;

  const boot = (far: boolean) =>
    `<path transform="translate(0 ${b.shin})" d="M-6 -1 V4.2 Q-6 6 -4 6 H9 Q11.4 6 11.4 3.6 Q11.4 -0.5 6 -1.5Z" fill="${far ? C.jointShade : C.joint}" stroke="${C.ink}" stroke-width="2" stroke-linejoin="round"/>`;
  const leg = (side: 'N' | 'F', hx: number, far: boolean) => {
    const fill = coat
      ? far
        ? C.underShade
        : 'url(#kUnder)'
      : far
        ? 'url(#kSuitFar)'
        : 'url(#kSuit)';
    const knee =
      coat || lite || far
        ? ''
        : `<circle cx="0" cy="1" r="3.1" fill="${acc}" stroke="${C.ink}" stroke-width="1.5"/>`;
    return jt(
      `j-h${side}`,
      hx,
      hipY,
      p[`h${side}`],
      limb(b.thigh, b.lw, fill) +
        jt(
          `j-k${side}`,
          0,
          b.thigh,
          p[`k${side}`],
          limb(b.shin - 1, b.lw - 0.6, fill) + knee + boot(far),
        ),
    );
  };

  // Held props keep an absolute angle (propAbs − arm rotation). A scene that hands a figure several
  // props over time passes opt.propN / opt.propFar so the slot exists (hidden until a pose uses it).
  const propRel = (p.propAbs || 0) - (p.sN + p.eN);
  const nearName = p.prop || opt.propN;
  const farName = p.propF || opt.propFar;
  const art = (name: HeldProp) =>
    name === 'tablet'
      ? `<g transform="translate(0 -10)">${PROP.tablet(opt.tabletGlyph)}</g>`
      : PROP[name]();
  const handN = nearName
    ? `<g class="j-propv"${p.prop ? '' : ' opacity="0"'}><g class="j j-prop" style="transform:rotate(${f(propRel)}deg)">${art(nearName)}</g></g>`
    : '';
  const propRelF = (p.propFAbs || 0) - (p.sF + p.eF);
  const handF = farName
    ? `<g class="j-propFv"${p.propF ? '' : ' opacity="0"'}><g class="j j-propF" style="transform:rotate(${f(propRelF)}deg)">${art(farName)}</g></g>`
    : p.prop2
      ? `<g transform="rotate(${f(-(p.sF + p.eF))})">${PROP[p.prop2]()}</g>`
      : '';
  const glove = (far: boolean) =>
    coat ? (far ? C.underShade : C.under) : far ? C.jointShade : C.joint;
  const arm = (
    side: 'N' | 'F',
    sh: Point,
    far: boolean,
    holdMarkup: string,
  ) => {
    const fill = coat
      ? far
        ? 'url(#kCoatFar)'
        : 'url(#kCoat)'
      : far
        ? 'url(#kSuitFar)'
        : 'url(#kSuit)';
    const patch =
      !far && !coat && !lite
        ? `<circle cx="1.2" cy="4.6" r="3.2" fill="${acc}" stroke="${C.ink}" stroke-width="1.4"/>`
        : '';
    const cuff = lite
      ? ''
      : `<rect x="${f(-b.aw / 2 - 0.6)}" y="${f(b.fa - 1.4)}" width="${f(b.aw + 1.2)}" height="3.8" rx="1.7" fill="${coat ? C.coatShade : acc}" stroke="${C.ink}" stroke-width="1.5"/>`;
    const hand = `<g transform="translate(0 ${f(b.fa + 1.5)})">${holdMarkup || ''}<circle r="${f(b.aw / 2 + 0.8)}" fill="${glove(far)}" stroke="${C.ink}" stroke-width="2"/></g>`;
    return jt(
      `j-s${side}`,
      sh[0],
      sh[1],
      p[`s${side}`],
      limb(b.ua, b.aw, fill) +
        patch +
        jt(
          `j-e${side}`,
          0,
          b.ua,
          p[`e${side}`],
          limb(b.fa, b.aw - 0.6, fill) + cuff + hand,
        ),
    );
  };

  // a block held in two hands rides the body (opt.holdBlock keeps a hidden one ready for scenes)
  const blockAt = p.blockAt || (opt.holdBlock ? [tw / 2 + 10, top + 14] : null);
  const heldArt =
    opt.held ??
    PROP.block(18, opt.holdBlock ? opt.holdBlock === 'lit' : !!p.blockLit);
  const heldBlock = blockAt
    ? `<g class="j-held" transform="translate(${f(blockAt[0])} ${f(blockAt[1])})"><g class="held-vis"${p.blockAt ? '' : ' opacity="0"'}>${heldArt}</g></g>`
    : '';

  const torsoH = b.th + 9;
  let torso: string;
  if (coat) {
    // a long flared lab coat with lapels and a pocket, over a dark undersuit
    const hem = hipY + 15;
    const L = -tw / 2 - 2;
    const Rt = tw / 2 + 2;
    const coatPath = `M${f(L)} ${f(top + 8)} Q${f(L)} ${top} ${f(L + 9)} ${top} H${f(Rt - 9)} Q${f(Rt)} ${top} ${f(Rt)} ${f(top + 8)} L${f(Rt + 5)} ${f(hem)} H${f(L - 5)}Z`;
    torso =
      `<rect x="${-tw / 2}" y="${top}" width="${tw}" height="${torsoH}" rx="${rx}" fill="${C.under}"/>` +
      `<path d="${coatPath}" fill="url(#kCoat)" stroke="${C.ink}" stroke-width="2.3" stroke-linejoin="round"/>` +
      `<path d="M-1 ${top} L4.5 ${f(top + 14)} L10 ${top}Z" fill="${C.under}"/>` +
      `<path d="M-1 ${top} L-6.5 ${f(top + 9)} L2.8 ${f(top + 11.5)} M10 ${top} L15.5 ${f(top + 9)} L6.2 ${f(top + 11.5)} M4.5 ${f(top + 14)} V${f(hem - 1)}" stroke="${C.ink}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" fill="none"/>` +
      `<path d="M${f(L + 2)} ${f(top + 15)} h9 v8 h-9Z" fill="${C.coatShade}" stroke="${C.ink}" stroke-width="1.4"/><path d="M${f(L + 5)} ${f(top + 11)} v5 M${f(L + 8.5)} ${f(top + 12)} v4" stroke="${acc}" stroke-width="2.2" stroke-linecap="round"/>`;
  } else {
    torso =
      `<rect x="${-tw / 2}" y="${top}" width="${tw}" height="${torsoH}" rx="${rx}" fill="url(#kTorso)" stroke="${C.ink}" stroke-width="2.4"/>` +
      `<path d="M${f(-tw / 2 + 1.2)} ${f(hipY - 3)} H${f(tw / 2 - 1.2)} V${f(hipY + 2.5)} H${f(-tw / 2 + 1.2)}Z" fill="${acc}"/>` +
      (lite
        ? ''
        : `<rect x="${f(-tw / 2 + 5)}" y="${f(top + 8)}" width="${f(tw - 19)}" height="10" rx="2.5" fill="${C.suitShade}" stroke="${C.ink}" stroke-width="1.6"/><path d="M${f(-tw / 2 + 9.6)} ${f(top + 13)}h.01" stroke="${C.rim}" stroke-width="3.8" stroke-linecap="round"/><path d="M${f(-tw / 2 + 15)} ${f(top + 13)}h.01" stroke="${acc}" stroke-width="3.8" stroke-linecap="round"/>`);
  }

  const pack = `<rect x="${f(-tw / 2 - 8)}" y="${f(top + 1)}" width="17" height="${f(b.th - 1)}" rx="6" fill="url(#kPack)" stroke="${C.ink}" stroke-width="2.2"/>`;
  const collar = `<rect x="${f(-tw / 2 + 5)}" y="${f(top - 3)}" width="${tw - 10}" height="6" rx="3" fill="${C.joint}" stroke="${C.ink}" stroke-width="2"/>`;

  const parts =
    arm('F', g.shF, true, handF) +
    leg('F', -5, true) +
    pack +
    leg('N', 4, false) +
    torso +
    collar +
    `<g transform="translate(${g.neck[0]} ${g.neck[1]})"><g class="j j-head" style="transform:rotate(${f(p.head)}deg)">${head(cast, b, expr).replace('rotate(-14deg)', `rotate(${f(p.ant)}deg)`)}</g></g>` +
    heldBlock +
    arm('N', g.shN, false, handN);

  const sq = p.sq || 0;
  const y = p.y;
  const shadowScale = Math.max(0.45, 1 - Math.abs(Math.min(0, y)) / 70);
  const seat = p.seat ? stool(hipY + g.sitDrop + 1) : '';
  const bench = p.bench
    ? workCrate(g, opt.crateBlock !== false, !!opt.crateLit)
    : '';
  return (
    `<g class="astro${coat ? ' astro--coat' : ''}" data-cast="${castId}">` +
    seat +
    bench +
    `<g class="j j-move"${opt.x ? ` style="transform:translateX(${f(opt.x)}px)"` : ''}>` +
    (opt.noShadow
      ? ''
      : `<g class="j j-shadow" style="transform:scale(${f(shadowScale)})"><ellipse cx="0" cy="1" rx="${f(tw / 2 + 6)}" ry="3.6" fill="#000" opacity=".3"/></g>`) +
    `<g class="j j-turn"${opt.face === -1 ? ' style="transform:scaleX(-1)"' : ''}><g class="j j-hop" style="transform:translateY(${f(y)}px) scale(${f(1 - sq)},${f(1 + sq)})">` +
    `<g transform="translate(0 ${f(hipY)})"><g class="j j-lean" style="transform:rotate(${f(p.lean)}deg)"><g transform="translate(0 ${f(-hipY)})">` +
    parts +
    `</g></g></g></g></g></g></g>`
  );
}

/** A helmet alone: avatars, ship windows, and figures under 40 px (helmet, visor and face only). */
export function helmet(
  castId: CastId,
  expr: Expr = 'smile',
  opt: { noAntenna?: boolean } = {},
): string {
  const cast = CAST[castId];
  const b = BUILDS[cast.build];
  return `<g class="helmet" transform="translate(0 ${f(b.hr - 3)})">${head(cast, b, expr, opt)}</g>`;
}

/**
 * "Your spot": a genome-violet dashed outline of an astronaut, the only way violet enters a figure
 * (Home's crew figure).
 */
export function ghost(build: keyof typeof BUILDS = 'average'): string {
  const b = BUILDS[build];
  const legLen = b.thigh + b.shin + 5;
  const hipY = -legLen;
  const top = hipY - b.th;
  const hy = top + 2 - b.hr + 3;
  const tw = b.tw;
  return (
    `<g class="ghost" fill="none" stroke="#ad8bff" stroke-width="2" stroke-dasharray="4.5 3.5" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="2" cy="${f(hy)}" r="${b.hr}"/>` +
    `<rect x="${f(-tw / 2)}" y="${f(top)}" width="${tw}" height="${f(b.th + 9)}" rx="${f(Math.min(13, tw / 2.6))}"/>` +
    `<rect x="${f(tw / 2 - 12.5)}" y="${f(top + 4)}" width="${b.aw}" height="${f(b.ua + b.fa + 5)}" rx="${f(b.aw / 2)}" transform="rotate(-10 ${f(tw / 2 - 7.5)} ${f(top + 8)})"/>` +
    `<rect x="-11" y="${f(hipY + 6)}" width="${b.lw}" height="${f(legLen - 6)}" rx="${f(b.lw / 2)}"/><rect x="${f(-1)}" y="${f(hipY + 6)}" width="${b.lw}" height="${f(legLen - 6)}" rx="${f(b.lw / 2)}"/>` +
    `</g>`
  );
}
