/** The Project HbS threshold map (site redesign spec §4.2, HbS, §6; #454).
 *
 * The real HbS (rs334) v3 surface, coarsened to res 3 for a window from West Africa to India, in a
 * Lambert azimuthal equal-area projection (so an area's share of the map is its share of the
 * Earth), with the measured surveys as studs. A threshold slider outlines the areas above t:
 *
 *   confidently above   the area's lowest child q025 ≥ t: its whole range clears t (solid)
 *   possibly above      its mean ≥ t but its range does not clear t (dashed)
 *   no estimate         `unknown` support: hatched, never outlined, never counted
 *
 * The outlines are drawn as contours around each set (edges with the set on one side only), so a
 * solid line rings the confident areas inside a dashed line ringing every area whose estimate is
 * above t: the uncertainty-aware threshold a screening programme would use. Nothing is fitted
 * here; every number comes from the pinned, coarsened figure data.
 *
 * Measured and modeled stay apart: the surface and the studs are two HexFields on two canvases,
 * the contours sit between them, and the studs, white and sized by AN, are drawn last.
 *
 * The pure helpers at the top have no DOM and are unit-tested; `initHbsMap` is the island.
 */

import { FigureController, createAnnouncer } from '../../graphics/figure';
import {
  decodeAreas,
  decodeSurveys,
  type Area,
  type Survey,
} from '../../graphics/figure-data';
import { HexField, type HexHit } from '../../graphics/hexfield';
import { linear, tween, type Tween } from '../../graphics/tween';
import {
  lambertAzimuthal,
  spherePoint,
  type LambertAzimuthal,
  type LonLat,
  type Projection,
  type SpherePoint,
} from '../../graphics/projection';

/** Slider stops in percent (spec §4.2: 1–15%, step 1). */
export const THRESHOLD_STOPS: readonly number[] = Array.from(
  { length: 15 },
  (_, index) => index + 1,
);
/**
 * The resting threshold. Spec §4.2 first set 10%, but with the conservative coarsening (an area's
 * range runs from its lowest child q025) no area clears 10% with its whole range, so the solid
 * "confidently above" outline and its legend key showed nothing at rest. At 5% both outlines show
 * real areas: 274 confidently above, 648 possibly (site redesign integration, 2026-10-14).
 */
export const DEFAULT_THRESHOLD = 5;
/** The projection centre (spec §4.2: 35°E, 10°N). */
export const MAP_CENTER: LonLat = [35, 10];

export type OutlineKind = 'confident' | 'possible';

/** Which outline an area gets at threshold `t` (a share, 0…1); null for none. */
export function classifyArea(area: Area, t: number): OutlineKind | null {
  if (area.support === 'unknown' || area.mean === null || area.lo === null)
    return null;
  if (area.lo >= t) return 'confident';
  if (area.mean >= t) return 'possible';
  return null;
}

export interface ThresholdCounts {
  confident: number;
  possible: number;
}

export function thresholdCounts(
  areas: readonly Area[],
  t: number,
): ThresholdCounts {
  const counts: ThresholdCounts = { confident: 0, possible: 0 };
  for (const area of areas) {
    const kind = classifyArea(area, t);
    if (kind) counts[kind] += 1;
  }
  return counts;
}

const whole = (value: number) => Math.round(value).toLocaleString('en-US');

/**
 * The live count's two clauses (copy deck: "{n} confidently above · {m} possibly above"). Each is
 * set unbroken, so the count wraps only at the " · ".
 */
export const countParts = ({
  confident,
  possible,
}: ThresholdCounts): [string, string] => [
  `${whole(confident)} confidently above`,
  `${whole(possible)} possibly above`,
];

/** The slider's spoken value (spec §4.2). */
export const valueText = (
  stop: number,
  { confident, possible }: ThresholdCounts,
) =>
  `${stop} percent: ${whole(confident)} areas confidently above, ${whole(possible)} possibly above`;

/** A share as a number of percent, as the Home hero writes it: whole from 10%, one decimal from 1%,
 * two below. */
export function formatPercent(share: number): string {
  const value = share * 100;
  if (value === 0) return '0';
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(value >= 1 ? 1 : 2);
}

const km = (value: number) => `${whole(value)} km`;
const counts = (survey: Survey) => `${whole(survey.ac)} of ${whole(survey.an)}`;

