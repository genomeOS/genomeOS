/**
 * The Docs landing as built (site redesign spec §4.4, §1.5, §9.2; #454): a pipeline map of the
 * guides instead of the old AI picture. Every station is a link to its guide, a bracket over all of
 * them links to the safeguards, and a row beneath links the three "work on it" guides. The map is
 * static SVG: the page ships Starlight's own scripts and nothing more. The docs are dark, with no
 * theme picker, and the two guides that mention a working group link to Contribute's groups.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { builtHtml, dist } from './helpers/dist';

const GUIDES = [
  'docs',
  'docs/system-overview',
  'docs/scientific-safeguards',
  'docs/data-and-literature',
  'docs/modeling-and-validation',
  'docs/issues-and-projects',
  'docs/local-development',
  'docs/deployment',
] as const;

const landing = builtHtml('docs');

const between = (html: string, open: string, close: string) => {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start);
  return start === -1 || end === -1
    ? ''
    : html.slice(start, end + close.length);
};
const main = between(landing, '<main', '</main>');

const decode = (html: string) =>
  html
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"');

/** Visible-ish text: tags become spaces, entities the few the build emits, whitespace collapsed. */
const text = (html: string) =>
  decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

/** The name a browser gives a link: its aria-label, or else its text as the markup runs it
 * together. A tag adds no space, so two SVG label lines with nothing between them
 * (`<tspan>Frequency</tspan><tspan>modeling</tspan>`) are named "Frequencymodeling", which a
 * voice-control user saying the words they see cannot match (WCAG 2.5.3, Label in Name). */
const accessibleName = (attributes: string, inner: string) =>
  decode(
    attributes.match(/\baria-label="([^"]*)"/)?.[1] ??
      inner.replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();

/** The one concept section: the map. */
const sections = [
  ...main.matchAll(/<section\b[^>]*\bdata-concept\b[^>]*>[\s\S]*?<\/section>/g),
].map((match) => match[0]);
const map = sections[0] ?? '';

/** Every link in the map: where it goes, its accessible name, and the words it shows (an SVG
 * station's label lines and the short line under them, "AC of AN"). */
const links = [...map.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(
  ([, attributes, inner]) => ({
    href: attributes.match(/\bhref="([^"]*)"/)?.[1] ?? '',
    name: accessibleName(attributes, inner),
    shows: text(inner),
  }),
);
/** Where the links named by a label go: the name is the label, or starts with it ("Observations
 * (AC of AN)"). The map draws each station once per layout (horizontal, stage columns, vertical)
 * and CSS shows one, so a station's links are counted once per target. */
const hrefOf = (label: string) => [
  ...new Set(
    links
      .filter(({ name }) => name === label || name.startsWith(`${label} `))
      .map((link) => link.href),
  ),
];

