/** The Atlas preview's island: Home's toy globe (site redesign spec §4.1, §2.7, §6.1; round 2
 * ruling R2-2; #454).
 *
 * The page is complete without it: AtlasPreview.astro renders the Modeled layer at rest as a
 * poster, with its pins and callouts placed from the provenance sidecar. This island decodes the
 * pinned HbS (rs334) figure data once the figure nears the viewport, swaps a live canvas in for the
 * poster and adds:
 *
 *   entrance   2.8 s in evidence order (land, studs west to east, modeled cells outward from the
 *              surveys, then the hatch), the globe turning 20° to its starting view the way the
 *              Earth turns; callouts light as their marks arrive. Plays once (FigureController).
 *   rotation   after a short hold on the starting view, a slow turn (a revolution a minute, the
 *              Earth's way: features drift west to east). It pauses while the visitor points at,
 *              drags or focuses the globe and resumes 4 s after they let go; a Pause control stops
 *              it until they press Play (WCAG 2.2.2). Never under reduced motion; never off screen
 *              or in a hidden tab (AutoSpin).
 *   callouts   the leader lines show only at the starting view; once the globe turns, the pins ride
 *              on it (and fade behind it) while the callouts stay put as its key.
 *   layers     Measured / Modeled, a 240 ms cross-fade (a new switch cancels the last)
 *   drag/keys  drag turns (pointer capture, inertia ≤ 1 s, latitude −60…70°); arrow keys turn 8°;
 *              Home returns to the starting view.
 *   fallback   slow frames cap the pixel ratio, then fall back to the poster; Save-Data and forced
 *              colours keep the poster (spec §2.2), so the figure is then its poster: the Modeled
 *              starting view, with no layer control and nothing that turns.
 *
 * Measured and modeled stay separate marks throughout (hexfield.ts); nothing here maps the width
 * of a range to colour (spec §6.3).
 */

import {
  prefersReducedMotion,
  type FigureController,
} from '../../graphics/figure';
import {
  decodeAreas,
  decodeSurveys,
  type Area,
  type Survey,
} from '../../graphics/figure-data';
import { HexField, type HexLayer, type Reveal } from '../../graphics/hexfield';
import { normalizeLon, orthographic } from '../../graphics/projection';
import {
  easeCamera,
  easeUi,
  tween,
  type FrameScheduler,
  type Tween,
} from '../../graphics/tween';
import { steadyEntrance } from './steady-entrance';

/** Entrance length (spec §4.1 motion table). */
export const ENTRANCE_MS = 2800;
/** The starting view: the globe's centre, [lon, lat]. The callouts describe this view. */
export const REST_VIEW: readonly [number, number] = [18, 8];
/** The entrance turns the globe this far, ending at the starting view. */
export const TURN_DEG = 20;
/** The globe box is this much wider than the disc, so limb studs keep their rings. */
export const DISC_PAD = 1.04;
/** The disc radius (CSS px) whose studs are drawn at full size. */
export const STUD_REFERENCE_RADIUS = 225;

/** Rotation: degrees of longitude a second (a revolution a minute). */
export const SPIN_DEG_PER_S = 6;
/** The starting view, with its leader lines, holds this long after the entrance. */
export const SPIN_DWELL_MS = 5000;
/** Rotation resumes this long after the visitor stops pointing at, dragging or focusing it. */
export const SPIN_IDLE_MS = 4000;
/** Each start eases up to full speed over this long. */
export const SPIN_RAMP_MS = 1600;
/** The rotation draws at most 30 frames a second: at 6°/s that is still under a pixel a frame. */
export const SPIN_FRAME_MS = 1000 / 30;

/**
 * The studs' share of their full size on a disc of this radius: they shrink with the disc (a
 * phone's is about a quarter smaller), so over West Africa or India they stay points and the
 * Modeled layer shows between them (design review, round 1). Never below 0.6.
 */
export const previewStudScale = (radius: number): number =>
  Math.min(1, Math.max(0.6, radius / STUD_REFERENCE_RADIUS));

