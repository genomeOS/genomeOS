/**
 * Contribute's orbit scene, as data and server markup (round 2 spec §4.3.2; characters.md §2, §4;
 * owner brief; R2-5, R2-6; #454). Ported from the design prototype
 * (`r2/characters/kit/orbit-scene.js`).
 *
 * The genomeOS globe sits in the middle; three working-group moons arrive one by one and orbit
 * slowly while each group's text types below the scene; then pods land 2, 1 and 3 astronauts, who
 * hop out, set up shop and get to work; then gentle 8 s idle loops.
 *
 * This module holds what the server and the client share: the timetable (`T`), the three layouts
 * (desktop, tablet, phone), the orbit's geometry, the crews and their props, the groups' copy, and
 * `renderOrbit()`, the SVG of the story's last frame (= the first frame of the idle loop), which is
 * also the reduced-motion and no-JavaScript picture. The tracks are in orbit.ts (client).
 *
 * Layouts are chosen by the stage's width, never the viewport's, so every moon label renders at
 * 13 px or more (spec §2.3): 1 viewBox unit is about 1 CSS px at a layout's widest stage, and each
 * layout's `label` size holds 13 px at its narrowest drawing (`minWidth`; the desktop's narrows
 * below its stage on a short screen, contribute.css).
 */
import { anchors, astronaut, PROP } from '../../graphics/astro/rig';
import type { CastId } from '../../graphics/astro/cast';
import type { PoseName } from '../../graphics/astro/poses';
import {
  bubble,
  cart,
  dust,
  easel,
  moon,
  moonLabel,
  onMoon,
  ore,
  probe,
  screen,
  spaceship,
  type BubbleIcon,
  type MoonKind,
} from '../../graphics/astro/props';
import { resolveKey } from '../../graphics/astro/tracks';
import { mulberry32, SEED } from '../../graphics/rng';
import { splitTyped } from '../../graphics/typing';
import { FOOTPRINT, type Box } from './orbit-footprint';

export { SEED };

const f = (n: number) => +(+n).toFixed(2);

/* ------------------------------------------------------------------------------------ timing */

/** The timetable, ms (characters.md §2.3). */
export const T = {
  story: 32000,
  loop: 8000,
  /** One revolution = 30 idle loops, so the orbit and the loops never drift apart. */
  orbit: 240000,
  /** Moon pops; each group's text types after its moon arrives (62 characters a second). */
  moon: { data: 800, model: 7200, ui: 14000 },
  /** Pod approaches; touchdown 2000 ms later. */
  ship: { data: 19400, model: 21600, ui: 23800 },
  /** The first frame of each moon's 8 s work loop (Data's first loop plays inside the story). */
  work: { data: 24000, model: 32000, ui: 32000 },
} as const;

/** The ms between a pod's approach and its touchdown. */
export const TOUCHDOWN_MS = 2000;

export const KINDS: readonly MoonKind[] = ['data', 'model', 'ui'];

/* ----------------------------------------------------------------------------------- layouts */

export type LayoutId = 'desktop' | 'tablet' | 'phone';

export interface OrbitLayout {
  id: LayoutId;
  /** viewBox */
  w: number;
  h: number;
  /** the globe's centre and radius */
  cx: number;
  cy: number;
  globe: number;
  /** the orbit's radii (an ellipse; the phone's is a face-on circle) */
  Rx: number;
  Ry: number;
  /** crew scale (an astronaut is about 96 units tall at 1) */
  cs: number;
  /** moon label size, units */
  label: number;
  /**
   * A moon label's baseline below the moon's rim, units. It stays put while the moon shrinks to
   * the back of the orbit, as the label keeps its size there (renderOrbit), so the gap between a
   * moon and its name is one gap all the way round. The desktop's is as deep as it can be with the
   * Modeling label still clear of the globe's art as it passes over it while the pods land: any
   * deeper and the label hid for four seconds of the story (labelTrack; review of the orbit's
   * hover, finding 2).
   */
  drop: number;
  r: Record<MoonKind, number>;
  lod: 'full' | 'lite';
  /** short moon labels ("Data", "Modeling", "UI") */
  short: boolean;
  /** the narrowest stage this layout is drawn at, CSS px (OrbitScene's container query) */
  minStage: number;
  /**
   * The narrowest the drawing gets, CSS px: the desktop's is sized to the screen's height and may
   * be narrower than its stage on a short laptop screen (contribute.css), its labels at 13 px still.
   */
  minWidth: number;
}

