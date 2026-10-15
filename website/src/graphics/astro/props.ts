/**
 * The astronaut kit's scene props (round 2 spec §3.1; R2-6; #454), ported from the design prototype
 * (`r2/characters/kit/props.js`). Same ink and light as the rig. Origins sit on the ground under
 * each prop unless noted. Strings only, so props render at build time too.
 *
 * Names follow the spec's interface (plan I-1); the prototype's longer names map as oreRock → ore,
 * oreCart → cart, soilProbe → probe. New in the build: `tablet(glyph)` and `chartCard()` (Home's
 * crew), `workbench(cast)` (the bench beside a seated figure). Clip-path ids are derived from what
 * a prop draws (never a running counter), so a page renders the same markup on every build.
 */
import { ACCENT, C } from './palette';
import { geom, helmet, PROP, sparkle, stool, workCrate } from './rig';
import type { CastId } from './cast';

export { PROP, sparkle, stool, workCrate };

const f = (n: number | string) => +(+n).toFixed(2);
const ION = '#70e6ff';

/* ------------------------------------------------------------------------------------- moons */

/**
 * Plate-toned two-tone moons with an ion hairline edge and the group's icon engraved in the face.
 * No large tint: the site's genome and aurora stay status colours.
 */
export const MOON = {
  lit: '#183f6e',
  shade: '#0c2446',
  crater: '#081a33',
  line: 'rgb(112 230 255 / 50%)',
} as const;

const CRATERS = [
  [-0.5, -0.22, 0.15],
  [0.42, 0.34, 0.13],
  [-0.2, 0.62, 0.1],
  [0.56, -0.36, 0.09],
  [-0.66, 0.3, 0.1],
  [0.12, -0.7, 0.07],
] as const;

/** The moons' gradients (kMoon, kMoonGlow); add them to the scene's `<defs>` beside `kitDefs()`. */
export function moonDefs(): string {
  return (
    `<radialGradient id="kMoon" cx=".58" cy=".4" r=".52"><stop offset=".965" stop-color="${MOON.lit}"/><stop offset="1" stop-color="${MOON.shade}"/></radialGradient>` +
    `<radialGradient id="kMoonGlow" r=".5"><stop offset=".7" stop-color="${ION}" stop-opacity=".1"/><stop offset="1" stop-color="${ION}" stop-opacity="0"/></radialGradient>`
  );
}

export type MoonKind = 'data' | 'model' | 'ui';

/** Engraved icons, drawn on a 60-unit grid (spec §2.6 line art). Moving parts carry classes. */
export const ICON: Record<MoonKind, string> = {
  data:
    `<ellipse cx="0" cy="-15" rx="16" ry="5.5"/><path d="M-16 -15 V15 M16 -15 V15"/>` +
    `<path class="disc disc-1" d="M-16 -5 A16 5.5 0 0 0 16 -5"/><path class="disc disc-2" d="M-16 5 A16 5.5 0 0 0 16 5"/><path d="M-16 15 A16 5.5 0 0 0 16 15"/>`,
  model:
    `<path class="band" d="M-7 9 V-7 C-4 -15 4 -15 7 -7 V9Z" fill="${ION}" fill-opacity=".22" stroke="none"/>` +
    `<path class="curve" d="M-22 9 C-11 9 -8 -17 0 -17 C8 -17 11 9 22 9"/><path d="M-24 9 H24"/>` +
    `<g class="hexes"><path d="M-14 17 l4 -2.3 l4 2.3 v4.6 l-4 2.3 l-4 -2.3Z"/><path d="M-4 17 l4 -2.3 l4 2.3 v4.6 l-4 2.3 l-4 -2.3Z" fill="${ION}" fill-opacity=".3"/><path d="M6 17 l4 -2.3 l4 2.3 v4.6 l-4 2.3 l-4 -2.3Z"/></g>`,
  ui:
    `<rect x="-21" y="-16" width="42" height="30" rx="3"/><path d="M-21 -9 H21"/>` +
    `<path class="pin" d="M-4 8 C-10 1 -10 -4 -4 -4 C2 -4 2 1 -4 8Z" fill="${ION}" fill-opacity=".3"/>` +
    `<path class="cursor" d="M7 0 L7 14 L10.5 10.5 L14 16 L16.5 14.8 L13 9.5 L17.5 9.5Z" fill="#0a2140"/>`,
};

