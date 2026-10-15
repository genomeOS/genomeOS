/** The Home hero's background film (site redesign round 2, ruling R2-1 and rulings 21–22 of the
 * round-2 build; round 2 spec §4.1.1 and §0.3; #454).
 *
 * HeroMedia.astro renders the poster (the LCP, in AVIF and WebP) and an empty, muted `<video>`.
 * This island decides whether the film plays at all, and only after the page's load event, so the
 * poster always wins LCP and the film never competes with the page's own requests:
 *
 *   poster stays   prefers-reduced-motion, Save-Data, a slow-2g, 2g or 3g connection, a poster that
 *                  arrived below 1.5 Mbit/s where NetworkInformation is missing (Safari, Firefox),
 *                  or no source the browser can play (`data-video="poster"`, the reason in
 *                  `data-video-reason`). Nothing then moves, so no Pause control is shown.
 *   remembered     a visitor who paused the film once keeps it paused on later visits
 *                  (`localStorage` `genomeos:hero-motion` = `paused`): no source is attached, and
 *                  the control offers Play over the poster; pressing it attaches the film.
 *   rendition      the smallest width that covers the viewport at up to 2x (pickRendition): 720p on
 *                  phones and small laptops, 1080p on desktops. Sources keep their given order
 *                  (AV1, then HEVC), filtered by `canPlayType`.
 *   fade           the film fades in over the poster once its first frame is presented.
 *   pause          a white Pause/Play glyph with no background (WCAG 2.2.2: the loop runs about a
 *                  minute; ruling 22), named for what it does. The film also pauses while the hero
 *                  is off screen or the tab is hidden, and resumes only if the visitor has not
 *                  paused it.
 *   scroll fade    CSS scroll-driven animation (hero-media.css); where `animation-timeline` is
 *                  missing, a rAF-throttled scroll listener sets `--hero-recede` instead
 *                  (recedeAt). Neither runs under reduced motion.
 *   motion hooks   the film registers as the `hero-film` scene: seeking sets its `currentTime`
 *                  (round 2 spec §3.4; e2e and dev builds only).
 */
import { registerScene } from '../../graphics/motion-hooks';

export interface HeroVideoSource {
  /** Site path of the file, e.g. '/media/hero/hero-1080.av1.mp4'. */
  src: string;
  /** MIME type with its codecs parameter, checked with `canPlayType`. */
  type: string;
  /** Frame width in pixels: the rendition this file belongs to. */
  width: number;
}

/** A phone's 3x screen still gets the 720p film: past 2x the film's softness, not its size, shows. */
export const MAX_VIDEO_DPR = 2;

/** Connections too slow for a 2–4 MB film (NetworkInformation.effectiveType). */
export const SLOW_CONNECTIONS: ReadonlySet<string> = new Set([
  'slow-2g',
  '2g',
  '3g',
]);

/**
 * Where NetworkInformation is missing, a poster that arrived below this rate (kbit/s) keeps the
 * film off: about 1.5 Mbit/s, the 3g line the film's other gate draws (round 2 spec §0.3 #19).
 */
export const SLOW_KBPS = 1500;

/** The scroll fade's length, as a share of the hero's height (hero-media.css uses the same span). */
export const RECEDE_SPAN = 0.75;

/** The visitor's Pause, remembered per browser (round 2 spec §0.3 #17). */
export const HERO_MOTION_KEY = 'genomeos:hero-motion';

export type PosterReason =
  | 'reduced-motion'
  | 'save-data'
  | 'slow-connection'
  | 'unsupported'
  | 'remembered-pause'
  | 'error';

/**
 * The sources of the rendition this screen needs, in their given order: the smallest width at
 * least the viewport's width in device pixels (capped at 2x), or the largest there is.
 */
export function pickRendition<T extends { width: number }>(
  sources: readonly T[],
  viewportWidth: number,
  devicePixelRatio: number,
): T[] {
  const widths = [...new Set(sources.map((source) => source.width))].sort(
    (a, b) => a - b,
  );
  if (widths.length === 0) return [];
  const need =
    viewportWidth * Math.min(Math.max(devicePixelRatio, 1), MAX_VIDEO_DPR);
  const width = widths.find((candidate) => candidate >= need) ?? widths.at(-1);
  return sources.filter((source) => source.width === width);
}

/** The parts of a PerformanceResourceTiming entry the throughput rule reads. */
export interface PosterTiming {
  transferSize?: number;
  startTime: number;
  requestStart?: number;
  responseEnd?: number;
}

/**
 * How fast the poster arrived, in kbit/s: its transferred bytes over the time from its request (or,
 * without request timing, the entry's start) to its response's end. Null when unknown: a cached
 * poster (`transferSize` 0), a browser that reports no size, or no time to divide by. Unknown
 * never blocks the film.
 */
