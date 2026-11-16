/**
 * Byte pins of the draped surface raster (terrain draping design, "Per layer under World Terrain"
 * and "Test plan", #483). Each case's tiles, at every level from 0 to 9 that holds one of its
 * cells, are hashed (sha256) as the rasteriser drew them at 7833c12, before its coarse tiles were
 * made cheap: fill, palette bins, Honmoon contours and both support masks, round a pole and across
 * ±180°. A faster path must draw the same bytes, so any change here is a change in what users see.
 */

import { createHash } from 'node:crypto';

import { gridDisk, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { rasterSurfaceTile } from '../src/atlas/geometry/raster/fill-raster';
import type {
  DrapedGeometry,
  SurfaceRasterSpec,
} from '../src/atlas/geometry/raster/types';
import type { Support } from '../src/atlas/contracts';
import type { PaletteId } from '../src/atlas/visual-encoding';
import { sortedU64 } from './helpers/mesh-input';
import {
  rasterInputFor,
  tilesCovering,
  type TestCell,
} from './helpers/raster-fixtures';

/** Every support code in turn, so both masks sit beside both kinds of supported cell. */
const SUPPORT_CYCLE: readonly Support[] = [
  'observed',
  'unknown',
  'interpolated',
  'prior_dominated',
];

/** The disk of `k` rings round `centre`, its supports cycled and valued `(row % 7) / 6`. */
function mixedDisk(centre: string, k: number): TestCell[] {
  return sortedU64(gridDisk(centre, k)).map((h3, row) => ({
    h3,
    support: SUPPORT_CYCLE[row % SUPPORT_CYCLE.length],
    value: (row % 7) / 6,
  }));
}

const KENYA = mixedDisk(latLngToCell(-1.836, 36.793, 4), 5);
const POLE = mixedDisk(latLngToCell(90, 0, 4), 2);
const SEAM = mixedDisk(latLngToCell(0, 180, 4), 2);

interface Case {
  cells: TestCell[];
  geometry: DrapedGeometry;
  palette?: PaletteId;
  cellSets?: SurfaceRasterSpec['cells'];
  contours?: boolean;
}

/** Per level, the sha256 (first 16 hex digits) of its tiles' addresses and bytes in order, an
 * empty tile as `null`. */
function levelDigests(c: Case): Record<number, string> {
  const input = {
    ...rasterInputFor(c.cells, {
      cells: c.cellSets,
      geometry: c.geometry,
      palette: c.palette,
    }),
    contours: c.contours ?? false,
  };
  const digests: Record<number, string> = {};
  for (let level = 0; level <= 9; level += 1) {
    const hash = createHash('sha256');
    for (const a of tilesCovering(input, level)) {
      hash.update(`${a.level}/${a.x}/${a.y}:`);
      const tile = rasterSurfaceTile(input, a);
      hash.update(tile ? tile.rgba : 'null');
    }
    digests[level] = hash.digest('hex').slice(0, 16);
  }
  return digests;
}

describe('surface raster bytes (terrain draping design, #483)', () => {
  it.each<[string, Case, Record<number, string>]>([
    [
      'smooth triangles with both masks',
      { cells: KENYA, geometry: 'triangles' },
      {
        0: '86dc3255f88c0413',
        1: '6c95b13d30abd5ef',
        2: '5e8128b8bbac811c',
        3: '8a0178355dd99950',
        4: '7d77092eb905bb7d',
        5: '6b1b556ba0a0228b',
        6: 'ad5631904062c5de',
        7: 'd9ffd237b4d17640',
        8: '1f2aa28cc6aa1a34',
        9: 'bdd83221d5c83932',
      },
    ],
    [
      'palette-bin hexagons in viridis',
      { cells: KENYA, geometry: 'hexagons', palette: 'viridis' },
      {
        0: '081081b390ac81a7',
        1: '7c5ce1550abec644',
        2: '70ba3692ece17ef8',
        3: 'a114b83c5400b365',
        4: '6c41100417504580',
        5: '5ede940dfdab19ed',
        6: '2f57ab94dff85d4e',
        7: 'fef91fff287edc4c',
        8: 'f8c74bf02dda3eb7',
        9: '2922b6b993b06bfa',
      },
    ],
    [
      'Honmoon contours',
      { cells: KENYA, contours: true, geometry: 'honmoon' },
      {
        0: 'bba8dd85e46bcfb9',
        1: '10475a1a6d5f3775',
        2: 'fd497bd4d99fceac',
        3: '164f8d87bf58ee7e',
        4: '15614e349e75e91b',
        5: 'e4f5facf0a9999a8',
        6: 'fc8b7897f436ac81',
        7: '8235830d022eb807',
        8: 'e38aec5950993886',
        9: 'c3c2edfc3517116c',
      },
    ],
    [
      'the Honmoon fill without contours',
      { cells: KENYA, geometry: 'honmoon-fill' },
      {
        0: 'be80022f876fb472',
        1: '1f76ceba0af9879a',
        2: 'b08c85b2ad13af2d',
        3: '481338efba910a13',
        4: '424a366cc65cd487',
        5: 'f4d081a4b7798681',
        6: '08f99a4f97a4cbf3',
        7: 'acf776301b5ee9d3',
        8: '2675310790497101',
        9: '955d2a6901d6313b',
      },
    ],
    [
      'the supported cells alone',
      {
        cellSets: { masked: false, supported: true },
        cells: KENYA,
        geometry: 'triangles',
      },
      {
        0: '5a5b4719b25a28a5',
        1: 'f0ebbf4421511372',
        2: '0cc9a73a84977771',
        3: 'f8c8387b47de9bfc',
        4: '079f35f4ef1e0716',
        5: 'f53d1111f7985880',
        6: '042bdb02e795d039',
        7: 'f3dd3669c46a01d6',
        8: 'a2e3f167a8278634',
        9: '0c9789875ce6d099',
      },
    ],
    [
      'the masks alone',
      {
        cellSets: { masked: true, supported: false },
        cells: KENYA,
        geometry: 'triangles',
      },
      {
        0: '63909a2cca46f72f',
        1: '5ab2aad5313ebf0f',
        2: '1138b7e5515b6b9f',
        3: 'a58865a2d4b06d17',
        4: '1765627418555c36',
        5: '46e38be3c2997f98',
        6: '3963fada7682c894',
        7: '639d9da68afedd47',
        8: '13d314ac2d0f95fc',
        9: 'a2e8bb2a97de1565',
      },
    ],
    [
      'a pole in triangles',
      { cells: POLE, geometry: 'triangles' },
      {
        0: 'ddbfa5c8df6c93a5',
        1: '3bee8bd405a1615c',
        2: '6b8986e0a4fca5bb',
        3: '7d621d52d7404ee6',
        4: '9cff2f1107dc2b8c',
        5: '6521353f51b3ac4c',
        6: '2066497a815e97fc',
        7: '2e37e46786edbbe7',
        8: 'ef0e9ce80619edcf',
        9: 'c873d12c98ac5025',
      },
    ],
    [
      'a pole in Honmoon contours',
      { cells: POLE, contours: true, geometry: 'honmoon-fill' },
      {
        0: 'fe052b5fc440131a',
        1: 'd084712b9b3ab933',
        2: '62202ee4a6af531e',
        3: 'f1df1f363357cf41',
        4: '5f32b4828c27f10c',
        5: 'b9409660084fcae1',
        6: 'd0657ae7dd093deb',
        7: '68be028b9a80ea28',
        8: 'aa33cabb7bd4780e',
        9: '1cd8c30708cca74e',
      },
    ],
    [
      'the antimeridian in triangles',
      { cells: SEAM, geometry: 'triangles' },
      {
        0: '521117d5e3ddea3c',
        1: '1973149309bc31d0',
        2: 'd30d049ee6742f40',
        3: '02308cc91eee702b',
        4: '2112489394d57dfc',
        5: '972c14bc7772071e',
        6: '3d337e501bd15627',
        7: '8009d36bbf063b9f',
        8: 'cea98eea2f4614c7',
        9: 'e1f2bb785794ee4f',
      },
    ],
    [
      'the antimeridian in hexagons',
      { cells: SEAM, geometry: 'hexagons' },
      {
        0: 'f751c78b431e8711',
        1: 'cb8cb433ec293178',
        2: '414cf7b7a76ce79f',
        3: '6c4924ecceb2916b',
        4: '277d64e503236d69',
        5: 'b6d87bb48a2254fc',
        6: 'acde39dc4b719cdd',
        7: '8d8ff1c29a7cb2eb',
        8: '2e449ba5286de631',
        9: '76f8b8db3855c855',
      },
    ],
  ])('draws %s as pinned', (_name, c, pinned) => {
    expect(levelDigests(c)).toEqual(pinned);
  });
});
