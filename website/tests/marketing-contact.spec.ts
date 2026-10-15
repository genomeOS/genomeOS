/**
 * Contact page browser checks (Contact page spec §1–§7; part of the site redesign, #454).
 *
 * - The address is in no served file: not the page, not any script or stylesheet it loads, in no
 *   encoding. Show email address reveals it, Copy copies it.
 * - The composer: every purpose and offer combination sets the live letter exactly as the draft
 *   builder writes it; the draft buttons navigate to the right `mailto:` (read as the request
 *   Chromium makes for it; no mail app answers); Copy draft copies the plain-text draft; the query
 *   preselects, before the island runs too, and keeps in step for sharing.
 * - Keyboard only, phones at 390 and 320 px, no JavaScript, an island that never loads, a blocked
 *   clipboard, print, forced colours, and reduced motion.
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
  type Route,
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
  'Projects',
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
    // Read, not shown: the address is in view, and focus is on its Copy (design critique 1, m-2).
    await expect(status.locator('.visually-hidden')).toHaveText(
      'Email address shown',
    );
    await expect(status.locator('.visually-hidden')).toHaveCSS('width', '1px');
    const copy = action(page, 'Copy');
    await expect(copy).toBeFocused();
    await expect(copy).toHaveAccessibleDescription(ADDRESS);
    // The letter's To line now reads the address too.
    expect((await readLetter(page)).to).toBe(ADDRESS);
    await copy.click();
    await expect(status).toHaveText('Copied');
    // A message that adds something is shown.
    await expect(status.locator('.visually-hidden')).toHaveCount(0);
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
    // A blank email has no draft to copy: the hint is the address the click just showed.
    await expect(composer(page).locator('[data-address]')).toHaveText(ADDRESS);
    await expect(composer(page).getByRole('status')).toHaveText(
      'If no email app opens, write to the address above.',
    );
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

  test('where the clipboard is blocked, the draft or the address is selected instead, and copies by hand as itself', async ({
    page,
  }) => {
    // Only the script's clipboard is blocked: the copy command the keys give still writes it,
    // and the test reads it back.
    await page.addInitScript(() => {
      Clipboard.prototype.writeText = () =>
        Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    });
    await page.goto('/contact/?topic=contribute&offer=data');
    await grantClipboard(page);
    const status = composer(page).getByRole('status');
    const selected = () =>
      page.evaluate(() => window.getSelection()?.toString() ?? '');
    // Emptied first (through `write`, which is not blocked), so a copy that writes nothing fails.
    const copyByHand = async () => {
      await page.evaluate(() =>
        navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([''], { type: 'text/plain' }),
          }),
        ]),
      );
      await page.keyboard.press('ControlOrMeta+KeyC');
      return clipboard(page);
    };
    const asText = (offers: Offer[]) =>
      draftText(ADDRESS, buildDraft({ topic: 'contribute', offers }));

    await action(page, 'Copy draft').click();
    await expect(status).toHaveText(
      'Copying is blocked here. The draft is selected, ready to copy.',
    );
    // The letter is what shows as selected, and a copy of it is the draft, line for line.
    const shown = await selected();
    for (const part of [ADDRESS, 'Contributing to genomeOS: data'])
      expect(shown).toContain(part);
    expect(await copyByHand()).toBe(asText(['data']));

    // Pressed while the letter stays selected, an offer is in the next copy.
    await offer(page, 'funding').press('Space');
    await expect(offer(page, 'funding')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await copyByHand()).toBe(asText(['data', 'funding']));

    // Ends moved onto the letter's first and last text, as a browser may move them (or as a hand
    // selection of the whole letter sets them), still hold the whole letter.
    await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.querySelector('[data-letter]')!,
        NodeFilter.SHOW_TEXT,
        (node) =>
          node.textContent?.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP,
      );
      const first = walker.nextNode()!;
      let last = first;
      while (walker.nextNode()) last = walker.currentNode;
      window
        .getSelection()
        ?.setBaseAndExtent(first, 0, last, last.textContent!.length);
    });
    expect(await copyByHand()).toBe(asText(['data', 'funding']));

    // Any other selection copies as the browser copies it.
    await page.evaluate(() =>
      window
        .getSelection()
        ?.selectAllChildren(document.querySelector('.letter__head dt')!),
    );
    expect(await copyByHand()).toBe('To');
    await page.keyboard.press('ControlOrMeta+KeyA');
    const everything = await copyByHand();
    expect(everything).toContain('Start the conversation.');
    expect(everything).not.toContain(asText(['data', 'funding']));

    await action(page, 'Copy').click();
    await expect(status).toHaveText(
      'Copying is blocked here. The address is selected, ready to copy.',
    );
    expect(await selected()).toBe(ADDRESS);
    expect(await copyByHand()).toBe(ADDRESS);
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
    // Every module script is held back until the letter has been read, so only the inline
    // pre-paint script has run (module scripts also hold back `load`).
    const held: Route[] = [];
    let release = false;
    await page.route(/\/_astro\/.*\.js(\?|$)/, (route) =>
      release ? route.continue() : void held.push(route),
    );
    await page.goto('/contact/?topic=contribute&offer=expertise,code', {
      waitUntil: 'commit',
    });
    await expect(composer(page)).toBeVisible();
    await expect(composer(page)).toHaveAttribute(
      'data-offers',
      'code expertise',
    );
    expect(await composer(page).getAttribute('data-ready')).toBeNull();
    await expect(offer(page, 'code')).toHaveAttribute('aria-pressed', 'true');
    await expectLetter(
      page,
      { topic: 'contribute', offers: ['code', 'expertise'] },
      'pre-paint',
    );
    // Then the island takes over from the same state.
    release = true;
    await Promise.all(held.map((route) => route.continue()));
    await expect(composer(page)).toHaveAttribute('data-ready', '');
    await expect(offer(page, 'code')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-contact-fallback]')).toBeHidden();
  });

  test('if the island never loads, the page spells the address out instead', async ({
    page,
  }) => {
    // A failed chunk: the pre-paint script showed the composer, but nothing in it would work.
    await page.route(/\/_astro\/.*\.js(\?|$)/, (route) => route.abort());
    await page.goto('/contact/?topic=contribute&offer=data');
    await expect(composer(page)).toBeHidden();
    const line = page.locator('[data-contact-fallback]');
    await expect(line).toBeVisible();
    await expect(line).toHaveText('Email us at info [at] genome-os [dot] org.');
    expect(addressForms(await page.content())).toEqual([]);
    await expect(
      page.locator('main').getByRole('link', { name: /Open a GitHub issue/ }),
    ).toBeVisible();
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

  test('Contribute sends data, expertise and funding offers here, offer pressed', async ({
    page,
  }) => {
    await page.goto('/contribute/');
    const start = page.locator('#start');
    for (const which of ['data', 'expertise', 'funding'] as const)
      await expect(
        start.getByRole('link', { name: `Offer ${which}` }),
      ).toHaveAttribute('href', `/contact/?topic=contribute&offer=${which}`);
    await start.getByRole('link', { name: 'Offer funding' }).click();
    await expect(page).toHaveURL(
      /\/contact\/\?topic=contribute&offer=funding$/,
    );
    await expect(offer(page, 'funding')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectLetter(
      page,
      { topic: 'contribute', offers: ['funding'] },
      'from Contribute',
    );
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
    // The last action has finished once it says so.
    await expect(composer(page).getByRole('status')).toHaveText('Draft copied');
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
  // Press and read in one turn of the page, so a slow round trip cannot miss the transitions.
  const pressAndTime = () =>
    data.evaluate((section) => {
      document
        .querySelector<HTMLButtonElement>('button[data-offer="data"]')!
        .click();
      return section
        .getAnimations()
        .map((animation) =>
          Number(animation.effect?.getTiming().duration ?? 0),
        );
    });
  const timings = await pressAndTime();
  expect(timings.length).toBeGreaterThan(0);
  expect(Math.max(...timings)).toBeLessThanOrEqual(240);
  await expect(data).toBeVisible();
  await expect
    .poll(() => data.evaluate((section) => section.getAnimations().length))
    .toBe(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await pressAndTime()).toEqual([]);
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

// Design critique 1: the letter's typesetting at every width.
test.describe('the letter is set like a letter', () => {
  const ALL_OFFERS = '?topic=contribute&offer=code,data,expertise,funding';

  test('each field’s leader runs on from the last word of its label, at 320 and 390 px', async ({
    page,
  }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/contact/${ALL_OFFERS}`);
      await page.evaluate(() => document.fonts.ready);
      const fields = await letter(page).evaluate((root) =>
        [...root.querySelectorAll('.letter__field')]
          .filter((field) =>
            field.checkVisibility({ visibilityProperty: true }),
          )
          .map((field) => {
            const label = field.querySelector('.letter__label')!;
            const words = document.createRange();
            words.selectNodeContents(label.firstChild!);
            const lines = [...words.getClientRects()].filter(
              (rect) => rect.width > 0,
            );
            const first = lines[0];
            const last = lines[lines.length - 1];
            const leader = field
              .querySelector('.letter__leader')!
              .getBoundingClientRect();
            const dash = field
              .querySelector('.letter__dash')!
              .getBoundingClientRect();
            return {
              field: label.textContent!.trim(),
              lines: new Set(lines.map((rect) => Math.round(rect.top))).size,
              first: { top: first.top, bottom: first.bottom },
              last: {
                top: last.top,
                bottom: last.bottom,
                right: last.right,
              },
              leader: { left: leader.left, bottom: leader.bottom },
              shown: label.getBoundingClientRect().right - leader.left,
              dash: { top: dash.top, bottom: dash.bottom },
            };
          }),
      );
      expect(fields, `${width} px`).toHaveLength(16);
      // The widths where labels wrap: the case this guards.
      expect(
        fields.filter(({ lines }) => lines > 1).length,
        `${width} px`,
      ).toBeGreaterThan(0);
      for (const { field, first, last, leader, shown, dash } of fields) {
        const where = `${width} px, ${field}`;
        // On the label's last line, on its baseline: within the line's descent of its bottom.
        expect(leader.bottom, where).toBeGreaterThan(
          (last.top + last.bottom) / 2,
        );
        expect(leader.bottom, where).toBeLessThanOrEqual(last.bottom + 0.5);
        expect(last.bottom - leader.bottom, where).toBeLessThanOrEqual(5);
        // Straight after the last word, with at least 1.25rem of dots in view.
        expect(leader.left, where).toBeGreaterThanOrEqual(last.right - 0.5);
        expect(leader.left - last.right, where).toBeLessThanOrEqual(10);
        expect(shown, where).toBeGreaterThanOrEqual(22);
        // The dash stays on the first line.
        expect(dash.bottom, where).toBeGreaterThan(first.top);
        expect(dash.top, where).toBeLessThan(first.bottom);
      }
    }
  });

  // Design critiques 1 (m-4) and 2 (m-1): the letter's lines, its head and the intro's lede.
  /** The tokens on the last line of an element's text, found by their boxes' centres. */
  const lastLine = (page: Page, selector: string) =>
    page.locator(selector).evaluate((line) => {
      const words: { text: string; y: number }[] = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        for (const match of node.data.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const box = range.getBoundingClientRect();
          // A purpose not chosen is not laid out.
          if (box.width === 0) continue;
          words.push({ text: match[0], y: (box.top + box.bottom) / 2 });
        }
      }
      const bottom = Math.max(...words.map(({ y }) => y));
      return words.filter(({ y }) => bottom - y < 8).map(({ text }) => text);
    });
  /** Words, not the "/" between offers or the full stop after the list (a text of its own). */
  const expectNoLoneWord = (tokens: string[], where: string) => {
    expect(
      tokens.filter((token) => /\p{L}/u.test(token)).length,
      `${where}: ${tokens.join(' ')}`,
    ).toBeGreaterThan(1);
    // No line of the placeholder starts with its slash.
    expect(tokens[0], `${where}: ${tokens.join(' ')}`).not.toBe('/');
  };
  const opening = (topic: Topic) => `.letter__line[data-for-topic="${topic}"]`;
  const greeting = '.letter__body > .letter__para:first-child .letter__line';

  test('no paragraph of the letter ends on one word alone at 1440 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/contact/${ALL_OFFERS}`);
    await page.evaluate(() => document.fonts.ready);
    expectNoLoneWord(
      await lastLine(page, opening('contribute')),
      `1440 px ${ALL_OFFERS}`,
    );
  });

  const STATES = [
    '',
    '?topic=contribute&offer=code',
    '?topic=contribute&offer=funding',
    '?topic=contribute&offer=code,data',
    '?topic=contribute&offer=data,expertise',
    '?topic=contribute&offer=code,data,funding',
    ALL_OFFERS,
    '?topic=question',
    '?topic=partner',
    '?topic=press',
  ];
  for (const width of [320, 360, 375, 390, 414, 430, 1024])
    test(`no line of the subject, the greeting, the opening, the caption or the lede ends on one word alone at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const query of STATES) {
        await page.goto(`/contact/${query}`);
        await page.evaluate(() => document.fonts.ready);
        const topic = (new URLSearchParams(query).get('topic') ??
          'contribute') as Topic;
        const where = `${width} px ${query || 'default'}`;
        expectNoLoneWord(
          await lastLine(page, '[data-letter-subject]'),
          `${where} subject`,
        );
        expectNoLoneWord(
          await lastLine(page, opening(topic)),
          `${where} opening`,
        );
        if (query) continue;
        // The same on every state: read once per width.
        expectNoLoneWord(await lastLine(page, greeting), `${where} greeting`);
        expectNoLoneWord(
          await lastLine(page, '.contact-letter > figcaption'),
          `${where} caption`,
        );
        expectNoLoneWord(
          await lastLine(page, '.page-intro__lede'),
          `${where} lede`,
        );
      }
    });

  test('the caption starts on the letter’s own left edge, and one hairline rules the actions', async ({
    page,
  }) => {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/contact/');
      const edges = await page.evaluate(() => {
        const left = (element: Element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects()[0].left;
        };
        return {
          caption: left(document.querySelector('.contact-letter figcaption')!),
          letter: left(
            document.querySelector('.letter__body [data-letter-line]')!,
          ),
        };
      });
      expect(
        Math.abs(edges.caption - edges.letter),
        `${width} px`,
      ).toBeLessThan(1);
      // The problem link is set apart by space, not a second rule under the address row.
      await expect(page.locator('.contact-problem')).toHaveCSS(
        'border-top-style',
        'none',
      );
    }
  });

  test('a narrow letter sets each label above its value; a wider one beside it', async ({
    page,
  }) => {
    const rows = () =>
      page.locator('.letter__row').evaluateAll((all) =>
        all.map((row) => {
          const dt = row.querySelector('dt')!.getBoundingClientRect();
          const dd = row.querySelector('dd')!;
          const value = dd.getBoundingClientRect();
          return {
            label: row.querySelector('dt')!.textContent!.trim(),
            dt: { left: dt.left, top: dt.top, bottom: dt.bottom },
            dd: { left: value.left, top: value.top, height: value.height },
            line: Number.parseFloat(getComputedStyle(dd).lineHeight),
          };
        }),
      );
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/contact/');
    await page.evaluate(() => document.fonts.ready);
    for (const { label, dt, dd, line } of await rows()) {
      expect(dd.top, label).toBeGreaterThanOrEqual(dt.bottom - 1);
      expect(Math.abs(dd.left - dt.left), label).toBeLessThan(1);
      // "genomeOS Foundation" and "Contributing to genomeOS" each keep one line.
      expect(dd.height, label).toBeLessThan(line * 1.5);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const { label, dt, dd } of await rows()) {
      expect(Math.abs(dd.top - dt.top), label).toBeLessThan(1);
      expect(dd.left, label).toBeGreaterThan(dt.left + 40);
    }
  });
});

test.describe('the phone dock @mobile-chromium', () => {
  const dock = (page: Page) => page.locator('[data-dock]');
  const CORNER = 81; // 4.5rem at the 18 px root: the cookie control's (spec §2.4)

  test('holds the primary action while the letter is read, clear of the cookie corner, until the actions take over', async ({
    page,
  }) => {
    const draft = buildDraft({ topic: 'contribute', offers: [...OFFERS] });
    for (const [width, height] of [
      [390, 844],
      [320, 640],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(
        '/contact/?topic=contribute&offer=code,data,expertise,funding',
      );
      // The first view is the controls': no dock over them.
      await expect(dock(page)).toBeHidden();
      await expect(dock(page)).toHaveAttribute('aria-hidden', 'true');
      await expect(dock(page).locator('button')).toHaveAttribute(
        'tabindex',
        '-1',
      );

      // The letter's head in view: the dock comes in at the foot of the screen.
      await page
        .locator('.letter__head')
        .evaluate((head) => head.scrollIntoView({ block: 'center' }));
      await expect(dock(page)).toBeVisible();
      const box = (await dock(page).locator('button').boundingBox())!;
      expect(box.x + box.width, `${width} px`).toBeLessThanOrEqual(
        width - CORNER + 0.5,
      );
      expect(box.y + box.height, `${width} px`).toBeLessThanOrEqual(height);
      expect(box.height, `${width} px`).toBeGreaterThanOrEqual(44);
      const cookie = await page
        .locator('.cookie-control__toggle')
        .boundingBox();
      if (cookie) expect(box.x + box.width).toBeLessThanOrEqual(cookie.x);

      // It opens the same draft as the button in the page.
      expectMailto(
        await mailtoFrom(page, () => dock(page).locator('button').click()),
        mailtoUrl(ADDRESS, draft),
      );

      // The actions in view: they take over.
      await page
        .locator('.contact__actions')
        .evaluate((actions) => actions.scrollIntoView({ block: 'center' }));
      await expect(dock(page)).toBeHidden();
      // And past them, it stays away.
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await expect(dock(page)).toBeHidden();
    }
  });

  test('keyboards and screen readers keep to the one button in the page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      '/contact/?topic=contribute&offer=code,data,expertise,funding',
    );
    await page
      .locator('.letter__head')
      .evaluate((head) => head.scrollIntoView({ block: 'center' }));
    await expect(dock(page)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open draft in your email app' }),
    ).toHaveCount(1);
    // Tab from Blank email goes to the address, then the problem link: never to the dock.
    await action(page, 'Blank email').focus();
    await page.keyboard.press('Tab');
    await expect(action(page, 'Show email address')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.locator('main').getByRole('link', { name: /Open a GitHub issue/ }),
    ).toBeFocused();
  });

  test('a dock in view from the start lands without moving; none comes in over a button just below the fold', async ({
    page,
  }) => {
    // A tablet's first view holds the letter. With every offer the button in the page is far below.
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(
      '/contact/?topic=contribute&offer=code,data,expertise,funding',
    );
    await expect(dock(page)).toHaveAttribute('data-motion', '');
    await expect(dock(page)).toBeVisible();
    expect(
      await dock(page).evaluate(
        (element) => element.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
    // With none, it is within a quarter of a screen below the fold: no dock over the letter.
    await page.goto('/contact/');
    await expect(dock(page)).toHaveAttribute('data-motion', '');
    await expect(dock(page)).toBeHidden();
  });

  // Design critique 2, I-1: the dock and the button in the page are never on screen together, and
  // the dock never covers the letter's subject, however the head wraps.
  for (const [width, height] of [
    [320, 640],
    [375, 667],
    [390, 844],
    [768, 1024],
  ] as const)
    for (const query of [
      '',
      '?topic=contribute&offer=code,data,expertise,funding',
    ])
      test(`hands over before the button in the page comes into view, clear of the subject, at ${width} × ${height} ${query ? 'with every offer' : 'by default'}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await page.goto(`/contact/${query}`);
        await page.evaluate(() => document.fonts.ready);
        const scan = await page.evaluate(async () => {
          const frames = (count: number) =>
            new Promise<void>((resolve) => {
              const step = () =>
                count-- <= 0 ? resolve() : requestAnimationFrame(step);
              step();
            });
          const dockElement = document.querySelector('[data-dock]')!;
          const docked = dockElement.querySelector('button')!;
          const inPage = document.querySelector(
            '.contact__actions [data-action="open"]',
          )!;
          const subject = document.querySelector('[data-letter-subject]')!;
          const failures: string[] = [];
          let shownAt = 0;
          const end =
            document.documentElement.scrollHeight - window.innerHeight;
          // Down the page in 10 px steps, then back up in 20 px steps.
          const steps = [
            ...Array.from(
              { length: Math.ceil(end / 10) + 1 },
              (_, i) => i * 10,
            ),
            ...Array.from(
              { length: Math.ceil(end / 20) + 1 },
              (_, i) => end - i * 20,
            ),
          ];
          for (const y of steps) {
            // Instant: the page scrolls smoothly, which would lag behind the steps.
            window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
            // The observers report after the frame that moved the page.
            await frames(2);
            if (!dockElement.hasAttribute('data-shown')) continue;
            shownAt += 1;
            const button = inPage.getBoundingClientRect();
            const box = docked.getBoundingClientRect();
            const head = subject.getBoundingClientRect();
            if (button.top < window.innerHeight)
              failures.push(
                `at ${window.scrollY}: the button in the page at ${button.top}`,
              );
            if (box.top < head.bottom && box.bottom > head.top)
              failures.push(`at ${window.scrollY}: over the subject`);
          }
          return { failures, shownAt };
        });
        expect(scan.failures).toEqual([]);
        // It does its job: a phone, or a tablet with a long letter, gets the dock.
        if (width < 768 || query) expect(scan.shownAt).toBeGreaterThan(0);
        else expect(scan.shownAt).toBe(0);
      });

  test('the dock’s label is short, on one line', async ({ page }) => {
    for (const [width, height] of [
      [320, 640],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(
        '/contact/?topic=contribute&offer=code,data,expertise,funding',
      );
      await page
        .locator('.letter__head')
        .evaluate((head) => head.scrollIntoView({ block: 'center' }));
      await expect(dock(page)).toBeVisible();
      const button = dock(page).locator('button');
      await expect(button).toHaveText('Open draft');
      expect((await button.boundingBox())!.height, `${width} px`).toBeLessThan(
        60,
      );
    }
  });
});

