/**
 * Contact page browser checks (Contact page spec §1–§7; part of the site redesign, #454).
 *
 * - The address is in no served file: not the page, not any script or stylesheet it loads, in no
 *   encoding. The browser joins it: it is in view from the start, beside Email us, whose mailto:
 *   is set only once a visitor reaches for it; its copy button confirms in place.
 * - The template section, below: every purpose and offer combination sets the live letter exactly
 *   as the draft builder writes it; Open draft navigates to the right `mailto:` (read as the
 *   request Chromium makes for it; no mail app answers); the query preselects, before the island
 *   runs too, and keeps in step for sharing.
 * - The letter types itself out once in view, To first and the sign-off last, in at most 3.5 s, and
 *   retypes only what a choice changes; assistive tech reads it whole at every instant, axe finds
 *   nothing mid-typing, and no line moves. Reduced motion, no JavaScript, print and forced colours
 *   show it whole at once.
 * - The order (the address and Email us first, the template steps 1 to 3, the problem link last),
 *   keyboard only, phones at 390 and 320 px, no JavaScript, an island that never loads, a blocked
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
/** The address as the page serves it, until a person is here (owner, 2026-10-15). */
const SPELLED = 'info [at] genome-os [dot] org';
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
    .getByRole('group', { name: 'What it’s about' })
    .getByRole('radio', { name: TOPIC_LABELS[topic], exact: true });
const offer = (page: Page, which: Offer) =>
  page
    .getByRole('group', { name: 'What you’d offer' })
    .getByRole('button', { name: OFFER_LABELS[which], exact: true });
const action = (page: Page, name: string) =>
  composer(page).getByRole('button', { name, exact: true });
const emailUs = (page: Page) =>
  page.locator('main').getByRole('link', { name: 'Email us', exact: true });
const copyButton = (page: Page) =>
  page
    .locator('main')
    .getByRole('button', { name: 'Copy email address', exact: true });
const shownAddress = (page: Page) => page.locator('main [data-address]');
/** The page's one polite live region, out of sight. */
const liveRegion = (page: Page) => page.locator('main [role="status"]');
/** Guidance shown next to the control it follows: Email us and the address, Open draft, or the
 * letter's copy button. */
const hint = (page: Page, which: 'address' | 'draft' | 'letter') =>
  page.locator(`[data-hint="${which}"]`);
/** What still works when a mailto: click opened nothing (owner and controller, 2026-10-15). */
const NOTHING_DRAFT = 'Nothing opened? Copy the letter.';
const NOTHING_EMAIL = 'Nothing opened? Copy the address.';
const PRESS_TO_COPY = 'Press Ctrl+C or Cmd+C to copy.';
const copyLetter = (page: Page) =>
  page.getByRole('button', { name: 'Copy the letter', exact: true });
/** A person here: one move of the pointer over the page. */
const arrive = (page: Page) => page.mouse.move(240, 160);

/** An element's box in the page, not the viewport, so a click that scrolls the page keeps it. */
const pageBox = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      x: box.x + window.scrollX,
      y: box.y + window.scrollY,
      width: box.width,
      height: box.height,
    };
  });

/** Guidance to read on screen, not only a message for screen readers. */
async function expectShown(line: Locator) {
  await expect
    .poll(() =>
      line.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(100);
  await expect(line).toBeVisible();
}

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

/** Copy with the keys, the clipboard emptied first, so a copy that writes nothing fails. */
async function copyByHand(page: Page) {
  await page.evaluate(() =>
    navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([''], { type: 'text/plain' }),
      }),
    ]),
  );
  await page.keyboard.press('ControlOrMeta+KeyC');
  return clipboard(page);
}

/** Two boxes that share any area. */
const overlaps = (
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

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
    // The browser joins it once a person is here, and even then no mailto: link holds it until a
    // visitor reaches for Email us.
    await expect(shownAddress(page)).toHaveText(SPELLED);
    await arrive(page);
    await expect(shownAddress(page)).toHaveText(ADDRESS);
    await expect(page.locator('a[href^="mailto:" i]')).toHaveCount(0);
  });

  // Owner request (2026-10-14): the address is the page's first piece of contact information, in
  // view from the start, so nobody misses it; Show email address is gone.
  test('the address is in view from the start, and its copy button confirms in place for about 2 s', async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto('/contact/');
    await grantClipboard(page);
    // Spelled out until a person is here (owner, 2026-10-15), and read so.
    await expect(shownAddress(page)).toHaveText(SPELLED);
    await expect(shownAddress(page)).toBeInViewport();
    await expect(
      page.getByRole('button', { name: 'Show email address' }),
    ).toHaveCount(0);
    // The letter's To line reads it too.
    expect((await readLetter(page)).to).toBe(SPELLED);

    const copy = copyButton(page);
    await expect(copy).toHaveAccessibleDescription(SPELLED);
    await expect(copy.locator('svg').first()).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    // In the button, which keeps its size.
    const done = page.locator('[data-copied]');
    await expect(done).toBeHidden();
    const before = await pageBox(copy);
    // A press is a person: the address copies, and shows, whole.
    await copy.click();
    expect(await clipboard(page)).toBe(ADDRESS);
    await expect(shownAddress(page)).toHaveText(ADDRESS);
    await expect(copy).toHaveAccessibleDescription(ADDRESS);
    // Confirmed on the button, where the eye is, at its own size; read out of sight.
    await expect(done).toBeVisible();
    await expect(copy).toHaveAccessibleName('Copy email address');
    expect(await pageBox(copy)).toEqual(before);
    await expect(liveRegion(page)).toHaveText('Copied');
    await expect(liveRegion(page)).toHaveCSS('width', '1px');
    await expect(hint(page, 'address')).toBeHidden();
    await page.clock.runFor(1800);
    await expect(done).toBeVisible();
    await page.clock.runFor(400);
    await expect(done).toBeHidden();
    // Still no mailto: link: the address is text.
    await expect(page.locator('a[href^="mailto:" i]')).toHaveCount(0);
  });

  // Owner request: a big Email us button, the plainest way to write, before any template.
  test('Email us opens a plain mailto: to the address, set only once a visitor reaches for it', async ({
    page,
  }) => {
    await page.goto('/contact/', { waitUntil: 'load' });
    const link = emailUs(page);
    await expect(link).toBeVisible();
    await expect(link).toHaveAccessibleName('Email us');
    await expect(link.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    // Loaded, but not yet reached for: no mailto: in it.
    expect(await link.getAttribute('href')).not.toMatch(/^mailto:/i);
    await link.hover();
    await expect(link).toHaveAttribute('href', `mailto:${ADDRESS}`);
    // No subject and no body: a blank email to the address.
    expect(await mailtoFrom(page, () => link.click())).toBe(
      `mailto:${ADDRESS}`,
    );

    // From the keyboard, focus is the reach.
    await page.goto('/contact/', { waitUntil: 'load' });
    expect(await link.getAttribute('href')).not.toMatch(/^mailto:/i);
    await link.focus();
    await expect(link).toHaveAttribute('href', `mailto:${ADDRESS}`);
    expect(await mailtoFrom(page, () => page.keyboard.press('Enter'))).toBe(
      `mailto:${ADDRESS}`,
    );
  });
});

// Owner, 2026-10-15 (~09:55): "remove the border around the copy icon and remove the text 'Copy'".
// The controller: icon-only at every width, the letter's glyph, size and target, so the two read as
// one control; hover changes the glyph's colour only; the ring on keyboard focus only; "Copied"
// beside or under it for about 2 s, moving nothing.
test.describe('the address’s copy glyph', () => {
  const look = (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        border: style.borderTopStyle,
        fill: style.backgroundColor,
        outline: style.outlineStyle,
        color: style.color,
        text: (element as HTMLElement).innerText.trim(),
        width: box.width,
        height: box.height,
      };
    });

  test('is the letter’s glyph: no border, no fill, no word, a 44 px target named "Copy email address"', async ({
    page,
  }) => {
    await page.goto('/contact/');
    const copy = copyButton(page);
    await expect(copy).toHaveAccessibleName('Copy email address');
    const at = await look(copy);
    expect(at).toMatchObject({
      border: 'none',
      fill: 'rgba(0, 0, 0, 0)',
      outline: 'none',
      text: '',
      width: 44,
      height: 44,
    });
    expect(at).toEqual({ ...(await look(copyLetter(page))) });
    // The same glyph at the same size.
    const glyph = (button: Locator) =>
      button.locator('.contact-glyph__idle').evaluate((icon) => ({
        href: icon.querySelector('use')!.getAttribute('href'),
        width: icon.getBoundingClientRect().width,
        height: icon.getBoundingClientRect().height,
      }));
    expect(await glyph(copy)).toEqual(await glyph(copyLetter(page)));
  });

  test('hover changes the glyph’s colour and nothing else; the ring shows on keyboard focus only', async ({
    page,
  }) => {
    await page.goto('/contact/');
    const copy = copyButton(page);
    const rest = await look(copy);
    const box = await pageBox(copy);
    await copy.hover();
    await expect
      .poll(async () => (await look(copy)).color)
      .not.toBe(rest.color);
    expect({ ...(await look(copy)), color: rest.color }).toEqual(rest);
    expect(await pageBox(copy)).toEqual(box);
    // A click focuses it without a ring; the keyboard brings the ring.
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await copy.click();
    expect((await look(copy)).outline).toBe('none');
    await emailUs(page).focus();
    await page.keyboard.press('Tab');
    await expect(copy).toBeFocused();
    expect((await look(copy)).outline).toBe('solid');
  });

  test('pressed, it shows a check and "Copied" for about 2 s, read out, and moves nothing, at 1440, 1024, 390 and 320 px', async ({
    page,
  }) => {
    await page.clock.install();
    await grantClipboard(page);
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 640],
    ] as const) {
      const label = `${width} px`;
      await page.setViewportSize({ width, height });
      await page.goto('/contact/');
      await page.evaluate(() => document.fonts.ready);
      await arrive(page);
      await expect(shownAddress(page)).toHaveText(ADDRESS);
      const copy = copyButton(page);
      const word = page.locator('[data-copied]');
      const boxes = () =>
        Promise.all(
          [
            emailUs(page),
            shownAddress(page),
            copy,
            page.locator('.contact-templates'),
          ].map(pageBox),
        );
      const before = await boxes();
      await expect(word, label).toBeHidden();
      await copy.click();
      expect(await clipboard(page), label).toBe(ADDRESS);
      await expect(copy.locator('.contact-glyph__check'), label).toBeVisible();
      await expect(copy.locator('.contact-glyph__idle'), label).toBeHidden();
      await expect(word, label).toBeVisible();
      await expect(liveRegion(page), label).toHaveText('Copied');
      expect(await boxes(), label).toEqual(before);
      // In view, clear of the address, and no wider than the page.
      const shown = await word.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(document.querySelector('[data-address]')!);
        const address = text.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          address: {
            left: address.left,
            right: address.right,
            top: address.top,
            bottom: address.bottom,
          },
          page: document.documentElement.clientWidth,
          overflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      expect(shown.left, label).toBeGreaterThanOrEqual(0);
      expect(shown.right, label).toBeLessThanOrEqual(shown.page);
      expect(shown.overflow, label).toBeLessThanOrEqual(0);
      expect(overlaps(shown, shown.address), label).toBe(false);
      await page.clock.runFor(1800);
      await expect(word, label).toBeVisible();
      await page.clock.runFor(400);
      await expect(word, label).toBeHidden();
      await expect(copy.locator('.contact-glyph__idle'), label).toBeVisible();
    }
  });
});

