/**
 * The Contribute page's transit line and group vignettes, as models (site redesign spec §4.3 C2,
 * #454). Owned by the Contribute orbit and flow task (round 2 plan T4); split verbatim out of
 * contribute-model.test.ts (plan T0 step 3).
 *
 * - The transit line: one route through three lanes, stations in pipeline order, a model step
 *   between the observations and the frequency surfaces, and two tokens. The measured stud rides
 *   the whole line; the modeled hex only joins at the model step and never replaces the stud, and
 *   both rest on the map's stretch, side by side (spec §6.1 rule 1).
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
  RING,
  modelingCells,
  modelingGroups,
  vignetteArt,
} from '../src/components/contribute/vignette-art';

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

describe('group vignettes', () => {
  it('carry no words and no status colour', () => {
    for (const kind of ['data', 'modeling', 'ui'] as const) {
      const art = vignetteArt(kind);
      expect(art, kind).not.toMatch(/<text\b|<tspan\b/);
      // Gold means validation or caution only (spec §2.6), never data.
      expect(art, kind).not.toMatch(/signal|#f4c86a/i);
      // Violet means future work, and only as a dashed outline (spec §2.1).
      if (kind !== 'ui') expect(art, kind).not.toMatch(/genome/);
    }
    expect(vignetteArt('ui')).toMatch(
      /class="wg-vig__future"[^>]*stroke:var\(--color-genome\)|class="wg-vig__future"[^>]*stroke-dasharray/,
    );
  });

  it('fades the modeled cells by evidence, hatching the far edge with no colour', () => {
    const cells = modelingCells();
    const tiers = new Set(cells.map((cell) => cell.tier));
    expect([...tiers].sort()).toEqual(['none', 'partial', 'strong', 'weak']);
    for (const cell of cells)
      expect(cell.fill === null, `${cell.tier} at ${cell.d}`).toBe(
        cell.tier === 'none',
      );
    // Cells come in by rings of distance from the evidence, each ring one path per colour: every
    // cell drawn once, nearer rings never after farther ones.
    const groups = modelingGroups();
    expect(groups.reduce((n, group) => n + group.cells.length, 0)).toBe(
      cells.length,
    );
    for (const group of groups)
      for (const cell of group.cells) {
        expect(cell.fill).toBe(group.fill);
        expect(Math.floor(cell.d / RING)).toBe(group.ring);
      }
    const byRing = [...groups].sort((a, b) => a.ring - b.ring);
    for (let index = 1; index < byRing.length; index += 1)
      expect(byRing[index].delay).toBeGreaterThanOrEqual(
        byRing[index - 1].delay,
      );
    const art = vignetteArt('modeling');
    expect([...art.matchAll(/--wg-d:(\d+)ms/g)]).toHaveLength(groups.length);
  });

  it('draws the studs after the surface they sit on', () => {
    for (const kind of ['data', 'modeling', 'ui'] as const) {
      const art = vignetteArt(kind);
      const lastCell = Math.max(
        art.lastIndexOf('wg-vig__grow'),
        art.lastIndexOf('url(#wg-hatch'),
      );
      const firstStud = art.indexOf('fill:var(--enc-obs)');
      expect(firstStud, kind).toBeGreaterThan(lastCell);
    }
  });
});
