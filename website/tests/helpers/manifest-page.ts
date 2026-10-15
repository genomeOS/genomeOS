/**
 * Open a manifest's page for the cross-page suites (site redesign spec §9.2, #454). A redirect
 * page (`redirect` in its manifest) is read as it is, with its meta refresh and its redirect script
 * held back, so the suites measure the page itself rather than where it sends people.
 */
import type { Page } from '@playwright/test';

import type { PageManifest } from './pages';

export async function openManifestPage(
  page: Page,
  manifest: PageManifest,
): Promise<void> {
  if (manifest.redirect) {
    await page.route(`**${manifest.route}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(/<meta http-equiv="refresh"[^>]*>/, '')
        .replace(/<script\b[^>]*\bdata-redirect\b[^>]*>[\s\S]*?<\/script>/, '');
      await route.fulfill({ response, body });
    });
  }
  await page.goto(manifest.route);
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Visible words in <main> (or in `within`, a selector inside it): rendered text nodes, leaving out
 * [hidden], closed <details> content, .sr-only and .visually-hidden text, scripts and styles. SVG
 * text and aria-hidden visible labels count. A typing twin (round 2 spec §3.2: one span per
 * character, `aria-hidden`, beside its visually hidden sentence) counts once, as its whole text.
 * Runs in the page; a missing `within` counts nothing (`found: false`).
 */
export function visibleWords(
  options: string | null | { exclude?: string | null; within?: string },
): {
  count: number;
  text: string;
  found: boolean;
} {
  const { exclude = null, within } =
    typeof options === 'string' || options === null
      ? { exclude: options }
      : options;
  const word = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;
  const main = document.querySelector('main');
  const root = main && within ? main.querySelector(within) : main;
  if (!root) return { count: 0, text: '', found: false };
  const skipped = (element: Element) =>
    !!element.closest(
      'script, style, template, noscript, [hidden], .sr-only, .visually-hidden',
    ) ||
    (!!exclude && !!element.closest(exclude)) ||
    (() => {
      const details = element.closest('details');
      return !!details && !details.open && !element.closest('summary');
    })() ||
    !element.checkVisibility({ visibilityProperty: true });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || element.closest('.typed') || skipped(element)) continue;
    const words = (node.nodeValue ?? '').match(word) ?? [];
    if (words.length === 0) continue;
    count += words.length;
    parts.push(words.join(' '));
  }
  for (const twin of root.querySelectorAll('.typed')) {
    if (skipped(twin)) continue;
    const words = (twin.textContent ?? '').match(word) ?? [];
    count += words.length;
    if (words.length) parts.push(words.join(' '));
  }
  return { count, text: parts.join(' '), found: true };
}
