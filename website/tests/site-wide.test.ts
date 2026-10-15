/**
 * Site-wide checks on the built site after the round-2 integration (round 2 plan T7; rulings 35,
 * 37, 39 and 44; #454), read from dist/ (the production build vitest makes):
 *
 * - no button anywhere shows "Pause", "Play", "Replay" or "Resume" as text outside its visually
 *   hidden name (ruling 35: those controls are glyphs);
 * - no "Schematic" and no "not yet validated" in any served text file, the Atlas app and Docs
 *   included (ruling 39);
 * - no marketing page announces a limitation: no "not yet validated", "plausible map" or
 *   "validated" in its visible text (ruling 37), and nowhere does the site say a use needs clinical
 *   validation or that a range "leans on the model's assumptions" (ruling 59: the Projects
 *   application chip and the HbS map's readout, a script's string);
 * - React (react-dom) is in the Atlas app's chunks only, and no marketing page reaches a chunk
 *   holding it, statically or through a lazy import (ruling 44);
 * - one punctuation rule per heading level on the marketing pages: a visible H1 or H2 is a
 *   sentence and ends with a period (a name, the Atlas's chapter, is not a sentence), and an H3 or
 *   below is a label without one (rulings item 27; design critique of the integrated build, round 2).
 *
 * The runtime side (axe at any instant, visible control text after scripts run, overflow) is
 * tests/marketing-sitewide.spec.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dist } from './helpers/dist';

/** Every file under `dir`, as paths relative to dist/. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : [path.relative(dist, full)];
  });
}

const all = files(dist);
const TEXT = /\.(html|js|mjs|css|json|svg|xml|txt|webmanifest)$/;
const read = (file: string) => readFileSync(path.join(dist, file), 'utf8');
const pages = all.filter((file) => file.endsWith('.html'));
/** The marketing pages: everything but the Atlas app, Docs and the dev gallery. */
const marketing = pages.filter(
  (file) => !/^(app|docs|kit)\//.test(file.split(path.sep).join('/')),
);

/** A page's visible text: no comments, scripts, styles or tags. */
const visibleText = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');

describe('motion controls are glyphs (ruling 35)', () => {
  it('finds the controls it checks', () => {
    const home = read('index.html');
    expect(home).toMatch(/data-video-toggle/);
    expect(home).toMatch(/data-spin-toggle/);
    expect(read(path.join('contribute', 'index.html'))).toMatch(
      /data-scene-toggle/,
    );
  });

  it.each(pages)(
    '%s shows no Pause, Play, Replay or Resume as button text',
    (file) => {
      const shown = [
        ...read(file).matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g),
      ]
        .map(([, inner]) =>
          visibleText(
            inner!
              .replace(/<svg\b[\s\S]*?<\/svg>/g, ' ')
              .replace(
                /<(span|strong|em)\b[^>]*class="[^"]*\bvisually-hidden\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g,
                ' ',
              ),
          ).trim(),
        )
        .filter((text) => /\b(pause|play|replay|resume)\b/i.test(text));
      expect(shown).toEqual([]);
    },
  );
});

describe('no scare labels anywhere (ruling 39)', () => {
  it('checks the whole site, the Atlas app and Docs included', () => {
    const text = all.filter((file) => TEXT.test(file));
    expect(text.some((file) => file.startsWith(`app${path.sep}`))).toBe(true);
    expect(text.some((file) => file.startsWith(`docs${path.sep}`))).toBe(true);
    const hits = text.filter((file) =>
      /schematic|not yet validated/i.test(
        read(file).replace(/<!--[\s\S]*?-->/g, ''),
      ),
    );
    expect(hits).toEqual([]);
  });
});