/** A moon of radius `r` with its group's engraved icon; `label` adds the name under it. */
export function moon(
  r: number,
  kind: MoonKind,
  opt: { label?: string } = {},
): string {
  const craters = CRATERS.map(([x, y, s]) => {
    const cx = x * r;
    const cy = y * r;
    const cr = s * r;
    return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(cr)}" ry="${f(cr * 0.8)}" fill="${MOON.crater}"/><path d="M${f(cx - cr * 0.7)} ${f(cy + cr * 0.55)} A${f(cr)} ${f(cr * 0.8)} 0 0 0 ${f(cx + cr * 0.95)} ${f(cy + cr * 0.1)}" fill="none" stroke="${ION}" stroke-opacity=".3" stroke-width="1.1" stroke-linecap="round"/>`;
  }).join('');
  const k = (r * 0.62) / 30;
  return (
    `<g class="moon moon-${kind}">` +
    `<circle r="${f(r * 1.22)}" fill="url(#kMoonGlow)"/>` +
    `<circle r="${r}" fill="url(#kMoon)"/>` +
    craters +
    `<g class="moon-icon" transform="translate(0 ${f(r * 0.12)}) scale(${f(k)})" fill="none" stroke="${ION}" stroke-width="${f(2.2 / k)}" stroke-linecap="round" stroke-linejoin="round" opacity=".62">${ICON[kind]}</g>` +
    `<path d="M${f(-r * 0.25)} ${f(-r * 0.9)} A${f(r * 0.94)} ${f(r * 0.94)} 0 0 1 ${f(r * 0.88)} ${f(r * 0.24)}" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="${f(r * 0.05)}" stroke-linecap="round"/>` +
    `<circle r="${r}" fill="none" stroke="${MOON.line}" stroke-width="1.6"/>` +
    (opt.label ? moonLabel(opt.label, r) : '') +
    `</g>`
  );
}

/** A moon's name under it, on a void halo (≥ 13 px wherever the stage is drawn). */
export function moonLabel(text: string, r: number, size = 16): string {
  return `<text class="moon-label" x="0" y="${f(r + size + 14)}" text-anchor="middle" font-size="${size}" font-weight="600" fill="#f2f8ff" stroke="#020712" stroke-width="5" stroke-linejoin="round" paint-order="stroke">${text}</text>`;
}

/**
 * Stand something on a moon's surface at an angle from the top (degrees, clockwise). Figures stay
 * within ±37° so nobody looks like they are falling off.
 */
export const onMoon = (
  r: number,
  deg: number,
  inner: string,
  s = 1,
  cls = '',
) =>
  `<g class="on-moon ${cls}" style="transform:rotate(${f(deg)}deg)"><g transform="translate(0 ${f(-r + 1.5)}) scale(${s})">${inner}</g></g>`;

/* -------------------------------------------------------------------------------------- ship */

/**
 * The round pod that rhymes with the helmet; its window shows one to three crew helmets. Origin
 * between the pads.
 */
