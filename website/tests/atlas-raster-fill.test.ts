import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  honmoonTexel,
  triangleValueGradient,
} from '../src/atlas/geometry/raster/contours';
import {
  HONMOON_FILL_ALPHA,
  HONMOON_FILL_SHADE,
  rasterSurfaceTile,
} from '../src/atlas/geometry/raster/fill-raster';
import { buildGridIndex } from '../src/atlas/geometry/raster/grid-index';
import {
  texelCentre,
  tileRectangle,
} from '../src/atlas/geometry/raster/tiling';
import {
  drawMesh,
  drawPolar,
  scanTarget,
  type Mesh,
  type TexelWriter,
} from '../src/atlas/geometry/raster/triangle-scan';
import {
  RASTER_TILE_SIZE,
  type DrapedGeometry,
  type SurfaceRasterInput,
  type SurfaceRasterSpec,
  type TileAddress,
  type TileRaster,
} from '../src/atlas/geometry/raster/types';
import { isSupportedCode } from '../src/atlas/geometry/support-codes';
import {
  buildSurfaceChunk,
  paletteBins,
  vertexMeans,
} from '../src/atlas/geometry/surface-buffers';
import type { Support } from '../src/atlas/contracts';
import {
  colorBytesAtStops,
  linearStops,
  normalizedValue,
} from '../src/atlas/visual-encoding';
import {
  barycentricColour,
  centreTexel,
  columnCoverage,
  drawnRows,
  forEachTexel,
  insideInnerDisk,
  KENYA_CELLS,
  lonLatTriangles,
  poleCells,
  rasterInputFor,
  rowOfCellAt,
  seamCells,
  texel,
  tileContaining,
  tilesCovering,
  wholeGridChunk,
  type TestCell,
} from './helpers/raster-fixtures';
import { meshInputFor, sortedU64 } from './helpers/mesh-input';

/** The Kenya disk with every third row unknown and every third prior-dominated. */
const MIXED_CELLS: TestCell[] = KENYA_CELLS.map((cell, row) => ({
  ...cell,
  support: (
    [
      'unknown',
      'observed',
      'prior_dominated',
    ] as const satisfies readonly Support[]
  )[row % 3],
}));

/** Four attributes affine in (x, y), so every interpolation of them is exact. */
function affineField(x: number, y: number): number[] {
  return [x, y, 3 * x - 2 * y + 1, 5];
}

/** The pole's azimuthal frame, in which a pole-holding row interpolates its attributes. */
function azimuthalField(lon: number, lat: number): number[] {
  const r = 90 - Math.abs(lat);
  const radians = (lon * Math.PI) / 180;
  return affineField(r * Math.cos(radians), r * Math.sin(radians));
}

/** Calls `check` with each texel `write` received: its centre, attributes and their changes. */
function recordingWriter(
  a: TileAddress,
  check: (
    centre: { lon: number; lat: number },
    v: readonly number[],
    dColumn: readonly number[],
    dRow: readonly number[],
  ) => void,
): TexelWriter {
  return (_rgba, offset, v, dColumn, dRow) => {
    const texelIndex = offset / 4;
    const centre = texelCentre(
      a,
      texelIndex % RASTER_TILE_SIZE,
      Math.floor(texelIndex / RASTER_TILE_SIZE),
    );
    check(
      centre,
      [...v.slice(0, 4)],
      [...dColumn.slice(0, 4)],
      [...dRow.slice(0, 4)],
    );
  };
}

/** The largest |actual − expected| over every channel. */
function largestGap(actual: readonly number[], expected: readonly number[]) {
  return Math.max(...actual.map((value, d) => Math.abs(value - expected[d])));
}

