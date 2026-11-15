/**
 * The hover, resolved on the CPU (Atlas design §11; owner decision 2026-11-14 on #483). A click
 * drill picks (`createSurfacePickResolver`); a hover makes no GPU pick at all, so it never waits
 * for a read-back nor links the pick variants of the programs in view, which on a cold shader
 * cache held the page's first hover for about 650 ms.
 *
 * What lies under the pointer, as the click resolves it:
 * 1. Nothing without a pick target: the displayed artifact, or the cold reveal's.
 * 2. An observation of that artifact wins (`observation-hits.ts`).
 * 3. Otherwise its cell, kept where a layer draws it (for chunks, once the chunk carrying it is
 *    added: a click needs a surface chunk under the pointer) and the reveal wave has reached it:
 *    - draped, under World Terrain, on the rendered ground (`resolveDrapedPick`: the camera's
 *      pick ray, then `globe.pick`);
 *    - at elevation 0 on the smooth globe, on the ellipsoid (`pickEllipsoid`), in every mode;
 *    - with data elevation, on the lifted surface as drawn: the first drawn cell the pick ray
 *      meets (`lifted-pick.ts`); mid-morph, none.
 */

import { cellToLatLng, latLngToCell } from 'h3-js';
import {
  Cartesian3,
  Ellipsoid,
  Math as CesiumMath,
  SceneMode,
  type Cartesian2,
  type Scene,
} from 'cesium';

import type { DrawnMesh } from '../geometry/drawn-mesh';
import { firstLiftedRow } from '../geometry/lifted-pick';
import { firstDrawnRowAlong } from '../geometry/map-frame-pick';
import { isSupportedCode } from '../geometry/support-codes';
import { h3At, renderAt, rowForH3 } from '../surface-columns';
import { heightFor, MAX_HEIGHT_METRES } from '../visual-encoding';
import { createHitView, type HitView } from './observation-hits';
import type { AtlasPickResolvers, HoverResolver } from './picking';
import type { Vec3 } from './reveal-wave';
import { SURFACE_CLEARANCE_METRES } from './surface-appearance';
import {
  createSurfacePickResolver,
  resolveDrapedPick,
  type DrapedPickScene,
  type PickTarget,
  type SurfacePickContext,
} from './surface-pick';
import type { AtlasPick, SurfacePick } from './types';

export type HoverScene = DrapedPickScene;

function cellDirection(h3Index: string): Vec3 {
  const [lat, lon] = cellToLatLng(h3Index);
  const point = Cartesian3.fromDegrees(lon, lat);
  return [point.x, point.y, point.z];
}

/** The target's cell at `h3Index`, if a layer draws it and the wave has reached it. */
function drawnCell(
  target: PickTarget,
  context: SurfacePickContext,
  h3Index: string,
): SurfacePick | null {
  const row = rowForH3(target.surface, h3Index);
  if (row === null || !target.drawn(row) || !waved(context, h3Index))
    return null;
  return { artifactKey: target.artifactKey, h3Index, kind: 'surface', row };
}

/** The cell on the ellipsoid under the pointer: the smooth globe at elevation 0. */
function ellipsoidCell(
  scene: HoverScene,
  target: PickTarget,
  context: SurfacePickContext,
  position: Cartesian2,
): SurfacePick | null {
  const hit = scene.camera.pickEllipsoid(position, Ellipsoid.WGS84);
  const cartographic = hit
    ? Ellipsoid.WGS84.cartesianToCartographic(hit)
    : undefined;
  if (!cartographic) return null;
  return drawnCell(
    target,
    context,
    latLngToCell(
      CesiumMath.toDegrees(cartographic.latitude),
      CesiumMath.toDegrees(cartographic.longitude),
      target.surface.grid.resolution,
    ),
  );
}

/** Whether the wave has reached the cell at `h3Index`; every cell without a wave. */
function waved(context: SurfacePickContext, h3Index: string): boolean {
  return !context.reveal || context.reveal(cellDirection(h3Index)) > 0;
}

/**
 * The first drawn cell along the pick ray through the lifted surface: on the globe in ECEF, in
 * Columbus view and 2D in the map frame (the world frame's `(height, x, y)` reordered). The
 * mesh reads each row's height as the click's resolver does: the render tier at exaggeration 1,
 * times the factor.
 */
function liftedCell(
  scene: HoverScene,
  target: PickTarget,
  context: SurfacePickContext,
  position: Cartesian2,
  factor: number,
): SurfacePick | null {
  if (scene.mode === SceneMode.MORPHING) return null;
  const ray = scene.camera.getPickRay(position);
  if (!ray) return null;
  const { surface } = target;
  const metric = context.metric();
  const domain = surface.artifact.metric_domains[metric];
  const mesh: DrawnMesh = {
    clearance: SURFACE_CLEARANCE_METRES,
    drawn: (row) => target.drawn(row) && waved(context, h3At(surface, row)),
    geometry: context.geometry(),
    maxLift: MAX_HEIGHT_METRES * factor,
    meshed: (row) => isSupportedCode(surface.support[row]),
    surface,
    top: (row) => {
      const cell = renderAt(surface, row);
      return (
        Math.max(0, heightFor(cell.support, cell[metric], domain, 1)) * factor
      );
    },
  };
  const { direction: d, origin: o } = ray;
  const row =
    scene.mode === SceneMode.SCENE3D
      ? firstLiftedRow(
          { direction: [d.x, d.y, d.z], origin: [o.x, o.y, o.z] },
          mesh,
        )
      : firstDrawnRowAlong(
          { direction: [d.y, d.z, d.x], origin: [o.y, o.z, o.x] },
          mesh,
        );
  return row === null
    ? null
    : {
        artifactKey: target.artifactKey,
        h3Index: h3At(surface, row),
        kind: 'surface',
        row,
      };
}

export function createHoverResolver(
  scene: HoverScene,
  context: SurfacePickContext,
  viewOf: (scene: HoverScene) => HitView = (hovered) =>
    createHitView(hovered as Scene),
): HoverResolver {
  return (position): AtlasPick | null => {
    const target = context.target();
    if (!target) return null;
    const observation =
      target.observations?.observationAt(viewOf(scene), position) ?? null;
    if (observation) {
      if (observation.artifactKey !== target.artifactKey)
        throw new Error(
          `the hover found ${observation.sourceRecordId} of ${observation.artifactKey} among the observations of ${target.artifactKey}`,
        );
      return observation;
    }
    if (target.draped || context.draped()) {
      const pick = resolveDrapedPick(scene, target, position);
      // Chunks run the wave under terrain too; a draped group has none.
      return pick && !target.draped && !waved(context, pick.h3Index)
        ? null
        : pick;
    }
    const factor = context.factor();
    return factor === 0
      ? ellipsoidCell(scene, target, context, position)
      : liftedCell(scene, target, context, position, factor);
  };
}

/** A click's resolver and a hover's, over one scene and one pick context. */
export function createAtlasPickResolvers(
  scene: Scene,
  context: SurfacePickContext,
): AtlasPickResolvers {
  return {
    click: createSurfacePickResolver(scene, context),
    hover: createHoverResolver(scene, context),
  };
}
