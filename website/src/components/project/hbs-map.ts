/** The Projects HbS threshold map (site redesign spec §4.2, HbS, §6; round 2 spec §4.2.2; #454).
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
 * above t: the uncertainty-aware threshold a screening program would use. Nothing is fitted
 * here; every number comes from the pinned, coarsened figure data.
 *
 * Measured and modeled stay apart: the surface and the studs are two HexFields on two canvases,
 * the contours sit between them, and the studs, white and sized by AN, are drawn last.
 *
 * The pure helpers at the top have no DOM and are unit-tested; `initHbsMap` is the island.
 */

import {
  FigureController,
  createAnnouncer,
  prefersReducedMotion,
  type FigureControllerOptions,
} from '../../graphics/figure';
import {
  decodeAreas,
  decodeSurveys,
  type Area,
  type Survey,
} from '../../graphics/figure-data';
import { HexField, type HexHit } from '../../graphics/hexfield';
import {
  DEFAULT_STOP,
  GENOTYPE_ORDER,
  RECOLOUR_MS,
  THRESHOLD_STOPS,
  areaFill,
  genotypeArea,
  genotypeDomain,
  stopText,
  type Genotype,
} from './hbs-genotypes';
import {
  MOTION_HOOKS,
  frozenAt as frozenFromUrl,
} from '../../graphics/motion-hooks';
import { easeUi, linear, tween, type Tween } from '../../graphics/tween';
import {
  lambertAzimuthal,
  spherePoint,
  type LambertAzimuthal,
  type LonLat,
  type Projection,
  type SpherePoint,
} from '../../graphics/projection';

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

/** The slider's spoken value (spec §4.2), at a stop in percent of births. */
export const valueText = (
  stop: number,
  { confident, possible }: ThresholdCounts,
) =>
  `${stopText(stop)} percent: ${whole(confident)} areas confidently above, ${whole(possible)} possibly above`;

/**
 * A share as a number of percent, as the Home hero writes it: whole from 10%, one decimal from 1%,
 * two below. A genotype's share can be tiny (SS) or nearly all (AA): below 0.01% reads "<0.01",
 * one decimal from 99%, and anything short of 100% that would round to it reads ">99.9", so no
 * share reads as a false zero or a false 100.
 */
export function formatPercent(share: number): string {
  const value = share * 100;
  if (value === 0) return '0';
  if (value === 100) return '100';
  if (value < 0.01) return '<0.01';
  if (value >= 99.95) return '>99.9';
  if (value >= 99) return value.toFixed(1);
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(value >= 1 ? 1 : 2);
}

const km = (value: number) => `${whole(value)} km`;
/**
 * People tested in a survey: AN gene copies are AN/2 people, exactly, because HBB is autosomal
 * (round 2 R2-16). The pinned surveys all have an even AN (tests/content-projects.test.ts). No
 * carrier count is derived from AC, which counts copies, not people.
 */
const people = (survey: Survey) => whole(survey.an / 2);

/**
 * The readout for what is under the pointer or reticle (copy deck; ruling 36): an area's expected
 * share of births for the genotype shown, with its 95% range through the same transform, the
 * modeled HbS frequency it comes from and the distance from surveys; a survey's people tested with
 * its copies kept as counts, the same for every genotype (surveys hold allele counts, never
 * genotypes); or "No estimate". `hit.area` is the area as modeled (q). A coarsened area carries its
 * children's median distance, so every distance is "about": a minority child can sit nearer a
 * survey. Far from surveys the readout says no more than that distance: the range and the
 * distance speak for themselves, with no warning line (ruling 59: no limitation labels).
 */
export function describeHit(
  hit: HexHit | null,
  genotype: Genotype,
): string | null {
  if (!hit) return null;
  if (hit.type === 'surveys') {
    const [first] = hit.surveys;
    if (hit.surveys.length === 1)
      return `Measured survey · ${people(first)} people tested; ${whole(first.ac)} of their ${whole(first.an)} gene copies carry HbS · Location within ±${km(first.radiusKm)}`;
    // The nearest three, as one list that says what its numbers count: "553, 2,013 and 1,342
    // people tested" (design review, round 3); "…" when more share the spot.
    const listed = hit.surveys.slice(0, 3).map(people);
    const tested = `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)} people tested`;
    return [
      `${hit.surveys.length} surveys here`,
      tested,
      ...(hit.surveys.length > 3 ? ['…'] : []),
    ].join(' · ');
  }
  const { area } = hit;
  if (area.support === 'unknown' || area.mean === null)
    return `No estimate · — · Nearest survey about ${km(area.distanceKm)}`;
  const shown = genotypeArea(area, genotype);
  return `Modeled: ${genotype} in about ${formatPercent(shown.mean!)}% of births · 95% credible range across this area ${formatPercent(shown.lo!)}–${formatPercent(shown.hi!)}% · HbS frequency about ${formatPercent(area.mean)}% · Nearest survey about ${km(area.distanceKm)}`;
}