const LAT_LIMITS = [-60, 70] as const;
const KEY_STEP_DEG = 8;
const INERTIA_MS = 1000;
const LAYER_FADE_MS = 240;
const HOME_MS = 600;
const DRAG_THRESHOLD_PX = 4;
/** Frame-time fallback ladder (spec §4.1): median draw time of 10 frames, ms. */
const SLOW_FRAME_MS = 16;
const POSTER_FRAME_MS = 24;
/** Pins fade out over this band of the limb (cosine of the angle from the view centre). */
const PIN_FADE = [0.06, 0.22] as const;
const DEG = 180 / Math.PI;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampLat = (lat: number) =>
  Math.min(LAT_LIMITS[1], Math.max(LAT_LIMITS[0], lat));

export interface EntranceFrame {
  reveal: Reveal;
  /** Globe centre, [lon, lat]. */
  view: [number, number];
  /** Callouts lit, 0–3. */
  callouts: number;
}

/**
 * The entrance at `t` ms (spec §4.1): 0–0.3 s land, 0.3–1.0 s studs (callout 1 at 1.0 s), 1.0–2.4 s
 * modeled cells (callout 2 at 2.4 s), 2.4–2.8 s hatch (callout 3 at 2.8 s); the globe turns 20° to
 * its starting view on the camera ease throughout, the Earth's way (its centre's longitude falls),
 * as the rotation that follows does.
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
    view: [REST_VIEW[0] + TURN_DEG * (1 - turn), REST_VIEW[1]],
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

/**
 * Layer switches cross-fade over 240 ms (spec §4.1). A switch inside a running fade cancels it, so
 * two quick switches never draw alternate layers on alternate frames. Reduced motion, or an
 * `instant` switch (the poster's return to Modeled), switches at once.
 */
export function layerFader(
  apply: (layer: HexLayer, amount: number) => void,
  options: { reduced?: boolean; schedule?: FrameScheduler } = {},
): (next: HexLayer, instant?: boolean) => void {
  let running: Tween | null = null;
  return (next, instant = false) => {
    running?.cancel();
    running = null;
    if (options.reduced || instant) {
      apply(next, 1);
      return;
    }
    apply(next, 0);
    running = tween(
      LAYER_FADE_MS,
      (amount) => apply(next, amount),
      easeUi,
      options.schedule,
    );
  };
}

/* ------------------------------------------------------------------ the rotation */

/**
 * What the rotation is doing:
 *   off       not allowed (no live globe yet, the poster, or reduced motion)
 *   paused    the visitor pressed Pause
 *   held      the visitor is pointing at, dragging or focusing the globe
 *   waiting   the hold on the starting view, or the idle wait after a hold
 *   stopped   off screen, or the tab is hidden
 *   running   turning
 */
export type SpinState =
  'off' | 'paused' | 'held' | 'waiting' | 'stopped' | 'running';

/** The clock the rotation runs on; tests drive a fake one. */
export interface SpinClock {
  now(): number;
  frame(callback: (now: number) => void): number;
  cancelFrame(id: number): void;
  timer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
}

const browserClock: SpinClock = {
  now: () => performance.now(),
  frame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  timer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (id) => window.clearTimeout(id),
};

/** Smoothstep: the ramp up to full speed. */
const ramp = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export interface AutoSpinOptions {
  onState?(state: SpinState): void;
  clock?: SpinClock;
  speed?: number;
  dwellMs?: number;
  idleMs?: number;
  rampMs?: number;
  frameMs?: number;
}

/**
 * The toy globe's slow rotation (ruling R2-2). It turns only when allowed (`enable`), on screen,
 * in a visible tab, not paused by the visitor, not held, and once its wait is over: the hold on the
 * starting view after `enable`, or the idle wait after the last hold ends. Frames are scheduled only
 * while it runs, at most one per `frameMs`, and each start eases up to speed.
 */
export class AutoSpin {
  state: SpinState = 'off';
  private enabled = false;
  private paused = false;
  private onScreen = false;
  private pageShown = true;
  private ready = false;
  private readonly holds = new Set<string>();
  private wait = 0;
  private raf = 0;
  private last = 0;
  private began = 0;
  private readonly clock: SpinClock;
  private readonly speed: number;
  private readonly dwellMs: number;
  private readonly idleMs: number;
  private readonly rampMs: number;
  private readonly frameMs: number;

