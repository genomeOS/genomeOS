/**
 * "How work moves": the board's columns, cards and astronaut story (round 2 spec §4.3.4, §0.4; R2-8;
 * characters.md §3; #454), ported from the design prototype (`r2/characters/kit/board-scene.js`).
 * Pure: no DOM. WorkBoard.astro uses it at build time (the columns, the cards, the storyboard frame
 * shown without motion); board.ts uses it in the browser (the live floor and its tracks, measured
 * against the columns).
 *
 * Columns: Discussion · Backlog · In progress · In review · Merge. The real board's Ready folds into
 * Backlog (the picked card lights up) and Blocked is renamed Merge, the owner's names; Merge shows the
 * board's Done. Cards are the pinned real items (src/data/board-snapshot.json); the moving card is a
 * plainly labelled example.
 *
 * Positions are column-relative ("column 3 at 58%"). The board's grid is five equal columns with a
 * 12 px pad and 8 px gaps on every layout (fluid on desktops, 300 px each on the phone track), so a
 * spot is exactly `pct %` of the track's width plus `px`: the storyboard places itself with nested
 * SVGs at percentages and needs no script; the live floor resolves the same spots against measured
 * columns (and again on resize, keeping the clock's time). Walks take a fixed number of steps, so the
 * story's times never depend on the layout: desktop and phone share one beat sheet and one e2e time
 * table. Everything seeded uses mulberry32(SEED = 42).
 */
import type { CastId } from '../../graphics/astro/cast';
import type { Geom, Point } from '../../graphics/astro/poses';
import { bubble, confetti, moonDefs, wall } from '../../graphics/astro/props';
import {
  PROP,
  anchors,
  astronaut,
  geom,
  kitDefs,
  sparkle,
  stool,
  workCrate,
  type AstronautOptions,
} from '../../graphics/astro/rig';
import {
  resolveKey,
  type PoseKey,
  type PoseKeySpec,
} from '../../graphics/astro/tracks';
import { mulberry32 } from '../../graphics/rng';
import { EASE, type Frame, type Phase } from '../../graphics/timeline';

export const SEED = 42;

/** The story (36 s) and the idle loop (8 s), ms. */
export const T = { story: 36000, loop: 8000 } as const;

const f = (n: number) => +(+n).toFixed(2);

/* ------------------------------------------------------------------------- columns and cards */

export type ColumnKey =
  'discussion' | 'backlog' | 'progress' | 'review' | 'merge';

export interface Column {
  key: ColumnKey;
  name: string;
  /** The short line under the name. */
  line: string;
  /** The real board's statuses this column shows. */
  statuses: readonly string[];
}

export const COLUMNS: readonly Column[] = [
  // GitHub Discussions, not a board status: GitHub Projects cannot hold discussions.
  {
    key: 'discussion',
    name: 'Discussion',
    line: 'Say hello',
    statuses: ['Discussion'],
  },
  // The board's Ready is folded in (R2-8): the picked card lights up.
  {
    key: 'backlog',
    name: 'Backlog',
    line: 'Pick a Ready one',
    statuses: ['Backlog', 'Ready'],
  },
  {
    key: 'progress',
    name: 'In progress',
    line: 'Build it',
    statuses: ['In progress'],
  },
  {
    key: 'review',
    name: 'In review',
    line: 'Experts check',
    statuses: ['In review'],
  },
  // The owner's "Merge" (renamed from Blocked) shows the board's Done.
  { key: 'merge', name: 'Merge', line: 'Joins the Atlas', statuses: ['Done'] },
];

/** The page's column for a board status, or null for one the page does not show. */
export function columnOf(status: string): ColumnKey | null {
  return (
    COLUMNS.find((column) => column.statuses.includes(status))?.key ?? null
  );
}

export interface SnapshotLabel {
  name: string;
  /** #RRGGBB, the repository's own colour */
  color: string;
}

export interface SnapshotItem {
  kind: 'discussion' | 'issue';
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: SnapshotLabel[];
  status: string;
}

export interface Snapshot {
  project: { title: string; number: number };
  /** YYYY-MM-DD */
  fetched: string;
  items: SnapshotItem[];
}

/** The audit's word pattern (round 2 spec §4: count_copy.py, word-budget.spec.ts). */
export const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;

/** The labels a card shows: its type, then expert review if asked, else a skill; at most two. */
export function shownLabels(item: {
  labels: SnapshotLabel[];
}): SnapshotLabel[] {
  const find = (test: (name: string) => boolean) =>
    item.labels.find((label) => test(label.name));
  const type = find((name) => name.startsWith('type:'));
  const second =
    find((name) => name === 'wants-expert-review') ??
    find((name) => name.startsWith('skill:'));
  return [type, second].filter((label): label is SnapshotLabel => !!label);
}

/** A card's meta line: "Discussion #76", or the repository and number ("genomeOS #63"). */
export function cardMeta(item: SnapshotItem): {
  repo: string | null;
  text: string;
} {
  return item.kind === 'discussion'
    ? { repo: null, text: `Discussion #${item.number}` }
    : { repo: 'genomeOS', text: `#${item.number}` };
}

