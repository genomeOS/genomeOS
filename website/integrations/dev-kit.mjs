/**
 * The figure kit gallery at /kit/, in development only (site redesign plan step 0.12, #454).
 * src/pages/_kit.astro is not a route of its own (Astro skips underscored pages), so a production
 * build never compiles it; `astro dev` gets it through this injected route.
 */
export default function devKit() {
  return {
    name: 'genomeos-dev-kit',
    hooks: {
      'astro:config:setup': ({ command, injectRoute }) => {
        if (command !== 'dev') return;
        injectRoute({ pattern: '/kit', entrypoint: './src/pages/_kit.astro' });
      },
    },
  };
}
