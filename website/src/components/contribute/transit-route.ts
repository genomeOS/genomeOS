/** The working groups' transit line (site redesign spec §4.3 C2, #454).
 *
 * One line carries evidence to the map, through three swimlanes, one per working group:
 *
 *   Data         Literature → Population registry → Observations ─┐            ┌→ Data service ─┐
 *   Modeling                                  (model step) └→ Frequency surfaces → Burden & risk ┘ │
 *   UI                                                                          Globe & map ┄┄ Guide (future)
 *
 * so the line itself shows that Data owns both ends of the pipeline. Two tokens ride it: a white
 * stud (measured) from the start, and a teal hex (modeled) that joins at the model step and
 * travels behind the stud. Both rest on the map's stretch, side by side: measured and modeled reach
 * the map as two layers, and nothing is replaced (spec §6.1 rule 1).
 *
 * Two layouts, chosen by the plate's own width (a container query, as the kit's Pipeline does):
 * horizontal swimlanes from a stage of `TRANSIT_LAYOUTS.h.minStage` px, and a vertical line with
 * lane brackets below it. Each layout's viewBox is close to its smallest drawn width (spec §2.3), so
 * a 15-unit label renders at 13 px or more.
 *
 * Shared by TransitLine.astro (server render: the final state) and transit.ts (the entrance). No
 * DOM.
 */

import { easeCamera } from '../../graphics/tween';

export type Lane = 'data' | 'modeling' | 'ui';
export type StationKey =
  | 'literature'
  | 'registry'
  | 'observations'
  | 'frequency'
  | 'burden'
  | 'service'
  | 'map'
  | 'guide';
export type StationIcon =
  | 'document'
  | 'pin'
  | 'stud'
  | 'hex'
  | 'bars'
  | 'cylinder'
  | 'globe'
  | 'speech';

export interface Point {
  x: number;
  y: number;
}

export interface Label {
  lines: string[];
  /** The first line's baseline. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  /** Set upright along the y axis (the phone layout's lane tags). */
  rotate?: boolean;
}

export interface Station extends Point {
  key: StationKey;
  lane: Lane;
  icon: StationIcon;
  label: Label;
  /** Not built yet: violet dashed outline (spec §6.1 rule 7). */
  future?: boolean;
}

export interface LaneBand {
  lane: Lane;
  x: number;
  y: number;
  width: number;
  height: number;
  name: Label;
  /** The phone layout's bracket, from y to y + length at x. */
  bracket?: { x: number; y: number; length: number };
}

export interface TransitLayout {
  id: 'h' | 'v';
  width: number;
  height: number;
  /** The smallest stage width (px) that shows this layout. */
  minStage: number;
  /** Drawn no wider than this (px), so labels stay moderate on wide screens. */
  maxWidth: number;
  fontSize: number;
  lineHeight: number;
  stationRadius: number;
  lanes: LaneBand[];
  stations: Station[];
  /** The line's corner points, from the first station to the map. */
  route: Point[];
  /** Corner radius of the line's turns. */
  corner: number;
  /** Where the line drops into the Modeling lane: the hex joins here. */
  modelStep: Point;
  modelStepLabel: Label & { glyph: Point };
  /** The violet dashed spur from the map to the future guide. */
  spur: [Point, Point];
  /** The hex travels this far behind the stud. */
  tokenGap: number;
  /** The stud rests this far before the map station's centre. */
  restBefore: number;
}

/** Labels render at 13 px or more (spec §2.3); figures.spec measures them too. */
export const MIN_LABEL_PX = 13;
/** The line draws, and the stud rides its head, over this long (spec §4.3 C2). */
export const TRANSIT_MS = 2400;
/** Stations in the order the line visits them; the guide hangs off the spur. */
export const ROUTE_ORDER: readonly StationKey[] = [
  'literature',
  'registry',
  'observations',
  'frequency',
  'burden',
  'service',
  'map',
];

const FONT = 15;
const LINE = 18;
const R = 14;

/* ---------- horizontal: three swimlanes ---------- */

// Lane bands are 100 units tall; the line runs at y = 66 (Data), 134 (Modeling), 234 (UI). Data
// labels sit above the line, Modeling and UI labels below it, so no label meets a diagonal.
const H_DATA = 66;
const H_MODEL = 134;
const H_UI = 234;
const above = (x: number, lines: string[]): Label => ({
  lines,
  x,
  y: lines.length === 1 ? 44 : 26,
  anchor: 'middle',
});
const below = (x: number, y: number, lines: string[]): Label => ({
  lines,
  x,
  y: y + 36,
  anchor: 'middle',
});

