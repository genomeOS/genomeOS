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
 * Visible words in <main>: rendered text nodes, leaving out [hidden], closed <details> content,
 * .sr-only and .visually-hidden text, scripts and styles. SVG text and aria-hidden visible labels
 * count. Runs in the page.
 */
export function visibleWords(exclude: string | null): {
  count: number;
  text: string;
} {
  const word = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;
  const main = document.querySelector('main');
  if (!main) return { count: 0, text: '' };
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element) continue;
    if (
      element.closest(
        'script, style, template, noscript, [hidden], .sr-only, .visually-hidden',
      )
    )
      continue;
    if (exclude && element.closest(exclude)) continue;
    const details = element.closest('details');
    if (details && !details.open && !element.closest('summary')) continue;
    if (!element.checkVisibility({ visibilityProperty: true })) continue;
    const words = (node.nodeValue ?? '').match(word) ?? [];
    if (words.length === 0) continue;
    count += words.length;
    parts.push(words.join(' '));
  }
  return { count, text: parts.join(' ') };
}
