import { cellToLatLng, latLngToCell } from 'h3-js';
import {
  Cartesian3,
  Math as CesiumMath,
  Ellipsoid,
  type PointPrimitiveCollection,
  type PolylineCollection,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObservationArtifact } from '../src/atlas/contracts';
import { GROUND_PASS_MEASURE } from '../src/atlas/e2e-hooks';
import {
  HIGHLIGHT_EDGE_SEGMENTS,
  HIGHLIGHT_GROUND_CLEARANCE_METRES,
  HighlightLayer,
} from '../src/atlas/scene/highlight-layer';
import { columnarHeightSource } from '../src/atlas/scene/surface-heights';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';
import { columnarSurface } from './helpers/columnar-surface';
import { fakeTerrain } from './helpers/terrain-fakes';

const CELL = '83754efffffffff';
const HIGHLIGHT_CLEARANCE_METRES = 5_500;

function setup() {
  stubCesiumBrowserImageTypes();
  const surface = columnarSurface([
    { h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' },
  ]);
  const source = columnarHeightSource(surface);
  const [lat, lon] = cellToLatLng(CELL);
  const observations = {
    observations: [{ lat, lon, source_record_id: 'map-surveys:1' }],
  } as unknown as ObservationArtifact;
  const layer = new HighlightLayer({ requestRender: vi.fn() } as never);
  layer.setArtifacts(source, observations, 'post_mean', true, 2);
  const lines = layer.collection.get(0) as PolylineCollection;
  const points = layer.collection.get(1) as PointPrimitiveCollection;
  return { layer, lines, observations, points, source, surface };
}

afterEach(() => vi.unstubAllGlobals());

describe('selection highlight from the render tier', () => {
  it('outlines a selected cell at its render-tier top', () => {
    const { layer, lines, source, surface } = setup();
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });

    const selection = lines.get(1);
    expect(selection.show).toBe(true);
    expect(
      Ellipsoid.WGS84.cartesianToCartographic(selection.positions[0]).height,
    ).toBeCloseTo(
      source.cellHeight(CELL, 'post_mean')! * 2 + HIGHLIGHT_CLEARANCE_METRES,
      3,
    );
  });

  it('hides the outline for a cell outside the surface', () => {
    const { layer, lines, surface } = setup();
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: '83754bfffffffff',
      kind: 'surface',
      row: 0,
    });
    expect(lines.get(1).show).toBe(false);
  });

  it('places an observation highlight on the render-tier surface height', () => {
    const { layer, points, source, surface } = setup();
    layer.setSelection({
      artifactKey: surface.artifactKey,
      kind: 'observation',
      sourceRecordId: 'map-surveys:1',
    });
    const point = points.get(1);
    expect(point.show).toBe(true);
    expect(
      Ellipsoid.WGS84.cartesianToCartographic(point.position).height,
    ).toBeCloseTo(
      source.cellHeight(CELL, 'post_mean')! * 2 + HIGHLIGHT_CLEARANCE_METRES,
      3,
    );
  });

  it('outlines a selected cell flat on the globe when elevation is off', () => {
    const { layer, lines, observations, source, surface } = setup();
    expect(source.cellHeight(CELL, 'post_mean')).toBeGreaterThan(0);
    layer.setArtifacts(source, observations, 'post_mean', false, 2);
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });

    const selection = lines.get(1);
    expect(selection.show).toBe(true);
    expect(
      Ellipsoid.WGS84.cartesianToCartographic(selection.positions[0]).height,
    ).toBeCloseTo(HIGHLIGHT_CLEARANCE_METRES, 3);
  });

  it('hides both highlights when the surface is withdrawn', () => {
    const { layer, lines, observations, points, surface } = setup();
    layer.setHover(
      {
        artifactKey: surface.artifactKey,
        h3Index: CELL,
        kind: 'surface',
        row: 0,
      },
      true,
    );
    layer.setSelection({
      artifactKey: surface.artifactKey,
      kind: 'observation',
      sourceRecordId: 'map-surveys:1',
    });
    expect(lines.get(0).show).toBe(true);
    expect(points.get(1).show).toBe(true);

    layer.setArtifacts(null, observations, 'post_mean', false, 0);

    for (const index of [0, 1]) {
      expect(lines.get(index).show).toBe(false);
      expect(points.get(index).show).toBe(false);
    }
  });
});

