/** The transit line's route geometry (site redesign spec §4.3 C2, #454): a polyline with filleted
 * corners, points and lengths along it, and where the two tokens ride at each moment of the
 * entrance. Pure and small: the page's island imports only this module, and the server render
 * hands it each layout's corner points and token plan (`transit-route.ts`).
 */

import { easeCamera } from '../../graphics/tween';

export interface Point {
  x: number;
  y: number;
}

/** The line draws, and the stud rides its head, over this long (spec §4.3 C2). */
export const TRANSIT_MS = 2400;

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

/** What the entrance needs from a layout, computed once on the server. */
export interface TokenPlan {
  /** The line's corner points and their fillet radius. */
  points: Point[];
  corner: number;
  /** Where the model step falls along the line: the hex joins from here. */
  step: number;
  /** Where the stud comes to rest, before the map station. */
  end: number;
  /** The hex travels this far behind the stud. */
  gap: number;
}

export interface TokenFrame {
  /** How much of the line is drawn. */
  line: number;
  stud: { length: number; point: Point };
  /** Null until the stud is a token gap past the model step. */
  hex: { length: number; point: Point } | null;
}

/** Where the line's head and both tokens are at `progress` (0–1) of the entrance. */
export function tokenAt(
  route: Route,
  plan: Pick<TokenPlan, 'step' | 'end' | 'gap'>,
  progress: number,
): TokenFrame {
  const line = easeCamera(Math.max(0, Math.min(1, progress))) * route.length;
  const stud = Math.min(line, plan.end);
  const hex = stud - plan.gap;
  return {
    line,
    stud: { length: stud, point: pointAt(route, stud) },
    hex: hex >= plan.step ? { length: hex, point: pointAt(route, hex) } : null,
  };
}
