/** Glyph drawings for the figure kit (site redesign spec §2.6, #454). `Glyph.astro` renders them
 * as one sprite per page. Each entry is [width, height] in px at its natural size and an SVG body.
 */
import { ENC, STUD_RADIUS } from '../../graphics/encoding';
import { studSvg } from './svg';

export const GLYPHS = {
  'stud-sm': [16, 16],
  'stud-md': [16, 16],
  'stud-lg': [16, 16],
  'stud-radius': [18, 18],
  hex: [18, 18],
  'vsup-wedge': [60, 22],
  'hex-land': [18, 18],
  hatch: [18, 18],
  prior: [18, 18],
  gate: [18, 18],
  future: [18, 18],
  cursor: [20, 20],
  readout: [24, 20],
  'issue-card': [24, 20],
  pr: [20, 20],
  speech: [22, 20],
  'scale-earth': [40, 40],
  'scale-population': [40, 40],
  'scale-chromosome': [40, 40],
  'scale-cell': [40, 40],
} as const;
export type GlyphName = keyof typeof GLYPHS;

// A flat-top hexagon of radius r centred on (cx, cy).
const hex = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k;
    return `${k ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join('') + 'Z';
// 45° hatch strokes on the figures' pitch: lines x + y = c, c stepping pitch × √2, across the hexagon.
const hatchStrokes = () =>
  [-2, -1, 0, 1, 2]
    .map((k) => {
      const c = 18 + k * ENC.hatchPitch * Math.SQRT2;
      return `M${(c + 2).toFixed(2)} -2L${(c - 20).toFixed(2)} 20`;
    })
    .join('');
// The canvas's and the poster's stud: a white disc on a 1.5 px void ring.
const stud = (r: number, centre = 8) => studSvg(centre, centre, r);
const wedge = () => {
  const rows = [ENC.mean, ENC.meanPartial, [ENC.meanWeak]];
  const width = 60;
  return rows
    .map((row, index) => {
      const w = width / row.length;
      return row
        .map(
          (colour, k) =>
            `<rect x="${(k * w).toFixed(2)}" y="${index * 7.5}" width="${(w - (row.length > 1 ? 1 : 0)).toFixed(2)}" height="6.5" fill="${colour}"/>`,
        )
        .join('');
    })
    .join('');
};

export const GLYPH_SYMBOLS: Record<GlyphName, string> = {
  'stud-sm': stud(STUD_RADIUS.sm),
  'stud-md': stud(STUD_RADIUS.md),
  'stud-lg': stud(STUD_RADIUS.lg),
  'stud-radius': `<circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--enc-obs-radius)" stroke-dasharray="2 2"/>${stud(STUD_RADIUS.md, 9)}`,
  hex: `<path d="${hex(9, 9, 8)}" fill="var(--enc-mean-4)"/>`,
  'vsup-wedge': wedge(),
  'hex-land': `<path d="${hex(9, 9, 8)}" fill="var(--enc-land)" stroke="rgb(165 185 211 / 35%)" stroke-width=".8"/>`,
  hatch: `<path d="${hex(9, 9, 8)}" fill="var(--enc-land)"/><clipPath id="glyph-hatch-clip"><path d="${hex(9, 9, 8)}"/></clipPath><path clip-path="url(#glyph-hatch-clip)" d="${hatchStrokes()}" stroke="var(--enc-hatch)" stroke-opacity="${ENC.hatchAlpha}" stroke-width="${ENC.hatchWidth}"/>`,
  prior: `<path d="${hex(9, 9, 8)}" fill="var(--enc-mean-4)" fill-opacity="${ENC.priorBaseAlpha}"/><g fill="color-mix(in srgb, var(--enc-mean-4), white ${Math.round(ENC.priorMix * 100)}%)"><circle cx="6" cy="6" r="1.1"/><circle cx="12" cy="6" r="1.1"/><circle cx="9" cy="9" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/></g>`,
  gate: `<rect x="4" y="4" width="10" height="10" transform="rotate(45 9 9)" fill="rgb(244 200 106 / 12%)" stroke="var(--enc-gate)" stroke-width="1.4"/><path d="M6 9.2l2.1 2.1L12.2 7" fill="none" stroke="var(--enc-gate)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  future: `<path d="${hex(9, 9, 7.5)}" fill="none" stroke="var(--color-genome)" stroke-width="1.4" stroke-dasharray="2.5 2"/>`,
  cursor: `<path d="M5 3l11 6.5-5 1.2-2.6 4.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`,
  readout: `<rect x="2.5" y="3" width="19" height="14" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 8h8M6 12h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M15 12h3" stroke="var(--enc-mean-4)" stroke-width="2.4"/>`,
  'issue-card': `<rect x="2.5" y="3" width="19" height="14" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="7" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M11 8h7M6 13h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
  pr: `<circle cx="5" cy="4.5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5" cy="15.5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="15" cy="15.5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 6.5v7M15 13.5V8a3 3 0 0 0-3-3H9.5m1.8-2-2 2 2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  speech: `<path d="M3 4.5h16v9H10l-4 3.5v-3.5H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  'scale-earth': `<circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 20h30M20 5c6 4.5 6 25.5 0 30M20 5c-6 4.5-6 25.5 0 30" fill="none" stroke="currentColor" stroke-width="1" opacity=".55"/>`,
  'scale-population': `<circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity=".55"/><circle cx="14" cy="16" r="2.4" fill="currentColor"/><circle cx="23" cy="13" r="2.4" fill="currentColor"/><circle cx="25" cy="24" r="2.4" fill="currentColor"/><circle cx="15" cy="26" r="2.4" fill="currentColor"/>`,
  'scale-chromosome': `<path d="M14 6c-3 0-4 3-4 6v4c0 2 2 4 2 4s-2 2-2 4v4c0 3 1 6 4 6s4-3 4-6v-4c0-2-2-4-2-4s2-2 2-4v-4c0-3-1-6-4-6zM26 6c-3 0-4 3-4 6v4c0 2 2 4 2 4s-2 2-2 4v4c0 3 1 6 4 6s4-3 4-6v-4c0-2-2-4-2-4s2-2 2-4v-4c0-3-1-6-4-6z" fill="none" stroke="var(--color-genome)" stroke-width="1.4" stroke-dasharray="2.5 2"/>`,
  'scale-cell': `<ellipse cx="20" cy="20" rx="16" ry="13" fill="none" stroke="var(--color-genome)" stroke-width="1.4" stroke-dasharray="2.5 2"/><circle cx="20" cy="20" r="6.5" fill="none" stroke="var(--color-genome)" stroke-width="1.2" stroke-dasharray="2 2"/>`,
};
