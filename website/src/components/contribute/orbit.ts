/**
 * The orbit scene's motion (round 2 spec §4.3.2, §2.3 rules 8–9, §3.2; characters.md §2.3, §4;
 * owner brief; R2-7; #454), ported from the design prototype's beat script
 * (`r2/characters/kit/orbit-scene.js`, `orbit.html`) onto the kit's scene timeline. Client code,
 * its own lazily loaded chunk (spec §7: ≤ 40 KB gzip), imported by the page once the figure is
 * within a viewport of the screen; never under reduced motion.
 *
 * Story (32 s, then 8 s loops on the same clock): the globe and the dotted orbit; the Data moon
 * pops and column 1 types; the Modeling moon and column 2; the UI moon and column 3; three pods
 * land (2, 1 and 3 astronauts), the crews leap out in low gravity, set up shop and start work;
 * then each moon's 8 s work loop: mining ore and carting a data block; probing soil and reading a
 * chart whose interval narrows as data arrive; fitting a tile, painting, and a discussion circle.
 * Phones add a camera that closes in on each landing and tours the moons in the loops.
 *
 * The server markup is the story's last frame (orbit-layouts.ts `renderOrbit`); the timeline
 * seeks to 0 once built, which the page's head script has already painted (contribute.css, the
 * armed state). `sceneController` (src/graphics/timeline.ts) owns the rest: the start at 35%
 * visible, pausing off screen and in a hidden tab, the sticky Pause, Replay, print, and the motion
 * hooks (`orbit`). Columns dim by colour, never by opacity, so their text holds 4.5:1 at every
 * instant (rulings item 25).
 */
import { anchors } from '../../graphics/astro/rig';
import {
  blinks,
  hopKeys,
  poseTracks,
  resolveKey,
  type PoseKey,
  type PoseKeySpec,
} from '../../graphics/astro/tracks';
import type { CastId } from '../../graphics/astro/cast';
import type { MoonKind } from '../../graphics/astro/props';
import {
  EASE,
  sceneController,
  type Frame,
  type Phase,
  type SceneController,
  type Timeline,
} from '../../graphics/timeline';
import { typeFrames } from '../../graphics/typing';
import {
  CREW,
  KINDS,
  LAYOUTS,
  SAY,
  T,
  TOUCHDOWN_MS,
  depth,
  moonCenter,
  surf,
  theta,
  toMoon,
  type LabelTrack,
  type LayoutId,
  type OrbitLayout,
} from './orbit-layouts';

const f = (n: number) => +(+n).toFixed(2);

/** Per-build state: each astronaut's story keys and surface travel, gathered across the beats. */
interface Beats {
  story: Map<CastId, PoseKey[]>;
  travel: Map<CastId, [number, number][]>;
}

/* ------------------------------------------------------------------------------- the scene */

function animate(svg: SVGSVGElement, tl: Timeline, L: OrbitLayout): void {
  const S = (selector: string) => svg.querySelector(selector);
  const beats: Beats = { story: new Map(), travel: new Map() };

  // The orbit: ambient, from 0 forever, one revolution in 30 loops.
  svg.querySelectorAll<SVGGElement>('.orbiter').forEach((g) => {
    const kind = g.dataset.moon as MoonKind;
    const t0 = theta(kind, 0);
    tl.ambient(
      g.querySelector('.orb-rot'),
      [
        [0, `rotate(${t0}deg)`],
        [T.orbit, `rotate(${t0 - 360}deg)`],
      ],
      T.orbit,
    );
    tl.ambient(
      g.querySelector('.orb-counter'),
      [
        [0, `rotate(${-t0}deg)`],
        [T.orbit, `rotate(${-t0 + 360}deg)`],
      ],
      T.orbit,
    );
    const frames: Frame[] = [];
    const counter: Frame[] = [];
    for (let i = 0; i <= 30; i++) {
      const t = (T.orbit * i) / 30;
      const d = depth(theta(kind, t));
      frames.push([t, `scale(${f(d)})`]);
      counter.push([t, `scale(${f(1 / d)})`]);
    }
    tl.ambient(g.querySelector('.orb-depth'), frames, T.orbit);
    // A label keeps one size at every depth (orbit-layouts.ts renderOrbit).
    tl.ambient(g.querySelector('.orb-label-k'), counter, T.orbit);
  });

  // Each label hides while the globe, another moon or its crew would cover it, and fades back
  // once clear (orbit-layouts.ts labelTrack; the server wrote the keys, the client plays them).
  svg
    .querySelectorAll<SVGGElement>('.orb-label-vis[data-track]')
    .forEach((el) => {
      const track = JSON.parse(el.dataset.track!) as Partial<LabelTrack>;
      const keys = (frames: [number, number][]) =>
        frames.map(([t, opacity]): Frame => [t, { opacity }]);
      if (track.story) tl.story(el, keys(track.story));
      if (track.loop) tl.loop(el, keys(track.loop), T.orbit);
    });

  // The globe, its halo and the dotted orbit.
  tl.story(S('.globe-in'), [
    [0, 'scale(.86)', EASE.out],
    [T.globe[1], 'scale(1)'],
  ]);
  tl.story(S('.globe'), [
    [0, { opacity: 0 }, EASE.out],
    [T.globe[1], { opacity: 1 }],
  ]);
  tl.story(S('.globe-halo'), [
    [0, { opacity: 0 }],
    [300, { opacity: 0 }, EASE.out],
    [1100, { opacity: 1 }],
  ]);
  tl.loop(S('.globe-halo'), [
    [0, { transform: 'scale(1)', opacity: 1 }, EASE.sine],
    [4000, { transform: 'scale(1.035)', opacity: 0.6 }, EASE.sine],
    [8000, { transform: 'scale(1)', opacity: 1 }],
  ]);
  svg.querySelectorAll('.arcs').forEach((arc) =>
    tl.story(arc, [
      [T.arcs[0], { opacity: 0 }, EASE.out],
      [T.arcs[1], { opacity: 1 }],
    ]),
  );
  svg.querySelectorAll('.twinkle').forEach((star, i) => {
    const o = Number(star.getAttribute('opacity'));
    const at = (i * 1370) % 8000;
    tl.loop(star, [
      [0, { opacity: o }],
      [at, { opacity: o }, EASE.sine],
      [Math.min(7999, at + 500), { opacity: 0.08 }, EASE.sine],
      [Math.min(8000, at + 1000), { opacity: o }],
    ]);
  });

  for (const kind of KINDS) {
    const m = svg.querySelector<SVGGElement>(
      `.orbiter--moon[data-moon="${kind}"]`,
    )!;
    const label = svg.querySelector(
      `.orbiter--label[data-moon="${kind}"] .orb-label`,
    );
    const r = L.r[kind];
    const t0 = T.moon[kind];
    // The moon arrives: a pop with overshoot, a ring flash, its label, its icon wakes.
    tl.story(m.querySelector('.moon-pop'), [
      [t0, 'scale(0)', EASE.back],
      [t0 + 700, 'scale(1)'],
    ]);
    tl.story(m.querySelector('.ring-flash'), [
      [t0 + 300, { transform: 'scale(1)', opacity: 0 }],
      [t0 + 320, { transform: 'scale(1)', opacity: 0.8 }, EASE.out],
      [t0 + 1300, { transform: 'scale(1.5)', opacity: 0 }],
    ]);
    tl.story(label, [
      [t0 + 400, { opacity: 0 }, EASE.out],
      [t0 + 900, { opacity: 1 }],
    ]);
    iconMotion(tl, m, kind, t0 + 600);
    landing(tl, m, kind, r, L, beats);
    activity(tl, m, kind, r, L, beats);
  }
}

