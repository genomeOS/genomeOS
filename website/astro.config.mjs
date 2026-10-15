import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import atlasScenePreload from './integrations/atlas-scene-preload.mjs';
import devKit from './integrations/dev-kit.mjs';
import { gaHead, gaMeasurementId } from './src/lib/ga.mjs';

import { FAVICON_SVG, rasterIconLinks } from './src/lib/favicons.ts';

const site = process.env.SITE_URL ?? 'https://genome-os.org';
const base = process.env.BASE_PATH ?? '/';
const outDir = process.env.OUT_DIR ?? 'dist';
const normalizedBase =
  base === '/' ? '/' : `/${base.replace(/^\/+|\/+$/g, '')}/`;
// #422: Google Analytics only when the build sets PUBLIC_GA_MEASUREMENT_ID (the production Pages
// build); a malformed ID fails here.
const gaId = gaMeasurementId();

export default defineConfig({
  site,
  base,
  outDir,
  devToolbar: { enabled: false },
  trailingSlash: 'always',
  integrations: [
    react(),
    atlasScenePreload(),
    devKit(),
    starlight({
      title: 'genomeOS',
      description: 'An open atlas of human genetic variation across geography.',
      favicon: FAVICON_SVG,
      disable404Route: true,
      components: {
        EditLink: './src/components/starlight/EditLink.astro',
        Footer: './src/components/starlight/Footer.astro',
        // #454: the site's lockup, nav and Atlas link around Starlight's search, and dark only.
        Header: './src/components/starlight/Header.astro',
        SocialIcons: './src/components/starlight/SocialIcons.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
      },
      customCss: [
        '@fontsource-variable/figtree',
        '@fontsource-variable/raleway',
        './src/styles/starlight.css',
      ],
      editLink: {
        baseUrl: 'https://github.com/genomeOS/genomeOS/edit/main/website/',
      },
      head: [
        ...rasterIconLinks(normalizedBase).map((attrs) => ({
          tag: 'link',
          attrs,
        })),
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: new URL(
              `${normalizedBase}images/genomeos-banner.png`,
              site,
            ).href,
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image',
            content: new URL(
              `${normalizedBase}images/genomeos-banner.png`,
              site,
            ).href,
          },
        },
        // #422: the same analytics head as the site layout (src/components/Analytics.astro).
        ...gaHead(),
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/genomeOS/genomeOS',
        },
      ],
      sidebar: [
        {
          // #454: the site nav for docs readers below 72rem, where the header hides it. No
          // "genomeOS" in a label: every visible genomeOS is set in the wordmark type.
          label: 'Explore the project',
          items: [
            { label: 'Home', link: '/' },
            { label: 'Atlas', link: '/app/' },
            { label: 'Project', link: '/project/' },
            { label: 'Contribute', link: '/contribute/' },
            { label: 'Contact', link: '/contact/' },
          ],
        },
        {
          label: 'Docs',
          items: [{ autogenerate: { directory: 'docs' } }],
        },
      ],
    }),
    // /working-groups/ only redirects to /contribute/#working-groups (#454, spec §1.4).
    sitemap({ filter: (page) => !page.includes('/working-groups/') }),
  ],
  vite: {
    envDir: '..',
    build: {
      rolldownOptions: {
        output: {
          // Fast-load design §B.1: a stable chunk name lets the cold-load
          // harness attribute long animation frames to Cesium. Rolldown's
          // replacement for the deprecated manualChunks.
          codeSplitting: {
            groups: [
              {
                name: 'cesium',
                // JavaScript only. CSS must stay out of the group: AtlasExplorer.tsx
                // still imports Cesium's CesiumWidget and Viewer stylesheets, and if
                // their stub lands in the Cesium chunk the island gains a static
                // import"./cesium.<hash>.js", loading all of Cesium with the island
                // and undoing Task 35 (B2.12)'s lazy scene chunk.
                //
                // The Atlas-owned render loop joins it: its frame callback is only
                // widget.resize() + widget.render(), the work Cesium's default loop did
                // from this chunk, so the harness keeps counting Cesium renders as
                // Cesium (atlas-scene is its only importer).
                test: /[\\/]node_modules[\\/](?:cesium|@cesium[\\/][^\\/]+)[\\/].*\.js$|[\\/]src[\\/]atlas[\\/]scene[\\/]render-loop\.ts$/,
              },
              // The marketing figure kit (site redesign spec §7, #454). Left to automatic
              // chunking, its modules split by which page imports them, and Project fetched six
              // kit files of 0.4-4.5 KB, each with its own response headers. Two groups instead:
              // the motion kit every figure page uses, and the hex-map kit the globe and the HbS
              // map share. src/graphics/encoding.ts imports nothing from the Atlas at run time
              // (tests/encoding-tokens.test.ts), so neither group pulls Atlas code in.
              {
                name: 'figure-kit',
                test: /[\\/]src[\\/]graphics[\\/](?:figure|tween|tabs)\.ts$/,
              },
              {
                name: 'hex-kit',
                test: /[\\/]src[\\/]graphics[\\/](?:hexfield|projection|figure-data|encoding|rng)\.ts$|[\\/]src[\\/]data[\\/]figures[\\/]hbs-surveys\.\w+\.bin\?url$/,
              },
            ],
          },
        },
      },
    },
    define: {
      CESIUM_BASE_URL: JSON.stringify(`${normalizedBase}cesium/`),
      // #422: a build-time constant, so a build without analytics drops the client code that sends
      // to gtag (src/lib/analytics.ts, src/lib/cookie-control.ts).
      'import.meta.env.PUBLIC_GA_MEASUREMENT_ID': JSON.stringify(gaId ?? ''),
    },
    // The Atlas data worker is a module worker sharing ES modules with the island (fast-load design §B.6.3).
    worker: { format: 'es' },
    plugins: [
      viteStaticCopy({
        // The engine reads Assets, ThirdParty and Workers through CESIUM_BASE_URL. Of the
        // widget layer only the Earth style picker's thumbnails are used: the globe is a
        // CesiumWidget whose CSS is bundled (issue #446).
        targets: [
          'Assets',
          'ThirdParty',
          'Workers',
          'Widgets/Images/ImageryProviders',
          'Widgets/Images/TerrainProviders',
        ].map((name) => ({
          src: `node_modules/cesium/Build/Cesium/${name}`,
          dest: 'cesium',
          rename: { stripBase: 4 },
        })),
      }),
    ],
  },
});