export function throughputKbps(
  entry: PosterTiming | null | undefined,
): number | null {
  if (!entry || !entry.transferSize || !entry.responseEnd) return null;
  const from =
    entry.requestStart && entry.requestStart > 0
      ? entry.requestStart
      : entry.startTime;
  const elapsed = entry.responseEnd - from;
  if (!(elapsed > 0)) return null;
  return (entry.transferSize * 8) / elapsed;
}

/** Why the poster stays, or null when the film may play. */
export function posterReason(environment: {
  reducedMotion: boolean;
  saveData?: boolean;
  effectiveType?: string;
  /** Whether the browser has NetworkInformation (`navigator.connection`). */
  networkInfo?: boolean;
  /** The poster's throughput (throughputKbps), read where NetworkInformation is missing. */
  throughputKbps?: number | null;
  /** How many of the film's sources the browser can play; omitted when not yet known. */
  playable?: number;
}): PosterReason | null {
  if (environment.reducedMotion) return 'reduced-motion';
  if (environment.saveData) return 'save-data';
  if (
    environment.effectiveType &&
    SLOW_CONNECTIONS.has(environment.effectiveType)
  )
    return 'slow-connection';
  if (
    environment.networkInfo === false &&
    typeof environment.throughputKbps === 'number' &&
    environment.throughputKbps < SLOW_KBPS
  )
    return 'slow-connection';
  if (environment.playable === 0) return 'unsupported';
  return null;
}

