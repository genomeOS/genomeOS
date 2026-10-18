import { cellToLatLng, latLngToCell } from 'h3-js';
import {
  Cartesian3,
  type Cartographic,
  Math as CesiumMath,
  Ellipsoid,
  type PointPrimitiveCollection,
  type PolylineCollection,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObservationArtifact } from '../src/atlas/contracts';
import {
  HIGHLIGHT_EDGE_SEGMENTS,
  HIGHLIGHT_GROUND_CLEARANCE_METRES,
  HighlightLayer,
} from '../src/atlas/scene/highlight-layer';
import { columnarHeightSource } from '../src/atlas/scene/surface-heights';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';
import { columnarSurface } from './helpers/columnar-surface';

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

/** A sloping ground: 1,000 m plus 100 m per degree of latitude; nothing loaded past ±180°. */
const slope = {
  getHeight: (c: Cartographic) =>
    Math.abs(c.longitude) <= Math.PI
      ? 1_000 + 100 * CesiumMath.toDegrees(c.latitude)
      : undefined,
};
const heightOf = (p: Cartesian3) =>
  Ellipsoid.WGS84.cartesianToCartographic(p).height;

describe('highlights on World Terrain', () => {
  it('outlines a selected cell 300 m above the ground, 16 points to an edge, whatever the data elevation', () => {
    const { layer, lines, surface } = setup();
    layer.setGround(slope);
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
      expect(heightOf(p)).toBeCloseTo(
        slope.getHeight(Ellipsoid.WGS84.cartesianToCartographic(p))! + 300,
        3,
      );
  });

  it('places an observation highlight 5,500 m above the ground under it', () => {
    const { layer, observations, points, surface } = setup();
    layer.setGround(slope);
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
    layer.setGround({ getHeight: () => undefined });
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    for (const p of lines.get(1).positions)
      expect(heightOf(p)).toBeCloseTo(300, 3);
  });

  it('re-samples the shown highlights when the ground is set again', () => {
    const { layer, lines, surface } = setup();
    let base = 1_000;
    const ground = { getHeight: () => base };
    layer.setGround(ground);
    layer.setSelection({
      artifactKey: surface.artifactKey,
      h3Index: CELL,
      kind: 'surface',
      row: 0,
    });
    base = 4_000; // relief raised
    layer.setGround(ground);
    expect(heightOf(lines.get(1).positions[0])).toBeCloseTo(4_300, 3);
  });

  it('restores the raised outline when the ground is cleared', () => {
    const { layer, lines, source, surface } = setup();
    layer.setGround(slope);
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
    layer.setGround(slope);
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
