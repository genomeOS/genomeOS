/** The Natural Earth GeoJSON parse the Atlas data worker ran until issue #445 (fast-load spec
 * 2026-10-07 §B.6.9), kept verbatim as the reference the compact GOBD decoder is held to (§B.10).
 *
 * It reproduces what `GeoJsonDataSource` plus `GeographicOverlay.load` drew: one ring per polygon
 * outer boundary (holes are not drawn), closed by repeating its first coordinate; one label per
 * distinct country text at LABEL_X/LABEL_Y, first occurrence wins. The site no longer parses
 * GeoJSON: `scripts/encode_natural_earth_borders.py` validates the source and writes GOBD, which
 * `decodeNaturalEarth` reads.
 */

import {
  countryLabelText,
  type CountryProperties,
  type NaturalEarthBuffers,
  type NaturalEarthLabel,
} from '../../src/atlas/geometry/natural-earth';

type Position = [number, number, ...number[]];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((coordinate) => Number.isFinite(coordinate))
  );
}

/** An RFC 7946 §3.1.6 linear ring: four or more positions, first equal to last. */
function linearRing(ring: unknown, where: string): Position[] {
  if (!Array.isArray(ring)) throw new TypeError(`${where} is not an array`);
  if (!ring.every(isPosition))
    throw new TypeError(`${where} has a non-numeric position`);
  if (ring.length < 4)
    throw new TypeError(`${where} has fewer than four positions`);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (
    first.length !== last.length ||
    first.some((coordinate, axis) => coordinate !== last[axis])
  )
    throw new TypeError(`${where} is not closed`);
  return ring;
}

function polygonRings(polygon: unknown, where: string): Position[][] {
  if (!Array.isArray(polygon))
    throw new TypeError(`${where} coordinates are not an array`);
  return polygon.map((ring, index) =>
    linearRing(ring, `${where} ring ${index}`),
  );
}

/** The feature's polygons, or `null` for an unlocated (`geometry: null`) feature. */
function featurePolygons(
  geometry: unknown,
  where: string,
): Position[][][] | null {
  if (geometry === null) return null;
  if (!isRecord(geometry))
    throw new TypeError(`${where} geometry must be a GeoJSON geometry or null`);
  const { type, coordinates } = geometry;
  if (type === 'Polygon')
    return [polygonRings(coordinates, `${where} Polygon`)];
  if (type === 'MultiPolygon') {
    if (!Array.isArray(coordinates))
      throw new TypeError(`${where} MultiPolygon coordinates are not an array`);
    return coordinates.map((polygon, index) =>
      polygonRings(polygon, `${where} MultiPolygon polygon ${index}`),
    );
  }
  throw new TypeError(
    `${where} has unsupported geometry type ${JSON.stringify(type)}; ` +
      'Natural Earth borders are Polygon or MultiPolygon',
  );
}

export function parseNaturalEarthGeoJson(json: unknown): NaturalEarthBuffers {
  if (
    !isRecord(json) ||
    json.type !== 'FeatureCollection' ||
    !Array.isArray(json.features)
  )
    throw new TypeError(
      'Natural Earth data must be a GeoJSON FeatureCollection',
    );
  const ringOffsets: number[] = [0];
  const lonLat: number[] = [];
  const labels: NaturalEarthLabel[] = [];
  const labelled = new Set<string>();
  json.features.forEach((feature: unknown, index) => {
    const where = `Natural Earth feature ${index}`;
    if (!isRecord(feature) || feature.type !== 'Feature')
      throw new TypeError(`${where} is not a GeoJSON Feature`);
    const { properties } = feature;
    if (
      properties !== undefined &&
      properties !== null &&
      !isRecord(properties)
    )
      throw new TypeError(`${where} properties must be an object or null`);
    const polygons = featurePolygons(feature.geometry, where);
    // Cesium made one entity per non-empty polygon, or one for a null
    // geometry, and the overlay offered each entity's text as a label.
    let hasEntity = polygons === null;
    for (const polygon of polygons ?? []) {
      if (polygon.length === 0) continue;
      const outer = polygon[0];
      for (const [lon, lat] of [...outer, outer[0]]) lonLat.push(lon, lat);
      ringOffsets.push(lonLat.length / 2);
      hasEntity = true;
    }
    if (!hasEntity || !properties) return;
    const country = properties as CountryProperties;
    const text = countryLabelText(country);
    const lon = country.LABEL_X;
    const lat = country.LABEL_Y;
    if (
      !text ||
      labelled.has(text) ||
      typeof lon !== 'number' ||
      !Number.isFinite(lon) ||
      typeof lat !== 'number' ||
      !Number.isFinite(lat)
    )
      return;
    labelled.add(text);
    labels.push({
      lat,
      lon,
      minLabel: typeof country.MIN_LABEL === 'number' ? country.MIN_LABEL : 7,
      text,
    });
  });
  return {
    labels,
    lonLat: Float64Array.from(lonLat),
    ringOffsets: Uint32Array.from(ringOffsets),
  };
}
