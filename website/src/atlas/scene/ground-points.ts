/**
 * The rendered ground under fixed points on World Terrain, for terrain draping design, "Per layer
 * under World Terrain" (observation symbols and the highlight), "Exaggeration" and "Failure
 * modes" (#483), and Atlas design §11.
 *
 * A point's ground changes only when the deepest terrain mesh Cesium renders under it changes (a
 * tile loads, is freed, or swaps its fill mesh for its own), or when that mesh is re-exaggerated
 * (Physical relief). So each point keeps the mesh it was picked on, and a pass picks
 * (`globe.getHeight`) only the points whose mesh changed: a pass over unchanged tiles picks
 * nothing. On a relief change the mesh stays, and Cesium raises each vertex along its normal by
 * `(h − r) · k + r` for exaggeration `k` from relative height `r`; the ground under a point moves
 * the same way, by its source height `H` read from the tile's own terrain data
 * (`interpolateHeight`), so `h' = h + (H − r') · k' + r' − (H − r) · k − r` with no pick. Dividing
 * the picked height by `k` instead is wrong on coarse tiles: the chord of a level-0 triangle sags
 * 15 km below the ellipsoid, and the error is twice that sag (30 km at level 0, 1.9 km at level 2;
 * the source-height rule is within 30 m at level 2 and 1 m from level 6). A fill mesh, drawn from
 * its neighbours' edges while the tile's own is not ready, has no terrain data of its own, so a
 * point on one is picked again when the relief changes.
 *
 * A pass may be limited to a budget of pick time: points in view (above the horizon from the
 * camera) are picked first, and the rest wait for the next pass. A point whose new mesh still
 * waits for its pick keeps its old mesh's ground, followed through relief the same way, so a
 * relief change between a tile load and the pick moves it too. Points start at NaN, and read NaN
 * where no tile under them has a mesh, as `getHeight` reads undefined there ("Failure modes": a
 * symbol keeps its height until its ground loads). Nothing is read while the globe's tiles are
 * still the smooth globe's ellipsoid, which World Terrain replaces only in the next frame.
 *
 * The mesh under a point is found as `Globe.getHeight` finds it, through Cesium 1.145's private
 * terrain quadtree (Globe.js `_surface`): `renderedTileAt` copies that descent, and a globe without
 * the quadtree is an error. Both are pinned in atlas-cesium-internals.test.ts, with the terrain
 * the quadtree's tiles are made from.
 */

import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  EllipsoidTerrainProvider,
  Math as CesiumMath,
  Rectangle,
  type Globe,
} from 'cesium';

/** A terrain mesh, as far as the ground under a point reads it (Cesium's `TerrainMesh`). */
interface TerrainMeshInternals {
  /** The relief the mesh is drawn at; Cesium rewrites it in the frame after a relief change. */
  readonly encoding: {
    readonly exaggeration: number;
    readonly exaggerationRelativeHeight: number;
  };
}

/** A terrain tile's data (Cesium's `GlobeSurfaceTile`). */
interface SurfaceTileInternals {
  /** The mesh drawn: its own `mesh` once it has a vertex array, else a fill mesh, if any. */
  readonly renderedMesh: TerrainMeshInternals | undefined;
  /** The mesh built from `terrainData`. */
  readonly mesh: TerrainMeshInternals | undefined;
  readonly terrainData:
    | {
        interpolateHeight(
          rectangle: Rectangle,
          longitude: number,
          latitude: number,
        ): number | undefined;
      }
    | undefined;
}

/** A node of the terrain quadtree (Cesium's `QuadtreeTile`); children exist once requested. */
export interface TerrainTileInternals {
  readonly rectangle: Rectangle;
  /** Undefined until the tile is first loaded; Cesium's own checks also allow null. */
  readonly data: SurfaceTileInternals | null | undefined;
  readonly _southwestChild: TerrainTileInternals | undefined;
  readonly _southeastChild: TerrainTileInternals | undefined;
  readonly _northwestChild: TerrainTileInternals | undefined;
  readonly _northeastChild: TerrainTileInternals | undefined;
}

/** The globe's terrain quadtree (Globe.js `_surface`, a `QuadtreePrimitive`). */
interface TerrainQuadtreeInternals {
  readonly _levelZeroTiles: readonly TerrainTileInternals[] | undefined;
  /** The terrain its tiles are made from: the globe's own only from the frame after a change. */
  readonly tileProvider: { readonly terrainProvider: unknown };
}

/** The globe the ground is picked on; its terrain quadtree is reached through Cesium internals. */
export type GroundGlobe = Pick<Globe, 'getHeight'>;

/** The pick time a limited pass may spend. */
export interface PickBudget {
  /** Milliseconds of picks left. */
  remainingMs(): number;
  /** Counts `ms` of picks against the budget. */
  spend(ms: number): void;
}

/** What limits a pass: its budget of pick time, the clock it is spent on, and the camera. */
export interface PassLimit {
  budget: PickBudget;
  now: () => number;
  /** The camera's position (ECEF metres): points above its horizon are picked first. */
  viewer?: Cartesian3;
}

