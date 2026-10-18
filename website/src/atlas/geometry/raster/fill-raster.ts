/**
 * The draped surface raster: fill fans, palette-bin polygons and support masks per tile (terrain
 * draping design, "Per layer under World Terrain", "Failure modes" and "Test plan", #483).
 *
 * Supported rows draw first, when `cells.supported`: the cell centre fanned to its topology
 * corners, as `buildSmoothChunk` and `buildFlatChunk` mesh them. Smooth geometries interpolate the
 * chunk's vertex colours barycentrically in degrees; hexagons take the palette-bin colour. With
 * `contours`, the Honmoon geometries ("honmoon contours from an analytic gradient") also
 * interpolate the chunk's vertex values and shade each texel with `honmoonTexel`, the smooth-globe
 * fragment's `fwidth` replaced by the value's change over one texel: the fan triangle's exact
 * gradient, which `triangle-scan.ts` hands each texel, or at a pole its central difference.
 * Without, both draw the Honmoon fill (rgb × 0.55, α 0.28). Masked rows
 * draw second, when `cells.masked`, over anything below (masks win): the cell boundary fanned round
 * the cell centre, or a pole-holding cell's `h3PolygonParts` parts, as `flatCellBuffers` meshes
 * them, in the `Grid` hatch (unknown) or the `Dot` pattern of the prior bin colour
 * (prior-dominated). A mask texel's `st` is interpolated from its triangle's vertex `st`, which
 * `stAt` gives in the part's own frame, as the GPU interpolates the chunk masks' vertex `st`; its
 * step across one texel is the larger of st's changes per column and per row, as Grid takes it
 * from `dFdx` and `dFdy`. `triangle-scan.ts` decides which texels each triangle covers, exactly
 * along shared edges, across ±180° and at the poles. A row is skipped when the grid index's box
 * for it (`rowBox`) holds no texel centre of the tile.
 *
 * Presentation only: no value is invented and no row is dropped; a support code outside the four
 * throws, and so do contours on a geometry without them. A tile with no texel of α > 0 is null, as
 * line-only Honmoon between its lines is. Contours read only the normalised value, never terrain
 * height. Cesium-free and deterministic: the data worker runs it and repeats give identical bytes.
 */

import { h3BoundaryDegrees, h3PolygonParts } from '../polygon-parts';
import { stAt, stFrameOf, type StFrame } from '../support-buffers';
import {
  honmoonModeForGeometry,
  isSmoothGeometry,
  paletteBins,
  vertexMeans,
} from '../surface-buffers';
import {
  isSupportedCode,
  PRIOR_DOMINATED_CODE,
  supportName,
  UNKNOWN_CODE,
} from '../support-codes';
import { cellLanes } from '../topology';
import { geodeticToEcef, type Vec3 } from '../wgs84';
import {
  colorBytesAtStops,
  linearStops,
  normalizedValue,
} from '../../visual-encoding';
import { honmoonTexel, type HonmoonMode } from './contours';
import { rowBox } from './grid-index';
import { dotTexel, hatchTexel } from './mask-texels';
import {
  drawMesh,
  drawPolar,
  scanTarget,
  touchesTexel,
  type Mesh,
  type Target,
  type TexelWriter,
} from './triangle-scan';
import type { SurfaceRasterInput, TileAddress, TileRaster } from './types';

/** The Honmoon fill of `ELEVATED_SURFACE_FRAGMENT_SHADER`: rgb × 0.55 at α 0.28. */
export const HONMOON_FILL_SHADE = 0.55;
export const HONMOON_FILL_ALPHA = 0.28;

const HONMOON_ALPHA_BYTE = Math.round(HONMOON_FILL_ALPHA * 255);

