/**
 * The primary navigation (round 2 spec §1.1, R2-4; #454): one list for the site header, the docs
 * header and the 404. "Project" became "Projects" at /projects/; /project/ only redirects there.
 * Contact follows Docs (Contact page spec §1).
 */
import { describe, expect, it } from 'vitest';

import { PRIMARY_NAV } from '../src/data/nav';
import { builtHtml } from './helpers/dist';

describe('PRIMARY_NAV', () => {
  it('lists Projects, Contribute, Docs and Contact, in that order', () => {
    expect(PRIMARY_NAV.map(({ label, href }) => [label, href])).toEqual([
      ['Projects', '/projects/'],
      ['Contribute', '/contribute/'],
      ['Docs', '/docs/'],
      ['Contact', '/contact/'],
    ]);
  });

  it('never links the redirect page', () => {
    for (const { href } of PRIMARY_NAV) expect(href).not.toBe('/project/');
  });
});

describe('the built nav', () => {
  const navLinks = (html: string) => {
    const nav = html.match(
      /<nav\b[^>]*aria-label="Primary navigation"[^>]*>([\s\S]*?)<\/nav>/,
    );
    expect(nav).not.toBeNull();
    return [...nav![1].matchAll(/<a\b([^>]*)>/g)].map((match) => match[1]);
  };

  it('marks Projects current on /projects/ only', () => {
    const projects = navLinks(builtHtml('projects'));
    const current = projects.filter((attributes) =>
      attributes.includes('aria-current="page"'),
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/projects/"');
  });

  it('marks nothing current on the /project/ redirect page', () => {
    for (const attributes of navLinks(builtHtml('project')))
      expect(attributes).not.toContain('aria-current');
  });

  it('labels the docs sidebar group "Explore the site": Home, Atlas, Projects, Contribute, Contact', () => {
    const docs = builtHtml('docs');
    expect(docs).toContain('Explore the site');
    expect(docs).not.toContain('Explore the project');
    const group = docs.slice(
      docs.indexOf('Explore the site'),
      docs.indexOf('</ul>', docs.indexOf('Explore the site')),
    );
    expect(
      [
        ...group.matchAll(
          /<a href="([^"]+)"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g,
        ),
      ].map(([, href, label]) => [label, href]),
    ).toEqual([
      ['Home', '/'],
      ['Atlas', '/app/'],
      ['Projects', '/projects/'],
      ['Contribute', '/contribute/'],
      ['Contact', '/contact/'],
    ]);
  });
});
