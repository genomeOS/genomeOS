import {
  BufferPolyline,
  BufferPolylineCollection,
  BufferPolylineMaterial,
  Cartesian3,
  DeveloperError,
  Ellipsoid,
  HeightReference,
  HorizontalOrigin,
  type Label,
  LabelCollection,
  PolylineCollection,
  PrimitiveCollection,
  SceneMode,
  VerticalOrigin,
} from 'cesium';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NATURAL_EARTH_BORDERS } from '../src/atlas/context-sources';
import { decodeNaturalEarth } from '../src/atlas/geometry/natural-earth-codec';
import {
  BORDER_CLEARANCE_METRES,
  ContextOverlay,
  LABEL_READY_MAX_FRAMES,
} from '../src/atlas/scene/context-overlay';
import { countryLabelHeight } from '../src/atlas/scene/geographic-overlay';
import { whenLayerReady } from '../src/atlas/scene/scene-transition';
import type { ContextHeights } from '../src/atlas/worker/protocol';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';
import {
  fakeDrapedRuntime,
  fakeRasterProvider,
  type FakeRasterProvider,
} from './helpers/draped-fakes';
import { FakeEvent, flushTasks } from './helpers/scene-fakes';

const parsed = {
  labels: [{ lat: 47, lon: 2, minLabel: 2, text: 'France' }],
  lonLat: Float64Array.of(0, 0, 1, 0, 1, 1, 10, 10, 11, 10, 11, 11),
  ringOffsets: Uint32Array.of(0, 3, 6),
};

interface SetupOptions {
  context?: typeof parsed;
  /** Resolves the worker's heights; by default 1,000 m under every vertex and 500 m under every label. */
  heights?: () => Promise<ContextHeights>;
  now?: () => number;
  /** Leaves the overlay its own Cesium LabelCollection, built with the scene. */
  realLabels?: boolean;
  slice?: { sliceMs?: number; yieldFn: () => Promise<void> };
}

/** `fetchBytes: null` leaves the overlay its own fetch, for tests that stub `fetch`. */
function setup(
  fetchBytes: ((url: string) => Promise<ArrayBuffer>) | null = async () =>
    new ArrayBuffer(8),
  config: SetupOptions = {},
) {
  const context = config.context ?? parsed;
  type AddedLabel = Pick<
    Label,
    | 'heightReference'
    | 'horizontalOrigin'
    | 'position'
    | 'text'
    | 'verticalOrigin'
  >;
  const added: AddedLabel[] = [];
  const labels = {
    add({
      heightReference,
      horizontalOrigin,
      position,
      text,
      verticalOrigin,
    }: AddedLabel) {
      const label = {
        heightReference,
        horizontalOrigin,
        position,
        text,
        verticalOrigin,
      };
      added.push(label);
      return label;
    },
    destroy() {},
    // LabelCollection.ready: false until every glyph is in the texture atlas.
    ready: false,
    show: true,
  };
  let contextParsed = false;
  const worker = {
    // Like the data worker, which computes heights from the context it has parsed.
    contextHeights: vi.fn(async (): Promise<ContextHeights> => {
      if (!contextParsed)
        throw new Error('Natural Earth context is not parsed');
      if (config.heights) return config.heights();
      return {
        borderHeights: Float32Array.from(
          { length: context.lonLat.length / 2 },
          () => 1_000,
        ),
        labelHeights: Float32Array.from(context.labels, () => 500),
      };
    }),
    parseContext: vi.fn(async () => {
      contextParsed = true;
      return context;
    }),
    prepareRaster: vi.fn(),
    rasterTile: vi.fn(),
    releaseRaster: vi.fn(),
  };
  const primitives = new PrimitiveCollection();
  const scene = {
    // What a Cesium LabelCollection built with the scene reads to clamp a label: the ground is
    // 1,000 m everywhere (Billboard._updateClamping, Billboard.js:1121-1200).
    ellipsoid: Ellipsoid.WGS84,
    frameState: { mode: SceneMode.SCENE3D },
    getHeight: () => 1_000,
    globe: {},
    imageryLayers: {},
    postRender: new FakeEvent(),
    preRender: new FakeEvent(),
    primitives,
    // A destroyed Cesium Scene throws here too; CesiumWidget.destroy() destroys the primitives with it.
    requestRender: vi.fn(() => {
      if (primitives.isDestroyed())
        throw new DeveloperError('This object was destroyed');
    }),
    updateHeight: () => () => {},
  };
  const addCredit = vi.fn();
  const removeCredit = vi.fn();
  const onDrapeFailure = vi.fn();
  const overlay = new ContextOverlay({
    addCredit,
    createLabels: config.realLabels ? undefined : () => labels as never,
    fetchBytes: fetchBytes ?? undefined,
    now: config.now,
    onDrapeFailure,
    removeCredit,
    scene: scene as never,
    slice: config.slice ?? { yieldFn: () => Promise.resolve() },
    worker: worker as never,
  });
  return {
    added,
    addCredit,
    labels,
    onDrapeFailure,
    overlay,
    removeCredit,
    scene,
    worker,
  };
}

/** The DOM Cesium's Label reads in Node to parse its font (Label.js:46-86). */
function stubLabelFontDom(): void {
  vi.stubGlobal('document', {
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ style: {} }),
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
  });
}

function childrenOf(overlay: ContextOverlay): unknown[] {
  return Array.from({ length: overlay.collection.length }, (_, index) =>
    overlay.collection.get(index),
  );
}

function bufferOf(overlay: ContextOverlay): BufferPolylineCollection {
  for (let index = 0; index < overlay.collection.length; index += 1) {
    const child: unknown = overlay.collection.get(index);
    if (child instanceof BufferPolylineCollection) return child;
  }
  throw new Error('no border buffer');
}