/**
 * Desktop from a 960 px stage; tablets from 680 px (round 2 spec §4.3.2: the layout the prototype
 * left unbuilt); phones below, at 274 px and up (the 320 px viewport). Labels are larger than the
 * prototype's where the site's wider page gutters make the stage narrower than the prototype
 * measured.
 *
 * The desktop and tablet stages are as tall as the orbit needs and no taller (owner, 2026-10-15:
 * the section "just needs to be maybe 20% less tall so we can fit both the graphics and text panels
 * on the screen at once"): the top moon's crew, mid-hop, reaches 3 units under the top edge (and
 * lands there lower, landingReach), and on the desktop the front moon's label fades out as it would
 * cross the bottom edge (labelCover), so the stage ends just under the front moon. The desktop's 21-unit labels let its drawing narrow to
 * 818 px on a short laptop screen (1366 × 768), labels still 13 px, so the plate's text shows under
 * it; the moons and crews keep their sizes in units.
 */
export const LAYOUTS: Record<LayoutId, OrbitLayout> = {
  desktop: {
    id: 'desktop',
    w: 1320,
    h: 665,
    cx: 660,
    cy: 358,
    globe: 64,
    Rx: 460,
    Ry: 172,
    cs: 0.9,
    label: 21,
    drop: 24,
    r: { data: 104, model: 90, ui: 118 },
    lod: 'full',
    short: false,
    minStage: 960,
    minWidth: 818,
  },
  tablet: {
    id: 'tablet',
    w: 900,
    h: 503,
    cx: 450,
    cy: 261,
    globe: 44,
    Rx: 330,
    Ry: 130,
    cs: 0.62,
    label: 17.5,
    drop: 28,
    r: { data: 64, model: 56, ui: 72 },
    lod: 'lite',
    short: false,
    minStage: 680,
    minWidth: 680,
  },
  phone: {
    id: 'phone',
    w: 358,
    h: 460,
    cx: 179,
    cy: 228,
    globe: 34,
    Rx: 124,
    Ry: 124,
    cs: 0.36,
    label: 17.5,
    drop: 31.5,
    r: { data: 42, model: 38, ui: 46 },
    lod: 'lite',
    short: true,
    minStage: 274,
    minWidth: 274,
  },
};

/** The stage widths (CSS px) at which the layouts switch: phone below the first, desktop from the second. */
export const BREAKPOINTS = {
  tablet: LAYOUTS.tablet.minStage,
  desktop: LAYOUTS.desktop.minStage,
} as const;

/** The layout drawn on a stage this wide. */
export const layoutFor = (stageWidth: number): OrbitLayout =>
  stageWidth >= BREAKPOINTS.desktop
    ? LAYOUTS.desktop
    : stageWidth >= BREAKPOINTS.tablet
      ? LAYOUTS.tablet
      : LAYOUTS.phone;

/* ---------------------------------------------------------------------------------- geometry */

/**
 * The orbit angle at t = 0, degrees (90 = in front of the globe, 270 = behind it). The orbit turns
 * counterclockwise on screen (front moons drift right). The moons share one angular speed and sit
 * about 120° apart (112°, 118° and 130°), as far apart as three moons can be, so on the endless idle
 * orbit no crew ever stands on another moon (review of T4, finding 1). At the story's end (also the
 * reduced-motion frame) they sit at 156, 268 and 26 degrees: Data lower left, Modeling at the top
 * above the globe, UI lower right, each moon over its own column of text, every label clear.
 */
export const THETA0: Record<MoonKind, number> = {
  data: 204,
  model: 316,
  ui: 74,
};

/**
 * The order the moons are drawn in. Where a crew passes in front of a farther moon (only ever at
 * the moons' closest, one in front of the globe and one behind it), the nearer moon must be drawn
 * last; at this spacing that holds for every meeting in this order (transit-model.test.ts).
 */
export const MOON_ORDER: readonly MoonKind[] = ['data', 'ui', 'model'];

export const theta = (kind: MoonKind, t: number): number =>
  THETA0[kind] - (360 * t) / T.orbit;

/** Depth scale: 0.8 at the back, 1 in front. */
export const depth = (deg: number): number =>
  0.9 + 0.1 * Math.sin((deg * Math.PI) / 180);

/** A moon's centre and depth scale at time t, in the layout's units. */
export function moonCenter(
  L: OrbitLayout,
  kind: MoonKind,
  t: number,
): [number, number, number] {
  const deg = theta(kind, t);
  const a = (deg * Math.PI) / 180;
  return [L.cx + L.Rx * Math.cos(a), L.cy + L.Ry * Math.sin(a), depth(deg)];
}

