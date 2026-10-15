/**
 * The Contact page's island (Contact page spec §2, §3, §5, §6): Email us and the address, the
 * template composer's state, the live letter, and the action that hands a draft to the visitor's
 * own email app.
 *
 * - The address is joined in the browser (contact-address.ts); the pre-paint script has already
 *   written it into the page (contact-paint.ts). Email us is a link whose `mailto:` this sets only
 *   when a visitor reaches for it (a pointer over it or down on it, a touch, or focus), so the page
 *   as loaded holds no `mailto:` link. Its copy button confirms in place: it reads "Copied" for a
 *   moment, at its own size.
 * - State is a purpose and a set of offers. The pre-paint script has already drawn the
 *   `?topic=…&offer=…` preselect; this takes over from the same `parseQuery`. The composer's
 *   `data-topic` and `data-offers` drive what the letter shows (contact.css), and a choice keeps
 *   the query in step with `history.replaceState`, so the page's link can be shared. Transitions
 *   exist only once the visitor has changed something (`data-live`), so nothing moves on load.
 * - Open draft in your email app builds the draft and navigates to its `mailto:`.
 * - Feedback goes through the page's one polite live region, which stays out of sight. Guidance on
 *   how to carry on (no email app opened; the clipboard is blocked) also shows as a line under the
 *   control it follows, and keeps it until that control's next message, so nothing moves by
 *   itself. Where the clipboard is blocked, the address is selected instead, ready to copy by hand.
 * - The whole letter selected (by hand) copies as the draft's text, exactly what the email app
 *   would get: the letter as laid out is not the draft's text (To and Subject lose their colons,
 *   each dash breaks from its field, and hidden sections leave blank lines).
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
  letterList,
  parseQuery,
  subjectSuffix,
  toQuery,
  type Offer,
} from '../../lib/contact-draft';
import { TOPIC_INPUT } from './contact-paint';

/** How long a message only read out stays in the live region. */
const STATUS_MS = 6000;
/** How long the copy button reads "Copied". */
const CONFIRM_MS = 2000;

const DRAFT_HINT =
  'If no email app opens, copy the letter and send it to the address above.';

export function initContact(root: HTMLElement): void {
  root.hidden = false;
  const find = <T extends Element>(selector: string) =>
    root.querySelector<T>(selector);
  const page = document;
  const radios = [
    ...root.querySelectorAll<HTMLInputElement>(`input[name="${TOPIC_INPUT}"]`),
  ];
  const toggles = [
    ...root.querySelectorAll<HTMLButtonElement>('button[data-offer]'),
  ];
  const offerListText = find('[data-offer-list]');
  const offerSubject = find('[data-offer-subject]');
  const letter = find('[data-letter]');
  const status = page.querySelector<HTMLElement>('[data-status]');
  const emailUs = page.querySelector<HTMLAnchorElement>('[data-email-us]');
  const addressText = page.querySelector('[data-address]');
  const hints = {
    address: page.querySelector<HTMLElement>('[data-hint="address"]'),
    draft: page.querySelector<HTMLElement>('[data-hint="draft"]'),
  };

  // Written by the pre-paint script already; written again, so the page holds it either way.
  const address = contactAddress();
  for (const place of page.querySelectorAll(
    '[data-address], [data-to-address]',
  ))
    place.textContent = address;
  root.dataset.revealed = '';

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
    if (offerListText) offerListText.textContent = letterList(offers);
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

  // The one polite live region, out of sight. A message is cleared after a while; the same one
  // twice is cleared first, so it is announced again. Guidance also shows under the control it
  // follows (`hint`), and stays there until that control's next message.
  let statusTimer = 0;
  const say = (message: string, hint?: HTMLElement | null) => {
    if (hint) {
      hint.textContent = message;
      hint.hidden = false;
    }
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

  // Email us: the address's mailto:, set when a visitor reaches for the link, never before.
  if (emailUs) {
    const reach = () => {
      emailUs.href = mailtoUrl(address);
    };
    for (const type of ['pointerover', 'pointerdown', 'touchstart', 'focus'])
      emailUs.addEventListener(type, reach, { once: true, passive: true });
    // A click that came with none of those (a script, an assistive tool) still opens it.
    emailUs.addEventListener('click', reach);
  }

  // The copy button reads "Copied" for a moment: both its labels share one cell (contact.css), so
  // it keeps its size.
  let confirmTimer = 0;
  const confirmCopy = (button: HTMLElement) => {
    window.clearTimeout(confirmTimer);
    button.toggleAttribute('data-confirmed', true);
    confirmTimer = window.setTimeout(
      () => button.removeAttribute('data-confirmed'),
      CONFIRM_MS,
    );
  };

  const copyAddress = async (button: HTMLElement) => {
    try {
      await navigator.clipboard.writeText(address);
      if (hints.address) hints.address.hidden = true;
      confirmCopy(button);
      say('Copied');
    } catch {
      if (addressText) window.getSelection()?.selectAllChildren(addressText);
      say(
        'Copying is blocked here. The address is selected, ready to copy.',
        hints.address,
      );
    }
  };

  const draft = () => draftText(address, buildDraft(state()));

  // The whole letter selected (by hand, or as a browser moves a selection's ends onto the nearest
  // text): a copy of it (keys, menu) carries the draft as the email app would get it, for the
  // choices as they now stand. Any other selection copies as the browser copies it. The ends are
  // compared by the text between them and the letter's own ends.
  const textBetween = (
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ) => {
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    return range.toString().trim();
  };
  const holdsLetter = () => {
    const selection = window.getSelection();
    if (!letter || selection?.rangeCount !== 1) return false;
    const held = selection.getRangeAt(0);
    return (
      letter.contains(held.startContainer) &&
      letter.contains(held.endContainer) &&
      textBetween(letter, 0, held.startContainer, held.startOffset) === '' &&
      textBetween(
        held.endContainer,
        held.endOffset,
        letter,
        letter.childNodes.length,
      ) === ''
    );
  };
  document.addEventListener('copy', (event) => {
    if (!event.clipboardData || !holdsLetter()) return;
    event.clipboardData.setData('text/plain', draft());
    event.preventDefault();
  });

  const actions: Record<string, (button: HTMLElement) => void> = {
    open: () => {
      window.location.href = mailtoUrl(address, buildDraft(state()));
      say(DRAFT_HINT, hints.draft);
    },
    'copy-address': (button) => void copyAddress(button),
  };
  page.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>(
      '.contact-page button[data-action]',
    );
    const action = button && actions[button.dataset.action ?? ''];
    if (button && action) action(button);
  });

  render();
  root.dataset.ready = '';
}
