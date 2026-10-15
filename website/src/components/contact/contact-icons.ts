/**
 * The Contact page's line icons (owner request, 2026-10-14): one for Email us, the copy buttons and
 * their confirmation, the webmail links' new tab, each purpose and each offer. Drawn as the kit's interface icons are
 * (components/kit/icons.ts): a 24 px grid, round caps and joins, no fills, in currentColor; set at
 * about 20 px, so a 1.8 stroke draws 1.5 px. Kept here, not in the kit, as only this page uses them.
 * `ContactIcon.astro` renders them as one sprite per page; every icon is decoration (aria-hidden),
 * and the control it sits in carries the name.
 */
import type { Offer, Topic } from '../../lib/contact-draft';

export const CONTACT_ICON_PATHS = {
  mail: 'M3.5 6h17v12h-17zM4 6.5l8 6.5 8-6.5',
  copy: 'M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  // Gmail and Outlook open in a new tab: the kit's external-link arrow (components/kit/icons.ts).
  external: 'M8 5.5H5.5v13h13V16M12.5 4.5h7v7M19.5 4.5 10.5 13.5',
  // Purposes: a plus to add to the project; a question in a speech bubble; two linked rings; a
  // microphone.
  contribute: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 8v8M8 12h8',
  question:
    'M4 4.5h16V16h-8.5L7 20v-4H4zM10 8.6a2.1 2.1 0 1 1 3 1.9c-.7.3-1 .8-1 1.5v.3M12 14.2v.1',
  partner:
    'M9 6.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM15 6.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z',
  press:
    'M12 3.5a2.75 2.75 0 0 1 2.75 2.75v5a2.75 2.75 0 0 1-5.5 0v-5A2.75 2.75 0 0 1 12 3.5zM6.5 11.25a5.5 5.5 0 0 0 11 0M12 16.75v3.75M9 20.5h6',
  // Offers: code brackets; a database cylinder; a light bulb; a banknote.
  code: 'M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5.5l-3 13',
  data: 'M5 6.5c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  expertise:
    'M9.5 17.5h5M10.5 20.5h3M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.6.5.8 1.1.8 1.8v2.3h5v-2.3c0-.7.2-1.3.8-1.8A5.5 5.5 0 0 0 12 3.5z',
  funding:
    'M3.5 7h17v10h-17zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM6.5 10v4M17.5 10v4',
} as const satisfies Record<
  Topic | Offer | 'mail' | 'copy' | 'check' | 'external',
  string
>;

export type ContactIconName = keyof typeof CONTACT_ICON_PATHS;
