/**
 * The scene timeline (round 2 spec §2.3 rules 8–9, §3.2; R2-7; #454): a small in-house timeline
 * over the Web Animations API, ported from the design prototype (`r2/characters/kit/clock.js`). No
 * GSAP, no Lottie, no animation library. One timeline per scene, three kinds of track, all on the
 * same clock:
 *
 *   story(el, frames)            plays once over [0, story]; holds its last frame (fill: both)
 *   loop(el, frames, period?)    starts exactly at `story` and repeats forever (delay = story,
 *                                fill: none); period is the loop or a whole multiple of it
 *   ambient(el, frames, period)  runs from 0 forever; period a whole multiple of the loop
 *
 * Frames are [ms, value, easingToNext?]: a string value is a transform, an object a keyframe
 * (`{ opacity: 0 }`, `{ '--n': 12 }`). Tracks are created in a fixed order (story, ambient, loop),
 * so a loop always composites above the story track of the same element, and `commit()` creates
 * them in idle-callback chunks so no task runs long (spec §7: no task over 50 ms at 4× CPU).
 *
 * Two WAAPI details the helper owns: a finished story track is never played again (WAAPI would
 * rewind it and replay the story after an offscreen pause), and `seek()` puts every track at the
 * same instant, which is what the motion hooks (motion-hooks.ts) scrub in tests.
 *
 * `sceneController` runs a scene's life (spec §3.2 items 4–7): build when near the viewport, start
 * the story at 35% visible, pause off screen or in a hidden tab, a sticky Pause, Replay, the end
 * state for print, and under `prefers-reduced-motion: reduce` nothing at all (zero Animations: the
 * server-rendered end state stays and the controls stay hidden).
 */
import { registerScene } from './motion-hooks';

export const EASE = {
  linear: 'linear',
  out: 'cubic-bezier(0.2, 0.72, 0.2, 1)', // --ease-figure
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)', // --ease-camera
  sine: 'cubic-bezier(0.37, 0, 0.63, 1)',
  up: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', // rising half of a parabola (quadratic ease-out)
  down: 'cubic-bezier(0.55, 0.085, 0.68, 0.53)', // falling half (quadratic ease-in)
  snap: 'cubic-bezier(0.7, 0, 0.9, 0.4)', // strikes
  back: 'cubic-bezier(0.3, 1.6, 0.55, 1)', // pop and settle with overshoot
  step: 'steps(1, end)', // instant switch at the next key (facing flips, swaps)
} as const;

export type Frame = [
  ms: number,
  value: string | Keyframe,
  easingToNext?: string,
];
export type Phase = 'story' | 'ambient' | 'loop';

export interface TimelineOptions {
  /** The story's length, ms. */
  story: number;
  /** The idle loop's length, ms (defaults to the story's). */
  loop?: number;
}

export interface TrackRequest {
  phase: Phase;
  el: Element;
  frames: Frame[];
  /** loop and ambient tracks: their period, a whole multiple of the loop */
  period?: number;
  composite?: CompositeOperation;
}

export interface PlannedTrack {
  phase: Phase;
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

const PHASES: Phase[] = ['story', 'ambient', 'loop'];

/** Keyframes over a track of `length` ms; the first and last values hold to the ends. */
export function toKeyframes(frames: Frame[], length: number): Keyframe[] {
  const sorted = [...frames].sort((a, b) => a[0] - b[0]);
  if (sorted[0][0] > 0) sorted.unshift([0, sorted[0][1]]);
  if (sorted[sorted.length - 1][0] < length)
    sorted.push([length, sorted[sorted.length - 1][1]]);
  return sorted.map(([t, value, easing]) => ({
    offset: Math.min(1, Math.max(0, t / length)),
    easing: easing || 'linear',
    ...(typeof value === 'string' ? { transform: value } : value),
  }));
}

/** The Animations a timeline creates, in creation order: story, then ambient, then loop. */
export function planTracks(
  requests: TrackRequest[],
  { story, loop = story }: TimelineOptions,
): PlannedTrack[] {
  const planned: PlannedTrack[] = [];
  for (const phase of PHASES)
    for (const request of requests) {
      if (request.phase !== phase) continue;
      const period = phase === 'story' ? story : (request.period ?? loop);
      if (phase !== 'story' && period % loop !== 0)
        throw new Error(
          `A ${phase} track's period (${period} ms) must be a whole multiple of the ${loop} ms loop.`,
        );
      const options: KeyframeAnimationOptions =
        phase === 'story'
          ? { duration: story, iterations: 1, fill: 'both' }
          : phase === 'loop'
            ? {
                duration: period,
                delay: story,
                iterations: Infinity,
                fill: 'none',
              }
            : { duration: period, iterations: Infinity, fill: 'both' };
      if (request.composite) options.composite = request.composite;
      planned.push({
        phase,
        el: request.el,
        keyframes: toKeyframes(request.frames, period),
        options,
      });
    }
  return planned;
}

/** The most tracks one idle callback creates. */
export const CHUNK_TRACKS = 120;

/** Split planned tracks into idle chunks: in order, one phase per chunk, at most `size` each. */
export function chunkTracks(
  planned: PlannedTrack[],
  size = CHUNK_TRACKS,
): PlannedTrack[][] {
  const chunks: PlannedTrack[][] = [];
  for (const track of planned) {
    const last = chunks[chunks.length - 1];
    if (last && last.length < size && last[0].phase === track.phase)
      last.push(track);
    else chunks.push([track]);
  }
  return chunks;
}

export interface Timeline {
  readonly storyMs: number;
  readonly loopMs: number;
  /** Once over [0, story]; holds its end. */
  story(
    el: Element | null,
    frames: Frame[],
    opts?: { composite?: CompositeOperation },
  ): void;
  /** From `story`, forever; `period` a whole multiple of the loop. */
  loop(el: Element | null, frames: Frame[], period?: number): void;
  /** From 0, forever; `period` a whole multiple of the loop. */
  ambient(el: Element | null, frames: Frame[], period: number): void;
  /** Any phase by name (the pose-track helpers use it). */
  track(
    phase: Phase,
    el: Element | null,
    frames: Frame[],
    period?: number,
  ): void;
  /** Create the queued Animations in idle chunks: story, then ambient, then loop. */
  commit(): Promise<void>;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  replay(): void;
  cancel(): void;
  /** The number of Animations created so far. */
  readonly count: number;
  readonly time: number;
  readonly playing: boolean;
  readonly storyDone: boolean;
}

const idle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: 120 });
    else setTimeout(resolve, 0);
  });