/** Fan triangles (0, 1 + k, 1 + (k + 1) mod n) round vertex 0 over a ring of `n`. */
function fanTriangles(
  n: number,
  firstVertex = 0,
  out: number[] = [],
): number[] {
  for (let k = 0; k < n; k += 1)
    out.push(firstVertex, firstVertex + 1 + k, firstVertex + 1 + ((k + 1) % n));
  return out;
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

const st: [number, number] = [0, 0];
const stStep: [number, number] = [0, 0];

const hatchWriter: TexelWriter = (rgba, offset, v, dColumn, dRow) => {
  for (let d = 0; d < 2; d += 1) {
    st[d] = v[d];
    stStep[d] = Math.max(Math.abs(dColumn[d]), Math.abs(dRow[d]));
  }
  hatchTexel(st, stStep, rgba, offset);
};

function dotWriter(rgb: readonly [number, number, number]): TexelWriter {
  return (rgba, offset, v) => {
    st[0] = v[0];
    st[1] = v[1];
    dotTexel(st, rgb, rgba, offset);
  };
}

/** What every supported row of one tile reads: smooth geometries take the chunk's vertex colours,
 * flat ones their palette bin, and contours the chunk's vertex values too. */
interface FillStyle {
  /** Writes the centre's and then each corner's attributes of `row`, whose corners are `ids`, into
   * `out`: colour bytes, then with contours the normalised value. */
  colours(row: number, ids: readonly number[], out: number[]): void;
  /** Attributes per vertex: 3, or 4 with contours. */
  dims: number;
  /** Contours read the value's change over one texel, which a pole-holding row computes only when
   * asked. */
  derivatives: boolean;
  write: TexelWriter;
}

/** Smooth corner colours, filled on first use: one per topology vertex, shared by every tile and
 * every cell that meets the vertex. Keyed by the vertex means, which `vertexMeans` keeps per
 * values, support and domain. */
const cornerColourCache = new WeakMap<
  Float32Array,
  Map<string, { rgb: Uint8Array; known: Uint8Array }>
>();

function cornerColours(
  means: Float32Array,
  palette: SurfaceRasterInput['palette'],
): { rgb: Uint8Array; known: Uint8Array } {
  const byPalette = cornerColourCache.get(means) ?? new Map();
  cornerColourCache.set(means, byPalette);
  let entry = byPalette.get(palette);
  if (!entry) {
    entry = {
      known: new Uint8Array(means.length),
      rgb: new Uint8Array(means.length * 3),
    };
    byPalette.set(palette, entry);
  }
  return entry;
}

/** `mode` is the geometry's Honmoon mode when contours are drawn, else 0. */
function fillStyleOf(i: SurfaceRasterInput, mode: 0 | HonmoonMode): FillStyle {
  if (!isSmoothGeometry(i.geometry)) {
    const bins = paletteBins(i, 'supported');
    return {
      colours: (row, ids, out) => {
        const colour = bins.colors.get(bins.binOfRow[row])!;
        for (let v = 0; v <= ids.length; v += 1) out.push(...colour);
      },
      derivatives: false,
      dims: 3,
      write: fillTexel,
    };
  }
  const honmoon = honmoonModeForGeometry(i.geometry) !== 0;
  const contours = mode !== 0;
  const stops = linearStops(i.palette);
  const means = vertexMeans(i).values;
  const corners = cornerColours(means, i.palette);
  return {
    colours: (row, ids, out) => {
      const value = normalizedValue(i.values[row], i.domain);
      out.push(...colorBytesAtStops(stops, value));
      if (contours) out.push(value);
      for (const id of ids) {
        if (corners.known[id] === 0) {
          corners.rgb.set(colorBytesAtStops(stops, means[id]), id * 3);
          corners.known[id] = 1;
        }
        out.push(
          corners.rgb[id * 3],
          corners.rgb[id * 3 + 1],
          corners.rgb[id * 3 + 2],
        );
        if (contours) out.push(means[id]);
      }
    },
    derivatives: contours,
    dims: contours ? 4 : 3,
    write: contours
      ? contourWriter(mode)
      : honmoon
        ? honmoonFillTexel
        : fillTexel,
  };
}

/** Draws supported row `row`: the centre fanned to its topology corners. */
function drawFill(
  t: Target,
  i: SurfaceRasterInput,
  row: number,
  style: FillStyle,
): void {
  const box = rowBox(i.topology, row);
  if (!box.polar && !touchesTexel(t, box)) return;
  const { topology } = i;
  const first = topology.cornerOffsets[row];
  const count = topology.cornerOffsets[row + 1] - first;
  const ids: number[] = [];
  const lon = [topology.centreLon[row]];
  const lat = [topology.centreLat[row]];
  for (let k = first; k < first + count; k += 1) {
    const id = topology.cornerIds[k];
    ids.push(id);
    lon.push(topology.vertexLon[id]);
    lat.push(topology.vertexLat[id]);
  }
  const mesh: Mesh = {
    attrs: [],
    derivatives: style.derivatives,
    dims: style.dims,
    lat,
    lon,
    triangles: fanTriangles(count),
  };
  style.colours(row, ids, mesh.attrs);
  const { write } = style;
  if (box.polar)
    drawPolar(
      t,
      { lat: lat.slice(1), lon: lon.slice(1) },
      mesh,
      topology.centreLat[row] > 0,
      write,
    );
  else drawMesh(t, mesh, write);
}

function ground(lon: number, lat: number): Vec3 {
  const point: Vec3 = [0, 0, 0];
  geodeticToEcef(lon, lat, 0, point);
  return point;
}

/** Appends `ring` to `m`, fanned round `centre`, or as one triangle without one; st in `frame`. */
function addMaskFan(
  m: Mesh,
  centre: [number, number] | null,
  ring: [number, number][],
  frame: StFrame,
): void {
  const first = m.lon.length;
  const points = centre ? [centre, ...ring] : ring;
  for (const [lon, lat] of points) {
    m.lon.push(lon);
    m.lat.push(lat);
    m.attrs.push(...stAt(frame, ground(lon, lat)));
  }
  if (centre) fanTriangles(ring.length, first, m.triangles);
  else m.triangles.push(first, first + 1, first + 2);
}

/** Draws masked row `row` in the hatch (unknown) or the dots of its prior bin colour. */
function drawMask(
  t: Target,
  i: SurfaceRasterInput,
  row: number,
  write: TexelWriter,
): void {
  const box = rowBox(i.topology, row);
  if (!box.polar && !touchesTexel(t, box)) return;
  const cell = cellLanes(i.grid, row);
  const centre: [number, number] = [
    i.topology.centreLon[row],
    i.topology.centreLat[row],
  ];
  const boundary = h3BoundaryDegrees(cell);
  const mesh: Mesh = {
    attrs: [],
    derivatives: true,
    dims: 2,
    lat: [],
    lon: [],
    triangles: [],
  };
  if (!box.polar) {
    addMaskFan(
      mesh,
      centre,
      boundary,
      stFrameOf(boundary.map(([lon, lat]) => ground(lon, lat))),
    );
    drawMesh(t, mesh, write);
    return;
  }
  for (const part of h3PolygonParts(cell)) {
    const frame = stFrameOf(part.map(([lon, lat]) => ground(lon, lat)));
    addMaskFan(mesh, part.length === 3 ? null : centre, part, frame);
  }
  const ring = {
    lat: boundary.map(([, lat]) => lat),
    lon: boundary.map(([lon]) => lon),
  };
  drawPolar(t, ring, mesh, centre[1] > 0, write);
}

/** True when some texel of `rgba` has α > 0. */
function anyVisible(rgba: Uint8ClampedArray): boolean {
  for (let alpha = 3; alpha < rgba.length; alpha += 4)
    if (rgba[alpha] > 0) return true;
  return false;
}

/** The surface tile at `a`: supported fill or contours, then masks over it; null when no texel
 * has α > 0. */
export function rasterSurfaceTile(
  i: SurfaceRasterInput,
  a: TileAddress,
): TileRaster | null {
  const honmoonMode = honmoonModeForGeometry(i.geometry);
  if (i.contours && honmoonMode === 0)
    throw new Error(
      'Honmoon contours need the honmoon or honmoon-fill geometry',
    );
  if (!i.cells.supported && !i.cells.masked) return null;
  const t = scanTarget(a);
  const rows = i.index.rowsIn(t.rect);
  // a code outside the four is a schema violation, never a silently skipped row
  for (const row of rows) supportName(i.support[row]);
  if (i.cells.supported) {
    const style = fillStyleOf(i, i.contours ? honmoonMode : 0);
    for (const row of rows)
      if (isSupportedCode(i.support[row])) drawFill(t, i, row, style);
  }
  if (i.cells.masked) {
    const prior = paletteBins(i, 'prior_dominated');
    for (const row of rows) {
      const code = i.support[row];
      if (code === UNKNOWN_CODE) drawMask(t, i, row, hatchWriter);
      else if (code === PRIOR_DOMINATED_CODE)
        drawMask(t, i, row, dotWriter(prior.colors.get(prior.binOfRow[row])!));
    }
  }
  return t.written && anyVisible(t.rgba) ? { rgba: t.rgba } : null;
}
