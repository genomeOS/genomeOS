/** Site figure encoding, derived from the Atlas's own tokens (site redesign spec §2.2, #454).
 *
 * Measured observations are white studs; modeled values are hex cells coloured by a VSUP
 * (value-suppressing uncertainty palette): six mean steps where a survey is near, three where
 * evidence is partial, one where it is weak, and a hatch with no number where the model has no
 * support. Nothing here maps the width of a 95% range to colour (spec §6.3).
 *
 * Every colour is computed from `src/atlas/encoding-tokens.ts` through the Atlas's own
 * interpolation (`visual-encoding.ts`, linear light), so the marketing marks and `/app/` agree.
 * No DOM, no Cesium: Astro frontmatter, islands and tests all import it.
 */

import {
  OBSERVATION_SOLID,
  PRIOR_DOTS,
  UNKNOWN_HATCH,
} from '../atlas/encoding-tokens';
import {
  colorAtPosition,
  colorAtStops,
  normalizedValue,
  type MetricDomain,
} from '../atlas/visual-encoding';

export type EvidenceTier = 'strong' | 'partial' | 'weak' | 'none';

/** Tier limits in units of the artifact's `correlation_range_km` (ρ). */
export const TIER_LIMITS = { strong: 0.25, partial: 1, weak: 2 } as const;

/** Six equal bins over the artifact's posterior-mean domain. */
export const MEAN_BINS = 6;

/** The genome palette is sampled on this sub-range: floor 4.0:1 on void, top clear of aurora. */
const MEAN_T = [0.22, 0.8] as const;
const FOG = '#3d4a5c';
const LAND = '#112a4b';

const mean = Array.from({ length: MEAN_BINS }, (_, index) =>
  colorAtPosition(
    'genome',
    MEAN_T[0] + ((MEAN_T[1] - MEAN_T[0]) * index) / (MEAN_BINS - 1),
  ),
);
const towardFog = (colour: string, amount: number) =>
  colorAtStops([colour, FOG], amount);

/** The site's data colours. Data colours never style UI chrome, and text never takes one. */
export const ENC = {
  /** Measured survey stud (the Atlas's default observation colour). */
  obs: OBSERVATION_SOLID,
  /** Stated location radius, drawn as a 1 px dashed ring. */
  obsRadius: 'rgb(244 251 255 / 45%)',
  /** Model grid footprint with no value drawn. */
  land: LAND,
  /** Strong evidence: six mean steps. */
  mean,
  /** Partial evidence: steps 2, 4 and 6, mixed 45% toward fog (three value steps). */
  meanPartial: [1, 3, 5].map((index) => towardFog(mean[index], 0.45)),
  /** Weak evidence: one colour, no value resolution. */
  meanWeak: towardFog(mean[3], 0.8),
  /** The suppression endpoint; never drawn alone. */
  fog: FOG,
  /** Evidence layer: a survey within 0.25ρ, 1ρ, 2ρ (light = close). Floor 3.7:1 on void. */
  evidence: ['#c3d0e0', '#8693a8', '#5a6b84'],
  /** `unknown` support: hatch strokes over land, no number. */
  hatch: UNKNOWN_HATCH.color,
  hatchAlpha: UNKNOWN_HATCH.alpha,
  /** `prior_dominated` support: dots mixed this far toward white on a 46% base. */
  priorMix: PRIOR_DOTS.highlightMix,
  priorBaseAlpha: PRIOR_DOTS.darkAlpha,
} as const;

/** Evidence tier for a distance to the nearest survey. Beyond 2ρ there is no estimate. */
export function tier(distanceKm: number, rhoKm: number): EvidenceTier {
  if (distanceKm <= TIER_LIMITS.strong * rhoKm) return 'strong';
  if (distanceKm <= TIER_LIMITS.partial * rhoKm) return 'partial';
  if (distanceKm <= TIER_LIMITS.weak * rhoKm) return 'weak';
  return 'none';
}

/** Which of the six equal bins a posterior mean falls in. */
export function meanBin(value: number, domain: MetricDomain): number {
  return Math.min(
    MEAN_BINS - 1,
    Math.floor(normalizedValue(value, domain) * MEAN_BINS),
  );
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
  return {
    light: colorAtStops([base, '#ffffff'], PRIOR_DOTS.highlightMix),
    dark: base,
  };
}

export type StudSize = 'sm' | 'md' | 'lg';

/** Studs are sized by alleles tested (AN): < 200, 200–1,999, ≥ 2,000. */
export const STUD_AN_STEPS = [200, 2000] as const;
/** Stud radii in CSS px, before the 1.5 px void ring. */
export const STUD_RADIUS: Record<StudSize, number> = { sm: 2, md: 3, lg: 4.25 };

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
    ...ENC.evidence.map((value, index): [string, string] => [
      `--enc-evidence-${index + 1}`,
      value,
    ]),
    ['--enc-hatch', ENC.hatch],
    ['--enc-hatch-alpha', String(ENC.hatchAlpha)],
    ['--enc-prior-mix', `${Math.round(ENC.priorMix * 100)}%`],
    ['--enc-gate', 'var(--color-signal)'],
  ];
  return `:root{${tokens.map(([name, value]) => `${name}:${value};`).join('')}}`;
}
