/**
 * The Contribute page's transit line and orbit scene, as models (site redesign spec §4.3 C2; round
 * 2 spec §4.3.2, §4.3.3; #454). Owned by the Contribute orbit and flow task (round 2 plan T4); the
 * transit tests were split verbatim out of contribute-model.test.ts (plan T0 step 3). The group
 * vignettes retired with the group cards (round 2 spec §4.3.5).
 *
 * - The transit line: one route through three lanes, stations in pipeline order, a model step
 *   between the observations and the frequency surfaces, and two tokens. The measured stud rides
 *   the whole line; the modeled hex only joins at the model step and never replaces the stud, and
 *   both rest on the map's stretch, side by side (spec §6.1 rule 1).
 * - The orbit: three layouts chosen by stage width, each keeping its moon labels at 13 px or more;
 *   crews and props stand within ±37° of a moon's top; a moon behind the globe never covers it;
 *   the moons arrive in column order and each group's text is typed before the next moon comes;
 *   the orbit is a whole number of idle loops; the markup is deterministic (SEED = 42).
 * - The idle orbit never runs forever into a collision (review of T4, finding 1): the moons sit
 *   about 120° apart, so no crew stands on another moon, and where a crew passes in front of a
 *   farther moon it is drawn over it; a moon label shows only while nothing covers it (the globe,
 *   another moon, its crew and props, another label), fading out before and in after, over a full
 *   revolution; every label shows in the story's last frame.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MIN_LABEL_PX,
  ROUTE_ORDER,
  TRANSIT_LAYOUTS,
  TRANSIT_MS,
  buildRoute,
  labelBoxes,
  laneStretches,
  lengthAt,
  pointAt,
  slicePath,
  tokenFrame,
  type TransitLayout,
} from '../src/components/contribute/transit-route';
import {
  BREAKPOINTS,
  CREW,
  GROUPS,
  KINDS,
  LABEL_FADE_MS,
  LAYOUTS,
  LEAP,
  MOON_ORDER,
  PROPS,
  T,
  THETA0,
  TOUCHDOWN_MS,
  depth,
  discAt,
  labelBox,
  labelCover,
  labelOpacity,
  labelTrack,
  landingReach,
  layoutFor,
  moonCenter,
  partsAt,
  renderOrbit,
  theta,
  type Box,
} from '../src/components/contribute/orbit-layouts';
import { typeFrames } from '../src/graphics/typing';

const layouts = Object.values(TRANSIT_LAYOUTS);
/** The hex token's radius, as TransitLine.astro draws it. */
const TOKEN_RADIUS = 8;
const station = (layout: TransitLayout, key: string) => {
  const found = layout.stations.find((item) => item.key === key);
  if (!found) throw new Error(`${layout.id}: no station ${key}`);
  return found;
};
const laneOf = (layout: TransitLayout, y: number, x: number) =>
  layout.lanes.find(
    (band) =>
      y >= band.y &&
      y <= band.y + band.height &&
      x >= band.x &&
      x <= band.x + band.width,
  )?.lane;

