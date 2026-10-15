/**
 * The Contact page's pre-paint script (Contact page spec §2, §3.1, §4). The composer is rendered
 * `hidden`, so a visitor without JavaScript sees only the `<noscript>` address; this script, a few
 * lines inlined right after it, shows it before the first paint, and applies a `?topic=…&offer=…`
 * preselect at the same moment, so a link from Contribute never paints the default letter and
 * then grows (a module script runs too late for that).
 *
 * It repeats `parseQuery`'s rule in plain ES5, with the purposes and offers from contact-draft.ts,
 * and carries the offer wording for every set of offers as a table built here from `letterList`
 * and `subjectSuffix`, so it writes no grammar of its own. `tests/contact-paint.test.ts` runs it
 * against `parseQuery` for every case, so the two cannot drift. The island (contact.ts) then
 * takes over from the same state, and marks the composer `data-ready`.
 *
 * If the island never runs (a chunk that failed to load, a browser without modules), the
 * composer's buttons would be inert. Module scripts run before `load`, so a composer still not
 * ready then goes back to the no-JavaScript page: hidden, with the address spelled out in its
 * place (`[data-contact-fallback]`).
 */
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

export function contactPaintScript(rootId: string): string {
  const json = JSON.stringify;
  return `(function () {
  var root = document.getElementById(${json(rootId)});
  if (!root) return;
  root.hidden = false;
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
    var line = document.querySelector('[data-contact-fallback]');
    if (line) line.hidden = false;
  });
})();`;
}
