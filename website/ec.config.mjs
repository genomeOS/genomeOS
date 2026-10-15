// Expressive Code's settings for the docs (round 2 spec §4.4, R2-9; docs-light.md §5; #454).
// Expressive Code reads this file itself; a theme object is not serializable, so it lives here
// rather than in astro.config.mjs. tests/docs-theme.test.ts runs it through Starlight's own
// preprocessor: Paper is the base theme, the dark theme is keyed to [data-theme='dark'] only, and
// no prefers-color-scheme block is emitted.
import { readFileSync } from 'node:fs';

import {
  defineEcConfig,
  ExpressiveCodeTheme,
} from '@astrojs/starlight/expressive-code';

const paper = ExpressiveCodeTheme.fromJSONString(
  readFileSync(
    new URL('./src/styles/code/genomeos-paper.json', import.meta.url),
    'utf8',
  ),
);

export default defineEcConfig({
  // Paper first: the base theme, which a page shows unless the reader chose dark. Starlight's
  // bundled dark theme (Night Owl) stays for the dark choice, so dark code looks as it did.
  themes: [paper, 'starlight-dark'],
  useStarlightDarkModeSwitch: true,
  // The frames (title bar, editor and terminal grounds, borders) take the Starlight tokens, which
  // the docs theme sets: the code ground is --sl-color-gray-7, the title bar --sl-color-gray-6.
  useStarlightUiThemeColors: true,
  // The docs follow the reader's choice, never the operating system's (ThemeProvider.astro).
  useDarkModeMediaQuery: false,
});
