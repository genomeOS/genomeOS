/**
 * Privacy page browser checks (site redesign spec §4.5, §9.2; #454). Owned by the Privacy task;
 * tests/analytics.spec.ts keeps the disclosure pins and the page's axe check with analytics on.
 *
 * The e2e build loads analytics, so the "What leaves your browser" figure draws the visitor's real
 * consent gate: it must show the stored choice from the first paint, follow the cookie panel
 * without a reload, link to the choice it reads, and send nothing itself.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const STORAGE_KEY = 'genomeos-analytics-consent';
const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';

declare global {
  interface Window {
    __gateAtPaint?: string[];
    __samePage?: boolean;
  }
}

const figure = (page: Page) => page.locator('[data-privacy-flow]');
/** The gate link, by its accessible name (the shown state only). */
const gate = (page: Page, state: string) =>
  figure(page).getByRole('link', { name: `Your choice: ${state}` });
const cookiePanel = (page: Page) =>
  page.getByRole('region', { name: 'Cookie settings' });
const analyticsSwitch = (page: Page) =>
  cookiePanel(page).getByRole('switch', { name: 'Analytics cookies' });

async function waitForCookieControl(page: Page): Promise<void> {
  await page.locator('[data-cookie-control][data-consent]').waitFor({
    state: 'attached',
  });
}

/** Store a choice before any page script runs, as a returning visitor's browser would. */
async function storeChoice(page: Page, choice: 'granted' | 'denied') {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [STORAGE_KEY, choice] as const,
  );
}

/**
 * Record the gate in the first animation frame that has the figure: frame callbacks run just
 * before that frame is painted, so this is the state the visitor first sees.
 */
async function recordGateAtFirstPaint(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.__gateAtPaint = seen;
    const look = () => {
      const node = document.querySelector('[data-privacy-flow]');
      if (node) seen.push(node.getAttribute('data-gate') ?? '');
      else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

/** The durations of the figure's running animations and transitions. */
function gateMotion(page: Page): Promise<number[]> {
  return figure(page).evaluate((node) =>
    node
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running')
      .map((animation) => Number(animation.effect?.getTiming().duration)),
  );
}

/**
 * Flip the cookie panel's switch and, in the same task (after the cookie control's re-render and
 * the figure's observer have run), list the durations of what started moving in the figure.
 */
function toggleAndMeasure(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    document
      .querySelector<HTMLElement>('[data-cookie-panel] [data-cookie-switch]')!
      .click();
    await Promise.resolve();
    return document
      .querySelector('[data-privacy-flow]')!
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running')
      .map((animation) => Number(animation.effect?.getTiming().duration));
  });
}

/**
 * What this page's cookie control holds (its switch, and the consent it applies to gtag) beside
 * the gate the figure draws: the figure must never claim a state the page is not in.
 */
function controlAndGate(page: Page) {
  return page.evaluate(() => ({
    consent: document
      .querySelector('[data-cookie-control]')
      ?.getAttribute('data-consent'),
    switchOn: document
      .querySelector('[data-cookie-panel] [data-cookie-switch]')
      ?.getAttribute('aria-checked'),
    gate: document
      .querySelector('[data-privacy-flow]')
      ?.getAttribute('data-gate'),
  }));
}

async function seriousAxeViolations(page: Page): Promise<unknown[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.filter(({ impact }) =>
    ['serious', 'critical'].includes(impact ?? ''),
  );
}

test('the privacy page opens on its heading', async ({ page }) => {
  await page.goto('/privacy/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    "What we measure, and what we don't.",
  );
});

test('the lead figure opens above the fold', async ({ page }, info) => {
  const phone = info.project.name === 'mobile-chromium';
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  );
  await page.goto('/privacy/');
  await page.evaluate(() => document.fonts.ready);
  const top = await figure(page).evaluate(
    (node) => node.getBoundingClientRect().top,
  );
  expect(top).toBeLessThan(phone ? 700 : 640);
});

