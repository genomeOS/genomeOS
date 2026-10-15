/**
 * The Contact page's island (Contact page spec §2, §3, §5, §6): Email us and the address, the
 * template composer's state, the live letter, and the actions that hand a draft to the visitor's
 * own email.
 *
 * - The address is joined in the browser (contact-address.ts), and only at the first sign of a
 *   person (owner, 2026-10-15; no CAPTCHA, by the controller's ruling): a pointer that moves or
 *   presses, a touch, a key, a wheel, or focus moving into the page. A scroll a person makes comes
 *   with one of those; a scroll alone is no sign (a script's, or a browser restoring its place).
 *   Until then the page shows it spelled out, as served; then the address takes the spelled-out
 *   form's box in each place (contact.css), once, and this stops listening. Events a script
 *   dispatches are no person. A press of a copy button copies the address whatever stands.
 * - Email us is a link whose `mailto:` this sets only when a visitor reaches for it (a pointer over
 *   it or down on it, a touch, or focus), so the page as loaded holds no `mailto:` link. Gmail and
 *   Outlook, under it and under Open draft, are set the same way, from the draft as it stands
 *   (contact-draft.ts `webmailUrl`), and open in a new tab. The copy buttons confirm in place: a
 *   check, and "Copied", for a moment, at their own size.
 * - A `mailto:` click (Email us, Open draft) with the page still in front 1.5 s on, neither blurred
 *   nor hidden, opened no email app (a computer whose mail is webmail): a hint next to the control
 *   says what still works. Its line is taken at the click, unseen, so showing it moves nothing.
 * - State is a purpose and a set of offers. The pre-paint script has already drawn the
 *   `?topic=…&offer=…` preselect; this takes over from the same `parseQuery`. The composer's
 *   `data-topic` and `data-offers` drive what the letter shows (contact.css), and a choice keeps
 *   the query in step with `history.replaceState`, so the page's link can be shared. Transitions
 *   exist only once the visitor has changed something (`data-live`), so nothing moves on load.
 * - Open draft in your email app builds the draft and navigates to its `mailto:`; the letter's copy
 *   button copies the draft's text.
 * - Feedback goes through the page's one polite live region, which stays out of sight. Guidance on
 *   how to carry on (no email app opened; the clipboard is blocked) also shows as a line next to the
 *   control it follows, and keeps it until that control's next message, so nothing moves by
 *   itself. Where the clipboard is blocked, the address or the letter is selected instead, ready to
 *   copy by hand.
 * - The whole letter selected (by hand) copies as the draft's text, exactly what the email app
 *   would get: the letter as laid out is not the draft's text (To and Subject lose their colons,
 *   each dash breaks from its field, and hidden sections leave blank lines).
 * - The letter types itself out the first time it is in view, and retypes what a choice changes
 *   (letter-typing.ts), where the pre-paint script set it waiting: not under reduced motion or
 *   forced colours. Typing is display only: every draft is built here, from the state, as before.
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
  webmailUrl,
  type Offer,
  type Webmail,
} from '../../lib/contact-draft';
import { TOPIC_INPUT } from './contact-paint';
import { letterTyping } from './letter-typing';

/** How long a message only read out stays in the live region. */
const STATUS_MS = 6000;
/** How long a copy button reads "Copied". */
const CONFIRM_MS = 2000;
/** How long after a `mailto:` click a page still in front means no email app opened. */
const NOTHING_MS = 1500;

const NOTHING = 'Nothing opened? Use Gmail or Outlook, or copy the ';
const BLOCKED_ADDRESS =
  'Copying is blocked here. The address is selected, ready to copy.';