function vertex(buffer: BufferPolylineCollection, ring: number): Cartesian3 {
  const line = new BufferPolyline();
  buffer.get(ring, line);
  const [x, y, z] = (line.toJSON() as { positions: number[] }).positions;
  return new Cartesian3(x, y, z);
}

function expectNear(actual: Cartesian3, expected: Cartesian3): void {
  expect(Cartesian3.distance(actual, expected)).toBeLessThan(1e-6);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Natural Earth context overlay', () => {
  it('draws worker rings and labels without touching surface heights at elevation 0', async () => {
    const { added, addCredit, overlay, removeCredit, scene, worker } = setup();

    await expect(
      overlay.load('/data/atlas/ne-50m-admin-0.borders.bin'),
    ).resolves.toBe('ready');

    expect(scene.primitives.contains(overlay.collection)).toBe(true);
    const buffer = bufferOf(overlay);
    expect(buffer.primitiveCount).toBe(2);
    expectNear(
      vertex(buffer, 0),
      Cartesian3.fromDegrees(0, 0, BORDER_CLEARANCE_METRES),
    );
    expectNear(
      vertex(buffer, 1),
      Cartesian3.fromDegrees(10, 10, BORDER_CLEARANCE_METRES),
    );
    expect(added.map(({ text }) => text)).toEqual(['France']);
    expectNear(
      added[0].position,
      Cartesian3.fromDegrees(2, 47, countryLabelHeight(0, 0)),
    );
    expect(addCredit).toHaveBeenCalledTimes(1);
    expect(addCredit.mock.calls[0][0].html).toContain('Natural Earth');
    expect(removeCredit).not.toHaveBeenCalled();
    expect(worker.contextHeights).not.toHaveBeenCalled();
    expect(overlay.isReady()).toBe(true);
  });

  it('credits Natural Earth from construction, before the deferred load', () => {
    // The phone credit block docks the legend strip: a credit added after the reveal wrapped the
    // credit text to a second line and moved the strip (#430).
    const { addCredit, overlay } = setup();
    expect(addCredit).toHaveBeenCalledTimes(1);
    expect(addCredit.mock.calls[0][0].html).toContain('Natural Earth');
    expect(overlay.isReady()).toBe(false);
  });

  it('centers each country label on its anchor, as the legacy entity labels were', async () => {
    // Cesium's Label defaults to LEFT/BASELINE, which drew each name to the right of and above its
    // country; LabelVisualizer gave the GeoJsonDataSource labels CENTER/CENTER.
    const { added, overlay } = setup();
    await overlay.load('/borders.bin');

    expect(added).toHaveLength(1);
    expect(added[0].horizontalOrigin).toBe(HorizontalOrigin.CENTER);
    expect(added[0].verticalOrigin).toBe(VerticalOrigin.CENTER);
  });

  it('loads once however often it is asked', async () => {
    const { overlay, worker } = setup();
    await Promise.all([
      overlay.load('/borders.bin'),
      overlay.load('/borders.bin'),
    ]);
    expect(worker.parseContext).toHaveBeenCalledTimes(1);
  });

  it('reports when the bytes have arrived, before it parses and draws them (§B.6.9)', async () => {
    const { overlay, worker } = setup();
    let finishParse!: () => void;
    worker.parseContext.mockImplementationOnce(
      () =>
        new Promise<typeof parsed>((resolve) => {
          finishParse = () => resolve(parsed);
        }),
    );
    const fetched = vi.fn();
    const loading = overlay.load('/a.geojson', fetched);
    await flushTasks();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.invocationCallOrder[0]).toBeLessThan(
      worker.parseContext.mock.invocationCallOrder[0],
    );
    expect(overlay.isReady()).toBe(false);
    finishParse();
    await expect(loading).resolves.toBe('ready');
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('reports each body chunk of the borders as progress, then their arrival (§B.6.9)', async () => {
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5)];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { overlay, worker } = setup(null);
    const fetched = vi.fn();
    const progress = vi.fn();
    await expect(overlay.load('/a.geojson', fetched, progress)).resolves.toBe(
      'ready',
    );
    expect(fetchMock).toHaveBeenCalledWith('/a.geojson');
    expect(progress).toHaveBeenCalledTimes(chunks.length);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(progress.mock.invocationCallOrder.at(-1)).toBeLessThan(
      fetched.mock.invocationCallOrder[0],
    );
    const [bytes] = worker.parseContext.mock.calls[0] as unknown as [
      ArrayBuffer,
    ];
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not report arrival when the borders cannot be fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { overlay } = setup(async () => {
      throw new Error('offline');
    });
    const fetched = vi.fn();
    await expect(overlay.load('/a.geojson', fetched)).resolves.toBe('fallback');
    expect(fetched).not.toHaveBeenCalled();
  });

  it('asks the worker for surface heights only on the first non-zero factor', async () => {
    const { added, overlay, worker } = setup();
    await overlay.load('/borders.bin');
    overlay.setSurface('hbs-rs334:v3:map-2026-08', 'post_mean');
    overlay.setElevationFactor(0, true);
    expect(worker.contextHeights).not.toHaveBeenCalled();

    overlay.setElevationFactor(2, true);
    expect(worker.contextHeights).toHaveBeenCalledWith({
      artifactKey: 'hbs-rs334:v3:map-2026-08',
      metric: 'post_mean',
    });
    await flushTasks();

    expectNear(
      vertex(bufferOf(overlay), 0),
      Cartesian3.fromDegrees(0, 0, 1_000 * 2 + BORDER_CLEARANCE_METRES),
    );
    expectNear(
      added[0].position,
      Cartesian3.fromDegrees(2, 47, countryLabelHeight(500, 2)),
    );
    overlay.setElevationFactor(3, true);
    expect(worker.contextHeights).toHaveBeenCalledTimes(1);
  });

  it('falls back quietly when the borders cannot be fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { addCredit, overlay, removeCredit } = setup(async () => {
      throw new Error('offline');
    });
    await expect(overlay.load('/borders.bin')).resolves.toBe('fallback');
    // No borders are drawn, so their credit goes.
    expect(removeCredit).toHaveBeenCalledTimes(1);
    expect(removeCredit).toHaveBeenCalledWith(addCredit.mock.calls[0][0]);
    expect(overlay.isReady()).toBe(false);
  });

  it('keeps the credit when the labels fail after the borders were drawn', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { labels, overlay, removeCredit } = setup();
    labels.add = () => {
      throw new Error('label failed');
    };
    await expect(overlay.load('/borders.bin')).resolves.toBe('fallback');
    expect(bufferOf(overlay).primitiveCount).toBe(2);
    expect(removeCredit).not.toHaveBeenCalled();
  });

  it('applies visibility and border style to the drawn rings', async () => {
    const { overlay } = setup();
    await overlay.load('/borders.bin');
    overlay.setVisible(false);
    expect(overlay.collection.show).toBe(false);

    overlay.setBorderStyle('#ff0000', 0.25);
    const line = new BufferPolyline();
    const material = new BufferPolylineMaterial();
    bufferOf(overlay).get(1, line);
    line.getMaterial(material);
    expect(material.color.red).toBeCloseTo(1, 2);
    expect(material.color.alpha).toBeCloseTo(0.25, 2);
    expect(material.width).toBeCloseTo(2.15, 2);
  });

  it("draws borders at the legacy entity polylines' on-screen width in both renderers", async () => {
    // The legacy borders were 1.65 px entity polylines, which PolylineColorAppearanceVS draws
    // 0.5 px wider; PolylineVS (the projected renderer) widens by 0.5 px too, BufferPolylineMaterialVS
    // does not.
    stubCesiumBrowserImageTypes();
    const { overlay } = setup();
    await overlay.load('/borders.bin');
    const line = new BufferPolyline();
    const material = new BufferPolylineMaterial();
    bufferOf(overlay).get(0, line);
    line.getMaterial(material);
    expect(material.width).toBeCloseTo(2.15, 2);

    await overlay.setSceneMode('map');
    expect(projectedOf(overlay)!.get(0).width).toBeCloseTo(1.65, 2);
  });

  it('keeps the projected borders hidden until every ring is added', async () => {
    // As for the cell outlines: a shown PolylineCollection is rebuilt in full on every render
    // after an add, so slice-by-slice drawing costs time quadratic in the ring count.
    stubCesiumBrowserImageTypes();
    const shownWhileAdding: boolean[] = [];
    let overlay: ContextOverlay | null = null;
    ({ overlay } = setup(undefined, {
      slice: {
        sliceMs: 0,
        yieldFn: async () => {
          const projected = overlay && projectedOf(overlay);
          if (projected) shownWhileAdding.push(projected.show);
        },
      },
    }));
    await overlay.load('/borders.bin');
    await overlay.setSceneMode('map');

    expect(projectedRingCount(overlay)).toBe(2);
    expect(shownWhileAdding.length).toBeGreaterThan(0);
    expect(shownWhileAdding.every((shown) => !shown)).toBe(true);
    expect(projectedOf(overlay)!.show).toBe(true);
  });

  it('switches to projected borders in the 2D map', async () => {
    stubCesiumBrowserImageTypes();
    const { overlay } = setup();
    await overlay.load('/borders.bin');
    await overlay.setSceneMode('map');

    const projected = [...Array(overlay.collection.length).keys()]
      .map((index) => overlay.collection.get(index) as unknown)
      .find(
        (child): child is PolylineCollection =>
          child instanceof PolylineCollection,
      );
    expect(projected?.length).toBe(2);
    expect(projected?.show).toBe(true);
    expect(bufferOf(overlay).show).toBe(false);
  });
});

