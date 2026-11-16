/**
 * Sampling footprint rings for the draped `atlas-footprints` layer (terrain draping design, "Per
 * layer under World Terrain": sampling footprints; "Failure modes": antimeridian and polar
 * footprints, #483).
 *
 * Each observation's circle is ringed as `samplingRingSamples` does on the smooth globe
 * (observation-layer.ts): `FOOTPRINT_RING_SEGMENTS` vertices from due north on the 6,371.0088 km
 * sphere. A footprint raster's rings are closed and unwrapped along their length, so one across
 * ±180° spans both sides and one round a pole spans 360° of longitude. Circles that are not finite
 * lon, lat, radius_km > 0 triples are an error. `line-raster.ts` re-exports it; like every
 * `geometry/raster/*` module it loads only through the raster runtime's `import()`. Nothing here is
 * stochastic.
 */

/** Vertices of a footprint ring, as `samplingRingSamples` draws it. */
export const FOOTPRINT_RING_SEGMENTS = 48;

/** The sphere `samplingRingSamples` rings footprints on (observation-layer.ts). */
const EARTH_RADIUS_KM = 6_371.0088;

const FOOTPRINT_CIRCLES_ERROR =
  'sampling footprints must be lon, lat, radius_km triples with a positive radius';

/** Throws unless `circles` is whole triples of a finite WGS84 lon, lat and a finite radius_km > 0. */
export function validateFootprintCircles(circles: Float64Array): void {
  if (circles.length % 3 !== 0)
    throw new Error(
      `${FOOTPRINT_CIRCLES_ERROR}; got ${circles.length} numbers`,
    );
  for (let k = 0; k < circles.length; k += 3) {
    const [lon, lat, radiusKm] = [circles[k], circles[k + 1], circles[k + 2]];
    if (!(
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90 &&
      radiusKm > 0 &&
      Number.isFinite(radiusKm)
    ))
      throw new Error(
        `${FOOTPRINT_CIRCLES_ERROR}; circle ${k / 3} is ${lon}, ${lat}, ${radiusKm}`,
      );
  }
}

/** The ring `radiusKm` round (lon, lat): `segments` vertices at bearings 2πk / segments from due
 * north, as interleaved lon, lat degrees, implicitly closed. Each vertex's lon lies within 180° of
 * the centre's (`samplingRingSamples`' destination formula). */
export function footprintRing(
  lon: number,
  lat: number,
  radiusKm: number,
  segments = FOOTPRINT_RING_SEGMENTS,
): Float64Array {
  const angularDistance = radiusKm / EARTH_RADIUS_KM;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const ringOf = new Float64Array(2 * segments);
  for (let k = 0; k < segments; k += 1) {
    const bearing = (k / segments) * Math.PI * 2;
    const lat2 = Math.asin(
      Math.min(
        1,
        Math.max(
          -1,
          Math.sin(lat1) * Math.cos(angularDistance) +
            Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
        ),
      ),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
      );
    ringOf[2 * k] = (lon2 * 180) / Math.PI;
    ringOf[2 * k + 1] = (lat2 * 180) / Math.PI;
  }
  return ringOf;
}

/** A footprint raster's rings, closed and unwrapped along their length, and their extents. */
export interface FootprintRings {
  count: number;
  /** `FOOTPRINT_RING_POINTS` points per ring: the vertices, then the first again. */
  lonLat: Float64Array;
  /** West, south, east, north of each ring, in its unwrapped longitudes. */
  boxes: Float64Array;
}

/** Points of each closed ring in `FootprintRings.lonLat`: the vertices, then the first again. */
export const FOOTPRINT_RING_POINTS = FOOTPRINT_RING_SEGMENTS + 1;
/** The longitude difference taken to within 180°. */
const wrapped = (degrees: number) => degrees - 360 * Math.round(degrees / 360);

/** One ring set per circles array, which is read once: it must not change afterwards. */
const FOOTPRINT_RINGS = new WeakMap<Float64Array, FootprintRings>();

/** The rings of `circles` (checked by `validateFootprintCircles`), closed and unwrapped, with
 * their extents; built once per array. */
export function footprintRings(circles: Float64Array): FootprintRings {
  const cached = FOOTPRINT_RINGS.get(circles);
  if (cached) return cached;
  validateFootprintCircles(circles);
  const count = circles.length / 3;
  const lonLat = new Float64Array(2 * FOOTPRINT_RING_POINTS * count);
  const boxes = new Float64Array(4 * count);
  const segments = FOOTPRINT_RING_SEGMENTS;
  for (let ring = 0; ring < count; ring += 1) {
    const ringOf = footprintRing(
      circles[3 * ring],
      circles[3 * ring + 1],
      circles[3 * ring + 2],
    );
    // Each point's lon lies within 180° of the last one's, so a ring round a pole spans 360°.
    let lon = wrapped(ringOf[0]);
    let [west, south, east, north] = [lon, Infinity, lon, -Infinity];
    for (let point = 0; point < FOOTPRINT_RING_POINTS; point += 1) {
      const vertex = point % segments;
      if (point > 0)
        lon += wrapped(
          ringOf[2 * vertex] - ringOf[2 * ((vertex + segments - 1) % segments)],
        );
      const lat = ringOf[2 * vertex + 1];
      const at = 2 * (ring * FOOTPRINT_RING_POINTS + point);
      lonLat[at] = lon;
      lonLat[at + 1] = lat;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    boxes.set([west, south, east, north], 4 * ring);
  }
  const rings = { boxes, count, lonLat };
  FOOTPRINT_RINGS.set(circles, rings);
  return rings;
}