/** A sloping ground: 1,000 m plus 100 m per degree of latitude. */
const slopeAt = (_lon: number, lat: number) => 1_000 + 100 * lat;
/**
 * The slope on a fake terrain that counts its picks (tests/helpers/terrain-fakes.ts); like
 * Cesium's, its tiles end at ±180°, where `getHeight` finds nothing.
 */
const slope = () => fakeTerrain(slopeAt).globe;
const heightOf = (p: Cartesian3) =>
  Ellipsoid.WGS84.cartesianToCartographic(p).height;
const latitudeOf = (p: Cartesian3) =>
  CesiumMath.toDegrees(Ellipsoid.WGS84.cartesianToCartographic(p).latitude);

describe('highlights on World Terrain', () => {
  it('outlines a selected cell 300 m above the ground, 16 points to an edge, whatever the data elevation', () => {
    const { layer, lines, surface } = setup();
    layer.setGround(slope());
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    const { positions } = lines.get(1);
    expect([
      HIGHLIGHT_GROUND_CLEARANCE_METRES,
      HIGHLIGHT_EDGE_SEGMENTS,
    ]).toEqual([300, 16]);
    expect(positions).toHaveLength(6 * 16);
    for (const p of positions)
      expect(heightOf(p)).toBeCloseTo(slopeAt(0, latitudeOf(p)) + 300, 3);
  });

  it('places an observation highlight 5,500 m above the ground under it', () => {
    const { layer, observations, points, surface } = setup();
    layer.setGround(slope());
    layer.setSelection({
      artifactKey: surface.artifactKey,
      kind: 'observation',
      sourceRecordId: 'map-surveys:1',
    });
    const { lat } = observations.observations[0];
    expect(heightOf(points.get(1).position)).toBeCloseTo(
      1_000 + 100 * lat + 5_500,
      3,
    );
  });

  it('falls to the ellipsoid where the ground has not loaded', () => {
    const { layer, lines, surface } = setup();
    const terrain = fakeTerrain(slopeAt);
    terrain.unload(); // no tile has a mesh yet
    layer.setGround(terrain.globe);
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    for (const p of lines.get(1).positions)
      expect(heightOf(p)).toBeCloseTo(300, 3);
  });

  it('re-reads the shown highlights when the ground is set again: relief without a pick, new tiles picked', () => {
    const { layer, lines, surface } = setup();
    const terrain = fakeTerrain(() => 1_000);
    layer.setGround(terrain.globe);
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(96);
    terrain.globe.getHeight.mockClear();
    terrain.setRelief(4); // relief raised: the frame after it re-exaggerates every mesh
    layer.setGround(terrain.globe);
    expect(heightOf(lines.get(1).positions[0])).toBeCloseTo(4_300, 3);
    expect(terrain.globe.getHeight).not.toHaveBeenCalled();
    terrain.load(() => 2_000); // new tiles, drawn at relief 4
    layer.setGround(terrain.globe);
    expect(heightOf(lines.get(1).positions[0])).toBeCloseTo(8_300, 3);
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(96);
  });

  // Each point keeps the terrain mesh it was picked on, which Cesium may free meanwhile.
  it('lets go of a hidden highlight’s ground: shown again, it picks afresh', () => {
    const { layer, surface } = setup();
    const terrain = fakeTerrain(() => 1_000);
    layer.setGround(terrain.globe);
    const cell = {
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    } as const;
    layer.setSelection(cell);
    layer.setSelection(null);
    terrain.globe.getHeight.mockClear();
    layer.setSelection(cell);
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(96);
  });

  it('follows relief under a highlighted observation without a pick', () => {
    const { layer, observations, points, surface } = setup();
    const terrain = fakeTerrain(slopeAt);
    layer.setGround(terrain.globe);
    layer.setSelection({
      artifactKey: surface.artifactKey,
      kind: 'observation',
      sourceRecordId: 'map-surveys:1',
    });
    terrain.globe.getHeight.mockClear();
    terrain.setRelief(3);
    layer.setGround(terrain.globe);
    const { lat } = observations.observations[0];
    expect(heightOf(points.get(1).position)).toBeCloseTo(
      3 * slopeAt(0, lat) + 5_500,
      3,
    );
    expect(terrain.globe.getHeight).not.toHaveBeenCalled();
  });

  it('restores the raised outline when the ground is cleared', () => {
    const { layer, lines, source, surface } = setup();
    layer.setGround(slope());
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    layer.setGround(null);
    expect(lines.get(1).positions).toHaveLength(6);
    expect(heightOf(lines.get(1).positions[0])).toBeCloseTo(
      source.cellHeight(CELL, 'post_mean')! * 2 + 5_500,
      3,
    );
  });

  it('keeps an outline continuous, and on the ground, across the antimeridian', () => {
    stubCesiumBrowserImageTypes();
    const cell = latLngToCell(0, 180, 3);
    const surface = columnarSurface([
      { h3: cell, post_mean: 0.5, post_sd: 0.1, support: 'observed' },
    ]);
    const layer = new HighlightLayer({ requestRender: vi.fn() } as never);
    layer.setArtifacts(
      columnarHeightSource(surface),
      null,
      'post_mean',
      false,
      0,
    );
    layer.setGround(slope());
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: cell,
      kind: 'surface',
      row: 0,
    });
    const ringOf = (layer.collection.get(0) as PolylineCollection).get(
      1,
    ).positions;
    ringOf.forEach((p, i) => {
      expect(
        Cartesian3.distance(p, ringOf[(i + 1) % ringOf.length]),
      ).toBeLessThan(10_000);
      expect(heightOf(p)).toBeGreaterThan(1_000); // the ground was found, not the ellipsoid
    });
  });
});