// Owner, 2026-10-15: "you sure its ok to display [the address] outright like that? doesnt that make
// us susceptible to bot spam?" The controller's ruling: no CAPTCHA (there is no form to protect);
// the page spells the address out until the first sign of a person, then joins it, once.
test.describe('the address waits for a person', () => {
  test('loaded with no one here, the page holds no address: both places spell it out, as assistive tech reads them', async ({
    page,
  }) => {
    await page.goto('/contact/?topic=contribute&offer=data');
    await expect(composer(page)).toHaveAttribute('data-ready', '');
    await page.waitForLoadState('networkidle');
    // Not in any text or attribute of the page as it stands.
    const dom = await page.evaluate(() => document.documentElement.outerHTML);
    expect(addressForms(dom)).toEqual([]);
    expect(dom).toContain(SPELLED);
    await expect(shownAddress(page)).toHaveText(SPELLED);
    expect((await readLetter(page)).to).toBe(SPELLED);
    await expect(copyButton(page)).toHaveAccessibleDescription(SPELLED);
    const region = page.getByRole('region', { name: 'Your draft.' });
    expect(await region.ariaSnapshot()).toContain(SPELLED);
    expect(await page.locator('main').ariaSnapshot()).not.toContain('@');
    // A script's own events are no person.
    await page.evaluate(() => {
      for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel'])
        window.dispatchEvent(new Event(type));
      document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    await expect(shownAddress(page)).toHaveText(SPELLED);
  });

  test('one move of the pointer joins it in both places, once, and moves nothing', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const shifts: number[] = [];
      (window as unknown as { __shifts: number[] }).__shifts = shifts;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          shifts.push((entry as PerformanceEntry & { value: number }).value);
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const shifts = () =>
      page.evaluate(
        () => (window as unknown as { __shifts: number[] }).__shifts.length,
      );
    // The letter whole at once, so the only change is the address.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 640],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/contact/');
      await page.evaluate(() => document.fonts.ready);
      await expect(composer(page)).toHaveAttribute('data-ready', '');
      const label = `${width} px`;
      const boxes = () =>
        Promise.all(
          [
            shownAddress(page),
            copyButton(page),
            page.locator('.letter__row dd').first(),
            page.locator('.letter__row').nth(1),
            emailUs(page),
            page.locator('.contact-templates'),
          ].map(pageBox),
        );
      const before = await boxes();
      const shifted = await shifts();
      await arrive(page);
      await expect(shownAddress(page), label).toHaveText(ADDRESS);
      expect((await readLetter(page)).to, label).toBe(ADDRESS);
      expect(await boxes(), label).toEqual(before);
      // A frame for any shift to be reported.
      await page.evaluate(
        () =>
          new Promise((done) => requestAnimationFrame(() => setTimeout(done))),
      );
      expect(await shifts(), label).toBe(shifted);
    }
    // Once: a person is here, and the page listens no more.
    await shownAddress(page).evaluate((place) => (place.textContent = 'x'));
    await page.mouse.move(20, 400);
    await page.keyboard.press('Shift');
    await expect(shownAddress(page)).toHaveText('x');
  });

  test('a key, a press, a wheel or focus moving into the page joins it too', async ({
    page,
    isMobile,
  }) => {
    const signs: [string, () => Promise<void>][] = [
      ['a key', () => page.keyboard.press('Shift')],
      ['a press', () => page.mouse.down().then(() => page.mouse.up())],
      ['focus moving in', () => page.keyboard.press('Tab')],
    ];
    if (!isMobile) signs.push(['a wheel', () => page.mouse.wheel(0, 40)]);
    else signs.push(['a touch', () => page.touchscreen.tap(160, 300)]);
    for (const [name, sign] of signs) {
      await page.goto('/contact/');
      await expect(composer(page)).toHaveAttribute('data-ready', '');
      await expect(shownAddress(page), name).toHaveText(SPELLED);
      await sign();
      await expect(shownAddress(page), name).toHaveText(ADDRESS);
      expect((await readLetter(page)).to, name).toBe(ADDRESS);
    }
  });
});

