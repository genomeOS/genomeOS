#!/usr/bin/env node
/**
 * Build the marketing figures' data from the pinned HbS (rs334) artifact (site redesign spec §5, #454).
 *
 *   node scripts/build-site-figures.mjs --from-dir <staged Atlas data root>
 *   ATLAS_DATA_BASE_URL=… node scripts/build-site-figures.mjs
 *
 * Inputs: `public/data/atlas/catalog.json` (the `hbs-rs334` entry) and its two public downloads,
 * `observations_url` and `surface_url`, read from a local copy of the Atlas data tree or fetched
 * from the data host named by `ATLAS_DATA_BASE_URL` (falling back to `PUBLIC_ATLAS_DATA_BASE_URL`,
 * the variable the e2e build uses). The host is never written anywhere: only derived, coarsened
 * figure data and their provenance (artifact id, versions, sha256s) are committed. Each download's
 * sha256 must equal the catalog's, or the script exits non-zero.
 *
 * Coarsening is display only (never finer than the res-4 artifact, and no inference):
 *   parent  = cellToParent(h3, res): res 2 for the hero globe, res 3 for the Project window
 *   mean    = mean of the children's post_mean
 *   range   = [lowest child q025, highest child q975] (never narrower than any child's interval)
 *   support = the class most children hold; ties go to the less certain class
 *   distance= median child dist_nearest_obs_km; tier from it and the artifact's ρ
 *
 * Outputs (content-hashed, in src/data/figures/): hbs-globe.<hash>.bin, hbs-region.<hash>.bin,
 * hbs-surveys.<hash>.bin, hbs-globe-poster.<hash>.svg and hbs.provenance.json. The script fails on
 * any broken self-check (spec §5). Run it by hand when the pinned artifact changes; never in CI.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import {
  cellToLatLng,
  cellToParent,
  cellToVertexes,
  vertexToLatLng,
} from 'h3-js';
import { runnerImport } from 'vite';

const website = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const ARTIFACT_ID = 'hbs-rs334';
const GLOBE_RES = 2;
const REGION_RES = 3;
const BAND_DEGREES = { [GLOBE_RES]: 3, [REGION_RES]: 1.5 };
/** Project HbS window (spec §4.2 P2), by area centre. */
const REGION_WINDOW = { west: -26, east: 98, south: -37, north: 46 };
/** Hero rest orientation (spec §4.1 H1). */
const REST = { lon: 18, lat: 8 };
/** "Visible at rest": within this cosine of the view centre (about 69.5°), clear of the limb. */
const VISIBLE_COSC = 0.35;
const CALLOUT_SURVEY = { lon: 8, lat: 9, withinKm: 600 };
const CALLOUT_UNKNOWN = { lon: 70, lat: 45 };
/** Poster geometry: a square disc image, 1 unit ≈ 1 CSS px on a desktop hero. */
const POSTER = { size: 640, radius: 300 };
const SUPPORT_RANK = {
  observed: 0,
  interpolated: 1,
  prior_dominated: 2,
  unknown: 3,
};
const BUDGET_GZIP = {
  globe: 45 * 1024,
  region: 85 * 1024,
  surveys: 12 * 1024,
  poster: 25 * 1024,
};

