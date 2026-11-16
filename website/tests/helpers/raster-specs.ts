/**
 * Raster specs shared by the draped-surface tests (terrain draping design, "Per layer under World
 * Terrain", #483).
 */

import type {
  BorderRasterSpec,
  SurfaceRasterSpec,
} from '../../src/atlas/geometry/raster/types';

export const SURFACE_SPEC: SurfaceRasterSpec = {
  artifactKey: 'hbs-rs334:v1:map-2026-08',
  cells: { masked: true, supported: true },
  contours: false,
  geometry: 'triangles',
  gridSha256: 'test-grid',
  layer: 'surface',
  metric: 'post_mean',
  palette: 'rainbow',
};

export const BORDER_SPEC: BorderRasterSpec = {
  color: '#ffffff',
  layer: 'borders',
  maximumLevel: 11,
};
