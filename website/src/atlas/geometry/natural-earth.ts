/** Natural Earth borders and country labels in the Atlas data worker (fast-load spec 2026-10-07
 * §B.6.9, §B.10): the buffers the context overlay draws, the label rules, and the border and label
 * heights over a surface.
 *
 * `decodeNaturalEarth` (natural-earth-codec.ts) fills the buffers from the compact GOBD borders
 * the way the earlier GeoJSON parse did, reproducing what `GeoJsonDataSource` plus
 * `GeographicOverlay.load` drew: one ring per polygon outer boundary (holes are not drawn), closed
 * by repeating its first coordinate; one label per distinct country text at LABEL_X/LABEL_Y, first
 * occurrence wins. Context only, never science. Label properties stay optional, as the overlay
 * read them: no text or no finite LABEL_X/LABEL_Y means no label, and a missing MIN_LABEL means 7.
 */

import { gridDisk, latLngToCell } from 'h3-js';

import type { DecodedGrid } from '../gosa/types';
import { heightFor, type MetricDomain } from '../visual-encoding';
import { supportName } from './support-codes';
import { gridRowOf } from './topology';

export interface CountryProperties {
  ADMIN?: unknown;
  LABEL_X?: unknown;
  LABEL_Y?: unknown;
  MIN_LABEL?: unknown;
  NAME?: unknown;
  NAME_LONG?: unknown;
}

export interface NaturalEarthLabel {
  text: string;
  lon: number;
  lat: number;
  minLabel: number;
}

export interface NaturalEarthBuffers {
  ringOffsets: Uint32Array;
  /** Interleaved lon, lat in degrees. */
  lonLat: Float64Array;
  labels: NaturalEarthLabel[];
}

export function countryLabelText(properties: CountryProperties): string | null {
  for (const value of [properties.NAME_LONG, properties.ADMIN, properties.NAME])
    if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** A feature's label, or null when it has no text, no finite anchor, or a text already labelled
 * (added to `labelled` when it is not). */
export function labelFor(
  properties: CountryProperties,
  labelled: Set<string>,
): NaturalEarthLabel | null {
  const text = countryLabelText(properties);
  const lon = properties.LABEL_X;
  const lat = properties.LABEL_Y;
  if (
    !text ||
    labelled.has(text) ||
    typeof lon !== 'number' ||
    !Number.isFinite(lon) ||
    typeof lat !== 'number' ||
    !Number.isFinite(lat)
  )
    return null;
  labelled.add(text);
  return {
    lat,
    lon,
    minLabel:
      typeof properties.MIN_LABEL === 'number' ? properties.MIN_LABEL : 7,
    text,
  };
}

export interface ContextSurface {
  grid: DecodedGrid;
  support: Uint8Array;
  values: Float32Array;
  domain: MetricDomain;
}

function supportedSurfaceHeight(
  lat: number,
  lon: number,
  surface: ContextSurface,
): number {
  const index = latLngToCell(lat, lon, surface.grid.resolution);
  let height = 0;
  for (const candidate of gridDisk(index, 1)) {
    const row = gridRowOf(surface.grid, candidate);
    if (row !== null)
      height = Math.max(
        height,
        heightFor(
          supportName(surface.support[row]),
          surface.values[row],
          surface.domain,
          1,
        ),
      );
  }
  return height;
}

/** Border and label heights at exaggeration 1 (legacy `#refreshSurfaceHeights`). */
export function naturalEarthHeights(
  buffers: Pick<NaturalEarthBuffers, 'lonLat' | 'labels'>,
  surface: ContextSurface,
): { borderHeights: Float32Array; labelHeights: Float32Array } {
  const borderHeights = new Float32Array(buffers.lonLat.length / 2);
  for (let vertex = 0; vertex < borderHeights.length; vertex += 1)
    borderHeights[vertex] = supportedSurfaceHeight(
      buffers.lonLat[vertex * 2 + 1],
      buffers.lonLat[vertex * 2],
      surface,
    );
  return {
    borderHeights,
    labelHeights: Float32Array.from(buffers.labels, (label) =>
      supportedSurfaceHeight(label.lat, label.lon, surface),
    ),
  };
}