test.describe('layout @desktop-chromium', () => {
  // The CLS budget (spec §7): when the web fonts replace the fallback, the chips must not jump
  // between rows. 1280×720 is the performance profile's desktop; 1440×900 the review width;
  // 1024×768 the tighter left-to-right form of a narrow desktop.
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ])
    test(`the page holds still while the web fonts arrive at ${viewport.width} px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(() => {
        const shifts = { total: 0 };
        (window as unknown as { __cls: typeof shifts }).__cls = shifts;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          })[])
            if (!entry.hadRecentInput) shifts.total += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto('/privacy/');
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const cls = await page.evaluate(
        () => (window as unknown as { __cls: { total: number } }).__cls.total,
      );
      expect(cls).toBeLessThanOrEqual(0.02);
    });

  for (const width of [1024, 1440])
    test(`at ${width} px the flow runs left to right, with no empty half beside a rail`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/privacy/');
      await page.evaluate(() => document.fonts.ready);
      const sockets = await figure(page)
        .locator('.pf-node > .pf-socket')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { top: Math.round(box.top), left: Math.round(box.left) };
          }),
        );
      expect(sockets).toHaveLength(4);
      expect(new Set(sockets.map(({ top }) => top)).size).toBe(1);
      const lefts = sockets.map(({ left }) => left);
      expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    });
});

test("the gate's glyph turns with the wire: in from the side it comes from", async ({
  page,
}, info) => {
  // The phone's rail runs top to bottom; the desktop's flow runs left to right.
  const rail = info.project.name === 'mobile-chromium';
  await storeChoice(page, 'denied');
  await page.goto('/privacy/');
  const [stub, wire] = await Promise.all([
    figure(page).locator('.pf-gate__stub').boundingBox(),
    figure(page).locator('.pf-wire--in').boundingBox(),
  ]);
  if (!stub || !wire) throw new Error('the gate or its wire is not drawn');
  if (rail) {
    expect(stub.height).toBeGreaterThan(stub.width);
    expect(
      Math.abs(stub.x + stub.width / 2 - (wire.x + wire.width / 2)),
    ).toBeLessThan(2);
  } else {
    expect(stub.width).toBeGreaterThan(stub.height);
    expect(
      Math.abs(stub.y + stub.height / 2 - (wire.y + wire.height / 2)),
    ).toBeLessThan(2);
  }
});

for (const [choice, drawn, state] of [
  ['granted', 'open', 'On'],
  ['denied', 'closed', 'Off'],
] as const)
  test(`a stored choice of ${state} is drawn from the first paint`, async ({
    page,
  }) => {
    await storeChoice(page, choice);
    await recordGateAtFirstPaint(page);
    await page.goto('/privacy/');
    await expect
      .poll(() => page.evaluate(() => window.__gateAtPaint?.[0]))
      .toBe(drawn);
    await expect(figure(page)).toHaveAttribute('data-gate', drawn);
    await expect(gate(page, state)).toBeVisible();
  });

test.describe('outside the opt-in regions', () => {
  test.use({ timezoneId: NEW_YORK });

  test('the gate opens by default, and follows the cookie panel without a reload', async ({
    page,
  }) => {
    await recordGateAtFirstPaint(page);
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    expect(await page.evaluate(() => window.__gateAtPaint?.[0])).toBe('open');
    await expect(gate(page, 'On')).toBeVisible();
    await page.evaluate(() => (window.__samePage = true));

    await page
      .locator('main')
      .getByRole('button', { name: 'Cookie settings' })
      .click();
    await expect(cookiePanel(page)).toBeVisible();
    await analyticsSwitch(page).click();
    await expect(analyticsSwitch(page)).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(figure(page)).toHaveAttribute('data-gate', 'closed');
    await expect(gate(page, 'Off')).toBeVisible();

    await analyticsSwitch(page).click();
    await expect(figure(page)).toHaveAttribute('data-gate', 'open');
    await expect(gate(page, 'On')).toBeVisible();
    expect(await page.evaluate(() => window.__samePage)).toBe(true);
  });

  test("the gate keeps to this page's cookie control when another tab changes the choice", async ({
    page,
    context,
  }) => {
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    const other = await context.newPage();
    await other.goto('/privacy/');
    await waitForCookieControl(other);

    // Listen on this page before the other tab writes, to know when its storage event is in.
    const delivered = page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          window.addEventListener('storage', () => resolve(), { once: true }),
        ),
    );
    await other
      .locator('main')
      .getByRole('button', { name: 'Cookie settings' })
      .click();
    await analyticsSwitch(other).click();
    await expect(figure(other)).toHaveAttribute('data-gate', 'closed');
    await delivered;

    // This page still holds On, and so does its gtag, until it reloads: the gate says On.
    expect(await controlAndGate(page)).toEqual({
      consent: 'granted',
      switchOn: 'true',
      gate: 'open',
    });
    await expect(gate(page, 'On')).toBeVisible();

    // Opening this page's own panel redraws the control; the gate stays with it.
    await page
      .locator('main')
      .getByRole('button', { name: 'Cookie settings' })
      .click();
    await expect(cookiePanel(page)).toBeVisible();
    expect(await controlAndGate(page)).toEqual({
      consent: 'granted',
      switchOn: 'true',
      gate: 'open',
    });

    // A change made here moves both together.
    await analyticsSwitch(page).click();
    await expect(figure(page)).toHaveAttribute('data-gate', 'closed');
    expect(await controlAndGate(page)).toEqual({
      consent: 'denied',
      switchOn: 'false',
      gate: 'closed',
    });
    await other.close();
  });

  test('the gate keeps to the cookie control when the page returns from the back-forward cache', async ({
    page,
  }) => {
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    // Another page stored Off while this one sat in the back-forward cache; this page's control
    // still holds On when it is shown again.
    await page.evaluate((key) => {
      window.localStorage.setItem(key, 'denied');
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      );
    }, STORAGE_KEY);
    expect(await controlAndGate(page)).toEqual({
      consent: 'granted',
      switchOn: 'true',
      gate: 'open',
    });
    await expect(gate(page, 'On')).toBeVisible();
  });

  test('the figure describes the state it draws, and only that one', async ({
    page,
  }) => {
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    const stage = figure(page).locator('[data-figure-stage]');
    // Whole sentences, each followed by a space: none runs into the next.
    await expect(stage).toHaveAccessibleDescription(
      /below control\. It is on, so the gate is open: .+ three Atlas actions\. The maintainers see/,
    );
    await expect(stage).not.toHaveAccessibleDescription(
      /It is off|not chosen yet/,
    );

    await page
      .locator('main')
      .getByRole('button', { name: 'Cookie settings' })
      .click();
    await analyticsSwitch(page).click();
    await expect(stage).toHaveAccessibleDescription(
      /below control\. It is off, so the gate is closed and nothing is sent\. The maintainers see/,
    );
    await expect(stage).not.toHaveAccessibleDescription(
      /It is on|not chosen yet/,
    );
  });

  test('Global Privacy Control closes the gate', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
        configurable: true,
        get: () => true,
      });
    });
    await recordGateAtFirstPaint(page);
    await page.goto('/privacy/');
    await expect
      .poll(() => page.evaluate(() => window.__gateAtPaint?.[0]))
      .toBe('closed');
    await expect(gate(page, 'Off')).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
  });

  test('the gate links to the choice it reads', async ({ page }) => {
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    await gate(page, 'On').click();
    await expect(page).toHaveURL(/\/privacy\/#your-choice$/);
    const choice = page.locator('#your-choice');
    await expect(
      choice.getByRole('button', { name: 'Cookie settings' }),
    ).toBeVisible();
    // The target lands clear of the fixed header.
    const [header, row] = await Promise.all([
      page
        .locator('[data-site-header]')
        .evaluate((node) => node.getBoundingClientRect().bottom),
      choice.evaluate((node) => node.getBoundingClientRect().top),
    ]);
    expect(row).toBeGreaterThanOrEqual(header - 1);
  });

  test('the figure sends nothing and loads nothing third-party', async ({
    page,
  }) => {
    const requests: { url: string; type: string }[] = [];
    page.on('request', (request) =>
      requests.push({ url: request.url(), type: request.resourceType() }),
    );
    await storeChoice(page, 'denied');
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    const origin = new URL(page.url()).origin;
    // Analytics is off, so nothing at all leaves for another origin.
    expect(
      requests
        .filter(({ url }) => !url.startsWith(origin))
        .map(({ url }) => url),
    ).toEqual([]);
    const before = requests.length;
    // Changing the choice redraws the gate. Of other origins, only gtag.js itself may follow a
    // grant (the cookie control loads it); the page's own lazy images may load as it scrolls.
    await page
      .locator('main')
      .getByRole('button', { name: 'Cookie settings' })
      .click();
    await analyticsSwitch(page).click();
    await expect(figure(page)).toHaveAttribute('data-gate', 'open');
    await analyticsSwitch(page).click();
    await expect(figure(page)).toHaveAttribute('data-gate', 'closed');
    expect(
      requests
        .slice(before)
        .filter(({ url }) => !url.startsWith(origin))
        .filter(
          ({ url }) => !url.startsWith('https://www.googletagmanager.com/'),
        ),
    ).toEqual([]);
    expect(
      requests.filter(({ type }) => ['fetch', 'xhr'].includes(type)),
    ).toEqual([]);
  });

  test('nothing moves on load; a change of choice moves the gate for 240 ms, then it rests', async ({
    page,
  }) => {
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    expect(await gateMotion(page)).toEqual([]);
    await expect(figure(page)).not.toHaveAttribute('data-live', /.*/);

    await page
      .locator('main')
      .getByRole('button', { name: 'Cookie settings' })
      .click();
    const moving = await toggleAndMeasure(page);
    expect(moving.length).toBeGreaterThan(0);
    for (const duration of moving) expect(duration).toBe(240);
    await expect(figure(page)).toHaveAttribute('data-gate', 'closed');
    await expect.poll(() => gateMotion(page)).toEqual([]);
  });

  test('under reduced motion a change of choice redraws the gate at once', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    await page
      .locator('main')
      .getByRole('button', { name: 'Cookie settings' })
      .click();
    expect(await toggleAndMeasure(page)).toEqual([]);
    await expect(figure(page)).toHaveAttribute('data-gate', 'closed');
  });
});

test.describe('in an opt-in time zone', () => {
  test.use({ timezoneId: BERLIN });

  test('the gate waits, closed, until the visitor chooses', async ({
    page,
  }) => {
    await recordGateAtFirstPaint(page);
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    expect(await page.evaluate(() => window.__gateAtPaint?.[0])).toBe(
      'pending',
    );
    await expect(gate(page, 'Not chosen yet')).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);

    // The first-visit prompt is open; declining closes the gate on this page.
    await cookiePanel(page).getByRole('button', { name: 'Decline' }).click();
    await expect(figure(page)).toHaveAttribute('data-gate', 'closed');
    await expect(gate(page, 'Off')).toBeVisible();

    await page.reload();
    await expect(gate(page, 'Off')).toBeVisible();
  });

  test('accepting opens the gate', async ({ page }) => {
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    await cookiePanel(page).getByRole('button', { name: 'Accept' }).click();
    await expect(figure(page)).toHaveAttribute('data-gate', 'open');
    await expect(gate(page, 'On')).toBeVisible();
  });

  test('with storage blocked, the gate follows the choice the cookie control keeps for the page', async ({
    page,
  }) => {
    // The browser refuses storage, so the control keeps the choice in memory for this page.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    await page.goto('/privacy/');
    await waitForCookieControl(page);
    await expect(gate(page, 'Not chosen yet')).toBeVisible();

    await cookiePanel(page).getByRole('button', { name: 'Accept' }).click();
    await expect(figure(page)).toHaveAttribute('data-gate', 'open');
    await expect(gate(page, 'On')).toBeVisible();
    expect(await controlAndGate(page)).toEqual({
      consent: 'granted',
      switchOn: 'true',
      gate: 'open',
    });
  });
});
