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
 * Points start at NaN, and read NaN where no tile under them has a mesh, as `getHeight` reads
 * undefined there ("Failure modes": a symbol keeps its height until its ground loads).
 *
 * The mesh under a point is found as `Globe.getHeight` finds it, through Cesium 1.145's private
 * terrain quadtree (Globe.js `_surface`): `renderedTileAt` copies that descent, and a globe without
 * the quadtree is an error. Both are pinned in atlas-cesium-internals.test.ts.
 */

import {
  Cartographic,
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
}

/** The globe the ground is picked on; its terrain quadtree is reached through Cesium internals. */
export type GroundGlobe = Pick<Globe, 'getHeight'>;

/** What one pass did. */
export interface GroundPass {
  /** Points picked: `globe.getHeight` calls. */
  picked: number;
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
   * relief, the others are picked.
   */
  update(globe: GroundGlobe): GroundPass {
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
      } else if (picked !== undefined && mesh === picked.mesh)
        height = followRelief(
          picked,
          mesh.encoding.exaggeration,
          mesh.encoding.exaggerationRelativeHeight,
        );
      if (height === undefined) {
        this.#tiles[i] = tile;
        pending.push(i);
      } else changed = this.#write(i, height) || changed;
    }
    for (const i of pending) changed = this.#pick(globe, i) || changed;
    this.#tiles.fill(undefined);
    return { changed, picked: pending.length };
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
}