const HORIZONTAL: TransitLayout = {
  id: 'h',
  width: 1000,
  height: 300,
  minStage: 870,
  maxWidth: 1080,
  fontSize: FONT,
  lineHeight: LINE,
  stationRadius: R,
  lanes: [
    {
      lane: 'data',
      x: 0,
      y: 0,
      width: 1000,
      height: 100,
      name: {
        lines: ['Data &', 'infrastructure'],
        x: 14,
        y: 46,
        anchor: 'start',
      },
    },
    {
      lane: 'modeling',
      x: 0,
      y: 100,
      width: 1000,
      height: 100,
      name: {
        lines: ['Statistical &', 'AI modeling'],
        x: 14,
        y: 146,
        anchor: 'start',
      },
    },
    {
      lane: 'ui',
      x: 0,
      y: 200,
      width: 1000,
      height: 100,
      name: { lines: ['UI &', 'applications'], x: 14, y: 246, anchor: 'start' },
    },
  ],
  stations: [
    {
      key: 'literature',
      lane: 'data',
      icon: 'document',
      x: 182,
      y: H_DATA,
      label: above(182, ['Literature']),
    },
    {
      key: 'registry',
      lane: 'data',
      icon: 'pin',
      x: 284,
      y: H_DATA,
      label: above(284, ['Population', 'registry']),
    },
    {
      key: 'observations',
      lane: 'data',
      icon: 'stud',
      x: 388,
      y: H_DATA,
      label: above(388, ['Observations']),
    },
    {
      key: 'frequency',
      lane: 'modeling',
      icon: 'hex',
      x: 536,
      y: H_MODEL,
      label: below(536, H_MODEL, ['Frequency', 'surfaces']),
    },
    {
      key: 'burden',
      lane: 'modeling',
      icon: 'bars',
      x: 636,
      y: H_MODEL,
      label: below(636, H_MODEL, ['Burden', '& risk']),
    },
    {
      key: 'service',
      lane: 'data',
      icon: 'cylinder',
      x: 762,
      y: H_DATA,
      label: above(762, ['Data service']),
    },
    {
      key: 'map',
      lane: 'ui',
      icon: 'globe',
      x: 884,
      y: H_UI,
      label: below(884, H_UI, ['Globe & map']),
    },
    {
      key: 'guide',
      lane: 'ui',
      icon: 'speech',
      future: true,
      x: 966,
      y: H_UI,
      label: below(966, H_UI, ['Guide', '(future)']),
    },
  ],
  route: [
    { x: 182, y: H_DATA },
    { x: 420, y: H_DATA },
    { x: 488, y: H_MODEL },
    { x: 664, y: H_MODEL },
    { x: 732, y: H_DATA },
    { x: 800, y: H_DATA },
    { x: 800, y: H_UI },
    { x: 884, y: H_UI },
  ],
  corner: 14,
  modelStep: { x: 488, y: H_MODEL },
  modelStepLabel: {
    lines: ['Model step'],
    x: 514,
    y: 112,
    anchor: 'start',
    glyph: { x: 503, y: 107 },
  },
  spur: [
    { x: 884 + R + 5, y: H_UI },
    { x: 966 - R - 5, y: H_UI },
  ],
  tokenGap: 21,
  restBefore: 24,
};

/* ---------- vertical: one rail, lanes as brackets ---------- */

// The rail steps right for Modeling and UI (x = 56, 84, 112), as the swimlanes step down in the
// horizontal layout; each stretch of the line gets a bracket naming its group at the far left.
const V_DATA = 56;
const V_MODEL = 84;
const V_UI = 112;
const right = (x: number, y: number, text: string): Label => ({
  lines: [text],
  x: x + 24,
  y: y + 5,
  anchor: 'start',
});
/** A lane tag set upright along its bracket, centred on it. */
const tag = (text: string, bracket: { y: number; length: number }): Label => ({
  lines: [text],
  x: 22,
  y: bracket.y + bracket.length / 2,
  anchor: 'middle',
  rotate: true,
});
const BRACKETS = {
  data: { x: 6, y: 18, length: 136 },
  modeling: { x: 6, y: 204, length: 84 },
  service: { x: 6, y: 326, length: 32 },
  ui: { x: 6, y: 468, length: 84 },
};