/** The engraved icon's moving parts (spec §2.7 rule 1: structure, then marks, then the band). */
function iconMotion(
  tl: Timeline,
  m: Element,
  kind: MoonKind,
  t0: number,
): void {
  const q = (selector: string) => m.querySelector(`.moon-icon ${selector}`);
  if (kind === 'data') {
    ['.disc-2', '.disc-1'].forEach((selector, i) => {
      const el = q(selector);
      tl.story(el, [
        [t0 + i * 250, { opacity: 0.2 }, EASE.out],
        [t0 + 300 + i * 250, { opacity: 1 }],
      ]);
      tl.loop(el, [
        [0, { opacity: 1 }],
        [5200 + i * 260, { opacity: 1 }, EASE.out],
        [5400 + i * 260, { opacity: 0.25 }, EASE.out],
        [6000 + i * 260, { opacity: 1 }],
      ]);
    });
  } else if (kind === 'model') {
    tl.story(q('.curve'), [
      [t0, { strokeDasharray: '80 80', strokeDashoffset: 80 }, EASE.out],
      [t0 + 900, { strokeDasharray: '80 80', strokeDashoffset: 0 }],
    ]);
    tl.story(q('.band'), [
      [t0 + 600, { opacity: 0 }, EASE.out],
      [t0 + 1200, { opacity: 1 }],
    ]);
    tl.story(q('.hexes'), [
      [t0 + 900, { opacity: 0 }, EASE.out],
      [t0 + 1400, { opacity: 1 }],
    ]);
  } else {
    tl.story(q('.cursor'), [
      [t0, 'translate(10px, 8px)', EASE.inOut],
      [t0 + 700, 'translate(0px, 0px)'],
      [t0 + 820, 'translate(0px, 0px) scale(.85)'],
      [t0 + 940, 'translate(0px, 0px) scale(1)'],
    ]);
    tl.story(q('.pin'), [
      [t0 + 820, { opacity: 0 }],
      [t0 + 900, { opacity: 1 }],
    ]);
    tl.loop(q('.cursor'), [
      [0, 'translate(0px, 0px)'],
      [3000, 'translate(0px, 0px)', EASE.inOut],
      [3700, 'translate(-9px, 3px)'],
      [3820, 'translate(-9px, 3px) scale(.85)'],
      [3940, 'translate(-9px, 3px)', EASE.inOut],
      [4800, 'translate(0px, 0px)'],
    ]);
  }
}

/* --------------------------------------------------------------------------------- landing */

