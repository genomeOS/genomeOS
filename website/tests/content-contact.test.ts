/**
 * The built Contact page (Contact page spec §2, §3, §4). Owned by the Contact page.
 *
 * - No built file anywhere in dist/ (pages, scripts, stylesheets, data) holds the address, in any
 *   encoding, and no page links to it with `mailto:`. The expected forms are built here from the
 *   address's parts at run time.
 * - The composer is rendered `hidden`, with the pre-paint script right after it to show it, and a
 *   `<noscript>` line spells the address out for a person to type.
 * - The letter's words are the draft builder's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { contactPaintScript } from '../src/components/contact/contact-paint';
import { OFFERS, SECTIONS, TOPICS } from '../src/lib/contact-draft';
import { builtHtml, dist } from './helpers/dist';

const PARTS = ['info', ['genome-os', 'org'].join('.')] as const;
const FORMS = [
  PARTS.join('@'),
  PARTS.join('%40'),
  PARTS.join('&#64;'),
  PARTS.join('&#x40;'),
  PARTS.join('&commat;'),
  PARTS.join('\\u0040'),
  PARTS.join('\\x40'),
];
const TEXT = /\.(?:html|js|mjs|css|json|xml|txt|svg|webmanifest)$/;

function textFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(target);
    return TEXT.test(entry.name) ? [target] : [];
  });
}

const html = builtHtml('contact');
const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));

describe('the built Contact page', () => {
  it('was built, with one h1', () => {
    expect(html).not.toBe('');
    expect(html.match(/<h1(?:\s|>)/g) ?? []).toHaveLength(1);
  });

  it('leaves the address out of every built file, in every encoding', () => {
    const files = textFiles(dist);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8').toLowerCase();
      return FORMS.filter((form) => text.includes(form)).map(
        (form) => `${path.relative(dist, file)}: ${form}`,
      );
    });
    expect(offenders).toEqual([]);
    for (const file of files.filter((name) => name.endsWith('.html')))
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/href="mailto:/i);
  });

  it('renders the composer hidden, shows it from the inline script, and spells the address out without JavaScript', () => {
    expect(main).toMatch(
      /<div class="contact" id="contact-composer"[^>]*hidden/,
    );
    // The pre-paint script follows the composer, so it runs before the composer first paints.
    const composerEnd = main.indexOf(
      '<script>',
      main.indexOf('id="contact-composer"'),
    );
    expect(main.slice(composerEnd)).toContain(
      contactPaintScript('contact-composer').slice(0, 80),
    );
    expect(main).toMatch(
      /<noscript>[\s\S]*info \[at\] genome-os \[dot\] org[\s\S]*<\/noscript>/,
    );
  });

  it('writes every purpose, offer and section of the letter from the draft builder', () => {
    for (const topic of TOPICS)
      expect(main).toContain(`name="contact-topic" value="${topic}"`);
    for (const offer of OFFERS)
      expect(main).toMatch(
        new RegExp(
          `<button[^>]*aria-pressed="false"[^>]*data-offer="${offer}"`,
        ),
      );
    for (const section of Object.values(SECTIONS)) {
      expect(main).toContain(section.heading);
      for (const field of section.fields)
        expect(main).toContain(field.replace(/'/g, '&#39;'));
    }
    expect(main).toContain(
      'href="https://github.com/genomeOS/genomeOS/issues/new/choose"',
    );
  });
});