const VERTICAL: TransitLayout = {
  id: 'v',
  width: 272,
  height: 560,
  minStage: 248,
  maxWidth: 352,
  fontSize: FONT,
  lineHeight: LINE,
  stationRadius: 13,
  lanes: [
    {
      lane: 'data',
      x: 0,
      y: 0,
      width: 272,
      height: 172,
      name: tag('Data', BRACKETS.data),
      bracket: BRACKETS.data,
    },
    {
      lane: 'modeling',
      x: 0,
      y: 172,
      width: 272,
      height: 132,
      name: tag('Modeling', BRACKETS.modeling),
      bracket: BRACKETS.modeling,
    },
    {
      lane: 'data',
      x: 0,
      y: 304,
      width: 272,
      height: 88,
      name: tag('Data', BRACKETS.service),
      bracket: BRACKETS.service,
    },
    {
      lane: 'ui',
      x: 0,
      y: 392,
      width: 272,
      height: 168,
      name: tag('UI', BRACKETS.ui),
      bracket: BRACKETS.ui,
    },
  ],
  stations: [
    {
      key: 'literature',
      lane: 'data',
      icon: 'document',
      x: V_DATA,
      y: 34,
      label: right(V_DATA, 34, 'Literature'),
    },
    {
      key: 'registry',
      lane: 'data',
      icon: 'pin',
      x: V_DATA,
      y: 86,
      label: right(V_DATA, 86, 'Population registry'),
    },
    {
      key: 'observations',
      lane: 'data',
      icon: 'stud',
      x: V_DATA,
      y: 138,
      label: right(V_DATA, 138, 'Observations'),
    },
    {
      key: 'frequency',
      lane: 'modeling',
      icon: 'hex',
      x: V_MODEL,
      y: 220,
      label: right(V_MODEL, 220, 'Frequency surfaces'),
    },
    {
      key: 'burden',
      lane: 'modeling',
      icon: 'bars',
      x: V_MODEL,
      y: 272,
      label: right(V_MODEL, 272, 'Burden & risk'),
    },
    {
      key: 'service',
      lane: 'data',
      icon: 'cylinder',
      x: V_DATA,
      y: 342,
      label: right(V_DATA, 342, 'Data service'),
    },
    {
      key: 'map',
      lane: 'ui',
      icon: 'globe',
      x: V_UI,
      y: 484,
      label: right(V_UI, 484, 'Globe & map'),
    },
    {
      key: 'guide',
      lane: 'ui',
      icon: 'speech',
      future: true,
      x: V_UI,
      y: 538,
      label: right(V_UI, 538, 'Guide (future)'),
    },
  ],
  route: [
    { x: V_DATA, y: 34 },
    { x: V_DATA, y: 162 },
    { x: V_MODEL, y: 190 },
    { x: V_MODEL, y: 290 },
    { x: V_DATA, y: 318 },
    { x: V_DATA, y: 364 },
    { x: V_UI, y: 420 },
    { x: V_UI, y: 484 },
  ],
  corner: 10,
  modelStep: { x: V_MODEL, y: 190 },
  modelStepLabel: {
    lines: ['Model step'],
    x: 122,
    y: 186,
    anchor: 'start',
    glyph: { x: 110, y: 181 },
  },
  spur: [
    { x: V_UI, y: 484 + 13 + 5 },
    { x: V_UI, y: 538 - 13 - 5 },
  ],
  tokenGap: 20,
  restBefore: 22,
};

export const TRANSIT_LAYOUTS = { h: HORIZONTAL, v: VERTICAL } as const;

/* ---------- route geometry: a polyline with filleted corners ---------- */

interface LineSegment {
  kind: 'line';
  a: Point;
  b: Point;
  start: number;
  length: number;
}

interface ArcSegment {
  kind: 'arc';
  a: Point;
  b: Point;
  centre: Point;
  radius: number;
  /** Angle of `a` around the centre, and the signed sweep to `b` (radians, y down). */
  from: number;
  sweep: number;
  start: number;
  length: number;
}

export type Segment = LineSegment | ArcSegment;

export interface Route {
  segments: Segment[];
  length: number;
  /** SVG path data. */
  d: string;
}

const round = (value: number) => Math.round(value * 100) / 100;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (v: Point): Point => {
  const length = Math.hypot(v.x, v.y);
  return { x: v.x / length, y: v.y / length };
};

