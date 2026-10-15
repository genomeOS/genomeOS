/**
 * The Docs light "paper" theme as built (round 2 spec §4.4, §11.1; R2-9; #454). The docs read as the
 * same site on a different surface: the site's dark header over a paper reading surface (variant
 * V1), light by default, one "Dark theme" toggle, a "Docs" kicker over guide titles and a matching
 * light code theme, "genomeOS Paper".
 *
 * - The inline provider resolves `stored === 'dark' ? 'dark' : 'light'`: the reader's stored choice,
 *   never the operating system's preference, and light when storage is blocked. The server-rendered
 *   page stays dark, so a visit with scripting off keeps today's dark docs.
 * - Expressive Code resolves to "genomeOS Paper" (the base theme) and Starlight's Night Owl for the
 *   dark choice, keyed to the reader's choice only: no `prefers-color-scheme` block.
 * - Every Paper token colour clears 5.5:1 on the code ground, and every pair in the paper palette's
 *   contrast table (docs-light.md §7) clears its floor, computed from starlight.css itself.
 * - starlight.css targets `header.header`, never a bare `.header` (which also matches Expressive
 *   Code's figcaption.header), keeps the dark palette under `[data-theme='dark']` and has no
 *   `!important`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';

const website = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(website, file), 'utf8');

const LANDING = 'docs';
const GUIDES = [
  'docs/system-overview',
  'docs/scientific-safeguards',
  'docs/data-and-literature',
  'docs/modeling-and-validation',
  'docs/issues-and-projects',
  'docs/local-development',
  'docs/deployment',
] as const;
const PAGES = [LANDING, ...GUIDES] as const;

/* ---------- WCAG 2 contrast, with alpha grounds composited as the browser paints them ---------- */

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
};
const hex = (c: Rgb) =>
  `#${c
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = (colour: string) => {
  const [r, g, b] = rgb(colour).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `fg` at `alpha` over an opaque `bg`. */
const over = (fg: string, alpha: number, bg: string) => {
  const [f, g] = [rgb(fg), rgb(bg)];
  return hex(f.map((v, i) => alpha * v + (1 - alpha) * g[i]) as Rgb);
};

/* ---------- the built pages ---------- */

const head = (html: string) => html.slice(0, html.indexOf('</head>'));

/** The theme provider every docs page inlines in its head. */
function providerScript(html: string): string {
  const scripts = [
    ...head(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
  ].map(([, body]) => body);
  const provider = scripts.filter((body) => body.includes('dataset.theme'));
  expect(provider).toHaveLength(1);
  return provider[0];
}

/** What the provider sets `data-theme` to, given what storage and the OS say. */
function themeFrom(
  script: string,
  {
    stored = null,
    blocked = false,
    os = 'light',
  }: {
    stored?: string | null;
    blocked?: boolean;
    os?: 'light' | 'dark';
  },
): string | undefined {
  const documentElement = { dataset: {} as Record<string, string> };
  const localStorage = {
    getItem(key: string) {
      if (blocked) throw new Error('SecurityError: storage is blocked');
      return key === 'starlight-theme' ? stored : null;
    },
  };
  const matchMedia = (query: string) => ({
    matches: query.includes(`prefers-color-scheme: ${os}`),
  });
  vm.runInNewContext(script, {
    document: { documentElement },
    localStorage,
    matchMedia,
    window: { localStorage, matchMedia },
  });
  return documentElement.dataset.theme;
}

describe('light by default (the theme provider)', () => {
  it.each(PAGES)(
    '/%s/ resolves stored === "dark" ? "dark" : "light", whatever the OS prefers',
    (page) => {
      const html = builtHtml(page);
      expect(html).not.toBe('');
      const script = providerScript(html);
      for (const os of ['light', 'dark'] as const) {
        expect(themeFrom(script, { os }), `nothing stored, ${os} OS`).toBe(
          'light',
        );
        expect(themeFrom(script, { stored: 'dark', os })).toBe('dark');
        expect(themeFrom(script, { stored: 'light', os })).toBe('light');
        // Starlight's encoding of its default, and its old "auto", both mean the default here.
        expect(themeFrom(script, { stored: '', os })).toBe('light');
        expect(themeFrom(script, { stored: 'auto', os })).toBe('light');
        expect(themeFrom(script, { blocked: true, os }), 'blocked').toBe(
          'light',
        );
      }
      // The old dark-only pin and Starlight's own OS-following provider are both gone.
      expect(html).not.toContain("dataset.theme = 'dark'");
      expect(html).not.toContain('StarlightThemeProvider');
    },
  );

  it.each(PAGES)(
    '/%s/ is server-rendered dark, so scripting off keeps the dark docs',
    (page) => {
      expect(builtHtml(page)).toMatch(/<html\b[^>]*\bdata-theme="dark"/);
    },
  );
});

describe('the theme control', () => {
  /** Every theme toggle on a page, with its attributes and visible text. */
  const toggles = (html: string) =>
    [
      ...html.matchAll(
        /<button\b([^>]*\bdata-docs-theme\b[^>]*)>([\s\S]*?)<\/button>/g,
      ),
    ].map(([, attributes, inner]) => ({
      attributes,
      text: inner
        .replace(/<svg[\s\S]*?<\/svg>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }));

  it.each(PAGES)(
    '/%s/ offers one "Dark theme" toggle in the header and one in the phone menu, unpressed',
    (page) => {
      const html = builtHtml(page);
      const found = toggles(html);
      expect(found).toHaveLength(2);
      for (const { attributes, text } of found) {
        expect(attributes).toMatch(/\btype="button"/);
        expect(attributes).toMatch(/\baria-pressed="false"/);
        expect(text).toBe('Dark theme');
      }
      expect(
        found.map(
          ({ attributes }) => /docs-theme--(\w+)/.exec(attributes)?.[1],
        ),
      ).toEqual(['header', 'menu']);
      // One control, not Starlight's three-way select.
      expect(html).not.toContain('starlight-theme-select');
    },
  );

  it('sits in the header between Search and the Atlas link', () => {
    const html = builtHtml(LANDING);
    const header = html.slice(
      html.indexOf('<div class="docs-header'),
      html.indexOf('</header>'),
    );
    const search = header.indexOf('<site-search');
    const toggle = header.indexOf('data-docs-theme');
    const atlas = header.indexOf('docs-header__atlas');
    expect(search).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(search);
    expect(atlas).toBeGreaterThan(toggle);
  });
});

describe('the "Docs" kicker', () => {
  const titleArea = (html: string) => {
    const h1 = html.search(/<h1\b/);
    return html.slice(Math.max(0, h1 - 200), h1 + 4);
  };

  it.each(GUIDES)('/%s/ names the part of the site above its title', (page) => {
    const html = builtHtml(page);
    expect(titleArea(html)).toMatch(
      /<p\b[^>]*class="docs-kicker"[^>]*>Docs<\/p>\s*<h1\b/,
    );
    expect(html.match(/class="docs-kicker"/g)).toHaveLength(1);
    // Search leaves it out (review of T6): a search for "docs" must not match every guide.
    expect(titleArea(html)).toMatch(
      /<p\b[^>]*class="docs-kicker"[^>]*data-pagefind-ignore[^>]*>Docs<\/p>/,
    );
  });

  it('is left off the landing, whose title already says Docs', () => {
    expect(builtHtml(LANDING)).not.toContain('docs-kicker');
  });
});

describe('the code theme, genomeOS Paper', () => {
  const theme = JSON.parse(read('src/styles/code/genomeos-paper.json')) as {
    name: string;
    type: string;
    colors: Record<string, string>;
    tokenColors: { scope?: string[]; settings: { foreground?: string } }[];
  };
  const CODE_GROUND = '#eef3f9';

  it('is a light theme named "genomeOS Paper" on the paper code ground', () => {
    expect(theme.name).toBe('genomeOS Paper');
    expect(theme.type).toBe('light');
    expect(theme.colors['editor.background']).toBe(CODE_GROUND);
  });

  it('sets every token colour at 5.5:1 or more on the code ground', () => {
    const colours = new Set([
      theme.colors['editor.foreground'],
      ...theme.tokenColors.flatMap(({ settings }) =>
        settings.foreground ? [settings.foreground] : [],
      ),
    ]);
    expect(colours.size).toBeGreaterThanOrEqual(9);
    for (const colour of colours)
      expect(
        Number(contrast(colour, CODE_GROUND).toFixed(2)),
        colour,
      ).toBeGreaterThanOrEqual(5.5);
  });

  it('resolves through Starlight to Paper, then Night Owl for the dark choice, with no prefers-color-scheme block', async () => {
    const { default: ecConfig } = await import('../ec.config.mjs');
    const { ExpressiveCode } =
      await import('@astrojs/starlight/expressive-code');
    const { getStarlightEcConfigPreprocessor } = await import(
      // Starlight's own preprocessor (not a public export): the code Starlight runs on this file.
      '../node_modules/@astrojs/starlight/dist/integrations/expressive-code/preprocessor.js'
    );
    expect(ecConfig).toMatchObject({
      useStarlightDarkModeSwitch: true,
      useStarlightUiThemeColors: true,
      useDarkModeMediaQuery: false,
    });
    type Setup = Parameters<typeof getStarlightEcConfigPreprocessor>[0];
    type Input = Parameters<
      ReturnType<typeof getStarlightEcConfigPreprocessor>
    >[0];
    // A one-locale site: the only parts of the config the preprocessor reads to resolve themes.
    const preprocess = getStarlightEcConfigPreprocessor({
      docsPath: 'src/content/docs',
      starlightConfig: {
        defaultLocale: {
          lang: 'en',
          label: 'English',
          dir: 'ltr',
          locale: undefined,
        },
        locales: undefined,
        isMultilingual: false,
      } as unknown as Setup['starlightConfig'],
      useTranslations: (() =>
        Object.assign(() => '', {
          all: () => ({}),
          exists: () => false,
        })) as unknown as Setup['useTranslations'],
    });
    const processed = await preprocess({
      ecConfig,
      astroConfig: {},
    } as unknown as Input);
    // Preprocessed, the themes are resolved theme objects, as the engine takes them.
    const engine = new ExpressiveCode(
      processed as ConstructorParameters<typeof ExpressiveCode>[0],
    );
    expect(
      engine.styleVariants.map(
        ({ theme: resolved }: { theme: { name: string; type: string } }) =>
          `${resolved.name} (${resolved.type})`,
      ),
    ).toEqual(['genomeOS Paper (light)', 'Night Owl No Italics (dark)']);
    const css = await engine.getThemeStyles();
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toContain("[data-theme='dark']");
  });

  it('is what the built code blocks carry: Paper first, Night Owl second, and no media query', () => {
    const html = builtHtml('docs/local-development');
    const spans = [
      ...html.matchAll(
        /<span style="--0:(#[0-9A-Fa-f]{6});--1:(#[0-9A-Fa-f]{6})"/g,
      ),
    ];
    expect(spans.length).toBeGreaterThan(20);
    const paper = new Set(
      theme.tokenColors
        .flatMap(({ settings }) =>
          settings.foreground ? [settings.foreground] : [],
        )
        .concat(theme.colors['editor.foreground'])
        .map((colour) => colour.toLowerCase()),
    );
    // Expressive Code kept every Paper colour as designed (none fell under its contrast floor).
    for (const [, light] of spans)
      expect(paper, light).toContain(light.toLowerCase());
    // The dark choice keeps today's Night Owl: its blue commands and amber arguments.
    const dark = new Set(spans.map(([, , night]) => night.toUpperCase()));
    expect(dark).toContain('#82AAFF');
    const sheet = html.match(
      /<link rel="stylesheet" href="\/_astro\/(ec\.[^"]+\.css)"/,
    )?.[1];
    expect(sheet).toBeTruthy();
    const ecCss = readFileSync(
      path.join(website, 'dist/_astro', sheet!),
      'utf8',
    );
    expect(ecCss).not.toContain('prefers-color-scheme');
  });
});

/* ---------- starlight.css ---------- */

const starlightCss = read('src/styles/starlight.css');
/** The stylesheet without comments, as rules: [selector list, declarations]. */
const rules = (() => {
  const source = starlightCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selector, body] of source.matchAll(pattern))
    found.push({ selector: selector.trim().replace(/\s+/g, ' '), body });
  return found;
})();

/** The custom properties a rule with exactly this selector declares. */
function tokens(selector: string): Record<string, string> {
  const rule = rules.find((candidate) => candidate.selector === selector);
  expect(rule, selector).toBeTruthy();
  return Object.fromEntries(
    [...rule!.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name, value]) => [name, value.trim()],
    ),
  );
}

describe('starlight.css', () => {
  it('targets the docs bar as header.header, never a bare .header (Expressive Code has figcaption.header)', () => {
    const source = starlightCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const bare = [...source.matchAll(/(\S*)\.header\b/g)]
      .map(([match, before]) => ({ match, before }))
      .filter(({ before }) => !before.endsWith('header'));
    expect(bare).toEqual([]);
    expect(source).toContain('header.header');
  });

  it('keeps the dark palette under [data-theme="dark"] (or the V1 header), the light under :not', () => {
    for (const { selector, body } of rules) {
      if (/--sl-color-(?:bg|black)\s*:\s*#020712/.test(body))
        expect(selector, 'the dark ground').toMatch(
          /\[data-theme='dark'\]|header\.header/,
        );
      if (/--paper\s*:/.test(body))
        expect(selector).toBe(":root:not([data-theme='dark'])");
    }
  });

  it('has no !important (the measured lane comes from --lane-measured)', () => {
    expect(starlightCss).not.toContain('!important');
  });

  it('meets its contrast table: text 4.5:1, marks 3:1 (docs-light.md §7)', () => {
    const t = tokens(":root:not([data-theme='dark'])");
    const [paper, band, code, bar, raised] = [
      t['--paper'],
      t['--paper-band'],
      t['--paper-code'],
      t['--paper-bar'],
      t['--paper-raised'],
    ];
    const [ink, soft, muted, faint] = [
      t['--ink'],
      t['--ink-soft'],
      t['--ink-muted'],
      t['--ink-faint'],
    ];
    const [ion, ionStrong, aurora, signal, danger] = [
      t['--ion-ink'],
      t['--ion-ink-strong'],
      t['--aurora-ink'],
      t['--signal-ink'],
      t['--danger-ink'],
    ];
    expect({ paper, band, code, bar, raised }).toEqual({
      paper: '#f6f9fc',
      band: '#edf2f8',
      code: '#eef3f9',
      bar: '#e2e9f2',
      raised: '#ffffff',
    });
    expect({ ink, soft, muted, faint, ion, ionStrong }).toEqual({
      ink: '#071831',
      soft: '#263850',
      muted: '#485b74',
      faint: '#5b6e87',
      ion: '#006a82',
      ionStrong: '#004e61',
    });
    const asides = { note: ion, tip: aurora, caution: signal, danger };
    const TEXT = 4.5;
    const MARK = 3;
    const pairs: [string, string, string, number][] = [
      ['headings, table head', ink, paper, TEXT],
      ['body text', soft, paper, TEXT],
      ['contents, edit and footer links', muted, paper, TEXT],
      ['links, the Docs kicker, contents current', ion, paper, TEXT],
      ['link hover', ionStrong, paper, TEXT],
      ['faint (map strokes)', faint, paper, TEXT],
      ['selected text', ink, over(ion, 0.2, paper), TEXT],
      ['inline code', ink, bar, TEXT],
      ['sidebar link', soft, band, TEXT],
      ['sidebar group label', ink, band, TEXT],
      ['sidebar link, hover', ink, over(ion, 0.06, band), TEXT],
      ['sidebar current page', ink, over(ion, 0.1, band), TEXT],
      ['phone contents bar; menu theme label', muted, band, TEXT],
      ['pager title, map labels', ink, raised, TEXT],
      ['pager label, map subtitles', muted, raised, TEXT],
      ['map caption', soft, raised, TEXT],
      ['map station label, lit', ion, '#e3f1f5', TEXT],
      ['pager and work link, hover', ink, '#f0f7fa', TEXT],
      ['search dialog text', soft, paper, TEXT],
      ['code, plain', soft, code, TEXT],
      ...Object.entries(asides).flatMap(
        ([kind, colour]): [string, string, string, number][] => [
          [`${kind} aside title`, colour, over(colour, 0.06, raised), TEXT],
          [`${kind} aside body`, soft, over(colour, 0.06, raised), TEXT],
          [`${kind} aside code`, ink, over(colour, 0.09, raised), TEXT],
          [`${kind} aside rule`, colour, paper, MARK],
        ],
      ),
      ['focus ring on paper', ion, paper, MARK],
      ['focus ring on a card', ion, raised, MARK],
      ['focus ring on the sidebar', ion, band, MARK],
      ['sidebar current rule', ion, over(ion, 0.1, band), MARK],
      ['map modeled lane', '#1c7796', raised, MARK],
      ['map measured lane', soft, raised, MARK],
      ['map stud ring', ink, '#ffffff', MARK],
      ['map gate glyph', signal, '#fbf6ea', MARK],
      ['theme toggle icon', muted, paper, MARK],
    ];
    const failures = pairs
      .map(([where, fg, bg, floor]) => ({
        where,
        fg,
        bg,
        ratio: Number(contrast(fg, bg).toFixed(2)),
        floor,
      }))
      .filter(({ ratio, floor }) => ratio < floor);
    expect(failures).toEqual([]);
  });

  it('keeps the V1 header on the site’s dark values, opaque', () => {
    const header = tokens(":root:not([data-theme='dark']) header.header");
    expect(header).toMatchObject({
      '--color-void': '#020712',
      '--color-starlight': '#f2f8ff',
      '--color-muted': '#a5b9d3',
      '--color-ion': '#70e6ff',
      '--sl-color-bg-nav': '#020712',
    });
  });
});