  constructor(
    private readonly turn: (degrees: number) => void,
    private readonly options: AutoSpinOptions = {},
  ) {
    this.clock = options.clock ?? browserClock;
    this.speed = options.speed ?? SPIN_DEG_PER_S;
    this.dwellMs = options.dwellMs ?? SPIN_DWELL_MS;
    this.idleMs = options.idleMs ?? SPIN_IDLE_MS;
    this.rampMs = options.rampMs ?? SPIN_RAMP_MS;
    this.frameMs = options.frameMs ?? SPIN_FRAME_MS;
  }

  /** The globe is live at its starting view: hold it there, then turn. */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.waitFor(this.dwellMs);
  }

  /** Back to off (the poster took over, or reduced motion). */
  disable(): void {
    this.enabled = false;
    this.clearWait();
    this.update();
  }

  /** The visitor's Pause (true) or Play (false). Play turns at once. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.clearWait();
      this.ready = true;
    }
    this.update();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  hold(reason: string): void {
    this.holds.add(reason);
    this.clearWait();
    this.ready = false;
    this.update();
  }

  release(reason: string): void {
    if (!this.holds.delete(reason)) return;
    if (this.holds.size === 0) this.waitFor(this.idleMs);
    else this.update();
  }

  setOnScreen(onScreen: boolean): void {
    this.onScreen = onScreen;
    this.update();
  }

  setPageShown(shown: boolean): void {
    this.pageShown = shown;
    this.update();
  }

  private clearWait(): void {
    if (this.wait) this.clock.clearTimer(this.wait);
    this.wait = 0;
  }

  private waitFor(ms: number): void {
    this.clearWait();
    this.ready = false;
    this.wait = this.clock.timer(() => {
      this.wait = 0;
      this.ready = true;
      this.update();
    }, ms);
    this.update();
  }

  private update(): void {
    const next: SpinState = !this.enabled
      ? 'off'
      : this.paused
        ? 'paused'
        : this.holds.size > 0
          ? 'held'
          : !this.ready
            ? 'waiting'
            : !this.onScreen || !this.pageShown
              ? 'stopped'
              : 'running';
    if (next !== this.state) {
      this.state = next;
      this.options.onState?.(next);
    }
    if (next === 'running' && !this.raf) {
      this.began = this.last = this.clock.now();
      this.raf = this.clock.frame(this.tick);
    } else if (next !== 'running' && this.raf) {
      this.clock.cancelFrame(this.raf);
      this.raf = 0;
    }
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (this.state !== 'running') return;
    const dt = now - this.last;
    if (dt >= this.frameMs - 1) {
      // A long gap (a stalled tab) never jumps the globe.
      const step = Math.min(dt, 100);
      this.last = now;
      this.turn(
        -((this.speed * step) / 1000) * ramp((now - this.began) / this.rampMs),
      );
    }
    if (this.state === 'running') this.raf = this.clock.frame(this.tick);
  };
}

/* ------------------------------------------------------------------ the island */

type CalloutKind = 'survey' | 'modeled' | 'unknown';

interface PreviewConfig {
  domain: [number, number];
  /** The callout objects, by index into the decoded surveys and areas. */
  survey: number;
  modeled: number;
  unknown: number;
}

interface PreviewData {
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

/** Decode off the critical path (spec §7: globe init ≤ 30 ms desktop). */
const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: 300 });
    else setTimeout(resolve, 0);
  });

