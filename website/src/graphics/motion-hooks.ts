/**
 * Motion hooks: deterministic animation in tests (round 2 spec §2.3 rule 9, §3.4; #454). Every
 * scene and figure registers here; in dev and in the e2e build (`PUBLIC_MOTION_HOOKS=1`, which only
 * `npm run build:e2e` may set: integrations/dev-kit.mjs refuses it elsewhere) the page exposes
 * `window.__motion`, and `?t=<ms>[&scene=<name>]` freezes every scene (or the named one) at that
 * moment once it is built. In the deployed build `MOTION_HOOKS` is false at build time, so none of
 * this ships (tests/motion-hooks.test.ts).
 *
 *   window.__motion.names()            the registered scene names
 *   window.__motion.ready(name)        resolves once that scene is built
 *   window.__motion.seek(name, ms)     fonts loaded, the scene built, every track at ms, paused
 *   window.__motion.pauseAll()         the visitor's Pause on every scene
 *   window.__motion.time(name)         a scene's clock, ms
 */

export const MOTION_HOOKS: boolean =
  import.meta.env.DEV || import.meta.env.PUBLIC_MOTION_HOOKS === '1';

export interface Scrubbable {
  name: string;
  /** The story's (or entrance's) length, ms. */
  story: number;
  /** Put the scene at `ms`, paused (building it first if it is not built yet). */
  seek(ms: number): void | Promise<void>;
  pause(): void;
  play(): void;
  readonly time: number;
  /** Resolves once the scene is built and seekable (default: at once). */
  ready?(): Promise<void>;
}

export interface MotionHooks {
  names(): string[];
  ready(name: string): Promise<void>;
  seek(name: string, ms: number): Promise<void>;
  pauseAll(): void;
  time(name: string): number;
}

declare global {
  interface Window {
    __motion?: MotionHooks;
  }
}

/** The freeze the URL asks for: `?t=<ms>`, for every scene or (with `&scene=`) one. */
export function frozenAt(search: string, name: string): number | null {
  const params = new URLSearchParams(search);
  const value = params.get('t');
  if (value === null) return null;
  const only = params.get('scene');
  if (only !== null && only !== name) return null;
  const t = Number(value);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(count);
  });

/** Register a scene with the hooks; does nothing unless MOTION_HOOKS. */
export function registerScene(scene: Scrubbable): void {
  if (!MOTION_HOOKS || typeof window === 'undefined') return;
  const registry = install();
  registry.scenes.set(scene.name, scene);
  registry.waiters.get(scene.name)?.forEach((resolve) => resolve(scene));
  registry.waiters.delete(scene.name);
  const t = frozenAt(location.search, scene.name);
  if (t !== null)
    void (scene.ready?.() ?? Promise.resolve()).then(() => scene.seek(t));
}

interface Registry {
  scenes: Map<string, Scrubbable>;
  waiters: Map<string, ((scene: Scrubbable) => void)[]>;
}

let registry: Registry | null = null;

function install(): Registry {
  if (registry) return registry;
  const state: Registry = { scenes: new Map(), waiters: new Map() };
  registry = state;
  const find = (name: string) =>
    new Promise<Scrubbable>((resolve) => {
      const scene = state.scenes.get(name);
      if (scene) resolve(scene);
      else
        state.waiters.set(name, [...(state.waiters.get(name) ?? []), resolve]);
    });
  window.__motion = {
    names: () => [...state.scenes.keys()],
    async ready(name) {
      const scene = await find(name);
      await (scene.ready?.() ?? Promise.resolve());
    },
    async seek(name, ms) {
      await document.fonts.ready;
      const scene = await find(name);
      await (scene.ready?.() ?? Promise.resolve());
      await scene.seek(ms);
      await frames(2);
    },
    pauseAll() {
      for (const scene of state.scenes.values()) scene.pause();
    },
    time: (name) => state.scenes.get(name)?.time ?? NaN,
  };
  return state;
}