function fail(message) {
  console.error(`build-site-figures: ${message}`);
  process.exit(1);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const { values: args } = parseArgs({
  options: {
    'from-dir': { type: 'string' },
    out: { type: 'string', default: 'src/data/figures' },
  },
});

/* ---------- inputs ---------- */

const catalog = JSON.parse(
  readFileSync(path.join(website, 'public/data/atlas/catalog.json'), 'utf8'),
);
const entry = catalog.artifacts.find((artifact) => artifact.id === ARTIFACT_ID);
if (!entry) fail(`catalog.json has no ${ARTIFACT_ID}`);

async function download(relative, expected, label) {
  let bytes;
  if (args['from-dir']) {
    const file = path.join(path.resolve(args['from-dir']), relative);
    if (!existsSync(file))
      fail(`${label}: ${relative} is not under --from-dir`);
    bytes = readFileSync(file);
  } else {
    const base =
      process.env.ATLAS_DATA_BASE_URL || process.env.PUBLIC_ATLAS_DATA_BASE_URL;
    if (!base)
      fail(
        'give --from-dir, or set ATLAS_DATA_BASE_URL (or PUBLIC_ATLAS_DATA_BASE_URL)',
      );
    const response = await fetch(
      new URL(relative, base.endsWith('/') ? base : `${base}/`),
    );
    if (!response.ok)
      fail(`${label}: HTTP ${response.status} from the data host`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const actual = sha256(bytes);
  if (actual !== expected)
    fail(`${label}: sha256 ${actual} does not match the catalog's ${expected}`);
  return JSON.parse(bytes.toString('utf8'));
}

const observationsDoc = await download(
  entry.observations_url,
  entry.observations_sha256,
  'observations',
);
const surfaceDoc = await download(
  entry.surface_url,
  entry.surface_sha256,
  'surface',
);

for (const doc of [observationsDoc, surfaceDoc])
  for (const key of [
    'id',
    'model_version',
    'data_version',
    'hf_revision',
    'variant_id',
  ])
    if (doc.artifact[key] !== entry[key])
      fail(
        `download ${key} ${doc.artifact[key]} differs from the catalog's ${entry[key]}`,
      );

const load = async (relative) =>
  (await runnerImport(path.join(website, relative))).module;
const encoding = await load('src/graphics/encoding.ts');
const figureData = await load('src/graphics/figure-data.ts');
const projection = await load('src/graphics/projection.ts');

const rho = entry.correlation_range_km;
const domain = entry.metric_domains.post_mean;
if (!(rho > 0)) fail('the artifact has no correlation_range_km');

/* ---------- coarsen ---------- */

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function coarsen(cells, res, keep = () => true) {
  const groups = new Map();
  for (const cell of cells) {
    const parent = cellToParent(cell.h3_index, res);
    let group = groups.get(parent);
    if (!group) groups.set(parent, (group = []));
    group.push(cell);
  }
  const areas = [];
  for (const parent of [...groups.keys()].sort()) {
    const [lat, lon] = cellToLatLng(parent);
    if (!keep(lon, lat)) continue;
    const children = groups.get(parent);
    const counts = new Map();
    for (const child of children)
      counts.set(child.support, (counts.get(child.support) ?? 0) + 1);
    // The class most children hold; on a tie, the less certain one.
    const support = [...counts.entries()].sort(
      ([a, na], [b, nb]) => nb - na || SUPPORT_RANK[b] - SUPPORT_RANK[a],
    )[0][0];
    const distanceKm = median(
      children.map((child) => child.dist_nearest_obs_km),
    );
    const unknown = support === 'unknown';
    areas.push({
      h3: parent,
      // The cell's 6 (or, at a pentagon, 5) corners. cellToBoundary adds points where an edge
      // crosses an icosahedron face, which a flat display cell does not need.
      boundary: cellToVertexes(parent).map((vertex) => {
        const [vlat, vlon] = vertexToLatLng(vertex);
        return [vlon, vlat];
      }),
      mean: unknown
        ? null
        : children.reduce((sum, child) => sum + child.post_mean, 0) /
          children.length,
      lo: unknown ? null : Math.min(...children.map((child) => child.q025)),
      hi: unknown ? null : Math.max(...children.map((child) => child.q975)),
      distanceKm,
      support,
      tier: encoding.tier(distanceKm, rho),
      children: children.length,
      center: [lon, lat],
    });
  }
  // North to south in latitude bands about two cells tall, west to east within each: neighbours
  // sit next to each other in the file, which is what lets the area columns compress.
  const band = BAND_DEGREES[res];
  return areas
    .sort(
      (a, b) =>
        Math.floor(b.center[1] / band) - Math.floor(a.center[1] / band) ||
        a.center[0] - b.center[0] ||
        (a.h3 < b.h3 ? -1 : 1),
    )
    .map(({ center: _center, ...area }) => area);
}

const cells = surfaceDoc.cells;
if (cells.length !== entry.n_cells)
  fail(`surface has ${cells.length} cells, the catalog says ${entry.n_cells}`);
for (const cell of cells)
  if (!(cell.q025 <= cell.post_mean && cell.post_mean <= cell.q975))
    fail(`cell ${cell.h3_index} has a mean outside its own interval`);

const globe = coarsen(cells, GLOBE_RES);
const region = coarsen(
  cells,
  REGION_RES,
  (lon, lat) =>
    lon >= REGION_WINDOW.west &&
    lon <= REGION_WINDOW.east &&
    lat >= REGION_WINDOW.south &&
    lat <= REGION_WINDOW.north,
);

const surveys = observationsDoc.observations.map((observation, index) => {
  const { ac, an, lat, lon, radius_km: radius } = observation;
  if (!Number.isInteger(ac) || !Number.isInteger(an) || ac < 0 || ac > an)
    fail(`observation ${index} needs integer 0 ≤ ac ≤ an`);
  if (!(radius > 0)) fail(`observation ${index} has no stated radius`);
  // Whole km, rounded up: a stated extent is never understated.
  return { lat, lon, ac, an, radiusKm: Math.ceil(radius) };
});
if (surveys.length !== entry.n_observations)
  fail(`${surveys.length} surveys, the catalog says ${entry.n_observations}`);

/* ---------- encode, then check what was encoded ---------- */

const globeBytes = figureData.encodeAreas(globe);
const regionBytes = figureData.encodeAreas(region);
const surveyBytes = figureData.encodeSurveys(surveys);
const decodedGlobe = figureData.decodeAreas(globeBytes);
const decodedRegion = figureData.decodeAreas(regionBytes);
const decodedSurveys = figureData.decodeSurveys(surveyBytes);

function checkAreas(name, areas) {
  areas.forEach((area, index) => {
    if (area.support === 'unknown') {
      if (area.mean !== null || area.lo !== null || area.hi !== null)
        fail(`${name} area ${index} is unknown but carries a value`);
      return;
    }
    if (area.mean === null || area.lo === null || area.hi === null)
      fail(`${name} area ${index} has support but no value`);
    if (!(area.lo <= area.mean && area.mean <= area.hi))
      fail(`${name} area ${index}: lo ≤ mean ≤ hi fails`);
  });
  const byTier = (tier) =>
    median(
      areas.filter((area) => area.tier === tier).map((area) => area.distanceKm),
    );
  const [strong, partial, weak] = ['strong', 'partial', 'weak'].map(byTier);
  if (!(strong < partial && partial < weak))
    fail(
      `${name}: tier medians ${strong}, ${partial}, ${weak} do not increase`,
    );
}
checkAreas('globe', decodedGlobe);
checkAreas('region', decodedRegion);
if (decodedSurveys.length !== entry.n_observations)
  fail('the survey count changed in encoding');
for (const survey of decodedSurveys)
  if (!Number.isInteger(survey.ac) || survey.ac < 0 || survey.ac > survey.an)
    fail('a decoded survey breaks 0 ≤ ac ≤ an');

/* ---------- callouts at rest ---------- */

const restProjection = projection.orthographic({
  center: [REST.lon, REST.lat],
  scale: POSTER.radius,
  translate: [POSTER.size / 2, POSTER.size / 2],
});
const atRest = (lon, lat) => {
  const [x, y, cosc] = restProjection.project(lon, lat);
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    nx: Math.round(((x - POSTER.size / 2) / POSTER.radius) * 1e4) / 1e4,
    ny: Math.round(((y - POSTER.size / 2) / POSTER.radius) * 1e4) / 1e4,
    cosc,
  };
};

const surveyCallout = decodedSurveys
  .map((survey, index) => ({
    index,
    survey,
    km: projection.haversineKm(
      [CALLOUT_SURVEY.lon, CALLOUT_SURVEY.lat],
      [survey.lon, survey.lat],
    ),
  }))
  .filter(({ km }) => km <= CALLOUT_SURVEY.withinKm)
  .sort((a, b) => b.survey.an - a.survey.an || a.index - b.index)[0];
if (!surveyCallout) fail('no survey within 600 km of 9°N 8°E');

const visibleGlobe = decodedGlobe
  .map((area, index) => ({ area, index, rest: atRest(...area.center) }))
  .filter(({ rest }) => rest.cosc >= VISIBLE_COSC);
const meanCallout = visibleGlobe
  .filter(({ area }) => area.mean !== null)
  .sort((a, b) => b.area.mean - a.area.mean || a.index - b.index)[0];
const unknownCallout = visibleGlobe
  .filter(({ area }) => area.support === 'unknown')
  .map((candidate) => ({
    ...candidate,
    km: projection.haversineKm(
      [CALLOUT_UNKNOWN.lon, CALLOUT_UNKNOWN.lat],
      candidate.area.center,
    ),
  }))
  .sort((a, b) => a.km - b.km || a.index - b.index)[0];
if (!meanCallout || !unknownCallout) fail('a callout has no visible candidate');

const round = (value, digits = 6) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const restPoint = (lon, lat) => {
  const { x, y, nx, ny } = atRest(lon, lat);
  return {
    lon: round(lon, 2),
    lat: round(lat, 2),
    poster: [x, y],
    disc: [nx, ny],
  };
};

const callouts = [
  {
    kind: 'survey',
    rule: 'the survey with the largest AN within 600 km of 9°N 8°E',
    ac: surveyCallout.survey.ac,
    an: surveyCallout.survey.an,
    radius_km: surveyCallout.survey.radiusKm,
    survey_index: surveyCallout.index,
    ...restPoint(surveyCallout.survey.lon, surveyCallout.survey.lat),
  },
  {
    kind: 'modeled',
    rule: 'the highest-mean area visible at rest',
    mean: round(meanCallout.area.mean),
    lo: round(meanCallout.area.lo),
    hi: round(meanCallout.area.hi),
    distance_km: meanCallout.area.distanceKm,
    tier: meanCallout.area.tier,
    area_index: meanCallout.index,
    ...restPoint(...meanCallout.area.center),
  },
  {
    kind: 'unknown',
    rule: 'the unknown area nearest 45°N 70°E visible at rest',
    distance_km: unknownCallout.area.distanceKm,
    area_index: unknownCallout.index,
    ...restPoint(...unknownCallout.area.center),
  },
];

/* ---------- poster: the Modeled layer at rest, as an SVG image ---------- */

function posterSvg() {
  const bins = new Map();
  const hatched = [];
  const ring = (area) => {
    const points = [];
    for (const [lon, lat] of area.boundary) {
      const [x, y, cosc] = restProjection.project(lon, lat);
      if (cosc < 0.02) return null;
      points.push([Math.round(x), Math.round(y)]);
    }
    return points;
  };
  const relative = (points) => {
    let d = `M${points[0][0]} ${points[0][1]}l`;
    for (let index = 1; index < points.length; index += 1) {
      const dx = points[index][0] - points[index - 1][0];
      const dy = points[index][1] - points[index - 1][1];
      d += `${index > 1 && dx >= 0 ? ' ' : ''}${dx}${dy >= 0 ? ' ' : ''}${dy}`;
    }
    return `${d}z`;
  };
  for (const area of decodedGlobe) {
    const points = ring(area);
    if (!points) continue;
    const d = relative(points);
    if (area.support === 'unknown') {
      hatched.push(d);
      continue;
    }
    const fill = encoding.vsupColor(
      area.mean,
      area.tier === 'none' ? 'weak' : area.tier,
      domain,
    );
    if (!bins.has(fill)) bins.set(fill, []);
    bins.get(fill).push(d);
  }
  const studs = { sm: [], md: [], lg: [] };
  for (const survey of decodedSurveys) {
    const [x, y, cosc] = restProjection.project(survey.lon, survey.lat);
    if (cosc < 0.05) continue;
    studs[encoding.studSize(survey.an)].push([Math.round(x), Math.round(y)]);
  }
  const dotPath = (points) => {
    let d = '';
    let previous = null;
    for (const [x, y] of points) {
      d += previous
        ? `m${x - previous[0]} ${y - previous[1]}h0`
        : `M${x} ${y}h0`;
      previous = [x, y];
    }
    return d;
  };
  const c = POSTER.size / 2;
  const { ENC, STUD_RADIUS } = encoding;
  const fills = [...bins.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fill, paths]) => `<path fill="${fill}" d="${paths.join('')}"/>`)
    .join('');
  const hatchPath = hatched.join('');
  const studDefs = Object.entries(studs)
    .filter(([, points]) => points.length > 0)
    .map(([size, points]) => `<path id="s${size}" d="${dotPath(points)}"/>`)
    .join('');
  const studUses = Object.entries(studs)
    .filter(([, points]) => points.length > 0)
    .map(([size]) => {
      const radius = STUD_RADIUS[size];
      return (
        `<use href="#s${size}" stroke="#020712" stroke-width="${radius * 2 + 3}"/>` +
        `<use href="#s${size}" stroke="${ENC.obs}" stroke-width="${radius * 2}"/>`
      );
    })
    .join('');
  // One centred stroke per tile, rotated 45°: the tile's width is the pitch, and the stroke is
  // never cut to half its width by the tile's clip.
  const tile = ENC.hatchPitch;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${POSTER.size} ${POSTER.size}" width="${POSTER.size}" height="${POSTER.size}">` +
    `<defs><radialGradient id="o" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#071831"/><stop offset="1" stop-color="#020712"/></radialGradient>` +
    `<pattern id="h" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M${tile / 2} 0V${tile}" stroke="${ENC.hatch}" stroke-opacity="${ENC.hatchAlpha}" stroke-width="${ENC.hatchWidth}"/></pattern>` +
    `${studDefs}</defs>` +
    `<circle cx="${c}" cy="${c}" r="${POSTER.radius}" fill="url(#o)"/>` +
    `<g stroke="#020712" stroke-opacity=".85" stroke-width=".7" stroke-linejoin="round">${fills}` +
    (hatchPath
      ? `<path data-support="unknown" fill="${ENC.land}" d="${hatchPath}"/><path data-support="unknown" fill="url(#h)" stroke="none" d="${hatchPath}"/>`
      : '') +
    `</g><g fill="none" stroke-linecap="round">${studUses}</g>` +
    `<circle cx="${c}" cy="${c}" r="${POSTER.radius + 0.5}" fill="none" stroke="rgb(112 230 255 / 28%)"/></svg>\n`;
  return { svg, bins: bins.size };
}

