/**
 * Write the brand SVGs the site serves, derived from the owner's artwork (scripts/brand-svg.mjs:
 * the header lockup, the Atlas wordmark and the footer's copy of the full artwork, with their path
 * data slimmed). Run from website/ with `npm run build:brand`, then commit public/brand/.
 * brand-assets.test fails if a committed file differs from what this writes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { brandFiles } from './brand-svg.mjs';

const publicDir = path.resolve(import.meta.dirname, '../public');
const artwork = readFileSync(
  path.join(publicDir, 'brand/genomeos-foundation-dark.svg'),
  'utf8',
);

for (const [file, svg] of Object.entries(brandFiles(artwork))) {
  writeFileSync(path.join(publicDir, file), svg);
  console.log(
    `${file}: ${svg.length} bytes, ${gzipSync(svg, { level: 9 }).length} gzipped`,
  );
}
