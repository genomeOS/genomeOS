/**
 * The micro astronaut: one person in a data figure (round 2 spec §3.3; R2-15, "people should be
 * represented by little astronaut icons"; #454). Ported from `r2/lead/proto/people.html`.
 *
 * One 16 × 20 glyph, a whole astronaut: two arms held a little out and two legs apart, a suit with
 * a dark chest panel, and a round helmet with its visor. The torso and helmet are edged in the
 * band's colour, so the helmet stands off the shoulders and the arms off the torso, and the figure
 * reads as an astronaut down to 12 px (the owner, 2026-10-15: the head-and-shoulders glyph was not
 * obviously an astronaut; "they need bodies, or at least arms"). Drawn once per page as
 * `<symbol>`s and placed with `<use>`, never one full astronaut per person.
 *
 *   face    the counts figure: the visor shows a face in one of the kit's six skin tones, seeded
 *           per position (`microSkins`); the suit carries the data (carrier or tested), and the
 *           glass rim keeps pale faces from reading as carriers.
 *   closed  the people figure: dark glass with one glint and no face, so ancestry is never drawn
 *           as skin colour; the suit tone carries the category (tested, other, carrier).
 *   untested  an empty place in a grid: one faint dot.
 *
 * Suits use only the `--person-*` tokens (tokens.css). The ring takes `--micro-band` (the band the
 * figure sits on; void by default), set on the figure's SVG.
 */
import { mulberry32, SEED } from '../rng';
import { SKIN, type SkinTone } from './palette';

export const MICRO_VIEWBOX = '0 0 16 20';

export type MicroState = 'carrier' | 'tested' | 'other' | 'untested';

const GLASS = '#0c1b36';
const SKINS = Object.keys(SKIN) as SkinTone[];

/** Arms (out and down from the shoulders) and legs, as round-capped strokes in the suit. */
const ARMS = 'M4.4 11.8 2.3 14.9M11.6 11.8l2.1 3.1';
const LEGS = 'M6.2 16v2.8M9.8 16v2.8';

function symbol(id: string, suit: string, window: string): string {
  const tone = `var(--person-${suit})`;
  const band = 'var(--micro-band,#020712)';
  return (
    `<symbol id="${id}" viewBox="${MICRO_VIEWBOX}">` +
    `<g fill="none" stroke-linecap="round" style="stroke:${tone}">` +
    `<path d="${ARMS}" stroke-width="2.5"/><path d="${LEGS}" stroke-width="2.7"/></g>` +
    `<rect x="4.1" y="10.4" width="7.8" height="6.6" rx="2.4" stroke-width=".8" style="fill:${tone};stroke:${band}"/>` +
    `<rect x="6.5" y="12.3" width="3" height="1.6" rx=".5" fill="${GLASS}"/>` +
    `<circle cx="8" cy="5.7" r="5.4" stroke-width="1.1" style="fill:${tone};stroke:${band}"/>` +
    window +
    `</symbol>`
  );
}

const faceWindow = (skin: SkinTone) =>
  `<ellipse cx="8.4" cy="6" rx="3.6" ry="3" fill="${GLASS}"/><ellipse cx="8.7" cy="6.3" rx="2.5" ry="2.1" fill="${SKIN[skin][0]}"/>`;
const closedWindow = `<ellipse cx="8.4" cy="6" rx="3.6" ry="3" fill="${GLASS}"/><ellipse cx="6.8" cy="4.8" rx="1.1" ry=".62" transform="rotate(-28 6.8 4.8)" fill="#f2f8ff" fill-opacity=".8"/>`;
const UNTESTED = `<symbol id="micro-untested" viewBox="${MICRO_VIEWBOX}"><circle cx="8" cy="10" r="2.1" style="fill:var(--person-untested)"/></symbol>`;

/**
 * The `<symbol>` set for a figure: 'face' (twelve faces and the untested place), 'closed' (three
 * closed visors and the untested place) or 'all'. Put it in one `<defs>` per page.
 */
export function microSymbols(variant: 'face' | 'closed' | 'all'): string {
  const faces =
    variant === 'closed'
      ? ''
      : (['carrier', 'tested'] as const)
          .flatMap((state) =>
            SKINS.map((skin) =>
              symbol(`micro-face-${state}-${skin}`, state, faceWindow(skin)),
            ),
          )
          .join('');
  const closed =
    variant === 'face'
      ? ''
      : (['tested', 'other', 'carrier'] as const)
          .map((state) => symbol(`micro-closed-${state}`, state, closedWindow))
          .join('');
  return faces + closed + UNTESTED;
}

/**
 * The symbol for one person: with a skin tone, the face variant; without, the closed variant (the
 * people figure). An untested place is the same in both.
 */
export function microId(state: MicroState, skin?: SkinTone): string {
  if (state === 'untested') return 'micro-untested';
  return skin ? `micro-face-${state}-${skin}` : `micro-closed-${state}`;
}

/**
 * Skin tones for `count` positions, seeded with mulberry32(SEED), so a figure draws the same faces
 * on every build and both rows of the counts figure share them position by position.
 */
export function microSkins(count: number, seed = SEED): SkinTone[] {
  const random = mulberry32(seed);
  return Array.from(
    { length: count },
    () => SKINS[Math.floor(random() * SKINS.length)],
  );
}