export function spaceship(
  crew: CastId[] = ['A1'],
  opt: { id?: string } = {},
): string {
  const id = opt.id ?? `sh-${crew.join('-')}`;
  const R = 46;
  const cy = -80;
  const wy = cy - 3;
  const ww = 72;
  const wh = 42;
  const xs =
    crew.length === 1 ? [4] : crew.length === 2 ? [-12, 18] : [-20, 4, 28];
  const heads = crew
    .map(
      (c, i) =>
        `<g class="ship-crew ship-crew-${i}" transform="translate(${xs[i]} ${wy + 9}) scale(.62)">${helmet(c, 'happy', { noAntenna: true })}</g>`,
    )
    .join('');
  const fin = (sx: number) =>
    `<path transform="scale(${sx} 1)" d="M-33 -58 C-54 -55 -64 -38 -62 -16 L-41 -33Z" fill="${ACCENT.coral[0]}" stroke="${C.ink}" stroke-width="2.2" stroke-linejoin="round"/>`;
  const leg = (sx: number) =>
    `<g transform="scale(${sx} 1)"><path d="M-24 -38 L-46 -5" stroke="${C.ink}" stroke-width="7" stroke-linecap="round"/><path d="M-24 -38 L-46 -5" stroke="${C.joint}" stroke-width="3.4" stroke-linecap="round"/><rect x="-57" y="-6" width="21" height="6" rx="3" fill="${C.joint}" stroke="${C.ink}" stroke-width="2"/></g>`;
  const win = `x="${f(4 - ww / 2)}" y="${f(wy - wh / 2)}" width="${ww}" height="${wh}" rx="19"`;
  return (
    `<g class="prop-ship">` +
    `<g class="ship-flame" style="transform-box:fill-box;transform-origin:50% 0"><path d="M-13 -30 C-13 -10 -6 8 0 26 C6 8 13 -10 13 -30Z" fill="#ff9a7a"/><path d="M-7 -30 C-7 -16 -3 -4 0 8 C3 -4 7 -16 7 -30Z" fill="#fff3ea"/></g>` +
    leg(1) +
    leg(-1) +
    fin(1) +
    fin(-1) +
    `<path d="M-22 -42 H22 L17 -27 H-17Z" fill="${C.joint}" stroke="${C.ink}" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<circle cx="0" cy="${cy}" r="${R}" fill="url(#kHelm)" stroke="${C.ink}" stroke-width="2.6"/>` +
    `<path d="M${f(-R + 6)} ${f(cy + 26)} Q0 ${f(cy + 36)} ${f(R - 6)} ${f(cy + 26)}" fill="none" stroke="${ACCENT.coral[0]}" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M-14 ${f(cy - R + 2)} L-19 ${f(cy - R - 10)}" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round"/><circle class="ship-beacon" cx="-20" cy="${f(cy - R - 13)}" r="4.2" fill="${ACCENT.coral[0]}" stroke="${C.ink}" stroke-width="1.8"/>` +
    `<rect x="${f(4 - ww / 2 - 3)}" y="${f(wy - wh / 2 - 3)}" width="${ww + 6}" height="${wh + 6}" rx="22" fill="${C.visorRim}" stroke="${C.ink}" stroke-width="2.2"/>` +
    `<clipPath id="${id}w"><rect ${win}/></clipPath>` +
    `<g clip-path="url(#${id}w)"><rect ${win} fill="url(#kGlass)"/>${heads}</g>` +
    `<path class="ship-glare" d="M10 ${f(wy - wh / 2 + 5)} Q${f(4 + ww / 2 - 6)} ${f(wy - wh / 2 + 4)} ${f(4 + ww / 2 - 5)} ${f(wy - 3)}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".7"/>` +
    `<rect ${win} fill="none" stroke="${C.ink}" stroke-width="1.8"/>` +
    `</g>`
  );
}

/** A dust puff for landings. Origin on the ground, centred. */
export function dust(w = 70): string {
  const lobes = [
    [-0.4, 0.13],
    [-0.2, 0.19],
    [0.02, 0.22],
    [0.24, 0.18],
    [0.42, 0.12],
  ];
  return (
    `<g class="dust" style="transform-box:fill-box;transform-origin:50% 100%">` +
    lobes
      .map(
        ([x, r]) =>
          `<circle cx="${f(x * w)}" cy="${f(-r * w * 0.55)}" r="${f(r * w * 0.55)}" fill="#c9d5e8" opacity=".55"/>`,
      )
      .join('') +
    `</g>`
  );
}

