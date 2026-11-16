/**
 * What the draped surface raster's supported rows read, built once per style (terrain draping
 * design, "Per layer under World Terrain": barycentric fill for smooth modes, palette-bin polygons
 * for flat modes, Honmoon contours; "Performance budget and measurement", #483).
 *
 * Smooth geometries interpolate the chunk's vertex colours: the cell centre's colour from its value
 * and each corner's from the vertex mean (`vertexMeans`), both through `colorBytesAtStops`; with
 * contours each vertex also carries its normalised value, and the texel is shaded by
 * `honmoonTexel`, its `fwidth` replaced by the value's change over one texel. Without contours the
 * Honmoon geometries draw the Honmoon fill (rgb × 0.55, α 0.28). Flat geometries take the palette
 * bin's colour (`paletteBins`) at every vertex.
 *
 * A row's colour is the same in every tile, so it is computed on the row's first draw and kept per
 * values, domain and palette (centres) or per vertex means and palette (corners): a tile after it
 * computes none, and a restyle back to a palette reuses it. The style itself is kept per raster
 * input, so a tile allocates nothing for it. Cesium-free and deterministic: the data worker runs
 * it.
 */

import {
  HONMOON_FILL_ALPHA,
  HONMOON_FILL_SHADE,
  honmoonTexel,
  type HonmoonMode,
} from './contours';
import type { TexelWriter } from './triangle-scan';
import type { SurfaceRasterInput } from './types';
import { isSmoothGeometry, paletteBins, vertexMeans } from '../surface-buffers';
import {
  colorBytesAtStops,
  linearStops,
  normalizedValue,
} from '../../visual-encoding';

const HONMOON_ALPHA_BYTE = Math.round(HONMOON_FILL_ALPHA * 255);

/** What every supported row of one tile reads: smooth geometries take the chunk's vertex colours,
 * flat ones their palette bin, and contours the chunk's vertex values too. */
export interface FillStyle {
  /** Writes the centre's and then each corner's attributes of `row`, whose corners are the
   * topology's `count` corners from `first`, into `out`: colour bytes, then with contours the
   * normalised value. */
  attributes(
    row: number,
    first: number,
    count: number,
    out: Float64Array,
  ): void;
  /** Attributes per vertex: 3, or 4 with contours. */
  dims: number;
  /** Contours read the value's change over one texel, which a pole-holding row computes only when
   * asked. */
  derivatives: boolean;
  write: TexelWriter;
}

const fillTexel: TexelWriter = (rgba, offset, v) => {
  rgba[offset] = Math.round(v[0]);
  rgba[offset + 1] = Math.round(v[1]);
  rgba[offset + 2] = Math.round(v[2]);
  rgba[offset + 3] = 255;
};

const honmoonFillTexel: TexelWriter = (rgba, offset, v) => {
  for (let c = 0; c < 3; c += 1)
    rgba[offset + c] = Math.round(Math.round(v[c]) * HONMOON_FILL_SHADE);
  rgba[offset + 3] = HONMOON_ALPHA_BYTE;
};

/** A contour texel's interpolated sRGB in [0, 1], as `v_surfaceColor`. */
const contourColour = new Float64Array(3);

/** Honmoon contours from attributes (r, g, b bytes, normalised value): the value's change over
 * one texel, `|dColumn| + |dRow|`, stands in for the shader's `fwidth`. */
function contourWriter(mode: HonmoonMode): TexelWriter {
  return (rgba, offset, v, dColumn, dRow) => {
    for (let c = 0; c < 3; c += 1) contourColour[c] = v[c] / 255;
    honmoonTexel(
      contourColour,
      v[3],
      Math.abs(dColumn[3]) + Math.abs(dRow[3]),
      mode,
      rgba,
      offset,
    );
  };
}

/** sRGB bytes filled on first use: `rgb[3k..3k+2]` once `known[k]` is 1. */
interface KnownColours {
  rgb: Uint8Array;
  known: Uint8Array;
}

function knownColours(count: number): KnownColours {
  return { known: new Uint8Array(count), rgb: new Uint8Array(count * 3) };
}

/** Smooth corner colours: one per topology vertex, shared by every tile and every cell that meets
 * the vertex. Keyed by the vertex means, which `vertexMeans` keeps per values, support and domain. */
