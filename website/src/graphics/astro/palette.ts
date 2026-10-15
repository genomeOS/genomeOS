/**
 * The astronaut kit's illustration palette (round 2 spec §2.1, §3.1; R2-6; #454). Ported from the
 * design prototype (`r2/characters/kit/rig.js`, direction B refined).
 *
 * Illustration colours never encode data and never style UI chrome; data figures that draw people
 * use the `--person-*` tokens (tokens.css) for suits. The one site colour on a figure is the ion
 * rim light on each helmet's lit edge (`C.rim`), lighting only, never an outline. The accents keep
 * an OKLab ΔE of 0.12 or more from ion, aurora, genome and signal (tests/astro-kit.test.ts), so
 * none reads as a status, a link or the genome violet; they only ever cover small areas.
 */

/** Suit, ink and light. The ink is pulled toward the plate navy, so outlines sit in the site's family. */
export const C = {
  ink: '#132746',
  suit: '#eef4fb',
  suitShade: '#c2d0e3',
  joint: '#95a8c5', // gloves, boots, ear module, antenna stem
  jointShade: '#7488a8',
  visor: '#0c1b36', // glass; the face fills most of it
  visorRim: '#d9e3f1',
  rim: '#70e6ff', // --color-ion as a rim light only, never an outline
  coat: '#fbfdff',
  coatShade: '#cfdcec',
  under: '#2a3c62', // expert undersuit: dark legs and gloves under the white coat
  underShade: '#1f2e4d',
  eye: '#0f0c16',
  catch: '#f2f8ff', // --color-starlight catchlights
  mouth: '#4a1724',
  tongue: '#ff8e86',
  blush: '#ff8a80',
  // the lit work block (the unit of work) and its raw state
  blockTop: '#b9c6dc',
  blockFront: '#8193b6',
  blockSide: '#5f7197',
  litTop: '#f2fdff',
  litFront: '#bff4ff',
  litSide: '#76d6ec',
  bulb: '#fff3cf', // pale cream; far from signal gold (OKLab 0.13)
  spark: '#e6fbff',
} as const;

/** Illustration accents, [base, shade]: patches, knee pads, belts, cuffs, antenna tips, fins. */
export const ACCENT = {
  coral: ['#ff7f6e', '#d95a4a'],
  pink: ['#ff8fb1', '#dc6a8f'],
  royal: ['#3f7dff', '#2a5bd6'],
  slate: ['#5d6f95', '#45557a'],
} as const;

export type AccentName = keyof typeof ACCENT;

/**
 * Six skin tones, each [base, shade, light]: the base fills the face, the shade sits lower left
 * (away from the light), the light is the cheek and rim on the lit side.
 */
export const SKIN = {
  s1: ['#f7d9c4', '#e6b89d', '#fff0e6'],
  s2: ['#ecba93', '#d39a73', '#f8d4b6'],
  s3: ['#c98c5b', '#ab6f42', '#dfa77a'],
  s4: ['#9d6241', '#7f4a2e', '#b97c58'],
  s5: ['#6f412b', '#55301f', '#8a5639'],
  s6: ['#4e2d1f', '#3a2016', '#74472f'],
} as const;

export type SkinTone = keyof typeof SKIN;

export const HAIR = {
  black: '#1c1923',
  brown: '#3d2619',
  auburn: '#93432a',
  sandy: '#cfa877',
  silver: '#d3d8e3',
  berry: '#b34a6a', // headscarf fabric
} as const;

export type HairColor = keyof typeof HAIR;
