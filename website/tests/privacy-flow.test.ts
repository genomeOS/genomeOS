/**
 * The privacy page's "What leaves your browser" figure (site redesign spec §4.5, §9.2; #454).
 *
 * - The consent gate it draws comes from consent.ts's own decision function, `resolveConsent`,
 *   the one the cookie control uses: open for analytics on, closed for off, "not chosen yet" for
 *   an undecided visitor in an opt-in time zone, and removed in a build without analytics.
 * - The small inline script that draws the stored choice before the first paint repeats that
 *   rule (a module script runs too late for it), so every input is checked against
 *   `resolveConsent` here: they cannot drift.
 * - The built page (vitest builds without analytics) draws the gate removed, keeps the
 *   disclosure ledger with every pinned string, and loads nothing third-party.
 */
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  controlGate,
  gatePaintScript,
  gateState,
  readGate,
  type GateState,
} from '../src/components/privacy/privacy-flow';
import { resolveConsent, type ConsentChoice } from '../src/lib/consent';
import { builtHtml } from './helpers/dist';

const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';
const TORONTO = 'America/Toronto';

function storage(value: string | null) {
  return { getItem: () => value };
}

const blocked = {
  getItem: (): string | null => {
    throw new DOMException('blocked', 'SecurityError');
  },
};

describe('the consent gate follows consent.ts', () => {
  const gate = (
    choice: ConsentChoice | null,
    gpc: boolean,
    timeZone: string | undefined,
  ) => gateState(resolveConsent({ choice, gpc, timeZone }));

  it('is open when analytics is on: a choice of On, or the default outside the opt-in regions', () => {
    expect(gate('granted', false, NEW_YORK)).toBe('open');
    expect(gate('granted', true, BERLIN)).toBe('open');
    expect(gate(null, false, NEW_YORK)).toBe('open');
    expect(gate(null, false, undefined)).toBe('open');
  });

  it('is closed when analytics is off: a choice of Off, or Global Privacy Control', () => {
    expect(gate('denied', false, NEW_YORK)).toBe('closed');
    expect(gate('denied', false, BERLIN)).toBe('closed');
    expect(gate(null, true, NEW_YORK)).toBe('closed');
    expect(gate(null, true, BERLIN)).toBe('closed');
  });

  it('waits, closed, for an undecided visitor in an opt-in time zone', () => {
    expect(gate(null, false, BERLIN)).toBe('pending');
    expect(gate(null, false, TORONTO)).toBe('pending');
  });

  it('is removed in a build without analytics', () => {
    expect(gateState(null)).toBe('removed');
  });

  it('reads the stored choice, the browser signal and the time zone through consent.ts', () => {
    expect(
      readGate({
        storage: storage('denied'),
        navigator: {},
        timeZone: NEW_YORK,
      }),
    ).toBe('closed');
    expect(
      readGate({
        storage: storage('granted'),
        navigator: {},
        timeZone: BERLIN,
      }),
    ).toBe('open');
    expect(
      readGate({ storage: storage(null), navigator: {}, timeZone: BERLIN }),
    ).toBe('pending');
    expect(
      readGate({
        storage: storage(null),
        navigator: { globalPrivacyControl: true },
        timeZone: NEW_YORK,
      }),
    ).toBe('closed');
    // Blocked storage reads as no choice, as the cookie control reads it.
    expect(
      readGate({ storage: blocked, navigator: {}, timeZone: NEW_YORK }),
    ).toBe('open');
    expect(readGate({ storage: null, navigator: {}, timeZone: BERLIN })).toBe(
      'pending',
    );
  });
});

