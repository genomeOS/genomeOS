/**
 * The scale frames (site redesign spec §4.1 H6, §4.2 the vision; #454): four frames from Earth to
 * a cell nucleus, each drawn once in a 170-unit square, and the zoom wedge that opens a small
 * region of one frame (its zoom box, on the content it magnifies) into the next frame. Project's
 * scale ladder and Home's vision teaser draw these same frames with the same wedges, each at its own
 * size (design review, round 2: the teaser's own squares sat on the frames' edges).
 *
 *   Earth            a value-free land footprint on a globe: no data, no coastline
 *   Population       an abstract cluster of studs with their stated radius rings
 *   Chromosome 11    an ideogram with the HBB gene marked at 11p15.4         (future, violet dashed)
 *   Cell nucleus     an outline with chromatin and the folded locus           (future, violet dashed)
 *
 * The art is build-time SVG markup; its classes (`.ladder__*`) are styled in
 * styles/scale-frames.css, which both figures import.
 */

import { cssVarStyles, studSvg } from './svg';

export type FrameKey = 'earth' | 'population' | 'chromosome' | 'nucleus';
export type ZoomFrame = Exclude<FrameKey, 'nucleus'>;

/** Each frame's art is drawn in one square of this many units. */
export const FRAME = 170;
type Box = readonly [x: number, y: number, w: number, h: number];

/** The zoom box in each frame (local units): the small region the next frame expands. */
export const ZOOM: Record<ZoomFrame, Box> = {
  earth: [110, 74, 24, 24],
  population: [118, 88, 24, 24],
  chromosome: [73, 14, 24, 20],
};
/** The population whose genome the next frames look into, and where Project's bridge returns. */
export const TARGET_STUD = { x: 130, y: 100, r: 4.25, ring: 20 } as const;
/** The HBB tick on chromosome 11 (11p15.4, near the end of the short arm). */
export const HBB_TICK = { x: 85, y: 24 } as const;

export const FRAME_ORDER: readonly FrameKey[] = [
  'earth',
  'population',
  'chromosome',
  'nucleus',
];
/** The three wedges, each from one frame's zoom box to the next frame. */
export const WEDGES: readonly (readonly [ZoomFrame, FrameKey])[] = [
  ['earth', 'population'],
  ['population', 'chromosome'],
  ['chromosome', 'nucleus'],
];
/** Frames 3–4 are future work, drawn only as violet dashed outlines (spec §6.1 rule 7). */
export const isFutureFrame = (frame: FrameKey) =>
  frame === 'chromosome' || frame === 'nucleus';

export interface Placement {
  x: number;
  y: number;
  scale: number;
}

type Line = [number, number, number, number];

/**
 * The wedge from frame `from`'s zoom box to the facing edge of the next frame, as two lines whose
 * first points are the zoom box's corners.
 */
export function zoomWedge(
  frames: Record<FrameKey, Placement>,
  from: ZoomFrame,
  to: FrameKey,
): [Line, Line] {
  const a = frames[from];
  const b = frames[to];
  const [bx, by, bw, bh] = ZOOM[from];
  const box = {
    left: a.x + bx * a.scale,
    right: a.x + (bx + bw) * a.scale,
    top: a.y + by * a.scale,
    bottom: a.y + (by + bh) * a.scale,
  };
  const size = FRAME * b.scale;
  if (b.x > a.x + 1)
    // The next frame is to the right: box's right corners to its left edge.
    return [
      [box.right, box.top, b.x, b.y],
      [box.right, box.bottom, b.x, b.y + size],
    ];
  if (b.x < a.x - 1)
    // To the left: box's left corners to its right edge.
    return [
      [box.left, box.top, b.x + size, b.y],
      [box.left, box.bottom, b.x + size, b.y + size],
    ];
  // Below: box's bottom corners to its top edge.
  return [
    [box.left, box.bottom, b.x, b.y],
    [box.right, box.bottom, b.x + size, b.y],
  ];
}