describe('Natural Earth country label glyphs', () => {
  // Cesium queues a new glyph in the label texture atlas only after an await, so the frame that
  // created it finds the queue empty, its afterRender update returns false and no frame follows: in
  // requestRenderMode the labels stayed undrawn until something else asked for a render.
  it('requests frames after the labels are added until their glyphs are drawn', async () => {
    const { labels, overlay, scene } = setup();
    await overlay.load('/borders.bin');
    expect(scene.postRender.numberOfListeners).toBe(1);

    scene.requestRender.mockClear();
    scene.postRender.raiseEvent();
    scene.postRender.raiseEvent();
    expect(scene.requestRender).toHaveBeenCalledTimes(2);

    labels.ready = true;
    scene.postRender.raiseEvent();
    expect(scene.requestRender).toHaveBeenCalledTimes(2);
    expect(scene.postRender.numberOfListeners).toBe(0);
  });

  it('waits without rendering while the countries layer is hidden', async () => {
    // A hidden PrimitiveCollection does not update its labels, so they cannot become ready.
    const { overlay, scene } = setup();
    await overlay.load('/borders.bin');
    overlay.setVisible(false);
    scene.requestRender.mockClear();

    scene.postRender.raiseEvent();
    expect(scene.requestRender).not.toHaveBeenCalled();
    expect(scene.postRender.numberOfListeners).toBe(1);

    overlay.setVisible(true);
    scene.requestRender.mockClear();
    scene.postRender.raiseEvent();
    expect(scene.requestRender).toHaveBeenCalledTimes(1);
  });

  it('stops after a bounded number of frames when a glyph never loads', async () => {
    const { overlay, scene } = setup();
    await overlay.load('/borders.bin');
    scene.requestRender.mockClear();

    for (let frame = 0; frame < LABEL_READY_MAX_FRAMES + 5; frame += 1)
      scene.postRender.raiseEvent();

    expect(scene.requestRender).toHaveBeenCalledTimes(LABEL_READY_MAX_FRAMES);
    expect(scene.postRender.numberOfListeners).toBe(0);
  });

  it('stops quietly when the scene is torn down before the glyphs are drawn', async () => {
    const { overlay, scene } = setup();
    await overlay.load('/borders.bin');
    scene.primitives.destroy();
    scene.requestRender.mockClear();

    // The fake scene throws from requestRender once destroyed, like Cesium's.
    expect(() => scene.postRender.raiseEvent()).not.toThrow();
    expect(scene.requestRender).not.toHaveBeenCalled();
    expect(scene.postRender.numberOfListeners).toBe(0);
  });

  it('reads the readiness Cesium LabelCollection exposes', () => {
    // LabelCollection.ready is @private in Cesium; a release that drops it must fail here.
    expect(
      Object.getOwnPropertyDescriptor(LabelCollection.prototype, 'ready')?.get,
    ).toBeTypeOf('function');
  });
});

