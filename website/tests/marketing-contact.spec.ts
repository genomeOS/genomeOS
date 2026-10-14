/**
 * Contact page browser checks (Contact page spec §1–§7; part of the site redesign, #454).
 *
 * - The address is in no served file: not the page, not any script or stylesheet it loads, in no
 *   encoding. Show email address reveals it, Copy copies it.
 * - The composer: every purpose and offer combination sets the live letter exactly as the draft
 *   builder writes it; the draft buttons navigate to the right `mailto:` (read as the request
 *   Chromium makes for it; no mail app answers); Copy draft copies the plain-text draft; the query
 *   preselects, before the island runs too, and keeps in step for sharing.
 * - Keyboard only, phones at 390 and 320 px, no JavaScript, print, and reduced motion.
 * - The nav: Contact in the site header, the Menu, the docs header and the 404, after Docs and
 *   before GitHub; in both footers; current on /contact/; and the header row still never wraps.
 *
 * The cross-page suites (word-budget, figures, motion, copy-spacing, performance) read the page's
 * manifest, tests/pages/contact.json. The expected address is built here from its parts, at run
 * time, so this file does not hold it either.
 */
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  buildDraft,
  draftText,
  mailtoUrl,
  OFFERS,
  OFFER_LABELS,
  TOPICS,
  TOPIC_LABELS,
  type DraftState,
  type Offer,
  type Topic,
} from '../src/lib/contact-draft';
import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const PARTS = ['info', ['genome-os', 'org'].join('.')] as const;
const ADDRESS = PARTS.join('@');
const ISSUES = 'https://github.com/genomeOS/genomeOS/issues/new/choose';
const NAV = [
  'Project',
  'Contribute',
  'Docs',
  'Contact',
  'View genomeOS on GitHub',
];

const composer = (page: Page) => page.locator('#contact-composer');
const letter = (page: Page) => page.locator('[data-letter]');
const purpose = (page: Page, topic: Topic) =>
  page
    .getByRole('group', { name: 'Purpose' })
    .getByRole('radio', { name: TOPIC_LABELS[topic], exact: true });
const offer = (page: Page, which: Offer) =>
  page
    .getByRole('group', { name: 'What you’d offer' })
    .getByRole('button', { name: OFFER_LABELS[which], exact: true });
const action = (page: Page, name: string) =>
  composer(page).getByRole('button', { name, exact: true });

