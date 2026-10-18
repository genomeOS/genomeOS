/**
 * How physical terrain is shaded, for Atlas design §11, interaction design §5.2 and the terrain
 * draping design, "Per layer under World Terrain" (#483).
 *
 * The smooth globe keeps Cesium's real-time sun, lit only when day/night is on, exactly as before.
 * World Terrain is lit by a fixed hillshade light (`terrainLighting`, scene-policy.ts) from the
 * north-west of the view target: the ground drawn on the view axis, which on the desktop is the
 * centre of the open area beside the controls panel (`viewCentre`, globe-offset.ts). The light
 * follows the target: on each rendered frame whose camera moved, it is re-aimed in place, so it
 * costs nothing while the view is still and requests no frame of its own (the globe renders on
 * demand). From 500 km out it swings towards a headlight, the camera's line of sight, reached at
 * 5,000 km (`hillshadeHeadlightWeight`), so no limb darkens at globe scale. The same frame fades
 * the shading with the camera's height (`hillshadeShading`), so World Terrain seen from far out,
 * or as the whole-world 2D map, has no night side. While installed, the hillshade also sets the
 * globe's diffuse multiplier and turns off its ground atmosphere and water effect while a surface
 * layer shows (`surfaceShown`), restoring the globe's own values on the smooth globe; it never
 * turns on an effect the globe had off. Nothing here touches the scene until the first `update`,
 * and the smooth globe never subscribes to a frame event and writes only `enableLighting`.
 *
 * Relief (`scene.verticalExaggeration`) raises the ground only where there is physical relief to
 * raise and the view is not the flat 2D map (`effectiveRelief`). It is a different control from
 * the data's elevation, which scales the scientific layers and never the ground. A relief change
 * also empties the terrain tiles' caches of ground positions (`forgetClampedGround`), so what
 * Cesium clamps to the ground, the country labels, follows the relief ("Exaggeration", #483).
 */

import {
  Cartesian2,
  Cartesian3,
  DirectionalLight,
  Ellipsoid,
  Math as CesiumMath,
  SceneMode,
  type Cartographic,
  type Light,
} from 'cesium';

import { effectiveRelief } from '../earth-style-catalog';
import type { ExplorerSceneMode, TerrainId } from '../url-state';
import { viewCentre } from './globe-offset';
import {
  HILLSHADE_AZIMUTH_DEGREES,
  HILLSHADE_DIFFUSE_MULTIPLIER,
  HILLSHADE_INTENSITY,
  hillshadeDirection,
  hillshadeElevationDegrees,
  hillshadeHeadlightWeight,
  hillshadeShading,
  terrainLighting,
} from './scene-policy';

/** The parts of a Cesium Scene the shading reads and writes. */
export interface ShadingScene {
  light: Light;
  /** Only in 3D is the camera's direction Earth-fixed, as a light's is in every mode. */
  readonly mode: SceneMode;
  globe: {
    enableLighting: boolean;
    dynamicAtmosphereLightingFromSun: boolean;
    vertexShadowDarkness: number;
    lambertDiffuseMultiplier: number;
    showGroundAtmosphere: boolean;
    showWaterEffect: boolean;
  };
  camera: {
    /** A shifted frustum draws the view axis right of the canvas centre (globe-offset.ts). */
    readonly frustum?: unknown;
    readonly positionCartographic: Cartographic;
    readonly positionWC: Cartesian3;
    readonly directionWC: Cartesian3;
    pickEllipsoid(
      windowPosition: Cartesian2,
      ellipsoid?: Ellipsoid,
      result?: Cartesian3,
    ): Cartesian3 | undefined;
  };
  canvas: { clientWidth: number; clientHeight: number };
  preRender: { addEventListener(listener: () => void): () => void };
  verticalExaggeration: number;
  verticalExaggerationRelativeHeight: number;
  requestRender(): void;
}

export interface TerrainPresentation {
  /** The terrain on the globe: the one the context controller applied, not merely requested. */
  terrain: TerrainId;
  dayNight: boolean;
  /** The chosen vertical exaggeration of the relief (the `relief` URL parameter). */
  relief: number;
  mode: ExplorerSceneMode;
  /** Whether the surface or support layer is shown; their ground carries no atmosphere or water. */
  surfaceShown: boolean;
}