/** What one pass did. */
export interface GroundPass {
  /** Points picked: `globe.getHeight` calls. */
  picked: number;
  /** Points still to pick, the budget spent. */
  pending: number;
  /** Whether any height changed. */
  changed: boolean;
}

function quadtreeOf(globe: GroundGlobe): TerrainQuadtreeInternals {
  const surface = (globe as unknown as { _surface?: TerrainQuadtreeInternals })
    ._surface;
  if (surface === undefined)
    throw new Error(
      'the ground under the observations needs the globe’s terrain quadtree (Globe._surface), which this Cesium lacks',
    );
  return surface;
}

/**
 * Whether the globe's tiles are still the smooth globe's (`EllipsoidTerrainProvider`): World
 * Terrain set on the globe reaches its quadtree, which frees the old tiles, only as the next frame
 * begins (Globe.js:1043, QuadtreePrimitive.js:336), and their ground is no terrain's.
 */
export function tilesAreSmooth(globe: GroundGlobe): boolean {
  return (
    quadtreeOf(globe).tileProvider.terrainProvider instanceof
    EllipsoidTerrainProvider
  );
}

function containing(
  tile: TerrainTileInternals | undefined,
  cartographic: Cartographic,
): TerrainTileInternals | undefined {
  return tile !== undefined && Rectangle.contains(tile.rectangle, cartographic)
    ? tile
    : undefined;
}

function hasRenderedMesh(tile: TerrainTileInternals | undefined): boolean {
  return tile?.data?.renderedMesh !== undefined;
}

/**
 * The deepest tile under `cartographic` with a rendered mesh, as Cesium 1.145's `Globe.getHeight`
 * finds the tile it picks (Globe.js:858-910), or undefined where none has one.
 */
export function renderedTileAt(
  levelZeroTiles: readonly TerrainTileInternals[],
  cartographic: Cartographic,
): TerrainTileInternals | undefined {
  let tile: TerrainTileInternals | undefined = levelZeroTiles.find((t) =>
    Rectangle.contains(t.rectangle, cartographic),
  );
  if (tile === undefined) return undefined;
  let tileWithMesh = tile;
  while (tile !== undefined) {
    tile =
      containing(tile._southwestChild, cartographic) ??
      containing(tile._southeastChild, cartographic) ??
      containing(tile._northwestChild, cartographic) ??
      tile._northeastChild;
    if (tile !== undefined && hasRenderedMesh(tile)) tileWithMesh = tile;
  }
  return hasRenderedMesh(tileWithMesh) ? tileWithMesh : undefined;
}

/** Where a pick's height came from: its mesh, that mesh's relief then, and the source height. */
interface Picked {
  mesh: TerrainMeshInternals;
  height: number;
  exaggeration: number;
  relativeHeight: number;
  /** The source height under the point (NaN on a fill mesh, whose source it cannot read). */
  source: number;
}

/**
 * The ground under `picked`'s point on its mesh drawn at `exaggeration` from `relativeHeight`;
 * undefined when that needs a pick: the relief changed and the source height is unknown.
 */
function followRelief(
  picked: Picked,
  exaggeration: number,
  relativeHeight: number,
): number | undefined {
  if (
    exaggeration === picked.exaggeration &&
    relativeHeight === picked.relativeHeight
  )
    return picked.height;
  if (!Number.isFinite(picked.source)) return undefined;
  return (
    picked.height +
    (picked.source - relativeHeight) * exaggeration +
    relativeHeight -
    (picked.source - picked.relativeHeight) * picked.exaggeration -
    picked.relativeHeight
  );
}

function assertLonLat(lonLat: Float64Array): void {
  if (lonLat.length % 2 !== 0)
    throw new Error(
      `ground heights need lon, lat pairs: got ${lonLat.length} numbers`,
    );
  const firstBad = lonLat.findIndex((value) => !Number.isFinite(value));
  if (firstBad !== -1) {
    const pair = Math.floor(firstBad / 2);
    throw new Error(
      `ground heights need finite lon, lat pairs: pair ${pair} is (${lonLat[2 * pair]}, ${lonLat[2 * pair + 1]})`,
    );
  }
}

const SCRATCH = new Cartographic();

/** The ground under fixed points, picked once per rendered mesh and followed through relief. */
export class GroundPoints {
  /** One height per point, NaN until picked or where no tile has a mesh. Read, never keep. */
  readonly heights: Float64Array;
  /** Radians, longitudes wrapped into [−π, π], where `getHeight` finds its tiles. */
  readonly #longitude: Float64Array;
  readonly #latitude: Float64Array;
  readonly #picked: (Picked | undefined)[];
  /**
   * Each point on the ellipsoid and its surface normal (ECEF), six numbers a point, made on the
   * first pass that orders points by view.
   */
  #tangentPlanes: Float64Array | undefined;
  /** This pass's tile under each point still to pick; reused from pass to pass. */
  readonly #tiles: (TerrainTileInternals | undefined)[];