/** The letter as shown: visible blocks and lines, the subject and the To line. */
function readLetter(page: Page) {
  return letter(page).evaluate((root) => {
    const visible = (element: Element) =>
      element.checkVisibility({ visibilityProperty: true });
    const text = (element: Element) =>
      (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    const body = [...root.querySelectorAll('[data-letter-block]')]
      .filter(visible)
      .map((block) =>
        [...block.querySelectorAll('[data-letter-line]')]
          .filter(visible)
          .map(text)
          .join('\n'),
      )
      .join('\n\n');
    const subject = [
      ...root.querySelectorAll('[data-letter-subject] [data-for-topic]'),
    ]
      .filter(visible)
      .map(text)
      .join('');
    const to = [...root.querySelectorAll('[data-to-name], [data-to-address]')]
      .filter(visible)
      .map(text)
      .join('');
    return { body, subject, to };
  });
}

async function expectLetter(page: Page, state: DraftState, label: string) {
  const draft = buildDraft(state);
  const shown = await readLetter(page);
  expect(shown.body, `${label}: body`).toBe(draft.body);
  expect(shown.subject, `${label}: subject`).toBe(draft.subject);
}

/**
 * A `mailto:` link's parts: the address, the decoded subject and body, and the query as sent.
 * Chromium writes the apostrophe the draft leaves bare (RFC 6068 allows it) as %27 when it
 * navigates; both decode to the same draft, so the comparison treats them alike.
 */
function mailtoParts(url: string) {
  const parsed = new URL(url);
  return {
    address: parsed.pathname,
    subject: parsed.searchParams.get('subject'),
    body: parsed.searchParams.get('body'),
    query: parsed.search.replace(/%27/g, "'"),
  };
}

function expectMailto(received: string, expected: string) {
  expect(received.startsWith(`mailto:${ADDRESS}`), received).toBe(true);
  expect(mailtoParts(received)).toEqual(mailtoParts(expected));
}

/** Wait for the `mailto:` navigation a draft button makes, while pressing it. */
async function mailtoFrom(page: Page, press: () => Promise<void>) {
  const [request] = await Promise.all([
    page.waitForRequest((request) => request.url().startsWith('mailto:')),
    press(),
  ]);
  return request.url();
}

async function grantClipboard(page: Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
}

const clipboard = (page: Page) =>
  page.evaluate(() => navigator.clipboard.readText());

/** Every encoded form of the address a harvester could read (spec §2). */
function addressForms(text: string): string[] {
  const lower = text.toLowerCase();
  const decodedEntities = lower.replace(
    /&#(x[0-9a-f]+|[0-9]+);?/g,
    (_match, code: string) =>
      String.fromCodePoint(
        code.startsWith('x')
          ? Number.parseInt(code.slice(1), 16)
          : Number(code),
      ),
  );
  const decodedPercent = lower.replace(/%([0-9a-f]{2})/g, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const decodedEscapes = lower.replace(
    /\\(?:u00|x)([0-9a-f]{2})/g,
    (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return [
    PARTS.join('@'),
    PARTS.join('%40'),
    PARTS.join('&#64;'),
    PARTS.join('&#x40;'),
    PARTS.join('&commat;'),
  ].filter(
    (form) =>
      lower.includes(form) ||
      decodedEntities.includes(form) ||
      decodedPercent.includes(form) ||
      decodedEscapes.includes(form),
  );
}

test.describe('the address is protected', () => {
  test('the served page and every script and stylesheet it loads hold no form of the address', async ({
    page,
  }) => {
    const bodies = new Map<string, Promise<string>>();
    page.on('response', (response) => {
      const type = response.request().resourceType();
      if (['document', 'script', 'stylesheet'].includes(type))
        bodies.set(
          response.url(),
          response.text().catch(() => ''),
        );
    });
    await page.goto('/contact/?topic=contribute&offer=code,data');
    await expect(composer(page)).toBeVisible();
    await page.waitForLoadState('networkidle');
    const html = await page.request.get('/contact/').then((r) => r.text());
    expect(addressForms(html), 'the HTML').toEqual([]);
    expect([...bodies.keys()].some((url) => /\.js(\?|$)/.test(url))).toBe(true);
    expect([...bodies.keys()].some((url) => /\.css(\?|$)/.test(url))).toBe(
      true,
    );
    for (const [url, body] of bodies)
      expect(addressForms(await body), url).toEqual([]);
    // Nor in the page as it stands before anyone asks, and no mailto: link anywhere.
    expect(addressForms(await page.content())).toEqual([]);
    await expect(page.locator('a[href^="mailto:" i]')).toHaveCount(0);
  });

  test('Show email address reveals it, and Copy copies it', async ({
    page,
  }) => {
    await page.goto('/contact/');
    await grantClipboard(page);
    const status = composer(page).getByRole('status');
    await expect(letter(page).locator('dd').first()).toHaveText(
      'genomeOS Foundation',
    );
    await action(page, 'Show email address').click();
    await expect(action(page, 'Show email address')).toBeHidden();
    await expect(composer(page).locator('[data-address]')).toHaveText(ADDRESS);
    await expect(status).toHaveText('Email address shown');
    const copy = action(page, 'Copy');
    await expect(copy).toBeFocused();
    await expect(copy).toHaveAccessibleDescription(ADDRESS);
    // The letter's To line now reads the address too.
    expect((await readLetter(page)).to).toBe(ADDRESS);
    await copy.click();
    await expect(status).toHaveText('Copied');
    expect(await clipboard(page)).toBe(ADDRESS);
    // Still no mailto: link: the address is text.
    await expect(page.locator('a[href^="mailto:" i]')).toHaveCount(0);
  });
});

test.describe('the composer', () => {
  test.beforeEach(async ({ page }) => {
    // Instant section changes, so each reading is the settled letter.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('opens on a contribution with nothing offered, and every purpose is a real radio', async ({
    page,
  }) => {
    await page.goto('/contact/');
    await expect(purpose(page, 'contribute')).toBeChecked();
    for (const topic of TOPICS)
      await expect(purpose(page, topic)).toHaveAttribute('type', 'radio');
    for (const which of OFFERS)
      await expect(offer(page, which)).toHaveAttribute('aria-pressed', 'false');
    await expectLetter(page, { topic: 'contribute', offers: [] }, 'default');
    expect((await readLetter(page)).to).toBe('genomeOS Foundation');
  });

  test('every set of offers sets the letter exactly, and the link keeps up', async ({
    page,
  }) => {
    await page.goto('/contact/');
    let pressed: Offer[] = [];
    // A Gray-code walk visits all 16 sets of offers, one press at a time.
    for (let step = 1; step < 16; step += 1) {
      const flip = OFFERS[Math.log2(step & -step)];
      await offer(page, flip).click();
      pressed = pressed.includes(flip)
        ? pressed.filter((other) => other !== flip)
        : OFFERS.filter((other) => other === flip || pressed.includes(other));
      const label = pressed.join(',') || 'none';
      for (const which of OFFERS)
        await expect(offer(page, which), label).toHaveAttribute(
          'aria-pressed',
          String(pressed.includes(which)),
        );
      await expectLetter(page, { topic: 'contribute', offers: pressed }, label);
      expect(new URL(page.url()).search, label).toBe(
        pressed.length
          ? `?topic=contribute&offer=${pressed.join(',')}`
          : '?topic=contribute',
      );
    }
  });

  test('each other purpose sets its own letter and hides the offers', async ({
    page,
  }) => {
    await page.goto('/contact/');
    await offer(page, 'data').click();
    for (const topic of ['question', 'partner', 'press'] as const) {
      await purpose(page, topic).check();
      await expect(
        page.getByRole('group', { name: 'What you’d offer' }),
      ).toBeHidden();
      await expectLetter(page, { topic, offers: [] }, topic);
      expect(new URL(page.url()).search).toBe(`?topic=${topic}`);
    }
    // Back to a contribution, the offer pressed before is still pressed.
    await purpose(page, 'contribute').check();
    await expect(offer(page, 'data')).toHaveAttribute('aria-pressed', 'true');
    await expectLetter(page, { topic: 'contribute', offers: ['data'] }, 'back');
  });

  test('Open draft navigates to the composed mailto:, and reveals the address', async ({
    page,
  }) => {
    await page.goto('/contact/');
    await offer(page, 'funding').click();
    await offer(page, 'code').click();
    await expect(page.locator('a[href^="mailto:" i]')).toHaveCount(0);
    const url = await mailtoFrom(page, () =>
      action(page, 'Open draft in your email app').click(),
    );
    expectMailto(
      url,
      mailtoUrl(
        ADDRESS,
        buildDraft({ topic: 'contribute', offers: ['code', 'funding'] }),
      ),
    );
    // The page stays, now showing the address for a visitor whose email app did not open.
    await expect(page).toHaveURL(
      /\/contact\/\?topic=contribute&offer=code,funding$/,
    );
    await expect(composer(page).locator('[data-address]')).toHaveText(ADDRESS);
    await expect(composer(page).getByRole('status')).toHaveText(
      'If no email app opens, use Copy draft.',
    );
    await expect(page.locator('a[href^="mailto:" i]')).toHaveCount(0);

    await purpose(page, 'press').check();
    expectMailto(
      await mailtoFrom(page, () =>
        action(page, 'Open draft in your email app').click(),
      ),
      mailtoUrl(ADDRESS, buildDraft({ topic: 'press', offers: [] })),
    );
  });

  test('Blank email opens mailto: and the address only', async ({ page }) => {
    await page.goto('/contact/?topic=question');
    expect(
      await mailtoFrom(page, () => action(page, 'Blank email').click()),
    ).toBe(`mailto:${ADDRESS}`);
  });

  test('Copy draft copies To, Subject and the body as plain text', async ({
    page,
  }) => {
    await page.goto('/contact/?topic=partner');
    await grantClipboard(page);
    await action(page, 'Copy draft').click();
    await expect(composer(page).getByRole('status')).toHaveText('Draft copied');
    expect(await clipboard(page)).toBe(
      draftText(ADDRESS, buildDraft({ topic: 'partner', offers: [] })),
    );
  });

  test('the query preselects a purpose and offers; unknown values are ignored', async ({
    page,
  }) => {
    await page.goto('/contact/?topic=contribute&offer=funding,data');
    await expect(purpose(page, 'contribute')).toBeChecked();
    for (const which of OFFERS)
      await expect(offer(page, which)).toHaveAttribute(
        'aria-pressed',
        String(which === 'data' || which === 'funding'),
      );
    await expectLetter(
      page,
      { topic: 'contribute', offers: ['data', 'funding'] },
      'preselect',
    );

    await page.goto('/contact/?topic=press');
    await expect(purpose(page, 'press')).toBeChecked();
    await expectLetter(page, { topic: 'press', offers: [] }, 'press');

    for (const search of [
      '?topic=report',
      '?topic=contribute&offer=money,time',
      '?topic=<b>x</b>&offer=<i>',
    ]) {
      await page.goto(`/contact/${search}`);
      await expect(purpose(page, 'contribute'), search).toBeChecked();
      await expectLetter(page, { topic: 'contribute', offers: [] }, search);
    }
  });

  test('the preselect is drawn before the island runs', async ({ page }) => {
    // With every module script held back, only the inline pre-paint script runs.
    await page.route(/\/_astro\/.*\.js(\?|$)/, (route) => route.abort());
    await page.goto('/contact/?topic=contribute&offer=expertise,code');
    await expect(composer(page)).toBeVisible();
    await expect(composer(page)).toHaveAttribute(
      'data-offers',
      'code expertise',
    );
    await expect(offer(page, 'code')).toHaveAttribute('aria-pressed', 'true');
    await expectLetter(
      page,
      { topic: 'contribute', offers: ['code', 'expertise'] },
      'pre-paint',
    );
  });

  test('a shared link reopens the same draft', async ({ page }) => {
    await page.goto('/contact/');
    await offer(page, 'expertise').click();
    await page.reload();
    await expect(offer(page, 'expertise')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectLetter(
      page,
      { topic: 'contribute', offers: ['expertise'] },
      'reloaded',
    );
  });

  test('a problem goes to GitHub’s new-issue chooser, not to email', async ({
    page,
  }) => {
    await page.goto('/contact/');
    const link = page
      .locator('main')
      .getByRole('link', { name: /Open a GitHub issue/ });
    await expect(link).toHaveAttribute('href', ISSUES);
    await expect(page.locator('main')).toContainText(
      'Found a problem? Open a GitHub issue',
    );
    for (const topic of TOPICS)
      expect(TOPIC_LABELS[topic]).not.toMatch(/problem|bug|report/i);
  });

  test('nothing is sent or stored while composing', async ({ page }) => {
    await page.goto('/contact/');
    await page.waitForLoadState('networkidle');
    await grantClipboard(page);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    const stored = () =>
      page.evaluate(() => [
        JSON.stringify({ ...localStorage }),
        JSON.stringify({ ...sessionStorage }),
        document.cookie,
      ]);
    const before = await stored();
    await offer(page, 'data').click();
    await purpose(page, 'question').check();
    await purpose(page, 'contribute').check();
    await action(page, 'Show email address').click();
    await action(page, 'Copy').click();
    await action(page, 'Copy draft').click();
    await page.waitForTimeout(300);
    expect(requests).toEqual([]);
    expect(await stored()).toEqual(before);
  });
});

test('the letter is a labelled region that is not announced on every change', async ({
  page,
}) => {
  await page.goto('/contact/');
  const region = page.getByRole('region', { name: 'Your draft.' });
  await expect(region).toBeVisible();
  await expect(region.locator('[data-letter]')).toHaveCount(1);
  expect(
    await letter(page).evaluate((element) => element.closest('[aria-live]')),
  ).toBeNull();
  // One live region on the page's composer: the status line.
  await expect(
    composer(page).locator('[aria-live], [role="status"]'),
  ).toHaveCount(1);
});

test('sections grow in and collapse within 240 ms, and at once under reduced motion', async ({
  page,
}) => {
  await page.goto('/contact/');
  const data = page.locator('.letter__section[data-section="data"]');
  await expect(data).toBeHidden();
  // Nothing moves on load.
  expect(
    await composer(page).evaluate(
      (root) => root.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  await offer(page, 'data').click();
  const timings = await data.evaluate((section) =>
    section
      .getAnimations()
      .map((animation) => Number(animation.effect?.getTiming().duration ?? 0)),
  );
  expect(timings.length).toBeGreaterThan(0);
  expect(Math.max(...timings)).toBeLessThanOrEqual(240);
  await expect(data).toBeVisible();
  await expect
    .poll(() => data.evaluate((section) => section.getAnimations().length))
    .toBe(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await offer(page, 'data').click();
  expect(await data.evaluate((section) => section.getAnimations().length)).toBe(
    0,
  );
  await expect(data).toBeHidden();
});

test('a keyboard alone chooses, presses, opens, copies and reveals', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contact/');
  await grantClipboard(page);
  // Tab in from the lede, the last thing before the composer.
  await page.locator('.page-intro__lede').evaluate((lede) => {
    lede.setAttribute('tabindex', '-1');
    (lede as HTMLElement).focus();
  });
  await page.keyboard.press('Tab');
  await expect(purpose(page, 'contribute')).toBeFocused();
  const ring = await page.evaluate(() => {
    const label = document.activeElement!.closest('label')!;
    return getComputedStyle(label).outlineStyle;
  });
  expect(ring).toBe('solid');

  // Arrows move between purposes; the offers come and go with Contribute.
  await page.keyboard.press('ArrowRight');
  await expect(purpose(page, 'question')).toBeChecked();
  await expectLetter(page, { topic: 'question', offers: [] }, 'arrow');
  await page.keyboard.press('ArrowLeft');
  await expect(purpose(page, 'contribute')).toBeChecked();

  await page.keyboard.press('Tab');
  await expect(offer(page, 'code')).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(offer(page, 'data')).toBeFocused();
  await page.keyboard.press('Enter');
  await expectLetter(
    page,
    { topic: 'contribute', offers: ['code', 'data'] },
    'keys',
  );

  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const open = action(page, 'Open draft in your email app');
  await expect(open).toBeFocused();
  expectMailto(
    await mailtoFrom(page, () => page.keyboard.press('Enter')),
    mailtoUrl(
      ADDRESS,
      buildDraft({ topic: 'contribute', offers: ['code', 'data'] }),
    ),
  );
  await page.keyboard.press('Tab');
  await expect(action(page, 'Copy draft')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(composer(page).getByRole('status')).toHaveText('Draft copied');
  await page.keyboard.press('Tab');
  await expect(action(page, 'Blank email')).toBeFocused();
  await page.keyboard.press('Tab');
  // The address is already shown (a draft action shows it), so its Copy is next.
  await expect(action(page, 'Copy')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(composer(page).getByRole('status')).toHaveText('Copied');
  await page.keyboard.press('Tab');
  await expect(
    page.locator('main').getByRole('link', { name: /Open a GitHub issue/ }),
  ).toBeFocused();
});

test('Show email address moves focus to Copy from the keyboard', async ({
  page,
}) => {
  await page.goto('/contact/');
  await action(page, 'Show email address').focus();
  await page.keyboard.press('Enter');
  await expect(action(page, 'Copy')).toBeFocused();
  await expect(composer(page).locator('[data-address]')).toHaveText(ADDRESS);
});

test.describe('on a phone @mobile-chromium', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('controls, then the letter, then the actions, in one column with 44 px targets', async ({
    page,
  }) => {
    await page.goto('/contact/');
    const top = async (locator: Locator) => (await locator.boundingBox())!.y;
    const controls = await top(page.locator('.contact__controls'));
    const draft = await top(page.locator('.contact-letter'));
    const actions = await top(page.locator('.contact__actions'));
    expect(controls).toBeLessThan(draft);
    expect(draft).toBeLessThan(actions);
    const targets = composer(page).locator(
      'label.contact-choice, button:visible',
    );
    for (const target of await targets.all()) {
      const box = (await target.boundingBox())!;
      expect(box.height, await target.innerText()).toBeGreaterThanOrEqual(44);
    }
  });
});

test('no sideways scroll at 320, 390, 640, 1024 or 1440 px', async ({
  page,
}) => {
  for (const width of [320, 390, 640, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      '/contact/?topic=contribute&offer=code,data,expertise,funding',
    );
    await action(page, 'Show email address').click();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${width} px`).toBeLessThanOrEqual(0);
    // No label overflows its control.
    const clipped = await composer(page).evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('label.contact-choice, button')]
        .filter((element) => element.checkVisibility())
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent?.trim()),
    );
    expect(clipped, `${width} px`).toEqual([]);
  }
});

test('without JavaScript the address is spelled out and the composer stays hidden', async ({
  browser,
}) => {
  const context = await (browser as Browser).newContext({
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  await page.goto('/contact/');
  // Playwright's text matchers skip <noscript>, so the line's own text is read directly.
  const line = page.locator('.contact-noscript');
  await expect(line).toBeVisible();
  expect(
    (await line.evaluate((element) => element.textContent))!
      .replace(/\s+/g, ' ')
      .trim(),
  ).toBe('Email us at info [at] genome-os [dot] org.');
  // It takes the composer's place, as wide as a line of text.
  expect((await line.boundingBox())!.width).toBeGreaterThan(300);
  await expect(composer(page)).toBeHidden();
  await expect(
    page.locator('main').getByRole('link', { name: /Open a GitHub issue/ }),
  ).toBeVisible();
  expect(addressForms(await page.content())).toEqual([]);
  await context.close();
});

test('print shows the letter, in dark type, without the controls', async ({
  page,
}) => {
  await page.goto('/contact/?topic=contribute&offer=data');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.contact-letter')).toBeVisible();
  await expect(page.locator('.contact__controls')).toBeHidden();
  await expect(page.locator('.contact__actions')).toBeHidden();
  const colour = await page
    .locator('.letter__heading')
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  expect(colour).toBe('rgb(17, 17, 17)');
});

test('in forced colours a pressed offer and the chosen purpose keep a system outline', async ({
  page,
}) => {
  await page.goto('/contact/?offer=code');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(offer(page, 'code')).toHaveCSS('outline-style', 'solid');
  await expect(
    page.locator('label.contact-choice').filter({ hasText: 'Contribute' }),
  ).toHaveCSS('outline-style', 'solid');
});

for (const viewport of [
  { tag: '@desktop-chromium', width: 1440, height: 900 },
  { tag: '@mobile-chromium', width: 390, height: 844 },
] as const)
  test.describe(`at ${viewport.width} px ${viewport.tag}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('one h1 and no serious axe violations, before and after revealing', async ({
      page,
    }) => {
      await page.goto('/contact/?topic=press');
      await expect(page.locator('h1')).toHaveCount(1);
      const blocking = async () =>
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations.filter(({ impact }) =>
          ['serious', 'critical'].includes(impact ?? ''),
        );
      expect(await blocking()).toEqual([]);
      await action(page, 'Show email address').click();
      await purpose(page, 'contribute').check();
      await offer(page, 'funding').click();
      expect(await blocking()).toEqual([]);
    });
  });

test.describe('Contact in the navigation', () => {
  const names = (nav: Locator) =>
    nav
      .getByRole('link')
      .evaluateAll((links) =>
        links.map(
          (link) => link.getAttribute('aria-label') ?? link.textContent!.trim(),
        ),
      );

  test('the site header lists it after Docs, current on /contact/ @desktop-chromium', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    const primary = page.getByRole('navigation', {
      name: 'Primary navigation',
    });
    expect(await names(primary)).toEqual(NAV);
    await expect(
      primary.getByRole('link', { name: 'Contact' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      primary.getByRole('link', { name: 'Contact' }),
    ).toHaveAttribute('href', '/contact/');
    await page.goto('/project/');
    await expect(
      primary.getByRole('link', { name: 'Contact' }),
    ).not.toHaveAttribute('aria-current', 'page');
    await primary.getByRole('link', { name: 'Contact' }).click();
    await expect(page).toHaveURL(/\/contact\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Start the conversation.',
    );
  });

  test('the Menu lists it below 72rem', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/contact/');
    await page.locator('.mobile-nav summary').click();
    const menu = page.getByRole('navigation', { name: 'Mobile navigation' });
    expect(await names(menu)).toEqual(NAV);
    await expect(menu.getByRole('link', { name: 'Contact' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the docs header and the 404 list it too @desktop-chromium', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const route of ['/docs/', '/404.html']) {
      await page.goto(route);
      expect(
        await names(
          page.getByRole('navigation', { name: 'Primary navigation' }),
        ),
        route,
      ).toEqual(NAV);
    }
  });

  test('both footers link to it, beside Site policies', async ({ page }) => {
    for (const route of ['/', '/docs/system-overview/']) {
      await page.goto(route);
      const contact = page
        .locator('footer, .docs-site-links')
        .getByRole('link', { name: 'Contact', exact: true })
        .last();
      await expect(contact, route).toHaveAttribute('href', '/contact/');
      await expect(
        page
          .getByRole('navigation', { name: 'Site policies' })
          .getByRole('link', { name: 'Privacy' }),
        route,
      ).toBeVisible();
    }
  });

  test('the header row never wraps with Contact in it @desktop-chromium', async ({
    page,
  }) => {
    for (const width of [1153, 1280, 1392, 1440, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/contact/');
      await page.evaluate(() => document.fonts.ready);
      const row = await page.evaluate(() => {
        const inner = document.querySelector('.site-header__inner')!;
        const logo = document
          .querySelector('.wordmark__logo')!
          .getBoundingClientRect();
        return {
          overflow: inner.scrollWidth - inner.clientWidth,
          heights: [...document.querySelectorAll('nav.desktop-nav a')].map(
            (link) => link.getBoundingClientRect().height,
          ),
          foundation: (logo.height * 41.11) / 300,
        };
      });
      expect(row.overflow, `${width} px`).toBeLessThanOrEqual(0);
      expect(row.heights, `${width} px`).toHaveLength(5);
      for (const height of row.heights)
        expect(height, `${width} px`).toBeLessThan(36);
      expect(row.foundation, `${width} px`).toBeGreaterThanOrEqual(7);
    }
  });
});
