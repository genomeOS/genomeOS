/**
 * Site-wide checks after the round-2 integration (round 2 plan T7, spec §8; rulings 25 and 35;
 * #454), on every route a visitor can open, at 1440 px (desktop project) and 390 px (phone):
 *
 * - axe finds nothing serious or critical at load, with every Projects section open, while each
 *   figure enters as it scrolls into view, and at moments through every scene's story (ruling 25:
 *   axe must pass at any instant, mid-fade included);
 * - every scene the route registers is one this file samples, and none is registered twice;
 * - no button shows "Pause", "Play", "Replay" or "Resume" as visible text: those controls are
 *   glyphs whose names are visually hidden (rulings 22 and 35);
 * - no horizontal scrolling at 320 and 390 px (phone) or 640 and 1440 px (desktop), with every
 *   figure built and every section open.
 *
 * The static side (dist text, no "Schematic" or "not yet validated", React only in the Atlas) is
 * tests/site-wide.test.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const ROUTES = [
  '/',
  '/projects/',
  '/contribute/',
  '/contact/',
  '/privacy/',
  '/404.html',
  '/docs/',
  '/docs/local-development/',
  '/app/',
] as const;

/** The figures each route draws in <main>, by data-graphic, each checked as it enters below. */
const FIGURES: Record<(typeof ROUTES)[number], string[]> = {
  '/': ['people', 'how-it-works', 'atlas-preview', 'crew'],
  '/projects/': [
    'project-index',
    'hbs-threshold',
    'applications',
    'join-up',
    'counts',
    'pipeline',
    'safeguards',
    'status-rail',
  ],
  '/contribute/': ['orbit', 'transit-line', 'work-board'],
  '/contact/': ['contact-letter'],
  '/privacy/': ['privacy-flow'],
  '/404.html': ['no-estimate'],
  '/docs/': ['pipeline'],
  '/docs/local-development/': [],
  '/app/': [],
};

/** The scenes each route registers with the motion hooks (e2e build), sampled through below. */
const SCENES: Record<(typeof ROUTES)[number], string[]> = {
  '/': ['hero-film', 'people', 'how-it-works', 'atlas-preview', 'crew'],
  '/projects/': [
    'hbs-threshold',
    'applications',
    'join-up',
    'counts',
    'pipeline',
    'safeguards',
    'status-rail',
  ],
  '/contribute/': ['orbit', 'transit-line', 'board'],
  '/contact/': ['contact-letter'],
  '/privacy/': [],
  '/404.html': [],
  '/docs/': [],
  '/docs/local-development/': [],
  '/app/': [],
};

/** A scene's figure, where it is not the figure named like the scene. */
const SCENE_FIGURE: Record<string, string> = {
  'hero-film': '[data-hero-media]',
  board: 'figure[data-graphic="work-board"]',
};

/** Moments through a story, as shares of its length. */
const STORY_SHARES = [0.04, 0.12, 0.25, 0.4, 0.55, 0.7, 0.85, 1];

const WIDTH = { desktop: 1440, phone: 390 } as const;

async function open(page: Page, route: string, width: number) {
  await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
  await page.goto(route);
  if (route === '/app/')
    await expect(page.locator('[data-atlas-ready="true"]')).toBeVisible({
      timeout: 45_000,
    });
  await page.evaluate(() => document.fonts.ready);
  // Docs: Expressive Code makes a code block that scrolls sideways focusable (tabindex 0, role
  // region) from a ResizeObserver, about 250 ms and an idle callback after load; the page is
  // checked as a keyboard user meets it, after that pass (as marketing-docs-theme.spec does).
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.expressive-code pre')].every(
      (pre) =>
        pre.scrollWidth <= pre.clientWidth ||
        pre.getAttribute('tabindex') === '0',
    ),
  );
}

/**
 * Open every collapsed section (Projects, ruling 40) and every "View as table", as a reader who
 * expands them all: each closed one that shows, until none does (a table inside a closed section
 * shows once its section opens).
 */
async function openSections(page: Page) {
  // The Atlas app's own disclosures are its controls, not sections to read.
  if (new URL(page.url()).pathname.startsWith('/app/')) return;
  const closed = page
    .locator('main details:not([open]) > summary')
    .filter({ visible: true });
  for (let opened = 0; opened < 40 && (await closed.count()) > 0; opened += 1)
    await closed.first().click();
  expect(await closed.count(), 'every section opens').toBe(0);
}

