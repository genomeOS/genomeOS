/**
 * The brand SVGs the site serves, derived from the owner's artwork
 * (public/brand/genomeos-foundation-dark.svg, which is never edited; brand-assets.test pins its
 * sha256). Site redesign #454, ruling 12: the shell's brand files are slimmed without a visible
 * change.
 *
 * The artwork draws every glyph as absolute cubic Béziers at 3 decimals of a user unit, which is
 * what made the header lockup 18 KB and the footer logo 26 KB gzipped. Here each path's data is
 * rewritten with relative commands, its coordinates rounded to `PRECISION` decimals, and
 * separators and repeated command letters left out. The rounding is applied to absolute
 * positions and the relative steps are their exact differences, so no error accumulates: every
 * point lands within 0.005 units of the original (brand-assets.test decodes them back). The
 * largest drawing, the 180 px touch icon, is 0.64 px per unit, so no point moves 1/300 px. A
 * browser test draws each file against the original at 1x and 2x and holds it to no more
 * changed pixels than moving the original by 0.02 units makes (tests/brand-pixels.spec.ts).
 *
 *   genomeos-lockup-dark.svg        the header's genome + OS + FOUNDATION crop, no tagline
 *   genomeos-wordmark-dark.svg      the Atlas header's genome + OS crop
 *   genomeos-foundation-dark.min.svg the footer's full artwork, tagline included
 *   (favicon.svg)                   scripts/build-favicons.mjs, with `slimPaths`
 *
 * `npm run build:brand` writes the three brand files; `exactCrop` gives the unslimmed crop that
 * the browser test compares against. No DOM: brand-assets.test and the scripts import it.
 */

/** Decimals kept in path data, in user units. */
export const PRECISION = 2;

/** `n`, an integer count of 10^-decimals units, in the shortest SVG number form. */
function formatNumber(n, decimals) {
  const negative = n < 0;
  const magnitude = Math.abs(n);
  const scale = 10 ** decimals;
  const whole = Math.floor(magnitude / scale);
  const fraction = decimals
    ? String(magnitude % scale)
        .padStart(decimals, '0')
        .replace(/0+$/, '')
    : '';
  const text =
    (whole === 0 && fraction ? '' : String(whole)) +
    (fraction ? `.${fraction}` : '');
  return (negative ? '-' : '') + (text || '0');
}

/**
 * Path data as absolute segments: ['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y] and
 * ['Z']. Reads M, L, H, V, C and Z in either case (the artwork uses absolute M, L, C and Z; the
 * slimmed data, relative m, l, h, v and c), and fails loudly on any other command.
 */
export function absoluteSegments(d) {
  const tokens =
    d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const segments = [];
  let command = null;
  let index = 0;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++];
    if (command === 'Z' || command === 'z') {
      segments.push(['Z']);
      x = startX;
      y = startY;
      command = null;
      continue;
    }
    const upper = command?.toUpperCase();
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6 }[upper];
    if (!arity)
      throw new Error(
        `brand-svg: unsupported path command ${JSON.stringify(command)}`,
      );
    const values = tokens.slice(index, index + arity).map(Number);
    if (values.length !== arity || values.some(Number.isNaN))
      throw new Error(`brand-svg: ${command} needs ${arity} numbers`);
    index += arity;
    const relative = command !== upper;
    if (upper === 'H') values.push(relative ? 0 : y);
    if (upper === 'V') values.unshift(relative ? 0 : x);
    const points = values.map((value, at) =>
      relative ? value + (at % 2 ? y : x) : value,
    );
    [x, y] = points.slice(-2);
    if (upper === 'M') {
      startX = x;
      startY = y;
      segments.push(['M', x, y]);
      // Pairs after a moveto are linetos (SVG 1.1 §8.3.2).
      command = relative ? 'l' : 'L';
    } else segments.push([upper === 'C' ? 'C' : 'L', ...points]);
  }
  return segments;
}

/**
 * Path data with relative commands at `decimals` decimals. Each absolute point is rounded first
 * and the relative steps are differences of rounded integers, so the decoded points are the
 * rounded originals exactly.
 */