const poster = posterSvg();
if (poster.bins > 12) fail(`poster uses ${poster.bins} colour bins (≤ 12)`);
// No colour on a hatched area: the unknown paths carry land and the hatch pattern only.
for (const match of poster.svg.matchAll(
  /<path data-support="unknown" fill="([^"]+)"/g,
))
  if (![encoding.ENC.land, 'url(#h)'].includes(match[1]))
    fail(`a hatched poster area is filled with ${match[1]}`);
const posterBytes = Buffer.from(poster.svg, 'utf8');

/* ---------- tables, alt text, provenance ---------- */

const pct = (value) => Math.round(value * 1000) / 10;
const inBox = ([lon, lat], box) =>
  lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
const childTiers = { strong: 0, partial: 0, weak: 0, none: 0 };
for (const cell of cells)
  childTiers[
    cell.support === 'unknown'
      ? 'none'
      : encoding.tier(cell.dist_nearest_obs_km, rho)
  ] += 1;
const tierShare = Object.fromEntries(
  Object.entries(childTiers).map(([tier, count]) => [
    tier,
    Math.round((count / cells.length) * 1000) / 1000,
  ]),
);

const BOX = {
  africaToIndia: { west: -20, east: 90, south: -35, north: 47 },
  centralAfrica: { west: 8, east: 32, south: -12, north: 12 },
  eastAsia: { west: 100, east: 145, south: 20, north: 50 },
  northernEurasia: { west: 30, east: 180, south: 50, north: 75 },
  oceania: { west: 110, east: 180, south: -50, north: 0 },
  americas: { west: -170, east: -30, south: -56, north: 72 },
};
const unknownShare = (box) => {
  const inside = cells.filter((cell) => {
    const [lat, lon] = cellToLatLng(cell.h3_index);
    return inBox([lon, lat], box);
  });
  return inside.length
    ? inside.filter((cell) => cell.support === 'unknown').length / inside.length
    : 0;
};
const surveyShare =
  decodedSurveys.filter((survey) =>
    inBox([survey.lon, survey.lat], BOX.africaToIndia),
  ).length / decodedSurveys.length;