export function timeline(options: TimelineOptions): Timeline {
  const storyMs = options.story;
  const loopMs = options.loop ?? options.story;
  const anims: Record<Phase, Animation[]> = {
    story: [],
    ambient: [],
    loop: [],
  };
  const all = () => [...anims.story, ...anims.ambient, ...anims.loop];
  let pending: TrackRequest[] = [];
  let time = 0;
  let committing: Promise<void> = Promise.resolve();

  const now = () => {
    const first = anims.ambient[0] ?? anims.loop[0] ?? anims.story[0];
    return first ? Number(first.currentTime ?? time) : time;
  };
  const create = (tracks: PlannedTrack[]) => {
    const at = now();
    const running = all().some(
      (animation) => animation.playState === 'running',
    );
    for (const track of tracks) {
      const animation = track.el.animate(track.keyframes, track.options);
      animation.pause();
      animation.currentTime = at;
      if (running && !(track.phase === 'story' && at >= storyMs))
        animation.play();
      anims[track.phase].push(animation);
    }
  };
  const take = () => {
    const plan = planTracks(pending, { story: storyMs, loop: loopMs });
    pending = [];
    return plan;
  };
  /** Any track still queued is created now, so a control never acts on half a scene. */
  const flush = () => {
    if (pending.length) create(take());
  };
  const add = (request: TrackRequest) => {
    if (request.el && request.frames.length) pending.push(request);
  };

  const api: Timeline = {
    storyMs,
    loopMs,
    story(el, frames, opts = {}) {
      if (el) add({ phase: 'story', el, frames, composite: opts.composite });
    },
    loop(el, frames, period) {
      if (el) add({ phase: 'loop', el, frames, period });
    },
    ambient(el, frames, period) {
      if (el) add({ phase: 'ambient', el, frames, period });
    },
    track(phase, el, frames, period) {
      if (el) add({ phase, el, frames, period });
    },
    commit() {
      const chunks = chunkTracks(take());
      committing = committing.then(async () => {
        for (const chunk of chunks) {
          await idle();
          create(chunk);
        }
      });
      return committing;
    },
    play() {
      flush();
      // A finished story track must not be played again: WAAPI would rewind it to 0.
      for (const animation of anims.story)
        if (Number(animation.currentTime) < storyMs) animation.play();
      for (const animation of anims.ambient) animation.play();
      for (const animation of anims.loop) animation.play();
    },
    pause() {
      flush();
      time = now();
      for (const animation of all()) animation.pause();
    },
    seek(ms) {
      flush();
      time = ms;
      for (const animation of all()) {
        animation.pause();
        animation.currentTime = ms;
      }
    },
    replay() {
      api.seek(0);
      api.play();
    },
    cancel() {
      for (const animation of all()) animation.cancel();
      anims.story.length = anims.ambient.length = anims.loop.length = 0;
      pending = [];
    },
    get count() {
      return all().length;
    },
    get time() {
      return now();
    },
    get playing() {
      return all().some((animation) => animation.playState === 'running');
    },
    get storyDone() {
      return now() >= storyMs;
    },
  };
  return api;
}

/* -------------------------------------------------------------------------- scene controller */

export type SceneState = 'idle' | 'armed' | 'playing' | 'paused' | 'rest';

