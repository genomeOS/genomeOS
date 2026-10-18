/** Measured-observation symbols and source-supported footprints for Atlas design §11.
 *
 * Heights are immutable, so `setSurfaceHeights` with the heights already shown changes nothing.
 * The commit re-applies the heights that arrived with the first chunk (spec 2026-10-07 §B.6.8);
 * re-placing every symbol and sampling ring then would rewrite the ring buffer one ring at a time,
 * a GPU write per ring, and on ANGLE Metal that held the GPU, and with it every frame, for ~0.6 s
 * right after the reveal (#443).
 *
 * Under World Terrain (terrain draping design, "Per layer under World Terrain": sampling
 * footprints and observation symbols, #483) each symbol rises by the ground under it with today's
 * clearance kept, and the sampling footprints drape as the group's own `atlas-footprints` imagery
 * layer, never part of the surface texture; the rings hide while that layer is set.
 */

import * as Cesium from 'cesium';
import {
  BillboardCollection,
  Cartesian3,
  Color,
  Material,
  PointPrimitiveCollection,
  PolylineCollection,
  PrimitiveCollection,
  VerticalOrigin,
} from 'cesium';

import type { Observation, ObservationArtifact } from '../contracts';
import type { FootprintRasterSpec } from '../geometry/raster/types';
import {
  observationColor,
  observationDomains,
  observationSize,
  validateObservationSizeRange,
  type ObservationColorVariable,
  type ObservationShape,
  type ObservationSizeRange,
  type ObservationSizeVariable,
} from '../observation-encoding';
import type { Metric } from '../visual-encoding';
import type { ObservationAnchorBuffers } from '../worker/protocol';
import {
  anchorsFromBuffers,
  litStudImage,
  observationSurfacePlacement,
  sphereSurfacePlacement,
  STUD_ASPECT_RATIO,
  type ObservationSurfaceAnchor,
  type ObservationSurfaceHeights,
} from './observation-symbols';
import { surfaceHeightAt, type SurfaceHeightSource } from './surface-heights';
import type { DrapedImageryLayer, ObservationPresentation } from './types';

export type { ObservationSurfaceHeights } from './observation-symbols';

export type ObservationPick = {
  kind: 'observation';
  artifactKey: string;
  sourceRecordId: string;
};

export interface ObservationLayerOptions {
  artifactKey: string;
  colorVariable: ObservationColorVariable;
  elevation: boolean;
  exaggeration: number;
  gradient: readonly [string, string, string];
  heights: ObservationSurfaceHeights | null;
  opacity: number;
  samplingAreaColor: string;
  sizeRange: ObservationSizeRange;
  samplingAreas: boolean;
  shape: ObservationShape;
  sizeVariable: ObservationSizeVariable;
  solidColor: string;
}

export interface ObservationPrimitiveGroup {
  readonly artifactKey: string;
  collection: PrimitiveCollection;
  isReady(): boolean;
  opacity(): number;
  readyCount(): number;
  totalCount(): number;
  setElevationFactor(factor: number, force?: boolean): void;
  /** Re-places the symbols and rings on new heights; the heights already shown are a no-op. */
  setSurfaceHeights(heights: ObservationSurfaceHeights | null): void;
  setEarthOpacity(opacity: number): void;
  /**
   * Lifts each symbol by the terrain under it, in observation order (null: the smooth globe, no
   * lift). A NaN entry keeps that symbol where it is until its ground loads; only symbols whose
   * ground changed are re-placed. A length other than the observation count throws.
   */
  setGroundHeights(h: Float64Array | null): void;
  /**
   * Takes ownership of the draped `atlas-footprints` layer (null clears it), destroying the layer
   * it replaces; the rings hide while one is set. Its α is the fade × style opacity, and it shows
   * while the collection and the sampling areas both do.
   */
  setFootprints(l: DrapedImageryLayer | null): void;
  setOpacity(opacity: number): void;
  setSamplingAreaColor(color: string): void;
  setSizeRange(range: ObservationSizeRange): void;
  setStyleOpacity(opacity: number): void;
  setVisibility(symbols: boolean, samplingAreas: boolean): void;
}

