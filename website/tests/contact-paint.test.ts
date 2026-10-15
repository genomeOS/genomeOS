/**
 * The Contact page's pre-paint script (Contact page spec §2, §3.1): before the first paint it shows
 * the address with Email us and the composer, and applies a `?topic=…&offer=…` preselect. It writes
 * no address: the page is served with it spelled out, and only the island joins it, once a person
 * is here (owner, 2026-10-15). It repeats `parseQuery`'s rule in plain ES5, so every case here runs
 * it against a fake page and compares it with `parseQuery` and the draft builder's own wording: the
 * two cannot drift. At `load`, a page the island never marked ready goes back to the
 * no-JavaScript page: hidden, with the address spelled out in a line of its own.
 */
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  contactDirectScript,
  contactPaintScript,
  offerWording,
  TOPIC_INPUT,
} from '../src/components/contact/contact-paint';
import { ADDRESS_PARTS } from '../src/lib/contact-address';
import {
  OFFERS,
  TOPICS,
  letterList,
  offerList,
  parseQuery,
  subjectSuffix,
} from '../src/lib/contact-draft';

/** Both inline scripts, in the page's order: the address's, then the composer's. */
const SCRIPT = `${contactDirectScript()}\n${contactPaintScript('contact-composer')}`;

interface Painted {
  hidden: boolean;
  /** Whether the address with Email us is hidden. */
  directHidden: boolean;
  /** Whatever was written into the address's places (the line, the letter's To). */
  addresses: string[];
  /** Whether the spelled-out address line is hidden, after `load`. */
  fallbackHidden: boolean;
  topic?: string;
  offers?: string;
  checked: string[];
  pressed: Record<string, string>;
  list?: string;
  suffix?: string;
  /** The letter's typing state, if the script set one: `pending` until the letter is in view. */
  typing?: string;
}

/** The browser the script runs in: its motion preference, forced colours, `@property`. */
interface Browser {
  reducedMotion?: boolean;
  forcedColors?: boolean;
  registerProperty?: boolean;
}

/**
 * Run the inline script against a fake composer, fire `load` (with the island having run or not),
 * and read back what it drew.
 */
function paint(
  search: string,
  {
    islandRan = true,
    browser,
  }: { islandRan?: boolean; browser?: Browser } = {},
): Painted {
  const painted: Painted = {
    hidden: true,
    directHidden: true,
    addresses: [],
    fallbackHidden: true,
    checked: [],
    pressed: {},
  };
  const attributes: Record<string, string> = {};
  const onLoad: (() => void)[] = [];
  const fallback = {
    set hidden(value: boolean) {
      painted.fallbackHidden = value;
    },
  };
  const direct = {
    set hidden(value: boolean) {
      painted.directHidden = value;
    },
  };
  // The address line, then the letter's To.
  const places = ['[data-address]', '[data-to-address]'].map(
    (selector, index) => ({
      selector,
      set textContent(text: string) {
        painted.addresses[index] = text;
      },
    }),
  );
  const radios = TOPICS.map((value) => ({
    value,
    set checked(on: boolean) {
      if (on) painted.checked.push(value);
    },
  }));
  const toggles = OFFERS.map((offer) => ({
    getAttribute: (name: string) => (name === 'data-offer' ? offer : null),
    setAttribute: (name: string, value: string) => {
      if (name === 'aria-pressed') painted.pressed[offer] = value;
    },
  }));
  const list = {
    set textContent(text: string) {
      painted.list = text;
    },
  };
  const suffix = {
    set textContent(text: string) {
      painted.suffix = text;
    },
  };
  const letter = {
    setAttribute: (name: string, value: string) => {
      if (name === 'data-typing') painted.typing = value;
    },
  };
  // A media query as the script asks it: no reduced motion, and no forced colours.
  const matchMedia = (query: string) => ({
    matches:
      query ===
        '(prefers-reduced-motion: no-preference) and (forced-colors: none)' &&
      !browser!.reducedMotion &&
      !browser!.forcedColors,
  });
  const root = {
    set hidden(value: boolean) {
      painted.hidden = value;
    },
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
    },
    removeAttribute: (name: string) => {
      delete attributes[name];
    },
    hasAttribute: (name: string) => name in attributes,
    querySelector: (selector: string) => {
      const radio = selector.match(
        new RegExp(`^input\\[name="${TOPIC_INPUT}"\\]\\[value="([^"]*)"\\]$`),
      );
      if (radio) return radios.find(({ value }) => value === radio[1]) ?? null;
      if (selector === '[data-offer-list]') return list;
      if (selector === '[data-offer-subject]') return suffix;
      if (selector === '[data-letter]') return letter;
      return null;
    },
    querySelectorAll: (selector: string) =>
      selector === '[data-offer]' ? toggles : [],
  };
  runInNewContext(SCRIPT, {
    document: {
      getElementById: (id: string) => (id === 'contact-composer' ? root : null),
      querySelector: (selector: string) =>
        selector === '[data-contact-fallback]'
          ? fallback
          : selector === '[data-contact-direct]'
            ? direct
            : null,
      querySelectorAll: (selector: string) =>
        places.filter((place) => selector.split(', ').includes(place.selector)),
    },
    window: {
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'load') onLoad.push(listener);
      },
      // A browser of old, without either, unless the case gives them.
      ...(browser && {
        matchMedia,
        CSS:
          browser.registerProperty === false ? {} : { registerProperty() {} },
      }),
    },
    location: { search },
    URLSearchParams,
    Object,
    String,
  });
  painted.topic = attributes['data-topic'];
  painted.offers = attributes['data-offers'];
  // The island marks the composer ready before `load`, when it runs at all.
  if (islandRan) attributes['data-ready'] = '';
  for (const listener of onLoad) listener();
  return painted;
}