  /** `lonLat`: WGS84 degree pairs. Throws unless they are finite pairs. */
  constructor(lonLat: Float64Array) {
    assertLonLat(lonLat);
    const count = lonLat.length / 2;
    this.heights = new Float64Array(count).fill(Number.NaN);
    this.#longitude = new Float64Array(count);
    this.#latitude = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      this.#longitude[i] = CesiumMath.negativePiToPi(
        CesiumMath.toRadians(lonLat[2 * i]),
      );
      this.#latitude[i] = CesiumMath.toRadians(lonLat[2 * i + 1]);
    }
    this.#picked = new Array<Picked | undefined>(count);
    this.#tiles = new Array<TerrainTileInternals | undefined>(count);
  }

  /**
   * Reads the ground under every point: a point on the mesh it was picked on follows that mesh's
   * relief, the others are picked, in view first, until `limit`'s budget is spent (all of them
   * without a limit).
   */
  update(globe: GroundGlobe, limit?: PassLimit): GroundPass {
    if (tilesAreSmooth(globe)) return { changed: false, pending: 0, picked: 0 };
    const levelZero = quadtreeOf(globe)._levelZeroTiles;
    const pending: number[] = [];
    let changed = false;
    for (let i = 0; i < this.heights.length; i += 1) {
      const tile =
        levelZero === undefined
          ? undefined
          : renderedTileAt(levelZero, this.#at(i));
      const mesh = tile?.data?.renderedMesh;
      const picked = this.#picked[i];
      let height: number | undefined;
      if (mesh === undefined) {
        this.#picked[i] = undefined;
        height = Number.NaN;
      } else if (picked !== undefined) {
        const followed = followRelief(
          picked,
          mesh.encoding.exaggeration,
          mesh.encoding.exaggerationRelativeHeight,
        );
        if (mesh === picked.mesh) height = followed;
        // A new mesh waits for its pick: until then the old mesh's ground follows the relief.
        else if (followed !== undefined)
          changed = this.#write(i, followed) || changed;
      }
      if (height === undefined) {
        this.#tiles[i] = tile;
        pending.push(i);
      } else changed = this.#write(i, height) || changed;
    }
    const order = limit?.viewer
      ? this.#inViewFirst(pending, limit.viewer)
      : pending;
    let picked = 0;
    for (const i of order) {
      if (limit && limit.budget.remainingMs() <= 0) break;
      const start = limit?.now();
      changed = this.#pick(globe, i) || changed;
      if (limit) limit.budget.spend(limit.now() - start!);
      picked += 1;
    }
    this.#tiles.fill(undefined);
    return { changed, pending: pending.length - picked, picked };
  }

  #at(i: number): Cartographic {
    SCRATCH.longitude = this.#longitude[i];
    SCRATCH.latitude = this.#latitude[i];
    SCRATCH.height = 0;
    return SCRATCH;
  }

  #write(i: number, height: number): boolean {
    if (Object.is(this.heights[i], height)) return false;
    this.heights[i] = height;
    return true;
  }

  /** Picks point `i` on the mesh of `this.#tiles[i]`, and keeps where the height came from. */
  #pick(globe: GroundGlobe, i: number): boolean {
    const tile = this.#tiles[i]!;
    const data = tile.data!;
    const mesh = data.renderedMesh!;
    const height = globe.getHeight(this.#at(i)) ?? Number.NaN;
    // Only the tile's own mesh draws its terrain data; a fill mesh draws its neighbours' edges.
    const source =
      mesh === data.mesh && data.terrainData !== undefined
        ? (data.terrainData.interpolateHeight(
            tile.rectangle,
            this.#longitude[i],
            this.#latitude[i],
          ) ?? Number.NaN)
        : Number.NaN;
    this.#picked[i] = {
      exaggeration: mesh.encoding.exaggeration,
      height,
      mesh,
      relativeHeight: mesh.encoding.exaggerationRelativeHeight,
      source,
    };
    return this.#write(i, height);
  }

  /**
   * `pending`, those above the horizon from `viewer` first, each part in its own order. A point is
   * above it when the camera is above the point's tangent plane on the ellipsoid.
   */
  #inViewFirst(pending: number[], viewer: Cartesian3): number[] {
    if (pending.length === 0) return pending;
    const planes = (this.#tangentPlanes ??= this.#planes());
    const inView = (i: number) =>
      (viewer.x - planes[6 * i]) * planes[6 * i + 3] +
        (viewer.y - planes[6 * i + 1]) * planes[6 * i + 4] +
        (viewer.z - planes[6 * i + 2]) * planes[6 * i + 5] >
      0;
    const first = pending.filter(inView);
    if (first.length === pending.length || first.length === 0) return pending;
    return [...first, ...pending.filter((i) => !inView(i))];
  }

  #planes(): Float64Array {
    const planes = new Float64Array(6 * this.heights.length);
    const point = new Cartesian3();
    const normal = new Cartesian3();
    for (let i = 0; i < this.heights.length; i += 1) {
      Cartesian3.fromRadians(
        this.#longitude[i],
        this.#latitude[i],
        0,
        Ellipsoid.WGS84,
        point,
      );
      Ellipsoid.WGS84.geodeticSurfaceNormal(point, normal);
      planes.set(
        [point.x, point.y, point.z, normal.x, normal.y, normal.z],
        6 * i,
      );
    }
    return planes;
  }
}
