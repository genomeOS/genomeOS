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
 * layout's `label` size holds 13 px at its narrowest (`minStage`).
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

export { SEED };

const f = (n: number) => +(+n).toFixed(2);

/* ------------------------------------------------------------------------------------ timing */

/** The timetable, ms (characters.md §2.3). */
export const T = {
  story: 32000,
  loop: 8000,
  /** One revolution = 30 idle loops, so the orbit and the loops never drift apart. */
  orbit: 240000,
  globe: [0, 800],
  arcs: [200, 1400],
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
  r: Record<MoonKind, number>;
  lod: 'full' | 'lite';
  /** short moon labels ("Data", "Modeling", "UI") */
  short: boolean;
  /** the narrowest stage this layout is drawn at, CSS px (OrbitScene's container query) */
  minStage: number;
}

/**
 * Desktop from a 960 px stage (18-unit labels at 13 px or more); tablets from 680 px (round 2 spec
 * §4.3.2: the layout the prototype left unbuilt); phones below, at 274 px and up (the 320 px
 * viewport). Labels are larger than the prototype's where the site's wider page gutters make the
 * stage narrower than the prototype measured.
 */
export const LAYOUTS: Record<LayoutId, OrbitLayout> = {
  desktop: {
    id: 'desktop',
    w: 1320,
    h: 680,
    cx: 660,
    cy: 340,
    globe: 64,
    Rx: 460,
    Ry: 172,
    cs: 0.9,
    label: 18,
    r: { data: 104, model: 90, ui: 118 },
    lod: 'full',
    short: false,
    minStage: 960,
  },
  tablet: {
    id: 'tablet',
    w: 900,
    h: 560,
    cx: 450,
    cy: 280,
    globe: 44,
    Rx: 330,
    Ry: 130,
    cs: 0.62,
    label: 17.5,
    r: { data: 64, model: 56, ui: 72 },
    lod: 'lite',
    short: false,
    minStage: 680,
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
    r: { data: 42, model: 38, ui: 46 },
    lod: 'lite',
    short: true,
    minStage: 274,
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
 * counterclockwise on screen (front moons drift right). The moons share one angular speed, so
 * their spacing is free: at the story's end (also the reduced-motion frame) they sit at 170, 250
 * and 25 degrees, left to right in column order, every crew and label clear of the globe.
 */
export const THETA0: Record<MoonKind, number> = {
  data: 218,
  model: 298,
  ui: 73,
};

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

/* -------------------------------------------------------------------------------- the copy */

const ISSUES =
  'https://github.com/genomeOS/genomeOS/issues?q=is%3Aissue+is%3Aopen+label%3A%22skill%3A';

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
  issues: string;
}

/** The copy (round 2 spec §4.3.2), exact. "For example:" is the bold lead-in of each `who`. */
export const GROUPS: Group[] = [
  {
    kind: 'data',
    id: 'group-data',
    title: 'Data Gathering & Infrastructure',
    moon: 'Data & Infrastructure',
    short: 'Data',
    what: 'Find allele counts in papers, supplements and non-English literature. Place every population with a stated uncertainty, then store and serve every version.',
    who: 'For example: literature sleuths, data engineers, multilingual readers.',
    issues: `${ISSUES}data-engineering%22`,
  },
  {
    kind: 'model',
    id: 'group-modeling',
    title: 'Statistical & AI Modeling',
    moon: 'Statistical & AI Modeling',
    short: 'Modeling',
    what: 'The world has not been sampled evenly. Brian leads Bayesian spatial models; geometric deep learning welcome. Frequencies become disease-burden and risk estimates.',
    who: 'For example: statisticians, machine-learning engineers, epidemiologists.',
    issues: `${ISSUES}spatial-stats%22`,
  },
  {
    kind: 'ui',
    id: 'group-ui',
    title: 'UI & Applications',
    moon: 'UI & Applications',
    short: 'UI',
    what: 'Make estimates and unknowns legible to anyone. Future exploration: an agentic AI guide and people’s own genomes, gated by privacy, consent and governance.',
    who: 'For example: designers, front-end developers, map makers.',
    issues: `${ISSUES}frontend%22`,
  },
];

/** The bold lead-in of each examples line. */
export const LEAD = 'For example:';

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
  // Labels sit in a layer under the globe, so a moon passing behind it hides its own label. Each
  // label rides under its moon's edge (depth-scaled) but counters the depth scale itself, so it
  // keeps one size, 13 px or more, all the way round (orbit.ts runs the matching ambient track).
  const labels =
    `<g class="j orb-labels">` +
    KINDS.map((kind) => {
      const text = escapeText(L.short ? groups[kind].short : groups[kind].moon);
      // moonLabel() sets its baseline r + size + 14 below the centre; here the group does, so
      // the text sits at its own origin and scales about its baseline.
      const label = moonLabel(text, -(L.label + 14), L.label);
      return carrier(
        kind,
        `<g class="orb-label"><g transform="translate(0 ${f(L.r[kind] + L.label + 14)})"><g class="j orb-label-k" style="transform:scale(${f(1 / depth(theta(kind, T.story)))})">${label}</g></g></g>`,
        'orbiter orbiter--label',
      );
    }).join('') +
    `</g>`;
  const moons = KINDS.map((kind) => {
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
    return carrier(
      kind,
      `<g class="j moon-pop"><g class="ring-flash" opacity="0"><circle r="${r}" fill="none" stroke="#70e6ff" stroke-width="2"/></g>${moon(r, kind)}${props}${crew}${extra}</g>`,
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
    labels +
    globe +
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