test('beside the letter, from 60rem, there is no dock @desktop-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(
    '/contact/?topic=contribute&offer=code,data,expertise,funding',
  );
  for (const top of [0, 400, 800]) {
    await page.evaluate((y) => window.scrollTo(0, y), top);
    await expect(page.locator('[data-dock]')).toBeHidden();
  }
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
    const targets = page.locator(
      '#contact-composer :is(label.contact-choice, button:visible), .contact-problem a',
    );
    expect(await targets.count()).toBeGreaterThan(8);
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
  const line = page.locator('noscript > .contact-noscript');
  await expect(line).toBeVisible();
  // The island-failure copy of the line stays hidden: only one line shows.
  await expect(page.locator('[data-contact-fallback]')).toBeHidden();
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
  // A printout made without JavaScript still says where to write, in the print's dark type.
  await page.emulateMedia({ media: 'print' });
  await expect(line).toBeVisible();
  await expect(line).toHaveCSS('color', 'rgb(17, 17, 17)');
  await expect(line.locator('strong')).toHaveCSS('color', 'rgb(17, 17, 17)');
  await context.close();
});

test('print shows the letter, in dark type on white, without the controls, and runs on between its parts', async ({
  page,
}) => {
  await page.goto('/contact/?topic=contribute&offer=data');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.contact-letter')).toBeVisible();
  await expect(page.locator('.contact__controls')).toBeHidden();
  await expect(page.locator('.contact__actions')).toBeHidden();
  // With the island running, the spelled-out line stays off the sheet too.
  await expect(page.locator('[data-contact-fallback]')).toBeHidden();
  const printed = await page.evaluate(() => {
    const style = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!);
    return {
      heading: style('.letter__heading').color,
      // With background graphics on, these would print under the dark type.
      grounds: ['html', 'body', '.page-intro', '.contact-letter'].map(
        (selector) => style(selector).backgroundColor,
      ),
      // Without background graphics, the plate's corner-tick overlay prints as a white sheet over
      // its frame and caption.
      overlay: getComputedStyle(
        document.querySelector('.contact-letter')!,
        '::before',
      ).display,
      // Paged print keeps a collapsed section's height, so only the draft's own sections lay out.
      sections: [...document.querySelectorAll('.letter__section')].map(
        (section) =>
          `${(section as HTMLElement).dataset.section} ${getComputedStyle(section).display}`,
      ),
    };
  });
  expect(printed.heading).toBe('rgb(17, 17, 17)');
  expect(printed.grounds).toEqual(Array(4).fill('rgb(255, 255, 255)'));
  expect(printed.overlay).toBe('none');
  expect(printed.sections).toEqual([
    'code none',
    'data grid',
    'expertise none',
    'funding none',
    'question none',
    'partner none',
    'press none',
  ]);

  // The longest draft runs on between the letter's parts, so it starts under the intro: two
  // pages, not the intro alone on page 1 and the whole letter on page 2.
  await page.goto(
    '/contact/?topic=contribute&offer=code,data,expertise,funding',
  );
  await page.evaluate(() => document.fonts.ready);
  const pdf = (await page.pdf()).toString('latin1');
  expect(pdf.match(/\/Type\s*\/Page(?!s)/g)).toHaveLength(2);
});

