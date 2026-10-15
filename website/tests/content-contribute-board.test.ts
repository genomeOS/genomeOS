/**
 * Contribute's "How work moves" content (round 2 spec §4.3.4, §8, §11.1; R2-8; #454), read from
 * the built page: GitHub's board in its dark UI with five columns (Discussion · Backlog · In
 * progress · In review · Merge), Ready folded into Backlog, Blocked renamed Merge, real pinned cards,
 * one plainly labelled example card, the astronaut story's storyboard as the picture without
 * motion, and the story in words for assistive tech. Owned by the board task (round 2 plan T5).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { storyboardOneLine } from '../src/components/contribute/board-layout';
import { builtHtml } from './helpers/dist';

const contribute = builtHtml('contribute');
const main = contribute.slice(
  contribute.indexOf('<main'),
  contribute.indexOf('</main>'),
);
const section =
  main.match(/<section[^>]*id="how-work-moves"[\s\S]*?(?=<section\b|$)/)?.[0] ??
  '';
const textOf = (html: string) =>
  html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
/** The markup of the first element with `class` containing `name`, through its closing tag. */
const block = (html: string, pattern: RegExp) => html.match(pattern)?.[0] ?? '';

describe('how work moves', () => {
  it('opens with its heading and the one-line legend', () => {
    expect(section).not.toBe('');
    expect(section).toMatch(
      /<h2[^>]*id="how-work-moves-title"[^>]*>How work moves</,
    );
    expect(textOf(section)).toContain('One issue, from hello to merge.');
    expect(textOf(section)).not.toContain('Experts review every change');
  });

  it('is one mechanism figure, a named motion exception, labelled by the heading', () => {
    const figures = section.match(/<figure\b[^>]*>/g) ?? [];
    expect(figures).toHaveLength(1);
    expect(figures[0]).toContain('data-graphic="work-board"');
    expect(figures[0]).toContain('data-kind="mechanism"');
    expect(figures[0]).toContain('data-motion-exception="board"');
    expect(section).toMatch(
      /data-figure-stage[^>]*role="group"[^>]*aria-labelledby="how-work-moves-title"|role="group"[^>]*aria-labelledby="how-work-moves-title"[^>]*data-figure-stage/,
    );
  });

  it('draws GitHub’s board: its real title, the Board tab and five columns with their lines', () => {
    const text = textOf(section);
    expect(text).toContain('Genome OS Atlas');
    expect(text).toMatch(/\bBoard\b/);
    const names = [
      ...section.matchAll(/class="gh-col__name"[^>]*>([^<]+)</g),
    ].map((match) => match[1].trim());
    expect(names).toEqual([
      'Discussion',
      'Backlog',
      'In progress',
      'In review',
      'Merge',
    ]);
    const lines = [
      ...section.matchAll(/class="gh-col__line"[^>]*>([^<]+)</g),
    ].map((match) => match[1].trim());
    expect(lines).toEqual([
      'Say hello',
      'Pick a Ready one',
      'Build it',
      'Experts check',
      'Joins the Atlas',
    ]);
  });

  it('keeps the workflow’s pinned words: Discussion #76, Ready, expert review, Merge; no Blocked', () => {
    const text = textOf(section);
    expect(text).toContain('Discussion #76');
    expect(text).toContain('Pick a Ready one');
    expect(text).toContain('wants-expert-review');
    expect(text).toContain('Merge');
    expect(textOf(main)).not.toMatch(/\bBlocked\b/);
    // Round 1's tour is gone: no step tabs, no panels.
    expect(section).not.toContain('role="tablist"');
    expect(text).not.toContain('Read the record');
  });

  it('labels the moving card plainly as an example, resting in Merge as merged', () => {
    const home = block(
      section,
      /<article[^>]*data-example="home"[\s\S]*?<\/article>/,
    );
    expect(home).toContain('aria-hidden="true"');
    expect(textOf(home)).toMatch(
      /^Example issue Add allele counts from a new study type:data skill:popgen .*Merged$/,
    );
    // The merge column holds it; every other copy only reserves the space.
    const merge = block(
      section,
      /<div[^>]*data-col="merge"[\s\S]*?(?=<div[^>]*data-col=|<div class="gh-floor")/,
    );
    expect(merge).toContain('data-example="home"');
    const holders = section.match(/data-example="slot"/g) ?? [];
    expect(holders).toHaveLength(3);
  });

  it('keeps the count pills out of the accessibility tree: the cards and the story say it', () => {
    const pills = section.match(/<span[^>]*class="gh-count"[^>]*>/g) ?? [];
    expect(pills).toHaveLength(5);
    for (const pill of pills) expect(pill).toContain('aria-hidden="true"');
  });

  it('wraps every visible genomeOS in the brand name', () => {
    const bare = textOf(
      section.replace(/<span class="brand-name">genomeOS<\/span>/g, ''),
    );
    expect(bare).not.toMatch(/genomeOS/);
    expect(section.match(/class="brand-name">genomeOS</g)?.length).toBe(4);
  });

  it('draws the storyboard without motion, decorative, with its two resting bubbles', () => {
    // The floor holds the storyboard alone (its nested SVGs close before it does).
    const svg = block(
      section,
      /<svg[^>]*class="floor-svg floor-svg--sb"[\s\S]*?<\/svg>(?=<\/div>)/,
    );
    expect(svg).toMatch(/^<svg[^>]*aria-hidden="true"/);
    const said = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) =>
      textOf(m[1]),
    );
    expect(said).toEqual(['Hi! I’d like to help.', 'Approved!']);
    // One beat per column: the contributor in every column, the experts in review and at the wall.
    expect(svg.match(/data-cast="A3"/g)).toHaveLength(5);
    expect(svg.match(/data-cast="E1"/g)).toHaveLength(2);
    expect(svg.match(/data-cast="E2"/g)).toHaveLength(2);
    // Its ids are its own, so no other scene's definitions can shadow them.
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids) expect(id).toMatch(/^wb-/);
  });

  it('tells the whole story in words, the dialogue verbatim', () => {
    const twin = block(
      section,
      /<ol class="visually-hidden wb-story"[\s\S]*?<\/ol>/,
    );
    expect(twin.match(/<li\b/g)).toHaveLength(5);
    const text = textOf(twin);
    for (const line of [
      'Hi! I’d like to help.',
      'Welcome aboard!',
      'Try the Backlog!',
      'Where are the counts from?',
      'Table 2, linked in the PR.',
      'Checks pass. Nice work!',
      'Approved!',
    ])
      expect(text).toContain(`“${line}”`);
    expect(text).toMatch(
      /^Discussion: [\s\S]*Backlog: [\s\S]*In progress: [\s\S]*In review: [\s\S]*Merge: /,
    );
  });

  it('offers Pause and Replay, hidden until the scene takes over', () => {
    expect(section).toMatch(
      /<button[^>]*data-scene-toggle[^>]*hidden[\s\S]*?Pause the board animation/,
    );
    expect(section).toMatch(
      /<button[^>]*data-scene-replay[^>]*hidden[\s\S]*?Replay the board animation/,
    );
    // The phone camera's column buttons: one per column, one pressed, hidden without script.
    const nav = block(section, /<div[^>]*class="wb-colnav"[\s\S]*?<\/div>/);
    expect(nav).toMatch(/role="group"[^>]*aria-label="Board columns"/);
    expect(nav).toMatch(/\shidden(?:=|\s|>)/);
    expect(nav.match(/<button\b/g)).toHaveLength(5);
    expect(nav.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('wraps the storyboard’s hello onto two lines exactly where one line would leave Discussion', () => {
    const css = readFileSync(
      new URL(
        '../src/components/contribute/how-work-moves.css',
        import.meta.url,
      ),
      'utf8',
    );
    expect(css).toContain(
      `@container wb-track (width < ${storyboardOneLine()}px)`,
    );
    // Both forms are drawn; the stylesheet shows one.
    const storyboard = block(
      section,
      /<svg[^>]*floor-svg--sb[\s\S]*?<\/svg>\s*<\/div>/,
    );
    expect(storyboard).toMatch(/class="sb-one"[\s\S]*Hi! I’d like to help\./);
    expect(storyboard).toMatch(
      /class="sb-two"[\s\S]*<tspan[^>]*>Hi! I’d like<\/tspan> <tspan[^>]*>to help\.<\/tspan>/,
    );
  });

  it('ends with the milestone rail and the workflow in Docs', () => {
    const text = textOf(section);
    expect(text).toMatch(
      /Milestones are release boundaries\. Data foundation Reproduce HbS Usable map Safe public launch/,
    );
    expect(section).toMatch(
      /<a href="[^"]*\/docs\/issues-and-projects\/"[^>]*>The full workflow in Docs/,
    );
  });

  // Round 2 spec §4.3.5: the panels' extra pins live in Docs now.
  it('leaves the details of the workflow to Docs', () => {
    const docs = builtHtml('docs/issues-and-projects');
    expect(docs).toContain('mention the original issue author');
    expect(docs).toContain('needs-human-decision');
    expect(textOf(section)).not.toContain('needs-human-decision');
  });
});