const COUNTRIES = {
  labels: [
    { lat: 47, lon: 2, minLabel: 2, text: 'France' },
    { lat: 40, lon: -4, minLabel: 2, text: 'Spain' },
    { lat: 42, lon: 12, minLabel: 2, text: 'Italy' },
  ],
  // One triangle per country, with its corner at (c, c), (c + 1, c) and (c + 1, c + 1).
  lonLat: Float64Array.from(
    [0, 10, 20].flatMap((c) => [c, c, c + 1, c, c + 1, c + 1]),
  ),
  ringOffsets: Uint32Array.of(0, 3, 6, 9),
};
const SURFACE = 'hbs-rs334:v3:map-2026-08';
const RAISED = 1_000 * 2 + BORDER_CLEARANCE_METRES;

/** One item per slice, so every build of two or more items yields between them. `atYield(when, action)`
 * runs `action` at the first yield at which `when()` holds, while borders or labels are being added. */
function slicedLoad() {
  const hooks: { action: () => void; when: () => boolean }[] = [];
  return {
    atYield(when: () => boolean, action: () => void) {
      hooks.push({ action, when });
    },
    slice: {
      sliceMs: 0,
      yieldFn: async () => {
        const index = hooks.findIndex(({ when }) => when());
        if (index >= 0) hooks.splice(index, 1)[0].action();
      },
    },
  };
}

function childOf<T>(
  overlay: ContextOverlay,
  type: abstract new (...args: never[]) => T,
): T | undefined {
  for (let index = 0; index < overlay.collection.length; index += 1) {
    const child: unknown = overlay.collection.get(index);
    if (child instanceof type) return child;
  }
  return undefined;
}

const projectedOf = (overlay: ContextOverlay) =>
  childOf(overlay, PolylineCollection);
const bufferRingCount = (overlay: ContextOverlay): number =>
  childOf(overlay, BufferPolylineCollection)?.primitiveCount ?? 0;
const projectedRingCount = (overlay: ContextOverlay): number =>
  projectedOf(overlay)?.length ?? 0;

function bufferRings(overlay: ContextOverlay): Cartesian3[][] {
  const buffer = bufferOf(overlay);
  const line = new BufferPolyline();
  return Array.from({ length: buffer.primitiveCount }, (_, ring) => {
    buffer.get(ring, line);
    const values = (line.toJSON() as { positions: number[] }).positions;
    return Array.from(
      { length: values.length / 3 },
      (_, vertex) =>
        new Cartesian3(
          values[vertex * 3],
          values[vertex * 3 + 1],
          values[vertex * 3 + 2],
        ),
    );
  });
}

function projectedRings(overlay: ContextOverlay): Cartesian3[][] {
  const projected = projectedOf(overlay)!;
  return Array.from(
    { length: projected.length },
    (_, ring) => projected.get(ring).positions,
  );
}

/** Every vertex of every COUNTRIES ring sits `height` metres above the ellipsoid. */
function expectRingsAt(rings: Cartesian3[][], height: number): void {
  const { lonLat, ringOffsets } = COUNTRIES;
  expect(rings).toHaveLength(ringOffsets.length - 1);
  rings.forEach((ring, index) => {
    expect(ring).toHaveLength(ringOffsets[index + 1] - ringOffsets[index]);
    ring.forEach((position, offset) => {
      const vertex = ringOffsets[index] + offset;
      expectNear(
        position,
        Cartesian3.fromDegrees(
          lonLat[vertex * 2],
          lonLat[vertex * 2 + 1],
          height,
        ),
      );
    });
  });
}

function expectLabelsAt(
  added: { position: Cartesian3 }[],
  surfaceHeight: number,
  factor: number,
): void {
  expect(added).toHaveLength(COUNTRIES.labels.length);
  added.forEach(({ position }, index) => {
    const { lat, lon } = COUNTRIES.labels[index];
    expectNear(
      position,
      Cartesian3.fromDegrees(
        lon,
        lat,
        countryLabelHeight(surfaceHeight, factor),
      ),
    );
  });
}

