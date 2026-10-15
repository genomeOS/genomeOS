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
  wordsEnforced: boolean;
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
  /** The first figure's top is above the fold (Project, Contribute, Privacy). "desktop" holds it
   * there at 1440 × 900 only: Contact, whose phone layout puts the controls before the letter
   * (Contact page spec §4), says so here instead of leaving the check out. */
  leadFigure?: boolean | 'desktop';
  /** The hero stage is in the first phone viewport (Home). */
  heroStage?: boolean;
  /** Gzip budgets in KB; null is "no budget of its own" (Starlight baseline, redirect). */
  jsKbGz: number | null;
  dataKbGz: number | null;
  transferKbGz: number | null;
  lcpMs: { desktop: number; phone: number } | null;
  cls: number;
  /** Why a budget departs from the spec's table (spec §7), for the reader of the manifest. */
  budgetNote?: string;
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
  'heroStage',
  'jsKbGz',
  'dataKbGz',
  'transferKbGz',
  'lcpMs',
  'cls',
  'budgetNote',
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
  if (
    'leadFigure' in raw &&
    typeof raw.leadFigure !== 'boolean' &&
    raw.leadFigure !== 'desktop'
  )
    throw new Error(`${file}: leadFigure must be true, false or "desktop"`);
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
