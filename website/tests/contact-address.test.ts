/**
 * The Contact page's address (Contact page spec §2): stored as parts that are joined only when a
 * visitor asks for it, so no source file, served page or script holds it whole. The expected
 * address is built here from its parts, at run time, for the same reason.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { contactAddress } from '../src/lib/contact-address';

const PARTS = ['info', ['genome-os', 'org'].join('.')] as const;
const ADDRESS = PARTS.join('@');

describe('the contact address', () => {
  it('joins its parts into the foundation’s address', () => {
    expect(contactAddress()).toBe(ADDRESS);
  });

  it('is not written whole, percent-encoded or as entities in its own module', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../src/lib/contact-address.ts'),
      'utf8',
    );
    for (const form of [
      ADDRESS,
      PARTS.join('%40'),
      PARTS.join('&#64;'),
      PARTS.join('&#x40;'),
      PARTS.join('&commat;'),
      PARTS[0],
      PARTS[1],
    ])
      expect(source.toLowerCase()).not.toContain(form);
  });
});
