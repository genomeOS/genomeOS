/** Interface icons for the figure kit (site redesign spec §2.6, #454): a 24 px grid, 1.6 px
 * strokes, round caps and joins, no fills. `Icon.astro` renders them as one sprite per page.
 */

export const ICON_PATHS = {
  speech: 'M4 5h16v10H11l-4.5 4v-4H4z',
  magnifier: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.3 15.3 20 20',
  board:
    'M3.5 4.5h17v15h-17zM9.2 4.5v15M14.8 4.5v15M5.5 8h2M11 8h2M16.5 8h2M5.5 11h2',
  branch:
    'M7 4.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 15.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM17 7.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 8.5v7M17 11.5c0 3-4 3-8.6 4.7',
  'shield-check':
    'M12 3.5 19 6v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6zM8.8 12l2.2 2.2 4.2-4.4',
  lock: 'M6 10.5h12v9H6zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14v2',
  arrow: 'M4.5 12h14M13.5 6.5 19 12l-5.5 5.5',
  external: 'M8 5.5H5.5v13h13V16M12.5 4.5h7v7M19.5 4.5 10.5 13.5',
  document: 'M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6M9 15.5h6',
  pin: 'M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21zM12 8.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z',
  cylinder:
    'M5 6.5c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  globe:
    'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c3 2.4 3 14.6 0 17M12 3.5c-3 2.4-3 14.6 0 17',
} as const;

export type IconName = keyof typeof ICON_PATHS;
