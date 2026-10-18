import { cellToLatLng, gridDisk } from 'h3-js';
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Primitive,
  PrimitiveCollection,
  type Color,
  type PointPrimitiveCollection,
  type PolylineCollection,
} from 'cesium';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mocked,
} from 'vitest';

import type { ObservationArtifact } from '../src/atlas/contracts';
import { ShiftedPerspectiveFrustum } from '../src/atlas/scene/globe-offset';
import { LayerCache } from '../src/atlas/scene/layer-cache';
import { REVEAL_WAVE_MS } from '../src/atlas/scene/reveal-wave';
import { createRevealWave } from '../src/atlas/scene/reveal-wave-driver';
import { createMarkTracker } from '../src/atlas/scene/scene-marks';
import {
  DEFAULT_LAYERS,
  DEFAULT_OBSERVATIONS,
} from '../src/atlas/scene/scene-policy';
import {
  ScientificLayers,
  type ScientificLayersOptions,
  type ScientificStyle,
} from '../src/atlas/scene/scientific-layers';
import type {
  ArtifactLoad,
  AtlasMark,
  DrapedRuntime,
  ObservationPresentation,
} from '../src/atlas/scene/types';
import { rowForH3, type SurfaceArtifact } from '../src/atlas/surface-columns';
import type {
  BuildChunksBody,
  ChunkMessage,
} from '../src/atlas/worker/protocol';
import type { ObservationPrimitiveGroup } from '../src/atlas/scene/observation-layer';
import type { SurfaceChunkGroup } from '../src/atlas/scene/surface-chunk-layer';
import { chunkMessage } from './helpers/chunk-buffers';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';
import { columnarSurface } from './helpers/columnar-surface';
import {
  fakeDrapedRuntime,
  type FakeDrapedGroup,
} from './helpers/draped-fakes';
import { FakeEvent, flushTasks } from './helpers/scene-fakes';

// Every group the layers build, so a test can read the opacity the swap gives each one. The
// wrappers pass straight through to the real factories.
const built = vi.hoisted(() => ({
  observations: [] as ObservationPrimitiveGroup[],
  surfaces: [] as SurfaceChunkGroup[],
}));
vi.mock('../src/atlas/scene/observation-layer', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/atlas/scene/observation-layer')
    >();
  return {
    ...actual,
    buildObservationLayer: (
      ...args: Parameters<typeof actual.buildObservationLayer>
    ) => {
      const group = actual.buildObservationLayer(...args);
      built.observations.push(group);
      return group;
    },
  };
});
vi.mock('../src/atlas/scene/surface-chunk-layer', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/atlas/scene/surface-chunk-layer')
    >();
  return {
    ...actual,
    createSurfaceChunkGroup: (
      ...args: Parameters<typeof actual.createSurfaceChunkGroup>
    ) => {
      const group = actual.createSurfaceChunkGroup(...args);
      built.surfaces.push(group);
      return group;
    },
  };
});

const CELL = '83754efffffffff';
const [LAT, LON] = cellToLatLng(CELL);
const SURFACE_CLEARANCE_METRES = 650;
const SYMBOL_CLEARANCE_METRES = 7_000;

function keyOf(id: string): string {
  return `${id}:v3:map-2026-08`;
}

