/**
 * The observation under a hovering pointer, found on the CPU (Atlas design §11; fast-load design
 * §B.6.6 and interaction design §8, both amended 2026-11-14 on the owner's decision, #483). A
 * hover makes no GPU pick: a pick reads its framebuffer back, which waits for the GPU, and the
 * page's first pick links the pick variants of the programs it draws, which on a cold shader cache
 * held a frame for about 650 ms. A click still drill picks.
 *
 * The click's pick reads the 3 × 3 drawing-buffer pixels about the pointer and finds what each
 * pixel's centre shows (Picking.js `computePickingDrawingBufferRectangle`, PickFramebuffer.js; the
 * pixel rectangle starts one pixel before the pointer, truncated to whole pixels by `readPixels`).
 * The hover tests the same nine points (`HitView.pickWindow`) against each marker as Cesium draws
 * it, read from its own primitive (@cesium/engine 26.3.0):
 * - a circle (`PointPrimitive`): a disc of its pixel size, its outline and the 1.5 drawing-buffer
 *   pixels of anti-aliasing the sprite pads each side with, whose faint fragments pick too
 *   (PointPrimitiveCollectionVS.glsl and FS.glsl), about its projected position;
 * - a stud or a pin (`Billboard`): its image's own pixels, opaque past 1/255, where the image
 *   stands on its projected position (bottom origin). A pin turns about its centre with the
 *   surface normal, as the shader's aligned axis turns it, while that centre stays half the
 *   image's height straight up the screen from the anchor (BillboardCollectionVS.glsl
 *   `addScreenSpaceOffset`);
 * - a sphere (`EllipsoidPrimitive`, drawn on the globe only): where the ray through each point
 *   meets it;
 * - a sampling ring (`Polyline`): its projected line at its width plus the half pixel the shader
 *   adds (PolylineVS.glsl), each ring first culled by its bounding sphere.
 *
 * A marker the globe hides does not count: behind the horizon, or under terrain with relief behind
 * the ground. A see-through Earth (opacity under 1) hides none: Cesium then culls nothing behind
 * the horizon (Scene.js `getOccluder`) and the globe writes no depth, so a click picks the far
 * side's markers through it. Of several, one over the centre pixel beats one the window only
 * grazes, as the pick's spiral out from that pixel has it, and among those the nearest to the
 * camera wins, as its depth test has it. The texture filtering of an image's edge is not modelled,
 * so there a hover and a click can still differ by a fraction of a pixel.
 */

import * as Cesium from 'cesium';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Ellipsoid,
  EllipsoidTerrainProvider,
  HorizontalOrigin,
  Matrix4,
  Ray,
  SceneMode,
  SceneTransforms,
  VerticalOrigin,
  type Billboard,
  type BillboardCollection,
  type Globe,
  type PointPrimitive,
  type PointPrimitiveCollection,
  type Polyline,
  type PolylineCollection,
  type PrimitiveCollection,
  type Scene,
} from 'cesium';

import type { ObservationPick } from './observation-layer';

// Cesium exports its horizon test at runtime but leaves it out of its typings. A member read,
// not a destructuring, so the bundler still keeps only what the scene uses of Cesium.
const EllipsoidalOccluder = (
  Cesium as unknown as {
    EllipsoidalOccluder: new (
      ellipsoid: Ellipsoid,
      camera: Cartesian3,
    ) => { isPointVisible(point: Cartesian3): boolean };
  }
).EllipsoidalOccluder;

/** What the hit test reads of the scene: its projection, horizon, depth and pixels. */
export interface HitView {
  /** The mode the markers are drawn in; a sphere draws on the globe only. */
  mode: SceneMode;
  /** Where the ECEF `point` is drawn, in canvas CSS px; undefined behind the camera. */
  toWindow(point: Cartesian3): Cartesian2 | undefined;
  /** False where the globe hides `point` from the camera. */
  visible(point: Cartesian3): boolean;
  /** How far `point` lies from the camera, which orders overlapping markers. */
  depth(point: Cartesian3): number;
  /** The ray through a canvas point in ECEF; undefined off the globe. */
  pickRay(position: Cartesian2): Ray | undefined;
  /** Metres per CSS px at `distance` metres from the camera. */
  metresPerPixel(distance: number): number;
  /** A world direction in eye space (x right, y up), as the billboard shader turns by it. */
  eyeDirection(direction: Cartesian3): { x: number; y: number };
  /** One drawing-buffer pixel, in CSS px. */
  drawingPixel: number;
  /**
   * The centres of the nine drawing-buffer pixels a click's pick reads about `position`, in
   * canvas CSS px: the centre pixel's first, the rest in no order.
   */
  pickWindow(position: Cartesian2): Cartesian2[];
}