interface GeographicPoint {
  lat: number;
  lon: number;
}

interface SymbolEncoding {
  anchor: ObservationSurfaceAnchor;
  color: string;
  observation: Observation;
  size: number;
  sizePosition: number;
}

interface RingSample {
  baseHeight: number;
  latRadians: number;
  lonRadians: number;
}

interface SpherePrimitive {
  center: Cartesian3;
  id: ObservationPick;
  material: Material;
  radii: Cartesian3;
  show: boolean;
}

interface SpherePrimitiveConstructor {
  new (options: {
    center: Cartesian3;
    id: ObservationPick;
    material: Material;
    radii: Cartesian3;
  }): SpherePrimitive;
}

const EARTH_RADIUS_KM = 6_371.0088;
const RING_CLEARANCE_METRES = 4_000;
const PIN_ASPECT_RATIO = 1.45;
// Cesium 1.145 exports this mutable ray-cast primitive but omits its private API from the types.
const RaycastSpherePrimitive = (
  Cesium as unknown as { EllipsoidPrimitive: SpherePrimitiveConstructor }
).EllipsoidPrimitive;
const FLAT_ANCHOR: ObservationSurfaceAnchor = { height: 0, triangle: null };
const LIT_PIN_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="96" height="128" viewBox="0 0 96 128">
    <defs>
      <radialGradient id="pin" cx="34%" cy="24%" r="76%">
        <stop offset="0" stop-color="white"/>
        <stop offset="0.42" stop-color="#e5edf7"/>
        <stop offset="0.78" stop-color="#8090a5"/>
        <stop offset="1" stop-color="#152238"/>
      </radialGradient>
    </defs>
    <ellipse cx="48" cy="121" rx="13" ry="4" fill="#020712" fill-opacity=".35"/>
    <path d="M48 124C41 108 12 82 12 50C12 23 28 8 48 8S84 23 84 50C84 82 55 108 48 124Z" fill="url(#pin)" stroke="white" stroke-opacity=".52" stroke-width="3"/>
    <ellipse cx="36" cy="31" rx="10" ry="7" fill="white" fill-opacity=".34"/>
  </svg>
`)}`;

function litPinImage(): HTMLCanvasElement | string {
  if (typeof document === 'undefined') return LIT_PIN_IMAGE;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is required for pins.');

  context.fillStyle = 'rgba(2, 7, 18, 0.35)';
  context.beginPath();
  context.ellipse(48, 121, 13, 4, 0, 0, Math.PI * 2);
  context.fill();

  context.beginPath();
  context.moveTo(48, 124);
  context.bezierCurveTo(41, 108, 12, 82, 12, 50);
  context.bezierCurveTo(12, 23, 28, 8, 48, 8);
  context.bezierCurveTo(68, 8, 84, 23, 84, 50);
  context.bezierCurveTo(84, 82, 55, 108, 48, 124);
  context.closePath();
  const body = context.createRadialGradient(33, 28, 2, 48, 52, 55);
  body.addColorStop(0, 'rgba(255, 255, 255, 1)');
  body.addColorStop(0.42, 'rgba(229, 237, 247, 1)');
  body.addColorStop(0.78, 'rgba(128, 144, 165, 1)');
  body.addColorStop(1, 'rgba(21, 34, 56, 1)');
  context.fillStyle = body;
  context.fill();
  context.strokeStyle = 'rgba(255, 255, 255, 0.52)';
  context.lineWidth = 3;
  context.stroke();

  context.fillStyle = 'rgba(255, 255, 255, 0.34)';
  context.beginPath();
  context.ellipse(36, 31, 10, 7, -0.25, 0, Math.PI * 2);
  context.fill();
  return canvas;
}

export function observationPickId(
  sourceRecordId: string,
  artifactKey: string,
): ObservationPick {
  return { artifactKey, kind: 'observation', sourceRecordId };
}

