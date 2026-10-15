/** Site figure encoding, derived from the Atlas's own tokens (site redesign spec §2.2, #454).
 *
 * Measured observations are white studs; modeled values are hex cells coloured by a VSUP
 * (value-suppressing uncertainty palette): six mean steps where a survey is near, three where
 * evidence is partial, one where it is weak, and a hatch with no number where the model has no
 * support. Nothing here maps the width of a 95% range to colour (spec §6.3).
 *
 * Every value is derived from `src/atlas/encoding-tokens.ts` through the Atlas's own
 * interpolation (`visual-encoding.ts`, linear light), so the marketing marks and `/app/` agree.
 * The derivation runs at build time, in `tests/encoding-tokens.test.ts`, which recomputes every
 * colour and number below from those two modules and fails on any drift. The values are written
 * out here so the islands that import this module ship no Atlas colour code (spec §7 JS budgets).
 * No DOM, no Cesium, no runtime import: Astro frontmatter, islands and tests all import it.
 */

import type { MetricDomain } from '../atlas/visual-encoding';

export type EvidenceTier = 'strong' | 'partial' | 'weak' | 'none';

/** Tier limits in units of the artifact's `correlation_range_km` (ρ). */
export const TIER_LIMITS = { strong: 0.25, partial: 1, weak: 2 } as const;

/** Six equal bins over the artifact's posterior-mean domain. */
export const MEAN_BINS = 6;

/** The genome palette is sampled on this sub-range: floor 4.0:1 on void, top clear of aurora. */
export const MEAN_T = [0.22, 0.8] as const;
/** Partial evidence keeps steps 2, 4 and 6, mixed this far toward fog; weak keeps step 4, mixed
 * further. */
export const PARTIAL_STEPS = [1, 3, 5] as const;
export const PARTIAL_FOG_MIX = 0.45;
export const WEAK_STEP = 3;
export const WEAK_FOG_MIX = 0.8;

/** `colorAtPosition('genome', t)` on MEAN_T, six even steps (derived; see the module note). */
const mean: readonly string[] = [
  '#1c7796',
  '#218eb1',
  '#25a2c8',
  '#39b3ce',
  '#4dc3cb',
  '#5dd1c7',
];

/** The site's data colours. Data colours never style UI chrome, and text never takes one. */
export const ENC = {
  /** Measured survey stud (the Atlas's default observation colour, `OBSERVATION_SOLID`). */
  obs: '#f4fbff',
  /** Stated location radius, drawn as a 1 px dashed ring. */
  obsRadius: 'rgb(244 251 255 / 45%)',
  /** Model grid footprint with no value drawn. */
  land: '#112a4b',
  /** Strong evidence: six mean steps. */
  mean,
  /** Partial evidence: steps 2, 4 and 6, mixed 45% toward fog (three value steps). */
  meanPartial: ['#307693', '#3b90a7', '#50a6a2'] as readonly string[],
  /** Weak evidence: one colour, no value resolution (step 4, mixed 80% toward fog). */
  meanWeak: '#3c6a7e' as string,
  /** The suppression endpoint; never drawn alone. */
  fog: '#3d4a5c',
  /** Evidence layer: a survey within 0.25ρ, 1ρ, 2ρ (light = close). Floor 3.7:1 on void. */
  evidence: ['#c3d0e0', '#8693a8', '#5a6b84'],
  /** `unknown` support: hatch strokes over land, no number (`UNKNOWN_HATCH`). */
  hatch: '#a8b5c9',
  hatchAlpha: 0.72,
  /** Hatch geometry, the same on the canvas, the poster and the legend glyph: 45° strokes this
   * wide, this far apart (px at 1 unit per px). */
  hatchWidth: 1.4,
  hatchPitch: 5,
  /** `prior_dominated` support: dots mixed this far toward white on a 46% base (`PRIOR_DOTS`). */
  priorMix: 0.38,
  priorBaseAlpha: 0.46,
} as const;

/**
 * The light prior dot of every colour a cell can take: the colour mixed `ENC.priorMix` toward
 * white in linear light, as the Atlas `Dot` material does (derived; see the module note).
 */