describe('once the cookie control has drawn a state, the gate mirrors it', () => {
  // The control keeps the page's choice (and its gtag consent) in memory, so the gate follows
  // what the control shows, not storage: storage can be blocked, or changed by another tab.
  it('is open when the control shows analytics on', () => {
    expect(controlGate({ consent: 'granted', prompting: false })).toBe('open');
  });

  it('is closed when the control shows analytics off', () => {
    expect(controlGate({ consent: 'denied', prompting: false })).toBe('closed');
  });

  it('waits, closed, while the control asks for a first choice', () => {
    expect(controlGate({ consent: 'denied', prompting: true })).toBe('pending');
  });

  it('defers to consent.ts before the control has drawn anything', () => {
    expect(controlGate({ consent: undefined, prompting: false })).toBeNull();
    expect(controlGate({ consent: null, prompting: false })).toBeNull();
    expect(controlGate({ consent: '', prompting: true })).toBeNull();
    expect(controlGate({ consent: 'yes', prompting: false })).toBeNull();
  });
});

describe('the pre-paint gate script', () => {
  const script = gatePaintScript('privacy-flow');

  /** Run the inline script against a fake page and return the gate it drew. */
  function paint(options: {
    stored: string | null;
    gpc: unknown;
    timeZone: string | undefined;
    storageBlocked?: boolean;
    intlBroken?: boolean;
  }): string | null {
    let drawn: string | null = null;
    const figure = {
      setAttribute: (name: string, value: string) => {
        if (name === 'data-gate') drawn = value;
      },
    };
    const window = {
      get localStorage() {
        if (options.storageBlocked)
          throw new DOMException('blocked', 'SecurityError');
        return storage(options.stored);
      },
      navigator: { globalPrivacyControl: options.gpc },
    };
    const Intl = {
      DateTimeFormat: () => {
        if (options.intlBroken) throw new RangeError('no time zone data');
        return { resolvedOptions: () => ({ timeZone: options.timeZone }) };
      },
    };
    runInNewContext(script, {
      window,
      document: {
        getElementById: (id: string) => (id === 'privacy-flow' ? figure : null),
      },
      Intl,
    });
    return drawn;
  }

  const stored = ['granted', 'denied', null, 'yes'] as const;
  const signals = [false, true, 'true'] as const;
  const zones = [BERLIN, NEW_YORK, TORONTO, 'Europe/Moscow', '', undefined];
  const cases = stored.flatMap((value) =>
    signals.flatMap((gpc) =>
      zones.flatMap((timeZone) =>
        [false, true].map((storageBlocked) => ({
          stored: value,
          gpc,
          timeZone,
          storageBlocked,
        })),
      ),
    ),
  );

  it.each(cases)(
    'draws what resolveConsent decides for %o',
    ({ stored: value, gpc, timeZone, storageBlocked }) => {
      const choice =
        !storageBlocked && (value === 'granted' || value === 'denied')
          ? value
          : null;
      const expected: GateState = gateState(
        resolveConsent({ choice, gpc: gpc === true, timeZone }),
      );
      expect(paint({ stored: value, gpc, timeZone, storageBlocked })).toBe(
        expected,
      );
    },
  );

  it('still draws a gate when the browser reports no time zone data', () => {
    expect(
      paint({ stored: null, gpc: false, timeZone: BERLIN, intlBroken: true }),
    ).toBe('open');
  });

  it('does nothing on a page without the figure', () => {
    expect(() =>
      runInNewContext(script, {
        window: {},
        document: { getElementById: () => null },
        Intl,
      }),
    ).not.toThrow();
  });

  it('names no Google host and makes no request', () => {
    expect(script).not.toMatch(/google|fetch|XMLHttpRequest|src=|import\(/i);
  });
});

/** Markup as text: tags removed and entities decoded, for copy checks. */
function textOf(markup: string): string {
  return markup
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** The text of the page's <main>. */
const mainText = (html: string) =>
  textOf(html.slice(html.indexOf('<main'), html.indexOf('</main>')));

describe('the built privacy page (a build without analytics)', () => {
  const html = builtHtml('privacy');
  const figureStart = html.indexOf('data-graphic="privacy-flow"');
  const figure = html.slice(
    html.lastIndexOf('<figure', figureStart),
    html.indexOf('</figure>', figureStart),
  );

  it('opens on the figure, inside its one concept section', () => {
    expect(html, 'privacy/index.html was not built').not.toBe('');
    expect(html.match(/\sdata-concept[\s=>]/g) ?? []).toHaveLength(1);
    expect(figureStart).toBeGreaterThan(html.indexOf('data-concept'));
    expect(figureStart).toBeLessThan(html.indexOf('<dl'));
  });

  it('draws the gate removed, says so, and ships no gate script', () => {
    expect(figure).toMatch(/\sdata-gate="removed"/);
    expect(textOf(figure)).toContain('This copy loads no analytics');
    expect(html).not.toContain('genomeos-analytics-consent');
    expect(html).not.toContain('globalPrivacyControl');
  });

  it('links the gate to the choice it reads', () => {
    expect(figure).toMatch(/<a\b[^>]*href="#your-choice"/);
    expect(html).toMatch(/\sid="your-choice"/);
  });

  it('keeps the map imagery wire apart from the gate, with its own name', () => {
    expect(figure).toMatch(
      /role="img"[^>]*aria-label="Map imagery loads from its providers"|aria-label="Map imagery loads from its providers"[^>]*role="img"/,
    );
  });

  it('loads nothing: no image, frame or remote source in the figure', () => {
    expect(figure).not.toMatch(/<(img|iframe|object|embed|video|audio)\b/);
    expect(figure).not.toMatch(/\s(src|href)="(https?:)?\/\//);
  });

  it('keeps the twelve disclosure rows, with the fallback note first', () => {
    expect(html.match(/<dt\b/g) ?? []).toHaveLength(12);
    expect(html.match(/<dd\b/g) ?? []).toHaveLength(12);
    const note = html.indexOf('data-no-analytics');
    expect(note).toBeGreaterThan(figureStart);
    expect(note).toBeLessThan(html.indexOf('<dt'));
    expect(html).not.toContain('contribution-detail');
  });

  it('keeps every pinned disclosure verbatim (audit §8.4)', () => {
    const text = mainText(html);
    for (const pin of [
      'Google Analytics 4',
      '_ga',
      '_ga_<container>',
      'European Economic Area, UK, Switzerland, Quebec and Turkey: opt-in. This includes',
      'Devices set to Eastern Time in Canada',
      'only once you have chosen Accept or turned analytics on yourself',
      'Everywhere else: opt-out.',
      'Global Privacy Control',
      'does not log or store IP addresses',
      'Google signals are off',
      'not in a cookie',
      'small cookie icon',
      'Each lasts up to two years',
      'the site doesn’t load Google Analytics',
      'keeps this visit-level data for two months',
      'under the map controls on a wide screen',
      // The rest of the full disclosure (audit §8.4).
      'Åland, the Channel Islands, the Isle of Man and Gibraltar',
      'cookieless pings',
      'turning it off removes its cookies',
      'Device, browser and operating system',
      'Language and screen size',
      'switches between globe, map and perspective views',
      'which inspector is opened',
      'only aggregate reports are kept',
      'No advertising or ad personalisation',
      'OpenStreetMap and Cesium ion',
      'Change your choice at any time',
      'Cookie settings link opens the same panel',
      'maintainers see only its aggregate reports',
      'so we can improve them',
    ])
      expect(text, pin).toContain(pin);
    expect(html).toMatch(
      /<a\b[^>]*href="https:\/\/policies\.google\.com\/privacy"[^>]*>privacy policy<\/a>/,
    );
    expect(html).toMatch(
      /<a\b[^>]*href="https:\/\/policies\.google\.com\/technologies\/partner-sites"/,
    );
  });

  it('never runs a word into the inline element that follows it ("choose<strong>Accept")', () => {
    // copy-spacing.test.ts checks the closing side; Astro's HTML compression also drops a line
    // break before an opening inline tag.
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    const joined = [
      ...main.matchAll(/[\p{L}\p{N},.;:)]<(?:a|b|em|span|strong)\b/gu),
    ].map((match) =>
      main.slice(Math.max(0, match.index - 30), match.index + 20),
    );
    expect(joined).toEqual([]);
  });

  it('sets no text in a monospace element', () => {
    expect(html.slice(html.indexOf('<main'))).not.toMatch(
      /<(code|kbd|samp|pre)\b/,
    );
  });
});