const peak = cells.reduce((best, cell) =>
  cell.post_mean > best.post_mean ? cell : best,
);
const [peakLat, peakLon] = cellToLatLng(peak.h3_index);
const gaps = [
  ['eastAsia', 'East Asia'],
  ['northernEurasia', 'northern Eurasia'],
  ['oceania', 'Oceania'],
  ['americas', 'the Americas'],
]
  .filter(([key]) => unknownShare(BOX[key]) > 0.5)
  .map(([, name]) => name);
const list = (names) =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const count = new Intl.NumberFormat('en-GB').format(decodedSurveys.length);
const alt = [
  'Globe of the sickle-cell variant HbS.',
  `White points are ${count} measured surveys${
    surveyShare > 0.5
      ? ', most in Africa, the Mediterranean, the Middle East and India'
      : ''
  }.`,
  `Modeled frequency is highest, about ${Math.round(domain[1] * 100)} percent, in parts of ${
    inBox([peakLon, peakLat], BOX.centralAfrica) ? 'Central Africa' : 'Africa'
  }, and fades with distance from surveys.`,
  gaps.length ? `Much of ${list(gaps)} has no estimate.` : '',
]
  .filter(Boolean)
  .join(' ');

const topAreas = decodedGlobe
  .map((area, index) => ({ area, index }))
  .filter(({ area }) => area.mean !== null)
  .sort((a, b) => b.area.mean - a.area.mean || a.index - b.index)
  .slice(0, 10)
  .map(({ area }) => ({
    lat: round(area.center[1], 1),
    lon: round(area.center[0], 1),
    mean: round(area.mean, 4),
    lo: round(area.lo, 4),
    hi: round(area.hi, 4),
    nearest_survey_km: area.distanceKm,
  }));
