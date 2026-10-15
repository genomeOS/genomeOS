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

import {
  contactDirectScript,
  contactPaintScript,
} from '../src/components/contact/contact-paint';
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
/** The address as a person reads it, before one is here to read it. */
const SPELLED = 'info [at] genome-os [dot] org';
const escape = (text: string) => text.replace(/[[\]]/g, '\\$&');

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

  it('renders Email us, the address and the composer hidden, shows them from inline scripts, and spells the address out without JavaScript', () => {
    // The address with Email us, then its script, before anything below it paints.
    expect(main).toMatch(
      /<div class="contact-direct"[^>]*data-contact-direct[^>]*hidden/,
    );
    const directEnd = main.indexOf(
      '<script>',
      main.indexOf('data-contact-direct'),
    );
    expect(main.slice(directEnd, directEnd + 200)).toContain(
      contactDirectScript().slice(0, 80),
    );
    // Email us holds no mailto: in the page as served: the island sets it when a visitor reaches.
    expect(main).toMatch(/<a [^>]*data-email-us[^>]*>/);
    expect(main.match(/<a [^>]*data-email-us[^>]*>/)![0]).not.toMatch(
      /mailto:/i,
    );
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

  // Owner, 2026-10-15: the address is spelled out until a person is here (no CAPTCHA, by the
  // controller's ruling); the island joins it then.
  it('serves the address spelled out in both its places, each holding the spelled-out box for the address to come', () => {
    const slots = [
      ...main.matchAll(/<span [^>]*data-spelled="([^"]*)"[^>]*>(.*?)<\/span>/g),
    ];
    expect(slots).toHaveLength(2);
    for (const [, spelled, inner] of slots) {
      expect(spelled).toBe(SPELLED);
      expect(inner).toMatch(
        new RegExp(`^<span [^>]*data-(?:to-)?address[^>]*>${escape(SPELLED)}$`),
      );
    }
    expect(slots.map(([, , inner]) => /data-to-address/.test(inner))).toEqual([
      false,
      true,
    ]);
  });

  // Owner, 2026-10-15 (~09:55): "remove the 'or open in Gmail · Outlook' bits. remove the border
  // around the copy icon and remove the text 'Copy'".
  it('serves no Gmail or Outlook links, and Copy as a glyph named by its label alone', () => {
    expect(main).not.toMatch(/data-webmail|or open in|mail\.google|outlook\./i);
    const copy = main.match(
      /<button [^>]*data-action="copy-address"[^>]*>([\s\S]*?)<\/button>(<span[^>]*>[^<]*<\/span>)/,
    )!;
    expect(copy[0]).toContain('aria-label="Copy email address"');
    // No word in it, so no "Copy"; "Copied" follows it, shown for a moment after a press.
    expect(copy[1].replace(/<[^>]+>/g, '').trim()).toBe('');
    expect(copy[2]).toMatch(/data-copied[^>]*>Copied<\/span>$/);
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