export interface SceneOptions {
  /** Registered with the motion hooks (motion-hooks.ts): orbit, board, crew, steps, people … */
  name: string;
  /** The timeline's story and loop lengths. */
  timeline: TimelineOptions;
  /** The story starts at this share visible (default 0.35). */
  threshold?: number;
  /** Import and build within this margin of the viewport (default '100%': one viewport). */
  nearMargin?: string;
  /** SceneControls' buttons: the Pause/Play toggle and Replay. */
  controls?: {
    toggle?: HTMLButtonElement | null;
    replay?: HTMLButtonElement | null;
  };
}

export interface SceneController {
  readonly state: SceneState;
  readonly timeline: Timeline | null;
  play(): void;
  pause(): void;
  replay(): void;
  /** Build now (if not yet) and put every track at `ms`, paused. Resolves once built. */
  seek(ms: number): Promise<void>;
}

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Run one scene: `build(tl)` adds the scene's tracks to a fresh timeline (it may be async, e.g. to
 * import the scene module), and the controller does the rest. Under reduced motion nothing is
 * built and the controls stay hidden; `figure.dataset.sceneState` mirrors the state.
 */
export function sceneController(
  figure: HTMLElement,
  build: (tl: Timeline) => void | Promise<void>,
  options: SceneOptions,
): SceneController {
  const threshold = options.threshold ?? 0.35;
  const toggle = options.controls?.toggle ?? null;
  const replayButton = options.controls?.replay ?? null;
  let state: SceneState = 'idle';
  let tl: Timeline | null = null;
  let built: Promise<Timeline> | null = null;
  let started = false;
  let userPaused = false;
  let onScreen = false;

  const setState = (next: SceneState) => {
    state = next;
    figure.dataset.sceneState = next;
  };

  if (reducedMotion()) {
    toggle?.setAttribute('hidden', '');
    replayButton?.setAttribute('hidden', '');
    setState('rest');
    const rest: SceneController = {
      get state() {
        return state;
      },
      timeline: null,
      play() {},
      pause() {},
      replay() {},
      seek: async () => {},
    };
    return rest;
  }

  const label = () => {
    if (!toggle) return;
    toggle.setAttribute('aria-pressed', String(userPaused));
    toggle.dataset.state = userPaused ? 'paused' : 'playing';
  };
  const ensure = (): Promise<Timeline> => {
    built ??= (async () => {
      const next = timeline(options.timeline);
      await build(next);
      await next.commit();
      next.seek(0);
      tl = next;
      if (!started) setState('armed');
      return next;
    })();
    return built;
  };
  let restTimer = 0;
  const sync = () => {
    window.clearTimeout(restTimer);
    if (!tl || !started) return;
    const run = !userPaused && onScreen && !document.hidden;
    if (run && !tl.playing) tl.play();
    if (!run && tl.playing) tl.pause();
    setState(run ? (tl.playing ? 'playing' : 'rest') : 'paused');
    // A scene without loops rests when its story ends: look again then.
    if (run && tl.playing && !tl.storyDone)
      restTimer = window.setTimeout(sync, tl.storyMs - tl.time + 50);
  };
  const start = () => {
    if (started) return;
    started = true;
    void ensure().then(sync);
  };

  const near = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      void ensure();
      near.disconnect();
    },
    { rootMargin: `${options.nearMargin ?? '100%'} 0px` },
  );
  const seen = new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      const fills = entry.intersectionRect.height >= threshold * innerHeight;
      if (
        entry.isIntersecting &&
        (entry.intersectionRatio >= threshold || fills)
      )
        start();
      sync();
    },
    { threshold: [0, 0.1, 0.2, threshold, 0.5] },
  );
  near.observe(figure);
  seen.observe(figure);
  document.addEventListener('visibilitychange', sync);
  // Printing shows the story's end (spec §8).
  window.addEventListener('beforeprint', () => {
    if (tl) tl.seek(tl.storyMs);
  });

  toggle?.addEventListener('click', () => {
    userPaused = !userPaused;
    label();
    if (!started) start();
    else sync();
  });
  replayButton?.addEventListener('click', () => {
    userPaused = false;
    label();
    void ensure().then((timeline) => {
      started = true;
      timeline.seek(0);
      sync();
    });
  });
  toggle?.removeAttribute('hidden');
  replayButton?.removeAttribute('hidden');
  label();

  const controller: SceneController = {
    get state() {
      return state;
    },
    get timeline() {
      return tl;
    },
    play() {
      userPaused = false;
      label();
      if (!started) start();
      else sync();
    },
    pause() {
      userPaused = true;
      label();
      sync();
      if (tl) setState('paused');
    },
    replay() {
      replayButton?.click();
    },
    async seek(ms) {
      const timeline = await ensure();
      started = true;
      userPaused = true;
      label();
      timeline.seek(ms);
      setState('paused');
    },
  };

  registerScene({
    name: options.name,
    story: options.timeline.story,
    ready: () => ensure().then(() => undefined),
    seek: (ms) => controller.seek(ms),
    pause: () => controller.pause(),
    play: () => controller.play(),
    get time() {
      return tl ? tl.time : 0;
    },
  });
  return controller;
}
