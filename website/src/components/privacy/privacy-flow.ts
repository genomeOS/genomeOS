/**
 * The privacy page's "What leaves your browser" figure (site redesign spec §4.5, #454): the
 * consent gate between the visitor's browser and Google Analytics 4 is drawn in the visitor's
 * actual state, as `src/lib/consent.ts` (the cookie control's module) decides it.
 *
 *   open      analytics is on: a choice of On, or the opt-out default outside the opt-in regions
 *   closed    analytics is off: a choice of Off, or Global Privacy Control
 *   pending   an undecided visitor in an opt-in time zone: closed until Accept ("Not chosen yet")
 *   removed   a build without analytics, drawn at build time ("This copy loads no analytics")
 *
 * Three pieces keep the drawing true:
 *
 * - `gatePaintScript`, a few lines inlined right after the figure, draws the stored choice before
 *   the first paint (a module script runs too late for that). It repeats `resolveConsent`'s rule,
 *   as the head bootstrap in `ga.mjs` does, and `tests/privacy-flow.test.ts` checks it against
 *   `resolveConsent` for every input, so the two cannot drift.
 * - `initPrivacyFlow` then mirrors the page's cookie control, which decides through consent.ts:
 *   it redraws whenever the control renders (it rewrites `data-consent` on its root each time).
 *   The control keeps the page's choice, and the consent it gave gtag, in memory, so the gate
 *   follows the control rather than storage: a choice made in another tab, or stored while the
 *   page sat in the back-forward cache, changes neither until the page reloads, and a choice the
 *   browser refused to store still counts on this page.
 * - CSS draws each state from the figure's `data-gate`. A change the visitor makes takes
 *   `--dur-ui` (240 ms), or no time under reduced motion; the transitions only exist once the
 *   figure is `data-live`, which the first such change sets, so nothing can move on load.
 *
 * The figure sends nothing and loads nothing: it only reads local state.
 */
import type { ConsentState } from '../../lib/consent';
import {
  CONSENT_STORAGE_KEY,
  CONSENT_TIME_ZONES,
} from '../../lib/consent-policy.mjs';

export type GateState = 'open' | 'closed' | 'pending' | 'removed';

/** The gate the figure draws for a consent state; null is a build without analytics. */
export function gateState(consent: ConsentState | null): GateState {
  if (consent === null) return 'removed';
  if (consent.source === 'opt-in-region') return 'pending';
  return consent.analytics === 'granted' ? 'open' : 'closed';
}

/**
 * The inline script that draws the stored choice on the figure `figureId` before the first
 * paint: `resolveConsent`'s rule in plain ES5, with the storage key and the opt-in time zones
 * from `consent-policy.mjs`. Build time only; a build without analytics renders none.
 */
export function gatePaintScript(figureId: string): string {
  const json = JSON.stringify;
  return `(function () {
  var figure = document.getElementById(${json(figureId)});
  if (!figure) return;
  var choice = null;
  try {
    var stored = window.localStorage.getItem(${json(CONSENT_STORAGE_KEY)});
    if (stored === 'granted' || stored === 'denied') choice = stored;
  } catch (error) {}
  var gate = 'open';
  if (choice) gate = choice === 'granted' ? 'open' : 'closed';
  else {
    var signal = false;
    try {
      signal = window.navigator.globalPrivacyControl === true;
    } catch (error) {}
    if (signal) gate = 'closed';
    else {
      var zone;
      try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (error) {}
      if (${json(CONSENT_TIME_ZONES)}.indexOf(zone) !== -1) gate = 'pending';
    }
  }
  figure.setAttribute('data-gate', gate);
})();`;
}

/** What the cookie control has drawn: its root's `data-consent`, and whether it is asking. */
export interface ControlView {
  /** `granted` or `denied` once the control has rendered; absent before. */
  consent: string | null | undefined;
  /** Its Accept/Decline prompt is shown: an undecided visitor in an opt-in time zone. */
  prompting: boolean;
}

/** The gate for the state the cookie control shows, or null before it has drawn one. */
export function controlGate({
  consent,
  prompting,
}: ControlView): GateState | null {
  if (consent === 'granted') return 'open';
  if (consent !== 'denied') return null;
  return prompting ? 'pending' : 'closed';
}

/** Keep the figure's gate in step with the page's cookie control. */
export function initPrivacyFlow(doc: Document = document): void {
  const figure = doc.querySelector<HTMLElement>('[data-privacy-flow]');
  const control = doc.querySelector<HTMLElement>('[data-cookie-control]');
  if (!figure || !control || figure.dataset.gate === 'removed') return;
  const prompt = control.querySelector<HTMLElement>('[data-cookie-prompt]');

  /** Redraw the gate; `animate` only for a change the visitor makes while the page is open. */
  const update = (animate: boolean) => {
    const gate = controlGate({
      consent: control.dataset.consent,
      prompting: prompt ? !prompt.hidden : false,
    });
    // Before the control's first render the pre-paint drawing, by the same rule, stands.
    if (!gate || figure.dataset.gate === gate) return;
    if (animate && !figure.hasAttribute('data-live')) {
      // The gate's transitions apply only to a live figure, so nothing can move on load. Commit
      // the current state with them on before the change, or the change would not animate.
      figure.setAttribute('data-live', '');
      void figure.offsetWidth;
    }
    figure.dataset.gate = gate;
  };

  update(false);
  // The cookie control re-renders, and rewrites `data-consent`, on every change of choice (and
  // whenever its panel opens, which changes nothing here).
  new MutationObserver(() => update(true)).observe(control, {
    attributes: true,
    attributeFilter: ['data-consent'],
  });
}