/* --------------------------------------------------------------------------- work-group props */

/** Data: a crystal rock to mine (prototype `oreRock`). */
export function ore(): string {
  return (
    `<g class="prop-ore-rock"><path d="M-24 0 C-26 -11 -18 -22 -7 -23 C2 -29 15 -24 19 -14 C26 -11 27 -3 24 0Z" fill="#3a5078" stroke="${C.ink}" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<path d="M-24 0 C-26 -11 -18 -22 -7 -23 C-3 -15 -6 -7 -2 0Z" fill="#2c4066"/>` +
    `<g class="crystals" stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round"><path d="M2 -19 L6 -35 L12 -20Z" fill="${C.litFront}"/><path d="M11 -16 L19 -27 L20 -13Z" fill="${C.litSide}"/><path d="M-10 -16 L-8 -28 L-3 -17Z" fill="${C.litFront}"/></g>` +
    `<g class="ore-spark" fill="${C.spark}">${sparkle(-14, -32, 3)}${sparkle(22, -31, 2.4)}</g></g>`
  );
}

/** Data: the cart the mined data rides in (prototype `oreCart`). */
export function cart(): string {
  return (
    `<g class="prop-ore-cart">` +
    `<g class="cart-load" stroke="${C.ink}" stroke-width="1.5" stroke-linejoin="round"><path d="M-14 -26 L-10 -38 L-5 -26Z" fill="${C.litFront}"/><path d="M-4 -26 L1 -42 L7 -26Z" fill="${C.litSide}"/><path d="M8 -26 L12 -35 L16 -26Z" fill="${C.litFront}"/></g>` +
    `<path d="M-23 -29 H23 L18 -9 H-18Z" fill="#3c527c" stroke="${C.ink}" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<rect x="-25" y="-31" width="50" height="5" rx="2" fill="${C.joint}" stroke="${C.ink}" stroke-width="1.8"/>` +
    `<path d="M-9 -23 V-13 M0 -23 V-13 M9 -23 V-13" stroke="#5d77a6" stroke-width="1.6"/>` +
    `<circle cx="-11" cy="-5" r="5.5" fill="${C.joint}" stroke="${C.ink}" stroke-width="2"/><circle cx="11" cy="-5" r="5.5" fill="${C.joint}" stroke="${C.ink}" stroke-width="2"/>` +
    `</g>`
  );
}

/** A data crate (rows of light): what the hauler carries. Centre at the origin. */
export function dataCrate(s = 20): string {
  const h = s / 2;
  return (
    `<g class="prop-data-crate"><rect x="${-h}" y="${-h}" width="${s}" height="${s}" rx="2" fill="#3c527c" stroke="${C.ink}" stroke-width="1.9"/>` +
    `<path d="M${f(-h + 4)} ${f(-h + 6)} h${f(s - 8)} M${f(-h + 4)} 0 h${f(s - 11)} M${f(-h + 4)} ${f(h - 6)} h${f(s - 9)}" stroke="${C.litFront}" stroke-width="2.2" stroke-linecap="round"/></g>`
  );
}

/**
 * Modeling: a chart easel, a posterior curve with a shaded interval and no numbers. The band
 * narrows as data arrive (`.post-band`), the evidence order of spec §2.7 rule 1.
 */