/* --------------------------------------------------------------------------------- the crews */

export interface CrewMember {
  id: CastId;
  /** place on the moon's surface: degrees from the top, clockwise (within ±37°) */
  deg: number;
  face: 1 | -1;
  pose: PoseName;
  holdBlock?: 'lit';
}

export const CREW: Record<MoonKind, CrewMember[]> = {
  data: [
    { id: 'A1', deg: -13, face: 1, pose: 'stand', holdBlock: 'lit' },
    { id: 'A6', deg: 12, face: 1, pose: 'mineUp' },
  ],
  model: [{ id: 'A5', deg: -18, face: 1, pose: 'probe' }],
  ui: [
    { id: 'A4', deg: -37, face: 1, pose: 'scroll' },
    { id: 'A2', deg: -17, face: 1, pose: 'stand' },
    { id: 'A3', deg: 24, face: -1, pose: 'paint' },
  ],
};

export type PropName = 'rock' | 'cart' | 'probe' | 'easel' | 'screen';

export const PROPS: Record<MoonKind, [PropName, number][]> = {
  data: [
    ['rock', 34],
    ['cart', -37],
  ],
  model: [
    ['probe', -1],
    ['easel', 31],
  ],
  ui: [['screen', 3]],
};

/** Who rides each pod (the window shows their helmets). */
export const SHIP_CREW: Record<MoonKind, CastId[]> = {
  data: ['A1', 'A6'],
  model: ['A5'],
  ui: ['A4', 'A2', 'A3'],
};

/** The UI crew's discussion circle in its loop: who, which icon, when, which way the tail points. */
export const SAY: [CastId, BubbleIcon, number, 'l' | 'r'][] = [
  ['A4', 'dots', 4400, 'r'],
  ['A3', 'heart', 5200, 'l'],
  ['A2', 'check', 6000, 'l'],
];

/** A moon-local point from a point in an astronaut's placement space. */
export function toMoon(
  r: number,
  deg: number,
  s: number,
  face: number,
  [x, y]: [number, number],
): [number, number] {
  const lx = face * x * s;
  const ly = y * s - r + 1.5;
  const a = (deg * Math.PI) / 180;
  return [
    lx * Math.cos(a) - ly * Math.sin(a),
    lx * Math.sin(a) + ly * Math.cos(a),
  ];
}

/** A moon-local point on (or `h` above) the surface, `deg` from the top. */
export function surf(r: number, deg: number, h = 0): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [(r + h) * Math.sin(a), -(r + h) * Math.cos(a)];
}

/** The crews' leap out of the hatch (orbit.ts landing): its height off the hatch, then at the top. */
export const LEAP = { out: -70, apex: -118 } as const;

/**
 * How high a landing reaches over its moon (orbit.ts plays it): the pod slows to a hover `hover`
 * units over the moon's top before it settles, and its crew leap out at `leap` times the full
 * height (LEAP, in an astronaut's units: the crew scale applies). The Modeling moon lands at the
 * top of its orbit, just under the top edge of the desktop's and the tablet's stage (each as tall
 * as its orbit needs, LAYOUTS), so there its pod hovers low and its crew leap under half as high,
 * heads and shoulders over the pod, and neither leaves the stage (brief: "nothing clips"; review
 * of the orbit's hover, finding 1). The phone's camera closes in on each landing.
 */
export function landingReach(
  L: OrbitLayout,
  kind: MoonKind,
): { hover: number; leap: number } {
  return kind === 'model' && L.id !== 'phone'
    ? { hover: 20, leap: 0.44 }
    : { hover: 120, leap: 1 };
}

/* ------------------------------------------------------------------- what covers a label */

export { FOOTPRINT, type Box } from './orbit-footprint';

/**
 * Each moon label's width in em (Figtree 600, measured with getBBox), and its box about the
 * baseline in em: the halo stroke adds 2.5 units all round.
 */
export const LABEL_EM: Record<'long' | 'short', Record<MoonKind, number>> = {
  long: { data: 9.6, model: 11.2, ui: 7.85 },
  short: { data: 2.15, model: 4.25, ui: 1 },
};
const LABEL_TOP = -0.96;
const LABEL_BOTTOM = 0.29;
const LABEL_HALO = 2.5;

