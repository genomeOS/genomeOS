# Draping Atlas data onto World Terrain (#483): design

Proposed. Cesium 1.145. Paths relative to `website/src/atlas/`.

## Intent

With Cesium World Terrain on, the data layers sit at fixed heights (surface 650 m, edges 1,050 m, borders 1,800 m, rings 4,000 m, symbols 7,000 m), so higher ground buries them. The owner decided to drape the data onto the terrain, light the terrain with a hillshade, and add a terrain-exaggeration control. The default smooth globe must not change.

## Goals and non-goals

Goals:
- Under World Terrain, surface, masks, edges, borders and footprints follow the ground at every zoom, mode and exaggeration, with the hillshade on the data.
- Symbols and labels are never buried; picks are correct on slopes and in oblique views.
- The smooth globe is unchanged in look, bytes and timings.

Non-goals:
- No change to the GOSA tiers, the server or the smooth-globe pipeline.
- Terrain height is never added to the metric (interaction spec §5.2, §6.2).
- No radial reveal wave under World Terrain.

## Decision

**Approach 1, draped imagery, with small changes.** The data worker rasterises H3 cells into 256×256 tiles, and Cesium drapes them as imagery layers. Cesium then handles terrain level of detail, scene modes, morphs, exaggeration and lighting. Imagery is blended into the globe colour before lighting is applied (GlobeFS.glsl:353, :431), so the hillshade falls on the data.

| Approach | Fidelity | Smooth globe | Performance | Features | Effort/risk |
|---|---|---|---|---|---|
| 1 Draped imagery | 9 | 9 | 6 | 6 | 6 |
| 2 Ground primitives | 7 | 9 | 5 | 5 | 5 |
| 3 Lifted lattice | 4 | 7 | 6 | 9 | 3 |

Approach 2 flattens the smooth default into 32 bins and drapes lines only near the camera. Approach 3 floats 2–5 km over valleys and re-implements ion tile fetching.

## When it is active

`draped` is true when the installed terrain provider is not `EllipsoidTerrainProvider`, as reported by `ContextController.setTerrain`. If ion fails, the terrain stays smooth and nothing changes. Draped code is imported lazily, both on the main thread and in the worker.

## Per layer under World Terrain

| Layer | Treatment |
|---|---|
| Surface | `atlas-surface` imagery layer: barycentric fill for smooth modes (same fan as `buildSmoothChunk`), palette-bin H3 polygons for flat modes, honmoon contours from an analytic gradient |
| Support masks | Hatch and dots baked into the surface tiles (disjoint cells) |
| Cell edges | `atlas-outlines` layer: 1.5–2 texel lines, matched or fixed colour at α 0.92, drawn from level 3 |
| Borders | `atlas-borders` layer, α = countryOpacity |
| Sampling footprints | `atlas-footprints` layer, owned by the observation group and never in the surface texture |
| Observation symbols | `globe.getHeight(anchor)` + today's clearance (650 + 7,000 m), via a new `scene/ground-heights.ts` |
| Labels | `LabelCollection({scene})`, `RELATIVE_TO_GROUND`, 2,500 m |
| Highlight | Densified ring at ground height + 300 m, in a PolylineCollection |

**Provider and group.** `AtlasRasterImageryProvider` uses a geographic tiling scheme clipped to the data bounds, up to level 11. It asks the worker for each tile; empty tiles come back as a shared 1×1 transparent canvas, and the rest as transferred `ImageBitmap`s. `DrapedSurfaceGroup` implements the existing SurfaceChunkGroup/FadeableGroup contract, so ScientificLayers reuses its epochs, cache and `animateSwap`.

**Lighting under World Terrain.**
- `enableLighting` is on.
- With day/night off, Atlas uses a north-west directional light whose elevation goes from a headlight at 5,000 km and above to 45° at 500 km and below.
- `vertexShadowDarkness` 0.45 and `lambertDiffuseMultiplier` 0.9. Flat and sunward ground then shows the exact legend colour, because the diffuse term clamps at 1.0; only slopes facing away darken.
- With day/night on, the light is SunLight.
- The water effect and ground atmosphere are off while the surface is shown.

## How existing features behave

