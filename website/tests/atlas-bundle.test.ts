import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

const dist = path.resolve(import.meta.dirname, '../dist');
const assets = path.join(dist, '_astro');
// Strings that survive minification in Cesium code. GLSL built-ins carry `czm_` in every shader
// source. `DeveloperError` is the error class behind Cesium's argument checks, which its ES source
// keeps, so every non-trivial Core value (Color, Cartesian3, Math, JulianDate, Event…) brings it
// along even when tree-shaken away from the renderer. Only constant-only modules (`defined`,
// `Frozen`, small enums) carry neither.
const CESIUM_MARKERS = ['czm_', 'DeveloperError'];
const STATIC_IMPORT =
  /(?:\bimport|\bexport)\s*(?:[^"'()]*?\bfrom\s*)?["'](\.\.?\/[^"']+\.js)["']/g;
// The Vite 8 Oxc minifier writes string literals, dynamic-import specifiers included, as
// template literals (import(`./atlas-scene.<hash>.js`)), so backticks are accepted here.
const DYNAMIC_IMPORT = /\bimport\(\s*["'`](\.\.?\/[^"'`]+\.js)["'`]\s*\)/g;

// Cesium's widget layer (@cesium/widgets), which `Viewer` pulls in even with every widget hidden:
// one class name or library name per part that survives minification (issue #446).
const WIDGET_LAYER_MARKERS = [
  'knockout',
  'cesium-viewer-toolbar',
  'cesium-animation-svg',
  'cesium-baseLayerPicker-dropDown',
  'cesium-fullscreenButton',
  'cesium-geocoder-input',
  'cesium-home-button',
  'cesium-infoBox-iframe',
  'cesium-navigationHelpButton-wrapper',
  'cesium-sceneModePicker',
  'cesium-selection-wrapper',
  'cesium-timeline-main',
  'cesium-vrButton',
];
// The widget layer's stylesheet rules, by the class each part's CSS styles.
const WIDGET_LAYER_CSS = [
  '.cesium-animation',
  '.cesium-baseLayerPicker',
  '.cesium-button',
  '.cesium-geocoder',
  '.cesium-infoBox',
  '.cesium-navigation-help',
  '.cesium-sceneModePicker',
  '.cesium-selection-wrapper',
  '.cesium-timeline',
];
// The Cesium chunk's gzip size (zlib default level, as `serve` compresses) after #446 built the
// globe on CesiumWidget: 1,101,646 bytes with Viewer at 0c9f328, 1,032,528 bytes without, both on
// darwin-arm64 with Node 23.9. The pin is CI's measurement of the same build (ubuntu x64, Node
// 24.21: 1,037,389 bytes), since CI is the gate and its zlib output runs about 0.5% larger. Pinned
// with 1% headroom, so Cesium-chunk edits such as the render loop pass, and the widget layer
// (+69,118 bytes) or another Cesium module family of similar size coming back fails. The test
// prints the size it measures, so drift toward the limit shows in CI logs.
const CESIUM_CHUNK_GZIP_BYTES = 1_037_389;
const CESIUM_CHUNK_GZIP_HEADROOM = 0.01;

function appHtml(): string {
  return readFileSync(path.join(dist, 'app', 'index.html'), 'utf8');
}

function code(file: string): string {
  return readFileSync(path.join(assets, file), 'utf8');
}

/** The Cesium markers present in a chunk's source. */
function cesiumMarkers(source: string): string[] {
  return CESIUM_MARKERS.filter((marker) => source.includes(marker));
}

function islandChunk(): string {
  const match = appHtml().match(
    /component-url="[^"]*\/_astro\/(AtlasExplorer\.[^"/]+\.js)"/,
  );
  if (!match) throw new Error('the /app/ page has no AtlasExplorer island');
  return match[1];
}

/** The chunk and everything it imports statically (dynamic imports excluded). */
export function staticGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of code(file).matchAll(STATIC_IMPORT)) {
      queue.push(path.posix.join(path.posix.dirname(file), match[1]));
    }
  }
  return [...seen];
}

export function sceneChunk(): string {
  const island = islandChunk();
  const graph = staticGraph(island);
  const targets = graph.flatMap((file) =>
    [...code(file).matchAll(DYNAMIC_IMPORT)].map((match) =>
      path.posix.join(path.posix.dirname(file), match[1]),
    ),
  );
  const scene = targets.find((file) =>
    path.posix.basename(file).startsWith('atlas-scene.'),
  );
  if (!scene)
    throw new Error(`no lazy atlas-scene chunk among ${targets.join(', ')}`);
  return scene;
}

describe('Atlas client bundle', () => {
  it('keeps Cesium out of the explorer island and its static imports', () => {
    for (const file of staticGraph(islandChunk())) {
      expect(cesiumMarkers(code(file)), file).toEqual([]);
    }
  });

  it('checks the production bundle Pages ships, not a development build', () => {
    // vitest sets NODE_ENV=test, which the build inherits unless tests/setup/build.ts pins
    // production; a development build carries React's jsxDEV and dev chunking, so the §B.8 checks
    // here would bind nothing (final review spec-6).
    for (const file of staticGraph(islandChunk()))
      expect(code(file).includes('jsxDEV'), file).toBe(false);
  });

  it('loads Cesium only through the lazy scene chunk', () => {
    const scene = sceneChunk();
    expect(existsSync(path.join(assets, scene))).toBe(true);
    // Every marker must occur in the scene graph, or it could never catch Cesium in the island.
    expect(
      new Set(staticGraph(scene).flatMap((file) => cesiumMarkers(code(file)))),
    ).toEqual(new Set(CESIUM_MARKERS));
  });

  it('bundles the Atlas render loop into the Cesium chunk, so its frames count as Cesium', () => {
    // Fast-load design §B.1 attributes long animation frames by script source: Cesium-chunk work
    // outside chunk frames is Cesium. The owned RenderLoop's tick is only widget.resize() and
    // widget.render(), the work Cesium's default loop did from the Cesium chunk; in the scene
    // chunk every Cesium render would be charged to Atlas.
    const message = 'The Atlas globe stopped rendering.';
    const scene = sceneChunk();
    const cesium = staticGraph(scene).find((file) =>
      path.posix.basename(file).startsWith('cesium.'),
    );
    expect(cesium).toBeDefined();
    // Booleans, so a failure does not print a megabyte of minified source.
    expect(code(cesium!).includes(message), cesium).toBe(true);
    expect(code(scene).includes(message), scene).toBe(false);
  });

  it('bundles the data worker as a Cesium-free ES module referenced by the island', () => {
    const worker = readdirSync(assets).find((name) =>
      /^atlas-data\.worker[-.].+\.js$/.test(name),
    );
    expect(worker).toBeDefined();
    const source = code(worker!);
    expect(cesiumMarkers(source)).toEqual([]);
    expect(source).toContain('load-grid');
    expect(source.trimStart().startsWith('(function')).toBe(false);
    expect(
      staticGraph(islandChunk()).some((file) => code(file).includes(worker!)),
    ).toBe(true);
  });

  it("keeps the raster runtime out of the worker's first load", () => {
    // Terrain draping design, "When it is active": draped code loads lazily in the worker too.
    const worker = readdirSync(assets).find((name) =>
      /^atlas-data\.worker[-.].+\.js$/.test(name),
    )!;
    for (const file of staticGraph(worker))
      expect(code(file).includes('atlas-raster-v1'), file).toBe(false);
    expect(
      readdirSync(assets).some(
        (name) =>
          name.endsWith('.js') && code(name).includes('atlas-raster-v1'),
      ),
    ).toBe(true);
  });

  it('modulepreloads the lazy scene chunk and its static imports from the /app/ head', () => {
    const html = appHtml();
    const head = html.slice(0, html.indexOf('</head>'));
    const hrefs = [
      ...head.matchAll(
        /<link rel="modulepreload" fetchpriority="high" href="([^"]+)">/g,
      ),
    ].map((match) => match[1]);
    const scene = sceneChunk();
    expect(hrefs[0]).toBe(`/_astro/${scene}`);
    expect(new Set(hrefs)).toEqual(
      new Set(staticGraph(scene).map((file) => `/_astro/${file}`)),
    );
    for (const href of hrefs)
      expect(existsSync(path.join(dist, href))).toBe(true);
  });
});

describe('Cesium chunk on the /app/ critical path (issue #446)', () => {
  function cesiumChunk(): string {
    const cesium = staticGraph(sceneChunk()).find((file) =>
      path.posix.basename(file).startsWith('cesium.'),
    );
    if (!cesium) throw new Error('the scene chunk imports no Cesium chunk');
    return cesium;
  }

  it("builds the globe without Cesium's widget layer", () => {
    const source = code(cesiumChunk());
    expect(
      WIDGET_LAYER_MARKERS.filter((marker) => source.includes(marker)),
    ).toEqual([]);
  });

  it('keeps the Cesium chunk within its pinned gzip size', () => {
    const bytes = gzipSync(
      readFileSync(path.join(assets, cesiumChunk())),
    ).length;
    const limit = Math.round(
      CESIUM_CHUNK_GZIP_BYTES * (1 + CESIUM_CHUNK_GZIP_HEADROOM),
    );
    // In the CI log, so drift toward the limit on another platform or Node shows before it fails.
    const format = (value: number, signDisplay: 'auto' | 'always' = 'auto') =>
      value.toLocaleString('en-US', { signDisplay });
    console.log(
      `Cesium chunk gzip: ${format(bytes)} bytes ` +
        `(${format(bytes - CESIUM_CHUNK_GZIP_BYTES, 'always')} against the ` +
        `${format(CESIUM_CHUNK_GZIP_BYTES)} pin; limit ${format(limit)})`,
    );
    expect(bytes).toBeLessThanOrEqual(limit);
  });

  it("ships the credit-row CSS to /app/ but none of the widget layer's", () => {
    const css = [
      ...appHtml().matchAll(
        /<link rel="stylesheet" href="\/_astro\/([^"]+\.css)">/g,
      ),
    ]
      .map((match) => code(match[1]))
      .join('\n');
    for (const selector of [
      '.cesium-widget-credits',
      '.cesium-viewer-bottom',
      '.cesium-viewer-cesiumWidgetContainer',
    ])
      expect(css.includes(selector), selector).toBe(true);
    expect(
      WIDGET_LAYER_CSS.filter((selector) => css.includes(selector)),
    ).toEqual([]);
  });
});