// About 1.5 s after a mailto: click, a page still in front (not blurred, never hidden) means no
// email app took it: the page says what still works, next to the control used.
test.describe('when nothing opens, the page says what still works', () => {
  const CASES = [
    {
      name: 'Open draft',
      which: 'draft',
      text: NOTHING_DRAFT,
      press: (page: Page) =>
        action(page, 'Open draft in your email app').click(),
    },
    {
      name: 'Email us',
      which: 'address',
      text: NOTHING_EMAIL,
      press: (page: Page) => emailUs(page).click(),
    },
  ] as const;

  for (const { name, which, text, press } of CASES)
    test(`after ${name}, a page that keeps the focus shows the hint at 1.5 s, in a line taken at the click`, async ({
      page,
    }) => {
      await page.clock.install();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/contact/');
      const line = hint(page, which);
      await expect(line).toBeHidden();
      await mailtoFrom(page, () => press(page));
      // Its line is laid out at the visitor's own click, unseen, so showing it moves nothing.
      const below = page.locator('.contact-problem');
      const at = await pageBox(below);
      await page.clock.runFor(1400);
      await expect(line).toBeHidden();
      await expect(liveRegion(page)).not.toHaveText(text);
      await page.clock.runFor(200);
      await expect(line).toHaveText(text);
      await expectShown(line);
      await expect(liveRegion(page)).toHaveText(text);
      expect(await pageBox(below)).toEqual(at);
      // Next to the control it follows: under Open draft; under the address, from its left edge
      // (ruling of 2026-10-15), not under the pill.
      const control = await pageBox(
        which === 'draft'
          ? action(page, 'Open draft in your email app')
          : page.locator('.contact-address'),
      );
      const box = await pageBox(line);
      expect(box.y).toBeGreaterThanOrEqual(control.y + control.height - 1);
      expect(box.y - (control.y + control.height)).toBeLessThan(24);
      if (which === 'address')
        expect(
          Math.abs(box.x - (await pageBox(shownAddress(page))).x),
        ).toBeLessThan(1);
      // The old sentence, shown whatever happened, is gone.
      await expect(page.locator('main')).not.toContainText(
        'If no email app opens',
      );
    });

  test('when an app takes the focus, or hides the page, no hint shows', async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto('/contact/');
    // An app took the focus.
    await mailtoFrom(page, () =>
      action(page, 'Open draft in your email app').click(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.clock.runFor(3000);
    await expect(hint(page, 'draft')).toBeHidden();
    await expect(liveRegion(page)).not.toHaveText(NOTHING_DRAFT);
    // An app hid the page (a phone switching to its mail app).
    await mailtoFrom(page, () => emailUs(page).click());
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(3000);
    await expect(hint(page, 'address')).toBeHidden();
    await expect(liveRegion(page)).not.toHaveText(NOTHING_EMAIL);
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
    // The letter is addressed from the start, spelled out until a person is here.
    expect((await readLetter(page)).to).toBe(SPELLED);
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

  test('Open draft navigates to the composed mailto:, and says nothing until nothing has opened', async ({
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
    // The page stays. What still works is said only if no email app took the page (below).
    await expect(page).toHaveURL(
      /\/contact\/\?topic=contribute&offer=code,funding$/,
    );
    await expect(hint(page, 'draft')).toBeHidden();
    await expect(liveRegion(page)).toHaveText('');
    await expect(page.locator('a[href^="mailto:" i]')).toHaveCount(0);

    await purpose(page, 'press').check();
    expectMailto(
      await mailtoFrom(page, () =>
        action(page, 'Open draft in your email app').click(),
      ),
      mailtoUrl(ADDRESS, buildDraft({ topic: 'press', offers: [] })),
    );
  });

  test('guidance shows under the control it follows, only once there is some, and takes no room before', async ({
    page,
  }) => {
    await page.goto('/contact/');
    await grantClipboard(page);
    for (const which of ['address', 'draft'] as const)
      await expect(hint(page, which)).toBeHidden();
    const problem = page.locator('.contact-problem');
    const rest = (await pageBox(problem)).y;
    // A copy is confirmed on its button and read out: no line for it.
    await copyButton(page).click();
    await expect(liveRegion(page)).toHaveText('Copied');
    await expect(hint(page, 'address')).toBeHidden();
    expect((await pageBox(problem)).y).toBe(rest);
    // Open draft's guidance, when nothing opened, takes a line right under the button.
    const open = action(page, 'Open draft in your email app');
    await mailtoFrom(page, () => open.click());
    await expectShown(hint(page, 'draft'));
    const button = await pageBox(open);
    const line = await pageBox(hint(page, 'draft'));
    expect(line.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(line.y - (button.y + button.height)).toBeLessThan(24);
  });

  test('where the clipboard is blocked, the address is selected instead; the whole letter selected copies as the draft', async ({
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
    const selected = () =>
      page.evaluate(() => window.getSelection()?.toString() ?? '');
    // Emptied first (through `write`, which is not blocked), so a copy that writes nothing fails.
    const asText = (offers: Offer[]) =>
      draftText(ADDRESS, buildDraft({ topic: 'contribute', offers }));

    await copyButton(page).click();
    const blocked =
      'Copying is blocked here. The address is selected, ready to copy.';
    await expect(hint(page, 'address')).toHaveText(blocked);
    await expectShown(hint(page, 'address'));
    await expect(liveRegion(page)).toHaveText(blocked);
    // Nothing was copied, so nothing is confirmed.
    await expect(page.locator('[data-copied]')).toBeHidden();
    expect(await selected()).toBe(ADDRESS);
    expect(await copyByHand(page)).toBe(ADDRESS);

    // The whole letter, selected by hand, copies as the draft, line for line: the fallback for a
    // visitor whose email app does not open.
    await letter(page).evaluate((root) =>
      window.getSelection()?.selectAllChildren(root),
    );
    const shown = await selected();
    for (const part of [ADDRESS, 'Contributing to genomeOS: data'])
      expect(shown).toContain(part);
    expect(await copyByHand(page)).toBe(asText(['data']));

    // Pressed while the letter stays selected, an offer is in the next copy.
    await offer(page, 'funding').press('Space');
    await expect(offer(page, 'funding')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await copyByHand(page)).toBe(asText(['data', 'funding']));

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
    expect(await copyByHand(page)).toBe(asText(['data', 'funding']));

    // Any other selection copies as the browser copies it.
    await page.evaluate(() =>
      window
        .getSelection()
        ?.selectAllChildren(document.querySelector('.letter__head dt')!),
    );
    expect(await copyByHand(page)).toBe('To');
    await page.keyboard.press('ControlOrMeta+KeyA');
    const everything = await copyByHand(page);
    expect(everything).toContain('Start the conversation.');
    expect(everything).not.toContain(asText(['data', 'funding']));
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

  test('the address and the preselect are drawn before the island runs', async ({
    page,
  }) => {
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
    // The address, spelled out, is in its first paint; Email us holds no mailto: yet.
    await expect(shownAddress(page)).toHaveText(SPELLED);
    expect((await readLetter(page)).to).toBe(SPELLED);
    await expect(emailUs(page)).toBeVisible();
    expect(await emailUs(page).getAttribute('href')).not.toMatch(/^mailto:/i);
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
    // A failed chunk: the pre-paint script showed the address, Email us and the composer, but
    // nothing in them would work.
    await page.route(/\/_astro\/.*\.js(\?|$)/, (route) => route.abort());
    await page.goto('/contact/?topic=contribute&offer=data');
    await expect(composer(page)).toBeHidden();
    await expect(page.locator('[data-contact-direct]')).toBeHidden();
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
    await emailUs(page).hover();
    await copyButton(page).click();
    // The last action has finished once it says so.
    await expect(liveRegion(page)).toHaveText('Copied');
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
  // One live region on the page, out of sight.
  await expect(
    page.locator('main').locator('[aria-live], [role="status"]'),
  ).toHaveCount(1);
});

// Owner, 2026-10-15: "add a copy icon to the upper right of the rendered template so people can
// easily copy it from there".
test.describe('the letter’s copy button', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('a glyph in the letter’s top-right corner, named by its words, with no outline or fill and a focus ring', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    const button = copyLetter(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName('Copy the letter');
    for (const icon of await button.locator('svg').all())
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
    const look = () =>
      button.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          border: style.borderTopStyle,
          fill: style.backgroundColor,
          outline: style.outlineStyle,
          text: (element as HTMLElement).innerText.trim(),
        };
      });
    // No words of its own at rest: the glyph says it.
    expect(await look()).toEqual({
      border: 'none',
      fill: 'rgba(0, 0, 0, 0)',
      outline: 'none',
      text: '',
    });
    const box = await pageBox(button);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // In the corner: the stage's top right, above the Subject line.
    const stage = await pageBox(
      page.locator('.contact-letter .kit-plate__stage'),
    );
    expect(stage.x + stage.width - (box.x + box.width)).toBeLessThan(28);
    expect(stage.x + stage.width - (box.x + box.width)).toBeGreaterThanOrEqual(
      0,
    );
    expect(box.y - stage.y).toBeLessThan(28);
    expect(box.y).toBeGreaterThanOrEqual(stage.y);
    expect(box.y + box.height).toBeLessThanOrEqual(
      (await pageBox(page.locator('.letter__row').nth(1).locator('dd'))).y,
    );
    // From the keyboard: after Open draft, with the site's ring.
    await action(page, 'Open draft in your email app').focus();
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    expect((await look()).outline).toBe('solid');
  });

  test('it copies the letter as the draft’s text and confirms in place for about 2 s, at its own size', async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto('/contact/?topic=contribute&offer=code,funding');
    await grantClipboard(page);
    const button = copyLetter(page);
    const idle = button.locator('.contact-glyph__idle');
    const check = button.locator('.contact-glyph__check');
    await expect(idle).toBeVisible();
    await expect(check).toBeHidden();
    const before = await pageBox(button);
    await button.click();
    // Exactly what the email app would get, as a copy of the whole letter gives it.
    expect(await clipboard(page)).toBe(
      draftText(
        ADDRESS,
        buildDraft({ topic: 'contribute', offers: ['code', 'funding'] }),
      ),
    );
    await expect(check).toBeVisible();
    await expect(idle).toBeHidden();
    await expect(button).toHaveAccessibleName('Copy the letter');
    expect(await pageBox(button)).toEqual(before);
    await expect(liveRegion(page)).toHaveText('Copied');
    await expect(hint(page, 'letter')).toBeHidden();
    await page.clock.runFor(1800);
    await expect(check).toBeVisible();
    await page.clock.runFor(400);
    await expect(check).toBeHidden();
    await expect(idle).toBeVisible();
    // The choices as they stand: a new purpose copies its own letter.
    await purpose(page, 'partner').check();
    await button.click();
    expect(await clipboard(page)).toBe(
      draftText(ADDRESS, buildDraft({ topic: 'partner', offers: [] })),
    );
  });

  test('"Copied" shows beside its check, inside the plate, at 1440 and 320 px', async ({
    page,
  }) => {
    await grantClipboard(page);
    for (const [width, height] of [
      [1440, 900],
      [320, 640],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/contact/');
      const word = copyLetter(page).getByText('Copied', { exact: true });
      await expect(word).toBeHidden();
      await copyLetter(page).click();
      await expect(word, `${width} px`).toBeVisible();
      const [box, check, stage] = await Promise.all(
        [
          word,
          copyLetter(page).locator('.contact-glyph__check'),
          page.locator('.contact-letter .kit-plate__stage'),
        ].map(pageBox),
      );
      expect(box.x + box.width, `${width} px`).toBeLessThanOrEqual(check.x);
      expect(check.x - (box.x + box.width), `${width} px`).toBeLessThan(16);
      expect(box.x, `${width} px`).toBeGreaterThan(stage.x);
    }
  });

  test('where the clipboard is blocked, the letter is selected instead, and the page says which keys copy it', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Clipboard.prototype.writeText = () =>
        Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    });
    await page.goto('/contact/?topic=question');
    await grantClipboard(page);
    await copyLetter(page).click();
    await expect(hint(page, 'letter')).toHaveText(PRESS_TO_COPY);
    await expectShown(hint(page, 'letter'));
    await expect(liveRegion(page)).toHaveText(PRESS_TO_COPY);
    // Nothing was copied, so nothing is confirmed.
    await expect(
      copyLetter(page).locator('.contact-glyph__check'),
    ).toBeHidden();
    // The whole letter is selected, and the keys copy it as the draft.
    expect(
      await letter(page).evaluate((root) => {
        const selection = window.getSelection()!;
        return (
          selection.rangeCount === 1 &&
          selection.getRangeAt(0).toString() === root.textContent
        );
      }),
    ).toBe(true);
    expect(await copyByHand(page)).toBe(
      draftText(ADDRESS, buildDraft({ topic: 'question', offers: [] })),
    );
    // Its line sits beside the button, at the letter's top.
    const line = await pageBox(hint(page, 'letter'));
    const stage = await pageBox(
      page.locator('.contact-letter .kit-plate__stage'),
    );
    expect(line.y).toBeGreaterThanOrEqual(stage.y);
    expect(line.y + line.height).toBeLessThanOrEqual(
      (await pageBox(page.locator('.letter__head'))).y + 1,
    );
  });
});

test('sections open and close within 240 ms, and at once under reduced motion', async ({
  page,
}) => {
  await page.goto('/contact/');
  const data = page.locator('.letter__section[data-section="data"]');
  await expect(data).toBeHidden();
  // No section moves on load (where it is in view, the letter may be typing itself out).
  expect(
    await composer(page).evaluate(
      (root) =>
        root
          .getAnimations({ subtree: true })
          .filter((animation) => animation instanceof CSSTransition).length,
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

// The owner's request (2026-10-15): "in the preview email template, letters should be written out
// with a typing animation" (Contact page spec §4, "The letter"). Scrubbed through the e2e build's
// motion hooks where an instant matters, and timed on the real clock where the point is time.
test.describe('the letter types itself out', () => {
  /** The name the motion hooks know the letter by. */
  const SCENE = 'contact-letter';
  const ALL_OFFERS = '?topic=contribute&offer=code,data,expertise,funding';
  const plate = (page: Page) => page.locator('.contact-letter');
  /** `pending` until the letter is in view, then `typing`, then `rest`. */
  const typingState = (page: Page) => letter(page).getAttribute('data-typing');
  /** Once the letter's typing has registered with the e2e build's motion hooks. */
  const typingLoaded = async (page: Page) => {
    await page.waitForFunction(() => window.__motion !== undefined);
    await page.evaluate((name) => window.__motion!.ready(name), SCENE);
  };
  /** The letter as it stands `ms` into its current typing, paused there (past the end: at rest). */
  const typeAt = (page: Page, ms: number) =>
    page.evaluate(([name, at]) => window.__motion!.seek(name, at), [
      SCENE,
      ms,
    ] as const);
  const toCentre = (page: Page) =>
    plate(page).evaluate((figure) =>
      figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );

  /**
   * Each line of the letter on screen, top to bottom: what it says (as assistive tech reads it),
   * how many of its characters show (`null`: plain text, all of it showing), and the carets drawn
   * in it. Runs in the page.
   */
  const LINES_ON_SCREEN = (root: Element) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        '.letter__row dd, [data-letter-line]',
      ),
    ]
      .filter((line) =>
        line.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        }),
      )
      .map((line) => {
        // A character that is not laid out (the space that opens a field's label) draws nothing,
        // typed or not: it neither ends the run of shown characters nor carries the caret.
        const chars = [
          ...line.querySelectorAll<HTMLElement>('.letter__typed > span'),
        ].map((char) => ({
          laid: char.getBoundingClientRect().width > 0,
          look: getComputedStyle(char),
        }));
        const drawn = chars.filter(({ laid }) => laid);
        const hidden = chars.findIndex(
          ({ laid, look }) => laid && look.opacity !== '1',
        );
        const carets = drawn.filter(({ look }) => {
          const offset = /\)\s+(-?[\d.]+)px/.exec(look.boxShadow);
          return offset !== null && Number(offset[1]) > 0;
        }).length;
        // A line being typed says its words once, out of sight; a plain one in its own text,
        // less any part not shown (another purpose's subject, the To line's stand-in).
        const sr = line.querySelector(':scope > .visually-hidden');
        let words = sr?.textContent ?? '';
        if (!sr) {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode())
            if (node.parentElement!.getClientRects().length)
              words += node.nodeValue;
        }
        return {
          text: words.replace(/\s+/g, ' ').trim(),
          length: chars.length || [...words].length,
          // The characters shown from the line's start, up to the first one still to type.
          shown: chars.length ? (hidden < 0 ? chars.length : hidden) : null,
          // None shows after that one: shown characters run from the line's start, with no gap.
          prefix: chars
            .slice(hidden < 0 ? chars.length : hidden)
            .every(({ laid, look }) => !laid || look.opacity !== '1'),
          carets,
          typing: line.hasAttribute('data-typing-line'),
        };
      });
  const linesOnScreen = (page: Page) => letter(page).evaluate(LINES_ON_SCREEN);

  test('it waits until it is in view, then types itself out and ends complete', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/contact/');
    await typingLoaded(page);
    await page.waitForTimeout(600);
    // Below the fold it only waits, and shows none of its words, so it never shows whole and then
    // empties when its typing starts.
    expect(await typingState(page)).toBe('pending');
    expect(
      await letter(page).evaluate(
        (root) => root.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
    await expect(page.locator('.letter__typed')).toHaveCount(0);
    for (const part of ['.letter__body', '.letter__row dd'])
      await expect(letter(page).locator(part).first()).toHaveCSS(
        'opacity',
        '0',
      );

    await toCentre(page);
    await expect.poll(() => typingState(page)).toBe('typing');
    const early = await linesOnScreen(page);
    expect(
      early.some(({ shown, length }) => shown !== null && shown < length),
    ).toBe(true);
    await expect.poll(() => typingState(page)).toBe('rest');
    await expectLetter(page, { topic: 'contribute', offers: [] }, 'typed');
    // No one has moved, pressed or typed: the To line typed the address spelled out.
    expect((await readLetter(page)).to).toBe(SPELLED);
    // At rest the letter is plain text again, exactly as served.
    await expect(
      page.locator('.letter__typed, [data-typing-line]'),
    ).toHaveCount(0);
    await expect(letter(page).locator('.visually-hidden')).toHaveCount(0);
  });

  test('it types top to bottom, To first and the sign-off last, with one steady caret', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/?topic=contribute&offer=data');
    await typingLoaded(page);
    let before = -1;
    for (const ms of [0, 120, 400, 800, 1200, 1600, 2000, 2400]) {
      await typeAt(page, ms);
      const lines = await linesOnScreen(page);
      const where = `${ms} ms`;
      // Every line of the letter is typed, To first (the address) and the sign-off last.
      expect(
        lines.every(({ typing }) => typing),
        where,
      ).toBe(true);
      expect(lines[0].text, where).toBe(SPELLED);
      expect(lines.at(-1)!.text, where).toBe('[Your name]');
      for (const { text, prefix } of lines)
        expect(prefix, `${where}: ${text}`).toBe(true);
      // Lines above the one being typed are whole, lines below it not begun.
      const at = lines.findIndex(({ shown, length }) => shown! < length);
      if (at >= 0)
        for (const [index, { shown, length, text }] of lines.entries())
          if (index < at) expect(shown, `${where}: ${text}`).toBe(length);
          else if (index > at) expect(shown, `${where}: ${text}`).toBe(0);
      const shown = lines.reduce((sum, line) => sum + line.shown!, 0);
      const carets = lines.reduce((sum, line) => sum + line.carets, 0);
      if (ms === 0) expect(shown, where).toBe(0);
      else {
        expect(shown, where).toBeGreaterThan(before);
        // One caret, after the last character typed.
        expect(carets, where).toBe(1);
      }
      before = shown;
    }
    // Past its end the letter is at rest: whole, and plain text again.
    await typeAt(page, 60_000);
    await expect.poll(() => typingState(page)).toBe('rest');
    await expectLetter(page, { topic: 'contribute', offers: ['data'] }, 'rest');
    await expect(page.locator('.letter__typed')).toHaveCount(0);
  });

  test('the whole letter types in within 3.5 s, the longest draft too, and a change within 1.3 s', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const changes: [string, number][] = [];
      (window as unknown as { __typing: typeof changes }).__typing = changes;
      new MutationObserver((records) => {
        for (const record of records) {
          const state = (record.target as HTMLElement).dataset.typing;
          if (state) changes.push([state, performance.now()]);
        }
      }).observe(document, { subtree: true, attributeFilter: ['data-typing'] });
    });
    const changes = () =>
      page.evaluate(
        () => (window as unknown as { __typing: [string, number][] }).__typing,
      );
    /** How long each typing took, from its start to its rest. */
    const spans = async () => {
      const list = await changes();
      return list.flatMap(([state, at], index) =>
        state === 'typing' && list[index + 1]?.[0] === 'rest'
          ? [Math.round(list[index + 1][1] - at)]
          : [],
      );
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const query of ['', ALL_OFFERS]) {
      await page.goto(`/contact/${query}`);
      await typingLoaded(page);
      await toCentre(page);
      await expect.poll(() => typingState(page)).toBe('rest');
      const [whole] = await spans();
      expect(
        whole,
        `${query || 'default'}: the whole letter`,
      ).toBeLessThanOrEqual(3500);
      // Typed, not shown at once.
      expect(whole, `${query || 'default'}: the whole letter`).toBeGreaterThan(
        1500,
      );
    }
    // A change: Data's section typed in, with the subject's and the opening's new words.
    await page.goto('/contact/');
    await typingLoaded(page);
    await toCentre(page);
    await expect.poll(() => typingState(page)).toBe('rest');
    await offer(page, 'data').click();
    await expect.poll(async () => (await spans()).length).toBe(2);
    const [, change] = await spans();
    expect(change, 'a change').toBeLessThanOrEqual(1300);
    expect(change, 'a change').toBeGreaterThan(400);
  });

  test('a new purpose retypes only the lines it changes; the others stay on screen throughout', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    await typingLoaded(page);
    await toCentre(page);
    await expect.poll(() => typingState(page)).toBe('rest');
    // Every frame of the change, from the press to the letter's rest: the lines being typed, and
    // whether each other line was whole on screen.
    await letter(page).evaluate((root, linesOnScreen) => {
      const read = new Function(`return (${linesOnScreen})`)() as (
        root: Element,
      ) => {
        text: string;
        shown: number | null;
        length: number;
        typing: boolean;
      }[];
      const frames: ReturnType<typeof read>[] = [];
      (window as unknown as { __frames: typeof frames }).__frames = frames;
      const sample = () => {
        frames.push(read(root));
        if (frames.length < 2 || root.getAttribute('data-typing') !== 'rest')
          requestAnimationFrame(sample);
      };
      // The press, then the first reading in the same turn: the letter as the press left it.
      document
        .querySelector<HTMLInputElement>(
          'input[name="contact-topic"][value="partner"]',
        )!
        .click();
      sample();
    }, LINES_ON_SCREEN.toString());
    await expect.poll(() => typingState(page)).toBe('rest');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __frames: unknown[] }).__frames.length > 1,
        ),
      )
      .toBe(true);
    const frames = await page.evaluate(
      () =>
        (
          window as unknown as {
            __frames: {
              text: string;
              shown: number | null;
              length: number;
              typing: boolean;
            }[][];
          }
        ).__frames,
    );
    const draft = buildDraft({ topic: 'partner', offers: [] });
    const retyped = new Set(
      frames.flatMap((lines) =>
        lines.filter(({ typing }) => typing).map(({ text }) => text),
      ),
    );
    expect([...retyped]).toEqual([
      draft.subject,
      "I'd like to discuss a partnership or collaboration with genomeOS.",
      'Proposal',
      '- Organization:',
      "- What we'd like to do together:",
      '- Timeline:',
    ]);
    // The first reading: the new subject not begun, the opening keeping the words it shares with
    // the old one ("I'd like to "), Proposal not begun.
    const first = frames[0];
    const line = (text: string) => first.find((entry) => entry.text === text)!;
    expect(line(draft.subject).shown).toBe(0);
    expect(
      line("I'd like to discuss a partnership or collaboration with genomeOS.")
        .shown,
    ).toBe("I'd like to ".length);
    expect(line('Proposal').shown).toBe(0);
    // Every other line stayed whole on screen in every frame.
    const kept = [
      SPELLED,
      'Dear genomeOS Foundation team,',
      'About me',
      '- Name:',
      '- Affiliation:',
      '- Role:',
      'Best regards,',
      '[Your name]',
    ];
    for (const [index, lines] of frames.entries())
      for (const text of kept) {
        const entry = lines.find((candidate) => candidate.text === text);
        expect(entry, `frame ${index}: ${text}`).toBeDefined();
        expect(entry!.shown, `frame ${index}: ${text}`).toBeNull();
      }
    // And the opening never lost "I'd like to ".
    for (const [index, lines] of frames.entries()) {
      const opening = lines.find(({ text }) =>
        text.startsWith("I'd like to discuss"),
      )!;
      expect(
        opening.shown ?? opening.length,
        `frame ${index}`,
      ).toBeGreaterThanOrEqual("I'd like to ".length);
    }
    await expectLetter(page, { topic: 'partner', offers: [] }, 'partner');
  });

  test('an offer pressed types its section in; released, its section goes at once and closes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    await typingLoaded(page);
    await toCentre(page);
    await expect.poll(() => typingState(page)).toBe('rest');
    const press = (which: Offer) =>
      letter(page).evaluate(
        (root, [offer, read]) => {
          document
            .querySelector<HTMLButtonElement>(`button[data-offer="${offer}"]`)!
            .click();
          return (
            new Function(`return (${read})`)() as (root: Element) => unknown
          )(root);
        },
        [which, LINES_ON_SCREEN.toString()] as const,
      ) as Promise<Awaited<ReturnType<typeof linesOnScreen>>>;
    const typedOf = (lines: Awaited<ReturnType<typeof linesOnScreen>>) =>
      lines
        .filter(({ typing }) => typing)
        .map(({ text, shown }) => [text, shown]);

    const opening = (offers: Offer[]) =>
      buildDraft({ topic: 'contribute', offers }).body.split('\n\n')[1];
    const kept = "I'd like to contribute to genomeOS by providing ".length;
    // Pressed: the subject keeps its words and types ": data", the opening keeps everything up to
    // its offers, and Data's section types in from nothing.
    expect(typedOf(await press('data'))).toEqual([
      ['Contributing to genomeOS: data', 'Contributing to genomeOS'.length],
      [opening(['data']), kept],
      ['Data', 0],
      ['- Dataset (name or publication):', 0],
      ['- Populations and sample size:', 0],
      ['- Data type (genotypes, allele counts, phenotypes):', 0],
      ['- Consent and access terms:', 0],
    ]);
    await expect.poll(() => typingState(page)).toBe('rest');
    await expectLetter(page, { topic: 'contribute', offers: ['data'] }, 'data');

    // Released: the section leaves the screen at once and closes, the subject loses ": data"
    // with nothing to type, and the opening types its placeholder back.
    const section = page.locator('.letter__section[data-section="data"]');
    const released = await press('data');
    expect(released.some(({ text }) => text === 'Data')).toBe(false);
    expect(typedOf(released)).toEqual([[opening([]), kept]]);
    await expect
      .poll(() =>
        section.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeLessThan(1);
    await expect.poll(() => typingState(page)).toBe('rest');
    await expectLetter(page, { topic: 'contribute', offers: [] }, 'released');
  });

  test('assistive tech reads the whole letter at every instant, never a character at a time', async ({
    page,
  }) => {
    const region = () => page.getByRole('region', { name: 'Your draft.' });
    await page.setViewportSize({ width: 1440, height: 900 });
    // The letter as it reads at rest, with nothing typed.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/contact/');
    const whole = await region().ariaSnapshot();
    await offer(page, 'funding').click();
    const funding = await region().ariaSnapshot();
    expect(funding).not.toBe(whole);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/contact/');
    await typingLoaded(page);
    // Waiting below the fold.
    expect(await typingState(page)).toBe('pending');
    expect(await region().ariaSnapshot()).toBe(whole);
    for (const ms of [0, 300, 900, 1700, 2500]) {
      await typeAt(page, ms);
      expect(await region().ariaSnapshot(), `${ms} ms`).toBe(whole);
    }
    await typeAt(page, 60_000);
    await offer(page, 'funding').click();
    for (const ms of [0, 250, 600]) {
      await typeAt(page, ms);
      expect(await region().ariaSnapshot(), `funding, ${ms} ms`).toBe(funding);
    }
  });

  test('it types whichever form of the address stands; joined mid-typing, the To line shows it whole and is never typed again', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    await typingLoaded(page);
    await typeAt(page, 60);
    const to = async () => (await linesOnScreen(page))[0];
    expect(await to()).toMatchObject({ text: SPELLED, typing: true });
    expect((await to()).shown).toBeLessThan(SPELLED.length);
    // A person arrives while the To line types.
    await arrive(page);
    expect(await to()).toMatchObject({
      text: ADDRESS,
      shown: null,
      typing: false,
      carets: 0,
    });
    // The rest of the letter types on, from where it was; the To line stays whole.
    let before = 0;
    for (const ms of [300, 900, 1600]) {
      await typeAt(page, ms);
      const lines = await linesOnScreen(page);
      expect(lines[0], `${ms} ms`).toMatchObject({
        text: ADDRESS,
        shown: null,
      });
      const shown = lines
        .slice(1)
        .reduce((sum, { shown, length }) => sum + (shown ?? length), 0);
      expect(shown, `${ms} ms`).toBeGreaterThan(before);
      before = shown;
    }
    await typeAt(page, 60_000);
    await expect.poll(() => typingState(page)).toBe('rest');
    expect((await readLetter(page)).to).toBe(ADDRESS);
    await expectLetter(page, { topic: 'contribute', offers: [] }, 'rest');
    // A change after it retypes what it changes, never the To line.
    await offer(page, 'code').click();
    await typeAt(page, 0);
    expect(await to()).toMatchObject({ text: ADDRESS, shown: null });
  });

  test('the copy button stays put while the letter types, and never overlaps the To line, at 1440, 1024, 390 and 320 px', async ({
    page,
  }) => {
    await grantClipboard(page);
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 640],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/contact/');
      await page.evaluate(() => document.fonts.ready);
      await typingLoaded(page);
      const button = copyLetter(page);
      // The button and what it shows (its "Copied" too), and the To line's text and boxes.
      const read = () =>
        page.evaluate(() => {
          const plain = (rect: DOMRect) => ({
            left: rect.left,
            right: rect.right,
            top: rect.top + window.scrollY,
            bottom: rect.bottom + window.scrollY,
          });
          const button = document.querySelector('.letter-copy')!;
          const shown = [button, ...button.querySelectorAll('*')]
            .filter((part) =>
              part.checkVisibility({ visibilityProperty: true }),
            )
            .map((part) => plain(part.getBoundingClientRect()));
          const to = document.createRange();
          to.selectNodeContents(document.querySelector('.letter__row dd')!);
          return {
            button: plain(button.getBoundingClientRect()),
            shown,
            to: [...to.getClientRects()]
              .filter((rect) => rect.width > 0)
              .map(plain),
          };
        });
      const where = (state: string) => `${width} px, ${state}`;
      const expectApart = (
        { shown, to }: Awaited<ReturnType<typeof read>>,
        state: string,
      ) => {
        expect(to.length, where(state)).toBeGreaterThan(0);
        for (const part of shown)
          for (const line of to)
            expect(
              overlaps(part, line),
              `${where(state)}: ${JSON.stringify({ part, line })}`,
            ).toBe(false);
      };
      await expect(button, where('at rest')).toBeVisible();
      const waiting = await read();
      expectApart(waiting, 'waiting');
      expect(waiting.button.right - waiting.button.left).toBeGreaterThanOrEqual(
        44,
      );
      expect(waiting.button.bottom - waiting.button.top).toBeGreaterThanOrEqual(
        44,
      );
      for (const ms of [0, 120, 700, 1500]) {
        await typeAt(page, ms);
        const now = await read();
        // Visible, and where it was, while the letter types.
        await expect(button, where(`${ms} ms`)).toBeVisible();
        expect(now.button, where(`${ms} ms`)).toEqual(waiting.button);
        expectApart(now, `${ms} ms`);
      }
      // At rest, the address joined, and confirming a copy.
      await typeAt(page, 60_000);
      await arrive(page);
      await expect(shownAddress(page)).toHaveText(ADDRESS);
      expectApart(await read(), 'joined');
      await button.click();
      await expect(button).toHaveAttribute('data-confirmed', '');
      const confirmed = await read();
      expect(confirmed.button, where('confirmed')).toEqual(waiting.button);
      expectApart(confirmed, 'confirmed');
    }
  });

  for (const viewport of [
    { tag: '@desktop-chromium', width: 1440, height: 900 },
    { tag: '@mobile-chromium', width: 390, height: 844 },
  ] as const)
    test(`axe finds nothing serious mid-typing, at ${viewport.width} px ${viewport.tag}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/contact/?topic=contribute&offer=code');
      await typingLoaded(page);
      const blocking = async (where: string) =>
        expect(
          (
            await new AxeBuilder({ page })
              .include('main')
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
              .analyze()
          ).violations.filter(({ impact }) =>
            ['serious', 'critical'].includes(impact ?? ''),
          ),
          where,
        ).toEqual([]);
      for (const ms of [150, 900, 1800]) {
        await typeAt(page, ms);
        await blocking(`${ms} ms`);
      }
      await typeAt(page, 60_000);
      await offer(page, 'funding').click();
      await typeAt(page, 300);
      await blocking('mid-change');
    });

  test('typing moves nothing: each line keeps its box from the first character to rest', async ({
    page,
  }) => {
    for (const [width, height] of [
      [1440, 900],
      [320, 640],
    ] as const)
      for (const query of ['', ALL_OFFERS, '?topic=partner']) {
        const where = `${width} px ${query || 'default'}`;
        await page.setViewportSize({ width, height });
        await page.goto(`/contact/${query}`);
        await page.evaluate(() => document.fonts.ready);
        await typingLoaded(page);
        const boxes = () =>
          letter(page).evaluate((root) => [
            Math.round(
              root.closest('figure')!.getBoundingClientRect().height * 100,
            ) / 100,
            ...[...root.querySelectorAll('.letter__row dd, [data-letter-line]')]
              .filter((line) =>
                line.checkVisibility({ visibilityProperty: true }),
              )
              .map((line) => {
                const box = line.getBoundingClientRect();
                return [
                  box.left,
                  box.top + window.scrollY,
                  box.width,
                  box.height,
                ]
                  .map((value) => Math.round(value * 100) / 100)
                  .join(' ');
              }),
          ]);
        const waiting = await boxes();
        for (const ms of [0, 700, 1500]) {
          await typeAt(page, ms);
          expect(await boxes(), `${where}, ${ms} ms`).toEqual(waiting);
        }
        await typeAt(page, 60_000);
        await expect.poll(() => typingState(page)).toBe('rest');
        expect(await boxes(), `${where}, at rest`).toEqual(waiting);
      }
  });

  test('on load it shifts nothing: the letter types in where it already stands @desktop-chromium', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const shifts: { value: number; recent: boolean; inLetter: boolean }[] =
        [];
      (window as unknown as { __shifts: typeof shifts }).__shifts = shifts;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources: { node?: Node }[];
        })[])
          shifts.push({
            value: entry.value,
            recent: entry.hadRecentInput,
            inLetter: entry.sources.some(({ node }) =>
              Boolean(
                (node instanceof Element ? node : node?.parentElement)?.closest(
                  '#contact-composer',
                ),
              ),
            ),
          });
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    // In view from the start, so it types on load.
    await expect.poll(() => typingState(page)).toBe('typing');
    await expect.poll(() => typingState(page)).toBe('rest');
    // A change, then its whole retyping: only the moves right after the press may shift.
    await offer(page, 'expertise').click();
    await expect.poll(() => typingState(page)).toBe('typing');
    await expect.poll(() => typingState(page)).toBe('rest');
    const shifts = await page.evaluate(
      () =>
        (
          window as unknown as {
            __shifts: { value: number; recent: boolean; inLetter: boolean }[];
          }
        ).__shifts,
    );
    const unprompted = shifts.filter(({ recent }) => !recent);
    expect(unprompted.filter(({ inLetter }) => inLetter)).toEqual([]);
    expect(
      unprompted.reduce((sum, { value }) => sum + value, 0),
    ).toBeLessThanOrEqual(0.02);
  });

  test('under reduced motion the letter is whole at once: nothing waits, types or moves', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    await expectLetter(page, { topic: 'contribute', offers: [] }, 'at once');
    expect(await typingState(page)).toBeNull();
    await page.waitForTimeout(500);
    await offer(page, 'code').click();
    await expectLetter(
      page,
      { topic: 'contribute', offers: ['code'] },
      'a change',
    );
    await expect(
      page.locator('.letter__typed, [data-typing-line]'),
    ).toHaveCount(0);
    expect(
      await composer(page).evaluate(
        (root) => root.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
    // Nor is the typing loaded at all.
    expect(
      await page.evaluate(() => window.__motion?.names() ?? []),
    ).not.toContain(SCENE);
  });

  test('without JavaScript the letter is served whole, with nothing in it waiting to be typed', async ({
    browser,
  }) => {
    const context = await (browser as Browser).newContext({
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.goto('/contact/');
    expect(await typingState(page)).toBeNull();
    await expect(
      page.locator('.letter__typed, [data-typing-line]'),
    ).toHaveCount(0);
    // The template section stays hidden without JavaScript (spec §2); shown, its letter is whole.
    await composer(page).evaluate((root) => root.removeAttribute('hidden'));
    await expectLetter(
      page,
      { topic: 'contribute', offers: [] },
      'no JavaScript',
    );
    for (const part of ['.letter__body', '.letter__row dd'])
      await expect(letter(page).locator(part).last()).toHaveCSS('opacity', '1');
    await context.close();
  });

  test('printed, or in forced colours, the letter is whole and has no caret', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const whole = async (where: string) => {
      const lines = await linesOnScreen(page);
      for (const { text, shown, length, carets } of lines) {
        expect(shown ?? length, `${where}: ${text}`).toBe(length);
        expect(carets, `${where}: ${text}`).toBe(0);
      }
      const leaders = await letter(page).evaluate((root) =>
        [...root.querySelectorAll('.letter__leader')]
          .filter((leader) =>
            leader.checkVisibility({ visibilityProperty: true }),
          )
          .map((leader) => leader.getBoundingClientRect().width),
      );
      for (const width of leaders)
        expect(width, `${where}: a leader`).toBeGreaterThan(20);
    };
    // Mid-typing, printed: every character and leader on the sheet.
    await page.goto('/contact/?topic=contribute&offer=funding');
    await typingLoaded(page);
    await typeAt(page, 700);
    await page.emulateMedia({ media: 'print' });
    await whole('printed mid-typing');
    // Before it is in view: the printout has the letter all the same.
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/contact/');
    await typingLoaded(page);
    expect(await typingState(page)).toBe('pending');
    await page.emulateMedia({ media: 'print' });
    await expect(letter(page).locator('.letter__body')).toHaveCSS(
      'opacity',
      '1',
    );
    // Forced colours from the start: no typing at all.
    await page.emulateMedia({ media: 'screen', forcedColors: 'active' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contact/');
    expect(await typingState(page)).toBeNull();
    await whole('forced colours');
    // Forced colours turned on mid-typing: the letter is whole at once.
    await page.emulateMedia({ forcedColors: 'none' });
    await page.goto('/contact/');
    await typingLoaded(page);
    await typeAt(page, 500);
    await page.emulateMedia({ forcedColors: 'active' });
    await whole('forced colours mid-typing');
  });
});

test('a keyboard alone emails, copies, chooses, presses, opens the draft and copies the letter, in the page’s order', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contact/');
  await grantClipboard(page);
  // Tab in from the lede, the last thing before the address.
  await page.locator('.page-intro__lede').evaluate((lede) => {
    lede.setAttribute('tabindex', '-1');
    (lede as HTMLElement).focus();
  });
  await page.keyboard.press('Tab');
  await expect(emailUs(page)).toBeFocused();
  expect(await mailtoFrom(page, () => page.keyboard.press('Enter'))).toBe(
    `mailto:${ADDRESS}`,
  );
  await page.keyboard.press('Tab');
  await expect(copyButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(liveRegion(page)).toHaveText('Copied');
  await expect(page.locator('[data-copied]')).toBeVisible();

  // Then the template, step by step.
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
  const draft = buildDraft({ topic: 'contribute', offers: ['code', 'data'] });
  // The letter's one control, its copy button, then the problem link, last on the page.
  await page.keyboard.press('Tab');
  await expect(copyLetter(page)).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await clipboard(page)).toBe(draftText(ADDRESS, draft));
  await page.keyboard.press('Tab');
  await expect(
    page.locator('main').getByRole('link', { name: /Open a GitHub issue/ }),
  ).toBeFocused();
});

// Design critique 1: the letter's typesetting at every width.
test.describe('the letter is set like a letter', () => {
  const ALL_OFFERS = '?topic=contribute&offer=code,data,expertise,funding';

  // The letter as it settles: mid-typing its words are also a visually hidden copy and a twin of
  // one span a character, which text ranges read too. Typing moves none of its lines ('the letter
  // types itself out').
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

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

// Design critique 3: the spacing of the page's own parts.
test.describe('the page keeps the site’s spacing', () => {
  const VIEWPORTS = [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const;

  // Design critique 3, m-1: the page ended on the intro's own bottom padding, 42 to 68 px above
  // the footer. It now ends on the template section, a band.
  test('it ends on a band’s padding above the footer, as every other page does', async ({
    page,
  }) => {
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await page.goto('/contact/');
      await page.evaluate(() => document.fonts.ready);
      const end = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.paddingTop = 'var(--band-pad)';
        document.body.append(probe);
        const band = Number.parseFloat(getComputedStyle(probe).paddingTop);
        probe.remove();
        const last = Math.max(
          ...[
            ...document.querySelectorAll('.contact-letter, .contact-problem'),
          ].map((part) => part.getBoundingClientRect().bottom),
        );
        const footer = document
          .querySelector('.site-footer')!
          .getBoundingClientRect().top;
        const rule = getComputedStyle(
          document.querySelector('.page-intro')!,
        ).borderBottomWidth;
        return { band, gap: footer - last, rule };
      });
      expect(end.gap, `${width} px`).toBeGreaterThanOrEqual(end.band - 0.5);
      expect(end.gap, `${width} px`).toBeLessThanOrEqual(end.band + 0.5);
      // The template band's own hairline is the one rule under the intro: no second one.
      expect(end.rule, `${width} px`).toBe('0px');
    }
  });

  // Owner request: the template's options read as one clear sequence, with no ragged grid.
  test('the template’s choices fill whole rows, and its steps start level with the letter beside them', async ({
    page,
  }) => {
    for (const [width, height] of [...VIEWPORTS, [320, 640]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/contact/');
      await page.evaluate(() => document.fonts.ready);
      const grids = await page.evaluate(() =>
        ['.contact-choices', '.contact-toggles'].map((selector) => {
          const items = [...document.querySelector(selector)!.children].map(
            (item) => item.getBoundingClientRect(),
          );
          const rows = new Map<number, DOMRect[]>();
          for (const box of items) {
            const key = Math.round(box.top);
            rows.set(key, [...(rows.get(key) ?? []), box]);
          }
          const counts = [...rows.values()].map((row) => row.length);
          return {
            selector,
            counts,
            lefts: [...rows.values()].map((row) => Math.round(row[0].left)),
            rights: [...rows.values()].map((row) =>
              Math.round(row.at(-1)!.right),
            ),
          };
        }),
      );
      for (const grid of grids) {
        const label = `${grid.selector} at ${width} px`;
        expect(new Set(grid.counts).size, label).toBe(1);
        expect(new Set(grid.lefts).size, label).toBe(1);
        expect(new Set(grid.rights).size, label).toBe(1);
      }
      if (width > 960) {
        const tops = await page.evaluate(() =>
          ['.contact__controls', '.contact-letter'].map(
            (selector) =>
              document.querySelector(selector)!.getBoundingClientRect().top,
          ),
        );
        expect(Math.abs(tops[0] - tops[1]), `${width} px`).toBeLessThan(1);
      }
    }
  });
});

test.describe('on a phone @mobile-chromium', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Email us and the address first, then the steps, then the letter, in one column with 44 px targets', async ({
    page,
  }) => {
    await page.goto('/contact/');
    const top = async (locator: Locator) => (await locator.boundingBox())!.y;
    const direct = await top(emailUs(page));
    const steps = await top(page.locator('.contact__controls'));
    const draft = await top(page.locator('.contact-letter'));
    expect(direct).toBeLessThan(steps);
    expect(steps).toBeLessThan(draft);
    const targets = page.locator(
      'main :is([data-email-us], label.contact-choice, button:visible), .contact-problem a',
    );
    // Email us, Copy, four purposes, four offers, Open draft, Copy the letter, the problem link.
    expect(await targets.count()).toBe(13);
    for (const target of await targets.all()) {
      const box = (await target.boundingBox())!;
      const name =
        (await target.getAttribute('aria-label')) ?? (await target.innerText());
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
  });
});

// Owner request (2026-10-14): nobody should miss the plainest way to write. The address and Email
// us come first, on every screen; the template tools follow in their own section, steps 1 to 3;
// the problem link is last.
test('the address and Email us come first in view, then the template section in its steps, and the problem link last', async ({
  page,
}) => {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
    [320, 640],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/contact/');
    await page.evaluate(() => document.fonts.ready);
    const label = `${width} px`;
    await expect(emailUs(page), label).toBeInViewport();
    await expect(shownAddress(page), label).toBeInViewport();
    const order = await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return {
          top: rect.top + window.scrollY,
          bottom: rect.bottom + window.scrollY,
        };
      };
      return {
        email: box('[data-email-us]'),
        address: box('[data-address]'),
        section: box('.contact-templates'),
        heading: box('.contact-templates h2'),
        purpose: box('[data-step="purpose"]'),
        offers: box('[data-step="offers"]'),
        send: box('[data-step="send"]'),
        letter: box('.contact-letter'),
        problem: box('.contact-problem'),
      };
    });
    expect(order.email.bottom, label).toBeLessThanOrEqual(order.section.top);
    expect(order.address.bottom, label).toBeLessThanOrEqual(order.section.top);
    expect(order.heading.bottom, label).toBeLessThanOrEqual(order.purpose.top);
    expect(order.purpose.bottom, label).toBeLessThanOrEqual(order.offers.top);
    expect(order.offers.bottom, label).toBeLessThanOrEqual(order.send.top);
    expect(order.heading.bottom, label).toBeLessThanOrEqual(order.letter.top);
    expect(order.problem.top, label).toBeGreaterThanOrEqual(
      Math.max(order.letter.bottom, order.send.bottom),
    );
  }
  await expect(
    page.getByRole('heading', { level: 2, name: 'Or start from a template' }),
  ).toBeVisible();
  // The old controls are gone.
  for (const name of ['Copy draft', 'Blank email', 'Show email address'])
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(page.locator('[data-dock]')).toHaveCount(0);
});

test('the icons are decoration: each control is named by its own words', async ({
  page,
}) => {
  await page.goto('/contact/');
  const icons = page.locator(
    '[data-contact-direct] svg, #contact-composer svg',
  );
  expect(await icons.count()).toBeGreaterThan(10);
  for (const icon of await icons.all())
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
  await expect(emailUs(page)).toHaveAccessibleName('Email us');
  await expect(copyButton(page)).toHaveAccessibleName('Copy email address');
  await expect(copyLetter(page)).toHaveAccessibleName('Copy the letter');
  for (const topic of TOPICS)
    await expect(purpose(page, topic)).toHaveAccessibleName(
      TOPIC_LABELS[topic],
    );
  for (const which of OFFERS)
    await expect(offer(page, which)).toHaveAccessibleName(OFFER_LABELS[which]);
  // Each purpose and each offer has an icon of its own, and each offer's section in the letter
  // carries its offer's icon.
  const symbols = await page
    .locator('.contact-choice use, .contact-toggle use')
    .evaluateAll((uses) => uses.map((use) => use.getAttribute('href')));
  expect(symbols).toHaveLength(8);
  expect(new Set(symbols).size).toBe(8);
  for (const which of OFFERS) {
    const own = await offer(page, which).locator('use').getAttribute('href');
    await expect(
      page.locator(`.letter__section[data-section="${which}"] use`),
    ).toHaveAttribute('href', own!);
  }
});

// CI's performance job measured CLS 0.033 at 1440 px on an Ubuntu runner, which has no Avenir
// Next: until the web fonts arrived, the generic sans-serif (DejaVu Sans, much wider) broke the
// H1 in two, and the swap lifted the whole composer 73 px.
test('set in the fallback fonts, the intro takes the lines the web fonts give it, so their arrival moves nothing below @desktop-chromium', async ({
  browser,
}) => {
  const VIEWPORTS = [
    [1440, 900],
    [412, 839],
  ] as const;
  const layout = (page: Page) =>
    page.evaluate(() => {
      const box = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      return {
        h1: Math.round(box('.page-intro h1').height),
        lede: Math.round(box('.page-intro__lede').height),
        composer: box('.page-intro__figure').top + window.scrollY,
      };
    });
  const loaded: Awaited<ReturnType<typeof layout>>[] = [];
  const settled = await (browser as Browser).newContext();
  const page = await settled.newPage();
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto('/contact/');
    await page.evaluate(() => document.fonts.ready);
    loaded.push(await layout(page));
  }
  await settled.close();

  // A machine with no Avenir Next and a wide sans-serif, before the web fonts arrive: here they
  // never do.
  const context = await (browser as Browser).newContext();
  const waiting = await context.newPage();
  const session = await context.newCDPSession(waiting);
  await session.send('Page.setFontFamilies', {
    fontFamilies: { sansSerif: 'Verdana' },
  });
  await waiting.route(/\.woff2(\?|$)/, (route) => route.abort());
  await waiting.route(/\/contact\/$|\.css(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replaceAll(
      'Avenir Next',
      'No Such Font',
    );
    await route.fulfill({ response, body });
  });
  for (const [index, [width, height]] of VIEWPORTS.entries()) {
    await waiting.setViewportSize({ width, height });
    await waiting.goto('/contact/');
    await waiting.evaluate(() => document.fonts.ready);
    const fallback = await layout(waiting);
    const label = `${width} px`;
    expect(fallback.h1, `${label}: the H1's height`).toBe(loaded[index].h1);
    expect(fallback.lede, `${label}: the lede's height`).toBe(
      loaded[index].lede,
    );
    expect(
      Math.abs(fallback.composer - loaded[index].composer),
      `${label}: the composer's top`,
    ).toBeLessThan(1);
  }
  await context.close();
});