const BLOCKED_LETTER = 'Press Ctrl+C or Cmd+C to copy.';
/** The first signs of a person. */
const SIGNS = [
  'pointermove',
  'pointerdown',
  'touchstart',
  'keydown',
  'wheel',
  'focusin',
];
/** A visitor reaching for a link; a click with none of those (a script, an assistive tool) too. */
const REACH = ['pointerover', 'pointerdown', 'touchstart', 'focus', 'click'];

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
  const letter = find<HTMLElement>('[data-letter]');
  const status = page.querySelector<HTMLElement>('[data-status]');
  const emailUs = page.querySelector<HTMLAnchorElement>('[data-email-us]');
  const addressText = page.querySelector('[data-address]');
  const hint = (which: string) =>
    page.querySelector<HTMLElement>(`[data-hint="${which}"]`);
  const hints = {
    address: hint('address'),
    draft: hint('draft'),
    letter: hint('letter'),
  };

  const address = contactAddress();

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

  // The letter's typing reads the letter before a redraw and retypes what it changed after it.
  const plate = letter?.closest<HTMLElement>('figure');
  const typing =
    letter?.dataset.typing === 'pending' && plate
      ? letterTyping(letter, plate)
      : undefined;

  // The address, joined at the first sign of a person, once: in its line and in the letter's To,
  // whole there even if the To line was typing.
  let joined = false;
  const join = (event?: Event) => {
    if (joined || (event && !event.isTrusted)) return;
    joined = true;
    for (const type of SIGNS) removeEventListener(type, join, true);
    for (const place of page.querySelectorAll<HTMLElement>(
      '[data-address], [data-to-address]',
    )) {
      place.textContent = address;
      place.dataset.joined = '';
      const line = place.closest<HTMLElement>('dd');
      if (line) typing?.settle(line);
    }
  };
  for (const type of SIGNS)
    addEventListener(type, join, { capture: true, passive: true });

  const changed = () => {
    root.dataset.live = '';
    const before = typing?.snapshot();
    render();
    if (typing && before) typing.retype(before);
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
      delete hint.dataset.pending;
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

  // After a mailto: click: a page that neither blurs nor hides within NOTHING_MS opened no app.
  // The hint's line is laid out now, at the visitor's own click, and shown then.
  let watching: AbortController | undefined;
  const watch = (line: HTMLElement | null, message: string) => {
    watching?.abort();
    const own = (watching = new AbortController());
    const { signal } = own;
    const opened = () => own.abort();
    addEventListener('blur', opened, { signal });
    page.addEventListener(
      'visibilitychange',
      () => page.visibilityState === 'hidden' && opened(),
      { signal },
    );
    if (line) {
      line.textContent = message;
      line.hidden = false;
      line.dataset.pending = '';
    }
    const timer = setTimeout(() => {
      own.abort();
      say(message, line);
    }, NOTHING_MS);
    signal.addEventListener('abort', () => clearTimeout(timer));
  };

  // Each link set when a visitor reaches for it, never before.
  const reach = (link: HTMLAnchorElement | null, href: () => string) => {
    for (const type of REACH)
      link?.addEventListener(type, () => (link.href = href()), {
        passive: true,
      });
  };
  // Email us: the address's mailto:, a blank email.
  reach(emailUs, () => mailtoUrl(address));
  emailUs?.addEventListener('click', () =>
    watch(hints.address, `${NOTHING}address.`),
  );
  // Gmail and Outlook: under Email us a blank email, under Open draft the draft as it stands.
  for (const link of page.querySelectorAll<HTMLAnchorElement>('[data-webmail]'))
    reach(link, () =>
      webmailUrl(
        link.dataset.webmail as Webmail,
        address,
        root.contains(link) ? buildDraft(state()) : undefined,
      ),
    );

  // A copy button reads "Copied" for a moment, at its own size (contact.css).
  const confirms = new WeakMap<HTMLElement, number>();
  const confirmCopy = (button: HTMLElement) => {
    clearTimeout(confirms.get(button));
    button.toggleAttribute('data-confirmed', true);
    confirms.set(
      button,
      window.setTimeout(
        () => button.removeAttribute('data-confirmed'),
        CONFIRM_MS,
      ),
    );
  };

  // Copied, or where the clipboard is blocked, selected for the keys, and said so beside it.
  const copy = async (
    button: HTMLElement,
    text: string,
    held: Node | null,
    blocked: string,
    line: HTMLElement | null,
  ) => {
    join();
    try {
      await navigator.clipboard.writeText(text);
      watching?.abort();
      if (line) line.hidden = true;
      confirmCopy(button);
      say('Copied');
    } catch {
      if (held) window.getSelection()?.selectAllChildren(held);
      say(blocked, line);
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
      watch(hints.draft, `${NOTHING}letter.`);
    },
    'copy-address': (button) =>
      void copy(button, address, addressText, BLOCKED_ADDRESS, hints.address),
    'copy-letter': (button) =>
      void copy(button, draft(), letter, BLOCKED_LETTER, hints.letter),
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
