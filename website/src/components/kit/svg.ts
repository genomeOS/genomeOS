/** SVG string helpers for the figure kit (site redesign #454). */

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
