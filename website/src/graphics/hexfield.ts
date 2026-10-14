/** Canvas renderer for coarsened H3 surfaces and measured surveys (site redesign spec §3, §4.1 H1,
 * §4.2 P2, §6.1; #454).
 *
 * Measured and modeled are separate passes with separate marks (AGENTS.md: observations and
 * surfaces are never conflated):
 *
 *   land     every area's footprint, no value                      (--enc-land)
 *   surface  modeled: VSUP by evidence tier; evidence: tier colour  (encoding.ts)
 *   hatch    `unknown` areas on every layer: no number             (--enc-hatch)
 *   prior    `prior_dominated` areas: dots, where an artifact has them
 *   studs    measured surveys, white with a void ring, sized by AN, drawn last (small to large,
 *            like the poster: a shared place reads as its best-sampled survey's stud)
 *
 * A stud is never coloured by the surface ramp and never morphs into a cell. The canvas draws no
 * text; labels and readouts are HTML or SVG over it. Back faces and offscreen areas are culled,
 * the pixel ratio is capped at 2 (1 after a slow-frame probe), and every draw is timed so a figure
 * can fall back to its poster (spec §4.1, phone cost fallback).
 */

import {
  ENC,
  STUD_PAINT_ORDER,
  STUD_RADIUS,
  STUD_RING,
  evidenceColor,
  priorColors,
  studSize,
  vsupColor,
  type StudSize,
} from './encoding';
import type { Area, Survey } from './figure-data';
import { spherePoint, type Projection, type SpherePoint } from './projection';
import { mulberry32 } from './rng';

export type HexLayer = 'measured' | 'modeled' | 'evidence';

export type HexHit =
  | { type: 'surveys'; surveys: Survey[]; x: number; y: number }
  | { type: 'area'; area: Area; x: number; y: number };

export interface HexFieldOptions {
  areas: readonly Area[];
  surveys: readonly Survey[];
  projection: Projection;
  /** The artifact's posterior-mean domain (`metric_domains.post_mean`). */
  domain: readonly [number, number];
  layer?: HexLayer;
  /** Draw the globe disc, limb and (optionally) graticule. Orthographic only. */
  globe?: boolean;
  graticule?: boolean;
  /** Set the projection's scale and translate for a canvas of this CSS size. */
  fit?(width: number, height: number, projection: Projection): void;
  /** An extra outline for an area (threshold maps): solid, dashed, or none. */
  areaOutline?(area: Area): 'solid' | 'dashed' | null;
  dprCap?: number;
  /**
   * Stud size for a canvas of this CSS size, as a share of STUD_RADIUS (default 1). A small
   * stage's studs shrink with its disc, so they read as points rather than merging into blobs; the
   * 1.5 px void ring and the 9 px hit radius stay as they are.
   */
  studScale?(width: number, height: number): number;
}

/** Entrance progress per pass, each 0…1 (1 = fully drawn). */
export interface Reveal {
  land: number;
  studs: number;
  surface: number;
  hatch: number;
}

/** Median of the last `size` frame times. */
export class FrameProbe {
  private readonly samples: number[] = [];
  constructor(private readonly size = 10) {}
  record(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
  }
  get full(): boolean {
    return this.samples.length >= this.size;
  }
  median(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }
}

/** Stud hit radius in CSS px (spec §4.1: nearest stud within 9 px, then the cell). */
export const STUD_HIT_PX = 9;

const OCEAN = ['#071831', '#020712'] as const;
const LIMB = 'rgb(112 230 255 / 28%)';
const GRATICULE = 'rgb(165 185 211 / 7%)';
const EDGE = 'rgb(2 7 18 / 85%)';
const FOCUS = '#70e6ff';

interface AreaGeometry {
  area: Area;
  vertices: SpherePoint[];
  center: SpherePoint;
  /** Entrance order, 0…1: nearest the evidence first. */
  order: number;
}

interface SurveyGeometry {
  survey: Survey;
  point: SpherePoint;
  size: StudSize;
  order: number;
}