describe('triangle scan (terrain draping design, #483)', () => {
  it('hands the texel writer each attribute and its exact change per column and per row', () => {
    const a: TileAddress = { level: 7, x: 154, y: 65 };
    const rect = tileRectangle(a);
    const texelDegrees = (rect.east - rect.west) / RASTER_TILE_SIZE;
    const lon = [rect.west + 0.2, rect.east - 0.3, rect.west + 0.5];
    const lat = [rect.south + 0.1, rect.south + 0.4, rect.north - 0.2];
    const mesh: Mesh = {
      attrs: lon.flatMap((x, v) => affineField(x, lat[v])),
      derivatives: true,
      dims: 4,
      lat,
      lon,
      triangles: [0, 1, 2],
    };
    const perColumn = [texelDegrees, 0, 3 * texelDegrees, 0];
    const perRow = [0, texelDegrees, -2 * texelDegrees, 0];
    let texels = 0;
    let gap = 0;
    drawMesh(
      scanTarget(a),
      mesh,
      recordingWriter(a, (centre, v, dColumn, dRow) => {
        texels += 1;
        gap = Math.max(
          gap,
          largestGap(v, affineField(centre.lon, centre.lat)),
          largestGap(dColumn, perColumn),
          largestGap(dRow, perRow),
        );
      }),
    );
    expect(texels).toBeGreaterThan(10_000);
    expect(gap).toBeLessThan(1e-9);
  });

  it('hands a pole-holding row its changes across one texel when the mesh asks for them', () => {
    const a: TileAddress = { level: 7, x: 128, y: 0 };
    const ringLon = [-150, -90, -30, 30, 90, 150];
    const lon = [0, ...ringLon];
    const lat = [89.95, ...ringLon.map(() => 89.5)];
    const triangles = ringLon.flatMap((_, k) => [0, 1 + k, 1 + ((k + 1) % 6)]);
    const half = 180 / 2 ** a.level / RASTER_TILE_SIZE / 2;
    const ring = { lat: lat.slice(1), lon: ringLon };
    for (const derivatives of [true, false]) {
      const mesh: Mesh = {
        attrs: lon.flatMap((x, v) => azimuthalField(x, lat[v])),
        derivatives,
        dims: 4,
        lat,
        lon,
        triangles,
      };
      let texels = 0;
      let gap = 0;
      drawPolar(
        scanTarget(a),
        ring,
        mesh,
        true,
        recordingWriter(a, ({ lon: x, lat: y }, v, dColumn, dRow) => {
          texels += 1;
          // inside the fan's hexagon in the azimuthal frame, where no weight is clamped
          if (y > 89.6)
            gap = Math.max(gap, largestGap(v, azimuthalField(x, y)));
          const along = (p: number[], q: number[]) =>
            p.map((value, d) => value - q[d]);
          gap = Math.max(
            gap,
            largestGap(
              dColumn,
              derivatives
                ? along(
                    azimuthalField(x + half, y),
                    azimuthalField(x - half, y),
                  )
                : [0, 0, 0, 0],
            ),
            largestGap(
              dRow,
              derivatives
                ? along(
                    azimuthalField(x, y + half),
                    azimuthalField(x, y - half),
                  )
                : [0, 0, 0, 0],
            ),
          );
        }),
      );
      expect(texels).toBeGreaterThan(10_000);
      expect(gap).toBeLessThan(1e-9);
    }
  });
});

