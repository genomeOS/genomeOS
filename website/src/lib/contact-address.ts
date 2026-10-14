/**
 * The genomeOS Foundation's email address, kept out of every served file (Contact page spec §2):
 * no page, script or stylesheet holds it whole, percent-encoded or as HTML entities, so an
 * address harvester reading the site finds nothing.
 *
 * It is stored as two runs of character codes, the part before the @ and the domain, each
 * reversed and shifted by a key. A minifier cannot fold them back into a string, and they are
 * joined only when a visitor asks for the address (Show email address, Copy, or a draft button).
 */

const KEY = 7;
const MAILBOX = [118, 109, 117, 112] as const;
const DOMAIN = [
  110, 121, 118, 53, 122, 118, 52, 108, 116, 118, 117, 108, 110,
] as const;

const decode = (codes: readonly number[]): string =>
  String.fromCharCode(...codes.map((code) => code - KEY).reverse());

/** The address, joined now. Call it only from a visitor's action. */
export function contactAddress(): string {
  return [decode(MAILBOX), decode(DOMAIN)].join(String.fromCharCode(64));
}
