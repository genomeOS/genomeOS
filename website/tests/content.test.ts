import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { atlasCatalogSchema } from '../src/atlas/contracts';
import { preloadScriptSource } from '../src/atlas/preload-script';

const dist = path.resolve(import.meta.dirname, '../dist');
// Only the inline catalog element; its assumptions deliberately mention the P0 registry.
const INLINE_CATALOG =
  /<script\b[^>]*\bid="atlas-catalog"[^>]*>([\s\S]*?)<\/script>/;

function page(route: string): string {
  const filename = path.join(dist, route, 'index.html');
  return existsSync(filename) ? readFileSync(filename, 'utf8') : '';
}

const home = page('');
const project = page('projects');
// The redirect to Projects (R2-4): one h1, like every page.
const projectRedirect = page('project');
// The redirect to Contribute's working groups (#454): one h1, like every page.
const groups = page('working-groups');
const contribute = page('contribute');
const preview = page('app');

describe('public site content', () => {
  it.each([
    ['home', home],
    ['projects', project],
    ['project redirect', projectRedirect],
    ['working groups', groups],
    ['contribute', contribute],
    ['preview', preview],
  ])('renders one primary heading on the %s page', (_name, html) => {
    expect(html.match(/<h1(?:\s|>)/g) ?? []).toHaveLength(1);
  });

  it('renders the native globe explorer instead of the diagnostic iframe', () => {
    expect(preview).toContain('AtlasExplorer');
    expect(preview).not.toContain('<iframe');
    expect(preview).not.toContain(
      'https://genomeos-api-357876699511.us-east1.run.app/preview',
    );
    expect(preview.replace(INLINE_CATALOG, '')).not.toMatch(/\bP[0-9]+\b/);
    expect(preview).toContain('Explore human genetic variation');
  });

  it('inlines the validated public catalog without markup characters', () => {
    const match = preview.match(INLINE_CATALOG);
    expect(match).not.toBeNull();
    const text = match![1];
    expect(text).not.toContain('<');
    const inline = JSON.parse(text) as unknown;
    expect(() => atlasCatalogSchema.parse(inline)).not.toThrow();
    expect(inline).toEqual(
      JSON.parse(
        readFileSync(
          path.resolve(
            import.meta.dirname,
            '../public/data/atlas/catalog.json',
          ),
          'utf8',
        ),
      ),
    );
    expect(preview.slice(0, preview.indexOf('</head>'))).toMatch(
      INLINE_CATALOG,
    );
  });

  it('does not expose unexplained internal project codes on introduction pages', () => {
    expect(home).not.toMatch(/\bP[0-9]+\b/);
    expect(project).not.toMatch(/\bP[0-9]+\b/);
  });

  it('preloads the selected artifact from an inline head script after the catalog', () => {
    const head = preview.slice(0, preview.indexOf('</head>'));
    const catalogAt = head.search(INLINE_CATALOG);
    const scriptAt = head.indexOf(preloadScriptSource());
    expect(catalogAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeGreaterThan(catalogAt);
    expect(head).not.toContain('rel="preconnect"');
  });
});