interface Hillshade {
  light: DirectionalLight;
  /** What the hillshade replaced, restored when the globe is smooth again. */
  sun: Light;
  fromSun: boolean;
  shadowDarkness: number;
  diffuse: number;
  /** Whether the globe had each effect on; the hillshade never turns on one that was off. */
  groundAtmosphere: boolean;
  waterEffect: boolean;
  removeFollow: () => void;
  /**
   * The camera the light was last aimed from; undefined forces the next aim. The height counts
   * apart from the position: a 2D zoom changes only the width of the map, which Cesium reports
   * as the camera's height.
   */
  position: Cartesian3 | undefined;
  direction: Cartesian3 | undefined;
  height: number | undefined;
}

/**
 * The loaded terrain tiles, reached through Cesium 1.145's private quadtree (Globe.js `_surface`),
 * which its typings leave out; pinned in atlas-cesium-internals.test.ts.
 */
interface LoadedTerrainTiles {
  _surface: {
    forEachLoadedTile(
      visit: (tile: { clearPositionCache(): void }) => void,
    ): void;
  };
}

/**
 * Empties each loaded terrain tile's cache of ground positions. In the frame that re-exaggerates
 * the tiles, Cesium re-clamps whatever is clamped to the ground, the country labels among them, but
 * takes each position from that cache when it holds one (QuadtreePrimitive.js:1449-1456), picked
 * at the old relief, and the re-exaggeration leaves the cache alone (GlobeSurfaceTile.js:415-466):
 * the labels would stay on the old ground. Emptied with the change, the re-clamp picks the new one.
 */
function forgetClampedGround(globe: ShadingScene['globe']): void {
  (globe as unknown as LoadedTerrainTiles)._surface.forEachLoadedTile((tile) =>
    tile.clearPositionCache(),
  );
}

const scratchCentre = new Cartesian2();
const scratchTarget = new Cartesian3();
const scratchHead = new Cartesian3();
const scratchAim = new Cartesian3();