function landing(
  tl: Timeline,
  m: Element,
  kind: MoonKind,
  r: number,
  L: OrbitLayout,
  beats: Beats,
): void {
  const ta = T.ship[kind];
  const td = ta + TOUCHDOWN_MS;
  const cs = L.cs;
  const top = -r + 1;
  // The pod comes in from the moon's outer side, never across the globe, swings upright,
  // settles, then leaves.
  const [mx] = moonCenter(L, kind, td);
  const side =
    Math.abs(mx - L.cx) < L.Rx * 0.35
      ? 0.4 * Math.sign(mx - L.cx || 1)
      : Math.sign(mx - L.cx);
  const from = [side * 300, -360];
  const mid = [from[0] * 0.25, top - 120];
  const tiltIn = from[0] < 0 ? 34 : -34;
  tl.story(m.querySelector('.ship-g'), [
    [ta, { opacity: 0 }],
    [ta + 1, { opacity: 1 }],
    [td + 1900, { opacity: 1 }, EASE.inOut],
    [td + 2500, { opacity: 0 }],
  ]);
  tl.story(m.querySelector('.ship-path'), [
    [
      ta,
      `translate(${from[0] * cs * 1.6}px, ${from[1] * cs * 1.6}px) rotate(${tiltIn}deg)`,
      EASE.out,
    ],
    [
      ta + 1300,
      `translate(${mid[0] * cs * 2}px, ${mid[1]}px) rotate(${tiltIn / 4}deg)`,
      EASE.inOut,
    ],
    [td, `translate(0px, ${top}px) rotate(0deg)`],
    [td + 1300, `translate(0px, ${top}px) rotate(0deg)`, EASE.down],
    [
      td + 2500,
      `translate(${(from[0] < 0 ? 220 : -220) * cs}px, ${top - 360 * cs}px) rotate(${-tiltIn / 2}deg)`,
    ],
  ]);
  tl.story(m.querySelector('.ship-body'), [
    [td - 60, 'scale(1, 1)'],
    [td + 80, 'scale(1.1, .86)', EASE.back],
    [td + 420, 'scale(1, 1)'],
    [td + 1300, 'scale(1, 1)'],
    [td + 1400, 'scale(.96, 1.06)'],
    [td + 1600, 'scale(1, 1)'],
  ]);
  tl.story(m.querySelector('.ship-flame'), [
    [ta, 'scale(1)'],
    [td - 300, 'scale(1)', EASE.out],
    [td, 'scale(0)'],
    [td + 1250, 'scale(0)', EASE.out],
    [td + 1450, 'scale(1.1)'],
    [td + 2500, 'scale(.9)'],
  ]);
  tl.story(m.querySelector('.dust-g'), [
    [
      td - 40,
      { opacity: 0, transform: `translate(0px, ${-r + 2}px) scale(.4)` },
    ],
    [
      td + 40,
      { opacity: 0.9, transform: `translate(0px, ${-r + 2}px) scale(.8)` },
      EASE.out,
    ],
    [
      td + 900,
      { opacity: 0, transform: `translate(0px, ${-r + 2}px) scale(1.5)` },
    ],
  ]);
  // The crew pop out of the hatch: the window helmets duck as the full figures leap clear, in a
  // low-gravity arc to their work spots, landing with a squash.
  const crew = CREW[kind];
  crew.forEach((c, i) => {
    const te = td + 420 + i * 260;
    tl.story(m.querySelector(`.ship-crew-${i}`), [
      [te - 80, { opacity: 1 }],
      [te, { opacity: 0 }],
    ]);
    const astro = m.querySelector(`.crew-${c.id} .astro`);
    const startDeg = (i - (crew.length - 1) / 2) * 6;
    tl.story(astro, [
      [te, { opacity: 0, transform: 'scale(.6)' }],
      [te + 1, { opacity: 1, transform: 'scale(.6)' }, EASE.out],
      [te + 260, { opacity: 1, transform: 'scale(1)' }],
    ]);
    beats.travel.set(c.id, [
      [0, startDeg],
      [te, startDeg],
      [te + 220, startDeg],
      [te + 1220, c.deg],
    ]);
    const face = c.deg >= startDeg ? 1 : -1;
    addStory(beats, c.id, [
      [te, { pose: 'hop', y: -70, face }, EASE.up],
      [te + 640, { pose: 'hop', y: -118, face }, EASE.down],
      [te + 1220, { pose: 'hop', y: 0, sq: 0 }, EASE.out],
      [te + 1320, { pose: 'crouch', y: 3, sq: -0.07 }, EASE.back],
      [te + 1560, { pose: 'stand' }],
    ]);
  });
}

function addStory(beats: Beats, id: CastId, keys: PoseKey[]): void {
  beats.story.set(id, [...(beats.story.get(id) ?? []), ...keys]);
}

const shift = (keys: PoseKey[], dt: number): PoseKey[] =>
  keys.map(([t, k, e]) => [t + dt, k, e]);

function walkKeys(
  t0: number,
  t1: number,
  extra: PoseKeySpec = {},
  step = 260,
): PoseKey[] {
  const keys: PoseKey[] = [];
  const seq = ['walkA', 'walkMid', 'walkB', 'walkMid'] as const;
  let i = 0;
  for (let t = t0; t < t1 - 1; t += step / 2)
    keys.push([t, { pose: seq[i++ % 4], ...extra }, EASE.sine]);
  return keys;
}

/* ------------------------------------------------------------------------------ activities */

/**
 * Each moon's 8 s loop, authored once. A moon whose crew is ready early (Data) plays one full
 * iteration inside the story, so the story's last frame is exactly the loop's first.
 */