/** Bring each figure into view in turn, so every lazy figure loads, builds and plays. */
async function visitFigures(
  page: Page,
  each: (index: number) => Promise<void> = async () => page.waitForTimeout(350),
) {
  const figures = page.locator('main figure[data-graphic]');
  const count = await figures.count();
  for (let index = 0; index < count; index += 1) {
    await figures
      .nth(index)
      .evaluate((figure) =>
        figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
    await each(index);
  }
}

async function blocking(page: Page, when: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter(({ impact }) => ['serious', 'critical'].includes(impact ?? ''))
    .flatMap(({ id, nodes }) =>
      nodes.map((node) => `${when}: ${id} at ${node.target.join(' ')}`),
    );
}

for (const route of ROUTES) {
  test(`${route}: axe finds nothing serious at load and with every section open`, async ({
    page,
    isMobile,
  }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('[motion'))
        warnings.push(message.text());
    });
    await open(page, route, isMobile ? WIDTH.phone : WIDTH.desktop);
    const found = await blocking(page, 'at load');
    await openSections(page);
    found.push(...(await blocking(page, 'sections open')));
    expect(found).toEqual([]);
    // The figures and scenes checked below are every one the route has, each under its own name.
    expect(
      await page
        .locator('main figure[data-graphic]')
        .evaluateAll((figures) =>
          figures.map((figure) => (figure as HTMLElement).dataset.graphic),
        ),
    ).toEqual(FIGURES[route]);
    await visitFigures(page);
    const names = await page.evaluate(() => window.__motion?.names() ?? []);
    expect([...names].sort()).toEqual([...SCENES[route]].sort());
    expect(warnings).toEqual([]);
  });

  FIGURES[route].forEach((graphic, index) =>
    test(`${route}: axe finds nothing serious as the ${graphic} figure enters`, async ({
      page,
      isMobile,
    }) => {
      await open(page, route, isMobile ? WIDTH.phone : WIDTH.desktop);
      await openSections(page);
      await page
        .locator('main figure[data-graphic]')
        .nth(index)
        .evaluate((figure) =>
          figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
      // At once (reveals and entrances mid-fade), and a moment on.
      const found = await blocking(page, `${graphic}, entering`);
      await page.waitForTimeout(450);
      found.push(...(await blocking(page, `${graphic}, a moment on`)));
      expect(found).toEqual([]);
    }),
  );

  for (const scene of SCENES[route])
    test(`${route}: axe finds nothing serious through the ${scene} scene`, async ({
      page,
      isMobile,
    }) => {
      await open(page, route, isMobile ? WIDTH.phone : WIDTH.desktop);
      await openSections(page);
      await page
        .locator(SCENE_FIGURE[scene] ?? `[data-graphic="${scene}"]`)
        .first()
        .evaluate((figure) =>
          figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
      await page.evaluate((name) => window.__motion!.ready(name), scene);
      // A seek starts a scene that has not begun (Contact's letter knows its length only then).
      await page.evaluate((name) => window.__motion!.seek(name, 0), scene);
      const story = await page.evaluate(
        (name) => window.__motion!.story(name),
        scene,
      );
      expect(story, scene).toBeGreaterThan(0);
      const found: string[] = [];
      for (const share of STORY_SHARES) {
        const t = Math.round(story * share);
        await page.evaluate(([name, ms]) => window.__motion!.seek(name, ms), [
          scene,
          t,
        ] as const);
        found.push(...(await blocking(page, `${scene} at ${t} ms`)));
      }
      expect(found).toEqual([]);
    });

  test(`${route}: no button shows Pause, Play, Replay or Resume as text`, async ({
    page,
    isMobile,
  }) => {
    await open(page, route, isMobile ? WIDTH.phone : WIDTH.desktop);
    await openSections(page);
    await visitFigures(page);
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter((button) => button.checkVisibility())
        .map((button) => {
          const copy = button.cloneNode(true) as HTMLElement;
          copy
            .querySelectorAll('.visually-hidden, svg')
            .forEach((hidden) => hidden.remove());
          return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
        })
        .filter((text) => /\b(pause|play|replay|resume)\b/i.test(text)),
    );
    expect(shown).toEqual([]);
  });

  for (const [width, project] of [
    [1440, 'desktop-chromium'],
    [640, 'desktop-chromium'],
    [390, 'mobile-chromium'],
    [320, 'mobile-chromium'],
  ] as const)
    test(`${route}: no horizontal scrolling at ${width} px @${project}`, async ({
      page,
    }) => {
      await open(page, route, width);
      await openSections(page);
      await visitFigures(page);
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: 'instant' }),
      );
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${route} at ${width} px`).toBeLessThanOrEqual(0);
    });
}
