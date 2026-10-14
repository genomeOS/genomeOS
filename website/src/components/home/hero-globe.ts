/** The hero evidence globe's island (site redesign spec §4.1 H1, §2.7, §6.1; #454).
 *
 * The page is complete without it: HeroGlobe.astro renders the Modeled layer at rest as a poster,
 * with the callouts and steps placed from the provenance sidecar. This island decodes the pinned
 * HbS (rs334) figure data, swaps a live canvas in for the poster and adds:
 *
 *   entrance   2.8 s in evidence order (land, studs west to east, modeled cells outward from the
 *              surveys, then the hatch), the globe turning 20° east to rest; steps and callouts
 *              light as their marks arrive. Plays once (FigureController), or not at all.
 *   layers     Measured / Modeled / Evidence, a 240 ms cross-fade
 *   readouts   hover, tap, keys and the step buttons write one docked strip (never over the globe);
 *              a stud reads AC of AN, a modeled area its 95% range, an `unknown` area no number
 *   drag/keys  drag turns (pointer capture, inertia ≤ 1 s, latitude −60…70°); arrow keys turn 8°
 *              with a centre reticle; Home or "Reset view" returns to rest, where the callouts
 *              describe the view again
 *   fallback   slow frames cap the pixel ratio, then fall back to the poster (hit tests still
 *              work); Save-Data starts on the poster and loads data only on first use
 *
 * Measured and modeled stay separate marks throughout (hexfield.ts); nothing here maps the width
 * of a range to colour (spec §6.3).
 */

import {
  createAnnouncer,
  prefersReducedMotion,
  type FigureController,
} from '../../graphics/figure';
import {
  decodeAreas,
  decodeSurveys,
  type Area,
  type Survey,
} from '../../graphics/figure-data';
import {
  HexField,
  type HexHit,
  type HexLayer,
  type Reveal,
} from '../../graphics/hexfield';
import { normalizeLon, orthographic } from '../../graphics/projection';
import { easeCamera, easeUi, tween, type Tween } from '../../graphics/tween';
import { steadyEntrance } from './count-up';

/** Entrance length (spec §4.1 motion table). */
export const ENTRANCE_MS = 2800;
/** Rest orientation: the globe's centre, [lon, lat]. */
export const REST_VIEW: readonly [number, number] = [18, 8];
/** The entrance turns the globe this far east, ending at rest. */
export const TURN_DEG = 20;
/** The globe box is this much wider than the disc, so limb studs keep their rings. */
export const DISC_PAD = 1.04;

const LAT_LIMITS = [-60, 70] as const;
const KEY_STEP_DEG = 8;
const INERTIA_MS = 1000;
const LAYER_FADE_MS = 240;
const HOME_MS = 600;
const DRAG_THRESHOLD_PX = 4;
/** Frame-time fallback ladder (spec §4.1): median draw time of 10 frames, ms. */
const SLOW_FRAME_MS = 16;
const POSTER_FRAME_MS = 24;
const DEG = 180 / Math.PI;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampLat = (lat: number) =>
  Math.min(LAT_LIMITS[1], Math.max(LAT_LIMITS[0], lat));

export interface EntranceFrame {
  reveal: Reveal;
  /** Globe centre, [lon, lat]. */
  view: [number, number];
  /** Steps lit, 0–3. */
  steps: number;
  /** Callouts shown, 0–3. */
  callouts: number;
}

/**
 * The entrance at `t` ms (spec §4.1): 0–0.3 s land, 0.3–1.0 s studs (step 1), 1.0–2.4 s modeled
 * cells (step 2, callout 1 at 1.0 s), 2.4–2.8 s hatch (step 3, callout 2 at 2.4 s, callout 3 at
 * 2.8 s); the globe turns 20° east to rest on the camera ease throughout.
 */
export function entranceAt(t: number): EntranceFrame {
  const turn = easeCamera(clamp01(t / ENTRANCE_MS));
  return {
    reveal: {
      land: clamp01(t / 300),
      studs: clamp01((t - 300) / 700),
      surface: clamp01((t - 1000) / 1400),
      hatch: clamp01((t - 2400) / 400),
    },
    view: [REST_VIEW[0] - TURN_DEG * (1 - turn), REST_VIEW[1]],
    steps: t >= 2400 ? 3 : t >= 1000 ? 2 : t >= 300 ? 1 : 0,
    callouts: t >= ENTRANCE_MS ? 3 : t >= 2400 ? 2 : t >= 1000 ? 1 : 0,
  };
}