describe.each(layouts.map((layout) => [layout.id, layout] as const))(
  'transit line, %s layout',
  (_id, layout) => {
    const route = buildRoute(layout);

    it('visits the stations in pipeline order along one line', () => {
      const lengths = ROUTE_ORDER.map((key) =>
        lengthAt(route, station(layout, key)),
      );
      for (let index = 1; index < lengths.length; index += 1)
        expect(lengths[index], ROUTE_ORDER[index]).toBeGreaterThan(
          lengths[index - 1],
        );
      // Every station on the route sits on the line itself.
      for (const key of ROUTE_ORDER) {
        const at = station(layout, key);
        const point = pointAt(route, lengthAt(route, at));
        expect(Math.hypot(point.x - at.x, point.y - at.y), key).toBeLessThan(
          0.5,
        );
      }
    });

    it('puts each station in the lane of the group that owns it', () => {
      for (const item of layout.stations)
        expect(laneOf(layout, item.y, item.x), item.key).toBe(item.lane);
      expect(station(layout, 'literature').lane).toBe('data');
      expect(station(layout, 'service').lane).toBe('data');
      expect(station(layout, 'frequency').lane).toBe('modeling');
      expect(station(layout, 'burden').lane).toBe('modeling');
      expect(station(layout, 'map').lane).toBe('ui');
      expect(station(layout, 'guide')).toMatchObject({
        lane: 'ui',
        future: true,
      });
    });

    it('marks the model step on the drop between observations and frequency surfaces', () => {
      const step = lengthAt(route, layout.modelStep);
      expect(step).toBeGreaterThan(
        lengthAt(route, station(layout, 'observations')),
      );
      expect(step).toBeLessThan(lengthAt(route, station(layout, 'frequency')));
      expect(laneOf(layout, layout.modelStep.y, layout.modelStep.x)).toBe(
        'modeling',
      );
    });

    it('never lets the hex replace the stud, and brings both to the map', () => {
      const step = lengthAt(route, layout.modelStep);
      const map = lengthAt(route, station(layout, 'map'));
      let joined = false;
      for (let t = 0; t <= TRANSIT_MS; t += 20) {
        const frame = tokenFrame(layout, route, t / TRANSIT_MS);
        // The measured stud is on the line at every moment.
        expect(frame.stud.length).toBeGreaterThanOrEqual(0);
        if (frame.hex) {
          joined = true;
          // The hex appears only from the model step on, behind the stud, never on top of it.
          expect(frame.hex.length).toBeGreaterThanOrEqual(step - 0.01);
          expect(frame.stud.length - frame.hex.length).toBeGreaterThanOrEqual(
            layout.tokenGap - 0.01,
          );
        } else expect(frame.stud.length - layout.tokenGap).toBeLessThan(step);
      }
      expect(joined).toBe(true);
      const rest = tokenFrame(layout, route, 1);
      expect(rest.hex).not.toBeNull();
      for (const token of [rest.stud, rest.hex!]) {
        expect(token.length).toBeLessThan(map);
        expect(laneOf(layout, token.point.y, token.point.x)).toBe('ui');
      }
      // Side by side on the map's straight run: neither rests on a bend or inside the station.
      const last = route.segments.at(-1)!;
      expect(last.kind).toBe('line');
      expect(rest.hex!.length - TOKEN_RADIUS).toBeGreaterThanOrEqual(
        last.start,
      );
      expect(map - rest.stud.length).toBeGreaterThanOrEqual(
        layout.stationRadius + TOKEN_RADIUS,
      );
    });

    it('splits the line into the stretches each group owns, with no gap', () => {
      const stretches = laneStretches(layout, route);
      expect(stretches[0].from).toBe(0);
      expect(stretches.at(-1)!.to).toBeCloseTo(route.length, 6);
      for (let index = 1; index < stretches.length; index += 1)
        expect(stretches[index].from).toBeCloseTo(stretches[index - 1].to, 6);
      // Data owns both ends of the pipeline: its stretch comes back after Modeling's.
      expect(stretches.map((stretch) => stretch.lane)).toEqual([
        'data',
        'modeling',
        'data',
        'ui',
      ]);
      for (const stretch of stretches) {
        const middle = pointAt(route, (stretch.from + stretch.to) / 2);
        expect(laneOf(layout, middle.y, middle.x)).toBe(stretch.lane);
        // Each slice is a path that starts and ends on the line.
        const d = slicePath(route, stretch.from, stretch.to);
        const start = pointAt(route, stretch.from);
        expect(d.startsWith(`M${Math.round(start.x * 100) / 100} `)).toBe(true);
      }
    });

    it('sets every label at 13 px or more wherever this layout shows', () => {
      // The smallest stage that shows the layout draws it at minStage / width.
      expect(
        (layout.fontSize * layout.minStage) / layout.width,
      ).toBeGreaterThanOrEqual(MIN_LABEL_PX);
      // One unit is about one pixel at the layout's smallest stage (spec §2.3, ±20%).
      expect(layout.width / layout.minStage).toBeLessThanOrEqual(1.2);
      expect(layout.minStage / layout.width).toBeLessThanOrEqual(1.2);
    });

    it('keeps labels clear of each other and of the stations', () => {
      const boxes = labelBoxes(layout);
      const hit = (
        a: { x: number; y: number; w: number; h: number },
        b: { x: number; y: number; w: number; h: number },
      ) =>
        Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
        Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
      boxes.forEach((a, index) => {
        for (const b of boxes.slice(index + 1))
          expect(hit(a, b), `${a.key} / ${b.key}`).toBe(false);
        for (const item of layout.stations) {
          const r = layout.stationRadius + 2;
          expect(
            hit(a, { x: item.x - r, y: item.y - r, w: 2 * r, h: 2 * r }),
            `${a.key} over station ${item.key}`,
          ).toBe(false);
        }
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
      });
    });
  },
);

