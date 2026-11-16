/**
 * Measures the log depth Cesium's ray-cast ellipsoid writes from the near plane, so the observation
 * spheres are never lost behind World Terrain (terrain draping design, "Goals": "Symbols and labels
 * are never buried"; "Test plan": "Placement. Spheres and labels above the summit"; #483).
 *
 * The Atlas draws spheres with Cesium's `EllipsoidPrimitive` (scene/observation-layer.ts), whose
 * fragment shader writes `czm_writeLogDepth(1.0 + positionCC.w)` (Cesium 1.145, @cesium/engine
 * 26.3.0: Shaders/EllipsoidFS.glsl:94). `czm_writeLogDepth` takes a depth "where 1.0 is on the near
 * plane" (Builtin/Functions/writeLogDepth.glsl:19), and every other caller subtracts the near plane
 * first: `(w - czm_currentFrustum.x) + 1.0` (Builtin/Functions/vertexLogDepth.glsl:39 and :61,
 * BillboardCollectionFS.glsl:117). So a sphere's depth lies one near-plane distance behind it.
 * Cesium puts the near plane at the nearest command's bounding plane, at least 0.1 m off. On the
 * smooth globe and in oblique views it is 0.1 m, too little to matter. Looking straight down under
 * World Terrain, though, the globe-sized label collection sets it 42 to 242 km out, past the 31.65 km
 * from a 12 km sphere's top to the ground under it, and with `depthTestAgainstTerrain` the terrain
 * wins the depth test: the sphere is neither drawn nor picked (the colour and pick programs share
 * this shader).
 *
 * This plugin rewrites that one line as its siblings write it, in the build (`vite.plugins`) and in
 * the dev server's pre-bundled `cesium` (`optimizeDeps.rolldownOptions.plugins`). It throws unless
 * the uncorrected line appears exactly once, so a Cesium upgrade that fixes or moves it fails the
 * build loudly: delete the plugin then. tests/atlas-cesium-ellipsoid-depth.test.ts checks the bundle.
 */

/** Cesium's ray-cast ellipsoid fragment shader, as an ES module (any OS's path separator). */
const ELLIPSOID_FS =
  /@cesium[\\/]engine[\\/]Source[\\/]Shaders[\\/]EllipsoidFS\.js$/;
const UNCORRECTED = 'czm_writeLogDepth(1.0 + positionCC.w);';
const CORRECTED =
  'czm_writeLogDepth(1.0 + positionCC.w - czm_currentFrustum.x);';

/**
 * EllipsoidFS.js with its log-depth write measured from the near plane.
 * @param {string} code the module's source
 * @returns {string} the corrected source
 */
function correctEllipsoidLogDepth(code) {
  const found = code.split(UNCORRECTED).length - 1;
  if (found !== 1)
    throw new Error(
      `cesium-ellipsoid-log-depth: "${UNCORRECTED}" found ${found} times, expected exactly once in @cesium/engine's EllipsoidFS.js. If a Cesium upgrade fixed the ellipsoid's log depth, delete integrations/cesium-ellipsoid-log-depth.mjs and its registrations in astro.config.mjs; otherwise update the anchor.`,
    );
  return code.replace(UNCORRECTED, CORRECTED);
}

/**
 * The Vite and Rolldown plugin.
 * @returns {{ name: string, transform: (code: string, id: string) => { code: string, map: null } | null }}
 */
export default function cesiumEllipsoidLogDepth() {
  return {
    name: 'genomeos-cesium-ellipsoid-log-depth',
    transform(code, id) {
      if (!ELLIPSOID_FS.test(id.split('?')[0])) return null;
      return { code: correctEllipsoidLogDepth(code), map: null };
    },
  };
}
