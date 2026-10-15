/**
 * Word budgets (site redesign spec §9.2, §10; round 2 spec §10, plan I-14; #454), at 1440×900 under
 * reduced motion (typed text shows in full and counts once: its visually hidden original is left
 * out), on the CI-style build (rulings item 20). Prints every count for the PR.
 *
 * - Per-section budgets (a manifest's `sections`) hold for every section a page has, so parallel
 *   tasks on one page cannot overrun each other.
 * - Page totals are enforced where the manifest says so (`wordsEnforced`, on for every page since
 *   the round-2 integration), or with FORCE_WORDS=1.
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';
import { openManifestPage, visibleWords } from './helpers/manifest-page';
import { pageManifests } from './helpers/pages';

useSiteFixtures();

const FORCE = process.env.FORCE_WORDS === '1';

test.describe('visible words stay within each page budget @desktop-chromium', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const manifest of pageManifests)
    test(`${manifest.route} keeps its words within budget`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openManifestPage(page, manifest);
      const exclude = manifest.wordsExclude ?? null;

      const enforcedTotal = manifest.wordsEnforced || FORCE;
      for (const [selector, budget] of Object.entries(
        manifest.sections ?? {},
      )) {
        const { count, text, found } = await page.evaluate(visibleWords, {
          exclude,
          within: selector,
        });
        if (!found) {
          console.log(
            `word budget ${manifest.route} ${selector}: absent / ${budget}`,
          );
          continue;
        }
        info.annotations.push({
          type: 'words',
          description: `${manifest.route} ${selector}: ${count} / ${budget}`,
        });
        console.log(
          `word budget ${manifest.route} ${selector}: ${count} / ${budget}`,
        );
        expect(count, `${selector}: ${text}`).toBeLessThanOrEqual(budget);
      }

      const { count, text } = await page.evaluate(visibleWords, { exclude });
      const note = enforcedTotal ? '' : ' (not enforced until wordsEnforced)';
      info.annotations.push({
        type: 'words',
        description: `${manifest.route}: ${count} / ${manifest.words}${note}`,
      });
      console.log(
        `word budget ${manifest.route}: ${count} / ${manifest.words}${note}`,
      );
      expect(count, text).toBeGreaterThan(0);
      if (enforcedTotal)
        expect(count, text).toBeLessThanOrEqual(manifest.words);
    });
});