describe('orbit scene', () => {
  const layouts = Object.values(LAYOUTS);

  it('keeps every moon label at 13 px or more on the narrowest drawing of its layout', () => {
    for (const L of layouts) {
      expect(
        (L.label * L.minWidth) / L.w,
        `${L.id} at ${L.minWidth} px`,
      ).toBeGreaterThanOrEqual(13);
      // Only the desktop's drawing narrows under its stage (sized to a short screen's height).
      expect(L.minWidth, L.id).toBeLessThanOrEqual(L.minStage);
    }
    expect(LAYOUTS.desktop.minWidth).toBeLessThan(LAYOUTS.desktop.minStage);
    // The phone layout reaches down to the 320 px viewport's stage (16 px gutters each side and
    // the site's 1.2rem page margin: 320 − 2 × 21.6 − 2 px of frame).
    expect(LAYOUTS.phone.minStage).toBeLessThanOrEqual(274.8);
  });

  it('sizes each wide drawing in contribute.css by its own viewBox and narrowest width', () => {
    // contribute.css holds the numbers as literals: they must be these layouts'.
    const css = readFileSync(
      new URL('../src/styles/pages/contribute.css', import.meta.url),
      'utf8',
    ).replace(/\s+/g, ' ');
    for (const L of [LAYOUTS.desktop, LAYOUTS.tablet]) {
      const rule = css.match(
        new RegExp(`\\.orbit-svg--${L.id} \\{ width: ([^;]+);`),
      )?.[1];
      expect(rule, L.id).toBeDefined();
      expect(rule).toContain(`max(${L.minWidth}px,`);
      expect(rule).toContain(`* ${L.w} / ${L.h})`);
    }
  });

  it('keeps each moon label one size and one gap under its moon at every depth', () => {
    // Moons shrink to 0.8 at the back of the orbit; their labels must not (13 px floor), nor the
    // gap between a moon's rim and its name, `drop`, set inside the counter-scale.
    for (const L of layouts) {
      const svg = renderOrbit(L, { globeHref: '/favicon.svg' });
      for (const kind of KINDS) {
        const label = svg.match(
          new RegExp(
            `<g class="orbiter orbiter--label" data-moon="${kind}"[\\s\\S]*?</text>`,
          ),
        )![0];
        expect(label).toMatch(
          new RegExp(
            `orb-label-k" style="transform:scale\\([\\d.]+\\)"><g transform="translate\\(0 ${L.drop}\\)">`,
          ),
        );
        const scale = (cls: string) =>
          Number(
            label.match(
              new RegExp(`${cls}" style="transform:scale\\(([\\d.]+)\\)`),
            )![1],
          );
        // To three decimals: a label 0.4% small is a 13 px label at 12.99 px.
        expect(
          scale('orb-depth') * scale('orb-label-k'),
          `${L.id} ${kind}`,
        ).toBeCloseTo(1, 3);
      }
    }
  });

  it('switches layouts by stage width: phone, then tablet, then desktop', () => {
    expect(layoutFor(274.8).id).toBe('phone');
    expect(layoutFor(BREAKPOINTS.tablet - 1).id).toBe('phone');
    expect(layoutFor(BREAKPOINTS.tablet).id).toBe('tablet');
    // A 768 px tablet (705 px stage) and a 1024 px laptop (940 px stage) take the tablet layout.
    expect(layoutFor(705).id).toBe('tablet');
    expect(layoutFor(940).id).toBe('tablet');
    expect(layoutFor(BREAKPOINTS.desktop).id).toBe('desktop');
    expect(layoutFor(1323).id).toBe('desktop');
    // One unit is about one pixel at the desktop's widest stage.
    expect(LAYOUTS.desktop.w / 1323).toBeLessThan(1.01);
  });

  it('stands crews and props within 37° of a moon’s top, so nobody looks like falling off', () => {
    for (const kind of KINDS) {
      for (const member of CREW[kind])
        expect(Math.abs(member.deg), member.id).toBeLessThanOrEqual(37);
      for (const [name, deg] of PROPS[kind])
        expect(Math.abs(deg), name).toBeLessThanOrEqual(37);
    }
    // Two, one and three astronauts: the owner's 1–3 per ship, six in the scene.
    expect(KINDS.map((kind) => CREW[kind].length)).toEqual([2, 1, 3]);
  });

  it('never lets a moon behind the globe cover it, at any time of the orbit', () => {
    for (const L of layouts)
      for (const kind of KINDS)
        for (let t = 0; t < T.orbit; t += 1000) {
          const deg = theta(kind, t);
          if (Math.sin((deg * Math.PI) / 180) >= 0) continue; // in front
          const [x, y, d] = moonCenter(L, kind, t);
          const gap = Math.hypot(x - L.cx, y - L.cy) - L.r[kind] * d;
          expect(gap, `${L.id} ${kind} at ${t} ms`).toBeGreaterThan(
            L.globe * 1.05,
          );
        }
  });

  it('ends the story with the moons left to right in column order, Modeling above the globe', () => {
    for (const L of layouts) {
      const xs = KINDS.map((kind) => moonCenter(L, kind, T.story)[0]);
      expect(xs[0], L.id).toBeLessThan(xs[1]);
      expect(xs[1], L.id).toBeLessThan(xs[2]);
    }
    // Data lower left, Modeling at the top over the globe, UI lower right: each moon above its own
    // column of text.
    expect(KINDS.map((kind) => Math.round(theta(kind, T.story)))).toEqual([
      156, 268, 26,
    ]);
    expect(depth(90)).toBe(1);
    expect(depth(270)).toBeCloseTo(0.8);
  });

  const hits = (a: Box, b: Box) =>
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  /** How far a box reaches into a disc, units (≤ 0: clear of it). */
  const graze = (box: Box, [x, y, r]: [number, number, number]) =>
    r -
    Math.hypot(
      Math.max(box[0], Math.min(x, box[2])) - x,
      Math.max(box[1], Math.min(y, box[3])) - y,
    );
  const GRAZE = 4;
  /** Every 250 ms from the story's start to the end of a full idle revolution. */
  const moments = Array.from(
    { length: (T.story + T.orbit) / 250 },
    (_, index) => index * 250,
  );

  it('spaces the moons about 120° apart, and draws a nearer crew over a farther moon', () => {
    for (const [a, b] of [
      ['data', 'model'],
      ['model', 'ui'],
      ['ui', 'data'],
    ] as const) {
      const apart = (((theta(b, 0) - theta(a, 0)) % 360) + 360) % 360;
      expect(apart, `${a} to ${b}`).toBeGreaterThanOrEqual(110);
      expect(apart, `${a} to ${b}`).toBeLessThanOrEqual(130);
    }
    for (const L of layouts)
      for (const t of moments.filter((ms) => ms >= T.story))
        for (const kind of KINDS)
          for (const other of KINDS) {
            if (other === kind) continue;
            const where = `${L.id} ${kind} over ${other} at ${t} ms`;
            const parts = partsAt(L, kind, t);
            // No crew ever mingles with another moon's crew or props.
            for (const part of parts)
              for (const theirs of partsAt(L, other, t))
                expect(hits(part, theirs), where).toBe(false);
            // A crew may pass over another moon's disc only in front of it: nearer on the orbit,
            // and drawn after it. Three moons in one drawing order can't always be right, so where
            // it is wrong the crew's box may only graze the farther moon's rim, by GRAZE units at
            // most (a box is the union of a figure's poses over its loop: the art grazes less).
            const front =
              depth(theta(kind, t)) > depth(theta(other, t)) &&
              MOON_ORDER.indexOf(kind) > MOON_ORDER.indexOf(other);
            const behind =
              depth(theta(kind, t)) < depth(theta(other, t)) &&
              MOON_ORDER.indexOf(kind) < MOON_ORDER.indexOf(other);
            if (!front && !behind)
              for (const part of parts)
                expect(
                  graze(part, discAt(L, other, t)),
                  where,
                ).toBeLessThanOrEqual(GRAZE);
          }
  });

  it('shows a moon label only while nothing covers it, all the way round', () => {
    for (const L of layouts) {
      const tracks = Object.fromEntries(
        KINDS.map((kind) => [kind, labelTrack(L, kind)]),
      );
      for (const t of moments) {
        const shown = KINDS.filter(
          (kind) =>
            t >= T.moon[kind] + 900 && labelOpacity(tracks[kind], t) > 0,
        );
        for (const kind of shown) {
          const where = `${L.id} ${kind} label at ${t} ms`;
          // Not cut by the globe, nor under another moon, its crew or its props.
          expect(labelCover(L, kind, t), where).toBeNull();
          // Two labels never overlap.
          for (const other of shown)
            if (other !== kind)
              expect(
                hits(labelBox(L, kind, t), labelBox(L, other, t)),
                where,
              ).toBe(false);
        }
      }
    }
  });

  it('shows every label in the story’s last frame, and each for most of a revolution', () => {
    for (const L of layouts)
      for (const kind of KINDS) {
        const track = labelTrack(L, kind);
        // The last frame (also reduced motion's), and the seam where the loop takes over.
        expect(labelOpacity(track, T.story), `${L.id} ${kind}`).toBe(1);
        expect(track.story.at(-1)![1], `${L.id} ${kind}`).toBe(1);
        expect(track.loop[0][1], `${L.id} ${kind}`).toBe(1);
        const visible = moments.filter(
          (t) => t >= T.story && labelOpacity(track, t) === 1,
        ).length;
        expect(
          visible / (T.orbit / 250),
          `${L.id} ${kind} shows`,
        ).toBeGreaterThan(0.6);
      }
  });

  it('fades a label out before anything reaches it and back in after, never blinking', () => {
    for (const L of layouts)
      for (const kind of KINDS) {
        const { story, loop } = labelTrack(L, kind);
        // The story's track spans the story; the loop's one revolution, ending where it starts.
        expect([story[0][0], story.at(-1)![0]]).toEqual([0, T.story]);
        expect([loop[0][0], loop.at(-1)![0]]).toEqual([0, T.orbit]);
        expect(loop.at(-1)![1]).toBe(loop[0][1]);
        // Round the loop, each spell shown or hidden lasts 3 s or more.
        const spells: [boolean, number][] = [];
        for (let t = 0; t < T.orbit; t += 250) {
          const on = labelOpacity({ story, loop }, T.story + t) > 0;
          if (spells.length && spells.at(-1)![0] === on)
            spells.at(-1)![1] += 250;
          else spells.push([on, 250]);
        }
        if (spells.length > 1 && spells[0][0] === spells.at(-1)![0])
          spells[0][1] += spells.pop()![1];
        for (const [on, ms] of spells.length > 1 ? spells : [])
          expect(
            ms,
            `${L.id} ${kind} ${on ? 'shown' : 'hidden'}`,
          ).toBeGreaterThanOrEqual(3000);
        // Every fade, once the label has arrived, takes LABEL_FADE_MS.
        for (const frames of [story, loop])
          for (let index = 1; index < frames.length; index += 1) {
            const [t0, a] = frames[index - 1];
            const [t1, b] = frames[index];
            if (a !== b && (frames === loop || t0 >= T.moon[kind] + 900))
              expect(t1 - t0, `${L.id} ${kind} fade at ${t0}`).toBe(
                LABEL_FADE_MS,
              );
          }
      }
  });

  // Nothing clips (owner, 2026-10-15, with the shorter stage): every moon, its crew mid-hop and
  // its label while it shows stay inside the stage at every moment of the story and a revolution,
  // and so does each pod from touchdown until it leaves.
  const inside = (L: (typeof layouts)[number], [x0, y0, x1, y1]: Box) =>
    x0 >= 0 && y0 >= 0 && x1 <= L.w && y1 <= L.h;
  /** The pod's top above its pads at full scale: the beacon (props.ts spaceship). */
  const POD_TOP = 144;
  /**
   * An astronaut's art above its feet through a leap, hands and antenna up, at full scale and with
   * the hop's squash: the most of any crew member, measured in the browser every 20 ms of each leap
   * and rounded up (the orbit spec checks the drawn landings themselves).
   */
  const LEAP_TOP = 108;

  it('keeps every moon, crew, pod and showing label inside the stage all the way round', () => {
    for (const L of layouts) {
      const tracks = Object.fromEntries(
        KINDS.map((kind) => [kind, labelTrack(L, kind)]),
      );
      for (const t of moments)
        for (const kind of KINDS) {
          if (t < T.moon[kind]) continue;
          const where = `${L.id} ${kind} at ${t} ms`;
          const [x, y, r] = discAt(L, kind, t);
          expect(inside(L, [x - r, y - r, x + r, y + r]), where).toBe(true);
          // Crews keep to the stage's height; on the phone a bubble may pass its side edge while
          // the camera, in the idle loops, holds a close-up elsewhere.
          for (const part of partsAt(L, kind, t))
            expect(
              L.id === 'phone'
                ? part[1] >= 0 && part[3] <= L.h
                : inside(L, part),
              `${where}: crew`,
            ).toBe(true);
          if (labelOpacity(tracks[kind], t) > 0)
            expect(inside(L, labelBox(L, kind, t)), `${where}: label`).toBe(
              true,
            );
        }
      for (const kind of KINDS)
        for (
          let t = T.ship[kind] + TOUCHDOWN_MS;
          t <= T.ship[kind] + TOUCHDOWN_MS + 1300;
          t += 100
        ) {
          const [, y, d] = moonCenter(L, kind, t);
          const top = y + d * (1 - L.r[kind] - POD_TOP * L.cs * 0.95);
          expect(top, `${L.id} ${kind} pod at ${t} ms`).toBeGreaterThanOrEqual(
            0,
          );
        }
    }
  });

  it('keeps every landing inside the desktop and tablet stages: each pod from its hover, each crew through its leap', () => {
    // orbit.ts landing: a pod slows to its hover 1300 ms after it comes in and settles at
    // touchdown; each crew member leaps out 420 + 260 i ms after touchdown, tops out 640 ms later and
    // is down at 1220, then crouches and stands (the work spots, partsAt, take over). Between two
    // keys neither reaches past the higher one (EASE.up, down and inOut never overshoot), so each
    // moment is checked at the higher key's height, the figure at full scale. The Modeling moon
    // lands at the top of its orbit, under the stage's top edge (landingReach). The phone's camera
    // closes in on each landing, so its stage's edge never frames one.
    for (const L of [LAYOUTS.desktop, LAYOUTS.tablet])
      for (const kind of KINDS) {
        const reach = landingReach(L, kind);
        const td = T.ship[kind] + TOUCHDOWN_MS;
        // [ms, the top in moon-local units before the depth scale]
        const tops: [number, number][] = [];
        for (let t = T.ship[kind] + 1300; t < td; t += 50)
          tops.push([t, 1 - L.r[kind] - reach.hover - POD_TOP * L.cs * 0.95]);
        CREW[kind].forEach((_, i) => {
          const te = td + 420 + i * 260;
          for (let t = te; t <= te + 1560; t += 50) {
            const lift = t <= te + 1220 ? LEAP.apex * reach.leap : 0;
            tops.push([t, 1.5 - L.r[kind] + L.cs * (lift - LEAP_TOP)]);
          }
        });
        for (const [t, top] of tops) {
          const [, y, d] = moonCenter(L, kind, t);
          expect(
            y + d * top,
            `${L.id} ${kind} at ${t} ms`,
          ).toBeGreaterThanOrEqual(0);
        }
      }
    // Only the top moon's landing is lowered.
    expect(landingReach(LAYOUTS.desktop, 'data')).toEqual({
      hover: 120,
      leap: 1,
    });
    expect(landingReach(LAYOUTS.phone, 'model')).toEqual({
      hover: 120,
      leap: 1,
    });
  });

  it('makes the desktop and tablet stages as tall as their orbits need and no taller', () => {
    for (const L of [LAYOUTS.desktop, LAYOUTS.tablet]) {
      const tracks = Object.fromEntries(
        KINDS.map((kind) => [kind, labelTrack(L, kind)]),
      );
      let top = Infinity;
      let bottom = -Infinity;
      for (const t of moments)
        for (const kind of KINDS) {
          if (t < T.moon[kind]) continue;
          for (const part of partsAt(L, kind, t)) top = Math.min(top, part[1]);
          const [, y, r] = discAt(L, kind, t);
          bottom = Math.max(bottom, y + r);
          if (labelOpacity(tracks[kind], t) > 0)
            bottom = Math.max(bottom, labelBox(L, kind, t)[3]);
        }
      // The top moon's crew, mid-hop, a few units under the top edge; the lowest thing that shows
      // a few units over the bottom edge.
      expect(top, L.id).toBeLessThanOrEqual(6);
      expect(L.h - bottom, L.id).toBeLessThanOrEqual(6);
    }
    // On the desktop the front moon's label fades out before the bottom edge (labelCover), so the
    // stage ends near the front moon itself.
    const desktop = LAYOUTS.desktop;
    const front = (T.orbit * (THETA0.ui - 90 + 360)) / 360;
    expect(theta('ui', front) % 360).toBeCloseTo(-270, 6);
    expect(labelCover(desktop, 'ui', front)).toBe('edge');
  });

  it('brings the moons in column order and types each group’s text before the next moon comes', () => {
    expect(GROUPS.map((group) => group.kind)).toEqual(['data', 'model', 'ui']);
    const pops = KINDS.map((kind) => T.moon[kind]);
    expect([...pops].sort((a, b) => a - b)).toEqual(pops);
    GROUPS.forEach((group, index) => {
      const what = typeFrames(group.what, { start: T.moon[group.kind] + 650 });
      const end = what[what.length - 1][0];
      const who = typeFrames(group.who, { start: end + 120 });
      const done = who[who.length - 1][0];
      const next =
        index < 2 ? T.moon[GROUPS[index + 1].kind] : T.ship[group.kind];
      expect(done, group.kind).toBeLessThan(next);
    });
    // Pods land after the last text is typed, one moon after another, before the story ends.
    for (const kind of KINDS)
      expect(T.ship[kind] + TOUCHDOWN_MS + 2500).toBeLessThanOrEqual(T.story);
  });

  it('fits the orbit and the phone tour to a whole number of idle loops', () => {
    expect(T.orbit % T.loop).toBe(0);
    expect(T.orbit / T.loop).toBe(30);
    expect(T.story % T.loop).toBe(0);
    // The phone's idle tour holds each moon for one loop: three loops, ten tours a revolution.
    expect(T.orbit % (3 * T.loop)).toBe(0);
  });

  it('renders the same markup every time, with ids unique across the three layouts', () => {
    const opt = { globeHref: '/favicon.svg' };
    const all = layouts.map((L) => renderOrbit(L, opt));
    expect(layouts.map((L) => renderOrbit(L, opt))).toEqual(all);
    const ids = all.flatMap((svg) =>
      [...svg.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of all) {
      // Decorative, out of the tab order, no words but the three moon labels.
      expect(svg).toMatch(/^<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
      expect(svg.match(/<text\b/g)).toHaveLength(3);
      expect(svg).not.toMatch(/Math\.random|NaN|undefined/);
    }
  });
});