describe('surface fill raster (terrain draping design, #483)', () => {
  it("matches buildSmoothChunk's colours within 1 byte at every texel it draws", () => {
    const input = rasterInputFor(KENYA_CELLS, { geometry: 'triangles' });
    const triangles = lonLatTriangles(
      buildSurfaceChunk(input, wholeGridChunk(input)),
    );
    let compared = 0;
    for (const a of tilesCovering(input, 7)) {
      forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
        const expected = barycentricColour(triangles, lon, lat);
        if (rgba[3] === 0 || !expected) return;
        compared += 1;
        for (let c = 0; c < 3; c += 1)
          expect(Math.abs(rgba[c] - expected[c])).toBeLessThanOrEqual(1);
      });
    }
    expect(compared).toBeGreaterThan(1_000);
  });

  it('colours each flat hexagon with its paletteBins colour', () => {
    const input = rasterInputFor(KENYA_CELLS, { geometry: 'hexagons' });
    const bins = paletteBins(input, 'supported');
    const a = tileContaining(36.793, -1.836, 7);
    let compared = 0;
    forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
      const r = rowOfCellAt(input, lon, lat);
      if (r === null) return;
      compared += 1;
      expect(rgba).toEqual([...bins.colors.get(bins.binOfRow[r])!, 255]);
    });
    expect(compared).toBeGreaterThan(1_000);
  });

  it('draws both honmoon geometries as the honmoon fill until contours arrive', () => {
    expect([HONMOON_FILL_SHADE, HONMOON_FILL_ALPHA]).toEqual([0.55, 0.28]);
    for (const geometry of ['honmoon', 'honmoon-fill'] as const) {
      const [r, g, b] = centreTexel(
        rasterInputFor(KENYA_CELLS, { geometry: 'triangles' }),
        36.793,
        -1.836,
      );
      expect(
        centreTexel(rasterInputFor(KENYA_CELLS, { geometry }), 36.793, -1.836),
      ).toEqual([
        Math.round(r * 0.55),
        Math.round(g * 0.55),
        Math.round(b * 0.55),
        Math.round(0.28 * 255),
      ]);
    }
  });

  it('leaves no gap along shared edges inside the disk', () => {
    const input = rasterInputFor(KENYA_CELLS, { geometry: 'hexagons' });
    const a = tileContaining(36.793, -1.836, 8);
    let inside = 0;
    forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
      // at least one texel inside the outer ring
      if (!insideInnerDisk(input, lon, lat)) return;
      inside += 1;
      expect(rgba[3]).toBe(255);
    });
    expect(inside).toBeGreaterThan(10_000);
  });

  it('draws a ±180° cell on both sides of the antimeridian, without a seam', () => {
    const input = rasterInputFor(seamCells(), { geometry: 'hexagons' });
    const east = { level: 6, x: 127, y: 32 };
    const west = { level: 6, x: 0, y: 32 };
    expect(columnCoverage(rasterSurfaceTile(input, east)!, 255)).toBe(
      columnCoverage(rasterSurfaceTile(input, west)!, 0),
    );
    expect(columnCoverage(rasterSurfaceTile(input, west)!, 0)).toBeGreaterThan(
      0,
    );
  });

  it('reaches the pole for a pole cell', () => {
    const input = rasterInputFor(poleCells(), { geometry: 'triangles' });
    const top = rasterSurfaceTile(input, { level: 3, x: 8, y: 0 })!;
    for (let column = 0; column < 256; column += 1)
      expect(texel(top, column, 255)[3]).toBe(255);
  });

  it('writes rows south-first', () => {
    const input = rasterInputFor([
      { h3: latLngToCell(-1.5, 36.8, 4), support: 'observed', value: 0.5 },
    ]);
    // west 33.75, south -11.25, east 45, north 0
    const raster = rasterSurfaceTile(input, { level: 4, x: 19, y: 8 })!;
    const rows = drawnRows(raster);
    expect(Math.min(...rows)).toBeGreaterThan(200);
    expect(Math.max(...rows)).toBeLessThan(256);
  });

  it('returns byte-identical tiles for repeated calls, and null for a tile with nothing drawn', () => {
    const input = rasterInputFor(KENYA_CELLS);
    const a = tileContaining(36.793, -1.836, 7);
    expect(rasterSurfaceTile(input, a)!.rgba).toEqual(
      rasterSurfaceTile(input, a)!.rgba,
    );
    expect(rasterSurfaceTile(input, { level: 7, x: 0, y: 0 })).toBeNull();
  });

  it('draws supported cells only with cells.supported and masked cells only with cells.masked', () => {
    const combinations: SurfaceRasterSpec['cells'][] = [
      { masked: true, supported: true },
      { masked: false, supported: true },
      { masked: true, supported: false },
      { masked: false, supported: false },
    ];
    for (const geometry of ['triangles', 'hexagons'] as const)
      for (const cells of combinations) {
        const input = rasterInputFor(MIXED_CELLS, { cells, geometry });
        const rows = MIXED_CELLS.map((_, row) => row);
        const expected = rows.filter((row) =>
          isSupportedCode(input.support[row]) ? cells.supported : cells.masked,
        );
        expect(
          rows.filter((row) => centreTexel(input, row, 8)[3] > 0),
          JSON.stringify({ cells, geometry }),
        ).toEqual(expected);
      }
    const nothing = rasterInputFor(MIXED_CELLS, {
      cells: { masked: false, supported: false },
    });
    for (const a of tilesCovering(nothing, 6))
      expect(rasterSurfaceTile(nothing, a)).toBeNull();
  });

  it('refuses Honmoon contours on a geometry that has none', () => {
    const input = { ...rasterInputFor(KENYA_CELLS), contours: true };
    expect(() =>
      rasterSurfaceTile(input, tileContaining(36.793, -1.836, 7)),
    ).toThrow('Honmoon contours need the honmoon or honmoon-fill geometry');
  });
});

/** One supported row's fan as `buildSmoothChunk` meshes it: the centre, then its topology corners,
 * longitudes unwrapped to within 180° of the centre. Values are what the chunk writes (centre
 * `normalizedValue(values[row])`, corners `vertexMeans(input).values[id]`), colours their
 * `colorBytesAtStops` bytes / 255. */