interface Visible {
  area: Area;
  xy: Float64Array;
}

export class HexField {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly projection: Projection;
  readonly probe = new FrameProbe();
  layer: HexLayer;
  /** The layer cross-fading out, and how far the new one has faded in (0…1). */
  private fade: { from: HexLayer; amount: number } | null = null;
  reveal: Reveal = { land: 1, studs: 1, surface: 1, hatch: 1 };
  hover: HexHit | null = null;
  pinned: HexHit | null = null;
  graticule: boolean;
  /** The studs' share of STUD_RADIUS at the current size (options.studScale). */
  studScale = 1;
  width = 0;
  height = 0;
  private dpr = 1;
  private dprCap: number;
  private readonly options: HexFieldOptions;
  private readonly areas: AreaGeometry[];
  private readonly surveys: SurveyGeometry[];
  private visibleAreas: Visible[] = [];
  private visibleSurveys: { geometry: SurveyGeometry; x: number; y: number }[] =
    [];
  private hatchPattern: CanvasPattern | null = null;

  constructor(canvas: HTMLCanvasElement, options: HexFieldOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.options = options;
    this.projection = options.projection;
    this.layer = options.layer ?? 'modeled';
    this.graticule = options.graticule ?? Boolean(options.globe);
    this.dprCap = options.dprCap ?? 2;

    const reach = Math.max(
      1,
      ...options.areas
        .filter((area) => area.support !== 'unknown')
        .map((area) => area.distanceKm),
    );
    this.areas = options.areas.map((area) => ({
      area,
      vertices: area.boundary.map(([lon, lat]) => spherePoint(lon, lat)),
      center: spherePoint(area.center[0], area.center[1]),
      order:
        area.support === 'unknown' ? 1 : Math.min(1, area.distanceKm / reach),
    }));
    // Surveys land west to east with a seeded jitter.
    const random = mulberry32();
    const lons = options.surveys.map((survey) => survey.lon);
    const [west, east] = [Math.min(...lons), Math.max(...lons)];
    this.surveys = options.surveys.map((survey) => ({
      survey,
      point: spherePoint(survey.lon, survey.lat),
      size: studSize(survey.an),
      order: Math.min(
        1,
        Math.max(
          0,
          (survey.lon - west) / (east - west || 1) + (random() - 0.5) * 0.12,
        ),
      ),
    }));
    this.resize();
  }

  /** Match the canvas to its CSS box; re-fit the projection; redraw. */
  resize(): void {
    this.dpr = Math.min(this.dprCap, globalThis.devicePixelRatio || 1);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.studScale = this.options.studScale?.(this.width, this.height) ?? 1;
    if (this.options.fit)
      this.options.fit(this.width, this.height, this.projection);
    else {
      this.projection.scale = (Math.min(this.width, this.height) / 2) * 0.92;
      this.projection.translate = [this.width / 2, this.height / 2];
    }
    this.hatchPattern = this.makeHatch();
    this.draw();
  }

  /** Lower the pixel-ratio cap (the slow-frame fallback) and redraw. */
  capPixelRatio(cap: number): void {
    this.dprCap = cap;
    this.resize();
  }

  /** Switch layer; `amount` (0…1) cross-fades from the previous one. Call with 1 to finish. */
  setLayer(layer: HexLayer, amount = 1): void {
    if (layer !== this.layer) {
      this.fade = { from: this.layer, amount };
      this.layer = layer;
    } else if (this.fade) this.fade.amount = amount;
    if (this.fade && this.fade.amount >= 1) this.fade = null;
    this.draw();
  }