/**
 * The globe's art fills this share of its radius (the favicon's globe, clipped at 99.03 of its
 * 109.23 dark backing): labels ride over the backing's rim, never over the globe itself.
 */
const GLOBE_ART = 0.91;

/** A moon's disc at time t: centre and radius, layout units. */
export function discAt(
  L: OrbitLayout,
  kind: MoonKind,
  t: number,
): [number, number, number] {
  const [x, y, d] = moonCenter(L, kind, t);
  return [x, y, L.r[kind] * d];
}

/** A moon label's box at time t (it rides `drop` under its moon's rim at one size; renderOrbit). */
export function labelBox(L: OrbitLayout, kind: MoonKind, t: number): Box {
  const [x, y, d] = moonCenter(L, kind, t);
  const base = y + L.r[kind] * d + L.drop;
  const half = (LABEL_EM[L.short ? 'short' : 'long'][kind] * L.label) / 2;
  return [
    x - half - LABEL_HALO,
    base + LABEL_TOP * L.label - LABEL_HALO,
    x + half + LABEL_HALO,
    base + LABEL_BOTTOM * L.label + LABEL_HALO,
  ];
}

/** A moon's crew and props at time t, layout units: none until its pod touches down. */
export function partsAt(L: OrbitLayout, kind: MoonKind, t: number): Box[] {
  if (t < T.ship[kind] + TOUCHDOWN_MS) return [];
  const [x, y, d] = moonCenter(L, kind, t);
  return FOOTPRINT[L.id][kind].map(([x0, y0, x1, y1]): Box => [
    x + x0 * d,
    y + y0 * d,
    x + x1 * d,
    y + y1 * d,
  ]);
}

const grow = ([x0, y0, x1, y1]: Box, m: number): Box => [
  x0 - m,
  y0 - m,
  x1 + m,
  y1 + m,
];
const overlaps = (a: Box, b: Box) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const overlapsDisc = (box: Box, [x, y, r]: [number, number, number]) =>
  Math.hypot(
    Math.max(box[0], Math.min(x, box[2])) - x,
    Math.max(box[1], Math.min(y, box[3])) - y,
  ) < r;

/**
 * What covers a moon label at time t, if anything: the stage's edge (the desktop's front moon
 * passes so low that its label would cross the bottom edge, and the stage ends there; LAYOUTS), the
 * globe's art, or another moon, its crew or its props (labels are drawn over the globe and under
 * the moons). `margin` units of clearance.
 */
export function labelCover(
  L: OrbitLayout,
  kind: MoonKind,
  t: number,
  margin = 0,
): MoonKind | 'globe' | 'edge' | null {
  const box = grow(labelBox(L, kind, t), margin);
  if (box[0] < 0 || box[1] < 0 || box[2] > L.w || box[3] > L.h) return 'edge';
  if (overlapsDisc(box, [L.cx, L.cy, L.globe * GLOBE_ART])) return 'globe';
  for (const other of KINDS) {
    if (other === kind || t < T.moon[other]) continue;
    if (overlapsDisc(box, discAt(L, other, t))) return other;
    if (partsAt(L, other, t).some((part) => overlaps(box, part))) return other;
  }
  return null;
}

/** How long a label takes to fade out before something reaches it, and back in after. */
export const LABEL_FADE_MS = 750;
/** A label stays shown, or hidden, at least this long: no blinking. */
const LABEL_SPELL_MS = 3000;
const LABEL_STEP_MS = 250;
/** The clearance a label keeps while it shows, units. */
const LABEL_CLEARANCE = 2;

/** A label's opacity keyframes, [ms, opacity]: the story's, then one revolution of the loop's. */
export interface LabelTrack {
  /** Over [0, T.story], while the moons arrive and the crews land. */
  story: [number, number][];
  /** Over one revolution from the story's end, [0, T.orbit]; it repeats exactly, as the orbit does. */
  loop: [number, number][];
}

/** Opacity per step: 0 while covered, fading to 1 within LABEL_FADE_MS of any covered step. */
function fadeAround(covered: boolean[], circular: boolean): number[] {
  const n = covered.length;
  const fade = LABEL_FADE_MS / LABEL_STEP_MS;
  const at = (i: number) =>
    circular ? covered[((i % n) + n) % n] : i >= 0 && i < n && covered[i];
  return covered.map((_, i) => {
    for (let k = 0; k <= fade; k += 1)
      if (at(i + k) || at(i - k)) return k / fade;
    return 1;
  });
}

