/**
 * The Contact page's pre-paint script (Contact page spec §2, §3.1): it shows the composer and
 * applies a `?topic=…&offer=…` preselect before the first paint. It repeats `parseQuery`'s rule in
 * plain ES5, so every case here runs it against a fake page and compares it with `parseQuery`
 * and the draft builder's own wording: the two cannot drift. At `load`, a composer the island never
 * marked ready goes back to the no-JavaScript page: hidden, with the address spelled out.
 */
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  contactPaintScript,
  offerWording,
  TOPIC_INPUT,
} from '../src/components/contact/contact-paint';
import {
  OFFERS,
  TOPICS,
  letterList,
  offerList,
  parseQuery,
  subjectSuffix,
} from '../src/lib/contact-draft';

const SCRIPT = contactPaintScript('contact-composer');

interface Painted {
  hidden: boolean;
  /** Whether the spelled-out address line is hidden, after `load`. */
  fallbackHidden: boolean;
  topic?: string;
  offers?: string;
  checked: string[];
  pressed: Record<string, string>;
  list?: string;
  suffix?: string;
}

/**
 * Run the inline script against a fake composer, fire `load` (with the island having run or not),
 * and read back what it drew.
 */
function paint(search: string, { islandRan = true } = {}): Painted {
  const painted: Painted = {
    hidden: true,
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
  const root = {
    set hidden(value: boolean) {
      painted.hidden = value;
    },
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
    },
    hasAttribute: (name: string) => name in attributes,
    querySelector: (selector: string) => {
      const radio = selector.match(
        new RegExp(`^input\\[name="${TOPIC_INPUT}"\\]\\[value="([^"]*)"\\]$`),
      );
      if (radio) return radios.find(({ value }) => value === radio[1]) ?? null;
      if (selector === '[data-offer-list]') return list;
      if (selector === '[data-offer-subject]') return suffix;
      return null;
    },
    querySelectorAll: (selector: string) =>
      selector === '[data-offer]' ? toggles : [],
  };
  runInNewContext(SCRIPT, {
    document: {
      getElementById: (id: string) => (id === 'contact-composer' ? root : null),
      querySelector: (selector: string) =>
        selector === '[data-contact-fallback]' ? fallback : null,
    },
    window: {
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'load') onLoad.push(listener);
      },
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
  it('shows the composer that the page renders hidden for visitors without JavaScript', () => {
    expect(paint('').hidden).toBe(false);
    expect(paint('?topic=report').hidden).toBe(false);
    expect(paint('').fallbackHidden).toBe(true);
  });

  it('goes back to the spelled-out address at load if the island never ran', () => {
    const painted = paint('?topic=contribute&offer=data', { islandRan: false });
    expect(painted.hidden).toBe(true);
    expect(painted.fallbackHidden).toBe(false);
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

  it('is plain ES5 with no address in it', () => {
    expect(SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    expect(SCRIPT).not.toContain('@');
  });
});
