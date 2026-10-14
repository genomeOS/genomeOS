/** Seeded randomness for figure motion (site redesign spec §2.7 rule 7, #454).
 *
 * Any staggered or jittered order in a figure draws from mulberry32 seeded with SEED, so a figure
 * plays the same way on every load and in every screenshot (AGENTS.md: SEED = 42).
 */

export const SEED = 42;

/** mulberry32: a 32-bit generator returning floats in [0, 1). */
export function mulberry32(seed: number = SEED): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic jitter in [-amount, amount] for each of `count` items. */
export function jitter(count: number, amount: number, seed = SEED): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => (random() * 2 - 1) * amount);
}
