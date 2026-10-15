/**
 * The figure contract (site redesign spec §2.3–§2.6, §8, §9.2; #454), at 1440×900 and 390×844, for
 * every page whose manifest enforces it:
 *
 * - the page has as many [data-concept] sections as its manifest says (so leaving `data-concept`
 *   off cannot pass), and each holds exactly one figure[data-graphic], with a figcaption and an
 *   accessible name or a "View as table" twin;
 * - figure chrome (controls, legends, readouts) overlaps neither other chrome, nor the stage it
 *   describes, nor the fixed header, nor the cookie control corner;
 * - every figure label renders at 13 px or more, at the project's width and at the other widths a
 *   layout can switch at (320–375 px phones; 768 px tablets and 1024–1920 px desktops, where a
 *   figure in a narrower column than the page, such as the Docs content, must still pick a layout
 *   that fits it);
 *   nothing in <main> is set in a monospace face;
 * - no wordmark inside a call to action; one selected tab and one pressed segment per group (a
 *   group of independent toggles, marked data-select="multiple", may press any number);
 * - chip and step rows keep inside the 16 px phone gutters, and control labels never overflow;
 * - the lead figure opens above the fold (Project, Contribute, Privacy). (Home's first view is its
 *   hero film since round 2, ruling R2-1; its figures start below it.)
 */
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';
import { openManifestPage } from './helpers/manifest-page';
import { conceptEnforced, type PageManifest } from './helpers/pages';

useSiteFixtures();

// Each viewport runs in its own Playwright project (the tag filters the other out).
const VIEWPORTS = [
  {
    name: 'desktop',
    tag: '@desktop-chromium',
    width: 1440,
    height: 900,
    fold: 640,
    otherWidths: [768, 1024, 1280, 1920],
  },
  {
    name: 'phone',
    tag: '@mobile-chromium',
    width: 390,
    height: 844,
    fold: 700,
    otherWidths: [320, 360, 375],
  },
] as const;

function concepts(): { count: number; failures: string[] } {
  const failures: string[] = [];
  const sections = document.querySelectorAll('[data-concept]');
  sections.forEach((section, index) => {
    const label = section.id || `concept ${index + 1}`;
    const figures = section.querySelectorAll('figure[data-graphic]');
    if (figures.length !== 1) {
      failures.push(`${label}: ${figures.length} figures`);
      return;
    }
    const figure = figures[0];
    const caption = figure.querySelector(':scope > figcaption');
    if (!caption || !caption.textContent?.trim())
      failures.push(`${label}: no figcaption`);
    const stages = figure.querySelectorAll('[data-figure-stage]');
    if (stages.length !== 1) failures.push(`${label}: ${stages.length} stages`);
    const stage = stages[0];
    const named =
      stage?.getAttribute('aria-label') ||
      stage?.getAttribute('aria-labelledby') ||
      figure.querySelector(':scope > details > summary');
    if (!named) failures.push(`${label}: the stage has no name or table twin`);
  });
  return { count: sections.length, failures };
}

/** Figure text under 13 px: SVG labels at their rendered scale, and HTML text in figures. */
function smallLabels(): string[] {
  const failures: string[] = [];
  const main = document.querySelector('main')!;
  const visible = (element: Element) =>
    element.checkVisibility({ visibilityProperty: true }) &&
    !element.closest('.visually-hidden, .sr-only, [hidden]');
  for (const figure of main.querySelectorAll('figure[data-graphic]')) {
    for (const text of figure.querySelectorAll<SVGTextElement>('svg text')) {
      if (!visible(text) || !text.textContent?.trim()) continue;
      const matrix = text.getScreenCTM();
      if (!matrix) continue;
      const size =
        Number.parseFloat(getComputedStyle(text).fontSize) *
        Math.hypot(matrix.a, matrix.b);
      if (size < 12.95)
        failures.push(
          `SVG "${text.textContent.trim()}" renders ${size.toFixed(1)} px`,
        );
    }
    for (const element of figure.querySelectorAll<HTMLElement>('*')) {
      if (element instanceof SVGElement || !visible(element)) continue;
      const own = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
      );
      if (!own) continue;
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (size < 12.95)
        failures.push(
          `"${element.textContent?.trim().slice(0, 40)}" is ${size.toFixed(1)} px`,
        );
    }
  }
  return failures;
}