/** A share as a number of percent: whole from 10%, one decimal from 1%, two below. */
export function formatPercent(value: number): string {
  const percent = value * 100;
  if (percent === 0) return '0';
  if (percent >= 10) return String(Math.round(percent));
  return percent.toFixed(percent >= 1 ? 1 : 2);
}

export const formatShare = (value: number): string =>
  `${formatPercent(value)}%`;

/** A 95% range as "7.2–28%". */
export const formatRange = (lo: number, hi: number): string =>
  `${formatPercent(lo)}–${formatPercent(hi)}%`;

export const formatKm = (km: number): string =>
  `${Math.round(km).toLocaleString('en-US')} km`;

const counts = (survey: Survey) =>
  `${survey.ac.toLocaleString('en-US')} of ${survey.an.toLocaleString('en-US')}`;

/** The readout for what is under the pointer, reticle or a step (spec §4.1 readouts). */
export function describeHit(
  hit: HexHit,
  layer: HexLayer,
  tiers: { weak: number },
): string {
  if (hit.type === 'surveys') {
    const [first] = hit.surveys;
    if (hit.surveys.length === 1)
      return `Measured survey · ${counts(first)} alleles carry HbS · Location within ±${formatKm(first.radiusKm)}`;
    const pairs = hit.surveys
      .slice(0, 3)
      .map((survey, index) =>
        index === 0 ? `${counts(survey)} alleles` : counts(survey),
      );
    return `${hit.surveys.length} surveys here · ${pairs.join(' · ')}${hit.surveys.length > 3 ? ' · …' : ''}`;
  }
  const { area } = hit;
  if (area.support === 'unknown' || area.mean === null)
    return `No estimate · — · No survey within ${formatKm(tiers.weak)}`;
  if (layer === 'measured') return 'Model grid · No values drawn on this layer';
  const text = `Modeled estimate about ${formatShare(area.mean)} · 95% credible range across this area ${formatRange(area.lo!, area.hi!)} · Nearest survey about ${formatKm(area.distanceKm)}`;
  return area.tier === 'weak' || area.tier === 'none'
    ? `${text}. Far from surveys: this range leans on the model’s assumptions.`
    : text;
}

/* ------------------------------------------------------------------ the island */

type CalloutKind = 'survey' | 'modeled' | 'unknown';

interface HeroConfig {
  domain: [number, number];
  tiers: { strong: number; partial: number; weak: number };
  /** The callout objects, by index into the decoded surveys and areas. */
  survey: number;
  modeled: number;
  unknown: number;
}

interface HeroData {
  areas: Area[];
  surveys: Survey[];
}

const BINARIES = import.meta.glob(
  [
    '../../data/figures/hbs-globe.*.bin',
    '../../data/figures/hbs-surveys.*.bin',
  ],
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>;

const binary = (prefix: string) =>
  Object.entries(BINARIES).find(([path]) => path.includes(`/${prefix}.`))![1];

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

/** Decode after first paint, off the critical path (spec §7: globe init ≤ 30 ms desktop). */
const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: 300 });
    else setTimeout(resolve, 0);
  });

async function loadData(): Promise<HeroData> {
  const [globe, surveys] = await Promise.all([
    fetchBytes(binary('hbs-globe')),
    fetchBytes(binary('hbs-surveys')),
  ]);
  await idle();
  return { areas: decodeAreas(globe), surveys: decodeSurveys(surveys) };
}

function saveData(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return Boolean(connection?.saveData);
}

/** A readout's first part is its lead-in; the rest follows it on the strip. */
function readoutHtml(text: string): string {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const [lead, ...rest] = text.split(' · ');
  return `<strong>${escape(lead)}</strong>${rest.length ? ` · ${escape(rest.join(' · '))}` : ''}`;
}