/**
 * No blinking: a covered spell lasts at least LABEL_SPELL_MS (a short one grows evenly either side)
 * and a clear spell shorter than that is covered too (round the clock if `circular`).
 */
function noBlinks(covered: boolean[], circular: boolean): void {
  const n = covered.length;
  const min = LABEL_SPELL_MS / LABEL_STEP_MS;
  for (let pass = 0; pass < 12; pass += 1) {
    const spells: { on: boolean; start: number; length: number }[] = [];
    for (let i = 0; i < n; i += 1)
      if (spells.length && spells[spells.length - 1].on === covered[i])
        spells[spells.length - 1].length += 1;
      else spells.push({ on: covered[i], start: i, length: 1 });
    if (circular && spells.length > 1 && spells[0].on === spells.at(-1)!.on) {
      const last = spells.pop()!;
      spells[0] = {
        on: last.on,
        start: last.start,
        length: last.length + spells[0].length,
      };
    }
    // Spells at the story's ends are cut by the clock, not short in themselves.
    const short = spells.find(
      (spell) =>
        spells.length > 1 &&
        spell.length < min &&
        (circular || (spell.start > 0 && spell.start + spell.length < n)),
    );
    if (!short) return;
    const pad = short.on ? Math.ceil((min - short.length) / 2) : 0;
    for (let k = -pad; k < short.length + pad; k += 1) {
      const i = short.start + k;
      if (circular) covered[((i % n) + n) % n] = true;
      else if (i >= 0 && i < n) covered[i] = true;
    }
  }
}

/** The corners of a piecewise-linear curve sampled every LABEL_STEP_MS, ending at `length`. */
function corners(opacity: number[], length: number): [number, number][] {
  const frames: [number, number][] = [[0, opacity[0]]];
  for (let i = 1; i < opacity.length - 1; i += 1)
    if (
      Math.abs(opacity[i] - opacity[i - 1] - (opacity[i + 1] - opacity[i])) >
      1e-9
    )
      frames.push([i * LABEL_STEP_MS, opacity[i]]);
  frames.push([length, opacity[opacity.length - 1]]);
  return frames;
}

/**
 * A moon label's opacity on the scene clock (orbit.ts plays it as a story track and a loop track).
 * The label hides while anything covers it (labelCover, with LABEL_CLEARANCE units to spare),
 * fading out over LABEL_FADE_MS just before and back in just after, and no spell, shown or hidden,
 * is shorter than three seconds. In the story, a crew counts from its touchdown.
 */
export function labelTrack(L: OrbitLayout, kind: MoonKind): LabelTrack {
  const covers = (t: number) =>
    labelCover(L, kind, t, LABEL_CLEARANCE) !== null;
  const loop = Array.from({ length: T.orbit / LABEL_STEP_MS }, (_, i) =>
    covers(T.story + i * LABEL_STEP_MS),
  );
  noBlinks(loop, true);
  const looped = fadeAround(loop, true);
  // The story runs on into the loop's first steps, so its fades meet the loop's at the seam.
  const reach = LABEL_SPELL_MS / LABEL_STEP_MS;
  const story = Array.from(
    { length: T.story / LABEL_STEP_MS + 1 + reach },
    (_, i) =>
      i * LABEL_STEP_MS < T.story
        ? covers(i * LABEL_STEP_MS)
        : loop[i - T.story / LABEL_STEP_MS],
  );
  noBlinks(story, false);
  const told = fadeAround(story, false).slice(0, T.story / LABEL_STEP_MS + 1);
  return {
    story: corners(told, T.story),
    loop: corners([...looped, looped[0]], T.orbit),
  };
}

/** A label's opacity at time t on the scene clock. */
export function labelOpacity(track: LabelTrack, t: number): number {
  const [frames, at] =
    t <= T.story ? [track.story, t] : [track.loop, (t - T.story) % T.orbit];
  for (let i = 1; i < frames.length; i += 1) {
    const [t1, b] = frames[i];
    if (at > t1) continue;
    const [t0, a] = frames[i - 1];
    return t1 === t0 ? b : a + ((b - a) * (at - t0)) / (t1 - t0);
  }
  return frames[frames.length - 1][1];
}

/** A track that never changes is no track: orbit.ts skips it. */
export const isConstant = (frames: [number, number][]): boolean =>
  frames.every(([, value]) => value === frames[0][1]);

/* -------------------------------------------------------------------------------- the copy */