test('in forced colours selection is a system fill, and focus still shows on a selected control', async ({
  page,
}) => {
  await page.goto('/contact/?topic=contribute&offer=code');
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  const choice = (name: string) =>
    page.locator('label.contact-choice').filter({ hasText: name });
  const look = (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fill: style.backgroundColor,
        ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`,
      };
    });

  // Selected and unselected read apart, by fill rather than by outline.
  const chosen = await look(choice('Contribute'));
  const pressed = await look(offer(page, 'code'));
  expect(chosen.fill).not.toBe((await look(choice('Ask a question'))).fill);
  expect(pressed.fill).not.toBe((await look(offer(page, 'data'))).fill);
  expect(chosen.ring).toMatch(/^none /);
  expect(pressed.ring).toMatch(/^none /);

  // Tab in: the chosen purpose, then the pressed offer, each with a ring it lacks at rest.
  await page.locator('.page-intro__lede').evaluate((lede) => {
    lede.setAttribute('tabindex', '-1');
    (lede as HTMLElement).focus();
  });
  await page.keyboard.press('Tab');
  await expect(purpose(page, 'contribute')).toBeFocused();
  const chosenFocused = await look(choice('Contribute'));
  expect(chosenFocused.ring).toMatch(/^solid 2px /);
  expect(chosenFocused.ring).not.toBe(chosen.ring);
  await page.keyboard.press('Tab');
  await expect(offer(page, 'code')).toBeFocused();
  const pressedFocused = await look(offer(page, 'code'));
  expect(pressedFocused.ring).toMatch(/^solid 2px /);
  expect(pressedFocused.ring).not.toBe(pressed.ring);
  expect(pressedFocused.fill).toBe(pressed.fill);
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
    await page.goto('/projects/');
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
    // Marked as the docs sidebar marks it: ion, with a square side rule (design critique 1, m-7).
    await expect(menu.getByRole('link', { name: 'Contact' })).toHaveCSS(
      'color',
      'rgb(112, 230, 255)',
    );
    await expect(menu.getByRole('link', { name: 'Docs' })).toHaveCSS(
      'color',
      'rgb(242, 248, 255)',
    );
    const rule = (name: string) =>
      menu.getByRole('link', { name, exact: true }).evaluate((link) => {
        const style = getComputedStyle(link, '::before');
        return `${style.content} ${style.borderLeftStyle} ${style.borderLeftWidth}`;
      });
    expect(await rule('Contact')).toBe('"" solid 3px');
    expect(await rule('Docs')).toMatch(/^none /);
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

  test('the docs overview has no previous page, so its pager never points back to Contact', async ({
    page,
  }) => {
    await page.goto('/docs/');
    await expect(page.locator('.pagination-links a[rel="prev"]')).toHaveCount(
      0,
    );
    await expect(page.locator('.pagination-links a[rel="next"]')).toHaveCount(
      1,
    );
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