interface OracleFan {
  lon: number[];
  lat: number[];
  value: number[];
  colour: number[][];
  west: number;
  east: number;
  south: number;
  north: number;
}

const oracleFans = new WeakMap<SurfaceRasterInput, OracleFan[]>();

function fansOf(input: SurfaceRasterInput): OracleFan[] {
  const cached = oracleFans.get(input);
  if (cached) return cached;
  const { topology } = input;
  const stops = linearStops(input.palette);
  const means = vertexMeans(input).values;
  const fans: OracleFan[] = [];
  for (let row = 0; row < topology.n; row += 1) {
    if (!isSupportedCode(input.support[row])) continue;
    const centre = topology.centreLon[row];
    const lon = [centre];
    const lat = [topology.centreLat[row]];
    const value = [normalizedValue(input.values[row], input.domain)];
    for (
      let k = topology.cornerOffsets[row];
      k < topology.cornerOffsets[row + 1];
      k += 1
    ) {
      const id = topology.cornerIds[k];
      const raw = topology.vertexLon[id];
      lon.push(raw - 360 * Math.round((raw - centre) / 360));
      lat.push(topology.vertexLat[id]);
      value.push(means[id]);
    }
    fans.push({
      colour: value.map((v) =>
        colorBytesAtStops(stops, v).map((byte) => byte / 255),
      ),
      east: Math.max(...lon),
      lat,
      lon,
      north: Math.max(...lat),
      south: Math.min(...lat),
      value,
      west: Math.min(...lon),
    });
  }
  oracleFans.set(input, fans);
  return fans;
}

/** buildSmoothChunk's fan at a point, by brute force: the supported row whose triangle (centre,
 * ring[k], ring[k+1]) contains (lon, lat), the point tried at lon and lon ± 360, with barycentric
 * weights in degrees; the gradient is `triangleValueGradient` over that triangle. Serves rows that
 * hold no pole. */