- **Palette, metric, geometry, support toggle.** A new layer is added at α 0; Cesium loads its tiles but does not draw them (GlobeSurfaceTileProvider.js:1094, :3004). Once `tilesLoaded` is true, or after a 3 s cap, the new layer cross-fades in on top while the outgoing layer stays opaque.
- **Opacity.** Layer α = 0.9 × opacity × fade, instant.
- **Edges toggle.** Instant, by setting the outlines layer to α 0; edges stay independent of surface opacity.
- **#449.** Unchanged (inspector only).
- **Reveal (#458).** A 1 s eased fade on the same RevealWave timeline. Reduced motion shows the data at once. The smooth globe keeps the radial wave.
- **Data elevation.** Forced to 0 by a new `resolveDrapedView`. The URL keeps the user's value, and the UI says "Not available with World Terrain".
- **Extruded.** Drawn as hexagons, labelled "Columns (smooth globe only)".
- **Globe offset.** Unchanged: imagery only adds textures to the patched globe shader, and picks use the patched `getPickRay`.
- **Worker.** Gains `prepare-raster` and `raster-tile` and keeps a borders copy; `load-detail` goes first; destroyed providers' requests are dropped.
- **Earth opacity and day/night.** Both also apply to the draped data.

## Exaggeration

- **Control.** URL param `terrainExaggeration`, range [1, 5], step 0.25, default 1. It is labelled "Terrain exaggeration", separate from the data `exaggeration` param, and shown only when draped. It sets `scene.verticalExaggeration` and requests a render.
- **What follows it.** Draped layers follow on the GPU. Labels re-clamp themselves. Ground heights re-sample every 50 ms during a drag and once at the end.
- **Smooth globe.** Switching to it resets exaggeration to 1, so Cesium's per-tile normal rebuild never runs there.

## Picking

Draped branch in `surface-pick.ts`:
1. `drillPick` runs as today, and observation hits win.
2. MORPHING returns null.
3. `globe.pick(camera.getPickRay(pos), scene)` hits the rendered, exaggerated mesh and returns WGS84 in every mode (Globe.js:823).
4. `latLngToCell` gives the row.
5. `drawn(row)`: supported rows need the surface layer, masked rows need support on, and surface α must be above 0.

The 650 m clearance and the translucent-depth pick are not used in this branch. The smooth globe keeps `pickEllipsoid`.

## 2D and Columbus

Imagery drapes natively in every mode and during morphs; Columbus view shows exaggerated relief and 2D is flat. The BufferPolylineCollection 3D-only limit no longer applies. The mode sequence (atlas-scene.ts:464-492) is unchanged, the draped group's `setSceneMode` is a no-op, and ground heights re-sample after `morphComplete`.

## Performance budget and measurement

**Smooth globe (asserted, unchanged):** surface visible ≤ 2.5 s desktop, ≤ 6 s mobile Fast 4G, ≤ 17.5 s slow profile; reveal ≤ 1.1 s; long frames ≤ 200 / 800 ms; warm switch < 2 s; ≥ 45 fps; Cesium gzip pin. New: atlas-bundle asserts the draped modules are absent from the /app/ initial chunks and the worker's first load.

**World Terrain** (new `atlas-terrain-performance.spec.ts`; report-only until phase 4, then asserted on hardware GPUs and skipped on SwiftShader):
- Data visible ≤ 2 s after the terrain switch, and restyles ≤ 2 s to `tilesLoaded`.
- ≥ 45 fps while orbiting; long frames ≤ 200 ms desktop and ≤ 800 ms mobile ×4.
- Raster p95 ≤ 2 ms per tile at level 3 and finer.
- Resident Atlas imagery ≤ 160 MiB desktop and ≤ 96 MiB on coarse pointers.

**Measured by** an e2e-only `__atlasDrapeStats` hook: tile counts (requested, delivered, empty), raster-time histogram, queue depth, and resident bytes (cached non-empty tiles × 349,525 B, from pinned ImageryLayer internals).

**Mobile fallbacks, in order:** lower `tileCacheSize`; merge outlines into the surface texture; cap borders at level 10.

## Failure modes

- ion missing or failing: keep the smooth globe, one-line warning (spec §14).
- Raster worker error or provider errorEvent: revert to the smooth globe with a warning; never silently empty tiles.
- `getHeight` undefined: the symbol keeps today's height until sampled (may pop once).
- First-draw shader compile hitch: pre-warm one frame at α 0.001.
- Cesium upgrade changes internals (α 0 skip, show=false frees tiles, numeric alpha, imagery cache): pinned tests fail.
- Polar and antimeridian cells: ±360° shifted copy, seam tests.
- ImageBitmap vs canvas row orientation: pinned by a unit test.

## Build phases

Each phase is one shippable PR; about 4–5 engineer-weeks in all.

1. **Harness, lighting and picking (3–4 days).** Synthetic-terrain fixture, the #483 repro spec marked `test.fail()`, the lighting policy, and `globe.pick` under terrain. Users get the hillshade and correct picks.
2. **Draped surface (8–10 days).** Rasteriser for fill, masks and outlines; grid index and worker handlers; provider and group; fade, swaps, `resolveDrapedView` and the pick branch. Honmoon shows its fill without contours; other layers keep today's heights. The repro spec passes from here.
3. **Context, observations and exaggeration (5 days).** Borders and footprint layers, labels, ground heights, the highlight, and the exaggeration slider with its URL param.
4. **Honmoon and hardening (4–5 days).** Contours, pre-warm, a mobile memory measurement, fallbacks if needed, and asserted terrain budgets.

## Test plan

**Vitest** (Node; Cesium-free except the pins):
- Rasteriser parity with `buildSmoothChunk`/`paletteBins` within 1 byte per texel centre; honmoon contour count per band.
- Coverage: on the full hbs-rs334 grid, every supported cell's centre texel at level 8 has its colour; one miss fails (never drop a row).
- Masks vs Grid/Dot formulas; gap-free seams and antimeridian; south-first rows; byte-identical repeats; empty → null.
- Provider (fake worker); DrapedSurfaceGroup (fake ImageryLayerCollection: α mapping, order, swap, destroy); ScientificLayers and surface-pick draped branches; `terrainExaggeration`; `resolveDrapedView`; ground heights; lighting blend.
- Cesium-internals pins.

**E2E** (Playwright, no ion). `window.__atlasTerrainFixture()` installs a `CustomHeightmapTerrainProvider` with a 6 km Gaussian peak under supported HbS cells, through `setTerrain`. It is imported dynamically inside the `PUBLIC_ATLAS_E2E_HOOKS` branch, so the production Cesium chunk, which does not contain it today, is unchanged; atlas-bundle asserts it stays out.
- **#483 repro.** The summit pixel shows the palette colour, not the basemap, at nadir and oblique, at exaggeration 1 and 3.
- **Pick.** An oblique pick on the slope returns the cell under the cursor.
- **Modes.** Data visible and picks working after each morph (globe → map → perspective → globe).
- **Swaps and toggles.** Swaps under 2 s; toggles instant; returning to the smooth globe restores wave, elevation and extruded.
- **Placement.** Spheres and labels above the summit.
- **Regression.** Smooth-globe cold-load, performance, mobile and pixel-diff specs unchanged.

The fixture has no vertex normals, so hillshade gets unit tests plus a manual ion run.

## Builder's calls

1. Approach 1, World Terrain only: draping always would double default GPU memory and tie cold-load budgets to Cesium's tile queue.
2. `draped` keys on "not EllipsoidTerrainProvider", so the fixture runs the real path.
3. Four separate layers: independent opacities and toggles; observations never share a texture with surfaces.
4. Outlines from level 3; coarser, a 1.5-texel line covers the whole cell.
5. 256 px tiles, maximum level 11 (~38 m per texel).
6. Fade instead of the radial wave; imagery has no per-fragment hook.
7. Data elevation off and extruded as hexagons; intent kept in the URL.
8. Honmoon contours deferred to phase 4.
9. Headlight-to-45° light blend, so no limb darkens at globe scale.
10. Atmosphere and water effect off while the surface shows.
11. Exaggeration [1, 5], default 1.
12. Raster lines: GroundPolylinePrimitive costs 1,456 B per segment and ignores exaggeration; draped BufferPolylineCollection is experimental, one colour per primitive, unverified in 2D/Columbus.
13. A raster failure reverts to the smooth globe.
14. Earth opacity and day/night dimming apply to draped data; accepted.

## Decided by the owner (2026-10-18)

- **Drape the data onto terrain** rather than float it or leave it buried: "Drape the data onto terrain".
- **Hillshade lighting whenever World Terrain is on**, independent of the clock. Day/night applies to the smooth globe.
- **Proceed in four shippable phases** ("Proceed with phased draping").
- **Reveal wave:** a 1 s fade replaces the radial wave under World Terrain ("Yes, fade under terrain"). The smooth globe keeps the wave.
- **Data elevation is off under World Terrain** ("Turn it off under terrain"). The user's setting stays in the URL and the UI explains why it is unavailable. Columns draw as flat hexagons.
- **Mobile:** if phones still miss the memory budget after the fallbacks, World Terrain may be desktop-only ("Yes, desktop-only if needed"), with a note explaining why it is off.

A further builder's call, settled after the review: **a cold load whose URL already says `terrain=world-terrain` drapes on the URL's word.** The draped pipeline is built directly; the smooth one is not built first and then swapped. If ion fails, the terrain reverts to the smooth globe with a warning and the smooth pipeline builds then (see Failure modes).

## Open questions for the owner

None open.
