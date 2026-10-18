import { cellToLatLng } from 'h3-js';
import {
  Ellipsoid,
  type Cartesian3,
  type PointPrimitiveCollection,
  type PolylineCollection,
  type PrimitiveCollection,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObservationArtifact } from '../src/atlas/contracts';
import {
  buildObservationLayer,
  footprintCircles,
  footprintSpec,
  observationHeightsFromBuffers,
  observationPickId,
  type ObservationLayerOptions,
} from '../src/atlas/scene/observation-layer';
import {
  anchorsFromBuffers,
  SYMBOL_CLEARANCE_METRES,
} from '../src/atlas/scene/observation-symbols';
import { SURFACE_CLEARANCE_METRES } from '../src/atlas/scene/surface-appearance';
import { columnarHeightSource } from '../src/atlas/scene/surface-heights';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';
import { columnarSurface } from './helpers/columnar-surface';

const KEY = 'fixture-artifact:v3:map-2026-08';
const CELL = '83754efffffffff';
const [LAT, LON] = cellToLatLng(CELL);
const RING_CLEARANCE_METRES = 4_000;

const observations = {
  artifact: {},
  observations: [
    {
      ac: 25,
      an: 100,
      assay: 'genotype',
      citation_text: 'Example publication.',
      cohort_id: 'map-study-1',
      disease_ascertainment_excluded: true,
      ingest_version: 'map-2026-08',
      lat: LAT,
      lon: LON,
      population_label: 'Example population',
      radius_km: 12,
      sampling_design: 'population_random',
      source_locator: 'MAP survey 1',
      source_record_id: 'map-surveys:1',
      source_url: 'https://example.org/source',
      study_id: 'map-study-1',
      study_label: 'Example study',
    },
  ],
} as unknown as ObservationArtifact;

function layer(overrides: Partial<ObservationLayerOptions> = {}) {
  stubCesiumBrowserImageTypes();
  return buildObservationLayer(observations, {
    artifactKey: KEY,
    colorVariable: 'solid',
    elevation: false,
    exaggeration: 1,
    gradient: ['#24144b', '#ad8bff', '#f4c86a'],
    heights: null,
    opacity: 1,
    samplingAreaColor: '#9af9e2',
    samplingAreas: true,
    shape: 'circle',
    sizeRange: [12, 32],
    sizeVariable: 'fixed',
    solidColor: '#f4fbff',
    ...overrides,
  });
}

function heightOf(
  position: Parameters<typeof Ellipsoid.WGS84.cartesianToCartographic>[0],
) {
  return Ellipsoid.WGS84.cartesianToCartographic(position).height;
}

afterEach(() => vi.unstubAllGlobals());

