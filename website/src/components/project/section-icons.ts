/**
 * The Atlas chapter's section icons (owner request, 2026-10-15; round 2 spec §4.2): one thematic line
 * icon per collapsed section, drawn as the kit's interface icons are (components/kit/icons.ts): a
 * 24 px grid, round caps and joins, no fills, in currentColor. Kept here, not in the kit, as only
 * Projects uses them. Every icon is decoration (`aria-hidden`); the summary's words carry the name.
 *
 *   cells   a sickled cell beside a round one (why hemoglobin S)
 *   target  a target and its arrow: evidence reaching a decision (what it could be used for)
 *   flow    a record, a model, a map: three parts on one rising wire (how it works)
 *   flag    a flag on its pole (where it stands)
 */
export const SECTION_ICON_PATHS = {
  cells:
    'M3.5 15.5C4.5 8 12.5 4 19.5 6.5 14 7.5 8.5 10.5 3.5 15.5zM16.5 12.5a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5z',
  target:
    'M10.5 6a7.5 7.5 0 1 0 7.5 7.5M10.5 10a3.5 3.5 0 1 0 3.5 3.5M10.5 13.5 19.5 4.5M15.5 4.5h4v4',
  flow: 'M3 14.5h5v5H3zM8 14.5l2.3-3.7M9.4 8.5a2.6 2.6 0 1 0 5.2 0 2.6 2.6 0 1 0-5.2 0zM13.8 10.5l2.6 3.4M18.3 13.6l2.5 1.45v2.9l-2.5 1.45-2.5-1.45v-2.9z',
  flag: 'M6.5 20.5v-16M6.5 4.5h10.5l-2.4 3.75 2.4 3.75H6.5',
} as const;

export type SectionIconName = keyof typeof SECTION_ICON_PATHS;

/** The disclosure chevron, pointing down while closed; CSS turns it on open. */
export const CHEVRON_PATH = 'M6.5 9.5 12 15l5.5-5.5';
