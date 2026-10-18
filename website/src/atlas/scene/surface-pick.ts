/** Cell resolution for chunk-level surface picks (Atlas design §11; spec 2026-10-07 §B.6.6).
 *
 * Surface and support primitives pick as a whole chunk. The cell under the
 * pointer comes from the ellipsoid at elevation 0 (no extra render pass) or
 * from a translucent depth pick otherwise; on the globe, `extruded` also
 * passes the camera's pick ray so the resolver can ray-test the prisms around
 * the depth hit instead of trusting its noisy altitude. In Columbus view and
 * 2D the shader shears the lifted surface in the map frame, so every geometry
 * passes the hit and the ray in that frame (`map-frame-pick.ts`); while the
 * scene morphs between modes no surface cell is resolved. The depth pick is
 * scoped to this call because `pickTranslucentDepth` is scene-wide and also
 * drives camera pivots. The incoming group of an unfinished swap is hidden
 * for that one pass so depth always comes from the displayed surface. The
 * pass also queries under a cache key of its own and is followed by one
 * ordinary pick that puts the pointer's pick depth back, so its translucent
 * hit should not become a camera pivot (§B.7). That is verified against
 * Cesium fakes only (ledger Task 61): the real-engine probe Task 61 asked for
 * (hover, pause and wheel; hover and wheel; a same-cell nudge, at factor 5
 * against a factor-0 reference) has not been run.
 *
 * A cell the reveal wave has not reached (#453) draws nothing, so the pick
 * pass cannot hit it, but a 3 × 3 pick window can catch a grown neighbour's
 * chunk and an extruded ray test can choose an unreached neighbour's prism:
 * the wave's own answer for the resolved cell's centre has the last word.
 *
 * Under World Terrain (terrain draping design, "Picking"; #483) the ground can
 * cover the surface, so a draped pick needs no surface chunk in the drill
 * pick: an observation hit still wins, and otherwise the cell is the one on
 * the rendered, exaggerated ground under the pointer (`globe.pick` through
 * the camera's pick ray), kept only where a layer draws it. The 650 m
 * clearance, the ellipsoid and the translucent depth pick play no part, and
 * a mid-morph pick resolves nothing. Chunks still run the radial wave under
 * terrain, so its answer stands for them; a draped group has no wave.
 */

import { cellToLatLng, latLngToCell } from 'h3-js';
import {
  Cartesian2,
  Cartesian3,
  Ellipsoid,
  Math as CesiumMath,
  SceneMode,
  type Scene,
} from 'cesium';

import type { MapFrameHit } from '../geometry/map-frame-pick';
import { resolveSurfaceRow, type PickRay } from '../geometry/pick-resolver';
import { isSupportedCode } from '../geometry/support-codes';
import {
  h3At,
  renderAt,
  rowForH3,
  type SurfaceArtifact,
} from '../surface-columns';
import type { SurfaceGeometry } from '../url-state';
import { heightFor, type Metric } from '../visual-encoding';
import { preferredAtlasPick, type PickResolver } from './picking';
import type { Vec3 } from './reveal-wave';
import { SURFACE_CLEARANCE_METRES } from './surface-appearance';
import type { SurfacePick } from './types';

export interface PickTarget {
  artifactKey: string;
  surface: SurfaceArtifact;
  hidden: readonly { show: boolean }[];
  /** Supported rows need layers.surface, masked rows layers.support, and the group must be shown (α > 0). */
  drawn(row: number): boolean;
  /** The displayed group is draped imagery (false until Task 11). */
  draped: boolean;
}

export interface SurfacePickContext {
  target(): PickTarget | null;
  factor(): number;
  metric(): Metric;
  geometry(): SurfaceGeometry;
  /** How far the reveal wave has grown the cell centred along `direction` (ECEF); 0 is unpickable. */
  reveal?(direction: Vec3): number;
  /** World Terrain is on the globe and the data lies flat on it, so picks take the ground. */
  draped?(): boolean;
}

function cellDirection(h3Index: string): Vec3 {
  const [lat, lon] = cellToLatLng(h3Index);
  const point = Cartesian3.fromDegrees(lon, lat);
  return [point.x, point.y, point.z];
}

type DepthPickScene = Pick<
  Scene,
  | 'camera'
  | 'globe'
  | 'mapProjection'
  | 'mode'
  | 'pick'
  | 'pickPosition'
  | 'pickTranslucentDepth'
>;

export type DrapedPickScene = Pick<
  Scene,
  'camera' | 'globe' | 'mapProjection' | 'mode'
>;

/**
 * The cell on the rendered ground under the pointer, if a layer draws it.
 * `globe.pick` intersects the tiles drawn this frame, so it hits the
 * exaggerated terrain mesh, and returns ECEF in every scene mode; mid-morph
 * that mesh lies between both frames, so nothing is resolved.
 */