// The address spelled out is wider than the address: in the fallback font, before the web font
// arrived, it once pushed Copy onto a line of its own at 390 px, and the web font's arrival lifted
// the page by a line (CLS 0.14). Owner (2026-10-15, ~09:55): "make sure the 'Email us' button, the
// email, and the copy icon are all aligned horizontally". In every font, before and after the
// address is joined: wherever the three fit on one line (1440, 1024, 768 px) they share one row
// with their centres level; on a phone the pill keeps its own line and the address and its glyph
// share the row below. Centres are of border boxes, and of the address's own line box (the
// element that holds its text, no wrapper's padding); the glyph sits just after the address.
test('in the web font and the fallbacks, Email us, the address and its copy glyph line up, before and after it is joined @desktop-chromium', async ({
  browser,
}) => {
  for (const font of ['Figtree', 'Avenir Next', 'Figtree Fallback']) {
    const context = await (browser as Browser).newContext();
    const page = await context.newPage();
    if (font !== 'Figtree')
      await page.route(/\.woff2(\?|$)/, (route) => route.abort());
    if (font === 'Figtree Fallback')
      await page.route(/\/contact\/$|\.css(\?|$)/, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replaceAll(
          'Avenir Next',
          'No Such Font',
        );
        await route.fulfill({ response, body });
      });
    for (const width of [1440, 1024, 768, 412, 390, 320]) {
      const label = `${font}, ${width} px`;
      const phone = width < 480;
      await page.setViewportSize({ width, height: 840 });
      await page.goto('/contact/');
      await page.evaluate(() => document.fonts.ready);
      await expect(composer(page)).toHaveAttribute('data-ready', '');
      const row = () =>
        page.evaluate(() => {
          const box = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect().toJSON();
          const text = document.createRange();
          text.selectNodeContents(document.querySelector('[data-address]')!);
          return {
            pill: box('[data-email-us]'),
            slot: box('.contact-address__value'),
            line: box('[data-address]'),
            copy: box('.contact-copy'),
            glyph: box('.contact-copy .contact-glyph__idle'),
            text: text.getBoundingClientRect().toJSON(),
          };
        });
      const centre = ({ top, height }: { top: number; height: number }) =>
        top + height / 2;
      const expectLinedUp = (
        at: Awaited<ReturnType<typeof row>>,
        when: string,
      ) => {
        const where = `${label}, ${when}`;
        // The address and its glyph: one row, centres level, the glyph just after the address.
        expect(
          Math.abs(centre(at.line) - centre(at.copy)),
          `${where}: address and glyph centres`,
        ).toBeLessThanOrEqual(1);
        expect(at.copy.top, where).toBeLessThan(at.line.bottom);
        expect(at.glyph.left, where).toBeGreaterThanOrEqual(at.text.right);
        expect(at.glyph.left - at.text.right, where).toBeLessThanOrEqual(10);
        if (phone) {
          // The pill on its own line above them.
          expect(at.pill.bottom, where).toBeLessThanOrEqual(at.copy.top);
          expect(at.pill.left, where).toBeLessThanOrEqual(at.line.left);
        } else {
          // All three on one row, centres level.
          expect(at.pill.right, where).toBeLessThan(at.line.left);
          expect(
            Math.abs(centre(at.pill) - centre(at.line)),
            `${where}: pill and address centres`,
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(centre(at.pill) - centre(at.copy)),
            `${where}: pill and glyph centres`,
          ).toBeLessThanOrEqual(1);
        }
      };
      const before = await row();
      expectLinedUp(before, 'spelled out');
      await arrive(page);
      await expect(shownAddress(page), label).toHaveText(ADDRESS);
      const after = await row();
      expectLinedUp(after, 'joined');
      // The swap moves nothing: the address fits the box its spelled-out form keeps.
      for (const part of ['pill', 'slot', 'line', 'copy'] as const)
        expect(after[part], `${label}: ${part}`).toEqual(before[part]);
      expect(after.text.width, label).toBeLessThanOrEqual(after.slot.width);
    }
    await context.close();
  }
});