export function easel(): string {
  return (
    `<g class="prop-easel">` +
    `<path d="M-15 -34 L-21 0 M15 -34 L21 0 M0 -36 L0 -4" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/><path d="M-15 -34 L-21 0 M15 -34 L21 0 M0 -36 L0 -4" stroke="#c9905d" stroke-width="2.4" stroke-linecap="round"/>` +
    `<rect x="-26" y="-74" width="52" height="40" rx="2.5" fill="#f4f8fd" stroke="${C.ink}" stroke-width="2.2"/>` +
    `<path d="M-21 -41 H21" stroke="#8194b3" stroke-width="1.4"/>` +
    `<g class="post-band" style="transform-box:fill-box;transform-origin:50% 100%"><path d="M-12 -41 V-52 C-6 -64 6 -64 12 -52 V-41Z" fill="#2a8fb0" fill-opacity=".22"/></g>` +
    `<path class="post-curve" d="M-21 -41 C-10 -41 -8 -66 0 -66 C8 -66 10 -41 21 -41" fill="none" stroke="#1f6e8c" stroke-width="2.2" stroke-linecap="round"/>` +
    `<g class="post-dots" fill="${C.ink}"><circle cx="-9" cy="-44" r="1.6"/><circle cx="-2" cy="-44" r="1.6"/><circle cx="4" cy="-44" r="1.6"/><circle class="post-dot-new" cx="10" cy="-44" r="1.6"/></g>` +
    `</g>`
  );
}

/** Modeling: a soil probe with its readout (prototype `soilProbe`). */
export function probe(): string {
  return (
    `<g class="prop-soil-probe">` +
    `<ellipse cx="0" cy="1" rx="9" ry="2.4" fill="#0a1c38"/>` +
    `<rect x="-2" y="-40" width="4" height="41" rx="2" fill="${C.joint}" stroke="${C.ink}" stroke-width="1.7"/>` +
    `<rect x="-10" y="-44" width="20" height="5" rx="2.5" fill="${C.suitShade}" stroke="${C.ink}" stroke-width="1.8"/>` +
    `<g class="probe-readout"><rect x="4" y="-33" width="21" height="16" rx="2.5" fill="#13284a" stroke="${C.ink}" stroke-width="1.8"/>` +
    `<path class="probe-bar probe-bar-1" d="M9 -21 V-24" stroke="${C.litFront}" stroke-width="3"/><path class="probe-bar probe-bar-2" d="M14 -21 V-27" stroke="${C.litFront}" stroke-width="3"/><path class="probe-bar probe-bar-3" d="M19 -21 V-29" stroke="${C.litFront}" stroke-width="3" style="transform-box:fill-box;transform-origin:50% 100%"/></g>` +
    `<path d="M-20 0 V-15 M14 0 V-14" stroke="${C.ink}" stroke-width="1.6"/><path d="M-20 -15 L-11 -12 L-20 -9Z" fill="${ACCENT.coral[0]}" stroke="${C.ink}" stroke-width="1.3" stroke-linejoin="round"/>` +
    `</g>`
  );
}

/**
 * UI: a screen on a stand that the crew builds and paints: tiles fill in (`.scr-tile`), a map
 * stroke and a pin appear (`.scr-paint`, `.scr-pin`).
 */
