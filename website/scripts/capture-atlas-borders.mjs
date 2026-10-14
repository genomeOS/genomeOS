/**
 * Compact Natural Earth borders: visual parity (issue #445; fast-load design §B.6.9, method of
 * §B.1 "Visual parity").
 *
 *   node scripts/capture-atlas-borders.mjs --phase before --commit <sha>  # ./dist is the pre-change build
 *   node scripts/capture-atlas-borders.mjs --phase after                  # ./dist is this build
 *
 * Both phases serve ./dist (a production build, `npm run build`) on 127.0.0.1:$ATLAS_CAPTURE_PORT
 * (default 4376) and capture each of VIEWS with page overlays hidden, time frozen and every
 * basemap tile replaced by one neutral pixel. Most views show the Natural Earth borders and labels
 * alone (`layers=countries`); the two elevated views keep the HbS surface, whose heights the
 * borders follow, and which the compact borders reproduce exactly (every vertex stays in its H3
 * cell, fast-load §B.10). The after phase compares every pair with the before captures and writes
 * docs/figures/atlas-compact-borders-parity.receipt.json, exiting non-zero when any pair differs by
 * more than CHANNEL_TOLERANCE on more than MAX_DIFFERENT_FRACTION of its pixels. Headless Chromium
 * renders through SwiftShader here, and two captures of one build are byte-identical, so every
 * difference the receipt counts comes from the change.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright';

import { countPixelDifferences, decodePng, gateViews } from './pixel-diff.mjs';

const websiteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const figuresDir = path.resolve(websiteRoot, '..', 'docs', 'figures');
const VIEWPORT = { height: 900, width: 1440 };
const FIXED_TIME = new Date('2026-10-07T12:00:00Z');
const CHANNEL_TOLERANCE = 2;
const MAX_DIFFERENT_FRACTION = 0.005;
const BORDERS_ONLY = { entity: 'hbs-rs334', layers: 'countries' };
/** The camera heights bracket the documented error bound: 8.8 m is about half a pixel at ~20 km. */
const VIEWS = [
  { name: 'globe', params: BORDERS_ONLY },
  // The 2D map has no sky box.
  { name: 'map', params: { ...BORDERS_ONLY, view: 'map' }, skyBox: false },
  {
    name: 'europe-1500km',
    params: { ...BORDERS_ONLY, height: '1500000', lat: '47', lon: '12' },
  },
  {
    name: 'alps-60km',
    params: { ...BORDERS_ONLY, height: '60000', lat: '46.45', lon: '8.5' },
  },
  {
    name: 'alps-20km',
    params: { ...BORDERS_ONLY, height: '20000', lat: '46.45', lon: '8.5' },
  },
  {
    name: 'elevated-surface',
    params: {
      elevation: 'true',
      entity: 'hbs-rs334',
      exaggeration: '5',
      height: '9000000',
      lat: '5',
      lon: '20',
      layers: 'surface,countries',
    },
  },
  // Tilted north over the Gulf of Gabès, at one of the 8 vertices that rounding alone would carry
  // into the neighbouring H3 cell (11.2026, 33.2492): it would drop from 24,778 m to 22,613 m on
  // the HbS surface at exaggeration 1. Snapped back into its own cell, it keeps 24,778 m, so this
  // view shows only the sub-pixel shift of the borders.
  {
    name: 'elevated-tilted-gabes',
    params: {
      elevation: 'true',
      entity: 'hbs-rs334',
      exaggeration: '5',
      height: '600000',
      lat: '26',
      lon: '11.2',
      layers: 'surface,countries',
      pitch: '-35',
    },
  },
];
const OVERLAYS = [
  '.site-header',
  '.atlas-top-slot',
  '.atlas-controls',
  '.atlas-legend',
  '.atlas-right-rail',
  '.atlas-status-stack',
  '.atlas-warning-banner',
  '.atlas-data-credit',
  '.atlas-hover-preview',
  '.cesium-viewer-bottom',
].join(', ');
const neutralTile = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAvPp7WQAAAABJRU5ErkJggg==',
  'base64',
);

const { values } = parseArgs({
  options: {
    commit: { type: 'string' },
    out: {
      default: path.join(websiteRoot, 'test-results', 'atlas-borders-figures'),
      type: 'string',
    },
    phase: { type: 'string' },
  },
});
const phase = values.phase;
if (phase !== 'before' && phase !== 'after')
  throw new Error('Pass --phase before|after.');
if (phase === 'before' && !values.commit)
  throw new Error('Pass --commit <sha of the pre-change build>.');
const commit =
  values.commit ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: websiteRoot,
    encoding: 'utf8',
  }).trim();
const outDir = path.resolve(values.out);
mkdirSync(outDir, { recursive: true });
const port = Number(process.env.ATLAS_CAPTURE_PORT ?? 4376);
const baseUrl = `http://127.0.0.1:${port}`;

function capturePath(view, capturePhase = phase) {
  return path.join(outDir, `${capturePhase}-${view}.png`);
}

