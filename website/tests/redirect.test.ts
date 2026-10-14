/**
 * The /working-groups/ redirect page as built (site redesign spec §1.4, §9.2; #454): a real
 * SiteLayout page that sends visitors to /contribute/#working-groups, names Contribute as
 * canonical, stays out of search results and the sitemap, and keeps the shell every page has.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { builtHtml, dist } from './helpers/dist';

const redirect = builtHtml('working-groups');
const contribute = builtHtml('contribute');
const head = redirect.slice(0, redirect.indexOf('</head>'));
const count = (html: string, pattern: RegExp) =>
  html.match(pattern)?.length ?? 0;

describe('/working-groups/ redirect page', () => {
  it('sends visitors to the working groups before first paint', () => {
    expect(head).toContain(
      '<meta http-equiv="refresh" content="0; url=/contribute/#working-groups">',
    );
    const script = head.match(
      /<script\b[^>]*\bdata-redirect\b[^>]*>([\s\S]*?)<\/script>/,
    );
    expect(script).not.toBeNull();
    expect(script![1]).toContain('location.replace("/contribute/"');
    for (const [from, to] of [
      ['#data', '#group-data'],
      ['#modeling', '#group-modeling'],
      ['#ui', '#group-ui'],
    ])
      expect(script![1]).toContain(`"${from}":"${to}"`);
    expect(script![1]).toContain("'#working-groups'");
  });

  it('names Contribute as canonical and stays out of search results', () => {
    expect(head).toContain('<meta name="robots" content="noindex">');
    expect(head).toMatch(
      /<link rel="canonical" href="https:\/\/[^"]+\/contribute\/">/,
    );
    const sitemaps = readdirSync(dist).filter((file) =>
      /^sitemap.*\.xml$/.test(file),
    );
    expect(sitemaps.length).toBeGreaterThan(0);
    for (const file of sitemaps) {
      const xml = readFileSync(path.join(dist, file), 'utf8');
      expect(xml, file).not.toContain('/working-groups/');
    }
  });

  it('keeps the shell every SiteLayout page has', () => {
    expect(head).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(count(redirect, /<h1(?:\s|>)/g)).toBe(1);
    expect(redirect).toContain('Working groups are now part of Contribute.');
    expect(redirect).toMatch(
      /<a href="\/contribute\/#working-groups">Go to the working groups<\/a>/,
    );
    // The same analytics bootstrap and cookie control as any page of this build (none without
    // PUBLIC_GA_MEASUREMENT_ID; tests/analytics.spec.ts checks the analytics build).
    expect(count(redirect, /googletagmanager\.com/g)).toBe(
      count(contribute, /googletagmanager\.com/g),
    );
    expect(count(redirect, /data-cookie-control(?:\s|>|=)/g)).toBe(
      count(contribute, /data-cookie-control(?:\s|>|=)/g),
    );
    expect(redirect).not.toContain('atlas-page');
  });
});
