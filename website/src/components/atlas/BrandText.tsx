/**
 * Text from data with the project name in the wordmark type (Atlas design
 * §11). Static markup wraps "genomeOS" by hand (BrandName.astro,
 * AtlasDataCredit); catalog strings such as the basemap label "genomeOS Dark"
 * go through this instead. aria-label and title attributes keep the plain
 * string.
 */

import { Fragment } from 'react';

export const BRAND_NAME = 'genomeOS';

export function BrandText({ text }: { text: string }) {
  return (
    <>
      {text.split(BRAND_NAME).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="brand-name">{BRAND_NAME}</span>}
          {part}
        </Fragment>
      ))}
    </>
  );
}
