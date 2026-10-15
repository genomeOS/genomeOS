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
 * - Feedback (shown, copied, how to carry on) goes through the one polite status line. "Email
 *   address shown" is for screen readers only: the address is in view and focus is on its Copy
 *   (design critique 1, m-2). Where the clipboard is blocked, the text to copy is selected
 *   instead: the address, or the letter. The letter as laid out is not the draft's text (To and
 *   Subject lose their colons, each dash breaks from its field, and hidden sections leave blank
 *   lines), so while that selection stands a copy carries `draftText`, exactly what Copy draft
 *   would have copied.
 * - On a phone the letter runs on below the controls and the actions below the letter, so while
 *   the letter is read and the button in the page is still well below it, a dock at the foot of
 *   the screen holds the primary action (design critiques 1, m-5, and 2, I-1; contact.css). It is
 *   a pointer shortcut to that button, which keyboards and screen readers use: hidden from both.
 *   It hands over before the button comes into view, so the action never shows twice.
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

/** How long a status message stays up. */
const STATUS_MS = 6000;

/** The phone dock goes this far before the button in the page would come into view... */
const DOCK_HANDOFF_PX = 24;
/** ...and comes back only once that button is this share of a screen below the fold. */
const DOCK_RETURN_SHARE = 0.25;

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
  const dock = find<HTMLElement>('[data-dock]');

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

  // One polite status line for every piece of feedback. The same message twice is cleared first,
  // so it is announced again. A message that only repeats what is in view is read, not shown.
  let statusTimer = 0;
  const say = (message: string, { shown = true } = {}) => {
    if (!status) return;
    window.clearTimeout(statusTimer);
    const write = () => {
      if (shown) status.textContent = message;
      else {
        const line = document.createElement('span');
        line.className = 'visually-hidden';
        line.textContent = message;
        status.replaceChildren(line);
      }
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

  const draft = () => draftText(reveal(), buildDraft(state()));

  // The whole letter selected (as `copy` selects it, or by hand), once the address is shown: a
  // hand copy of it (keys, menu) carries the draft as Copy draft writes it, for the choices as
  // they now stand. Any other selection copies as the browser copies it. The ends are compared by
  // the text between them and the letter's own ends, since a browser may move a selection's ends
  // onto the nearest text.
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
    if (!letter || !address || selection?.rangeCount !== 1) return false;
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

  const actions: Record<string, () => void> = {
    open: () =>
      open(mailtoUrl(reveal(), buildDraft(state())), 'use Copy draft.'),
    blank: () => open(mailtoUrl(reveal()), 'write to the address above.'),
    'copy-draft': () => void copy(draft(), 'Draft copied', letter, 'draft'),
    reveal: () => {
      reveal();
      copyAddress?.focus();
      say('Email address shown', { shown: false });
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

  // The phone dock (contact.css; design critiques 1, m-5, and 2, I-1): the primary action at the
  // foot of the screen while the letter is read.
  // - It comes in once the letter's whole head (To and Subject, however they wrap) has risen above
  //   it, which the letter's body reaching the dock's top marks, while the button in the page is
  //   more than a quarter of a screen below the fold.
  // - It goes DOCK_HANDOFF_PX before that button would come into view, so the two are never on
  //   screen together, and stays away until the button is a quarter of a screen below again.
  // - The observers only say when to look: each report decides from where the letter and the
  //   button are now, with the observers' own edges (an edge touched counts as reached), so a jump
  //   (End, a link) past an observer's line leaves no stale state.
  // - Its first state lands at once, so nothing moves on load; later changes move. Above 60rem
  //   contact.css never shows it.
  const letterBody = find('.letter__body');
  const inPage = find('.contact__actions [data-action="open"]');
  if (dock && letterBody && inPage && 'IntersectionObserver' in window) {
    let reach = -1;
    let shown = false;
    let watchers: IntersectionObserver[] = [];
    const reported = new Set<IntersectionObserver>();
    const update = (watcher: IntersectionObserver) => {
      const fold = window.innerHeight;
      const button = inPage.getBoundingClientRect().top;
      const headClear = letterBody.getBoundingClientRect().top <= fold - reach;
      if (!headClear || button <= fold + DOCK_HANDOFF_PX) shown = false;
      else if (button > fold * (1 + DOCK_RETURN_SHARE)) shown = true;
      dock.toggleAttribute('data-shown', shown);
      reported.add(watcher);
      if (reported.size < watchers.length || dock.hasAttribute('data-motion'))
        return;
      // Every watcher has reported: commit that state as it stands, then let changes move.
      void getComputedStyle(dock).opacity;
      dock.toggleAttribute('data-motion', true);
    };
    const observe = (target: Element, bottom: string) => {
      const watcher = new IntersectionObserver(() => update(watcher), {
        rootMargin: `0px 0px ${bottom} 0px`,
      });
      watcher.observe(target);
      return watcher;
    };
    const watch = () => {
      // How far up from the foot of the screen the dock reaches (offsetTop leaves out its rise).
      const next = Math.max(0, Math.round(window.innerHeight - dock.offsetTop));
      if (next === reach) return;
      reach = next;
      for (const watcher of watchers) watcher.disconnect();
      reported.clear();
      watchers = [
        observe(letterBody, `-${reach}px`),
        observe(inPage, `${DOCK_HANDOFF_PX}px`),
        observe(inPage, `${DOCK_RETURN_SHARE * 100}%`),
      ];
    };
    watch();
    window.addEventListener('resize', watch, { passive: true });
  }

  render();
  root.dataset.ready = '';
}