/** The words a card shows (its meta, title and labels), as the word audit counts them. */
export function cardWords(item: SnapshotItem): string[] {
  const meta = cardMeta(item);
  const text = [
    meta.repo ?? '',
    meta.text,
    item.title,
    ...shownLabels(item).map((label) => label.name),
  ].join(' ');
  return text.match(WORD) ?? [];
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** "2026-10-14" → "14 Oct 2026". */
export function formatFetched(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * A label chip's colours as GitHub's dark theme tints them: dark label colours are lifted toward
 * white for the text, light ones keep theirs; the fill and the edge are the colour, translucent.
 */
export function labelStyle(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
  const k = light ? 0 : 0.45;
  const text = [r, g, b].map((v) => Math.round(v + (255 - v) * k)).join(' ');
  return `color:rgb(${text});background:rgb(${r} ${g} ${b} / ${light ? 12 : 18}%);border-color:rgb(${r} ${g} ${b} / ${light ? 30 : 45}%)`;
}

/** The moving card: plainly an example (round 2 spec §4.3.4), with two of the repository's labels. */
export const EXAMPLE = {
  meta: 'Example issue',
  title: 'Add allele counts from a new study',
  labels: ['type:data', 'skill:popgen'],
} as const;

/** The conversation, short and friendly, and how review works here: sources linked in the pull
 * request, automated checks, an expert approves (R2-11). */
export const SAY = {
  hello: ['A3', 'Hi! I’d like to help.'],
  welcome: ['A2', 'Welcome aboard!'],
  backlog: ['A5', 'Try the Backlog!'],
  q: ['E1', 'Where are the counts from?'],
  a: ['A3', 'Table 2, linked in the PR.'],
  checks: ['E2', 'Checks pass. Nice work!'],
  ok: ['E1', 'Approved!'],
} as const satisfies Record<string, readonly [CastId, string]>;

export type SayKey = keyof typeof SAY;

/** The story in words, one beat per column, the dialogue verbatim (spec §4.3.4 text twin). Actions
 * only; never appearance. */
export const STORY_TEXT: readonly [ColumnKey, string][] = [
  [
    'discussion',
    `Discussion: three newcomers arrive and say hello. One says “${SAY.hello[1]}” Another answers “${SAY.welcome[1]}” and a third points the way: “${SAY.backlog[1]}”`,
  ],
  [
    'backlog',
    'Backlog: the newcomer scrolls through the issues on a tablet, gets an idea and picks a Ready one. The example card lights up and shows their avatar.',
  ],
  [
    'progress',
    'In progress: they sit at the bench and work a block with a hammer, inspecting it after every strike, until it lights up, finished.',
  ],
  [
    'review',
    `In review: they raise the finished block. Two experts in lab coats come over; one thinks it over, hand on chin. “${SAY.q[1]}” “${SAY.a[1]}” “${SAY.checks[1]}” “${SAY.ok[1]}” Everyone nods, and the experts take the block.`,
  ],
  [
    'merge',
    'Merge: the experts fit the block into the wall, which lights up, complete and shining. The contributor bounces over and they all celebrate.',
  ],
];

/* ------------------------------------------------------------------------------ the geometry */

/** The board grid's pad and gap (px), the same on every layout (how-work-moves.css). */
export const PAD = 12;
export const GAP = 8;
/** Figures at about 100 px (scale 1.05). */
export const FIG_SCALE = 1.05;
/** The floor band's height (px) and the floor line's height above the band's bottom. */
export const FLOOR_H = 206;
export const FLOOR_LIFT = 22;

/** A column-relative spot: column `c`, a fraction `fr` across it, then `dx` px. */
export interface Spot {
  c: number;
  fr: number;
  dx?: number;
}

/** The measured board: the track's width and the floor band's height, the columns, the scale. */
export interface Geo {
  W: number;
  H: number;
  /** the floor line, from the band's top */
  F: number;
  s: number;
  cols: { x0: number; w: number }[];
}

export function spotX(geo: Geo, p: Spot): number {
  const col = geo.cols[p.c];
  return col.x0 + p.fr * col.w + (p.dx ?? 0);
}

/**
 * A spot as a percentage of the track's width plus px: five equal columns with PAD and GAP make
 * x0(c) + fr·w = (c + fr)·W/5 + PAD + c·(GAP − K) − fr·K, with K = (2·PAD + 4·GAP)/5.
 */
export function spotPct(p: Spot): { pct: number; px: number } {
  const k = (2 * PAD + 4 * GAP) / 5;
  return {
    pct: f((p.c + p.fr) * 20),
    px: f(PAD + p.c * (GAP - k) - p.fr * k + (p.dx ?? 0)),
  };
}

/** The geometry of an ideal track `W` px wide (tests and the server's checks). */
export function gridGeo(W: number, H = FLOOR_H, s = FIG_SCALE): Geo {
  const w = (W - 2 * PAD - 4 * GAP) / 5;
  return {
    W,
    H,
    F: H - FLOOR_LIFT,
    s,
    cols: Array.from({ length: 5 }, (_, c) => ({ x0: PAD + c * (w + GAP), w })),
  };
}

/* ------------------------------------------------------------------------- the spots */

const CELL = 23; // a wall block (20) and its gap (3)
const WALL_COLS = 6;
const WALL_ROWS = 4;
export const WALL_W = WALL_COLS * CELL - 3;
/** The socket the finished block fits: column 3, row 1 of the wall. */
const SOCKET: Point = [3 * CELL + 10, -(WALL_ROWS - 1) * CELL + 10];

const g1 = geom('E1');

export const SPOTS = {
  off: { c: 0, fr: 0, dx: -70 - PAD },
  D2: { c: 0, fr: 0.2 },
  D3: { c: 0, fr: 0.5 },
  D5: { c: 0, fr: 0.8 },
  B3: { c: 1, fr: 0.42 },
  P3: { c: 2, fr: 0.28 },
  R3: { c: 3, fr: 0.2 },
  RE2: { c: 3, fr: 0.58 },
  RE1: { c: 3, fr: 0.86 },
  ME2: { c: 4, fr: 0.88 },
  // the contributor joins the experts just inside Merge's left edge, clear of its border
  MA3: { c: 4, fr: 0.13 },
  wall: { c: 4, fr: 0.5, dx: 8 - WALL_W / 2 },
  // E1 stands so its raised block lands exactly in the socket.
  ME1: {
    c: 4,
    fr: 0.5,
    dx: 8 - WALL_W / 2 + SOCKET[0] - (g1.tw / 2 + 20) * FIG_SCALE,
  },
} as const satisfies Record<string, Spot>;

export type SpotName = keyof typeof SPOTS;

/* ------------------------------------------------------------------------- the beat sheet */

const CAST_BOARD = ['A2', 'A5', 'A3', 'E2', 'E1'] as const;
export type BoardCast = (typeof CAST_BOARD)[number];
export { CAST_BOARD };

/** A track on an element found by selector: [phase, selector, frames]. */
export type PropTrack = [Phase, string, Frame[]];

export interface Say {
  k: SayKey;
  id: CastId;
  x: number;
  face: 1 | -1;
  pose: PoseKeySpec['pose'];
  t0: number;
  t1: number;
  tail: 'l' | 'r' | 'c';
}

export interface Plan {
  beats: Record<string, number | number[]>;
  K: Record<BoardCast, PoseKey[]>;
  loopK: Record<BoardCast, PoseKey[]>;
  props: PropTrack[];
  says: Say[];
  /** [ms, column]: the example card's moves (the first is where it starts) */
  cardMoves: [number, number][];
  /** [ms, column]: where the phone camera pans, as the action leaves for the next column */
  camera: [number, number][];
  pos: Record<SpotName, number>;
  finals: Record<BoardCast, PoseKeySpec>;
}

/** The whole story against one geometry: pose keys per astronaut, prop tracks, bubbles, the card. */
export function plan(geo: Geo): Plan {
  const s = geo.s;
  const X = (c: number, fr: number) => geo.cols[c].x0 + fr * geo.cols[c].w;
  const u = (px: number) => px / s; // px to astronaut units (.j-move)
  const K = Object.fromEntries(
    CAST_BOARD.map((id) => [id, []]),
  ) as unknown as Record<BoardCast, PoseKey[]>;
  const props: PropTrack[] = [];
  const says: Say[] = [];
  const key = (id: BoardCast, t: number, pose: PoseKeySpec, e?: string) =>
    K[id].push([t, pose, e]);
  const hop = (
    id: BoardCast,
    t0: number,
    x0: number,
    x1: number,
    o: {
      dur?: number;
      h?: number;
      face?: 1 | -1;
      P?: PoseKeySpec;
      chain?: boolean;
      from?: PoseKeySpec['pose'];
      land?: PoseKeySpec['pose'];
    } = {},
  ) => {
    const dur = o.dur ?? 620;
    const h = o.h ?? -38;
    const face = o.face ?? (x1 >= x0 ? 1 : -1);
    const P = o.P || {};
    const t1 = t0 + 150;
    const t2 = t1 + 60;
    const t3 = t2 + dur;
    key(id, t0, { pose: o.from || 'stand', ...P, x: u(x0), face }, EASE.inOut);
    key(id, t1, { pose: 'crouch', ...P, x: u(x0), face }, EASE.out);
    key(
      id,
      t2,
      { pose: 'hop', ...P, y: -4, sq: 0.06, x: u(x0), face },
      EASE.up,
    );
    key(
      id,
      t2 + dur / 2,
      { pose: 'hop', ...P, y: h, sq: 0.02, x: u((x0 + x1) / 2), face },
      EASE.down,
    );
    key(id, t3, { pose: 'hop', ...P, y: 0, sq: 0, x: u(x1), face }, EASE.out);
    key(
      id,
      t3 + 90,
      { pose: 'crouch', ...P, y: 3, sq: -0.07, x: u(x1), face },
      EASE.back,
    );
    if (!o.chain)
      key(
        id,
        t3 + 300,
        { pose: o.land || 'stand', ...P, x: u(x1), face },
        EASE.inOut,
      );
    return o.chain ? t3 + 90 : t3 + 300;
  };
  const walk = (
    id: BoardCast,
    t0: number,
    x0: number,
    x1: number,
    P: PoseKeySpec = {},
    step = 300,
    n = 8,
  ) => {
    const seq = ['walkA', 'walkMid', 'walkB', 'walkMid'] as const;
    const face = x1 >= x0 ? 1 : -1;
    for (let i = 0; i <= n; i++)
      key(
        id,
        t0 + (i * step) / 2,
        {
          pose: i === n ? 'stand' : seq[i % 4],
          ...P,
          x: u(x0 + ((x1 - x0) * i) / n),
          face,
        },
        EASE.sine,
      );
    return t0 + (n * step) / 2;
  };
  const say = (
    k: SayKey,
    id: CastId,
    x: number,
    face: 1 | -1,
    pose: PoseKeySpec['pose'],
    t0: number,
    t1: number,
    tail: Say['tail'] = 'c',
  ) => says.push({ k, id, x, face, pose, t0, t1, tail });

  const pos = Object.fromEntries(
    Object.entries(SPOTS).map(([name, spot]) => [name, spotX(geo, spot)]),
  ) as Record<SpotName, number>;
  const { off, D2, D3, D5, B3, P3, R3, RE2, RE1, ME2, ME1, MA3 } = pos;

  // ---- 1. Discussion: three hop in from the left and chat
  hop('A2', 400, off, D2, { dur: 700 });
  hop('A5', 650, off, D5, { dur: 900, h: -46 });
  key('A5', 2150, { pose: 'stand', x: u(D5), face: -1 });
  hop('A3', 900, off, D3, { dur: 800, h: -42 });
  key('A3', 2250, { pose: 'stand', x: u(D3), face: 1 }, EASE.inOut);
  key(
    'A3',
    2400,
    { pose: 'chat', x: u(D3), face: 1, expr: 'talk' },
    EASE.inOut,
  );
  say('hello', 'A3', D3, 1, 'chat', 2450, 3550, 'c');
  key('A3', 3500, { pose: 'listen', x: u(D3), face: -1 }, EASE.inOut);
  key(
    'A2',
    3300,
    { pose: 'chat', x: u(D2), face: 1, expr: 'talk' },
    EASE.inOut,
  );
  say('welcome', 'A2', D2, 1, 'chat', 3400, 4500, 'l');
  key('A2', 4500, { pose: 'stand', x: u(D2), face: 1 }, EASE.inOut);
  key('A3', 4350, { pose: 'listen', x: u(D3), face: 1 }, EASE.inOut);
  key('A5', 4300, { pose: 'stand', x: u(D5), face: 1 });
  key(
    'A5',
    4400,
    { pose: 'point', x: u(D5), face: 1, expr: 'talk' },
    EASE.inOut,
  );
  say('backlog', 'A5', D5, 1, 'point', 4500, 5600, 'r');
  key(
    'A5',
    5500,
    { pose: 'point', x: u(D5), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  key('A5', 5900, { pose: 'stand', x: u(D5), face: -1 }, EASE.inOut);
  key(
    'A3',
    5100,
    { pose: 'stand', x: u(D3), face: 1, expr: 'happy' },
    EASE.inOut,
  );

  // ---- 2. to the Backlog: two low-gravity bounces
  let t = hop('A3', 5600, D3, X(1, -0.04), { dur: 560, h: -44, chain: true });
  t = hop('A3', t - 150, X(1, -0.04), B3, { dur: 520, h: -32, from: 'crouch' });
  // browse: tablet out, a hover ring walks down the column
  key('A3', t + 100, { pose: 'scroll', x: u(B3), face: 1 }, EASE.inOut);
  const tBrowse = t + 100;
  key(
    'A3',
    tBrowse + 700,
    { pose: 'scroll', head: 18, x: u(B3), face: 1 },
    EASE.inOut,
  );
  key(
    'A3',
    tBrowse + 1400,
    { pose: 'scroll', head: 8, x: u(B3), face: 1 },
    EASE.inOut,
  );
  props.push([
    'story',
    '.tablet-rows',
    [
      [tBrowse, 'translateY(0px)'],
      [tBrowse + 300, 'translateY(0px)', EASE.inOut],
      [tBrowse + 1500, 'translateY(-4px)'],
    ],
  ]);
  props.push([
    'story',
    '[data-hover="real"]',
    [
      [tBrowse + 200, { opacity: 0 }],
      [tBrowse + 300, { opacity: 1 }],
      [tBrowse + 900, { opacity: 1 }],
      [tBrowse + 1000, { opacity: 0 }],
    ],
  ]);
  props.push([
    'story',
    '[data-hover="example"]',
    [
      [tBrowse + 900, { opacity: 0 }],
      [tBrowse + 1000, { opacity: 1 }],
      [tBrowse + 1700, { opacity: 1 }],
      [tBrowse + 1800, { opacity: 0 }],
    ],
  ]);
  // idea: the bulb, then the pick (the example card lights: Ready folds into Backlog)
  const tIdea = tBrowse + 1800;
  key(
    'A3',
    tIdea,
    { pose: 'idea', x: u(B3), face: 1, expr: 'open' },
    EASE.back,
  );
  props.push([
    'story',
    '.bulb',
    [
      [0, { opacity: 0, transform: 'scale(0)' }],
      [tIdea, { opacity: 0, transform: 'scale(0)' }],
      [tIdea + 1, { opacity: 1, transform: 'scale(0)' }, EASE.back],
      [tIdea + 350, { opacity: 1, transform: 'scale(1)' }],
      [tIdea + 1700, { opacity: 1, transform: 'scale(1)' }, EASE.out],
      [tIdea + 2000, { opacity: 0, transform: 'scale(1)' }],
    ],
  ]);
  props.push([
    'story',
    '.bulb .bulb-rays',
    [
      [tIdea + 200, { opacity: 0 }],
      [tIdea + 350, { opacity: 1 }],
      [tIdea + 900, { opacity: 0.4 }],
      [tIdea + 1200, { opacity: 1 }],
    ],
  ]);
  const tSel = tIdea + 800;
  key(
    'A3',
    tSel,
    {
      pose: 'point',
      handN: (g: Geom) => [g.shN[0] + 18, g.top - 12],
      x: u(B3),
      face: 1,
      expr: 'happy',
    },
    EASE.inOut,
  );
  key(
    'A3',
    tSel + 900,
    { pose: 'stand', x: u(B3), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  const dim = {
    boxShadow: '0 0 0 0 rgb(31 111 235 / 0%)',
    borderColor: '#30363d',
  };
  const lit = {
    boxShadow: '0 0 0 1px #1f6feb, 0 0 22px rgb(31 111 235 / 45%)',
    borderColor: '#1f6feb',
  };
  props.push([
    'story',
    '.ex-lit',
    [
      [0, dim],
      [tSel + 150, dim, EASE.out],
      [tSel + 450, lit],
    ],
  ]);
  props.push([
    'story',
    '.ex-av',
    [
      [tSel + 300, { opacity: 0, transform: 'scale(.4)' }, EASE.back],
      [tSel + 600, { opacity: 1, transform: 'scale(1)' }],
    ],
  ]);

  // ---- 3. In progress: bounce over (the card slides along), sit, strike and inspect three times
  const tGo = tSel + 1000;
  t = hop('A3', tGo, B3, X(2, -0.03), { dur: 560, h: -44, chain: true });
  t = hop('A3', t - 150, X(2, -0.03), P3, { dur: 460, h: -26, from: 'crouch' });
  const cardMoves: [number, number][] = [
    [0, 1],
    [tGo + 200, 2],
  ];
  let tf = t + 80;
  key('A3', tf, { pose: 'sit', x: u(P3), face: 1 }, EASE.inOut);
  tf += 350;
  const strikes: number[] = [];
  for (let i = 0; i < 3; i++) {
    key('A3', tf, { pose: 'hammerUp', x: u(P3), face: 1 }, EASE.inOut);
    key('A3', tf + 380, { pose: 'hammerUp', x: u(P3), face: 1 }, EASE.snap);
    key('A3', tf + 470, { pose: 'hammerHit', x: u(P3), face: 1 }, EASE.out);
    strikes.push(tf + 470);
    key(
      'A3',
      tf + 620,
      { pose: 'hammerHit', lean: 12, x: u(P3), face: 1 },
      EASE.inOut,
    );
    key('A3', tf + 900, { pose: 'inspect', x: u(P3), face: 1 }, EASE.inOut);
    key(
      'A3',
      tf + 1300,
      {
        pose: 'inspect',
        head: 22,
        x: u(P3),
        face: 1,
        expr: i === 2 ? 'happy' : 'focus',
      },
      EASE.inOut,
    );
    tf += 1500;
  }
  const blk: Frame[] = [[0, 'scale(1, 1)']];
  strikes.forEach((st) =>
    blk.push(
      [st - 1, 'scale(1, 1)'],
      [st, 'scale(1.18, .78)', EASE.back],
      [st + 260, 'scale(1, 1)'],
    ),
  );
  props.push(['story', '.crate-block .j-blk', blk]);
  const spark: Frame[] = [[0, { opacity: 0 }]];
  strikes.forEach((st) =>
    spark.push(
      [st - 1, { opacity: 0, transform: 'scale(.6)' }],
      [st, { opacity: 1, transform: 'scale(.6)' }, EASE.out],
      [st + 300, { opacity: 0, transform: 'scale(1.3)' }],
    ),
  );
  props.push(['story', '.strike-spark', spark]);
  const tLit = strikes[2] + 700;
  props.push([
    'story',
    '.crate-lit',
    [
      [0, { opacity: 0 }],
      [tLit, { opacity: 0 }, EASE.out],
      [tLit + 300, { opacity: 1 }],
    ],
  ]);
  props.push([
    'story',
    '.lit-spark',
    [
      [0, { opacity: 0, transform: 'scale(.5)' }],
      [tLit, { opacity: 0, transform: 'scale(.5)' }, EASE.back],
      [tLit + 350, { opacity: 1, transform: 'scale(1)' }],
      [tLit + 900, { opacity: 0, transform: 'scale(1.2)' }],
    ],
  ]);

  // ---- 4. In review: stand, take the block, bounce over, present; the pull request asks for review
  const tUp = tf + 100;
  const carry: PoseKeySpec = {
    block: (g) => [g.tw / 2 + 10, g.top + 14],
    blockLit: true,
    handN: (g) => [g.tw / 2 + 15, g.top + 18],
    handF: (g) => [g.tw / 2 + 4, g.top + 14],
  };
  key(
    'A3',
    tUp,
    { pose: 'stand', x: u(P3), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  key(
    'A3',
    tUp + 300,
    { pose: 'carry', ...carry, x: u(P3), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  props.push([
    'story',
    '.crate-block',
    [
      [0, { opacity: 1 }],
      [tUp + 300, { opacity: 1 }],
      [tUp + 301, { opacity: 0 }],
    ],
  ]);
  props.push([
    'story',
    '.crate-lit',
    [
      [tUp + 300, { opacity: 1 }],
      [tUp + 301, { opacity: 0 }],
    ],
  ]);
  t = hop('A3', tUp + 450, P3, X(3, -0.04), {
    dur: 560,
    h: -36,
    chain: true,
    P: carry,
  });
  t = hop('A3', t - 150, X(3, -0.04), R3, {
    dur: 460,
    h: -24,
    from: 'crouch',
    P: carry,
  });
  cardMoves.push([tUp + 600, 3]);
  props.push([
    'story',
    '.ex-pr',
    [
      [0, { opacity: 0, maxHeight: '0px' }],
      [tUp + 900, { opacity: 0, maxHeight: '0px' }, EASE.out],
      [tUp + 1300, { opacity: 1, maxHeight: '40px' }],
    ],
  ]);
  const tPres = t + 50;
  key(
    'A3',
    tPres,
    { pose: 'present', x: u(R3), face: 1, expr: 'happy' },
    EASE.back,
  );
  key(
    'A3',
    tPres + 700,
    { pose: 'present', head: -16, x: u(R3), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  // the experts walk over from Merge
  const tEx = tPres - 300;
  const e2arr = walk('E2', tEx, ME2, RE2, {}, 320, 10);
  const e1arr = walk('E1', tEx + 250, ME1, RE1, {}, 320, 8);
  key('E2', e2arr + 100, { pose: 'think', x: u(RE2), face: -1 }, EASE.inOut);
  key(
    'E1',
    e1arr + 100,
    { pose: 'listen', head: 10, lean: 6, x: u(RE1), face: -1 },
    EASE.inOut,
  );
  key('A3', tPres + 1500, { pose: 'present', x: u(R3), face: 1 }, EASE.inOut);
  // the conversation
  const tt = Math.max(e1arr, e2arr) + 300;
  key(
    'E1',
    tt,
    { pose: 'chat', x: u(RE1), face: -1, expr: 'talk' },
    EASE.inOut,
  );
  say('q', 'E1', RE1, -1, 'chat', tt + 50, tt + 1300, 'r');
  key('A3', tt + 1250, { pose: 'present', x: u(R3), face: 1 }, EASE.inOut);
  key(
    'A3',
    tt + 1300,
    {
      pose: 'chat',
      ...carry,
      handN: (g) => [g.shN[0] + 17, g.shN[1] - 6],
      x: u(R3),
      face: 1,
      expr: 'talk',
    },
    EASE.inOut,
  );
  say('a', 'A3', R3, 1, 'chat', tt + 1350, tt + 2600, 'l');
  key('E1', tt + 1350, { pose: 'think', x: u(RE1), face: -1 }, EASE.inOut);
  key(
    'E2',
    tt + 2500,
    { pose: 'chat', x: u(RE2), face: -1, expr: 'talk' },
    EASE.inOut,
  );
  say('checks', 'E2', RE2, -1, 'chat', tt + 2600, tt + 3800, 'c');
  key(
    'A3',
    tt + 2650,
    { pose: 'carry', ...carry, x: u(R3), face: 1 },
    EASE.inOut,
  );
  key('E2', tt + 3800, { pose: 'clipboard', x: u(RE2), face: -1 }, EASE.inOut);
  key(
    'E1',
    tt + 3700,
    { pose: 'chat', x: u(RE1), face: -1, expr: 'happy' },
    EASE.inOut,
  );
  say('ok', 'E1', RE1, -1, 'chat', tt + 3800, tt + 4900, 'r');
  const tApproved = tt + 3900;
  props.push([
    'story',
    '.st-req',
    [
      [0, { opacity: 1 }],
      [tApproved, { opacity: 1 }],
      [tApproved + 1, { opacity: 0 }],
    ],
  ]);
  props.push([
    'story',
    '.st-ok',
    [
      [0, { opacity: 0 }],
      [tApproved, { opacity: 0 }],
      [tApproved + 1, { opacity: 1 }],
    ],
  ]);
  // nods all round, twice
  const tN = tt + 4800;
  for (const [id, x, face] of [
    ['A3', R3, 1],
    ['E2', RE2, -1],
    ['E1', RE1, -1],
  ] as const) {
    const extra = id === 'A3' ? carry : {};
    key(id, tN, { pose: 'stand', ...extra, x: u(x), face }, EASE.inOut);
    key(
      id,
      tN + 220,
      { pose: 'nod', ...extra, x: u(x), face, expr: 'happy' },
      EASE.inOut,
    );
    key(
      id,
      tN + 440,
      { pose: 'stand', ...extra, x: u(x), face, expr: 'happy' },
      EASE.inOut,
    );
    key(
      id,
      tN + 660,
      { pose: 'nod', ...extra, x: u(x), face, expr: 'happy' },
      EASE.inOut,
    );
    key(
      id,
      tN + 880,
      { pose: 'stand', ...extra, x: u(x), face, expr: 'happy' },
      EASE.inOut,
    );
  }
  // hand-off: E1 steps in; the block passes from hand to hand at one point in space
  const tH = tN + 1000;
  const giveA3: PoseKeySpec = { pose: 'give', blockLit: true };
  const a3block = anchors('A3', resolveKey('A3', giveA3)).block!; // A3 units, facing right
  const handX = R3 + a3block[0] * s;
  const e1Give: PoseKeySpec = {
    pose: 'give',
    blockLit: true,
    block: (g) => [g.tw / 2 + 20, a3block[1]],
    handN: (g) => [g.tw / 2 + 25, a3block[1] + 5],
    handF: (g) => [g.tw / 2 + 13, a3block[1] + 1],
  };
  const e1BlockX = anchors('E1', resolveKey('E1', e1Give)).block![0];
  const HE1 = handX + e1BlockX * s; // E1 faces left: its block sits to its left
  key('A3', tH, { ...giveA3, x: u(R3), face: 1, expr: 'happy' }, EASE.inOut);
  key('E1', tH, { pose: 'stand', x: u(RE1), face: -1 }, EASE.inOut);
  key(
    'E1',
    tH + 350,
    { pose: 'walkA', x: u((RE1 + HE1) / 2), face: -1 },
    EASE.inOut,
  );
  key('E1', tH + 650, { ...e1Give, x: u(HE1), face: -1 }, EASE.inOut);
  const tSwap = tH + 760;
  key('A3', tSwap, { ...giveA3, x: u(R3), face: 1, expr: 'happy' }, EASE.inOut);
  key(
    'A3',
    tSwap + 1,
    { pose: 'stand', x: u(R3), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  key(
    'A3',
    tSwap + 300,
    { pose: 'wave', x: u(R3), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  key(
    'A3',
    tSwap + 900,
    { pose: 'stand', x: u(R3), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  key('E1', tSwap, { ...e1Give, x: u(HE1), face: -1 });
  key(
    'E1',
    tSwap + 300,
    { pose: 'carry', blockLit: true, x: u(HE1), face: -1 },
    EASE.inOut,
  );
  key('E1', tSwap + 400, { pose: 'carry', blockLit: true, x: u(HE1), face: 1 });

  // ---- 5. Merge: the experts carry the block over and fit it; the wall shines; the contributor
  // bounces over and they all celebrate
  const tM = tSwap + 450;
  const e1m = walk('E1', tM, HE1, ME1, { ...carry, blockLit: true }, 300, 8);
  const e2m = walk('E2', tM + 200, RE2, ME2, {}, 320, 10);
  key('E2', e2m + 100, { pose: 'think', x: u(ME2), face: -1 }, EASE.inOut);
  cardMoves.push([tM + 200, 4]);
  const tMerged = tM + 600;
  props.push([
    'story',
    '.ex-merged',
    [
      [0, { opacity: 0 }],
      [tMerged, { opacity: 0 }],
      [tMerged + 1, { opacity: 1 }],
    ],
  ]);
  props.push([
    'story',
    '.ex-pr-merged',
    [
      [0, { opacity: 0 }],
      [tMerged, { opacity: 0 }],
      [tMerged + 1, { opacity: 1 }],
    ],
  ]);
  props.push([
    'story',
    '.st-ok',
    [
      [tMerged, { opacity: 1 }],
      [tMerged + 1, { opacity: 0 }],
    ],
  ]);
  props.push([
    'story',
    '.st-merged',
    [
      [0, { opacity: 0 }],
      [tMerged, { opacity: 0 }],
      [tMerged + 1, { opacity: 1 }],
    ],
  ]);
  // once merged, the card is an ordinary merged card again: its Ready glow fades
  props.push([
    'story',
    '.ex-lit',
    [
      [tMerged + 300, lit, EASE.out],
      [tMerged + 900, dim],
    ],
  ]);
  const tFit = e1m + 150;
  const fitHi: PoseKeySpec = {
    pose: 'fit',
    block: (g) => [g.tw / 2 + 20, u(SOCKET[1])],
    handN: (g) => [g.tw / 2 + 11, u(SOCKET[1]) + 5],
    handF: (g) => [g.tw / 2 + 9, u(SOCKET[1]) - 4],
  };
  key(
    'E1',
    tFit,
    { pose: 'carry', ...carry, blockLit: true, x: u(ME1), face: 1 },
    EASE.inOut,
  );
  key('E1', tFit + 400, { ...fitHi, x: u(ME1 - 8), face: 1 }, EASE.inOut);
  key(
    'E1',
    tFit + 800,
    { ...fitHi, x: u(ME1), face: 1, expr: 'focus' },
    EASE.back,
  );
  const tIn = tFit + 820;
  key('E1', tIn, { ...fitHi, x: u(ME1), face: 1 }, EASE.inOut);
  key(
    'E1',
    tIn + 1,
    { pose: 'fit', block: undefined, x: u(ME1), face: 1 },
    EASE.inOut,
  );
  key(
    'E1',
    tIn + 500,
    { pose: 'stand', x: u(ME1 + 6), face: 1, expr: 'happy' },
    EASE.inOut,
  );
  props.push([
    'story',
    '.wall-fill',
    [
      [0, { opacity: 0 }],
      [tIn, { opacity: 0 }],
      [tIn + 1, { opacity: 1 }],
    ],
  ]);
  props.push([
    'story',
    '.wall-fill .j-wf',
    [
      [tIn, 'scale(1.25)'],
      [tIn + 1, 'scale(1.25)', EASE.back],
      [tIn + 260, 'scale(1)'],
    ],
  ]);
  props.push([
    'story',
    '.wall-shine',
    [
      [0, { opacity: 0 }],
      [tIn + 150, { opacity: 0 }, EASE.out],
      [tIn + 500, { opacity: 1 }],
      [tIn + 1500, { opacity: 0.55 }],
    ],
  ]);
  for (let r = 0; r < WALL_ROWS; r++)
    for (let c = 0; c < WALL_COLS; c++) {
      if (r === 1 && c === 3) continue;
      const d = Math.hypot(c - 3, r - 1) * 90;
      props.push([
        'story',
        `.wall-cell-${r}-${c}`,
        [
          [0, { fill: '#2a4a74' }],
          [tIn + 150 + d, { fill: '#2a4a74' }, EASE.out],
          [tIn + 350 + d, { fill: '#bff4ff' }, EASE.inOut],
          [tIn + 900 + d, { fill: '#5fb4dc' }],
        ],
      ]);
    }
  props.push([
    'story',
    '.wall-glow',
    [
      [0, { opacity: 0 }],
      [tIn + 150, { opacity: 0 }, EASE.out],
      [tIn + 700, { opacity: 1 }],
    ],
  ]);
  const sweepFrom = 'translateX(-40px)';
  const sweepTo = `translateX(${WALL_W + 40}px)`;
  props.push([
    'story',
    '.wall-sweep',
    [
      [0, { opacity: 0, transform: sweepFrom }],
      [tIn + 200, { opacity: 0, transform: sweepFrom }],
      [tIn + 300, { opacity: 0.9, transform: sweepFrom }, EASE.inOut],
      [tIn + 1200, { opacity: 0, transform: sweepTo }],
    ],
  ]);
  // the contributor bounces over from In review
  const tJ = tIn + 200;
  t = hop('A3', tJ, R3, X(3, 0.7), { dur: 520, h: -40, chain: true });
  t = hop('A3', t - 150, X(3, 0.7), MA3, { dur: 600, h: -40, from: 'crouch' });
  // celebrate: three bounces each, staggered, happy; confetti
  const tC = Math.max(t, tIn + 900) + 100;
  const crew = [
    ['A3', MA3, 1, 0],
    ['E1', ME1 + 6, 1, 140],
    ['E2', ME2, -1, 280],
  ] as const;
  for (const [id, x, face, d] of crew) {
    for (let i = 0; i < 3; i++) {
      const b0 = tC + d + i * 760;
      key(id, b0, { pose: 'crouch', x: u(x), face, expr: 'happy' }, EASE.up);
      key(
        id,
        b0 + 330,
        { pose: 'celebrate', x: u(x), face, expr: 'happy' },
        EASE.down,
      );
      key(
        id,
        b0 + 660,
        { pose: 'stand', x: u(x), face, expr: 'happy', sq: -0.04 },
        EASE.back,
      );
    }
    key(
      id,
      tC + d + 2400,
      { pose: 'stand', x: u(x), face, expr: 'happy' },
      EASE.inOut,
    );
  }
  props.push([
    'story',
    '.confetti',
    [
      [0, { opacity: 0, transform: 'translateY(30px) scale(.6)' }],
      [
        tC + 250,
        { opacity: 0, transform: 'translateY(30px) scale(.6)' },
        EASE.out,
      ],
      [tC + 700, { opacity: 1, transform: 'translateY(0px) scale(1)' }],
      [
        tC + 2000,
        { opacity: 1, transform: 'translateY(16px) scale(1)' },
        EASE.inOut,
      ],
      [tC + 2800, { opacity: 0, transform: 'translateY(40px) scale(1)' }],
    ],
  ]);

  // the end of the story: final poses, held until the loop takes over
  const end = T.story;
  const finals: Record<BoardCast, PoseKeySpec> = {
    A2: { pose: 'listen', x: u(D2), face: 1 },
    A5: { pose: 'chat', x: u(D5), face: -1 },
    A3: { pose: 'stand', x: u(MA3), face: 1, expr: 'happy' },
    E2: { pose: 'clipboard', x: u(ME2), face: -1 },
    E1: { pose: 'stand', x: u(ME1 + 6), face: 1, expr: 'happy' },
  };
  // A2 and A5 keep the Discussion going after A3 leaves
  key('A2', 7200, { pose: 'listen', x: u(D2), face: 1 }, EASE.inOut);
  key(
    'A5',
    7000,
    { pose: 'chat', x: u(D5), face: -1, expr: 'talk' },
    EASE.inOut,
  );
  for (const id of CAST_BOARD) {
    const start: PoseKeySpec =
      id === 'E2'
        ? { pose: 'clipboard', x: u(ME2), face: -1 }
        : id === 'E1'
          ? { pose: 'stand', x: u(ME1), face: 1 }
          : { pose: 'stand', x: u(off), face: 1 };
    K[id].unshift([0, start]);
    K[id].push([end - 400, finals[id], EASE.inOut], [end, finals[id]]);
    K[id].sort((a, b) => a[0] - b[0]);
  }
  // A speaker holds the pose they speak in until their bubble starts to fade, so the bubble's tail
  // stays on their helmet (keys interpolate, so the head would otherwise drift toward the next pose
  // while the bubble still shows).
  for (const said of says) {
    const keys = K[said.id as BoardCast];
    const at = keys.findLastIndex(([t]) => t <= said.t0 + 60);
    const hold = said.t1 - 220;
    const next = keys[at + 1];
    if (at >= 0 && next && next[0] > hold && hold > keys[at][0]) {
      keys.splice(at + 1, 0, [hold, keys[at][1], EASE.inOut]);
    }
  }

  // ---- idle loop (8 s): the Discussion pair keeps talking; the Merge crew admires the wall
  const loopK: Record<BoardCast, PoseKey[]> = {
    A2: [
      [0, finals.A2],
      [2600, { ...finals.A2, pose: 'chat', expr: 'talk' }, EASE.inOut],
      [4200, finals.A2, EASE.inOut],
      [6400, { ...finals.A2, head: 6 }, EASE.inOut],
      [8000, finals.A2],
    ],
    A5: [
      [0, finals.A5],
      [1400, { ...finals.A5, pose: 'listen' }, EASE.inOut],
      [4800, { ...finals.A5, pose: 'nod', expr: 'happy' }, EASE.inOut],
      [5300, { ...finals.A5, pose: 'listen' }, EASE.inOut],
      [7200, finals.A5, EASE.inOut],
      [8000, finals.A5],
    ],
    A3: [
      [0, finals.A3],
      [3000, finals.A3, EASE.up],
      [3300, { ...finals.A3, pose: 'hop', y: -16 }, EASE.down],
      [3600, { ...finals.A3, sq: -0.05 }, EASE.back],
      [3900, finals.A3],
      [8000, finals.A3],
    ],
    E2: [
      [0, finals.E2],
      [2000, { ...finals.E2, head: 14 }, EASE.inOut],
      [3200, finals.E2, EASE.inOut],
      [8000, finals.E2],
    ],
    E1: [
      [0, finals.E1],
      [5000, { ...finals.E1, pose: 'nod' }, EASE.inOut],
      [5400, finals.E1, EASE.inOut],
      [8000, finals.E1],
    ],
  };
  props.push([
    'loop',
    '.wall-sweep',
    [
      [0, { opacity: 0, transform: sweepFrom }],
      [5600, { opacity: 0, transform: sweepFrom }],
      [5700, { opacity: 0.6, transform: sweepFrom }, EASE.inOut],
      [6700, { opacity: 0, transform: sweepTo }],
      [8000, { opacity: 0, transform: sweepTo }],
    ],
  ]);

  // The phone camera leaves with the action: as the contributor sets off for the Backlog, for In
  // progress and for In review, and as the experts carry the block to Merge.
  const camera: [number, number][] = [
    [0, 0],
    [5600, 1],
    [tGo, 2],
    [tUp, 3],
    [tM - 200, 4],
  ];

  const beats = {
    tBrowse,
    tIdea,
    tSel,
    tGo,
    strikes,
    tLit,
    tUp,
    tPres,
    tEx,
    talk: tt,
    tApproved,
    tN,
    tH,
    tSwap,
    tM,
    tMerged,
    tFit,
    tIn,
    tJ,
    tC,
  };
  return { beats, K, loopK, props, says, cardMoves, camera, pos, finals };
}

/** The column the example card sits in at `t` (it slides 520 ms; it belongs to the new column
 * from the move's start + 260 ms, when the counts tick). */
export function cardColumnAt(P: Pick<Plan, 'cardMoves'>, t: number): number {
  let col = P.cardMoves[0][1];
  for (const [at, c] of P.cardMoves.slice(1)) if (t >= at + 260) col = c;
  return col;
}

/* ----------------------------------------------------------------------------- the markup */

/** This board's own ids: every kit id gets the `wb-` prefix, so no other scene's definitions on
 * the page (which may sit in a hidden layout) can shadow the board's gradients and clips. */
export function scopeIds(markup: string): string {
  return markup.replace(
    /(\sid="|url\(#)(k(?:v-[a-z]+|[A-Z][A-Za-z]*)|av-[\w-]+|wallclip)/g,
    '$1wb-$2',
  );
}

/** The held props each figure keeps ready (hidden until a key shows them). */
const PROPS_OF: Partial<Record<BoardCast, AstronautOptions>> = {
  A3: { propN: 'tablet', propFar: 'hammer', holdBlock: 'lit' },
  E1: { holdBlock: 'lit' },
  E2: { propN: 'clipboard' },
};

const defs = () => kitDefs().replace('</defs>', `${moonDefs()}</defs>`);

function wallMarkup(lit: boolean): string {
  const w = wall(WALL_COLS, WALL_ROWS, 20, [3, 1], { lit });
  return lit
    ? w.replace(
        'class="wall-shine" opacity="0"',
        'class="wall-shine" opacity=".55"',
      )
    : w;
}

/** The finished block in the socket. */
const socketBlock = () =>
  PROP.block(20, true).replace(
    'class="prop-block"',
    'class="prop-block" transform="translate(-1.6 1.6) scale(.84)"',
  );

const bench = (g3: Geom) => stool(g3.hipY + g3.sitDrop + 1);

/**
 * The live floor (motion allowed), measured against the columns: the figures in their story-end
 * poses, the wall complete, every bubble hidden; board.ts animates it from the story's start.
 */
export function renderFloor(geo: Geo, P: Plan): string {
  const s = geo.s;
  const F = geo.F;
  const at = (x: number, inner: string, cls = '') =>
    `<g class="${cls}" transform="translate(${f(x)} ${f(F)}) scale(${s})">${inner}</g>`;
  const { pos } = P;
  const wallH = WALL_ROWS * CELL;
  const wallG =
    `<g class="wall-g" transform="translate(${f(pos.wall)} ${f(F)})">${wallMarkup(true)}` +
    `<g class="wall-fill" transform="translate(${SOCKET[0]} ${SOCKET[1]})"><g class="j-wf">${socketBlock()}</g></g>` +
    `<clipPath id="wallclip"><rect x="-6" y="${-wallH - 6}" width="${WALL_W + 12}" height="${wallH + 6}" rx="3"/></clipPath>` +
    `<g clip-path="url(#wallclip)"><g class="wall-sweep" opacity="0"><rect x="0" y="${-wallH - 10}" width="26" height="${wallH + 14}" fill="#f2fdff" transform="skewX(-18)"/></g></g></g>`;
  // In progress: the seat and the workbench with its block (raw, then lit), and the sparks
  const g3 = geom('A3');
  const bt = g3.bench.top + g3.sitDrop;
  const crate = workCrate(g3, true, false).replace(
    'class="crate-block"',
    'class="crate-block" opacity="0"',
  );
  const litBlock = `<g class="crate-lit" opacity="0" transform="translate(${f(g3.bench.x - 1)} ${f(bt - g3.bench.block / 2 - 0.9)})">${PROP.block(g3.bench.block, true)}</g>`;
  const sparkAt = [g3.bench.x - 1, bt - g3.bench.block - 6];
  // An animated transform replaces a transform attribute, so each animated group sits inside the
  // group that places it.
  const sparks = (cls: string, dy: number, inner: string) =>
    `<g transform="translate(${f(sparkAt[0])} ${f(sparkAt[1] + dy)})"><g class="${cls}" opacity="0" style="transform-box:fill-box;transform-origin:50% 50%" fill="#e6fbff">${inner}</g></g>`;
  const spark = sparks(
    'strike-spark',
    0,
    sparkle(-9, -6, 4.5) + sparkle(9, -9, 3.5) + sparkle(0, -14, 3),
  );
  const litSpark = sparks(
    'lit-spark',
    4,
    sparkle(-14, -4, 4) + sparkle(14, -10, 3.4) + sparkle(2, -20, 3.8),
  );
  const workshop =
    at(pos.P3, bench(g3)) +
    at(pos.P3, `<g class="crate-g">${crate}${litBlock}${spark}${litSpark}</g>`);
  // the bulb above the contributor in the Backlog
  const idea = anchors('A3', resolveKey('A3', { pose: 'idea' })).headTop;
  const bulbG = `<g transform="translate(${f(pos.B3 + idea[0] * s + 2)} ${f(F + idea[1] * s - 26)})"><g class="bulb" opacity="0" style="transform-box:fill-box;transform-origin:50% 100%">${PROP.lightbulb()}</g></g>`;
  // confetti over the Merge crew (seeded)
  const conf = `<g transform="translate(${f((pos.MA3 + pos.ME2) / 2)} ${f(F - 118)})"><g class="confetti" opacity="0">${confetti(26, mulberry32(SEED), geo.cols[4].w * 0.9, 60)}</g></g>`;
  // the figures in their story-end poses
  const figs = (['A2', 'A5', 'E2', 'E1', 'A3'] as const)
    .map((id) => {
      const fin = P.finals[id];
      const markup = astronaut(id, fin.pose ?? 'stand', {
        face: fin.face,
        x: fin.x,
        expr: fin.expr,
        ...(PROPS_OF[id] ?? {}),
      });
      return at(0, markup, `who who-${id}`);
    })
    .join('');
  // speech bubbles, anchored to each speaker's helmet at the moment they speak
  const bubbles = P.says
    .map((b) => {
      const a = anchors(b.id, resolveKey(b.id, { pose: b.pose }));
      const hx = b.x + b.face * a.headTop[0] * s;
      const hy = F + a.headTop[1] * s;
      return bubble(hx, hy, SAY[b.k][1], {
        tail: b.tail,
        cls: `say say-${b.k}`,
        lift: 4,
        size: 14,
        hidden: true,
      });
    })
    .join('');
  return scopeIds(
    `<svg class="floor-svg floor-svg--live" viewBox="0 0 ${f(geo.W)} ${f(geo.H)}" width="${f(geo.W)}" height="${f(geo.H)}" aria-hidden="true" focusable="false">` +
      defs() +
      wallG +
      workshop +
      bulbG +
      figs +
      conf +
      bubbles +
      `</svg>`,
  );
}

/** A group placed at a spot on the floor line, with nested SVG at a percentage of the track. */
function placed(spot: Spot, F: number, inner: string, scale = 1): string {
  const { pct, px } = spotPct(spot);
  return `<svg x="${pct}%" overflow="visible"><g transform="translate(${px} ${F})${scale === 1 ? '' : ` scale(${scale})`}">${inner}</g></svg>`;
}

/**
 * The storyboard frame (reduced motion and no JavaScript; spec §4.3.4): one static picture that
 * tells the whole story, column by column, like a comic strip. The contributor appears once per
 * column, joined by faint dotted hop arcs; the experts think it over in review and celebrate at the
 * shining wall. Placed by percentages, so it fits every width without a script.
 */
export function renderStoryboard(H = FLOOR_H, s = FIG_SCALE): string {
  const F = H - FLOOR_LIFT;
  const fig = (
    id: CastId,
    pose: PoseKeySpec['pose'],
    spot: Spot,
    face: 1 | -1,
    expr?: PoseKeySpec['expr'],
  ) => placed(spot, F, astronaut(id, pose ?? 'stand', { face, expr }), s);
  const headTop = (
    id: CastId,
    pose: PoseKeySpec['pose'],
    face: 1 | -1,
  ): Point => {
    const a = anchors(id, resolveKey(id, { pose }));
    return [face * a.headTop[0] * s, a.headTop[1] * s];
  };
  const g3 = geom('A3');
  // the path the contributor took: faint dotted arcs between the five beats
  const stops = [SPOTS.D3, SPOTS.B3, SPOTS.P3, SPOTS.R3, SPOTS.MA3];
  const arcs = stops
    .slice(1)
    .map((to, i) => {
      const a = spotPct(stops[i]).pct + 2.4;
      const b = spotPct(to).pct - 2.4;
      return `<svg x="${f(a)}%" y="${F - 126}" width="${f(b - a)}%" height="118" viewBox="0 0 100 100" preserveAspectRatio="none" overflow="visible"><path d="M0 100 Q50 -4 100 100" fill="none" stroke="#7d8590" stroke-width="1.5" stroke-dasharray="2 6" stroke-linecap="round" opacity=".6" vector-effect="non-scaling-stroke"/></svg>`;
    })
    .join('');
  const hello = headTop('A3', 'chat', 1);
  const ok = headTop('E1', 'chat', -1);
  const bulb = headTop('A3', 'idea', 1);
  const wallG = placed(
    SPOTS.wall,
    F,
    `${wallMarkup(true)}<g transform="translate(${SOCKET[0]} ${SOCKET[1]})">${socketBlock()}</g>`,
  );
  const confettiG = placed(
    { c: 4, fr: (SPOTS.MA3.fr + SPOTS.ME2.fr) / 2 },
    F,
    `<g transform="translate(0 -118)">${confetti(26, mulberry32(SEED), 186, 60)}</g>`,
  );
  return scopeIds(
    `<svg class="floor-svg floor-svg--sb" width="100%" height="${H}" aria-hidden="true" focusable="false" overflow="visible">` +
      defs() +
      arcs +
      wallG +
      placed(SPOTS.P3, F, bench(g3) + workCrate(g3, true, false), s) +
      // 1 Discussion: three newcomers say hello
      fig('A2', 'listen', SPOTS.D2, 1) +
      fig('A3', 'chat', SPOTS.D3, 1, 'talk') +
      fig('A5', 'stand', SPOTS.D5, -1) +
      placed(
        SPOTS.D3,
        F,
        bubble(hello[0], hello[1], SAY.hello[1], {
          tail: 'c',
          lift: 4,
          size: 14,
        }),
      ) +
      // 2 Backlog: the idea
      fig('A3', 'idea', SPOTS.B3, 1, 'open') +
      placed(
        SPOTS.B3,
        F,
        `<g transform="translate(${f(bulb[0] + 2)} ${f(bulb[1] - 26)})">${PROP.lightbulb()}</g>`,
      ) +
      // 3 In progress: strike and inspect
      fig('A3', 'hammerHit', SPOTS.P3, 1) +
      // 4 In review: present; one expert thinks it over, the other approves
      fig('A3', 'present', SPOTS.R3, 1) +
      fig('E2', 'think', SPOTS.RE2, -1) +
      fig('E1', 'chat', SPOTS.RE1, -1, 'happy') +
      placed(
        SPOTS.RE1,
        F,
        bubble(ok[0], ok[1], SAY.ok[1], { tail: 'r', lift: 4, size: 14 }),
      ) +
      // 5 Merge: fitted, shining, celebrating
      fig('E1', 'stand', { ...SPOTS.ME1, dx: SPOTS.ME1.dx + 6 }, 1, 'happy') +
      fig('E2', 'clipboard', SPOTS.ME2, -1) +
      fig('A3', 'celebrate', SPOTS.MA3, 1) +
      confettiG +
      `</svg>`,
  );
}

/* --------------------------------------------------------------------------- phone camera */

/**
 * On the phone and tablet track (five 300 px columns) a camera follows the story: it pans to the
 * column where the action is, 700 ms on the camera ease, and rests on Merge. `view` is the visible
 * width.
 */
export function cameraKeys(
  geo: Geo,
  P: Pick<Plan, 'camera'>,
  view: number,
): Frame[] {
  const at = (col: number) => cameraOffset(geo, col, view);
  const frames: Frame[] = [[0, `translateX(${-at(0)}px)`]];
  for (const [t, c] of P.camera.slice(1))
    frames.push(
      [t, frames[frames.length - 1][1], EASE.inOut],
      [t + 700, `translateX(${-at(c)}px)`],
    );
  return frames;
}

/** The camera's offset (px) that centres column `col` in a `view` px window. */
export function cameraOffset(geo: Geo, col: number, view: number): number {
  const c = geo.cols[col];
  return f(Math.max(0, Math.min(geo.W - view, c.x0 + c.w / 2 - view / 2)));
}

/** The camera's column at `t` (the column it is panning to, from the pan's start). */
export function cameraColumnAt(P: Pick<Plan, 'camera'>, t: number): number {
  let col = 0;
  for (const [at, c] of P.camera) if (t >= at) col = c;
  return col;
}
