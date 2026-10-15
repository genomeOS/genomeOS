/**
 * The micro astronaut: one person in a data figure (round 2 spec §3.3; R2-15, "people should be
 * represented by little astronaut icons"; #454). Ported from `r2/lead/proto/people.html`.
 *
 * One 16 × 20 glyph: a body, a helmet ringed in the band's colour (a 1.2-unit gap that separates
 * helmet from body, so the silhouette reads at 12 px), and a visor. Drawn once per page as
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

const BODY = 'M2.2 20v-4.4a3.6 3.6 0 0 1 3.6-3.6h4.4a3.6 3.6 0 0 1 3.6 3.6V20z';

function symbol(id: string, suit: string, window: string): string {
  const fill = `style="fill:var(--person-${suit})"`;
  return (
    `<symbol id="${id}" viewBox="${MICRO_VIEWBOX}">` +
    `<path d="${BODY}" ${fill}/>` +
    `<circle cx="8" cy="7" r="6.4" stroke-width="1.2" style="fill:var(--person-${suit});stroke:var(--micro-band,#020712)"/>` +
    window +
    `</symbol>`
  );
}

const faceWindow = (skin: SkinTone) =>
  `<ellipse cx="8.4" cy="7.3" rx="4.2" ry="3.5" fill="${GLASS}"/><ellipse cx="8.7" cy="7.6" rx="2.9" ry="2.5" fill="${SKIN[skin][0]}"/>`;
const closedWindow = `<ellipse cx="8.4" cy="7.3" rx="4.1" ry="3.4" fill="${GLASS}"/><ellipse cx="6.6" cy="5.9" rx="1.25" ry=".7" transform="rotate(-28 6.6 5.9)" fill="#f2f8ff" fill-opacity=".8"/>`;
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