function typeAndControls(): string[] {
  const failures: string[] = [];
  const main = document.querySelector('main')!;
  const visible = (element: Element) =>
    element.checkVisibility({ visibilityProperty: true }) &&
    !element.closest('.visually-hidden, .sr-only, [hidden]');
  for (const element of main.querySelectorAll<HTMLElement>('*')) {
    const own = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
    );
    if (!own) continue;
    if (
      /mono|courier|consolas|menlo/i.test(getComputedStyle(element).fontFamily)
    )
      failures.push(
        `<${element.localName}> "${element.textContent?.trim().slice(0, 30)}" is monospace`,
      );
  }
  for (const brand of main.querySelectorAll(
    '.button-link .brand-name, .github-cta strong .brand-name',
  ))
    failures.push(
      `wordmark inside a call to action: ${brand.closest('a')?.textContent?.trim()}`,
    );
  for (const list of main.querySelectorAll('[role="tablist"]')) {
    const selected = list.querySelectorAll(
      '[role="tab"][aria-selected="true"]',
    );
    if (selected.length !== 1)
      failures.push(
        `tablist "${list.getAttribute('aria-label')}" has ${selected.length} selected`,
      );
    // Tabs may wrap onto more rows on a phone. Each tab draws its own rule, so every row keeps
    // one and the selected underline sits on its own row (design review, fix round 2).
    for (const tab of list.querySelectorAll<HTMLElement>('[role="tab"]')) {
      if (!visible(tab)) continue;
      const style = getComputedStyle(tab);
      if (
        style.borderBottomStyle === 'none' ||
        parseFloat(style.borderBottomWidth) < 1
      )
        failures.push(
          `tab "${tab.textContent?.trim()}" has no rule of its own`,
        );
    }
  }
  // A segmented control is single-choice: exactly one pressed. A group of independent toggles,
  // such as Contact's "What you'd offer", says so with data-select="multiple" and may press any.
  const pressedGroups = new Set(
    [...main.querySelectorAll('[aria-pressed]')]
      .map(
        (button) => button.closest('[role="group"]') ?? button.parentElement!,
      )
      .filter((group) => group.getAttribute('data-select') !== 'multiple'),
  );
  for (const group of pressedGroups) {
    if (!visible(group)) continue;
    const pressed = group.querySelectorAll('[aria-pressed="true"]');
    if (pressed.length !== 1)
      failures.push(
        `group "${group.getAttribute('aria-label')}" has ${pressed.length} pressed`,
      );
  }
  for (const label of main.querySelectorAll<HTMLElement>(
    '.kit-segmented button, [role="tab"]',
  )) {
    if (!visible(label)) continue;
    if (label.scrollWidth > label.clientWidth + 1)
      failures.push(`"${label.textContent?.trim()}" overflows its control`);
  }
  return failures;
}

/** Chrome that is not inside other chrome: the boxes that must not collide. */
function chromeBoxes(): {
  figure: number;
  label: string;
  box: { top: number; left: number; bottom: number; right: number };
}[] {
  const figures = [...document.querySelectorAll('main figure[data-graphic]')];
  return figures.flatMap((figure, index) =>
    [...figure.querySelectorAll<HTMLElement>('[data-figure-chrome]')]
      .filter(
        (element) =>
          !element.parentElement?.closest('[data-figure-chrome]') &&
          element.checkVisibility({ visibilityProperty: true }) &&
          element.getBoundingClientRect().width > 0,
      )
      .map((element) => {
        const { top, left, bottom, right } = element.getBoundingClientRect();
        return {
          figure: index,
          label: `${element.className || element.localName}`.slice(0, 40),
          box: {
            top: top + scrollY,
            left,
            bottom: bottom + scrollY,
            right,
          },
        };
      }),
  );
}

const overlaps = (
  a: { top: number; left: number; bottom: number; right: number },
  b: { top: number; left: number; bottom: number; right: number },
) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

