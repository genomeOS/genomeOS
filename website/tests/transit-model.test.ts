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
 */
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
  LAYOUTS,
  PROPS,
  T,
  TOUCHDOWN_MS,
  depth,
  layoutFor,
  moonCenter,
  renderOrbit,
  theta,
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

  it('keeps every moon label at 13 px or more on the narrowest stage of its layout', () => {
    for (const L of layouts)
      expect(
        (L.label * L.minStage) / L.w,
        `${L.id} at ${L.minStage} px`,
      ).toBeGreaterThanOrEqual(13);
    // The phone layout reaches down to the 320 px viewport's stage (16 px gutters each side and
    // the site's 1.2rem page margin: 320 − 2 × 21.6 − 2 px of frame).
    expect(LAYOUTS.phone.minStage).toBeLessThanOrEqual(274.8);
  });

  it('keeps each moon label one size at every depth, countering its moon’s depth scale', () => {
    // Moons shrink to 0.8 at the back of the orbit; their labels must not (13 px floor).
    for (const L of layouts) {
      const svg = renderOrbit(L, { globeHref: '/favicon.svg' });
      for (const kind of KINDS) {
        const label = svg.match(
          new RegExp(
            `<g class="orbiter orbiter--label" data-moon="${kind}"[\\s\\S]*?</text>`,
          ),
        )![0];
        const scale = (cls: string) =>
          Number(
            label.match(
              new RegExp(`${cls}" style="transform:scale\\(([\\d.]+)\\)`),
            )![1],
          );
        expect(
          scale('orb-depth') * scale('orb-label-k'),
          `${L.id} ${kind}`,
        ).toBeCloseTo(1, 2);
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

  it('ends the story with the moons left to right in column order, clear of the globe', () => {
    for (const L of layouts) {
      const xs = KINDS.map((kind) => moonCenter(L, kind, T.story)[0]);
      expect(xs[0], L.id).toBeLessThan(xs[1]);
      expect(xs[1], L.id).toBeLessThan(xs[2]);
    }
    expect(KINDS.map((kind) => Math.round(theta(kind, T.story)))).toEqual([
      170, 250, 25,
    ]);
    expect(depth(90)).toBe(1);
    expect(depth(270)).toBeCloseTo(0.8);
  });

  it('keeps every moon and its label inside the stage all the way round', () => {
    for (const L of layouts)
      for (const kind of KINDS)
        for (let t = 0; t < T.orbit; t += 2000) {
          const [x, y, d] = moonCenter(L, kind, t);
          const r = L.r[kind] * d;
          expect(x - r, `${L.id} ${kind}`).toBeGreaterThanOrEqual(0);
          expect(x + r, `${L.id} ${kind}`).toBeLessThanOrEqual(L.w);
          // The label's baseline sits r + size + 14 below the centre.
          expect(
            y + (L.r[kind] + L.label + 14) * d,
            `${L.id} ${kind}`,
          ).toBeLessThanOrEqual(L.h);
        }
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
