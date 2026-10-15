/**
 * The Home page contract (round 2 spec §4.1, §7, §11.1; R2-3, R2-14; #454), read from the built
 * page: the order of its concepts, one figure each, what left Home for Projects, how its figures
 * load (none of them is first-load JS), and the chrome every page shares. The hero film and the
 * Atlas preview have their own file, home-hero.test.ts; the copy is in content-home.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dist } from './helpers/dist';

const homepage = path.join(dist, 'index.html');
const html = existsSync(homepage) ? readFileSync(homepage, 'utf8') : '';
const visibleText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));

/** The markup of the section whose opening tag matches `pattern`, up to its close. */
function section(pattern: RegExp): string {
  const start = main.search(pattern);
  if (start === -1) return '';
  const end = main.indexOf('</section>', start);
  return main.slice(start, end);
}

describe('homepage structure', () => {
  it('has four concept sections, why → how → atlas → join, each with one figure', () => {
    const concepts = [
      ...main.matchAll(/<section\b[^>]*\bdata-concept\b[^>]*>/g),
    ].map((match) => match[0].match(/\bid="([^"]+)"/)?.[1] ?? '?');
    expect(concepts).toEqual(['why', 'how', 'atlas', 'join']);
    const parts = main.split(/<section\b[^>]*\bdata-concept\b[^>]*>/).slice(1);
    for (const part of parts) {
      const own = part.slice(0, part.indexOf('</section>'));
      expect(own.match(/<figure\b[^>]*\bdata-graphic\b/g) ?? []).toHaveLength(
        1,
      );
    }
    const graphics = [...main.matchAll(/<figure\b[^>]*data-graphic="([^"]+)"/g)]
      .map(([, name]) => name)
      .filter((name) => name !== 'hero-film');
    expect(graphics).toEqual([
      'people',
      'how-it-works',
      'atlas-preview',
      'crew',
    ]);
    // The hero comes first and is not a concept: its film is decorative.
    expect(main.indexOf('id="hero"')).toBeLessThan(main.indexOf('id="why"'));
    expect(section(/<section\b[^>]*\bid="hero"/)).not.toContain('data-concept');
  });

  it('leaves the technical story to Projects (R2-3): no Pipeline, counts, totals or vision', () => {
    for (const graphic of [
      'pipeline',
      'counts',
      'evidence-base',
      'applications',
      'vision',
      'open-field',
      'scale-ladder',
    ])
      expect(main, graphic).not.toMatch(
        new RegExp(`data-graphic="${graphic}"`),
      );
    expect(main).not.toContain('data-pipeline');
    expect(main).not.toMatch(/\bid="(metrics|applications|vision|open)"/);
    expect(visibleText).not.toContain('Counts, not guesses');
    expect(visibleText).not.toContain('4,392');
    expect(visibleText).not.toContain('Potential applications');
  });

  it('never says "Not yet validated" and never links the old /project/ route', () => {
    expect(visibleText).not.toMatch(/not yet validated/i);
    expect(main).not.toContain('data-status="not-validated"');
    expect(html).not.toMatch(/href="\/project\/(#[^"]*)?"/);
    expect(main).toMatch(/href="\/projects\/"/);
  });

  it('opens the Atlas from the preview’s pill, in the wordmark', () => {
    const atlas = section(/<section\b[^>]*\bid="atlas"/);
    const pill = atlas.match(/<a class="atlas-open" href="([^"]+)"/);
    expect(pill?.[1]).toMatch(/^\/app\//);
    expect(atlas).toMatch(
      /class="atlas-open"[\s\S]*?<span class="brand-name">genomeOS<\/span>/,
    );
  });

  it('sends the hero’s two calls to action to Contribute and down to How it works', () => {
    const hero = section(/<section\b[^>]*\bid="hero"/);
    const actions = [
      ...hero.matchAll(
        /<a class="(button-link[^"]*)" href="([^"]+)"[^>]*>([^<]+)</g,
      ),
    ].map(([, kind, href, label]) => ({ kind, href, label: label.trim() }));
    expect(actions).toEqual([
      { kind: 'button-link', href: '/contribute/', label: 'Get involved' },
      {
        kind: 'button-link button-link--quiet',
        href: '#how',
        label: 'How it works',
      },
    ]);
    expect(main).toContain('id="how"');
  });
});