function activity(
  tl: Timeline,
  m: Element,
  kind: MoonKind,
  r: number,
  L: OrbitLayout,
  beats: Beats,
): void {
  const cs = L.cs;
  const tw = T.work[kind];
  const loops: Partial<Record<CastId, PoseKey[]>> = {};
  const travel: Partial<Record<CastId, [number, number][]>> = {};
  const extras: [Phase, Element | null, Frame[]][] = [];

  if (kind === 'data') {
    // A6 mines the rock; a lit data block pops out and arcs to A1, who carts it.
    const strikes = [450, 1500, 4450, 5500, 6550];
    const mk: PoseKey[] = [[0, { pose: 'mineUp', face: 1 }, EASE.snap]];
    strikes.forEach((s, i) => {
      mk.push(
        [s, 'mineHit', EASE.out],
        [s + 120, { pose: 'mineHit', lean: 18 }, EASE.out],
      );
      if (i !== 1 && i !== 4) mk.push([s + 520, 'mineUp', EASE.snap]);
    });
    mk.push(
      [1950, { pose: 'stand', head: -6, face: 1 }, EASE.inOut],
      [2050, { pose: 'stand', face: -1 }, EASE.inOut],
      [2400, { pose: 'point', head: -8, face: -1, expr: 'happy' }, EASE.inOut],
      [3300, { pose: 'stand', face: -1 }, EASE.inOut],
      [3500, { pose: 'stand', face: 1 }, EASE.inOut],
      [3800, { pose: 'mineUp', face: 1 }, EASE.snap],
      [7000, 'mineUp', EASE.inOut],
      [8000, 'mineUp'],
    );
    loops.A6 = mk.sort((a, b) => a[0] - b[0]);
    const sparkFrames: Frame[] = [[0, { opacity: 0 }]];
    const crystalFrames: Frame[] = [[0, 'translateY(0px)']];
    for (const s of strikes) {
      sparkFrames.push(
        [s - 1, { opacity: 0 }],
        [s, { opacity: 1 }],
        [s + 380, { opacity: 0 }],
      );
      crystalFrames.push(
        [s, 'translateY(0px)'],
        [s + 60, 'translateY(-2px)'],
        [s + 200, 'translateY(0px)'],
      );
    }
    extras.push([
      'loop',
      m.querySelector('.setup-rock .ore-spark'),
      sparkFrames,
    ]);
    extras.push([
      'loop',
      m.querySelector('.setup-rock .crystals'),
      crystalFrames,
    ]);
    // A1: watches, catches, turns, walks to the cart, tips it in, walks back.
    const carried: PoseKeySpec = {
      block: (g) => [g.tw / 2 + 10, g.top + 14],
      blockLit: true,
      face: -1,
      handN: (g) => [g.tw / 2 + 15, g.top + 18],
      handF: (g) => [g.tw / 2 + 4, g.top + 14],
    };
    loops.A1 = [
      [0, { pose: 'stand', head: 4, face: 1 }],
      [2200, { pose: 'stand', head: -2, face: 1 }, EASE.inOut],
      [
        2500,
        { pose: 'give', blockLit: true, face: 1, expr: 'happy' },
        EASE.out,
      ],
      [2700, { pose: 'carry', face: 1 }, EASE.inOut],
      [2950, { pose: 'carry', face: -1 }],
      ...walkKeys(3000, 4400, carried),
      [4400, { pose: 'give', face: -1 }, EASE.out],
      [4800, { pose: 'give', face: -1, expr: 'happy' }, EASE.inOut],
      [5000, { pose: 'stand', face: -1 }],
      [5050, { pose: 'stand', face: 1 }],
      ...walkKeys(5100, 6500, { face: 1 }),
      [6500, { pose: 'stand', face: 1 }, EASE.inOut],
      [7400, { pose: 'stand', head: 4, face: 1 }],
      [8000, { pose: 'stand', head: 4, face: 1 }],
    ];
    travel.A1 = [
      [0, -13],
      [3000, -13],
      [4400, -27],
      [5100, -27],
      [6500, -13],
      [8000, -13],
    ];
    // The block's flight from the rock to A1's hands (moon-local), then into the cart.
    const caught = anchors(
      'A1',
      resolveKey('A1', { pose: 'give', blockLit: true }),
    );
    const catchAt = toMoon(r, -13, cs, 1, caught.block!);
    const start = surf(r, 34, 26 * cs);
    const apex = [
      (start[0] + catchAt[0]) / 2,
      Math.min(start[1], catchAt[1]) - 46 * cs,
    ];
    const at = (p: number[], s: number) =>
      `translate(${f(p[0])}px, ${f(p[1])}px) scale(${s})`;
    extras.push([
      'loop',
      m.querySelector('.fly-block'),
      [
        [0, { opacity: 0, transform: at(start, cs) }],
        [1700, { opacity: 0, transform: at(start, cs * 0.4) }],
        [1701, { opacity: 1, transform: at(start, cs * 0.4) }, EASE.back],
        [1950, { opacity: 1, transform: at(start, cs) }, EASE.out],
        [2220, { opacity: 1, transform: at(apex, cs) }, EASE.down],
        [2500, { opacity: 1, transform: at(catchAt, cs) }],
        [2501, { opacity: 0, transform: at(catchAt, cs) }],
      ],
    ]);
    extras.push([
      'loop',
      m.querySelector('.setup-cart .cart-load'),
      [
        [0, 'translateY(0px)'],
        [4700, 'translateY(0px)', EASE.out],
        [4800, 'translateY(-4px)', EASE.back],
        [5100, 'translateY(0px)'],
      ],
    ]);
    // Setting up shop (story): the rock rises, the cart rolls in.
    const td = T.ship.data + TOUCHDOWN_MS;
    extras.push([
      'story',
      m.querySelector('.setup-rock'),
      [
        [td + 1300, { transform: 'scaleY(0)', opacity: 0 }, EASE.back],
        [td + 1750, { transform: 'scaleY(1)', opacity: 1 }],
      ],
    ]);
    extras.push([
      'story',
      m.querySelector('.prop-cart'),
      [
        [td + 1500, 'rotate(-48deg)', EASE.out],
        [td + 2300, 'rotate(-37deg)'],
      ],
    ]);
    extras.push([
      'story',
      m.querySelector('.setup-cart'),
      [
        [td + 1499, { opacity: 0 }],
        [td + 1500, { opacity: 1 }],
      ],
    ]);
  }

  if (kind === 'model') {
    // A5: two probe pushes (the readout climbs), a hop over the probe to the easel, thinking as a
    // new point lands and the interval narrows (more data, less uncertainty), a nod, a hop back.
    const h1 = hopKeys(2500, -18, 12, { dur: 820, height: -36 });
    const h2 = hopKeys(6450, 12, -18, { dur: 760, height: -30 });
    loops.A5 = [
      [0, { pose: 'probe', face: 1 }, EASE.inOut],
      [500, { pose: 'probe', lean: 18, y: 4, face: 1 }, EASE.inOut],
      [1000, { pose: 'probe', face: 1 }, EASE.inOut],
      [1500, { pose: 'probe', lean: 18, y: 4, face: 1 }, EASE.inOut],
      [2000, { pose: 'probe', face: 1, expr: 'happy' }, EASE.inOut],
      [2400, { pose: 'stand', face: 1 }],
      ...h1.keys.map(([t, k, e]): PoseKey => [
        t,
        { ...(k as PoseKeySpec), face: 1 },
        e,
      ]),
      [h1.end + 100, { pose: 'think', face: 1 }, EASE.inOut],
      [5000, { pose: 'think', head: -12, face: 1 }, EASE.inOut],
      [5800, { pose: 'nod', face: 1 }, EASE.inOut],
      [6050, { pose: 'stand', face: 1, expr: 'happy' }, EASE.inOut],
      [6400, { pose: 'stand', face: -1 }],
      ...h2.keys.map(([t, k, e]): PoseKey => [
        t,
        { ...(k as PoseKeySpec), face: -1 },
        e,
      ]),
      [7850, { pose: 'stand', face: -1 }],
      [7900, { pose: 'probe', face: 1 }],
      [8000, { pose: 'probe', face: 1 }],
    ];
    travel.A5 = [[0, -18], ...h1.travel, ...h2.travel, [8000, -18]];
    [1, 2, 3].forEach((i, n) => {
      const bar = m.querySelector(`.probe-bar-${i}`);
      // Held at the loop's first frame through the story, so the loop takes over without a jump.
      extras.push(['story', bar, [[0, { opacity: 0.25 }]]]);
      extras.push([
        'loop',
        bar,
        [
          [0, { opacity: 0.25 }],
          [500 + n * 300, { opacity: 0.25 }],
          [520 + n * 300, { opacity: 1 }],
          [7600, { opacity: 1 }],
          [7800, { opacity: 0.25 }],
        ],
      ]);
    });
    const dot = m.querySelector('.post-dot-new');
    extras.push(['story', dot, [[0, { opacity: 0 }]]]);
    extras.push([
      'loop',
      dot,
      [
        [0, { opacity: 0 }],
        [4300, { opacity: 0 }],
        [4320, { opacity: 1 }],
        [7000, { opacity: 1 }, EASE.out],
        [7500, { opacity: 0 }],
      ],
    ]);
    extras.push([
      'loop',
      m.querySelector('.post-band'),
      [
        [0, 'scaleX(1)'],
        [4500, 'scaleX(1)', EASE.inOut],
        [5400, 'scaleX(.66)'],
        [7000, 'scaleX(.66)', EASE.inOut],
        [7800, 'scaleX(1)'],
      ],
    ]);
    // Setting up shop (story): the probe drops in, the easel unfolds, A5 waves, then probes.
    const td = T.ship.model + TOUCHDOWN_MS;
    extras.push([
      'story',
      m.querySelector('.setup-probe'),
      [
        [td + 1700, { transform: 'translateY(-40px)', opacity: 0 }, EASE.down],
        [td + 2100, { transform: 'translateY(0px)', opacity: 1 }],
      ],
    ]);
    extras.push([
      'story',
      m.querySelector('.setup-easel'),
      [
        [td + 2100, { transform: 'scaleY(0)', opacity: 0 }, EASE.back],
        [td + 2600, { transform: 'scaleY(1)', opacity: 1 }],
      ],
    ]);
    addStory(beats, 'A5', [
      [td + 2400, { pose: 'wave', expr: 'happy', face: 1 }, EASE.inOut],
      [td + 2800, { pose: 'wave', expr: 'happy', face: 1 }, EASE.inOut],
      [td + 3600, { pose: 'stand', face: 1 }, EASE.inOut],
      [td + 4400, { pose: 'probe', face: 1 }, EASE.inOut],
      [td + 4900, { pose: 'probe', lean: 18, y: 4, face: 1 }, EASE.inOut],
      [td + 5400, { pose: 'probe', face: 1 }, EASE.inOut],
      [td + 5900, { pose: 'probe', lean: 18, y: 4, face: 1 }, EASE.inOut],
      [td + 6400, { pose: 'probe', face: 1 }],
      [T.story, { pose: 'probe', face: 1 }],
    ]);
  }

  if (kind === 'ui') {
    const tiles = [...m.querySelectorAll('.scr-tile')];
    const last = tiles[tiles.length - 1];
    const pin = m.querySelector('.scr-pin');
    // A2 fits the last tile; A3 paints and adds a pin; then all three talk it over; then reset.
    loops.A2 = [
      [0, { pose: 'stand', face: 1 }, EASE.inOut],
      [700, { pose: 'fit', face: 1 }, EASE.out],
      [1400, { pose: 'fit', lean: 14, face: 1 }, EASE.back],
      [1700, { pose: 'stand', face: 1, expr: 'happy' }, EASE.inOut],
      [4200, { pose: 'listen', face: 1 }, EASE.inOut],
      [6000, { pose: 'chat', face: 1 }, EASE.inOut],
      [6800, { pose: 'stand', face: 1 }, EASE.inOut],
      [7300, { pose: 'crouch', face: 1 }, EASE.inOut],
      [7700, { pose: 'stand', face: 1 }, EASE.inOut],
      [8000, { pose: 'stand', face: 1 }],
    ];
    loops.A3 = [
      [0, { pose: 'paint', face: -1 }, EASE.inOut],
      [
        800,
        { pose: 'paint', handN: (g) => [g.shN[0] + 22, g.top - 4], face: -1 },
        EASE.inOut,
      ],
      [
        1600,
        { pose: 'paint', handN: (g) => [g.shN[0] + 22, g.top + 6], face: -1 },
        EASE.inOut,
      ],
      [
        2400,
        { pose: 'paint', handN: (g) => [g.shN[0] + 24, g.top - 2], face: -1 },
        EASE.inOut,
      ],
      [3200, { pose: 'paint', face: -1, expr: 'happy' }, EASE.inOut],
      [4300, { pose: 'stand', face: 1 }, EASE.inOut],
      [5200, { pose: 'chat', face: 1, expr: 'talk' }, EASE.inOut],
      [5900, { pose: 'stand', face: -1 }, EASE.inOut],
      [7200, { pose: 'paint', face: -1 }, EASE.inOut],
      [8000, { pose: 'paint', face: -1 }],
    ];
    loops.A4 = [
      [0, { pose: 'scroll', face: 1 }, EASE.inOut],
      [1800, { pose: 'scroll', head: 6, face: 1 }, EASE.inOut],
      [3600, { pose: 'scroll', face: 1 }, EASE.inOut],
      [4300, { pose: 'chat', face: 1, expr: 'talk' }, EASE.inOut],
      [5100, { pose: 'listen', face: 1 }, EASE.inOut],
      [6600, { pose: 'nod', face: 1 }, EASE.inOut],
      [7000, { pose: 'scroll', face: 1 }, EASE.inOut],
      [8000, { pose: 'scroll', face: 1 }],
    ];
    extras.push([
      'loop',
      last,
      [
        [0, { fill: '#1d3a63' }],
        [1500, { fill: '#1d3a63' }],
        [1520, { fill: '#4f8fc9' }],
        [7000, { fill: '#4f8fc9' }, EASE.out],
        [7500, { fill: '#1d3a63' }],
      ],
    ]);
    extras.push([
      'loop',
      pin,
      [
        [0, { opacity: 0, transform: 'translateY(-6px)' }],
        [3000, { opacity: 0, transform: 'translateY(-6px)' }, EASE.back],
        [3300, { opacity: 1, transform: 'translateY(0px)' }],
        [7000, { opacity: 1, transform: 'translateY(0px)' }, EASE.out],
        [7500, { opacity: 0, transform: 'translateY(0px)' }],
      ],
    ]);
    // The discussion circle: three icon bubbles (server-rendered, anchored to each helmet).
    SAY.forEach(([, , t], i) => {
      const el = m.querySelector(`.say-${i}`);
      extras.push(['story', el, [[0, { opacity: 0 }]]]);
      extras.push([
        'loop',
        el,
        [
          [0, { opacity: 0 }],
          [t, { opacity: 0 }],
          [t + 1, { opacity: 1 }],
          [7000, { opacity: 1 }, EASE.out],
          [7300, { opacity: 0 }],
        ],
      ]);
      extras.push([
        'loop',
        el?.querySelector('.bubble-pop') ?? null,
        [
          [0, 'scale(0)'],
          [t, 'scale(0)', EASE.back],
          [t + 300, 'scale(1)'],
        ],
      ]);
    });
    // Setting up shop (story): the screen rises, its tiles light in a sweep, the first stroke.
    const td = T.ship.ui + TOUCHDOWN_MS;
    extras.push([
      'story',
      m.querySelector('.setup-screen'),
      [
        [td + 2200, { transform: 'scaleY(0)', opacity: 0 }, EASE.back],
        [td + 2800, { transform: 'scaleY(1)', opacity: 1 }],
      ],
    ]);
    tiles.slice(0, -1).forEach((tile, i) =>
      extras.push([
        'story',
        tile,
        [
          [td + 3000 + i * 170, { fill: '#1d3a63' }],
          [td + 3000 + i * 170 + 1, { fill: '#4f8fc9' }],
        ],
      ]),
    );
    extras.push(['story', last, [[0, { fill: '#1d3a63' }]]]);
    extras.push([
      'story',
      m.querySelector('.scr-paint'),
      [
        [
          td + 3600,
          { strokeDasharray: '70 70', strokeDashoffset: 70 },
          EASE.inOut,
        ],
        [td + 5200, { strokeDasharray: '70 70', strokeDashoffset: 0 }],
      ],
    ]);
    extras.push(['story', pin, [[0, { opacity: 0 }]]]);
    addStory(beats, 'A2', [
      [td + 2500, { pose: 'stand', face: 1 }, EASE.inOut],
      [td + 3200, { pose: 'fit', face: 1 }, EASE.inOut],
      [td + 4800, { pose: 'fit', lean: 14, face: 1 }, EASE.inOut],
      [td + 5600, { pose: 'stand', face: 1 }],
      [T.story, { pose: 'stand', face: 1 }],
    ]);
    addStory(beats, 'A3', [
      [td + 1700, { pose: 'stand', face: 1 }],
      [td + 1750, { pose: 'stand', face: -1 }, EASE.inOut],
      [td + 3400, { pose: 'paint', face: -1 }, EASE.inOut],
      [
        td + 4400,
        { pose: 'paint', handN: (g) => [g.shN[0] + 22, g.top + 6], face: -1 },
        EASE.inOut,
      ],
      [td + 5200, { pose: 'paint', face: -1 }],
      [T.story, { pose: 'paint', face: -1 }],
    ]);
    addStory(beats, 'A4', [
      [td + 1900, { pose: 'stand', face: -1 }],
      [td + 1950, { pose: 'stand', face: 1 }, EASE.inOut],
      [td + 2600, { pose: 'wave', face: 1, expr: 'happy' }, EASE.inOut],
      [td + 3600, { pose: 'scroll', face: 1 }],
      [T.story, { pose: 'scroll', face: 1 }],
    ]);
  }

  // Write the tracks: the story (landing, setting up, and Data's first loop), then the loop.
  for (const c of CREW[kind]) {
    const g = m.querySelector(`.crew-${c.id}`);
    const astro = g?.querySelector('.astro');
    if (!g || !astro) continue;
    const own = loops[c.id];
    let story = [...(beats.story.get(c.id) ?? [])];
    if (tw < T.story && own) story = [...story, ...shift(own, tw)];
    story.sort((a, b) => a[0] - b[0]);
    if (story.length) {
      if (story[0][0] > 0) story.unshift([0, story[0][1]]);
      poseTracks(tl, 'story', astro, c.id, story, { base: { pose: c.pose } });
    }
    if (own)
      poseTracks(tl, 'loop', astro, c.id, own, { base: { pose: c.pose } });
    // Travel along the surface: one story track (the leap, and any loop inside the story), one
    // loop track. `.on-moon` turns about the moon's centre, so a figure stays upright on it.
    const surface = [...(beats.travel.get(c.id) ?? [[0, c.deg]])];
    const moves = travel[c.id];
    if (tw < T.story && moves)
      surface.push(...moves.map(([t, d]): [number, number] => [t + tw, d]));
    surface.sort((a, b) => a[0] - b[0]);
    tl.story(
      g,
      surface.map(([t, d]) => [t, `rotate(${d}deg)`]),
    );
    if (moves)
      tl.loop(
        g,
        moves.map(([t, d]) => [t, `rotate(${d}deg)`]),
      );
    blinks(
      tl,
      'loop',
      astro,
      [1100 + c.deg * 20, 5300 - c.deg * 10].map((t) =>
        Math.max(200, Math.min(7600, Math.round(t))),
      ),
    );
  }
  for (const [phase, el, frames] of extras) tl.track(phase, el, frames);
  // Data's first loop plays inside the story, so its loop extras do too.
  if (tw < T.story)
    for (const [phase, el, frames] of extras)
      if (phase === 'loop' && el)
        tl.story(el, [
          [0, frames[0][1]],
          ...frames.map(([t, v, e]): Frame => [t + tw, v, e]),
        ]);
}