function surfaceFor(id: string): SurfaceArtifact {
  return columnarSurface(
    [{ h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' }],
    { id },
  );
}

function observationsFor(): ObservationArtifact {
  return {
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
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function markReady(collection: PrimitiveCollection): void {
  for (let index = 0; index < collection.length; index += 1) {
    const child: unknown = collection.get(index);
    if (child instanceof PrimitiveCollection) markReady(child);
    else if (child instanceof Primitive)
      (child as unknown as { _ready: boolean })._ready = true;
  }
}

function harness(
  overrides: Partial<ScientificStyle> = {},
  camera: Record<string, unknown> = {},
  layerOptions: Partial<ScientificLayersOptions> = {},
) {
  stubCesiumBrowserImageTypes();
  const preUpdate = new FakeEvent();
  const preRender = new FakeEvent();
  const postRender = new FakeEvent();
  const primitives = new PrimitiveCollection();
  const scene = {
    camera: {
      pickEllipsoid: () => undefined,
      positionCartographic: Cartographic.fromDegrees(20, 12, 16_500_000),
      ...camera,
    },
    canvas: { clientHeight: 600, clientWidth: 800 },
    globe: { tilesLoaded: true },
    imageryLayers: {},
    postRender,
    preRender,
    preUpdate,
    primitives,
    requestRender: vi.fn(),
  };
  const attributes = new Map<string, string>();
  // The scene's real driver on a test clock: each `frame()` advances the wave like a render.
  const clock = { now: 0 };
  const wave = createRevealWave({
    measure: vi.fn(),
    now: () => clock.now,
    scene,
    target: { setAttribute: (name, value) => attributes.set(name, value) },
    view: () => ({ eye: 3, origin: [0, 0, 1], reach: 1 }),
    visibility: { isHidden: () => false, onChange: () => () => {} },
  });
  const realWaveStart = wave.start;
  const waveStarts = vi.spyOn(wave, 'start');
  const displayedHistory: string[] = [];
  const marks = createMarkTracker(
    scene,
    {
      setAttribute: (name, value) => {
        attributes.set(name, value);
        if (name === 'data-atlas-displayed') displayedHistory.push(value);
      },
    },
    { mark: vi.fn() },
  );
  const emitted: AtlasMark[] = [];
  marks.onMark((mark) => emitted.push(mark));
  const commits: string[] = [];
  const requests: BuildChunksBody[] = [];
  const highlight = {
    collection: new PrimitiveCollection(),
    setArtifacts: vi.fn(),
  };
  primitives.add(highlight.collection);
  const style: ScientificStyle = {
    cellEdges: false,
    earthOpacity: 1,
    edgeColorMode: 'matched',
    edgeFixedColor: '#b9f5ff',
    elevationFactor: 0,
    geometry: 'triangles',
    layers: { ...DEFAULT_LAYERS },
    metric: 'post_mean',
    mode: 'globe',
    observationStyle: { ...DEFAULT_OBSERVATIONS, shape: 'circle' },
    palette: 'rainbow',
    reducedMotion: true,
    surfaceOpacity: 0.58,
    ...overrides,
  };
  const stream = async (
    request: BuildChunksBody,
    onChunk: (message: ChunkMessage) => void,
    signal?: AbortSignal,
  ) => {
    requests.push(request);
    for (const chunk of [0, 1]) {
      await flushTasks();
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      onChunk(
        chunkMessage(request.artifactKey, chunk, {
          anchors:
            chunk === 0 && request.observationPoints
              ? {
                  // Metric-dependent, so a test can tell which metric's heights the markers use.
                  heights: Float64Array.of(
                    request.metric === 'post_sd' ? 3_000 : 1_000,
                  ),
                  triangles: new Float64Array(9).fill(Number.NaN),
                }
              : null,
          total: 2,
        }),
      );
    }
  };
  // The real AtlasWorkerClient.recolour has the worker rebuild each chunk from its cached
  // topology, chunk plan and vertex means, and sends no anchors (Task 52 (B3.13)); the fake
  // matches it, so recolour tests see what production sees.
  const recolourStream = (
    request: BuildChunksBody,
    onChunk: (message: ChunkMessage) => void,
    signal?: AbortSignal,
  ) => stream({ ...request, observationPoints: null }, onChunk, signal);
  const worker = {
    buildChunks: vi.fn(stream),
    buildEdges: vi.fn(async () => {}),
    recolour: vi.fn(recolourStream),
  };
  const layers = new ScientificLayers({
    frameBudgetMs: 8,
    highlight,
    marks,
    onCommit: (key) => commits.push(key),
    perf: { mark: vi.fn() },
    scene: scene as never,
    style: () => style,
    wave,
    worker: worker as never,
    ...layerOptions,
  });
  const frame = () => {
    preUpdate.raiseEvent();
    markReady(primitives);
    postRender.raiseEvent();
  };
  /** Frames until the wave has passed the horizon (one frame moves it a quarter at most). */
  const finishWave = () => {
    for (let index = 0; index < 6; index += 1) {
      clock.now += REVEAL_WAVE_MS / 4;
      frame();
    }
  };
  const pump = async (frames = 12) => {
    for (let index = 0; index < frames; index += 1) {
      await flushTasks();
      frame();
    }
  };
  const load = (
    id: string,
    surface: Promise<SurfaceArtifact> = Promise.resolve(surfaceFor(id)),
  ): ArtifactLoad => ({
    artifactId: id,
    artifactKey: keyOf(id),
    observations: Promise.resolve(observationsFor()),
    surface,
  });
  const show = async (id: string) => {
    const done = layers.setArtifact(load(id));
    await pump();
    await done;
    await pump(1);
  };
  const childCollections = () =>
    Array.from(
      { length: primitives.length },
      (_, index) => primitives.get(index) as PrimitiveCollection,
    );
  return {
    attributes,
    childCollections,
    clock,
    commits,
    displayedHistory,
    emitted,
    finishWave,
    frame,
    highlight,
    layers,
    load,
    primitives,
    pump,
    realWaveStart,
    requests,
    scene,
    show,
    style,
    wave,
    waveStarts,
    worker,
  };
}

type Harness = ReturnType<typeof harness>;

/** Runs each animation frame a second later, so an animated swap ends on its first frame. */
function runAnimationFramesAtOnce(): void {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(performance.now() + 1_000));
    return 0;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  built.observations.length = 0;
  built.surfaces.length = 0;
});

describe('cold progressive reveal', () => {
  it('shows observations first, then chunks with their masks, and commits once complete', async () => {
    const h = harness();
    const surface = deferred<SurfaceArtifact>();
    const done = h.layers.setArtifact(h.load('hbs-rs334', surface.promise));

    await flushTasks();
    h.frame();
    expect(h.emitted).toEqual(['observations-visible']);
    expect(h.attributes.get('data-atlas-displayed')).toBe('hbs-rs334');
    expect(h.commits).toEqual([]);

    surface.resolve(surfaceFor('hbs-rs334'));
    await h.pump();
    await done;
    await h.pump(1);

    expect(h.commits).toEqual([keyOf('hbs-rs334')]);
    expect(h.emitted).toEqual([
      'observations-visible',
      'surface-first-chunk',
      'surface-visible',
      'ready',
    ]);
    expect(h.attributes.get('data-atlas-surface-visible')).toBe('true');
    expect(JSON.parse(h.attributes.get('data-atlas-reveal')!)).toMatchObject({
      frames: expect.any(Number),
      longestFrameMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(h.layers.displayedLayer()).toEqual({
      artifactKey: keyOf('hbs-rs334'),
      geometry: 'triangles',
      metric: 'post_mean',
      palette: 'rainbow',
    });
    expect(h.requests[0].observationPoints).toEqual(Float64Array.of(LON, LAT));
    expect(h.requests[0].lookAt.lat).toBeCloseTo(12);
    expect(h.requests[0].lookAt.lon).toBeCloseTo(20);
    expect(h.highlight.setArtifacts).toHaveBeenCalledTimes(1);
  });

  it('orders the reveal from the centre of the open area beside the controls panel (#452)', async () => {
    // A projection shifted by half the 800 px canvas's half-width draws the view axis at x = 600.
    const frustum = new ShiftedPerspectiveFrustum({
      aspectRatio: 800 / 600,
      fov: 1,
    });
    frustum.projectionShift = 0.5;
    const pickEllipsoid = vi.fn(() => Cartesian3.fromDegrees(31, 4));
    const h = harness({}, { frustum, pickEllipsoid });
    await h.show('hbs-rs334');
    expect(pickEllipsoid).toHaveBeenCalledWith(
      new Cartesian2(600, 300),
      Ellipsoid.WGS84,
    );
    expect(h.requests[0].lookAt.lon).toBeCloseTo(31);
    expect(h.requests[0].lookAt.lat).toBeCloseTo(4);
  });

  it('applies worker anchors before the first chunk is added at elevation', async () => {
    const h = harness({ elevationFactor: 2 });
    const done = h.layers.setArtifact(h.load('hbs-rs334'));
    let checked = false;
    for (let index = 0; index < 12 && !checked; index += 1) {
      await flushTasks();
      h.frame();
      const chunkGroup = h
        .childCollections()
        .find((child) => child.length === 3);
      const observations = h
        .childCollections()
        .find((child) => child.length === 5);
      if (chunkGroup && (chunkGroup.get(0) as PrimitiveCollection).length > 0) {
        const points = observations!.get(2) as PointPrimitiveCollection;
        expect(
          Ellipsoid.WGS84.cartesianToCartographic(points.get(0).position)
            .height,
        ).toBeCloseTo(
          SURFACE_CLEARANCE_METRES + 1_000 * 2 + SYMBOL_CLEARANCE_METRES,
          3,
        );
        checked = true;
      }
    }
    await h.pump();
    await done;
    expect(checked).toBe(true);
  });

  it('leaves the sampling rings where the first chunk placed them at the cold commit (#443)', async () => {
    // Re-placing every ring at the commit rewrote the ring buffer one ring at a time and, on
    // ANGLE Metal, held the GPU and every frame for ~0.6 s right after the reveal.
    const h = harness({ elevationFactor: 2 });
    const done = h.layers.setArtifact(h.load('hbs-rs334'));
    let placed: unknown = null;
    for (let index = 0; index < 12 && placed === null; index += 1) {
      await flushTasks();
      h.frame();
      const chunkGroup = h
        .childCollections()
        .find((child) => child.length === 3);
      if (chunkGroup && (chunkGroup.get(0) as PrimitiveCollection).length > 0)
        placed = (
          built.observations[0].collection.get(0) as PolylineCollection
        ).get(0).positions;
    }
    expect(placed).not.toBeNull();
    await h.pump();
    await done;
    await h.pump(1);
    expect(h.commits).toEqual([keyOf('hbs-rs334')]);
    expect(
      (built.observations[0].collection.get(0) as PolylineCollection).get(0)
        .positions,
    ).toBe(placed);
  });

  it('raises chunks during a cold reveal of an artifact without observations', async () => {
    // No markers means no anchors to wait for (§B.6.8): the group is raised before its first
    // chunk is added, and an elevation change during the reveal applies, instead of the surface
    // lying flat until the commit.
    const h = harness({ elevationFactor: 2 });
    const done = h.layers.setArtifact({
      ...h.load('hbs-rs334'),
      observations: Promise.resolve(null),
    });
    let checked = false;
    for (let index = 0; index < 12 && !checked; index += 1) {
      await flushTasks();
      h.frame();
      const chunkGroup = h
        .childCollections()
        .find((child) => child.length === 3);
      const surfaces = chunkGroup?.get(0) as PrimitiveCollection | undefined;
      if (surfaces && surfaces.length > 0 && h.commits.length === 0) {
        const factor = () =>
          (
            (surfaces.get(0) as Primitive).appearance as unknown as {
              uniforms: { u_elevationFactor: number };
            }
          ).uniforms.u_elevationFactor;
        expect(factor()).toBe(2);
        h.style.elevationFactor = 3;
        h.layers.setElevationFactor(3, true);
        expect(factor()).toBe(3);
        checked = true;
      }
    }
    await h.pump();
    await done;
    expect(checked).toBe(true);
  });

  it('renders nothing when the render tier fails during a cold load', async () => {
    const h = harness();
    const failing = deferred<SurfaceArtifact>();
    const outcome = h.layers
      .setArtifact(h.load('hbs-rs334', failing.promise))
      .catch((error: Error) => error);
    await flushTasks();
    h.frame();
    expect(h.attributes.get('data-atlas-displayed')).toBe('hbs-rs334');

    failing.reject(new Error('render tier failed its checksum'));
    await expect(outcome).resolves.toMatchObject({
      message: 'render tier failed its checksum',
    });
    h.frame();
    expect(h.attributes.get('data-atlas-displayed')).toBe('');
    expect(h.commits).toEqual([]);
  });

  it('stops picking a cold reveal once a newer request supersedes it', async () => {
    const h = harness();
    const first = h.layers.setArtifact(h.load('hbs-rs334'));
    for (let index = 0; index < 12 && !h.layers.pickTarget(); index += 1) {
      await flushTasks();
      h.frame();
    }
    expect(h.layers.pickTarget()).toMatchObject({
      artifactKey: keyOf('hbs-rs334'),
    });

    const observations = deferred<ObservationArtifact | null>();
    const surface = deferred<SurfaceArtifact>();
    const second = h.layers.setArtifact({
      ...h.load('g6pd-deficiency', surface.promise),
      observations: observations.promise,
    });
    await h.pump();
    await first;
    // The superseded reveal is gone and the newer request has no surface yet.
    expect(h.layers.pickTarget()).toBeNull();

    observations.resolve(null);
    surface.resolve(surfaceFor('g6pd-deficiency'));
    await h.pump();
    await second;
    expect(h.layers.pickTarget()).toMatchObject({
      artifactKey: keyOf('g6pd-deficiency'),
    });
  });
});

describe('pick target under World Terrain (#483)', () => {
  it('draws supported rows with the surface layer and masked rows with the support layer', async () => {
    const h = harness();
    const [masked] = gridDisk(CELL, 1).filter((cell) => cell !== CELL);
    const surface = columnarSurface(
      [
        { h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' },
        { h3: masked, post_mean: 0.5, post_sd: 0.1, support: 'unknown' },
      ],
      { id: 'hbs-rs334' },
    );
    const done = h.layers.setArtifact(
      h.load('hbs-rs334', Promise.resolve(surface)),
    );
    await h.pump();
    await done;
    const target = h.layers.pickTarget()!;
    const drawn = () =>
      [CELL, masked].map((cell) => target.drawn(rowForH3(surface, cell)!));
    expect(target.draped).toBe(false);
    expect(drawn()).toEqual([true, true]);
    h.style.layers = { ...DEFAULT_LAYERS, support: false };
    expect(drawn()).toEqual([true, false]);
    h.style.layers = { ...DEFAULT_LAYERS, surface: false };
    expect(drawn()).toEqual([false, true]);
  });

  it('draws nothing while the displayed group is faded out or hidden', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    const target = h.layers.pickTarget()!;
    const group = built.surfaces.at(-1)!;
    group.setOpacity(0);
    expect(target.drawn(0)).toBe(false);
    group.setOpacity(1);
    group.collection.show = false;
    expect(target.drawn(0)).toBe(false);
  });
});

describe('atomic replacement', () => {
  it('builds a replacement hidden and swaps it in with one commit', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    const pending = deferred<SurfaceArtifact>();
    const second = h.layers.setArtifact(
      h.load('g6pd-deficiency', pending.promise),
    );

    await h.pump(3);
    expect(h.attributes.get('data-atlas-displayed')).toBe('hbs-rs334');
    pending.resolve(surfaceFor('g6pd-deficiency'));
    await flushTasks();
    h.frame();
    expect(h.attributes.get('data-atlas-displayed')).toBe('hbs-rs334');
    expect(h.layers.pickTarget()).toMatchObject({
      artifactKey: keyOf('hbs-rs334'),
    });
    // The incoming surface and observation groups (fix round 1, finding 1).
    expect(h.layers.pickTarget()!.hidden).toHaveLength(2);
    expect(h.commits).toEqual([keyOf('hbs-rs334')]);

    await h.pump();
    await second;
    await h.pump(1);
    expect(h.commits).toEqual([keyOf('hbs-rs334'), keyOf('g6pd-deficiency')]);
    expect(h.attributes.get('data-atlas-displayed')).toBe('g6pd-deficiency');
    expect(h.layers.displayedLayer()?.artifactKey).toBe(
      keyOf('g6pd-deficiency'),
    );
  });

  it('keeps the incoming observation group out of depth picks until the swap commits', async () => {
    // Translucent depth picks write depth whatever the alpha, so the opacity-0 incoming markers
    // and sampling-area rings would otherwise set the depth (§B.6.6).
    const h = harness();
    await h.show('hbs-rs334');
    const displayed = h.childCollections().find((child) => child.length === 5);
    const pending = deferred<SurfaceArtifact>();
    const second = h.layers.setArtifact(
      h.load('g6pd-deficiency', pending.promise),
    );
    await h.pump(3);
    const incoming = h
      .childCollections()
      .find((child) => child.length === 5 && child !== displayed);
    expect(incoming).toBeDefined();
    expect(h.layers.pickTarget()!.hidden).toEqual([incoming]);

    pending.resolve(surfaceFor('g6pd-deficiency'));
    await flushTasks();
    h.frame();
    expect(h.layers.pickTarget()!.hidden).toContain(incoming);
    expect(h.layers.pickTarget()!.hidden).not.toContain(displayed);

    await h.pump();
    await second;
    expect(h.layers.pickTarget()).toMatchObject({
      artifactKey: keyOf('g6pd-deficiency'),
      hidden: [],
    });
  });

  it('rebuilds a pending replacement, not the displayed artifact, on a style change', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    const pending = deferred<SurfaceArtifact>();
    const second = h.layers.setArtifact(
      h.load('g6pd-deficiency', pending.promise),
    );
    await h.pump(2);

    h.style.metric = 'post_sd';
    const rebuilt = h.layers.rebuild();
    pending.resolve(surfaceFor('g6pd-deficiency'));
    await h.pump();
    await Promise.all([second, rebuilt]);
    await h.pump(1);
    expect(h.commits).toEqual([keyOf('hbs-rs334'), keyOf('g6pd-deficiency')]);
    expect(h.layers.displayedLayer()).toMatchObject({
      artifactKey: keyOf('g6pd-deficiency'),
      metric: 'post_sd',
    });
    expect(h.attributes.get('data-atlas-displayed')).toBe('g6pd-deficiency');
  });

  it('rebuilds the displayed artifact once its replacement has failed', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    const failing = deferred<SurfaceArtifact>();
    const outcome = h.layers
      .setArtifact(h.load('g6pd-deficiency', failing.promise))
      .catch((error: Error) => error);
    failing.reject(new Error('render tier failed its checksum'));
    await expect(outcome).resolves.toMatchObject({
      message: 'render tier failed its checksum',
    });

    h.style.metric = 'post_sd';
    const rebuilt = h.layers.rebuild();
    await h.pump();
    await rebuilt;
    expect(h.commits).toEqual([keyOf('hbs-rs334'), keyOf('hbs-rs334')]);
    expect(h.layers.displayedLayer()).toMatchObject({
      artifactKey: keyOf('hbs-rs334'),
      metric: 'post_sd',
    });
  });

  it('restyles the incoming measured points during a replacement', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    const displayed = h.childCollections().find((child) => child.length === 5)!;
    const displayedAlpha = (displayed.get(2) as PointPrimitiveCollection).get(0)
      .color.alpha;
    const pending = deferred<SurfaceArtifact>();
    const second = h.layers.setArtifact(
      h.load('g6pd-deficiency', pending.promise),
    );
    await h.pump(2);
    const incoming = h
      .childCollections()
      .find((child) => child.length === 5 && child !== displayed)!;
    const points = incoming.get(2) as PointPrimitiveCollection;
    const rings = incoming.get(0) as PolylineCollection;

    const observationStyle: ObservationPresentation = {
      ...h.style.observationStyle,
      opacity: 0.5,
      samplingAreaColor: '#ff0000',
      sizeRange: [40, 40],
    };
    h.style.observationStyle = observationStyle;
    h.layers.setObservationAppearance(observationStyle, h.style.layers);
    h.style.earthOpacity = 0.5;
    h.layers.setEarthOpacity(0.5);
    expect(points.get(0).pixelSize).toBe(40);

    pending.resolve(surfaceFor('g6pd-deficiency'));
    await h.pump();
    await second;
    expect(h.layers.displayedLayer()?.artifactKey).toBe(
      keyOf('g6pd-deficiency'),
    );
    expect(points.get(0).color.alpha).toBeCloseTo(displayedAlpha * 0.25, 6);
    const ringColor = rings.get(0).material.uniforms.color as Color;
    expect(ringColor.red).toBe(1);
    expect(ringColor.green).toBe(0);
    expect(ringColor.alpha).toBeCloseTo(0.9 * 0.25, 6);
  });

  it('applies the observation style current at the commit to the incoming group', async () => {
    // As the commit does for the surface's opacity, visibility, outlines and mode.
    const h = harness();
    await h.show('hbs-rs334');
    const displayed = h.childCollections().find((child) => child.length === 5)!;
    const displayedAlpha = (displayed.get(2) as PointPrimitiveCollection).get(0)
      .color.alpha;
    const pending = deferred<SurfaceArtifact>();
    const second = h.layers.setArtifact(
      h.load('g6pd-deficiency', pending.promise),
    );
    await h.pump(2);
    const incoming = h
      .childCollections()
      .find((child) => child.length === 5 && child !== displayed)!;
    const points = incoming.get(2) as PointPrimitiveCollection;
    const rings = incoming.get(0) as PolylineCollection;

    h.style.observationStyle = {
      ...h.style.observationStyle,
      opacity: 0.5,
      samplingAreaColor: '#ff0000',
      sizeRange: [40, 40],
    };
    h.style.earthOpacity = 0.5;
    pending.resolve(surfaceFor('g6pd-deficiency'));
    await h.pump();
    await second;
    expect(points.get(0).pixelSize).toBe(40);
    expect(points.get(0).color.alpha).toBeCloseTo(displayedAlpha * 0.25, 6);
    const ringColor = rings.get(0).material.uniforms.color as Color;
    expect(ringColor.red).toBe(1);
    expect(ringColor.alpha).toBeCloseTo(0.9 * 0.25, 6);
  });

  it('settles a cold request that a restyle of the same artifact superseded with the restyle’s failure', async () => {
    // AtlasExplorer restyles a cold load with `void scene.setMetric(…)`, whose rebuild replays the
    // pipeline's pending request. The pipeline awaits the original call: it must not resolve (and
    // mark the map ready) while the rebuild alone carries the outcome (final review correctness-1).
    const h = harness();
    const observations = deferred<ObservationArtifact>();
    const surface = deferred<SurfaceArtifact>();
    const original = h.layers.setArtifact({
      artifactId: 'hbs-rs334',
      artifactKey: keyOf('hbs-rs334'),
      observations: observations.promise,
      surface: surface.promise,
    });
    await flushTasks();
    h.style.metric = 'post_sd';
    const rebuilt = h.layers.rebuild();
    const outcomeOf = (promise: Promise<void>) =>
      promise.then(
        () => 'resolved',
        (error: Error) => `rejected: ${error.message}`,
      );
    const originalOutcome = outcomeOf(original);
    const rebuiltOutcome = outcomeOf(rebuilt);
    surface.reject(new Error('Atlas request failed with HTTP 503: render'));
    observations.resolve(observationsFor());
    await h.pump();
    const failure = 'rejected: Atlas request failed with HTTP 503: render';
    expect(await rebuiltOutcome).toBe(failure);
    expect(await originalOutcome).toBe(failure);
    expect(h.commits).toEqual([]);
    expect(h.layers.displayedLayer()).toBeNull();
  });

  it('settles a cold request that a restyle of the same artifact superseded only when the restyle commits', async () => {
    const h = harness();
    const surface = deferred<SurfaceArtifact>();
    const original = h.layers.setArtifact(h.load('hbs-rs334', surface.promise));
    let commitsWhenSettled: number | null = null;
    void original.then(() => {
      commitsWhenSettled = h.commits.length;
    });
    await flushTasks();
    h.style.metric = 'post_sd';
    const rebuilt = h.layers.rebuild();
    await h.pump(4);
    expect(commitsWhenSettled).toBeNull();

    surface.resolve(surfaceFor('hbs-rs334'));
    await h.pump();
    await rebuilt;
    await original;
    // Not when it noticed it was superseded (the surface arrived), but when the rebuild committed.
    expect(commitsWhenSettled).toBe(1);
    expect(h.commits).toEqual([keyOf('hbs-rs334')]);
    expect(h.layers.displayedLayer()?.metric).toBe('post_sd');
  });

  it('commits only the latest request when one is superseded', async () => {
    const h = harness();
    const slow = deferred<SurfaceArtifact>();
    const first = h.layers.setArtifact(h.load('hbs-rs334', slow.promise));
    const second = h.layers.setArtifact(h.load('g6pd-deficiency'));
    slow.resolve(surfaceFor('hbs-rs334'));

    await h.pump();
    await Promise.all([first, second]);
    await h.pump(1);
    expect(h.commits).toEqual([keyOf('g6pd-deficiency')]);
    expect(h.attributes.get('data-atlas-displayed')).toBe('g6pd-deficiency');
  });

  it('marks ready only for the request that is still current when its swap ends', async () => {
    // A request made during another's swap animation begins a new epoch; the older request's
    // `ready` must not land in it (ledger Task 58 ruling; spec §B.1 `atlas:ready`). Since #453 a
    // dataset switch commits at once and grows by the reveal wave, so the animated swap here is
    // a restyle (a palette change) of the displayed artifact.
    const h = harness({ reducedMotion: false });
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      animationFrames.push(callback),
    );
    const readyCount = () =>
      h.emitted.filter((mark) => mark === 'ready').length;
    await h.show('hbs-rs334');
    expect(readyCount()).toBe(1);

    h.style.palette = 'viridis';
    const second = h.layers.rebuild();
    for (let index = 0; index < 4 && animationFrames.length === 0; index += 1)
      await h.pump();
    expect(h.commits).toEqual([keyOf('hbs-rs334'), keyOf('hbs-rs334')]);
    expect(animationFrames).not.toHaveLength(0);
    const pending = deferred<SurfaceArtifact>();
    const third = h.layers.setArtifact(h.load('kir-3ds1', pending.promise));
    while (animationFrames.length > 0)
      animationFrames.shift()!(performance.now() + 1_000);
    await second;
    await h.pump(2);
    expect(readyCount()).toBe(1);

    pending.resolve(surfaceFor('kir-3ds1'));
    for (let index = 0; index < 4 && h.commits.length < 3; index += 1)
      await h.pump();
    await third;
    await h.pump(1);
    expect(h.commits.at(-1)).toBe(keyOf('kir-3ds1'));
    expect(animationFrames).toHaveLength(0);
    expect(readyCount()).toBe(2);
  });

  it('fades the incoming surface and observations together against the outgoing pair (animated swap)', async () => {
    // Spec §B.6.8: every restyle is one atomic swap. With motion on, each frame of the 300 ms
    // fade gives the incoming surface and its observations the same opacity p and the outgoing
    // pair 1 - p; reduced motion would hide a non-atomic swap (both jump to 1 at once). A
    // palette and marker-shape change replaces both groups of the displayed artifact (a dataset
    // switch commits at once since #453).
    const h = harness({ reducedMotion: false });
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      animationFrames.push(callback),
    );
    await h.show('hbs-rs334');
    expect(built.surfaces).toHaveLength(1);
    expect(built.observations).toHaveLength(1);
    const [surfaceOut] = built.surfaces;
    const [pointsOut] = built.observations;

    h.style.palette = 'viridis';
    h.style.observationStyle = { ...h.style.observationStyle, shape: 'pin' };
    const swap = h.layers.rebuild();
    for (let index = 0; index < 4 && animationFrames.length === 0; index += 1)
      await h.pump();
    expect(animationFrames).not.toHaveLength(0);
    const surfaceIn = built.surfaces.at(-1)!;
    const pointsIn = built.observations.at(-1)!;
    expect([surfaceIn, pointsIn]).not.toContain(surfaceOut);
    expect(pointsIn).not.toBe(pointsOut);
    // Built hidden: nothing of the replacement shows before the fade starts.
    expect([surfaceIn.opacity(), pointsIn.opacity()]).toEqual([0, 0]);

    animationFrames.shift()!(performance.now() + 150);
    const progress = surfaceIn.opacity();
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
    expect(pointsIn.opacity()).toBe(progress);
    expect(surfaceOut.opacity()).toBeCloseTo(1 - progress, 12);
    expect(pointsOut.opacity()).toBeCloseTo(1 - progress, 12);

    while (animationFrames.length > 0)
      animationFrames.shift()!(performance.now() + 1_000);
    await swap;
    expect([surfaceIn.opacity(), pointsIn.opacity()]).toEqual([1, 1]);
    expect([surfaceOut.opacity(), pointsOut.opacity()]).toEqual([0, 0]);
    expect(h.commits.at(-1)).toBe(keyOf('hbs-rs334'));
    // A restyle runs no wave: only the cold reveal did.
    expect(h.waveStarts).toHaveBeenCalledTimes(1);
  });

  it('recolours a palette change in the worker and reuses cached groups', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    h.style.palette = 'viridis';
    const recoloured = h.layers.rebuild();
    await h.pump();
    await recoloured;
    expect(h.worker.recolour).toHaveBeenCalledTimes(1);
    expect(h.worker.buildChunks).toHaveBeenCalledTimes(1);

    h.style.palette = 'rainbow';
    const back = h.layers.rebuild();
    await h.pump();
    await back;
    expect(h.worker.buildChunks).toHaveBeenCalledTimes(1);
    expect(h.worker.recolour).toHaveBeenCalledTimes(1);
    expect(h.commits).toHaveLength(3);
  });

  it('keeps measured points raised through a palette-only recolour at elevation', async () => {
    const h = harness({ elevationFactor: 2 });
    const pointHeight = () => {
      const observations = h
        .childCollections()
        .find((child) => child.length === 5)!;
      const points = observations.get(2) as PointPrimitiveCollection;
      return Ellipsoid.WGS84.cartesianToCartographic(points.get(0).position)
        .height;
    };
    const raised = (anchor: number) =>
      SURFACE_CLEARANCE_METRES + anchor * 2 + SYMBOL_CLEARANCE_METRES;
    const rebuild = async () => {
      const done = h.layers.rebuild();
      await h.pump();
      await done;
      await h.pump(1);
    };
    await h.show('hbs-rs334');
    expect(pointHeight()).toBeCloseTo(raised(1_000), 3);

    // Palette only: the worker recolours (no anchors), the markers keep their heights.
    h.style.palette = 'viridis';
    await rebuild();
    expect(h.worker.recolour).toHaveBeenCalledTimes(1);
    expect(pointHeight()).toBeCloseTo(raised(1_000), 3);
    expect(pointHeight()).toBeGreaterThan(
      SURFACE_CLEARANCE_METRES + SYMBOL_CLEARANCE_METRES,
    );

    // Another metric builds with its own anchors.
    h.style.metric = 'post_sd';
    await rebuild();
    expect(h.worker.buildChunks).toHaveBeenCalledTimes(2);
    expect(pointHeight()).toBeCloseTo(raised(3_000), 3);

    // Back to post_mean with the recoloured palette: a cache hit on the recoloured group, whose
    // copied heights are post_mean's, not the other metric's.
    h.style.metric = 'post_mean';
    await rebuild();
    expect(h.worker.buildChunks).toHaveBeenCalledTimes(2);
    expect(pointHeight()).toBeCloseTo(raised(1_000), 3);
  });
});

