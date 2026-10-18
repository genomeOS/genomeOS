/** Hover and persistent-selection highlights for Atlas design §11. Under World
 * Terrain the outline is a densified ring 300 m above the ground, in the same
 * PolylineCollection, and it follows Physical relief when re-sampled (terrain
 * draping design, "Per layer under World Terrain" (highlight), "Exaggeration"
 * and "Failure modes" (antimeridian cells), #483).
 */

import {
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  Color,
  type Globe,
  Material,
  PointPrimitive,
  PointPrimitiveCollection,
  Polyline,
  PolylineCollection,
  PrimitiveCollection,
  type Scene,
} from 'cesium';

import type { Observation, ObservationArtifact } from '../contracts';
import { h3BoundaryDegrees } from '../geometry/polygon-parts';
import type { Metric } from '../visual-encoding';
import { surfaceHeightAt, type SurfaceHeightSource } from './surface-heights';
import type { AtlasPick } from './types';

export type HighlightKind = 'hover' | 'selection';

export interface HighlightStyle {
  color: string;
  pointSize: number;
  width: number;
}

interface HighlightEntry {
  baseColor: Color;
  line: Polyline;
  lineMaterial: Material;
  point: PointPrimitive;
}

const HOVER_DURATION_MS = 160;
const SURFACE_CLEARANCE_METRES = 5_500;
/** The grounded outline's height above `globe.getHeight` under World Terrain. */
export const HIGHLIGHT_GROUND_CLEARANCE_METRES = 300;
/** Points per boundary edge of the grounded outline, so it follows the relief. */
export const HIGHLIGHT_EDGE_SEGMENTS = 16;

type Ground = Pick<Globe, 'getHeight'>;

const scratchCartographic = new Cartographic();

/** The rendered ground at a point (radians); 0 (the ellipsoid) where no tile
 * has loaded. `getHeight` finds no tile beyond ±180°, so the longitude is
 * wrapped into [−π, π] first. */
function groundHeight(
  ground: Ground,
  longitude: number,
  latitude: number,
): number {
  scratchCartographic.longitude = CesiumMath.negativePiToPi(longitude);
  scratchCartographic.latitude = latitude;
  scratchCartographic.height = 0;
  return ground.getHeight(scratchCartographic) ?? 0;
}

/** The cell's boundary with HIGHLIGHT_EDGE_SEGMENTS points to an edge, each
 * HIGHLIGHT_GROUND_CLEARANCE_METRES above the ground under it. Each edge is
 * unwrapped to its short way round, so a cell across 180° keeps one ring. */
function groundRing(ground: Ground, h3Index: string): Cartesian3[] {
  const boundary = h3BoundaryDegrees(h3Index);
  const positions: Cartesian3[] = [];
  boundary.forEach(([lon, lat], index) => {
    const [nextLon, nextLat] = boundary[(index + 1) % boundary.length];
    const rawDeltaLon = nextLon - lon;
    const deltaLon = rawDeltaLon - 360 * Math.round(rawDeltaLon / 360);
    const deltaLat = nextLat - lat;
    for (let step = 0; step < HIGHLIGHT_EDGE_SEGMENTS; step += 1) {
      const fraction = step / HIGHLIGHT_EDGE_SEGMENTS;
      const longitude = CesiumMath.toRadians(lon + deltaLon * fraction);
      const latitude = CesiumMath.toRadians(lat + deltaLat * fraction);
      positions.push(
        Cartesian3.fromRadians(
          longitude,
          latitude,
          groundHeight(ground, longitude, latitude) +
            HIGHLIGHT_GROUND_CLEARANCE_METRES,
        ),
      );
    }
  });
  return positions;
}

export function highlightStyle(kind: HighlightKind): HighlightStyle {
  return kind === 'hover'
    ? { color: '#b9f8ff', pointSize: 26, width: 4 }
    : { color: '#ffd56a', pointSize: 32, width: 5 };
}

function createEntry(
  kind: HighlightKind,
  lines: PolylineCollection,
  points: PointPrimitiveCollection,
): HighlightEntry {
  const style = highlightStyle(kind);
  const baseColor = Color.fromCssColorString(style.color);
  const lineMaterial = Material.fromType('PolylineGlow', {
    color: baseColor.withAlpha(0),
    glowPower: kind === 'hover' ? 0.32 : 0.18,
    taperPower: 0.6,
  });
  const line = lines.add({
    loop: true,
    material: lineMaterial,
    positions: Cartesian3.fromDegreesArray([0, 0, 0.1, 0]),
    show: false,
    width: style.width,
  });
  const point = points.add({
    color: baseColor.withAlpha(0.12),
    disableDepthTestDistance: 0,
    outlineColor: baseColor.withAlpha(0),
    outlineWidth: kind === 'hover' ? 5 : 6,
    pixelSize: style.pointSize,
    position: Cartesian3.fromDegrees(0, 0),
    show: false,
  });
  return { baseColor, line, lineMaterial, point };
}

function setEntryOpacity(
  entry: HighlightEntry,
  opacity: number,
  earthOpacity = 1,
): void {
  const lineColor = entry.lineMaterial.uniforms.color;
  if (lineColor instanceof Color) lineColor.alpha = opacity * earthOpacity;
  entry.point.color.alpha = 0.12 * opacity * earthOpacity;
  entry.point.outlineColor.alpha = opacity * earthOpacity;
}

export class HighlightLayer {
  readonly collection = new PrimitiveCollection();
  readonly #scene: Scene;
  readonly #hover: HighlightEntry;
  readonly #selection: HighlightEntry;
  #surface: SurfaceHeightSource | null = null;
  #observations = new Map<string, Observation>();
  #metric: Metric = 'post_mean';
  #elevation = false;
  #exaggeration = 1;
  #earthOpacity = 1;
  #ground: Ground | null = null;
  #hoverPick: AtlasPick | null = null;
  #selectionPick: AtlasPick | null = null;
  #hoverSequence = 0;