describe('the Docs landing', () => {
  it('is titled Docs, with one h1', () => {
    expect(landing).toContain('<title>Docs | genomeOS</title>');
    const h1s = [...landing.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
    expect(h1s.map(([, inner]) => text(inner))).toEqual(['Docs']);
    expect(landing).not.toContain('Technical overview');
  });

  it('marks Docs as the current page in the header nav', () => {
    const nav = between(landing, '<nav class="docs-header__nav', '</nav>');
    const current = [...nav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
      .filter(([, attributes]) => attributes.includes('aria-current="page"'))
      .map(([, , inner]) => text(inner));
    expect(current).toEqual(['Docs']);
  });

  it('has one concept section holding the static links map, and no picture', () => {
    expect(sections).toHaveLength(1);
    expect(map.match(/<figure\b[^>]*\bdata-graphic\b/g)).toHaveLength(1);
    expect(map).toContain('data-pipeline="links"');
    // Stations are links, not the interactive variant's buttons, and nothing travels.
    expect(map).not.toContain('role="button"');
    expect(map).not.toContain('data-packets');
    expect(landing).not.toContain('docs-system');
    expect(landing).not.toMatch(/<img\b[^>]*src="[^"]*_astro\//);
    expect(
      existsSync(
        path.resolve(import.meta.dirname, '../src/assets/docs-system.webp'),
      ),
    ).toBe(false);
    const astroAssets = path.join(dist, '_astro');
    const leftovers = existsSync(astroAssets)
      ? readdirSync(astroAssets).filter((file) => file.includes('docs-system'))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('links every station to the guide for its part', () => {
    const guide = (slug: string) => [`/docs/${slug}/`];
    expect(hrefOf('Population-location registry')).toEqual(
      guide('data-and-literature'),
    );
    expect(hrefOf('Observations')).toEqual(guide('data-and-literature'));
    expect(hrefOf('Frequency modeling')).toEqual(
      guide('modeling-and-validation'),
    );
    expect(hrefOf('Disease-burden modeling')).toEqual(
      guide('modeling-and-validation'),
    );
    expect(hrefOf('Validation gate')).toEqual(guide('scientific-safeguards'));
    expect(hrefOf('Data service')).toEqual(guide('system-overview'));
    expect(hrefOf('Interactive public map')).toEqual(guide('system-overview'));
  });

  it('names every link in the map with the words it shows (WCAG 2.5.3)', () => {
    expect(links.length).toBeGreaterThan(10);
    for (const { name, shows } of links)
      expect(
        name.replace(/[()]/g, ''),
        `the link showing "${shows}"`,
      ).toContain(shows);
  });

  it('brackets every station with the safeguards, and offers the work-on-it guides beneath', () => {
    expect(hrefOf('Scientific safeguards')).toEqual([
      '/docs/scientific-safeguards/',
    ]);
    expect(hrefOf('Issues and projects')).toEqual([
      '/docs/issues-and-projects/',
    ]);
    expect(hrefOf('Local development')).toEqual(['/docs/local-development/']);
    expect(hrefOf('Deployment')).toEqual(['/docs/deployment/']);
    expect(text(map)).toContain('Work on it');
    // One bracket only: the stage titles of Home's three-stage telling are not drawn here.
    expect(text(map)).not.toContain('Aggregate the evidence');
  });

  it('reaches the four part guides, the safeguards and the three work-on-it guides, all built', () => {
    const targets = [...new Set(links.map((link) => link.href))].sort();
    expect(targets).toEqual(
      [
        'data-and-literature',
        'deployment',
        'issues-and-projects',
        'local-development',
        'modeling-and-validation',
        'scientific-safeguards',
        'system-overview',
      ].map((slug) => `/docs/${slug}/`),
    );
    for (const href of targets)
      expect(builtHtml(href.replace(/^\/|\/$/g, '')), href).not.toBe('');
  });

  it('carries the copy deck: lede, legend, part-label note, table, sources and closing line', () => {
    const words = text(main);
    for (const line of [
      'Reference for the science and the system: what each part does, how it is checked, and how to run it.',
      'The pipeline, with a guide for each part. Safeguards apply to every part.',
      'The repository labels the six parts P0 to P5. You only need them to match an issue to its part.',
      'The system in six parts',
      'Start with the authoritative sources',
      'These guides summarize. Frozen schemas, design documents, plans and issue decisions remain authoritative.',
    ])
      expect(words).toContain(line);
    const table = between(main, '<table', '</table>');
    for (const code of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'])
      expect(text(table)).toContain(code);
    const sources = [...main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
      .filter(([, attributes]) => attributes.includes('/blob/main/'))
      .map(([, , inner]) => text(inner));
    expect(sources).toEqual([
      'Project overview',
      'Scientific and engineering objectives',
      'Atlas v1 design',
      'Repository contributor contract',
    ]);
    // The old prose is gone.
    expect(words).not.toContain('You do not need to know those labels');
    expect(words).not.toContain('Read the system overview');
  });

  it('ships no script of its own: the same scripts as a plain guide page', () => {
    const scripts = (html: string) =>
      [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(
        ([, attributes, body]) =>
          attributes.match(/\bsrc="([^"]*)"/)?.[1] ?? `inline:${body.length}`,
      );
    // A guide with no code block, so Expressive Code's copy button script is not in it either.
    expect(scripts(landing)).toEqual(
      scripts(builtHtml('docs/scientific-safeguards')),
    );
  });

  it.each(GUIDES)('/%s/ renders dark, with no theme picker', (guide) => {
    const html = builtHtml(guide);
    expect(html).not.toBe('');
    expect(html).toContain("document.documentElement.dataset.theme = 'dark'");
    expect(html).not.toContain('starlight-theme-select');
  });

  it.each([
    ['docs/data-and-literature', 'The Data '],
    ['docs/modeling-and-validation', 'The '],
  ])('%s links its working group to Contribute', (guide, before) => {
    const html = builtHtml(guide);
    expect(html).toContain(
      `${before}<a href="../../contribute/#working-groups">working group</a>`,
    );
    expect(builtHtml('contribute')).not.toBe('');
  });
});