describe('Natural Earth context built across several slices', () => {
  it('releases projected borders that share a material when the scene is torn down', async () => {
    stubCesiumBrowserImageTypes();
    const { overlay, scene, worker } = setup(undefined, { context: COUNTRIES });
    await overlay.load('/borders.bin');
    await overlay.setSceneMode('map');
    const projected = projectedOf(overlay)!;
    expect(projected.length).toBe(3);
    expect(projected.get(2).material).toBe(projected.get(0).material);

    expect(() => scene.primitives.destroy()).not.toThrow();
    expect(overlay.collection.isDestroyed()).toBe(true);

    // Calls that reach a torn-down overlay change nothing and do not throw.
    overlay.setVisible(false);
    overlay.setBorderStyle('#ff0000', 0.25);
    overlay.setSurface(SURFACE, 'post_mean');
    overlay.setElevationFactor(2, true);
    await expect(overlay.setSceneMode('globe')).resolves.toBeUndefined();
    expect(worker.contextHeights).not.toHaveBeenCalled();
  });

  it.each(['borders', 'labels'] as const)(
    'shows projected borders when the view switches to map while the %s are added',
    async (phase) => {
      stubCesiumBrowserImageTypes();
      const { atYield, slice } = slicedLoad();
      const { added, overlay } = setup(undefined, {
        context: COUNTRIES,
        slice,
      });
      atYield(
        phase === 'borders'
          ? () => bufferRingCount(overlay) > 0
          : () => added.length > 0,
        () => void overlay.setSceneMode('map'),
      );

      await expect(overlay.load('/borders.bin')).resolves.toBe('ready');

      expect(projectedOf(overlay)?.length).toBe(3);
      expect(projectedOf(overlay)?.show).toBe(true);
      expect(bufferOf(overlay).show).toBe(false);
      expect(added).toHaveLength(3);
    },
  );

  it('shows the renderer of the last view when two switches overlap', async () => {
    stubCesiumBrowserImageTypes();
    const { atYield, slice } = slicedLoad();
    const { overlay } = setup(undefined, { context: COUNTRIES, slice });
    await overlay.load('/borders.bin');
    let back: Promise<void> | undefined;
    atYield(
      () => projectedRingCount(overlay) > 0,
      () => {
        back = overlay.setSceneMode('globe');
      },
    );

    await overlay.setSceneMode('map');
    await back;

    expect(back).toBeDefined();
    expect(projectedOf(overlay)?.length).toBe(3);
    expect(bufferOf(overlay).show).toBe(true);
    expect(projectedOf(overlay)?.show).toBe(false);
  });

  it('asks for surface heights once the worker has parsed the context', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { added, overlay, worker } = setup(undefined, { context: COUNTRIES });
    overlay.setSurface(SURFACE, 'post_mean');
    overlay.setElevationFactor(2, true);
    expect(worker.contextHeights).not.toHaveBeenCalled();

    await expect(overlay.load('/borders.bin')).resolves.toBe('ready');
    await flushTasks();

    expect(worker.contextHeights).toHaveBeenCalledTimes(1);
    expect(worker.contextHeights).toHaveBeenCalledWith({
      artifactKey: SURFACE,
      metric: 'post_mean',
    });
    expect(console.warn).not.toHaveBeenCalled();
    expectRingsAt(bufferRings(overlay), RAISED);
    expectLabelsAt(added, 500, 2);
  });

  it.each(['globe', 'map'] as const)(
    'raises every %s border and label when surface heights arrive during the load',
    async (mode) => {
      stubCesiumBrowserImageTypes();
      const { atYield, slice } = slicedLoad();
      let release = () => {};
      const arrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { added, overlay } = setup(undefined, {
        context: COUNTRIES,
        heights: async () => {
          await arrived;
          return {
            borderHeights: new Float32Array(9).fill(1_000),
            labelHeights: new Float32Array(3).fill(500),
          };
        },
        slice,
      });
      await overlay.setSceneMode(mode);
      overlay.setSurface(SURFACE, 'post_mean');
      overlay.setElevationFactor(2, true);
      atYield(
        () => bufferRingCount(overlay) + projectedRingCount(overlay) > 0,
        release,
      );

      await expect(overlay.load('/borders.bin')).resolves.toBe('ready');

      expectRingsAt(
        mode === 'globe' ? bufferRings(overlay) : projectedRings(overlay),
        RAISED,
      );
      expectLabelsAt(added, 500, 2);
    },
  );

  it('raises every projected ring when the elevation changes while they are added', async () => {
    stubCesiumBrowserImageTypes();
    const { atYield, slice } = slicedLoad();
    const { overlay } = setup(undefined, { context: COUNTRIES, slice });
    await overlay.load('/borders.bin');
    overlay.setSurface(SURFACE, 'post_mean');
    overlay.setElevationFactor(2, true);
    await flushTasks();
    overlay.setElevationFactor(0, true);
    atYield(
      () => projectedRingCount(overlay) > 0,
      () => overlay.setElevationFactor(2, true),
    );

    await overlay.setSceneMode('map');

    expectRingsAt(projectedRings(overlay), RAISED);
    expectRingsAt(bufferRings(overlay), RAISED);
  });

  it('keeps one height when a throttled elevation change lands while projected rings are added', async () => {
    stubCesiumBrowserImageTypes();
    const { atYield, slice } = slicedLoad();
    const { overlay } = setup(undefined, {
      context: COUNTRIES,
      now: () => 0,
      slice,
    });
    await overlay.load('/borders.bin');
    overlay.setSurface(SURFACE, 'post_mean');
    overlay.setElevationFactor(1, true);
    await flushTasks();
    // Within the 50 ms throttle: recorded, not yet drawn.
    atYield(
      () => projectedRingCount(overlay) > 0,
      () => overlay.setElevationFactor(2),
    );

    await overlay.setSceneMode('map');
    expectRingsAt(projectedRings(overlay), 1_000 + BORDER_CLEARANCE_METRES);

    overlay.setElevationFactor(2, true);
    expectRingsAt(projectedRings(overlay), RAISED);
    expectRingsAt(bufferRings(overlay), RAISED);
  });

  it.each([
    ['an elevation change', true, 2],
    ['a throttled elevation change', false, 1],
  ] as const)(
    'keeps the labels at one height when %s lands while they are added',
    async (_, force, factor) => {
      const { atYield, slice } = slicedLoad();
      const { added, overlay } = setup(undefined, {
        context: COUNTRIES,
        now: () => 0,
        slice,
      });
      overlay.setSurface(SURFACE, 'post_mean');
      overlay.setElevationFactor(1, true);
      // Opens the 50 ms throttle window once the borders are drawn.
      atYield(
        () => bufferRingCount(overlay) > 0,
        () => overlay.setElevationFactor(1, true),
      );
      atYield(
        () => added.length === 1,
        () => overlay.setElevationFactor(2, force),
      );
      let midLoad: Cartesian3[] = [];
      atYield(
        () => added.length === 2,
        () => {
          midLoad = added.map(({ position }) => position);
        },
      );

      await expect(overlay.load('/borders.bin')).resolves.toBe('ready');

      expect(midLoad).toHaveLength(2);
      midLoad.forEach((position, index) => {
        const { lat, lon } = COUNTRIES.labels[index];
        expectNear(
          position,
          Cartesian3.fromDegrees(lon, lat, countryLabelHeight(500, factor)),
        );
      });
      // The load ends by drawing everything at the current elevation.
      expectLabelsAt(added, 500, 2);
      expectRingsAt(bufferRings(overlay), RAISED);
    },
  );

  it('colours every ring with a border style set while the borders are added', async () => {
    const { atYield, slice } = slicedLoad();
    const { overlay } = setup(undefined, { context: COUNTRIES, slice });
    atYield(
      () => bufferRingCount(overlay) > 0,
      () => overlay.setBorderStyle('#ff0000', 0.25),
    );

    await overlay.load('/borders.bin');

    const buffer = bufferOf(overlay);
    const line = new BufferPolyline();
    const material = new BufferPolylineMaterial();
    expect(buffer.primitiveCount).toBe(3);
    for (let ring = 0; ring < buffer.primitiveCount; ring += 1) {
      buffer.get(ring, line);
      line.getMaterial(material);
      expect(material.color.red).toBeCloseTo(1, 2);
      expect(material.color.green).toBeCloseTo(0, 2);
      expect(material.color.alpha).toBeCloseTo(0.25, 2);
      expect(material.width).toBeCloseTo(2.15, 2);
    }
  });

  it('draws projected borders in the chosen style and restyles them', async () => {
    stubCesiumBrowserImageTypes();
    const { overlay } = setup(undefined, { context: COUNTRIES });
    await overlay.load('/borders.bin');
    overlay.setBorderStyle('#00ff00', 0.4);
    await overlay.setSceneMode('map');
    const projected = projectedOf(overlay)!;
    for (let ring = 0; ring < projected.length; ring += 1) {
      const line = projected.get(ring);
      expect(line.width).toBeCloseTo(1.65, 2);
      expect(line.material.uniforms.color.green).toBeCloseTo(1, 2);
      expect(line.material.uniforms.color.alpha).toBeCloseTo(0.4, 2);
    }

    overlay.setBorderStyle('#ff0000', 0.25);
    for (let ring = 0; ring < projected.length; ring += 1) {
      const { color } = projected.get(ring).material.uniforms;
      expect(color.red).toBeCloseTo(1, 2);
      expect(color.green).toBeCloseTo(0, 2);
      expect(color.alpha).toBeCloseTo(0.25, 2);
    }
  });

  it.each(['vertices', 'borders', 'labels'] as const)(
    'stops quietly at the next yield when the scene is torn down while the %s are prepared',
    async (phase) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { atYield, slice } = slicedLoad();
      const { added, overlay, scene } = setup(undefined, {
        context: COUNTRIES,
        slice,
      });
      let rendersAtTeardown = -1;
      atYield(
        {
          borders: () => bufferRingCount(overlay) > 0,
          labels: () => added.length > 0,
          vertices: () => true,
        }[phase],
        () => {
          scene.primitives.destroy();
          rendersAtTeardown = scene.requestRender.mock.calls.length;
        },
      );

      await expect(overlay.load('/borders.bin')).resolves.toBe('fallback');

      // No slice ran on the destroyed scene: a slice ends by requesting a render.
      expect(scene.requestRender).toHaveBeenCalledTimes(rendersAtTeardown);
      expect(console.warn).not.toHaveBeenCalled();
      expect(overlay.isReady()).toBe(false);
    },
  );

  it('stays quiet when the worker stops with a torn-down scene', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { overlay, removeCredit, scene, worker } = setup(undefined, {
      context: COUNTRIES,
    });
    worker.parseContext.mockImplementationOnce(async () => {
      scene.primitives.destroy();
      throw new Error('Atlas data worker terminated');
    });

    await expect(overlay.load('/borders.bin')).resolves.toBe('fallback');

    // The credit display went with the CesiumWidget.
    expect(removeCredit).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(['arrive', 'fail'] as const)(
    'leaves a torn-down scene alone when pending surface heights %s',
    async (outcome) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { overlay, scene, worker } = setup(undefined, {
        context: COUNTRIES,
      });
      await overlay.load('/borders.bin');
      let settle: () => void = () => {};
      worker.contextHeights.mockImplementationOnce(
        () =>
          new Promise<ContextHeights>((resolve, reject) => {
            settle = () =>
              outcome === 'arrive'
                ? resolve({
                    borderHeights: new Float32Array(9).fill(1_000),
                    labelHeights: new Float32Array(3).fill(500),
                  })
                : reject(new Error('Atlas data worker terminated'));
          }),
      );
      overlay.setSurface(SURFACE, 'post_mean');
      overlay.setElevationFactor(2, true);
      expect(worker.contextHeights).toHaveBeenCalledTimes(1);

      scene.primitives.destroy();
      const rendersAtTeardown = scene.requestRender.mock.calls.length;
      settle();
      await flushTasks();

      expect(scene.requestRender).toHaveBeenCalledTimes(rendersAtTeardown);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );
});