describe('ground pass measures of the grounded highlight (e2e build)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    performance.clearMeasures();
  });

  const passes = () =>
    performance.getEntriesByName(GROUND_PASS_MEASURE, 'measure').map((e) => ({
      detail: (e as PerformanceMeasure).detail as unknown,
      duration: e.duration,
    }));

  /** The slope, each pick taking 1 ms of the page's clock. */
  function timedGround() {
    const clock = { now: 500 };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    const terrain = fakeTerrain(slopeAt);
    const pick = terrain.globe.getHeight.getMockImplementation()!;
    terrain.globe.getHeight.mockImplementation((c) => {
      clock.now += 1;
      return pick(c);
    });
    return terrain;
  }

  it('measures each grounded ring as a highlight pass, with the points it picked', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const { layer, surface } = setup();
    const terrain = timedGround();
    layer.setGround(terrain.globe);
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    terrain.setRelief(2);
    layer.setGround(terrain.globe); // a relief change: followed without a pick
    terrain.load(slopeAt);
    layer.setGround(terrain.globe); // tiles loaded: every point picked again
    expect(passes()).toEqual([
      { detail: { kind: 'highlight', points: 96 }, duration: 96 },
      { detail: { kind: 'highlight', points: 0 }, duration: 0 },
      { detail: { kind: 'highlight', points: 96 }, duration: 96 },
    ]);
  });

  it('measures nothing outside the e2e build', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '');
    const { layer, lines, surface } = setup();
    layer.setGround(timedGround().globe);
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    expect(lines.get(1).positions).toHaveLength(96);
    expect(passes()).toEqual([]);
  });
});
