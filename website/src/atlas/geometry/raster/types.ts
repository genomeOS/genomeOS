/**
 * Raster contracts and constants of the draped Atlas layers (terrain draping design, "Decision" and
 * "Per layer under World Terrain", #483).
 *
 * The data worker rasterises H3 cells and lines into 256 × 256 RGBA tiles on Cesium's
 * `GeographicTilingScheme` (two 180° roots, y counted from the north, levels 0–11), and Cesium
 * drapes them as four imagery layers. Texel rows are south-first: the texel at (column, row) starts
 * at byte `(row × 256 + column) × 4`, row 0 southernmost. Main-thread code outside the lazy draped
 * modules imports only the types of this module.
 */

import type { EdgeColorSpec } from '../edge-buffers';
import type { MeshInput } from '../surface-buffers';
import type { SurfaceGeometry } from '../../url-state';
import type { Metric, PaletteId } from '../../visual-encoding';

/** The Atlas imagery layers, bottom to top, all above the basemap. */
export type AtlasImageryLayerName =
  'atlas-surface' | 'atlas-outlines' | 'atlas-borders' | 'atlas-footprints';

/** Layer order, bottom to top. */
export const ATLAS_IMAGERY_LAYER_ORDER: readonly AtlasImageryLayerName[] = [
  'atlas-surface',
  'atlas-outlines',
  'atlas-borders',
  'atlas-footprints',
];

/** A tile of the geographic tiling scheme; `y` counts from the north. */
export interface TileAddress {
  x: number;
  y: number;
  level: number;
}

/** WGS84 decimal degrees. */
export interface DegreeRectangle {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** `RASTER_TILE_SIZE`² RGBA texels, rows south-first. */
export interface TileRaster {
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** Extruded draws as hexagons under World Terrain, so it is never rasterised. */
export type DrapedGeometry = Exclude<SurfaceGeometry, 'extruded'>;

/** The artifact columns and style a surface or outline raster reads. */
export interface ArtifactRaster {
  artifactKey: string;
  gridSha256: string;
  metric: Metric;
  palette: PaletteId;
  geometry: DrapedGeometry;
}

export interface SurfaceRasterSpec extends ArtifactRaster {
  layer: 'surface';
  /** `supported` draws the supported cells' fill, `masked` the hatch and dot masks. */
  cells: { supported: boolean; masked: boolean };
  /** Honmoon contour bands; only a Honmoon geometry may ask for them. */
  contours: boolean;
}

export interface OutlineRasterSpec extends ArtifactRaster {
  layer: 'outlines';
  edgeColor: EdgeColorSpec;
}

export interface BorderRasterSpec {
  layer: 'borders';
  /** `#rrggbb`. */
  color: string;
  /** The provider's deepest level; no border tile is drawn above it. */
  maximumLevel: number;
}

export interface FootprintRasterSpec {
  layer: 'footprints';
  artifactKey: string;
  /** Interleaved lon, lat (degrees), radius_km triples. */
  circles: Float64Array;
  /** `#rrggbb`. */
  color: string;
}

export type RasterSpec =
  | SurfaceRasterSpec
  | OutlineRasterSpec
  | BorderRasterSpec
  | FootprintRasterSpec;

/** Texels along each tile side. */
export const RASTER_TILE_SIZE = 256;
/** The deepest tile level, about 38 m per texel. */
export const RASTER_MAX_LEVEL = 11;
/** Coarser than this, a 1.5-texel outline covers the whole cell, so none is drawn. */
export const OUTLINE_MIN_LEVEL = 3;
/** GPU bytes of one resident tile: 256² RGBA plus its mip chain (× 4/3). */
export const RESIDENT_TILE_BYTES = 349_525;
/** Outline width in texels, linear from `OUTLINE_MIN_LEVEL` to `RASTER_MAX_LEVEL`. */
export const OUTLINE_WIDTH_TEXELS = [1.5, 2] as const;
/** The `atlas-surface` layer's own α factor. The layer scales its whole texture by it, so the mask
 * texels, which the chunk path draws unscaled, store their material α divided by it. */
export const DRAPED_SURFACE_ALPHA = 0.9;

/** Grid rows by rectangle, with ±360° copies of rows that cross the antimeridian. */
export interface GridIndex {
  /** Each row overlapping `r` once, ascending; `out` is reused when given. */
  rowsIn(r: DegreeRectangle, out?: number[]): number[];
  /** The union of the drawn rows' extents; null when no row is drawn. */
  bounds(drawn: (row: number) => boolean): DegreeRectangle | null;
}

/** What the surface and outline rasterisers read for one artifact. */
export interface SurfaceRasterInput extends Pick<
  MeshInput,
  'grid' | 'topology' | 'support' | 'values' | 'domain' | 'palette'
> {
  geometry: DrapedGeometry;
  index: GridIndex;
  cells: SurfaceRasterSpec['cells'];
  contours: boolean;
}

/** The worker's rasterisers, injected into its raster runtime; null is an empty tile. */
export interface Rasterisers {
  surface(i: SurfaceRasterInput, a: TileAddress): TileRaster | null;
  outlines(
    i: SurfaceRasterInput & { edgeColor: EdgeColorSpec },
    a: TileAddress,
  ): TileRaster | null;
}
