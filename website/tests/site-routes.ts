/** Top-level public routes shared by the Playwright suites. */

export const topLevelRoutes = [
  '/',
  '/project/',
  '/contribute/',
  '/app/',
  '/docs/',
  '/privacy/',
] as const;

/** The marketing pages the site redesign rebuilds (#454, spec §9.1). */
export const marketingRoutes = [
  '/',
  '/project/',
  '/contribute/',
  '/privacy/',
  '/404.html',
] as const;