const cornerColourCache = new WeakMap<
  Float32Array,
  Map<string, KnownColours>
>();

/** Smooth centre colours: one per row, keyed by its values, then by palette and domain. */
const centreColourCache = new WeakMap<
  Float32Array,
  Map<string, KnownColours>
>();

function cached(
  cache: WeakMap<Float32Array, Map<string, KnownColours>>,
  by: Float32Array,
  key: string,
  count: number,
): KnownColours {
  const byKey = cache.get(by) ?? new Map<string, KnownColours>();
  cache.set(by, byKey);
  let entry = byKey.get(key);
  if (!entry) {
    entry = knownColours(count);
    byKey.set(key, entry);
  }
  return entry;
}

/** The style each raster input's tiles share. */
const styles = new WeakMap<SurfaceRasterInput, FillStyle>();

/** Every vertex in one flat palette-bin colour. */
function flatStyle(i: SurfaceRasterInput): FillStyle {
  const bins = paletteBins(i, 'supported');
  const binRgb = new Uint8Array(3 * (Math.max(-1, ...bins.colors.keys()) + 1));
  for (const [bin, colour] of bins.colors) binRgb.set(colour, 3 * bin);
  return {
    attributes: (row, _first, count, out) => {
      const at = 3 * bins.binOfRow[row];
      if (!(at >= 0 && at < binRgb.length))
        throw new Error(`supported row ${row} has no palette bin`);
      for (let v = 0; v <= count; v += 1) {
        out[3 * v] = binRgb[at];
        out[3 * v + 1] = binRgb[at + 1];
        out[3 * v + 2] = binRgb[at + 2];
      }
    },
    derivatives: false,
    dims: 3,
    write: fillTexel,
  };
}

/** The chunk's smooth vertex colours, and with `lines` (a Honmoon mode) each vertex's value. */
function smoothStyle(
  i: SurfaceRasterInput,
  honmoon: 0 | HonmoonMode,
  lines: 0 | HonmoonMode,
): FillStyle {
  const stops = linearStops(i.palette);
  const means = vertexMeans(i).values;
  const corners = cached(cornerColourCache, means, i.palette, means.length);
  const centres = cached(
    centreColourCache,
    i.values,
    `${i.palette}|${i.domain[0]}|${i.domain[1]}`,
    i.values.length,
  );
  const { cornerIds } = i.topology;
  const dims = lines !== 0 ? 4 : 3;
  const colourOf = (
    colours: KnownColours,
    k: number,
    value: number,
    out: Float64Array,
    at: number,
  ) => {
    if (colours.known[k] === 0) {
      colours.rgb.set(colorBytesAtStops(stops, value), 3 * k);
      colours.known[k] = 1;
    }
    out[at] = colours.rgb[3 * k];
    out[at + 1] = colours.rgb[3 * k + 1];
    out[at + 2] = colours.rgb[3 * k + 2];
  };
  return {
    attributes: (row, first, count, out) => {
      const value = normalizedValue(i.values[row], i.domain);
      colourOf(centres, row, value, out, 0);
      if (lines !== 0) out[3] = value;
      for (let k = 0; k < count; k += 1) {
        const id = cornerIds[first + k];
        colourOf(corners, id, means[id], out, dims * (k + 1));
        if (lines !== 0) out[dims * (k + 1) + 3] = means[id];
      }
    },
    derivatives: lines !== 0,
    dims,
    write:
      lines !== 0
        ? contourWriter(lines)
        : honmoon !== 0
          ? honmoonFillTexel
          : fillTexel,
  };
}

/** `honmoon` is the geometry's Honmoon mode (0: none); `contours` draws its lines, which
 * `rasterSurfaceTile` has refused for a geometry without them. Kept per input. */
export function fillStyleOf(
  i: SurfaceRasterInput,
  honmoon: 0 | HonmoonMode,
  contours: boolean,
): FillStyle {
  let style = styles.get(i);
  if (!style) {
    style = isSmoothGeometry(i.geometry)
      ? smoothStyle(i, honmoon, contours ? honmoon : 0)
      : flatStyle(i);
    styles.set(i, style);
  }
  return style;
}