/**
 * Whether Cesium draws the globe's front faces see-through (GlobeTranslucencyState.js
 * `isFaceTranslucent`), which `applyEarthOpacity` turns on below opacity 1.
 */
function seeThrough(globe: Globe): boolean {
  const { baseColor, translucency } = globe;
  if (!translucency.enabled) return false;
  const byDistance = translucency.frontFaceAlphaByDistance;
  const alphas = byDistance ? [byDistance.nearValue, byDistance.farValue] : [1];
  return (
    baseColor.alpha < 1 ||
    alphas.some((alpha) => alpha * translucency.frontFaceAlpha < 1)
  );
}

/** The scene's own view for one hover. */
export function createHitView(scene: Scene): HitView {
  const { camera, canvas, mode } = scene;
  // Only an opaque globe hides a marker, by its horizon or by its rendered ground.
  const hides = mode === SceneMode.SCENE3D && !seeThrough(scene.globe);
  const occluder = hides
    ? new EllipsoidalOccluder(Ellipsoid.WGS84, camera.positionWC)
    : null;
  const relief =
    hides && !(scene.globe.terrainProvider instanceof EllipsoidTerrainProvider);
  // Cesium leaves these out of its typings: the drawing buffer's pixels per CSS px, and the
  // uniform state whose `view3D` the billboard shader turns an aligned axis by.
  const { context, pixelRatio } = scene as unknown as {
    context: { uniformState: { view3D: Matrix4 } };
    pixelRatio: number;
  };
  const { uniformState } = context;
  const { drawingBufferHeight, drawingBufferWidth } = scene;
  const xScale = drawingBufferWidth / canvas.clientWidth;
  const yScale = drawingBufferHeight / canvas.clientHeight;
  return {
    depth: (point) =>
      mode === SceneMode.SCENE3D || mode === SceneMode.MORPHING
        ? Cartesian3.distance(camera.positionWC, point)
        : Cartesian3.distance(camera.positionWC, mapWorldPoint(scene, point)),
    drawingPixel: 1 / pixelRatio,
    eyeDirection: (direction) => {
      const eye = Matrix4.multiplyByPointAsVector(
        uniformState.view3D,
        direction,
        new Cartesian3(),
      );
      return { x: eye.x, y: eye.y };
    },
    metresPerPixel: (distance) =>
      camera.frustum.getPixelDimensions(
        drawingBufferWidth,
        drawingBufferHeight,
        // A camera inside a ring's bounding sphere asks at a distance ≤ 0: a metre stands in.
        Math.max(distance, 1),
        pixelRatio,
        new Cartesian2(),
      ).y,
    mode,
    pickRay: (position) =>
      mode === SceneMode.SCENE3D
        ? camera.getPickRay(position, new Ray())
        : undefined,
    pickWindow: (position) => {
      // `readPixels` takes the rectangle's corner, one pixel before the pointer, as whole pixels;
      // its rows count up from the drawing buffer's bottom.
      const left = Math.trunc(position.x * xScale - 1);
      const bottom = Math.trunc(drawingBufferHeight - position.y * yScale - 1);
      const at = (column: number, row: number) =>
        new Cartesian2(
          (left + column + 0.5) / xScale,
          (drawingBufferHeight - (bottom + row) - 0.5) / yScale,
        );
      const window = [at(1, 1)];
      for (const column of [0, 1, 2])
        for (const row of [0, 1, 2])
          if (column !== 1 || row !== 1) window.push(at(column, row));
      return window;
    },
    toWindow: (point) => SceneTransforms.worldToWindowCoordinates(scene, point),
    visible: (point) =>
      occluder === null ||
      (occluder.isPointVisible(point) &&
        !(relief && groundHides(scene, point))),
  };
}

/** Columbus view and 2D draw in the projected map frame: the world point `(height, x, y)`. */
function mapWorldPoint(scene: Scene, point: Cartesian3): Cartesian3 {
  const projection = scene.mapProjection;
  const cartographic = projection.ellipsoid.cartesianToCartographic(point);
  // Only the Earth's centre has no cartographic position; no marker stands there.
  if (!cartographic)
    throw new Error(`a marker at ${point.toString()} has no map position`);
  const projected = projection.project(cartographic);
  return new Cartesian3(projected.z, projected.x, projected.y);
}

