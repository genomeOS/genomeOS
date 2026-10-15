/** Top-level public routes shared by the Playwright suites. */

export const topLevelRoutes = [
  '/',
  '/projects/',
  '/contribute/',
  '/app/',
  '/docs/',
  '/privacy/',
  '/contact/',
] as const;

/** The marketing pages the site redesign rebuilds (#454, spec §9.1). */
export const marketingRoutes = [
  '/',
  '/projects/',
  '/contribute/',
  '/privacy/',
  '/contact/',
  '/404.html',
] as const;
