/**
 * The Contact page's island (Contact page spec §2, §3, §5, §6): the composer's state, the live
 * letter, and the actions that hand a draft to the visitor's own email app.
 *
 * - State is a purpose and a set of offers. The pre-paint script (contact-paint.ts) has already
 *   drawn the `?topic=…&offer=…` preselect; this takes over from the same `parseQuery`. The
 *   composer's `data-topic` and `data-offers` drive what the letter shows (contact.css), and a
 *   choice keeps the query in step with `history.replaceState`, so the page's link can be shared.
 *   Transitions exist only once the visitor has changed something (`data-live`), so nothing moves
 *   on load.
 * - The address is joined only on a visitor's action (contact-address.ts): Show email address,
 *   or any of the three draft actions, which also show it, so a visitor whose email app does not
 *   open still has it. No `<a href="mailto:…">` sits in the page: the draft buttons build the
 *   link when pressed and navigate to it.
 * - Feedback (shown, copied, how to carry on) goes through the one polite status line. Where the
 *   clipboard is blocked, the text to copy is selected instead: the address, or the letter.
 * - The composer is marked `data-ready` once this has run; the pre-paint script falls back to the
 *   spelled-out address if it never does.
 * - Nothing is sent or stored: no request, no storage, no analytics event. (A browser test reads
 *   the `mailto:` navigation as the request Chromium makes for it, which no mail app answers.)
 */
import { contactAddress } from '../../lib/contact-address';
import {
  buildDraft,
  draftText,
  isOffer,
  isTopic,
  mailtoUrl,
  normalizeOffers,
  offerList,
  parseQuery,
  subjectSuffix,
  toQuery,
  type Offer,
} from '../../lib/contact-draft';
import { TOPIC_INPUT } from './contact-paint';

/** How long a status message stays up. */
const STATUS_MS = 6000;

export function initContact(root: HTMLElement): void {
  root.hidden = false;
  const find = <T extends Element>(selector: string) =>
    root.querySelector<T>(selector);
  const radios = [
    ...root.querySelectorAll<HTMLInputElement>(`input[name="${TOPIC_INPUT}"]`),
  ];
  const toggles = [
    ...root.querySelectorAll<HTMLButtonElement>('button[data-offer]'),
  ];
  const offerListText = find('[data-offer-list]');
  const offerSubject = find('[data-offer-subject]');
  const toAddress = find('[data-to-address]');
  const status = find<HTMLElement>('[data-status]');
  const revealButton = find<HTMLButtonElement>('[data-action="reveal"]');
  const shown = find<HTMLElement>('[data-address-shown]');
  const letter = find('[data-letter]');
  const addressText = find('[data-address]');
  const copyAddress = find<HTMLButtonElement>('[data-action="copy-address"]');

  let { topic, offers } = parseQuery(location.search);
  const state = () => ({ topic, offers });

  const render = () => {
    root.dataset.topic = topic;
    root.dataset.offers = offers.join(' ');
    for (const radio of radios) radio.checked = radio.value === topic;
    for (const toggle of toggles)
      toggle.setAttribute(
        'aria-pressed',
        String(offers.includes(toggle.dataset.offer as Offer)),
      );
    if (offerListText) offerListText.textContent = offerList(offers);
    if (offerSubject) offerSubject.textContent = subjectSuffix(offers);
  };

  const changed = () => {
    root.dataset.live = '';
    render();
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${toQuery(state())}${location.hash}`,
    );
  };

  for (const radio of radios)
    radio.addEventListener('change', () => {
      if (!radio.checked || !isTopic(radio.value)) return;
      topic = radio.value;
      changed();
    });

  for (const toggle of toggles)
    toggle.addEventListener('click', () => {
      const offer = toggle.dataset.offer;
      if (!isOffer(offer)) return;
      offers = offers.includes(offer)
        ? offers.filter((other) => other !== offer)
        : normalizeOffers([...offers, offer]);
      changed();
    });

  // One polite status line for every piece of feedback. The same message twice is cleared first,
  // so it is announced again.
  let statusTimer = 0;
  const say = (message: string) => {
    if (!status) return;
    window.clearTimeout(statusTimer);
    const write = () => {
      status.textContent = message;
      statusTimer = window.setTimeout(() => {
        status.textContent = '';
      }, STATUS_MS);
    };
    if (status.textContent === message) {
      status.textContent = '';
      statusTimer = window.setTimeout(write, 120);
    } else write();
  };

  let address = '';
  const reveal = (): string => {
    if (address) return address;
    address = contactAddress();
    if (addressText) addressText.textContent = address;
    if (toAddress) toAddress.textContent = address;
    root.dataset.revealed = '';
    if (revealButton) revealButton.hidden = true;
    if (shown) shown.hidden = false;
    return address;
  };

  // Each draft action has already shown the address, so a visitor whose email app does not open
  // is told what still works: the draft to copy, or the address just above this line.
  const open = (url: string, otherwise: string) => {
    window.location.href = url;
    say(`If no email app opens, ${otherwise}`);
  };

  // `what` names the text `selection` holds: where the clipboard is blocked, it is selected,
  // ready to copy by hand.
  const copy = async (
    text: string,
    done: string,
    selection: Element | null,
    what: string,
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      say(done);
    } catch {
      if (selection) window.getSelection()?.selectAllChildren(selection);
      say(
        selection
          ? `Copying is blocked here. The ${what} is selected, ready to copy.`
          : 'Copying is blocked here.',
      );
    }
  };

  const actions: Record<string, () => void> = {
    open: () =>
      open(mailtoUrl(reveal(), buildDraft(state())), 'use Copy draft.'),
    blank: () => open(mailtoUrl(reveal()), 'write to the address above.'),
    'copy-draft': () =>
      void copy(
        draftText(reveal(), buildDraft(state())),
        'Draft copied',
        letter,
        'draft',
      ),
    reveal: () => {
      reveal();
      copyAddress?.focus();
      say('Email address shown');
    },
    'copy-address': () => void copy(reveal(), 'Copied', addressText, 'address'),
  };
  root.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>(
      'button[data-action]',
    );
    const action = button && actions[button.dataset.action ?? ''];
    if (action) action();
  });

  render();
  root.dataset.ready = '';
}