/* -------------------------------------------------------------------------- phone camera */

/** The close-up: zoom and glide (characters.md §4). */
export const CAM = { zoom: 2.05, glide: 650 } as const;

function focus(
  L: OrbitLayout,
  kind: MoonKind,
  t: number,
  z: number,
): [number, number] {
  const [mx, my, d] = moonCenter(L, kind, t);
  const r = L.r[kind] * d;
  // The crew stands on top.
  return [L.w / 2 - z * mx, L.h * 0.56 - z * (my - r - 6)];
}

const camAt = (tx: number, ty: number, z: number) =>
  `translate(${f(tx)}px, ${f(ty)}px) scale(${f(z)})`;

/**
 * Phones: the overview while the moons arrive and the texts type, a close-up on each landing (the
 * crews read at about 75 px), then a slow tour that holds each moon for one 8 s loop. The tour is
 * 24 s and the orbit 240 s, so one 240 s camera loop tracks the moving moons exactly, forever.
 */
function cameraTracks(tl: Timeline, svg: SVGSVGElement, L: OrbitLayout): void {
  const cam = svg.querySelector('.cam');
  const z = CAM.zoom;
  const frames: Frame[] = [[0, camAt(0, 0, 1)]];
  const hold = (kind: MoonKind, t0: number, t1: number) => {
    for (let t = t0; t <= t1; t += 500)
      frames.push([t, camAt(...focus(L, kind, t, z), z)]);
    frames.push([t1, camAt(...focus(L, kind, t1, z), z)]);
  };
  // Close-ups on each landing: [moon, arrive, leave]; each glide starts where the last shot left.
  const shots: [MoonKind, number, number][] = [
    ['data', 19800, 23200],
    ['model', 23850, 25600],
    ['ui', 26250, 30600],
  ];
  let prev = 0;
  for (const [kind, arrive, leave] of shots) {
    frames.push([
      prev || arrive - CAM.glide,
      frames[frames.length - 1][1],
      EASE.inOut,
    ]);
    hold(kind, arrive, leave);
    prev = leave;
  }
  frames.push(
    [prev, frames[frames.length - 1][1], EASE.inOut],
    [prev + 1100, camAt(0, 0, 1)],
  );
  tl.story(cam, frames);
  const labels = svg.querySelector('.orb-labels');
  const zoomed = (v: Frame[1]) =>
    typeof v === 'string' && v.includes(`scale(${f(z)})`);
  const overview = camAt(0, 0, 1);
  tl.story(
    labels,
    frames.map(([t, v], i) => [
      t,
      {
        opacity:
          zoomed(v) || (i > 0 && zoomed(frames[i - 1][1]) && v !== overview)
            ? 0
            : 1,
      },
      EASE.step,
    ]),
  );
  // The idle tour: Data, Modeling, UI, one loop each (30 loops = 10 tours = one orbit).
  const tour: Frame[] = [];
  const order: MoonKind[] = ['data', 'model', 'ui'];
  for (let k = 0; k < 30; k++) {
    const kind = order[k % 3];
    const t0 = k * T.loop;
    tour.push([t0, k === 0 ? overview : tour[tour.length - 1][1], EASE.inOut]);
    for (let t = t0 + 900; t < t0 + T.loop; t += 1000)
      tour.push([t, camAt(...focus(L, kind, T.story + t, z), z)]);
    tour.push([
      t0 + T.loop - 1,
      camAt(...focus(L, kind, T.story + t0 + T.loop - 1, z), z),
    ]);
  }
  tour.push([T.orbit, overview]);
  tl.loop(
    cam,
    tour.map(([t, v, e], i) =>
      i === tour.length - 1 ? [t, tour[0][1]] : [t, v, e],
    ),
    T.orbit,
  );
  tl.loop(
    labels,
    [
      [0, { opacity: 1 }],
      [400, { opacity: 0 }],
      [T.orbit, { opacity: 0 }],
    ],
    T.orbit,
  );
}