async function loadData(): Promise<PreviewData> {
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

/** The figure's data load starts this far ahead of the viewport. */
const LOAD_AHEAD = '600px 0px';

export function initAtlasPreview(figure: HTMLElement): void {
  const globe = figure.querySelector<HTMLElement>('.hg-globe');
  const canvas = globe?.querySelector<HTMLCanvasElement>('.hg-canvas');
  const stage = figure.querySelector<HTMLElement>('[data-figure-stage]');
  const leaders = figure.querySelector<SVGSVGElement>('.hg-leaders');
  const spinToggle =
    figure.querySelector<HTMLButtonElement>('[data-spin-toggle]');
  const spinText = spinToggle?.querySelector<HTMLElement>('[data-spin-text]');
  if (!globe || !canvas || !stage || !spinToggle || !spinText) return;

  const config = JSON.parse(globe.dataset.config ?? '{}') as PreviewConfig;
  const reduced = prefersReducedMotion();
  const byOrder = (order: number) =>
    figure.querySelectorAll<HTMLElement | SVGElement>(
      `[data-callout-order="${order}"]`,
    );
  const kinds: CalloutKind[] = ['survey', 'modeled', 'unknown'];

  let loading: Promise<PreviewData> | null = null;
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
  figure.dataset.spin = 'off';
  // Printing shows the final state (spec §8) at the starting view, as the poster draws it.
  let printing =
    typeof matchMedia === 'function' && matchMedia('print').matches;

  /* ---- the rotation and its control ---- */

  const spin = new AutoSpin(
    (degrees) => {
      setView(view[0] + degrees, view[1]);
      probe();
    },
    {
      onState(state) {
        figure.dataset.spin = state;
        const off = state === 'off';
        spinToggle.hidden = off;
        const paused = spin.isPaused;
        spinText.textContent = paused ? 'Play' : 'Pause';
        spinToggle.setAttribute(
          'aria-label',
          paused ? 'Play the rotation' : 'Pause the rotation',
        );
        spinToggle.dataset.state = paused ? 'paused' : 'playing';
      },
    },
  );
  spinToggle.addEventListener('click', () => spin.setPaused(!spin.isPaused));
  new IntersectionObserver(([entry]) =>
    spin.setOnScreen(entry.isIntersecting),
  ).observe(globe);
  document.addEventListener('visibilitychange', () =>
    spin.setPageShown(!document.hidden),
  );

  /* ---- state shown in the markup ---- */

  const setCallouts = (shown: number) => {
    for (let order = 1; order <= 3; order += 1)
      byOrder(order).forEach((element) =>
        element.classList.toggle('is-off', order > shown),
      );
  };

  /** Pins (and, while the entrance turns the globe, leader ends) follow their objects. */
  const targets = new Map<CalloutKind, [number, number]>();
  const trackTargets = () => {
    if (!field) return;
    const box = globe.getBoundingClientRect();
    const frame = stage.getBoundingClientRect();
    const unit = 100 / frame.width;
    for (const kind of kinds) {
      const target = targets.get(kind);
      if (!target) continue;
      const [x, y, cosc] = projection.project(target[0], target[1]);
      const sx = ((box.left - frame.left + x) * unit).toFixed(2);
      const sy = ((box.top - frame.top + y) * unit).toFixed(2);
      const line = leaders?.querySelector(`[data-callout="${kind}"] line`);
      line?.setAttribute('x2', sx);
      line?.setAttribute('y2', sy);
      const marker = figure.querySelector<HTMLElement>(
        `.hg-marker[data-callout="${kind}"]`,
      );
      if (marker) {
        marker.style.left = `${(x / box.width) * 100}%`;
        marker.style.top = `${(y / box.height) * 100}%`;
        // Toward the limb a pin fades out: it marks its object, which is turning away.
        marker.style.setProperty(
          '--pin-alpha',
          clamp01((cosc - PIN_FADE[0]) / (PIN_FADE[1] - PIN_FADE[0])).toFixed(
            3,
          ),
        );
      }
    }
  };
  /** At the starting view the server-rendered positions are exact: drop the tracked ones. */
  const restoreTargets = () => {
    if (!leaders) return;
    for (const line of leaders.querySelectorAll<SVGLineElement>(
      'line[data-rest-x]',
    )) {
      line.setAttribute('x2', line.dataset.restX!);
      line.setAttribute('y2', line.dataset.restY!);
    }
    for (const marker of figure.querySelectorAll<HTMLElement>('.hg-marker'))
      for (const property of ['left', 'top', '--pin-alpha'])
        marker.style.removeProperty(property);
  };
  // Remember the server's leader end points so the starting view can put them back.
  leaders?.querySelectorAll<SVGLineElement>('line').forEach((line) => {
    line.dataset.restX = line.getAttribute('x2')!;
    line.dataset.restY = line.getAttribute('y2')!;
  });

  /* ---- view ---- */

  const atRest = () =>
    Math.abs(normalizeLon(view[0] - REST_VIEW[0])) < 1e-6 &&
    Math.abs(view[1] - REST_VIEW[1]) < 1e-6;
  /** True while the entrance turns the globe: its leaders follow their pins in. */
  let entering = false;
  /**
   * Turn to [lon, lat]. data-view is `rest` at the starting view, `entering` during the entrance
   * and `moved` otherwise; CSS shows the leader lines only for the first two.
   */
  const setView = (lon: number, lat: number) => {
    view = [normalizeLon(lon), clampLat(lat)];
    projection.rotate(view);
    field?.draw();
    if (atRest() || printing) {
      figure.dataset.view = 'rest';
      restoreTargets();
    } else {
      figure.dataset.view = entering ? 'entering' : 'moved';
      trackTargets();
    }
  };
  const stopMotion = () => {
    motion?.cancel();
    motion = null;
    if (inertia) cancelAnimationFrame(inertia);
    inertia = 0;
  };
  const finishEntrance = () => {
    if (controller && controller.state !== 'rest') controller.finish();
    entering = false;
  };

  /** Back to the starting view, where the callouts' leaders show again. */
  const goHome = (animate = !reduced) => {
    stopMotion();
    const [lon0, lat0] = view;
    const dLon = normalizeLon(REST_VIEW[0] - lon0);
    const dLat = REST_VIEW[1] - lat0;
    if (!animate || atRest()) {
      setView(REST_VIEW[0], REST_VIEW[1]);
      return;
    }
    motion = tween(
      HOME_MS,
      (eased) =>
        eased >= 1
          ? setView(REST_VIEW[0], REST_VIEW[1])
          : setView(lon0 + dLon * eased, lat0 + dLat * eased),
      easeCamera,
    );
  };

  /* ---- layers ---- */

  // Layers cross-fade; the legend swaps to the layer's own marks.
  const fadeTo = layerFader((next, amount) => field?.setLayer(next, amount), {
    reduced,
  });
  const layerButtons = [
    ...figure.querySelectorAll<HTMLButtonElement>('.hg-layers button'),
  ];
  /** Show `next`: its pressed segment, its legend, and (live) its marks. */
  const selectLayer = (next: HexLayer, instant = false) => {
    layer = next;
    for (const button of layerButtons)
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.value === next),
      );
    for (const legend of figure.querySelectorAll<HTMLElement>('[data-legend]'))
      legend.toggleAttribute('data-active', legend.dataset.legend === next);
    if (field) fadeTo(next, instant);
  };

  /* ---- live canvas or poster ---- */

  const forcedColours =
    typeof matchMedia === 'function'
      ? matchMedia('(forced-colors: active)')
      : null;
  /** Slow frames, Save-Data or missing data hold the poster for good; forced colours can end. */
  let posterHeld = false;

  const goLive = () => {
    if (!posterOnly) figure.dataset.live = '';
  };
  /** The poster is the Modeled layer at the starting view: the legend and view match it. */
  const usePoster = (hold = true) => {
    posterHeld ||= hold;
    posterOnly = true;
    spin.disable();
    stopMotion();
    finishEntrance();
    figure.dataset.mode = 'poster';
    delete figure.dataset.live;
    if (drag) {
      drag = null;
      delete figure.dataset.dragging;
    }
    if (layer !== 'modeled') selectLayer('modeled', true);
    setView(REST_VIEW[0], REST_VIEW[1]);
  };
  /** Forced colours ended: the live globe returns at its starting view, unless the poster is held. */
  const leavePoster = () => {
    if (!posterOnly || posterHeld) return;
    posterOnly = false;
    delete figure.dataset.mode;
    void ensureData().then(() => {
      if (posterOnly) return;
      restState();
      goLive();
      allowSpin();
    });
  };
  /** The fallback ladder (spec §4.1): read once, after 10 frames of the entrance, a drag or a turn. */
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
    setCallouts(3);
  };
  /** The rotation, wherever motion is allowed and the globe is live. */
  const allowSpin = () => {
    if (!reduced && !posterOnly) spin.enable();
  };

  const build = (loaded: PreviewData) => {
    field = new HexField(canvas, {
      areas: loaded.areas,
      surveys: loaded.surveys,
      projection,
      domain: config.domain,
      layer,
      globe: true,
      studScale: (width) => previewStudScale(width / 2 / DISC_PAD),
      fit(width, height, target) {
        target.scale = width / 2 / DISC_PAD;
        target.translate = [width / 2, height / 2];
      },
    });
    const survey = loaded.surveys[config.survey];
    targets.set('survey', [survey.lon, survey.lat]);
    targets.set('modeled', loaded.areas[config.modeled].center);
    targets.set('unknown', loaded.areas[config.unknown].center);
    new ResizeObserver(() => {
      field?.resize();
      if (figure.dataset.view === 'moved') trackTargets();
    }).observe(globe);
  };

  const ensureData = (): Promise<PreviewData> => {
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
    // The controller holds the figure's state (armed, playing or rest). It plays when 35% of the
    // figure is in view (MotionController), or rests at once under reduced motion or when the data
    // arrive with the figure already on screen.
    controller = steadyEntrance(figure, {
      duration: ENTRANCE_MS,
      arm() {
        goLive();
        entering = true;
        const frame = entranceAt(0);
        field!.reveal = frame.reveal;
        setView(frame.view[0], frame.view[1]);
        setCallouts(frame.callouts);
      },
      render(t) {
        const frame = entranceAt(t);
        field!.reveal = frame.reveal;
        setView(frame.view[0], frame.view[1]);
        setCallouts(frame.callouts);
        probe();
      },
      rest() {
        entering = false;
        goLive();
        restState();
        allowSpin();
      },
    });
    if (printing) controller.finish();
  };

  window.addEventListener('beforeprint', () => {
    printing = true;
    restoreTargets();
  });
  window.addEventListener('afterprint', () => {
    printing = false;
    setView(view[0], view[1]);
  });

  /* ---- interaction ---- */

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
  const turns = () => Boolean(field) && !posterOnly;

  globe.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') spin.hold('hover');
  });
  globe.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') spin.release('hover');
  });

  globe.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !turns()) return;
    spin.hold('drag');
    finishEntrance();
    stopMotion();
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
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
      globe.setPointerCapture(event.pointerId);
      figure.dataset.dragging = '';
    }
    if (!drag.moved) return;
    const r = radius();
    setView(drag.from[0] - (dx / r) * DEG, drag.from[1] + (dy / r) * DEG);
    const dt = Math.max(1, event.timeStamp - drag.lastT);
    drag.speed = ((-(event.clientX - drag.lastX) / r) * DEG) / dt;
    drag.lastX = event.clientX;
    drag.lastT = event.timeStamp;
    probe();
  });

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, speed, lastT } = drag;
    drag = null;
    delete figure.dataset.dragging;
    spin.release('drag');
    // Inertia: at most 1 s, and none under reduced motion.
    const recent = event.timeStamp - lastT < 80;
    if (!moved || reduced || !recent || Math.abs(speed) < 0.01) return;
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
    if (drag?.id !== event.pointerId) return;
    drag = null;
    delete figure.dataset.dragging;
    spin.release('drag');
  });

  // Keyboard (or scripted) focus holds the rotation while it lasts; the focus a click or tap gives
  // the globe does not, or a mouse visitor's globe would stay still until they clicked elsewhere.
  let pressed = false;
  globe.addEventListener('pointerdown', () => (pressed = true), {
    capture: true,
  });
  globe.addEventListener('focus', () => {
    if (!pressed) spin.hold('focus');
    pressed = false;
  });
  globe.addEventListener('blur', () => {
    pressed = false;
    spin.release('focus');
  });
  globe.addEventListener('keydown', (event) => {
    const turn: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP_DEG, 0],
      ArrowRight: [KEY_STEP_DEG, 0],
      ArrowUp: [0, KEY_STEP_DEG],
      ArrowDown: [0, -KEY_STEP_DEG],
    };
    if (event.key in turn) {
      event.preventDefault();
      if (!turns()) return;
      finishEntrance();
      stopMotion();
      const [dLon, dLat] = turn[event.key];
      setView(view[0] + dLon, view[1] + dLat);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (!turns()) return;
      finishEntrance();
      goHome(false);
    }
  });

  figure.addEventListener('segmented:change', (event) => {
    selectLayer((event as CustomEvent<{ value: HexLayer }>).detail.value);
  });

  forcedColours?.addEventListener('change', () => {
    if (forcedColours.matches) usePoster(false);
    else leavePoster();
  });

  if (saveData()) {
    // Save-Data: the poster stays, and no figure data is fetched.
    usePoster();
    return;
  }
  if (forcedColours?.matches) {
    usePoster(false);
    return;
  }
  // The data load waits until the figure nears the viewport: it is below the hero.
  const near = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      near.disconnect();
      void start().catch(() => {
        // No data, no canvas: the poster, pins and callouts already tell the story.
        usePoster();
      });
    },
    { rootMargin: LOAD_AHEAD },
  );
  near.observe(figure);
}
