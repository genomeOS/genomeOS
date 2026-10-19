/**
 * The draped surface raster: fill fans, palette-bin polygons and support masks per tile (terrain
 * draping design, "Per layer under World Terrain", "Failure modes", "Performance budget and
 * measurement" and "Test plan", #483).
 *
 * Supported rows draw first, when `cells.supported`: the cell centre fanned to its topology
 * corners, as `buildSmoothChunk` and `buildFlatChunk` mesh them, in the colours and values of
 * `fill-style.ts` (smooth vertex colours, palette bins, Honmoon fill or contours). Masked rows draw
 * second, when `cells.masked`, over anything below (masks win): the cell boundary fanned round the
 * cell centre, or a pole-holding cell's `h3PolygonParts` parts, as `flatCellBuffers` meshes them
 * (`mask-fans.ts`), in the `Grid` hatch (unknown) or the `Dot` pattern of the prior bin colour
 * (prior-dominated). A mask texel's `st` is interpolated from its triangle's vertex `st`, as the
 * GPU interpolates the chunk masks' vertex `st`; its step across one texel is the larger of st's
 * changes per column and per row, as Grid takes it from `dFdx` and `dFdy`. `triangle-scan.ts`
 * decides which texels each triangle covers, exactly along shared edges, across ±180° and at the
 * poles. A row is skipped when the grid index's box for it (`GridIndex.boxes`) holds no texel
 * centre of the tile.
 *
 * Cheap at every level: a level-0 tile at production density holds about 39,000 rows, so per tile
 * a row costs its scan alone. Its colours are kept per style (`fill-style.ts`) and a masked row's
 * boundary and st per grid (`mask-fans.ts`); a fan that holds no pole is drawn from one reused
 * scratch mesh, so no H3 call and no per-row allocation happens per tile.
 *
 * Presentation only: no value is invented and no row is dropped; a support code outside the four
 * throws, and so do contours on a geometry without them. A tile with no texel of α > 0 is null, as
 * line-only Honmoon between its lines is. Contours read only the normalised value, never terrain
 * height. Cesium-free and deterministic: the data worker runs it and repeats give identical bytes
 * (`atlas-raster-bytes.test.ts` pins them).
 */

import { honmoonModeForGeometry, paletteBins } from '../surface-buffers';
import {
  isSupportedCode,
  PRIOR_DOMINATED_CODE,
  supportName,
  UNKNOWN_CODE,
} from '../support-codes';
import { HONMOON_FILL_ALPHA, HONMOON_FILL_SHADE } from './contours';
import { fillStyleOf, type FillStyle } from './fill-style';
import { maskFanInto, polarMask } from './mask-fans';
import { dotTexel, hatchTexel } from './mask-texels';
import {
  drawMesh,
  drawPolar,
  MAX_MESH_DIMS,
  scanTarget,
  touchesTexel,
  type Target,
  type TexelWriter,
} from './triangle-scan';
import type { SurfaceRasterInput, TileAddress, TileRaster } from './types';

// One owner: the Honmoon fill of `contours.ts`, rgb × 0.55 at α 0.28, drawn here without contours.
export { HONMOON_FILL_ALPHA, HONMOON_FILL_SHADE };

/** Fan triangle indices (0, 1 + k, 1 + (k + 1) mod n) round vertex 0 over a ring of `n`, per n. */
const fans: Uint16Array[] = [];

function fanIndices(n: number): Uint16Array {
  let fan = fans[n];
  if (!fan) {
    fan = new Uint16Array(3 * n);
    for (let k = 0; k < n; k += 1) {
      fan[3 * k] = 0;
      fan[3 * k + 1] = 1 + k;
      fan[3 * k + 2] = 1 + ((k + 1) % n);
    }
    fans[n] = fan;
  }
  return fan;
}

/** The one fan every row that holds no pole is drawn from: room for a cell centre and its 10 most
 * boundary points, the attributes of each, and the row's fan indices. */
const fan = {
  attrs: new Float64Array(11 * MAX_MESH_DIMS),
  derivatives: false,
  dims: 3,
  lat: new Float64Array(11),
  lon: new Float64Array(11),
  triangles: fanIndices(6) as ArrayLike<number>,
};

/** Rows of the tile being drawn, reused from tile to tile. */
const rows: number[] = [];