export function observationHeightsFromBuffers(
  buffers: ObservationAnchorBuffers,
  observations: readonly Observation[],
  source: SurfaceHeightSource,
  metric: Metric,
): ObservationSurfaceHeights {
  return {
    anchors: anchorsFromBuffers(buffers, observations.length),
    ringBaseHeights: observations.map((observation) =>
      surfaceHeightAt(observation, source, metric, true, 1),
    ),
  };
}

/**
 * The cache key of a built group: the artifact and the presentation fields baked into its symbols.
 * The others (opacity, size range, sampling areas and their colour) are applied by its setters.
 */
export function observationKeyFor(
  artifactKey: string,
  style: ObservationPresentation,
): string {
  return [
    artifactKey,
    style.shape,
    style.colorVariable,
    style.solidColor,
    ...style.gradient,
    style.sizeVariable,
  ].join(':');
}

/** Each observation's sampling footprint as interleaved lon, lat (degrees), radius_km, in order. */
export function footprintCircles(
  observations: readonly Observation[],
): Float64Array {
  const circles = new Float64Array(observations.length * 3);
  for (const [index, observation] of observations.entries()) {
    circles[index * 3] = observation.lon;
    circles[index * 3 + 1] = observation.lat;
    circles[index * 3 + 2] = observation.radius_km;
  }
  return circles;
}

/** The footprint raster for one observation group; the colour is baked into its texels. */
export function footprintSpec(
  artifactKey: string,
  observations: readonly Observation[],
  color: string,
): FootprintRasterSpec {
  return {
    artifactKey,
    circles: footprintCircles(observations),
    color,
    layer: 'footprints',
  };
}

function samplingAreaMaterial(cssColor: string): Material {
  return Material.fromType('Color', {
    color: Color.fromCssColorString(cssColor).withAlpha(0.9),
  });
}

export function samplingRingSamples(
  observation: Observation,
  baseHeightAt: (point: GeographicPoint) => number,
  segments = 48,
): RingSample[] {
  const baseHeight = baseHeightAt(observation);
  const angularDistance = observation.radius_km / EARTH_RADIUS_KM;
  const lat1 = (observation.lat * Math.PI) / 180;
  const lon1 = (observation.lon * Math.PI) / 180;
  return Array.from({ length: segments }, (_, index) => {
    const bearing = (index / segments) * Math.PI * 2;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularDistance) +
        Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
      );
    return {
      baseHeight,
      latRadians: lat2,
      lonRadians: lon2,
    };
  });
}

function ringPositions(
  samples: readonly RingSample[],
  elevationFactor: number,
): Cartesian3[] {
  return samples.map((sample) =>
    Cartesian3.fromRadians(
      sample.lonRadians,
      sample.latRadians,
      sample.baseHeight * elevationFactor + RING_CLEARANCE_METRES,
    ),
  );
}

function encodings(
  artifact: ObservationArtifact,
  options: ObservationLayerOptions,
): SymbolEncoding[] {
  const domains = observationDomains(artifact.observations);
  const range = options.sizeRange;
  validateObservationSizeRange(options.shape, range);
  const sizeDomain =
    options.sizeVariable === 'fixed'
      ? ([0, 1] as const)
      : domains[options.sizeVariable];
  const colorDomain =
    options.colorVariable === 'gradient'
      ? domains.frequency
      : options.colorVariable === 'ac'
        ? domains.ac
        : ([0, 1] as const);
  return artifact.observations.map((observation, index) => {
    const sizePosition = observationSize(
      observation,
      options.sizeVariable,
      [0, 1],
      sizeDomain,
    );
    return {
      anchor: options.heights?.anchors[index] ?? FLAT_ANCHOR,
      color: observationColor(
        observation,
        options.colorVariable,
        colorDomain,
        options.solidColor,
        options.gradient,
      ),
      observation,
      size: range[0] + sizePosition * (range[1] - range[0]),
      sizePosition,
    };
  });
}

