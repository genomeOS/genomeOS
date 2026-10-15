/**
 * Per-page manifests (site redesign spec §9.3, #454): one `tests/pages/<page>.json` per page,
 * owned by that page's task, so six page tasks can tighten their own budgets without touching the
 * same file. The cross-page suites (word-budget, figures, motion, copy-spacing, performance) read
 * the enforced ones; the integration task fails the build if any flag is still false.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface PageManifest {
  /** The file's name without .json, e.g. "home". */
  name: string;
  route: string;
  /** Visible words in <main> at 1440×900 (spec §10). */
  words: number;
  /**
   * The page total is enforced (or with FORCE_WORDS=1). Round 2 (plan I-14): false for Home,
   * Projects and Contribute until the integration task, which turns them on.
   */
  wordsEnforced: boolean;
  /**
   * Round 2 (spec §10): per-section word budgets, keyed by a CSS selector in <main> ("#why",
   * ".page-intro"), so parallel tasks on one page cannot overrun each other. Enforced for every
   * section the page has, unless it is listed in `sectionsPending`.
   */
  sections?: Record<string, number>;
  /**
   * Sections that still hold their round-1 copy (the task that rewrites them has not landed):
   * their counts are reported, and enforced only with FORCE_WORDS=1 or once `wordsEnforced`.
   */
  sectionsPending?: string[];
  /** Every [data-concept] holds one figure, and the figure contract holds (spec §9.2). */
  conceptsEnforced: boolean;
  /** How many [data-concept] sections the page has (spec §10: Home 7, Project 6, Contribute 2,
   * Privacy 1, 404 1, Docs 1; the redirect page none). figures.spec checks the count, so a page
   * cannot pass the contract by leaving `data-concept` off its sections. */
  concepts: number;
  /** Selector whose words the budget leaves out (the Docs P-code table). */
  wordsExclude?: string;
  /** The page only redirects here: the suites read it with the redirect held. */
  redirect?: string;
  /** The first figure's top is above the fold (Project, Contribute, Privacy). */
  leadFigure?: boolean;
  /**
   * Gzip budgets in KB; null is "no budget of its own" (Starlight baseline, redirect). Round 2
   * (spec §7): `jsKbGz` is first-load JS (before any scrolling) and `transferKbGz` the initial
   * transfer (from navigation until network idle, without scrolling, the film left out).
   */
  jsKbGz: number | null;
  dataKbGz: number | null;
  transferKbGz: number | null;
  /** Round 2 (spec §7): each lazily imported module, by its chunk name ("orbit", "atlas-preview"). */
  lazyJsKbGz?: Record<string, number>;
  /** Round 2 (spec §7): images in the initial transfer (Home's poster). */
  imagesKbGz?: number;
  /**
   * Round 2 (spec §7): a deferred hero film's own budget per profile, KB as transferred (video is
   * not gzipped): the rendition a profile loads, which must start after the load event and is left
   * out of `transferKbGz` (Home's film, ruling R2-1).
   */
  deferredMediaKb?: { desktop: number; phone: number };
  lcpMs: { desktop: number; phone: number } | null;
  cls: number;
}

const directory = path.resolve(import.meta.dirname, '../pages');
const KEYS = new Set([
  'route',
  'words',
  'wordsEnforced',
  'conceptsEnforced',
  'concepts',
  'wordsExclude',
  'redirect',
  'leadFigure',
  'jsKbGz',
  'dataKbGz',
  'transferKbGz',
  'lazyJsKbGz',
  'imagesKbGz',
  'deferredMediaKb',
  'sections',
  'sectionsPending',
  'lcpMs',
  'cls',
]);

function load(file: string): PageManifest {
  const raw = JSON.parse(
    readFileSync(path.join(directory, file), 'utf8'),
  ) as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!KEYS.has(key))
      throw new Error(`${file}: unknown manifest field "${key}"`);
  for (const key of [
    'route',
    'words',
    'wordsEnforced',
    'conceptsEnforced',
    'concepts',
    'cls',
  ])
    if (!(key in raw)) throw new Error(`${file}: missing "${key}"`);
  if (typeof raw.route !== 'string' || !raw.route.startsWith('/'))
    throw new Error(`${file}: route must be a site path`);
  if (!Number.isInteger(raw.concepts) || (raw.concepts as number) < 0)
    throw new Error(`${file}: concepts must be a whole number`);
  const sections = raw.sections as Record<string, unknown> | undefined;
  for (const [selector, budget] of Object.entries(sections ?? {}))
    if (!Number.isInteger(budget) || (budget as number) <= 0)
      throw new Error(
        `${file}: section "${selector}" needs a whole-number budget`,
      );
  for (const pending of (raw.sectionsPending as string[] | undefined) ?? [])
    if (!sections || !(pending in sections))
      throw new Error(`${file}: pending section "${pending}" has no budget`);
  const media = raw.deferredMediaKb as Record<string, unknown> | undefined;
  if (
    media &&
    !(typeof media.desktop === 'number' && typeof media.phone === 'number')
  )
    throw new Error(`${file}: deferredMediaKb needs desktop and phone`);
  return { name: file.replace(/\.json$/, ''), ...raw } as PageManifest;
}

export const pageManifests: readonly PageManifest[] = readdirSync(directory)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map(load);

export const wordEnforced = pageManifests.filter((page) => page.wordsEnforced);
export const conceptEnforced = pageManifests.filter(
  (page) => page.conceptsEnforced,
);
/** Pages whose task is done: both flags on. The performance budgets apply to these. */
export const fullyEnforced = pageManifests.filter(
  (page) => page.wordsEnforced && page.conceptsEnforced,
);

/** The audit's word pattern (audit §1; spec §4 copy blocks). */
export const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;
