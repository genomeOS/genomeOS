/**
 * The Docs light "paper" theme in the browser (round 2 spec §4.4, §11.2; R2-9; docs-light.md;
 * #454). Owned by the Docs task.
 *
 * Docs keep the site's dark header exactly (variant V1) over a paper reading surface, so a visitor
 * sees the same site and knows they are in its reference part. Light is the default whatever the
 * operating system prefers; one square "Dark theme" toggle (in the header from 50em, in the phone
 * menu below) switches to today's dark docs and is remembered under Starlight's own key. With
 * scripting off the server-rendered dark docs stay, and the toggle is not offered. Code blocks
 * use "genomeOS Paper" on paper and Night Owl in the dark. Axe passes in both themes, the header
 * holds one row with the toggle at the pinned widths, and nothing overflows a 320 px phone.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const PAPER = 'rgb(246, 249, 252)';
const BAND = 'rgb(237, 242, 248)';
const CODE = 'rgb(238, 243, 249)';
const VOID = 'rgb(2, 7, 18)';
const INK = 'rgb(7, 24, 49)';
const ION_INK = 'rgb(0, 106, 130)';
const ION = 'rgb(112, 230, 255)';
const STARLIGHT = 'rgb(242, 248, 255)';
const MUTED = 'rgb(165, 185, 211)';

/** genomeOS Paper's token colours (src/styles/code/genomeos-paper.json), as computed colours. */
const PAPER_CODE = new Set(
  [
    '#263850',
    '#506278',
    '#6b46b8',
    '#00657c',
    '#006b4d',
    '#7a5500',
    '#071831',
    '#004e61',
    '#485b74',
    '#b9195c',
  ].map((hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgb(${r}, ${g}, ${b})`;
  }),
);

const GUIDE = '/docs/system-overview/';
const LONG_GUIDE = '/docs/deployment/';
const CODE_GUIDE = '/docs/local-development/';

const theme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);
const stored = (page: Page) =>
  page.evaluate(() => localStorage.getItem('starlight-theme'));
const style = (locator: Locator, property: string) =>
  locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );
const preferDark = (page: Page) =>
  page.addInitScript(() => {
    try {
      localStorage.setItem('starlight-theme', 'dark');
    } catch {
      /* storage blocked: the default stands */
    }
  });

/** The toggle a visitor at this width can reach: the header's, or the phone menu's (opened). */
async function reachableToggle(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.locator('.sl-menu-button').click();
    return page.locator('.docs-theme--menu');
  }
  return page.locator('header .docs-theme--header');
}

/** Serious and critical axe violations, once the page has finished setting itself up. Expressive
 * Code makes a code block that scrolls sideways focusable (tabindex 0, role region) from a
 * ResizeObserver, 250 ms and an idle callback after load, in both themes; axe reads the page as a
 * keyboard user meets it, after that pass. */
async function blockingAxe(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.expressive-code pre')].every(
      (pre) =>
        pre.scrollWidth <= pre.clientWidth ||
        pre.getAttribute('tabindex') === '0',
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter(({ impact }) => ['serious', 'critical'].includes(impact ?? ''))
    .map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target.join(' ')),
    }));
}

test.describe('light by default, even on a dark OS', () => {
  test.use({ colorScheme: 'dark' });

  for (const route of ['/docs/', GUIDE]) {
    test(`${route} opens on paper under the site’s dark header`, async ({
      page,
      isMobile,
    }) => {
      await page.goto(route);
      expect(await theme(page)).toBe('light');
      await expect(page.locator('body')).toHaveCSS('background-color', PAPER);
      await expect(page.locator('h1')).toHaveCSS('color', INK);
      // V1: the bar is the site's bar, opaque, on every docs page.
      const bar = page.locator('header.header');
      await expect(bar).toHaveCSS('background-color', VOID);
      await expect(page.locator('.docs-header__atlas')).toHaveCSS(
        'color',
        STARLIGHT,
      );
      expect(await style(page.locator(':root'), 'color-scheme')).toBe('light');
      expect(await style(bar, 'color-scheme')).toBe('dark');
      if (!isMobile) {
        await expect(page.locator('.sidebar-pane')).toHaveCSS(
          'background-color',
          BAND,
        );
        await page.setViewportSize({ width: 1440, height: 900 });
        const nav = page.getByRole('navigation', {
          name: 'Primary navigation',
        });
        await expect(nav.getByRole('link', { name: 'Docs' })).toHaveCSS(
          'color',
          STARLIGHT,
        );
        await expect(nav.getByRole('link', { name: 'Projects' })).toHaveCSS(
          'color',
          MUTED,
        );
      }
    });
  }
});

test('the toggle switches to the dark docs, remembers it, and switches back', async ({
  page,
  isMobile,
}) => {
  await page.goto(GUIDE);
  let toggle = await reachableToggle(page, isMobile);
  await expect(toggle).toBeVisible();
  // One name in both states: aria-pressed carries the state (WCAG 4.1.2).
  await expect(toggle).toHaveAccessibleName('Dark theme');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  if (isMobile) await expect(toggle).toHaveText('Dark theme');
  // A square control, as every control on the site.
  await expect(toggle).toHaveCSS('border-radius', '0px');
  const box = (await toggle.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);

  await toggle.click();
  expect(await theme(page)).toBe('dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAccessibleName('Dark theme');
  for (const each of await page.locator('[data-docs-theme]').all())
    await expect(each).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveCSS('background-color', VOID);
  expect(await stored(page)).toBe('dark');

  // Remembered across a reload and on the next page.
  await page.reload();
  expect(await theme(page)).toBe('dark');
  await expect(page.locator('body')).toHaveCSS('background-color', VOID);
  await page.goto(LONG_GUIDE);
  expect(await theme(page)).toBe('dark');
  toggle = await reachableToggle(page, isMobile);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // And back: Starlight's encoding of its default is the empty string.
  await toggle.click();
  expect(await theme(page)).toBe('light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await stored(page)).toBe('');
  await page.reload();
  expect(await theme(page)).toBe('light');
  await expect(page.locator('body')).toHaveCSS('background-color', PAPER);
});

test.describe('scripting off', () => {
  test.use({ javaScriptEnabled: false });

  test('keeps the server-rendered dark docs and offers no toggle', async ({
    page,
  }) => {
    await page.goto(GUIDE);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', VOID);
    await expect(page.locator('h1')).toHaveCSS('color', STARLIGHT);
    const toggles = page.locator('[data-docs-theme]');
    await expect(toggles).toHaveCount(2);
    for (const each of await toggles.all())
      await expect(each).toHaveCSS('display', 'none');
  });
});

test.describe('code blocks', () => {
  /** The computed colours of the first code block's tokens, its ground and its terminal mark. */
  const firstBlock = (page: Page) =>
    page
      .locator('.expressive-code')
      .first()
      .evaluate((block) => {
        const spans = [...block.querySelectorAll('.ec-line span[style^="--"]')];
        const header = block.querySelector('.frame.is-terminal .header');
        return {
          colours: [
            ...new Set(spans.map((span) => getComputedStyle(span).color)),
          ],
          ground: getComputedStyle(block.querySelector('pre')!).backgroundColor,
          terminal: header
            ? getComputedStyle(header, '::before').maskImage
            : 'none',
          copy: getComputedStyle(block.querySelector('.copy button')!)
            .borderTopLeftRadius,
        };
      });

  test('carry genomeOS Paper on paper: its colours, the code ground, square details', async ({
    page,
  }) => {
    await page.goto(CODE_GUIDE);
    const block = await firstBlock(page);
    expect(block.ground).toBe(CODE);
    expect(block.colours.length).toBeGreaterThanOrEqual(3);
    for (const colour of block.colours) expect(PAPER_CODE).toContain(colour);
    // Commands in ion, flags in genome violet.
    expect(block.colours).toContain('rgb(0, 101, 124)');
    expect(block.colours).toContain('rgb(107, 70, 184)');
    // The terminal's three dots are three squares; the copy button is square.
    expect(block.terminal).toContain('rect');
    expect(block.terminal).not.toContain('circle');
    expect(block.copy).toBe('0px');
  });

  test('carry Night Owl in the dark, as before', async ({ page }) => {
    await preferDark(page);
    await page.goto(CODE_GUIDE);
    const block = await firstBlock(page);
    expect(block.ground).toBe(INK);
    expect(block.colours).toContain('rgb(130, 170, 255)');
    for (const colour of block.colours)
      expect(PAPER_CODE, colour).not.toContain(colour);
  });
});

test.describe('axe, in both themes', () => {
  for (const dark of [false, true])
    for (const route of ['/docs/', LONG_GUIDE, CODE_GUIDE])
      test(`${route} has no serious axe violations (${dark ? 'dark' : 'light'})`, async ({
        page,
      }) => {
        if (dark) await preferDark(page);
        await page.goto(route);
        expect(await theme(page)).toBe(dark ? 'dark' : 'light');
        await expect(page.locator('h1')).toHaveCount(1);
        expect(await blockingAxe(page)).toEqual([]);
      });

  test('the phone menu, the search dialog and the focused toggle stay clean on paper', async ({
    page,
    isMobile,
  }) => {
    await page.goto(GUIDE);
    const toggle = await reachableToggle(page, isMobile);
    await toggle.focus();
    expect(await blockingAxe(page)).toEqual([]);
    if (isMobile) await page.locator('.sl-menu-button').click();
    await page.locator('header button[data-open-modal]').click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    // The dialog belongs to the page, not the bar: paper.
    await expect(dialog).toHaveCSS('background-color', PAPER);
    await page.keyboard.type('model');
    // Its field takes the paper's ion-ink ring, not the browser's blue.
    await expect(dialog.locator('input')).toHaveCSS('outline-color', ION_INK);
    await expect(dialog.locator('.pagefind-ui__result').first()).toBeVisible();
    expect(await blockingAxe(page)).toEqual([]);
  });
});

test('guides name the part of the site above their title; the landing does not', async ({
  page,
}) => {
  await page.goto(GUIDE);
  const kicker = page.locator('.docs-kicker');
  await expect(kicker).toHaveText('Docs');
  await expect(kicker).toHaveCSS('color', ION_INK);
  await expect(kicker).toHaveCSS('font-weight', '640');
  await expect(kicker).toHaveCSS('font-family', /Figtree/);
  const [k, h1] = await Promise.all([
    kicker.boundingBox(),
    page.locator('h1').boundingBox(),
  ]);
  expect(k!.y + k!.height).toBeLessThanOrEqual(h1!.y);
  expect(Math.abs(k!.x - h1!.x)).toBeLessThan(4);
  await page.goto('/docs/');
  await expect(page.locator('.docs-kicker')).toHaveCount(0);
  // In the dark it takes the site's ion.
  await preferDark(page);
  await page.goto(GUIDE);
  await expect(page.locator('.docs-kicker')).toHaveCSS('color', ION);
});

// The site's type and marks on paper (docs-light.md §3.1, §3.3): display weights +20 against
// irradiation, the sidebar's current page in ink on its ion rule, the pager's link cards on paper.
// (site.spec.ts pins the dark values; T7 parameterises them by theme.)
test('paper sets the site’s type and marks: weights +20, ink current page, paper link cards', async ({
  page,
  isMobile,
}) => {
  await page.goto(GUIDE);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCSS(
    'font-weight',
    '390',
  );
  await expect(page.locator('.sl-markdown-content h2').first()).toHaveCSS(
    'font-weight',
    '420',
  );
  if (isMobile) await page.locator('.sl-menu-button').click();
  const current = page.locator('#starlight__sidebar a[aria-current="page"]');
  await expect(current).toHaveCSS('color', INK);
  await expect(current).toHaveCSS('border-radius', '0px');
  expect(await style(current, 'box-shadow')).toContain(ION_INK);
  if (isMobile) await page.locator('.sl-menu-button').click();
  const cards = page.locator('.pagination-links a');
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card).toHaveCSS('border-radius', '0px');
    await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(card).toHaveCSS('border-top-color', 'rgba(0, 106, 130, 0.2)');
  }
  if (!isMobile) {
    await cards.first().hover();
    await expect(cards.first()).toHaveCSS('border-top-color', ION_INK);
  }
});

test('the landing’s pipeline map draws its lanes and studs in ink on paper', async ({
  page,
}) => {
  await page.goto('/docs/');
  const map = page.locator('.docs-map');
  const visible = (selector: string) =>
    map.locator(selector).filter({ visible: true }).first();
  await expect(map.locator('.kit-plate').first()).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  // The measured lane in ink-soft (white would vanish on white), the modeled lane at the ramp's
  // darkest step, both through the kit's tokens.
  await expect(visible('.pl-edge--measured')).toHaveCSS(
    'stroke',
    'rgb(38, 56, 80)',
  );
  await expect(visible('.pl-edge--modeled')).toHaveCSS(
    'stroke',
    'rgb(28, 119, 150)',
  );
  expect(await style(map, '--lane-measured')).toBe('#263850');
  expect(await style(map, '--enc-obs-ring')).toBe('#071831');
});

test(
  'the docs header holds one row with the toggle, at every pinned width',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.goto(GUIDE);
    for (const width of [800, 1153, 1280, 1392, 1440, 1920])
      for (const dark of [false, true]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(
          (value) => localStorage.setItem('starlight-theme', value),
          dark ? 'dark' : '',
        );
        await page.reload();
        expect(await theme(page)).toBe(dark ? 'dark' : 'light');
        await page.evaluate(() => document.fonts.ready);
        const at = `${width} px, ${dark ? 'dark' : 'light'}`;
        const row = await page.evaluate(() => {
          const header = document.querySelector('header.header')!;
          const box = (element: Element) =>
            element.getBoundingClientRect().toJSON() as DOMRect;
          const shown = [
            ...header.querySelectorAll(
              '.docs-header__lockup, .docs-header__nav a, button[data-open-modal], [data-docs-theme], .docs-header__atlas',
            ),
          ].filter((element) => element.checkVisibility());
          const inner = header.querySelector('.docs-header')!;
          return {
            bar: box(header),
            overflow: inner.scrollWidth - inner.clientWidth,
            items: shown.map((element) => ({
              name:
                element.getAttribute('aria-label') ??
                element.textContent?.replace(/\s+/g, ' ').trim() ??
                element.tagName,
              lines: element.getClientRects().length,
              ...box(element),
            })),
            search: box(header.querySelector('button[data-open-modal]')!),
            toggle: box(header.querySelector('[data-docs-theme]')!),
            atlas: box(header.querySelector('.docs-header__atlas')!),
          };
        });
        expect(row.overflow, `${at}: overflow`).toBeLessThanOrEqual(0);
        const centres = row.items.map(({ y, height }) => y + height / 2);
        for (const item of row.items) {
          expect(item.lines, `${at}: ${item.name} wraps`).toBe(1);
          expect(item.y, `${at}: ${item.name}`).toBeGreaterThanOrEqual(
            row.bar.y,
          );
          expect(
            item.y + item.height,
            `${at}: ${item.name}`,
          ).toBeLessThanOrEqual(row.bar.y + row.bar.height);
        }
        expect(
          Math.max(...centres) - Math.min(...centres),
          `${at}: one row`,
        ).toBeLessThan(2);
        // Search, then the toggle, then the Atlas link, each clear of the next.
        expect(row.toggle.width, at).toBeGreaterThanOrEqual(44);
        expect(row.toggle.left, at).toBeGreaterThanOrEqual(row.search.right);
        expect(row.atlas.left, at).toBeGreaterThanOrEqual(row.toggle.right);
        expect(row.search.width, `${at}: search target`).toBeGreaterThanOrEqual(
          44,
        );
      }
  },
);

test('nothing overflows a 320 px phone, in either theme', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  for (const dark of [false, true]) {
    if (dark) await preferDark(page);
    for (const route of [
      '/docs/',
      LONG_GUIDE,
      CODE_GUIDE,
      '/docs/scientific-safeguards/',
    ]) {
      await page.goto(route);
      expect(await theme(page)).toBe(dark ? 'dark' : 'light');
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(
        overflow,
        `${route} (${dark ? 'dark' : 'light'})`,
      ).toBeLessThanOrEqual(0);
    }
  }
});

test(
  'the focused toggle shows the site’s ion ring on the dark bar',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(GUIDE);
    await page.locator('header button[data-open-modal]').focus();
    await page.keyboard.press('Tab');
    const toggle = page.locator('header .docs-theme--header');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS('outline-color', ION);
    await expect(toggle).toHaveCSS('outline-style', 'solid');
    // On the dark bar the toggle keeps the bar's colours.
    await expect(toggle).toHaveCSS('color', MUTED);
  },
);