/** The rendered ground lies between the camera and `point`. */
function groundHides(scene: Scene, point: Cartesian3): boolean {
  const from = scene.camera.positionWC;
  const toward = Cartesian3.subtract(point, from, new Cartesian3());
  const distance = Cartesian3.magnitude(toward);
  const hit = scene.globe.pick(
    new Ray(from, Cartesian3.divideByScalar(toward, distance, toward)),
    scene,
  );
  return hit !== undefined && Cartesian3.distance(from, hit) < distance;
}

/** A marker image's alpha, row by row from its top. */
export interface ImageMask {
  width: number;
  height: number;
  alpha: Uint8Array;
}

/**
 * The alpha of a marker image drawn into a canvas, read when a hover first needs it. An image
 * given as a URL (no document to draw it in) has no pixels to read: an error.
 */
export function imageMask(
  image: HTMLCanvasElement | string | null,
): () => ImageMask {
  let mask: ImageMask | null = null;
  return () => {
    if (mask) return mask;
    if (image === null || typeof image === 'string')
      throw new Error('a marker image without a canvas has no pixels to test');
    const context = image.getContext('2d');
    if (!context)
      throw new Error('a marker image whose canvas has no 2D context');
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const alpha = new Uint8Array(image.width * image.height);
    for (let index = 0; index < alpha.length; index += 1)
      alpha[index] = data[index * 4 + 3];
    mask = { alpha, height: image.height, width: image.width };
    return mask;
  };
}

/** The ray-cast sphere's mutable fields Cesium leaves out of its typings. */
interface SpherePrimitive {
  center: Cartesian3;
  id: unknown;
  radii: Cartesian3;
  show: boolean;
}

/** One observation group's markers, as `buildObservationLayer` built them. */
export interface ObservationMarkers {
  collection: { show: boolean };
  points: PointPrimitiveCollection;
  /** The studs and the pins, each with the alpha of its image. */
  billboards: readonly {
    collection: BillboardCollection;
    image: () => ImageMask;
  }[];
  spheres: PrimitiveCollection;
  rings: PolylineCollection;
}

interface Hit {
  pick: ObservationPick;
  /** The marker covers the window's centre pixel, not only another. */
  under: boolean;
  /** Distance from the camera. */
  depth: number;
  /** How far from the centre pixel the nearest pixel it covers lies, in CSS px. */
  aside: number;
}

/** Whether `next` beats `best`: the centre pixel's first and nearest, then the closest pixel's. */
function better(next: Hit, best: Hit | null): boolean {
  if (!best) return true;
  if (next.under !== best.under) return next.under;
  return next.under ? next.depth < best.depth : next.aside < best.aside;
}

/** The first point of `window` that `covers` holds for, as its index; -1 for none. */
function firstCovered(
  window: readonly Cartesian2[],
  covers: (point: Cartesian2, index: number) => boolean,
): number {
  let found = -1;
  let aside = Number.POSITIVE_INFINITY;
  for (let index = 0; index < window.length; index += 1) {
    if (!covers(window[index], index)) continue;
    if (index === 0) return 0;
    const distance = Cartesian2.distance(window[index], window[0]);
    if (distance < aside) {
      found = index;
      aside = distance;
    }
  }
  return found;
}

/** The observation drawn under `position` (canvas CSS px), or null. */
export function observationAt(
  view: HitView,
  position: Cartesian2,
  markers: ObservationMarkers,
): ObservationPick | null {
  if (!markers.collection.show) return null;
  const window = view.pickWindow(position);
  let best: Hit | null = null;
  const offer = (hit: Hit | null) => {
    if (hit && better(hit, best)) best = hit;
  };
  const { points, spheres } = markers;
  if (points.show)
    for (let index = 0; index < points.length; index += 1)
      offer(pointHit(view, window, points.get(index)));
  for (const { collection, image } of markers.billboards)
    if (collection.show && collection.length > 0) {
      const mask = image();
      for (let index = 0; index < collection.length; index += 1)
        offer(billboardHit(view, window, collection.get(index), mask));
    }
  if (spheres.show && spheres.length > 0 && view.mode === SceneMode.SCENE3D) {
    const rays = window.map((point) => view.pickRay(point));
    if (rays.every((ray) => ray !== undefined))
      for (let index = 0; index < spheres.length; index += 1)
        offer(
          sphereHit(view, window, rays, spheres.get(index) as SpherePrimitive),
        );
  }
  if (markers.rings.show)
    for (let index = 0; index < markers.rings.length; index += 1)
      offer(ringHit(view, window, markers.rings.get(index)));
  return (best as Hit | null)?.pick ?? null;
}

