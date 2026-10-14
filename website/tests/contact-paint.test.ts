/**
 * The Contact page's pre-paint script (Contact page spec §2, §3.1): it shows the composer and
 * applies a `?topic=…&offer=…` preselect before the first paint. It repeats `parseQuery`'s rule in
 * plain ES5, so every case here runs it against a fake page and compares it with `parseQuery`
 * and the draft builder's own wording: the two cannot drift.
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
  offerList,
  parseQuery,
  subjectSuffix,
} from '../src/lib/contact-draft';

const SCRIPT = contactPaintScript('contact-composer');

interface Painted {
  hidden: boolean;
  topic?: string;
  offers?: string;
  checked: string[];
  pressed: Record<string, string>;
  list?: string;
  suffix?: string;
}

/** Run the inline script against a fake composer and read back what it drew. */
function paint(search: string): Painted {
  const painted: Painted = { hidden: true, checked: [], pressed: {} };
  const attributes: Record<string, string> = {};
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
    },
    location: { search },
    URLSearchParams,
    Object,
    String,
  });
  painted.topic = attributes['data-topic'];
  painted.offers = attributes['data-offers'];
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
    expect(painted.list).toBe(offerList(state.offers));
    expect(painted.suffix).toBe(subjectSuffix(state.offers));
  });

  it('carries the wording for every set of offers, from the draft builder', () => {
    const table = offerWording();
    expect(Object.keys(table)).toHaveLength(16);
    expect(table['']).toEqual([offerList([]), '']);
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