/**
 * The readout, one fact a line with no separators on screen (design critique of the integrated
 * build: the run-on paragraph wrapped onto lines that began with "·"). The separators stay in the
 * text, visually hidden, so a screen reader and the region's text read as describeHit wrote it.
 */
export function readoutLines(region: HTMLElement, text: string): void {
  const nodes: Node[] = [];
  text.split(' · ').forEach((part, index) => {
    if (index > 0) {
      const gap = document.createElement('span');
      gap.className = 'visually-hidden';
      gap.textContent = ' · ';
      nodes.push(gap);
    }
    const line = document.createElement('span');
    line.className = 'hbs__line';
    line.textContent = part;
    nodes.push(line);
  });
  region.replaceChildren(...nodes);
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

/**
 * Captures hold the entrance at `?t=<ms>[&scene=hbs-threshold]` (FigureController's freeze hook),
 * in dev and the e2e build only (motion hooks, round 2 spec §3.4); never in the deployed build.
 */
function frozenAt(): number | null {
  if (!MOTION_HOOKS) return null;
  return frozenFromUrl(location.search, 'hbs-threshold');
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

/** The hairline between areas and the hover outline, as HexField draws them (hexfield.ts). */
const EDGE = 'rgb(2 7 18 / 85%)';
const FOCUS = '#70e6ff';

export async function initHbsMap(
  figure: HTMLElement,
  urls: { region: string; surveys: string },
  options?: FigureControllerOptions,
): Promise<void> {
  const stage = figure.querySelector<HTMLElement>('[data-hbs-map]');
  const domain = stage ? readDomain(stage) : null;
  const surfaceCanvas = figure.querySelector<HTMLCanvasElement>(
    '[data-hbs-canvas="surface"]',
  );
  const previous = figure.querySelector<HTMLCanvasElement>(
    '[data-hbs-canvas="previous"]',
  );
  const studCanvas = figure.querySelector<HTMLCanvasElement>(
    '[data-hbs-canvas="studs"]',
  );
  const reticle = figure.querySelector<HTMLElement>('[data-hbs-reticle]');
  const slider = figure.querySelector<HTMLInputElement>('[data-hbs-slider]');
  const threshold = figure.querySelector<HTMLElement>('[data-hbs-threshold]');
  const genotypeName = figure.querySelector<HTMLElement>(
    '[data-hbs-genotype-name]',
  );
  const mutedKey = figure.querySelector<HTMLElement>('[data-hbs-muted-key]');
  const count = figure.querySelector<HTMLElement>('[data-hbs-count]');
  const readout = figure.querySelector<HTMLElement>('[data-readout]');
  const cell = figure.querySelector<HTMLElement>('[data-genotype]');
  if (
    !domain ||
    !stage ||
    !surfaceCanvas ||
    !previous ||
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

  /* ----- the genotype shown: the triad's pressed button is the one state (ruling 36) ----- */
  let genotype: Genotype = isGenotype(cell?.dataset.genotype)
    ? cell.dataset.genotype
    : 'AS';
  /** Each genotype's slider stop, kept while another is shown. */
  const stopIndex = Object.fromEntries(
    GENOTYPE_ORDER.map((key) => [
      key,
      THRESHOLD_STOPS[key].indexOf(DEFAULT_STOP[key]),
    ]),
  ) as Record<Genotype, number>;
  stopIndex[genotype] = Number(slider.value);
  const stopOf = () =>
    THRESHOLD_STOPS[genotype][stopIndex[genotype]] ?? DEFAULT_STOP[genotype];

  // What the surface shows: one display area per modeled area, whose `mean` is the selected
  // genotype's share as a position in that genotype's ramp (HexField colours a [0, 1] domain with
  // the kit's VSUP bins, the same colours areaFill gives for the genotype's own domain). The modeled
  // areas stay as they are, for the readout.
  const display: Area[] = areas.map((area) => ({ ...area }));
  const indexOf = new Map(display.map((area, index) => [area, index]));
  let shares: Area[] = [];
  let shareDomain: [number, number] = [0, 1];
  let t = stopOf() / 100;
  let paints: { fill: string | null; muted: boolean }[] = [];
  const showGenotype = () => {
    shareDomain = genotypeDomain(genotype, domain);
    shares = areas.map((area) => genotypeArea(area, genotype));
    const [low, high] = shareDomain;
    const span = high - low || 1;
    shares.forEach((share, index) => {
      display[index].mean =
        share.mean === null ? null : clamp01((share.mean - low) / span);
    });
  };
  showGenotype();

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

  let contourAlpha = 1;
  const edges = gridEdges(areas);
  let lines = {
    confident: [] as SpherePoint[][],
    possible: [] as SpherePoint[][],
  };
  const outline = () => {
    const kinds = shares.map((area) => classifyArea(area, t));
    lines = {
      // Every area whose estimate is at or above t (dashed), and inside it the confident core.
      possible: chains(contour(edges, (index) => kinds[index] !== null)),
      confident: chains(
        contour(edges, (index) => kinds[index] === 'confident'),
      ),
    };
    paints = shares.map((area) => areaFill(area, t, shareDomain));
  };
  outline();

  const surface = new HexField(surfaceCanvas, {
    areas: display,
    surveys: [],
    projection,
    domain: [0, 1],
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

  /* ----- areas below the threshold: a muted grey of their ramp colour (owner, 2026-10-15) ----- */
  const rings = areas.map((area) =>
    area.boundary.map(([lon, lat]) => spherePoint(lon, lat)),
  );
  const ringPath = (g: CanvasRenderingContext2D, index: number): boolean => {
    g.beginPath();
    for (const [k, point] of rings[index].entries()) {
      const [x, y, cosc] = projection.projectPoint(point);
      if (cosc < -0.9) return false;
      if (k) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
    return true;
  };
  const drawMuted = () => {
    if (contourAlpha <= 0) return;
    const g = surface.ctx;
    g.save();
    g.globalAlpha = contourAlpha;
    g.lineJoin = 'round';
    g.strokeStyle = EDGE;
    g.lineWidth = 0.7;
    paints.forEach((paint, index) => {
      if (!paint.muted || !paint.fill || !ringPath(g, index)) return;
      g.fillStyle = paint.fill;
      g.fill();
      g.stroke();
    });
    // The hover outline, again over a muted area.
    const hovered =
      surface.hover?.type === 'area' ? indexOf.get(surface.hover.area) : null;
    if (hovered != null && paints[hovered]?.muted && ringPath(g, hovered)) {
      g.globalAlpha = 1;
      g.strokeStyle = FOCUS;
      g.lineWidth = 1.6;
      g.stroke();
    }
    g.restore();
  };

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
    // No fill lift: lightening the selected cells would shift their colour up the ramp.
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
  const paintSurface = () => {
    surface.draw();
    drawMuted();
    drawContours();
  };
  const redraw = () => {
    paintSurface();
    studs.draw();
  };

  /* ----- the recolour: the old picture fades out over the new one (≤ 300 ms, ruling 36) ----- */
  let fade: Tween | null = null;
  let fadeToken = 0;
  const shownAs = () => `${genotype} ${stopText(stopOf())}`;
  const settle = () => {
    previous.style.opacity = '0';
    previous.width = 0;
    previous.height = 0;
    figure.dataset.hbsShown = shownAs();
  };
  const stopFade = () => {
    fadeToken += 1;
    fade?.cancel();
    fade = null;
    settle();
  };
  const recolour = (apply: () => void) => {
    const animate =
      !prefersReducedMotion() &&
      controller.state === 'rest' &&
      surfaceCanvas.width > 0;
    if (animate) {
      const g = previous.getContext('2d')!;
      const showing = Number(previous.style.opacity || '0');
      if (
        showing > 0 &&
        previous.width === surfaceCanvas.width &&
        previous.height === surfaceCanvas.height
      ) {
        // Mid-fade: bake what shows now (the previous picture, part faded, over the surface).
        g.save();
        g.globalCompositeOperation = 'destination-in';
        g.fillStyle = `rgb(0 0 0 / ${showing})`;
        g.fillRect(0, 0, previous.width, previous.height);
        g.globalCompositeOperation = 'destination-over';
        g.drawImage(surfaceCanvas, 0, 0);
        g.restore();
      } else {
        previous.width = surfaceCanvas.width;
        previous.height = surfaceCanvas.height;
        g.drawImage(surfaceCanvas, 0, 0);
      }
      previous.style.opacity = '1';
    }
    apply();
    paintSurface();
    if (!animate) {
      stopFade();
      return;
    }
    fade?.cancel();
    const token = ++fadeToken;
    fade = tween(
      RECOLOUR_MS,
      (eased) => {
        if (token === fadeToken) previous.style.opacity = String(1 - eased);
      },
      easeUi,
    );
    void fade.done.then(() => {
      if (token !== fadeToken) return;
      fade = null;
      settle();
    });
  };

  new ResizeObserver(() => {
    stopFade();
    setStudScale();
    surface.resize();
    drawMuted();
    drawContours();
    studs.resize();
    placeReticle();
  }).observe(stage);

  /* ----- readout: pointer, tap and keyboard reticle ----- */
  const idle = readout.textContent ?? '';
  const announce = createAnnouncer(readout, 400, readoutLines);
  let reticleAt: [number, number] | null = null;
  // A pointer moving inside one area or stud cluster changes nothing: skip the redraw and the
  // announcement (a full redraw costs several ms, and a phone runs it four times slower).
  let shown: HexHit | null = null;
  /** The hit as modeled: a display area back to its modeled area. */
  const modeled = (hit: HexHit | null): HexHit | null =>
    hit?.type === 'area'
      ? { ...hit, area: areas[indexOf.get(hit.area) ?? 0] }
      : hit;
  const show = (hit: HexHit | null, force = false) => {
    if (!force && sameHit(hit, shown)) return;
    shown = hit;
    surface.hover = hit?.type === 'area' ? hit : null;
    studs.hover = hit?.type === 'surveys' ? hit : null;
    redraw();
    announce(describeHit(modeled(hit), genotype) ?? idle);
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

  /* ----- the threshold and the genotype's words ----- */
  const setControls = () => {
    const stop = stopOf();
    t = stop / 100;
    const counts = thresholdCounts(shares, t);
    figure.dataset.hbsGenotype = genotype;
    slider.value = String(stopIndex[genotype]);
    threshold.textContent = `${stopText(stop)}%`;
    if (genotypeName) genotypeName.textContent = genotype;
    if (mutedKey) mutedKey.textContent = `Below ${stopText(stop)}%`;
    // Only the numbers change: each sits in a fixed, right-aligned box, so no word moves.
    const [confident, possible] = count.querySelectorAll('b');
    if (confident) confident.textContent = whole(counts.confident);
    if (possible) possible.textContent = whole(counts.possible);
    slider.setAttribute('aria-valuetext', valueText(stop, counts));
    const alt = stage.dataset[`alt${genotype[0]}${genotype[1].toLowerCase()}`];
    if (alt) stage.setAttribute('aria-label', alt);
    outline();
  };
  slider.addEventListener('input', () =>
    recolour(() => {
      stopIndex[genotype] = Number(slider.value);
      setControls();
    }),
  );
  figure.addEventListener('genotype:change', (event) => {
    const next = (event as CustomEvent<{ genotype: Genotype }>).detail.genotype;
    if (next === genotype) return;
    recolour(() => {
      genotype = next;
      showGenotype();
      setControls();
    });
    // A readout on screen says the new genotype's numbers (a survey's stay as measured).
    if (shown) show(shown, true);
  });
  setControls();
  figure.dataset.hbsShown = shownAs();

  // The e2e build's hook for tests: where a place lands on the surface canvas, in CSS px.
  if (MOTION_HOOKS)
    (
      figure as HTMLElement & {
        __hbsPoint?: (lon: number, lat: number) => [number, number];
      }
    ).__hbsPoint = (lon, lat) => {
      const [x, y] = projection.project(lon, lat);
      return [x, y];
    };

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
    // The threshold arrives last: its outlines and the muted areas together.
    contourAlpha = clamp01((time - 1000) / 200);
    redraw();
  };
  // The entrance runs on its own tween, started by the controller and cancelled by its rest. The
  // controller still ends it when the figure leaves the screen, the tab hides or the page prints;
  // its `render` hook is not used, because the map is created late (near view) and a jump scroll
  // can start play before the controller has seen the figure come on screen, which would hold the
  // entrance at its first frame.
  let entrance: Tween | null = null;
  const controller = new FigureController(
    figure,
    {
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
    },
    options,
  );
  // The data load late (near view): a print that began before they arrived has already sent its
  // `beforeprint`, so the map shows its final state at once (spec §8, "final states print").
  if (matchMedia('print').matches) controller.finish();
  figure.toggleAttribute('data-hbs-ready', true);
}

const isGenotype = (value: string | undefined): value is Genotype =>
  value === 'AA' || value === 'AS' || value === 'SS';