export class TerrainShading {
  readonly #scene: ShadingScene;
  #presentation: TerrainPresentation = {
    dayNight: true,
    mode: 'globe',
    relief: 1,
    surfaceShown: true,
    terrain: 'smooth-globe',
  };
  #hillshade: Hillshade | null = null;
  #destroyed = false;

  constructor(scene: ShadingScene) {
    this.#scene = scene;
  }

  update(change: Partial<TerrainPresentation>): void {
    if (this.#destroyed) return;
    this.#presentation = { ...this.#presentation, ...change };
    const lighting = terrainLighting(this.#presentation);
    if (lighting.light === 'hillshade') {
      // The hillshade's own frame sets the lighting, by the camera's height (#follow).
      const hillshade = this.#installHillshade();
      const globe = this.#scene.globe;
      globe.showGroundAtmosphere =
        lighting.groundAtmosphere && hillshade.groundAtmosphere;
      globe.showWaterEffect = lighting.waterEffect && hillshade.waterEffect;
    } else {
      this.#removeHillshade();
      this.#scene.globe.enableLighting = lighting.enableLighting;
    }
    const { mode, relief, terrain } = this.#presentation;
    const exaggeration = effectiveRelief({ relief, terrain, view: mode });
    if (this.#scene.verticalExaggeration !== exaggeration) {
      // Heights are exaggerated from sea level, as in Cesium's vertical-exaggeration example.
      this.#scene.verticalExaggeration = exaggeration;
      this.#scene.verticalExaggerationRelativeHeight = 0;
      forgetClampedGround(this.#scene.globe);
    }
    this.#scene.requestRender();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#hillshade?.removeFollow();
    this.#hillshade = null;
  }

  #installHillshade(): Hillshade {
    if (this.#hillshade) return this.#hillshade;
    const scene = this.#scene;
    const hillshade: Hillshade = {
      diffuse: scene.globe.lambertDiffuseMultiplier,
      direction: undefined,
      fromSun: scene.globe.dynamicAtmosphereLightingFromSun,
      groundAtmosphere: scene.globe.showGroundAtmosphere,
      height: undefined,
      light: new DirectionalLight({
        // Replaced by the first aim, below; Cesium refuses a zero direction.
        direction: Cartesian3.UNIT_Z,
        intensity: HILLSHADE_INTENSITY,
      }),
      position: undefined,
      removeFollow: scene.preRender.addEventListener(() => this.#follow()),
      shadowDarkness: scene.globe.vertexShadowDarkness,
      sun: scene.light,
      waterEffect: scene.globe.showWaterEffect,
    };
    this.#hillshade = hillshade;
    scene.light = hillshade.light;
    // The atmosphere follows the scene's light, not the sun, so it too ignores the clock.
    scene.globe.dynamicAtmosphereLightingFromSun = false;
    scene.globe.lambertDiffuseMultiplier = HILLSHADE_DIFFUSE_MULTIPLIER;
    this.#follow();
    return hillshade;
  }

  #removeHillshade(): void {
    const hillshade = this.#hillshade;
    if (!hillshade) return;
    hillshade.removeFollow();
    this.#scene.light = hillshade.sun;
    const globe = this.#scene.globe;
    globe.dynamicAtmosphereLightingFromSun = hillshade.fromSun;
    globe.vertexShadowDarkness = hillshade.shadowDarkness;
    globe.lambertDiffuseMultiplier = hillshade.diffuse;
    globe.showGroundAtmosphere = hillshade.groundAtmosphere;
    globe.showWaterEffect = hillshade.waterEffect;
    this.#hillshade = null;
  }

  /**
   * Re-aims the light and re-fades the shading when the camera moved since the last aim;
   * otherwise does nothing. A frame with no finite aim (mid-morph) keeps the last one.
   */
  #follow(): void {
    const hillshade = this.#hillshade;
    if (!hillshade) return;
    const scene = this.#scene;
    const camera = scene.camera;
    const height = camera.positionCartographic.height;
    if (
      hillshade.position &&
      hillshade.direction &&
      hillshade.height === height &&
      Cartesian3.equals(hillshade.position, camera.positionWC) &&
      Cartesian3.equals(hillshade.direction, camera.directionWC)
    )
      return;
    hillshade.position = Cartesian3.clone(
      camera.positionWC,
      hillshade.position,
    );
    hillshade.direction = Cartesian3.clone(
      camera.directionWC,
      hillshade.direction,
    );
    hillshade.height = height;
    const shading = hillshadeShading(height);
    scene.globe.enableLighting = shading.enableLighting;
    scene.globe.vertexShadowDarkness = shading.shadowDarkness;
    const centre = camera.pickEllipsoid(
      viewCentre(scene, scratchCentre),
      Ellipsoid.WGS84,
      scratchTarget,
    );
    // The view target; a view that misses the Earth falls back to the point under the camera.
    const target =
      (centre && Ellipsoid.WGS84.cartesianToCartographic(centre)) ??
      camera.positionCartographic;
    const lon = CesiumMath.toDegrees(target.longitude);
    const lat = CesiumMath.toDegrees(target.latitude);
    const [x, y, z] = hillshadeDirection(
      lon,
      lat,
      HILLSHADE_AZIMUTH_DEGREES,
      hillshadeElevationDegrees(height),
    );
    const weight = hillshadeHeadlightWeight(height);
    // Light directions are Earth-fixed in every mode (UniformState.js:1517-1526); the camera's
    // only in 3D (Camera.js:700-713), so 2D and Columbus view swing towards overhead at the
    // target instead.
    const head =
      scene.mode === SceneMode.SCENE3D
        ? camera.directionWC
        : Cartesian3.fromArray(
            hillshadeDirection(lon, lat, HILLSHADE_AZIMUTH_DEGREES, 90),
            0,
            scratchHead,
          );
    const aim =
      weight >= 1
        ? Cartesian3.clone(head, scratchAim)
        : Cartesian3.fromElements(
            x + weight * (head.x - x),
            y + weight * (head.y - y),
            z + weight * (head.z - z),
            scratchAim,
          );
    // Checked before normalising: Cesium's debug build throws on a result that is not a number.
    if (![aim.x, aim.y, aim.z].every(Number.isFinite)) return;
    // A line of sight exactly opposite the hillshade cancels it: keep the hillshade.
    if (Cartesian3.magnitudeSquared(aim) < 1e-12)
      Cartesian3.fromElements(x, y, z, aim);
    Cartesian3.normalize(aim, hillshade.light.direction);
  }
}
