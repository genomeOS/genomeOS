import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { h3PolygonParts } from '../src/atlas/geometry/polygon-parts';
import { rasterSurfaceTile } from '../src/atlas/geometry/raster/fill-raster';
import { dotTexel, hatchTexel } from '../src/atlas/geometry/raster/mask-texels';
import {
  flatCellBuffers,
  stAt,
  stFrameOf,
} from '../src/atlas/geometry/support-buffers';
import { paletteBins } from '../src/atlas/geometry/surface-buffers';
import { geodeticToEcef, type Vec3 } from '../src/atlas/geometry/wgs84';
import { UNKNOWN_HATCH } from '../src/atlas/encoding-tokens';
import { meshInputFor } from './helpers/mesh-input';
import {
  forEachTexel,
  KENYA_CELLS,
  poleCells,
  rasterInputFor,
  rowOfCellAt,
  texel,
  tileContaining,
  type TestCell,
} from './helpers/raster-fixtures';

/** A res-3 hexagon beside a pentagon (at an icosahedron vertex): class III, so its boundary
 * carries a distortion vertex beyond its six corners. */
const CELL = '83d602fffffffff';

/** Cesium's display gamma (`Scene.gamma`, `czm_gamma`), which Atlas leaves at its default. */
const SCENE_GAMMA = 2.2;
/** The hatch rgb bytes under HDR: #a8b5c9 × 0.5 × 2^(1 / 2.2). */
const HATCH_RGB = [115, 124, 138];

function engineSource(file: string): string {
  return readFileSync(
    path.resolve(
      import.meta.dirname,
      '../node_modules/@cesium/engine/Source',
      file,
    ),
    'utf8',
  );
}

function ecef(lon: number, lat: number, height: number): Vec3 {
  const point: Vec3 = [0, 0, 0];
  geodeticToEcef(lon, lat, height, point);
  return point;
}