async function chromeCollisions(page: Page): Promise<string[]> {
  const failures: string[] = [];
  const boxes = await page.evaluate(chromeBoxes);
  const stages = await page.evaluate(() =>
    [...document.querySelectorAll('main figure[data-graphic]')].map(
      (figure) => {
        const stage = figure.querySelector('[data-figure-stage]');
        if (!stage) return null;
        const { top, left, bottom, right } = stage.getBoundingClientRect();
        return { top: top + scrollY, left, bottom: bottom + scrollY, right };
      },
    ),
  );
  boxes.forEach((a, i) => {
    const stage = stages[a.figure];
    if (stage && overlaps(a.box, stage))
      failures.push(`${a.label} overlaps its stage`);
    boxes.slice(i + 1).forEach((b) => {
      if (a.figure === b.figure && overlaps(a.box, b.box))
        failures.push(`${a.label} overlaps ${b.label}`);
    });
  });
  // Scrolled into view, chrome clears the fixed header and the cookie control corner.
  for (const [index, { label }] of boxes.entries()) {
    const hit = await page.evaluate((target) => {
      const chrome = [
        ...document.querySelectorAll<HTMLElement>(
          'main figure[data-graphic] [data-figure-chrome]',
        ),
      ].filter(
        (element) =>
          !element.parentElement?.closest('[data-figure-chrome]') &&
          element.checkVisibility({ visibilityProperty: true }) &&
          element.getBoundingClientRect().width > 0,
      )[target];
      if (!chrome) return [];
      chrome.scrollIntoView({ block: 'center', behavior: 'instant' });
      const box = chrome.getBoundingClientRect();
      const blockers = [
        ['header', document.querySelector('[data-site-header]')],
        ['cookie control', document.querySelector('[data-cookie-control]')],
      ] as const;
      return blockers
        .filter(([, blocker]) => blocker && blocker.getClientRects().length > 0)
        .filter(([, blocker]) => {
          const other = blocker!.getBoundingClientRect();
          return (
            Math.min(box.right, other.right) - Math.max(box.left, other.left) >
              0.5 &&
            Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) >
              0.5
          );
        })
        .map(([name]) => name);
    }, index);
    for (const name of hit) failures.push(`${label} sits under the ${name}`);
  }
  return failures;
}

async function gutters(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const failures: string[] = [];
    const gutter = 16;
    for (const element of document.querySelectorAll<HTMLElement>(
      'main figure[data-graphic] [data-figure-chrome], main [role="tablist"]',
    )) {
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      const { left, right, width } = element.getBoundingClientRect();
      if (width === 0) continue;
      if (left < gutter - 0.5 || right > innerWidth - gutter + 0.5)
        failures.push(
          `${element.className || element.localName} spans ${left.toFixed(0)}–${right.toFixed(0)} px`,
        );
    }
    return failures;
  });
}

async function fold(
  page: Page,
  manifest: PageManifest,
  viewport: (typeof VIEWPORTS)[number],
) {
  await page.evaluate(() => window.scrollTo(0, 0));
  if (
    manifest.leadFigure === true ||
    (manifest.leadFigure === 'desktop' && viewport.name === 'desktop')
  ) {
    const top = await page.evaluate(
      () =>
        document
          .querySelector('main figure[data-graphic]')
          ?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
    );
    expect(top, 'the lead figure opens above the fold').toBeLessThan(
      viewport.fold,
    );
  }
}

for (const viewport of VIEWPORTS)
  test.describe(`figures at ${viewport.width} px ${viewport.tag}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const manifest of conceptEnforced)
      test(`${manifest.route} keeps the figure contract`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openManifestPage(page, manifest);
        const sections = await page.evaluate(concepts);
        expect(sections.count, 'concept sections').toBe(manifest.concepts);
        expect(sections.failures, 'concept sections').toEqual([]);
        expect(await page.evaluate(smallLabels), 'figure labels').toEqual([]);
        expect(
          await page.evaluate(typeAndControls),
          'type and controls',
        ).toEqual([]);
        expect(await chromeCollisions(page), 'chrome collisions').toEqual([]);
        if (viewport.name === 'phone')
          expect(await gutters(page), '16 px gutters').toEqual([]);
        await fold(page, manifest, viewport);
        for (const width of viewport.otherWidths) {
          await page.setViewportSize({ width, height: viewport.height });
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          expect(
            await page.evaluate(smallLabels),
            `figure labels at ${width} px`,
          ).toEqual([]);
        }
      });
  });