describe('compact borders in the post-reveal load order (§B.6.9, §B.10)', () => {
  const ATLAS = new URL('../public/data/atlas/', import.meta.url);

  it('reports each chunk of the GOBD file, then its last byte, before the worker decodes it', async () => {
    // The file the catalog names for the borders, as the explorer resolves it (#445).
    const { context_sources } = JSON.parse(
      readFileSync(fileURLToPath(new URL('catalog.json', ATLAS)), 'utf8'),
    ) as { context_sources: { id: string; url: string }[] };
    const name = context_sources.find(
      (source) => source.id === NATURAL_EARTH_BORDERS,
    )?.url;
    expect(name).toMatch(/\.bin$/);
    const file = new Uint8Array(
      readFileSync(fileURLToPath(new URL(name!, ATLAS))),
    );
    const CHUNK = 64 * 1024;
    const chunks: Uint8Array[] = [];
    for (let start = 0; start < file.length; start += CHUNK)
      chunks.push(file.slice(start, start + CHUNK));
    expect(chunks.length).toBeGreaterThan(1);
    const url = `/data/atlas/${name}`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    // The overlay's own fetch (no fetchBytes), and the decoder the data worker runs on the bytes.
    const { overlay, worker } = setup(null);
    let decoded: ReturnType<typeof decodeNaturalEarth> | undefined;
    let readyAtArrival: boolean | undefined;
    worker.parseContext.mockImplementationOnce(async (...args: unknown[]) => {
      decoded = decodeNaturalEarth(args[0] as ArrayBuffer);
      return parsed;
    });
    const progress = vi.fn();
    const fetched = vi.fn(() => {
      readyAtArrival = overlay.isReady();
    });

    await expect(overlay.load(url, fetched, progress)).resolves.toBe('ready');

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url);
    expect(progress).toHaveBeenCalledTimes(chunks.length);
    expect(fetched).toHaveBeenCalledTimes(1);
    // Arrival is the last byte: after every chunk, before the decode, with nothing drawn yet.
    expect(progress.mock.invocationCallOrder.at(-1)).toBeLessThan(
      fetched.mock.invocationCallOrder[0],
    );
    expect(fetched.mock.invocationCallOrder[0]).toBeLessThan(
      worker.parseContext.mock.invocationCallOrder[0],
    );
    expect(readyAtArrival).toBe(false);
    // The streamed bytes are the file, and they decode as the file does.
    const [bytes] = worker.parseContext.mock.calls[0] as unknown as [
      ArrayBuffer,
    ];
    expect(new Uint8Array(bytes)).toEqual(file);
    const direct = decodeNaturalEarth(file);
    expect(decoded!.ringOffsets).toEqual(direct.ringOffsets);
    expect(decoded!.lonLat).toEqual(direct.lonLat);
    expect(decoded!.labels).toEqual(direct.labels);
    expect(decoded!.labels.length).toBeGreaterThan(200);
  });
});