const thresholds = [0.05, 0.1, 0.15].map((t) => ({
  threshold: t,
  confidently_above: decodedRegion.filter(
    (area) => area.lo !== null && area.lo >= t,
  ).length,
  possibly_above: decodedRegion.filter(
    (area) => area.mean !== null && area.mean >= t && area.lo < t,
  ).length,
}));

/* ---------- write ---------- */

const out = path.resolve(website, args.out);
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out))
  if (
    /^hbs-(globe|region|surveys|globe-poster)\.[0-9a-f]{16}\.(bin|svg)$/.test(
      name,
    )
  )
    rmSync(path.join(out, name));

const files = {};
for (const [key, prefix, extension, bytes, records] of [
  ['globe', 'hbs-globe', 'bin', globeBytes, decodedGlobe.length],
  ['region', 'hbs-region', 'bin', regionBytes, decodedRegion.length],
  ['surveys', 'hbs-surveys', 'bin', surveyBytes, decodedSurveys.length],
  ['poster', 'hbs-globe-poster', 'svg', posterBytes, null],
]) {
  const digest = sha256(bytes);
  const name = `${prefix}.${digest.slice(0, 16)}.${extension}`;
  const gzip = gzipSync(bytes, { level: 9 }).length;
  if (gzip > BUDGET_GZIP[key])
    fail(`${name} is ${gzip} B gzip, over its ${BUDGET_GZIP[key]} B budget`);
  writeFileSync(path.join(out, name), bytes);
  files[key] = {
    name,
    bytes: bytes.length,
    gzip_bytes: gzip,
    sha256: digest,
    records,
  };
}

