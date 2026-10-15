/**
 * Motion rules (site redesign spec §2.7, §9.2; round 2 spec §2.3, §11.2; #454), for every page with
 * a manifest:
 *
 * - reduced motion: 1.2 s after load nothing is running and every figure shows its final state;
 * - otherwise: once every figure has been scrolled into view and 6.5 s have passed, nothing runs
 *   but the named exceptions of round 2 spec §2.3, each marked `data-motion-exception` (the
 *   genomeOS Atlas pill's aurora, Home's hero film, the Atlas preview's rotation, Contribute's
 *   orbit and board loops), and no animation frame is scheduled where the test ends. Each
 *   exception stops off screen, in a hidden tab and on its Pause; scroll-driven animations (the
 *   hero's scroll fade) are not counted: they move only while the visitor scrolls, and never
 *   under reduced motion;
 * - pressing every visible Pause leaves nothing running 6.5 s later but the Atlas pill's aurora,
 *   and no frame scheduled (WCAG 2.2.2);
 * - a figure scrolled offscreen in the middle of its entrance stops scheduling frames;
 * - printing shows every figure in its final state, even one never scrolled into view (spec §8).
 */
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';
import { openManifestPage } from './helpers/manifest-page';
import { pageManifests } from './helpers/pages';

useSiteFixtures();

declare global {
  interface Window {
    __frames?: { requested: number; pending: Set<number> };
  }
}

/** Count requestAnimationFrame calls and the frames still pending. */
async function instrumentFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames = { requested: 0, pending: new Set<number>() };
    window.__frames = frames;
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      frames.requested += 1;
      const id = request((time) => {
        frames.pending.delete(id);
        callback(time);
      });
      frames.pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      frames.pending.delete(id);
      cancel(id);
    };
  });
}

const frames = (page: Page) =>
  page.evaluate(() => ({
    requested: window.__frames?.requested ?? 0,
    pending: window.__frames?.pending.size ?? 0,
  }));

/** The Atlas pill's aurora: the one motion that never rests (round 1). */
const PILL = '[data-motion-exception="launch-atlas-cta"]';
/** Every named exception of round 2 spec §2.3 (pill, hero film, preview, orbit, board). */
const EXCEPTIONS = '[data-motion-exception]';

/**
 * Running animations and transitions, leaving out those inside `exempt` and, unless
 * `scrollLinked`, animations on a scroll or view timeline (they move only while the page scrolls).
 */
const running = (page: Page, scrollLinked = false, exempt = PILL) =>
  page.evaluate(
    ([countScrollLinked, exemptSelector]) =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === 'running')
        .filter(
          (animation) =>
            countScrollLinked || animation.timeline instanceof DocumentTimeline,
        )
        .filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return !(target instanceof Element && target.closest(exemptSelector));
        })
        .map((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          const name =
            animation instanceof CSSAnimation
              ? animation.animationName
              : animation instanceof CSSTransition
                ? animation.transitionProperty
                : 'script';
          return `${name} on ${target instanceof Element ? target.className || target.localName : '?'}`;
        }),
    [scrollLinked, exempt] as const,
  );

async function expectFramesStop(page: Page, label: string): Promise<void> {
  const before = await frames(page);
  await page.waitForTimeout(1000);
  const after = await frames(page);
  expect(after.requested - before.requested, `${label}: new frames`).toBe(0);
  expect(after.pending, `${label}: pending frames`).toBe(0);
}

