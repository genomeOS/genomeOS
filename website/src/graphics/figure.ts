/** FigureController: play once, then rest (site redesign spec §2.7, #454).
 *
 * Every animated figure goes through one controller, so the motion rules hold everywhere:
 *
 * 1. A figure plays its entrance once, when 35% of it is visible, and never loops.
 * 2. After rest it schedules no frame. Frames are only scheduled while the figure is on screen and
 *    the tab is visible; a figure that leaves the viewport (or a tab that hides) mid-entrance jumps
 *    straight to rest.
 * 3. `prefers-reduced-motion: reduce` shows the final state at once; replay is instant too.
 * 4. Above the fold never flashes: a figure on screen when it becomes ready arms its "before" state
 *    only if that happens within 1,200 ms of navigation start; later, it simply shows rest.
 * 5. Replay is always explicit (`replay()`, from a control the visitor pressed).
 * 6. Printing shows the final state: a figure still armed or playing finishes on `beforeprint`
 *    (spec §8, "final SVG states print"). CSS keeps "before" styles to `@media screen`, too.
 *
 * Server-rendered markup is already the final state; `arm()` hides what the entrance will
 * reveal. The element's `data-figure-state` reflects the phase: armed, playing, rest.
 *
 * Plays on the `graphic:play` event that MotionController dispatches for `[data-graphic]`; pages
 * without MotionController (Starlight) fall back to the controller's own observer.
 *
 * Motion hooks (round 2 spec §3.4): in dev and in the e2e build (`MOTION_HOOKS`), `?t=<ms>`
 * freezes every figure (or, with `&scene=<data-graphic>`, one) at that moment of its entrance, for
 * `scripts/capture-site.mjs` entrance frames and screenshot tests, and every figure registers with
 * `window.__motion` under its `data-graphic` name. The deployed build carries none of it.
 */
import { MOTION_HOOKS, frozenAt, registerScene } from './motion-hooks';

export const PLAY_THRESHOLD = 0.35;
export const READY_BY_MS = 1200;

export type FigureState = 'armed' | 'playing' | 'rest';

export interface FigureMotion {
  /** Entrance length in ms. */
  duration: number;
  /** Hide what the entrance reveals. Only called when the entrance will play. */
  arm?(): void;
  /** The entrance begins (add classes for CSS keyframes here). */
  start?(): void;
  /** Draw the entrance at `t` ms. Omit for a CSS-only entrance. */
  render?(t: number): void;
  /** The final, most informative state. Also the reduced-motion and skipped state. */
  rest(): void;
}

export interface FigureControllerOptions {
  threshold?: number;
  readyBy?: number;
  /**
   * Register with the motion hooks under the figure's `data-graphic` (default true). False for a
   * figure that registers a scene of its own under that name (the Atlas preview: entrance, hold
   * and turn, round 2 spec §3.4), which would otherwise replace this one with a warning.
   */
  register?: boolean;
}

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The freeze time from `?t=<ms>` (motion hooks only), or null. */
function frozenTime(name: string): number | null {
  if (!MOTION_HOOKS || typeof location === 'undefined') return null;
  return frozenAt(location.search, name);
}

function domContentLoaded(): Promise<void> {
  const [navigation] = performance.getEntriesByType(
    'navigation',
  ) as PerformanceNavigationTiming[];
  if (
    document.readyState === 'complete' ||
    (navigation && navigation.domContentLoadedEventStart > 0)
  )
    return Promise.resolve();
  return new Promise((resolve) =>
    document.addEventListener('DOMContentLoaded', () => resolve(), {
      once: true,
    }),
  );
}

function inViewport(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return (
    box.bottom > 0 &&
    box.right > 0 &&
    box.top < innerHeight &&
    box.left < innerWidth &&
    box.width > 0 &&
    box.height > 0
  );
}

export class FigureController {
  readonly element: HTMLElement;
  readonly reduced: boolean;
  state: FigureState = 'rest';
  private readonly motion: FigureMotion;
  private readonly threshold: number;
  private onScreen = true;
  private frames = new Set<number>();
  private started = 0;
  private timer = 0;
  private playObserver: IntersectionObserver | null = null;
  private screenObserver: IntersectionObserver | null = null;
  private readonly frozenAt: number | null;
  private scrubbedAt = 0;
  private readonly onPlay = () => this.play();
  private readonly onVisibility = () => {
    if (document.hidden && this.state === 'playing') this.finish();
  };
  private readonly onPrint = () => {
    if (this.state !== 'rest') this.finish();
  };

  constructor(
    element: HTMLElement,
    motion: FigureMotion,
    {
      threshold = PLAY_THRESHOLD,
      readyBy = READY_BY_MS,
      register = true,
    }: FigureControllerOptions = {},
  ) {
    this.element = element;
    this.motion = motion;
    this.threshold = threshold;
    this.reduced = prefersReducedMotion();
    const name = element.dataset.graphic ?? 'figure';
    this.frozenAt = frozenTime(name);
    if (register) this.register(name);

    window.addEventListener('beforeprint', this.onPrint);
    if (this.frozenAt !== null) {
      this.setState('armed');
      motion.arm?.();
      this.freeze(this.frozenAt);
      return;
    }
    if (this.reduced || (inViewport(element) && performance.now() > readyBy)) {
      this.finish();
      return;
    }
    this.setState('armed');
    motion.arm?.();
    element.addEventListener('graphic:play', this.onPlay);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.screenObserver = new IntersectionObserver(([entry]) => {
      this.onScreen = entry.isIntersecting;
      if (!this.onScreen && this.state === 'playing') this.finish();
    });
    this.screenObserver.observe(element);
    if (element.hasAttribute('data-graphic-played')) this.play();
    else void domContentLoaded().then(() => this.observeIfAlone());
  }

