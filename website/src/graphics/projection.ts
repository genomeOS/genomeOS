/** Map projections for site figures (site redesign spec §3, §4.1 H1, §4.2 P2; #454).
 *
 * Orthographic for the hero globe (rotatable, invertible for hit tests under a pointer) and
 * Lambert azimuthal equal-area for the Project HbS window, so an area's share of the screen is its
 * share of the Earth. Coordinates are WGS84 degrees in, CSS pixels out (y grows downward).
 * No DOM; the canvas renderer and the build script share it.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type LonLat = readonly [lon: number, lat: number];

/** A point on the sphere, precomputed for repeated projection: [λ (rad), cos φ, sin φ]. */
export type SpherePoint = readonly [number, number, number];

export function spherePoint(lon: number, lat: number): SpherePoint {
  const phi = lat * RAD;
  return [lon * RAD, Math.cos(phi), Math.sin(phi)];
}

export interface ProjectionOptions {
  /** Projection centre, degrees. */
  center: LonLat;
  /** Globe radius (orthographic) or Earth radius scale (equal-area), CSS px. */
  scale: number;
  /** Screen position of the centre, CSS px. */
  translate: readonly [number, number];
}

export interface Projection {
  readonly kind: 'orthographic' | 'equal-area';
  center: LonLat;
  scale: number;
  translate: readonly [number, number];
  /** [x, y, cosc]: cosc < 0 is the far side (orthographic) or the antipode (equal-area). */
  project(lon: number, lat: number): [number, number, number];
  /** The same, from a precomputed `spherePoint`. */
  projectPoint(point: SpherePoint): [number, number, number];
  /** Degrees under a screen point, or null off the projected Earth. */
  invert(x: number, y: number): [number, number] | null;
}

abstract class Azimuthal implements Projection {
  abstract readonly kind: 'orthographic' | 'equal-area';
  center: LonLat;
  scale: number;
  translate: readonly [number, number];
  protected lambda0 = 0;
  protected cosPhi0 = 1;
  protected sinPhi0 = 0;

  constructor({ center, scale, translate }: ProjectionOptions) {
    this.center = center;
    this.scale = scale;
    this.translate = translate;
    this.rotate(center);
  }

  /** Move the projection centre (the globe turns under the viewer). */
  rotate(center: LonLat): void {
    this.center = center;
    this.lambda0 = center[0] * RAD;
    this.cosPhi0 = Math.cos(center[1] * RAD);
    this.sinPhi0 = Math.sin(center[1] * RAD);
  }

  project(lon: number, lat: number): [number, number, number] {
    return this.projectPoint(spherePoint(lon, lat));
  }

  protected abstract radial(cosc: number): number;
  protected abstract arc(rho: number): number | null;

  projectPoint([lambda, cosPhi, sinPhi]: SpherePoint): [
    number,
    number,
    number,
  ] {
    const dl = lambda - this.lambda0;
    const cosDl = Math.cos(dl);
    const cosc = this.sinPhi0 * sinPhi + this.cosPhi0 * cosPhi * cosDl;
    const k = this.radial(cosc) * this.scale;
    const x = k * cosPhi * Math.sin(dl);
    const y = k * (this.cosPhi0 * sinPhi - this.sinPhi0 * cosPhi * cosDl);
    return [this.translate[0] + x, this.translate[1] - y, cosc];
  }

  invert(screenX: number, screenY: number): [number, number] | null {
    const x = (screenX - this.translate[0]) / this.scale;
    const y = (this.translate[1] - screenY) / this.scale;
    const rho = Math.hypot(x, y);
    if (rho === 0) return [this.center[0], this.center[1]];
    const c = this.arc(rho);
    if (c === null) return null;
    const sinC = Math.sin(c);
    const cosC = Math.cos(c);
    const lat = Math.asin(
      Math.min(
        1,
        Math.max(-1, cosC * this.sinPhi0 + (y * sinC * this.cosPhi0) / rho),
      ),
    );
    const lon =
      this.lambda0 +
      Math.atan2(x * sinC, rho * this.cosPhi0 * cosC - y * this.sinPhi0 * sinC);
    return [normalizeLon(lon * DEG), lat * DEG];
  }
}

/** Orthographic: the hemisphere a viewer at infinity sees. `scale` is the globe radius. */
export class Orthographic extends Azimuthal {
  readonly kind = 'orthographic' as const;
  protected radial(): number {
    return 1;
  }
  protected arc(rho: number): number | null {
    return rho > 1 ? null : Math.asin(rho);
  }
}

/** Lambert azimuthal equal-area: areas keep their proportions. */
export class LambertAzimuthal extends Azimuthal {
  readonly kind = 'equal-area' as const;
  protected radial(cosc: number): number {
    // k′ = sqrt(2 / (1 + cos c)); the antipode (cos c = −1) has no image.
    return cosc <= -1 + 1e-12 ? 0 : Math.sqrt(2 / (1 + cosc));
  }
  protected arc(rho: number): number | null {
    return rho > 2 ? null : 2 * Math.asin(rho / 2);
  }
}

export function orthographic(options: ProjectionOptions): Orthographic {
  return new Orthographic(options);
}

export function lambertAzimuthal(options: ProjectionOptions): LambertAzimuthal {
  return new LambertAzimuthal(options);
}

export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Scale and translate an equal-area projection so `points` fill `width` × `height` with
 * `padding` px to spare, keeping its centre. Returns the fitted projection.
 */
export function fitEqualArea(
  center: LonLat,
  points: readonly LonLat[],
  width: number,
  height: number,
  padding = 0,
): LambertAzimuthal {
  const unit = lambertAzimuthal({ center, scale: 1, translate: [0, 0] });
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of points) {
    const [x, y] = unit.project(lon, lat);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const scale = Math.min(
    (width - 2 * padding) / (maxX - minX || 1),
    (height - 2 * padding) / (maxY - minY || 1),
  );
  const translate: [number, number] = [
    width / 2 - ((minX + maxX) / 2) * scale,
    height / 2 - ((minY + maxY) / 2) * scale,
  ];
  return lambertAzimuthal({ center, scale, translate });
}

/** Great-circle distance in km (spherical Earth, R = 6,371.0088 km). */
export function haversineKm(a: LonLat, b: LonLat): number {
  const R = 6371.0088;
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