/** How far the hero has receded, 0–1, for the scroll fade's script fallback. */
export function recedeAt(
  scrollY: number,
  top: number,
  height: number,
  span = RECEDE_SPAN,
): number {
  if (height <= 0) return 0;
  return Math.min(1, Math.max(0, (scrollY - top) / (height * span)));
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>;

/** Whether this visitor paused the film before. Blocked or missing storage reads as no. */
export function rememberedPause(
  storage: ReadStorage | null | undefined,
): boolean {
  try {
    return storage?.getItem(HERO_MOTION_KEY) === 'paused';
  } catch {
    return false;
  }
}

/** Remember the visitor's Pause, or forget it on Play. Never throws. */
export function rememberPause(
  storage: WriteStorage | null | undefined,
  paused: boolean,
): void {
  try {
    if (paused) storage?.setItem(HERO_MOTION_KEY, 'paused');
    else storage?.removeItem(HERO_MOTION_KEY);
  } catch {
    // A private window or blocked site data: the Pause holds for this visit only.
  }
}

/** The page's localStorage, or null where reading it throws. */
function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface Connection {
  saveData?: boolean;
  effectiveType?: string;
}

const LABEL = {
  pause: 'Pause the background video',
  play: 'Play the background video',
} as const;

export function initHeroMedia(root: HTMLElement): void {
  const video = root.querySelector<HTMLVideoElement>('video');
  const toggle = root.querySelector<HTMLButtonElement>('[data-video-toggle]');
  const name = toggle?.querySelector<HTMLElement>('[data-video-toggle-text]');
  const backdrop = root.querySelector<HTMLElement>('[data-hero-backdrop]');
  const poster = root.querySelector<HTMLImageElement>('.hero-media__poster');
  if (!video || !toggle || !name) return;

  const sources = JSON.parse(
    video.dataset.sources ?? '[]',
  ) as HeroVideoSource[];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const connection = (navigator as Navigator & { connection?: Connection })
    .connection;

  let started = false;
  let failed = false;
  let userPaused = false;
  let onScreen = true;
  let framed = false;
  /** Sources are attached once, when the film may play or the visitor asks for it. */
  let attach: (() => void) | null = null;
  let readyFilm: () => void = () => {};
  const filmReady = new Promise<void>((resolve) => (readyFilm = resolve));

  /** The glyph shows what a press does; the name says it in words (ruling 22). */
  const setLabel = (paused: boolean) => {
    name.textContent = paused ? LABEL.play : LABEL.pause;
    toggle.dataset.state = paused ? 'paused' : 'playing';
  };

  /** Back to the poster for good (an error, or reduced motion turned on mid-visit). */
  const keepPoster = (reason: PosterReason) => {
    failed = true;
    root.dataset.video = 'poster';
    root.dataset.videoReason = reason;
    toggle.hidden = true;
    if (!video.paused) video.pause();
    readyFilm();
  };

  const render = () => {
    if (failed) return;
    if (!started) root.dataset.video = 'poster';
    else if (userPaused) root.dataset.video = 'paused';
    else root.dataset.video = framed ? 'playing' : 'loading';
  };

  /** Play while the hero is on screen in a visible tab, unless the visitor paused it. */
  const sync = () => {
    render();
    if (!started || failed) return;
    const run = onScreen && !document.hidden && !userPaused;
    if (run && video.paused) {
      video.play().catch(() => {
        // Autoplay refused (a low-power mode, a policy): stay put and offer Play.
        if (failed) return;
        userPaused = true;
        setLabel(true);
        render();
      });
    } else if (!run && !video.paused) video.pause();
  };

  const markFramed = () => {
    if (framed) return;
    framed = true;
    root.dataset.videoFrame = '';
    render();
  };

  /** Attach the playable sources and start (or, paused, just load) the film. */
  const start = (playable: HeroVideoSource[]) => {
    started = true;
    delete root.dataset.videoReason;
    for (const { src, type } of playable) {
      const source = document.createElement('source');
      source.src = src;
      source.type = type;
      video.append(source);
    }
    // The last source failing means none could play: the poster stays.
    video.lastElementChild?.addEventListener('error', () =>
      keepPoster('error'),
    );
    video.addEventListener('error', () => keepPoster('error'));
    video.addEventListener('loadeddata', () => readyFilm(), { once: true });
    video.addEventListener('playing', () => {
      if ('requestVideoFrameCallback' in video)
        video.requestVideoFrameCallback(markFramed);
      else requestAnimationFrame(markFramed);
    });
    toggle.hidden = false;
    setLabel(userPaused);
    sync();
  };

  const begin = () => {
    if (started || failed) return;
    const timing = poster?.currentSrc
      ? (performance.getEntriesByName(poster.currentSrc)[0] as
          PerformanceResourceTiming | undefined)
      : undefined;
    const playable = pickRendition(
      sources,
      innerWidth,
      devicePixelRatio || 1,
    ).filter((source) => video.canPlayType(source.type) !== '');
    const reason = posterReason({
      reducedMotion: reduce.matches,
      saveData: connection?.saveData,
      effectiveType: connection?.effectiveType,
      networkInfo: Boolean(connection),
      throughputKbps: connection ? null : throughputKbps(timing),
      playable: playable.length,
    });
    if (reason) {
      keepPoster(reason);
      return;
    }
    if (rememberedPause(localStore())) {
      // Paused on an earlier visit: nothing is fetched until the visitor presses Play.
      userPaused = true;
      root.dataset.videoReason = 'remembered-pause';
      attach = () => start(playable);
      toggle.hidden = false;
      setLabel(true);
      readyFilm();
      return;
    }
    start(playable);
  };

  toggle.addEventListener('click', () => {
    userPaused = !userPaused;
    rememberPause(localStore(), userPaused);
    setLabel(userPaused);
    if (attach && !userPaused) {
      const run = attach;
      attach = null;
      run();
      return;
    }
    sync();
  });

  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    sync();
  }).observe(root);
  document.addEventListener('visibilitychange', sync);
  reduce.addEventListener('change', () => {
    if (reduce.matches) keepPoster('reduced-motion');
  });

  // After the load event, and then an idle moment: the poster is the LCP, and the film never
  // competes with the page's own requests.
  const later = () => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(begin, { timeout: 1000 });
    else setTimeout(begin, 200);
  };
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });

  // Motion hooks (e2e and dev builds): seeking the film sets its time and leaves it paused.
  registerScene({
    name: 'hero-film',
    get story() {
      return Number.isFinite(video.duration) ? video.duration * 1000 : 0;
    },
    ready: () => filmReady,
    seek(ms) {
      if (!started || failed) return;
      video.pause();
      return new Promise<void>((resolve) => {
        video.addEventListener('seeked', () => resolve(), { once: true });
        video.currentTime = ms / 1000;
      });
    },
    pause() {
      if (started && !failed && !userPaused) toggle.click();
    },
    play() {
      if (!failed && userPaused) toggle.click();
    },
    get time() {
      return video.currentTime * 1000;
    },
  });

  // The scroll fade's fallback where scroll-driven animations are missing. No scroll-linked motion
  // under reduced motion (hero-media.css keys the fallback on data-recede too).
  if (
    backdrop &&
    !reduce.matches &&
    typeof CSS !== 'undefined' &&
    !CSS.supports('animation-timeline', 'scroll()')
  ) {
    root.dataset.recede = 'script';
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = root.getBoundingClientRect();
      const top = box.top + scrollY;
      root.style.setProperty(
        '--hero-recede',
        recedeAt(scrollY, top, box.height).toFixed(3),
      );
    };
    addEventListener(
      'scroll',
      () => {
        if (!frame) frame = requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  }
}
