/** The working groups' vignettes (site redesign spec §4.3 C2, #454): one small picture per group,
 * drawn in the Atlas's own marks, with no words in the art (the card carries the meaning).
 *
 *   data       a highlighted table cell flies along a dotted path and lands as a stud with its
 *              location ring on an abstract patch of land (footprint only, no values), then a
 *              versioned stack gains a plate
 *   modeling   around the same five studs, modeled cells fade in outward by distance, the far edge
 *              hatched (no estimate); a small posterior density with a shaded 95% band, no axis
 *              numbers, links to one cell
 *   ui         the same surface in an interface frame; a cursor visits a cell and a readout shows
 *              a range bar with no number; future work (an "ask" bubble, a lock) fades in last,
 *              in violet dashed outline
 *
 * The patch is abstract (no coastline, no real place) and computed here at build time: the
 * same seeded shape and the same five studs in every vignette. Fills come from the site's
 * encoding (`graphics/encoding.ts`): VSUP by distance to the nearest stud, a hatch with no colour
 * beyond the weak tier, white studs on a void ring, drawn last. Pure and deterministic; no DOM.
 */

import {
  ENC,
  STUD_RING,
  vsupColor,
  type EvidenceTier,
} from '../../graphics/encoding';
import { cssVarStyles, studSvg } from '../kit/svg';

export type VignetteKind = 'data' | 'modeling' | 'ui';

export const VIGNETTE_SIZE = { width: 320, height: 200 } as const;

/** The five measured samples every vignette shares, and their (illustrative) frequencies. */
const STUDS: readonly [number, number][] = [
  [118, 96],
  [152, 82],
  [136, 126],
  [178, 112],
  [100, 132],
];
const VALUES = [0.11, 0.07, 0.13, 0.05, 0.09];
const DOMAIN = [0, 0.14] as const;
/** Distance limits (units) for the strong, partial and weak tiers; beyond is no estimate. */
const TIERS = [16, 38, 60] as const;
const HEX = 7.4;
const STUD_R = 3.2;

const f = (value: number) => Math.round(value * 10) / 10;

/** A pointy-top hexagon's path, a little inside its pitch so cells read as cells. */
function hexPath(x: number, y: number, r = HEX - 0.7): string {
  return (
    'M' +
    Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k - Math.PI / 2;
      return `${f(x + r * Math.cos(a))} ${f(y + r * Math.sin(a))}`;
    }).join('L') +
    'Z'
  );
}

/** Cell centres inside a wobbly ellipse: an abstract patch, the same on every build. */
function patch(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
): [number, number][] {
  const w = HEX * Math.sqrt(3);
  const cells: [number, number][] = [];
  for (let row = -12; row <= 12; row += 1)
    for (let col = -16; col <= 16; col += 1) {
      const x = cx + col * w + (row & 1 ? w / 2 : 0);
      const y = cy + row * HEX * 1.5;
      const angle = Math.atan2(y - cy, x - cx);
      const wobble =
        1 +
        0.14 * Math.sin(angle * 3 + seed) +
        0.08 * Math.cos(angle * 5 + seed * 2);
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= wobble * wobble)
        cells.push([x, y]);
    }
  return cells;
}

interface Modeled {
  x: number;
  y: number;
  /** Distance to the nearest stud. */
  d: number;
  tier: EvidenceTier;
  fill: string | null;
}

/** Inverse-distance surface around the studs, faded by evidence tier (VSUP). Illustrative. */
function surface(cells: [number, number][], studs = STUDS): Modeled[] {
  return cells.map(([x, y]) => {
    let weights = 0;
    let sum = 0;
    let d = Number.POSITIVE_INFINITY;
    studs.forEach(([sx, sy], index) => {
      const distance = Math.hypot(x - sx, y - sy);
      d = Math.min(d, distance);
      const weight = 1 / (distance * distance + 40);
      weights += weight;
      sum += weight * VALUES[index];
    });
    const tier: EvidenceTier =
      d <= TIERS[0]
        ? 'strong'
        : d <= TIERS[1]
          ? 'partial'
          : d <= TIERS[2]
            ? 'weak'
            : 'none';
    return { x, y, d, tier, fill: vsupColor(sum / weights, tier, DOMAIN) };
  });
}