export function resolveDrapedPick(
  scene: DrapedPickScene,
  target: PickTarget,
  position: Cartesian2,
): SurfacePick | null {
  if (scene.mode === SceneMode.MORPHING) return null;
  const ray = scene.camera.getPickRay(position);
  if (!ray) return null;
  // `Globe.pick` reads only the scene's `mode` and `mapProjection`, projecting a 2D or
  // Columbus-view hit back to ECEF (@cesium/engine 26.3.0, Globe.js:740-741, :823-831).
  const hit = scene.globe.pick(ray, scene as Scene);
  const cartographic = hit
    ? Ellipsoid.WGS84.cartesianToCartographic(hit)
    : undefined;
  if (!cartographic) return null;
  const h3Index = latLngToCell(
    CesiumMath.toDegrees(cartographic.latitude),
    CesiumMath.toDegrees(cartographic.longitude),
    target.surface.grid.resolution,
  );
  const row = rowForH3(target.surface, h3Index);
  if (row === null || !target.drawn(row)) return null;
  return { artifactKey: target.artifactKey, h3Index, kind: 'surface', row };
}

/** The pointer's ray in ECEF metres; only the globe's camera works in those coordinates. */
function globePickRay(
  scene: Pick<Scene, 'camera' | 'mode'>,
  position: Cartesian2,
): PickRay | null {
  if (scene.mode !== SceneMode.SCENE3D) return null;
  const ray = scene.camera.getPickRay(position);
  return ray
    ? {
        direction: [ray.direction.x, ray.direction.y, ray.direction.z],
        origin: [ray.origin.x, ray.origin.y, ray.origin.z],
      }
    : null;
}

/** Columbus view and 2D draw in the projected map frame, not in ECEF. */
function drawsInMapFrame(scene: Pick<Scene, 'mode'>): boolean {
  return (
    scene.mode === SceneMode.COLUMBUS_VIEW || scene.mode === SceneMode.SCENE2D
  );
}

/**
 * The depth hit and the pointer's ray in the map frame `[x, y, height]`.
 * `pickPosition` unprojects the world point `(height, x, y)` and returns it
 * as ECEF (@cesium/engine 26.3.0, Picking.js `pickPosition`); projecting it
 * back recovers x and y. `getPickRay` already works in the world frame, so
 * its axes are only reordered.
 */
function mapFrameHit(
  scene: Pick<Scene, 'camera' | 'mapProjection'>,
  position: Cartesian2,
  hit: Cartesian3,
): MapFrameHit | null {
  const projection = scene.mapProjection;
  const cartographic = projection.ellipsoid.cartesianToCartographic(hit);
  if (!cartographic) return null;
  const point = projection.project(cartographic);
  const ray = scene.camera.getPickRay(position);
  return {
    point: [point.x, point.y, point.z],
    ray: ray
      ? {
          direction: [ray.direction.y, ray.direction.z, ray.direction.x],
          origin: [ray.origin.y, ray.origin.z, ray.origin.x],
        }
      : null,
  };
}

/**
 * The pointer's own coordinates (so the same drawing-buffer pixel) under a
 * cache key no other caller produces. Cesium caches `pickPosition` results by
 * `windowPosition.toString()` alone, whatever `pickTranslucentDepth` was,
 * until the next `Scene.render` (@cesium/engine 26.3.0, Picking.js
 * `pickPositionWorldCoordinates`). The next tick's camera controller picks
 * its zoom and rotate pivots at the same pointer position before that render,
 * so a shared key would hand it the translucent surface point; restoring the
 * flag alone does not undo a cached result.
 */
function translucentPickPosition(position: Cartesian2): Cartesian2 {
  const query = Cartesian2.clone(position);
  const key = `atlas-translucent-depth ${position.toString()}`;
  query.toString = () => key;
  return query;
}

export function pickDepthPosition(
  scene: Pick<Scene, 'pickPosition' | 'pickTranslucentDepth'>,
  position: Cartesian2,
  hidden: readonly { show: boolean }[],
): Cartesian3 | undefined {
  const previous = scene.pickTranslucentDepth;
  const shown = hidden.map((collection) => collection.show);
  for (const collection of hidden) collection.show = false;
  scene.pickTranslucentDepth = true;
  try {
    return scene.pickPosition(translucentPickPosition(position)) ?? undefined;
  } finally {
    scene.pickTranslucentDepth = previous;
    hidden.forEach((collection, index) => {
      collection.show = shown[index];
    });
  }
}