export function slimPathData(d, decimals = PRECISION) {
  const scale = 10 ** decimals;
  const round = (value) => Math.round(value * scale);
  let out = '';
  let previous = '';
  let lastNumber = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const emit = (command, numbers) => {
    // A repeated command letter may be left out, except after a moveto (whose extra pairs would
    // read as linetos).
    let text = command === previous && command !== 'm' ? '' : command;
    let last = text ? null : lastNumber;
    for (const number of numbers) {
      const token = formatNumber(number, decimals);
      const joins =
        token.startsWith('-') ||
        (token.startsWith('.') && last !== null && last.includes('.'));
      if (last !== null && !joins) text += ' ';
      text += token;
      last = token;
    }
    out += text;
    previous = command;
    lastNumber = last;
  };
  for (const [command, ...values] of absoluteSegments(d)) {
    if (command === 'Z') {
      out += 'z';
      previous = 'z';
      lastNumber = null;
      x = startX;
      y = startY;
      continue;
    }
    const points = values.map(round);
    const [px, py] = points.slice(-2);
    if (command === 'M') {
      if (out === '') emit('M', [px, py]);
      else emit('m', [px - x, py - y]);
      startX = px;
      startY = py;
    } else if (command === 'L') {
      if (px === x) emit('v', [py - y]);
      else if (py === y) emit('h', [px - x]);
      else emit('l', [px - x, py - y]);
    } else {
      emit(
        'c',
        points.map((value, at) => value - (at % 2 ? y : x)),
      );
    }
    x = px;
    y = py;
  }
  return out;
}

/** The SVG with every path's data slimmed; nothing else changes. */
export function slimPaths(svg, decimals = PRECISION) {
  return svg.replace(
    / d="([^"]*)"/g,
    (_, d) => ` d="${slimPathData(d, decimals)}"`,
  );
}

/** The artwork's #tagline group, which the header lockup leaves out. */
const TAGLINE_GROUP =
  /\n {2}<g id="tagline"[^>]*>\n(?: {4}<path\b[^>]*\/>\n)+ {2}<\/g>/;

/** The crops of the artwork: root box, title and description, and whether the tagline stays. */
export const CROPS = {
  'brand/genomeos-lockup-dark.svg': {
    // Union of getBBox() for #wordmark-genome, #wordmark-os and #foundation-line, padded 2% per
    // axis and rounded outward (brand-assets.test).
    viewBox: '136 270 1395 300',
    title: 'genomeOS Foundation',
    description: 'genomeOS Foundation',
    tagline: false,
  },
  'brand/genomeos-wordmark-dark.svg': {
    viewBox: '137 272 1391 228',
    title: 'genomeOS',
    description: 'genomeOS',
    tagline: true,
  },
};

/** The footer's copy of the whole artwork, slimmed (the original stays at its own URL). */
export const FULL_ARTWORK_COPY = 'brand/genomeos-foundation-dark.min.svg';

/** A crop of the artwork with its path data exactly as the owner drew it. */
export function exactCrop(artwork, { viewBox, title, description, tagline }) {
  const [, , width, height] = viewBox.split(' ');
  const replace = (text, pattern, replacement) => {
    if (!pattern.test(text))
      throw new Error(`brand-svg: ${pattern} not found in the artwork`);
    return text.replace(pattern, replacement);
  };
  let svg = replace(
    artwork,
    /(<svg\b[^>]*?) width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
    `$1 width="${width}" height="${height}" viewBox="${viewBox}"`,
  );
  svg = replace(
    svg,
    /(<title id="logo-title">)[^<]*(<\/title>)/,
    `$1${title}$2`,
  );
  svg = replace(
    svg,
    /(<desc id="logo-description">)[^<]*(<\/desc>)/,
    `$1${description}$2`,
  );
  return tagline ? svg : replace(svg, TAGLINE_GROUP, '');
}

/** Every brand file the site serves under public/, by path, from the owner's artwork. */
export function brandFiles(artwork) {
  return {
    ...Object.fromEntries(
      Object.entries(CROPS).map(([file, crop]) => [
        file,
        slimPaths(exactCrop(artwork, crop)),
      ]),
    ),
    [FULL_ARTWORK_COPY]: slimPaths(artwork),
  };
}