/**
 * A group's open issues on GitHub, as a search link. Comma-separated labels are "any of" in GitHub's
 * search, so a group's work is every open issue of its type or its skill (owner, 2026-10-15: a moon
 * opens "the Issues page on GH with working-group-specific filters applied"). The moon and its
 * column's "Browse matching issues" share this one URL.
 */
export function issuesLink(labels: readonly string[]): string {
  const query = `is:issue is:open label:${labels.map((label) => `"${label}"`).join(',')}`;
  return `https://github.com/genomeOS/genomeOS/issues?q=${encodeURIComponent(query).replace(/%20/g, '+')}`;
}

export interface Group {
  kind: MoonKind;
  /** the column's id: /working-groups/#data, #modeling, #ui land here */
  id: 'group-data' | 'group-modeling' | 'group-ui';
  title: string;
  /** the moon's label (desktop and tablet) */
  moon: string;
  /** the moon's label on phones */
  short: string;
  /** typed first: what the group does */
  what: string;
  /** typed second: who might join (examples, not requirements) */
  who: string;
  /** the group's open issues on GitHub (issuesLink): its column's link and its moon go there */
  issues: string;
}

/** The copy (round 2 spec §4.3.2), exact. "For example:" is the bold lead-in of each `who`. */
export const GROUPS: Group[] = [
  {
    kind: 'data',
    id: 'group-data',
    title: 'Data & Infrastructure',
    moon: 'Data & Infrastructure',
    short: 'Data',
    what: 'Find allele counts in papers, supplements and non-English literature. Place every population with a stated uncertainty, then store and serve every version.',
    who: 'For example: literature sleuths, data engineers, multilingual readers.',
    issues: issuesLink(['type:data', 'type:infra', 'skill:data-engineering']),
  },
  {
    kind: 'model',
    id: 'group-modeling',
    title: 'Statistical & AI Modeling',
    moon: 'Statistical & AI Modeling',
    short: 'Modeling',
    what: 'The world has not been sampled evenly. Brian leads Bayesian spatial models; geometric deep learning welcome. Frequencies become disease-burden and risk estimates.',
    who: 'For example: statisticians, machine-learning engineers, epidemiologists.',
    issues: issuesLink(['type:science', 'skill:spatial-stats']),
  },
  {
    kind: 'ui',
    id: 'group-ui',
    title: 'UI & Applications',
    moon: 'UI & Applications',
    short: 'UI',
    what: 'Make estimates and unknowns legible to anyone. Future exploration: an agentic AI guide and people’s own genomes, gated by privacy, consent and governance.',
    who: 'For example: designers, front-end developers, map makers.',
    issues: issuesLink(['type:ui', 'skill:frontend']),
  },
];

/** The bold lead-in of each examples line. */
export const LEAD = 'For example:';

/** Characters per chunk of a typing twin (typedTwin; contribute.css counts to it). */
export const TYPE_CHUNK = 12;

/**
 * A typed sentence's twin, cheap to type (review of T4, finding 4): the kit's twin (typing.ts
 * splitTyped: `aria-hidden`, one span per character with its index as `--i`), its characters
 * grouped in chunks of TYPE_CHUNK, each chunk carrying its first index as `--a`. contribute.css
 * works out from the twin's typed count (`--n`, the kit's track) how far into its own chunk the
 * typing is, and hides what is not typed yet with `visibility`, chunk by chunk: per frame only one
 * chunk's characters change, and no character switches a compositing layer, which per-character
 * opacity did on every one (a third of all frames dropped at 4× CPU). Without container style
 * queries the kit's per-character opacity applies instead.
 */
export function typedTwin(text: string, lead = 0): string {
  const spans =
    splitTyped(text, { lead }).twin.match(
      /<span style="--i:\d+"(?: class="b")?>[^<]*<\/span>/g,
    ) ?? [];
  const chunks: string[] = [];
  for (let a = 0; a < spans.length; a += TYPE_CHUNK)
    chunks.push(
      `<span class="tc" style="--a:${a}">${spans.slice(a, a + TYPE_CHUNK).join('')}</span>`,
    );
  return `<span class="typed" aria-hidden="true">${chunks.join('')}</span>`;
}

/** The scene in one sentence, actions only (spec §8.5): the stage's accessible name. */
export const SUMMARY =
  'Three moons orbit the genomeOS globe, one per working group; crews land and get to work: mining data, measuring soil and charting, building and painting a screen.';

/* ---------------------------------------------------------------------------------- render */

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function propMarkup(name: PropName): string {
  return { rock: ore, cart, probe, easel, screen }[name]();
}