describe('support mask texels (terrain draping design, #483)', () => {
  it("hatches unknown cells with the Grid material's formula (UNKNOWN_HATCH)", () => {
    const out = new Uint8ClampedArray(4);
    hatchTexel([0, 0.37], [0.01, 0.01], out, 0); // on a line: value 0
    expect([...out]).toEqual([...HATCH_RGB, 204]); // α 0.72 / 0.9
    hatchTexel([0.1, 0.1], [0.01, 0.01], out, 0); // between lines: value 1
    expect(out[3]).toBe(49); // 0.72 × (1 − 0.76) / 0.9 × 255
  });

  it("shows the light the chunk masks' Grid shows under HDR, the nearest byte to it", () => {
    // Grid writes 0.5 × colour, gamma-corrected, into both diffuse and emission, and the FLAT mask
    // appearance shows their sum; imagery shows texel^γ. Atlas turns HDR on (scene-policy.ts).
    const colour = [1, 3, 5].map((offset) =>
      Number.parseInt(UNKNOWN_HATCH.color.slice(offset, offset + 2), 16),
    );
    const out = new Uint8ClampedArray(4);
    hatchTexel([0, 0.37], [0.01, 0.01], out, 0);
    colour.forEach((byte, channel) => {
      const chunk = 2 * ((0.5 * byte) / 255) ** SCENE_GAMMA;
      const shown = (texelByte: number) =>
        Math.abs((texelByte / 255) ** SCENE_GAMMA - chunk);
      expect(shown(out[channel])).toBeLessThan(shown(out[channel] - 1));
      expect(shown(out[channel])).toBeLessThan(shown(out[channel] + 1));
    });
  });

  it('pins the Cesium terms the hatch and dot shades rest on', () => {
    const grid = engineSource('Shaders/Materials/GridMaterial.glsl');
    expect(grid).toContain('halfColor.rgb = color.rgb * 0.5;');
    expect(grid).toContain('halfColor = czm_gammaCorrect(halfColor);');
    expect(grid).toContain('material.diffuse = halfColor.rgb;');
    expect(grid).toContain('material.emission = halfColor.rgb;');
    const dot = engineSource('Shaders/Materials/DotMaterial.glsl');
    expect(dot).toContain('material.diffuse = color.rgb;');
    expect(dot).not.toContain('material.emission');
    expect(engineSource('Scene/Scene.js')).toContain(
      `this.gamma = ${SCENE_GAMMA};`,
    );
    expect(engineSource('Shaders/GlobeFS.glsl')).toContain(
      'vec4 tempColor = czm_gammaCorrect(vec4(color, alpha));',
    );
  });

  it("dots prior-dominated cells with the Dot material's formula in their bin colour (PRIOR_DOTS)", () => {
    const out = new Uint8ClampedArray(4);
    dotTexel([0.05, 0.05], [200, 40, 40], out, 0); // a dot's centre: the light colour
    expect([...out]).toEqual([
      Math.round(200 + (255 - 200) * 0.38),
      Math.round(40 + 215 * 0.38),
      Math.round(40 + 215 * 0.38),
      232,
    ]);
    dotTexel([0, 0], [200, 40, 40], out, 0); // between dots: the dark colour
    expect([...out]).toEqual([200, 40, 40, 130]);
  });

  it("takes st from each part's tangent-plane frame, as the chunk masks do", () => {
    const input = meshInputFor([{ h3: CELL, support: 'unknown', value: 0.5 }]);
    const buffers = flatCellBuffers(input, [0]);
    const ring = h3PolygonParts(CELL)[0].map(([lon, lat]) => ecef(lon, lat, 0));
    expect(ring.length).toBeGreaterThan(6);
    ring.forEach((point, i) =>
      expect(stAt(stFrameOf(ring), point)).toEqual([
        expect.closeTo(buffers.st[(i + 1) * 2], 6),
        expect.closeTo(buffers.st[(i + 1) * 2 + 1], 6),
      ]),
    );
  });

  it('draws unknown cells as the hatch and prior-dominated cells as dots in their bin colour', () => {
    const cells: TestCell[] = KENYA_CELLS.map((cell, row) => ({
      ...cell,
      support: row % 2 === 0 ? 'unknown' : 'prior_dominated',
    }));
    const input = rasterInputFor(cells, { geometry: 'hexagons' });
    const bins = paletteBins(input, 'prior_dominated');
    const a = tileContaining(36.793, -1.836, 8);
    const hatch = new Set<number>();
    const dots = new Set<number>();
    forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
      const row = rowOfCellAt(input, lon, lat, 8);
      if (row === null) return;
      if (cells[row].support === 'unknown') {
        expect(rgba.slice(0, 3)).toEqual(HATCH_RGB);
        expect(rgba[3]).toBeGreaterThanOrEqual(49);
        expect(rgba[3]).toBeLessThanOrEqual(204);
        hatch.add(rgba[3]);
        return;
      }
      // mix(light, dark, b): α from 232 (b = 0) to 130 (b = 1), rgb along the same blend
      const dark = bins.colors.get(bins.binOfRow[row])!;
      const light = dark.map((c) => c + (255 - c) * 0.38);
      expect(rgba[3]).toBeGreaterThanOrEqual(130);
      expect(rgba[3]).toBeLessThanOrEqual(232);
      const blend = (232 - rgba[3]) / (232 - 130);
      for (let c = 0; c < 3; c += 1)
        expect(
          Math.abs(rgba[c] - (light[c] * (1 - blend) + dark[c] * blend)),
        ).toBeLessThanOrEqual(1.5);
      dots.add(rgba[3]);
    });
    // lines and the cells between them; dots and the ground between them
    for (const alpha of [204, 49]) expect(hatch).toContain(alpha);
    for (const alpha of [232, 130]) expect(dots).toContain(alpha);
  });

  it('masks a cell that holds a pole all the way round, out to the pole', () => {
    // The polar branch: h3PolygonParts' parts, with central-difference derivatives.
    const a = { level: 3, x: 8, y: 0 }; // lon 0..22.5, lat 67.5..90
    for (const support of ['unknown', 'prior_dominated'] as const) {
      const input = rasterInputFor(
        poleCells().map((cell) => ({ ...cell, support })),
        { geometry: 'hexagons' },
      );
      const top = rasterSurfaceTile(input, a)!;
      const [low, high] = support === 'unknown' ? [49, 204] : [130, 232];
      for (let column = 0; column < 256; column += 1) {
        const rgba = texel(top, column, 255);
        if (support === 'unknown') expect(rgba.slice(0, 3)).toEqual(HATCH_RGB);
        expect(rgba[3]).toBeGreaterThanOrEqual(low);
        expect(rgba[3]).toBeLessThanOrEqual(high);
      }
    }
  });
});