export const PRIOR_LIGHT: Readonly<Record<string, string>> = {
  '#1c7796': '#a7bbc7',
  '#218eb1': '#a8c3d3',
  '#25a2c8': '#a8ccdf',
  '#39b3ce': '#abd4e2',
  '#4dc3cb': '#afdce1',
  '#5dd1c7': '#b2e4de',
  '#307693': '#a9bac5',
  '#3b90a7': '#abc4ce',
  '#50a6a2': '#afcecc',
  '#3c6a7e': '#abb6bd',
  '#c3d0e0': '#dce3ec',
  '#8693a8': '#c0c5cf',
  '#5a6b84': '#b2b7bf',
};

/** Evidence tier for a distance to the nearest survey. Beyond 2ρ there is no estimate. */
export function tier(distanceKm: number, rhoKm: number): EvidenceTier {
  if (distanceKm <= TIER_LIMITS.strong * rhoKm) return 'strong';
  if (distanceKm <= TIER_LIMITS.partial * rhoKm) return 'partial';
  if (distanceKm <= TIER_LIMITS.weak * rhoKm) return 'weak';
  return 'none';
}

/** Which of the six equal bins a posterior mean falls in. */
export function meanBin(value: number, [lower, upper]: MetricDomain): number {
  // visual-encoding's normalizedValue: position in the domain, clamped to [0, 1].
  const position =
    lower === upper
      ? 0
      : Math.min(1, Math.max(0, (value - lower) / (upper - lower)));
  return Math.min(MEAN_BINS - 1, Math.floor(position * MEAN_BINS));
}

/** VSUP fill for a modeled cell; null where there is no estimate (draw the hatch). */
export function vsupColor(
  value: number,
  evidence: EvidenceTier,
  domain: MetricDomain,
): string | null {
  if (evidence === 'none') return null;
  if (evidence === 'weak') return ENC.meanWeak;
  const bin = meanBin(value, domain);
  return evidence === 'strong'
    ? ENC.mean[bin]
    : ENC.meanPartial[Math.floor(bin / 2)];
}

/** Evidence-layer fill; null where there is no estimate. */
export function evidenceColor(evidence: EvidenceTier): string | null {
  if (evidence === 'none') return null;
  return ENC.evidence[['strong', 'partial', 'weak'].indexOf(evidence)];
}

/** The Atlas `Dot` material's two colours for a prior-dominated cell of palette colour `base`. */
export function priorColors(base: string): { light: string; dark: string } {
  const light = PRIOR_LIGHT[base];
  if (!light) throw new Error(`no prior dot colour for ${base}`);
  return { light, dark: base };
}

export type StudSize = 'sm' | 'md' | 'lg';

/** Studs are sized by alleles tested (AN): < 200, 200–1,999, ≥ 2,000. */
export const STUD_AN_STEPS = [200, 2000] as const;
/** Stud radii in CSS px: the white disc, inside its void ring. */
export const STUD_RADIUS: Record<StudSize, number> = { sm: 2, md: 3, lg: 4.25 };
/** Every stud's separating ring: this many px of void around the white disc (spec §2.2). */
export const STUD_RING = 1.5;
/**
 * The order the canvas and the poster paint studs in: one size class at a time, small to large,
 * all of a class's void rings before its white discs. Surveys at one place then read as the
 * largest white stud, and studs of one size merge instead of ringing each other.
 */
export const STUD_PAINT_ORDER: readonly StudSize[] = ['sm', 'md', 'lg'];

export function studSize(an: number): StudSize {
  if (an < STUD_AN_STEPS[0]) return 'sm';
  return an < STUD_AN_STEPS[1] ? 'md' : 'lg';
}

/** The `:root` block `EncodingStyle.astro` puts in every SiteLayout head. */
export function encodingCss(): string {
  const tokens: [string, string][] = [
    ['--enc-obs', ENC.obs],
    ['--enc-obs-ring', 'var(--color-void)'],
    ['--enc-obs-radius', ENC.obsRadius],
    ['--enc-land', ENC.land],
    ...ENC.mean.map((value, index): [string, string] => [
      `--enc-mean-${index + 1}`,
      value,
    ]),
    ...ENC.meanPartial.map((value, index): [string, string] => [
      `--enc-mean-partial-${index + 1}`,
      value,
    ]),
    ['--enc-mean-weak', ENC.meanWeak],
    ['--enc-fog', ENC.fog],
    ['--enc-hatch', ENC.hatch],
    ['--enc-hatch-alpha', String(ENC.hatchAlpha)],
    ['--enc-prior-mix', `${Math.round(ENC.priorMix * 100)}%`],
    ['--enc-gate', 'var(--color-signal)'],
  ];
  return `:root{${tokens.map(([name, value]) => `${name}:${value};`).join('')}}`;
}
