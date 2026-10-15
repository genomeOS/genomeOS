/** The HbS map by genotype (ruling 36, owner request 2026-10-15; round 2 spec §4.2.2; #454).
 *
 * Pressing AA, AS or SS redraws the modeled surface as that genotype's expected share of births,
 * derived from each area's modeled HbS frequency q under random mating (Hardy–Weinberg):
 *
 *   AA  (1 − q)²      usual hemoglobin
 *   AS  2q(1 − q)     sickle-cell trait
 *   SS  q²            sickle-cell disease
 *
 * Each area's 95% range goes through the same function, exactly: the image of [lo, hi]. Every
 * transform is monotone for q < 0.5 (the pinned data stay below 0.28), so the range's ends map to
 * the range's ends; for AA, which falls as q rises, they swap. This is a derived surface: it is
 * computed here from the published model's q, never fitted, and never applied to a survey (surveys
 * hold allele counts, not genotype counts; AGENTS.md: observations and surfaces stay apart).
 *
 * The threshold control applies to the share shown, with stops chosen per genotype from the data
 * so no stop shows an empty or an all-muted map. Areas below it draw in a muted grey of their ramp
 * colour (`muteColor`), distinct from the hatch that means "no estimate".
 *
 * Pure, DOM-free and unit-tested (tests/content-projects.test.ts); the map island and the
 * server-rendered figure both use it.
 */
import { vsupColor } from '../../graphics/encoding';
import type { Area } from '../../graphics/figure-data';
import type { Genotype } from './genotype';

export type { Genotype };

export const GENOTYPE_ORDER: readonly Genotype[] = ['AA', 'AS', 'SS'];

/** The triad's names, as its buttons write them. */
export const GENOTYPE_NAME: Readonly<Record<Genotype, string>> = {
  AA: 'Usual hemoglobin',
  AS: 'Sickle-cell trait',
  SS: 'Sickle-cell disease',
};

/** The recolour when the genotype or the threshold changes, in ms (ruling 36: ≤ 300). */
export const RECOLOUR_MS = 240;

/** A genotype's expected share of births at HbS frequency q, under random mating. */
export function genotypeShare(genotype: Genotype, q: number): number {
  if (!(q >= 0 && q <= 1))
    throw new RangeError(`HbS frequency out of range: ${q}`);
  if (genotype === 'AA') return (1 - q) ** 2;
  if (genotype === 'AS') return 2 * q * (1 - q);
  return q * q;
}

/** The exact image of the frequency range [lo, hi] as a genotype's share of births. */
export function shareInterval(
  genotype: Genotype,
  lo: number,
  hi: number,
): [number, number] {
  if (!(lo <= hi))
    throw new RangeError(`range ends out of order: ${lo}, ${hi}`);
  const [a, b] = [genotypeShare(genotype, lo), genotypeShare(genotype, hi)];
  // AS peaks at q = 0.5: a range across it reaches 0.5 inside, not at an end.
  const peak = genotype === 'AS' && lo < 0.5 && hi > 0.5 ? 0.5 : -Infinity;
  return [Math.min(a, b), Math.max(a, b, peak)];
}

/** An area as the genotype's expected share of births; an area with no estimate keeps none. */
export function genotypeArea(area: Area, genotype: Genotype): Area {
  if (area.mean === null || area.lo === null || area.hi === null)
    return { ...area, mean: null, lo: null, hi: null };
  const [lo, hi] = shareInterval(genotype, area.lo, area.hi);
  return { ...area, mean: genotypeShare(genotype, area.mean), lo, hi };
}

/** The colour ramp's domain for a genotype: the model's frequency domain, transformed. */
export function genotypeDomain(
  genotype: Genotype,
  [lo, hi]: readonly [number, number],
): [number, number] {
  return shareInterval(genotype, lo, hi);
}

/** A ramp's range for its legend, in whole percent that contain it: "0–29%", "68–100%". */
export const rangeLabel = ([lo, hi]: readonly [number, number]): string =>
  `${Math.floor(lo * 100)}–${Math.ceil(hi * 100)}%`;

const steps = (count: number, first: number, step: number) =>
  Array.from({ length: count }, (_, index) =>
    Number((first + index * step).toFixed(1)),
  );

/**
 * Threshold stops in percent of births, per genotype, twenty each so the slider keeps its size.
 * Chosen from the pinned data so every stop leaves some areas above and some muted below: AS spans
 * 0–29%, SS stays under 3%, and AA sits between 68% and 100%.
 */
export const THRESHOLD_STOPS: Readonly<Record<Genotype, readonly number[]>> = {
  AA: steps(20, 80, 1),
  AS: steps(20, 1, 1),
  SS: steps(20, 0.1, 0.1),
};

/**
 * Where each genotype's slider starts: AS 10% (about q = 5%, where round 2's map rested), SS 0.5%
 * (one birth in 200) and AA 90%.
 */
export const DEFAULT_STOP: Readonly<Record<Genotype, number>> = {
  AA: 90,
  AS: 10,
  SS: 0.5,
};

/** A stop as written: "10", "0.5", "1". */
export const stopText = (stop: number): string =>
  String(Number(stop.toFixed(1)));

/** The threshold control's label, true for the measure shown. */
export const thresholdLabel = (genotype: Genotype, stop: number): string =>
  `Show areas where ${stopText(stop)}% or more of births are ${genotype}`;

/* ---------- the muted state ---------- */

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (linear: number) => {
  const c =
    linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};
const rgbOf = (hex: string) =>
  [1, 3, 5].map((at) => toLinear(Number.parseInt(hex.slice(at, at + 2), 16)));

/** The muted state's floor: a dark, neutral grey the band's navy reads through. */
const MUTE_FLOOR = rgbOf('#161b22');
/** How much of a colour's own lightness survives muting (linear light). */
export const MUTE_KEEP = 0.3;

/**
 * A ramp colour, muted: its lightness kept at MUTE_KEEP in linear light, its hue and chroma gone,
 * over a dark neutral floor. Lighter ramp steps stay lighter greys, so the hidden ramp still reads
 * faintly; every grey sits well below the hatch's light strokes.
 */
export function muteColor(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return `#${MUTE_FLOOR.map((floor) =>
    toSrgb(floor + (y - floor) * MUTE_KEEP)
      .toString(16)
      .padStart(2, '0'),
  ).join('')}`;
}

/**
 * How an area paints at share threshold t: its ramp colour for the genotype's domain (VSUP by
 * evidence, encoding.ts), muted below t; no fill at all where there is no estimate (the hatch).
 */
export function areaFill(
  area: Area,
  t: number,
  domain: readonly [number, number],
): { fill: string | null; muted: boolean } {
  if (area.support === 'unknown' || area.mean === null)
    return { fill: null, muted: false };
  const ramp = vsupColor(
    area.mean,
    area.tier === 'none' ? 'weak' : area.tier,
    domain,
  );
  if (ramp === null) return { fill: null, muted: false };
  const muted = area.mean < t;
  return { fill: muted ? muteColor(ramp) : ramp, muted };
}