const provenance = {
  generated_by: 'website/scripts/build-site-figures.mjs',
  artifact_id: entry.id,
  variant_id: entry.variant_id,
  label: entry.label,
  model_version: entry.model_version,
  data_version: entry.data_version,
  hf_dataset: entry.hf_dataset,
  hf_revision: entry.hf_revision,
  observations_sha256: entry.observations_sha256,
  surface_sha256: entry.surface_sha256,
  source_resolution: entry.resolution,
  resolutions: { globe: GLOBE_RES, region: REGION_RES },
  region_window: REGION_WINDOW,
  correlation_range_km: rho,
  tier_limits_km: {
    strong: round(encoding.TIER_LIMITS.strong * rho, 1),
    partial: round(encoding.TIER_LIMITS.partial * rho, 1),
    weak: round(encoding.TIER_LIMITS.weak * rho, 1),
  },
  metric_domain: { post_mean: domain },
  coarsening: {
    mean: 'mean of child post_mean',
    range: 'lowest child q025 to highest child q975',
    support: 'majority of children; ties toward the less certain class',
    distance: 'median child dist_nearest_obs_km',
  },
  stud_an_steps: encoding.STUD_AN_STEPS,
  rest: { ...REST, visible_cosc: VISIBLE_COSC },
  poster: {
    size: POSTER.size,
    radius: POSTER.radius,
    colour_bins: poster.bins,
  },
  files,
  counts: {
    surveys: decodedSurveys.length,
    globe_areas: decodedGlobe.length,
    region_areas: decodedRegion.length,
    model_cells: cells.length,
  },
  callouts,
  alt,
  table: {
    top_areas: topAreas,
    model_cell_share_by_tier: tierShare,
    region_thresholds: thresholds,
  },
};
writeFileSync(
  path.join(out, 'hbs.provenance.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
);

console.log(
  [
    `globe ${decodedGlobe.length} areas, ${files.globe.gzip_bytes} B gzip`,
    `region ${decodedRegion.length} areas, ${files.region.gzip_bytes} B gzip`,
    `surveys ${decodedSurveys.length}, ${files.surveys.gzip_bytes} B gzip`,
    `poster ${poster.bins} bins, ${files.poster.gzip_bytes} B gzip`,
    `callouts: ${surveyCallout.survey.ac} of ${surveyCallout.survey.an}; ` +
      `${pct(meanCallout.area.mean)}% (${pct(meanCallout.area.lo)}–${pct(meanCallout.area.hi)}%); ` +
      `unknown at ${unknownCallout.area.center.map((v) => v.toFixed(1)).join(', ')}`,
  ].join('\n'),
);