/** The route through `points`, each interior corner rounded with `radius`. */
export function filletRoute(points: Point[], radius: number): Route {
  const segments: Segment[] = [];
  let cursor = points[0];
  let start = 0;
  const pushLine = (to: Point) => {
    const length = Math.hypot(to.x - cursor.x, to.y - cursor.y);
    if (length > 1e-9) {
      segments.push({ kind: 'line', a: cursor, b: to, start, length });
      start += length;
    }
    cursor = to;
  };
  for (let index = 1; index < points.length - 1; index += 1) {
    const corner = points[index];
    const u = unit(sub(corner, points[index - 1]));
    const v = unit(sub(points[index + 1], corner));
    const turn = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
    if (turn < 1e-6) continue;
    const cross = u.x * v.y - u.y * v.x;
    const tangent = radius * Math.tan(turn / 2);
    const a = { x: corner.x - u.x * tangent, y: corner.y - u.y * tangent };
    const b = { x: corner.x + v.x * tangent, y: corner.y + v.y * tangent };
    const normal = cross > 0 ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
    const centre = { x: a.x + normal.x * radius, y: a.y + normal.y * radius };
    pushLine(a);
    const length = radius * turn;
    segments.push({
      kind: 'arc',
      a,
      b,
      centre,
      radius,
      from: Math.atan2(a.y - centre.y, a.x - centre.x),
      sweep: cross > 0 ? turn : -turn,
      start,
      length,
    });
    start += length;
    cursor = b;
  }
  pushLine(points[points.length - 1]);

  let d = `M${round(points[0].x)} ${round(points[0].y)}`;
  for (const segment of segments)
    d +=
      segment.kind === 'line'
        ? `L${round(segment.b.x)} ${round(segment.b.y)}`
        : `A${segment.radius} ${segment.radius} 0 0 ${segment.sweep > 0 ? 1 : 0} ${round(segment.b.x)} ${round(segment.b.y)}`;
  return { segments, length: start, d };
}

export function buildRoute(layout: TransitLayout): Route {
  return filletRoute(layout.route, layout.corner);
}

/** The point `length` along the route (clamped to its ends). */
export function pointAt(route: Route, length: number): Point {
  const l = Math.max(0, Math.min(route.length, length));
  const segment =
    route.segments.find((item) => l <= item.start + item.length) ??
    route.segments[route.segments.length - 1];
  const local = Math.max(0, Math.min(segment.length, l - segment.start));
  if (segment.kind === 'line') {
    const f = segment.length ? local / segment.length : 0;
    return {
      x: segment.a.x + (segment.b.x - segment.a.x) * f,
      y: segment.a.y + (segment.b.y - segment.a.y) * f,
    };
  }
  const angle =
    segment.from + (Math.sign(segment.sweep) * local) / segment.radius;
  return {
    x: segment.centre.x + segment.radius * Math.cos(angle),
    y: segment.centre.y + segment.radius * Math.sin(angle),
  };
}

/** How far along the route its point nearest `point` lies. */
export function lengthAt(route: Route, point: Point): number {
  let best = { distance: Number.POSITIVE_INFINITY, length: 0 };
  for (const segment of route.segments) {
    let local: number;
    if (segment.kind === 'line') {
      const dx = segment.b.x - segment.a.x;
      const dy = segment.b.y - segment.a.y;
      const f =
        ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) /
        (dx * dx + dy * dy);
      local = Math.max(0, Math.min(1, f)) * segment.length;
    } else {
      const angle = Math.atan2(
        point.y - segment.centre.y,
        point.x - segment.centre.x,
      );
      let delta = (angle - segment.from) * Math.sign(segment.sweep);
      delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (delta > Math.abs(segment.sweep))
        delta =
          delta - Math.abs(segment.sweep) < 2 * Math.PI - delta
            ? Math.abs(segment.sweep)
            : 0;
      local = delta * segment.radius;
    }
    const at = pointAt(route, segment.start + local);
    const distance = Math.hypot(at.x - point.x, at.y - point.y);
    if (distance < best.distance - 1e-9)
      best = { distance, length: segment.start + local };
  }
  return best.length;
}

/** SVG path data for the part of the route between two lengths. */
export function slicePath(route: Route, from: number, to: number): string {
  const a = Math.max(0, from);
  const b = Math.min(route.length, to);
  const start = pointAt(route, a);
  let d = `M${round(start.x)} ${round(start.y)}`;
  for (const segment of route.segments) {
    const s0 = Math.max(a, segment.start);
    const s1 = Math.min(b, segment.start + segment.length);
    if (s1 <= s0) continue;
    const end = pointAt(route, s1);
    d +=
      segment.kind === 'line'
        ? `L${round(end.x)} ${round(end.y)}`
        : `A${segment.radius} ${segment.radius} 0 0 ${segment.sweep > 0 ? 1 : 0} ${round(end.x)} ${round(end.y)}`;
  }
  return d;
}

