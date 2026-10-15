/**
 * The genomeOS Atlas chapter's collapsed sections (owner request, 2026-10-15; round 2 spec §4.2):
 * native `<details>` rows (AtlasSection.astro), closed by default, whose figures load nothing and
 * do not move until their section opens.
 *
 * - **Lazy.** A section's module (`section-*.ts`, one chunk each) is imported on its first open,
 *   and only then does it create its figures' controllers, fetch the HbS map's data or set up the
 *   Pipeline. The page's own island is this file.
 * - **Entrances once, on open.** Opened by the visitor, a section's figures play their entrance
 *   as they come into view (`readyBy: Infinity` lifts FigureController's page-load rule that a
 *   figure already on screen simply rests). Until its module has armed them, the section is
 *   `acc--pending` and its figures hold invisible, so the final state never flashes before the
 *   entrance. Under reduced motion nothing waits and everything rests. The section watches its
 *   own figures for the 35% that plays them (MotionController's rule): the page-wide observer
 *   misses a figure revealed by the opening section's growing clip, whose share of the viewport
 *   then never crosses another of its thresholds. `data-acc-ready` marks a section whose module
 *   has set up (and whose map has its data).
 * - **Deep links.** A fragment inside a section opens it, on load and on `hashchange`, and the
 *   target is scrolled into view (browsers that open `<details>` for a fragment themselves do so
 *   before this runs). A section open on load keeps the page-load rule: what is on screen rests.
 * - **Print.** `beforeprint` opens every section and `afterprint` closes again the ones it opened.
 *   Printing loads nothing: every figure's server markup is its final state.
 */
import type { FigureControllerOptions } from '../../graphics/figure';

export interface SectionModule {
  /** Set up the section's figures; a promise if part of it waits for data (the HbS map). */
  init(
    section: HTMLElement,
    options?: FigureControllerOptions,
  ): void | Promise<void>;
}

export type SectionLoaders = Readonly<
  Record<string, () => Promise<SectionModule>>
>;

const SECTION = 'details.acc[data-acc]';

const reducedMotion = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The collapsed section an element sits in (or heads), if any. */
export function sectionOf(element: Element | null): HTMLDetailsElement | null {
  return element?.closest<HTMLDetailsElement>(SECTION) ?? null;
}

/** A figure plays once 35% of it is in view, or it fills 35% of the viewport (figure.ts). */
export const PLAY_SHARE = 0.35;
const STEPS = Array.from({ length: 21 }, (_, index) => index / 20);

/**
 * Tell each figure in a section to play once 35% of it is in view, as MotionController does for the
 * page, but on fine steps, so a figure revealed by the section's opening transition is caught.
 */
function watchFigures(section: HTMLElement): void {
  const figures = [
    ...section.querySelectorAll<HTMLElement>('figure[data-graphic]'),
  ].filter((figure) => !figure.hasAttribute('data-graphic-played'));
  if (!figures.length) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const fills =
          entry.intersectionRect.height >= PLAY_SHARE * window.innerHeight;
        if (entry.intersectionRatio < PLAY_SHARE && !fills) continue;
        const figure = entry.target as HTMLElement;
        observer.unobserve(figure);
        if (figure.hasAttribute('data-graphic-played')) continue;
        figure.setAttribute('data-graphic-played', '');
        figure.dispatchEvent(new CustomEvent('graphic:play'));
      }
    },
    { threshold: STEPS },
  );
  for (const figure of figures) observer.observe(figure);
}

/** The element a fragment names, or null (an empty or malformed fragment names nothing). */
export function fragmentTarget(hash: string): HTMLElement | null {
  let id = '';
  try {
    id = decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return null;
  }
  return id ? document.getElementById(id) : null;
}

export function initAccordion(loaders: SectionLoaders): void {
  const sections = [...document.querySelectorAll<HTMLDetailsElement>(SECTION)];
  const started = new WeakSet<HTMLDetailsElement>();
  let printing = false;

  /** Load a section's module and start its figures, once. */
  const start = (
    section: HTMLDetailsElement,
    options?: FigureControllerOptions,
  ) => {
    if (printing || !section.open || started.has(section)) return;
    const load = loaders[section.dataset.acc ?? ''];
    if (!load) return;
    started.add(section);
    const hold = options?.readyBy !== undefined && !reducedMotion();
    if (hold) section.classList.add('acc--pending');
    void load()
      .then((module) => {
        const done = module.init(section, options);
        section.classList.remove('acc--pending');
        watchFigures(section);
        return done;
      })
      .finally(() => {
        section.classList.remove('acc--pending');
        section.dataset.accReady = '';
      });
  };

  /** Open the section a fragment points into, and bring the target into view. */
  const reveal = (hash: string) => {
    const target = fragmentTarget(hash);
    const section = sectionOf(target);
    if (!target || !section) return;
    // A jump, not a click: no opening transition, so the page is its full height before the
    // scroll (a browser may have opened the section itself and begun the transition).
    section.classList.add('acc--instant');
    section.open = true;
    requestAnimationFrame(() => section.classList.remove('acc--instant'));
    start(section);
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
  };

  // What is open before the visitor has done anything lands like a page: what is on screen rests.
  reveal(location.hash);
  for (const section of sections) start(section);

  for (const section of sections)
    section.addEventListener('toggle', () =>
      start(section, { readyBy: Number.POSITIVE_INFINITY }),
    );
  window.addEventListener('hashchange', () => reveal(location.hash));

  const openedForPrint: HTMLDetailsElement[] = [];
  window.addEventListener('beforeprint', () => {
    printing = true;
    for (const section of sections)
      if (!section.open) {
        section.open = true;
        openedForPrint.push(section);
      }
  });
  window.addEventListener('afterprint', () => {
    for (const section of openedForPrint.splice(0)) section.open = false;
    printing = false;
  });
}