  /** Without MotionController's observer on the page, watch for 35% visibility here. */
  private observeIfAlone(): void {
    if (this.state !== 'armed') return;
    if (document.documentElement.hasAttribute('data-graphic-observer')) return;
    this.playObserver = new IntersectionObserver(
      ([entry]) => {
        const fills =
          entry.intersectionRect.height >= this.threshold * innerHeight;
        if (entry.intersectionRatio >= this.threshold || fills) this.play();
      },
      { threshold: [0, 0.1, 0.2, this.threshold, 0.5] },
    );
    this.playObserver.observe(this.element);
  }

  private setState(state: FigureState): void {
    this.state = state;
    this.element.dataset.figureState = state;
  }

  /** Begin the entrance. Only an armed figure plays. */
  play(): void {
    if (this.state !== 'armed') return;
    this.playObserver?.disconnect();
    this.setState('playing');
    this.motion.start?.();
    this.started = performance.now();
    if (this.motion.render) {
      const step = (now: number) => {
        const t = now - this.started;
        if (t >= this.motion.duration) {
          this.finish();
          return;
        }
        this.motion.render!(t);
        this.frame(step);
      };
      this.motion.render(0);
      this.frame(step);
    } else {
      this.timer = window.setTimeout(() => this.finish(), this.motion.duration);
    }
  }

  /** Play the entrance again, because the visitor asked. Reduced motion: rest at once. */
  replay(): void {
    this.cancel();
    if (this.reduced) {
      this.finish();
      return;
    }
    this.setState('armed');
    this.motion.arm?.();
    // A frame between arm and play, so CSS sees the before state.
    requestAnimationFrame(() => this.play());
  }

  /** Jump to the final state and stop scheduling anything. */
  finish(): void {
    this.cancel();
    this.setState('rest');
    this.motion.rest();
  }

  /** requestAnimationFrame, but only while the entrance plays on screen in a visible tab. */
  frame(callback: FrameRequestCallback): number {
    if (this.state !== 'playing' || !this.onScreen || document.hidden) return 0;
    const id = requestAnimationFrame((now) => {
      this.frames.delete(id);
      callback(now);
    });
    this.frames.add(id);
    return id;
  }

  private cancel(): void {
    for (const id of this.frames) cancelAnimationFrame(id);
    this.frames.clear();
    window.clearTimeout(this.timer);
  }

  /** The figure's entrance as a scrubbable scene (motion-hooks.ts); a no-op in the deployed build. */
  private register(name: string): void {
    if (!MOTION_HOOKS) return;
    const figure = this;
    registerScene({
      name,
      story: this.motion.duration,
      seek: (t) => {
        figure.cancel();
        figure.setState('armed');
        figure.motion.arm?.();
        figure.scrubbedAt = t;
        figure.freeze(t);
      },
      pause: () => figure.cancel(),
      play: () => figure.replay(),
      get time() {
        if (
          figure.state === 'playing' &&
          !figure.element.hasAttribute('data-figure-frozen')
        )
          return performance.now() - figure.started;
        return figure.state === 'rest'
          ? figure.motion.duration
          : figure.scrubbedAt;
      },
    });
  }

  private freeze(t: number): void {
    this.setState('playing');
    this.motion.start?.();
    if (t >= this.motion.duration) {
      this.finish();
      return;
    }
    this.motion.render?.(t);
    // CSS-driven entrances freeze through a negative animation delay the figure reads.
    this.element.style.setProperty('--figure-freeze', `-${t}ms`);
    this.element.dataset.figureFrozen = '';
  }

  dispose(): void {
    this.cancel();
    this.playObserver?.disconnect();
    this.screenObserver?.disconnect();
    this.element.removeEventListener('graphic:play', this.onPlay);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeprint', this.onPrint);
  }
}

/**
 * A live-region writer for a figure's readout: it speaks only when the visitor changed
 * something, at most once per 400 ms; the last text always lands. `render` lays the text out (one
 * fact a line, say); by default it is the region's text.
 */
export function createAnnouncer(
  region: HTMLElement,
  intervalMs = 400,
  render: (region: HTMLElement, text: string) => void = (target, text) => {
    target.textContent = text;
  },
) {
  let last = 0;
  let pending = 0;
  let next: string | null = null;
  const write = () => {
    pending = 0;
    if (next === null) return;
    render(region, next);
    next = null;
    last = performance.now();
  };
  return (text: string) => {
    next = text;
    const wait = last + intervalMs - performance.now();
    if (wait <= 0 && !pending) write();
    else if (!pending) pending = window.setTimeout(write, Math.max(0, wait));
  };
}