  private makeHatch(): CanvasPattern | null {
    // 45° strokes 1.4 px wide on a 5 px pitch (spec §2.2), drawn at the device pixel ratio.
    const tile = ENC.hatchPitch * Math.SQRT2;
    const size = Math.max(1, Math.round(tile * this.dpr));
    const pattern = document.createElement('canvas');
    pattern.width = size;
    pattern.height = size;
    const g = pattern.getContext('2d');
    if (!g) return null;
    g.strokeStyle = ENC.hatch;
    g.globalAlpha = ENC.hatchAlpha;
    g.lineWidth = ENC.hatchWidth * this.dpr;
    g.lineCap = 'square';
    g.beginPath();
    for (const offset of [-size, 0, size]) {
      g.moveTo(offset, size);
      g.lineTo(offset + size, 0);
    }
    g.stroke();
    const result = this.ctx.createPattern(pattern, 'repeat');
    result?.setTransform(new DOMMatrix().scale(1 / this.dpr));
    return result;
  }

  private projectRing(geometry: AreaGeometry): Float64Array | null {
    const xy = new Float64Array(geometry.vertices.length * 2);
    const limit = this.projection.kind === 'orthographic' ? 0.02 : -0.9;
    let outside = 0;
    for (let index = 0; index < geometry.vertices.length; index += 1) {
      const [x, y, cosc] = this.projection.projectPoint(
        geometry.vertices[index],
      );
      if (cosc < limit) return null;
      xy[index * 2] = x;
      xy[index * 2 + 1] = y;
      if (x < -20 || x > this.width + 20 || y < -20 || y > this.height + 20)
        outside += 1;
    }
    return outside === geometry.vertices.length ? null : xy;
  }

  private path(xy: Float64Array): void {
    const g = this.ctx;
    g.beginPath();
    g.moveTo(xy[0], xy[1]);
    for (let index = 2; index < xy.length; index += 2)
      g.lineTo(xy[index], xy[index + 1]);
    g.closePath();
  }

  private surfaceFill(area: Area, layer: HexLayer): string | null {
    if (area.support === 'unknown' || area.mean === null) return null;
    if (layer === 'measured') return ENC.land;
    // An area with support but a median distance past 2ρ still has a value: draw it weak.
    const evidence = area.tier === 'none' ? 'weak' : area.tier;
    return layer === 'evidence'
      ? evidenceColor(evidence)
      : vsupColor(area.mean, evidence, this.options.domain);
  }

  private alphaFor(order: number, progress: number, spread = 0.35): number {
    if (progress >= 1) return 1;
    return Math.max(0, Math.min(1, (progress * (1 + spread) - order) / spread));
  }

  /** Draw every pass at the current reveal, layer, hover and pin. */
  draw(): void {
    const started = performance.now();
    const g = this.ctx;
    const { projection } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.width, this.height);
    g.globalAlpha = 1;

    const globe = this.options.globe && projection.kind === 'orthographic';
    const [cx, cy] = projection.translate;
    if (globe) {
      const radius = projection.scale;
      const ocean = g.createRadialGradient(
        cx - radius * 0.3,
        cy - radius * 0.35,
        radius * 0.1,
        cx,
        cy,
        radius,
      );
      ocean.addColorStop(0, OCEAN[0]);
      ocean.addColorStop(1, OCEAN[1]);
      g.beginPath();
      g.arc(cx, cy, radius, 0, Math.PI * 2);
      g.fillStyle = ocean;
      g.fill();
      if (this.graticule) this.drawGraticule();
    }

    // Pass 1: the model grid's footprint (no values).
    this.visibleAreas = [];
    g.lineJoin = 'round';
    g.globalAlpha = this.reveal.land;
    g.fillStyle = ENC.land;
    for (const geometry of this.areas) {
      const xy = this.projectRing(geometry);
      if (!xy) continue;
      this.visibleAreas.push({ area: geometry.area, xy });
      this.path(xy);
      g.fill();
    }