/* ----------------------------------------------------------------------- the text columns */

/**
 * Each column waits dimmed (by colour: `--orbit-wait`, contribute.css), wakes as its moon pops
 * with an ion rule across its top, types what the group does and then who might join, and lights
 * its link once typed. The rule hands over to the next column.
 */
function columnTracks(tl: Timeline, figure: HTMLElement): void {
  const columns = [...figure.querySelectorAll<HTMLElement>('.orbit-col')];
  columns.forEach((column, i) => {
    const kind = column.dataset.group as MoonKind;
    const tm = T.moon[kind];
    const nextKind = columns[i + 1]?.dataset.group as MoonKind | undefined;
    const next = nextKind ? T.moon[nextKind] : 20600;
    tl.story(column, [
      [0, { '--orbit-wait': 1 }],
      [tm + 250, { '--orbit-wait': 1 }, EASE.out],
      [tm + 650, { '--orbit-wait': 0 }],
    ]);
    tl.story(column.querySelector('.orbit-col__rule'), [
      [0, { transform: 'scaleX(0)', opacity: 1 }],
      [tm + 250, { transform: 'scaleX(0)', opacity: 1 }, EASE.out],
      [tm + 900, { transform: 'scaleX(1)', opacity: 1 }],
      [next, { transform: 'scaleX(1)', opacity: 1 }, EASE.out],
      [next + 500, { transform: 'scaleX(1)', opacity: 0 }],
    ]);
    const what = column.querySelector('.orbit-col__what .typed');
    const who = column.querySelector('.orbit-col__who .typed');
    const a = typeFrames(what?.textContent ?? '', { start: tm + 650 });
    const b = typeFrames(who?.textContent ?? '', {
      start: a[a.length - 1][0] + 120,
    });
    const end = b[b.length - 1][0];
    tl.story(what, a);
    tl.story(who, b);
    tl.story(column.querySelector('.orbit-col__link'), [
      [0, { '--orbit-link-wait': 1 }],
      [end - 300, { '--orbit-link-wait': 1 }, EASE.out],
      [end + 200, { '--orbit-link-wait': 0 }],
    ]);
  });
}