export interface Stretch {
  lane: Lane;
  from: number;
  to: number;
}

/**
 * The runs of the line inside each lane band, in order: the stretch each group owns. A run that
 * only passes through a band, with no station of that lane on it (the horizontal layout's drop
 * from the data service to the map crosses the Modeling band), belongs to the stretch it continues.
 */
export function laneStretches(layout: TransitLayout, route: Route): Stretch[] {
  const stations = layout.stations
    .filter((station) => ROUTE_ORDER.includes(station.key))
    .map((station) => ({ lane: station.lane, at: lengthAt(route, station) }));
  const owned = (stretch: Stretch) =>
    stations.some(
      (station) =>
        station.lane === stretch.lane &&
        station.at >= stretch.from &&
        station.at <= stretch.to,
    );
  const merged: Stretch[] = [];
  for (const stretch of bandRuns(layout, route)) {
    const previous = merged.at(-1);
    if (previous && (previous.lane === stretch.lane || !owned(stretch)))
      previous.to = stretch.to;
    else merged.push({ ...stretch });
  }
  return merged;
}

function bandRuns(layout: TransitLayout, route: Route): Stretch[] {
  const laneAt = (length: number) => {
    const point = pointAt(route, length);
    return layout.lanes.find(
      (band) =>
        point.y >= band.y &&
        point.y < band.y + band.height &&
        point.x >= band.x &&
        point.x <= band.x + band.width,
    )!.lane;
  };
  const step = 0.25;
  const stretches: Stretch[] = [];
  let current: Stretch = { lane: laneAt(0), from: 0, to: 0 };
  for (let length = step; length < route.length; length += step) {
    const lane = laneAt(length);
    if (lane === current.lane) continue;
    current.to = length - step / 2;
    stretches.push(current);
    current = { lane, from: current.to, to: 0 };
  }
  current.to = route.length;
  stretches.push(current);
  return stretches;
}

export interface TokenFrame {
  /** How much of the line is drawn. */
  line: number;
  stud: { length: number; point: Point };
  /** Null until the stud is a token gap past the model step. */
  hex: { length: number; point: Point } | null;
}

/** Where the line's head and both tokens are at `progress` (0–1) of the entrance. */
export function tokenFrame(
  layout: TransitLayout,
  route: Route,
  progress: number,
): TokenFrame {
  const map = layout.stations.find((station) => station.key === 'map')!;
  const end = lengthAt(route, map) - layout.restBefore;
  const step = lengthAt(route, layout.modelStep);
  const line = easeCamera(Math.max(0, Math.min(1, progress))) * route.length;
  const stud = Math.min(line, end);
  const hex = stud - layout.tokenGap;
  return {
    line,
    stud: { length: stud, point: pointAt(route, stud) },
    hex: hex >= step ? { length: hex, point: pointAt(route, hex) } : null,
  };
}

/* ---------- label boxes (for the clearance test and the art's own checks) ---------- */

/** Figtree's average advance at the labels' weights, as a share of the font size (generous). */
export const CHAR_EM = 0.56;

export interface LabelBox {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function box(layout: TransitLayout, key: string, label: Label): LabelBox {
  const longest = Math.max(...label.lines.map((line) => line.length));
  const along = longest * layout.fontSize * CHAR_EM;
  const ascent = layout.fontSize * 0.78;
  const descent = layout.fontSize * 0.24;
  const across =
    ascent + descent + (label.lines.length - 1) * layout.lineHeight;
  if (label.rotate) {
    // Upright text reads bottom to top, centred on y; its baseline is at x.
    return {
      key,
      x: label.x - ascent,
      y: label.y - along / 2,
      w: across,
      h: along,
    };
  }
  const left =
    label.anchor === 'start'
      ? label.x
      : label.anchor === 'middle'
        ? label.x - along / 2
        : label.x - along;
  return { key, x: left, y: label.y - ascent, w: along, h: across };
}

/** Every label's box: lane names, stations and the model step (with its hex glyph). */
export function labelBoxes(layout: TransitLayout): LabelBox[] {
  const step = box(layout, 'model step', layout.modelStepLabel);
  const glyph = layout.modelStepLabel.glyph;
  const left = Math.min(step.x, glyph.x - 8);
  return [
    ...layout.lanes.map((band, index) =>
      box(layout, `lane ${band.lane} ${index}`, band.name),
    ),
    ...layout.stations.map((station) =>
      box(layout, station.key, station.label),
    ),
    { ...step, x: left, w: step.x + step.w - left },
  ];
}
