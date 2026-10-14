/** Jeffreys 95% intervals for allele counts (site redesign spec §4.1 H2, §6.1 rule 2; #454).
 *
 * The posterior for a share after AC carriers among AN alleles, under the Jeffreys prior, is
 * Beta(AC + ½, AN − AC + ½); the equal-tailed 95% interval is its 2.5% and 97.5% quantiles, with
 * the lower bound pinned at 0 when AC = 0 and the upper at 1 when AC = AN. A zero count therefore
 * reads as "up to X% is still plausible", never as absence.
 *
 * Build and SSR only: figures receive precomputed tables, and no browser bundle fits anything.
 * A port of `tools-final/jeffreys.py` (continued fraction for the regularised incomplete beta,
 * Numerical Recipes §6.4, then bisection).
 */

function logGamma(x: number): number {
  // Lanczos approximation, g = 7, n = 9; accurate to ~1e-15 for x > 0.
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = coefficients[0];
  for (let index = 1; index < coefficients.length; index += 1)
    sum += coefficients[index] / (shifted + index);
  const t = shifted + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(sum)
  );
}

function continuedFraction(a: number, b: number, x: number): number {
  const MAX_ITERATIONS = 400;
  const EPSILON = 3e-16;
  const TINY = 1e-300;
  const guard = (value: number) => (Math.abs(value) < TINY ? TINY : value);
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 / guard(1 - (qab * x) / qap);
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 / guard(1 + aa * d);
    c = guard(1 + aa / c);
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 / guard(1 + aa * d);
    c = guard(1 + aa / c);
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

/** The regularised incomplete beta function I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2))
    return (front * continuedFraction(a, b, x)) / a;
  return 1 - (front * continuedFraction(b, a, 1 - x)) / b;
}

/** The p-quantile of Beta(a, b), by bisection. */
export function betaQuantile(p: number, a: number, b: number): number {
  let lower = 0;
  let upper = 1;
  for (let step = 0; step < 200; step += 1) {
    const middle = (lower + upper) / 2;
    if (incompleteBeta(a, b, middle) < p) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

export interface JeffreysInterval {
  /** 2.5% quantile; 0 when no allele carries the variant. */
  lo: number;
  /** Posterior mean (AC + ½) / (AN + 1). */
  mean: number;
  /** 97.5% quantile; 1 when every allele carries it. */
  hi: number;
}

/** Jeffreys 95% interval for `ac` carriers among `an` alleles (integers, 0 ≤ ac ≤ an, an > 0). */
export function jeffreys(ac: number, an: number): JeffreysInterval {
  if (!Number.isInteger(ac) || !Number.isInteger(an) || an <= 0)
    throw new Error(`counts must be integers with an > 0 (got ${ac} of ${an})`);
  if (ac < 0 || ac > an)
    throw new Error(`need 0 ≤ ac ≤ an (got ${ac} of ${an})`);
  const a = ac + 0.5;
  const b = an - ac + 0.5;
  return {
    lo: ac === 0 ? 0 : betaQuantile(0.025, a, b),
    mean: a / (an + 1),
    hi: ac === an ? 1 : betaQuantile(0.975, a, b),
  };
}
