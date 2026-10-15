/**
 * The Contact page's pre-paint scripts (Contact page spec §2, §3.1, §4). The address with Email us
 * and the template composer are rendered `hidden`, so a visitor without JavaScript sees only the
 * `<noscript>` address. Two scripts, a few lines each, inlined right after each part, show them
 * before the first paint:
 *
 * - `contactDirectScript`, after the address and Email us: joins the address from its stored parts
 *   (contact-address.ts) and writes it into the page, so it is in view from the first paint and
 *   nothing moves when the island arrives. No `mailto:` is written here: the island sets Email us's
 *   when a visitor reaches for it.
 * - `contactPaintScript`, after the composer: shows it, writes the address into the letter's To,
 *   and applies a `?topic=…&offer=…` preselect at the same moment, so a link from Contribute never
 *   paints the default letter and then grows (a module script runs too late for that).
 *
 * It repeats `parseQuery`'s rule in plain ES5, with the purposes and offers from contact-draft.ts,
 * and carries the offer wording for every set of offers as a table built here from `letterList`
 * and `subjectSuffix`, so it writes no grammar of its own. `tests/contact-paint.test.ts` runs it
 * against `parseQuery` for every case, so the two cannot drift. The island (contact.ts) then
 * takes over from the same state, and marks the composer `data-ready`.
 *
 * If the island never runs (a chunk that failed to load, a browser without modules), Email us,
 * the copy button and the composer's buttons would be inert. Module scripts run before `load`, so
 * a page still not ready then goes back to the no-JavaScript page: both parts hidden, the joined
 * address taken out again, and the address spelled out in their place (`[data-contact-fallback]`).
 */
import { ADDRESS_PARTS } from '../../lib/contact-address';
import {
  OFFERS,
  TOPICS,
  letterList,
  subjectSuffix,
  type Offer,
} from '../../lib/contact-draft';

/** The radio group's name, shared by the markup, this script and the island. */
export const TOPIC_INPUT = 'contact-topic';

/** Every set of offers, keyed by its space-separated canonical list: [opening list, subject suffix]. */
export function offerWording(): Record<string, [string, string]> {
  const table: Record<string, [string, string]> = {};
  for (let mask = 0; mask < 1 << OFFERS.length; mask += 1) {
    const offers: Offer[] = OFFERS.filter((_, index) => mask & (1 << index));
    table[offers.join(' ')] = [letterList(offers), subjectSuffix(offers)];
  }
  return table;
}

/** ES5 that sets `address` from the stored parts, joined as `contactAddress` joins them. */
function joinAddress(): string {
  const json = JSON.stringify;
  const { key, mailbox, domain } = ADDRESS_PARTS;
  return `var address = [${json(mailbox)}, ${json(domain)}]
      .map(function (codes) {
        return String.fromCharCode.apply(
          null,
          codes
            .map(function (code) {
              return code - ${key};
            })
            .reverse()
        );
      })
      .join(String.fromCharCode(64));`;
}

/** Shows the address with Email us, the address written in, before the first paint. */
export function contactDirectScript(): string {
  return `(function () {
  var direct = document.querySelector('[data-contact-direct]');
  if (!direct) return;
  try {
    ${joinAddress()}
    var places = document.querySelectorAll('[data-address]');
    for (var i = 0; i < places.length; i += 1) places[i].textContent = address;
    direct.hidden = false;
  } catch (error) {}
})();`;
}

export function contactPaintScript(rootId: string): string {
  const json = JSON.stringify;
  return `(function () {
  var root = document.getElementById(${json(rootId)});
  if (!root) return;
  root.hidden = false;
  try {
    ${joinAddress()}
    var to = document.querySelectorAll('[data-to-address]');
    for (var j = 0; j < to.length; j += 1) to[j].textContent = address;
    root.setAttribute('data-revealed', '');
  } catch (error) {}
  try {
    var topics = ${json(TOPICS)};
    var offers = ${json(OFFERS)};
    var wording = ${json(offerWording())};
    var query = new URLSearchParams(location.search);
    var topic = (query.get('topic') || '').trim().toLowerCase();
    if (topics.indexOf(topic) < 0) topic = 'contribute';
    var wanted = Object.create(null);
    if (topic === 'contribute')
      query.getAll('offer').forEach(function (value) {
        value.split(',').forEach(function (offer) {
          wanted[offer.trim().toLowerCase()] = true;
        });
      });
    var picked = offers.filter(function (offer) {
      return wanted[offer] === true;
    });
    var key = picked.join(' ');
    root.setAttribute('data-topic', topic);
    root.setAttribute('data-offers', key);
    var radio = root.querySelector('input[name=${json(TOPIC_INPUT)}][value="' + topic + '"]');
    if (radio) radio.checked = true;
    var toggles = root.querySelectorAll('[data-offer]');
    for (var i = 0; i < toggles.length; i += 1)
      toggles[i].setAttribute(
        'aria-pressed',
        String(picked.indexOf(toggles[i].getAttribute('data-offer')) >= 0)
      );
    var list = root.querySelector('[data-offer-list]');
    if (list) list.textContent = wording[key][0];
    var suffix = root.querySelector('[data-offer-subject]');
    if (suffix) suffix.textContent = wording[key][1];
  } catch (error) {}
  window.addEventListener('load', function () {
    if (root.hasAttribute('data-ready')) return;
    root.hidden = true;
    root.removeAttribute('data-revealed');
    var direct = document.querySelector('[data-contact-direct]');
    if (direct) direct.hidden = true;
    var written = document.querySelectorAll('[data-address], [data-to-address]');
    for (var k = 0; k < written.length; k += 1) written[k].textContent = '';
    var line = document.querySelector('[data-contact-fallback]');
    if (line) line.hidden = false;
  });
})();`;
}