    // Pass 2: the modeled surface, appearing outward from the evidence.
    const layers: [HexLayer, number][] = this.fade
      ? [
          [this.fade.from, 1],
          [this.layer, this.fade.amount],
        ]
      : [[this.layer, 1]];
    const byArea = new Map(
      this.areas.map((geometry) => [geometry.area, geometry]),
    );
    for (const [layer, layerAlpha] of layers) {
      if (layer === 'measured' && layers.length === 1) continue;
      for (const { area, xy } of this.visibleAreas) {
        const fill = this.surfaceFill(area, layer);
        if (fill === null) continue;
        const alpha =
          layer === 'measured'
            ? layerAlpha
            : layerAlpha *
              this.alphaFor(byArea.get(area)!.order, this.reveal.surface);
        if (alpha <= 0) continue;
        g.globalAlpha = alpha;
        g.fillStyle = fill;
        this.path(xy);
        g.fill();
      }
    }

    // Pass 3: no estimate. Hatch on every layer, never a colour.
    if (this.hatchPattern && this.reveal.hatch > 0) {
      g.globalAlpha = this.reveal.hatch;
      g.fillStyle = this.hatchPattern;
      for (const { area, xy } of this.visibleAreas) {
        if (area.support !== 'unknown') continue;
        this.path(xy);
        g.fill();
      }
    }