async function waitForServer(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitUntil(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function settledScreenshot(page) {
  const options = { animations: 'disabled', caret: 'hide' };
  let previous = await page.screenshot(options);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(750);
    const next = await page.screenshot(options);
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error('The globe did not settle within 30 s.');
}

async function capture(browser, view) {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    viewport: VIEWPORT,
  });
  await context.clock.setFixedTime(FIXED_TIME);
  await context.route(/^https:\/\/tile(s)?\./, (route) =>
    route.fulfill({ body: neutralTile, contentType: 'image/png', status: 200 }),
  );
  const page = await context.newPage();
  const pageErrors = [];
  const skyBoxFaces = new Set();
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('requestfinished', (request) => {
    if (request.url().includes('/Textures/SkyBox/'))
      skyBoxFaces.add(request.url());
  });
  try {
    await page.goto(`${baseUrl}/app/?${new URLSearchParams(view.params)}`);
    await page
      .locator('[data-atlas-context-ready="true"]')
      .waitFor({ timeout: 180_000 });
    if (view.skyBox !== false)
      await waitUntil(() => skyBoxFaces.size >= 6, 60_000, 'six sky box faces');
    await page.mouse.move(0, 0);
    await page.addStyleTag({
      content: `${OVERLAYS} { visibility: hidden !important; }`,
    });
    const globe = await settledScreenshot(page);
    if (pageErrors.length > 0) throw pageErrors[0];
    writeFileSync(capturePath(view.name), globe);
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl && debug
        ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
        : 'unknown';
    });
  } finally {
    await context.close();
  }
}

async function writeReceipt(browser) {
  const beforeMetaPath = path.join(outDir, 'before-meta.json');
  if (!existsSync(beforeMetaPath))
    throw new Error(`Run --phase before first (missing ${beforeMetaPath}).`);
  const page = await browser.newPage();
  const pairs = [];
  try {
    for (const view of VIEWS) {
      const before = await decodePng(
        page,
        readFileSync(capturePath(view.name, 'before')),
      );
      const after = await decodePng(
        page,
        readFileSync(capturePath(view.name, 'after')),
      );
      if (before.width !== after.width || before.height !== after.height)
        throw new Error(`${view.name}: capture sizes differ`);
      pairs.push({
        view: view.name,
        query: new URLSearchParams(view.params).toString(),
        ...countPixelDifferences(before.data, after.data, CHANNEL_TOLERANCE),
      });
    }
  } finally {
    await page.close();
  }
  const gate = gateViews({ borders: pairs }, MAX_DIFFERENT_FRACTION);
  const receipt = {
    generated_by: 'website/scripts/capture-atlas-borders.mjs',
    issue: 'https://github.com/genomeOS/genomeOS/issues/445',
    before: JSON.parse(readFileSync(beforeMetaPath, 'utf8')),
    after: JSON.parse(
      readFileSync(path.join(outDir, 'after-meta.json'), 'utf8'),
    ),
    viewport: VIEWPORT,
    fixed_time: FIXED_TIME.toISOString(),
    compared:
      'globe captures with page overlays hidden and neutral basemap tiles: the Natural Earth borders and labels alone, and over the elevated HbS surface',
    channel_tolerance: CHANNEL_TOLERANCE,
    max_different_fraction: MAX_DIFFERENT_FRACTION,
    pairs: gate.views.borders,
  };
  writeFileSync(
    path.join(figuresDir, 'atlas-compact-borders-parity.receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  for (const pair of gate.views.borders)
    process.stdout.write(
      `${pair.pass ? 'ok  ' : 'FAIL'} ${pair.view}: ${(pair.fractionAny * 100).toFixed(4)}% of pixels differ at all, ${(pair.fractionOverTolerance * 100).toFixed(4)}% by more than ${CHANNEL_TOLERANCE}/255\n`,
    );
  return gate.failed;
}

const server = spawn(
  process.execPath,
  [
    path.join(websiteRoot, 'node_modules', 'serve', 'build', 'main.js'),
    'dist',
    '-c',
    '../serve.json',
    '-l',
    `tcp://127.0.0.1:${port}`,
    '--no-clipboard',
  ],
  { cwd: websiteRoot, stdio: 'ignore' },
);
let browser;
let failed = false;
try {
  await waitForServer(`${baseUrl}/app/`);
  browser = await chromium.launch({ headless: true });
  let renderer = 'unknown';
  for (const view of VIEWS) {
    renderer = await capture(browser, view);
    process.stdout.write(`captured ${phase} ${view.name}\n`);
  }
  writeFileSync(
    path.join(outDir, `${phase}-meta.json`),
    `${JSON.stringify({ baseUrl, commit, renderer }, null, 2)}\n`,
  );
  if (phase === 'after') failed = await writeReceipt(browser);
} finally {
  await browser?.close();
  server.kill();
  await once(server, 'exit');
}
process.exit(failed ? 1 : 0);