describe('marketing pages announce no limitations (ruling 37)', () => {
  it.each(marketing)('%s', (file) => {
    const text = visibleText(read(file));
    expect(text).not.toMatch(/not yet validated/i);
    expect(text).not.toMatch(/plausible map/i);
    expect(text).not.toMatch(/\bvalidated\b/i);
    expect(text).not.toMatch(/clinical validation/i);
  });

  // Ruling 59: the two lines the owner ruled out in the final critique, in any served file (the
  // readout's words live in the HbS map's script, not in a page's text).
  it('nowhere says a use needs clinical validation or a range leans on the model', () => {
    const hits = all
      .filter((file) => TEXT.test(file))
      .filter((file) =>
        /clinical validation needed|leans on the model|far from surveys:/i.test(
          read(file).replace(/<!--[\s\S]*?-->/g, ''),
        ),
      );
    expect(hits).toEqual([]);
  });
});

describe('React stays in the Atlas app (ruling 44)', () => {
  const chunks = all.filter((file) => /^_astro[\\/][^\\/]+\.js$/.test(file));
  const name = (file: string) =>
    path.basename(file).replace(/\.[\w-]+\.js$/, '');

  it('only the Atlas chunks hold react-dom', () => {
    const react = chunks.filter((file) => read(file).includes('react-dom'));
    expect(react.length).toBeGreaterThan(0);
    for (const file of react)
      expect(['AtlasExplorer', 'cesium', 'client'], file).toContain(name(file));
  });

  /** Every module a page can load: its module scripts and their static and lazy imports. */
  function reach(html: string): Set<string> {
    const seen = new Set<string>();
    const pending = [
      ...html.matchAll(/<script\b[^>]*type="module"[^>]*src="\/([^"]+)"/g),
    ].map(([, src]) => src!.split('/').join(path.sep));
    for (const [, inline] of html.matchAll(
      /<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g,
    ))
      for (const [, specifier] of inline!.matchAll(
        /["'`]\/(_astro\/[^"'`]+\.js)["'`]/g,
      ))
        pending.push(specifier!.split('/').join(path.sep));
    while (pending.length) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = read(file);
      const dir = path.dirname(file);
      for (const [, specifier] of source.matchAll(
        /(?:\bfrom|\bimport)\s*\(?\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]/g,
      ))
        pending.push(path.normalize(path.join(dir, specifier!)));
      // Lazy imports' preloads (Vite's __vite__mapDeps), relative to the site root.
      for (const [, list] of source.matchAll(/m\.f=\[([^\]]*)\]/g))
        for (const [, dep] of list!.matchAll(/["'`]([^"'`]+\.js)["'`]/g))
          pending.push(dep!.split('/').join(path.sep));
    }
    return seen;
  }

  it.each(marketing)('%s reaches no chunk holding react-dom', (file) => {
    const reached = [...reach(read(file))];
    expect(reached.length).toBeGreaterThan(0);
    expect(
      reached.filter((chunk) => read(chunk).includes('react-dom')),
    ).toEqual([]);
  });
});

describe('one punctuation rule per heading level (marketing pages)', () => {
  /** Headings that are names, not sentences. */
  const NAMES = new Set(['genomeOS Atlas']);
  const headings = (html: string) =>
    [...html.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g)]
      .filter(([, , attributes]) => !/\bvisually-hidden\b/.test(attributes!))
      .map(([, level, , inner]) => ({
        level: Number(level),
        text: visibleText(inner!)
          .replace(/&amp;/g, '&')
          .replace(/&#39;|&rsquo;/g, '’')
          .trim(),
      }))
      .filter(({ text }) => text !== '');

  it('finds the headings it checks', () => {
    expect(
      marketing.flatMap((file) => headings(read(file))).length,
    ).toBeGreaterThan(30);
  });

  it.each(marketing)('%s', (file) => {
    const wrong = headings(read(file)).filter(({ level, text }) =>
      level <= 2 ? !NAMES.has(text) && !/[.?!]$/.test(text) : /\.$/.test(text),
    );
    expect(wrong).toEqual([]);
  });
});