test('no sideways scroll at 320, 390, 640, 1024 or 1440 px', async ({
  page,
}) => {
  for (const width of [320, 390, 640, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      '/contact/?topic=contribute&offer=code,data,expertise,funding',
    );
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${width} px`).toBeLessThanOrEqual(0);
    // No label overflows its control.
    const clipped = await page.locator('main').evaluate((root) =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'label.contact-choice, button, [data-email-us]',
        ),
      ]
        .filter((element) => element.checkVisibility())
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent?.trim()),
    );
    expect(clipped, `${width} px`).toEqual([]);
  }
});

test('without JavaScript the address is spelled out, and Email us and the composer stay hidden', async ({
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
  // It takes the place of the address and Email us, as wide as a line of text.
  expect((await line.boundingBox())!.width).toBeGreaterThan(300);
  await expect(page.locator('[data-contact-direct]')).toBeHidden();
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

test('print shows the address and the letter, in dark type on white, without the controls, and runs on between its parts', async ({
  page,
}) => {
  await page.goto('/contact/?topic=contribute&offer=data');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.contact-letter')).toBeVisible();
  await expect(page.locator('.contact__controls')).toBeHidden();
  await expect(emailUs(page)).toBeHidden();
  await expect(copyButton(page)).toBeHidden();
  // The page's paper says where to write.
  await expect(shownAddress(page)).toBeVisible();
  await expect(shownAddress(page)).toHaveCSS('color', 'rgb(17, 17, 17)');
  // With the island running, the spelled-out line stays off the sheet too.
  await expect(page.locator('[data-contact-fallback]')).toBeHidden();
  const printed = await page.evaluate(() => {
    const style = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!);
    return {
      heading: style('.letter__heading').color,
      // With background graphics on, these would print under the dark type.
      grounds: [
        'html',
        'body',
        '.page-intro',
        '.contact-templates',
        '.contact-letter',
      ].map((selector) => style(selector).backgroundColor),
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
  expect(printed.grounds).toEqual(Array(5).fill('rgb(255, 255, 255)'));
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

  // Tab in from the address's copy button: the chosen purpose, then the pressed offer, each with
  // a ring it lacks at rest.
  await copyButton(page).focus();
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
      await copyButton(page).click();
      await purpose(page, 'contribute').check();
      await offer(page, 'funding').click();
      // Read once the offers have grown in: mid-fade, their text is not yet its own colour.
      await expect
        .poll(() =>
          composer(page).evaluate(
            (root) => root.getAnimations({ subtree: true }).length,
          ),
        )
        .toBe(0);
      expect(await blocking()).toEqual([]);
    });
  });

test('axe finds nothing serious with each hint showing and a copy confirmed', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.install();
  await page.goto('/contact/?topic=contribute&offer=data');
  const blocking = async (where: string) =>
    expect(
      (
        await new AxeBuilder({ page })
          .include('main')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations.filter(({ impact }) =>
        ['serious', 'critical'].includes(impact ?? ''),
      ),
      where,
    ).toEqual([]);
  // Each click is watched until the next: Email us's hint, then Open draft's beside it.
  await mailtoFrom(page, () => emailUs(page).click());
  await page.clock.runFor(1600);
  await expectShown(hint(page, 'address'));
  await blocking('Email us’s hint');
  await mailtoFrom(page, () =>
    action(page, 'Open draft in your email app').click(),
  );
  await page.clock.runFor(1600);
  await expectShown(hint(page, 'draft'));
  await copyLetter(page).click();
  await expect(copyLetter(page)).toHaveAttribute('data-confirmed', '');
  await blocking('Open draft’s hint, the letter copied');
});

// Ruling 35: no visible "Pause", "Play", "Replay" or "Resume" anywhere on the site. The letter's
// typing has no control: reduced motion is its pause.
test('no visible Pause, Play, Replay or Resume, at rest or mid-typing', async ({
  page,
}) => {
  await page.goto('/contact/');
  await page.waitForFunction(() => window.__motion !== undefined);
  await page.evaluate(() => window.__motion!.seek('contact-letter', 400));
  for (const state of ['mid-typing', 'at rest']) {
    const text = await page.locator('body').innerText();
    expect(text, state).not.toMatch(/\b(?:pause|play|replay|resume)\b/i);
    await page.evaluate(() => window.__motion!.seek('contact-letter', 60_000));
  }
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