describe('reveal wave triggers (#453)', () => {
  function surfaceChunkCount(): number {
    return built.surfaces.reduce(
      (total, group) => total + group.chunkCount(),
      0,
    );
  }

  it('starts the wave as the first chunk of a cold reveal is added, not before', async () => {
    const h = harness({ reducedMotion: false });
    const chunksAtStart: number[] = [];
    h.waveStarts.mockImplementation((reducedMotion) => {
      chunksAtStart.push(surfaceChunkCount());
      h.realWaveStart(reducedMotion);
    });
    const surface = deferred<SurfaceArtifact>();
    const done = h.layers.setArtifact(h.load('hbs-rs334', surface.promise));
    await flushTasks();
    h.frame();
    // The observations show first; the surface has not begun.
    expect(h.emitted).toEqual(['observations-visible']);
    expect(h.waveStarts).not.toHaveBeenCalled();
    expect(h.attributes.get('data-atlas-wave')).toBe('pending');

    surface.resolve(surfaceFor('hbs-rs334'));
    await h.pump();
    await done;
    await h.pump(1);

    expect(chunksAtStart).toEqual([1]);
    expect(h.waveStarts).toHaveBeenCalledWith(false);
    expect(h.wave.running()).toBe(true);
    expect(h.attributes.get('data-atlas-wave')).toBe('running');
    // Load milestones keep their meaning: the wave delays none of them.
    expect(h.emitted).toEqual([
      'observations-visible',
      'surface-first-chunk',
      'surface-visible',
      'ready',
    ]);
    h.finishWave();
    expect(h.wave.running()).toBe(false);
    expect(h.attributes.get('data-atlas-wave')).toBe('done');
  });

  it('reads done when a cold reveal ends with no chunk to grow', async () => {
    // A surface with no supported cells streams no chunk, so no wave starts; a test or the
    // harness waiting for `done` must not wait for ever.
    const h = harness({ reducedMotion: false });
    h.worker.buildChunks.mockImplementation(async (request) => {
      h.requests.push(request);
    });
    await h.show('hbs-rs334');

    expect(surfaceChunkCount()).toBe(0);
    expect(h.waveStarts).not.toHaveBeenCalled();
    expect(h.wave.running()).toBe(false);
    expect(h.attributes.get('data-atlas-wave')).toBe('done');
  });

  it('shows the surface at once under reduced motion', async () => {
    const h = harness({ reducedMotion: true });
    await h.show('hbs-rs334');
    expect(h.waveStarts).toHaveBeenCalledTimes(1);
    expect(h.waveStarts).toHaveBeenCalledWith(true);
    expect(h.wave.running()).toBe(false);
    expect(h.attributes.get('data-atlas-wave')).toBe('done');
  });

  it('retires the old dataset at the commit and grows the new one from the centre', async () => {
    const h = harness({ reducedMotion: false });
    await h.show('hbs-rs334');
    h.finishWave();
    const [surfaceOut] = built.surfaces;
    const [pointsOut] = built.observations;
    const atStart: unknown[] = [];
    h.waveStarts.mockImplementation((reducedMotion) => {
      const surfaceIn = built.surfaces.at(-1)!;
      const pointsIn = built.observations.at(-1)!;
      atStart.push({
        commits: [...h.commits],
        incoming: [surfaceIn.opacity(), pointsIn.opacity()],
        outgoing: [surfaceOut.opacity(), pointsOut.opacity()],
        outgoingShown: [surfaceOut.collection.show, pointsOut.collection.show],
      });
      h.realWaveStart(reducedMotion);
    });
    h.displayedHistory.length = 0;

    // No animation frame is needed: a switch does not cross-fade.
    const swap = h.layers.setArtifact(h.load('g6pd-deficiency'));
    await h.pump();
    await swap;
    await h.pump(1);

    expect(atStart).toEqual([
      {
        commits: [keyOf('hbs-rs334'), keyOf('g6pd-deficiency')],
        incoming: [1, 1],
        outgoing: [0, 0],
        outgoingShown: [false, false],
      },
    ]);
    expect(h.waveStarts).toHaveBeenLastCalledWith(false);
    expect(h.wave.running()).toBe(true);
    // Never two datasets under one legend.
    expect(h.displayedHistory).toEqual(['g6pd-deficiency']);
    expect(h.emitted.filter((mark) => mark === 'ready')).toHaveLength(2);
  });

  it('switches at once and runs no wave under reduced motion', async () => {
    const h = harness({ reducedMotion: true });
    await h.show('hbs-rs334');
    const swap = h.layers.setArtifact(h.load('g6pd-deficiency'));
    await h.pump();
    await swap;
    expect(h.waveStarts).toHaveBeenCalledTimes(2);
    expect(h.waveStarts).toHaveBeenLastCalledWith(true);
    expect(h.wave.running()).toBe(false);
    expect(h.attributes.get('data-atlas-displayed')).toBe('g6pd-deficiency');
  });

  it('keeps metric, palette and elevation changes instant: they recolour the same data', async () => {
    const h = harness({ reducedMotion: false });
    runAnimationFramesAtOnce();
    await h.show('hbs-rs334');
    h.finishWave();
    h.style.metric = 'post_sd';
    await Promise.all([h.layers.rebuild(), h.pump()]);
    h.style.palette = 'viridis';
    await Promise.all([h.layers.rebuild(), h.pump()]);
    h.style.elevationFactor = 2;
    h.layers.setElevationFactor(2, true);
    await h.pump(1);
    expect(h.commits).toHaveLength(3);
    expect(h.waveStarts).toHaveBeenCalledTimes(1);
    expect(h.wave.running()).toBe(false);
  });

  it('builds the cell outlines only once the wave has passed, then shows them', async () => {
    const h = harness({ cellEdges: true, reducedMotion: false });
    await h.show('hbs-rs334');
    expect(h.emitted).toContain('surface-visible');
    expect(h.wave.running()).toBe(true);
    // Outlines added during the wave would pack every ring at once when it ends (#451).
    expect(h.worker.buildEdges).not.toHaveBeenCalled();
    const group = built.surfaces[0];
    expect(group.edges.collection.show).toBe(false);

    h.finishWave();
    await h.pump(2);
    expect(h.worker.buildEdges).toHaveBeenCalledTimes(1);
    expect(group.edges.collection.show).toBe(true);
    expect(h.emitted).toContain('edges-ready');
  });

  it('holds built outlines of a dataset switched back to until its wave has passed', async () => {
    const h = harness({ cellEdges: true, reducedMotion: false });
    await h.show('hbs-rs334');
    h.finishWave();
    await h.pump(2);
    const [hbs] = built.surfaces;
    expect(hbs.edges.isBuilt()).toBe(true);
    for (const id of ['g6pd-deficiency', 'hbs-rs334']) {
      const swap = h.layers.setArtifact(h.load(id));
      await h.pump();
      await swap;
      await h.pump(1);
      if (id === 'g6pd-deficiency') {
        h.finishWave();
        await h.pump(2);
      }
    }
    expect(h.layers.displayedLayer()?.artifactKey).toBe(keyOf('hbs-rs334'));
    expect(h.wave.running()).toBe(true);
    expect(hbs.edges.collection.show).toBe(false);
    h.finishWave();
    await h.pump(2);
    expect(hbs.edges.collection.show).toBe(true);
  });
});