  constructor(scene: Scene) {
    this.#scene = scene;
    const lines = new PolylineCollection();
    const points = new PointPrimitiveCollection();
    this.collection.add(lines);
    this.collection.add(points);
    this.#hover = createEntry('hover', lines, points);
    this.#selection = createEntry('selection', lines, points);
  }

  setArtifacts(
    surface: SurfaceHeightSource | null,
    observations: ObservationArtifact | null,
    metric: Metric,
    elevation: boolean,
    exaggeration: number,
  ): void {
    this.#surface = surface;
    this.#observations = new Map(
      (observations?.observations ?? []).map((observation) => [
        observation.source_record_id,
        observation,
      ]),
    );
    this.#metric = metric;
    this.#elevation = elevation;
    this.#exaggeration = exaggeration;
    this.#show(this.#hover, this.#hoverPick);
    this.#show(this.#selection, this.#selectionPick);
  }

  /** Ground the highlights on World Terrain's rendered surface, or `null` for
   * today's outline at the data's top. Calling it again re-samples the shown
   * highlights, so they follow relief once Cesium has re-exaggerated the tiles. */
  setGround(ground: Ground | null): void {
    this.#ground = ground;
    if (!this.#hoverPick && !this.#selectionPick) return;
    if (this.#hoverPick) this.#show(this.#hover, this.#hoverPick);
    if (this.#selectionPick) this.#show(this.#selection, this.#selectionPick);
    this.#scene.requestRender();
  }

  setElevationStyle(enabled: boolean, exaggeration: number): void {
    this.#elevation = enabled;
    this.#exaggeration = exaggeration;
    this.#show(this.#hover, this.#hoverPick);
    this.#show(this.#selection, this.#selectionPick);
  }

  setHover(pick: AtlasPick | null, reducedMotion: boolean): void {
    this.#hoverPick = pick;
    const sequence = ++this.#hoverSequence;
    if (pick) this.#show(this.#hover, pick);
    const target = pick ? 1 : 0;
    if (reducedMotion) {
      setEntryOpacity(this.#hover, target, this.#earthOpacity);
      if (!pick) this.#hide(this.#hover);
      this.#scene.requestRender();
      return;
    }
    const started = performance.now();
    const frame = (now: number) => {
      if (sequence !== this.#hoverSequence) return;
      const linear = Math.min(1, (now - started) / HOVER_DURATION_MS);
      const eased = linear * linear * (3 - 2 * linear);
      setEntryOpacity(
        this.#hover,
        pick ? eased : 1 - eased,
        this.#earthOpacity,
      );
      this.#scene.requestRender();
      if (linear < 1) requestAnimationFrame(frame);
      else if (!pick) this.#hide(this.#hover);
    };
    requestAnimationFrame(frame);
  }

  setSelection(pick: AtlasPick | null): void {
    this.#selectionPick = pick;
    this.#show(this.#selection, pick);
    setEntryOpacity(this.#selection, pick ? 1 : 0, this.#earthOpacity);
    this.#scene.requestRender();
  }

  setEarthOpacity(opacity: number): void {
    this.#earthOpacity = Math.min(1, Math.max(0.15, opacity));
    setEntryOpacity(this.#hover, this.#hoverPick ? 1 : 0, this.#earthOpacity);
    setEntryOpacity(
      this.#selection,
      this.#selectionPick ? 1 : 0,
      this.#earthOpacity,
    );
    this.#scene.requestRender();
  }

  #hide(entry: HighlightEntry): void {
    entry.line.show = false;
    entry.point.show = false;
  }

  #show(entry: HighlightEntry, pick: AtlasPick | null): void {
    if (!pick || !this.#surface) {
      this.#hide(entry);
      return;
    }
    if (
      pick.artifactKey !== undefined &&
      this.#surface.artifactKey !== null &&
      pick.artifactKey !== this.#surface.artifactKey
    ) {
      this.#hide(entry);
      return;
    }
    if (pick.kind === 'surface') {
      const height = this.#surface.cellHeight(pick.h3Index, this.#metric);
      if (height === null) {
        this.#hide(entry);
        return;
      }
      entry.line.positions = this.#ground
        ? groundRing(this.#ground, pick.h3Index)
        : this.#raisedRing(pick.h3Index, height);
      entry.line.show = true;
      entry.point.show = false;
      return;
    }
    const observation = this.#observations.get(pick.sourceRecordId);
    if (!observation) {
      this.#hide(entry);
      return;
    }
    const top = this.#ground
      ? groundHeight(
          this.#ground,
          CesiumMath.toRadians(observation.lon),
          CesiumMath.toRadians(observation.lat),
        )
      : surfaceHeightAt(
          observation,
          this.#surface,
          this.#metric,
          this.#elevation,
          this.#exaggeration,
        );
    entry.point.position = Cartesian3.fromDegrees(
      observation.lon,
      observation.lat,
      top + SURFACE_CLEARANCE_METRES,
    );
    entry.point.show = true;
    entry.line.show = false;
  }

  /** Today's outline on the smooth globe: the boundary at the data's top. */
  #raisedRing(h3Index: string, height: number): Cartesian3[] {
    const top = this.#elevation ? height * Math.max(0, this.#exaggeration) : 0;
    return Cartesian3.fromDegreesArrayHeights(
      h3BoundaryDegrees(h3Index).flatMap(([lon, lat]) => [
        lon,
        lat,
        top + SURFACE_CLEARANCE_METRES,
      ]),
    );
  }
}