const hatchPattern = (id: string) =>
  `<pattern id="${id}" width="${ENC.hatchPitch}" height="${ENC.hatchPitch}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
  `<rect width="${ENC.hatchPitch}" height="${ENC.hatchPitch}" fill="${ENC.land}"/>` +
  `<line x1="${ENC.hatchPitch / 2}" y1="0" x2="${ENC.hatchPitch / 2}" y2="${ENC.hatchPitch}" stroke="${ENC.hatch}" stroke-opacity="${ENC.hatchAlpha}" stroke-width="${ENC.hatchWidth}"/>` +
  `</pattern>`;

const stud = (x: number, y: number, extra = '') =>
  `<g${extra}>${studSvg(f(x), f(y), STUD_R)}</g>`;
const ring = (x: number, y: number, r: number, extra = '') =>
  `<circle${extra} cx="${f(x)}" cy="${f(y)}" r="${r}" fill="none" stroke="var(--enc-obs-radius)" stroke-width="1" stroke-dasharray="2 2"/>`;

/** Modeled cells, each fading in after a delay that grows with its distance from evidence. */
function modeledCells(cells: Modeled[], hatchId: string): string {
  return cells
    .map(
      (cell) =>
        `<path class="wg-vig__grow" style="--wg-d:${Math.round(120 + cell.d * 9)}ms" d="${hexPath(cell.x, cell.y)}" fill="${cell.fill ?? `url(#${hatchId})`}"/>`,
    )
    .join('');
}

function dataArt(): string {
  const land = patch(206, 92, 82, 56, 1.3)
    .map(([x, y]) => `<path d="${hexPath(x, y)}"/>`)
    .join('');
  // The table: a sheet behind a sheet, placeholder lines, a 3 × 4 grid with one cell lit.
  const table: string[] = [];
  for (let row = 0; row < 4; row += 1)
    for (let col = 0; col < 3; col += 1)
      table.push(
        `<rect x="${24 + col * 22}" y="${76 + row * 13}" width="19" height="9" fill="${
          row === 2 && col === 2
            ? 'rgb(112 230 255 / 78%)'
            : 'rgb(165 185 211 / 12%)'
        }"/>`,
      );
  const from = { x: 77.5, y: 106.5 };
  const to = { x: 214, y: 70 };
  const flight = `M${from.x} ${from.y}C120 40 176 26 ${to.x} ${to.y}`;
  return (
    `<g class="wg-vig__sheet">` +
    `<rect x="22" y="38" width="84" height="116" fill="var(--color-plate-raised)" stroke="rgb(165 185 211 / 22%)"/>` +
    `<rect x="14" y="46" width="84" height="116" fill="var(--color-plate-raised)" stroke="rgb(165 185 211 / 30%)"/>` +
    `<rect x="24" y="56" width="52" height="4" fill="rgb(165 185 211 / 32%)"/>` +
    `<rect x="24" y="65" width="64" height="3" fill="rgb(165 185 211 / 20%)"/>` +
    table.join('') +
    `<rect x="24" y="134" width="58" height="3" fill="rgb(165 185 211 / 20%)"/>` +
    `<rect x="24" y="142" width="44" height="3" fill="rgb(165 185 211 / 20%)"/>` +
    `</g>` +
    `<g fill="${ENC.land}" stroke="var(--color-plate)" stroke-width="1.2">${land}</g>` +
    `<path d="${flight}" fill="none" stroke="rgb(112 230 255 / 40%)" stroke-width="1.2" stroke-dasharray="2 4"/>` +
    ring(176, 110, 13) +
    ring(240, 116, 17) +
    stud(176, 110) +
    stud(240, 116) +
    ring(to.x, to.y, 14, ' class="wg-vig__ring"') +
    stud(to.x, to.y, ' class="wg-vig__land"') +
    `<rect class="wg-vig__fly" x="-9.5" y="-4.5" width="19" height="9" fill="rgb(112 230 255 / 85%)" style="offset-path: path('${flight}')"/>` +
    // The versioned stack: two plates, then a new one (ion) settles on top.
    `<g transform="translate(240 156)" fill="var(--color-plate-raised)" stroke="rgb(165 185 211 / 35%)">` +
    `<path d="M0 24l22-9h46l-22 9z"/>` +
    `<path d="M0 17l22-9h46l-22 9z"/>` +
    `<path class="wg-vig__plate" d="M0 10l22-9h46l-22 9z" stroke="var(--color-ion)"/>` +
    `</g>`
  );
}

function modelingArt(): string {
  const cells = surface(patch(140, 110, 104, 70, 1.3));
  const lit = cells.reduce((best, cell) =>
    Math.hypot(cell.x - 150, cell.y - 100) <
    Math.hypot(best.x - 150, best.y - 100)
      ? cell
      : best,
  );
  return (
    `<defs>${hatchPattern('wg-hatch-modeling')}</defs>` +
    `<g stroke="var(--color-plate)" stroke-width="1.2">${modeledCells(cells, 'wg-hatch-modeling')}</g>` +
    `<path class="wg-vig__hi" d="${hexPath(lit.x, lit.y, HEX + 0.3)}" fill="none" stroke="var(--color-starlight)" stroke-width="1.6"/>` +
    STUDS.map(([x, y]) => stud(x, y)).join('') +
    // The posterior for the lit cell: a density with its 95% band shaded, no axis numbers.
    `<path class="wg-vig__hi" d="M${f(lit.x + 7)} ${f(lit.y - 6)}L236 60" fill="none" stroke="rgb(112 230 255 / 45%)" stroke-width="1"/>` +
    `<g transform="translate(232 12)">` +
    `<rect width="76" height="54" fill="var(--color-plate-raised)" stroke="rgb(165 185 211 / 22%)"/>` +
    `<path class="wg-vig__band" d="M24 44V35C30 22 34 12 38 10C42 12 46 22 52 35V44Z" fill="${ENC.mean[3]}" fill-opacity="0.55"/>` +
    `<path class="wg-vig__draw" pathLength="1" d="M6 44C16 43 22 33 28 22C32 14 35 10 38 10C41 10 44 14 48 22C54 33 60 43 70 44" fill="none" stroke="var(--color-starlight)" stroke-width="1.5"/>` +
    `<path d="M5 44.5H71" stroke="rgb(165 185 211 / 40%)" stroke-width="1"/>` +
    `<path class="wg-vig__draw-tick" d="M38 8V44" stroke="var(--color-starlight)" stroke-opacity="0.65" stroke-width="1"/>` +
    `</g>`
  );
}

