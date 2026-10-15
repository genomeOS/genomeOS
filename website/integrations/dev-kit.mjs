/**
 * The figure and astronaut kit gallery at /kit/ (site redesign plan step 0.12; round 2 spec §3.1,
 * §3.4; #454). src/pages/_kit.astro is not a route of its own (Astro skips underscored pages), so a
 * production build never compiles it. `astro dev` gets it through this injected route, and so does
 * the e2e build (`PUBLIC_MOTION_HOOKS=1`), where tests/kit.spec.ts scrubs its test scene. The
 * deployed build never has it, and the sitemap leaves /kit/ out (astro.config.mjs).
 *
 * `PUBLIC_MOTION_HOOKS` turns on the motion hooks (src/graphics/motion-hooks.ts). Like
 * `PUBLIC_ATLAS_E2E_HOOKS` (src/lib/catalog-build.ts `assertE2eHooks`), only `npm run build:e2e` may
 * set it: a build with it and without the e2e catalog fails here.
 */

/** The e2e build's catalog (src/lib/catalog-build.ts E2E_ATLAS_CATALOG_PATH). */
export const E2E_CATALOG_PATH = 'tests/fixtures/atlas/e2e/catalog.json';

/**
 * Refuse motion hooks outside the e2e build, and any value but "1".
 * @param {string | undefined} catalogPath ATLAS_CATALOG_PATH
 * @param {string | undefined} flag PUBLIC_MOTION_HOOKS
 * @returns {boolean} whether the build carries the hooks
 */
export function assertMotionHooks(catalogPath, flag) {
  if (flag === undefined || flag === '') return false;
  if (catalogPath !== E2E_CATALOG_PATH)
    throw new Error(
      `PUBLIC_MOTION_HOOKS is only allowed in the e2e build (npm run build:e2e, ATLAS_CATALOG_PATH=${E2E_CATALOG_PATH}); the deployed build carries no motion hooks and no /kit/ page (#454).`,
    );
  if (flag !== '1')
    throw new Error(
      `PUBLIC_MOTION_HOOKS must be 1 when set, not ${JSON.stringify(flag)}.`,
    );
  return true;
}

export default function devKit() {
  return {
    name: 'genomeos-dev-kit',
    hooks: {
      'astro:config:setup': ({ command, injectRoute }) => {
        const hooks = assertMotionHooks(
          process.env.ATLAS_CATALOG_PATH,
          process.env.PUBLIC_MOTION_HOOKS,
        );
        if (command !== 'dev' && !(command === 'build' && hooks)) return;
        injectRoute({ pattern: '/kit', entrypoint: './src/pages/_kit.astro' });
      },
    },
  };
}