describe('Natural Earth context on World Terrain', () => {
  it('drapes the borders as atlas-borders at the country opacity, and hides the lines', async () => {
    const { onDrapeFailure, overlay } = setup();
    await overlay.load('borders.bin');
    overlay.setBorderStyle('#ff0000', 0.4);
    const { layers, providers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    expect(providers.map(({ spec }) => spec)).toEqual([
      { color: '#ff0000', layer: 'borders', maximumLevel: 11 },
    ]);
    expect(layers).toMatchObject([
      { alpha: 0.4, name: 'atlas-borders', shown: true },
    ]);
    expect(bufferOf(overlay).show).toBe(false);
    expect(onDrapeFailure).not.toHaveBeenCalled();
  });

  it('clamps every label 2,500 m above the ground while draped, and lets go when undraped', async () => {
    const { added, overlay } = setup();
    await overlay.load('borders.bin');
    await overlay.setDraped(fakeDrapedRuntime().runtime);
    for (const label of added) {
      expect(label.heightReference).toBe(HeightReference.RELATIVE_TO_GROUND);
      expect(
        Ellipsoid.WGS84.cartesianToCartographic(label.position).height,
      ).toBeCloseTo(2_500, 3);
    }
    await overlay.setDraped(null);
    for (const label of added)
      expect(label.heightReference).toBe(HeightReference.NONE);
  });

  it('clamps a real Cesium label to the ground: it is built with the scene', async () => {
    stubLabelFontDom();
    const { overlay } = setup(undefined, { realLabels: true }); // scene.getHeight → 1,000 m
    await overlay.load('borders.bin');
    await overlay.setDraped(fakeDrapedRuntime().runtime);
    const labels = childrenOf(overlay).find(
      (c) => c instanceof LabelCollection,
    ) as LabelCollection;
    const clamped = (
      labels.get(0) as unknown as { _clampedPosition: Cartesian3 }
    )._clampedPosition; // Label.js:1134
    expect(Ellipsoid.WGS84.cartesianToCartographic(clamped).height).toBeCloseTo(
      3_500,
      3,
    );
  });

  it('drapes on load when draped first, and never builds the lines', async () => {
    const { overlay } = setup();
    const { providers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    expect(providers).toHaveLength(0);
    await overlay.load('borders.bin');
    expect(providers).toHaveLength(1);
    expect(
      childrenOf(overlay).some(
        (c) =>
          c instanceof BufferPolylineCollection ||
          c instanceof PolylineCollection,
      ),
    ).toBe(false);
  });

  it('changes the border opacity at once, and swaps in a recoloured layer once it is ready', async () => {
    const { overlay, scene } = setup();
    await overlay.load('borders.bin');
    const { layers, providers, runtime } = fakeDrapedRuntime();
    overlay.setBorderStyle('#ffffff', 0.5);
    await overlay.setDraped(runtime);
    overlay.setBorderStyle('#ffffff', 0.7);
    expect([providers.length, layers[0].alpha]).toEqual([1, 0.7]);
    overlay.setBorderStyle('#00ff00', 0.7);
    await flushTasks();
    expect(providers[1].spec).toMatchObject({
      color: '#00ff00',
      layer: 'borders',
    });
    expect([layers[1].alpha, layers[0].destroy.mock.calls.length]).toEqual([
      0, 0,
    ]);
    layers[1].ready = true;
    scene.postRender.raiseEvent();
    await flushTasks();
    expect([layers[1].alpha, layers[0].destroy.mock.calls.length]).toEqual([
      0.7, 1,
    ]);
  });

  it('drops a recoloured layer still waiting for its tiles when the terrain goes smooth', async () => {
    const { overlay, scene } = setup();
    await overlay.load('borders.bin');
    const { layers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    overlay.setBorderStyle('#00ff00', 0.5);
    await flushTasks();
    expect(layers).toHaveLength(2);
    await overlay.setDraped(null);
    layers[1].ready = true;
    scene.postRender.raiseEvent();
    await flushTasks();
    // Each layer destroyed once, its provider with it, and the waiting one never shown.
    expect(
      layers.map(({ destroy, provider }) => [
        destroy.mock.calls.length,
        provider.destroy.mock.calls.length,
      ]),
    ).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(layers[1].alpha).toBe(0);
  });

  it('drops a recoloured layer retired in the frame it became ready, raising nothing', async () => {
    const { overlay, scene } = setup();
    await overlay.load('borders.bin');
    const { layers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    overlay.setBorderStyle('#00ff00', 0.5);
    await flushTasks();
    expect(layers).toHaveLength(2);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      layers[1].ready = true;
      // A listener after the wait's own, in the same frame: the terrain goes smooth.
      scene.postRender.addEventListener(() => void overlay.setDraped(null));
      scene.postRender.raiseEvent();
      await flushTasks();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(layers.map(({ destroy }) => destroy.mock.calls.length)).toEqual([
      1, 1,
    ]);
    expect(layers[1].alpha).toBe(0);
  });

  it('hides the draped borders with the countries layer, freeing their tiles', async () => {
    const { overlay } = setup();
    await overlay.load('borders.bin');
    const { layers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    overlay.setVisible(false);
    expect(layers[0].shown).toBe(false);
    overlay.setVisible(true);
    expect(layers[0].shown).toBe(true);
  });

  it('keeps the lines hidden across a view switch while draped, and returns to them when undraped', async () => {
    const { overlay } = setup();
    await overlay.load('borders.bin');
    const { layers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    await overlay.setSceneMode('map');
    expect(
      childrenOf(overlay).some(
        (c) => c instanceof PolylineCollection && c.show,
      ),
    ).toBe(false);
    await overlay.setSceneMode('globe');
    await overlay.setDraped(null);
    expect([
      layers[0].destroy.mock.calls.length,
      bufferOf(overlay).show,
    ]).toEqual([1, true]);
  });

  it('drops a border layer still preparing when a newer call supersedes it', async () => {
    const { overlay } = setup();
    await overlay.load('borders.bin');
    const { runtime } = fakeDrapedRuntime();
    const pending = Promise.withResolvers<FakeRasterProvider>();
    vi.mocked(runtime.providerFromSpec).mockReturnValueOnce(
      pending.promise as never,
    );
    const first = overlay.setDraped(runtime);
    await overlay.setDraped(null);
    const provider = fakeRasterProvider();
    pending.resolve(provider);
    await first;
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.addDrapedImageryLayer).not.toHaveBeenCalled();
  });

  it('reports the first failure of the border raster', async () => {
    const failing = setup();
    await failing.overlay.load('borders.bin');
    const broken = fakeDrapedRuntime();
    const error = new Error('raster worker failed');
    vi.mocked(broken.runtime.providerFromSpec).mockRejectedValueOnce(error);
    await failing.overlay.setDraped(broken.runtime);
    expect(failing.onDrapeFailure).toHaveBeenCalledWith(error);

    const { onDrapeFailure, overlay } = setup();
    await overlay.load('borders.bin');
    const { providers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    const tileError = { message: 'tile 3/9/2 failed' };
    providers[0].errorEvent.raiseEvent(tileError);
    providers[0].errorEvent.raiseEvent(tileError);
    expect(onDrapeFailure.mock.calls).toEqual([[tileError]]);
  });

  it('ignores the data elevation while draped', async () => {
    const { added, overlay, worker } = setup();
    await overlay.load('borders.bin');
    await overlay.setDraped(fakeDrapedRuntime().runtime);
    overlay.setSurface('artifact', 'post_mean');
    overlay.setElevationFactor(2, true);
    expect(worker.contextHeights).not.toHaveBeenCalled();
    expect(
      Ellipsoid.WGS84.cartesianToCartographic(added[0].position).height,
    ).toBeCloseTo(2_500, 3);
  });
});

describe('whenLayerReady', () => {
  it('resolves on the first frame the layer is ready, asking for frames', async () => {
    const postRender = new FakeEvent(),
      requestRender = vi.fn();
    let ready = false;
    const done = vi.fn();
    void whenLayerReady(
      { isReady: () => ready },
      { postRender, requestRender },
      new AbortController().signal,
    ).then(done);
    postRender.raiseEvent();
    await flushTasks();
    expect(done).not.toHaveBeenCalled();
    ready = true;
    postRender.raiseEvent();
    await flushTasks();
    expect([done.mock.calls.length, postRender.numberOfListeners]).toEqual([
      1, 0,
    ]);
    expect(requestRender).toHaveBeenCalled();
  });

  it('rejects with an AbortError once aborted', async () => {
    const abort = new AbortController(),
      postRender = new FakeEvent();
    const waiting = whenLayerReady(
      { isReady: () => false },
      { postRender, requestRender: vi.fn() },
      abort.signal,
    );
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(postRender.numberOfListeners).toBe(0);
  });
});