export function initHeroGlobe(figure: HTMLElement): void {
  const globe = figure.querySelector<HTMLElement>('.hg-globe');
  const canvas = globe?.querySelector<HTMLCanvasElement>('.hg-canvas');
  const stage = figure.querySelector<HTMLElement>('[data-figure-stage]');
  const leaders = figure.querySelector<SVGSVGElement>('.hg-leaders');
  const visual = figure.querySelector<HTMLElement>('[data-readout-text]');
  const spoken = figure.querySelector<HTMLElement>('[data-readout-sr]');
  const reset = figure.querySelector<HTMLButtonElement>('.hg-reset');
  if (!globe || !canvas || !stage || !visual || !spoken || !reset) return;

  const config = JSON.parse(globe.dataset.config ?? '{}') as HeroConfig;
  const idleText = visual.textContent ?? '';
  const announce = createAnnouncer(spoken);
  const reduced = prefersReducedMotion();
  const steps = [...figure.querySelectorAll<HTMLElement>('.hg-step')];
  const byOrder = (order: number) =>
    figure.querySelectorAll<HTMLElement | SVGElement>(
      `[data-callout-order="${order}"]`,
    );
  const kinds: CalloutKind[] = ['survey', 'modeled', 'unknown'];

  let data: HeroData | null = null;
  let loading: Promise<HeroData> | null = null;
  let field: HexField | null = null;
  let controller: FigureController | null = null;
  let layer: HexLayer = 'modeled';
  let view: [number, number] = [REST_VIEW[0], REST_VIEW[1]];
  let posterOnly = false;
  let probed = false;
  let motion: Tween | null = null;
  let inertia = 0;
  const projection = orthographic({
    center: REST_VIEW,
    scale: 1,
    translate: [0, 0],
  });

  figure.dataset.view = 'rest';
  // Printing shows the final state (spec §8). FigureController handles a print once it exists; the
  // data can arrive after printing began, so remember it here too.
  let printing =
    typeof matchMedia === 'function' && matchMedia('print').matches;
  window.addEventListener('beforeprint', () => (printing = true));
  window.addEventListener('afterprint', () => (printing = false));

  /* ---- state shown in the markup ---- */

  const setSteps = (lit: number) =>
    steps.forEach((step, index) =>
      step.classList.toggle('is-off', index >= lit),
    );
  const setCallouts = (shown: number) => {
    for (let order = 1; order <= 3; order += 1)
      byOrder(order).forEach((element) =>
        element.classList.toggle('is-off', order > shown),
      );
  };

  /** During the entrance, leaders and markers follow their targets as the globe turns. */
  const targets = new Map<CalloutKind, [number, number]>();
  const trackTargets = () => {
    if (!field || !leaders) return;
    const box = globe.getBoundingClientRect();
    const frame = stage.getBoundingClientRect();
    const unit = 100 / frame.width;
    for (const kind of kinds) {
      const target = targets.get(kind);
      if (!target) continue;
      const [x, y, cosc] = projection.project(target[0], target[1]);
      const line = leaders.querySelector<SVGLineElement>(
        `[data-target-line="${kind}"]`,
      );
      const ring = leaders.querySelector<SVGCircleElement>(
        `[data-target-ring="${kind}"]`,
      );
      const marker = figure.querySelector<HTMLElement>(
        `.hg-marker[data-callout="${kind}"]`,
      );
      const sx = (box.left - frame.left + x) * unit;
      const sy = (box.top - frame.top + y) * unit;
      line?.setAttribute('x2', sx.toFixed(2));
      line?.setAttribute('y2', sy.toFixed(2));
      ring?.setAttribute('cx', sx.toFixed(2));
      ring?.setAttribute('cy', sy.toFixed(2));
      if (marker) {
        marker.style.left = `${(x / box.width) * 100}%`;
        marker.style.top = `${(y / box.height) * 100}%`;
        marker.style.visibility = cosc < 0.05 ? 'hidden' : '';
      }
    }
  };
  /** At rest the server-rendered positions are exact: drop the tracked ones. */
  const restoreTargets = () => {
    if (!leaders) return;
    for (const element of leaders.querySelectorAll<SVGElement>(
      '[data-rest-x]',
    )) {
      const [ax, ay] =
        element.localName === 'line' ? ['x2', 'y2'] : ['cx', 'cy'];
      element.setAttribute(ax, element.dataset.restX!);
      element.setAttribute(ay, element.dataset.restY!);
    }
    for (const marker of figure.querySelectorAll<HTMLElement>('.hg-marker'))
      for (const property of ['left', 'top', 'visibility'])
        marker.style.removeProperty(property);
  };
  // Remember the server's leader end points so rest can put them back.
  leaders
    ?.querySelectorAll<SVGElement>('[data-target-line], [data-target-ring]')
    .forEach((element) => {
      const line = element.localName === 'line';
      element.dataset.restX = element.getAttribute(line ? 'x2' : 'cx')!;
      element.dataset.restY = element.getAttribute(line ? 'y2' : 'cy')!;
    });

  /* ---- the readout ---- */

  let pinned: HexHit | null = null;
  let hovered: HexHit | null = null;
  const show = (hit: HexHit | null, speak = true) => {
    if (!hit) {
      visual.textContent = idleText;
      return;
    }
    const text = describeHit(hit, layer, config.tiers);
    visual.innerHTML = readoutHtml(text);
    if (speak) announce(text);
  };
  const sameHit = (a: HexHit | null, b: HexHit | null) =>
    a === b ||
    (a?.type === 'area' && b?.type === 'area' && a.area === b.area) ||
    (a?.type === 'surveys' &&
      b?.type === 'surveys' &&
      a.surveys.length === b.surveys.length &&
      a.surveys.every((survey, index) => survey === b.surveys[index]));

  /* ---- view ---- */

  const draw = () => field?.draw();
  const atRest = () =>
    Math.abs(normalizeLon(view[0] - REST_VIEW[0])) < 1e-6 &&
    Math.abs(view[1] - REST_VIEW[1]) < 1e-6;
  const setView = (lon: number, lat: number) => {
    view = [normalizeLon(lon), clampLat(lat)];
    projection.rotate(view);
    if (hovered) {
      hovered = null;
      if (field) field.hover = null;
    }
    // A pinned stud's ring sits at a screen point, which a turn moves away from it.
    if (field?.pinned?.type === 'surveys') field.pinned = null;
    draw();
  };
  const markMoved = () => {
    figure.dataset.view = 'moved';
    reset.hidden = false;
  };
  const markRest = () => {
    figure.dataset.view = 'rest';
    reset.hidden = true;
  };
  const stopMotion = () => {
    motion?.cancel();
    motion = null;
    if (inertia) cancelAnimationFrame(inertia);
    inertia = 0;
  };
  const finishEntrance = () => {
    if (controller && controller.state !== 'rest') controller.finish();
  };

  /** Back to the rest orientation, where the callouts describe the view again. */
  const goHome = (animate = !reduced) => {
    stopMotion();
    const [lon0, lat0] = view;
    const dLon = normalizeLon(REST_VIEW[0] - lon0);
    const dLat = REST_VIEW[1] - lat0;
    const arrive = () => {
      setView(REST_VIEW[0], REST_VIEW[1]);
      markRest();
    };
    if (!animate || atRest()) {
      arrive();
      return;
    }
    motion = tween(
      HOME_MS,
      (eased) => {
        if (eased >= 1) arrive();
        else setView(lon0 + dLon * eased, lat0 + dLat * eased);
      },
      easeCamera,
    );
  };

  /* ---- live canvas or poster ---- */

  const goLive = () => {
    if (!posterOnly) figure.dataset.live = '';
  };
  const usePoster = () => {
    posterOnly = true;
    stopMotion();
    finishEntrance();
    figure.dataset.mode = 'poster';
    delete figure.dataset.live;
    if (!atRest()) setView(REST_VIEW[0], REST_VIEW[1]);
    markRest();
  };
  /** The fallback ladder (spec §4.1): read once, after 10 frames of the entrance or a drag. */
  const probe = () => {
    if (!field || probed || !field.probe.full) return;
    probed = true;
    const median = field.probe.median();
    if (median > POSTER_FRAME_MS) usePoster();
    else if (median > SLOW_FRAME_MS) {
      field.graticule = false;
      field.capPixelRatio(1);
    }
  };

  const restState = () => {
    field!.reveal = { land: 1, studs: 1, surface: 1, hatch: 1 };
    setView(REST_VIEW[0], REST_VIEW[1]);
    markRest();
    setSteps(3);
    setCallouts(3);
    restoreTargets();
  };

  const build = (loaded: HeroData) => {
    data = loaded;
    field = new HexField(canvas, {
      areas: loaded.areas,
      surveys: loaded.surveys,
      projection,
      domain: config.domain,
      layer,
      globe: true,
      fit(width, height, target) {
        target.scale = width / 2 / DISC_PAD;
        target.translate = [width / 2, height / 2];
      },
    });
    const survey = loaded.surveys[config.survey];
    targets.set('survey', [survey.lon, survey.lat]);
    targets.set('modeled', loaded.areas[config.modeled].center);
    targets.set('unknown', loaded.areas[config.unknown].center);
    new ResizeObserver(() => field?.resize()).observe(globe);
  };

  const ensureData = (): Promise<HeroData> => {
    loading ??= loadData().then((loaded) => {
      build(loaded);
      if (posterOnly) restState();
      return loaded;
    });
    return loading;
  };

  const start = async () => {
    await ensureData();
    if (posterOnly) return;
    controller = steadyEntrance(figure, {
      duration: ENTRANCE_MS,
      arm() {
        goLive();
        const frame = entranceAt(0);
        field!.reveal = frame.reveal;
        setView(frame.view[0], frame.view[1]);
        setSteps(frame.steps);
        setCallouts(frame.callouts);
        trackTargets();
      },
      render(t) {
        const frame = entranceAt(t);
        field!.reveal = frame.reveal;
        setView(frame.view[0], frame.view[1]);
        setSteps(frame.steps);
        setCallouts(frame.callouts);
        trackTargets();
        probe();
      },
      rest() {
        goLive();
        restState();
      },
    });
    if (printing) controller.finish();
  };

  /* ---- interaction ---- */

  const point = (event: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const pin = (hit: HexHit | null) => {
    pinned = hit;
    if (field) {
      field.pinned = hit;
      draw();
    }
    show(hit);
  };

  let drag: {
    id: number;
    x: number;
    y: number;
    from: [number, number];
    moved: boolean;
    lastX: number;
    lastT: number;
    speed: number;
  } | null = null;
  const radius = () => canvas.clientWidth / 2 / DISC_PAD;

  globe.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    void ensureData();
    // Every press is recorded, so a tap pins a readout even on the poster or before the data
    // arrive; only a live canvas turns.
    if (field && !posterOnly) {
      finishEntrance();
      stopMotion();
    }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: [view[0], view[1]],
      moved: false,
      lastX: event.clientX,
      lastT: event.timeStamp,
      speed: 0,
    };
  });

  globe.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.id) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      const turns = Boolean(field) && !posterOnly;
      if (turns && !drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        drag.moved = true;
        globe.setPointerCapture(event.pointerId);
        markMoved();
        figure.dataset.dragging = '';
      }
      if (drag.moved) {
        const r = radius();
        setView(drag.from[0] - (dx / r) * DEG, drag.from[1] + (dy / r) * DEG);
        const dt = Math.max(1, event.timeStamp - drag.lastT);
        drag.speed = ((-(event.clientX - drag.lastX) / r) * DEG) / dt;
        drag.lastX = event.clientX;
        drag.lastT = event.timeStamp;
        probe();
        return;
      }
    }
    if (event.pointerType !== 'mouse' || !field) return;
    const hit = field.hit(...point(event));
    if (sameHit(hit, hovered)) return;
    hovered = hit;
    field.hover = hit;
    draw();
    show(hit ?? pinned);
  });

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, speed, lastT } = drag;
    drag = null;
    delete figure.dataset.dragging;
    if (!moved) {
      // A tap (or a click that did not drag) pins what is under it.
      void ensureData().then(() => {
        if (field) pin(field.hit(...point(event)));
      });
      return;
    }
    // Inertia: at most 1 s, and none under reduced motion.
    const recent = event.timeStamp - lastT < 80;
    if (reduced || !recent || Math.abs(speed) < 0.01) return;
    let velocity = speed;
    let last = performance.now();
    const began = last;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      velocity *= Math.pow(0.9, dt / 16);
      setView(view[0] + velocity * dt, view[1]);
      if (
        now - began < INERTIA_MS &&
        Math.abs(velocity) > 0.004 &&
        !document.hidden
      )
        inertia = requestAnimationFrame(step);
      else inertia = 0;
    };
    inertia = requestAnimationFrame(step);
  };
  globe.addEventListener('pointerup', endDrag);
  globe.addEventListener('pointercancel', (event) => {
    if (drag?.id === event.pointerId) {
      drag = null;
      delete figure.dataset.dragging;
    }
  });
  globe.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse' || drag) return;
    hovered = null;
    if (field) {
      field.hover = null;
      draw();
    }
    show(pinned, false);
  });

  /** What sits under the centre reticle. */
  const describeCentre = () => {
    if (!field) return;
    const x = canvas.clientWidth / 2;
    const y = canvas.clientHeight / 2;
    const hit = field.hit(x, y);
    pinned = hit;
    field.pinned = hit;
    draw();
    show(hit);
  };

  globe.addEventListener('focus', () => {
    if (!globe.matches(':focus-visible')) return;
    figure.dataset.reticle = '';
    void ensureData().then(describeCentre);
  });
  globe.addEventListener('blur', () => delete figure.dataset.reticle);
  globe.addEventListener('keydown', (event) => {
    const turn: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP_DEG, 0],
      ArrowRight: [KEY_STEP_DEG, 0],
      ArrowUp: [0, KEY_STEP_DEG],
      ArrowDown: [0, -KEY_STEP_DEG],
    };
    if (event.key in turn) {
      event.preventDefault();
      figure.dataset.reticle = '';
      void ensureData().then(() => {
        if (posterOnly || !field) return describeCentre();
        finishEntrance();
        stopMotion();
        const [dLon, dLat] = turn[event.key];
        setView(view[0] + dLon, view[1] + dLat);
        if (!atRest()) markMoved();
        else markRest();
        describeCentre();
      });
    } else if (event.key === 'Home') {
      event.preventDefault();
      figure.dataset.reticle = '';
      void ensureData().then(() => {
        finishEntrance();
        goHome(false);
        describeCentre();
      });
    } else if (event.key === 'Escape' && pinned) {
      pin(null);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      figure.dataset.reticle = '';
      void ensureData().then(describeCentre);
    }
  });

  reset.addEventListener('click', () => {
    finishEntrance();
    goHome();
  });

  // The steps pin the object their callout describes.
  for (const button of figure.querySelectorAll<HTMLButtonElement>(
    '.hg-step button[data-pin]',
  ))
    button.addEventListener('click', () => {
      const kind = button.dataset.pin as CalloutKind;
      void ensureData().then(() => {
        if (!field || !data) return;
        finishEntrance();
        if (!atRest()) goHome(false);
        const target = targets.get(kind)!;
        const [x, y] = projection.project(target[0], target[1]);
        const hit: HexHit =
          kind === 'survey'
            ? {
                type: 'surveys',
                surveys: [data.surveys[config.survey]],
                x,
                y,
              }
            : {
                type: 'area',
                area: data.areas[config[kind]],
                x,
                y,
              };
        pin(hit);
      });
    });

  // Layers cross-fade; the legend swaps to the layer's own marks.
  figure.addEventListener('segmented:change', (event) => {
    const next = (event as CustomEvent<{ value: HexLayer }>).detail.value;
    layer = next;
    for (const legend of figure.querySelectorAll<HTMLElement>('[data-legend]'))
      legend.toggleAttribute('data-active', legend.dataset.legend === next);
    if (field) {
      if (reduced) field.setLayer(next);
      else {
        field.setLayer(next, 0);
        tween(LAYER_FADE_MS, (amount) => field?.setLayer(next, amount), easeUi);
      }
    }
    const current = hovered ?? pinned;
    if (current) show(current, false);
  });

  if (saveData()) {
    // Save-Data: the poster stays; data arrive only when someone inspects the globe.
    usePoster();
    globe.addEventListener('focus', () => void ensureData(), { once: true });
    return;
  }
  void start().catch(() => {
    // No data, no canvas: the poster, callouts and steps already tell the story.
    usePoster();
  });
}
