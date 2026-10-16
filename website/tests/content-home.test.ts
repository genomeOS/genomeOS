/**
 * Home page content (round 2 spec §4.1 copy decks, §6.1; R2-3, R2-11, rulings item 27; #454),
 * pinned from the built page. Owned by the Home task. The owner's headline is kept word for word;
 * the copy deck in final-spec-r2.md is the source of truth for everything else.
 */
import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';

const home = builtHtml('');
const main = home.slice(home.indexOf('<main'), home.indexOf('</main>'));
/** Visible text: tags stripped, entities for quotes, ampersands and no-break spaces decoded,
 * spaces collapsed. */
const text = main
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/\s+/g, ' ');

describe('home page content', () => {
  // Ruling 47: the owner's break after "science"; the space before it keeps the heading's text and
  // accessible name "Open science for the benefit of all."
  it('keeps the owner’s headline, kicker, lede and page description word for word', () => {
    expect(home).toMatch(
      /<h1[^>]*>Open science <br\s*\/?>\s*for the benefit of all\.<\/h1>/,
    );
    // Ruling 48: the owner (2026-10-15) cut the kicker above the headline as noise. The heading
    // opens the hero.
    expect(text).not.toContain('Genomics, AI and public health');
    expect(home).not.toContain('home-hero__kicker');
    expect(home).toMatch(/<div class="home-hero__text"[^>]*>\s*<h1/);
    expect(text).toContain(
      'Data, models and tools built in the open, with anyone, for everyone.',
    );
    expect(home).toContain(
      '<meta name="description" content="The genomeOS Foundation promotes open science where genomics, AI and public health meet. Anyone can help build open tools, starting with the genomeOS Atlas.">',
    );
    expect(home).toMatch(/<title>genomeOS<\/title>/);
  });

  it('says why it matters, with the one sourced number about diversity', () => {
    expect(text).toContain('Why it matters');
    expect(text).toContain('Genetic research should include everyone.');
    expect(text).toContain(
      'A genetic difference common in one community can be rare in another. Yet most people in genetic studies so far have European ancestry. We learn from humanity’s diversity, so discoveries serve everyone, including communities research has left out.',
    );
    expect(text).toContain(
      'Of every 100 participants in genome-wide studies, up to 2021',
    );
    expect(text).toContain(
      'Populations with the greatest genetic diversity are the least represented in research.',
    );
    expect(text).toMatch(
      /86 European ancestry 13 All other ancestries, or not recorded 1 African ancestry/,
    );
    // (The link's closing tag becomes a space here, before the full stop.)
    expect(text).toMatch(
      /Source: GWAS Catalog, July 2021, in Fatumo et al\., Nature Medicine, 2022 ↗ ?\. A person in several studies is counted in each\./,
    );
    // It opens in a new tab, so it carries the site's ↗ like Code ↗ (review of T2), hidden from
    // assistive tech.
    expect(main).toMatch(
      /<a href="https:\/\/doi\.org\/10\.1038\/s41591-021-01672-4" target="_blank" rel="noopener noreferrer">Fatumo et al\., Nature Medicine, 2022 <span aria-hidden="true">↗<\/span><\/a>/,
    );
  });

  it('names the three steps, in order, and what each does', () => {
    expect(text).toContain('How it works');
    expect(text).toContain('Three steps, all in the open.');
    expect(text).toMatch(
      /Gather and harmonize We collect genetic data from research papers and our community, welcome university and industry partners, and put it into one format\. AI agents that read the research are coming\.[\s\S]*Build AI models Models learn from real measurements to estimate what hasn’t been measured yet, and show how sure they are\.[\s\S]*Explore the genomeOS Atlas Anyone can see the results on a free, interactive globe\./,
    );
    for (const source of ['Research papers', 'Community', 'Partners'])
      expect(text).toContain(source);
  });

  it('says code, data and models are public, linking each with a name that holds its label', () => {
    expect(text).toContain(
      'Our code, data and models are public, so anyone can check our work and build on it.',
    );
    const links = [
      ...main.matchAll(
        /<a href="([^"]+)" aria-label="([^"]+)"[^>]*>\s*<span class="arrow-link__label">(Code|Data|Models)<\/span>/g,
      ),
    ].map(([, href, name, label]) => ({ href, name, label }));
    expect(links).toEqual([
      {
        href: 'https://github.com/genomeOS/genomeOS',
        name: 'Code on GitHub',
        label: 'Code',
      },
      {
        href: '/docs/data-and-literature/',
        name: 'Data: where it comes from, and its terms',
        label: 'Data',
      },
      {
        href: '/docs/modeling-and-validation/',
        name: 'Models: how they are tested',
        label: 'Models',
      },
    ]);
    // WCAG 2.5.3: each visible label is in its accessible name.
    for (const { name, label } of links) expect(name).toContain(label);
    // Some published data carry non-commercial terms: never "open data" or "free to use".
    expect(text).not.toMatch(/open data|free to use|everything we make/i);
  });

  it('introduces the flagship project in one section and links Projects', () => {
    expect(text).toContain('Our flagship project');
    expect(text).toContain('A growing map of human genetic variation.');
    expect(text).toContain(
      'The genomeOS Atlas shows how common genetic differences are around the world, where data are still missing, and how sure we are. Spin the preview, then explore the real thing.',
    );
    expect(main).toMatch(
      /<a class="home-link" href="\/projects\/"><span class="arrow-link__label">Read about our projects<\/span>\s*<span class="arrow-link__arrow" aria-hidden="true">→<\/span><\/a>/,
    );
  });

  it('invites anyone to join, with three ways in', () => {
    expect(text).toContain('Join us');
    expect(text).toContain('You don’t need a PhD to help.');
    expect(text).toContain(
      'We’re a hacker collective doing open-source citizen science. All skillsets and backgrounds are welcome: coding, writing, healthcare, graphic design, fundraising, business strategy, or just a strong curiosity and desire to do good for the world. We’ll find a place to fit your expertise and interests.',
    );
    expect(text).toContain('Your spot');
    const ways = [
      ...main.matchAll(
        /<a class="github-cta[^"]*" href="([^"]+)" data-crew-cta[^>]*>\s*<span>([^<]+)<\/span>\s*<strong>([^<]+)<\/strong>/g,
      ),
    ].map(([, href, lead, label]) => ({ href, lead, label }));
    expect(ways).toEqual([
      {
        href: '/contribute/',
        lead: 'Find your place',
        label: 'Start contributing',
      },
      {
        href: 'https://github.com/genomeOS/genomeOS/discussions/76',
        lead: 'Say hello',
        label: 'Introduce yourself',
      },
      {
        href: '/contact/?topic=question',
        lead: 'Ask us anything',
        label: 'Contact us',
      },
    ]);
    // Discussion #76 once on Home (spec §1.3); it opens in a new tab.
    expect(
      home.match(/github\.com\/genomeOS\/genomeOS\/discussions\/76/g),
    ).toHaveLength(1);
    expect(main).toMatch(
      /href="https:\/\/github\.com\/genomeOS\/genomeOS\/discussions\/76" data-crew-cta target="_blank" rel="noopener noreferrer"/,
    );
  });

  it('writes in US English and keeps every visible genomeOS in the wordmark', () => {
    for (const word of [
      'harmonise',
      'colour',
      'programme',
      'haemoglobin',
      'behaviour',
      'modelled',
    ])
      expect(text.toLowerCase(), word).not.toContain(word);
    // Every "genomeOS" in visible text sits in .brand-name (attributes and the wordmark excepted).
    const bare = main
      .replace(/<span class="brand-name">genomeOS<\/span>/g, '')
      .replace(/<[^>]+>/g, ' ');
    expect(bare).not.toMatch(/genomeOS/);
  });
});
