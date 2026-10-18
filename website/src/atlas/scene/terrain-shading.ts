/**
 * How physical terrain is shaded, for Atlas design §11 and interaction design §5.2 (#483).
 *
 * The smooth globe keeps Cesium's real-time sun, lit only when day/night is on, exactly as before.
 * World Terrain is lit by a fixed hillshade light (`terrainLighting`, scene-policy.ts) from the
 * north-west of the view target: the ground drawn on the view axis, which on the desktop is the
 * centre of the open area beside the controls panel (`viewCentre`, globe-offset.ts). The light
 * follows the target: on each rendered frame whose camera moved, it is re-aimed in place, so it
 * costs nothing while the view is still and requests no frame of its own (the globe renders on
 * demand). The same frame fades the shading with the camera's height (`hillshadeShading`), so
 * World Terrain seen from far out, or as the whole-world 2D map, has no night side. Nothing here
 * touches the scene until the first `update`, and the smooth globe never subscribes to a frame
 * event.
 *
 * Relief (`scene.verticalExaggeration`) raises the ground only where there is physical relief to
 * raise and the view is not the flat 2D map (`effectiveRelief`). It is a different control from
 * the data's elevation, which scales the scientific layers and never the ground.
 */

import {
  Cartesian2,
  Cartesian3,
  DirectionalLight,
  Ellipsoid,
  Math as CesiumMath,
  type Cartographic,
  type Light,
} from 'cesium';

import { effectiveRelief } from '../earth-style-catalog';
import type { ExplorerSceneMode, TerrainId } from '../url-state';
import { viewCentre } from './globe-offset';
import {
  HILLSHADE_AZIMUTH_DEGREES,
  HILLSHADE_INTENSITY,
  hillshadeDirection,
  hillshadeElevationDegrees,
  hillshadeShading,
  terrainLighting,
} from './scene-policy';

/** The parts of a Cesium Scene the shading reads and writes. */
export interface ShadingScene {
  light: Light;
  globe: {
    enableLighting: boolean;
    dynamicAtmosphereLightingFromSun: boolean;
    vertexShadowDarkness: number;
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
}

interface Hillshade {
  light: DirectionalLight;
  /** What the hillshade replaced, restored when the globe is smooth again. */
  sun: Light;
  fromSun: boolean;
  shadowDarkness: number;
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

const scratchCentre = new Cartesian2();
const scratchTarget = new Cartesian3();

export class TerrainShading {
  readonly #scene: ShadingScene;
  #presentation: TerrainPresentation = {
    dayNight: true,
    mode: 'globe',
    relief: 1,
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
    // The hillshade's own frame sets the lighting, by the camera's height (#follow).
    if (lighting.light === 'hillshade') this.#installHillshade();
    else {
      this.#removeHillshade();
      this.#scene.globe.enableLighting = lighting.enableLighting;
    }
    const { mode, relief, terrain } = this.#presentation;
    const exaggeration = effectiveRelief({ relief, terrain, view: mode });
    if (this.#scene.verticalExaggeration !== exaggeration) {
      // Heights are exaggerated from sea level, as in Cesium's vertical-exaggeration example.
      this.#scene.verticalExaggeration = exaggeration;
      this.#scene.verticalExaggerationRelativeHeight = 0;
    }
    this.#scene.requestRender();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#hillshade?.removeFollow();
    this.#hillshade = null;
  }

  #installHillshade(): void {
    if (this.#hillshade) return;
    const scene = this.#scene;
    const hillshade: Hillshade = {
      direction: undefined,
      fromSun: scene.globe.dynamicAtmosphereLightingFromSun,
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
    };
    this.#hillshade = hillshade;
    scene.light = hillshade.light;
    // The atmosphere follows the scene's light, not the sun, so it too ignores the clock.
    scene.globe.dynamicAtmosphereLightingFromSun = false;
    this.#follow();
  }

  #removeHillshade(): void {
    const hillshade = this.#hillshade;
    if (!hillshade) return;
    hillshade.removeFollow();
    this.#scene.light = hillshade.sun;
    this.#scene.globe.dynamicAtmosphereLightingFromSun = hillshade.fromSun;
    this.#scene.globe.vertexShadowDarkness = hillshade.shadowDarkness;
    this.#hillshade = null;
  }

  /**
   * Re-aims the light and re-fades the shading when the camera moved since the last aim;
   * otherwise does nothing.
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
    const [x, y, z] = hillshadeDirection(
      CesiumMath.toDegrees(target.longitude),
      CesiumMath.toDegrees(target.latitude),
      HILLSHADE_AZIMUTH_DEGREES,
      hillshadeElevationDegrees(height),
    );
    Cartesian3.fromElements(x, y, z, hillshade.light.direction);
  }
}
