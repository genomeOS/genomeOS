/** The Home hero's background film (site redesign round 2, ruling R2-1; #454).
 *
 * HeroMedia.astro renders the poster (the LCP, in AVIF and WebP) and an empty, muted `<video>`.
 * This island decides whether the film plays at all, and only after the page's load event, so the
 * poster always wins LCP and the film never competes with the page's own requests:
 *
 *   poster stays   prefers-reduced-motion, Save-Data, a slow-2g, 2g or 3g connection, or no
 *                  source the browser can play (`data-video="poster"`, the reason in
 *                  `data-video-reason`). Nothing then moves, so no Pause control is shown.
 *   rendition      the smallest width that covers the viewport at up to 2x (pickRendition): 720p on
 *                  phones and small laptops, 1080p on desktops. Sources keep their given order
 *                  (AV1, then HEVC), filtered by `canPlayType`.
 *   fade           the film fades in over the poster once its first frame is presented.
 *   pause          a visible Pause/Play control (WCAG 2.2.2: the loop runs 16 s). The film also
 *                  pauses while the hero is off screen or the tab is hidden, and resumes only if
 *                  the visitor has not paused it.
 *   scroll fade    CSS scroll-driven animation (home.css); where `animation-timeline` is missing, a
 *                  rAF-throttled scroll listener sets `--hero-recede` instead (recedeAt). Neither
 *                  runs under reduced motion.
 */

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

/** The scroll fade's length, as a share of the hero's height (home.css uses the same span). */
export const RECEDE_SPAN = 0.75;

export type PosterReason =
  'reduced-motion' | 'save-data' | 'slow-connection' | 'unsupported' | 'error';

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

/** Why the poster stays, or null when the film may play. */
export function posterReason(environment: {
  reducedMotion: boolean;
  saveData?: boolean;
  effectiveType?: string;
}): PosterReason | null {
  if (environment.reducedMotion) return 'reduced-motion';
  if (environment.saveData) return 'save-data';
  if (
    environment.effectiveType &&
    SLOW_CONNECTIONS.has(environment.effectiveType)
  )
    return 'slow-connection';
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

interface Connection {
  saveData?: boolean;
  effectiveType?: string;
}

const LABEL = {
  pause: ['Pause', 'Pause the background video'],
  play: ['Play', 'Play the background video'],
} as const;

export function initHeroMedia(root: HTMLElement): void {
  const video = root.querySelector<HTMLVideoElement>('video');
  const toggle = root.querySelector<HTMLButtonElement>('[data-video-toggle]');
  const text = toggle?.querySelector<HTMLElement>('[data-video-toggle-text]');
  const backdrop = root.querySelector<HTMLElement>('[data-hero-backdrop]');
  if (!video || !toggle || !text) return;

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

  const setLabel = (paused: boolean) => {
    const [visible, name] = paused ? LABEL.play : LABEL.pause;
    text.textContent = visible;
    toggle.setAttribute('aria-label', name);
    toggle.dataset.state = paused ? 'paused' : 'playing';
  };

  /** Back to the poster for good (an error, or reduced motion turned on mid-visit). */
  const keepPoster = (reason: PosterReason) => {
    failed = true;
    root.dataset.video = 'poster';
    root.dataset.videoReason = reason;
    toggle.hidden = true;
    if (!video.paused) video.pause();
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

  const begin = () => {
    if (started || failed) return;
    const reason = posterReason({
      reducedMotion: reduce.matches,
      saveData: connection?.saveData,
      effectiveType: connection?.effectiveType,
    });
    if (reason) {
      keepPoster(reason);
      return;
    }
    const playable = pickRendition(
      sources,
      innerWidth,
      devicePixelRatio || 1,
    ).filter((source) => video.canPlayType(source.type) !== '');
    if (playable.length === 0) {
      keepPoster('unsupported');
      return;
    }
    started = true;
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
    video.addEventListener('playing', () => {
      if ('requestVideoFrameCallback' in video)
        video.requestVideoFrameCallback(markFramed);
      else requestAnimationFrame(markFramed);
    });
    toggle.hidden = false;
    setLabel(false);
    sync();
  };

  toggle.addEventListener('click', () => {
    userPaused = !userPaused;
    setLabel(userPaused);
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

  // The scroll fade's fallback where scroll-driven animations are missing. No scroll-linked motion
  // under reduced motion (home.css keys the fallback on data-recede too).
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