/** A hit by the marker at `point` (ECEF) over window point `index`, if the globe shows it. */
function hitAt(
  view: HitView,
  window: readonly Cartesian2[],
  index: number,
  point: Cartesian3,
  id: unknown,
): Hit | null {
  if (index < 0 || !view.visible(point)) return null;
  return {
    aside: Cartesian2.distance(window[index], window[0]),
    depth: view.depth(point),
    pick: id as ObservationPick,
    under: index === 0,
  };
}

/** A circle: its pixel size is the disc's diameter, and its outline and pad lie outside it. */
function pointHit(
  view: HitView,
  window: readonly Cartesian2[],
  point: PointPrimitive,
): Hit | null {
  if (!point.show) return null;
  const drawn = view.toWindow(point.position);
  if (!drawn) return null;
  // The sprite's anti-aliasing pad: 3 drawing-buffer pixels across, half each side.
  const radius =
    point.pixelSize / 2 + point.outlineWidth + 1.5 * view.drawingPixel;
  const index = firstCovered(
    window,
    (at) => Cartesian2.distance(at, drawn) <= radius,
  );
  return hitAt(view, window, index, point.position, point.id);
}

/**
 * The turn Cesium's billboard shader gives an image with an aligned axis (eye space, radians,
 * counterclockwise), its formula as written, `acos` of a squared cosine included.
 */
function alignedTurn(axis: { x: number; y: number }): number {
  return (
    Math.sign(-axis.x) *
    Math.acos(
      (Math.sign(axis.y) * axis.y * axis.y) /
        (axis.x * axis.x + axis.y * axis.y),
    )
  );
}

/** A stud or a pin: its image's pixels, placed and turned as the shader does. */
function billboardHit(
  view: HitView,
  window: readonly Cartesian2[],
  billboard: Billboard,
  mask: ImageMask,
): Hit | null {
  if (!billboard.show) return null;
  const { height, width } = billboard;
  // An unsized billboard takes its image's size, which the markers never leave to Cesium.
  if (width === undefined || height === undefined)
    throw new Error(
      `the observation marker ${String(billboard.id)} has no size`,
    );
  const anchor = view.toWindow(billboard.position);
  if (!anchor) return null;
  const halfWidth = (width * billboard.scale) / 2;
  const halfHeight = (height * billboard.scale) / 2;
  // The origin moves the image's centre by half its size, unturned (y is up in eye space).
  const centre = new Cartesian2(
    anchor.x + horizontalShift(billboard.horizontalOrigin) * halfWidth,
    anchor.y - verticalShift(billboard.verticalOrigin) * halfHeight,
  );
  if (
    Cartesian2.distance(window[0], centre) >
    Math.hypot(halfWidth, halfHeight) + 2 * view.drawingPixel
  )
    return null;
  const axis = billboard.alignedAxis;
  const turn = Cartesian3.equals(axis, Cartesian3.ZERO)
    ? 0
    : alignedTurn(view.eyeDirection(axis));
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const index = firstCovered(window, (at) => {
    // Back into the image's own axes: a counterclockwise eye turn is clockwise on the y-down
    // page. Then its texel, rows counted from its top.
    const dx = at.x - centre.x;
    const dy = at.y - centre.y;
    const u = (dx * cos - dy * sin) / (2 * halfWidth) + 0.5;
    const v = 0.5 + (dx * sin + dy * cos) / (2 * halfHeight);
    if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return false;
    const texel =
      Math.floor(v * mask.height) * mask.width + Math.floor(u * mask.width);
    // The fragment shader drops a fragment whose alpha is under 0.005, so 1/255 and below.
    return mask.alpha[texel] > 1;
  });
  return hitAt(view, window, index, billboard.position, billboard.id);
}

/** `HorizontalOrigin`: the image's centre lies this many half widths right of its anchor. */
function horizontalShift(origin: HorizontalOrigin): number {
  if (origin === HorizontalOrigin.LEFT) return 1;
  if (origin === HorizontalOrigin.RIGHT) return -1;
  return 0;
}

/** `VerticalOrigin`: the image's centre lies this many half heights above its anchor. */
function verticalShift(origin: VerticalOrigin): number {
  if (origin === VerticalOrigin.BOTTOM || origin === VerticalOrigin.BASELINE)
    return 1;
  if (origin === VerticalOrigin.TOP) return -1;
  return 0;
}