export function screen(): string {
  const tiles: string[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      tiles.push(
        `<rect class="scr-tile scr-tile-${r * 4 + c}" x="${-30 + c * 15}" y="${-86 + r * 13}" width="14" height="12" fill="${r * 4 + c === 11 ? '#1d3a63' : '#4f8fc9'}"/>`,
      );
  return (
    `<g class="prop-screen">` +
    `<path d="M0 -40 V-2" stroke="${C.ink}" stroke-width="7" stroke-linecap="round"/><path d="M0 -40 V-2" stroke="${C.joint}" stroke-width="3.5"/>` +
    `<path d="M-16 0 H16" stroke="${C.ink}" stroke-width="6" stroke-linecap="round"/><path d="M-16 0 H16" stroke="${C.joint}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<rect x="-34" y="-90" width="68" height="50" rx="3" fill="#0d1d3b" stroke="${C.ink}" stroke-width="2.4"/>` +
    tiles.join('') +
    `<path class="scr-paint" d="M-24 -56 C-16 -66 -8 -54 0 -62 C8 -70 14 -60 24 -66" fill="none" stroke="${ACCENT.pink[0]}" stroke-width="3.2" stroke-linecap="round"/>` +
    `<path class="scr-pin" d="M6 -64 C1 -70 1 -75 6 -75 C11 -75 11 -70 6 -64Z" fill="${ACCENT.coral[0]}" stroke="${C.ink}" stroke-width="1.4"/>` +
    `<rect x="-34" y="-90" width="68" height="50" rx="3" fill="none" stroke="${C.ink}" stroke-width="2.4"/>` +
    `</g>`
  );
}

/** A tablet with a short glyph on its screen (Home's coder: `tablet('</>')`). Centre at the origin. */
export function tablet(glyph?: string): string {
  return PROP.tablet(glyph);
}

/**
 * A small chart card to hold up (Home's data person, held with `astronaut(…, { held: chartCard() })`):
 * a card with bars and a trend line, no numbers. Centre at the origin.
 */
export function chartCard(): string {
  return (
    `<g class="prop-chart-card"><rect x="-13" y="-11" width="26" height="22" rx="2.5" fill="#f4f8fd" stroke="${C.ink}" stroke-width="1.9"/>` +
    `<path d="M-9 7 H9" stroke="#8194b3" stroke-width="1.2"/>` +
    `<path d="M-6.5 7 V2 M-1.5 7 V-1 M3.5 7 V0.5 M8 7 V-3.5" stroke="#2a8fb0" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M-8 -3 L-3 -6 L2 -4 L8 -8" fill="none" stroke="${ACCENT.coral[0]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>`
  );
}

/**
 * The workbench beside a seated figure of `castId` (the bench `hammerUp`, `hammerHit` and `inspect`
 * draw themselves): `block` false leaves it bare, `lit` lights the block.
 */
export function workbench(
  castId: CastId,
  opt: { block?: boolean; lit?: boolean } = {},
): string {
  return workCrate(geom(castId), opt.block !== false, !!opt.lit);
}

/* --------------------------------------------------------------------------------- the board */

/** The Merge wall: blocks of finished work with one socket. Origin at the wall's bottom left. */
export function wall(
  cols = 6,
  rows = 4,
  s = 20,
  hole: [number, number] = [3, 1],
  opt: { lit?: boolean } = {},
): string {
  let cells = '';
  const gap = 3;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * (s + gap);
      const y = -(rows - r) * (s + gap);
      if (c === hole[0] && r === hole[1]) {
        cells += `<rect class="wall-socket" x="${x}" y="${y}" width="${s}" height="${s}" rx="2" fill="#030a16" stroke="${ION}" stroke-opacity=".55" stroke-width="1.4" stroke-dasharray="3 2.5"/>`;
      } else {
        cells += `<rect class="wall-cell wall-cell-${r}-${c}" x="${x}" y="${y}" width="${s}" height="${s}" rx="2" fill="${opt.lit ? '#5fb4dc' : '#2a4a74'}" stroke="${C.ink}" stroke-width="1.6"/>`;
      }
    }
  }
  const w = cols * (s + gap) - gap;
  const h = rows * (s + gap) - gap;
  return (
    `<g class="prop-wall">` +
    `<ellipse class="wall-glow" cx="${w / 2}" cy="${-h / 2}" rx="${w * 0.95}" ry="${h * 0.95}" fill="url(#kMoonGlow)"${opt.lit ? '' : ' opacity="0"'}/>` +
    `<rect x="-6" y="${-h - 9}" width="${w + 12}" height="${h + 9}" rx="3" fill="#0f2442" stroke="${C.ink}" stroke-width="2"/>` +
    cells +
    `<g class="wall-shine" opacity="0"><rect x="-6" y="${-h - 9}" width="${w + 12}" height="${h + 9}" rx="3" fill="${C.litFront}" opacity=".22"/>` +
    `<g fill="${C.spark}">${sparkle(-12, -h - 12, 5)}${sparkle(w + 12, -h + 6, 4)}${sparkle(w / 2, -h - 22, 4.5)}${sparkle(w * 0.2, -h - 18, 3)}</g></g>` +
    `</g>`
  );
}

