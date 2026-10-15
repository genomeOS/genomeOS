/**
 * Contribute page content (moved from content.test.ts, #454). Owned by the Contribute task.
 *
 * Contribute absorbs the Working groups page (site redesign spec §1.3, §4.3): the groups'
 * pins move here, the six-step flow and its six detail articles become one board with five steps,
 * and the decorative community image goes.
 */
import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';

const contribute = builtHtml('contribute');
const main = contribute.slice(
  contribute.indexOf('<main'),
  contribute.indexOf('</main>'),
);
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;

describe('contribute page content', () => {
  it('defines all three forming working groups and modeling breadth', () => {
    expect(contribute).toMatch(
      /Data Gathering &amp; Infrastructure[\s\S]*Statistical &amp; AI Modeling[\s\S]*UI &amp; Applications/,
    );
    expect(contribute).toContain('geometric deep learning');
    expect(contribute).toContain('Brian');
    expect(contribute).toMatch(/not been sampled evenly/i);
    expect(contribute).toMatch(/disease-burden[\s\S]*risk estimates/i);
    expect(contribute).toMatch(/agentic AI[\s\S]*own genomes/i);
    expect(contribute).toMatch(
      /Future exploration[\s\S]*privacy[\s\S]*consent[\s\S]*governance/,
    );
    expect(contribute).toContain('Three groups are forming');
  });

  it('links each group card to its unchanged skill filter', () => {
    const issues =
      'https://github.com/genomeOS/genomeOS/issues?q=is%3Aissue+is%3Aopen+label%3A%22skill%3A';
    for (const [id, skill] of [
      ['group-data', 'data-engineering'],
      ['group-modeling', 'spatial-stats'],
      ['group-ui', 'frontend'],
    ]) {
      const card = main.match(
        new RegExp(`<article[^>]*id="${id}"[\\s\\S]*?</article>`),
      )?.[0];
      expect(card, id).toBeDefined();
      expect(card).toContain(`${issues}${skill}%22`);
      expect(card).toContain('Group forming');
      expect(textOf(card!)).toContain('Browse matching issues');
    }
    expect(main.match(/Group forming/g)).toHaveLength(3);
  });

  // Design review, round 2: the lanes and the cards named the same groups two ways, in two cases,
  // and the section the Working groups links land on never said "Working groups".
  it('names its section, and names each lane as its card does', () => {
    const section = main.match(
      /<section[^>]*id="working-groups"[\s\S]*?<\/section>/,
    )![0];
    expect(section).toMatch(
      /<p class="section-kicker[^"]*">\s*Working groups\s*<\/p>\s*<h2\b[^>]*>\s*Three groups are forming\./,
    );
    const titles = Object.fromEntries(
      [
        ...section.matchAll(
          /<article[^>]*id="group-(\w+)"[\s\S]*?<\/article>/g,
        ),
      ].map(([card, lane]) => [
        lane,
        textOf(card.match(/<h3\b[\s\S]*?<\/h3>/)![0]),
      ]),
    );
    expect(Object.keys(titles)).toEqual(['data', 'modeling', 'ui']);
    const names = [
      ...section.matchAll(
        /<g class="wg-lane" data-lane="(\w+)">[\s\S]*?<text class="wg-lane__name"[^>]*>([\s\S]*?)<\/text>/g,
      ),
    ].map(([, lane, name]) => [lane, textOf(name)] as const);
    // Both layouts: the wide two-line names and the phone's one-word brackets.
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const [lane, name] of names)
      for (const word of name.split(' '))
        expect(titles[lane].split(' '), `${lane}: ${name}`).toContain(word);
  });

  it('keeps every group scope line to 25 words or fewer', () => {
    const scopes = [
      ...main.matchAll(/<p class="wg-card__scope"[^>]*>([\s\S]*?)<\/p>/g),
    ];
    expect(scopes).toHaveLength(3);
    for (const [, scope] of scopes)
      expect(textOf(scope).match(WORD)!.length).toBeLessThanOrEqual(25);
  });

  it('opens on the working groups section with the transit line inside it', () => {
    expect(main).toMatch(
      /<section[^>]*id="working-groups"[^>]*data-concept[\s\S]*?data-graphic="transit-line"/,
    );
    expect(main).toMatch(
      /<section[^>]*id="how-work-moves"[^>]*data-concept[\s\S]*?data-graphic="work-board"/,
    );
    expect(main.match(/data-concept/g)).toHaveLength(2);
    // The transit line names the model step in words and draws the guide as future work.
    expect(main).toContain('Model step');
    expect(main).toMatch(
      /class="[^"]*wg-station--future[^"]*"[^>]*data-station="guide"/,
    );
  });

  it('draws the group vignettes without words', () => {
    const vignettes = [
      ...main.matchAll(/<svg[^>]*class="wg-vig[^"]*"[\s\S]*?<\/svg>/g),
    ].map(([svg]) => svg);
    expect(vignettes).toHaveLength(3);
    for (const svg of vignettes) {
      expect(svg).toMatch(/aria-hidden="true"/);
      expect(svg).not.toMatch(/<text\b/);
    }
  });

  it('retires the community image, the old flow and its detail articles', () => {
    expect(contribute).not.toContain('contribute-community.webp');
    expect(main).not.toMatch(
      /contribution-flow|contribution-detail|page-visual/,
    );
    // Label names are set in Figtree as chips, never in code type.
    expect(main).not.toMatch(/<code\b/);
  });

  it('ends on four places to start, including the community standards issue', () => {
    const start = main.match(/<section[^>]*id="start"[\s\S]*?<\/section>/)?.[0];
    expect(start).toBeDefined();
    expect(start!.match(/class="github-cta/g)).toHaveLength(4);
    for (const href of [
      'https://github.com/genomeOS/genomeOS/discussions/76',
      'https://github.com/genomeOS/genomeOS/issues/new/choose',
      'https://github.com/orgs/genomeOS/projects/1',
      'https://github.com/genomeOS/genomeOS/issues/65',
    ])
      expect(start).toContain(`href="${href}"`);
  });

  it('sends data, expertise and funding offers to the Contact page’s draft, offer pressed', () => {
    const start = main.match(/<section[^>]*id="start"[\s\S]*?<\/section>/)?.[0];
    const offers = start!.match(/<p class="start-offers"[\s\S]*?<\/p>/)?.[0];
    expect(offers).toBeDefined();
    for (const offer of ['data', 'expertise', 'funding'])
      expect(offers).toContain(
        `href="/contact/?topic=contribute&amp;offer=${offer}"`,
      );
    expect(textOf(offers!)).toBe(
      'By email Offer data Offer expertise Offer funding',
    );
  });

  it('arms the transit line before its first paint, and only when motion is allowed', () => {
    // Spec §2.7 rule 5: the server renders the line drawn; a head script marks it armed before any
    // of it paints, and stands down at 1,200 ms if the island has not begun (design review, round 1).
    const head = contribute.slice(0, contribute.indexOf('</head>'));
    const script = head.match(
      /<script>((?:(?!<\/script>)[\s\S])*data-arm-transit(?:(?!<\/script>)[\s\S])*)<\/script>/,
    )?.[1];
    expect(script).toBeDefined();
    expect(script).toContain('prefers-reduced-motion: reduce');
    expect(script).toContain('1200');
  });

  it('marks the UI group’s future work with the status dot, not a link-like underline', () => {
    const ui = main.match(/<article[^>]*id="group-ui"[\s\S]*?<\/article>/)?.[0];
    expect(ui).toMatch(/class="wg-card__future"[^>]*data-status="future"/);
  });
});
