/**
 * Contribute page content, as built (round 2 spec §4.3, §11.1; #454). Owned by the Contribute
 * orbit and flow task (round 2 plan T4).
 *
 * Round 2 (owner brief, R2-5): the orbit scene opens the page, with each working group's text
 * typed below it as three columns (the old group cards); then the transit line in its own section
 * ("the flow ... should come after the orbit scene"); then How work moves (the board task's); then
 * Start here. The group pins of round 1 all survive in the columns.
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
const section = (id: string) =>
  main.match(new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`))?.[0];
const orbit = () =>
  main.match(/<figure[^>]*data-graphic="orbit"[\s\S]*?<\/figure>/)?.[0] ?? '';
const column = (id: string) =>
  main.match(new RegExp(`<article[^>]*id="${id}"[\\s\\S]*?</article>`))?.[0];
/** The typed twin's text: one span per character. */
const twinText = (html: string) =>
  [...html.matchAll(/<span style="--i:\d+"(?: class="b")?>([^<]*)<\/span>/g)]
    .map(([, ch]) => ch.replace(/&amp;/g, '&'))
    .join('');

describe('contribute page content', () => {
  it('defines all three forming working groups and modeling breadth', () => {
    expect(contribute).toMatch(
      /Data &amp; Infrastructure[\s\S]*Statistical &amp; AI Modeling[\s\S]*UI &amp; Applications/,
    );
    expect(contribute).toContain('geometric deep learning');
    expect(contribute).toContain('Bayesian spatial models');
    // The owner (2026-10-16): no one knows the lead by name, so the group names its methods.
    expect(contribute).not.toContain('Brian');
    expect(contribute).toMatch(/not been sampled evenly/i);
    expect(contribute).toMatch(/disease-burden[\s\S]*risk estimates/i);
    expect(contribute).toMatch(/agentic AI[\s\S]*own genomes/i);
    expect(contribute).toMatch(
      /Future exploration[\s\S]*privacy[\s\S]*consent[\s\S]*governance/,
    );
    expect(contribute).toContain('Three groups are forming');
  });

  // Design critique of the integrated build: the product's name is capitalized as on every other
  // page, and the page's sentence-style headings end with a period (rulings, item 27).
  it('names the Atlas with a capital and ends its headings with a period', () => {
    expect(contribute).toContain(
      'Literature, statistics, engineering, design, clinical and community knowledge all move the Atlas. Every contribution starts with a conversation.',
    );
    const headings = [
      ...main.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/g),
    ].map(([, inner]) =>
      inner
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    expect(headings).toEqual([
      'Find work that fits how you think.',
      'Three groups are forming.',
      'How the groups fit together.',
      'How work moves.',
      'Start here.',
    ]);
  });

  it('opens on the orbit, then the flow, then how work moves, then the start links', () => {
    const order = [...main.matchAll(/<section[^>]*\bid="([\w-]+)"[^>]*>/g)].map(
      ([, id]) => id,
    );
    expect(order).toEqual([
      'working-groups',
      'flow',
      'how-work-moves',
      'start',
    ]);
    // Three concepts, each one figure: the orbit, the transit line, the work board.
    expect(main.match(/data-concept/g)).toHaveLength(3);
    expect(section('working-groups')).toMatch(
      /<section[^>]*data-concept[\s\S]*data-graphic="orbit"/,
    );
    expect(section('flow')).toMatch(
      /<section[^>]*data-concept[\s\S]*data-graphic="transit-line"/,
    );
    expect(section('how-work-moves')).toMatch(
      /<section[^>]*data-concept[\s\S]*data-graphic="work-board"/,
    );
    expect(section('start')).not.toContain('data-concept');
    // The orbit is the page's first figure.
    expect(main.match(/<figure[^>]*data-graphic="([\w-]+)"/)?.[1]).toBe(
      'orbit',
    );
  });

  it('names the working groups section, captions the orbit and gives it its controls', () => {
    expect(section('working-groups')).toMatch(
      /<p class="section-kicker[^"]*">\s*Working groups\s*<\/p>\s*<h2\b[^>]*id="working-groups-title"[^>]*>\s*Three groups are forming\./,
    );
    const figure = orbit();
    const open = figure.match(/<figure[^>]*>/)![0];
    expect(open).toContain('data-kind="mechanism"');
    expect(open).toContain('role="group"');
    expect(open).toContain('aria-labelledby="working-groups-title"');
    expect(open).toContain('data-motion-exception="orbit"');
    const describedby = open.match(/aria-describedby="([\w-]+)"/)?.[1];
    expect(describedby).toBeDefined();
    expect(
      textOf(
        figure.match(
          new RegExp(`<p[^>]*id="${describedby}"[\\s\\S]*?</p>`),
        )![0],
      ),
    ).toBe('Examples, not requirements: curiosity counts.');
    // The caption line and the controls share the plate's top bar, the figure's figcaption.
    expect(figure).toMatch(
      /<figcaption[^>]*data-figure-chrome[\s\S]*Examples, not requirements[\s\S]*data-scene-toggle[\s\S]*data-scene-replay[\s\S]*<\/figcaption>/,
    );
    expect(textOf(figure)).toContain('Pause the orbit animation');
    expect(textOf(figure)).toContain('Replay the orbit animation');
  });

  it('names the stage with the scene in one sentence and draws it three ways, hidden from assistive tech', () => {
    const figure = orbit();
    const stage = figure.match(/<div[^>]*data-figure-stage[^>]*>/)![0];
    expect(stage).toContain('role="img"');
    expect(stage).toMatch(
      /aria-label="Three moons orbit the genomeOS globe, one per working group; crews land and get to work: mining data, measuring soil and charting, building and painting a screen\."/,
    );
    const svgs = [
      ...figure.matchAll(/<svg[^>]*class="orbit-svg[^"]*"[^>]*>/g),
    ].map(([svg]) => svg);
    expect(svgs.map((svg) => svg.match(/data-layout="(\w+)"/)![1])).toEqual([
      'desktop',
      'tablet',
      'phone',
    ]);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
  });

  it('server-renders the story’s last frame: every crew on its moon, the pods gone', () => {
    for (const layout of ['desktop', 'tablet', 'phone']) {
      const svg = orbit().match(
        new RegExp(
          `<svg[^>]*data-layout="${layout}"[\\s\\S]*?</svg>(?=\\s*(?:<svg[^>]*class="orbit-svg|</div>))`,
        ),
      )![0];
      const moonOf = (kind: string) =>
        svg.match(
          new RegExp(
            `<g class="orbiter orbiter--moon" data-moon="${kind}"[\\s\\S]*?(?=<g class="orbiter orbiter--moon"|$)`,
          ),
        )![0];
      for (const [kind, crew] of [
        ['data', ['A1', 'A6']],
        ['model', ['A5']],
        ['ui', ['A4', 'A2', 'A3']],
      ] as const) {
        const markup = moonOf(kind);
        for (const id of crew)
          expect(markup, `${layout} ${kind} ${id}`).toContain(`crew-${id}`);
        expect(markup).toMatch(/<g class="ship-g" opacity="0">/);
      }
      // One label per moon (drawn over the globe, under the moons).
      expect(svg.match(/class="moon-label"/g)).toHaveLength(3);
    }
  });

  it('labels the moons with the groups’ names, short on phones', () => {
    const labels = (layout: string) =>
      [
        ...orbit()
          .match(
            new RegExp(`<svg[^>]*data-layout="${layout}"[\\s\\S]*?</svg>`),
          )![0]
          .matchAll(/<text class="moon-label"[^>]*>([^<]*)<\/text>/g),
      ].map(([, text]) => text.replace(/&amp;/g, '&'));
    for (const layout of ['desktop', 'tablet'])
      expect(labels(layout)).toEqual([
        'Data & Infrastructure',
        'Statistical & AI Modeling',
        'UI & Applications',
      ]);
    expect(labels('phone')).toEqual(['Data', 'Modeling', 'UI']);
  });

  it('gives each group a column: title, Group forming, typed text, examples and its issues', () => {
    // A group's open issues are those of its type or its skill: GitHub reads comma-separated labels
    // as "any of" (owner, 2026-10-15). Its moon opens the same URL (contribute.astro).
    const issues =
      'https://github.com/genomeOS/genomeOS/issues?q=is%3Aissue+is%3Aopen+label%3A';
    for (const [id, labels, query, title] of [
      [
        'group-data',
        '%22type%3Adata%22%2C%22type%3Ainfra%22%2C%22skill%3Adata-engineering%22',
        'is:issue is:open label:"type:data","type:infra","skill:data-engineering"',
        'Data & Infrastructure',
      ],
      [
        'group-modeling',
        '%22type%3Ascience%22%2C%22skill%3Aspatial-stats%22',
        'is:issue is:open label:"type:science","skill:spatial-stats"',
        'Statistical & AI Modeling',
      ],
      [
        'group-ui',
        '%22type%3Aui%22%2C%22skill%3Afrontend%22',
        'is:issue is:open label:"type:ui","skill:frontend"',
        'UI & Applications',
      ],
    ]) {
      const card = column(id);
      expect(card, id).toBeDefined();
      expect(textOf(card!.match(/<h3\b[\s\S]*?<\/h3>/)![0])).toBe(title);
      expect(card).toContain(`href="${issues}${labels}"`);
      const href = card!.match(/class="orbit-col__link" href="([^"]+)"/)![1];
      expect(
        decodeURIComponent(new URL(href).search.slice(3).replace(/\+/g, ' ')),
      ).toBe(query);
      expect(card).toMatch(/target="_blank" rel="noopener noreferrer"/);
      expect(card).toContain('Group forming');
      expect(textOf(card!)).toContain('Browse matching issues');
    }
    expect(main.match(/Group forming/g)).toHaveLength(3);
    expect(main.match(/Browse matching issues/g)).toHaveLength(3);
  });

  it('calls each group by one name: its moon, its column and its lane on the line', () => {
    // Design critique of the integrated build, round 2: the Data column said "Data Gathering &
    // Infrastructure" under a moon and a lane that say "Data & Infrastructure".
    const moons = [
      ...orbit()
        .match(/<svg[^>]*data-layout="desktop"[\s\S]*?<\/svg>/)![0]
        .matchAll(/<text class="moon-label"[^>]*>([^<]*)<\/text>/g),
    ].map(([, text]) => text.replace(/&amp;/g, '&'));
    const titles = ['group-data', 'group-modeling', 'group-ui'].map((id) =>
      textOf(column(id)!.match(/<h3\b[\s\S]*?<\/h3>/)![0]),
    );
    // The lane buttons, once per drawing (wide and phone): each drawing names the same lanes.
    const lanes = [
      ...new Set(
        [
          ...section('flow')!.matchAll(
            /<button[^>]*data-lane-button="[^"]*"[^>]*><span class="visually-hidden">([^<]*)<\/span>/g,
          ),
        ].map(([, text]) => text.replace(/&amp;/g, '&')),
      ),
    ];
    expect(titles).toEqual([
      'Data & Infrastructure',
      'Statistical & AI Modeling',
      'UI & Applications',
    ]);
    expect(moons).toEqual(titles);
    expect(lanes).toEqual(titles);
  });

  it('types every sentence over a real, visually hidden copy of it', () => {
    for (const id of ['group-data', 'group-modeling', 'group-ui']) {
      const card = column(id)!;
      const typed = [
        ...card.matchAll(
          /<span class="visually-hidden">([^<]*)<\/span><span class="typed" aria-hidden="true">([\s\S]*?)<\/span><\/p>/g,
        ),
      ];
      expect(typed, id).toHaveLength(2);
      for (const [, sentence, twin] of typed)
        expect(twinText(twin)).toBe(sentence.replace(/&amp;/g, '&'));
      const [, what] = typed[0];
      const [, who, whoTwin] = typed[1];
      expect(what.match(WORD)!.length).toBeLessThanOrEqual(25);
      // Examples, not requirements: the line opens with a bold "For example:".
      expect(who).toMatch(/^For example: /);
      expect(whoTwin.match(/class="b"/g)).toHaveLength('For example:'.length);
    }
  });

  it('adds a phone close-up of each moon above its text, from the one scene', () => {
    for (const id of ['group-data', 'group-modeling', 'group-ui'])
      expect(column(id)).toMatch(
        /<svg class="orbit-col__shot"[^>]*aria-hidden="true"[^>]*><use href="#orbit-phone-moons"><\/use><\/svg>/,
      );
  });

  it('gives the flow its own section after the orbit, with its heading and legend', () => {
    const flow = section('flow')!;
    expect(flow).toMatch(
      /<h2\b[^>]*id="flow-title"[^>]*>\s*How the groups fit together\.\s*<\/h2>/,
    );
    expect(flow).toMatch(/aria-labelledby="flow-title"/);
    expect(textOf(flow.match(/<figcaption\b[\s\S]*?<\/figcaption>/)![0])).toBe(
      'One line carries evidence to the map. Each group owns a stretch of it.',
    );
    // The transit line names the model step in words and draws the guide as future work.
    expect(flow).toContain('Model step');
    expect(flow).toMatch(
      /class="[^"]*wg-station--future[^"]*"[^>]*data-station="guide"/,
    );
  });

  it('names each lane as the column of the group that owns it', () => {
    const titles = Object.fromEntries(
      [
        ['data', 'group-data'],
        ['modeling', 'group-modeling'],
        ['ui', 'group-ui'],
      ].map(([lane, id]) => [
        lane,
        textOf(column(id)!.match(/<h3\b[\s\S]*?<\/h3>/)![0]),
      ]),
    );
    const names = [
      ...section('flow')!.matchAll(
        /<g class="wg-lane" data-lane="(\w+)">[\s\S]*?<text class="wg-lane__name"[^>]*>([\s\S]*?)<\/text>/g,
      ),
    ].map(([, lane, name]) => [lane, textOf(name)] as const);
    // Both layouts: the wide two-line names and the phone's one-word brackets.
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const [lane, name] of names)
      for (const word of name.split(' '))
        expect(titles[lane].split(' '), `${lane}: ${name}`).toContain(word);
  });

  it('retires the group cards, their vignettes, the community image and the old flow', () => {
    expect(main).not.toMatch(/wg-card|wg-vig|group-vignettes|data-wg-card/);
    expect(contribute).not.toContain('contribute-community.webp');
    expect(main).not.toMatch(
      /contribution-flow|contribution-detail|page-visual/,
    );
    // Label names are set in Figtree, never in code type.
    expect(main).not.toMatch(/<code\b/);
    // "Groups are an invitation, not a boundary." went for the word budget (spec §0.4 item 5).
    expect(main).not.toContain('invitation, not a boundary');
  });

  it('ends on four places to start, including the community standards issue', () => {
    const start = section('start');
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
    const offers = section('start')!.match(
      /<p class="start-offers"[\s\S]*?<\/p>/,
    )?.[0];
    expect(offers).toBeDefined();
    for (const offer of ['data', 'expertise', 'funding'])
      expect(offers).toContain(
        `href="/contact/?topic=contribute&amp;offer=${offer}"`,
      );
    expect(textOf(offers!)).toBe(
      'By email Offer data Offer expertise Offer funding',
    );
  });

  it('arms the orbit before its first paint, and only when motion is allowed', () => {
    // Spec §2.7 rule 5 (round 2 §4.3.2): the server renders the story's last frame; a head script
    // marks the orbit armed (its 0 ms state) before any of it paints, and stands down at 1,200 ms
    // if the scene has not begun loading. The transit line is no longer above the fold.
    const head = contribute.slice(0, contribute.indexOf('</head>'));
    const script = head.match(
      /<script>((?:(?!<\/script>)[\s\S])*data-arm-orbit(?:(?!<\/script>)[\s\S])*)<\/script>/,
    )?.[1];
    expect(script).toBeDefined();
    expect(script).toContain('prefers-reduced-motion: reduce');
    expect(script).toContain('1200');
    expect(contribute).not.toContain('data-arm-transit');
  });
});
