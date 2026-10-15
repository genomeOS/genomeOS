/**
 * The micro astronaut (round 2 spec §3.3, §11.1; R2-15): one person in a data figure, a 16 × 20
 * glyph drawn as `<symbol>`s and placed with `<use>`. The suit carries the data, only ever in the
 * `--person-*` tokens; the face variant shows the kit's six skin tones, and the closed variant shows
 * none, so ancestry is never drawn as skin colour.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  MICRO_VIEWBOX,
  microId,
  microSkins,
  microSymbols,
} from '../src/graphics/astro/micro';
import { SKIN } from '../src/graphics/astro/palette';

const symbols = (markup: string) =>
  [
    ...markup.matchAll(/<symbol\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g),
  ].map(([, id, body]) => ({ id, body }));
const all = symbols(microSymbols('all'));
const skinBases = Object.values(SKIN).map(([base]) => base.toLowerCase());
const tokens = readFileSync(
  path.resolve(import.meta.dirname, '../src/styles/tokens.css'),
  'utf8',
);

describe('the micro astronaut symbols', () => {
  it('are sixteen: twelve faces, three closed visors and one untested place', () => {
    expect(all.map(({ id }) => id).sort()).toEqual(
      [
        ...['carrier', 'tested'].flatMap((state) =>
          Object.keys(SKIN).map((skin) => `micro-face-${state}-${skin}`),
        ),
        'micro-closed-carrier',
        'micro-closed-other',
        'micro-closed-tested',
        'micro-untested',
      ].sort(),
    );
    for (const { id } of all) expect(id).toMatch(/^micro-/);
    expect(microSymbols('face').match(/<symbol\b/g)).toHaveLength(13);
    expect(microSymbols('closed').match(/<symbol\b/g)).toHaveLength(4);
  });

  it('draw every symbol on the 16 × 20 grid', () => {
    expect(MICRO_VIEWBOX).toBe('0 0 16 20');
    for (const symbol of microSymbols('all').match(/<symbol\b[^>]*>/g)!)
      expect(symbol).toContain(`viewBox="${MICRO_VIEWBOX}"`);
  });

  it('show each of the six skin tones in the face symbols, one tone per symbol', () => {
    for (const { id, body } of all.filter(({ id }) => id.includes('-face-'))) {
      const skin = id.slice(-2) as keyof typeof SKIN;
      const tones = skinBases.filter((base) =>
        body.toLowerCase().includes(base),
      );
      expect(tones, id).toEqual([SKIN[skin][0].toLowerCase()]);
    }
  });

  it('never draw skin in a closed visor (ancestry is never drawn as skin colour)', () => {
    for (const { id, body } of all.filter(({ id }) => !id.includes('-face-')))
      for (const base of skinBases)
        expect(body.toLowerCase(), id).not.toContain(base);
  });

  it('colour suits only with the --person-* tokens', () => {
    for (const { id, body } of all) {
      const suits = [...body.matchAll(/fill:\s*var\((--[\w-]+)\)/g)].map(
        ([, name]) => name,
      );
      expect(suits.length, id).toBeGreaterThan(0);
      for (const name of suits) {
        expect(name, id).toMatch(/^--person-(tested|other|carrier|untested)$/);
        expect(tokens, name).toContain(`${name}:`);
      }
    }
    const suitOf = (id: string) =>
      all
        .find((symbol) => symbol.id === id)!
        .body.match(/fill:\s*var\((--person-[\w-]+)\)/)![1];
    expect(suitOf('micro-face-carrier-s1')).toBe('--person-carrier');
    expect(suitOf('micro-face-tested-s6')).toBe('--person-tested');
    expect(suitOf('micro-closed-other')).toBe('--person-other');
    expect(suitOf('micro-untested')).toBe('--person-untested');
  });

  it('weigh 3 KB or less in a page', () => {
    expect(gzipSync(microSymbols('all')).length).toBeLessThanOrEqual(3 * 1024);
  });
});

describe('placing people', () => {
  it('names the symbol for a person’s state and, in the face variant, skin', () => {
    expect(microId('carrier', 's3')).toBe('micro-face-carrier-s3');
    expect(microId('tested', 's6')).toBe('micro-face-tested-s6');
    expect(microId('tested')).toBe('micro-closed-tested');
    expect(microId('other')).toBe('micro-closed-other');
    expect(microId('carrier')).toBe('micro-closed-carrier');
    expect(microId('untested', 's2')).toBe('micro-untested');
  });

  it('seeds skin tones per position, the same on every build (mulberry32, SEED = 42)', () => {
    const skins = microSkins(706);
    expect(skins).toEqual(microSkins(706));
    expect(new Set(skins).size).toBe(6);
    // The first positions are stable across builds and across the two rows of a figure.
    expect(microSkins(5)).toEqual(skins.slice(0, 5));
  });
});