describe('homepage figures', () => {
  it('draws the people as closed-visor micro astronauts in one sprite, never skin tones', () => {
    const why = section(/<section\b[^>]*\bid="why"/);
    expect(why.match(/<symbol\b/g)).toHaveLength(4);
    expect(why).not.toMatch(/micro-face-/);
    // One <use> per person per layout (100) plus the 14 tone layers, never one drawing each.
    expect(why.match(/<use\b[^>]*class="people__p"/g)).toHaveLength(200);
  });

  it('builds the steps plate in two layouts with two lanes that never join', () => {
    const how = section(/<section\b[^>]*\bid="how"/);
    // Each layout's markup, up to the next (it nests the Atlas mark's own <svg>).
    const layouts = how
      .split(/(?=<svg\b[^>]*class="hiw-svg")/)
      .slice(1)
      .map((svg) => [svg, svg.match(/data-layout="(\w+)"/)![1]] as const);
    expect(layouts.map(([, name]) => name)).toEqual(['wide', 'tall']);
    for (const [svg, name] of layouts) {
      for (const wire of [
        'in0',
        'in1',
        'in2',
        'to-model',
        'measured',
        'modeled',
      ])
        expect(svg, `${name} ${wire}`).toContain(`data-wire="${wire}"`);
      // The measured lane is white, the modeled lane teal: separate paths, separate classes.
      expect(svg).toMatch(
        /class="hiw-wire hiw-wire--measured"[^>]*data-wire="measured"/,
      );
      expect(svg).toMatch(
        /class="hiw-wire hiw-wire--modeled"[^>]*data-wire="modeled"/,
      );
      // The Atlas mark: hex cells (some hatched: gaps stay gaps) and six white studs on top.
      expect(svg).toContain('atlas-mark--stage');
      expect(svg).toMatch(/data-hatch/);
      expect(
        svg
          .match(/class="atlas-mark__studs"[\s\S]*?<\/g>/)![0]
          .match(/<circle\b/g),
      ).toHaveLength(6);
    }
    // The stage is an image named by one sentence; Replay is the plate's only control.
    expect(how).toMatch(
      /data-figure-stage role="img" aria-label="Records from research papers, the community and partners are put into one format\./,
    );
    expect(how).toMatch(/data-scene-replay hidden/);
    expect(how.match(/<h3\b/g)).toHaveLength(3);
  });

  it('keeps the crew decorative, its words in a visually hidden caption', () => {
    const join = section(/<section\b[^>]*\bid="join"/);
    const crew = join.match(
      /<figure\b[^>]*data-graphic="crew"[\s\S]*?<\/figure>/,
    )![0];
    expect(crew).toContain('data-kind="mechanism"');
    expect(crew).toMatch(/role="img" aria-labelledby="crew-caption"/);
    expect(crew).toMatch(
      /<figcaption class="visually-hidden" id="crew-caption">Four people at work: a coder, a builder, an expert thinking and a data person, with an empty spot for you\.<\/figcaption>/,
    );
    for (const svg of crew.match(/<svg\b[^>]*class="crew__svg"[^>]*>/g)!)
      expect(svg).toContain('aria-hidden="true"');
    expect(crew).toMatch(/<p class="crew__label" aria-hidden="true"/);
    // The kit's astronauts: the four at work, then the newcomer who fills the spot.
    expect(crew).toContain('data-cast="A2"');
    expect(crew).toContain('data-cast="A6"');
    expect(crew).toContain('data-cast="E3"');
    expect(crew).toContain('data-cast="A4"');
    expect(crew).toMatch(/class="crew__newcomer"[\s\S]*?data-cast="A8"/);
    expect(crew).toContain('class="ghost"');
    // Three cards fill the spot on hover or focus.
    expect(join.match(/data-crew-cta/g)).toHaveLength(3);
  });

  it('imports every figure’s module only as it approaches: none is first-load JS', () => {
    const entries = [
      ...html.matchAll(/<script type="module" src="([^"]+)"/g),
    ].map(([, src]) => src);
    const inline = [
      ...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g),
    ].map(([, code]) => code);
    const code = [
      ...inline,
      ...entries.map((src) =>
        readFileSync(path.join(dist, src.replace(/^\//, '')), 'utf8'),
      ),
    ].join('\n');
    for (const chunk of ['how-it-works', 'people', 'crew', 'atlas-preview']) {
      expect(code, chunk).toMatch(
        new RegExp(`import\\([\`"']\\./${chunk}\\.[\\w-]+\\.js[\`"']\\)`),
      );
      expect(code, chunk).not.toMatch(
        new RegExp(`from\\s*["']\\./${chunk}\\.[\\w-]+\\.js["']`),
      );
      expect(html, chunk).not.toMatch(
        new RegExp(`rel="modulepreload"[^>]*${chunk}\\.`),
      );
    }
  });

  it('keeps repository part codes out of the raw HTML (text, ids, classes, labels)', () => {
    expect(main).not.toMatch(/\bP[0-5]\b/);
  });

  it('never runs a word into the inline element after it', () => {
    // copy-spacing.test checks the closing side ("</span>word"); this is the opening side, where
    // a formatter's line break can vanish.
    const glued = [
      ...main.matchAll(/\p{L}<(?:abbr|a|b|em|strong|span)\b/gu),
    ].map((match) =>
      main.slice(Math.max(0, match.index - 30), match.index + 20),
    );
    expect(glued).toEqual([]);
  });
});

describe('site chrome on Home', () => {
  it('names the header Atlas link genomeOS Atlas and describes it with its caption', () => {
    const link = html.match(/<a class="launch-atlas-cta"[^>]*>[\s\S]*?<\/a>/);
    expect(link?.[0]).toContain('href="/app/"');
    expect(link?.[0]).toContain('aria-describedby="launch-atlas-caption"');
    // Its text is its name alone, for crawlers and plain-text copies too.
    expect(
      link?.[0]
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe('genomeOS Atlas');
    expect(html).toMatch(
      /<\/a>\s*<span class="launch-atlas-cta__caption" id="launch-atlas-caption" aria-hidden="true">Explore the interactive app<\/span>/,
    );
    expect(html).toMatch(
      /<li class="mobile-nav__launch"><a href="\/app\/">\s*<span class="brand-name">genomeOS<\/span> Atlas\s*<\/a><\/li>/,
    );
    expect(visibleText).not.toContain('Launch Atlas');
  });

  it('offers keyboard bypass and an accessible repository link', () => {
    expect(html).toContain('Skip to main content');
    expect(html).toContain('aria-label="View genomeOS on GitHub"');
    expect(html).toContain('https://github.com/genomeOS/genomeOS');
    expect(visibleText).toMatch(/© \d{4} genomeOS/);
  });
});
