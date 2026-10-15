/**
 * Keyframing whole astronauts on the scene timeline (round 2 spec §3.1 `tracks.ts`; R2-7; #454),
 * ported from the design prototype (`r2/characters/kit/motion.js`). Client code.
 *
 * A key is `[ms, pose, easingToNext?]`, where pose is a POSES name or `{ pose: name, ...overrides,
 * x, face, expr }`. Joints are solved with the rig's IK per key and interpolated in joint space
 * between keys. Tracks whose value never changes are skipped, so an idle astronaut costs only the
 * joints that move. Height and squash ride `.j-hop`; x travel rides `.j-move` (linear while
 * airborne); facing flips instantly (`steps(1)`: a scale through zero would collapse the figure);
 * expressions swap instantly; held props keep an absolute angle and appear or vanish at a key (a
 * hand-off never shows two blocks).
 */
import type { CastId } from './cast';
import type { Expr, PoseName, PoseSpec, SolvedPose } from './poses';
import { POSES } from './poses';
import { solve } from './rig';
import { EASE, type Frame, type Phase, type Timeline } from '../timeline';

const JOINTS = [
  'sN',
  'eN',
  'sF',
  'eF',
  'hN',
  'kN',
  'hF',
  'kF',
  'head',
  'lean',
  'ant',
] as const;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Per expression: [eyes open, eyes happy, mouth, mouth open] opacities. */
const EXPR: Record<Expr, [number, number, number, number]> = {
  smile: [1, 0, 1, 0],
  focus: [1, 0, 1, 0],
  think: [1, 0, 1, 0],
  happy: [0, 1, 0, 1],
  talk: [1, 0, 0, 1],
  open: [1, 0, 0, 1],
};

export interface PoseKeySpec extends PoseSpec {
  pose?: PoseName;
  /** travel along x (scene units) */
  x?: number;
  /** easing of the x travel to the next key (default linear) */
  xe?: string;
  /** facing: 1 right, -1 left */
  face?: 1 | -1;
}

export type PoseKey = [
  ms: number,
  pose: PoseName | PoseKeySpec,
  easingToNext?: string,
];

type Resolved = SolvedPose & { expr: Expr };

/** A key's pose, solved for one cast member. */
export function resolveKey(
  castId: CastId,
  key: PoseName | PoseKeySpec,
): Resolved {
  const spec: PoseKeySpec = typeof key === 'string' ? { pose: key } : key;
  const base = POSES[spec.pose || 'stand'];
  const solved = solve(castId, {
    ...base,
    ...spec,
    pose: undefined,
  } as PoseSpec);
  return { ...solved, expr: spec.expr || base.expr || 'smile' };
}

const constant = (frames: Frame[]) => {
  const first = JSON.stringify(frames[0][1]);
  return frames.every((frame) => JSON.stringify(frame[1]) === first);
};

/**
 * Tracks for one astronaut (`root`, its `.astro` group) from pose keys, sorted by time. `opt.base`
 * is the pose the markup was rendered in: tracks equal to it throughout are skipped.
 */