function drilledPrimitive(picked: unknown): { show: boolean } | null {
  if (typeof picked !== 'object' || picked === null || !('primitive' in picked))
    return null;
  const { primitive } = picked;
  return typeof primitive === 'object' &&
    primitive !== null &&
    'show' in primitive &&
    typeof primitive.show === 'boolean'
    ? (primitive as { show: boolean })
    : null;
}

/**
 * Puts back the pick depth `drillPick` left at the pointer. The translucent
 * pass copies the surface's depth into the default view's pick-depth texture
 * at the pointer and rebuilds that view's frustum list (@cesium/engine
 * 26.3.0, Picking.js `renderTranslucentDepthForPick`, Scene.js
 * `executeCommands`). On a cache miss, Cesium's opaque
 * `pickPositionWorldCoordinates` reads both without rendering, and the camera
 * controller takes its zoom and rotate pivots from it. Under
 * `requestRenderMode` nothing re-renders until the scene changes, so a hover,
 * a pause and a wheel at the same point would pivot on the surface. This
 * repeats `drillPick`'s last pass instead: one ordinary pick over the same
 * 3 × 3 pixels with every drilled primitive hidden. Pick passes write depth
 * for translucent primitives too (DerivedCommand.js `getPickRenderState`),
 * which is why they are hidden; what remains is what lay behind them, as
 * before the depth pick.
 */
export function restorePickDepth(
  scene: Pick<Scene, 'pick'>,
  position: Cartesian2,
  drilled: readonly unknown[],
): void {
  const shown = new Map<{ show: boolean }, boolean>();
  for (const picked of drilled) {
    const primitive = drilledPrimitive(picked);
    if (primitive && !shown.has(primitive))
      shown.set(primitive, primitive.show);
  }
  for (const primitive of shown.keys()) primitive.show = false;
  try {
    scene.pick(position);
  } finally {
    for (const [primitive, show] of shown) primitive.show = show;
  }
}

export function createSurfacePickResolver(
  scene: DepthPickScene,
  context: SurfacePickContext,
): PickResolver {
  return (picks, position) => {
    const target = context.target();
    const chosen = preferredAtlasPick(picks, target?.artifactKey ?? null);
    if (chosen?.kind === 'observation') return chosen;
    if (!target) return null;
    if (target.draped || context.draped?.()) {
      const pick = resolveDrapedPick(scene, target, position);
      return pick &&
        !target.draped &&
        context.reveal &&
        context.reveal(cellDirection(pick.h3Index)) <= 0
        ? null
        : pick;
    }
    if (!chosen) return null;
    const factor = context.factor();
    const geometry = context.geometry();
    let cartesian: [number, number, number] | null = null;
    let ellipsoidHit: { lat: number; lon: number } | null = null;
    let ray: PickRay | null = null;
    let mapFrame: MapFrameHit | null = null;
    if (factor === 0) {
      const hit = scene.camera.pickEllipsoid(position, Ellipsoid.WGS84);
      const cartographic = hit
        ? Ellipsoid.WGS84.cartesianToCartographic(hit)
        : undefined;
      if (!cartographic) return null;
      ellipsoidHit = {
        lat: CesiumMath.toDegrees(cartographic.latitude),
        lon: CesiumMath.toDegrees(cartographic.longitude),
      };
    } else {
      // Mid-morph the surface is drawn between both frames.
      if (scene.mode === SceneMode.MORPHING) return null;
      const hit = pickDepthPosition(scene, position, target.hidden);
      restorePickDepth(scene, position, picks);
      if (!hit) return null;
      if (drawsInMapFrame(scene)) {
        mapFrame = mapFrameHit(scene, position, hit);
        if (!mapFrame) return null;
      } else {
        cartesian = [hit.x, hit.y, hit.z];
        if (geometry === 'extruded') ray = globePickRay(scene, position);
      }
    }
    const metric = context.metric();
    const domain = target.surface.artifact.metric_domains[metric];
    const row = resolveSurfaceRow(
      {
        cartesian,
        clearance: SURFACE_CLEARANCE_METRES,
        ellipsoidHit,
        factor,
        geometry,
        mapFrame,
        ray,
      },
      target.surface,
      // Heights at exaggeration 1: the resolver applies `factor` itself.
      (candidate) => {
        const cell = renderAt(target.surface, candidate);
        return heightFor(cell.support, cell[metric], domain, 1);
      },
      (candidate) => isSupportedCode(target.surface.support[candidate]),
    );
    if (row === null) return null;
    const h3Index = h3At(target.surface, row);
    if (context.reveal && context.reveal(cellDirection(h3Index)) <= 0)
      return null;
    return {
      artifactKey: target.artifactKey,
      h3Index,
      kind: 'surface',
      row,
    };
  };
}