export function buildObservationLayer(
  artifact: ObservationArtifact,
  options: ObservationLayerOptions,
): ObservationPrimitiveGroup {
  const collection = new PrimitiveCollection();
  const rings = new PolylineCollection();
  const points = new PointPrimitiveCollection();
  const pins = new BillboardCollection();
  const hemispheres = new BillboardCollection();
  const spheres = new PrimitiveCollection();
  const symbols = encodings(artifact, options);
  let elevationFactor = options.elevation ? options.exaggeration : 0;
  let lastElevationUpdate = Number.NEGATIVE_INFINITY;
  let fadeOpacity = 1;
  let earthOpacity = 1;
  // The heights every symbol and ring is placed on now.
  let shownHeights = options.heights;
  let styleOpacity = options.opacity;
  // The terrain under each observation (World Terrain); zeros on the smooth globe.
  const ground = new Float64Array(symbols.length);
  let footprints: DrapedImageryLayer | null = null;
  let samplingAreasShown = options.samplingAreas;
  let collectionShown = collection.show;
  const uploadColor = new Color();
  const ringSamples: RingSample[][] = [];
  const ringBaseColors: Color[] = [];
  for (const [index, observation] of artifact.observations.entries()) {
    const material = samplingAreaMaterial(options.samplingAreaColor);
    const color = material.uniforms.color as Color;
    ringBaseColors.push(color.clone());
    const samples = samplingRingSamples(
      observation,
      () => options.heights?.ringBaseHeights[index] ?? 0,
    );
    ringSamples.push(samples);
    rings.add({
      id: observationPickId(observation.source_record_id, options.artifactKey),
      loop: true,
      material,
      positions: ringPositions(samples, elevationFactor),
      width: 2,
    });
  }
  rings.show = options.samplingAreas;
  collection.add(rings);

  const hemisphereBaseColors: Color[] = [];
  if (options.shape === 'hemisphere') {
    const hemisphereImage = litStudImage();
    for (const { anchor, color, observation, size } of symbols) {
      const cesiumColor = Color.fromCssColorString(color).withAlpha(1);
      const placement = observationSurfacePlacement(
        anchor,
        observation,
        elevationFactor,
      );
      hemisphereBaseColors.push(cesiumColor.clone());
      hemispheres.add({
        alignedAxis: Cartesian3.ZERO,
        color: cesiumColor,
        disableDepthTestDistance: 0,
        eyeOffset: placement.eyeOffset,
        height: size * STUD_ASPECT_RATIO,
        id: observationPickId(
          observation.source_record_id,
          options.artifactKey,
        ),
        image: hemisphereImage,
        position: placement.position,
        sizeInMeters: false,
        verticalOrigin: VerticalOrigin.BOTTOM,
        width: size,
      });
    }
  }
  collection.add(hemispheres);

  const pinImage = options.shape === 'pin' ? litPinImage() : null;
  const pointBaseColors: Color[] = [];
  const pointOutlineBaseColors: Color[] = [];
  const pinBaseColors: Color[] = [];
  for (const symbol of symbols) {
    const { anchor, color, observation, size } = symbol;
    const cesiumColor = Color.fromCssColorString(color).withAlpha(1);
    const placement = observationSurfacePlacement(
      anchor,
      observation,
      elevationFactor,
    );
    if (options.shape === 'circle') {
      const outlineColor = Color.fromCssColorString('#071426').withAlpha(0.92);
      pointBaseColors.push(cesiumColor.clone());
      pointOutlineBaseColors.push(outlineColor.clone());
      points.add({
        color: cesiumColor,
        disableDepthTestDistance: 0,
        id: observationPickId(
          observation.source_record_id,
          options.artifactKey,
        ),
        outlineColor,
        outlineWidth: 2,
        pixelSize: size,
        position: placement.position,
      });
    } else if (options.shape === 'pin') {
      pinBaseColors.push(cesiumColor.clone());
      pins.add({
        alignedAxis: placement.normal,
        color: cesiumColor,
        disableDepthTestDistance: 0,
        eyeOffset: placement.eyeOffset,
        id: observationPickId(
          observation.source_record_id,
          options.artifactKey,
        ),
        height: size * PIN_ASPECT_RATIO,
        image: pinImage!,
        position: placement.position,
        sizeInMeters: false,
        verticalOrigin: VerticalOrigin.BOTTOM,
        width: size,
      });
    }
  }
  collection.add(points);
  collection.add(pins);

  const sphereBaseColors: Color[] = [];
  if (options.shape === 'sphere') {
    for (const symbol of symbols) {
      const { anchor, color, observation, size } = symbol;
      const cesiumColor = Color.fromCssColorString(color).withAlpha(1);
      const sphere = sphereSurfacePlacement(
        observationSurfacePlacement(anchor, observation, elevationFactor),
        size,
      );
      sphereBaseColors.push(cesiumColor.clone());
      spheres.add(
        new RaycastSpherePrimitive({
          center: sphere.center,
          id: observationPickId(
            observation.source_record_id,
            options.artifactKey,
          ),
          material: Material.fromType('Color', { color: cesiumColor }),
          radii: sphere.radii,
        }),
      );
    }
  }
  collection.add(spheres);

  const symbolCollections = [hemispheres, points, pins, spheres];
  const placeSymbol = (index: number) => {
    const symbol = symbols[index];
    const placement = observationSurfacePlacement(
      symbol.anchor,
      symbol.observation,
      elevationFactor,
      ground[index],
    );
    if (options.shape === 'circle')
      points.get(index).position = placement.position;
    else if (options.shape === 'pin') {
      pins.get(index).position = placement.position;
      pins.get(index).alignedAxis = placement.normal;
    } else if (options.shape === 'hemisphere') {
      hemispheres.get(index).position = placement.position;
    } else {
      spheres.get(index).center = sphereSurfacePlacement(
        placement,
        symbol.size,
      ).center;
    }
  };
  const placeAll = () => {
    for (let index = 0; index < rings.length; index += 1)
      rings.get(index).positions = ringPositions(
        ringSamples[index],
        elevationFactor,
      );
    for (let index = 0; index < symbols.length; index += 1) placeSymbol(index);
  };
  // The draped footprints stand in for the rings: shown while the group and its sampling areas
  // are; only `show = false` frees an imagery layer's tiles (α 0 keeps them resident).
  const showSamplingAreas = () => {
    rings.show = samplingAreasShown && footprints === null;
    footprints?.setShown(collectionShown && samplingAreasShown);
  };
  // PrimitiveCollection.show is a plain field that Cesium reads each frame. This instance's own
  // accessor keeps that, and also hides the footprint layer when the group is retired.
  Object.defineProperty(collection, 'show', {
    configurable: true,
    enumerable: true,
    get: () => collectionShown,
    set: (shown: boolean) => {
      collectionShown = shown;
      showSamplingAreas();
    },
  });
  return {
    artifactKey: options.artifactKey,
    collection,
    isReady: () => true,
    opacity: () => fadeOpacity,
    readyCount: () => 0,
    totalCount: () => 0,
    setElevationFactor(factor: number, force = false) {
      const safeFactor = Math.max(0, factor);
      if (safeFactor === elevationFactor) return;
      const now = performance.now();
      if (!force && safeFactor !== 0 && now - lastElevationUpdate < 50) return;
      elevationFactor = safeFactor;
      lastElevationUpdate = now;
      placeAll();
    },
    setSurfaceHeights(heights: ObservationSurfaceHeights | null) {
      if (heights === shownHeights) return;
      shownHeights = heights;
      for (let index = 0; index < symbols.length; index += 1)
        symbols[index].anchor = heights?.anchors[index] ?? FLAT_ANCHOR;
      for (let index = 0; index < ringSamples.length; index += 1) {
        const baseHeight = heights?.ringBaseHeights[index] ?? 0;
        for (const sample of ringSamples[index]) sample.baseHeight = baseHeight;
      }
      placeAll();
    },
    setGroundHeights(heights: Float64Array | null) {
      if (heights && heights.length !== ground.length)
        throw new Error(
          `Ground heights do not match the ${ground.length} observations of this artifact`,
        );
      for (let index = 0; index < ground.length; index += 1) {
        const metres = heights ? heights[index] : 0;
        if (!Number.isFinite(metres) || metres === ground[index]) continue;
        ground[index] = metres;
        placeSymbol(index);
      }
    },
    setFootprints(layer: DrapedImageryLayer | null) {
      if (layer !== footprints) footprints?.destroy();
      footprints = layer;
      footprints?.setAlpha(fadeOpacity * styleOpacity);
      showSamplingAreas();
    },
    setOpacity(opacity: number) {
      fadeOpacity = opacity;
      // The translucent globe already dims draped imagery, so earth opacity is left out here.
      footprints?.setAlpha(opacity * styleOpacity);
      for (let index = 0; index < rings.length; index += 1) {
        const material = rings.get(index).material;
        const color = material.uniforms.color;
        if (color instanceof Color) {
          Color.clone(ringBaseColors[index], color);
          color.alpha =
            ringBaseColors[index].alpha * opacity * styleOpacity * earthOpacity;
        }
      }
      for (let index = 0; index < points.length; index += 1) {
        Color.clone(pointBaseColors[index], uploadColor);
        uploadColor.alpha =
          pointBaseColors[index].alpha * opacity * styleOpacity * earthOpacity;
        points.get(index).color = uploadColor;
        Color.clone(pointOutlineBaseColors[index], uploadColor);
        uploadColor.alpha =
          pointOutlineBaseColors[index].alpha *
          opacity *
          styleOpacity *
          earthOpacity;
        points.get(index).outlineColor = uploadColor;
      }
      for (let index = 0; index < pins.length; index += 1) {
        Color.clone(pinBaseColors[index], uploadColor);
        uploadColor.alpha =
          pinBaseColors[index].alpha * opacity * styleOpacity * earthOpacity;
        pins.get(index).color = uploadColor;
      }
      for (let index = 0; index < hemispheres.length; index += 1) {
        Color.clone(hemisphereBaseColors[index], uploadColor);
        uploadColor.alpha =
          hemisphereBaseColors[index].alpha *
          opacity *
          styleOpacity *
          earthOpacity;
        hemispheres.get(index).color = uploadColor;
      }
      for (let index = 0; index < spheres.length; index += 1) {
        const color = spheres.get(index).material.uniforms.color;
        if (color instanceof Color) {
          Color.clone(sphereBaseColors[index], color);
          color.alpha =
            sphereBaseColors[index].alpha *
            opacity *
            styleOpacity *
            earthOpacity;
        }
      }
    },
    setEarthOpacity(opacity: number) {
      earthOpacity = Math.min(1, Math.max(0.15, opacity));
      this.setOpacity(fadeOpacity);
    },
    setSizeRange(range: ObservationSizeRange) {
      validateObservationSizeRange(options.shape, range);
      for (let index = 0; index < symbols.length; index += 1) {
        const symbol = symbols[index];
        const size = range[0] + symbol.sizePosition * (range[1] - range[0]);
        symbol.size = size;
        if (options.shape === 'circle') points.get(index).pixelSize = size;
        else if (options.shape === 'hemisphere') {
          hemispheres.get(index).width = size;
          hemispheres.get(index).height = size * STUD_ASPECT_RATIO;
        } else if (options.shape === 'pin') {
          pins.get(index).width = size;
          pins.get(index).height = size * PIN_ASPECT_RATIO;
        } else {
          const sphere = sphereSurfacePlacement(
            observationSurfacePlacement(
              symbol.anchor,
              symbol.observation,
              elevationFactor,
              ground[index],
            ),
            size,
          );
          spheres.get(index).center = sphere.center;
          spheres.get(index).radii = sphere.radii;
        }
      }
    },
    setSamplingAreaColor(cssColor: string) {
      const selected = Color.fromCssColorString(cssColor).withAlpha(0.9);
      for (let index = 0; index < rings.length; index += 1)
        ringBaseColors[index] = selected.clone();
      this.setOpacity(fadeOpacity);
    },
    setStyleOpacity(opacity: number) {
      styleOpacity = opacity;
      this.setOpacity(fadeOpacity);
    },
    setVisibility(symbolsVisible: boolean, samplingAreas: boolean) {
      samplingAreasShown = samplingAreas;
      showSamplingAreas();
      for (const symbolCollection of symbolCollections)
        symbolCollection.show = symbolsVisible;
    },
  };
}