/* ----------------------------------------------------------------------------------- bubbles */

const BICON = {
  dots: `<g fill="#3d5478"><circle cx="-7" cy="0" r="2.4"/><circle cx="0" cy="0" r="2.4"/><circle cx="7" cy="0" r="2.4"/></g>`,
  check: `<path d="M-6 0 L-1.5 4.5 L7 -4.5" fill="none" stroke="#1a7f37" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  q: `<text x="0" y="5.5" text-anchor="middle" font-weight="700" font-size="16" fill="#3d5478">?</text>`,
  heart: `<path d="M0 5 C-8 0 -8 -6 -3.5 -6 C-1.5 -6 0 -4.5 0 -3 C0 -4.5 1.5 -6 3.5 -6 C8 -6 8 0 0 5Z" fill="${ACCENT.coral[0]}"/>`,
  chart: `<g fill="#2a8fb0"><rect x="-8" y="0" width="4" height="5"/><rect x="-2" y="-4" width="4" height="9"/><rect x="4" y="-7" width="4" height="12" fill="${ACCENT.coral[0]}"/></g>`,
  wave: `<path d="M-5 5 C-8 1 -7 -4 -4 -6 M-1 4 V-6 M3 4 V-5 M7 5 V-3" fill="none" stroke="#3d5478" stroke-width="2.2" stroke-linecap="round"/>`,
} as const;

export type BubbleIcon = keyof typeof BICON;

let measure = (t: string, size: number) => t.length * size * 0.54; // build-time; browsers swap in canvas

/** Swap the text measure (a canvas measureText in the browser, once fonts are ready). */
export function setMeasure(fn: (text: string, size: number) => number): void {
  measure = fn;
}

export interface BubbleOptions {
  /** text size in scene units (≥ 13 px as drawn) */
  size?: number;
  /** 'l' points down-left, 'r' down-right, 'c' straight down */
  tail?: 'l' | 'r' | 'c';
  /** gap between the tail's tip and the helmet top */
  lift?: number;
  cls?: string;
  hidden?: boolean;
}

/**
 * A speech bubble in scene space (1 unit ≈ 1 CSS px), anchored to a speaker's helmet top (x, y),
 * e.g. rig.ts `anchors().headTop`: the tail's tip lands within a few units of it. `content` is text
 * or an icon key (dots, check, q, heart, chart, wave).
 */
export function bubble(
  x: number,
  y: number,
  content: string,
  opt: BubbleOptions = {},
): string {
  const size = opt.size || 14;
  const icon = (BICON as Record<string, string>)[content];
  const w = icon ? 34 : Math.ceil(measure(content, size) + 22);
  const h = icon ? 24 : size + 14;
  const tail = opt.tail || 'l';
  const lift = opt.lift ?? 8;
  // the bubble sits up and to one side, so the tail points back at the helmet
  const bx = tail === 'l' ? x - 6 + w / 2 : tail === 'r' ? x + 6 - w / 2 : x;
  const by = y - lift - 7 - h / 2;
  const tx = tail === 'l' ? -w / 2 + 9 : tail === 'r' ? w / 2 - 9 : 2;
  const tip = [
    tail === 'l' ? -w / 2 + 3 : tail === 'r' ? w / 2 - 3 : 0,
    h / 2 + 7,
  ];
  const d =
    `M${f(-w / 2 + 5)} ${-h / 2} H${f(w / 2 - 5)} Q${w / 2} ${-h / 2} ${w / 2} ${f(-h / 2 + 5)} V${f(h / 2 - 5)} Q${w / 2} ${h / 2} ${f(w / 2 - 5)} ${h / 2} ` +
    (tail === 'l'
      ? `H${f(tx + 5)} L${f(tip[0])} ${f(tip[1])} L${f(tx - 3)} ${h / 2} H${f(-w / 2 + 5)}`
      : tail === 'r'
        ? `H${f(tx + 3)} L${f(tip[0])} ${f(tip[1])} L${f(tx - 5)} ${h / 2} H${f(-w / 2 + 5)}`
        : `H${f(tx + 3)} L${f(tip[0])} ${f(tip[1])} L${f(tx - 7)} ${h / 2} H${f(-w / 2 + 5)}`) +
    ` Q${-w / 2} ${h / 2} ${-w / 2} ${f(h / 2 - 5)} V${f(-h / 2 + 5)} Q${-w / 2} ${-h / 2} ${f(-w / 2 + 5)} ${-h / 2}Z`;
  const inner =
    icon ||
    `<text x="0" y="${f(size * 0.36)}" text-anchor="middle" font-size="${size}" font-weight="600" fill="#132746">${content}</text>`;
  return (
    `<g class="bubble ${opt.cls || ''}" transform="translate(${f(bx)} ${f(by)})"${opt.hidden ? ' opacity="0"' : ''}>` +
    `<g class="bubble-pop" style="transform-box:fill-box;transform-origin:${tail === 'l' ? '0% 100%' : tail === 'r' ? '100% 100%' : '50% 100%'}">` +
    `<path d="${d}" fill="#f4f8fd" stroke="${C.ink}" stroke-width="2" stroke-linejoin="round"/>${inner}</g></g>`
  );
}

/** A thought trail of three dots rising from a helmet top toward the upper right. */
export function thought(x: number, y: number, cls = ''): string {
  return `<g class="thought ${cls}" fill="#f4f8fd" stroke="${C.ink}" stroke-width="1.6"><circle cx="${f(x + 8)}" cy="${f(y - 6)}" r="2.4"/><circle cx="${f(x + 14)}" cy="${f(y - 14)}" r="3.4"/><circle cx="${f(x + 22)}" cy="${f(y - 24)}" r="4.6"/></g>`;
}

/* ----------------------------------------------------------------------------------- avatars */

/**
 * A GitHub-style avatar: a helmet head in a circle (figures under 40 px: helmet, visor, face only).
 * `ring` is the circle's edge (GitHub's #30363d by default); `bg` the circle's fill.
 */
export function avatar(
  castId: CastId,
  r = 10,
  ring = '#30363d',
  opt: { bg?: string; id?: string } = {},
): string {
  const id = opt.id ?? `av-${castId}-${f(r)}`.replace('.', '_');
  const bg = opt.bg ?? '#21324f';
  return `<g class="avatar"><clipPath id="${id}"><circle r="${r}"/></clipPath><circle r="${r}" fill="${bg}"/><g clip-path="url(#${id})"><g transform="translate(-1 ${f(r * 0.3)}) scale(${f(r / 27)})">${helmet(castId, 'smile', { noAntenna: true })}</g></g><circle r="${r}" fill="none" stroke="${ring}" stroke-width="1"/></g>`;
}

/** Seeded confetti (pass `mulberry32(SEED)` from rng.ts): small squares and dots in the accents. */
export function confetti(
  n: number,
  rnd: () => number,
  w = 120,
  h = 60,
): string {
  const cols = [
    ACCENT.coral[0],
    ACCENT.pink[0],
    ACCENT.royal[0],
    C.litFront,
    '#f2f8ff',
  ];
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = f((rnd() - 0.5) * w);
    const y = f(-rnd() * h);
    const c = cols[i % cols.length];
    s +=
      i % 2
        ? `<rect x="${x}" y="${y}" width="4" height="4" fill="${c}" transform="rotate(${f(rnd() * 90)} ${x} ${y})"/>`
        : `<circle cx="${x}" cy="${y}" r="2.2" fill="${c}"/>`;
  }
  return s;
}