/**
 * The readout for what is under the pointer or reticle, word for word as the Home hero's (copy
 * deck): an area's estimate with its 95% range and its distance from surveys, a survey's counts,
 * or "No estimate". A coarsened area carries its children's median distance, so every distance
 * is "about": a minority child can sit nearer a survey.
 */
export function describeHit(hit: HexHit | null): string | null {
  if (!hit) return null;
  if (hit.type === 'surveys') {
    const [first] = hit.surveys;
    if (hit.surveys.length === 1)
      return `Measured survey · ${counts(first)} alleles carry HbS · Location within ±${km(first.radiusKm)}`;
    const listed = hit.surveys
      .slice(0, 3)
      .map((survey, index) => counts(survey) + (index ? '' : ' alleles'));
    return [
      `${hit.surveys.length} surveys here`,
      ...listed,
      ...(hit.surveys.length > 3 ? ['…'] : []),
    ].join(' · ');
  }
  const { area } = hit;
  if (area.support === 'unknown' || area.mean === null)
    return `No estimate · — · Nearest survey about ${km(area.distanceKm)}`;
  const line = `Modeled estimate about ${formatPercent(area.mean)}% · 95% credible range across this area ${formatPercent(area.lo!)}–${formatPercent(area.hi!)}% · Nearest survey about ${km(area.distanceKm)}`;
  return area.tier === 'weak' || area.tier === 'none'
    ? `${line}. Far from surveys: this range leans on the model’s assumptions.`
    : line;
}

/** Whether two hits read out the same: one area, or the same studs, nearest first. */
export function sameHit(a: HexHit | null, b: HexHit | null): boolean {
  if (!a || !b) return a === b;
  if (a.type === 'area') return b.type === 'area' && a.area === b.area;
  return (
    b.type === 'surveys' &&
    a.surveys.length === b.surveys.length &&
    a.surveys.every((survey, index) => survey === b.surveys[index])
  );
}

/* ---------- contours ---------- */

/** One shared or outer edge of the coarsened grid: its two ends and the one or two areas it bounds. */
export interface GridEdge {
  a: SpherePoint;
  b: SpherePoint;
  /** Vertex keys (centi-degrees), shared by every edge that meets there. */
  ka: string;
  kb: string;
  left: number;
  right: number;
}

/** Index every area edge once. Neighbouring H3 cells share exact vertices, so keys match. */
export function gridEdges(areas: readonly Area[]): GridEdge[] {
  const key = ([lon, lat]: [number, number]) =>
    `${Math.round(lon * 100)},${Math.round(lat * 100)}`;
  const byKey = new Map<string, GridEdge>();
  areas.forEach((area, index) => {
    const ring = area.boundary;
    for (let k = 0; k < ring.length; k += 1) {
      const p = ring[k];
      const q = ring[(k + 1) % ring.length];
      const [kp, kq] = [key(p), key(q)];
      if (kp === kq) continue;
      const id = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const edge = byKey.get(id);
      if (edge) edge.right = index;
      else
        byKey.set(id, {
          a: spherePoint(p[0], p[1]),
          b: spherePoint(q[0], q[1]),
          ka: kp,
          kb: kq,
          left: index,
          right: -1,
        });
    }
  });
  return [...byKey.values()];
}

/** Edges with the set on exactly one side: the set's outline. */
export function contour(
  edges: readonly GridEdge[],
  inSet: (index: number) => boolean,
): GridEdge[] {
  return edges.filter(
    (edge) => inSet(edge.left) !== (edge.right !== -1 && inSet(edge.right)),
  );
}

/**
 * Join an outline's edges into continuous paths (end to end through shared vertices), so a dashed
 * line keeps its rhythm along the whole outline instead of restarting on every short edge.
 */