for (const manifest of pageManifests) {
  test(`${manifest.route} rests at once under reduced motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openManifestPage(page, manifest);
    await page.waitForTimeout(1200);
    // Under reduced motion nothing is linked to the scroll either.
    expect(await running(page, true)).toEqual([]);
    const states = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-figure-state]')].map(
        (figure) => `${figure.dataset.graphic}: ${figure.dataset.figureState}`,
      ),
    );
    for (const state of states) expect(state).toMatch(/: rest$/);
    const pipelines = await page.evaluate(() =>
      [...document.querySelectorAll('[data-pipeline="interactive"]')].map(
        (figure) => figure.classList.contains('is-drawn'),
      ),
    );
    for (const drawn of pipelines)
      expect(drawn, 'the Pipeline is drawn').toBe(true);
  });

  test(`${manifest.route} plays each figure once, then rests`, async ({
    page,
  }) => {
    await instrumentFrames(page);
    await openManifestPage(page, manifest);
    const count = await page.locator('main figure[data-graphic]').count();
    for (let index = 0; index < count; index += 1) {
      await page
        .locator('main figure[data-graphic]')
        .nth(index)
        .evaluate((figure) =>
          figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(6500);
    expect(await running(page, false, EXCEPTIONS)).toEqual([]);
    await expectFramesStop(page, 'after rest');
    // A figure that schedules nothing can still be stuck mid-entrance (the FigureController race
    // the page tasks worked around): every figure scrolled to above must have reached rest.
    const states = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main figure[data-graphic]')]
        .flatMap((figure) => [
          figure,
          ...figure.querySelectorAll<HTMLElement>('[data-figure-state]'),
        ])
        .filter((element) => element.dataset.figureState)
        .map(
          (element) =>
            `${element.dataset.graphic ?? element.className}: ${element.dataset.figureState}`,
        ),
    );
    for (const state of states) expect(state).toMatch(/: rest$/);
  });

  test(`${manifest.route} rests on every Pause, but for the Atlas pill`, async ({
    page,
  }) => {
    await instrumentFrames(page);
    await openManifestPage(page, manifest);
    const count = await page.locator('main figure[data-graphic]').count();
    for (let index = 0; index < count; index += 1) {
      await page
        .locator('main figure[data-graphic]')
        .nth(index)
        .evaluate((figure) =>
          figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
      await page.waitForTimeout(300);
    }
    // Every visible Pause the page offers (the hero film, the preview's rotation, the scenes),
    // pressed where it sits; a toggle already showing Play is left alone.
    // Collected first: a pressed toggle may rename itself to Play.
    const pauses = await page.getByRole('button', { name: /^Pause\b/ }).all();
    for (const pause of pauses) {
      if (!(await pause.isVisible())) continue;
      if ((await pause.getAttribute('aria-pressed')) === 'true') continue;
      await pause.scrollIntoViewIfNeeded();
      await pause.click();
    }
    await page.waitForTimeout(6500);
    expect(await running(page)).toEqual([]);
    await expectFramesStop(page, 'after every Pause');
  });

  test(`${manifest.route} stops a figure that leaves the viewport mid-entrance`, async ({
    page,
  }) => {
    await instrumentFrames(page);
    await openManifestPage(page, manifest);
    const armed = await page.evaluate(
      () => document.querySelectorAll('[data-figure-state="armed"]').length,
    );
    for (let index = 0; index < armed; index += 1) {
      const figure = page.locator('[data-figure-state="armed"]').first();
      const name = await figure.getAttribute('data-graphic');
      await figure.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const away =
          window.scrollY > document.documentElement.scrollHeight / 2
            ? 0
            : document.documentElement.scrollHeight;
        window.scrollTo({ top: away, behavior: 'instant' });
      });
      await page.waitForTimeout(400);
      await expectFramesStop(page, `${name} offscreen`);
    }
  });

  test(`${manifest.route} prints every figure in its final state`, async ({
    page,
  }) => {
    await openManifestPage(page, manifest);
    // Figures below the fold are still armed: their "before" styles are for screens only...
    await page.emulateMedia({ media: 'print' });
    const undrawn = await page.evaluate(() =>
      [...document.querySelectorAll<SVGPathElement>('.pl-edge--draw')]
        .filter((edge) => edge.closest('svg')!.getClientRects().length > 0)
        .filter(
          (edge) =>
            Number.parseFloat(getComputedStyle(edge).strokeDashoffset) !== 0,
        )
        .map((edge) => edge.dataset.edge),
    );
    expect(undrawn, 'Pipeline wires drawn in print').toEqual([]);
    // ...and printing finishes every entrance, canvas figures included.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    const states = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-figure-state]')].map(
        (figure) => `${figure.dataset.graphic}: ${figure.dataset.figureState}`,
      ),
    );
    for (const state of states) expect(state).toMatch(/: rest$/);
  });
}
