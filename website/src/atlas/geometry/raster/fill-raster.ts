/**
 * The draped surface raster: fill fans, palette-bin polygons and support masks per tile (terrain
 * draping design, "Per layer under World Terrain", "Failure modes" and "Test plan", #483).
 *
 * Supported rows draw first, when `cells.supported`: the cell centre fanned to its topology
 * corners, as `buildSmoothChunk` and `buildFlatChunk` mesh them. Smooth geometries interpolate the
 * chunk's vertex colours barycentrically in degrees; hexagons take the palette-bin colour; both
 * Honmoon geometries draw the Honmoon fill (rgb × 0.55, α 0.28) until contours arrive. Masked rows
 * draw second, when `cells.masked`, over anything below (masks win): the cell boundary fanned round
 * the cell centre, or a pole-holding cell's `h3PolygonParts` parts, as `flatCellBuffers` meshes
 * them, in the `Grid` hatch (unknown) or the `Dot` pattern of the prior bin colour
 * (prior-dominated). A mask texel's `st` is interpolated from its triangle's vertex `st`, which
 * `stAt` gives in the part's own frame, as the GPU interpolates the chunk masks' vertex `st`; its
 * step across one texel is the triangle's gradient. `triangle-scan.ts` decides which texels each
 * triangle covers, exactly along shared edges, across ±180° and at the poles.
 *
 * Presentation only: no value is invented and no row is dropped, and a support code outside the
 * four throws. A tile with nothing drawn is null. Cesium-free and deterministic: the data worker
 * runs it and repeats give identical bytes.
 */

import { h3BoundaryDegrees, h3PolygonParts } from '../polygon-parts';
import { stAt, stFrameOf, type StFrame } from '../support-buffers';
import { isSmoothGeometry, paletteBins, vertexMeans } from '../surface-buffers';
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
import { dotTexel, hatchTexel } from './mask-texels';
import {
  drawMesh,
  drawPolar,
  scanTarget,
  touchesTexel,
  turnsNear,
  type Mesh,
  type Target,
  type TexelWriter,
} from './triangle-scan';
import type {
  DegreeRectangle,
  SurfaceRasterInput,
  TileAddress,
  TileRaster,
} from './types';

/** The Honmoon fill of `ELEVATED_SURFACE_FRAGMENT_SHADER`: rgb × 0.55 at α 0.28. */
export const HONMOON_FILL_SHADE = 0.55;
export const HONMOON_FILL_ALPHA = 0.28;

const HONMOON_ALPHA_BYTE = Math.round(HONMOON_FILL_ALPHA * 255);
/** Fraction of a row's corner box added on every side before the texel test; it covers the
 * boundary's class III distortion points, as the grid index does. */
const BOX_PAD = 0.1;

/** The row's corners unwrapped towards its centre: the box, padded by `BOX_PAD`, and whether the
 * row holds a pole. */
function cornerBox(
  i: SurfaceRasterInput,
  row: number,
): { box: DegreeRectangle; polar: boolean } {
  const { topology } = i;
  const near = topology.centreLon[row];
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (
    let k = topology.cornerOffsets[row];
    k < topology.cornerOffsets[row + 1];
    k += 1
  ) {
    const id = topology.cornerIds[k];
    const lon =
      topology.vertexLon[id] + 360 * turnsNear(topology.vertexLon[id], near);
    const lat = topology.vertexLat[id];
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const padLon = BOX_PAD * (east - west);
  const padLat = BOX_PAD * (north - south);
  return {
    box: {
      east: east + padLon,
      north: north + padLat,
      south: south - padLat,
      west: west - padLon,
    },
    polar: east - west > 180,
  };
}

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

const st: [number, number] = [0, 0];

const hatchWriter: TexelWriter = (rgba, offset, v, step) => {
  st[0] = v[0];
  st[1] = v[1];
  hatchTexel(st, step, rgba, offset);
};

function dotWriter(rgb: readonly [number, number, number]): TexelWriter {
  return (rgba, offset, v) => {
    st[0] = v[0];
    st[1] = v[1];
    dotTexel(st, rgb, rgba, offset);
  };
}

/** What every supported row of one tile reads: smooth geometries take the chunk's vertex colours,
 * flat ones their palette bin. */
interface FillStyle {
  /** Writes the centre's and then each corner's colour bytes of `row`, whose corners are `ids`,
   * into `out`. */
  colours(row: number, ids: readonly number[], out: number[]): void;
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

function fillStyleOf(i: SurfaceRasterInput): FillStyle {
  const write =
    i.geometry === 'honmoon' || i.geometry === 'honmoon-fill'
      ? honmoonFillTexel
      : fillTexel;
  if (!isSmoothGeometry(i.geometry)) {
    const bins = paletteBins(i, 'supported');
    return {
      colours: (row, ids, out) => {
        const colour = bins.colors.get(bins.binOfRow[row])!;
        for (let v = 0; v <= ids.length; v += 1) out.push(...colour);
      },
      write,
    };
  }
  const stops = linearStops(i.palette);
  const means = vertexMeans(i).values;
  const corners = cornerColours(means, i.palette);
  return {
    colours: (row, ids, out) => {
      out.push(
        ...colorBytesAtStops(stops, normalizedValue(i.values[row], i.domain)),
      );
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
      }
    },
    write,
  };
}

/** Draws supported row `row`: the centre fanned to its topology corners. */
function drawFill(
  t: Target,
  i: SurfaceRasterInput,
  row: number,
  style: FillStyle,
): void {
  const { polar, box } = cornerBox(i, row);
  if (!polar && !touchesTexel(t, box)) return;
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
    dims: 3,
    lat,
    lon,
    triangles: fanTriangles(count),
  };
  style.colours(row, ids, mesh.attrs);
  const { write } = style;
  if (polar)
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
  const { polar, box } = cornerBox(i, row);
  if (!polar && !touchesTexel(t, box)) return;
  const cell = cellLanes(i.grid, row);
  const centre: [number, number] = [
    i.topology.centreLon[row],
    i.topology.centreLat[row],
  ];
  const boundary = h3BoundaryDegrees(cell);
  const mesh: Mesh = { attrs: [], dims: 2, lat: [], lon: [], triangles: [] };
  if (!polar) {
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

/** The surface tile at `a`: supported fill, then masks over it; null when nothing is drawn. */
export function rasterSurfaceTile(
  i: SurfaceRasterInput,
  a: TileAddress,
): TileRaster | null {
  if (i.contours && i.geometry !== 'honmoon' && i.geometry !== 'honmoon-fill')
    throw new Error(
      'Honmoon contours need the honmoon or honmoon-fill geometry',
    );
  if (!i.cells.supported && !i.cells.masked) return null;
  const t = scanTarget(a);
  const rows = i.index.rowsIn(t.rect);
  // a code outside the four is a schema violation, never a silently skipped row
  for (const row of rows) supportName(i.support[row]);
  if (i.cells.supported) {
    const style = fillStyleOf(i);
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
  return t.written ? { rgba: t.rgba } : null;
}