const flatHex = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k;
    return `${k ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join('') + 'Z';

const zoomBox = (frame: ZoomFrame) => {
  const [x, y, w, h] = ZOOM[frame];
  return `<rect class="ladder__zoom" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
};

/**
 * Each frame's art, in its 170-unit square, ready for `set:html`. `clipId` names the chromosome's
 * clip path; it must be unique on the page.
 */
export function frameArt(clipId: string): Record<FrameKey, string> {
  // A value-free land footprint: hexagons inside an abstract blob, inside the globe. No data.
  const landCells: string[] = [];
  const r = 6;
  for (let col = -12; col <= 12; col += 1)
    for (let row = -12; row <= 12; row += 1) {
      const x = 85 + col * 1.5 * r;
      const y =
        85 + row * Math.sqrt(3) * r + (col % 2 ? (Math.sqrt(3) * r) / 2 : 0);
      const inBlob =
        Math.hypot(x - 104, y - 78) < 30 ||
        Math.hypot(x - 80, y - 108) < 19 ||
        Math.hypot(x - 58, y - 62) < 13;
      if (inBlob && Math.hypot(x - 85, y - 85) < 58)
        landCells.push(flatHex(x, y, r - 0.6));
    }
  const studs = [
    { x: 44, y: 58, r: 3, ring: 16 },
    { x: 84, y: 38, r: 2, ring: 10 },
    { x: 64, y: 106, r: 4.25, ring: 24 },
    { x: 106, y: 140, r: 2, ring: 9 },
    TARGET_STUD,
  ];
  const chromosome =
    'M74 27A11 11 0 0 1 96 27V64L91 70L96 76V143A11 11 0 0 1 74 143V76L79 70L74 64Z';
  const art: Record<FrameKey, string> = {
    earth:
      '<circle class="ladder__globe" cx="85" cy="85" r="66"/>' +
      '<ellipse class="ladder__grat" cx="85" cy="85" rx="66" ry="22"/>' +
      '<ellipse class="ladder__grat" cx="85" cy="85" rx="26" ry="66"/>' +
      '<ellipse class="ladder__grat" cx="85" cy="85" rx="54" ry="66"/>' +
      landCells.map((d) => `<path class="ladder__land" d="${d}"/>`).join('') +
      zoomBox('earth'),
    population:
      studs
        .map(
          ({ x, y, ring }) =>
            `<circle class="ladder__ring" cx="${x}" cy="${y}" r="${ring}"/>`,
        )
        .join('') +
      studs.map(({ x, y, r: radius }) => studSvg(x, y, radius)).join('') +
      zoomBox('population'),
    chromosome:
      `<clipPath id="${clipId}"><path d="${chromosome}"/></clipPath>` +
      `<g clip-path="url(#${clipId})">` +
      [
        [33, 6],
        [48, 10],
        [86, 9],
        [104, 7],
        [121, 13],
        [141, 6],
      ]
        .map(
          ([y, h]) =>
            `<rect class="ladder__band" x="70" y="${y}" width="30" height="${h}"/>`,
        )
        .join('') +
      '</g>' +
      `<path class="ladder__future" d="${chromosome}"/>` +
      `<path class="ladder__tick" d="M${HBB_TICK.x - 20} ${HBB_TICK.y}H${HBB_TICK.x + 20}"/>` +
      zoomBox('chromosome'),
    nucleus:
      '<ellipse class="ladder__future" cx="85" cy="85" rx="70" ry="60"/>' +
      '<circle class="ladder__future ladder__future--faint" cx="112" cy="62" r="11"/>' +
      '<path class="ladder__chromatin" d="M30 78c8-16 22-2 30-12s16-16 26-4M40 112c10-6 14 8 26 2s12-14 24-8M98 120c8 6 18-4 24 4s12 2 16-6M104 88c6-10 18-6 22 2"/>' +
      '<path class="ladder__locus" d="M62 92c-12 6-10 24 4 22s10-20 0-18-8 16 6 18 18-6 16-16"/>',
  };
  return Object.fromEntries(
    FRAME_ORDER.map((frame) => [frame, cssVarStyles(art[frame])]),
  ) as Record<FrameKey, string>;
}