export function poseTracks(
  tl: Timeline,
  phase: Phase,
  root: Element,
  castId: CastId,
  keys: PoseKey[],
  opt: { base?: PoseName | PoseKeySpec } = {},
): Resolved[] {
  const solved = keys.map(
    ([t, k, e]) =>
      [t, resolveKey(castId, k), e] as [number, Resolved, string | undefined],
  );
  const base = opt.base ? resolveKey(castId, opt.base) : null;
  const add = (el: Element | null, frames: Frame[], baseValue?: string) => {
    if (!el) return;
    if (
      constant(frames) &&
      baseValue !== undefined &&
      JSON.stringify(frames[0][1]) === JSON.stringify(baseValue)
    )
      return;
    tl.track(phase, el, frames);
  };
  for (const joint of JOINTS) {
    const angle = (p: Resolved) =>
      joint === 'lean' ? p.lean + (p.spin || 0) : p[joint];
    add(
      root.querySelector(`.j-${joint}`),
      solved.map(([t, p, e]) => [t, `rotate(${r2(angle(p))}deg)`, e]),
      base
        ? `rotate(${r2(joint === 'lean' ? base.lean : base[joint])}deg)`
        : undefined,
    );
  }
  const hop = (p: Resolved) =>
    `translateY(${r2(p.y)}px) scale(${r2(1 - (p.sq || 0))}, ${r2(1 + (p.sq || 0))})`;
  add(
    root.querySelector('.j-hop'),
    solved.map(([t, p, e]) => [t, hop(p), e]),
    base ? hop(base) : undefined,
  );
  const shadow = root.querySelector('.j-shadow');
  if (shadow)
    add(
      shadow,
      solved.map(([t, p, e]) => [
        t,
        `scale(${r2(Math.max(0.45, 1 - Math.abs(Math.min(0, p.y)) / 70))})`,
        e,
      ]),
      'scale(1)',
    );
  // Held props: angle tracks (the last known absolute angle carries through keys without one) and
  // instant visibility tracks, so a figure can put the tablet away and pick up the hammer.
  for (const [cls, name, abs, s1, s2] of [
    ['.j-prop', 'prop', 'propAbs', 'sN', 'eN'],
    ['.j-propF', 'propF', 'propFAbs', 'sF', 'eF'],
  ] as const) {
    const el = root.querySelector(cls);
    if (!el) continue;
    let last = solved.find(([, p]) => p[abs] !== undefined)?.[1][abs] ?? 0;
    add(
      el,
      solved.map(([t, p, e]) => {
        if (p[abs] !== undefined) last = p[abs]!;
        return [t, `rotate(${r2(last - (p[s1] + p[s2]))}deg)`, e];
      }),
    );
    const visible = el.parentElement;
    if (solved.some(([, p]) => !p[name]) && solved.some(([, p]) => p[name]))
      tl.track(
        phase,
        visible,
        solved.map(([t, p]) => [t, { opacity: p[name] ? 1 : 0 }, EASE.step]),
      );
  }
  // travel along x (board floors), linear while airborne
  if (keys.some(([, k]) => typeof k === 'object' && k.x !== undefined)) {
    let last = 0;
    add(
      root.querySelector('.j-move'),
      keys.map(([t, k]) => {
        if (typeof k === 'object' && k.x !== undefined) last = k.x;
        return [
          t,
          `translateX(${r2(last)}px)`,
          typeof k === 'object' && k.xe ? k.xe : 'linear',
        ];
      }),
    );
  }
  // facing: an instant flip (a scale through zero would collapse the figure)
  if (keys.some(([, k]) => typeof k === 'object' && k.face !== undefined)) {
    let last = 1;
    add(
      root.querySelector('.j-turn'),
      keys.map(([t, k]) => {
        if (typeof k === 'object' && k.face !== undefined) last = k.face;
        return [t, `scaleX(${last})`, EASE.step];
      }),
    );
  }
  // expressions swap instantly
  const parts = ['.j-eyes', '.j-eyes-h', '.j-mouth', '.j-mouth-o'].map((s) =>
    root.querySelector(s),
  );
  if (parts.every(Boolean) && new Set(solved.map(([, p]) => p.expr)).size > 1)
    parts.forEach((el, i) =>
      tl.track(
        phase,
        el,
        solved.map(([t, p]) => [
          t,
          { opacity: (EXPR[p.expr] || EXPR.smile)[i] },
          EASE.step,
        ]),
      ),
    );
  // held block: body-parented, so it rides every hop and lean exactly
  const held = root.querySelector('.j-held');
  if (held && solved.some(([, p]) => p.blockAt)) {
    let last = solved.find(([, p]) => p.blockAt)![1].blockAt!;
    tl.track(
      phase,
      held,
      solved.map(([t, p, e]) => {
        if (p.blockAt) last = p.blockAt;
        return [t, `translate(${r2(last[0])}px, ${r2(last[1])}px)`, e];
      }),
    );
    // visibility switches at the key, never fades (a hand-off must not show two blocks)
    tl.track(
      phase,
      held.firstElementChild,
      solved.map(([t, p]) => [t, { opacity: p.blockAt ? 1 : 0 }, EASE.step]),
    );
  }
  return solved.map(([, p]) => p);
}

/** Blinks: quick eye squeezes at the given times (ms within the phase). */
export function blinks(
  tl: Timeline,
  phase: Phase,
  root: Element,
  times: number[],
  length = phase === 'loop' ? tl.loopMs : tl.storyMs,
): void {
  const eyes = root.querySelector('.j-eyes');
  if (!eyes || !times.length) return;
  const frames: Frame[] = [[0, 'scaleY(1)']];
  for (const t of times)
    frames.push(
      [t, 'scaleY(1)'],
      [t + 70, 'scaleY(0.12)'],
      [t + 150, 'scaleY(1)'],
    );
  frames.push([length, 'scaleY(1)']);
  tl.track(phase, eyes, frames);
}

/**
 * A hop from `from` to `to` (in whatever travel unit the caller uses), as pose keys plus travel
 * keys: crouch, launch, a low-gravity arc, touch down with squash, settle. Moon scenes drive
 * `.on-moon` rotation with `travel`; floors drive x.
 */
export function hopKeys(
  t0: number,
  from: number,
  to: number,
  opt: {
    dur?: number;
    height?: number;
    pose?: PoseKeySpec;
    land?: PoseName;
    from?: PoseName;
  } = {},
): { keys: PoseKey[]; travel: [number, number][]; end: number } {
  const dur = opt.dur ?? 900;
  const h = opt.height ?? -30;
  const pose = opt.pose || {};
  const land = opt.land || 'stand';
  const t1 = t0 + 160; // crouch
  const t2 = t1 + 60; // launch
  const apex = t2 + dur / 2;
  const t3 = t2 + dur; // touch down
  const keys: PoseKey[] = [
    [t0, { pose: opt.from || 'stand', ...pose }, EASE.inOut],
    [t1, { pose: 'crouch', ...pose, sq: -0.08 }, EASE.out],
    [t2, { pose: 'hop', ...pose, y: -4, sq: 0.06 }, EASE.up],
    [apex, { pose: 'hop', ...pose, y: h, sq: 0.02 }, EASE.down],
    [t3, { pose: 'hop', ...pose, y: 0, sq: 0 }, EASE.out],
    [t3 + 90, { pose: 'crouch', ...pose, y: 3, sq: -0.07 }, EASE.back],
    [t3 + 320, { pose: land, ...pose }, EASE.inOut],
  ];
  const travel: [number, number][] = [
    [t0, from],
    [t2, from],
    [t3, to],
  ];
  return { keys, travel, end: t3 + 320 };
}