/** A sphere: where each window point's ray passes it, against its radius. */
function sphereHit(
  view: HitView,
  window: readonly Cartesian2[],
  rays: readonly Ray[],
  sphere: SpherePrimitive,
): Hit | null {
  if (!sphere.show) return null;
  const radius = sphere.radii.x;
  /** Where each ray that meets the sphere enters it, by window point. */
  const entries: number[] = [];
  const index = firstCovered(window, (_, at) => {
    const { direction, origin } = rays[at];
    const toCentre = Cartesian3.subtract(
      sphere.center,
      origin,
      new Cartesian3(),
    );
    const along = Cartesian3.dot(toCentre, direction);
    const missSquared = Cartesian3.magnitudeSquared(toCentre) - along * along;
    if (along <= 0 || missSquared > radius * radius) return false;
    entries[at] = along - Math.sqrt(radius * radius - Math.max(0, missSquared));
    return true;
  });
  return index < 0
    ? null
    : hitAt(
        view,
        window,
        index,
        Ray.getPoint(rays[index], entries[index], new Cartesian3()),
        sphere.id,
      );
}

/** Bounding spheres of ring positions, kept until the ring is placed anew. */
const ringBounds = new WeakMap<readonly Cartesian3[], BoundingSphere>();

function boundsOf(positions: readonly Cartesian3[]): BoundingSphere {
  let bounds = ringBounds.get(positions);
  if (!bounds) {
    bounds = BoundingSphere.fromPoints([...positions]);
    ringBounds.set(positions, bounds);
  }
  return bounds;
}

/** Whether the window's centre can be within `reach` px of a ring inside `bounds`. */
function nearBounds(
  view: HitView,
  position: Cartesian2,
  bounds: BoundingSphere,
  reach: number,
): boolean {
  const centre = view.toWindow(bounds.center);
  // Its centre behind the camera, some of the ring can still be in view: every segment is tested.
  if (!centre) return true;
  const metresPerPixel = view.metresPerPixel(
    view.depth(bounds.center) - bounds.radius,
  );
  // Off the globe the map frame stretches east-west by 1 / cos(latitude).
  const stretch =
    view.mode === SceneMode.SCENE3D
      ? 1
      : 1 /
        Math.max(
          0.01,
          Math.cos(
            Ellipsoid.WGS84.cartesianToCartographic(bounds.center)?.latitude ??
              0,
          ),
        );
  return (
    Cartesian2.distance(centre, position) <=
    (bounds.radius * stretch * 1.1) / metresPerPixel + reach
  );
}

/** A sampling ring: its projected line, at its drawn width. */
function ringHit(
  view: HitView,
  window: readonly Cartesian2[],
  ring: Polyline,
): Hit | null {
  if (!ring.show) return null;
  const positions = ring.positions as Cartesian3[];
  const halfWidth = (ring.width + 0.5) / 2;
  if (
    positions.length < 2 ||
    !nearBounds(
      view,
      window[0],
      boundsOf(positions),
      halfWidth + 2 * view.drawingPixel,
    )
  )
    return null;
  const drawn = positions.map((position) => view.toWindow(position));
  const count = ring.loop ? positions.length : positions.length - 1;
  /** The point of the ring nearest each window point that it covers, by window point. */
  const nearest: Cartesian3[] = [];
  const index = firstCovered(window, (at, slot) => {
    let closest = Number.POSITIVE_INFINITY;
    for (let segment = 0; segment < count; segment += 1) {
      const next = (segment + 1) % positions.length;
      const from = drawn[segment];
      const to = drawn[next];
      if (!from || !to) continue;
      const share = nearestShare(at, from, to);
      const distance = Cartesian2.distance(
        at,
        Cartesian2.lerp(from, to, share, new Cartesian2()),
      );
      if (distance < closest) {
        closest = distance;
        nearest[slot] = Cartesian3.lerp(
          positions[segment],
          positions[next],
          share,
          new Cartesian3(),
        );
      }
    }
    return closest <= halfWidth;
  });
  return index < 0 ? null : hitAt(view, window, index, nearest[index], ring.id);
}

/** The share of the way from `from` to `to` of the segment's point nearest `point`. */
function nearestShare(
  point: Cartesian2,
  from: Cartesian2,
  to: Cartesian2,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return 0;
  return Math.min(
    1,
    Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length),
  );
}