    // Pass 4: mostly prior. Dots in the area's own colour on this layer (its VSUP colour on
    // Modeled, its evidence colour on Evidence), on a 46% base. The Measured layer draws no
    // modeled value, so it draws no dots either (spec §2.2, §4.1 layers).
    for (const { area, xy } of this.layer === 'measured'
      ? []
      : this.visibleAreas) {
      if (area.support !== 'prior_dominated') continue;
      const base = this.surfaceFill(area, this.layer);
      if (base === null) continue;
      const { light } = priorColors(base);
      g.save();
      this.path(xy);
      g.clip();
      g.globalAlpha = ENC.priorBaseAlpha * this.reveal.surface;
      g.fillStyle = base;
      g.fill();
      g.globalAlpha = this.reveal.surface;
      g.fillStyle = light;
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let index = 0; index < xy.length; index += 2) {
        minX = Math.min(minX, xy[index]);
        maxX = Math.max(maxX, xy[index]);
        minY = Math.min(minY, xy[index + 1]);
        maxY = Math.max(maxY, xy[index + 1]);
      }
      for (let y = minY + 2; y < maxY; y += 4)
        for (let x = minX + 2; x < maxX; x += 4) {
          g.beginPath();
          g.arc(x, y, 0.9, 0, Math.PI * 2);
          g.fill();
        }
      g.restore();
    }

    // Hairline gaps between areas, then outlines a figure asked for.
    g.globalAlpha = this.reveal.land;
    g.strokeStyle = EDGE;
    g.lineWidth = 0.7;
    for (const { xy } of this.visibleAreas) {
      this.path(xy);
      g.stroke();
    }
    g.globalAlpha = 1;
    if (this.options.areaOutline) {
      g.strokeStyle = FOCUS;
      g.lineWidth = 1.3;
      for (const { area, xy } of this.visibleAreas) {
        const outline = this.options.areaOutline(area);
        if (!outline) continue;
        g.setLineDash(outline === 'dashed' ? [3, 2.5] : []);
        this.path(xy);
        g.stroke();
      }
      g.setLineDash([]);
    }
    for (const hit of [this.pinned, this.hover]) {
      if (hit?.type !== 'area') continue;
      const visible = this.visibleAreas.find(
        (entry) => entry.area === hit.area,
      );
      if (!visible) continue;
      g.strokeStyle = FOCUS;
      g.lineWidth = 1.6;
      this.path(visible.xy);
      g.stroke();
    }

    // Pass 5: measured surveys, always on top, always the same mark: a white disc on a void disc
    // STUD_RING wider (the glyph and the poster draw it the same way). One size class at a time,
    // small to large, rings before discs: surveys at one place read as the largest white stud,
    // and studs of one size merge instead of ringing each other.
    this.visibleSurveys = [];
    const marks: Record<
      StudSize,
      { x: number; y: number; r: number; alpha: number }[]
    > = { sm: [], md: [], lg: [] };
    for (const geometry of this.surveys) {
      const [x, y, cosc] = projection.projectPoint(geometry.point);
      if (cosc < (projection.kind === 'orthographic' ? 0.05 : -0.9)) continue;
      if (x < -10 || x > this.width + 10 || y < -10 || y > this.height + 10)
        continue;
      const alpha = this.alphaFor(geometry.order, this.reveal.studs, 0.25);
      if (alpha <= 0) continue;
      this.visibleSurveys.push({ geometry, x, y });
      const r =
        STUD_RADIUS[geometry.size] * this.studScale * (0.4 + 0.6 * alpha);
      marks[geometry.size].push({ x, y, r, alpha });
    }
    for (const size of STUD_PAINT_ORDER)
      for (const [fill, grow] of [
        [OCEAN[1], STUD_RING],
        [ENC.obs, 0],
      ] as const) {
        g.fillStyle = fill;
        for (const { x, y, r, alpha } of marks[size]) {
          g.globalAlpha = alpha;
          g.beginPath();
          g.arc(x, y, r + grow, 0, Math.PI * 2);
          g.fill();
        }
      }
    g.globalAlpha = 1;
    for (const hit of [this.pinned, this.hover]) {
      if (hit?.type !== 'surveys') continue;
      g.beginPath();
      g.arc(hit.x, hit.y, STUD_RADIUS.lg * this.studScale + 4, 0, Math.PI * 2);
      g.strokeStyle = FOCUS;
      g.lineWidth = 1.5;
      g.stroke();
    }

    if (globe) {
      g.beginPath();
      g.arc(cx, cy, projection.scale + 0.5, 0, Math.PI * 2);
      g.strokeStyle = LIMB;
      g.lineWidth = 1;
      g.stroke();
    }
    this.probe.record(performance.now() - started);
  }

  private drawGraticule(): void {
    const g = this.ctx;
    g.strokeStyle = GRATICULE;
    g.lineWidth = 0.8;
    const line = (points: [number, number][]) => {
      g.beginPath();
      let pen = false;
      for (const [lon, lat] of points) {
        const [x, y, cosc] = this.projection.project(lon, lat);
        if (cosc < 0) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(x, y);
        else g.moveTo(x, y);
        pen = true;
      }
      g.stroke();
    };
    for (let lon = -180; lon < 180; lon += 30) {
      const points: [number, number][] = [];
      for (let lat = -80; lat <= 80; lat += 4) points.push([lon, lat]);
      line(points);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const points: [number, number][] = [];
      for (let lon = -180; lon <= 180; lon += 4) points.push([lon, lat]);
      line(points);
    }
  }

  /** What is under a CSS-pixel point: every stud within 9 px (nearest first), else the area. */
  hit(x: number, y: number): HexHit | null {
    const near = this.visibleSurveys
      .map((entry) => ({
        entry,
        distance: Math.hypot(entry.x - x, entry.y - y),
      }))
      .filter(({ distance }) => distance <= STUD_HIT_PX)
      .sort((a, b) => a.distance - b.distance);
    if (near.length > 0) {
      const [{ entry }] = near;
      return {
        type: 'surveys',
        surveys: near.map(({ entry: { geometry } }) => geometry.survey),
        x: entry.x,
        y: entry.y,
      };
    }
    for (const { area, xy } of this.visibleAreas)
      if (contains(xy, x, y)) {
        const [cx, cy] = this.projection.project(
          area.center[0],
          area.center[1],
        );
        return { type: 'area', area, x: cx, y: cy };
      }
    return null;
  }

  /** Areas currently drawn (after culling), for tables and keyboard reticles. */
  get drawnAreas(): readonly Area[] {
    return this.visibleAreas.map(({ area }) => area);
  }
}

/** Even-odd point-in-polygon on a flat [x0, y0, x1, y1, …] ring. */
export function contains(xy: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const count = xy.length / 2;
  for (let index = 0, previous = count - 1; index < count; previous = index++) {
    const [xi, yi] = [xy[index * 2], xy[index * 2 + 1]];
    const [xj, yj] = [xy[previous * 2], xy[previous * 2 + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