describe('displayed-artifact state', () => {
  it('reports cell values ready only for the displayed artifact', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    h.layers.markValuesReady(keyOf('g6pd-deficiency'));
    h.frame();
    expect(h.attributes.get('data-atlas-values-ready')).toBe('false');
    h.layers.markValuesReady(keyOf('hbs-rs334'));
    h.frame();
    expect(h.attributes.get('data-atlas-values-ready')).toBe('true');

    await h.show('kir-3ds1');
    expect(h.attributes.get('data-atlas-values-ready')).toBe('false');
  });

  it('removes the displayed surface when its cell values fail validation', async () => {
    const h = harness();
    await h.show('hbs-rs334');
    const before = h.primitives.length;
    h.layers.removeSurface(keyOf('hbs-rs334'));
    h.frame();
    expect(h.primitives.length).toBe(before - 1);
    expect(h.layers.pickTarget()?.artifactKey).toBe(keyOf('hbs-rs334'));
    expect(h.attributes.get('data-atlas-displayed')).toBe('hbs-rs334');
  });

  it('forgets a group removed from the layer cache', () => {
    const cache = new LayerCache<object>(2);
    const value = {};
    cache.set('a', value);
    cache.delete(value);
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('draped surface (#483)', () => {
  let runtime: Mocked<DrapedRuntime>;
  let groups: FakeDrapedGroup[];
  beforeEach(() => {
    ({ groups, runtime } = fakeDrapedRuntime());
  });

  /** Shows `id` draped: its raster prepared, its tiles loaded and its fade run to the end. */
  async function showDraped(h: Harness, id: string): Promise<void> {
    const done = h.layers.setArtifact(h.load(id));
    await h.pump();
    const group = groups.at(-1)!;
    group.prepared.resolve();
    group.ready = true;
    await h.pump();
    await done;
    h.finishWave();
    await h.pump(1);
  }

  it('builds a draped group, never chunks, for a draped style', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    void h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    expect(h.worker.buildChunks).not.toHaveBeenCalled();
    expect(groups).toHaveLength(1);
    expect(groups[0].options.surface).toEqual({
      artifactKey: keyOf('hbs'),
      cells: { masked: true, supported: true },
      contours: false,
      geometry: 'triangles',
      gridSha256: expect.any(String),
      layer: 'surface',
      metric: 'post_mean',
      palette: 'rainbow',
    });
    expect(groups[0].options).toMatchObject({
      artifactKey: keyOf('hbs'),
      cellEdges: false,
      edgeColor: { mode: 'matched' },
      scene: h.scene,
      source: runtime.rasterSource.mock.results[0].value,
      surfaceOpacity: 0.58,
      wave: h.wave,
    });
    expect(runtime.rasterSource).toHaveBeenCalledWith(h.worker);
  });

  it('drapes extruded as hexagons and draws the cells whose layers are on', async () => {
    const { drapedSurfaceSpec } =
      await import('../src/atlas/scene/surface-groups');
    const h = harness({ draped: true, geometry: 'extruded' });
    const surface = surfaceFor('hbs');
    const spec = drapedSurfaceSpec({ artifactKey: keyOf('hbs') }, surface, {
      ...h.style,
      layers: { ...DEFAULT_LAYERS, support: false },
    });
    expect(spec).toMatchObject({
      cells: { masked: false, supported: true },
      geometry: 'hexagons',
      gridSha256: surface.grid.gridSha256,
    });
  });

  it('starts the cold fade at the first isReady, from opacity 0', async () => {
    const h = harness(
      { draped: true, reducedMotion: false },
      {},
      { draped: async () => runtime },
    );
    const done = h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    groups[0].prepared.resolve();
    await h.pump();
    expect(groups[0].opacity()).toBe(0);
    expect(h.waveStarts).not.toHaveBeenCalled();
    groups[0].ready = true;
    await h.pump();
    expect(groups[0].opacity()).toBe(1);
    expect(h.waveStarts).toHaveBeenCalledTimes(1);
    expect(h.waveStarts).toHaveBeenCalledWith(false);
    await done;
    expect(h.commits).toEqual([keyOf('hbs')]);
    expect(h.emitted).toContain('surface-visible');
  });

  it('draws no draped row for picks until the fade has drawn a frame', async () => {
    const h = harness(
      { draped: true, reducedMotion: false },
      {},
      { draped: async () => runtime },
    );
    const done = h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    groups[0].prepared.resolve();
    await flushTasks();
    groups[0].ready = true;
    h.frame();
    await done;
    expect(h.wave.running()).toBe(true);
    expect(h.wave.progress()).toBe(0);
    expect(h.layers.pickTarget()!.drawn(0)).toBe(false);
    h.frame();
    h.clock.now += 100;
    h.frame();
    expect(h.wave.progress()).toBeGreaterThan(0);
    expect(h.layers.pickTarget()!.drawn(0)).toBe(true);
  });

  it('keeps the outgoing draped group opaque through a restyle swap and retires it after', async () => {
    const h = harness(
      { draped: true, reducedMotion: false },
      {},
      { draped: async () => runtime },
    );
    await showDraped(h, 'hbs');
    // Frames run by hand, so the swap is sampled mid-fade.
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      animationFrames.push(callback),
    );
    groups[0].opacities.length = 0;
    h.style.palette = 'viridis';
    const restyle = h.layers.rebuild();
    await h.pump();
    groups[1].prepared.resolve();
    groups[1].ready = true;
    for (let index = 0; index < 4 && animationFrames.length === 0; index += 1)
      await h.pump();
    expect(animationFrames).not.toHaveLength(0);
    animationFrames.shift()!(performance.now() + 150);
    expect(groups[1].opacity()).toBeGreaterThan(0);
    expect(groups[1].opacity()).toBeLessThan(1);
    // The incoming layer rises over an outgoing one that stays opaque.
    expect(groups[0].opacity()).toBe(1);
    while (animationFrames.length > 0)
      animationFrames.shift()!(performance.now() + 1_000);
    await restyle;
    expect(new Set(groups[0].opacities)).toEqual(new Set([1, 0]));
    expect(groups[0].opacities.at(-1)).toBe(0);
    expect(groups[0].collection.show).toBe(false);
    expect(groups[1].opacity()).toBe(1);
    expect(h.commits).toEqual([keyOf('hbs'), keyOf('hbs')]);
    // One raster source serves every group of these layers.
    expect(runtime.rasterSource).toHaveBeenCalledTimes(1);
  });

  it('switches datasets at once and fades the new draped group in on a new wave', async () => {
    const h = harness(
      { draped: true, reducedMotion: false },
      {},
      { draped: async () => runtime },
    );
    await showDraped(h, 'hbs');
    const atStart: unknown[] = [];
    h.waveStarts.mockImplementation((reducedMotion) => {
      atStart.push({
        commits: [...h.commits],
        incoming: groups[1].opacity(),
        outgoing: groups[0].opacity(),
        outgoingShown: groups[0].collection.show,
      });
      h.realWaveStart(reducedMotion);
    });
    // No animation frame is needed: a switch does not cross-fade.
    const swap = h.layers.setArtifact(h.load('g6pd-deficiency'));
    await h.pump();
    groups[1].prepared.resolve();
    groups[1].ready = true;
    await h.pump();
    await swap;
    expect(atStart).toEqual([
      {
        commits: [keyOf('hbs'), keyOf('g6pd-deficiency')],
        incoming: 1,
        outgoing: 0,
        outgoingShown: false,
      },
    ]);
    expect(h.waveStarts).toHaveBeenCalledTimes(2);
    expect(h.waveStarts).toHaveBeenLastCalledWith(false);
    expect(h.wave.running()).toBe(true);
  });

  it('rebuilds when a layer toggle changes the drawn cells, and hides at α 0 when both are off', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    await showDraped(h, 'hbs');
    h.style.layers = { ...h.style.layers, support: false };
    h.layers.setVisibility(h.style.layers, true);
    await h.pump();
    expect(groups).toHaveLength(2);
    expect(groups[1].cells).toEqual({ masked: false, supported: true });
    h.style.layers = { ...h.style.layers, support: false, surface: false };
    h.layers.setVisibility(h.style.layers, true);
    await h.pump();
    expect(groups).toHaveLength(2);
    expect(groups[1].setVisibility).toHaveBeenLastCalledWith(false, false);
    expect(h.worker.buildChunks).not.toHaveBeenCalled();
  });

  it('rebuilds a toggle undone while its rebuild is still preparing', async () => {
    // The pending rebuild drew the cells of the first toggle; the second one must not leave them.
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    await showDraped(h, 'hbs');
    h.style.layers = { ...h.style.layers, support: false };
    h.layers.setVisibility(h.style.layers, true);
    await h.pump();
    expect(groups).toHaveLength(2);
    h.style.layers = { ...h.style.layers, support: true };
    h.layers.setVisibility(h.style.layers, true);
    await h.pump();
    await h.pump(1);
    expect(groups[1].destroy).toHaveBeenCalledTimes(1);
    expect(h.commits).toEqual([keyOf('hbs'), keyOf('hbs')]);
    expect(groups).toHaveLength(2);
    expect(groups[0].collection.show).toBe(true);
    expect(groups[0].opacity()).toBe(1);
  });

  it('reports a failed raster and settles with the rebuild it starts', async () => {
    const failures: unknown[] = [];
    const h = harness(
      { draped: true },
      {},
      {
        draped: async () => runtime,
        onDrapeFailure: (e) => {
          failures.push(e);
          h.style.draped = false;
          void h.layers.rebuild();
        },
      },
    );
    const done = h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    groups[0].prepared.reject(new Error('raster'));
    await h.pump();
    await expect(done).resolves.toBeUndefined();
    expect(failures).toEqual([new Error('raster')]);
    expect(h.worker.buildChunks).toHaveBeenCalledTimes(1);
    expect(groups[0].destroy).toHaveBeenCalled();
    expect(h.commits).toEqual([keyOf('hbs')]);
  });

  it('rejects with the raster error when nothing reverts the terrain', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    const done = h.layers
      .setArtifact(h.load('hbs'))
      .catch((error: unknown) => error);
    await h.pump();
    groups[0].prepared.reject(new Error('raster'));
    expect(await done).toEqual(new Error('raster'));
    expect(groups[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('reports a provider failure of a group in view once, and none of a retired one', async () => {
    const onDrapeFailure = vi.fn();
    const h = harness(
      { draped: true },
      {},
      { draped: async () => runtime, onDrapeFailure },
    );
    await showDraped(h, 'hbs');
    await showDraped(h, 'g6pd-deficiency');
    // The retired group stays cached, hidden: its late tiles are not the globe's problem.
    groups[0].options.onError(new Error('late'));
    expect(onDrapeFailure).not.toHaveBeenCalled();
    const error = new Error('tile');
    groups[1].options.onError(error);
    groups[1].options.onError(error);
    expect(onDrapeFailure.mock.calls).toEqual([[error]]);
  });

  it('tells picks the group is draped and keeps draped groups out of the depth-pick hide list', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    await showDraped(h, 'hbs');
    h.style.palette = 'viridis';
    void h.layers.rebuild();
    await h.pump();
    expect(groups).toHaveLength(2);
    expect(h.layers.pickTarget()).toMatchObject({ draped: true, hidden: [] });
  });

  it('commits a draped surface with nothing to draw, ends its wave and still reads surface-visible', async () => {
    const h = harness(
      { draped: true, reducedMotion: false },
      {},
      { draped: async () => runtime },
    );
    void h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    Object.assign(groups[0], { empty: true, ready: true });
    groups[0].prepared.resolve();
    await h.pump();
    expect(h.waveStarts).not.toHaveBeenCalled();
    expect(h.attributes.get('data-atlas-wave')).toBe('done');
    expect(h.emitted).toContain('surface-visible');
    expect(h.commits).toEqual([keyOf('hbs')]);
  });

  it('turns on draped outlines through setCellEdges and marks edges-ready once they are ready', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    await showDraped(h, 'hbs');
    h.style.cellEdges = true;
    const edges = h.layers.setCellEdges(true);
    await h.pump(2);
    expect(groups[0].setCellEdges).toHaveBeenLastCalledWith(true);
    expect(h.emitted).not.toContain('edges-ready');
    groups[0].outlines = true;
    await h.pump(2);
    await edges;
    expect(h.emitted).toContain('edges-ready');
    expect(groups[0].setOutlineStyle).not.toHaveBeenCalled();

    h.style.edgeColorMode = 'fixed';
    h.style.edgeFixedColor = '#ff0000';
    await h.layers.setEdgeStyle();
    expect(groups[0].setOutlineStyle).toHaveBeenCalledExactlyOnceWith({
      color: '#ff0000',
      mode: 'fixed',
    });
    h.frame();
    expect(h.attributes.get('data-atlas-edges-ready')).toBe('true');

    await h.layers.setCellEdges(false);
    expect(groups[0].setCellEdges).toHaveBeenLastCalledWith(false);
    expect(h.attributes.get('data-atlas-edges-ready')).toBe('false');
    expect(h.worker.buildEdges).not.toHaveBeenCalled();
  });

  it('reverts through onDrapeFailure when the outline raster fails', async () => {
    const onDrapeFailure = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(
      { draped: true },
      {},
      { draped: async () => runtime, onDrapeFailure },
    );
    await showDraped(h, 'hbs');
    const error = new Error('outline raster');
    groups[0].setCellEdges.mockRejectedValueOnce(error);
    h.style.cellEdges = true;
    await h.layers.setCellEdges(true);
    expect(onDrapeFailure.mock.calls).toEqual([[error]]);
    expect(warn).toHaveBeenCalledWith(
      'Cell outlines could not be built.',
      error,
    );
    warn.mockRestore();
  });

  it('destroys a superseded draped group that was never shown', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    const first = h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    expect(groups).toHaveLength(1);
    const second = h.layers.setArtifact(h.load('g6pd-deficiency'));
    await h.pump();
    await first;
    expect(groups[0].destroy).toHaveBeenCalledTimes(1);
    expect(groups[0].opacities.every((opacity) => opacity === 0)).toBe(true);
    groups[1].prepared.resolve();
    groups[1].ready = true;
    await h.pump();
    await second;
    expect(groups[0].destroy).toHaveBeenCalledTimes(1);
    expect(h.commits).toEqual([keyOf('g6pd-deficiency')]);
  });

  it('shows a cold draped surface at once under reduced motion', async () => {
    const h = harness(
      { draped: true, reducedMotion: true },
      {},
      { draped: async () => runtime },
    );
    const done = h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    groups[0].prepared.resolve();
    groups[0].ready = true;
    await h.pump(1);
    await done;
    expect(groups[0].opacity()).toBe(1);
    expect(h.waveStarts).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.attributes.get('data-atlas-wave')).toBe('done');
    expect(h.wave.progress()).toBe(1);
    expect(h.layers.pickTarget()!.drawn(0)).toBe(true);
  });

  it('destroys its draped groups with the layers, so their rasters are released', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    await showDraped(h, 'hbs');
    h.style.palette = 'viridis';
    const restyle = h.layers.rebuild().catch((error: unknown) => error);
    await h.pump();
    expect(groups).toHaveLength(2);
    h.layers.destroy();
    await h.pump();
    // As for chunks, a build that destroy cuts short ends with its AbortError.
    expect(await restyle).toMatchObject({ name: 'AbortError' });
    expect(groups.map((group) => group.destroy.mock.calls.length)).toEqual([
      1, 1,
    ]);
  });
});