/* ------------------------------------------------------------------------------------ init */

/** The layout drawn now: the one SVG the stage's container query shows. */
const drawnSvg = (figure: HTMLElement) =>
  [...figure.querySelectorAll<SVGSVGElement>('.orbit-svg')].find(
    (svg) => svg.getClientRects().length > 0,
  ) ?? null;

/** Start the orbit scene on its figure (the page calls this once the module has loaded). */
export function initOrbit(figure: HTMLElement): SceneController {
  // Did the head script arm the stage (its first moment painted), or stand down to the last frame?
  const armed = document.documentElement.hasAttribute('data-arm-orbit');
  let builtFor: LayoutId | null = null;
  const build = (tl: Timeline) => {
    try {
      const svg = drawnSvg(figure);
      if (svg) {
        builtFor = svg.dataset.layout as LayoutId;
        const L = LAYOUTS[builtFor];
        animate(svg, tl, L);
        if (L.id === 'phone') cameraTracks(tl, svg, L);
      }
      columnTracks(tl, figure);
    } catch (error) {
      // Never leave the stage armed and empty: the last frame stands.
      document.documentElement.removeAttribute('data-arm-orbit');
      figure.removeAttribute('data-orbit-loading');
      throw error;
    }
  };
  const controller = sceneController(figure, build, {
    name: 'orbit',
    timeline: { story: T.story, loop: T.loop },
    controls: {
      toggle: figure.querySelector<HTMLButtonElement>('[data-scene-toggle]'),
      replay: figure.querySelector<HTMLButtonElement>('[data-scene-replay]'),
    },
  });
  // The page marked the scene loading before importing this module. It stays so until the
  // controller has a state (built, or resting), which on a slow phone is several hundred ms after
  // this point: the head script's 1,200 ms check must not stand down in that gap and paint the
  // last frame, only for the build to empty it (spec §2.7 rule 5; review of T4, finding 2).
  const loaded = () => figure.removeAttribute('data-orbit-loading');
  if (figure.hasAttribute('data-scene-state')) loaded();
  else
    new MutationObserver((_, observer) => {
      if (!figure.hasAttribute('data-scene-state')) return;
      observer.disconnect();
      loaded();
    }).observe(figure, {
      attributes: true,
      attributeFilter: ['data-scene-state'],
    });

  // The stage changed layout (a rotated tablet, a resized window): rebuild the tracks on the
  // layout now drawn, at the same moment of the clock, then let the controller play or pause.
  let rebuilding = false;
  const relayout = async () => {
    const svg = drawnSvg(figure);
    if (!svg || svg.dataset.layout === builtFor || rebuilding) return;
    const tl = controller.timeline;
    if (!tl) {
      // Still building: look again once it is.
      if (builtFor) window.setTimeout(() => void relayout(), 250);
      return;
    }
    rebuilding = true;
    const time = tl.time;
    tl.cancel();
    build(tl);
    await tl.commit();
    tl.seek(time);
    rebuilding = false;
    // Hand back to the controller, which plays or pauses by its own rules (on screen, the tab
    // visible, the visitor's Pause) and sets the state to match: a visibility check that landed
    // mid-rebuild saw nothing running (review of T4, finding 6). A story not yet started stays
    // armed for the visitor.
    if (controller.state !== 'armed' && controller.state !== 'idle') {
      const toggle = figure.querySelector('[data-scene-toggle]');
      if (toggle?.getAttribute('aria-pressed') === 'true') controller.pause();
      else controller.play();
    }
    void relayout();
  };
  const stage = figure.querySelector('[data-figure-stage]');
  if (stage) new ResizeObserver(() => void relayout()).observe(stage);

  // Colours forced mid-visit (spec §8.9): rest on the story's last frame.
  matchMedia('(forced-colors: active)').addEventListener('change', (event) => {
    if (event.matches) void controller.seek(T.story);
  });

  // The head script stood down (a slow page) and the last frame is already on screen: emptying it
  // for the story would flash (spec §2.7 rule 5). Rest on the last frame and run the idle loops;
  // Replay plays the story.
  const box = figure.getBoundingClientRect();
  if (!armed && box.top < innerHeight && box.bottom > 0)
    void controller.seek(T.story).then(() => controller.play());
  return controller;
}
