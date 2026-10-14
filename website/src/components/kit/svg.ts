/** SVG string helpers for the figure kit (site redesign #454). */

import { STUD_RING } from '../../graphics/encoding';

/**
 * A measured stud as SVG: a void disc `STUD_RING` wider, then the white disc of radius `r` (spec
 * §2.2, §2.6). The legend glyphs, the Pipeline and its packets use it, so they draw the same mark
 * as the canvas and the poster.
 */
export function studSvg(
  cx: number,
  cy: number,
  r: number,
  colours: { obs: string; ring: string } = {
    obs: 'var(--enc-obs)',
    ring: 'var(--enc-obs-ring)',
  },
): string {
  const at = cx === 0 && cy === 0 ? '' : ` cx="${cx}" cy="${cy}"`;
  return (
    `<circle${at} r="${r + STUD_RING}" fill="${colours.ring}"/>` +
    `<circle${at} r="${r}" fill="${colours.obs}"/>`
  );
}

const VAR_VALUE = /\s([a-z-]+)="([^"]*(?:var\(|color-mix\()[^"]*)"/g;

/**
 * Move presentation attributes whose value uses `var()` or `color-mix()` into a `style`
 * attribute: browsers do not all resolve custom properties in presentation attributes, but every
 * browser resolves them in CSS.
 */
export function cssVarStyles(markup: string): string {
  return markup.replace(
    /<([a-zA-Z][\w-]*)(\s[^<>]*?)?(\/?)>/g,
    (tag, name: string, attributes = '', close: string) => {
      const moved: string[] = [];
      const rest = (attributes as string).replace(
        VAR_VALUE,
        (_match, attribute: string, value: string) => {
          moved.push(`${attribute}:${value}`);
          return '';
        },
      );
      if (moved.length === 0) return tag;
      return `<${name}${rest} style="${moved.join(';')}"${close}>`;
    },
  );
}