export interface RenderOptions {
  /** The favicon globe (already cached by the header's Atlas pill). */
  globeHref: string;
}

/** The id of a layout's moons group (the phone's reduced-motion close-ups `<use>` it). */
export const moonsId = (L: OrbitLayout): string => `orbit-${L.id}-moons`;

/**
 * The story's last frame as one SVG. The page holds the kit's gradients and visor clips once
 * (`<KitDefs moons sprite />`), so the three layouts reference one set of definitions.
 */
export function renderOrbit(L: OrbitLayout, opt: RenderOptions): string {
  const rnd = mulberry32(SEED);
  const stars = Array.from(
    { length: Math.round((L.w * L.h) / 11000) },
    (_, i) => {
      const x = f(rnd() * L.w);
      const y = f(rnd() * L.h);
      const r = f(0.5 + rnd() * 1.1);
      return `<circle${i % 9 === 0 ? ' class="twinkle"' : ''} cx="${x}" cy="${y}" r="${r}" fill="#cfe3ff" opacity="${f(0.25 + rnd() * 0.45)}"/>`;
    },
  ).join('');
  const k = L.Ry / L.Rx;
  const ell = (half: 'back' | 'front') =>
    `<path class="orbit-arc orbit-arc--${half}" d="M${L.cx - L.Rx} ${L.cy} A${L.Rx} ${L.Ry} 0 0 ${half === 'back' ? 1 : 0} ${L.cx + L.Rx} ${L.cy}" fill="none" stroke="#70e6ff" stroke-opacity=".32" stroke-width="1.4" stroke-dasharray="1.2 8" stroke-linecap="round"/>`;
  // Orbit carriers: a rotation and its counter-rotation inside a squash give exact elliptical
  // motion while the moon itself stays upright and unscaled (two linear ambient tracks per moon).
  const carrier = (kind: MoonKind, inner: string, cls: string) => {
    const th = theta(kind, T.story);
    return (
      `<g class="${cls}" data-moon="${kind}" transform="translate(${L.cx} ${L.cy}) scale(1 ${f(k)})">` +
      `<g class="j orb-rot" style="transform:rotate(${f(th)}deg)"><g transform="translate(${L.Rx} 0)">` +
      `<g class="j orb-counter" style="transform:rotate(${f(-th)}deg)"><g transform="scale(1 ${f(1 / k)})">` +
      `<g class="j orb-depth" style="transform:scale(${f(depth(th))})">${inner}</g></g></g></g></g></g>`
    );
  };
  const groups = Object.fromEntries(GROUPS.map((g) => [g.kind, g]));
  // A label's counter-scale undoes its moon's depth scale as written (two decimals), to four, so
  // the label is its own size, not 0.4% under it: at the desktop's narrowest drawing that is the
  // difference between 13 px and 12.99.
  const counter = (kind: MoonKind) =>
    +(1 / f(depth(theta(kind, T.story)))).toFixed(4);
  // Labels sit in a layer over the globe and under the moons; each fades out before anything would
  // cover it, and back in once clear (labelTrack; orbit.ts plays it on `.orb-label-vis`). Each
  // label rides under its moon's rim (depth-scaled) but counters the depth scale itself, so it keeps
  // one size, 13 px or more, and one gap under the rim, `drop`, all the way round (orbit.ts runs
  // the matching ambient track).
  const labels =
    `<g class="j orb-labels">` +
    KINDS.map((kind) => {
      const text = escapeText(L.short ? groups[kind].short : groups[kind].moon);
      // moonLabel() sets its baseline r + size + 14 below the centre; here the group does, so
      // the text sits at its own origin and scales about its baseline.
      const label = moonLabel(text, -(L.label + 14), L.label);
      // When it hides on the clock (labelTrack), computed here so the client only plays it.
      const track = labelTrack(L, kind);
      const keys = {
        ...(isConstant(track.story) ? {} : { story: track.story }),
        ...(isConstant(track.loop) ? {} : { loop: track.loop }),
      };
      const data = Object.keys(keys).length
        ? ` data-track='${JSON.stringify(keys)}'`
        : '';
      return carrier(
        kind,
        `<g class="orb-label"><g class="orb-label-vis"${data} transform="translate(0 ${L.r[kind]})"><g class="j orb-label-k" style="transform:scale(${counter(kind)})"><g transform="translate(0 ${L.drop})">${label}</g></g></g></g>`,
        'orbiter orbiter--label',
      );
    }).join('') +
    `</g>`;
  const moons = MOON_ORDER.map((kind) => {
    const r = L.r[kind];
    const props = PROPS[kind]
      .map(([name, deg]) =>
        onMoon(
          r,
          deg,
          `<g class="setup setup-${name}" style="transform-box:fill-box;transform-origin:50% 100%">${propMarkup(name)}</g>`,
          L.cs,
          `prop-${name}`,
        ),
      )
      .join('');
    const crew = CREW[kind]
      .map((c) =>
        onMoon(
          r,
          c.deg,
          astronaut(c.id, c.pose, {
            lod: L.lod,
            face: c.face,
            holdBlock: c.holdBlock,
          }),
          L.cs,
          `crew crew-${c.id}`,
        ),
      )
      .join('');
    // The UI crew's icon bubbles, anchored to each speaker's helmet top (hidden at rest).
    const bubbles =
      kind === 'ui'
        ? SAY.map(([id, icon, , tail], i) => {
            const c = CREW.ui.find((member) => member.id === id)!;
            const a = anchors(id, resolveKey(id, 'chat'));
            const [x, y] = toMoon(r, c.deg, L.cs, c.face, a.headTop);
            return bubble(x, y, icon, {
              tail,
              cls: `say say-${i}`,
              lift: 2,
              hidden: true,
            });
          }).join('')
        : '';
    const extra =
      (kind === 'data'
        ? `<g class="fly-block" opacity="0">${PROP.block(18, true)}</g>`
        : '') +
      `<g class="bubbles">${bubbles}</g>` +
      `<g class="ship-g" opacity="0"><g class="j ship-path"><g class="j ship-body" style="transform-box:fill-box;transform-origin:50% 100%"><g transform="scale(${f(L.cs * 0.95)})">${spaceship(SHIP_CREW[kind], { id: `orbit-${L.id}-ship-${kind}` })}</g></g></g></g>` +
      `<g class="dust-g" transform="translate(0 ${-r + 2})" opacity="0">${dust(70 * L.cs)}</g>`;
    // The ring a pointer lights round the moon (contribute.css, the moon's hover), under its crew.
    const ring = `<circle class="moon-ring" r="${f(r + 9)}" opacity="0" fill="none" stroke="#70e6ff" stroke-width="1.6" stroke-dasharray="1.2 7" stroke-linecap="round"/>`;
    return carrier(
      kind,
      `<g class="j moon-pop"><g class="ring-flash" opacity="0"><circle r="${r}" fill="none" stroke="#70e6ff" stroke-width="2"/></g>${moon(r, kind)}${ring}${props}${crew}${extra}</g>`,
      'orbiter orbiter--moon',
    );
  }).join('');
  const halo = `<g class="globe-halo"><circle r="${f(L.globe * 1.24)}" fill="none" stroke="#70e6ff" stroke-opacity=".16"/><circle r="${f(L.globe * 1.5)}" fill="none" stroke="#70e6ff" stroke-opacity=".07"/></g>`;
  const globe =
    `<g class="globe" transform="translate(${L.cx} ${L.cy})"><circle r="${f(L.globe * 1.9)}" fill="url(#kMoonGlow)"/>${halo}` +
    `<g class="j globe-in"><image href="${opt.globeHref}" x="${-L.globe}" y="${-L.globe}" width="${L.globe * 2}" height="${L.globe * 2}"/></g></g>`;
  return (
    `<svg class="orbit-svg orbit-svg--${L.id}" data-layout="${L.id}" viewBox="0 0 ${L.w} ${L.h}" aria-hidden="true" focusable="false">` +
    `<g class="j cam">` +
    `<g class="sky">${stars}</g>` +
    `<g class="arcs">${ell('back')}</g>` +
    globe +
    labels +
    `<g class="arcs">${ell('front')}</g>` +
    `<g id="${moonsId(L)}">${moons}</g>` +
    `</g></svg>`
  );
}

/**
 * Phones under reduced motion (or without JavaScript): a close-up of each moon above its group's
 * text, the story's last frame seen through a viewBox on the phone scene (`<use>`, no copies).
 */
export function closeUpViewBox(kind: MoonKind): string {
  const L = LAYOUTS.phone;
  const [mx, my, d] = moonCenter(L, kind, T.story);
  const r = L.r[kind] * d;
  const w = 170;
  const h = (w * 210) / 358;
  return `${f(mx - w / 2)} ${f(my - r - h * 0.62)} ${w} ${f(h)}`;
}