describe('observation surface heights', () => {
  it('turns worker anchor buffers into anchors, without a triangle when NaN', () => {
    const anchors = anchorsFromBuffers(
      {
        heights: Float64Array.of(1_000, 0),
        triangles: Float64Array.of(
          1,
          2,
          10,
          3,
          4,
          20,
          5,
          6,
          30,
          NaN,
          NaN,
          NaN,
          NaN,
          NaN,
          NaN,
          NaN,
          NaN,
          NaN,
        ),
      },
      2,
    );
    expect(anchors[0]).toEqual({
      height: 1_000,
      triangle: [
        { height: 10, lat: 1, lon: 2 },
        { height: 20, lat: 3, lon: 4 },
        { height: 30, lat: 5, lon: 6 },
      ],
    });
    expect(anchors[1]).toEqual({ height: 0, triangle: null });
  });

  it('refuses anchor heights that do not match the observations', () => {
    expect(() =>
      anchorsFromBuffers(
        { heights: new Float64Array(1), triangles: new Float64Array(18) },
        2,
      ),
    ).toThrow(/2 observations/);
  });

  it('refuses anchor triangles that do not match the observations', () => {
    expect(() =>
      anchorsFromBuffers(
        { heights: new Float64Array(2), triangles: new Float64Array(9) },
        2,
      ),
    ).toThrow(/2 observations/);
  });

  it('builds observations first at flat anchors and raises them when heights arrive', () => {
    const group = layer();
    const points = group.collection.get(2) as PointPrimitiveCollection;
    const rings = group.collection.get(0) as PolylineCollection;
    expect(heightOf(points.get(0).position)).toBeCloseTo(
      SURFACE_CLEARANCE_METRES + SYMBOL_CLEARANCE_METRES,
      3,
    );

    group.setSurfaceHeights({
      anchors: [{ height: 1_000, triangle: null }],
      ringBaseHeights: [500],
    });
    group.setElevationFactor(2, true);

    expect(heightOf(points.get(0).position)).toBeCloseTo(
      SURFACE_CLEARANCE_METRES + 2_000 + SYMBOL_CLEARANCE_METRES,
      3,
    );
    expect(heightOf(rings.get(0).positions[0])).toBeCloseTo(
      1_000 + RING_CLEARANCE_METRES,
      3,
    );
  });

  it('leaves every ring in place when the heights it already shows arrive again', () => {
    // The commit re-applies the heights the first chunk brought (#443). Rewriting the rings then
    // costs one GPU buffer write per ring, which held the GPU for ~0.6 s after the reveal.
    const group = layer();
    const rings = group.collection.get(0) as PolylineCollection;
    const flat = rings.get(0).positions;
    group.setSurfaceHeights(null);
    expect(rings.get(0).positions).toBe(flat);

    const heights = {
      anchors: [{ height: 1_000, triangle: null }],
      ringBaseHeights: [500],
    };
    group.setSurfaceHeights(heights);
    const placed = rings.get(0).positions;
    expect(placed).not.toBe(flat);
    group.setSurfaceHeights(heights);
    expect(rings.get(0).positions).toBe(placed);
  });

  it('keys observation picks and the group by artifact', () => {
    const group = layer();
    const points = group.collection.get(2) as PointPrimitiveCollection;
    expect(points.get(0).id).toEqual(observationPickId('map-surveys:1', KEY));
    expect(observationPickId('map-surveys:1', KEY)).toEqual({
      artifactKey: KEY,
      kind: 'observation',
      sourceRecordId: 'map-surveys:1',
    });
    expect(group.artifactKey).toBe(KEY);
    group.setOpacity(0.25);
    expect(group.opacity()).toBe(0.25);
  });

  it('combines worker anchors with render-tier ring heights', () => {
    const surface = columnarSurface([
      { h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' },
    ]);
    const source = columnarHeightSource(surface);
    const heights = observationHeightsFromBuffers(
      {
        heights: Float64Array.of(777),
        triangles: new Float64Array(9).fill(NaN),
      },
      observations.observations,
      source,
      'post_mean',
    );
    expect(heights.anchors).toEqual([{ height: 777, triangle: null }]);
    expect(heights.ringBaseHeights).toEqual([
      source.cellHeight(CELL, 'post_mean'),
    ]);
  });
});

function fakeFootprints() {
  return {
    alpha: Number.NaN,
    destroy: vi.fn(),
    isReady: () => true,
    layer: {} as never,
    name: 'atlas-footprints' as const,
    shown: true,
    setAlpha(a: number) {
      this.alpha = a;
    },
    setShown(s: boolean) {
      this.shown = s;
    },
  };
}
const CLEARANCE = SURFACE_CLEARANCE_METRES + SYMBOL_CLEARANCE_METRES; // 7,650 m

describe('observations on World Terrain', () => {
  it("lifts a symbol by the ground under it, keeping today's clearance", () => {
    const group = layer();
    const points = group.collection.get(2) as PointPrimitiveCollection;
    group.setGroundHeights(Float64Array.of(6_000));
    expect(heightOf(points.get(0).position)).toBeCloseTo(6_000 + CLEARANCE, 3);
    group.setGroundHeights(null);
    expect(heightOf(points.get(0).position)).toBeCloseTo(CLEARANCE, 3);
  });

  it('keeps a symbol where the ground has not loaded', () => {
    const group = layer();
    const points = group.collection.get(2) as PointPrimitiveCollection;
    group.setGroundHeights(Float64Array.of(Number.NaN));
    expect(heightOf(points.get(0).position)).toBeCloseTo(CLEARANCE, 3);
    group.setGroundHeights(Float64Array.of(6_000));
    group.setGroundHeights(Float64Array.of(Number.NaN));
    expect(heightOf(points.get(0).position)).toBeCloseTo(6_000 + CLEARANCE, 3);
  });

  it('refuses ground heights that do not match the observations', () => {
    expect(() => layer().setGroundHeights(Float64Array.of(1, 2))).toThrow(
      /1 observations/,
    );
  });

  it('raises a sphere by its radius above the ground, and leaves it alone when the ground holds', () => {
    const group = layer({ shape: 'sphere' }); // fixed size 22 → 22 km
    const spheres = group.collection.get(4) as PrimitiveCollection;
    group.setGroundHeights(Float64Array.of(6_000));
    const center = spheres.get(0).center as Cartesian3;
    expect(heightOf(center)).toBeCloseTo(6_000 + CLEARANCE + 22_000, 3);
    group.setGroundHeights(Float64Array.of(6_000));
    expect(spheres.get(0).center).toBe(center); // not re-placed
  });

  // Every appearance change under World Terrain resizes the symbols in view.
  it('keeps a resized sphere on the ground', () => {
    const group = layer({ shape: 'sphere' }); // fixed size 22 → 22 km
    const spheres = group.collection.get(4) as PrimitiveCollection;
    group.setGroundHeights(Float64Array.of(6_000));
    group.setSizeRange([20, 40]); // fixed size 30 → 30 km
    expect(heightOf(spheres.get(0).center as Cartesian3)).toBeCloseTo(
      6_000 + CLEARANCE + 30_000,
      3,
    );
  });

  it('reads its footprints as shown only while the collection and the sampling areas both are', () => {
    const group = layer({ samplingAreas: false });
    expect(group.footprintsShown()).toBe(false);
    group.setVisibility(true, true);
    expect(group.footprintsShown()).toBe(true);
    group.collection.show = false;
    expect(group.footprintsShown()).toBe(false);
  });

  it("hides the rings behind a draped footprint layer driven by the group's opacity and visibility", () => {
    const group = layer();
    const rings = group.collection.get(0) as PolylineCollection;
    const footprints = fakeFootprints();
    group.setStyleOpacity(0.8);
    group.setFootprints(footprints);
    expect([rings.show, footprints.alpha, footprints.shown]).toEqual([
      false,
      expect.closeTo(0.8, 9),
      true,
    ]);
    group.setOpacity(0.5);
    expect(footprints.alpha).toBeCloseTo(0.4, 9);
    group.setEarthOpacity(0.3);
    expect(footprints.alpha).toBeCloseTo(0.4, 9); // the translucent globe already dims draped imagery
    group.setVisibility(true, false);
    expect([footprints.shown, rings.show]).toEqual([false, false]);
    group.setVisibility(true, true);
    expect(footprints.shown).toBe(true);
    group.collection.show = false; // retired: frees its tiles
    expect(footprints.shown).toBe(false);
    group.collection.show = true;
    expect(footprints.shown).toBe(true);
    group.setFootprints(null);
    expect([footprints.destroy.mock.calls.length, rings.show]).toEqual([
      1,
      true,
    ]);
  });

  it('destroys the footprint layer it replaces', () => {
    const group = layer();
    const [first, second] = [fakeFootprints(), fakeFootprints()];
    group.setFootprints(first);
    group.setFootprints(second);
    expect([
      first.destroy.mock.calls.length,
      second.destroy.mock.calls.length,
    ]).toEqual([1, 0]);
  });

  it('lists sampling footprints as lon, lat, radius triples', () => {
    expect(footprintCircles(observations.observations)).toEqual(
      Float64Array.of(LON, LAT, 12),
    );
    expect(footprintSpec(KEY, observations.observations, '#9af9e2')).toEqual({
      artifactKey: KEY,
      circles: Float64Array.of(LON, LAT, 12),
      color: '#9af9e2',
      layer: 'footprints',
    });
  });
});
