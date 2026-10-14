/**
 * Word budgets (site redesign spec §9.2, §10; #454): for every page whose manifest enforces it,
 * the visible words in <main> at 1440×900 stay within budget. Prints each page's count for the PR.
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';
import { openManifestPage, visibleWords } from './helpers/manifest-page';
import { wordEnforced } from './helpers/pages';

useSiteFixtures();

test.describe('visible words stay within each page budget @desktop-chromium', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const manifest of wordEnforced)
    test(`${manifest.route} uses at most ${manifest.words} words`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openManifestPage(page, manifest);
      const { count, text } = await page.evaluate(
        visibleWords,
        manifest.wordsExclude ?? null,
      );
      info.annotations.push({
        type: 'words',
        description: `${manifest.route}: ${count} / ${manifest.words}`,
      });
      console.log(
        `word budget ${manifest.route}: ${count} / ${manifest.words}`,
      );
      expect(count, text).toBeGreaterThan(0);
      expect(count, text).toBeLessThanOrEqual(manifest.words);
    });
});