function uiArt(): string {
  const cells = surface(
    patch(122, 112, 98, 64, 1.3),
    STUDS.map(([x, y]) => [x - 10, y + 4] as [number, number]),
  );
  const target = cells.reduce((best, cell) =>
    Math.hypot(cell.x - 140, cell.y - 104) <
    Math.hypot(best.x - 140, best.y - 104)
      ? cell
      : best,
  );
  return (
    `<defs>${hatchPattern('wg-hatch-ui')}<clipPath id="wg-ui-clip"><rect x="13" y="29" width="294" height="160"/></clipPath></defs>` +
    `<rect x="12.5" y="12.5" width="295" height="177" fill="rgb(2 7 18 / 55%)" stroke="rgb(165 185 211 / 26%)"/>` +
    `<path d="M13 28.5H307" stroke="rgb(165 185 211 / 18%)"/>` +
    `<circle cx="23" cy="20.5" r="2.5" fill="rgb(165 185 211 / 40%)"/><circle cx="32" cy="20.5" r="2.5" fill="rgb(165 185 211 / 40%)"/>` +
    `<g clip-path="url(#wg-ui-clip)">` +
    `<g stroke="var(--color-plate)" stroke-width="1.2">${cells
      .map(
        (cell) =>
          `<path d="${hexPath(cell.x, cell.y)}" fill="${cell.fill ?? 'url(#wg-hatch-ui)'}"/>`,
      )
      .join('')}</g>` +
    STUDS.map(([x, y]) => stud(x - 10, y + 4)).join('') +
    `</g>` +
    `<path class="wg-vig__hi" d="${hexPath(target.x, target.y, HEX + 0.3)}" fill="none" stroke="var(--color-starlight)" stroke-width="1.6"/>` +
    `<g class="wg-vig__cursor"><path d="M${f(target.x + 2)} ${f(target.y + 1)}l0 15 4-3.8 3 6.4 2.8-1.3-3-6.3 5.6-.4z" fill="var(--color-starlight)" stroke="var(--color-void)" stroke-width="1.1" stroke-linejoin="round"/></g>` +
    // The readout: two lines of text as bars, and a range bar with its mean, no number.
    `<g class="wg-vig__pop">` +
    `<rect x="204.5" y="44.5" width="92" height="48" fill="var(--color-plate)" stroke="var(--color-line-strong)"/>` +
    `<rect x="214" y="55" width="50" height="4" fill="rgb(165 185 211 / 45%)"/>` +
    `<rect x="214" y="64" width="34" height="3" fill="rgb(165 185 211 / 28%)"/>` +
    `<rect x="214" y="78" width="72" height="4" fill="rgb(165 185 211 / 15%)"/>` +
    `<rect x="230" y="78" width="32" height="4" fill="${ENC.mean[3]}"/>` +
    `<rect x="245" y="75" width="2" height="10" fill="var(--color-starlight)"/>` +
    `</g>` +
    // Future work, last: an "ask" bubble and a lock, violet dashed (spec §6.1 rule 7).
    `<g class="wg-vig__future" fill="none" stroke="var(--color-genome)" stroke-width="1.4" stroke-dasharray="3.5 2.5">` +
    `<path d="M220.5 112.5h76v30h-50l-9 8v-8h-17z"/>` +
    `<rect x="262.5" y="164.5" width="18" height="14"/>` +
    `<path d="M266.5 164.5v-4a5 5 0 0 1 10 0v4" stroke-dasharray="none"/>` +
    `</g>`
  );
}

const ART: Record<VignetteKind, () => string> = {
  data: dataArt,
  modeling: modelingArt,
  ui: uiArt,
};

/** The vignette's inner SVG markup, with custom properties moved into `style` (kit/svg.ts). */
export function vignetteArt(kind: VignetteKind): string {
  return cssVarStyles(ART[kind]());
}

/** For tests: the modeled cells the modeling vignette draws, with their tier and fill. */
export function modelingCells(): Modeled[] {
  return surface(patch(140, 110, 104, 70, 1.3));
}

/** For tests: the stud ring width the vignettes share with every other stud. */
export const VIGNETTE_STUD = { radius: STUD_R, ring: STUD_RING } as const;