/** The supported row in `fan`, whose attributes `fillAttributes` writes once a texel needs them. */
const pending = { count: 0, first: 0, row: 0, style: null as FillStyle | null };

function fillAttributes(): void {
  pending.style!.attributes(
    pending.row,
    pending.first,
    pending.count,
    fan.attrs,
  );
}

/** Draws supported row `row`: the centre fanned to its topology corners. */
function drawFill(
  t: Target,
  i: SurfaceRasterInput,
  row: number,
  style: FillStyle,
): void {
  const { boxes } = i.index;
  const polar = boxes.polar[row] === 1;
  if (!polar && !touchesTexel(t, boxes, row)) return;
  const { topology } = i;
  const first = topology.cornerOffsets[row];
  const count = topology.cornerOffsets[row + 1] - first;
  if (count + 1 > fan.lon.length)
    throw new Error(`grid row ${row} has ${count} corners, more than a cell`);
  fan.lon[0] = topology.centreLon[row];
  fan.lat[0] = topology.centreLat[row];
  for (let k = 0; k < count; k += 1) {
    const id = topology.cornerIds[first + k];
    fan.lon[1 + k] = topology.vertexLon[id];
    fan.lat[1 + k] = topology.vertexLat[id];
  }
  fan.dims = style.dims;
  fan.derivatives = style.derivatives;
  fan.triangles = fanIndices(count);
  if (!polar) {
    pending.count = count;
    pending.first = first;
    pending.row = row;
    pending.style = style;
    drawMesh(t, fan, style.write, count + 1, 3 * count, fillAttributes);
    return;
  }
  style.attributes(row, first, count, fan.attrs);
  const vertices = count + 1;
  drawPolar(
    t,
    {
      lat: Array.from(fan.lat.subarray(1, vertices)),
      lon: Array.from(fan.lon.subarray(1, vertices)),
    },
    {
      attrs: fan.attrs.slice(0, vertices * style.dims),
      derivatives: style.derivatives,
      dims: style.dims,
      lat: Array.from(fan.lat.subarray(0, vertices)),
      lon: Array.from(fan.lon.subarray(0, vertices)),
      triangles: Array.from(fan.triangles),
    },
    topology.centreLat[row] > 0,
    style.write,
  );
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

/** The prior bin colour of the row `dotWriter` is drawing. */
let dotColour: readonly [number, number, number] = [0, 0, 0];

const dotWriter: TexelWriter = (rgba, offset, v) => {
  st[0] = v[0];
  st[1] = v[1];
  dotTexel(st, dotColour, rgba, offset);
};

/** Draws masked row `row` in the hatch (unknown) or the dots of its prior bin colour. */
function drawMask(
  t: Target,
  i: SurfaceRasterInput,
  row: number,
  write: TexelWriter,
): void {
  const { boxes } = i.index;
  if (boxes.polar[row] === 1) {
    const { mesh, north, ring } = polarMask(i.grid, i.topology, row);
    drawPolar(t, ring, mesh, north, write);
    return;
  }
  if (!touchesTexel(t, boxes, row)) return;
  const count = maskFanInto(i.grid, i.topology, row, fan);
  fan.dims = 2;
  fan.derivatives = true;
  fan.triangles = fanIndices(count - 1);
  drawMesh(t, fan, write, count, 3 * (count - 1));
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
  i.index.rowsIn(t.rect, rows);
  // a code outside the four is a schema violation, never a silently skipped row
  for (const row of rows) supportName(i.support[row]);
  if (i.cells.supported) {
    const style = fillStyleOf(i, honmoonMode, i.contours);
    for (const row of rows)
      if (isSupportedCode(i.support[row])) drawFill(t, i, row, style);
  }
  if (i.cells.masked) {
    const prior = paletteBins(i, 'prior_dominated');
    for (const row of rows) {
      const code = i.support[row];
      if (code === UNKNOWN_CODE) drawMask(t, i, row, hatchWriter);
      else if (code === PRIOR_DOMINATED_CODE) {
        dotColour = prior.colors.get(prior.binOfRow[row])!;
        drawMask(t, i, row, dotWriter);
      }
    }
  }
  return t.written && anyVisible(t.rgba) ? { rgba: t.rgba } : null;
}
