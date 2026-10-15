/**
 * The astronaut cast and builds (round 2 spec §3.1; R2-6; #454), ported from the design prototype
 * (`r2/characters/kit/rig.js`). Eight contributors (A1–A8) and three experts in lab coats (E1–E3).
 *
 * Cast labels describe drawings, never identities. Six skin tones; the deepest (s6) is drawn on a
 * contributor (A6) and on the senior expert (E1). Arms are about 18% longer than direction B's and
 * the helmet about 8% smaller, so "present" clears the helmet and "think" reaches the chin.
 */
import type { AccentName, HairColor, SkinTone } from './palette';

/** Body proportions, in character units (an average astronaut is about 96 units tall). */
export interface Build {
  /** torso width and height */
  tw: number;
  th: number;
  /** thigh and shin length */
  thigh: number;
  shin: number;
  /** upper arm and forearm length */
  ua: number;
  fa: number;
  /** leg and arm width */
  lw: number;
  aw: number;
  /** helmet radius */
  hr: number;
}

export type BuildName = 'petite' | 'slim' | 'average' | 'broad';

export const BUILDS: Record<BuildName, Build> = {
  petite: {
    tw: 31,
    th: 23,
    thigh: 9,
    shin: 8,
    ua: 12.5,
    fa: 10.5,
    lw: 11,
    aw: 10,
    hr: 23,
  },
  slim: {
    tw: 31,
    th: 27,
    thigh: 12,
    shin: 10,
    ua: 14,
    fa: 11.5,
    lw: 11,
    aw: 10,
    hr: 23.5,
  },
  average: {
    tw: 36,
    th: 26,
    thigh: 11,
    shin: 9,
    ua: 13.5,
    fa: 11.5,
    lw: 12.5,
    aw: 11,
    hr: 24,
  },
  broad: {
    tw: 43,
    th: 27,
    thigh: 10.5,
    shin: 9,
    ua: 13.5,
    fa: 11.5,
    lw: 14,
    aw: 12.5,
    hr: 24.5,
  },
};

export type HairStyle =
  | 'afro'
  | 'crop'
  | 'long'
  | 'scarf'
  | 'curly'
  | 'coily'
  | 'bun'
  | 'sweep'
  | 'beard'
  | 'bob';

export interface CastMember {
  skin: SkinTone;
  hair: HairStyle;
  hairColor: HairColor;
  build: BuildName;
  accent: AccentName;
  freckles?: boolean;
  /** A lab coat over a dark undersuit: the experts. */
  coat?: boolean;
  glasses?: boolean;
}

export type CastId =
  'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'E1' | 'E2' | 'E3';

/** The cast. IDs and drawings, not identities: the gallery labels what is drawn. */
export const CAST: Record<CastId, CastMember> = {
  A1: {
    skin: 's5',
    hair: 'afro',
    hairColor: 'black',
    build: 'average',
    accent: 'coral',
  },
  A2: {
    skin: 's2',
    hair: 'crop',
    hairColor: 'black',
    build: 'slim',
    accent: 'royal',
  },
  A3: {
    skin: 's3',
    hair: 'long',
    hairColor: 'brown',
    build: 'petite',
    accent: 'pink',
  },
  A4: {
    skin: 's4',
    hair: 'scarf',
    hairColor: 'berry',
    build: 'average',
    accent: 'slate',
  },
  A5: {
    skin: 's1',
    hair: 'curly',
    hairColor: 'auburn',
    build: 'broad',
    accent: 'royal',
    freckles: true,
  },
  A6: {
    skin: 's6',
    hair: 'coily',
    hairColor: 'black',
    build: 'slim',
    accent: 'coral',
  },
  A7: {
    skin: 's4',
    hair: 'bun',
    hairColor: 'black',
    build: 'petite',
    accent: 'royal',
  },
  A8: {
    skin: 's2',
    hair: 'sweep',
    hairColor: 'sandy',
    build: 'average',
    accent: 'pink',
  },
  E1: {
    skin: 's6',
    hair: 'beard',
    hairColor: 'silver',
    build: 'broad',
    accent: 'royal',
    coat: true,
    glasses: true,
  },
  E2: {
    skin: 's1',
    hair: 'bob',
    hairColor: 'silver',
    build: 'slim',
    accent: 'coral',
    coat: true,
    glasses: true,
  },
  E3: {
    skin: 's3',
    hair: 'long',
    hairColor: 'black',
    build: 'average',
    accent: 'pink',
    coat: true,
  },
};

export const CAST_IDS = Object.keys(CAST) as CastId[];

/** What each cast member's drawing shows, for galleries and alt text (never an identity). */
export const CAST_LABELS: Record<CastId, string> = {
  A1: 'afro · coral · average',
  A2: 'short crop · royal · slim',
  A3: 'long hair · pink · petite',
  A4: 'headscarf · slate · average',
  A5: 'curls, freckles · royal · broad',
  A6: 'short coils · coral · slim',
  A7: 'bun · royal · petite',
  A8: 'side sweep · pink · average',
  E1: 'expert · silver beard, glasses · broad',
  E2: 'expert · silver bob, glasses · slim',
  E3: 'expert · long hair · average',
};