const QUERIES = [
  '',
  '?topic=contribute',
  '?topic=contribute&offer=data,funding',
  '?topic=contribute&offer=funding,code,code',
  '?offer=EXPERTISE&topic=Contribute',
  '?topic=contribute&offer=code&offer=data',
  '?topic=contribute&offer=money,,time',
  '?topic=question',
  '?topic=partner&offer=code',
  '?topic=press',
  '?topic=report',
  '?topic=__proto__&offer=constructor,__proto__',
  '?offer=data',
  '?topic=%20press%20',
];

describe('the pre-paint composer script', () => {
  it('shows the address with Email us and the composer, which the page renders hidden for visitors without JavaScript', () => {
    expect(paint('').hidden).toBe(false);
    expect(paint('').directHidden).toBe(false);
    expect(paint('?topic=report').hidden).toBe(false);
    expect(paint('').fallbackHidden).toBe(true);
  });

  it('writes no address into the line or the letter: they are served spelled out, and only the island joins it', () => {
    expect(paint('').addresses).toEqual([]);
    expect(paint('?topic=press').addresses).toEqual([]);
  });

  it('goes back to the spelled-out address at load if the island never ran', () => {
    const painted = paint('?topic=contribute&offer=data', { islandRan: false });
    expect(painted.hidden).toBe(true);
    expect(painted.directHidden).toBe(true);
    expect(painted.fallbackHidden).toBe(false);
    // Nothing was joined, so nothing is left to take out.
    expect(painted.addresses).toEqual([]);
  });

  it.each(QUERIES)('agrees with parseQuery on "%s"', (search) => {
    const state = parseQuery(search);
    const painted = paint(search);
    expect(painted.topic).toBe(state.topic);
    expect(painted.offers).toBe(state.offers.join(' '));
    expect(painted.checked).toEqual([state.topic]);
    expect(painted.pressed).toEqual(
      Object.fromEntries(
        OFFERS.map((offer) => [offer, String(state.offers.includes(offer))]),
      ),
    );
    expect(painted.list).toBe(letterList(state.offers));
    expect(painted.suffix).toBe(subjectSuffix(state.offers));
  });

  it('sets the letter waiting to type itself out only where it can, so it never shows whole and then empties', () => {
    expect(paint('', { browser: {} }).typing).toBe('pending');
    expect(paint('?topic=press', { browser: {} }).typing).toBe('pending');
    // Reduced motion and forced colours: the letter is whole at once.
    expect(
      paint('', { browser: { reducedMotion: true } }).typing,
    ).toBeUndefined();
    expect(
      paint('', { browser: { forcedColors: true } }).typing,
    ).toBeUndefined();
    // Without `@property` the twin's characters cannot step, nor without matchMedia.
    expect(
      paint('', { browser: { registerProperty: false } }).typing,
    ).toBeUndefined();
    expect(paint('').typing).toBeUndefined();
  });

  it('carries the wording for every set of offers, from the draft builder', () => {
    const table = offerWording();
    expect(Object.keys(table)).toHaveLength(16);
    // The placeholder as the letter sets it: no line starts with its slashes.
    expect(table['']).toEqual([letterList([]), '']);
    expect(table[''][0]).toBe(
      '[code\u00a0/ data\u00a0/ expertise\u00a0/ funding]',
    );
    // Its words are still the builder's.
    expect(table[''][0].replace(/\u00a0/g, ' ')).toBe(offerList([]));
    expect(table['code data expertise funding']).toEqual([
      'code, data, expertise and funding',
      ': code, data, expertise, funding',
    ]);
  });

  // Design critique 3 set the composer's heading at the site's H2 size, where Raleway's swap moves
  // its glyphs about 4 px: until the face has loaded, the heading waits unseen.
  it('holds the composer’s heading unseen until the display face loads, then shows it', async () => {
    const run = async (loaded: boolean) => {
      const attributes = new Set<string>();
      const heading = {
        setAttribute: (name: string) => attributes.add(name),
        removeAttribute: (name: string) => attributes.delete(name),
      };
      const asked: string[] = [];
      let finish: () => void = () => {};
      const loading = new Promise<void>((resolve) => (finish = resolve));
      runInNewContext(contactPaintScript('contact-composer'), {
        document: {
          getElementById: () => ({
            set hidden(_value: boolean) {},
            querySelector: (selector: string) =>
              selector === '[data-font-wait]' ? heading : null,
          }),
          fonts: {
            check: (face: string) => (asked.push(face), loaded),
            load: () => loading,
          },
        },
        window: { addEventListener: () => {} },
        location: { search: '' },
        URLSearchParams,
        setTimeout: () => 0,
      });
      const pending = attributes.has('data-font-pending');
      finish();
      await loading;
      await Promise.resolve();
      return { asked, pending, after: attributes.has('data-font-pending') };
    };
    expect(await run(false)).toEqual({
      asked: ['400 1em "Raleway Variable"'],
      pending: true,
      after: false,
    });
    // Already loaded (a second page view): it never waits.
    expect(await run(true)).toMatchObject({ pending: false, after: false });
  });

  it('is plain ES5 with no address in it, nor its stored parts', () => {
    expect(SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    expect(SCRIPT).not.toContain('@');
    expect(SCRIPT).not.toContain('fromCharCode');
    for (const codes of [ADDRESS_PARTS.mailbox, ADDRESS_PARTS.domain])
      expect(SCRIPT).not.toContain(JSON.stringify(codes));
  });
});