export function chains(edges: readonly GridEdge[]): SpherePoint[][] {
  const at = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    for (const key of [edge.ka, edge.kb])
      (at.get(key) ?? at.set(key, []).get(key)!).push(index);
  });
  const used = new Uint8Array(edges.length);
  const paths: SpherePoint[][] = [];
  for (let first = 0; first < edges.length; first += 1) {
    if (used[first]) continue;
    used[first] = 1;
    const edge = edges[first];
    const path: SpherePoint[] = [edge.a, edge.b];
    // Walk forward from b, then backward from a.
    for (const [end, prepend] of [
      [edge.kb, false],
      [edge.ka, true],
    ] as const) {
      let key = end;
      for (;;) {
        const next = (at.get(key) ?? []).find((index) => !used[index]);
        if (next === undefined) break;
        used[next] = 1;
        const step = edges[next];
        const [point, other] =
          step.ka === key ? [step.b, step.kb] : [step.a, step.ka];
        if (prepend) path.unshift(point);
        else path.push(point);
        key = other;
      }
    }
    paths.push(path);
  }
  return paths;
}

/* ---------- the island ---------- */

/** The surface's metric domain (`metric_domains.post_mean`), from the server-rendered map. */
function readDomain(map: HTMLElement): [number, number] | null {
  const { hbsDomain } = map.dataset;
  return hbsDomain ? (JSON.parse(hbsDomain) as [number, number]) : null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const ENTRANCE = 1200;
const STEP_PX = 16;
const CASING = 'rgb(2 7 18 / 88%)';
const CONTOUR = '#70e6ff';
/** The threshold outlines, CSS px (the legend's keys in projects.css match). */
export const OUTLINE = {
  confident: { width: 2.6, casing: 5.4 },
  possible: { width: 1.8, casing: 4.2, dash: [6, 4] },
} as const;

/**
 * How much smaller studs draw than the kit's size, by the map's width in CSS px: full size from
 * 960 px, down to 60% on a phone. Their three AN sizes keep their proportions.
 */
export function studScale(mapWidth: number): number {
  return Math.min(1, Math.max(0.6, mapWidth / 960));
}

/** The map's margin around the window, as a share of its width. */
const WINDOW_PAD = 0.03;

/** Surveys the map shows: inside the window's projected extent, on the near hemisphere. */
export function surveyWindow(
  areas: readonly Area[],
): (survey: Survey) => boolean {
  const bounds = unitBounds(areas);
  const pad = WINDOW_PAD * (bounds.maxX - bounds.minX);
  const unit = lambertAzimuthal({
    center: MAP_CENTER,
    scale: 1,
    translate: [0, 0],
  });
  return (survey) => {
    const [x, y, cosc] = unit.project(survey.lon, survey.lat);
    return (
      cosc > 0 &&
      x >= bounds.minX - pad &&
      x <= bounds.maxX + pad &&
      y >= bounds.minY - pad &&
      y <= bounds.maxY + pad
    );
  };
}

/** Dev captures hold the entrance at `?t=<ms>` (FigureController's freeze hook). */
function frozenAt(): number | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(location.search).get('t');
  const t = value === null ? NaN : Number(value);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

async function bytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

/** The window's extent in a unit projection, for fitting it to any canvas size. */
export function unitBounds(areas: readonly Area[]) {
  const unit = lambertAzimuthal({
    center: MAP_CENTER,
    scale: 1,
    translate: [0, 0],
  });
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const area of areas)
    for (const [lon, lat] of area.boundary) {
      const [x, y] = unit.project(lon, lat);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  return { minX, minY, maxX, maxY };
}

export async function initHbsMap(
  figure: HTMLElement,
  urls: { region: string; surveys: string },
): Promise<void> {
  const stage = figure.querySelector<HTMLElement>('[data-hbs-map]');
  const domain = stage ? readDomain(stage) : null;
  const surfaceCanvas = figure.querySelector<HTMLCanvasElement>(
    '[data-hbs-canvas="surface"]',
  );
  const studCanvas = figure.querySelector<HTMLCanvasElement>(
    '[data-hbs-canvas="studs"]',
  );
  const reticle = figure.querySelector<HTMLElement>('[data-hbs-reticle]');
  const slider = figure.querySelector<HTMLInputElement>('[data-hbs-slider]');
  const threshold = figure.querySelector<HTMLElement>('[data-hbs-threshold]');
  const count = figure.querySelector<HTMLElement>('[data-hbs-count]');
  const readout = figure.querySelector<HTMLElement>('[data-readout]');
  if (
    !domain ||
    !stage ||
    !surfaceCanvas ||
    !studCanvas ||
    !reticle ||
    !slider ||
    !threshold ||
    !count ||
    !readout
  )
    return;

  const [regionBytes, surveyBytes] = await Promise.all([
    bytes(urls.region),
    bytes(urls.surveys),
  ]);
  const areas = decodeAreas(regionBytes);
  const bounds = unitBounds(areas);
  const pad = WINDOW_PAD * (bounds.maxX - bounds.minX);
  // Surveys outside the window would be culled by the canvas anyway; leave them out of the hit
  // test too.
  const surveys = decodeSurveys(surveyBytes).filter(surveyWindow(areas));

  const projection: LambertAzimuthal = lambertAzimuthal({
    center: MAP_CENTER,
    scale: 1,
    translate: [0, 0],
  });
  // The studs draw on their own, larger canvas that CSS scales down to the map (studScale), so
  // ~850 surveys keep the kit's three sizes without burying the surface on a narrow map.
  const studProjection: LambertAzimuthal = lambertAzimuthal({
    center: MAP_CENTER,
    scale: 1,
    translate: [0, 0],
  });
  let scale = studScale(stage.clientWidth);
  const setStudScale = () => {
    scale = studScale(stage.clientWidth);
    stage.style.setProperty('--stud-scale', String(scale));
  };
  setStudScale();
  const fit = (width: number, height: number, target: Projection) => {
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const scale = Math.min(
      width / (spanX + 2 * pad),
      height / (spanY + 2 * pad),
    );
    target.scale = scale;
    target.translate = [
      width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
      height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
    ];
  };

  let t = Number(slider.value) / 100;
  let contourAlpha = 1;
  const edges = gridEdges(areas);
  let lines = {
    confident: [] as SpherePoint[][],
    possible: [] as SpherePoint[][],
  };
  const outline = () => {
    const kinds = areas.map((area) => classifyArea(area, t));
    lines = {
      // Every area whose estimate is above t (dashed), and inside it the confident core (solid).
      possible: chains(contour(edges, (index) => kinds[index] !== null)),
      confident: chains(
        contour(edges, (index) => kinds[index] === 'confident'),
      ),
    };
  };
  outline();

  const surface = new HexField(surfaceCanvas, {
    areas,
    surveys: [],
    projection,
    domain,
    layer: 'modeled',
    fit,
  });
  const studs = new HexField(studCanvas, {
    areas: [],
    surveys,
    projection: studProjection,
    domain,
    fit,
  });

  const drawContours = () => {
    if (contourAlpha <= 0) return;
    const g = surface.ctx;
    g.save();
    g.globalAlpha = contourAlpha;
    g.lineCap = 'round';
    const stroke = (
      paths: SpherePoint[][],
      width: number,
      colour: string,
      dash: readonly number[],
    ) => {
      g.beginPath();
      for (const path of paths)
        path.forEach((point, index) => {
          const [x, y] = projection.projectPoint(point);
          if (index) g.lineTo(x, y);
          else g.moveTo(x, y);
        });
      g.setLineDash([...dash]);
      g.lineWidth = width;
      g.strokeStyle = colour;
      g.stroke();
    };
    // A dark casing keeps the ion line legible on the lightest cells and parts it from the cells'
    // own borders; the lines are as heavy as the legend's keys draw them (design review, round 1).
    // No fill lift: lightening the selected cells would shift their colour up the frequency ramp.
    g.lineJoin = 'round';
    stroke(lines.possible, OUTLINE.possible.casing, CASING, []);
    stroke(lines.confident, OUTLINE.confident.casing, CASING, []);
    stroke(
      lines.possible,
      OUTLINE.possible.width,
      CONTOUR,
      OUTLINE.possible.dash,
    );
    stroke(lines.confident, OUTLINE.confident.width, CONTOUR, []);
    g.restore();
  };
  const redraw = () => {
    surface.draw();
    drawContours();
    studs.draw();
  };
  new ResizeObserver(() => {
    setStudScale();
    surface.resize();
    drawContours();
    studs.resize();
    placeReticle();
  }).observe(stage);

  /* ----- readout: pointer, tap and keyboard reticle ----- */
  const idle = readout.textContent ?? '';
  const announce = createAnnouncer(readout);
  let reticleAt: [number, number] | null = null;
  // A pointer moving inside one area or stud cluster changes nothing: skip the redraw and the
  // announcement (a full redraw costs several ms, and a phone runs it four times slower).
  let shown: HexHit | null = null;
  const show = (hit: HexHit | null) => {
    if (sameHit(hit, shown)) return;
    shown = hit;
    surface.hover = hit?.type === 'area' ? hit : null;
    studs.hover = hit?.type === 'surveys' ? hit : null;
    redraw();
    announce(describeHit(hit) ?? idle);
  };
  const hitAt = (x: number, y: number): HexHit | null =>
    studs.hit(x / scale, y / scale) ?? surface.hit(x, y);
  const local = (event: PointerEvent): [number, number] => {
    const box = surfaceCanvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  stage.addEventListener('pointermove', (event) =>
    show(hitAt(...local(event))),
  );
  stage.addEventListener('pointerdown', (event) =>
    show(hitAt(...local(event))),
  );
  stage.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && !reticleAt) show(null);
  });

  const centre = (): [number, number] => {
    const [x, y] = projection.project(...MAP_CENTER);
    return [x, y];
  };
  function placeReticle() {
    if (!reticleAt) {
      reticle!.hidden = true;
      return;
    }
    reticle!.hidden = false;
    reticle!.style.transform = `translate(${reticleAt[0]}px, ${reticleAt[1]}px)`;
  }
  const moveReticle = (to: [number, number]) => {
    const width = surfaceCanvas.clientWidth;
    const height = surfaceCanvas.clientHeight;
    reticleAt = [
      Math.min(width - 4, Math.max(4, to[0])),
      Math.min(height - 4, Math.max(4, to[1])),
    ];
    placeReticle();
    show(hitAt(...reticleAt));
  };
  stage.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? STEP_PX * 3 : STEP_PX;
    const [x, y] = reticleAt ?? centre();
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [x - step, y],
      ArrowRight: [x + step, y],
      ArrowUp: [x, y - step],
      ArrowDown: [x, y + step],
      Home: centre(),
    };
    if (event.key in moves) {
      event.preventDefault();
      moveReticle(moves[event.key]);
    } else if (event.key === 'Escape' && reticleAt) {
      reticleAt = null;
      placeReticle();
      show(null);
    }
  });
  // Focus leaving the map lets go of the reticle and its readout, as Escape does.
  stage.addEventListener('blur', () => {
    reticleAt = null;
    placeReticle();
    show(null);
  });

  /* ----- threshold slider ----- */
  const setThreshold = () => {
    const stop = Number(slider.value);
    t = stop / 100;
    const counts = thresholdCounts(areas, t);
    threshold.textContent = `${stop}%`;
    countParts(counts).forEach((part, index) => {
      const clause = count.children[index];
      if (clause) clause.textContent = part;
    });
    slider.setAttribute('aria-valuetext', valueText(stop, counts));
    outline();
    redraw();
  };
  slider.addEventListener('input', setThreshold);
  setThreshold();

  /* ----- entrance: structure, studs, then the surface outward from the evidence ----- */
  const reveal = (time: number) => {
    surface.reveal = {
      land: clamp01(time / 200),
      studs: 1,
      surface: clamp01((time - 450) / 650),
      hatch: clamp01((time - 1000) / 200),
    };
    studs.reveal = {
      land: 1,
      studs: clamp01((time - 150) / 400),
      surface: 1,
      hatch: 1,
    };
    contourAlpha = clamp01((time - 1000) / 200);
    redraw();
  };
  // The entrance runs on its own tween, started by the controller and cancelled by its rest. The
  // controller still ends it when the figure leaves the screen, the tab hides or the page prints;
  // its `render` hook is not used, because the map is created late (near view) and a jump scroll
  // can start play before the controller has seen the figure come on screen, which would hold the
  // entrance at its first frame.
  let entrance: Tween | null = null;
  new FigureController(figure, {
    duration: ENTRANCE,
    arm: () => reveal(0),
    start: () => {
      const frozen = frozenAt();
      if (frozen !== null) reveal(Math.min(frozen, ENTRANCE));
      else
        entrance = tween(
          ENTRANCE,
          (_eased, progress) => reveal(progress * ENTRANCE),
          linear,
        );
    },
    rest: () => {
      entrance?.cancel();
      entrance = null;
      reveal(ENTRANCE);
    },
  });
  figure.toggleAttribute('data-hbs-ready', true);
}
