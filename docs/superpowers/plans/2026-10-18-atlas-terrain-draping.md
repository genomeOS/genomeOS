# Atlas Terrain Draping (#483) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under Cesium World Terrain, drape the Atlas data (surface, support masks, cell outlines, country borders, sampling footprints) onto the ground as worker-rasterised imagery layers, ground the symbols, labels and highlight, and light it all with a hillshade, while the default smooth globe stays exactly as it is.

**Architecture:** The data worker rasterises H3 cells and lines into 256 × 256 geographic tiles. A lazily loaded main-thread runtime serves them to Cesium as four ordered imagery layers (`atlas-surface`, `atlas-outlines`, `atlas-borders`, `atlas-footprints`), so Cesium handles terrain level of detail, scene modes, morphs, relief and lighting. A `DrapedSurfaceGroup` implements the existing surface-group contract, so `ScientificLayers` keeps its epochs, cache and `animateSwap`. Symbols, labels and the highlight follow `globe.getHeight`. Four stacked PRs build on terrain PR 1 (`fix/terrain-visibility`).

**Tech Stack:** TypeScript, Astro + React, CesiumJS 1.145, `h3-js`, a module Web Worker (`ImageData` → `createImageBitmap`), Vitest (Node), Playwright (desktop-chromium and mobile-chromium projects).

**Spec:** `docs/superpowers/specs/2026-10-18-atlas-terrain-draping-design.md` (draping design). Also read `docs/superpowers/specs/2026-09-07-cesium-explorer-interaction-design.md` §5.2 (PR 1's terrain amendment) and `AGENTS.md`.

## Global Constraints

Every task's requirements include this section. Paths are under `website/` (`src/atlas/…`, `src/components/atlas/…`, `tests/…`).

**Base and phases**
- Base: PR 1, branch `fix/terrain-visibility`, head `d00d3f5` (not the skeleton's `bfb87a3`: `b179e51`, `08597a5` and `d00d3f5` follow it). Line numbers for existing files are at `d00d3f5`; later phases shift them, so locate each edit by the symbol named with it.
- Four PRs, stacked: `feat/atlas-drape-1` (Tasks 1–5) → `feat/atlas-drape-2` (6–17) → `feat/atlas-drape-3` (18–26) → `feat/atlas-drape-4` (27–36). Each is based on the previous phase's branch, retargeted to `main` when its base merges.
- Cesium `1.145.0`. Engine source for reference, read only: `/Users/bschilder/Desktop/genomeOS/.claude/worktrees/atlas-fast-load-b/website/node_modules/@cesium/engine/Source`.

**Owner decisions and PR 1 (binding; they override the spec where it differs)**
- Hillshade lighting whenever World Terrain is on the globe. Day/night applies only to the smooth globe. The spec's "with day/night on, the light is SunLight" is void.
- PR 1's Relief control replaces the spec's `terrainExaggeration`: URL param `relief`, `RELIEF_RANGE = [1, 10]`, `RELIEF_STEP = 0.5`, default 1, label "Physical relief ×", drawn through `effectiveRelief` (1 on the smooth globe and in the 2D map). The spec's cap of 5 has no technical basis: Cesium's per-tile normal rebuild runs for any value ≠ 1, and `effectiveRelief` already keeps the smooth globe at 1.
- A 1 s fade replaces the radial reveal wave under World Terrain; the smooth globe keeps the wave.
- Data elevation is off under World Terrain. The URL keeps `elevation` and `exaggeration`; the control shows "Not available with World Terrain"; extruded draws as hexagons, its option labelled "Columns (smooth globe only)".
- A cold load with `terrain=world-terrain` drapes on the URL's word: the draped pipeline is built directly, never the chunks first.
- World Terrain may be desktop-only if phones still miss the 96 MiB budget after the fallbacks, with a note saying why.

**When draped**
- Scene rule: `hasPhysicalRelief(requested terrain)` from the moment `setTerrain` is called; when the newest request settles, `hasPhysicalRelief(applied terrain)`.
- UI rule (controls): `hasPhysicalRelief(appliedTerrain)`, the terrain MapStyleControls already follows.
- Picks: `SurfacePickContext.draped()` is `hasPhysicalRelief(applied) && elevationFactor === 0`; a displayed draped group sets `PickTarget.draped`.

**The smooth globe does not change** in look, bytes or timings. Every new branch keys on the rules above. Its asserted budgets stay: surface visible ≤ 2.5 s desktop, ≤ 6 s mobile Fast 4G, ≤ 17.5 s slow profile; reveal ≤ 1.1 s; long frames ≤ 200 / 800 ms; warm switch < 2 s; ≥ 45 fps; the Cesium chunk gzip pin.

**Lighting under World Terrain**
- Azimuth 315° and intensity 2 (PR 1). Elevation 45° at the view target, with PR 1's horizon rule (horizon + 10°).
- The light swings towards a headlight from 500 km (weight 0) to 5,000 km (weight 1): `camera.directionWC` in 3D, overhead at the target in 2D and Columbus view.
- `vertexShadowDarkness` 0.45, rising to 1 over PR 1's 1,000–3,000 km fade (unlit beyond 3,000 km). `lambertDiffuseMultiplier` 0.9.
- Ground atmosphere and water effect off while `layers.surface || layers.support`; never switched on if the smooth globe had them off.

**Tiles and layers**
- 256 × 256 RGBA on `GeographicTilingScheme` (two 180° roots, y counted from the north), levels 0–11, rows south-first (texel offset `(row × 256 + column) × 4`, row 0 southernmost).
- Empty tile: one shared 1 × 1 transparent canvas. Drawn tile: a transferred `ImageBitmap` made with `{ imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }`.
- Layer order, bottom to top: basemap, `atlas-surface`, `atlas-outlines`, `atlas-borders`, `atlas-footprints`.
- `RESIDENT_TILE_BYTES = 349_525` (256² × 4 × 4/3).

**Values**

| Item | Value |
|---|---|
| Surface layer α | 0.9 × surfaceOpacity × opacity() × progress(); 0 with both cell sets off |
| Outlines layer α | `cellEdges && cells.supported ? opacity() × progress() : 0` |
| Outline texels | α 0.92, width 1.5 → 2 texels linear over levels 3 → 11, none below level 3 |
| Mask texels | material α ÷ 0.9 (the layer scales by 0.9) |
| Honmoon fill (P2) | rgb × 0.55, α 0.28 |
| Honmoon contours (P4) | 36 bands, derivative clamp [0.006, 0.22] |
| Borders | 1.65 texels, opaque, layer α = `countryOpacity`, `maximumLevel` 11 (10 in mobile fallback 3) |
| Footprints | 2 texels, α 0.9, 48-segment rings |
| Labels | `RELATIVE_TO_GROUND`, 2,500 m |
| Symbols | ground + 650 + 7,000 m |
| Highlight ring | ground + 300 m, 16 points per edge |
| Ready | `globe.tilesLoaded`, or `DRAPED_READY_CAP_MS = 3_000` |
| Restyle | today's 300 ms `animateSwap`; the outgoing draped layer stays opaque until retired |
| Reveal | 1 s fade on the RevealWave timeline (`REVEAL_WAVE_MS = 1_000`, `waveEase`); reduced motion and hidden tabs show at once |
| Ground resample | `GROUND_RESAMPLE_MS = 50`; `final` on drag end, `morphComplete` and an empty tile queue |
| Pre-warm (P4) | one frame at α 0.001 |
| In-flight tiles per provider | `RASTER_MAX_IN_FLIGHT = 8` |

**World Terrain budgets** (`atlas-terrain-performance.spec.ts`; report-only in P2–P3, asserted in P4 on hardware GPUs): data visible ≤ 2 s after the terrain switch; restyles ≤ 2 s to `tilesLoaded`; ≥ 45 fps orbiting; long frames ≤ 200 ms desktop, ≤ 800 ms mobile ×4; raster p95 ≤ 2 ms per tile at level ≥ 3; resident Atlas imagery ≤ 160 MiB desktop (167,772,160 B, 480 tiles) and ≤ 96 MiB on coarse pointers (100,663,296 B, 288 tiles). Mobile fallbacks, in order, only while over budget: `tileCacheSize` 100 → 50 (floor 25); outlines merged into the surface texture; borders capped at level 10; World Terrain desktop-only.

**Code rules**
- Lazy: `scene/draped/*`, `geometry/raster/*` and `worker/raster-handlers.ts` load only through `import()`; main-thread code outside them imports only their types. The markers `'atlas-draped-v1'` (`DrapedRuntime.version`) and `'atlas-raster-v1'` (`RasterRuntime.version`) appear in no /app/ initial chunk and nowhere in the worker's first load. No production chunk contains the synthetic terrain.
- No silent gaps (AGENTS.md: schema violations are hard errors). A raster or provider error reverts to the smooth globe with `DRAPE_FAILED_WARNING` under warning id `'drape'`. No row is dropped (the coverage test). These throw: a non-`#rrggbb` colour, a border segment jumping > 180° of longitude, footprint circles that are not finite `lon, lat, radius_km > 0` triples, ground heights whose length differs from the observation count, a border tile above `maximumLevel`, `contours: true` on a non-Honmoon geometry.
- Science: terrain height never enters the metric; contours read only the normalised value.
- Determinism: nothing is stochastic; rasters are byte-identical on repeat, so no `SEED`.
- Fixture: PR 1's `window.__atlasSyntheticTerrain` flag, passed through `ContextControllerOptions.worldTerrain`; there is no `__atlasTerrainFixture()`. `SYNTHETIC_PEAK = { lat: 40.419, lon: -3.709, peakMetres: 6_000, sigmaKm: 40 }` stands under the HbS Spain survey `map-surveys:1135` (population label "Spain", `radius_km` 1.7841241161527712); its res-4 cell is `84390cbffffffff`.
- Size: `src/components/atlas/AtlasExplorer.tsx` is untouched (726 of 755 logical, 784 physical lines). `scene/scientific-layers.ts` stays ≤ 986 logical lines from Task 11 on. New production modules target ≤ 500 logical lines; split at 800.
- Docstrings: each new or changed module docstring cites the draping design by heading, e.g. `terrain draping design, "Per layer under World Terrain" (#483)` (the spec has no section numbers), plus `Atlas design §11` for scene modules.
- URL params the tests use: `entity`, `version`, `metric`, `palette`, `opacity` ([0.2, 1], default 0.58), `geometry` (not `surfaceGeometry`), `edges` (default true), `edgeColor`, `edgeFixed`, `countryColor`, `countryOpacity`, `dayNight`, `layers` (comma list of `surface,observations,support,context,countries`), `view`, `terrain`, `relief`, `elevation`, `exaggeration`, `obsShape` (`circle|hemisphere|sphere|pin`), `obsSize`, `pointMin`, `pointMax`, `samplingColor`, `samplingAreas`, `lon`, `lat`, `height`, `heading`, `pitch`.
- Commits: each message contains `advances #483` (in the subject or as its own paragraph) and ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies for phases 1–3 say "advances #483"; phase 4's says "closes #483". PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Gates, per phase and in this order (vitest's `globalSetup`, `tests/setup/build.ts`, rebuilds a production `dist/`): `npm run format:check`; `npm run check` (0 errors); `npm test`; then `PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ PUBLIC_GA_MEASUREMENT_ID=G-TEST123 npm run build:e2e` before any Playwright run. Arm a CI watch on each PR and fix failures at once.

## Review Focus

The five failure modes most likely to bite a user that the spec's own test plan does not exercise. Each test sits in the task that owns the code.

1. **World Terrain flipped World → Smooth → World, or "Retry globe", while rasters and draped layers are still preparing.** The newest choice wins, no imagery layer is left on the globe, and every worker raster is released. Tests: Task 16 "keeps the newest of rapid World Terrain, smooth and World Terrain requests"; Task 11 "destroys a superseded draped group that was never shown"; Task 9 "releases its raster once, drops later requests and raises nothing after destroy"; Task 23 "drops a border layer still preparing when a newer call supersedes it"; Task 24 "drops footprints still preparing when the terrain goes smooth".
2. **World Terrain requested but slow or failing to reach the globe** (ion down, no token, a cold load with `terrain=world-terrain`). Picks stay on the smooth path until the terrain is on the globe, and a failed load builds the chunks once, with the warning. Tests: Task 4 "keeps the smooth pick while a requested World Terrain has not reached the globe"; Task 16 "falls back to chunks when World Terrain fails to load: one rebuild back".
3. **A cold draped load under reduced motion or in a hidden tab.** The data shows at once and is never stuck at α 0. Tests: Task 11 "shows a cold draped surface at once under reduced motion" and "reads progress 1 under reduced motion and once a hidden tab ends the wave"; Task 14 "shows at once when the wave rests".
4. **Dragging Physical relief ×.** Symbols and the highlight end on the new ground, not on the heights read before the frame that applied the new exaggeration (Cesium re-exaggerates loaded tiles only in the next render). Tests: Task 25 "resamples the ground after the frame that applies relief, and once more when the slider rests"; Task 26 relief 6 → 10.
5. **A draped surface with nothing to draw** (every cell unknown with support off, or both cell layers off). No layer is added, the wave reads done, and `surface-visible` still fires so the borders load. Tests: Task 11 "commits a draped surface with nothing to draw, ends its wave and still reads surface-visible"; Task 14 "adds no layer for a raster with nothing to draw, and is ready at once".

Each phase also lists the reviewer checks specific to its PR.

## Execution and parallelism

```
P1: [1 ∥ 2 ∥ 3] → 4 → 5
P2: 6 → [7 ∥ 9 ∥ 10 ∥ 11] → [8, 12, 13 after 7; 14 after 9] → 15 → 16 → 17
P3: [18 ∥ 20 ∥ 21 ∥ 22 ∥ 23] → 19 (after 18) → 24 → 25 → 26
P4: [27 ∥ 29 ∥ 30] → 28 (after 27) → 31 → 32? → 33? → 34? → 35? → 36   (? = only while phones are over budget)
```

| Phase | Parallel group (one git worktree per task, off the phase branch) | Then, on the merged phase branch |
|---|---|---|
| P1 | Tasks 1, 2, 3 | 4 (needs 1, 2), 5 (needs 3, 4) |
| P2 | after 6: Tasks 7, 9, 10, 11; as soon as 7 merges: 8, 12, 13; as soon as 9 merges: 14 | 15 (needs 8, 12, 13), 16 (needs 10, 11, 14, 15), 17 |
| P3 | Tasks 18, 20, 21, 22, 23; 19 once 18 merges | 24 (needs 20, 22, 23), 25 (needs 20, 21, 23, 24), 26 |
| P4 | Tasks 27, 29, 30; 28 once 27 merges | 31 (needs 28, 29, 30), then 32–35 in order while needed, then 36 |

- Isolation: each parallel task runs in its own worktree (superpowers:using-git-worktrees) branched from the phase branch at the commit its dependencies merged; merge back in task-number order and run the phase's integration tasks (5, 15–17, 24–26, 31, 36) on the merged branch.
- Early starts: pure lanes may branch from Task 6 (types only) before P2 finishes: Tasks 20, 21 and 22 (P3) and 27 and 30 (P4). They still merge into their own phase.
- Hot files (`scene/atlas-scene.ts`, `scene/scientific-layers.ts`, `worker/protocol.ts`, `e2e-hooks.ts`, `playwright.config.ts`): no two tasks in one parallel group edit the same one. Owners: Task 2 (scientific-layers), 3 (e2e-hooks), 4 (atlas-scene), 5 (playwright.config); 6 (protocol); 11 (scientific-layers); 16 (atlas-scene, scientific-layers, e2e-hooks); 17 (e2e-hooks, playwright.config); 24 (scientific-layers); 25 (atlas-scene); 26 (e2e-hooks).
- Shared test helpers: `tests/atlas-terrain-helpers.ts` (Task 5 creates; 17, 26, 31 extend), `tests/helpers/raster-fixtures.ts` (7 creates; 12 extends), `tests/helpers/imagery-fakes.ts` (9 creates), `tests/helpers/draped-fakes.ts` (11 creates; 23 extends).

---

## Phase 1: Harness, lighting and picking (Tasks 1–5)

**Branch:** `feat/atlas-drape-1` from `origin/fix/terrain-visibility` at `d00d3f5`. One PR, based on `fix/terrain-visibility` until PR 1 merges, then on `main`.

**What ships.** With World Terrain on, users get the draping design's hillshade: a 45° light that swings to a headlight from far out, legend colours on flat ground, and no atmosphere or water tint over the data. Picks name the cell on the rendered ground under the cursor. The e2e harness gains a Gaussian peak under supported HbS cells and the #483 repro, which stays under `test.fail` until Task 17 drapes the data.

### Phase 1 decisions (checked against the code)

1. **`SYNTHETIC_PEAK` stands at Madrid, not Kenya.** The e2e grid (`tests/fixtures/atlas/e2e/grids/h3-r4.ccbf19c4a606d017.gosa`) holds 256 res-4 cells spread across the globe. None of the 11 res-4 cells within 80 km of the Kenya survey (−1.836, 36.793) is in it. The Spain survey `map-surveys:1135` (40.419, −3.709) has all 10 cells within 80 km supported in the `hbs-rs334` render tier (5 observed, 5 interpolated).
2. **`resolveDrapedPick` needs `mapProjection`.** `Globe.pick` reads `scene.mode` and `scene.mapProjection` (Globe.js:740-741, :823-831), and its `.d.ts` takes a full `Scene`. Use `DrapedPickScene = Pick<Scene, 'camera' | 'globe' | 'mapProjection' | 'mode'>` with one documented cast at the call; `DepthPickScene` gains `'globe'`.
3. **The headlight is Earth-fixed only in 3D.** A `DirectionalLight` direction is ECEF in every mode (UniformState.js:1517-1526); `camera.directionWC` is in the projected frame in 2D and Columbus view (Camera.js:700-713). So the headlight is `camera.directionWC` in `SCENE3D` and overhead at the view target elsewhere; `ShadingScene` gains `readonly mode: SceneMode`.
4. **The reveal check stays for chunk groups.** In phase 1 the chunk group still runs the radial wave under terrain, so the draped branch applies `context.reveal` when `!target.draped`. A draped group (Task 11) skips it.
5. **`SurfacePickContext.draped` lands optional (Task 2) and becomes required (Task 4)**, so every commit type-checks.
6. No change needed, recorded for reviewers: `HILLSHADE_DIFFUSE_MULTIPLIER = 0.9` is Cesium 1.145's default (Globe.js:176); setting and restoring it pins the value without changing the image.

### Phase 1 reviewer checks

- World Terrain requested but not on the globe: smooth picks (Task 4).
- Data elevation on under World Terrain: the lifted surface keeps the depth pick (Task 4).
- A frame mid-morph (NaN height, no target): the light keeps its last finite direction (Task 1).
- Surface toggled under World Terrain, then back to smooth: atmosphere and water return to the smooth globe's own values, never switched on (Task 1).
- Hover over terrain with no data: the branch runs on every hover and returns null (Task 2).

---

### Task 1: Lighting, the draping design's hillshade terms

**Parallel:** yes, with Tasks 2 and 3.

**Files:**
- Modify: `src/atlas/scene/scene-policy.ts:12-27` (doc, constants), `:29-49` (`TerrainLighting`, `terrainLighting`), `:51-68` (doc 35° → 45°), `:70-104` (`HILLSHADE_SHADOW_DARKNESS` and its doc)
- Modify: `src/atlas/scene/terrain-shading.ts:1-18` (docstring), `:43-67` (`ShadingScene`), `:69-76` (`TerrainPresentation`), `:78-93` (`Hillshade`), `:100-105` (default presentation), `:113-131` (`update`), `:139-171` (install and remove), `:177-219` (`#follow`)
- Modify: `docs/superpowers/specs/2026-09-07-cesium-explorer-interaction-design.md:232-248` (the §5.2 amendment)
- Test: `tests/atlas-terrain-shading.test.ts`

**Interfaces:**
- Consumes PR 1's `hasPhysicalRelief(terrain)`, `hillshadeDirection(lon, lat, azimuth, elevation): [number, number, number]`, `hillshadeElevationDegrees(h)`, `hillshadeShading(h): HillshadeShading`, `HILLSHADE_FADE_METRES`, `HILLSHADE_AZIMUTH_DEGREES` and `TerrainShading`.
- Produces:
```ts
// scene-policy.ts
export const HILLSHADE_ELEVATION_DEGREES = 45;           // was 35
export const HILLSHADE_SHADOW_DARKNESS = 0.45;           // was 0.3; PR 1's fade to 1 kept
export const HILLSHADE_DIFFUSE_MULTIPLIER = 0.9;
export const HILLSHADE_HEADLIGHT_METRES = [500_000, 5_000_000] as const;
export function hillshadeHeadlightWeight(heightMetres: number): number; // 0 ≤ 500 km, linear, 1 ≥ 5,000 km; NaN → 1
export interface TerrainLighting { enableLighting: boolean; light: 'sun' | 'hillshade'; groundAtmosphere: boolean; waterEffect: boolean }
export function terrainLighting(i: { dayNight: boolean; terrain: TerrainId; surfaceShown: boolean }): TerrainLighting;
// terrain-shading.ts
interface ShadingScene { /* PR 1 */ readonly mode: SceneMode;
  globe: { /* PR 1 */ lambertDiffuseMultiplier: number; showGroundAtmosphere: boolean; showWaterEffect: boolean } }
interface TerrainPresentation { /* PR 1 */ surfaceShown: boolean } // default true
```
`groundAtmosphere` and `waterEffect` say whether the effect *may* show; `TerrainShading` ANDs each with the value the globe had when the hillshade was installed.

- [ ] **Step 1: Write the failing tests**

Edit existing assertions:
- `hillshadeDirection` test (:71-84): rename to "…45° above the horizon…"; use `toBe(45)`, `hillshadeDirection(lon, lat, 315, 45)` and `Math.sin(45 * DEGREE)`.
- :103-106: rename to `'holds 45° wherever relief is visible'`, heights `[0, 1_000, 17_000, 200_000, 500_000, 1_000_000]`, `toBe(45)`.
- :109: the starting `previous` becomes `45`.
- :121-141: rename to `"shades fully up to 1,000 km, with shadow darkness 0.45"`; expect `HILLSHADE_SHADOW_DARKNESS` to be `0.45`, `0.45` wherever `0.3` appears, and the 2,000 km value `toBeCloseTo(0.725, 12)`.
- `fakeScene` (:154-193): `scene` gains `mode: SceneMode.SCENE3D as SceneMode`; `globe` gains `lambertDiffuseMultiplier: 0.9, showGroundAtmosphere: true, showWaterEffect: true`; `camera.directionWC` becomes a mutable `Cartesian3`.
- `expectDirection` (:199): default elevation `45`.
- :257-264: at 16,500 km the light is the line of sight: `expectVector((scene.light as DirectionalLight).direction, camera.directionWC)`.
- :285, :290, :303: expect `0.45`, `0.725`, `0.45`.

Add:
```ts
function expectVector(actual: Cartesian3, expected: Cartesian3) {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 9);
}
const down = (lon: number, lat: number) => new Cartesian3(...up(lon, lat).map((v) => -v));

describe('terrainLighting (draping design)', () => {
  it('lights World Terrain with the hillshade, without atmosphere or water while the surface shows', () => {
    for (const dayNight of [true, false])
      expect(terrainLighting({ dayNight, surfaceShown: true, terrain: 'world-terrain' })).toEqual({
        enableLighting: true, groundAtmosphere: false, light: 'hillshade', waterEffect: false });
  });
  it('allows the atmosphere and water on World Terrain while no surface shows', () => {
    expect(terrainLighting({ dayNight: true, surfaceShown: false, terrain: 'world-terrain' })).toEqual({
      enableLighting: true, groundAtmosphere: true, light: 'hillshade', waterEffect: true });
  });
  it('keeps the smooth globe on the real-time sun, lit only when day/night is on', () => {
    for (const surfaceShown of [true, false])
      for (const dayNight of [true, false])
        expect(terrainLighting({ dayNight, surfaceShown, terrain: 'smooth-globe' })).toEqual({
          enableLighting: dayNight, groundAtmosphere: true, light: 'sun', waterEffect: true });
  });
});

describe('hillshadeHeadlightWeight', () => {
  it('is 0 up to 500 km, 1 from 5,000 km (and mid-morph), linear between', () => {
    expect(HILLSHADE_HEADLIGHT_METRES).toEqual([500_000, 5_000_000]);
    for (const h of [-50, 0, 200_000, 500_000]) expect(hillshadeHeadlightWeight(h)).toBe(0);
    expect(hillshadeHeadlightWeight(2_750_000)).toBeCloseTo(0.5, 12);
    for (const h of [5_000_000, 1.65e7, 1.9e7, Number.NaN]) expect(hillshadeHeadlightWeight(h)).toBe(1);
  });
});

describe('TerrainShading, draping design terms', () => {
  it("sets the hillshade terms under World Terrain and restores the globe's own on the smooth globe", () => {
    const { scene } = fakeScene();
    scene.globe.lambertDiffuseMultiplier = 0.7;
    const shading = new TerrainShading(scene);
    shading.update({ terrain: 'world-terrain' });
    expect(HILLSHADE_DIFFUSE_MULTIPLIER).toBe(0.9);
    expect(scene.globe).toMatchObject({ lambertDiffuseMultiplier: 0.9, showGroundAtmosphere: false,
      showWaterEffect: false, vertexShadowDarkness: 0.45 });
    shading.update({ surfaceShown: false });
    expect(scene.globe).toMatchObject({ showGroundAtmosphere: true, showWaterEffect: true });
    shading.update({ surfaceShown: true });
    expect(scene.globe).toMatchObject({ showGroundAtmosphere: false, showWaterEffect: false });
    shading.update({ terrain: 'smooth-globe' });
    expect(scene.globe).toMatchObject({ lambertDiffuseMultiplier: 0.7, showGroundAtmosphere: true,
      showWaterEffect: true, vertexShadowDarkness: 0.3 });
  });

  it('never turns on an atmosphere or water effect the smooth globe had off', () => {
    const { scene } = fakeScene();
    Object.assign(scene.globe, { showGroundAtmosphere: false, showWaterEffect: false });
    const shading = new TerrainShading(scene);
    shading.update({ surfaceShown: false });
    shading.update({ terrain: 'world-terrain' });
    expect(scene.globe).toMatchObject({ showGroundAtmosphere: false, showWaterEffect: false });
    shading.update({ terrain: 'smooth-globe' });
    expect(scene.globe).toMatchObject({ showGroundAtmosphere: false, showWaterEffect: false });
  });

  it('keeps flat ground at the legend colour under a nadir camera up to 3,000 km (GlobeFS.glsl:432)', () => {
    for (const height of [1_000, 200_000, 500_000, 1_000_000, 2_000_000, 2_999_000]) {
      const { camera, scene } = fakeScene({ lat: 40.419, lon: -3.709 }, height);
      camera.directionWC = down(-3.709, 40.419);
      new TerrainShading(scene).update({ terrain: 'world-terrain' });
      const { x, y, z } = (scene.light as DirectionalLight).direction;
      const lambert = -dot([x, y, z], up(-3.709, 40.419));
      expect(lambert * scene.globe.lambertDiffuseMultiplier + scene.globe.vertexShadowDarkness)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it('swings the light towards the line of sight from 500 km, reaching it at 5,000 km', () => {
    const { camera, moveTo, scene } = fakeScene();
    const sight = Cartesian3.normalize(new Cartesian3(-1, -2, -3), new Cartesian3());
    camera.directionWC = sight;
    new TerrainShading(scene).update({ terrain: 'world-terrain' });
    moveTo(38.75, 9.03, 2_750_000);
    const hill = new Cartesian3(...hillshadeDirection(38.75, 9.03, 315, hillshadeElevationDegrees(2_750_000)));
    const half = Cartesian3.normalize(Cartesian3.add(hill, sight, new Cartesian3()), new Cartesian3());
    expectVector((scene.light as DirectionalLight).direction, half);
    moveTo(38.75, 9.03, 5_000_000);
    expectVector((scene.light as DirectionalLight).direction, sight);
  });

  it('swings towards overhead in 2D and Columbus view, whose camera directions are not Earth-fixed', () => {
    for (const [mode, view] of [[SceneMode.COLUMBUS_VIEW, 'perspective'], [SceneMode.SCENE2D, 'map']] as const) {
      const { moveTo, scene } = fakeScene();
      scene.mode = mode;
      new TerrainShading(scene).update({ mode: view, terrain: 'world-terrain' });
      moveTo(38.75, 9.03, 5_000_000);
      expectDirection(scene.light, 38.75, 9.03, 90);
    }
  });

  it('keeps the hillshade when the line of sight opposes it exactly', () => {
    const { camera, moveTo, scene } = fakeScene();
    const elevation = hillshadeElevationDegrees(2_750_000);
    const hill = hillshadeDirection(38.75, 9.03, 315, elevation);
    camera.directionWC = new Cartesian3(-hill[0], -hill[1], -hill[2]);
    new TerrainShading(scene).update({ terrain: 'world-terrain' });
    moveTo(38.75, 9.03, 2_750_000);
    expectDirection(scene.light, 38.75, 9.03, elevation);
  });

  it('keeps a finite light mid-morph, when the camera has no height and the view no target', () => {
    const { camera, preRender, scene } = fakeScene();
    new TerrainShading(scene).update({ terrain: 'world-terrain' });
    const before = Cartesian3.clone((scene.light as DirectionalLight).direction);
    scene.mode = SceneMode.MORPHING;
    camera.pickEllipsoid.mockReturnValue(undefined as never);
    camera.positionCartographic = new Cartographic(Number.NaN, Number.NaN, Number.NaN);
    preRender.raiseEvent();
    expect(Cartesian3.equals((scene.light as DirectionalLight).direction, before)).toBe(true);
    expect(scene.globe.enableLighting).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-terrain-shading.test.ts`
Expected: FAIL, with `hillshadeHeadlightWeight is not a function`, `expected 35 to be 45` and `expected 0.3 to be 0.45`.

- [ ] **Step 3: Implement the `scene-policy.ts` changes**

Constants and `hillshadeHeadlightWeight` per the Interfaces block; `terrainLighting` is fixed by the tests. Docs: 45° holds up to about 1,410 km, where `acos(R/(R+h)) + 10° = 45°`; `sin 45° × 0.9 + 0.45 ≥ 1`, so flat, sunward ground keeps the exact legend colour; cite `terrain draping design, "Per layer under World Terrain" (#483)`.

- [ ] **Step 4: Implement the `terrain-shading.ts` changes**

- `#installHillshade` saves `lambertDiffuseMultiplier`, `showGroundAtmosphere` and `showWaterEffect`, then sets `HILLSHADE_DIFFUSE_MULTIPLIER`.
- While installed, `update` writes `globe.showGroundAtmosphere = lighting.groundAtmosphere && saved.groundAtmosphere`, and the same for the water effect.
- `#removeHillshade` restores all three. The smooth globe still writes only `enableLighting`.

In `#follow`, after the target is resolved, this blend replaces the final aim (:200-218):
```ts
const weight = hillshadeHeadlightWeight(height);
const [x, y, z] = hillshadeDirection(lon, lat, HILLSHADE_AZIMUTH_DEGREES, hillshadeElevationDegrees(height));
// Light directions are Earth-fixed in every mode (UniformState.js:1517-1526); the camera's only in
// 3D (Camera.js:700-713), so 2D and Columbus view swing towards overhead at the target instead.
const head = scene.mode === SceneMode.SCENE3D
  ? camera.directionWC
  : Cartesian3.fromArray(hillshadeDirection(lon, lat, HILLSHADE_AZIMUTH_DEGREES, 90), 0, scratchHead);
const aim = weight >= 1
  ? Cartesian3.clone(head, scratchAim)
  : Cartesian3.fromElements(x + weight * (head.x - x), y + weight * (head.y - y), z + weight * (head.z - z), scratchAim);
if (![aim.x, aim.y, aim.z].every(Number.isFinite)) return;              // mid-morph: keep the last aim
if (Cartesian3.magnitudeSquared(aim) < 1e-12) Cartesian3.fromElements(x, y, z, aim); // opposed: hillshade
Cartesian3.normalize(aim, hillshade.light.direction);
```
Check finiteness before `normalize`: Cesium's debug build throws "normalized result is not a number".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-terrain-shading.test.ts`
Expected: PASS.

- [ ] **Step 6: Amend interaction design §5.2**

Add *Amended 2026-10-18 (#483, draping design)* to the paragraph at :232-248: 35° up to about 660 km becomes 45° up to about 1,410 km; from 500 km the light swings towards the camera's line of sight, reaching it at 5,000 km (overhead in 2D and Columbus view); shadow darkness 0.45 and diffuse 0.9 keep flat ground facing the light at the legend colour; ground atmosphere and water effect are off while a surface layer shows.

- [ ] **Step 7: Commit**
```bash
git add website/src/atlas/scene/scene-policy.ts website/src/atlas/scene/terrain-shading.ts \
  website/tests/atlas-terrain-shading.test.ts docs/superpowers/specs/2026-09-07-cesium-explorer-interaction-design.md
git commit -m "fix: light World Terrain by the draping design's hillshade terms" \
  -m "45° light blending to a headlight from 500 to 5,000 km (overhead in 2D and Columbus view), shadow darkness 0.45, diffuse 0.9, and no ground atmosphere or water effect while a surface layer shows." \
  -m "advances #483" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Draped pick branch

**Parallel:** yes, with Tasks 1 and 3.

**Files:**
- Modify: `src/atlas/scene/surface-pick.ts:1-25` (docstring paragraph citing `terrain draping design, "Picking"`), `:27-45` (imports: `latLngToCell`, `rowForH3`, `SurfacePick`), `:47-60` (`PickTarget`, `SurfacePickContext`), `:68-76` (`DepthPickScene` adds `'globe'`), `:211-221` (resolver entry)
- Modify: `src/atlas/scene/scientific-layers.ts:59` (imports), `:266-295` (`pickTarget`)
- Create: `tests/atlas-surface-pick-terrain.test.ts`
- Modify: `tests/atlas-picking.test.ts:54`, `:491`, `:556`, `:654`: each target gains `draped: false, drawn: () => true`.
- Modify: `tests/atlas-scientific-layers.test.ts`: a describe after the one ending at :543.

**Interfaces:**
- Consumes `preferredAtlasPick`, `rowForH3(surface, h3): number | null`, `isSupportedCode(code)` and `shown(group)` (scientific-layers.ts:166).
- Produces:
```ts
export interface PickTarget { artifactKey: string; surface: SurfaceArtifact; hidden: readonly { show: boolean }[];
  /** Supported rows need layers.surface, masked rows layers.support, and the group must be shown (α > 0). */
  drawn(row: number): boolean;
  /** The displayed group is draped imagery (false until Task 11). */
  draped: boolean }
export interface SurfacePickContext { /* existing */ draped?(): boolean } // required from Task 4
export type DrapedPickScene = Pick<Scene, 'camera' | 'globe' | 'mapProjection' | 'mode'>;
export function resolveDrapedPick(scene: DrapedPickScene, target: PickTarget, position: Cartesian2): SurfacePick | null;
```
- Resolver order: (1) an observation hit wins; (2) no target → null; (3) if `target.draped || context.draped?.()`, return `resolveDrapedPick(…)`, dropped when `!target.draped && context.reveal(cellDirection(h3Index)) <= 0`; (4) otherwise today's path, unchanged.
- `resolveDrapedPick`: `MORPHING` → null; otherwise `globe.pick(camera.getPickRay(p), scene)` → `latLngToCell(…, grid.resolution)` → `rowForH3` → `drawn(row)`. No 650 m clearance, no translucent depth pick.

- [ ] **Step 1: Write the failing tests**

In `tests/atlas-surface-pick-terrain.test.ts`:
```ts
const CELL = '84390cbffffffff'; // SYNTHETIC_PEAK's res-4 cell
const surface = columnarSurface([{ h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' }]);
const KEY = surface.artifactKey;
const [LAT, LON] = cellToLatLng(CELL);
const WINDOW = new Cartesian2(412, 288);
const GROUND = Cartesian3.fromDegrees(LON, LAT, 18_000);  // the summit at relief 3
const BEHIND = Cartesian3.fromDegrees(LON, LAT + 0.45);   // the ellipsoid ~50 km on: 84392b5ffffffff
const PICKED = { artifactKey: KEY, h3Index: CELL, kind: 'surface', row: rowForH3(surface, CELL) };

function fakeScene(mode: SceneMode = SceneMode.SCENE3D) {
  const ray = new Ray(Cartesian3.fromDegrees(LON, LAT - 2.2, 100_000), Cartesian3.UNIT_Z);
  return { camera: { getPickRay: vi.fn((_: Cartesian2) => ray as Ray | undefined), pickEllipsoid: vi.fn(() => BEHIND) },
    globe: { pick: vi.fn((_r: Ray, _s: unknown) => GROUND as Cartesian3 | undefined) },
    mapProjection: new GeographicProjection(), mode, pick: vi.fn(), pickPosition: vi.fn(), pickTranslucentDepth: false, ray };
}
const target = (o: Partial<PickTarget> = {}): PickTarget =>
  ({ artifactKey: KEY, draped: false, drawn: () => true, hidden: [], surface, ...o });
const context = (o: Partial<SurfacePickContext> = {}): SurfacePickContext =>
  ({ draped: () => true, factor: () => 0, geometry: () => 'triangles', metric: () => 'post_mean', target: () => target(), ...o });

describe('resolveDrapedPick (#483)', () => {
  it('resolves the cell on the rendered ground under the pointer', () => {
    const scene = fakeScene();
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toEqual(PICKED);
    expect(scene.camera.getPickRay).toHaveBeenCalledWith(WINDOW);
    expect(scene.globe.pick).toHaveBeenCalledWith(scene.ray, scene);
    expect(scene.camera.pickEllipsoid).not.toHaveBeenCalled();
  });
  it('resolves nothing while the scene morphs', () => {
    const scene = fakeScene(SceneMode.MORPHING);
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
    expect(scene.globe.pick).not.toHaveBeenCalled();
  });
  it('resolves nothing where the pointer misses the rendered ground', () => {
    const scene = fakeScene();
    scene.globe.pick.mockReturnValue(undefined);
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
    scene.camera.getPickRay.mockReturnValue(undefined);
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
  });
  it('resolves nothing over ground outside the grid', () => {
    const scene = fakeScene();
    scene.globe.pick.mockReturnValue(Cartesian3.fromDegrees(LON + 20, LAT, 300));
    expect(resolveDrapedPick(scene as never, target(), WINDOW)).toBeNull();
  });
  it('resolves nothing for a row the layers do not draw', () => {
    const drawn = vi.fn(() => false);
    expect(resolveDrapedPick(fakeScene() as never, target({ drawn }), WINDOW)).toBeNull();
    expect(drawn).toHaveBeenCalledWith(PICKED.row);
  });
  it('hands globe.pick the scene in 2D and Columbus view, which projects its hit back', () => {
    for (const mode of [SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW]) {
      const scene = fakeScene(mode);
      expect(resolveDrapedPick(scene as never, target(), WINDOW)).toEqual(PICKED);
      expect(scene.globe.pick).toHaveBeenCalledWith(scene.ray, scene);
    }
  });
});

describe('createSurfacePickResolver under World Terrain (#483)', () => {
  it('needs no surface chunk in the drill pick, since the ground can cover the surface', () => {
    const resolve = createSurfacePickResolver(fakeScene() as never, context());
    expect(resolve([], WINDOW)).toEqual(PICKED);
    expect(resolve([{ id: surfaceChunkPickId(KEY, 0) }], WINDOW)).toEqual(PICKED);
  });
  it('lets an observation hit win first', () => {
    const scene = fakeScene();
    const observation = observationPickId('map-surveys:1135', KEY);
    expect(createSurfacePickResolver(scene as never, context())([{ id: observation }], WINDOW)).toEqual(observation);
    expect(scene.globe.pick).not.toHaveBeenCalled();
  });
  it('uses neither the ellipsoid, the clearance nor the translucent depth pick', () => {
    const scene = fakeScene();
    createSurfacePickResolver(scene as never, context())([], WINDOW);
    expect(scene.camera.pickEllipsoid).not.toHaveBeenCalled();
    expect(scene.pickPosition).not.toHaveBeenCalled();
    expect(scene.pick).not.toHaveBeenCalled();
    expect(scene.pickTranslucentDepth).toBe(false);
  });
  it('takes the ground branch for a draped group on any terrain', () => {
    const resolve = createSurfacePickResolver(fakeScene() as never,
      context({ draped: () => false, target: () => target({ draped: true }) }));
    expect(resolve([], WINDOW)).toEqual(PICKED);
  });
  it('keeps the ellipsoid on the smooth globe', () => {
    const scene = fakeScene();
    scene.camera.pickEllipsoid.mockReturnValue(Cartesian3.fromDegrees(LON, LAT));
    const resolve = createSurfacePickResolver(scene as never, context({ draped: () => false }));
    expect(resolve([{ id: surfaceChunkPickId(KEY, 0) }], WINDOW)).toEqual(PICKED);
    expect(resolve([], WINDOW)).toBeNull();
    expect(scene.globe.pick).not.toHaveBeenCalled();
  });
  it("keeps the reveal wave's word while chunks still wave, and not for a draped group", () => {
    const scene = fakeScene();
    expect(createSurfacePickResolver(scene as never, context({ reveal: () => 0 }))([], WINDOW)).toBeNull();
    expect(createSurfacePickResolver(scene as never,
      context({ reveal: () => 0, target: () => target({ draped: true }) }))([], WINDOW)).toEqual(PICKED);
  });
});
```

In `tests/atlas-scientific-layers.test.ts` (imports gain `gridDisk` and `rowForH3`):
```ts
describe('pick target under World Terrain (#483)', () => {
  it('draws supported rows with the surface layer and masked rows with the support layer', async () => {
    const h = harness();
    const [masked] = gridDisk(CELL, 1).filter((cell) => cell !== CELL);
    const surface = columnarSurface([{ h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' },
      { h3: masked, post_mean: 0.5, post_sd: 0.1, support: 'unknown' }], { id: 'hbs-rs334' });
    const done = h.layers.setArtifact(h.load('hbs-rs334', Promise.resolve(surface)));
    await h.pump();
    await done;
    const target = h.layers.pickTarget()!;
    const drawn = () => [CELL, masked].map((cell) => target.drawn(rowForH3(surface, cell)!));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-surface-pick-terrain.test.ts tests/atlas-scientific-layers.test.ts -t "World Terrain"`
Expected: FAIL, with `resolveDrapedPick is not a function` and `target.drawn is not a function`.

- [ ] **Step 3: Implement `resolveDrapedPick` and the resolver branch in `surface-pick.ts`**

Signatures and order are in the Interfaces block. Pass `scene as Scene` to `globe.pick`, with a comment citing Globe.js:823-831 (it reads only `mode` and `mapProjection`).

- [ ] **Step 4: Add `drawn` and `draped: false` to both `pickTarget()` branches in `scientific-layers.ts`**

`drawn(row)` reads `this.#options.style().layers` at call time and checks the group with `shown(group)`; a null group draws nothing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-surface-pick-terrain.test.ts tests/atlas-picking.test.ts tests/atlas-scientific-layers.test.ts`
Expected: PASS; the smooth-globe pick tests are unchanged apart from the target fields.

- [ ] **Step 6: Commit**
```bash
git add website/src/atlas/scene/surface-pick.ts website/src/atlas/scene/scientific-layers.ts \
  website/tests/atlas-surface-pick-terrain.test.ts website/tests/atlas-picking.test.ts website/tests/atlas-scientific-layers.test.ts
git commit -m "fix: resolve picks on the rendered ground under World Terrain" \
  -m "globe.pick through the camera's pick ray, then the H3 cell and the layer that draws it; observations still win, and a mid-morph pick resolves nothing." \
  -m "advances #483" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fixture and probe

**Parallel:** yes, with Tasks 1 and 2.

**Files:**
- Modify: `src/atlas/e2e-hooks.ts:33-46` (`TerrainProbe`), `:48-57` (`SYNTHETIC_PEAK` after `SYNTHETIC_CONE`)
- Modify: `src/atlas/scene/synthetic-terrain.ts`: docstring `:1-9` (cites `terrain draping design, "Test plan"`); `:25-38` extract the shared great-circle distance and add `syntheticTerrainHeight`; `:60` the tile callback calls it; `:71-97` the probe's new fields.
- Test: `tests/atlas-synthetic-terrain.test.ts` (imports `:3-24`, probe test `:78-128`, two new describes)

**Interfaces:**
- Consumes PR 1's `SYNTHETIC_CONE`, `syntheticConeHeight` and `publishTerrainProbe`, plus `decodeGrid`, `decodeRender`, `gridRowOf`, `isSupportedCode` and `tests/support/gosa-builder` (`fixtureBytes`, `onlyGrid`, `toBuffer`).
- Produces:
```ts
// e2e-hooks.ts (Cesium-free, so Playwright imports it)
export const SYNTHETIC_PEAK = { lat: 40.419, lon: -3.709, peakMetres: 6_000, sigmaKm: 40 } as const; // HbS Spain survey (MAP survey 1135)
export interface TerrainProbe { /* PR 1 */ lambertDiffuseMultiplier: number; showGroundAtmosphere: boolean;
  showWaterEffect: boolean; vertexShadowDarkness: number;
  /** SYNTHETIC_PEAK on the rendered (exaggerated) ground, in canvas CSS px; null until its tile loads or when off screen. */
  apexWindow: { x: number; y: number } | null }
// synthetic-terrain.ts
export function syntheticTerrainHeight(lon: number, lat: number): number; // cone + peakMetres·exp(−d²/2σ²)
export { SYNTHETIC_PEAK } from '../e2e-hooks';
```

- [ ] **Step 1: Write the failing tests**
```ts
describe('syntheticTerrainHeight', () => {
  it('adds a 6 km Gaussian peak, σ 40 km, under the Madrid HbS survey to the cone', () => {
    const { lat, lon, peakMetres, sigmaKm } = SYNTHETIC_PEAK;
    expect(SYNTHETIC_PEAK).toEqual({ lat: 40.419, lon: -3.709, peakMetres: 6_000, sigmaKm: 40 });
    expect(syntheticTerrainHeight(lon, lat)).toBeCloseTo(peakMetres, 6);
    expect(syntheticTerrainHeight(lon, lat + km(sigmaKm))).toBeCloseTo(peakMetres * Math.exp(-0.5), 0);
    expect(syntheticTerrainHeight(lon, lat + km(2 * sigmaKm))).toBeCloseTo(peakMetres * Math.exp(-2), 0);
    expect(syntheticTerrainHeight(SYNTHETIC_CONE.lon, SYNTHETIC_CONE.lat)).toBeCloseTo(SYNTHETIC_CONE.peakMetres, 6);
    expect(syntheticTerrainHeight(lon + 180, -lat)).toBeCloseTo(0, 6);
  });
  it('serves the peak as heightmap tiles', async () => {
    // As the cone test (:48-75), at level 8 over SYNTHETIC_PEAK: height > 0.97 × 6,000 and ≤ 6,000.
  });
});

describe('SYNTHETIC_PEAK on the e2e fixture', () => {
  it('stands where hbs-rs334 supports every res-4 cell within 2σ of the apex', () => {
    const directory = path.resolve(import.meta.dirname, 'fixtures/atlas/e2e');
    const catalog = atlasCatalogSchema.parse(JSON.parse(readFileSync(path.join(directory, 'catalog.json'), 'utf8')));
    const { entry, gridSha256 } = onlyGrid(catalog);
    const grid = decodeGrid(toBuffer(fixtureBytes(directory, entry.url)), { entry, gridSha256 });
    const ref = catalog.artifacts.find(({ id }) => id === 'hbs-rs334')!;
    const { support } = decodeRender(toBuffer(fixtureBytes(directory, ref.web.render.url)), { grid, ref });
    const apex: [number, number] = [SYNTHETIC_PEAK.lat, SYNTHETIC_PEAK.lon];
    const near = gridDisk(latLngToCell(...apex, grid.resolution), 3).filter(
      (cell) => greatCircleDistance(apex, cellToLatLng(cell), UNITS.km) <= 2 * SYNTHETIC_PEAK.sigmaKm);
    expect(near.length).toBeGreaterThanOrEqual(7);
    for (const cell of near) {
      const row = gridRowOf(grid, cell);
      expect(row, cell).not.toBeNull();
      expect(isSupportedCode(support[row!]), cell).toBe(true);
    }
  });
});
```

Then update the probe test (:101-128):
- `fakeWidget.scene.globe` gains `lambertDiffuseMultiplier: 0.9, showGroundAtmosphere: false, showWaterEffect: false, vertexShadowDarkness: 0.45`.
- Add `const toWindow = vi.spyOn(SceneTransforms, 'worldToWindowCoordinates').mockReturnValue(new Cartesian2(412, 288))`.
- The first `toEqual` adds `apexWindow: { x: 412, y: 288 }` and the four globe fields.
- Assert `Cartographic.fromCartesian(toWindow.mock.lastCall![1])` is at `SYNTHETIC_PEAK` (radians, 9 places) with a height close to 5,000 (the fake `getHeight`).
- Once `getHeight` returns `undefined`, and again once `toWindow` returns `undefined`, expect `apexWindow: null`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-synthetic-terrain.test.ts`
Expected: FAIL, with `syntheticTerrainHeight is not a function` and the `apexWindow` mismatch.

- [ ] **Step 3: Implement the `e2e-hooks.ts` and `synthetic-terrain.ts` changes**

`apexWindow` is `globe.getHeight(Cartographic.fromDegrees(lon, lat))`, then `SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(lon, lat, ground))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-synthetic-terrain.test.ts`
Expected: PASS, including the existing `production build › carries no synthetic terrain`.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/e2e-hooks.ts website/src/atlas/scene/synthetic-terrain.ts website/tests/atlas-synthetic-terrain.test.ts
git commit -m "test: stand a Gaussian peak under supported HbS cells in the synthetic terrain" \
  -m "6 km, σ 40 km, under the Madrid HbS survey (map-surveys:1135), where the e2e grid supports every res-4 cell within 2σ; the Kenya survey has none of its 11 in the grid. The probe reports the hillshade terms and the summit's window position." \
  -m "advances #483" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Scene wiring

**Parallel:** no. Depends on Task 1 (`TerrainPresentation.surfaceShown`) and Task 2 (`SurfacePickContext.draped`).

**Files:**
- Modify: `src/atlas/scene/atlas-scene.ts`: after `:17` import `hasPhysicalRelief` from `'../earth-style-catalog'`; `:264-271` the resolver context gains `draped: () => hasPhysicalRelief(this.#appliedTerrain) && this.#elevationFactor === 0`; `:438-444` `setLayerVisibility` calls `this.#terrainShading.update({ surfaceShown: layers.surface || layers.support })`.
- Modify: `src/atlas/scene/surface-pick.ts:53-60`: `draped` becomes required and the resolver calls `context.draped()`.
- Modify: `tests/atlas-picking.test.ts:50-55`: the `context()` helper gains `draped: () => false`.
- Test: `tests/atlas-scene-terrain.test.ts` (harness `:9-19` gains `pickContext`; mocks `:63-107` per Step 1; `scene()` `:138-144` takes `reducedMotion = false`)

**Interfaces:**
- Consumes `SurfacePickContext`, `TerrainShading.update(Partial<TerrainPresentation>)`, `#appliedTerrain` (atlas-scene.ts:168).
- Produces `SurfacePickContext.draped(): boolean`.

- [ ] **Step 1: Write the failing tests**

Mocks: `'../src/atlas/scene/surface-pick'` keeps the original exports, with `createSurfacePickResolver: (_s: unknown, context: SurfacePickContext) => { harness.pickContext = context; return () => null; }`; the `ContextController` mock gains `setTerrain = () => new Promise<boolean>(() => {})` and `setVisible = () => {}`; the `ContextOverlay` mock gains `setVisible = () => {}`; the `ScientificLayers` mock gains `setVisibility = () => {}`.

```ts
it('picks on the ground once World Terrain is on the globe, and on the ellipsoid on the smooth globe', () => {
  scene();
  expect(harness.pickContext!.draped()).toBe(false);
  harness.contextOptions?.onTerrainApplied?.('world-terrain');
  expect(harness.pickContext!.draped()).toBe(true);
  harness.contextOptions?.onTerrainApplied?.('smooth-globe');
  expect(harness.pickContext!.draped()).toBe(false);
});
it('keeps the smooth pick while a requested World Terrain has not reached the globe', () => {
  void scene().setTerrain('world-terrain'); // the fake never settles
  expect(harness.pickContext!.draped()).toBe(false);
});
it('keeps the depth pick while data elevation lifts the surface under World Terrain', async () => {
  const controller = scene(true);
  harness.contextOptions?.onTerrainApplied?.('world-terrain');
  await controller.setElevation(true, 2);
  expect(harness.pickContext!.draped()).toBe(false);
  await controller.setElevation(false, 2);
  expect(harness.pickContext!.draped()).toBe(true);
});
it('tells the shading whether any surface layer is shown', () => {
  const controller = scene();
  controller.setLayerVisibility({ ...DEFAULT_LAYERS, support: false, surface: false });
  expect(harness.updates).toContainEqual({ surfaceShown: false });
  controller.setLayerVisibility({ ...DEFAULT_LAYERS, surface: false });
  expect(harness.updates.at(-1)).toEqual({ surfaceShown: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-scene-terrain.test.ts`
Expected: FAIL, with `harness.pickContext.draped is not a function` and no `{ surfaceShown: false }` update.

- [ ] **Step 3: Make the three edits listed under Files**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-scene-terrain.test.ts tests/atlas-picking.test.ts tests/atlas-surface-pick-terrain.test.ts && npm run check`
Expected: PASS; `astro check` reports 0 errors.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/atlas-scene.ts website/src/atlas/scene/surface-pick.ts \
  website/tests/atlas-scene-terrain.test.ts website/tests/atlas-picking.test.ts
git commit -m "fix: pick on World Terrain's ground, and drop its atmosphere while the surface shows" \
  -m "The scene reports picks as draped once World Terrain is on the globe and the data is flat, and tells the terrain shading whether a surface layer is shown." \
  -m "advances #483" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `atlas-drape.spec` with the #483 repro, and the shared e2e helpers

**Parallel:** no. Depends on Task 3 (`SYNTHETIC_PEAK`, `apexWindow`) and Task 4.

**Files:**
- Create: `tests/atlas-terrain-helpers.ts`
- Create: `tests/atlas-drape.spec.ts`
- Modify: `tests/atlas-terrain.spec.ts:41-62, 76-83`: move `probe`, `cameraSettled` and `openTerrainChooser` into the helpers file and import them.
- Modify: `playwright.config.ts:24-25`: add `'atlas-drape.spec.ts'` with the comment `// The data draped onto the synthetic terrain (#483).`

**Interfaces:**
- Consumes `SYNTHETIC_PEAK`, `TerrainProbe` (Task 3), `waitForAtlasReady`, `waitForRevealWave` (`tests/atlas-mobile-helpers.ts`).
- Produces (Tasks 17, 26 and 31 use and extend these):
```ts
export async function probe(page: Page): Promise<TerrainProbe>;            // moved
export async function cameraSettled(page: Page): Promise<void>;            // moved
export async function openTerrainChooser(page: Page): Promise<Locator>;    // moved: the 'Basemap and terrain' dialog
export async function afterNextPaint(page: Page): Promise<void>;           // two rAFs
export type DrapeView = 'nadir' | 'oblique';
export const DRAPE_CAMERAS: Record<DrapeView, { heading: 0; height: number; lat: number; lon: number; pitch: number }>;
  // nadir:   SYNTHETIC_PEAK, height 60_000, pitch −90
  // oblique: lat SYNTHETIC_PEAK.lat − 2.2 (245 km south), height 100_000, pitch −20; at relief 3 the
  //          ellipsoid behind the summit is ~50 km on, in 84392b5ffffffff
export function drapeQuery(view: DrapeView, relief: number, extra?: Record<string, string>): string;
  // { entity: 'hbs-rs334', version: 'v1/map-2026-08', metric: 'post_mean', terrain: 'world-terrain', relief,
  //   dayNight: 'false', edges: 'false', layers: 'surface,support', ...DRAPE_CAMERAS[view], ...extra } as URLSearchParams:
  //   extra overrides any key; edges are off unless a test turns them on, so probes list only the layers it expects
export async function openDrape(page: Page, query: string): Promise<void>;
  // goto /app/?query, waitForAtlasReady, waitForRevealWave, cameraSettled, then poll probe().provider === 'synthetic' (30 s)
export async function apexOnPage(page: Page): Promise<{ x: number; y: number }>; // polls tilesLoaded && apexWindow; adds the canvas offset
export const SUMMIT_PATCH_PX = 7;
export async function summitPatch(page: Page, at: { x: number; y: number }, sizePx?: number): Promise<string>; // base64 PNG, square, default SUMMIT_PATCH_PX
export const CHANGED_CHANNEL = 16;
export async function changedShare(page: Page, before: string, after: string): Promise<number>;
  // both decoded in the page (createImageBitmap → OffscreenCanvas → getImageData); share of pixels with any channel differing by > 16
export async function setSurfaceOpacity(page: Page, opacity: number): Promise<void>;
  // opens 'Inferred surface' if closed, fills 'Surface opacity', waits for the URL's opacity and afterNextPaint
export async function surfaceVisibleAtApex(page: Page): Promise<boolean>;
  // summit patch at opacity 0.2, then at 1; true when changedShare ≥ 0.8. Changing opacity, not toggling the layer:
  // a toggle also switches the ground atmosphere (Task 1) and changes the pixel even while the surface is buried.
```

- [ ] **Step 1: Write the spec**
```ts
test.describe('terrain draping @desktop-chromium', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { window.__atlasSyntheticTerrain = true; });
  });

  for (const view of ['nadir', 'oblique'] as const)
    for (const relief of [1, 3])
      test(`#483 repro: the summit shows the surface (${view}, relief ${relief})`, async ({ page }) => {
        test.fail(true, 'Phase 1: the surface sits at 650 m, so the 6 km summit buries it; Task 17 drapes it (#483).');
        await openDrape(page, drapeQuery(view, relief));
        expect(await surfaceVisibleAtApex(page)).toBe(true);
      });

  test("an oblique pick at the summit names the summit's cell, not the ground behind it", async ({ page }) => {
    await openDrape(page, drapeQuery('oblique', 3));
    expect(await probe(page)).toMatchObject({ verticalExaggeration: 3 });
    const apex = await apexOnPage(page);
    await page.mouse.click(apex.x, apex.y);
    const inspector = page.getByRole('complementary', { name: 'Selected map cell' });
    await expect(inspector).toContainText(latLngToCell(SYNTHETIC_PEAK.lat, SYNTHETIC_PEAK.lon, 4)); // 84390cbffffffff
    await expect(inspector).not.toContainText('84392b5ffffffff');
  });

  test('World Terrain sets the hillshade terms, and drops atmosphere and water while the surface shows', async ({ page }) => {
    await openDrape(page, drapeQuery('nadir', 1));
    await expect.poll(() => probe(page)).toMatchObject({ enableLighting: true, lambertDiffuseMultiplier: 0.9,
      showGroundAtmosphere: false, showWaterEffect: false, sunLight: false, vertexShadowDarkness: 0.45 });
    for (const name of ['Inferred surface', 'Evidence support'])
      await page.getByRole('checkbox', { exact: true, name }).uncheck();
    await expect.poll(() => probe(page)).toMatchObject({ showGroundAtmosphere: true, showWaterEffect: true });
    await page.getByRole('checkbox', { exact: true, name: 'Evidence support' }).check();
    await expect.poll(() => probe(page)).toMatchObject({ showGroundAtmosphere: false, showWaterEffect: false });
  });
});
```
The pick and lighting tests share the repro's `openDrape`, `probe` and `apexOnPage` path, so a broken harness fails them instead of hiding under `test.fail`.

- [ ] **Step 2: Build the e2e site and run the spec**

Run: `cd website && PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ PUBLIC_GA_MEASUREMENT_ID=G-TEST123 npm run build:e2e && npx playwright test tests/atlas-drape.spec.ts --project=desktop-chromium`
Expected: 6 passed, the four `#483 repro` tests as expected failures. If one passes, Playwright reports "Expected to fail, but passed" and the run fails.

- [ ] **Step 3: Check that PR 1's spec still passes after the helper move**

Run: `cd website && npx playwright test tests/atlas-terrain.spec.ts --project=desktop-chromium`
Expected: 4 passed.

- [ ] **Step 4: Commit**
```bash
git add website/tests/atlas-drape.spec.ts website/tests/atlas-terrain-helpers.ts website/tests/atlas-terrain.spec.ts website/playwright.config.ts
git commit -m "test: add the #483 drape spec, with the buried-summit repro held under test.fail" \
  -m "The synthetic peak's summit keeps the ground's colour whatever the surface opacity, at nadir and oblique, relief 1 and 3, until phase 2 drapes the data. An oblique pick at the summit names its cell, and World Terrain's lighting terms are probed." \
  -m "advances #483" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Phase 1 ship checklist

- [ ] Gates, in order: `cd website && npm run format:check && npm run check && npm test` (all green, including `atlas-module-size`, `atlas-bundle` and `production build › carries no synthetic terrain`); then the e2e build and `npx playwright test tests/atlas-drape.spec.ts tests/atlas-terrain.spec.ts tests/atlas-cross-origin.spec.ts tests/atlas-mobile.spec.ts` (cross-origin and mobile cover smooth-globe picks and hovers). CI runs the full `npx playwright test`.
- [ ] `git diff --stat origin/fix/terrain-visibility...HEAD -- website/src/components/atlas/AtlasExplorer.tsx` is empty.
- [ ] Manual ion run (the fixture has no vertex normals): World Terrain over the Ethiopian highlands and the Himalaya at 200 km, 1,000 km and 3,000 km. Flat ground keeps its legend colour; only slopes facing away darken; no limb darkens on the way out; Columbus view is lit from overhead when far out.
- [ ] **PR** title: `fix: terrain-correct picks and the draping hillshade under World Terrain (#483, phase 1 of 4)`. TL;DR:
  - Picks under World Terrain hit the rendered, exaggerated ground (`globe.pick`) and name the H3 cell there. At relief 3 an oblique pick at a summit used to name the ellipsoid cell about 50 km behind it.
  - The hillshade uses the draping design's terms: a 45° north-west light swinging to a headlight between 500 and 5,000 km (overhead in 2D and Columbus view); shadow darkness 0.45 and diffuse 0.9, so flat ground keeps the legend colour; no ground atmosphere or water effect while a surface layer shows.
  - Harness: a 6 km Gaussian peak under the Madrid HbS survey, where the e2e grid supports every cell within 2σ (the Kenya survey has none of its cells in the grid). `atlas-drape.spec` holds the #483 repro under `test.fail`; phase 2 removes the marker.
  - The smooth globe is unchanged. Known and expected: the data still sits at fixed heights, so high ground hides it until phase 2.
  - Body ends `advances #483`, then `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Phase 2: Draped surface (Tasks 6–17)

**Branch:** `feat/atlas-drape-2`, stacked on `feat/atlas-drape-1`. One PR.

**What ships.** With World Terrain on, the data worker rasterises the inferred surface, its support masks and its cell outlines into 256 × 256 tiles, and Cesium drapes them as the `atlas-surface` and `atlas-outlines` imagery layers, so high ground no longer hides the surface and the hillshade lights it. Restyles cross-fade the new layer in over an opaque outgoing one; the cold reveal is a 1 s fade; data elevation is off and extruded draws as hexagons; picks go through `globe.pick`; a raster failure brings the smooth globe back; Honmoon shows its fill without contours (contours in Task 28). Borders, rings, symbols, labels and the highlight keep today's heights until phase 3. The #483 repro passes from this phase on.

### Phase 2 decisions

1. **Files beyond the skeleton:** `scene/synthetic-terrain.ts` (the probe reads `draped` and `imageryLayers`), `playwright.config.ts` (`atlas-terrain-performance.spec.ts` needs the e2e build's synthetic terrain, so it cannot run under `playwright.performance.config.ts`, which asserts a production build), `geometry/support-buffers.ts` (exports the mask `st` frame so mask texels draw the chunk masks' pattern), `tests/atlas-module-size.test.ts`.
2. **`scientific-layers.ts` is already over the split threshold** (986 logical lines; AGENTS.md: split at 800 before adding). Task 11 moves the per-kind surface-group operations into a new `scene/surface-groups.ts` and caps `scientific-layers.ts` at 986.
3. **Task 6 lands the protocol, client and placeholder worker entries** with the types: the raster request types make `HandlerRegistry` exhaustive, and Task 11's worker type needs the client's raster methods.
4. **Delivered tiles must request a render.** Cesium re-renders after a tile only for requests made through `RequestScheduler` (Scene.js:705), which worker tiles bypass. The provider has `readonly tileLoaded: Event`, and `addDrapedImageryLayer` requests a render on it.
5. **Provider extras:** `readonly bounds: DegreeRectangle | null` (null → the group adds no layer); `RASTER_MAX_IN_FLIGHT = 8` (above it `requestImage` returns undefined and Cesium asks again next frame, so the worker queue holds no backlog from an old camera); a tile that fails with `cancelled` resolves as empty instead of rejecting, which would raise `errorEvent` and revert the terrain; `maximumLevel` is the border spec's `maximumLevel`, else 11.
6. **`DrapedRuntime.providerFromSpec`** builds a provider for any raster, so phase 3's borders and footprints never import the lazy class statically. `DrapedScene` includes `'postRender'` from the start (phase 3's `whenLayerReady` and phase 4's pre-warm wait on it).
7. **Contracts live in `scene/types.ts`** (`RasterImageryProvider`, `AddDrapedImageryLayer`, `DrapeStatsRecorder`, `RasterWorkerClient`), so lanes compile before any class exists. Rasterisers are injected (`createRasterRuntime(c, rasterisers)`); `ATLAS_RASTERISERS` arrives in Task 15; until Task 19, `RasterWorkerContext.naturalEarth` is `() => null`.
8. **Outline α** is `cellEdges && cells.supported ? …`: the chunk path hides edges with the surface layer (`applyEdgeVisibility`, surface-chunk-layer.ts:221-227). **Mask texel α** is the material α ÷ 0.9: the chunk path does not scale mask materials by 0.9, but the draped layer scales the whole texture.
9. **Probe `imageryLayers`** lists only shown layers with α > 0, non-Atlas layers named `'basemap'`, so an instant toggle is visible to the e2e tests.

### Phase 2 reviewer checks

- Rapid World → Smooth → World before a raster lands (Review Focus 1): Tasks 16 and 11.
- The basemap arriving after the Atlas layers on a cold load stays below them: Task 9 "keeps that order when the basemap arrives later at index 0".
- Cold draped load under reduced motion or in a hidden tab (Review Focus 3): Tasks 11 and 14.
- "Retry globe" while tiles are in flight: no render request or `tileLoaded` after destroy, the raster released, the stats reader unpublished: Task 9 "…raises nothing after destroy", Task 16 "…removes the drape stats reader on destroy".
- A raster with nothing to draw (Review Focus 5): Tasks 11 and 14.

### File map (new)

| File | Responsibility |
|---|---|
| `geometry/raster/types.ts` | Raster contracts and constants |
| `geometry/raster/tiling.ts` | Tile rectangles and texel ↔ lon/lat |
| `geometry/raster/grid-index.ts` | Rows in a rectangle, with ±360° copies; drawn bounds |
| `geometry/raster/fill-raster.ts` | Fill fans, palette-bin polygons and masks per tile |
| `geometry/raster/mask-texels.ts` | Grid and Dot texel formulas |
| `geometry/raster/line-raster.ts` | Anti-aliased lines; borders and footprints in Task 18 |
| `worker/raster-handlers.ts` | Worker raster runtime: prepare, tile, release; a yielding FIFO |
| `scene/draped/raster-imagery-provider.ts` | `AtlasRasterImageryProvider` |
| `scene/draped/draped-imagery-layer.ts` | Layer order, readiness, alpha and show |
| `scene/draped/drape-stats.ts` | Counts, raster-time histogram, resident bytes |
| `scene/draped/draped-surface-group.ts` | `DrapedSurfaceGroup` |
| `scene/draped/runtime.ts` | `drapedRuntime`, the lazy entry point |
| `scene/surface-groups.ts` | Surface-group operations per kind, moved out of ScientificLayers |

---

### Task 6: Draped contracts, protocol and client (P2.0)

**Parallel:** no; every other P2 task builds on it.

**Files:**
- Create: `src/atlas/geometry/raster/types.ts`
- Modify: `src/atlas/worker/protocol.ts:79-121` (request and response maps), `:200-227` (`TERMINAL_RESPONSES`)
- Modify: `src/atlas/worker/client.ts`: three methods after `contextHeights` (`:284-296`)
- Modify: `src/atlas/worker/handlers.ts:70-84`: placeholder raster entries
- Modify: `src/atlas/scene/types.ts`: `SurfaceGroup` after `ScientificPrimitiveGroup` (`:49-61`), the draped contracts appended
- Modify: `src/atlas/scene/surface-chunk-layer.ts:66-75, 310`: `kind: 'chunks'`
- Create: `tests/helpers/raster-specs.ts`: `SURFACE_SPEC: SurfaceRasterSpec` (below) and `BORDER_SPEC: BorderRasterSpec = { color: '#ffffff', layer: 'borders', maximumLevel: 11 }`, shared by Tasks 8, 9, 14 and 15
- Test: `tests/atlas-raster-tiling.test.ts` (new), `tests/atlas-worker-client.test.ts`, `tests/atlas-surface-chunk-layer.test.ts`

**Interfaces:**
- Consumes: `SurfaceGeometry`, `MeshInput`, `EdgeColorSpec`, `NaturalEarthBuffers`, `Metric`, `PaletteId`, `FadeableGroup` (scene-transition.ts:9-17).
- Produces:
```ts
// geometry/raster/types.ts
export type AtlasImageryLayerName = 'atlas-surface' | 'atlas-outlines' | 'atlas-borders' | 'atlas-footprints'; // bottom→top
export const ATLAS_IMAGERY_LAYER_ORDER: readonly AtlasImageryLayerName[] = ['atlas-surface', 'atlas-outlines', 'atlas-borders', 'atlas-footprints'];
export interface TileAddress { x: number; y: number; level: number }
export interface DegreeRectangle { west: number; south: number; east: number; north: number }
export interface TileRaster { rgba: Uint8ClampedArray<ArrayBuffer> } // 256²×4, south-first
export type DrapedGeometry = Exclude<SurfaceGeometry, 'extruded'>;
export interface ArtifactRaster { artifactKey: string; gridSha256: string; metric: Metric; palette: PaletteId; geometry: DrapedGeometry }
export interface SurfaceRasterSpec extends ArtifactRaster { layer: 'surface'; cells: { supported: boolean; masked: boolean }; contours: boolean } // true for Honmoon from Task 31
export interface OutlineRasterSpec extends ArtifactRaster { layer: 'outlines'; edgeColor: EdgeColorSpec }
export interface BorderRasterSpec { layer: 'borders'; color: string; maximumLevel: number }               // Task 23: 11; Task 34 fallback: 10
export interface FootprintRasterSpec { layer: 'footprints'; artifactKey: string; circles: Float64Array; color: string } // lon, lat, radius_km triples
export type RasterSpec = SurfaceRasterSpec | OutlineRasterSpec | BorderRasterSpec | FootprintRasterSpec;
export const RASTER_TILE_SIZE = 256, RASTER_MAX_LEVEL = 11, OUTLINE_MIN_LEVEL = 3, RESIDENT_TILE_BYTES = 349_525;
export const OUTLINE_WIDTH_TEXELS = [1.5, 2] as const; // linear, level 3→11
export interface GridIndex { rowsIn(r: DegreeRectangle, out?: number[]): number[]; bounds(drawn: (row: number) => boolean): DegreeRectangle | null }
export interface SurfaceRasterInput extends Pick<MeshInput, 'grid' | 'topology' | 'support' | 'values' | 'domain' | 'palette'> {
  geometry: DrapedGeometry; index: GridIndex; cells: SurfaceRasterSpec['cells']; contours: boolean }
export interface Rasterisers { // Task 19 adds borders and footprints
  surface(i: SurfaceRasterInput, a: TileAddress): TileRaster | null;
  outlines(i: SurfaceRasterInput & { edgeColor: EdgeColorSpec }, a: TileAddress): TileRaster | null }
// worker/protocol.ts
export interface RasterReady { rasterId: number; bounds: DegreeRectangle | null }
export interface RasterTileBody extends TileAddress { rasterId: number }          // rasterId = the prepare request's id
export interface RasterTileMessage extends RasterTileBody { bitmap: ImageBitmap | null; rasterMs: number } // null = empty
// WorkerRequestMap +  'prepare-raster': { spec: RasterSpec }; 'raster-tile': RasterTileBody; 'release-raster': { rasterId: number }
// WorkerResponseMap + 'raster-ready': RasterReady; 'tile-ready': RasterTileMessage; 'raster-released': { rasterId: number }
export type RasterRequestType = 'prepare-raster' | 'raster-tile' | 'release-raster';
export type RasterResponse = WorkerResponseOf<'raster-ready'> | WorkerResponseOf<'tile-ready'> | WorkerResponseOf<'raster-released'>;
// all three responses join TERMINAL_RESPONSES
// AtlasWorkerClient
prepareRaster(spec: RasterSpec, signal?: AbortSignal): Promise<RasterReady>;
rasterTile(body: RasterTileBody, signal?: AbortSignal): Promise<RasterTileMessage>;
releaseRaster(rasterId: number): Promise<void>;
// scene/types.ts
export interface SurfaceGroup extends FadeableGroup, Pick<ScientificPrimitiveGroup, 'setSurfaceOpacity' | 'setVisibility' | 'setCellEdges' | 'setElevationFactor' | 'setSceneMode'> {
  readonly kind: 'chunks' | 'draped'; readonly artifactKey: string; totalCount(): number; readyChunkCount(): number; opacity(): number; setEdgesHeld(held: boolean): void }
export interface RasterWorkerClient extends Pick<AtlasWorkerClient, 'prepareRaster' | 'rasterTile' | 'releaseRaster'> {}
export interface RasterTileSource { prepare(s: RasterSpec, signal: AbortSignal): Promise<RasterReady>; tile(b: RasterTileBody): Promise<RasterTileMessage>; release(id: number): void }
export type DrapedScene = Pick<Scene, 'globe' | 'imageryLayers' | 'preRender' | 'postRender' | 'requestRender'>;
export type RasterImageryProvider = ImageryProvider & { readonly bounds: DegreeRectangle | null;
  readonly tileLoaded: Event<(message: RasterTileMessage) => void>; destroy(): void; isDestroyed(): boolean };
export interface DrapedImageryLayer { readonly name: AtlasImageryLayerName; readonly layer: ImageryLayer; setAlpha(a: number): void; setShown(s: boolean): void; isReady(): boolean; destroy(): void }
export interface DrapedImageryLayerOptions { scene: DrapedScene; provider: RasterImageryProvider; name: AtlasImageryLayerName; alpha: number }
export type AddDrapedImageryLayer = (o: DrapedImageryLayerOptions) => DrapedImageryLayer;
export interface DrapedSurfaceGroupOptions { artifactKey: string; scene: DrapedScene; source: RasterTileSource; surface: SurfaceRasterSpec; edgeColor: EdgeColorSpec;
  cellEdges: boolean; surfaceOpacity: number; wave: DrapeWave; onError(e: unknown): void }
export interface DrapeWave { progress(): number; running(): boolean } // RevealWave satisfies it from Task 11
export interface DrapedSurfaceGroup extends SurfaceGroup { readonly kind: 'draped'; readonly cells: SurfaceRasterSpec['cells'];
  readonly collection: { show: boolean }; prepare(signal: AbortSignal): Promise<void>; setOutlineStyle(c: EdgeColorSpec): Promise<void>; outlinesReady(): boolean; isReady(): boolean; destroy(): void }
export interface DrapeStats { requested: number; delivered: number; empty: number; queueDepth: number;
  rasterMs: { upperMs: readonly number[] /* 0.5, 1, 2, 4, 8, 16, Infinity */; counts: number[] }; // level ≥ 3 only
  residentBytes: number } // non-empty cached tiles × RESIDENT_TILE_BYTES
export interface DrapeStatsRecorder { source(inner: RasterTileSource): RasterTileSource; watchLayer(layer: ImageryLayer): () => void; read(): DrapeStats }
export interface DrapedRuntime { readonly version: 'atlas-draped-v1';
  createDrapedSurfaceGroup(o: DrapedSurfaceGroupOptions): DrapedSurfaceGroup; addDrapedImageryLayer: AddDrapedImageryLayer;
  providerFromSpec(src: RasterTileSource, spec: RasterSpec, signal: AbortSignal): Promise<RasterImageryProvider>;
  rasterSource(w: RasterWorkerClient): RasterTileSource; stats: DrapeStatsRecorder }
// SurfaceChunkGroup extends ScientificPrimitiveGroup, SurfaceGroup { readonly kind: 'chunks'; collection: PrimitiveCollection; … } (collection redeclared: TS2320)
```

- [ ] **Step 1: Write the failing tests**
```ts
// tests/atlas-raster-tiling.test.ts
describe('raster constants (#483)', () => {
  it('pins the tile size, levels, outline widths and resident bytes', () => {
    expect([RASTER_TILE_SIZE, RASTER_MAX_LEVEL, OUTLINE_MIN_LEVEL]).toEqual([256, 11, 3]);
    expect(OUTLINE_WIDTH_TEXELS).toEqual([1.5, 2]);
    expect(RESIDENT_TILE_BYTES).toBe(Math.floor((256 * 256 * 4 * 4) / 3)); // 256² RGBA plus a mip chain
    expect(ATLAS_IMAGERY_LAYER_ORDER).toEqual(['atlas-surface', 'atlas-outlines', 'atlas-borders', 'atlas-footprints']);
  });
});
// tests/atlas-worker-client.test.ts
it('settles prepare, tile and release on their terminal raster responses', async () => {
  const handlers: HandlerRegistry = {
    ...ATLAS_WORKER_HANDLERS,
    'prepare-raster': (r, c) => c.post({ bounds: null, id: r.id, rasterId: r.id, type: 'raster-ready' }),
    'raster-tile': (r, c) => c.post({ bitmap: null, id: r.id, level: r.level, rasterId: r.rasterId, rasterMs: 0.5, type: 'tile-ready', x: r.x, y: r.y }),
    'release-raster': (r, c) => c.post({ id: r.id, rasterId: r.rasterId, type: 'raster-released' }),
  };
  const { client: atlas } = client(new InProcessWorker(handlers));
  const ready = await atlas.prepareRaster(SURFACE_SPEC);
  expect(ready).toEqual({ bounds: null, rasterId: expect.any(Number) });
  expect(await atlas.rasterTile({ level: 3, rasterId: ready.rasterId, x: 9, y: 2 }))
    .toMatchObject({ bitmap: null, level: 3, rasterId: ready.rasterId, rasterMs: 0.5, x: 9, y: 2 });
  await expect(atlas.releaseRaster(ready.rasterId)).resolves.toBeUndefined();
});
// tests/atlas-surface-chunk-layer.test.ts
it('reads as the chunks kind of surface group', () => {
  expect(createSurfaceChunkGroup(OPTIONS).kind).toBe('chunks');
});
```
`SURFACE_SPEC` (`tests/helpers/raster-specs.ts`): `{ artifactKey: 'hbs-rs334:v1:map-2026-08', cells: { masked: true, supported: true }, contours: false, geometry: 'triangles', gridSha256: 'test-grid', layer: 'surface', metric: 'post_mean', palette: 'rainbow' }`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-raster-tiling.test.ts tests/atlas-worker-client.test.ts tests/atlas-surface-chunk-layer.test.ts -t "raster|chunks kind"`
Expected: FAIL: `../src/atlas/geometry/raster/types` does not resolve, and `atlas.prepareRaster is not a function`.

- [ ] **Step 3: Implement the contracts**

The client methods are `#request<'raster-ready' | 'tile-ready' | 'raster-released'>` calls that transfer nothing. In `handlers.ts` the three raster entries are one function throwing `new Error('The Atlas raster runtime is wired in Task 15')`, which the dispatcher turns into an `internal` error. `createSurfaceChunkGroup` returns `kind: 'chunks'`.

- [ ] **Step 4: Run the tests and the type check**

Run: `cd website && npx vitest run tests/atlas-raster-tiling.test.ts tests/atlas-worker-client.test.ts tests/atlas-surface-chunk-layer.test.ts && npm run check`
Expected: PASS; 0 errors.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/geometry/raster/types.ts website/src/atlas/worker/{protocol,client,handlers}.ts website/src/atlas/scene/{types,surface-chunk-layer}.ts website/tests/helpers/raster-specs.ts website/tests/atlas-{raster-tiling,worker-client,surface-chunk-layer}.test.ts
git commit -m "feat: declare the draped-surface contracts and the raster protocol (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Tiling and the grid index (P2.1)

**Parallel:** yes, with Tasks 9, 10 and 11. Tasks 8, 12 and 13 follow it.

**Files:**
- Create: `src/atlas/geometry/raster/tiling.ts`, `src/atlas/geometry/raster/grid-index.ts`, `tests/helpers/raster-fixtures.ts`
- Test: `tests/atlas-raster-tiling.test.ts`, `tests/atlas-raster-grid-index.test.ts`

**Interfaces:**
- Consumes: `TileAddress`, `DegreeRectangle`, `GridIndex`, `RASTER_TILE_SIZE` (Task 6); `GridTopology` (topology.ts:20-29).
- Produces:
```ts
export function tileRectangle(a: TileAddress): DegreeRectangle; // 2×1 geographic roots
export function texelCentre(a: TileAddress, column: number, row: number): { lon: number; lat: number }; // row 0 at the south edge
export function toTexel(a: TileAddress, lon: number, lat: number): { x: number; y: number }; // texel-centre frame: centre of (c, r) is (c, r)
export function buildGridIndex(topology: GridTopology): GridIndex;
// tests/helpers/raster-fixtures.ts
export const KENYA_CELLS: TestCell[]; // gridDisk(latLngToCell(-1.836, 36.793, 4), 3) sorted by sortedU64, all 'observed', value = (row % 7) / 6
export function seamCells(): TestCell[]; // gridDisk(latLngToCell(0, 180, 4), 1), 'observed', 0.5
export function poleCells(): TestCell[];  // gridDisk(latLngToCell(90, 0, 4), 1), 'observed', 0.5
export function rasterInputFor(cells: TestCell[], o?: { geometry?: DrapedGeometry; cells?: SurfaceRasterSpec['cells']; palette?: PaletteId }): SurfaceRasterInput;
export function tileContaining(lon: number, lat: number, level: number): TileAddress;
export function texel(raster: TileRaster, column: number, row: number): [number, number, number, number];
export function forEachTexel(raster: TileRaster, a: TileAddress, visit: (t: { column: number; row: number; lon: number; lat: number; rgba: number[] }) => void): void;
```
The Kenya disk is arbitrary unit-test data; it is not the e2e peak.

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-raster-tiling.test.ts
it("matches Cesium's GeographicTilingScheme: two 180° roots, y from the north", () => {
  expect(tileRectangle({ level: 0, x: 0, y: 0 })).toEqual({ east: 0, north: 90, south: -90, west: -180 });
  const scheme = new GeographicTilingScheme();
  for (const a of [{ level: 3, x: 5, y: 3 }, { level: 9, x: 1023, y: 0 }, { level: 11, x: 2900, y: 1100 }]) {
    const r = scheme.tileXYToRectangle(a.x, a.y, a.level);
    const d = tileRectangle(a);
    for (const side of ['west', 'south', 'east', 'north'] as const)
      expect(d[side]).toBeCloseTo(CesiumMath.toDegrees(r[side]), 9);
  }
});
it('puts row 0 at the south edge (rows are south-first)', () => {
  const a = { level: 0, x: 1, y: 0 };
  expect(texelCentre(a, 0, 0)).toEqual({ lat: -90 + 180 / 512, lon: 180 / 512 });
  expect(texelCentre(a, 255, 255)).toEqual({ lat: 90 - 180 / 512, lon: 180 - 180 / 512 });
  const { lat, lon } = texelCentre({ level: 8, x: 300, y: 128 }, 17, 201);
  expect(toTexel({ level: 8, x: 300, y: 128 }, lon, lat)).toEqual({ x: expect.closeTo(17, 9), y: expect.closeTo(201, 9) });
});
// atlas-raster-grid-index.test.ts
it('returns each row overlapping a rectangle once, in ascending order', () => {
  const { index, topology } = rasterInputFor(KENYA_CELLS);
  const rect = { east: 37.5, north: -1, south: -2.5, west: 36 };
  const rows = index.rowsIn(rect);
  expect(rows).toEqual([...new Set(rows)].sort((a, b) => a - b));
  expect(rows).toEqual(rowsWhoseCornersOverlap(topology, rect)); // brute force over every row
});
it('holds every boundary point of every cell, distortion vertices included', () => {
  const { grid, index } = rasterInputFor(KENYA_CELLS);
  for (let row = 0; row < grid.n; row += 1)
    for (const [lon, lat] of h3BoundaryDegrees(cellLanes(grid, row)))
      expect(index.rowsIn({ east: lon + 1e-9, north: lat + 1e-9, south: lat - 1e-9, west: lon - 1e-9 })).toContain(row);
});
it('finds a cell that crosses ±180° from tiles on both sides (its ±360° copy)', () => {
  const seam = seamCells().find(({ h3 }) => crossesAntimeridian(h3))!;
  const { index } = rasterInputFor([seam]);
  expect(index.rowsIn({ east: 180, north: 1, south: -1, west: 179.5 })).toEqual([0]);
  expect(index.rowsIn({ east: -179.5, north: 1, south: -1, west: -180 })).toEqual([0]);
  expect(index.bounds(() => true)).toMatchObject({ east: 180, west: -180 });
});
it('reaches the pole for a pole cell', () => {
  const { index } = rasterInputFor([{ h3: latLngToCell(90, 0, 4), support: 'observed', value: 0.5 }]);
  expect(index.rowsIn({ east: 180, north: 90, south: 89.99, west: -180 })).toEqual([0]);
});
it('bounds the drawn rows only, and nothing when none is drawn', () => {
  const { grid, index } = rasterInputFor(KENYA_CELLS);
  const b = index.bounds((row) => row < 10)!;
  for (let row = 0; row < 10; row += 1)
    for (const [lon, lat] of h3BoundaryDegrees(cellLanes(grid, row))) {
      expect(lon).toBeGreaterThanOrEqual(b.west);
      expect(lon).toBeLessThanOrEqual(b.east);
      expect(lat).toBeGreaterThanOrEqual(b.south);
      expect(lat).toBeLessThanOrEqual(b.north);
    }
  expect(index.bounds(() => false)).toBeNull();
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-raster-tiling.test.ts tests/atlas-raster-grid-index.test.ts`
Expected: FAIL: neither `tiling` nor `grid-index` resolves.

- [ ] **Step 3: Implement `tiling.ts` and `grid-index.ts`**

Tile span Δ = 180 / 2^level; `west = −180 + x·Δ`, `north = 90 − y·Δ`; `toTexel` gives `x = (lon − west)·256/Δ − 0.5`, `y = (lat − south)·256/Δ − 0.5`. The index, which the tests do not determine:
- **Per-row box:** the row's topology corners, each unwrapped to within 180° of the centre's longitude, padded by 10% of the box's own extent on every side (covers class-III distortion points, which topology does not hold).
- **Polar rows:** unwrapped corners spanning > 180° of longitude contain a pole: longitude [−180, 180], latitude from the lowest corner to ±90.
- **Buckets:** 360 × 180 buckets of 1°; a box past ±180° is entered once more, shifted by ∓360°.
- **`rowsIn`:** each row once (stamp array), ascending, reusing `out`.
- **`bounds`:** the union of drawn rows' boxes; any drawn polar or ±180°-crossing row makes west −180 and east 180 (never west > east); no drawn row → null.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd website && npx vitest run tests/atlas-raster-tiling.test.ts tests/atlas-raster-grid-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/geometry/raster/{tiling,grid-index}.ts website/tests/helpers/raster-fixtures.ts website/tests/atlas-raster-{tiling,grid-index}.test.ts
git commit -m "feat: tile draped rasters geographically and index the grid by rectangle (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Worker raster runtime with injected rasterisers (P2.2)

**Parallel:** after Task 7 (its harness uses `rasterInputFor` and a real `buildGridIndex`); parallel with Tasks 9–14.

**Files:**
- Create: `src/atlas/worker/raster-handlers.ts`
- Modify: `src/atlas/worker/geometry-handlers.ts:100-104, 378-383`: `prepared`
- Test: `tests/atlas-raster-worker.test.ts` (new), `tests/atlas-worker-geometry.test.ts`

**Interfaces:**
- Consumes: `RasterSpec`, `Rasterisers`, `TileRaster`, `RASTER_TILE_SIZE`, the raster protocol types and `WorkerErrorMessage` (Task 6); `buildGridIndex` (Task 7); `PreparedGrid` (geometry-handlers.ts:49-52).
- Produces:
```ts
export interface RasterWorkerContext {
  post(message: RasterResponse | WorkerErrorMessage, transfer: Transferable[]): void;
  prepared(gridSha256: string): PreparedGrid | undefined;
  gridFor(artifactKey: string): DecodedGrid | undefined;
  render(artifactKey: string): DecodedRender | undefined;
  naturalEarth(): NaturalEarthBuffers | null; // () => null until Task 19
  isCancelled(id: number): boolean;
  now(): number;
  yieldToEventLoop(): Promise<void>;           // after each tile, so load-detail goes first
  toBitmap(raster: TileRaster): Promise<ImageBitmap>; // unflipped
}
export interface RasterRuntime { readonly version: 'atlas-raster-v1';
  handlers: { [K in RasterRequestType]: (request: WorkerRequestOf<K>) => Promise<void> } }
export function createRasterRuntime(c: RasterWorkerContext, rasterisers: Rasterisers): RasterRuntime;
export function imageDataBitmap(raster: TileRaster): Promise<ImageBitmap>; // the worker's toBitmap
// GeometryWorker +
prepared(gridSha256: string): PreparedGrid | undefined; // cached topology and plan, built untimed when absent; undefined when the grid is not loaded
```

- [ ] **Step 1: Write the failing tests**

The harness supplies a context over `rasterInputFor(KENYA_CELLS)`'s grid and topology; a render tier with `support`, `post_mean = values` and `metric_domains.post_mean = [0, 1]`; `posted: { m, t }[]` and an incrementing `now`; a `yieldToEventLoop` that records `posted.length` into `yields` and runs an optional `between()` hook (and `holdYield()`/`releaseYield()` to park the first yield); and rasterisers that return `FAKE_TILE` (all 255), or null when `x === 99`. `rasterHarness(o?: { rasterisers?: Rasterisers; naturalEarth?: () => NaturalEarthBuffers | null })` is exported for Task 19.

```ts
it('answers prepare-raster with its own id as the raster id and the drawn bounds', async () => {
  await h.runtime.handlers['prepare-raster']({ id: 7, spec: SURFACE_SPEC, type: 'prepare-raster' });
  expect(h.posted[0]).toEqual({
    m: { bounds: buildGridIndex(h.topology).bounds(() => true), id: 7, rasterId: 7, type: 'raster-ready' }, t: [] });
});
it('rasterises queued tiles first in, first out, yielding after each', async () => {
  await prepare(h, 7);
  await Promise.all([11, 12, 13].map((id) => tile(h, id, 7)));
  expect(h.posted.slice(1).map(({ m }) => m.id)).toEqual([11, 12, 13]);
  expect(h.yields).toEqual([2, 3, 4]);
});
it('lets a message that arrives between two tiles run before the second', async () => {
  const order: string[] = [];
  h.between = () => order.push('load-detail');
  await prepare(h, 7);
  await Promise.all([tile(h, 11, 7), tile(h, 12, 7)]);
  order.push(...h.posted.slice(1).map(({ m }) => `tile ${m.id}`));
  expect(order).toEqual(['load-detail', 'load-detail', 'tile 11', 'tile 12']);
  expect(h.events).toEqual(['tile 11', 'load-detail', 'tile 12', 'load-detail']);
});
it('transfers a drawn tile’s bitmap with its raster time, and posts an empty tile as null', async () => {
  await prepare(h, 7);
  await tile(h, 11, 7, 5);
  await tile(h, 12, 7, 99);
  const [drawn, empty] = h.posted.slice(1);
  expect(drawn).toEqual({ m: expect.objectContaining({ bitmap: BITMAP, rasterMs: 1, type: 'tile-ready', x: 5 }), t: [BITMAP] });
  expect(empty.m).toMatchObject({ bitmap: null, x: 99 });
  expect(h.context.toBitmap).toHaveBeenCalledTimes(1);
});
it('fails a released raster’s queued tiles as cancelled and confirms the release', async () => {
  await prepare(h, 7);
  h.holdYield(); // the first tile's yield waits for release()
  const [first, second] = [tile(h, 11, 7), tile(h, 12, 7)];
  await h.runtime.handlers['release-raster']({ id: 20, rasterId: 7, type: 'release-raster' });
  h.releaseYield();
  await Promise.all([first, second]);
  expect(h.posted.map(({ m }) => [m.id, m.type === 'error' ? m.code : m.type]))
    .toEqual([[7, 'raster-ready'], [11, 'tile-ready'], [20, 'raster-released'], [12, 'cancelled']]);
});
it('fails a cancelled tile request as cancelled when it is reached', async () => {
  await prepare(h, 7);
  h.cancelled.add(11);
  await tile(h, 11, 7);
  expect(h.posted[1].m).toMatchObject({ code: 'cancelled', id: 11, type: 'error' });
});
it('reports a missing render tier, an unloaded grid, a grid mismatch or a layer it cannot raster yet as internal', async () => {
  for (const spec of [{ ...SURFACE_SPEC, artifactKey: 'absent' }, { ...SURFACE_SPEC, gridSha256: 'other' }, BORDER_SPEC]) {
    h.posted.length = 0;
    await h.runtime.handlers['prepare-raster']({ id: 3, spec, type: 'prepare-raster' });
    expect(h.posted[0].m).toMatchObject({ code: 'internal', id: 3, type: 'error' });
  }
});
it('makes bitmaps unflipped and unpremultiplied, and carries the atlas-raster-v1 marker', async () => {
  const created = vi.fn(async () => ({}) as ImageBitmap);
  vi.stubGlobal('createImageBitmap', created);
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  await imageDataBitmap({ rgba: new Uint8ClampedArray(256 * 256 * 4) });
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ height: 256, width: 256 }),
    { colorSpaceConversion: 'none', imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  expect(h.runtime.version).toBe('atlas-raster-v1');
});
// atlas-worker-geometry.test.ts
it('shares its cached topology with the raster runtime, building it untimed on demand', () => {
  const { worker, posted, fixture } = harness();
  const first = worker.prepared(fixture.grid.gridSha256)!;
  expect(first.topology).toEqual(buildGridTopology(fixture.grid));
  expect(worker.prepared(fixture.grid.gridSha256)).toBe(first);
  expect(posted).toEqual([]);
  expect(worker.prepared('absent')).toBeUndefined();
});
```
The bitmap test is the pin for straight alpha: a premultiplied bitmap darkens every partial-alpha texel (outlines, masks, Honmoon halos), because Cesium blends imagery as straight alpha.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-raster-worker.test.ts tests/atlas-worker-geometry.test.ts -t "raster|prepared|unflipped|FIFO|cancel|released|internal"`
Expected: FAIL: `raster-handlers` does not resolve; `worker.prepared is not a function`.

- [ ] **Step 3: Implement `createRasterRuntime`, `imageDataBitmap` and `GeometryWorker.prepared`**

- **Prepare:** require `gridFor(spec.artifactKey)?.gridSha256 === spec.gridSha256`, `render(…)` and `prepared(…)`, else post `internal`. Build and cache the raster's `SurfaceRasterInput`: `index` from `buildGridIndex(topology)` (cached in a `WeakMap` keyed by topology); drawn = `isSupportedCode(support[row]) ? cells.supported : cells.masked`; `outlines` rasters draw supported rows only. Store under `rasterId = request.id`; post `raster-ready` with `index.bounds(drawn)`. `borders` and `footprints` are `internal` until Task 19.
- **Tiles:** `raster-tile` appends a job and resolves when it is done. One drain loop, first in first out: `isCancelled(id)` or a missing raster posts `cancelled`; time the rasteriser with `now()`; `toBitmap` only for a non-null tile; post `tile-ready` with the bitmap in the transfer list; await `yieldToEventLoop()`.
- **Release:** delete the raster and post `raster-released`; queued jobs fail when reached.
- **Bitmaps:** `createImageBitmap(new ImageData(rgba, 256, 256), { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd website && npx vitest run tests/atlas-raster-worker.test.ts tests/atlas-worker-geometry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/worker/{raster-handlers,geometry-handlers}.ts website/tests/atlas-raster-worker.test.ts website/tests/atlas-worker-geometry.test.ts
git commit -m "feat: rasterise draped tiles in the data worker through a yielding queue (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Provider, imagery layer, drape stats and Cesium pins (P2.3)

**Parallel:** yes, with Tasks 7, 10 and 11. Task 14 follows it.

**Files:**
- Create: `src/atlas/scene/draped/raster-imagery-provider.ts`, `src/atlas/scene/draped/draped-imagery-layer.ts`, `src/atlas/scene/draped/drape-stats.ts`, `tests/helpers/imagery-fakes.ts`
- Test: `tests/atlas-raster-provider.test.ts`, `tests/atlas-draped-surface-group.test.ts` (sections `addDrapedImageryLayer` and `drape stats`), `tests/atlas-cesium-internals.test.ts`

**Interfaces:**
- Consumes: `RasterTileSource`, `RasterImageryProvider`, `DrapedScene`, `DrapedImageryLayer`, `DrapedImageryLayerOptions`, `DrapeStats`, `DrapeStatsRecorder`, `ATLAS_IMAGERY_LAYER_ORDER`, `RASTER_MAX_LEVEL`, `OUTLINE_MIN_LEVEL`, `RESIDENT_TILE_BYTES` (Task 6); `FakeEvent` (`tests/helpers/scene-fakes.ts`).
- Produces:
```ts
export const RASTER_MAX_IN_FLIGHT = 8;
export function emptyTile(): HTMLCanvasElement; // one shared 1 × 1 canvas
export class AtlasRasterImageryProvider implements RasterImageryProvider {
  static fromSpec(src: RasterTileSource, spec: RasterSpec, signal: AbortSignal): Promise<AtlasRasterImageryProvider>;
  readonly bounds: DegreeRectangle | null;
  readonly tileLoaded: Event<(message: RasterTileMessage) => void>;
  readonly errorEvent: Event;
  requestImage(x: number, y: number, level: number): Promise<ImageBitmap | HTMLCanvasElement> | undefined;
  destroy(): void;
  isDestroyed(): boolean;
  // GeographicTilingScheme; tileWidth/Height 256; minimumLevel 0; maximumLevel = spec.layer === 'borders' ? spec.maximumLevel : 11;
  // hasAlphaChannel true; rectangle = Rectangle.fromDegrees(bounds), else Rectangle.MAX_VALUE;
  // tileDiscardPolicy, credit, proxy undefined; getTileCredits() and pickFeatures() return undefined
}
export const DRAPED_READY_CAP_MS = 3_000;
export const addDrapedImageryLayer: AddDrapedImageryLayer;
export function drapedLayerName(layer: ImageryLayer): AtlasImageryLayerName | undefined;
export const DRAPE_RASTER_BINS_MS = [0.5, 1, 2, 4, 8, 16, Infinity] as const;
export function createDrapeStats(): DrapeStatsRecorder;
export const drapeStats: DrapeStatsRecorder; // the page's recorder; addDrapedImageryLayer watches every layer with it
// tests/helpers/imagery-fakes.ts
export function fakeSource(bounds?: DegreeRectangle | null): RasterTileSource & { prepare: Mock; release: Mock; tiles: Map<string, Deferred<RasterTileMessage>> };
  // prepare resolves { rasterId, bounds } with rasterId 7, 8, …; tile() returns a deferred per "x/y/level"
export function fakeProvider(): RasterImageryProvider & { destroy: Mock }; // a ready geographic provider with FakeEvent tileLoaded and errorEvent
export function message(x: number, y: number, level: number, bitmap: ImageBitmap | null, rasterId?: number): RasterTileMessage;
export function stubCesiumBrowserImageTypes(): void;
```

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-raster-provider.test.ts
it('is a geographic provider over the prepared bounds, to level 11, with an alpha channel', async () => {
  const p = await AtlasRasterImageryProvider.fromSpec(fakeSource({ east: 40, north: 5, south: -5, west: 30 }), SURFACE_SPEC, signal);
  expect(p.tilingScheme).toBeInstanceOf(GeographicTilingScheme);
  expect([p.tileWidth, p.tileHeight, p.maximumLevel, p.hasAlphaChannel]).toEqual([256, 256, 11, true]);
  expect(Rectangle.equalsEpsilon(p.rectangle, Rectangle.fromDegrees(30, -5, 40, 5), 1e-12)).toBe(true);
  expect(p.bounds).toEqual({ east: 40, north: 5, south: -5, west: 30 });
});
it("stops a border provider at the spec's maximum level", async () => {
  const levelOf = async (spec: RasterSpec) => (await AtlasRasterImageryProvider.fromSpec(fakeSource(), spec, signal)).maximumLevel;
  expect(await levelOf({ color: '#ffffff', layer: 'borders', maximumLevel: 11 })).toBe(11);
  expect(await levelOf({ color: '#ffffff', layer: 'borders', maximumLevel: 10 })).toBe(10);
  expect(await levelOf({ artifactKey: 'k', circles: Float64Array.of(0, 0, 10), color: '#ff00ff', layer: 'footprints' })).toBe(RASTER_MAX_LEVEL);
});
it('hands Cesium a drawn tile’s bitmap and one shared transparent canvas for every empty tile', async () => {
  stubCesiumBrowserImageTypes();
  const p = await AtlasRasterImageryProvider.fromSpec(source, SURFACE_SPEC, signal);
  const drawn = p.requestImage(1, 2, 3)!;
  tiles.get('1/2/3')!.resolve(message(1, 2, 3, BITMAP));
  expect(await drawn).toBe(BITMAP);
  const [a, b] = [p.requestImage(4, 2, 3)!, p.requestImage(5, 2, 3)!];
  tiles.get('4/2/3')!.resolve(message(4, 2, 3, null));
  tiles.get('5/2/3')!.resolve(message(5, 2, 3, null));
  expect(await a).toBe(await b);
  expect(await a).toBe(emptyTile());
  expect(emptyTile().width).toBe(1);
});
it('returns undefined while 8 of its tiles are in flight, so Cesium asks again next frame', async () => {
  for (let x = 0; x < RASTER_MAX_IN_FLIGHT; x += 1) expect(p.requestImage(x, 0, 4)).toBeDefined();
  expect(p.requestImage(8, 0, 4)).toBeUndefined();
  tiles.get('0/0/4')!.resolve(message(0, 0, 4, null));
  await flushTasks();
  expect(p.requestImage(8, 0, 4)).toBeDefined();
});
it('raises tileLoaded for each delivered tile', async () => {
  const loaded = vi.fn();
  p.tileLoaded.addEventListener(loaded);
  const r = p.requestImage(1, 1, 3)!;
  tiles.get('1/1/3')!.resolve(message(1, 1, 3, null));
  await r;
  expect(loaded).toHaveBeenCalledWith(message(1, 1, 3, null));
});
it('resolves a cancelled tile as empty, and rejects any other failure so Cesium raises errorEvent', async () => {
  const cancelled = p.requestImage(1, 1, 3)!;
  tiles.get('1/1/3')!.reject(Object.assign(new Error('raster released'), { code: 'cancelled' }));
  expect(await cancelled).toBe(emptyTile());
  const failed = p.requestImage(2, 1, 3)!;
  tiles.get('2/1/3')!.reject(Object.assign(new Error('boom'), { code: 'internal' }));
  await expect(failed).rejects.toThrow('boom');
});
it('releases its raster once, drops later requests and raises nothing after destroy', async () => {
  const loaded = vi.fn();
  p.tileLoaded.addEventListener(loaded);
  const pending = p.requestImage(1, 1, 3)!;
  p.destroy();
  p.destroy();
  expect(source.release).toHaveBeenCalledTimes(1);
  expect(source.release).toHaveBeenCalledWith(7);
  expect(p.requestImage(2, 1, 3)).toBeUndefined();
  tiles.get('1/1/3')!.resolve(message(1, 1, 3, BITMAP));
  expect(await pending).toBe(emptyTile());
  expect(loaded).not.toHaveBeenCalled();
  expect(p.isDestroyed()).toBe(true);
});
// atlas-draped-surface-group.test.ts, describe('addDrapedImageryLayer'): a real ImageryLayerCollection, FakeEvent preRender/postRender, globe { tilesLoaded }
it('stacks surface below outlines above the basemap, a newer layer of a name above the older', () => {
  scene.imageryLayers.addImageryProvider(fakeProvider()); // basemap
  const [sa, oa, sb, ob] = (['atlas-surface', 'atlas-outlines', 'atlas-surface', 'atlas-outlines'] as const)
    .map((name) => addDrapedImageryLayer({ alpha: 1, name, provider: fakeProvider(), scene }).layer);
  expect(stack(scene)).toEqual([undefined, sa, sb, oa, ob].map((l) => l && drapedLayerName(l)));
  expect(order(scene).slice(1)).toEqual([sa, sb, oa, ob]);
});
it('keeps that order when the basemap arrives later at index 0', () => {
  addDrapedImageryLayer({ alpha: 1, name: 'atlas-outlines', provider: fakeProvider(), scene });
  addDrapedImageryLayer({ alpha: 1, name: 'atlas-surface', provider: fakeProvider(), scene });
  scene.imageryLayers.add(new ImageryLayer(fakeProvider()), 0);
  expect(stack(scene)).toEqual([undefined, 'atlas-surface', 'atlas-outlines']);
});
it('is ready once tilesLoaded holds from the second frame after the add, or after 3 s', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const layer = addDrapedImageryLayer({ alpha: 0, name: 'atlas-surface', provider: fakeProvider(), scene });
  scene.globe.tilesLoaded = true;
  scene.preRender.raiseEvent();
  expect(layer.isReady()).toBe(false);
  scene.preRender.raiseEvent();
  expect(layer.isReady()).toBe(true);
  scene.globe.tilesLoaded = false;
  const capped = addDrapedImageryLayer({ alpha: 0, name: 'atlas-surface', provider: fakeProvider(), scene });
  now.mockReturnValue(2_999);
  scene.preRender.raiseEvent();
  expect(capped.isReady()).toBe(false);
  now.mockReturnValue(3_000);
  scene.preRender.raiseEvent();
  expect(capped.isReady()).toBe(true);
});
it('requests frames until ready, writes numeric alpha and show, and renders each delivered tile', () => {
  const provider = fakeProvider();
  const l = addDrapedImageryLayer({ alpha: 0.4, name: 'atlas-surface', provider, scene });
  scene.preRender.raiseEvent();
  expect(scene.requestRender).toHaveBeenCalled();
  l.setAlpha(0.25);
  expect(l.layer.alpha).toBe(0.25);
  l.setShown(false);
  expect(l.layer.show).toBe(false);
  scene.requestRender.mockClear();
  provider.tileLoaded.raiseEvent(message(0, 0, 3, null));
  expect(scene.requestRender).toHaveBeenCalledTimes(1);
});
it('destroy removes the layer and destroys its provider, once', () => {
  /* imageryLayers.length is back to before; provider.destroy called once; a second destroy is a no-op */
});
// describe('drape stats')
it('counts requested, delivered and empty tiles and the queue depth through the source it wraps', async () => {
  const stats = createDrapeStats();
  const wrapped = stats.source(source);
  const first = wrapped.tile(body(1, 0, 3));
  void wrapped.tile(body(2, 0, 3));
  expect(stats.read()).toMatchObject({ delivered: 0, empty: 0, queueDepth: 2, requested: 2 });
  tiles.get('1/0/3')!.resolve(message(1, 0, 3, null));
  await first;
  expect(stats.read()).toMatchObject({ delivered: 1, empty: 1, queueDepth: 1, requested: 2 });
});
it('bins raster time of level-3-and-finer tiles by 0.5, 1, 2, 4, 8, 16 ms and above', async () => {
  for (const [level, ms] of [[2, 0.1], [3, 0.4], [3, 0.5], [4, 1.5], [11, 3], [5, 20]]) await deliver(wrapped, level, ms);
  expect(stats.read().rasterMs).toEqual({ counts: [2, 0, 1, 1, 0, 0, 1], upperMs: [0.5, 1, 2, 4, 8, 16, Infinity] });
});
it('counts resident bytes as non-empty cached tiles × 349,525', () => {
  const layer = { _imageryCache: { a: { texture: { width: 256 } }, b: { texture: { width: 1 } }, c: { texture: undefined } } } as unknown as ImageryLayer;
  const unwatch = stats.watchLayer(layer);
  expect(stats.read().residentBytes).toBe(349_525);
  unwatch();
  expect(stats.read().residentBytes).toBe(0);
});
// atlas-cesium-internals.test.ts
describe('Cesium 1.145 internals the draped layers rely on (#483)', () => {
  it('draws no texture of a layer at alpha 0', () => {
    const provider = { _debug: { texturesRendered: 0, tilesRendered: 0 }, _tilesToRenderByTextureCount: [] as unknown[][] };
    const tile = { data: { imagery: [{ readyImagery: { imageryLayer: { alpha: 0 } } }, { readyImagery: { imageryLayer: { alpha: 0.5 } } }], vertexArray: {} } };
    (GlobeSurfaceTileProvider.prototype as unknown as { showTileThisFrame(t: unknown, f: unknown): void }).showTileThisFrame.call(provider, tile, {});
    expect(provider._tilesToRenderByTextureCount[1]).toEqual([tile]);
  });
  it('frees a hidden layer’s tiles as if it were removed', () => {
    const collection = new ImageryLayerCollection();
    const layer = collection.addImageryProvider(fakeProvider());
    const shown = vi.fn();
    collection.layerShownOrHidden.addEventListener(shown);
    layer.show = false;
    (collection as unknown as { _update(): void })._update();
    expect(shown).toHaveBeenCalledWith(layer, 0, false);
    const removed = vi.fn();
    (GlobeSurfaceTileProvider.prototype as unknown as { _onLayerShownOrHidden(l: unknown, i: number, s: boolean): void })
      ._onLayerShownOrHidden.call({ _onLayerAdded: vi.fn(), _onLayerRemoved: removed }, layer, 0, false);
    expect(removed).toHaveBeenCalledWith(layer, 0);
  });
  it('keeps alpha a plain number that the tile shader reads', () => {
    const layer = new ImageryLayer(fakeProvider(), { alpha: 0.25 });
    expect(layer.alpha).toBe(0.25);
    layer.alpha = 0.6;
    expect(layer.alpha).toBe(0.6);
    expect(cesiumSource('Scene/GlobeSurfaceTileProvider.js')).toMatch(/dayTextureAlpha\[numberOfDayTextures\] =\s*imageryLayer\.alpha;/);
  });
  it('caches imagery under JSON [x, y, level] in _imageryCache, each with a texture field', () => {
    const layer = new ImageryLayer(fakeProvider());
    const imagery = layer.getImageryFromCache(1, 0, 0, Rectangle.MAX_VALUE);
    const cache = (layer as unknown as { _imageryCache: Record<string, object> })._imageryCache;
    expect(Object.keys(cache)).toEqual(['[1,0,0]']);
    expect('texture' in imagery).toBe(true);
    layer.removeImageryFromCache(imagery);
    expect(cache).toEqual({});
  });
  it('decodes imagery flipped, so a south-first bitmap matches what Cesium uploads', () => {
    const fetchImage = vi.spyOn(Resource.prototype, 'fetchImage').mockResolvedValue(undefined);
    void ImageryProvider.loadImage(undefined as never, 'https://example.org/tile.png');
    expect(fetchImage).toHaveBeenCalledWith({ flipY: true, preferImageBitmap: true });
  });
});
```
`cesiumSource(p)` reads `node_modules/@cesium/engine/Source/<p>` through `createRequire(import.meta.url).resolve('@cesium/engine/package.json')`; export it from the internals test file's helpers for Task 29.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-raster-provider.test.ts tests/atlas-draped-surface-group.test.ts tests/atlas-cesium-internals.test.ts`
Expected: FAIL: the provider and layer modules do not resolve. The pins pass already (they pin today's Cesium).

- [ ] **Step 3: Implement the provider, `addDrapedImageryLayer`, `drapedLayerName` and the stats**

- **`requestImage`:** undefined once destroyed or with 8 tiles in flight; otherwise `src.tile({ rasterId, x, y, level })`. Success raises `tileLoaded` (unless destroyed) and returns `bitmap ?? emptyTile()`. Failure returns `emptyTile()` when `code === 'cancelled'`, `name === 'AbortError'` or the provider is destroyed; otherwise rethrows.
- **`destroy`:** releases the raster once.
- **Insertion index:** after the last Atlas layer whose rank in `ATLAS_IMAGERY_LAYER_ORDER` is ≤ the new layer's; otherwise before the first Atlas layer of a higher rank; otherwise at the end. Names live in a module `WeakMap<ImageryLayer, AtlasImageryLayerName>`.
- **Readiness:** counted on `preRender`; each `preRender` requests a frame while not ready.
- **Delivered tiles:** `tileLoaded` → `scene.requestRender()`.
- **Destroy and stats:** `imageryLayers.remove(layer, true)` and `provider.destroy()`; `drapeStats.watchLayer(layer)` registered at add, removed at destroy.
- **Histogram:** the first bin whose upper bound is ≥ `rasterMs`; only `level ≥ OUTLINE_MIN_LEVEL` counts.
- **Resident bytes:** every watched layer's `_imageryCache` entries with `texture?.width === 256`, × `RESIDENT_TILE_BYTES`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd website && npx vitest run tests/atlas-raster-provider.test.ts tests/atlas-draped-surface-group.test.ts tests/atlas-cesium-internals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/draped/{raster-imagery-provider,draped-imagery-layer,drape-stats}.ts website/tests/helpers/imagery-fakes.ts website/tests/atlas-{raster-provider,draped-surface-group,cesium-internals}.test.ts
git commit -m "feat: serve worker tiles as ordered Cesium imagery layers, and pin the internals they use (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `resolveDrapedView` and the surface controls (P2.4)

**Parallel:** yes, with Tasks 7, 9 and 11.

**Files:**
- Modify: `src/atlas/earth-style-catalog.ts`: new exports after `resolveElevationView` (`:286-292`)
- Modify: `src/components/atlas/InferredSurfaceControls.tsx:11-21` (props), `:88-92` (extruded option), `:147-182` (elevation)
- Modify: `src/components/atlas/ExplorerControls.tsx:363-373`: pass `draped`
- Test: `tests/atlas-terrain-controls.test.ts`

**Interfaces:**
- Consumes: `hasPhysicalRelief` (earth-style-catalog.ts:294), `ExplorerSceneMode`, `SurfaceGeometry` (url-state).
- Produces:
```ts
export interface DrapedView { elevationFactor: number; geometry: SurfaceGeometry; elevationNote: string | null; extrudedLabel: string }
export const DRAPED_ELEVATION_NOTE = 'Not available with World Terrain';
export const DRAPED_EXTRUDED_LABEL = 'Columns (smooth globe only)';
export const EXTRUDED_LABEL = 'Extruded hexagons';
export const DRAPE_FAILED_WARNING =
  'The map data could not be draped over World Terrain, so the smooth globe is shown instead.';
export function resolveDrapedView(i: { draped: boolean; elevation: boolean; exaggeration: number; geometry: SurfaceGeometry; view: ExplorerSceneMode }): DrapedView;
// InferredSurfaceControlsProps + draped: boolean (required); ExplorerControls passes draped={hasPhysicalRelief(appliedTerrain)}
```

- [ ] **Step 1: Write the failing tests**
```ts
describe('draped view (#483)', () => {
  it('forces data elevation to 0 and draws columns as hexagons while draped', () => {
    expect(resolveDrapedView({ draped: true, elevation: true, exaggeration: 3, geometry: 'extruded', view: 'globe' })).toEqual({
      elevationFactor: 0, elevationNote: 'Not available with World Terrain',
      extrudedLabel: 'Columns (smooth globe only)', geometry: 'hexagons' });
    for (const geometry of ['triangles', 'hexagons', 'honmoon', 'honmoon-fill'] as const)
      expect(resolveDrapedView({ draped: true, elevation: false, exaggeration: 1, geometry, view: 'globe' }).geometry).toBe(geometry);
  });
  it("returns today's values on the smooth globe", () => {
    expect(resolveDrapedView({ draped: false, elevation: true, exaggeration: 3, geometry: 'extruded', view: 'globe' }))
      .toEqual({ elevationFactor: 3, elevationNote: null, extrudedLabel: 'Extruded hexagons', geometry: 'extruded' });
    expect(resolveDrapedView({ draped: false, elevation: true, exaggeration: 3, geometry: 'triangles', view: 'map' }).elevationFactor).toBe(0);
  });
  it("disables Statistical elevation with the note while keeping the URL's choice", () => {
    const html = surfaceControls('elevation=true&exaggeration=2&geometry=extruded&terrain=world-terrain', true);
    expect(html).toMatch(/id="atlas-statistical-elevation" type="checkbox" checked="" disabled=""/);
    expect(html).toContain('Not available with World Terrain');
    expect(html).toContain('>Columns (smooth globe only)</option>');
    expect(html).toMatch(/aria-label="Data height exaggeration"[^>]*disabled=""/);
  });
  it('leaves the controls as they were on the smooth globe', () => {
    const html = surfaceControls('elevation=true&exaggeration=2', false);
    expect(html).not.toContain('Not available with World Terrain');
    expect(html).toContain('>Extruded hexagons</option>');
    expect(html).not.toMatch(/id="atlas-statistical-elevation"[^>]*disabled/);
  });
});
```
`surfaceControls(query, draped)` renders `InferredSurfaceControls` with `renderToStaticMarkup`, like `mapControls` in the same file.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-terrain-controls.test.ts -t "draped view"`
Expected: FAIL: `resolveDrapedView is not a function`.

- [ ] **Step 3: Implement `resolveDrapedView`, the `draped` prop and the pass-through**

When draped, the elevation checkbox and the exaggeration slider are `disabled`; `<p className="atlas-control-note" id="atlas-data-height-draped">` holds `elevationNote` and the checkbox's `aria-describedby` names it; the extruded `<option>` text is `extrudedLabel`.

- [ ] **Step 4: Run the tests and the module-size cap**

Run: `cd website && npx vitest run tests/atlas-terrain-controls.test.ts tests/atlas-module-size.test.ts`
Expected: PASS; `AtlasExplorer.tsx` unchanged.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/earth-style-catalog.ts website/src/components/atlas/{InferredSurfaceControls,ExplorerControls}.tsx website/tests/atlas-terrain-controls.test.ts
git commit -m "feat: turn data elevation off and draw columns as hexagons while the data is draped (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: ScientificLayers over `SurfaceGroup`, and wave progress (P2.5)

**Parallel:** yes, with Tasks 7, 9 and 10; it uses a fake draped runtime. It is the only P2 lane that edits `scientific-layers.ts`.

**Files:**
- Create: `src/atlas/scene/surface-groups.ts`, `tests/helpers/draped-fakes.ts`
- Modify: `src/atlas/scene/scientific-layers.ts`: `:68-82` (`ScientificStyle`), `:95-131` (options, scene, `Displayed`), `:170-172` (keys), `:205-211` (caches), `:266-295` (`pickTarget`), `:323-445` (`#show`), `:458-531` (visibility and edges), `:539-556` (`removeSurface`), `:637-772` (moved out), `:774-880` (`#commit`), `:897-1012` (edges and dispose)
- Modify: `src/atlas/scene/reveal-wave-driver.ts:95-112, 229-286`: `progress()`
- Test: `tests/atlas-scientific-layers.test.ts`, `tests/atlas-reveal-wave-driver.test.ts`, `tests/atlas-module-size.test.ts`

**Interfaces:**
- Consumes: `SurfaceGroup`, `DrapedSurfaceGroup`, `DrapedSurfaceGroupOptions`, `DrapedRuntime`, `RasterWorkerClient`, `SurfaceRasterSpec` (Task 6); Task 2's `PickTarget.drawn`/`draped` and the resolver branch, which already takes `target.draped || context.draped()` and skips the reveal check for a draped target (no `surface-pick.ts` change here).
- Produces:
```ts
// RevealWave +
progress(): number; // 1 at rest; 0 from start() to the wave's first drawn frame; then waveEase(clock / durationMs)
// ScientificStyle + draped?: boolean (required from Task 16)
// ScientificLayersOptions: scene adds 'globe' | 'imageryLayers' | 'preRender' | 'postRender'; wave adds 'progress';
//   worker adds RasterWorkerClient; draped?: () => Promise<DrapedRuntime>; onDrapeFailure?: (error: unknown) => void (both required from Task 16)
// scene/surface-groups.ts
export interface SurfaceGroupHost {
  readonly scene: ScientificScene; readonly worker: ScientificLayersOptions['worker']; readonly wave: ScientificLayersOptions['wave'];
  readonly marks: MarkTracker; readonly perf: NonNullable<ScientificLayersOptions['perf']>; readonly frameBudgetMs: number;
  readonly heights: WeakMap<SurfaceGroup, ObservationSurfaceHeights>; style(): ScientificStyle; lookAt(): LookAt;
}
export function createChunkGroup(host: SurfaceGroupHost, load: ArtifactLoad, style: ScientificStyle, cold: boolean): SurfaceChunkGroup; // was #createGroup minus id and overlay bookkeeping
export function streamChunks(host: SurfaceGroupHost, input: ChunkStreamInput): Promise<void>; // was #stream, verbatim
export function buildChunkEdges(host: SurfaceGroupHost, displayed: EdgeSource, group: SurfaceChunkGroup, signal: AbortSignal): Promise<void>; // #buildEdges' worker call
export function drapedSurfaceSpec(load: Pick<ArtifactLoad, 'artifactKey'>, surface: SurfaceArtifact, style: ScientificStyle): SurfaceRasterSpec; // maps a stray 'extruded' to 'hexagons'; contours false until Task 31
export function edgeColorOf(style: Pick<ScientificStyle, 'edgeColorMode' | 'edgeFixedColor'>): EdgeColorSpec;
export function isDrapedGroup(group: SurfaceGroup | null | undefined): group is DrapedSurfaceGroup;
export function opaqueUntilRetired(group: SurfaceGroup): FadeableGroup; // setOpacity(o) → group.setOpacity(o > 0 ? 1 : 0); collection proxies the group's
export function disposeSurfaceGroup(scene: ScientificScene, group: SurfaceGroup): void; // draped → destroy(); chunks → primitives.remove(collection)
export class DrapeFailure extends Error { readonly cause: unknown }
// tests/helpers/draped-fakes.ts
export function fakeDrapedRuntime(): { runtime: Mocked<DrapedRuntime>; groups: FakeDrapedGroup[] }; // every callable member a vi.fn
  // each FakeDrapedGroup records options and opacities, spies its setters, has ready/empty flags,
  // a `prepared` deferred behind prepare(), and cells = options.surface.cells. Task 23 extends this file.
```
`ChunkStreamInput` is the `#stream` input type moved as it is (`:660-670`); `EdgeSource` is `Pick<Displayed, 'artifactKey' | 'geometry' | 'metric' | 'palette' | 'surface'>`.

- [ ] **Step 1: Write the failing tests**

Setup: `harness(overrides, camera, layerOptions)` gains a third argument spread into the `ScientificLayers` options; its scene gains `globe: { tilesLoaded: true }`, `imageryLayers: {}`, `preRender` and `postRender` (`FakeEvent`s). `showDraped(h, id)` runs `setArtifact`, resolves `prepare`, sets `ready` and runs `finishWave()`. `const { runtime, groups } = fakeDrapedRuntime()` per test.

```ts
describe('draped surface (#483)', () => {
  it('builds a draped group, never chunks, for a draped style', async () => {
    const h = harness({ draped: true }, {}, { draped: async () => runtime });
    void h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    expect(h.worker.buildChunks).not.toHaveBeenCalled();
    expect(groups[0].options.surface).toEqual({
      artifactKey: keyOf('hbs'), cells: { masked: true, supported: true }, contours: false,
      geometry: 'triangles', gridSha256: expect.any(String), layer: 'surface', metric: 'post_mean', palette: 'rainbow' });
    expect(groups[0].options).toMatchObject({ cellEdges: false, edgeColor: { mode: 'matched' }, surfaceOpacity: 0.58 });
  });
  it('starts the cold fade at the first isReady, from opacity 0', async () => {
    const h = harness({ draped: true, reducedMotion: false }, {}, { draped: async () => runtime });
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
    await done;
    expect(h.commits).toEqual([keyOf('hbs')]);
  });
  it('keeps the outgoing draped group opaque through a restyle swap and retires it after', async () => {
    runAnimationFramesAtOnce();
    const h = harness({ draped: true, reducedMotion: false }, {}, { draped: async () => runtime });
    await showDraped(h, 'hbs');
    groups[0].opacities.length = 0;
    h.style.palette = 'viridis';
    const restyle = h.layers.rebuild();
    await h.pump();
    groups[1].prepared.resolve();
    groups[1].ready = true;
    await h.pump();
    await restyle;
    expect(new Set(groups[0].opacities)).toEqual(new Set([1, 0]));
    expect(groups[0].opacities.at(-1)).toBe(0);
    expect(groups[0].collection.show).toBe(false);
    expect(groups[1].opacity()).toBe(1);
  });
  it('switches datasets at once and fades the new draped group in on a new wave', async () => {
    /* outgoing opacity 0 and hidden in the commit frame; incoming opacity 1; waveStarts + 1 */
  });
  it('rebuilds when a layer toggle changes the drawn cells, and hides at α 0 when both are off', async () => {
    await showDraped(h, 'hbs');
    h.style.layers = { ...h.style.layers, support: false };
    h.layers.setVisibility(h.style.layers, true);
    await h.pump();
    expect(groups[1].cells).toEqual({ masked: false, supported: true });
    h.style.layers = { ...h.style.layers, support: false, surface: false };
    h.layers.setVisibility(h.style.layers, true);
    await h.pump();
    expect(groups).toHaveLength(2);
    expect(groups[1].setVisibility).toHaveBeenLastCalledWith(false, false);
  });
  it('reports a failed raster and settles with the rebuild it starts', async () => {
    const failures: unknown[] = [];
    const h = harness({ draped: true }, {}, {
      draped: async () => runtime,
      onDrapeFailure: (e) => { failures.push(e); h.style.draped = false; void h.layers.rebuild(); } });
    const done = h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    groups[0].prepared.reject(new Error('raster'));
    await h.pump();
    await expect(done).resolves.toBeUndefined();
    expect(failures).toEqual([new Error('raster')]);
    expect(h.worker.buildChunks).toHaveBeenCalledTimes(1);
    expect(groups[0].destroy).toHaveBeenCalled();
  });
  it('tells picks the group is draped and keeps draped groups out of the depth-pick hide list', async () => {
    await showDraped(h, 'hbs');
    h.style.palette = 'viridis';
    void h.layers.rebuild();
    await h.pump();
    expect(h.layers.pickTarget()).toMatchObject({ draped: true, hidden: [] });
  });
  it('commits a draped surface with nothing to draw, ends its wave and still reads surface-visible', async () => {
    void h.layers.setArtifact(h.load('hbs'));
    await h.pump();
    Object.assign(groups[0], { empty: true, ready: true });
    groups[0].prepared.resolve();
    await h.pump();
    expect(h.attributes.get('data-atlas-wave')).toBe('done');
    expect(h.emitted).toContain('surface-visible');
  });
  it('turns on draped outlines through setCellEdges and marks edges-ready once they are ready', async () => {
    /* setCellEdges(true) → group.setCellEdges(true); outlinesReady → 'edges-ready'; an edge colour change → setOutlineStyle({ color: '#ff0000', mode: 'fixed' }) */
  });
  it('destroys a superseded draped group that was never shown', async () => {
    /* a second setArtifact before the first prepare resolves → groups[0].destroy called once */
  });
  it('shows a cold draped surface at once under reduced motion', async () => {
    /* reducedMotion: true → opacity 1 at ready, the wave reads 'done', wave.progress() is 1 */
  });
});
// atlas-reveal-wave-driver.test.ts
it('reads progress 1 at rest, 0 until its first drawn frame, then the eased timeline', () => {
  const { wave, frame } = harness();
  expect(wave.progress()).toBe(1);
  wave.start(false);
  expect(wave.progress()).toBe(0);
  frame();
  frame(REVEAL_WAVE_MS / 4);
  expect(wave.progress()).toBeCloseTo(waveEase(0.25), 9);
  for (let i = 0; i < 4; i += 1) frame(REVEAL_WAVE_MS / 4);
  expect(wave.progress()).toBe(1);
});
it('reads progress 1 under reduced motion and once a hidden tab ends the wave', () => {
  /* start(true) → 1; start(false) then hide() → 1 */
});
// atlas-module-size.test.ts
it('keeps scientific-layers.ts at or below its 986 logical lines (AGENTS.md: split before adding)', () => {
  expect(logicalLines('../src/atlas/scene/scientific-layers.ts')).toBeLessThanOrEqual(986);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-scientific-layers.test.ts tests/atlas-reveal-wave-driver.test.ts tests/atlas-module-size.test.ts -t "draped|progress|986"`
Expected: FAIL: `wave.progress is not a function`; the draped style still builds chunks.

- [ ] **Step 3: Implement `progress()`, the `surface-groups.ts` move and the draped branches**

The moved functions keep their bodies. **`#show` when `style.draped`** (the scene has already resolved the geometry):
1. Await `options.draped!()`; `runtime.createDrapedSurfaceGroup` with `scene`, `source: runtime.rasterSource(worker)` (memoised per instance), `surface: drapedSurfaceSpec(...)`, `edgeColor: edgeColorOf(style)`, `cellEdges` and `surfaceOpacity` from the style, `wave`, and an `onError` that reports through `onDrapeFailure` once per group, only while the group is displayed or in the current epoch.
2. Set opacity 0 and `await group.prepare(signal)`.
3. Run `waitForReady` as today. If cold, set opacity 1, then `wave.start(reducedMotion)`, or `wave.finish()` when `readyChunkCount()` is 0.

**Errors:** a non-abort error from the runtime import or `prepare` becomes a `DrapeFailure`; the `#show` catch calls `onDrapeFailure?.(cause)` and returns `true` when that started a newer request, else rethrows `cause`.

**Kind branches:**
- The surface key appends `draped:${+cells.supported}${+cells.masked}`, or `chunks`.
- `pickTarget` sets `draped: isDrapedGroup(group)`, keeps only chunk collections in `hidden`, and ANDs `drawn` with `wave.progress() > 0` for draped groups.
- The commit's `leaving` wraps a draped outgoing group in `opaqueUntilRetired`.
- `setVisibility` rebuilds when a draped group's `cells` differ from `{ supported: layers.surface, masked: layers.support }` and at least one layer is on.
- Edges: chunks go through `#buildEdges` as today; draped groups use `setCellEdges`/`setOutlineStyle`, then `waitForReady` on `{ collection: group.collection, isReady: group.outlinesReady, readyCount: () => +group.outlinesReady(), setOpacity() {} }`, then the `edges-ready` mark. The `wave.running()` early return applies to chunks only.
- Dispose, prune and `removeSurface` go through `disposeSurfaceGroup`.

- [ ] **Step 4: Run every ScientificLayers, wave, pick and size test**

Run: `cd website && npx vitest run tests/atlas-scientific-layers.test.ts tests/atlas-reveal-wave-driver.test.ts tests/atlas-surface-pick-terrain.test.ts tests/atlas-picking.test.ts tests/atlas-module-size.test.ts && npm run check`
Expected: PASS; every pre-existing chunk-path test unchanged; 0 errors.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/{scientific-layers,surface-groups,reveal-wave-driver}.ts website/tests/helpers/draped-fakes.ts website/tests/atlas-{scientific-layers,reveal-wave-driver,module-size}.test.ts
git commit -m "feat: let the scientific layers show a draped surface group (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Fill and mask rasteriser (P2.6)

**Parallel:** after Task 7; parallel with Tasks 8–11, 13 and 14.

**Files:**
- Create: `src/atlas/geometry/raster/fill-raster.ts`, `src/atlas/geometry/raster/mask-texels.ts`
- Modify: `src/atlas/geometry/support-buffers.ts:82-129` (export the `st` frame), `:132-215` (`flatCellBuffers` uses it)
- Modify: `tests/helpers/raster-fixtures.ts`: add `lonLatTriangles(chunk)` (positions through `Cartographic.fromCartesian`), `barycentricColour(triangles, lon, lat)`, `tilesCovering(input, level)`, `rowOfCellAt(input, lon, lat)` (null within one texel of a cell edge), `insideInnerDisk`, `columnCoverage(raster, column)`, `drawnRows(raster)`, `centreTexel(input, lonOrRow, latOrLevel)`, `wholeGridChunk(input)`
- Test: `tests/atlas-raster-fill.test.ts`, `tests/atlas-raster-masks.test.ts`, `tests/atlas-raster-coverage.test.ts`

**Interfaces:**
- Consumes: `toTexel`, `tileRectangle`, `GridIndex` and the fixtures (Task 7); `vertexMeans`, `paletteBins`, `isSmoothGeometry`, `colorBytesAtStops`/`linearStops` (surface-buffers.ts); `h3PolygonParts`; `UNKNOWN_HATCH` and `PRIOR_DOTS` (encoding-tokens.ts:26-41).
- Produces:
```ts
export function rasterSurfaceTile(i: SurfaceRasterInput, a: TileAddress): TileRaster | null; // null = empty tile
export const HONMOON_FILL_SHADE = 0.55, HONMOON_FILL_ALPHA = 0.28; // ELEVATED_SURFACE_FRAGMENT_SHADER's fill
export function hatchTexel(st: readonly [number, number], stStep: readonly [number, number], out: Uint8ClampedArray, offset: number): void; // Grid
export function dotTexel(st: readonly [number, number], rgb: readonly [number, number, number], out: Uint8ClampedArray, offset: number): void; // Dot
// support-buffers.ts
export interface StFrame { plane: TangentPlane; minE: number; maxE: number; minN: number; maxN: number }
export function stFrameOf(ring: readonly Vec3[]): StFrame; // ground ECEF ring of one polygon part
export function stAt(frame: StFrame, ground: Vec3): [number, number]; // clamped to [0, 1]
```

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-raster-fill.test.ts
it("matches buildSmoothChunk's colours within 1 byte at every texel it draws", () => {
  const input = rasterInputFor(KENYA_CELLS, { geometry: 'triangles' });
  const triangles = lonLatTriangles(buildSurfaceChunk(input, wholeGridChunk(input)));
  for (const a of tilesCovering(input, 7)) {
    forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
      const expected = barycentricColour(triangles, lon, lat);
      if (rgba[3] === 0 || !expected) return;
      for (let c = 0; c < 3; c += 1) expect(Math.abs(rgba[c] - expected[c])).toBeLessThanOrEqual(1);
    });
  }
});
it('colours each flat hexagon with its paletteBins colour', () => {
  const input = rasterInputFor(KENYA_CELLS, { geometry: 'hexagons' });
  const bins = paletteBins(input, 'supported');
  const a = tileContaining(36.793, -1.836, 7);
  forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
    const r = rowOfCellAt(input, lon, lat);
    if (r === null) return;
    expect(rgba).toEqual([...bins.colors.get(bins.binOfRow[r])!, 255]);
  });
});
it('draws both honmoon geometries as the honmoon fill until contours arrive', () => {
  for (const geometry of ['honmoon', 'honmoon-fill'] as const) {
    const [r, g, b] = centreTexel(rasterInputFor(KENYA_CELLS, { geometry: 'triangles' }), 36.793, -1.836);
    expect(centreTexel(rasterInputFor(KENYA_CELLS, { geometry }), 36.793, -1.836))
      .toEqual([Math.round(r * 0.55), Math.round(g * 0.55), Math.round(b * 0.55), Math.round(0.28 * 255)]);
  }
});
it('leaves no gap along shared edges inside the disk', () => {
  const input = rasterInputFor(KENYA_CELLS, { geometry: 'hexagons' });
  const a = tileContaining(36.793, -1.836, 8);
  forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
    if (insideInnerDisk(input, lon, lat)) expect(rgba[3]).toBe(255); // at least one texel inside the outer ring
  });
});
it('draws a ±180° cell on both sides of the antimeridian, without a seam', () => {
  const input = rasterInputFor(seamCells(), { geometry: 'hexagons' });
  const east = { level: 6, x: 127, y: 32 };
  const west = { level: 6, x: 0, y: 32 };
  expect(columnCoverage(rasterSurfaceTile(input, east)!, 255)).toBe(columnCoverage(rasterSurfaceTile(input, west)!, 0));
  expect(columnCoverage(rasterSurfaceTile(input, west)!, 0)).toBeGreaterThan(0);
});
it('reaches the pole for a pole cell', () => {
  const input = rasterInputFor(poleCells(), { geometry: 'triangles' });
  const top = rasterSurfaceTile(input, { level: 3, x: 8, y: 0 })!;
  for (let column = 0; column < 256; column += 1) expect(texel(top, column, 255)[3]).toBe(255);
});
it('writes rows south-first', () => {
  const input = rasterInputFor([{ h3: latLngToCell(-1.5, 36.8, 4), support: 'observed', value: 0.5 }]);
  const raster = rasterSurfaceTile(input, { level: 4, x: 19, y: 8 })!; // west 33.75, south -11.25, east 45, north 0
  const rows = drawnRows(raster);
  expect(Math.min(...rows)).toBeGreaterThan(200);
  expect(Math.max(...rows)).toBeLessThan(256);
});
it('returns byte-identical tiles for repeated calls, and null for a tile with nothing drawn', () => {
  const input = rasterInputFor(KENYA_CELLS);
  const a = tileContaining(36.793, -1.836, 7);
  expect(rasterSurfaceTile(input, a)!.rgba).toEqual(rasterSurfaceTile(input, a)!.rgba);
  expect(rasterSurfaceTile(input, { level: 7, x: 0, y: 0 })).toBeNull();
});
it('draws supported cells only with cells.supported and masked cells only with cells.masked', () => {
  /* a mixed observed/unknown fixture; for each cells combination the drawn rows equal the expected support set */
});
// atlas-raster-masks.test.ts
it("hatches unknown cells with the Grid material's formula (UNKNOWN_HATCH)", () => {
  const out = new Uint8ClampedArray(4);
  hatchTexel([0, 0.37], [0.01, 0.01], out, 0); // on a line: value 0
  expect([...out]).toEqual([84, 91, 101, 204]); // #a8b5c9 × 0.5; α 0.72 / 0.9
  hatchTexel([0.1, 0.1], [0.01, 0.01], out, 0); // between lines: value 1
  expect(out[3]).toBe(49); // 0.72 × (1 − 0.76) / 0.9 × 255
});
it("dots prior-dominated cells with the Dot material's formula in their bin colour (PRIOR_DOTS)", () => {
  const out = new Uint8ClampedArray(4);
  dotTexel([0.05, 0.05], [200, 40, 40], out, 0); // a dot's centre: the light colour
  expect([...out]).toEqual([Math.round(200 + (255 - 200) * 0.38), Math.round(40 + 215 * 0.38), Math.round(40 + 215 * 0.38), 232]);
  dotTexel([0, 0], [200, 40, 40], out, 0); // between dots: the dark colour
  expect([...out]).toEqual([200, 40, 40, 130]);
});
it("takes st from each part's tangent-plane frame, as the chunk masks do", () => {
  const input = meshInputFor([{ h3: CELL, support: 'unknown', value: 0.5 }]);
  const buffers = flatCellBuffers(input, [0]);
  const ring = h3PolygonParts(CELL)[0].map(([lon, lat]) => ecef(lon, lat, 0));
  ring.forEach((point, i) => expect(stAt(stFrameOf(ring), point)).toEqual([
    expect.closeTo(buffers.st[(i + 1) * 2], 6), expect.closeTo(buffers.st[(i + 1) * 2 + 1], 6)]));
});
// atlas-raster-coverage.test.ts
describe.skipIf(!hasFullGrid)('full-grid coverage (#483: never drop a row)', () => {
  it("colours every supported cell's centre texel at level 8 on the full hbs-rs334 grid", () => {
    const input = fullGridRasterInput(FULL_GRID_SURFACE!, 'hexagons');
    const bins = paletteBins(input, 'supported');
    const misses = supportedRows(input).filter((row) =>
      !sameColour(centreTexel(input, row, 8), [...bins.colors.get(bins.binOfRow[row])!, 255]));
    expect(misses).toEqual([]);
  }, 180_000);
  it("covers every supported cell's centre texel at level 8 in smooth triangles", () => {
    const input = fullGridRasterInput(FULL_GRID_SURFACE!, 'triangles');
    expect(supportedRows(input).filter((row) => centreTexel(input, row, 8)[3] !== 255)).toEqual([]);
  }, 180_000);
});
```
`hasFullGrid` is true when `ATLAS_DATA_DIR` names a staging tree holding the full `hbs-rs334` grid and render tier.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-raster-fill.test.ts tests/atlas-raster-masks.test.ts tests/atlas-raster-coverage.test.ts`
Expected: FAIL: `fill-raster` and `mask-texels` do not resolve; `stFrameOf is not a function`. Without `ATLAS_DATA_DIR` the coverage suite is skipped.

- [ ] **Step 3: Implement `rasterSurfaceTile`, `hatchTexel`, `dotTexel`, `stFrameOf` and `stAt`**

`flatCellBuffers` now calls `stFrameOf` and `stAt`; the existing support tests pin its output. The rasterisation, which the tests do not determine:
```text
rows   = index.rowsIn(tileRectangle(a)); pass 1 draws supported rows if cells.supported, pass 2 masked rows if cells.masked (masks win where they overlap)
fans   supported: the cell centre plus its topology corners, as in buildSmoothChunk (smooth) and buildFlatChunk (flat)
         smooth colours: colorBytesAtStops(stops, t_row) at the centre, colorBytesAtStops(stops, means.values[id]) at corner id
         flat colour:    bins.colors.get(bins.binOfRow[row]), one value for the whole cell
         honmoon (contours false): rgb × HONMOON_FILL_SHADE, α HONMOON_FILL_ALPHA; otherwise α 255
       masked: each h3PolygonParts part fanned round the cell centre, as in flatCellBuffers; colour per texel from
         hatchTexel (unknown) or dotTexel (prior bin colour); st = stAt(stFrameOf(part ring), ecef(texel, 0)); stStep = central differences over one texel
wrap   per vertex w_v ∈ {−1, 0, 1} brings its longitude within 180° of the centre; for each copy s ∈ {−1, 0, 1} whose box meets the tile:
         lon_v = vertexLon + 360 · (w_v + s), the integer sum taken first, so a vertex the copy does not shift keeps its exact value
scan   texel frame from toTexel; for rows ceil(min y)..floor(max y) within 0..255, test each texel centre against the three edge functions
       E(p) = (b.x − a.x)(p.y − a.y) − (b.y − a.y)(p.x − a.x), each evaluated with its endpoints in lexicographic order and the sign flipped
       back, so two triangles sharing an edge compute exact negations; inside if every E > 0, or E = 0 on a top or left edge (top-left rule)
colour barycentric weights E_i / area interpolate the three vertex colours; the Uint8ClampedArray rounds them
polar  a row whose unwrapped corners span > 180° of longitude contains a pole. A texel is inside when its latitude is poleward of the ring
       (the corners, or the part boundary for masks, sorted by longitude and joined by straight lon/lat segments, closed across ±180°).
       A smooth colour uses the barycentric weights, in the azimuthal frame (x, y) = (90° − |lat|)(cos lon, sin lon), of the fan triangle
       whose longitude sector holds the texel
result null if no texel was written
mask α hatch: 0.72 · (1 − (1 − 0.24) · value) / 0.9, value = min over s and t of smoothstep(dF·0.65, dF·1.85, distance to the line), dF = stStep · 5;
       rgb #a8b5c9 × 0.5
       dot:  b = smoothstep(0.3, 0.32, |fract(10 · st) − 0.5|); mix(light = lerp(rgb, white, 0.38) at α 0.82, dark = rgb at α 0.46, b), α ÷ 0.9
```

- [ ] **Step 4: Run the tests to make sure they pass, including the full grid once**

Run: `cd website && npx vitest run tests/atlas-raster-fill.test.ts tests/atlas-raster-masks.test.ts tests/atlas-geometry-support.test.ts && ATLAS_DATA_DIR=<staging tree> npx vitest run tests/atlas-raster-coverage.test.ts`
Expected: PASS; the coverage suite reports 2 passed, not skipped.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/geometry/raster/{fill-raster,mask-texels}.ts website/src/atlas/geometry/support-buffers.ts website/tests/helpers/raster-fixtures.ts website/tests/atlas-raster-{fill,masks,coverage}.test.ts
git commit -m "feat: rasterise the surface fill and support masks into draped tiles (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Outline rasteriser (P2.7)

**Parallel:** after Task 7; parallel with Tasks 8–12 and 14. It keeps its own helpers in its test file, so it does not edit `raster-fixtures.ts` alongside Task 12.

**Files:**
- Create: `src/atlas/geometry/raster/line-raster.ts`
- Test: `tests/atlas-raster-lines.test.ts` (local helpers `outlineInput(cells, edgeColor = { mode: 'matched' })`, `CENTRE_ROW`, `firstCornerOf(input, row)`, `texelAtLonLat(raster, a, lon, lat)`)

**Interfaces:**
- Consumes: `toTexel`, `tileRectangle`, `texelCentre` (Task 7); `brighterEdgeBytes` and `EDGE_ALPHA` (edge-buffers.ts:23-62); `h3PolygonParts`; `paletteBins`; `OUTLINE_MIN_LEVEL`, `RASTER_MAX_LEVEL`, `OUTLINE_WIDTH_TEXELS`.
- Produces (Task 18 reuses `strokePolyline` for borders and footprints):
```ts
export function outlineWidthTexels(level: number): number; // 1.5 at level 3, 2 at level 11, linear, clamped
export function rasterOutlineTile(i: SurfaceRasterInput & { edgeColor: EdgeColorSpec }, a: TileAddress): TileRaster | null;
export function strokePolyline(raster: TileRaster, a: TileAddress, lonLat: ArrayLike<number>, from: number, to: number,
  widthTexels: number, rgb: readonly [number, number, number], alpha: number): void; // points from..to-1, interleaved lon, lat
```

- [ ] **Step 1: Write the failing tests**
```ts
it('draws nothing below level 3, and widens from 1.5 texels at level 3 to 2 at level 11', () => {
  expect(rasterOutlineTile(outlineInput(KENYA_CELLS), tileContaining(36.8, -1.8, 2))).toBeNull();
  expect([3, 7, 11, 14].map(outlineWidthTexels)).toEqual([1.5, 1.75, 2, 2]);
});
it('strokes each supported cell’s rings at α 0.92 in the matched colour, or the fixed one', () => {
  const input = outlineInput(KENYA_CELLS, { mode: 'matched' });
  const bins = paletteBins(input, 'supported');
  const [r, a] = [CENTRE_ROW, tileContaining(...firstCornerOf(input, CENTRE_ROW), 9)];
  expect(texelAtLonLat(rasterOutlineTile(input, a)!, a, ...firstCornerOf(input, r)))
    .toEqual([...brighterEdgeBytes(bins.colors.get(bins.binOfRow[r])!), Math.round(0.92 * 255)]);
  const fixed = outlineInput(KENYA_CELLS, { color: '#ff8000', mode: 'fixed' });
  expect(texelAtLonLat(rasterOutlineTile(fixed, a)!, a, ...firstCornerOf(input, r)).slice(0, 3)).toEqual([255, 128, 0]);
});
it('skips masked cells', () => {
  expect(rasterOutlineTile(outlineInput(KENYA_CELLS.map((c) => ({ ...c, support: 'unknown' }))), tileContaining(36.8, -1.8, 9))).toBeNull();
});
it('anti-aliases over one texel beyond half the width, keeping the higher alpha where lines meet', () => {
  const raster = { rgba: new Uint8ClampedArray(256 * 256 * 4) };
  const a = { level: 8, x: 0, y: 0 };
  const along = (row: number) => { const { lat } = texelCentre(a, 0, row); return [tileRectangle(a).west, lat, tileRectangle(a).east, lat]; };
  strokePolyline(raster, a, along(10), 0, 2, 2, [255, 255, 255], 0.92);
  expect([10, 11, 12].map((row) => texel(raster, 128, row)[3])).toEqual([235, Math.round(0.92 * 0.5 * 255), 0]);
  strokePolyline(raster, a, along(11), 0, 2, 2, [255, 255, 255], 0.5);
  expect(texel(raster, 128, 10)[3]).toBe(235);
});
it('joins a ring across ±180° without a line around the world', () => {
  const input = outlineInput(seamCells());
  expect(rasterOutlineTile(input, { level: 6, x: 64, y: 32 })).toBeNull(); // lon 0..2.8
  expect(rasterOutlineTile(input, { level: 6, x: 0, y: 32 })).not.toBeNull();
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-raster-lines.test.ts`
Expected: FAIL: `line-raster` does not resolve.

- [ ] **Step 3: Implement `outlineWidthTexels`, `strokePolyline` and `rasterOutlineTile`**

The stroke (Task 18 reuses this coverage law): each segment's end is unwrapped (|Δlon| > 180° → ±360°); it is drawn for each copy shifted by 0 or ±360° whose box meets the tile, in the `toTexel` frame. For each texel in the segment's box grown by w/2 + 1, d is the distance from the texel centre to the segment (projection clamped to the ends), coverage c = clamp(w/2 + 0.5 − d, 0, 1), α = round(alpha · c · 255), written with `rgb` only if it exceeds the stored α (max-combine). `rasterOutlineTile` returns null below `OUTLINE_MIN_LEVEL` or when nothing was written; queries rows on the tile rectangle grown by (w/2 + 1) texels; strokes the closed `h3PolygonParts` rings of supported rows at `EDGE_ALPHA`, coloured `brighterEdgeBytes(bin colour)` (matched) or the fixed hex.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd website && npx vitest run tests/atlas-raster-lines.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/geometry/raster/line-raster.ts website/tests/atlas-raster-lines.test.ts
git commit -m "feat: rasterise cell outlines as anti-aliased draped lines (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `DrapedSurfaceGroup` and the draped runtime (P2.8)

**Parallel:** after Task 9; parallel with Tasks 10–13.

**Files:**
- Create: `src/atlas/scene/draped/draped-surface-group.ts`, `src/atlas/scene/draped/runtime.ts`
- Test: `tests/atlas-draped-surface-group.test.ts` (sections `DrapedSurfaceGroup` and `drapedRuntime`)

**Interfaces:**
- Consumes: `AtlasRasterImageryProvider`, `addDrapedImageryLayer`, `drapedLayerName`, `drapeStats` (Task 9); the contracts (Task 6); `fakeSource`, `fakeProvider`, `message` (`tests/helpers/imagery-fakes.ts`).
- Produces:
```ts
export const DRAPED_SURFACE_ALPHA = 0.9;
export function createDrapedSurfaceGroup(o: DrapedSurfaceGroupOptions): DrapedSurfaceGroup;
export const drapedRuntime: DrapedRuntime; // { version: 'atlas-draped-v1', createDrapedSurfaceGroup, addDrapedImageryLayer,
  // providerFromSpec: AtlasRasterImageryProvider.fromSpec, rasterSource: (w) => drapeStats.source(client-backed source), stats: drapeStats }
```

- [ ] **Step 1: Write the failing tests**

Setup: a real `ImageryLayerCollection`, `FakeEvent` `preRender` and `postRender`, `globe.tilesLoaded`, `fakeSource(bounds)` (a new `rasterId` per prepare). `alphas(scene)` maps layers to `[name, alpha]` bottom to top. `OPTIONS`: `surfaceOpacity: 0.58`, `cellEdges: false`, `edgeColor: { mode: 'matched' }`, `cells: { supported: true, masked: true }`; `REST = { progress: () => 1, running: () => false }`.

```ts
it('drapes atlas-surface at 0.9 × surface opacity × opacity × progress', async () => {
  const group = createDrapedSurfaceGroup({ ...OPTIONS, scene, source, wave: REST });
  await group.prepare(signal);
  expect(alphas(scene)).toEqual([['atlas-surface', expect.closeTo(0.9 * 0.58, 9)]]);
  group.setOpacity(0.5);
  expect(alphas(scene)[0][1]).toBeCloseTo(0.9 * 0.58 * 0.5, 9);
  group.setSurfaceOpacity(1);
  expect(alphas(scene)[0][1]).toBeCloseTo(0.45, 9);
});
it('fades both layers with the wave on each frame while it runs', async () => {
  let progress = 0;
  const group = createDrapedSurfaceGroup({ ...OPTIONS, cellEdges: true, scene, source, wave: { progress: () => progress, running: () => true } });
  await group.prepare(signal);
  progress = 0.5;
  scene.preRender.raiseEvent();
  expect(alphas(scene)).toEqual([['atlas-surface', expect.closeTo(0.9 * 0.58 * 0.5, 9)], ['atlas-outlines', 0.5]]);
});
it('adds atlas-outlines only once cell edges are on, then toggles them by alpha alone', async () => {
  const group = createDrapedSurfaceGroup({ ...OPTIONS, scene, source, wave: REST });
  await group.prepare(signal);
  expect(alphas(scene).map(([n]) => n)).toEqual(['atlas-surface']);
  await group.setCellEdges(true);
  expect(source.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ edgeColor: { mode: 'matched' }, layer: 'outlines' }), expect.any(AbortSignal));
  await group.setCellEdges(false);
  await group.setCellEdges(true);
  expect(source.prepare).toHaveBeenCalledTimes(2);
  expect(alphas(scene)[1]).toEqual(['atlas-outlines', 1]);
});
it('keeps outlines independent of surface opacity and hides them with the surface layer', async () => {
  /* setSurfaceOpacity(0.2) leaves the outline α at 1; a group built with cells { supported: false, masked: true } adds no outlines layer */
});
it('replaces its outlines on setOutlineStyle', async () => {
  /* a new outlines prepare with { color: '#ff0000', mode: 'fixed' }; the old outline layer is gone and its raster released */
});
it('is ready with its surface layer, and counts one ready chunk after its first drawn tile', async () => {
  /* not ready → globe.tilesLoaded + 2 frames → isReady(); readyChunkCount() 0 until provider.tileLoaded raises a message with a non-null bitmap */
});
it('draws nothing with both cells off, keeping its raster', async () => {
  group.setVisibility(false, false);
  expect(alphas(scene)[0][1]).toBe(0);
  group.setVisibility(true, true);
  expect(alphas(scene)[0][1]).toBeCloseTo(0.522, 9);
  expect(source.release).not.toHaveBeenCalled();
});
it('maps collection.show to setShown and ignores elevation, scene mode and edge holds', async () => {
  group.collection.show = false;
  expect(scene.imageryLayers.get(0).show).toBe(false);
  const before = alphas(scene);
  group.setElevationFactor(3);
  await group.setSceneMode('map');
  group.setEdgesHeld(true);
  expect(alphas(scene)).toEqual(before);
});
it("reports its providers' errorEvent through onError", async () => { /* provider.errorEvent.raiseEvent(error) → onError(error) */ });
it('adds no layer for a raster with nothing to draw, and is ready at once', async () => {
  const group = createDrapedSurfaceGroup({ ...OPTIONS, scene, source: fakeSource(null), wave: REST });
  await group.prepare(signal);
  expect(scene.imageryLayers.length).toBe(0);
  expect(group.isReady()).toBe(true);
  expect(group.readyChunkCount()).toBe(0);
});
it('removes both layers and releases both rasters on destroy, and drops a prepare it aborted', async () => { /* … */ });
it('shows at once when the wave rests (reduced motion, hidden tab)', async () => {
  /* wave REST → α 0.9 × 0.58 right after prepare */
});
// describe('drapedRuntime')
it('carries the atlas-draped-v1 marker and counts tiles through its raster source', async () => {
  const client = { prepareRaster: vi.fn(), rasterTile: vi.fn(async (b) => ({ ...b, bitmap: null, rasterMs: 1 })), releaseRaster: vi.fn() };
  const before = drapedRuntime.stats.read().requested;
  await drapedRuntime.rasterSource(client).tile({ level: 3, rasterId: 1, x: 0, y: 0 });
  expect(drapedRuntime.version).toBe('atlas-draped-v1');
  expect(drapedRuntime.stats.read().requested).toBe(before + 1);
});
it('builds a provider for any raster, a border one stopping at its maximum level', async () => {
  const provider = await drapedRuntime.providerFromSpec(fakeSource(), { color: '#ffffff', layer: 'borders', maximumLevel: 10 }, signal);
  expect(provider).toBeInstanceOf(AtlasRasterImageryProvider);
  expect(provider.maximumLevel).toBe(10);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-draped-surface-group.test.ts -t "DrapedSurfaceGroup|drapedRuntime"`
Expected: FAIL: `draped-surface-group` and `runtime` do not resolve.

- [ ] **Step 3: Implement `createDrapedSurfaceGroup` and `drapedRuntime`**

- **Alpha:** `surfaceα = hidden ? 0 : 0.9 × surfaceOpacity × opacity × progress`; `outlineα = hidden || !cellEdges || !cells.supported ? 0 : opacity × progress`, where `hidden` is `!surface && !support` after `setVisibility`. Every setter and every `preRender` recomputes both and writes only a changed one.
- **`prepare(signal)`:** (1) `AtlasRasterImageryProvider.fromSpec(source, surface, signal)`; null `bounds` destroys the provider and adds no layer; otherwise `addDrapedImageryLayer({ name: 'atlas-surface', … })`, subscribing `errorEvent` → `onError` and `tileLoaded` (a non-null bitmap marks the first drawn tile). (2) If `cellEdges && cells.supported`, prepare the outlines the same way from `{ layer: 'outlines', edgeColor, … }`. (3) An internal controller aborts on `destroy()`; a provider resolving after an abort is destroyed.
- **Other members:** `outlinesReady()` = outlines prepared and their layer ready, or prepared with nothing to draw; `collection` = a `{ show }` accessor pair over `setShown` on both layers; `totalCount() = 1`; `readyCount() = +isReady()`; `readyChunkCount() = +firstTileDrawn`; the elevation, scene-mode and edge-hold setters do nothing.
- `runtime.ts`: `rasterSource(w) = drapeStats.source({ prepare: (s, signal) => w.prepareRaster(s, signal), tile: (b) => w.rasterTile(b), release: (id) => void w.releaseRaster(id) })`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd website && npx vitest run tests/atlas-draped-surface-group.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/draped/{draped-surface-group,runtime}.ts website/tests/atlas-draped-surface-group.test.ts
git commit -m "feat: drape the surface and its outlines as a fadeable imagery group (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Worker integration (P2.int-a)

**Parallel:** no. Depends on Tasks 8, 12 and 13.

**Files:**
- Modify: `src/atlas/worker/handlers.ts:70-84`: the lazy raster adapter replaces Task 6's placeholder
- Modify: `src/atlas/worker/raster-handlers.ts`: `ATLAS_RASTERISERS`
- Modify: `src/atlas/worker/atlas-data.worker.ts:1-4`: the docstring allows the one lazy raster import
- Test: `tests/atlas-worker-client.test.ts`, `tests/atlas-bundle.test.ts`

**Interfaces:**
- Consumes: `createRasterRuntime`, `imageDataBitmap` (Task 8), `rasterSurfaceTile` (Task 12), `rasterOutlineTile` (Task 13), `geometryRuntime(context).worker.prepared` (Task 8).
- Produces: `export const ATLAS_RASTERISERS: Rasterisers = { outlines: rasterOutlineTile, surface: rasterSurfaceTile }`. In `handlers.ts`, `raster<K extends RasterRequestType>(type: K): RequestHandler<K>` imports `./raster-handlers` once per `WorkerState` (`WeakMap<WorkerState, Promise<RasterRuntime>>`), registers `context.signal` under `context.id` as `geometry()` does, and builds the context: `prepared` = `geometryRuntime(context).worker.prepared`; `gridFor` and `render` as in `geometryRuntime`; `naturalEarth: () => null`; `isCancelled` from the signals map; `now = performance.timeOrigin + performance.now()`; `yieldToEventLoop = messageChannelYield()`; `toBitmap = imageDataBitmap`.

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-worker-client.test.ts
it('drapes end to end through the worker: prepare, a drawn tile, release', async () => {
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  vi.stubGlobal('createImageBitmap', async (image: { data: Uint8ClampedArray }) => image.data.buffer); // a transferable stand-in
  const { client: atlas } = client();
  await atlas.loadGrid(toBuffer(goldenBytes(entry.url)), { entry, gridSha256 });
  await atlas.loadRender(toBuffer(goldenBytes(ref.web.render.url)), ref);
  const ready = await atlas.prepareRaster({ ...SURFACE_SPEC, artifactKey: artifactKeyFor(ref), gridSha256 });
  expect(ready.bounds).not.toBeNull();
  const tile = await atlas.rasterTile({ rasterId: ready.rasterId, ...tileContaining(...centreOf(ready.bounds!), 6) });
  expect((tile.bitmap as unknown as ArrayBuffer).byteLength).toBe(256 * 256 * 4);
  await atlas.releaseRaster(ready.rasterId);
  await expect(atlas.rasterTile({ level: 6, rasterId: ready.rasterId, x: 0, y: 0 })).rejects.toMatchObject({ code: 'cancelled' });
});
// atlas-bundle.test.ts
it("keeps the raster runtime out of the worker's first load", () => {
  const worker = readdirSync(assets).find((name) => /^atlas-data\.worker[-.].+\.js$/.test(name))!;
  for (const file of staticGraph(worker)) expect(code(file).includes('atlas-raster-v1'), file).toBe(false);
  expect(readdirSync(assets).some((name) => name.endsWith('.js') && code(name).includes('atlas-raster-v1'))).toBe(true);
});
```
`centreOf(bounds)` returns `[lon, lat]` of the rectangle's middle.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-worker-client.test.ts tests/atlas-bundle.test.ts -t "drapes end to end|raster runtime out"`
Expected: FAIL: `prepareRaster` rejects with `The Atlas raster runtime is wired in Task 15`; no asset contains `atlas-raster-v1`.

- [ ] **Step 3: Implement the adapter and `ATLAS_RASTERISERS`, and amend the worker docstring**

The docstring reads: "Cesium-free; its one `import()` loads the raster runtime on the first raster request (terrain draping design, "Per layer under World Terrain")".

- [ ] **Step 4: Run the worker and bundle tests to make sure they pass**

Run: `cd website && npx vitest run tests/atlas-worker-client.test.ts tests/atlas-worker-dispatcher.test.ts tests/atlas-bundle.test.ts`
Expected: PASS; "bundles the data worker as a Cesium-free ES module" still passes.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/worker/{handlers,raster-handlers,atlas-data.worker}.ts website/tests/atlas-{worker-client,bundle}.test.ts
git commit -m "feat: load the raster runtime in the data worker on the first draped tile (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Scene integration (P2.int-b)

**Parallel:** no. Depends on Tasks 10, 11, 14 and 15.

**Files:**
- Modify: `src/atlas/scene/atlas-scene.ts`: `:11-17, :71` (imports), `:150-169` (state), `:231-242` (`ScientificLayers` options), `:278-294` (`#scientificStyle`), `:345-360` (terrain and elevation helpers), `:430-432` (`setTerrain`), `:641-662` (`destroy`)
- Modify: `src/atlas/scene/context-controller.ts:41-44`: warning id `'drape'`
- Modify: `src/atlas/scene/scientific-layers.ts`: `ScientificStyle.draped`, `draped` and `onDrapeFailure` become required
- Modify: `src/atlas/e2e-hooks.ts`: `__atlasDrapeStats` and `drapeStatsTestHook`
- Test: `tests/atlas-scene-terrain.test.ts`, `tests/atlas-e2e-hooks.test.ts`, `tests/atlas-bundle.test.ts`

**Interfaces:**
- Consumes: `resolveDrapedView`, `DRAPE_FAILED_WARNING` (Task 10); the `ScientificLayers` options (Task 11); `drapedRuntime` (Task 14); `ContextController.setTerrain`/`onTerrainApplied` (PR 1).
- Produces:
```ts
// context-controller.ts
ContextWarning['id']: 'basemap' | 'terrain' | 'drape';
// e2e-hooks.ts
export function drapeStatsTestHook(read: () => DrapeStats): (() => void) | undefined; // window.__atlasDrapeStats in e2e builds only
// atlas-scene.ts (private; phase 3 builds on these names)
#drapeTerrain: boolean;                         // the scene's draped rule (Global Constraints)
#requestTerrain(terrain: TerrainId): Promise<boolean>;
#setDrapeTerrain(next: boolean): void;          // on a change: void this.#layers.rebuild(); void this.setElevation(this.#elevation, this.#exaggeration)
#drapedView(): DrapedView;                      // resolveDrapedView({ draped: #drapeTerrain, elevation, exaggeration, geometry: #surfaceGeometry, view: #mode })
#loadDrapedRuntime(): Promise<DrapedRuntime>;   // memoised import('./draped/runtime'); a rejected import is forgotten
#onDrapeFailure(error: unknown): void;          // console.warn; warning { id: 'drape', message: DRAPE_FAILED_WARNING }; #requestTerrain('smooth-globe')
```

- [ ] **Step 1: Write the failing tests**

Setup: the `ContextController` mock's `setTerrain` (replacing Task 4's never-settling fake) is `(t) => { harness.terrainRequests.push(t); return harness.nextTerrain(); }`, a deferred per call in `harness.terrain`; the `ScientificLayers` mock records its options in `harness.layers` and counts `rebuild` calls (`rebuilds()`); `vi.mock('../src/atlas/scene/draped/runtime', runtimeFactory)` with `runtimeFactory` a `vi.fn` returning `{ drapedRuntime: FAKE }`; `e2e-hooks` is partly mocked so `drapeStatsTestHook` returns the spy `harness.removeDrapeStats`.

```ts
describe('draping (#483)', () => {
  it("drapes on the requested terrain at once, so the URL's World Terrain builds no chunks first", () => {
    const scene = createAtlasScene(container(), OPTIONS);
    void scene.setTerrain('world-terrain');
    expect(harness.layers!.style().draped).toBe(true);
    expect(rebuilds()).toBe(1);
  });
  it('falls back to chunks when World Terrain fails to load: one rebuild back', async () => {
    void scene.setTerrain('world-terrain');
    harness.terrain[0].resolve(false);
    await flushTasks();
    expect(harness.layers!.style().draped).toBe(false);
    expect(rebuilds()).toBe(2);
  });
  it('forces data elevation to 0 and extruded to hexagons while draped, restoring them after', async () => {
    await scene.setElevation(true, 3); // reducedMotion: true
    void scene.setTerrain('world-terrain');
    await flushTasks();
    expect(harness.factors.at(-1)).toBe(0);
    await scene.setSurfaceStyle('rainbow', 0.58, false, 'matched', '#b9f5ff', 'extruded');
    expect(harness.layers!.style().geometry).toBe('hexagons');
    harness.terrain[0].resolve(true);
    void scene.setTerrain('smooth-globe');
    harness.terrain[1].resolve(true);
    await flushTasks();
    expect(harness.factors.at(-1)).toBe(3);
    expect(harness.layers!.style().geometry).toBe('extruded');
  });
  it('reverts to the smooth globe with the drape warning when a raster fails, until the next choice', () => {
    const warnings: (readonly ContextWarning[])[] = [];
    scene.onWarning((w) => warnings.push(w));
    void scene.setTerrain('world-terrain');
    harness.layers!.onDrapeFailure(new Error('tile'));
    expect(harness.terrainRequests).toEqual(['world-terrain', 'smooth-globe']);
    expect(warnings.at(-1)).toContainEqual({ id: 'drape', message: DRAPE_FAILED_WARNING });
    expect(harness.layers!.style().draped).toBe(false);
    void scene.setTerrain('world-terrain');
    expect(warnings.at(-1)!.some(({ id }) => id === 'drape')).toBe(false);
  });
  it('keeps the newest of rapid World Terrain, smooth and World Terrain requests', async () => {
    void scene.setTerrain('world-terrain');
    void scene.setTerrain('smooth-globe');
    void scene.setTerrain('world-terrain');
    harness.terrain[1].resolve(true);
    harness.terrain[2].resolve(true);
    harness.terrain[0].resolve(false);
    await flushTasks();
    expect(harness.layers!.style().draped).toBe(true);
    expect(rebuilds()).toBe(3);
  });
  it('loads the draped runtime once, only when asked, and removes the drape stats reader on destroy', async () => {
    expect(runtimeFactory).not.toHaveBeenCalled();
    const [a, b] = [harness.layers!.draped(), harness.layers!.draped()];
    expect(a).toBe(b);
    await a;
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    scene.destroy();
    expect(harness.removeDrapeStats).toHaveBeenCalledTimes(1);
  });
});
// atlas-e2e-hooks.test.ts
describe('drapeStatsTestHook', () => {
  it('publishes nothing outside the e2e build', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '');
    expect(drapeStatsTestHook(() => STATS)).toBeUndefined();
    expect(page.__atlasDrapeStats).toBeUndefined();
  });
  it('publishes the reader and removes only its own', () => {
    const page = published();
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const remove = drapeStatsTestHook(() => STATS)!;
    expect(page.__atlasDrapeStats!()).toBe(STATS);
    const newer = () => STATS;
    page.__atlasDrapeStats = newer;
    remove();
    expect(page.__atlasDrapeStats).toBe(newer);
  });
});
// atlas-bundle.test.ts
it('keeps the draped modules out of the /app/ initial chunks', () => {
  for (const file of new Set([...staticGraph(islandChunk()), ...staticGraph(sceneChunk())]))
    expect(code(file).includes('atlas-draped-v1'), file).toBe(false);
  expect(readdirSync(assets).some((name) => name.endsWith('.js') && code(name).includes('atlas-draped-v1'))).toBe(true);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-scene-terrain.test.ts tests/atlas-e2e-hooks.test.ts tests/atlas-bundle.test.ts -t "draping|drapeStatsTestHook|draped modules"`
Expected: FAIL: `style().draped` is `undefined`, `drapeStatsTestHook is not a function`, and no asset contains `atlas-draped-v1`.

- [ ] **Step 3: Implement the wiring**

`#drapedView()` feeds `#targetElevationFactor()`, `#scientificStyle().geometry` and `draped: #drapeTerrain`. `#requestTerrain` calls `ContextController.setTerrain`, sets the flag from the request and, on settle, if still the newest request, from `#appliedTerrain`. The public `setTerrain` also clears the `'drape'` warning. The `ScientificLayers` option `draped` is `() => this.#loadDrapedRuntime()`, which also publishes `drapeStatsTestHook(() => drapedRuntime.stats.read())` and keeps its remover; `onDrapeFailure` is `(e) => this.#onDrapeFailure(e)`. `destroy()` calls the remover.

- [ ] **Step 4: Run the scene, hook, bundle and check gates**

Run: `cd website && npx vitest run tests/atlas-scene*.test.ts tests/atlas-e2e-hooks.test.ts tests/atlas-bundle.test.ts && npm run check`
Expected: PASS; the Cesium gzip pin holds; 0 errors.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/{atlas-scene,context-controller,scientific-layers}.ts website/src/atlas/e2e-hooks.ts website/tests/atlas-{scene-terrain,e2e-hooks,bundle}.test.ts
git commit -m "feat: drape the surface whenever World Terrain is requested, and fall back on a raster failure (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: End-to-end tests and the performance report (P2.int-c)

**Parallel:** no. Depends on Task 16.

**Files:**
- Modify: `src/atlas/e2e-hooks.ts:34-46`: `TerrainProbe` fields
- Modify: `src/atlas/scene/synthetic-terrain.ts:72-97`: `publishTerrainProbe`
- Modify: `playwright.config.ts:20-26`: add `'atlas-terrain-performance.spec.ts'`
- Modify: `tests/atlas-drape.spec.ts`: drop `test.fail()` from the #483 repro; add the tests below inside its `@desktop-chromium` describe (whose `beforeEach` already sets the synthetic terrain)
- Create: `tests/atlas-terrain-performance.spec.ts`
- Test: `tests/atlas-synthetic-terrain.test.ts`

**Interfaces:**
- Consumes: the Task 5 helpers (`openDrape`, `drapeQuery`, `probe`, `cameraSettled`, `openTerrainChooser`, `apexOnPage`, `summitPatch`, `changedShare`, `surfaceVisibleAtApex`); `drapedLayerName`, `addDrapedImageryLayer` (Task 9); `window.__atlasDrapeStats` (Task 16).
- Produces: `TerrainProbe` gains `draped: boolean` (an `atlas-surface` layer is shown at α > 0) and `imageryLayers: string[]` (shown layers with α > 0, bottom to top, non-Atlas layers named `'basemap'`).

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-synthetic-terrain.test.ts
it('lists the shown imagery layers bottom to top and says whether the surface is draped', () => {
  const widget = fakeWidget(); // a real ImageryLayerCollection under scene.imageryLayers
  widget.scene.imageryLayers.addImageryProvider(fakeProvider());
  addDrapedImageryLayer({ alpha: 0.5, name: 'atlas-surface', provider: fakeProvider(), scene: widget.scene });
  addDrapedImageryLayer({ alpha: 0, name: 'atlas-outlines', provider: fakeProvider(), scene: widget.scene });
  publishTerrainProbe(widget as never);
  expect(window.__atlasTerrainProbe!()).toMatchObject({ draped: true, imageryLayers: ['basemap', 'atlas-surface'] });
});
// atlas-drape.spec.ts
test('a cold load with terrain=world-terrain drapes without building chunks first', async ({ page }) => {
  await openDrape(page, drapeQuery('nadir', 1));
  expect(await probe(page)).toMatchObject({ draped: true, imageryLayers: ['basemap', 'atlas-surface'], provider: 'synthetic' });
  expect(await page.evaluate(() => performance.getEntriesByName('atlas:chunk-add').length)).toBe(0);
});
test('the draped surface stays visible and pickable after each morph', async ({ page }) => {
  await openDrape(page, drapeQuery('oblique', 1));
  await page.locator('summary').filter({ hasText: /^Map$/ }).click();
  for (const view of ['Map', 'Perspective', 'Globe']) {
    await page.getByRole('radio', { name: view }).check();
    await cameraSettled(page);
    await expect.poll(() => surfaceVisibleAtApex(page), { timeout: 30_000 }).toBe(true);
    const apex = await apexOnPage(page);
    await page.mouse.click(apex.x, apex.y);
    await expect(
      page.getByRole('complementary', { name: 'Selected map cell' }).locator('dt', { hasText: 'Cell ID' }).locator('..').locator('dd'),
    ).toHaveText(latLngToCell(SYNTHETIC_PEAK.lat, SYNTHETIC_PEAK.lon, 4));
  }
});
test('a palette restyle swaps the draped layer, and the outlines toggle is instant', async ({ page }) => {
  await openDrape(page, drapeQuery('nadir', 1));
  const before = await summitPatch(page, await apexOnPage(page));
  await page.getByLabel('Surface palette').selectOption('viridis');
  await expect.poll(async () => (await probe(page)).imageryLayers.filter((n) => n === 'atlas-surface').length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => changedShare(page, before, await summitPatch(page, await apexOnPage(page)))).toBeGreaterThanOrEqual(0.5);
  const outlines = page.getByLabel('Cell outlines');
  await outlines.check();
  await expect.poll(async () => (await probe(page)).imageryLayers, { timeout: 30_000 }).toContain('atlas-outlines');
  const requested = await page.evaluate(() => window.__atlasDrapeStats!().requested);
  await outlines.uncheck();
  await expect.poll(async () => (await probe(page)).imageryLayers, { timeout: 1_000 }).not.toContain('atlas-outlines');
  await outlines.check();
  await expect.poll(async () => (await probe(page)).imageryLayers, { timeout: 1_000 }).toContain('atlas-outlines');
  expect(await page.evaluate(() => window.__atlasDrapeStats!().requested)).toBe(requested);
});
test('returning to the smooth globe restores chunks, data elevation and extruded columns', async ({ page }) => {
  await openDrape(page, drapeQuery('nadir', 1, { elevation: 'true', exaggeration: '2', geometry: 'extruded' }));
  await page.locator('summary').filter({ hasText: /^Inferred surface$/ }).click();
  await expect(page.getByText('Not available with World Terrain')).toBeVisible();
  await expect(page.locator('#atlas-surface-geometry option[value="extruded"]')).toHaveText('Columns (smooth globe only)');
  await expect(page.locator('#atlas-statistical-elevation')).toBeDisabled();
  await expect(page).toHaveURL(/elevation=true/);
  const chooser = await openTerrainChooser(page);
  await chooser.getByRole('radio', { name: 'Smooth Globe terrain' }).click();
  await expect.poll(async () => (await probe(page)).imageryLayers, { timeout: 30_000 }).toEqual(['basemap']);
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('atlas:chunk-add').length)).toBeGreaterThan(0);
  await expect(page.locator('#atlas-statistical-elevation')).toBeEnabled();
  await expect(page.locator('#atlas-surface-geometry option[value="extruded"]')).toHaveText('Extruded hexagons');
});
// atlas-terrain-performance.spec.ts: report-only until Task 36; runs in both projects
test('reports the World Terrain draped budgets (report-only until phase 4)', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const mobile = testInfo.project.name === 'mobile-chromium';
  await page.addInitScript(() => {
    window.__atlasSyntheticTerrain = true;
    const frames: number[] = ((window as never as { __atlasLongFrames: number[] }).__atlasLongFrames = []);
    new PerformanceObserver((list) => frames.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'long-animation-frame', buffered: true });
  });
  if (mobile) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const report = mobile ? await coldLoadDraped(page) : await switchToDraped(page); // { dataVisibleMs }
  Object.assign(report, await restyleMs(page), await orbitFps(page, 3_000), await drapeReport(page));
  console.log(`atlas terrain budgets (${testInfo.project.name}): ${JSON.stringify(report)}`);
  await testInfo.attach('terrain-budgets.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect((await page.evaluate(() => window.__atlasDrapeStats!())).delivered).toBeGreaterThan(0);
});
```
The report's local helpers, all over `drapeQuery('oblique', 1, …)`: `dataVisibleMs` from the terrain choice (desktop, through `openTerrainChooser`; mobile, a cold load of `terrain=world-terrain` from the terrain being applied) to `probe.draped && __atlasDrapeStats().delivered > 0`; `restyleMs` from the palette change to one `atlas-surface` and `tilesLoaded`; `orbitFps` from the animation-frame count while ArrowLeft is held for 3 s; `longestFrameMs` from `__atlasLongFrames`; `rasterP95UpperMs` the upper bound of the bin reaching 95% of `rasterMs`; `residentBytes` from `__atlasDrapeStats`; `renderer` from `WEBGL_debug_renderer_info` as in `atlas-performance.spec.ts`. The report logs the Global Constraints' World Terrain budgets next to the measurements.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd website && npx vitest run tests/atlas-synthetic-terrain.test.ts -t "shown imagery layers" && PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ PUBLIC_GA_MEASUREMENT_ID=G-TEST123 npm run build:e2e && npx playwright test tests/atlas-drape.spec.ts --project=desktop-chromium`
Expected: FAIL: the probe has no `imageryLayers`; Playwright reports the repro "Expected to fail, but passed" under `test.fail()`, and the new tests fail on `draped: undefined`.

- [ ] **Step 3: Implement the probe fields, remove the repro's `test.fail()` and register the performance spec**

The probe walks `scene.imageryLayers` from index 0, keeps each layer with `show && alpha > 0`, and names it `drapedLayerName(layer) ?? 'basemap'`.

- [ ] **Step 4: Run the e2e specs to make sure they pass**

Run: `cd website && npx vitest run tests/atlas-synthetic-terrain.test.ts && PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ PUBLIC_GA_MEASUREMENT_ID=G-TEST123 npm run build:e2e && npx playwright test tests/atlas-drape.spec.ts tests/atlas-terrain.spec.ts tests/atlas-terrain-performance.spec.ts`
Expected: PASS on both projects; the performance spec logs `atlas terrain budgets (desktop-chromium): {…}` and `atlas terrain budgets (mobile-chromium): {…}`.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/{e2e-hooks,scene/synthetic-terrain}.ts website/playwright.config.ts website/tests/atlas-drape.spec.ts website/tests/atlas-terrain-performance.spec.ts website/tests/atlas-synthetic-terrain.test.ts
git commit -m "test: pass the #483 repro on draped data and report the World Terrain budgets (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Phase 2 ship checklist

- [ ] `cd website && npm run format:check`, then `npm run check` (0 errors).
- [ ] `npm test`, once with `ATLAS_DATA_DIR=<staging tree>` so the full-grid coverage suite runs; say in the PR whether it ran. This covers `atlas-bundle` (both markers and the Cesium gzip pin), `atlas-module-size` (both caps), the internals pins and the pixel diff.
- [ ] The e2e build, then `npx playwright test tests/atlas-drape.spec.ts tests/atlas-terrain.spec.ts tests/atlas-terrain-performance.spec.ts tests/atlas-mobile.spec.ts tests/site.spec.ts`.
- [ ] Smooth-globe budgets unchanged: `cd website && npm run build && npm run test:performance -- tests/atlas-performance.spec.ts tests/atlas-cold-load.spec.ts`.
- [ ] Repo gates: `python scripts/smoke.py` and `python scripts/check_private_files.py`; check staged paths with `git diff --cached --name-only`.
- [ ] **PR** title: `feat: drape the Atlas surface onto World Terrain (advances #483)`. TL;DR:
  - With World Terrain on, the data worker rasterises the inferred surface, its support masks and its cell outlines, and they lie on the ground as Cesium imagery layers (`atlas-surface`, `atlas-outlines`); high ground no longer hides them, and the hillshade lights them.
  - A restyle cross-fades the new layer in over an opaque old one once its tiles load, or after 3 s at most. The cold reveal is a 1 s fade; reduced motion shows it at once.
  - While draped, data elevation is off (the URL keeps it; the control says "Not available with World Terrain") and extruded draws as hexagons ("Columns (smooth globe only)"). Honmoon shows its fill; contours come in phase 4.
  - A cold load with `terrain=world-terrain` builds the draped surface directly. If ion or a raster fails, the smooth globe comes back with a warning. Picks on draped data go through `globe.pick`.
  - The smooth globe is unchanged; the draped code loads only on demand (bundle tests) and every existing budget holds. World Terrain performance is reported here and asserted in phase 4.
  - Still at fixed heights until phase 3: borders, sampling rings, symbols, labels and the highlight.
  - Body ends `advances #483`, then the Claude Code line.

---

## Phase 3: Context, observations and relief (Tasks 18–26)

**Branch:** `feat/atlas-drape-3`, stacked on `feat/atlas-drape-2`. One PR.

**What ships.** With World Terrain on, country borders and sampling footprints drape as imagery layers; country labels clamp 2,500 m above the ground; observation symbols and the highlight sit on `globe.getHeight`; and all of it follows PR 1's Physical relief, so PR 1's "World Terrain can hide map data…" warning is retired.

**Spec sections** (by heading): "Per layer under World Terrain", "Exaggeration", "2D and Columbus", "Failure modes", "Test plan".

### Phase 3 decisions

1. **Providers for other owners** come from `DrapedRuntime.providerFromSpec` and `rasterSource(w: RasterWorkerClient)` (Tasks 6, 9, 14), so main-thread code never imports the lazy provider class.
2. **Relief resamples would read stale heights.** Cesium re-exaggerates loaded tile meshes inside the *next* frame (GlobeSurfaceTileProvider.js:555-575 → GlobeSurfaceTile.js:415-466); until it renders, `globe.getHeight` (Globe.js:851) returns the old exaggeration. `ground-heights.ts` adds `afterNextRender(scene, run)`, and the scene resamples from it.
3. **Files the skeleton leaves out:** `scene/scientific-layers.ts` (one hot-file task, 24, wires a new `scene/observation-drapes.ts` so the 986-line cap holds); `worker/handlers.ts` (passes `naturalEarth`); `geometry/raster/types.ts` (`Rasterisers` gains borders and footprints); `scene/observation-symbols.ts`; `scene/scene-transition.ts` (`whenLayerReady`); `scene/synthetic-terrain.ts` and `e2e-hooks.ts` (`__atlasWindowOf`, `__atlasLabelClearance`); `tests/atlas-terrain.spec.ts` and `tests/atlas-terrain-controls.test.ts` (PR 1 asserts the warning P3 retires).
4. **Semantics:** `setFootprints(l)` takes ownership and destroys the layer it replaces or clears; calling `HighlightLayer.setGround(g)` again re-samples the shown highlights; the footprint raster bakes its colour in, so a `samplingAreaColor` change rebuilds the footprint layer.
5. **Labels on the peak.** Spain's Natural Earth label anchor (40.090953, −3.464718) lies 42 km from `SYNTHETIC_PEAK` (about 1σ, ground ≈ 3.64 km at relief 1), so Task 26 checks a label above the flank through `__atlasLabelClearance`, and Task 23 pins clamping against a real Cesium `LabelCollection`.
6. **Relief (binding).** PR 1's `relief` [1, 10], step 0.5, and `effectiveRelief` stay. Phase 3's exaggeration work is making ground heights, the highlight and labels (Cesium re-clamps them, GlobeSurfaceTile.js:455-462) follow it, and retiring the hidden-data warning.

### Phase 3 reviewer checks

- A relief drag reads the pre-drag heights (Review Focus 4): Tasks 25 and 26.
- A border or sampling colour change under terrain shows the old colour: Task 23 "…swaps in a recoloured layer once it is ready"; Task 24 "rebuilds the footprints in a new sampling colour…".
- Terrain toggled while a draped layer is preparing (Review Focus 1): Tasks 23 and 24.
- Antimeridian and polar footprints, highlights across 180° (no line around the world, no missing half, no ring dropping to the ellipsoid where `getHeight` is undefined for lon > 180°): Task 18 antimeridian and pole-band tests; Task 21 "keeps an outline continuous, and on the ground, across the antimeridian".
- Hidden or retired groups keep tiles resident (α 0 still loads tiles; only `show = false` frees them): Task 22 `collection.show` → `setShown`; Task 23 countries off → `setShown(false)`; Task 24 a pruned group's layer destroyed.

### File map

| File | Change | Task |
|---|---|---|
| `geometry/raster/line-raster.ts` | segment index; border and footprint rasterisers; rings and bounds | 18 |
| `geometry/raster/types.ts`, `worker/raster-handlers.ts`, `worker/geometry-handlers.ts`, `worker/handlers.ts` | `borders` and `footprints` rasters; the Natural Earth copy | 19 |
| `scene/ground-heights.ts` (new) | sampling, throttling, triggers; `afterNextRender` | 20 |
| `scene/highlight-layer.ts` | densified ring on the ground | 21 |
| `scene/observation-symbols.ts`, `scene/observation-layer.ts` | ground-lifted placement; footprint ownership; `footprintCircles`, `footprintSpec` | 22 |
| `scene/context-overlay.ts`, `scene/scene-transition.ts` | `setDraped`; label clamping; `whenLayerReady` | 23 |
| `scene/observation-drapes.ts` (new), `scene/scientific-layers.ts` | footprints and ground heights per observation group | 24 |
| `scene/atlas-scene.ts`, `earth-style-catalog.ts` | flip wiring; relief resampling; retiring the warning | 25 |
| `scene/synthetic-terrain.ts`, `e2e-hooks.ts`, `tests/atlas-drape.spec.ts` | window and label hooks; placement and footprint e2e | 26 |

---

### Task 18: Border and footprint rasterisers (P3.1)

**Parallel:** yes, with Tasks 20, 21, 22 and 23.

**Files:**
- Modify: `src/atlas/geometry/raster/line-raster.ts` (Task 13): the exports below; the docstring adds "Per layer under World Terrain" (borders, sampling footprints) and "Failure modes" (antimeridian).
- Test: `tests/atlas-raster-lines.test.ts` (new describes)

**Interfaces:**
- Consumes: `TileAddress`, `DegreeRectangle`, `TileRaster`, `RASTER_TILE_SIZE` (Task 6); `tileRectangle`, `texelCentre` (Task 7); `strokePolyline`'s coverage law (Task 13); `NaturalEarthBuffers`, `decodeNaturalEarth` (`geometry/natural-earth.ts`).
- Produces:
```ts
export const BORDER_WIDTH_TEXELS = 1.65, FOOTPRINT_WIDTH_TEXELS = 2, FOOTPRINT_ALPHA = 0.9;
export const FOOTPRINT_RING_SEGMENTS = 48, SEGMENT_BUCKET_DEGREES = 1, BOUNDS_MARGIN_DEGREES = 1;
export interface SegmentIndex { segmentsIn(r: DegreeRectangle, out?: number[]): number[] } // segment v = vertex v → v+1 in its ring; ids unique
export function buildSegmentIndex(lonLat: Float64Array, ringOffsets: Uint32Array): SegmentIndex;
export function footprintRing(lon: number, lat: number, radiusKm: number, segments?: number): Float64Array; // lon, lat pairs; implicitly closed
export function validateFootprintCircles(circles: Float64Array): void; // throws 'sampling footprints must be lon, lat, radius_km triples with a positive radius'
export function borderBounds(borders: NaturalEarthBuffers): DegreeRectangle | null;
export function footprintBounds(circles: Float64Array): DegreeRectangle | null;
export function rasterBorderTile(i: { borders: NaturalEarthBuffers; color: string }, a: TileAddress): TileRaster | null;
export function rasterFootprintTile(i: { circles: Float64Array; color: string }, a: TileAddress): TileRaster | null;
```

- [ ] **Step 1: Write the failing tests**
```ts
const EARTH_RADIUS_KM = 6_371.0088;
const KM_PER_DEGREE = (Math.PI * EARTH_RADIUS_KM) / 180;
const SPAIN = { lat: 40.419, lon: -3.709, radiusKm: 1.7841241161527712 }; // map-surveys:1135, on the synthetic peak
const at = (column: number, row: number) => (row * RASTER_TILE_SIZE + column) * 4;
const alphaAt = (t: TileRaster, c: number, r: number) => t.rgba[at(c, r) + 3];
const rgbAt = (t: TileRaster, c: number, r: number) => Array.from(t.rgba.subarray(at(c, r), at(c, r) + 3));
const ring = (...lonLat: number[]): NaturalEarthBuffers =>
  ({ labels: [], lonLat: Float64Array.from(lonLat), ringOffsets: Uint32Array.of(0, lonLat.length / 2) });
const NE = (() => {
  const b = readFileSync(fileURLToPath(new URL('../public/data/atlas/ne-50m-admin-0.borders.bin', import.meta.url)));
  return decodeNaturalEarth(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
})();

describe('draped borders (P3)', () => {
  const a = { level: 3, x: 9, y: 2 };
  const { east, west } = tileRectangle(a);
  const { lat } = texelCentre(a, 0, 100);

  it('strokes a border 1.65 texels wide, opaque, in its colour, south-first', () => {
    const tile = rasterBorderTile({ borders: ring(west + 1, lat, east - 1, lat), color: '#ff8000' }, a)!;
    expect(BORDER_WIDTH_TEXELS).toBe(1.65);
    expect([98, 99, 100, 101, 102].map((row) => alphaAt(tile, 128, row))).toEqual([0, 83, 255, 83, 0]);
    expect(rgbAt(tile, 128, 100)).toEqual([255, 128, 0]);
    expect(alphaAt(tile, 128, 155)).toBe(0); // the mirrored row: rows run south to north
  });
  it('takes the larger coverage where strokes overlap, never their sum', () => {
    const once = rasterBorderTile({ borders: ring(west, lat, east, lat), color: '#ffffff' }, a)!;
    const twice = rasterBorderTile({ borders: { labels: [], lonLat: Float64Array.of(west, lat, east, lat, west, lat, east, lat),
      ringOffsets: Uint32Array.of(0, 2, 4) }, color: '#ffffff' }, a)!;
    expect(twice.rgba).toEqual(once.rgba);
  });
  it('returns null where no border reaches, and repeats byte for byte', () => {
    const borders = ring(west + 1, lat, east - 1, lat);
    expect(rasterBorderTile({ borders, color: '#ffffff' }, { level: 3, x: 0, y: 0 })).toBeNull();
    expect(rasterBorderTile({ borders, color: '#ffffff' }, a)!.rgba).toEqual(rasterBorderTile({ borders, color: '#ffffff' }, a)!.rgba);
  });
  it('draws a border on the antimeridian into the tiles on both sides of it', () => {
    // Natural Earth closes Russia, Fiji and Antarctica along ±180° (56 of its vertices lie on it).
    const eastEdge = { level: 8, x: 511, y: 127 }, westEdge = { level: 8, x: 0, y: 127 };
    const borders = ring(180, texelCentre(eastEdge, 0, 20).lat, 180, texelCentre(eastEdge, 0, 200).lat);
    expect(alphaAt(rasterBorderTile({ borders, color: '#ffffff' }, eastEdge)!, 255, 100)).toBe(210); // 0.825 × 255
    expect(alphaAt(rasterBorderTile({ borders, color: '#ffffff' }, westEdge)!, 0, 100)).toBe(210);
    expect(rasterBorderTile({ borders, color: '#ffffff' }, { level: 8, x: 256, y: 127 })).toBeNull();
  });
  it('refuses a border that jumps the antimeridian, and colours other than #rrggbb', () => {
    expect(() => rasterBorderTile({ borders: ring(179, 0, -179, 0), color: '#ffffff' }, { level: 0, x: 0, y: 0 })).toThrow(/antimeridian/);
    expect(() => rasterBorderTile({ borders: ring(0, 0, 1, 0), color: 'white' }, { level: 0, x: 1, y: 0 })).toThrow(/#rrggbb/);
  });
  it('bounds the Natural Earth borders one degree out', () => {
    expect(borderBounds(NE)).toEqual({ east: 180, north: expect.closeTo(84.5996, 4), south: -90, west: -180 });
  });
  it('strokes the texel of every Natural Earth vertex at level 5 (never drops a border)', () => {
    const level = 5, span = 180 / 2 ** level, byTile = new Map<string, number[]>();
    for (let v = 0; v < NE.lonLat.length / 2; v += 1) {
      const x = Math.min(2 ** (level + 1) - 1, Math.floor((NE.lonLat[2 * v] + 180) / span));
      const y = Math.min(2 ** level - 1, Math.floor((90 - NE.lonLat[2 * v + 1]) / span));
      byTile.set(`${x},${y}`, [...(byTile.get(`${x},${y}`) ?? []), v]);
    }
    const missed: number[] = [];
    for (const [key, vertices] of byTile) {
      const [x, y] = key.split(',').map(Number);
      const tile = rasterBorderTile({ borders: NE, color: '#ffffff' }, { level, x, y });
      const r = tileRectangle({ level, x, y });
      for (const v of vertices) {
        const column = Math.min(255, Math.floor(((NE.lonLat[2 * v] - r.west) / span) * 256));
        const row = Math.min(255, Math.floor(((NE.lonLat[2 * v + 1] - r.south) / span) * 256));
        if (!tile || alphaAt(tile, column, row) === 0) missed.push(v);
      }
    }
    expect(missed.slice(0, 5)).toEqual([]);
  });
});

describe('draped sampling footprints (P3)', () => {
  it('rings each footprint at its sampling radius, 48 vertices from due north', () => {
    const ringOf = footprintRing(SPAIN.lon, SPAIN.lat, SPAIN.radiusKm);
    expect(FOOTPRINT_RING_SEGMENTS).toBe(48);
    expect(ringOf).toHaveLength(96);
    expect([ringOf[0], ringOf[1]]).toEqual([expect.closeTo(SPAIN.lon, 9), expect.closeTo(SPAIN.lat + SPAIN.radiusKm / KM_PER_DEGREE, 9)]);
    for (let k = 0; k < 48; k += 1)
      expect(haversineKm(SPAIN.lon, SPAIN.lat, ringOf[2 * k], ringOf[2 * k + 1])).toBeCloseTo(SPAIN.radiusKm, 6);
  });
  it('strokes a footprint 2 texels wide at alpha 0.9, leaving its inside clear', () => {
    const a = { level: 8, x: 256, y: 127 };
    const top = texelCentre(a, 128, 128);
    const circles = Float64Array.of(top.lon, top.lat - 20 / KM_PER_DEGREE, 20); // vertex 0 on a texel centre
    const tile = rasterFootprintTile({ circles, color: '#ff00ff' }, a)!;
    expect([FOOTPRINT_WIDTH_TEXELS, FOOTPRINT_ALPHA]).toEqual([2, 0.9]);
    expect([126, 127, 128, 129, 130].map((row) => alphaAt(tile, 128, row))).toEqual([0, 115, 230, 115, 0]);
    expect(rgbAt(tile, 128, 128)).toEqual([255, 0, 255]);
    expect(alphaAt(tile, 128, 70)).toBe(0); // inside the circle
  });
  it('draws a footprint that straddles the antimeridian on both sides of it', () => {
    const circles = Float64Array.of(179.9, 10, 50);
    expect(rasterFootprintTile({ circles, color: '#ff00ff' }, { level: 3, x: 15, y: 3 })).not.toBeNull();
    expect(rasterFootprintTile({ circles, color: '#ff00ff' }, { level: 3, x: 0, y: 3 })).not.toBeNull();
    expect(rasterFootprintTile({ circles, color: '#ff00ff' }, { level: 3, x: 8, y: 3 })).toBeNull();
    expect(footprintBounds(circles)).toMatchObject({ east: 180, west: -180 });
  });
  it('draws a footprint that encloses a pole as a band across every longitude', () => {
    const circles = Float64Array.of(0, 89, 300);
    for (let x = 0; x < 8; x += 1)
      expect(rasterFootprintTile({ circles, color: '#ff00ff' }, { level: 2, x, y: 0 }), `x=${x}`).not.toBeNull();
    expect(rasterFootprintTile({ circles, color: '#ff00ff' }, { level: 2, x: 0, y: 1 })).toBeNull();
  });
  it('bounds footprints one degree beyond their rings, with none for no circles', () => {
    const b = footprintBounds(Float64Array.of(10, 20, KM_PER_DEGREE))!;
    expect(b).toEqual({ east: expect.closeTo(12.0642, 3), north: expect.closeTo(22, 6),
      south: expect.closeTo(18, 6), west: expect.closeTo(7.9358, 3) });
    expect(footprintBounds(new Float64Array(0))).toBeNull();
  });
  it('refuses circles that are not lon, lat, radius_km triples with a positive radius', () => {
    for (const bad of [Float64Array.of(1, 2), Float64Array.of(1, 2, 0), Float64Array.of(1, Number.NaN, 5)])
      expect(() => validateFootprintCircles(bad)).toThrow(/lon, lat, radius_km triples/);
  });
});
```
`haversineKm` is a three-line local helper with radius 6,371.0088 km.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-raster-lines.test.ts -t "draped (borders|sampling footprints)"`
Expected: FAIL: `rasterBorderTile is not a function` (and the others).

- [ ] **Step 3: Implement the signatures in `line-raster.ts`**

Algorithms the tests do not determine:
```ts
// Strokes use Task 13's coverage law (reach = width / 2 + 0.5; α = round(alpha · 255 · clamp(reach − d, 0, 1)); max-combine, never a sum).
// Antimeridian: each segment's end is taken to within 180° of its start (footprint rings: unwrap; borders: |Δlon| > 180 throws
// 'border segment jumps the antimeridian'), and drawn at lon offsets k·360°, k ∈ {−1, 0, 1}, wherever its shifted box grown by reach
// meets the tile; a line on ±180° fills both edge tiles, and a ring round a pole (unwrapped through 360°) is a band.
// Segment index: 1° buckets over [−180,180]×[−90,90] in CSR form (offsets + Uint32Array ids); a segment goes in every bucket its box
// meets; segmentsIn dedupes with a stamp array. A border tile queries its rectangle grown by reach × (tile degrees / 256), plus that
// rectangle shifted ∓360° where it passes ±180°.
```
Cache the index in a module `WeakMap<NaturalEarthBuffers, SegmentIndex>` and a footprint raster's rings and per-ring boxes in a `WeakMap<Float64Array, …>`. `footprintRing` uses the destination formula of `samplingRingSamples` (observation-layer.ts:213-240), bearing 2πk/48, lon unwrapped about the centre. Bounds are the unwrapped vertex extent grown by `BOUNDS_MARGIN_DEGREES`, clamped to the world; a ring passing ±180° or spanning 360° gives `west: -180, east: 180`. Parse `#rrggbb` as `bytesFromHex` does (geometry/edge-buffers.ts:65). A tile with no drawn texel returns `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Same command. Expected: PASS (13 tests); the level-5 coverage test runs in under 5 s.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/geometry/raster/line-raster.ts website/tests/atlas-raster-lines.test.ts
git commit -m "feat: rasterise draped borders and sampling footprints (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: The worker serves border and footprint rasters (P3.2)

**Parallel:** after Task 18; parallel with Tasks 20–23.

**Files:**
- Modify: `src/atlas/geometry/raster/types.ts`: `Rasterisers` gains `borders` and `footprints`
- Modify: `src/atlas/worker/geometry-handlers.ts:100-104` (`naturalEarth()` on `GeometryWorker`), `:378-384` (return it)
- Modify: `src/atlas/worker/handlers.ts`: the raster context's `naturalEarth: () => geometryRuntime(context).worker.naturalEarth()` replaces `() => null`
- Modify: `src/atlas/worker/raster-handlers.ts`: the `'borders'` and `'footprints'` branches of `prepare-raster`; `ATLAS_RASTERISERS` adds both
- Test: `tests/atlas-worker-geometry.test.ts`, `tests/atlas-worker-dispatcher.test.ts`, `tests/atlas-raster-worker.test.ts` (Task 8's `rasterHarness`)

**Interfaces:**
- Consumes: `rasterBorderTile`, `rasterFootprintTile`, `borderBounds`, `footprintBounds`, `validateFootprintCircles` (Task 18); `RasterWorkerContext.naturalEarth` (Task 8).
- Produces:
```ts
interface Rasterisers { /* Task 6 */
  borders(i: { borders: NaturalEarthBuffers; color: string }, a: TileAddress): TileRaster | null;
  footprints(i: { circles: Float64Array; color: string }, a: TileAddress): TileRaster | null }
// ATLAS_RASTERISERS + { borders: rasterBorderTile, footprints: rasterFootprintTile }
GeometryWorker.naturalEarth(): NaturalEarthBuffers | null; // the copy 'parse-context' keeps (geometry-handlers.ts:335-339); null before parsing
```

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-worker-geometry.test.ts, beside 'parses Natural Earth and later returns its surface heights'
it('keeps the parsed Natural Earth copy for the raster runtime', async () => {
  const { posted, worker } = harness();
  expect(worker.naturalEarth()).toBeNull();
  const borders = encodeRings([/* the fixture ring of the test above */]);
  await worker.handlers['parse-context']({ bytes: borders.slice().buffer, id: 12, type: 'parse-context' });
  const [ready] = ofType(posted, 'context-ready');
  expect(worker.naturalEarth()).toEqual(ready.message.buffers);
  expect(worker.naturalEarth()!.lonLat).not.toBe(ready.message.buffers.lonLat); // the posted buffers are transferred
});
// atlas-worker-dispatcher.test.ts
it('prepares a border raster once the worker has parsed the borders', async () => {
  const { dispatch, sent } = harness();
  const spec = { color: '#ffffff', layer: 'borders', maximumLevel: 11 } as const;
  dispatch({ id: 1, spec, type: 'prepare-raster' });
  await settle();
  expect(terminal(sent, 1)).toMatchObject({ code: 'internal', message: 'Natural Earth context is not parsed', type: 'error' });
  dispatch({ bytes: neBorderBytes(), id: 2, type: 'parse-context' }); // public/data/atlas/ne-50m-admin-0.borders.bin
  await settle();
  dispatch({ id: 3, spec, type: 'prepare-raster' });
  await settle();
  expect(terminal(sent, 3)).toMatchObject({ bounds: { east: 180, south: -90, west: -180 }, rasterId: 3, type: 'raster-ready' });
});
// atlas-raster-worker.test.ts
it('tiles a footprint raster, an empty tile as null', async () => {
  const { posted, runtime } = rasterHarness({ rasterisers: ATLAS_RASTERISERS });
  const spec = { artifactKey: 'k', circles: Float64Array.of(-3.709, 40.419, 50), color: '#ff00ff', layer: 'footprints' } as const;
  await runtime.handlers['prepare-raster']({ id: 5, spec, type: 'prepare-raster' });
  expect(last(posted, 'raster-ready')).toMatchObject({ bounds: { north: expect.closeTo(40.419 + 50 / 111.195 + 1, 3) }, rasterId: 5 });
  await runtime.handlers['raster-tile']({ id: 6, level: 3, rasterId: 5, type: 'raster-tile', x: 7, y: 2 });
  expect(last(posted, 'tile-ready').bitmap).not.toBeNull();
  await runtime.handlers['raster-tile']({ id: 7, level: 3, rasterId: 5, type: 'raster-tile', x: 0, y: 0 });
  expect(last(posted, 'tile-ready').bitmap).toBeNull();
});
it('refuses malformed footprints, and border tiles above their maximum level, as validation errors', async () => {
  const { posted, runtime } = rasterHarness({ naturalEarth: () => tinyBorders, rasterisers: ATLAS_RASTERISERS });
  await runtime.handlers['prepare-raster']({ id: 8, spec: { artifactKey: 'k', circles: Float64Array.of(1, 2), color: '#ff00ff', layer: 'footprints' }, type: 'prepare-raster' });
  expect(last(posted, 'error')).toMatchObject({ code: 'validation', id: 8, message: expect.stringMatching(/lon, lat, radius_km triples/) });
  await runtime.handlers['prepare-raster']({ id: 9, spec: { color: '#ffffff', layer: 'borders', maximumLevel: 10 }, type: 'prepare-raster' });
  await runtime.handlers['raster-tile']({ id: 10, level: 11, rasterId: 9, type: 'raster-tile', x: 0, y: 0 });
  expect(last(posted, 'error')).toMatchObject({ code: 'validation', id: 10, message: expect.stringMatching(/maximum level 10/) });
});
```
Task 8's "…or a layer it cannot raster yet as internal" still holds for `BORDER_SPEC`: with `naturalEarth: () => null` it is `internal` ('Natural Earth context is not parsed'); rename it "…or borders before the context is parsed as internal".

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-worker-geometry.test.ts tests/atlas-worker-dispatcher.test.ts tests/atlas-raster-worker.test.ts -t "Natural Earth copy|border raster|footprint"`
Expected: FAIL: `worker.naturalEarth is not a function`, and Task 8's unsupported-layer error on the raster tests.

- [ ] **Step 3: Implement the change**

- `naturalEarth()` returns the module's `naturalEarth` variable.
- `'borders'`: `c.naturalEarth()`; null throws `MissingInputError('Natural Earth context is not parsed')`, posted as `internal` the way `guarded` does (geometry-handlers.ts:180-199); bounds `borderBounds`; tiles `rasterisers.borders({ borders, color })`.
- `'footprints'`: `validateFootprintCircles` (code `'validation'`), bounds `footprintBounds`, tiles `rasterisers.footprints`.
- A border `raster-tile` with `level > spec.maximumLevel` is `'validation'`: `border tiles stop at maximum level ${n}`.

- [ ] **Step 4: Run the tests to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/geometry/raster/types.ts website/src/atlas/worker website/tests/atlas-worker-geometry.test.ts website/tests/atlas-worker-dispatcher.test.ts website/tests/atlas-raster-worker.test.ts
git commit -m "feat: serve draped border and footprint tiles from the data worker (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Ground heights (P3.3)

**Parallel:** yes, with Tasks 18, 21, 22 and 23. Pure: it may branch from Task 6.

**Files:**
- Create: `src/atlas/scene/ground-heights.ts` (docstring cites "Per layer under World Terrain" (observation symbols), "Exaggeration" (what follows it), "2D and Columbus" (re-sample after `morphComplete`) and "Failure modes" (`getHeight` undefined))
- Test: `tests/atlas-ground-heights.test.ts` (create)

**Interfaces:**
- Consumes: Cesium `Globe.getHeight`, `Globe.tileLoadProgressEvent` (raised with the queue length), `Scene.morphComplete`, `Scene.postRender`.
- Produces:
```ts
export const GROUND_RESAMPLE_MS = 50;
export function sampleGroundHeights(globe: Pick<Globe, 'getHeight'>, lonLat: Float64Array, out?: Float64Array): Float64Array; // NaN: unloaded
export interface GroundHeights { heights(): Float64Array; onChange(l: (h: Float64Array) => void): () => void; resample(final?: boolean): void; destroy(): void }
export function createGroundHeights(scene: { globe: Pick<Globe, 'getHeight' | 'tileLoadProgressEvent'>; morphComplete: Event },
  lonLat: Float64Array, now?: () => number): GroundHeights;
export function afterNextRender(scene: { postRender: { addEventListener(l: () => void): () => void }; requestRender(): void }, run: () => void): () => void;
```

- [ ] **Step 1: Write the failing tests**
```ts
class ProgressEvent { // Cesium raises tileLoadProgressEvent with the tile queue's length
  readonly listeners = new Set<(length: number) => void>();
  addEventListener(l: (length: number) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  raiseEvent(length: number) { for (const l of [...this.listeners]) l(length); }
}
/** The Spain survey on the synthetic peak (map-surveys:1135), then the Gabon survey (map-surveys:996). */
const POINTS = Float64Array.of(-3.709, 40.419, 12.686, -1.844);

function setup(initial: (lon: number) => number | undefined) {
  const clock = { now: 0 };
  let ground = initial;
  const globe = { getHeight: vi.fn((c: Cartographic) => ground(CesiumMath.toDegrees(c.longitude))),
    tileLoadProgressEvent: new ProgressEvent() };
  const morphComplete = new FakeEvent();
  const heights = createGroundHeights({ globe, morphComplete } as never, POINTS, () => clock.now);
  return { clock, globe, heights, morphComplete, setGround: (next: typeof initial) => { ground = next; } };
}

describe('ground heights under World Terrain', () => {
  it('samples the rendered ground under each point, NaN where no tile has loaded', () => {
    const globe = { getHeight: (c: Cartographic) => (CesiumMath.toDegrees(c.longitude) < 0 ? 6_000 : undefined) };
    expect(Array.from(sampleGroundHeights(globe as never, POINTS))).toEqual([6_000, Number.NaN]);
    const out = new Float64Array(2);
    expect(sampleGroundHeights(globe as never, POINTS, out)).toBe(out);
  });
  it('samples at creation and tells listeners only when a height changed', () => {
    const { heights, setGround } = setup((lon) => (lon < 0 ? 6_000 : undefined));
    expect(Array.from(heights.heights())).toEqual([6_000, Number.NaN]);
    const heard = vi.fn();
    heights.onChange(heard);
    heights.resample(true);
    expect(heard).not.toHaveBeenCalled(); // NaN stayed NaN: no change
    setGround((lon) => (lon < 0 ? 6_500 : undefined));
    heights.resample(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(Array.from(heard.mock.calls[0][0] as Float64Array)).toEqual([6_500, Number.NaN]);
  });
  it('resamples at most every 50 ms unless the resample is final', () => {
    const { clock, heights, setGround } = setup(() => 1_000);
    expect(GROUND_RESAMPLE_MS).toBe(50);
    setGround(() => 2_000);
    clock.now = 49; heights.resample(); expect(heights.heights()[0]).toBe(1_000);
    clock.now = 50; heights.resample(); expect(heights.heights()[0]).toBe(2_000);
    setGround(() => 3_000);
    clock.now = 51; heights.resample(true); expect(heights.heights()[0]).toBe(3_000);
  });
  it('resamples as terrain tiles load, and once more when their queue empties', () => {
    const { clock, globe, heights, setGround } = setup(() => 1_000);
    setGround(() => 2_000);
    clock.now = 10; globe.tileLoadProgressEvent.raiseEvent(4); expect(heights.heights()[0]).toBe(1_000);
    clock.now = 60; globe.tileLoadProgressEvent.raiseEvent(3); expect(heights.heights()[0]).toBe(2_000);
    setGround(() => 3_000);
    clock.now = 70; globe.tileLoadProgressEvent.raiseEvent(0); expect(heights.heights()[0]).toBe(3_000);
  });
  it('resamples once a morph between views completes', () => {
    const { clock, heights, morphComplete, setGround } = setup(() => 1_000);
    setGround(() => 2_000); clock.now = 1;
    morphComplete.raiseEvent();
    expect(heights.heights()[0]).toBe(2_000);
  });
  it('stops listening once destroyed, and tells no unsubscribed listener', () => {
    const { globe, heights, morphComplete, setGround } = setup(() => 1_000);
    const kept = vi.fn(), dropped = vi.fn();
    heights.onChange(kept); heights.onChange(dropped)();
    setGround(() => 2_000); heights.resample(true);
    expect([kept.mock.calls.length, dropped.mock.calls.length]).toEqual([1, 0]);
    heights.destroy();
    expect(globe.tileLoadProgressEvent.listeners.size).toBe(0);
    expect(morphComplete.numberOfListeners).toBe(0);
    setGround(() => 3_000); heights.resample(true);
    expect(kept).toHaveBeenCalledTimes(1);
  });
  it('refuses coordinates that are not lon, lat pairs', () => {
    const scene = { globe: { getHeight: () => 0, tileLoadProgressEvent: new ProgressEvent() }, morphComplete: new FakeEvent() };
    expect(() => createGroundHeights(scene as never, Float64Array.of(1, 2, 3))).toThrow(/lon, lat pairs/);
  });
});

describe('afterNextRender', () => {
  it('runs once, after the next frame, and asks for that frame', () => {
    const postRender = new FakeEvent(), requestRender = vi.fn(), run = vi.fn();
    afterNextRender({ postRender, requestRender }, run);
    expect([requestRender.mock.calls.length, run.mock.calls.length]).toEqual([1, 0]);
    postRender.raiseEvent(); postRender.raiseEvent();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('never runs once removed', () => {
    const postRender = new FakeEvent(), run = vi.fn();
    afterNextRender({ postRender, requestRender: vi.fn() }, run)();
    postRender.raiseEvent();
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-ground-heights.test.ts`
Expected: FAIL: `Failed to load url ../src/atlas/scene/ground-heights`.

- [ ] **Step 3: Create `ground-heights.ts`**

One scratch `Cartographic`; `undefined` → `NaN`; change detection element by element with `Object.is`; throttle on `now() - last < GROUND_RESAMPLE_MS` unless `final`; `tileLoadProgressEvent` → `resample(length === 0)`; `morphComplete` → `resample(true)`; listeners receive the internal array and must not keep it; `now` defaults to `performance.now`.

- [ ] **Step 4: Run the tests to verify they pass**

Same command. Expected: PASS (9 tests).

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/ground-heights.ts website/tests/atlas-ground-heights.test.ts
git commit -m "feat: sample World Terrain ground heights for draped observations (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: The highlight on the ground (P3.4)

**Parallel:** yes, with Tasks 18, 20, 22 and 23. Pure: it may branch from Task 6.

**Files:**
- Modify: `src/atlas/scene/highlight-layer.ts`: `:1` (docstring cites "Per layer under World Terrain" (highlight)), `:36-37` (constants), `:87-110` (`#ground`), `:112-138` (`setGround` beside `setArtifacts`), `:191-240` (`#show`)
- Test: `tests/atlas-highlight-layer.test.ts` (reuse `setup()`; its exaggeration of 2 must not raise a grounded outline)

**Interfaces:**
- Consumes: `h3BoundaryDegrees` (geometry/polygon-parts.ts:13).
- Produces:
```ts
export const HIGHLIGHT_GROUND_CLEARANCE_METRES = 300;
export const HIGHLIGHT_EDGE_SEGMENTS = 16;
HighlightLayer.setGround(g: Pick<Globe, 'getHeight'> | null): void; // re-samples the shown highlights; null: today's outline
```

- [ ] **Step 1: Write the failing tests**
```ts
/** A sloping ground: 1,000 m plus 100 m per degree of latitude; nothing loaded past ±180°. */
const slope = { getHeight: (c: Cartographic) =>
  Math.abs(c.longitude) <= Math.PI ? 1_000 + 100 * CesiumMath.toDegrees(c.latitude) : undefined };
const heightOf = (p: Cartesian3) => Ellipsoid.WGS84.cartesianToCartographic(p).height;

describe('highlights on World Terrain', () => {
  it('outlines a selected cell 300 m above the ground, 16 points to an edge, whatever the data elevation', () => {
    const { layer, lines, surface } = setup();
    layer.setGround(slope);
    layer.setSelection({ artifactKey: surface.artifactKey, h3Index: CELL, kind: 'surface', row: 0 });
    const { positions } = lines.get(1);
    expect([HIGHLIGHT_GROUND_CLEARANCE_METRES, HIGHLIGHT_EDGE_SEGMENTS]).toEqual([300, 16]);
    expect(positions).toHaveLength(6 * 16);
    for (const p of positions)
      expect(heightOf(p)).toBeCloseTo(slope.getHeight(Ellipsoid.WGS84.cartesianToCartographic(p))! + 300, 3);
  });
  it('places an observation highlight 5,500 m above the ground under it', () => {
    const { layer, observations, points, surface } = setup();
    layer.setGround(slope);
    layer.setSelection({ artifactKey: surface.artifactKey, kind: 'observation', sourceRecordId: 'map-surveys:1' });
    const { lat } = observations.observations[0];
    expect(heightOf(points.get(1).position)).toBeCloseTo(1_000 + 100 * lat + 5_500, 3);
  });
  it('falls to the ellipsoid where the ground has not loaded', () => {
    const { layer, lines, surface } = setup();
    layer.setGround({ getHeight: () => undefined });
    layer.setSelection({ artifactKey: surface.artifactKey, h3Index: CELL, kind: 'surface', row: 0 });
    for (const p of lines.get(1).positions) expect(heightOf(p)).toBeCloseTo(300, 3);
  });
  it('re-samples the shown highlights when the ground is set again', () => {
    const { layer, lines, surface } = setup();
    let base = 1_000;
    const ground = { getHeight: () => base };
    layer.setGround(ground);
    layer.setSelection({ artifactKey: surface.artifactKey, h3Index: CELL, kind: 'surface', row: 0 });
    base = 4_000; // relief raised
    layer.setGround(ground);
    expect(heightOf(lines.get(1).positions[0])).toBeCloseTo(4_300, 3);
  });
  it('restores the raised outline when the ground is cleared', () => {
    const { layer, lines, source, surface } = setup();
    layer.setGround(slope);
    layer.setSelection({ artifactKey: surface.artifactKey, h3Index: CELL, kind: 'surface', row: 0 });
    layer.setGround(null);
    expect(lines.get(1).positions).toHaveLength(6);
    expect(heightOf(lines.get(1).positions[0])).toBeCloseTo(source.cellHeight(CELL, 'post_mean')! * 2 + 5_500, 3);
  });
  it('keeps an outline continuous, and on the ground, across the antimeridian', () => {
    const cell = latLngToCell(0, 180, 3);
    const surface = columnarSurface([{ h3: cell, post_mean: 0.5, post_sd: 0.1, support: 'observed' }]);
    const layer = new HighlightLayer({ requestRender: vi.fn() } as never);
    layer.setArtifacts(columnarHeightSource(surface), null, 'post_mean', false, 0);
    layer.setGround(slope);
    layer.setSelection({ artifactKey: surface.artifactKey, h3Index: cell, kind: 'surface', row: 0 });
    const ringOf = (layer.collection.get(0) as PolylineCollection).get(1).positions;
    ringOf.forEach((p, i) => {
      expect(Cartesian3.distance(p, ringOf[(i + 1) % ringOf.length])).toBeLessThan(10_000);
      expect(heightOf(p)).toBeGreaterThan(1_000); // the ground was found, not the ellipsoid
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-highlight-layer.test.ts -t "highlights on World Terrain"`
Expected: FAIL: `layer.setGround is not a function`.

- [ ] **Step 3: Implement `setGround(g)`**

It stores `g` and re-runs `#show` for the hover and the selection. With a ground, a surface pick draws the densified boundary at `(g.getHeight(c) ?? 0) + HIGHLIGHT_GROUND_CLEARANCE_METRES`, ignoring data elevation; an observation pick sits at `(g.getHeight(c) ?? 0) + SURFACE_CLEARANCE_METRES` (5,500). With no ground, today's path is unchanged.
```ts
// For each boundary edge (v[i] → v[i+1], wrapping), unwrap v[i+1].lon to within 180° of v[i].lon and emit
// v[i] + (v[i+1] − v[i]) · k / 16 for k = 0..15. Normalise each emitted lon into [−180, 180] (CesiumMath.negativePiToPi
// on radians) before getHeight, which finds no tile for lon > 180°.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-highlight-layer.test.ts`
Expected: PASS, the existing 5 tests unchanged.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/highlight-layer.ts website/tests/atlas-highlight-layer.test.ts
git commit -m "feat: draw the highlight on World Terrain's ground (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: The observation group on the ground, with its own footprint layer (P3.5)

**Parallel:** yes, with Tasks 18, 20, 21 and 23. It consumes only Task 6 types, so it may branch from Task 6.

**Files:**
- Modify: `src/atlas/scene/observation-symbols.ts:83-107`: `observationSurfacePlacement` gains `groundMetres = 0`
- Modify: `src/atlas/scene/observation-layer.ts`: `:1-8` (docstring cites "Per layer under World Terrain" (sampling footprints, observation symbols)), `:70-86` (interface), `:295-597` (`buildObservationLayer`'s `placeAll`, setters, `collection.show`), plus two helpers
- Test: `tests/atlas-observation-heights.test.ts` (`layer()` gains `overrides: Partial<ObservationLayerOptions> = {}`)

**Interfaces:**
- Consumes: `DrapedImageryLayer`, `FootprintRasterSpec` (Task 6, types only).
- Produces:
```ts
observationSurfacePlacement(anchor, point, elevationFactor, groundMetres = 0) // height = ground + 650 + anchor.height × factor + 7,000
ObservationPrimitiveGroup.setGroundHeights(h: Float64Array | null): void; // NaN entries keep the symbol's height; length ≠ observation count throws
ObservationPrimitiveGroup.setFootprints(l: DrapedImageryLayer | null): void; // owns l; destroys the layer it replaces; hides the rings while set
export function footprintCircles(observations: readonly Observation[]): Float64Array; // lon, lat, radius_km per observation, in order
export function footprintSpec(artifactKey: string, observations: readonly Observation[], color: string): FootprintRasterSpec;
```

- [ ] **Step 1: Write the failing tests**
```ts
function fakeFootprints() {
  return { alpha: Number.NaN, destroy: vi.fn(), isReady: () => true, layer: {} as never,
    name: 'atlas-footprints' as const, shown: true,
    setAlpha(a: number) { this.alpha = a; }, setShown(s: boolean) { this.shown = s; } };
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
    expect(() => layer().setGroundHeights(Float64Array.of(1, 2))).toThrow(/1 observations/);
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
  it("hides the rings behind a draped footprint layer driven by the group's opacity and visibility", () => {
    const group = layer();
    const rings = group.collection.get(0) as PolylineCollection;
    const footprints = fakeFootprints();
    group.setStyleOpacity(0.8);
    group.setFootprints(footprints);
    expect([rings.show, footprints.alpha, footprints.shown]).toEqual([false, expect.closeTo(0.8, 9), true]);
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
    expect([footprints.destroy.mock.calls.length, rings.show]).toEqual([1, true]);
  });
  it('destroys the footprint layer it replaces', () => {
    const group = layer();
    const [first, second] = [fakeFootprints(), fakeFootprints()];
    group.setFootprints(first); group.setFootprints(second);
    expect([first.destroy.mock.calls.length, second.destroy.mock.calls.length]).toEqual([1, 0]);
  });
  it('lists sampling footprints as lon, lat, radius triples', () => {
    expect(footprintCircles(observations.observations)).toEqual(Float64Array.of(LON, LAT, 12));
    expect(footprintSpec(KEY, observations.observations, '#9af9e2')).toEqual(
      { artifactKey: KEY, circles: Float64Array.of(LON, LAT, 12), color: '#9af9e2', layer: 'footprints' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-observation-heights.test.ts -t "observations on World Terrain"`
Expected: FAIL: `group.setGroundHeights is not a function`.

- [ ] **Step 3: Implement the signatures above**

- The group keeps a `ground: Float64Array` of zeros; `setGroundHeights` copies finite entries, re-places only symbols whose entry changed, and leaves the rings (hidden while draped); `null` zeroes it. `placeAll` and `setSizeRange` pass `ground[i]`.
- Footprint α = `fadeOpacity × styleOpacity` (earth opacity not applied); `shown = collectionShown && samplingAreas`; `rings.show = samplingAreas && footprints === null`.
- `PrimitiveCollection.show` is a plain field, so this instance gets its own accessor with `Object.defineProperty`; Cesium's update reads it as before, and the setter also updates the footprint layer.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-observation-heights.test.ts tests/atlas-observation-layer.test.ts`
Expected: PASS, including the existing anchor tests.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/observation-layer.ts website/src/atlas/scene/observation-symbols.ts website/tests/atlas-observation-heights.test.ts
git commit -m "feat: lift observation symbols over the ground and own their draped footprints (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23: The context overlay drapes the borders and clamps the labels (P3.6)

**Parallel:** yes, with Tasks 18, 20, 21 and 22.

**Files:**
- Modify: `src/atlas/scene/context-overlay.ts`: `:1-28` (docstring cites "Per layer under World Terrain" (borders, labels) and "Failure modes"), `:30-49` (imports `HeightReference`, `type Scene`), `:109-123` (options), `:164-203` (fields), `:253-278` (`setVisible`, `setBorderStyle`), `:280-326` (`#load` drapes after the parse), `:365-371` (`#elevation` returns `FLAT` while draped), `:399-415` (`#ensureRenderer` keeps both line renderers hidden while draped), `:475-517` (`#addLabels` sets the height reference; the default factory passes the scene)
- Modify: `src/atlas/scene/scene-transition.ts`: add `whenLayerReady`
- Modify: `tests/helpers/draped-fakes.ts` (Task 11): `fakeDrapedRuntime()` also returns `layers: FakeDrapedLayer[]` (recorded by `addDrapedImageryLayer`: `name`, `alpha`, `shown`, `ready`, `destroy` spy, `isReady() = ready`) and `providers: FakeRasterProvider[]` (recorded by `providerFromSpec`: `spec`, `errorEvent` and `tileLoaded` as `ArgEvent`s, `destroy` spy); exports `ArgEvent<T>`, `FakeDrapedLayer`, `FakeRasterProvider`, `fakeRasterProvider()`
- Test: `tests/atlas-context-overlay.test.ts`: `setup()`'s scene gains `globe: {}`, `imageryLayers: {}`, `preRender` and `postRender` (`FakeEvent`), `frameState: { mode: SceneMode.SCENE3D }`, `ellipsoid: Ellipsoid.WGS84`, `getHeight: () => 1_000`, `updateHeight: () => () => {}`; the worker gains `prepareRaster`, `rasterTile`, `releaseRaster` (`vi.fn()`); options gain `onDrapeFailure: vi.fn()`; the fake label keeps `heightReference`; a `realLabels` option omits `createLabels`

**Interfaces:**
- Consumes: `DrapedRuntime` (`providerFromSpec`, `rasterSource`, `addDrapedImageryLayer`), `DrapedImageryLayer`, `DrapedScene`, `BorderRasterSpec`, `RasterWorkerClient` (Task 6). `DrapedImageryLayer.isReady()` turns true once the globe's tiles have loaded with the layer in place, or 3,000 ms after it was added.
- Produces:
```ts
export const BORDER_MAXIMUM_LEVEL = 11; // Task 34's fallback reads the runtime's memory policy instead
export type ContextOverlayScene = DrapedScene & Pick<Scene, 'primitives'>;
ContextOverlayOptions.scene: ContextOverlayScene;
ContextOverlayOptions.worker: Pick<AtlasWorkerClient, 'contextHeights' | 'parseContext'> & RasterWorkerClient;
ContextOverlayOptions.onDrapeFailure?: (error: unknown) => void; // the first failure of each draped layer
ContextOverlay.setDraped(r: DrapedRuntime | null): Promise<void>; // resolves once the borders layer is added (or at once); never rejects
export function whenLayerReady(layer: Pick<DrapedImageryLayer, 'isReady'>,       // scene-transition.ts
  scene: { postRender: { addEventListener(l: () => void): () => void }; requestRender(): void }, signal: AbortSignal): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**
```ts
describe('Natural Earth context on World Terrain', () => {
  it('drapes the borders as atlas-borders at the country opacity, and hides the lines', async () => {
    const { onDrapeFailure, overlay } = setup();
    await overlay.load('borders.bin');
    overlay.setBorderStyle('#ff0000', 0.4);
    const { layers, providers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    expect(providers.map(({ spec }) => spec)).toEqual([{ color: '#ff0000', layer: 'borders', maximumLevel: 11 }]);
    expect(layers).toMatchObject([{ alpha: 0.4, name: 'atlas-borders', shown: true }]);
    expect(bufferOf(overlay).show).toBe(false);
    expect(onDrapeFailure).not.toHaveBeenCalled();
  });
  it('clamps every label 2,500 m above the ground while draped, and lets go when undraped', async () => {
    const { added, overlay } = setup();
    await overlay.load('borders.bin');
    await overlay.setDraped(fakeDrapedRuntime().runtime);
    for (const label of added) {
      expect(label.heightReference).toBe(HeightReference.RELATIVE_TO_GROUND);
      expect(Ellipsoid.WGS84.cartesianToCartographic(label.position).height).toBeCloseTo(2_500, 3);
    }
    await overlay.setDraped(null);
    for (const label of added) expect(label.heightReference).toBe(HeightReference.NONE);
  });
  it('clamps a real Cesium label to the ground: it is built with the scene', async () => {
    const { overlay } = setup(undefined, { realLabels: true }); // scene.getHeight → 1,000 m
    await overlay.load('borders.bin');
    await overlay.setDraped(fakeDrapedRuntime().runtime);
    const labels = childrenOf(overlay).find((c) => c instanceof LabelCollection) as LabelCollection;
    const clamped = (labels.get(0) as unknown as { _clampedPosition: Cartesian3 })._clampedPosition; // Label.js:1134
    expect(Ellipsoid.WGS84.cartesianToCartographic(clamped).height).toBeCloseTo(3_500, 3);
  });
  it('drapes on load when draped first, and never builds the lines', async () => {
    const { overlay } = setup();
    const { providers, runtime } = fakeDrapedRuntime();
    await overlay.setDraped(runtime);
    expect(providers).toHaveLength(0);
    await overlay.load('borders.bin');
    expect(providers).toHaveLength(1);
    expect(childrenOf(overlay).some((c) => c instanceof BufferPolylineCollection || c instanceof PolylineCollection)).toBe(false);
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
    expect(providers[1].spec).toMatchObject({ color: '#00ff00', layer: 'borders' });
    expect([layers[1].alpha, layers[0].destroy.mock.calls.length]).toEqual([0, 0]);
    layers[1].ready = true;
    scene.postRender.raiseEvent();
    await flushTasks();
    expect([layers[1].alpha, layers[0].destroy.mock.calls.length]).toEqual([0.7, 1]);
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
    expect(childrenOf(overlay).some((c) => c instanceof PolylineCollection && c.show)).toBe(false);
    await overlay.setSceneMode('globe');
    await overlay.setDraped(null);
    expect([layers[0].destroy.mock.calls.length, bufferOf(overlay).show]).toEqual([1, true]);
  });
  it('drops a border layer still preparing when a newer call supersedes it', async () => {
    const { overlay } = setup();
    await overlay.load('borders.bin');
    const { runtime } = fakeDrapedRuntime();
    const pending = Promise.withResolvers<FakeRasterProvider>();
    vi.mocked(runtime.providerFromSpec).mockReturnValueOnce(pending.promise as never);
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
    expect(Ellipsoid.WGS84.cartesianToCartographic(added[0].position).height).toBeCloseTo(2_500, 3);
  });
});

describe('whenLayerReady', () => {
  it('resolves on the first frame the layer is ready, asking for frames', async () => {
    const postRender = new FakeEvent(), requestRender = vi.fn();
    let ready = false;
    const done = vi.fn();
    void whenLayerReady({ isReady: () => ready }, { postRender, requestRender }, new AbortController().signal).then(done);
    postRender.raiseEvent(); await flushTasks();
    expect(done).not.toHaveBeenCalled();
    ready = true; postRender.raiseEvent(); await flushTasks();
    expect([done.mock.calls.length, postRender.numberOfListeners]).toEqual([1, 0]);
    expect(requestRender).toHaveBeenCalled();
  });
  it('rejects with an AbortError once aborted', async () => {
    const abort = new AbortController(), postRender = new FakeEvent();
    const waiting = whenLayerReady({ isReady: () => false }, { postRender, requestRender: vi.fn() }, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(postRender.numberOfListeners).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-context-overlay.test.ts -t "World Terrain|whenLayerReady"`
Expected: FAIL: `overlay.setDraped is not a function`.

- [ ] **Step 3: Implement the signatures above**

- **`setDraped(r)`** bumps a sequence and aborts any border build in flight; a result arriving after a newer call destroys its provider and adds nothing.
- **Labels:** `heightReference` becomes `RELATIVE_TO_GROUND` (or back to `NONE`), each re-placed at `#labelPosition(index, this.#draped ? FLAT : this.#elevation())`; labels added later take the current reference.
- **Line renderers:** `#ensureRenderer` hides both, and builds neither, while draped.
- **Borders layer**, once `#parsed` is set: (1) `r.providerFromSpec(r.rasterSource(worker), { color: this.#borderCss, layer: 'borders', maximumLevel: BORDER_MAXIMUM_LEVEL }, signal)`; (2) subscribe `errorEvent`; (3) `r.addDrapedImageryLayer({ alpha: opacity, name: 'atlas-borders', provider, scene })`; (4) `setShown(this.collection.show)`. A non-abort failure calls `onDrapeFailure` once per layer.
- **`setBorderStyle`:** an opacity change sets α at once; a colour change builds a new layer at α 0, awaits `whenLayerReady`, sets the opacity, then destroys the old one.
- **Default label factory:** `() => new LabelCollection({ scene: this.#options.scene as Scene })` (atlas-scene hands it the real Scene; the cast stays here). With `HeightReference.NONE` the scene changes nothing (Billboard.js:1121-1150, BillboardCollection.js:324).
- **`whenLayerReady`:** one `postRender` listener, a `requestRender` per frame while waiting, removed on settle or abort.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-context-overlay.test.ts`
Expected: PASS; every smooth-globe test unchanged.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/context-overlay.ts website/src/atlas/scene/scene-transition.ts website/tests/atlas-context-overlay.test.ts website/tests/helpers/draped-fakes.ts
git commit -m "feat: drape the borders and clamp country labels to World Terrain (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 24: ScientificLayers drapes the observations (P3.int-a)

**Parallel:** no. Depends on Tasks 20, 22 and 23; hot file.

**Files:**
- Create: `src/atlas/scene/observation-drapes.ts` (docstring cites "Per layer under World Terrain" (sampling footprints, observation symbols))
- Modify: `src/atlas/scene/scientific-layers.ts`: `:95-103` (`ScientificScene` adds `'morphComplete'`), `:202-235` (an `ObservationDrapes` field), `:471-482` (`setObservationAppearance`), `:558-564` (`destroy`), `:601-635` (`#observationGroupFor`), `:999-1002` (`#dispose`); `resampleGround`
- Test: `tests/atlas-scientific-layers.test.ts` (the harness scene gains `globe.getHeight` reading `ground.value`, `globe.tileLoadProgressEvent` as an `ArgEvent`, `morphComplete` as a `FakeEvent`; `h.draped = fakeDrapedRuntime()`; `onDrapeFailure` a `vi.fn()`), `tests/atlas-module-size.test.ts` (unchanged cap)

**Interfaces:**
- Consumes: `createGroundHeights`, `GroundHeights` (Task 20); `setGroundHeights`, `setFootprints`, `footprintSpec` (Task 22); `whenLayerReady` (Task 23); `DrapedRuntime.providerFromSpec`, `rasterSource` (Task 6); `ScientificStyle.draped`, `options.draped()`, `onDrapeFailure` (Task 11); `observationPoints()` (scientific-layers.ts:192-200).
- Produces:
```ts
// scene/observation-drapes.ts
export interface ObservationDrapesOptions {
  scene: Pick<ScientificScene, 'globe' | 'imageryLayers' | 'morphComplete' | 'preRender' | 'postRender' | 'requestRender'>;
  worker: RasterWorkerClient; draped(): Promise<DrapedRuntime>; onDrapeFailure(error: unknown): void }
export class ObservationDrapes {
  constructor(options: ObservationDrapesOptions);
  /** Draped: ground heights once per group, footprints rebuilt when the colour differs. Smooth: release. */
  sync(group: ObservationPrimitiveGroup, observations: readonly Observation[], artifactKey: string,
    style: { draped: boolean; samplingAreaColor: string }): void;
  release(group: ObservationPrimitiveGroup): void; // abort the build, setFootprints(null), ground.destroy(), setGroundHeights(null)
  resample(final?: boolean): void;                 // every tracked group's ground heights
  destroy(): void;
}
// ScientificLayers +
resampleGround(final?: boolean): void; // forwards to ObservationDrapes.resample
```

- [ ] **Step 1: Write the failing tests**
```ts
describe('observations on World Terrain', () => {
  const symbolHeight = (h: Harness) => heightOf(pointsOf(h).get(0).position); // displayed group's PointPrimitiveCollection
  const footprintsOf = (h: Harness) => h.draped.layers.filter((l) => l.name === 'atlas-footprints');

  it('drapes the sampling footprints and hides the rings once the layer is ready', async () => {
    const h = harness({ draped: true });
    await h.show('a');
    expect(h.draped.providers.at(-1)!.spec).toEqual(footprintSpec(keyOf('a'), observationsFor().observations,
      h.style.observationStyle.samplingAreaColor));
    const [footprints] = footprintsOf(h);
    expect([footprints.alpha, ringsOf(h).show]).toEqual([0, true]);
    footprints.ready = true;
    await h.pump(2);
    expect([footprints.alpha, ringsOf(h).show]).toEqual([h.style.observationStyle.opacity, false]);
  });
  it('lifts draped observations by the ground, and follows it as terrain tiles load', async () => {
    const h = harness({ draped: true });
    h.ground.value = 4_000;
    await h.show('a');
    expect(symbolHeight(h)).toBeCloseTo(4_000 + 7_650, 3);
    h.ground.value = 4_500;
    h.scene.globe.tileLoadProgressEvent.raiseEvent(0);
    expect(symbolHeight(h)).toBeCloseTo(4_500 + 7_650, 3);
  });
  it('resamples the ground of every observation group in view', async () => {
    const h = harness({ draped: true });
    await h.show('a');
    h.ground.value = 5_000;
    h.layers.resampleGround(true);
    expect(symbolHeight(h)).toBeCloseTo(5_000 + 7_650, 3);
  });
  it("returns observations to their rings and today's heights on the smooth globe", async () => {
    const h = harness({ draped: true });
    h.ground.value = 4_000;
    await h.show('a');
    const [footprints] = footprintsOf(h);
    footprints.ready = true; await h.pump(2);
    h.style.draped = false;
    await h.layers.rebuild(); await h.pump();
    expect([footprints.destroy.mock.calls.length, ringsOf(h).show]).toEqual([1, true]);
    expect(symbolHeight(h)).toBeCloseTo(7_650, 3);
    expect(h.scene.globe.tileLoadProgressEvent.listeners.size).toBe(0);
  });
  it('drops footprints still preparing when the terrain goes smooth', async () => {
    const h = harness({ draped: true });
    const pending = Promise.withResolvers<FakeRasterProvider>();
    vi.mocked(h.draped.runtime.providerFromSpec).mockReturnValueOnce(pending.promise as never);
    const shown = h.show('a');
    h.style.draped = false;
    await h.layers.rebuild();
    const provider = fakeRasterProvider();
    pending.resolve(provider);
    await shown; await h.pump();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(footprintsOf(h)).toHaveLength(0);
  });
  it('rebuilds the footprints in a new sampling colour, keeping the old until the new is ready', async () => {
    const h = harness({ draped: true });
    await h.show('a');
    const [old] = footprintsOf(h);
    old.ready = true; await h.pump(2);
    h.layers.setObservationAppearance({ ...h.style.observationStyle, samplingAreaColor: '#ff00ff' }, h.style.layers);
    await flushTasks();
    expect(h.draped.providers.at(-1)!.spec).toMatchObject({ color: '#ff00ff', layer: 'footprints' });
    const [, next] = footprintsOf(h);
    expect(old.destroy).not.toHaveBeenCalled();
    next.ready = true; await h.pump(2);
    expect(old.destroy).toHaveBeenCalledTimes(1);
  });
  it('reverts through onDrapeFailure when the footprints cannot be rastered', async () => {
    const h = harness({ draped: true });
    const error = new Error('raster worker failed');
    vi.mocked(h.draped.runtime.providerFromSpec).mockRejectedValueOnce(error);
    await h.show('a');
    expect(h.onDrapeFailure).toHaveBeenCalledWith(error);
  });
  it('releases the footprints and ground of a pruned observation group', async () => {
    const h = harness({ draped: true });
    await h.show('a');
    const [first] = footprintsOf(h);
    for (const id of ['b', 'c', 'd']) await h.show(id); // the observation cache holds 3
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(h.scene.globe.tileLoadProgressEvent.listeners.size).toBe(1); // the displayed group's only
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-scientific-layers.test.ts -t "observations on World Terrain"`
Expected: FAIL: `h.layers.resampleGround is not a function`; no `'footprints'` spec requested.

- [ ] **Step 3: Implement `ObservationDrapes` and its wiring**

- **Tracking:** `Map<ObservationPrimitiveGroup, { ground: GroundHeights; color: string | null; build: AbortController | null }>`. ScientificLayers calls `sync` from `#observationGroupFor` (new and cached groups) and from `setObservationAppearance` for the groups in view, `release` from `#dispose`, `resample` from `resampleGround`, and `destroy` from `destroy()`.
- **While draped:** create `createGroundHeights(scene, observationPoints(observations)!)` once, `onChange` → `group.setGroundHeights`, applying `heights()` at once. When `samplingAreaColor` differs from the entry's colour, abort the old build and run a new one: `await options.draped()`; `providerFromSpec(runtime.rasterSource(worker), footprintSpec(…), signal)`, `errorEvent` → `onDrapeFailure` once; `addDrapedImageryLayer({ alpha: 0, name: 'atlas-footprints', provider, scene })`; `whenLayerReady`; `group.setFootprints(layer)`.
- **On the smooth globe:** `release(group)` and delete the entry.
- **Errors:** an AbortError is ignored; any other goes to `onDrapeFailure`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd website && npx vitest run tests/atlas-scientific-layers.test.ts tests/atlas-module-size.test.ts`
Expected: PASS; the smooth-globe tests unchanged and none creates ground heights; `scientific-layers.ts` still ≤ 986 logical lines.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/{observation-drapes,scientific-layers}.ts website/tests/atlas-scientific-layers.test.ts
git commit -m "feat: drape sampling footprints and ground the symbols of draped observations (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 25: Scene wiring, relief, and the retired warning (P3.int-b)

**Parallel:** no. Depends on Tasks 20, 21, 23 and 24; hot file.

**Files:**
- Modify: `src/atlas/scene/atlas-scene.ts`: `:191-194` (the `#reliefFrame` callback adds `#followRelief()`), `:206-212` (`ContextOverlay` options gain `onDrapeFailure: (e) => this.#onDrapeFailure(e)`), `#setDrapeTerrain` (Task 16) gains `void this.#drapeContext(next)`, `:641-662` (`destroy` clears the relief timer and the pending after-render)
- Modify: `src/atlas/earth-style-catalog.ts`: `reliefControl`'s World Terrain branch returns `warning: null`; the docstring says the data drapes onto the relief (draping design "Exaggeration")
- Modify: `tests/atlas-terrain.spec.ts:29-30, 139, 142`: `toHaveText(HIDDEN_DATA)` becomes `await expect(chooser.getByText(HIDDEN_DATA)).toHaveCount(0)`; the constant's comment says phase 3 retired it
- Test: `tests/atlas-scene-terrain.test.ts` (mocks gain `setDraped`, `setGround`, `resampleGround` as `vi.fn()` recorded in `harness`; the fake scene gains a raisable `postRender` and a `globe` sentinel; mock `../src/atlas/scene/draped/runtime` to `harness.drapedRuntime`), `tests/atlas-terrain-controls.test.ts` (replace the two PR 1 warning tests; drop the `/hide map data on high ground/` line from 'renders a labelled "Physical relief ×" slider')

**Interfaces:**
- Consumes: `afterNextRender`, `GROUND_RESAMPLE_MS` (Task 20); `HighlightLayer.setGround` (Task 21); `ContextOverlay.setDraped`, `onDrapeFailure` (Task 23); `ScientificLayers.resampleGround` (Task 24); `#drapeTerrain`, `#setDrapeTerrain`, `#loadDrapedRuntime`, `#onDrapeFailure` (Task 16).
- Produces (private): `#drapeContext(draped: boolean): Promise<void>`, `#followRelief(): void`, `#resampleGround(final: boolean): void`.

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-scene-terrain.test.ts
it('drapes the context overlay and the highlight with the data, and lets them go on the smooth globe', async () => {
  const controller = scene();
  void controller.setTerrain('world-terrain');
  await flushTasks();
  expect(harness.overlay.setDraped).toHaveBeenLastCalledWith(harness.drapedRuntime);
  expect(harness.highlight.setGround).toHaveBeenLastCalledWith(harness.globe);
  void controller.setTerrain('smooth-globe');
  await flushTasks();
  expect(harness.overlay.setDraped).toHaveBeenLastCalledWith(null);
  expect(harness.highlight.setGround).toHaveBeenLastCalledWith(null);
});
it('resamples the ground after the frame that applies relief, and once more when the slider rests', async () => {
  vi.useFakeTimers();
  const controller = scene();
  void controller.setTerrain('world-terrain');
  await vi.advanceTimersByTimeAsync(0);
  harness.highlight.setGround.mockClear();
  controller.setRelief(3);
  frame(); // the relief frame: TerrainShading sets scene.verticalExaggeration
  // Cesium re-exaggerates loaded tiles in the next render (GlobeSurfaceTileProvider.js:555-575).
  expect(harness.layers.resampleGround).not.toHaveBeenCalled();
  harness.postRender.raise();
  expect(harness.layers.resampleGround.mock.calls).toEqual([[false]]);
  vi.advanceTimersByTime(GROUND_RESAMPLE_MS);
  harness.postRender.raise();
  expect(harness.layers.resampleGround.mock.calls).toEqual([[false], [true]]);
  expect(harness.highlight.setGround).toHaveBeenLastCalledWith(harness.globe);
  vi.useRealTimers();
});
it('leaves the smooth globe alone when relief is set', () => {
  const controller = scene();
  controller.setRelief(3); frame(); harness.postRender.raise();
  expect(harness.layers.resampleGround).not.toHaveBeenCalled();
});
it('reverts to the smooth globe when the borders cannot be draped', () => {
  const controller = scene();
  const warnings = vi.fn();
  controller.onWarning(warnings);
  harness.overlayOptions!.onDrapeFailure!(new Error('raster worker failed'));
  expect(harness.terrainRequests.at(-1)).toBe('smooth-globe');
  expect(warnings).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'drape' })]));
});
it('stops relief resampling once the scene is destroyed', async () => {
  vi.useFakeTimers();
  const controller = scene();
  void controller.setTerrain('world-terrain'); await vi.advanceTimersByTimeAsync(0);
  controller.setRelief(3); frame(); controller.destroy();
  harness.postRender.raise(); vi.advanceTimersByTime(GROUND_RESAMPLE_MS); harness.postRender.raise();
  expect(harness.layers.resampleGround).not.toHaveBeenCalled();
  vi.useRealTimers();
});
// atlas-terrain-controls.test.ts
it('does not warn about hidden data: the data drapes onto World Terrain (#483)', () => {
  for (const [value, view] of [[1, 'globe'], [3, 'globe'], [10, 'perspective']] as const)
    expect(reliefControl({ relief: value, terrain: 'world-terrain', view }).warning).toBeNull();
  const html = relief('world-terrain', 'globe', 3);
  expect(tagWithId(html, 'atlas-relief')).toContain('aria-describedby="atlas-relief-help"');
  expect(html).toMatch(/<div role="status"[^>]*><\/div>/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-scene-terrain.test.ts tests/atlas-terrain-controls.test.ts -t "drapes the context|resamples the ground|smooth globe alone|borders cannot be draped|stops relief|does not warn"`
Expected: FAIL: `setDraped` and `resampleGround` are never called; the warning is `'World Terrain can hide map data…'`.

- [ ] **Step 3: Implement the change**

- **`#drapeContext(draped)`**, behind a sequence guard: `this.#highlightLayer.setGround(draped ? scene.globe : null)`; then `await this.#overlay.setDraped(draped ? await this.#loadDrapedRuntime() : null)`, applied only if still the latest flip.
- **`#followRelief()`** returns at once unless `#drapeTerrain`; it replaces any pending `afterNextRender(scene, () => this.#resampleGround(false))` and re-arms `setTimeout(() => afterNextRender(scene, () => this.#resampleGround(true)), GROUND_RESAMPLE_MS)`.
- **`#resampleGround(final)`** calls `this.#layers.resampleGround(final)` and `this.#highlightLayer.setGround(scene.globe)`.
- **`reliefControl`**'s World Terrain branch returns `{ disabled: false, note: null, warning: null }`.

- [ ] **Step 4: Run the tests to verify they pass**

Same vitest command: PASS. Then `cd website && PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ PUBLIC_GA_MEASUREMENT_ID=G-TEST123 npm run build:e2e && npx playwright test tests/atlas-terrain.spec.ts --project=desktop-chromium`: 4 passed.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/scene/atlas-scene.ts website/src/atlas/earth-style-catalog.ts website/tests/atlas-scene-terrain.test.ts website/tests/atlas-terrain-controls.test.ts website/tests/atlas-terrain.spec.ts
git commit -m "feat: follow Physical relief with the draped context, and retire the hidden-data warning (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 26: Placement, labels and footprints end to end (P3.int-c)

**Parallel:** no. Depends on Tasks 18–25.

**Files:**
- Modify: `src/atlas/e2e-hooks.ts`: in `declare global`, `__atlasWindowOf?: (lon: number, lat: number, aboveGroundMetres: number) => { x: number; y: number } | null` and `__atlasLabelClearance?: (text: string) => number | null`
- Modify: `src/atlas/scene/synthetic-terrain.ts`: `publishTerrainProbe` publishes both; its removal deletes them
- Modify: `tests/atlas-terrain-helpers.ts`: `windowOf(page, lon, lat, metres)`, `clickAbove(page, metres)` (`SYNTHETIC_PEAK` + the `.atlas-scene canvas` box, asserting the point lies inside it), `pixelsAround(page, at, radius): Promise<[number, number, number][]>` (same in-page decode as `changedShare`)
- Modify: `tests/atlas-drape.spec.ts`: the describe below
- Test: `tests/atlas-synthetic-terrain.test.ts` (`fakeWidget`'s `scene.primitives` becomes a real `PrimitiveCollection`)

**Interfaces:**
- Consumes: `SYNTHETIC_PEAK`, the Task 5 helpers, `probe(page).draped`/`imageryLayers` (Task 17).
- Produces: `window.__atlasWindowOf(lon, lat, aboveGroundMetres)`: canvas CSS px of `globe.getHeight(lon, lat) + aboveGroundMetres`, or null until that ground has loaded or off screen (the `apexWindow` convention). `window.__atlasLabelClearance(text)`: walks `scene.primitives` (recursing into `PrimitiveCollection`s) for a `LabelCollection` label with that text and returns the height of `label._clampedPosition ?? label.position` minus `globe.getHeight` under it; null when no such label exists or its ground has not loaded.

- [ ] **Step 1: Write the failing tests**
```ts
// atlas-synthetic-terrain.test.ts
it('projects a point above the rendered ground for the browser test, and unpublishes it', () => {
  const page = {} as Window;
  vi.stubGlobal('window', page);
  const widget = fakeWidget(createSyntheticTerrain());
  widget.scene.globe.getHeight.mockReturnValue(6_000);
  const toWindow = vi.spyOn(SceneTransforms, 'worldToWindowCoordinates').mockReturnValue(new Cartesian2(12, 34));
  const unpublish = publishTerrainProbe(widget as unknown as CesiumWidget);
  expect(page.__atlasWindowOf!(-3.709, 40.419, 7_650)).toEqual({ x: 12, y: 34 });
  expect(Ellipsoid.WGS84.cartesianToCartographic(toWindow.mock.calls[0][1]).height).toBeCloseTo(13_650, 3);
  widget.scene.globe.getHeight.mockReturnValue(undefined);
  expect(page.__atlasWindowOf!(-3.709, 40.419, 7_650)).toBeNull();
  unpublish();
  expect(page.__atlasWindowOf).toBeUndefined();
  expect(page.__atlasLabelClearance).toBeUndefined();
});
it('reports how far a label stands above the rendered ground', () => {
  const page = {} as Window;
  vi.stubGlobal('window', page);
  const widget = fakeWidget(createSyntheticTerrain());
  const labels = new LabelCollection();
  labels.add({ position: Cartesian3.fromDegrees(-3.464718, 40.090953, 24_000), text: 'Spain' });
  widget.scene.primitives.add(new PrimitiveCollection()).add(labels);
  widget.scene.globe.getHeight.mockReturnValue(21_500);
  publishTerrainProbe(widget as unknown as CesiumWidget);
  expect(page.__atlasLabelClearance!('Spain')).toBeCloseTo(2_500, 3);
  expect(page.__atlasLabelClearance!('Kenya')).toBeNull();
});
```

```ts
// atlas-drape.spec.ts: values pinned by unit tests (observation-symbols, line-raster)
const SYMBOL_CLEARANCE = 650 + 7_000;
const SPHERE_RADIUS = 12_000; // obsShape=sphere, obsSize=fixed, pointMin=pointMax=12 → 12 × 1,000 m
const RING = { lat: 40.454, lon: -3.7302, radiusKm: 12.6156626101008 }; // map-surveys:892, 4.3 km from the apex
const ORDER = ['atlas-surface', 'atlas-outlines', 'atlas-borders', 'atlas-footprints'];
const atlasLayers = (names: string[]) => names.filter((name) => name.startsWith('atlas-'));
const ALL_LAYERS = 'surface,observations,support,context,countries';

test.describe('context and observations on World Terrain @desktop-chromium', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { window.__atlasSyntheticTerrain = true; });
  });

  test('symbols and labels stand above the summit at Physical relief 6, and follow it to 10', async ({ page }) => {
    // 155 km south of the apex, 110 km up, looking 20° down: the summit spheres sit near the view axis.
    await openDrape(page, drapeQuery('oblique', 6, { height: '110000', lat: String(SYNTHETIC_PEAK.lat - 1.4),
      layers: ALL_LAYERS, obsShape: 'sphere', obsSize: 'fixed', pointMax: '12', pointMin: '12' }));
    await expect.poll(async () => (await probe(page)).draped).toBe(true);
    await expect.poll(async () => (await probe(page)).tilesLoaded, { timeout: 30_000 }).toBe(true);
    const observation = page.getByRole('complementary', { name: 'Selected observation' });
    // At 6× the 36 km summit buries today's spheres (centre 19.65 km); a grounded one is picked here.
    await clickAbove(page, SYMBOL_CLEARANCE + SPHERE_RADIUS);
    await expect(observation).toContainText('Spain'); // map-surveys:1135, :966 or :892, all within 5 km
    await page.keyboard.press('Escape');
    await expect(observation).toBeHidden();
    // Spain's label anchor is 42 km from the apex, on the peak's flank.
    await expect.poll(() => page.evaluate(() => window.__atlasLabelClearance!('Spain')), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2_499);

    const chooser = await openTerrainChooser(page);
    await chooser.getByLabel('Physical relief ×').fill('10');
    await expect(page).toHaveURL(/relief=10(&|$)/);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await probe(page)).verticalExaggeration).toBe(10);
    await expect.poll(async () => (await probe(page)).tilesLoaded, { timeout: 30_000 }).toBe(true);
    await clickAbove(page, SYMBOL_CLEARANCE + SPHERE_RADIUS); // the 60 km summit: the spheres followed it
    await expect(observation).toContainText('Spain');
    await expect.poll(() => page.evaluate(() => window.__atlasLabelClearance!('Spain'))).toBeGreaterThanOrEqual(2_499);
  });

  test('sampling footprints and borders drape onto the summit, and leave with World Terrain', async ({ page }) => {
    // Straight down from 120 km at relief 6; small circles, no surface, so the 12.6 km ring's north point is clear.
    await openDrape(page, drapeQuery('nadir', 6, { height: '120000', layers: 'observations,context,countries',
      obsShape: 'circle', obsSize: 'fixed', pointMax: '4', pointMin: '4', samplingAreas: 'true', samplingColor: '#ff00ff' }));
    await expect.poll(async () => atlasLayers((await probe(page)).imageryLayers), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(['atlas-borders', 'atlas-footprints']));
    const names = atlasLayers((await probe(page)).imageryLayers);
    expect(names).toEqual(ORDER.filter((name) => names.includes(name)));
    await expect.poll(async () => (await probe(page)).tilesLoaded, { timeout: 30_000 }).toBe(true);
    // Today's rings sit 4 km above sea level, under the ~33 km ground there; the draped ring lies on it.
    const north = await windowOf(page, RING.lon, RING.lat + RING.radiusKm / 111.195, 0);
    expect((await pixelsAround(page, north!, 2)).some(([r, g, b]) => r >= 150 && b >= 150 && g <= 110)).toBe(true);

    const chooser = await openTerrainChooser(page);
    await chooser.getByRole('radio', { name: 'Smooth Globe terrain' }).click();
    await expect.poll(async () => (await probe(page)).draped, { timeout: 30_000 }).toBe(false);
    await expect.poll(async () => atlasLayers((await probe(page)).imageryLayers)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run tests/atlas-synthetic-terrain.test.ts -t "projects a point|label stands"`: FAIL with `page.__atlasWindowOf is not a function`. Then the e2e build and `npx playwright test tests/atlas-drape.spec.ts --project=desktop-chromium -g "context and observations on World Terrain"`: 2 failed (`window.__atlasWindowOf is not a function`).

- [ ] **Step 3: Implement the hooks and helpers**

`__atlasWindowOf` reads `globe.getHeight(Cartographic.fromDegrees(lon, lat))` (undefined → null), then `SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(lon, lat, ground + aboveGroundMetres))`. `pixelsAround` screenshots the (2r+1)² block with `page.screenshot({ clip })` and decodes it in the page like `changedShare` (the repo has no PNG library).

- [ ] **Step 4: Run the tests to verify they pass**

Same two commands: vitest PASS, Playwright 2 passed. Then the whole spec, `npx playwright test tests/atlas-drape.spec.ts --project=desktop-chromium`: every phase 1–3 test passes.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/e2e-hooks.ts website/src/atlas/scene/synthetic-terrain.ts website/tests/atlas-synthetic-terrain.test.ts website/tests/atlas-terrain-helpers.ts website/tests/atlas-drape.spec.ts
git commit -m "test: drive grounded symbols, clamped labels and draped footprints over the synthetic peak (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Phase 3 ship checklist

- [ ] From `website/`: `npm run format:check`; `npm run check`; `npm test` (the draped markers stay out of the /app/ initial chunks and the worker's first load; the Cesium chunk within its gzip pin; P3 adds about 3 kB gzip there, so if the pin trips, move `ground-heights.ts` behind the draped runtime; `atlas-module-size` reads 755/784 for `AtlasExplorer.tsx` and ≤ 986 for `scientific-layers.ts`).
- [ ] The e2e build, then `npx playwright test tests/atlas-drape.spec.ts tests/atlas-terrain.spec.ts --project=desktop-chromium` and `npx playwright test tests/atlas-mobile.spec.ts` (smooth-globe regression).
- [ ] `npm run test:performance` (atlas-performance and atlas-cold-load): the smooth-globe budgets pass unchanged.
- [ ] `atlas-terrain-performance.spec.ts` (still report-only): paste requested/delivered/empty tiles, raster p95 at level ≥ 3 (target ≤ 2 ms) and resident Atlas imagery, now including borders and footprints (target ≤ 160 MiB desktop), into the PR.
- [ ] Manual ion run with a real token: borders, footprints, labels and grounded spheres in the Himalaya and the Ethiopian highlands at relief 1, 3 and 10, in globe, perspective and map views; attach screenshots.
- [ ] **PR** title: `feat: drape the Atlas context and observations onto World Terrain (advances #483)`. TL;DR:
  - Under World Terrain, country borders (`atlas-borders`, 1.65 texels at the country opacity, to level 11) and sampling footprints (`atlas-footprints`, 2 texels at α 0.9) are draped imagery, rasterised by the data worker from its Natural Earth copy and the observation circles, stacked above the surface and its outlines.
  - Observation symbols sit 7,650 m above `globe.getHeight`, re-sampled as tiles load, after each morph, and on relief changes (at most every 50 ms after the frame that applies the change, and once more when the slider rests). Country labels clamp 2,500 m above the ground; the hover and selection outline is densified 300 m above it.
  - PR 1's Physical relief (`relief`, [1, 10], step 0.5) now carries all the data with it, so its "World Terrain can hide map data on high ground" warning is retired.
  - The smooth globe is unchanged; the draped code stays lazy; a raster failure reverts to the smooth globe with the `'drape'` warning.
  - E2E on the synthetic peak at relief 6 and 10: the Spain survey's sphere is picked above the summit, Spain's label stands above the flank, a footprint shows on the ground, and the layer order is checked.
  - Left for phase 4: Honmoon contours, the shader pre-warm, the mobile memory measurement and fallbacks, asserted budgets.
  - Body says "advances #483" and ends with the Claude Code line. After opening, arm a CI watch and move the board item on orgs/genomeOS/projects/1.

---

## Phase 4: Honmoon and hardening (Tasks 27–36)

**Branch:** `feat/atlas-drape-4`, stacked on `feat/atlas-drape-3`. One PR; its body says "closes #483".

**What ships.** Under World Terrain, Honmoon draws its contour lines into the draped surface; each new draped surface compiles its globe shader before it fades in; phones are measured against the 96 MiB imagery budget and the spec's fallbacks are applied only as far as needed; the World Terrain budgets become assertions.

**Architecture.** A Cesium-free `geometry/raster/contours.ts` ports the smooth-globe Honmoon fragment (`scene/surface-appearance.ts:162-176`) to texels, replacing the shader's `fwidth` with the fan triangle's analytic value gradient; `fill-raster.ts` calls it per texel when `SurfaceRasterSpec.contours` is true. `DrapedImageryLayer.prewarm()` draws one frame at α 0.001, and `DrapedSurfaceGroup.isReady()` waits for it. One tour in `atlas-terrain-performance.spec.ts` records each project's numbers, including peak resident Atlas imagery, and `tests/support/terrain-budgets.ts` turns a run into a list of failures.

**Spec sections:** "Build phases" item 4, "Performance budget and measurement", "Failure modes".

### Phase 4 decisions

1. **The Honmoon constants import Cesium.** `HONMOON_CONTOUR_BANDS` and `honmoonModeForGeometry` live in `scene/surface-appearance.ts`, which imports Cesium, so the worker cannot use them. Task 27 moves both into the Cesium-free `geometry/surface-buffers.ts` and re-exports them, as `SURFACE_CLEARANCE_METRES` already is; identity and the smooth-globe shader do not change.
2. **Measure before building fallbacks.** The spec says "fallbacks if needed" and the owner "desktop-only if needed", so Task 31 measures first, and Tasks 32–35 run in the spec's order only while phones are still over 96 MiB. The skeleton's names and signatures stay.
3. **Files beyond the skeleton:** `geometry/surface-buffers.ts` and `scene/surface-appearance.ts` (decision 1); `scene/surface-groups.ts` (Task 11's `drapedSurfaceSpec` sets `contours`, so `scientific-layers.ts` is not touched); `scene/terrain-shading.ts` (applies `tileCacheSize` with the terrain); `scene/context-overlay.ts` (border level from the memory policy); for the desktop-only gate only, `scene/context-controller.ts`, `scene/types.ts`, `explorer-runtime.ts` and `EarthStylePicker.tsx`. The conditional tasks add `DrapedRuntime.memory` and `SurfaceRasterSpec.mergedOutlines?`.
4. **Memory is asserted on every renderer — needs the owner's sign-off.** Resident memory is a count of tiles, not a timing, so Task 36 asserts it on every renderer, CI's SwiftShader included, and skips only the timing budgets there. The spec skips every terrain budget on SwiftShader; this is the plan's one departure from it. If the owner declines, `terrainBudgetFailures` also skips the memory comparison on a software renderer (Task 30's last test flips to expect `[]`).

### Phase 4 reviewer checks

- Premultiplied tile bitmaps would darken the partial-alpha Honmoon halo (Cesium blends imagery as straight alpha): Task 8 "makes bitmaps unflipped and unpremultiplied" pins it.
- Sliver, polar and antimeridian fans give degenerate or non-finite gradients, and a wrapped fan must not break a contour at the seam: Task 27 "draws a degenerate or non-finite derivative as the widest line"; Task 28 "meets its contours across the antimeridian".
- A layer destroyed or restyled during its pre-warm frame settles, leaves no scene listener and no α stuck at 0.001: Task 29 "settles and lets go of the scene when destroyed mid pre-warm".
- Mobile emulation that is not a coarse pointer would silently measure the desktop policy: Task 31 Step 7 (if `(pointer: coarse)` does not match on `mobile-chromium`, enable CDP `Emulation.setTouchEmulationEnabled { enabled: true, maxTouchPoints: 5 }` before navigating; never drop the check).
- A run that passes because nothing was measured: Task 30 "never passes a run with nothing measured".

---

### Task 27: Honmoon contour shading for texels (P4.1)

**Parallel:** yes, with Tasks 29 and 30. Pure: it may branch from Task 6.

**Files:**
- Create: `src/atlas/geometry/raster/contours.ts`
- Modify: `src/atlas/geometry/surface-buffers.ts:86-92`: the two Honmoon exports after `isSmoothGeometry`
- Modify: `src/atlas/scene/surface-appearance.ts:31-32`, `:245-249`: replace both definitions with `export { HONMOON_CONTOUR_BANDS, honmoonModeForGeometry } from '../geometry/surface-buffers';` and import them for the shader template
- Test: `tests/atlas-raster-contours.test.ts`

**Interfaces:**
- Produces:
```ts
// geometry/surface-buffers.ts (moved; surface-appearance.ts re-exports both)
export const HONMOON_CONTOUR_BANDS = 36;
export function honmoonModeForGeometry(geometry: SurfaceGeometry): 0 | 1 | 2;
// geometry/raster/contours.ts
export type HonmoonMode = 1 | 2; // 1: lines (honmoon); 2: lines and fill (honmoon-fill)
export const HONMOON_DERIVATIVE_CLAMP = [0.006, 0.22] as const; // the shader's fwidth clamp
/** [∂v/∂lon, ∂v/∂lat] per degree of the plane through three vertices; [0, 0] when collinear. */
export function triangleValueGradient(lon0: number, lat0: number, v0: number, lon1: number, lat1: number, v1: number,
  lon2: number, lat2: number, v2: number, out?: Float64Array): Float64Array;
/** One texel's RGBA at out[offset..offset+3]. colour: interpolated sRGB in [0, 1] (v_surfaceColor); value: the normalised
 * value (v_surfaceValue); valueDerivative: |∂v/∂column| + |∂v/∂row| per texel. */
export function honmoonTexel(colour: ArrayLike<number>, value: number, valueDerivative: number,
  mode: HonmoonMode, out: Uint8ClampedArray, offset: number): void;
```

- [ ] **Step 1: Write the failing tests**
```ts
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** surface-appearance.ts:162-176 with material.alpha 1 and fwidth(contourCoordinate) = 36 × derivative. */
function shaderHonmoon(c: readonly number[], v: number, derivative: number, mode: 1 | 2): number[] {
  const cc = v * 36;
  const d = Math.abs(cc + 0.5 - Math.floor(cc + 0.5) - 0.5);
  const p = d / Math.min(0.22, Math.max(0.006, 36 * derivative));
  const core = 1 - smoothstep(0.45, 1.15, p);
  const halo = 1 - smoothstep(0.7, 4.5, p);
  const rgb = c.map((x) => mix(x * 0.55, mix(x, 1, 0.2 + core * 0.3) * 1.35, Math.max(core, halo * 0.62)));
  const alpha = Math.max(mode === 2 ? 0.28 : 0, Math.max(core, halo * 0.42));
  return [...rgb, alpha].map((x) => Math.round(255 * Math.min(1, Math.max(0, x))));
}
const texel = (c: readonly number[], v: number, derivative: number, mode: 1 | 2) => {
  const out = new Uint8ClampedArray(4);
  honmoonTexel(c, v, derivative, mode, out, 0);
  return [...out];
};

it('ports the smooth-globe Honmoon fragment within one byte', () => {
  for (const mode of [1, 2] as const)
    for (const c of [[0, 0, 0], [0.2, 0.6, 0.9], [1, 1, 1], [0.93, 0.11, 0.42]])
      for (const v of [0, 1 / 72, 0.1, 0.5, 37 / 72, 0.9861, 1])
        for (const derivative of [0, 1e-5, 0.0002, 0.003, 0.05, 1])
          texel(c, v, derivative, mode).forEach((byte, channel) =>
            expect(Math.abs(byte - shaderHonmoon(c, v, derivative, mode)[channel])).toBeLessThanOrEqual(1));
});
it('draws one contour per band a ramp crosses', () => {
  for (const mode of [1, 2] as const) {
    const lit = Array.from({ length: 256 }, (_, col) => texel([0.2, 0.6, 0.9], 0.1 + (0.8 * col) / 255, 0.8 / 255, mode)[3] >= 128);
    expect(lit.filter((on, col) => on && !lit[col - 1]).length).toBe(29); // lines at k/36 for k = 4..32
  }
});
it('draws a degenerate or non-finite derivative as the widest line, never NaN bytes', () => {
  expect(texel([0.2, 0.6, 0.9], 0.51, Number.NaN, 1)).toEqual(texel([0.2, 0.6, 0.9], 0.51, Number.POSITIVE_INFINITY, 1));
  expect(texel([0.2, 0.6, 0.9], 0.51, Number.NaN, 1)).toEqual(texel([0.2, 0.6, 0.9], 0.51, 1, 1)); // 36 × 1 clamps to 0.22
});
it('gives the plane through three vertices, and none for collinear ones', () => {
  const plane = (lon: number, lat: number) => 0.01 * lon + 0.02 * lat;
  const g = triangleValueGradient(36, -2, plane(36, -2), 37, -2, plane(37, -2), 36.5, -1, plane(36.5, -1));
  expect(g[0]).toBeCloseTo(0.01, 12);
  expect(g[1]).toBeCloseTo(0.02, 12);
  expect([...triangleValueGradient(0, 0, 0, 1, 1, 0.5, 2, 2, 1)]).toEqual([0, 0]);
});
it('still ports the shader text it was written from', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../src/atlas/scene/surface-appearance.ts'), 'utf8');
  for (const line of [
    'float distanceToLine = abs(fract(contourCoordinate + 0.5) - 0.5);',
    'float screenDerivative = clamp(fwidth(contourCoordinate), 0.006, 0.22);',
    'float core = 1.0 - smoothstep(0.45, 1.15, pixelsFromLine);',
    'float halo = 1.0 - smoothstep(0.7, 4.5, pixelsFromLine);',
    'vec3 luminous = mix(v_surfaceColor, vec3(1.0), 0.2 + core * 0.3);',
    'float fillAlpha = u_honmoonMode > 1.5 ? material.alpha * 0.28 : 0.0;',
    'float lineAlpha = material.alpha * max(core, halo * 0.42);',
    'vec3 fillColor = v_surfaceColor * 0.55;',
    'mix(fillColor, luminous * 1.35, max(core, halo * 0.62)),',
  ]) expect(source).toContain(line);
});
it("shares the smooth globe's band count and mode table", async () => {
  const scene = await import('../src/atlas/scene/surface-appearance');
  expect(scene.HONMOON_CONTOUR_BANDS).toBe(HONMOON_CONTOUR_BANDS);
  expect(HONMOON_CONTOUR_BANDS).toBe(36);
  expect(scene.honmoonModeForGeometry).toBe(honmoonModeForGeometry);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd website && npx vitest run tests/atlas-raster-contours.test.ts`
Expected: FAIL: `Failed to resolve import "../src/atlas/geometry/raster/contours"`.

- [ ] **Step 3: Move `HONMOON_CONTOUR_BANDS` and `honmoonModeForGeometry` into `surface-buffers.ts`** (return type narrowed to `0 | 1 | 2`) and re-export them from `surface-appearance.ts`.

- [ ] **Step 4: Implement `contours.ts`**

w = 36 × `valueDerivative`; non-finite w becomes 0.22, otherwise clamped to `HONMOON_DERIVATIVE_CLAMP`. Apply the oracle's formula with material α 1 (the layer's α carries opacity) and write 255 × channel into the clamping array; the shader's `luminous × 1.35` overshoot, which HDR keeps on the smooth globe, saturates here. Fast path: when p ≥ 4.5, core and halo are 0, so mode 1 writes `0,0,0,0` and mode 2 writes 0.55 × colour at α 0.28 (the formula's own values, keeping the 2 ms p95). `triangleValueGradient`: with dx_i = lon_i − lon0, dy_i = lat_i − lat0, dv_i = v_i − v0 and det = dx1·dy2 − dx2·dy1, ∂v/∂lon = (dv1·dy2 − dv2·dy1)/det and ∂v/∂lat = (dx1·dv2 − dx2·dv1)/det, `[0, 0]` when det = 0.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd website && npx vitest run tests/atlas-raster-contours.test.ts tests/atlas-surface-appearance.test.ts tests/atlas-scene.test.ts`
Expected: PASS (the moved exports keep the existing Honmoon assertions green).

- [ ] **Step 6: Commit**
```bash
git add website/src/atlas/geometry/raster/contours.ts website/src/atlas/geometry/surface-buffers.ts \
  website/src/atlas/scene/surface-appearance.ts website/tests/atlas-raster-contours.test.ts
git commit -m "feat: port the Honmoon contour shading to texels for the draped surface (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 28: Contours in the draped surface raster (P4.2)

**Parallel:** after Task 27; parallel with Tasks 29 and 30.

**Files:**
- Modify: `src/atlas/geometry/raster/fill-raster.ts` (Task 12): the smooth (fan) branch of `rasterSurfaceTile` and its empty-tile return
- Test: `tests/atlas-raster-fill.test.ts`

**Interfaces:**
- Consumes: `honmoonTexel`, `triangleValueGradient`, `honmoonModeForGeometry` (Task 27); `rasterSurfaceTile`, `texelCentre`, `tileRectangle`, `buildGridIndex`, `RASTER_TILE_SIZE` (Tasks 6, 7, 12); `meshInputFor` (`tests/helpers/mesh-input.ts`).
- Produces: `rasterSurfaceTile` draws contours when `contours` is true and throws for a geometry with none; the empty-tile rule becomes "null when no texel has α > 0".

- [ ] **Step 1: Write the failing tests**
```ts
/** buildSmoothChunk's fan at a point, by brute force: the supported row whose triangle (centre, ring[k], ring[k+1]) contains
 * (lon, lat), vertex longitudes unwrapped to within 180° of the cell centre, the point tried at lon and lon ± 360. Barycentric
 * weights in degrees. Values and colours are exactly what buildSmoothChunk writes: centre normalizedValue(values[row]),
 * corners vertexMeans(input).values[id], colour colorBytesAtStops(linearStops(palette), value) / 255. */
function fanAt(input: SurfaceRasterInput, lon: number, lat: number): { colour: number[]; value: number; gradient: Float64Array } | null;

const KENYA = { lat: -1.836, lon: 36.793 }; // the Task 7 fixtures' disk centre
const FIJI = { lat: -17.7, lon: 179.95 };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
function honmoonInput(at: { lat: number; lon: number }, k: number, geometry: DrapedGeometry, value: (lon: number) => number,
  support: (row: number) => Support = () => 'interpolated'): SurfaceRasterInput {
  const cells = sortedU64(gridDisk(latLngToCell(at.lat, at.lon, 4), k));
  const mesh = meshInputFor(cells.map((h3, row) => ({ h3, support: support(row), value: value(cellToLatLng(h3)[1]) })));
  return { ...mesh, geometry, index: buildGridIndex(mesh.topology), cells: { supported: true, masked: true },
    contours: geometry === 'honmoon' || geometry === 'honmoon-fill' };
}
/** Bytes of the texels whose centre lies in a supported fan, against honmoonTexel at the oracle's value and gradient. */
function honmoonMismatches(input: SurfaceRasterInput, tile: TileAddress, mode: 1 | 2): { compared: number; mismatches: string[] };

it.each([['honmoon', 1], ['honmoon-fill', 2]] as const)('draws %s contours to the smooth-globe formula at every texel centre', (geometry, mode) => {
  const { compared, mismatches } = honmoonMismatches(honmoonInput(KENYA, 5, geometry, (lon) => clamp01((lon - 35.4) / 3)), { x: 154, y: 65, level: 7 }, mode);
  expect(mismatches).toEqual([]);
  expect(compared).toBeGreaterThan(50_000);
});
it('meets its contours across the antimeridian', () => {
  const input = honmoonInput(FIJI, 3, 'honmoon', (lon) => clamp01((((lon + 360) % 360) - 177) / 6));
  for (const tile of [{ x: 127, y: 38, level: 6 }, { x: 0, y: 38, level: 6 }]) {
    const { compared, mismatches } = honmoonMismatches(input, tile, 1);
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(5_000);
  }
});
it('leaves the support masks as they are', () => {
  const support = (row: number): Support => (['unknown', 'prior_dominated', 'interpolated'] as const)[row % 3];
  const ramp = (lon: number) => clamp01((lon - 35.4) / 3);
  const tile = { x: 154, y: 65, level: 7 };
  const honmoon = honmoonInput(KENYA, 5, 'honmoon', ramp, support);
  const plain = rasterSurfaceTile(honmoonInput(KENYA, 5, 'triangles', ramp, support), tile)!;
  const lined = rasterSurfaceTile(honmoon, tile)!;
  const changed: number[] = [];
  for (let row = 0; row < 256; row++) for (let column = 0; column < 256; column++) {
    const { lon, lat } = texelCentre(tile, column, row);
    if (fanAt(honmoon, lon, lat)) continue;
    const offset = (row * 256 + column) * 4;
    for (let channel = 0; channel < 4; channel++) if (lined.rgba[offset + channel] !== plain.rgba[offset + channel]) changed.push(offset);
  }
  expect(changed).toEqual([]);
});
it('returns no tile where line-only Honmoon draws nothing', () => {
  const tile = { x: 154, y: 65, level: 7 };
  expect(rasterSurfaceTile(honmoonInput(KENYA, 5, 'honmoon', () => 37 / 72), tile)).toBeNull(); // mid-band: 36v = 18.5
  const fill = rasterSurfaceTile(honmoonInput(KENYA, 5, 'honmoon-fill', () => 37 / 72), tile)!;
  expect(new Set(alphaOfFanTexels(fill))).toEqual(new Set([71])); // 0.28 × 255
});
it('refuses contours on a geometry that has none', () => {
  const input = { ...honmoonInput(KENYA, 1, 'triangles', () => 0.5), contours: true };
  expect(() => rasterSurfaceTile(input, { x: 154, y: 65, level: 7 })).toThrow('Honmoon contours need the honmoon or honmoon-fill geometry');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd website && npx vitest run tests/atlas-raster-fill.test.ts -t "Honmoon|contours|masks|line-only|antimeridian"`
Expected: FAIL: the parity tests list mismatches (Honmoon still draws Task 12's fill) and the line-only tile is non-null.

- [ ] **Step 3: Implement the contour path in `rasterSurfaceTile`**

`mode = honmoonModeForGeometry(i.geometry)`; `i.contours && mode === 0` throws the message above. `texelDegrees = (rect.east − rect.west) / RASTER_TILE_SIZE` once per tile. Once per fan triangle, `triangleValueGradient` on the same unwrapped (lon, lat, value) vertices Task 12 interpolates, and `derivative = texelDegrees × (|g[0]| + |g[1]|)`. Each filled texel calls `honmoonTexel(colour, value, derivative, mode, rgba, offset)` with Task 12's barycentric colour as floats in [0, 1], not rounded bytes. Return null when no texel has α > 0.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd website && npx vitest run tests/atlas-raster-fill.test.ts tests/atlas-raster-coverage.test.ts tests/atlas-raster-worker.test.ts`
Expected: PASS, with Task 12's parity, coverage and seam tests unchanged.

- [ ] **Step 5: Commit**
```bash
git add website/src/atlas/geometry/raster/fill-raster.ts website/tests/atlas-raster-fill.test.ts
git commit -m "feat: draw Honmoon contours into the draped surface tiles from the fan's analytic gradient (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 29: Pre-warm the globe shader before a draped fade (P4.3)

**Parallel:** yes, with Tasks 27, 28 and 30.

**Files:**
- Modify: `src/atlas/scene/draped/draped-imagery-layer.ts` (Task 9): `DrapedImageryLayer`, `addDrapedImageryLayer`
- Modify: `src/atlas/scene/types.ts`: `DrapedImageryLayer` gains `prewarm()`
- Modify: `src/atlas/scene/draped/draped-surface-group.ts` (Task 14): `isReady()`
- Test: `tests/atlas-draped-surface-group.test.ts`, `tests/atlas-cesium-internals.test.ts`

**Interfaces:**
- Consumes: `addDrapedImageryLayer`, `DrapedImageryLayer.{setAlpha, setShown, isReady, destroy}`, `DRAPED_READY_CAP_MS`, `DRAPED_SURFACE_ALPHA` and the group's α rules (Tasks 9, 14); `DrapedScene` already has `'postRender'` (Task 6). The scene renders on request (`globe-widget.ts:42-43`, `requestRenderMode: true`), so only a `postRender` proves the α 0.001 frame was drawn.
- Produces:
```ts
export const PREWARM_ALPHA = 0.001;
interface DrapedImageryLayer { /* Task 6 */ prewarm(): Promise<void> } // repeated calls return the same promise
// DrapedSurfaceGroup.isReady(): true only once its layers have loaded (Task 14) and their pre-warm has resolved
```
Why only the layers the fade will draw: Cesium caches a globe shader per number of drawn textures (`GlobeSurfaceShaderSet.js`, `_shadersByTexturesFlags[numberOfDayTextures]`) and skips layers at α 0 (Task 9's pin), so the pre-warm frame must draw exactly what the fade draws: the incoming surface when its target α is above 0, the outlines when edges are on, and the outgoing group beside them. An edge toggle is instant, not animated, so its compile is latency rather than a jump in the fade, and it is not pre-warmed.

- [ ] **Step 1: Write the failing tests**

Reuse Task 9's and Task 14's fakes; `listeners(scene)` sums `numberOfListeners` over `scene.preRender` and `scene.postRender`. `drapedLayerAt(alpha)` adds one layer; `loadedGroup(o)` returns a prepared group with tiles loaded at opacity 0 and its `layers` by name.
```ts
describe('pre-warm (#483 phase 4)', () => {
  it('draws a layer at α 0.001 for one frame, then restores its α', async () => {
    const { scene, layer } = drapedLayerAt(0);
    const baseline = listeners(scene);
    const warmed = layer.prewarm();
    expect(layer.layer.alpha).toBe(PREWARM_ALPHA);
    expect(scene.requestRender).toHaveBeenCalled();
    scene.postRender.raiseEvent(); // that frame began before the pre-warm, so it does not count
    expect(layer.layer.alpha).toBe(PREWARM_ALPHA);
    scene.preRender.raiseEvent();
    scene.postRender.raiseEvent();
    await warmed;
    expect(layer.layer.alpha).toBe(0);
    expect(listeners(scene)).toBe(baseline);
  });
  it('keeps an α set during the pre-warm frame', async () => { /* setAlpha(0.3) after prewarm(); after the frame alpha === 0.3 */ });
  it('leaves a drawn or hidden layer alone', async () => {
    /* α 0.5: prewarm() resolves with no frame, alpha stays 0.5, listeners === baseline; the same after setShown(false) at α 0 */
  });
  it('settles and lets go of the scene when destroyed mid pre-warm', async () => {
    const { scene, layer } = drapedLayerAt(0);
    const baseline = listeners(scene);
    const warmed = layer.prewarm();
    layer.destroy();
    await expect(warmed).resolves.toBeUndefined();
    expect(listeners(scene)).toBe(baseline);
  });
  it('is ready only after its pre-warm frame has drawn', () => {
    const { scene, group, layers } = loadedGroup({ cellEdges: false });
    expect(group.isReady()).toBe(false);
    expect(layers['atlas-surface'].alpha).toBe(PREWARM_ALPHA);
    scene.preRender.raiseEvent();
    scene.postRender.raiseEvent();
    return vi.waitFor(() => expect(group.isReady()).toBe(true));
  });
  it('pre-warms the outlines with the surface when edges are on', () => { /* cellEdges: true → both layers at PREWARM_ALPHA */ });
});
// atlas-cesium-internals.test.ts
it('keys globe shaders by the number of drawn textures (why the pre-warm works)', () => {
  expect(cesiumSource('Scene/GlobeSurfaceShaderSet.js')).toContain('this._shadersByTexturesFlags[numberOfDayTextures]');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd website && npx vitest run tests/atlas-draped-surface-group.test.ts -t "pre-warm"`
Expected: FAIL: `layer.prewarm is not a function`. The pin passes against Cesium 1.145.

- [ ] **Step 3: Implement `prewarm()`**

Hidden, or requested α already ≥ `PREWARM_ALPHA`: resolve at once. Otherwise floor `layer.alpha = max(requested, PREWARM_ALPHA)` and request a render; the first `preRender` marks the pre-warm frame; on the `postRender` after it, drop the floor, write the requested α, remove both listeners, request a render and resolve. `destroy()` removes the listeners and resolves.

- [ ] **Step 4: Gate `DrapedSurfaceGroup.isReady()` on the pre-warm**

The first time the group finds its layers loaded (Task 14's rule), it calls `prewarm()` once on the layers the fade will draw: the surface when `DRAPED_SURFACE_ALPHA × surfaceOpacity > 0` and a cell set is on; the outlines when `cellEdges` is on. `isReady()` is true once those promises have resolved.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd website && npx vitest run tests/atlas-draped-surface-group.test.ts tests/atlas-cesium-internals.test.ts tests/atlas-scientific-layers.test.ts`
Expected: PASS; Task 11's swap and cold-wave tests still green (they wait one more frame).

- [ ] **Step 6: Commit**
```bash
git add website/src/atlas/scene/draped website/src/atlas/scene/types.ts \
  website/tests/atlas-draped-surface-group.test.ts website/tests/atlas-cesium-internals.test.ts
git commit -m "feat: pre-warm a draped surface's globe shader one frame before it fades in (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 30: Terrain budget evaluator (P4.4)

**Parallel:** yes, with Tasks 27–29. Pure: it may branch from Task 6.

**Files:**
- Create: `tests/support/terrain-budgets.ts`
- Test: `tests/atlas-terrain-budgets.test.ts`

**Interfaces:**
- Consumes: `DrapeStats` (type, `src/atlas/scene/types.ts`) and `RESIDENT_TILE_BYTES` (`src/atlas/geometry/raster/types.ts`; import it, never restate it).
- Produces:
```ts
export const MIB = 1_048_576;
export type TerrainProfile = 'desktop' | 'mobile';
export interface TerrainBudgets { dataVisibleMs: number; restyleMs: number; orbitFps: number; longFrameMs: number; rasterP95Ms: number; residentBytes: number }
export const TERRAIN_BUDGETS: Record<TerrainProfile, TerrainBudgets>; // desktop: 2_000, 2_000, 45, 200, 2, 160 * MIB; mobile: the same except longFrameMs 800, residentBytes 96 * MIB
export interface TerrainPerformanceMetrics {
  profile: TerrainProfile; renderer: string;
  dataVisibleMs: number;  // terrain switch → draped data visible (Task 17's measure)
  restyleMs: number[];    // each restyle → globe.tilesLoaded
  orbitFps: number;
  longFramesMs: number[]; // long-animation-frame durations from the terrain switch on
  rasterMs: DrapeStats['rasterMs'];
  peakResidentBytes: number;
}
export function isSoftwareRenderer(renderer: string): boolean;               // /swiftshader|software/i, as atlas-performance.spec.ts tests it
export function rasterP95UpperMs(histogram: DrapeStats['rasterMs']): number; // first upperMs whose running count reaches 95%; NaN with no samples
export function terrainBudgetFailures(metrics: TerrainPerformanceMetrics): string[];
```
`terrainBudgetFailures` checks, in order: data visible; each restyle (or `'no restyles measured'`); orbit; each long frame; raster p95 (or `'no raster samples at level 3 or finer'`); resident memory. Milliseconds and fps are rounded to whole numbers, bytes exact. On a software renderer it skips the timing comparisons, never the two "nothing measured" checks or (pending phase 4 decision 4) the memory check.

- [ ] **Step 1: Write the failing tests**
```ts
const PASSING: TerrainPerformanceMetrics = {
  profile: 'desktop', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)', dataVisibleMs: 1_400, restyleMs: [900, 1_300],
  orbitFps: 58, longFramesMs: [120, 180], peakResidentBytes: 150 * MIB,
  rasterMs: { upperMs: [0.5, 1, 2, 4, 8, 16, Infinity], counts: [40, 50, 6, 4, 0, 0, 0] },
};
const NONE = [0, 0, 0, 0, 0, 0, 0];
it('passes a run inside every budget', () => expect(terrainBudgetFailures(PASSING)).toEqual([]));
it('reads the raster p95 off the histogram', () => {
  expect(rasterP95UpperMs(PASSING.rasterMs)).toBe(2);
  expect(rasterP95UpperMs({ ...PASSING.rasterMs, counts: [0, 90, 4, 6, 0, 0, 0] })).toBe(4);
  expect(rasterP95UpperMs({ ...PASSING.rasterMs, counts: NONE })).toBeNaN();
});
it('fails each budget it is outside, with the measured number', () => {
  expect(terrainBudgetFailures({ ...PASSING, dataVisibleMs: 2_100, restyleMs: [900, 2_400], orbitFps: 40, longFramesMs: [250],
    rasterMs: { ...PASSING.rasterMs, counts: [0, 90, 4, 6, 0, 0, 0] } })).toEqual([
    'data visible 2100 ms > 2000 ms', 'restyle 2400 ms > 2000 ms', 'orbit 40 fps < 45 fps',
    'long frame 250 ms > 200 ms', 'raster p95 4 ms > 2 ms']);
});
it('never passes a run with nothing measured', () => {
  expect(terrainBudgetFailures({ ...PASSING, restyleMs: [], rasterMs: { ...PASSING.rasterMs, counts: NONE } }))
    .toEqual(['no restyles measured', 'no raster samples at level 3 or finer']);
});
it('holds phones to 96 MiB and desktops to 160 MiB of resident imagery', () => {
  const mobile = { ...PASSING, profile: 'mobile' as const, longFramesMs: [700] };
  expect(terrainBudgetFailures({ ...mobile, peakResidentBytes: 100_663_296 })).toEqual([]);
  expect(terrainBudgetFailures({ ...mobile, peakResidentBytes: 100_663_297 })).toEqual(['resident Atlas imagery 100663297 B > 100663296 B']);
  expect(terrainBudgetFailures({ ...PASSING, peakResidentBytes: 167_772_161 })).toEqual(['resident Atlas imagery 167772161 B > 167772160 B']);
  expect(Math.floor(TERRAIN_BUDGETS.mobile.residentBytes / RESIDENT_TILE_BYTES)).toBe(288);
  expect(Math.floor(TERRAIN_BUDGETS.desktop.residentBytes / RESIDENT_TILE_BYTES)).toBe(480);
});
it('skips the timing budgets on a software renderer, never the memory budget', () => {
  expect(terrainBudgetFailures({ ...PASSING, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))',
    dataVisibleMs: 9_000, orbitFps: 4, longFramesMs: [3_000], peakResidentBytes: 170 * MIB }))
    .toEqual(['resident Atlas imagery 178257920 B > 167772160 B']);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd website && npx vitest run tests/atlas-terrain-budgets.test.ts`
Expected: FAIL: `Failed to resolve import "./support/terrain-budgets"`.

- [ ] **Step 3: Implement `terrain-budgets.ts`** to the interfaces above.

- [ ] **Step 4: Run the tests and confirm they pass**

Same command. Expected: PASS (6 tests).

- [ ] **Step 5: Commit**
```bash
git add website/tests/support/terrain-budgets.ts website/tests/atlas-terrain-budgets.test.ts
git commit -m "test: own the World Terrain budgets and judge a measured run against them (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 31: Wire Honmoon, tour the terrain, measure (P4.int)

**Parallel:** no. Depends on Tasks 28, 29 and 30.

**Files:**
- Modify: `src/atlas/scene/surface-groups.ts` (Task 11): `drapedSurfaceSpec`'s `contours: false` becomes `contours: honmoonModeForGeometry(geometry) !== 0`, `geometry` being the drawn geometry
- Modify: `tests/atlas-terrain-helpers.ts`: `drapeSettled(page)`
- Test: `tests/atlas-scientific-layers.test.ts`, `tests/atlas-drape.spec.ts`, `tests/atlas-terrain-performance.spec.ts`

**Interfaces:**
- Consumes: `honmoonModeForGeometry` (Task 27, from `geometry/surface-buffers`); `TerrainPerformanceMetrics`, `TerrainProfile`, `terrainBudgetFailures` (Task 30); `window.__atlasDrapeStats` (Task 16); the Task 5 helpers; `expandExplorerSheet` and `touchDrag` (`tests/atlas-mobile-helpers.ts`); phase 3's ground heights, which re-sample during the tour's relief step so long frames include that work.
- Produces:
```ts
// tests/atlas-terrain-helpers.ts
export async function drapeSettled(page: Page): Promise<void>; // cameraSettled, then probe().tilesLoaded and __atlasDrapeStats().queueDepth === 0
```
The spec's single test `'World Terrain meets its budgets'` runs in both projects (still report-only); its measured peaks decide Tasks 32–35.

- [ ] **Step 1: Write the failing unit test** (`atlas-scientific-layers.test.ts`, in the draped describe)
```ts
it.each([['honmoon', true], ['honmoon-fill', true], ['triangles', false], ['hexagons', false]] as const)(
  'asks the draped surface for Honmoon contours with %s: %s', (geometry, contours) => {
    const surface = columnarSurface([{ h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'observed' }]);
    expect(drapedSurfaceSpec({ artifactKey: surface.artifactKey }, surface, { ...harness({ draped: true }).style, geometry }).contours).toBe(contours);
  });
```

- [ ] **Step 2: Write the failing e2e test** (`atlas-drape.spec.ts`, inside the `terrain draping @desktop-chromium` describe)
```ts
test('Honmoon draws its contours on the draped surface', async ({ page }) => {
  const shot = async (geometry: string) => {
    await openDrape(page, drapeQuery('nadir', 1, { geometry, height: '400000' }));
    await drapeSettled(page);
    return summitPatch(page, await apexOnPage(page), 160);
  };
  const triangles = await shot('triangles');
  const honmoon = await shot('honmoon');
  expect(await changedShare(page, triangles, honmoon)).toBeGreaterThan(0.2);
});
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `cd website && npx vitest run tests/atlas-scientific-layers.test.ts -t "Honmoon contours"`; then the e2e build and `npx playwright test tests/atlas-drape.spec.ts -g "Honmoon draws its contours" --project=desktop-chromium`.
Expected: FAIL: the spec has `contours: false`; the changed share is about 0, because phase 2 draws Honmoon as a fill.

- [ ] **Step 4: Implement the wiring** (the one line under Files).

- [ ] **Step 5: Run both tests again** (rebuild the e2e build first). Expected: PASS.

- [ ] **Step 6: Turn the terrain spec into one tour in both projects**

Fold Task 17's report-only test into `'World Terrain meets its budgets'`, with no project tag, producing one `TerrainPerformanceMetrics` per project. It records:
```ts
await page.addInitScript(() => {
  window.__atlasSyntheticTerrain = true;
  const w = window as Window & { __atlasPeakResident?: number; __atlasLongFrames?: number[] };
  w.__atlasPeakResident = 0;
  w.__atlasLongFrames = [];
  new PerformanceObserver((list) => w.__atlasLongFrames!.push(...list.getEntries().map((entry) => entry.duration)))
    .observe({ type: 'long-animation-frame', buffered: true });
  const sample = () => {
    const stats = window.__atlasDrapeStats?.();
    if (stats) w.__atlasPeakResident = Math.max(w.__atlasPeakResident!, stats.residentBytes);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
if (profile === 'mobile') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
```
The tour:
1. Start at `/app/?${drapeQuery('oblique', 1, { edges: 'true', geometry: 'triangles', height: '400000', lat: String(SYNTHETIC_PEAK.lat), layers: 'surface,observations,support,context,countries', palette: 'rainbow', pitch: '-45', terrain: 'smooth-globe' })}`. Wait for ready and a settled camera, then clear `__atlasLongFrames`.
2. Switch to World Terrain through `openTerrainChooser`, giving `dataVisibleMs`.
3. Orbit 160 px in 20 steps (mouse; `touchDrag` on mobile) while counting rAF frames over 1.2 s, as `atlas-performance.spec.ts` does: `orbitFps`.
4. Press 'Zoom in' three times, settling after each.
5. Move 'Physical relief ×' from 1 to 3.
6. Change 'Surface palette' to `viridis`, then 'Surface geometry' to `honmoon`, timing each from the change to `tilesLoaded`: `restyleMs`.
7. Press 'Home'.
8. Read `rasterMs` from the stats; take `peakResidentBytes` and `longFramesMs`.

On `mobile-chromium`, call `expandExplorerSheet(page)` before using a control. Attach `atlas-terrain-performance.json` and log the metrics; the test stays report-only here.

- [ ] **Step 7: Check that the phone run really is a coarse pointer** (right after navigating)
```ts
expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(profile === 'mobile');
```

- [ ] **Step 8: Measure**

Run: the e2e build, then `npx playwright test tests/atlas-terrain-performance.spec.ts -g "World Terrain meets its budgets"`.
Expected: 2 passed (report-only). Record each project's `peakResidentBytes` and the rest of the JSON for the PR.

- [ ] **Step 9: Decide what happens next**

- Desktop peak above 167,772,160 B: stop and report it to the owner; the spec's fallbacks are mobile-only, so this is a phase 2 design defect, not a fallback case.
- Mobile peak at or below 100,663,296 B: skip Tasks 32–35 and record "no mobile fallback needed (*n* MiB)".
- Otherwise: Task 32.

- [ ] **Step 10: Commit**
```bash
git add website/src/atlas/scene/surface-groups.ts website/tests/atlas-scientific-layers.test.ts website/tests/atlas-terrain-helpers.ts \
  website/tests/atlas-drape.spec.ts website/tests/atlas-terrain-performance.spec.ts
git commit -m "feat: draw Honmoon contours under World Terrain and tour the terrain budgets on desktop and phone (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 32: Mobile fallback 1: a smaller tile cache under World Terrain (P4.6)

**Run only if** the last recorded mobile peak is above 100,663,296 B; otherwise record it as skipped. **Depends on** Task 31.

**Files:**
- Modify: `src/atlas/scene/scene-policy.ts`: the memory policy after `hillshadeShading`
- Modify: `src/atlas/scene/terrain-shading.ts`: `:43-49` (`ShadingScene.globe` gains `tileCacheSize: number`), `:109-111` (constructor options), `:113-131` (`update()` sets `globe.tileCacheSize`)
- Test: `tests/atlas-terrain-shading.test.ts` (`fakeScene`'s globe gains `tileCacheSize: 100`)

**Interfaces:**
- Produces:
```ts
export const CESIUM_TILE_CACHE_SIZE = 100; // Globe.tileCacheSize default (Globe.js:116)
export interface DrapeMemoryPolicy { readonly tileCacheSize: number }
export const DESKTOP_DRAPE_MEMORY: DrapeMemoryPolicy;        // { tileCacheSize: 100 }
export const COARSE_POINTER_DRAPE_MEMORY: DrapeMemoryPolicy; // { tileCacheSize: 50 }, or 25 after Step 5
export function isCoarsePointer(): boolean; // typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
export function drapeMemoryPolicy(coarsePointer: boolean): DrapeMemoryPolicy;
export function globeTileCacheSize(i: { terrain: TerrainId; coarsePointer: boolean }): number; // 100 unless hasPhysicalRelief && coarse
// TerrainShading
constructor(scene: ShadingScene, options?: { coarsePointer?: boolean }) // default isCoarsePointer(); atlas-scene.ts untouched
```

- [ ] **Step 1: Write the failing tests**
```ts
describe('drape memory policy (#483 mobile fallback 1)', () => {
  it("keeps Cesium's tile cache on desktops and on the smooth globe", () => {
    expect(drapeMemoryPolicy(false)).toBe(DESKTOP_DRAPE_MEMORY);
    expect(globeTileCacheSize({ terrain: 'smooth-globe', coarsePointer: true })).toBe(100);
    expect(globeTileCacheSize({ terrain: 'world-terrain', coarsePointer: false })).toBe(100);
  });
  it('lowers the tile cache on coarse pointers while World Terrain is on', () => {
    expect(COARSE_POINTER_DRAPE_MEMORY.tileCacheSize).toBe(50);
    expect(globeTileCacheSize({ terrain: 'world-terrain', coarsePointer: true })).toBe(50);
  });
});
it('applies the coarse-pointer tile cache with World Terrain and restores 100 on the smooth globe', () => {
  const { scene } = fakeScene();
  const shading = new TerrainShading(scene, { coarsePointer: true });
  shading.update({ terrain: 'world-terrain' });
  expect(scene.globe.tileCacheSize).toBe(50);
  shading.update({ terrain: 'smooth-globe' });
  expect(scene.globe.tileCacheSize).toBe(100);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd website && npx vitest run tests/atlas-terrain-shading.test.ts -t "tile cache"`
Expected: FAIL: `drapeMemoryPolicy is not a function`.

- [ ] **Step 3: Implement the policy and apply it in `TerrainShading.update()`.**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd website && npx vitest run tests/atlas-terrain-shading.test.ts tests/atlas-scene-terrain.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-measure**

The e2e build, then `npx playwright test tests/atlas-terrain-performance.spec.ts --project=mobile-chromium -g "World Terrain meets its budgets"`. Above 100,663,296 B: set 25 in both the constant and the test and measure again (25 is the floor: below it every small pan reloads terrain and basemap tiles over a phone's network). Record the peak; still over budget → Task 33.

- [ ] **Step 6: Commit**
```bash
git add website/src/atlas/scene/scene-policy.ts website/src/atlas/scene/terrain-shading.ts website/tests/atlas-terrain-shading.test.ts
git commit -m "feat: keep fewer cached terrain tiles on touch screens while World Terrain is on (advances #483)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 33: Mobile fallback 2: outlines merged into the surface texture (P4.7)

**Run only if** the mobile peak after Task 32 is still above 100,663,296 B. **Depends on** Task 32 (and edits `fill-raster.ts` after Task 28).

**Files:**
- Modify: `src/atlas/scene/scene-policy.ts`: `mergeOutlines` (desktop false, coarse true)
- Modify: `src/atlas/geometry/raster/types.ts`: `mergedOutlines?` on the surface spec and input
- Modify: `src/atlas/geometry/raster/fill-raster.ts`: `compositeOver` and the merge step
- Modify: `src/atlas/worker/raster-handlers.ts`: pass `mergedOutlines` from the spec to the input
- Modify: `src/atlas/scene/types.ts` and `src/atlas/scene/draped/runtime.ts`: `DrapedRuntime.memory`
- Modify: `src/atlas/scene/draped/draped-surface-group.ts`: merge mode
- Modify: `tests/helpers/draped-fakes.ts`: the fake runtime gains `memory: DESKTOP_DRAPE_MEMORY`
- Test: `tests/atlas-raster-fill.test.ts`, `tests/atlas-raster-worker.test.ts`, `tests/atlas-draped-surface-group.test.ts`, `tests/atlas-terrain-shading.test.ts`

**Interfaces:**
- Produces:
```ts
interface DrapeMemoryPolicy { readonly tileCacheSize: number; readonly mergeOutlines: boolean }
interface SurfaceRasterSpec { /* Task 6 */ mergedOutlines?: EdgeColorSpec } // set by the group only; absent: a separate outlines layer
export function compositeOver(under: TileRaster | null, over: TileRaster | null): TileRaster | null; // fill-raster.ts
interface DrapedRuntime { /* Task 6 */ readonly memory: DrapeMemoryPolicy } // drapeMemoryPolicy(isCoarsePointer()) at creation
function createDrapedSurfaceGroup(o: DrapedSurfaceGroupOptions & { mergeOutlines?: boolean }): DrapedSurfaceGroup; // the runtime passes memory.mergeOutlines
```
`compositeOver` is straight-alpha source-over: with aS = over.a/255 and aD = under.a/255, aO = aS + aD(1 − aS) and rgb = aO === 0 ? 0 : (rgbS·aS + rgbD·aD(1 − aS)) / aO, written as 255 × value. The fallback's cost (state it in the PR): merged outlines take the surface layer's α (0.9 × surfaceOpacity × fade), so on phones the edges dim with surface opacity; an edge toggle or colour change re-rasters the surface, a restyle (≤ 2 s) instead of an instant change.

- [ ] **Step 1: Write the failing tests**
  - `'composites straight-alpha source-over'`: under `[255,0,0,255]`, over `[0,0,255,235]` → `[20,0,235,255]`; under transparent → over; both null → null.
  - `'merges outlines over the surface from level 3'`: the Kenya input with `mergedOutlines: { mode: 'matched' }`; at `{x:77, y:32, level:6}` the bytes equal `compositeOver(rasterSurfaceTile(unmerged), rasterOutlineTile({ ...unmerged, edgeColor: { mode: 'matched' } }, tile))`; at `{x:4, y:2, level:2}` they equal the unmerged tile.
  - Worker: `'passes merged outlines from the spec to the rasteriser'`.
  - Group: `'draws no outlines layer when outlines are merged'` (names `['atlas-surface']`; the prepared spec carries `mergedOutlines`); `'turning edges off re-rasters the surface and replaces it in place'` (a new spec without `mergedOutlines`; after load and pre-warm one `atlas-surface` remains at the same index and the old provider is released); `'keeps only the latest of two quick edge toggles'` (the first `prepare` signal is aborted).
  - Policy: `COARSE_POINTER_DRAPE_MEMORY.mergeOutlines === true`, `DESKTOP_DRAPE_MEMORY.mergeOutlines === false`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd website && npx vitest run tests/atlas-raster-fill.test.ts tests/atlas-draped-surface-group.test.ts -t "merge|composite|toggle"`
Expected: FAIL: `compositeOver is not a function`.

- [ ] **Step 3: Implement**

`rasterSurfaceTile` composites the outline raster over the surface when `i.mergedOutlines` is set and `a.level >= OUTLINE_MIN_LEVEL`. In merge mode, `setCellEdges` and `setOutlineStyle` prepare the new surface spec under an `AbortController`; the new layer is added at α 0 directly above the old one and, once `isReady()` (pre-warmed), takes the current surface α while the old one is destroyed in the same frame.

- [ ] **Step 4: Run the tests and confirm they pass, then re-measure as in Task 32 Step 5.** Record the peak; still over budget → Task 34.

- [ ] **Step 5: Commit** with `feat: merge cell outlines into the draped surface tiles on touch screens (advances #483)` and the Co-Authored-By trailer.

---

### Task 34: Mobile fallback 3: borders capped at level 10 (P4.8)

**Run only if** the mobile peak after Task 33 is still above 100,663,296 B. **Depends on** Task 33 (`DrapedRuntime.memory`).

**Files:**
- Modify: `src/atlas/scene/scene-policy.ts`: `borderMaximumLevel: 10 | 11` (desktop 11, coarse 10)
- Modify: `src/atlas/scene/context-overlay.ts` (Task 23): `setDraped(r)` builds `BorderRasterSpec` with `maximumLevel: r.memory.borderMaximumLevel` instead of `BORDER_MAXIMUM_LEVEL`
- Test: `tests/atlas-context-overlay.test.ts`, `tests/atlas-terrain-shading.test.ts`

**Interfaces:**
- Produces: `DrapeMemoryPolicy` gains `readonly borderMaximumLevel: 10 | 11` (the fake runtime's `memory` from Task 33 picks it up).

- [ ] **Step 1: Write the failing test** `"caps the border raster at the runtime's memory policy"`: with a fake runtime whose `memory` is `{ ...DESKTOP_DRAPE_MEMORY, borderMaximumLevel: 10 }`, the spec passed to `providerFromSpec` matches `expect.objectContaining({ layer: 'borders', maximumLevel: 10 })`; with the desktop policy, 11.
- [ ] **Step 2: Run the test and confirm it fails.** `cd website && npx vitest run tests/atlas-context-overlay.test.ts -t "memory policy"`: FAIL with `maximumLevel: 11`.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the test until it passes, then re-measure as in Task 32 Step 5 and record the peak.**
- [ ] **Step 5: Commit** with `feat: stop sharpening draped borders past level 10 on touch screens (advances #483)` and the Co-Authored-By trailer.

---

### Task 35: Last resort: World Terrain on desktops only (P4.9)

**Run only if** the mobile peak after Task 34 is still above 100,663,296 B. The owner's decision applies: "Yes, desktop-only if needed", with a note saying why it is off. **Depends on** Task 34.

**Files:**
- Modify: `src/atlas/earth-style-catalog.ts`: `availableTerrains` (`:275-283`) and the note beside `ION_UNAVAILABLE` (`:256-257`)
- Modify: `src/atlas/scene/context-controller.ts`: `:52-57` (options), `:232-248` (`capabilities()`, `#terrains()`), `:324-330` (the unavailability message)
- Modify: `src/atlas/scene/types.ts:113-116`, `src/atlas/explorer-runtime.ts:8-11` (`terrainNote: null`), `src/components/atlas/EarthStylePicker.tsx:302-304`
- Modify: `docs/superpowers/specs/2026-09-07-cesium-explorer-interaction-design.md` §5.2
- Test: `tests/atlas-terrain-controls.test.ts`, `tests/atlas-context-controller.test.ts`, `tests/atlas-drape.spec.ts` (a `@mobile-chromium` describe), `tests/atlas-terrain-performance.spec.ts` (the mobile tour skipped with that reason)

**Interfaces:**
- Produces:
```ts
export const WORLD_TERRAIN_TOUCH_NOTE =
  'World Terrain is not available on touch screens: draping the map data on it needs more graphics memory than phones have.';
export function availableTerrains(token: string, coarsePointer = false): Record<TerrainId, boolean>; // world-terrain false when coarse
interface SceneCapabilities { basemaps; terrains; terrainNote: string | null } // why World Terrain is off, when not the ion token
interface ContextControllerOptions { /* PR 1 */ coarsePointer?: boolean } // defaults to isCoarsePointer()
```
On a coarse pointer, `#terrains()` keeps World Terrain off even with the e2e stand-in injected; `#loadTerrain` warns `${WORLD_TERRAIN_TOUCH_NOTE} The smooth globe remains active.`; the picker's World Terrain detail shows `capabilities.terrainNote` in place of the ion-token text. `AtlasExplorer.tsx` stays untouched.

- [ ] **Step 1: Write the failing tests**
  - Catalog: `'turns World Terrain off on touch screens, with the reason'`.
  - Controller: `'keeps the smooth globe on a touch screen, even with the stand-in, and says why'`: with `{ coarsePointer: true, worldTerrain }`, `setTerrain('world-terrain')` resolves false, the warning is the note plus `' The smooth globe remains active.'`, and `capabilities().terrainNote` is the note.
  - E2E `@mobile-chromium`: `'World Terrain is desktop-only on touch screens'`: a cold load of `drapeQuery('nadir', 1)` keeps `provider: 'ellipsoid'` and shows the note; in the chooser (after `expandExplorerSheet`) the World Terrain radio has `aria-disabled="true"` and its detail shows the note.
- [ ] **Step 2: Run the tests and confirm they fail.** `cd website && npx vitest run tests/atlas-terrain-controls.test.ts tests/atlas-context-controller.test.ts -t "touch screen"`, and the e2e test by name after the e2e build: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests until they pass**, plus `tests/atlas-module-size.test.ts`.
- [ ] **Step 5: Amend §5.2** with one paragraph dated the day of the change: World Terrain is offered only on fine pointers, with the reason.
- [ ] **Step 6: Commit** with `feat: offer World Terrain on desktops only, and say why on touch screens (advances #483)` and the Co-Authored-By trailer.

---

### Task 36: Assert the terrain budgets and close #483 (P4.10)

**Parallel:** no. Depends on Task 31 and whichever of Tasks 32–35 ran. Confirm phase 4 decision 4 (memory on SwiftShader) with the owner first.

**Files:**
- Modify: `tests/atlas-terrain-performance.spec.ts`
- Modify: `docs/superpowers/specs/2026-09-07-cesium-explorer-interaction-design.md` §5.2
- Modify: `docs/superpowers/specs/2026-10-18-atlas-terrain-draping-design.md`: the status line

**Interfaces:**
- Consumes: `terrainBudgetFailures`, `isSoftwareRenderer` (Task 30); the tour (Task 31).

- [ ] **Step 1: Make the budgets assertions** (replace the report-only ending)
```ts
if (isSoftwareRenderer(metrics.renderer))
  testInfo.annotations.push({ type: 'timing budgets skipped', description: `software renderer: ${metrics.renderer}` });
expect(terrainBudgetFailures(metrics)).toEqual([]);
```
- [ ] **Step 2: Run the CI-like check.** The e2e build, then `npx playwright test tests/atlas-terrain-performance.spec.ts`. Expected: 2 passed; on SwiftShader the timings are annotated as skipped and memory is asserted.
- [ ] **Step 3: Run on a hardware GPU.** `npx playwright test tests/atlas-terrain-performance.spec.ts --headed`. Expected: 2 passed with every budget asserted; keep both JSON attachments for the PR.
- [ ] **Step 4: Update the docs.** §5.2: under World Terrain, Honmoon draws its contour lines into the draped surface; each new draped surface draws one frame at α 0.001 before it fades in; on touch screens resident Atlas imagery is held to 96 MiB by the fallbacks applied (named), or "no fallback was needed". The draping design's status line changes from "Proposed." to "Implemented (#483)."
- [ ] **Step 5: Commit** with `test: assert the World Terrain budgets on hardware GPUs, and memory everywhere (advances #483)` and the Co-Authored-By trailer.

---

### Phase 4 ship checklist

- [ ] From `website/`: `npm run format:check`; `npm run check`; `npm test` (`atlas-bundle` with both markers absent from the initial chunks and the Cesium gzip pin; `atlas-module-size`; `atlas-pixel-diff`).
- [ ] The e2e build, then `npx playwright test tests/atlas-drape.spec.ts tests/atlas-terrain.spec.ts tests/atlas-terrain-performance.spec.ts tests/atlas-mobile.spec.ts tests/site.spec.ts`, in both projects.
- [ ] Smooth globe unchanged: `npm run build && npm run test:performance -- tests/atlas-performance.spec.ts tests/atlas-cold-load.spec.ts`, headed on a hardware GPU; the same budgets as before Task 1.
- [ ] After pushing, arm a CI watch on the PR and fix failures before asking for review.
- [ ] **PR** title: `feat: Honmoon contours on World Terrain, shader pre-warm and asserted terrain budgets (closes #483)`. TL;DR:
  - Under World Terrain, Honmoon draws its contour lines into the draped surface, ported from the smooth-globe shader with an analytic gradient; line-only Honmoon shows the basemap between its lines, as on the smooth globe.
  - Each new draped surface draws one frame at α 0.001 before its fade, so Cesium compiles the globe shader before the fade instead of during it.
  - Mobile memory: the phone peak was *x* MiB against 96 MiB, the desktop peak *y* MiB against 160 MiB; the fallbacks applied (tile cache *n* / merged outlines / borders at level 10 / desktop-only), or "none needed". Merged outlines dim with surface opacity, and their edge toggle becomes a restyle.
  - World Terrain budgets are asserted on hardware GPUs (data visible ≤ 2 s, restyles ≤ 2 s, ≥ 45 fps, long frames ≤ 200 ms desktop and ≤ 800 ms mobile ×4, raster p95 ≤ 2 ms). Memory is asserted on every renderer, CI included, as the owner signed off (phase 4 decision 4).
  - The smooth globe is unchanged: its cold-load, performance, mobile and pixel-diff specs pass without edits.
  - Closes #483 (earlier phase PRs said "advances #483"). The body ends with the Claude Code line.
