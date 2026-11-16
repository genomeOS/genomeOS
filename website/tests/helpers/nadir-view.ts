/**
 * A hover's view of the globe for unit tests (`HitView`, scene/observation-hits.ts): looking
 * straight down on (`lat`, `lon`) from 1,000 km, orthographically. East is +x and north is −y,
 * one CSS px is `metresPerPixel` metres and one drawing-buffer pixel, and (`lat`, `lon`) is drawn
 * at `centre`. The pick window is the pointer and the eight points one pixel round it. `groundAt`
 * undoes the projection onto the ellipsoid's tangent plane there, as `pickEllipsoid` would.
 */

import { Cartesian2, Cartesian3, Ellipsoid, Ray, SceneMode } from 'cesium';

import type { HitView } from '../../src/atlas/scene/observation-hits';

export interface NadirView extends HitView {
  /** The ground point drawn at `position`. */
  groundAt(position: Cartesian2): Cartesian3;
}

export function nadirView(
  lat: number,
  lon: number,
  metresPerPixel: number,
  centre: Cartesian2,
  overrides: Partial<HitView> = {},
): NadirView {
  const ground = Cartesian3.fromDegrees(lon, lat, 0);
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(ground, new Cartesian3());
  const east = Cartesian3.normalize(
    Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()),
    new Cartesian3(),
  );
  const north = Cartesian3.cross(up, east, new Cartesian3());
  const camera = Cartesian3.add(
    ground,
    Cartesian3.multiplyByScalar(up, 1e6, new Cartesian3()),
    new Cartesian3(),
  );
  /** `origin` moved across the view by `position`'s offset from `centre`. */
  const across = (origin: Cartesian3, position: Cartesian2): Cartesian3 => {
    const point = Cartesian3.clone(origin);
    Cartesian3.add(
      point,
      Cartesian3.multiplyByScalar(
        east,
        (position.x - centre.x) * metresPerPixel,
        new Cartesian3(),
      ),
      point,
    );
    return Cartesian3.add(
      point,
      Cartesian3.multiplyByScalar(
        north,
        (centre.y - position.y) * metresPerPixel,
        new Cartesian3(),
      ),
      point,
    );
  };
  return {
    depth: (point) => Cartesian3.distance(camera, point),
    eyeDirection: (direction) => ({
      x: Cartesian3.dot(direction, east),
      y: Cartesian3.dot(direction, north),
    }),
    groundAt: (position) => across(ground, position),
    metresPerPixel: () => metresPerPixel,
    mode: SceneMode.SCENE3D,
    pickRay: (position) =>
      new Ray(
        across(camera, position),
        Cartesian3.negate(up, new Cartesian3()),
      ),
    drawingPixel: 1,
    pickWindow: (position) => {
      const window = [Cartesian2.clone(position)];
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1])
          if (dx !== 0 || dy !== 0)
            window.push(new Cartesian2(position.x + dx, position.y + dy));
      return window;
    },
    toWindow: (point) => {
      const offset = Cartesian3.subtract(point, ground, new Cartesian3());
      return new Cartesian2(
        centre.x + Cartesian3.dot(offset, east) / metresPerPixel,
        centre.y - Cartesian3.dot(offset, north) / metresPerPixel,
      );
    },
    visible: () => true,
    ...overrides,
  };
}
