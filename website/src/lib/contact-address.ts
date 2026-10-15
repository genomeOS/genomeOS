/**
 * The genomeOS Foundation's email address, kept out of every served file (Contact page spec §2):
 * no page, script or stylesheet holds it whole, percent-encoded or as HTML entities, so an
 * address harvester reading the site finds nothing.
 *
 * It is stored as two runs of character codes, the part before the @ and the domain, each
 * reversed and shifted by a key. A minifier cannot fold them back into a string, and they are
 * joined only in the browser, by the island (contact.ts): the page shows the address spelled out
 * until the first sign of a person (owner, 2026-10-15), and builds each `mailto:` from it when a
 * visitor reaches for one. A harvester that runs JavaScript and acts like a person
 * can still read it; the mailbox's own spam filtering is the backstop (Contact page spec §2).
 */

const KEY = 7;
const MAILBOX = [118, 109, 117, 112] as const;
const DOMAIN = [
  110, 121, 118, 53, 122, 118, 52, 108, 116, 118, 117, 108, 110,
] as const;

const decode = (codes: readonly number[]): string =>
  String.fromCharCode(...codes.map((code) => code - KEY).reverse());

/** The stored parts, which a test checks the page's pre-paint scripts never carry. */
export const ADDRESS_PARTS = {
  key: KEY,
  mailbox: MAILBOX,
  domain: DOMAIN,
} as const;

/** The address, joined now, in the browser. */
export function contactAddress(): string {
  return [decode(MAILBOX), decode(DOMAIN)].join(String.fromCharCode(64));
}