function fanAt(
  input: SurfaceRasterInput,
  lon: number,
  lat: number,
): { colour: number[]; value: number; gradient: Float64Array } | null {
  for (const fan of fansOf(input)) {
    if (lat < fan.south || lat > fan.north) continue;
    for (const x of [lon, lon - 360, lon + 360]) {
      if (x < fan.west || x > fan.east) continue;
      const { lat: ys, lon: xs } = fan;
      const n = xs.length - 1;
      for (let k = 1; k <= n; k += 1) {
        const [a, b, c] = [0, k, (k % n) + 1];
        const area =
          (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
        if (area === 0) continue;
        const w1 =
          ((x - xs[a]) * (ys[c] - ys[a]) - (lat - ys[a]) * (xs[c] - xs[a])) /
          area;
        const w2 =
          ((xs[b] - xs[a]) * (lat - ys[a]) - (ys[b] - ys[a]) * (x - xs[a])) /
          area;
        const w0 = 1 - w1 - w2;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const mixed = (at: (vertex: number) => number) =>
          w0 * at(a) + w1 * at(b) + w2 * at(c);
        return {
          colour: [0, 1, 2].map((channel) =>
            mixed((vertex) => fan.colour[vertex][channel]),
          ),
          gradient: triangleValueGradient(
            xs[a],
            ys[a],
            fan.value[a],
            xs[b],
            ys[b],
            fan.value[b],
            xs[c],
            ys[c],
            fan.value[c],
          ),
          value: mixed((vertex) => fan.value[vertex]),
        };
      }
    }
  }
  return null;
}

const KENYA = { lat: -1.836, lon: 36.793 }; // the Task 7 fixtures' disk centre
const FIJI = { lat: -17.7, lon: 179.95 };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The res-4 disk of radius `k` round `at`, each cell valued by `value(its centre longitude)`;
 * contours on for both Honmoon geometries. */
function honmoonInput(
  at: { lat: number; lon: number },
  k: number,
  geometry: DrapedGeometry,
  value: (lon: number) => number,
  support: (row: number) => Support = () => 'interpolated',
): SurfaceRasterInput {
  const cells = sortedU64(gridDisk(latLngToCell(at.lat, at.lon, 4), k));
  const mesh = meshInputFor(
    cells.map((h3, row) => ({
      h3,
      support: support(row),
      value: value(cellToLatLng(h3)[1]),
    })),
  );
  return {
    ...mesh,
    cells: { masked: true, supported: true },
    contours: geometry === 'honmoon' || geometry === 'honmoon-fill',
    geometry,
    index: buildGridIndex(mesh.topology),
  };
}

/** Mismatches listed before the rest are only counted. */
const LISTED_MISMATCHES = 20;
/** Far above the 1e-13 by which the scan's and the oracle's sums of the same barycentric terms
 * differ, far below a byte's 0.0039. */
const TIE_NUDGE = 1e-9;

/** Bytes of the texels whose centre lies in a supported fan, against honmoonTexel at the oracle's
 * value and gradient (|∂v/∂column| + |∂v/∂row| = texel degrees × (|∂v/∂lon| + |∂v/∂lat|)). Exact,
 * except at a tie: a channel that lands on a half byte (0.55 × 210 = 115.5 beyond the halo, where a
 * channel's byte is constant across a palette segment) rounds either way with the summation order,
 * so a channel also matches the byte honmoonTexel gives with the colour nudged by ±`TIE_NUDGE`. */
function honmoonMismatches(
  input: SurfaceRasterInput,
  tile: TileAddress,
  mode: 1 | 2,
): { compared: number; mismatches: string[] } {
  const raster = rasterSurfaceTile(input, tile);
  const rect = tileRectangle(tile);
  const texelDegrees = (rect.east - rect.west) / RASTER_TILE_SIZE;
  const expected = new Uint8ClampedArray(4);
  const nudged = [new Uint8ClampedArray(4), new Uint8ClampedArray(4)];
  const mismatches: string[] = [];
  let compared = 0;
  let unlisted = 0;
  for (let row = 0; row < RASTER_TILE_SIZE; row += 1)
    for (let column = 0; column < RASTER_TILE_SIZE; column += 1) {
      const { lat, lon } = texelCentre(tile, column, row);
      const fan = fanAt(input, lon, lat);
      if (!fan) continue;
      compared += 1;
      const derivative =
        texelDegrees * (Math.abs(fan.gradient[0]) + Math.abs(fan.gradient[1]));
      honmoonTexel(fan.colour, fan.value, derivative, mode, expected, 0);
      [-TIE_NUDGE, TIE_NUDGE].forEach((nudge, k) =>
        honmoonTexel(
          fan.colour.map((c) => c + nudge),
          fan.value,
          derivative,
          mode,
          nudged[k],
          0,
        ),
      );
      const actual = raster ? texel(raster, column, row) : [0, 0, 0, 0];
      if (
        actual.every(
          (byte, channel) =>
            byte === expected[channel] ||
            byte === nudged[0][channel] ||
            byte === nudged[1][channel],
        )
      )
        continue;
      if (mismatches.length < LISTED_MISMATCHES)
        mismatches.push(
          `(${column}, ${row}): [${actual.join(', ')}], expected [${[...expected].join(', ')}]`,
        );
      else unlisted += 1;
    }
  if (unlisted > 0) mismatches.push(`and ${unlisted} more`);
  return { compared, mismatches };
}

/** α of every texel of `raster` whose centre lies in a supported fan of `input`. */
function alphaOfFanTexels(
  raster: TileRaster,
  input: SurfaceRasterInput,
  tile: TileAddress,
): number[] {
  const alphas: number[] = [];
  forEachTexel(raster, tile, ({ lat, lon, rgba }) => {
    if (fanAt(input, lon, lat)) alphas.push(rgba[3]);
  });
  return alphas;
}

describe('Honmoon contours in the surface raster (terrain draping design, #483)', () => {
  it.each([
    ['honmoon', 1],
    ['honmoon-fill', 2],
  ] as const)(
    'draws %s contours to the smooth-globe formula at every texel centre',
    (geometry, mode) => {
      const { compared, mismatches } = honmoonMismatches(
        honmoonInput(KENYA, 5, geometry, (lon) => clamp01((lon - 35.4) / 3)),
        { level: 7, x: 154, y: 65 },
        mode,
      );
      expect(mismatches).toEqual([]);
      expect(compared).toBeGreaterThan(50_000);
    },
  );

  it('meets its contours across the antimeridian', () => {
    const input = honmoonInput(FIJI, 3, 'honmoon', (lon) =>
      clamp01((((lon + 360) % 360) - 177) / 6),
    );
    for (const tile of [
      { level: 6, x: 127, y: 38 },
      { level: 6, x: 0, y: 38 },
    ]) {
      const { compared, mismatches } = honmoonMismatches(input, tile, 1);
      expect(mismatches).toEqual([]);
      expect(compared).toBeGreaterThan(5_000);
    }
  });

  it('leaves the support masks as they are', () => {
    const support = (row: number): Support =>
      (['unknown', 'prior_dominated', 'interpolated'] as const)[row % 3];
    const ramp = (lon: number) => clamp01((lon - 35.4) / 3);
    const tile = { level: 7, x: 154, y: 65 };
    const honmoon = honmoonInput(KENYA, 5, 'honmoon', ramp, support);
    const plain = rasterSurfaceTile(
      honmoonInput(KENYA, 5, 'triangles', ramp, support),
      tile,
    )!;
    const lined = rasterSurfaceTile(honmoon, tile)!;
    const changed: number[] = [];
    let outside = 0;
    for (let row = 0; row < 256; row += 1)
      for (let column = 0; column < 256; column += 1) {
        const { lat, lon } = texelCentre(tile, column, row);
        if (fanAt(honmoon, lon, lat)) continue;
        outside += 1;
        const offset = (row * 256 + column) * 4;
        for (let channel = 0; channel < 4; channel += 1)
          if (lined.rgba[offset + channel] !== plain.rgba[offset + channel])
            changed.push(offset);
      }
    expect(changed).toEqual([]);
    expect(outside).toBeGreaterThan(30_000); // two rows in three are masked
  });

  it('returns no tile where line-only Honmoon draws nothing', () => {
    const tile = { level: 7, x: 154, y: 65 };
    // mid-band: 36v = 18.5
    expect(
      rasterSurfaceTile(
        honmoonInput(KENYA, 5, 'honmoon', () => 37 / 72),
        tile,
      ),
    ).toBeNull();
    const input = honmoonInput(KENYA, 5, 'honmoon-fill', () => 37 / 72);
    const fill = rasterSurfaceTile(input, tile)!;
    expect(new Set(alphaOfFanTexels(fill, input, tile))).toEqual(new Set([71])); // 0.28 × 255
  });

  it.each(['triangles', 'hexagons'] as const)(
    'refuses contours on a geometry that has none: %s',
    (geometry) => {
      const input = {
        ...honmoonInput(KENYA, 1, geometry, () => 0.5),
        contours: true,
      };
      expect(() =>
        rasterSurfaceTile(input, { level: 7, x: 154, y: 65 }),
      ).toThrow('Honmoon contours need the honmoon or honmoon-fill geometry');
    },
  );

  it('draws a pole cell through the contour path, with no gap', () => {
    const top = { level: 3, x: 8, y: 0 };
    // 36 × 0.5 = 18: every texel lies on a contour line
    const onLine = rasterSurfaceTile(
      honmoonInput({ lat: 90, lon: 0 }, 1, 'honmoon', () => 0.5),
      top,
    )!;
    // mid-band: only the fill
    const between = rasterSurfaceTile(
      honmoonInput({ lat: 90, lon: 0 }, 1, 'honmoon-fill', () => 37 / 72),
      top,
    )!;
    for (let column = 0; column < 256; column += 1) {
      expect(texel(onLine, column, 255)[3]).toBe(255);
      expect(texel(between, column, 255)[3]).toBe(71);
    }
  });

  // A pole-holding row reads its value's change across one texel only when the mesh asks for it
  // (`derivatives`). Ramped round the pole, the pole cell's corners differ, so its lines are as
  // wide as that change makes them, not the 0.006-clamped narrowest a zero change would draw.
  it("widens a pole cell's contours by its value's change across a texel", () => {
    const top = { level: 7, x: 0, y: 0 }; // 88.6–90° N: the pole cell fills its top rows
    const input = honmoonInput({ lat: 90, lon: 0 }, 1, 'honmoon', (lon) =>
      clamp01((lon + 180) / 360),
    );
    const raster = rasterSurfaceTile(input, top)!;
    let compared = 0;
    let lit = 0;
    let halo = 0;
    for (let row = 255; row > 255 - 16; row -= 1)
      for (let column = 0; column < 256; column += 1) {
        const alpha = texel(raster, column, row)[3];
        compared += 1;
        if (alpha > 0) lit += 1;
        if (alpha > 0 && alpha < 255) halo += 1;
      }
    // The narrowest line lights at most 2 × 4.5 × 0.006 of a band: under 6% of the texels.
    expect(lit / compared).toBeGreaterThan(0.5);
    expect(halo).toBeGreaterThan(0);
  });
});
