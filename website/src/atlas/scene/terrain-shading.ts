/**
 * How physical terrain is shaded, for Atlas design §11 and interaction design §5.2 (#483).
 *
 * The smooth globe keeps Cesium's real-time sun, lit only when day/night is on, exactly as before.
 * World Terrain is lit by a fixed hillshade light (`terrainLighting`, scene-policy.ts) from the
 * north-west of the view target. The light follows the target: on each rendered frame whose camera
 * moved, it is re-aimed in place, so it costs nothing while the view is still and requests no
 * frame of its own (the globe renders on demand). Nothing here touches the scene until the first
 * `update`, and the smooth globe never subscribes to a frame event.
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

import type { TerrainId } from '../url-state';
import {
  HILLSHADE_AZIMUTH_DEGREES,
  HILLSHADE_INTENSITY,
  hillshadeDirection,
  hillshadeElevationDegrees,
  terrainLighting,
} from './scene-policy';

/** The parts of a Cesium Scene the shading reads and writes. */
export interface ShadingScene {
  light: Light;
  globe: { enableLighting: boolean; dynamicAtmosphereLightingFromSun: boolean };
  camera: {
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
  requestRender(): void;
}

export interface TerrainPresentation {
  /** The terrain on the globe: the one the context controller applied, not merely requested. */
  terrain: TerrainId;
  dayNight: boolean;
}

interface Hillshade {
  light: DirectionalLight;
  /** What the hillshade replaced, restored when the globe is smooth again. */
  sun: Light;
  fromSun: boolean;
  removeFollow: () => void;
  /** The camera the light was last aimed from; undefined forces the next aim. */
  position: Cartesian3 | undefined;
  direction: Cartesian3 | undefined;
}

const scratchCentre = new Cartesian2();
const scratchTarget = new Cartesian3();

export class TerrainShading {
  readonly #scene: ShadingScene;
  #presentation: TerrainPresentation = {
    dayNight: true,
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
    if (lighting.light === 'hillshade') this.#installHillshade();
    else this.#removeHillshade();
    this.#scene.globe.enableLighting = lighting.enableLighting;
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
      light: new DirectionalLight({
        // Replaced by the first aim, below; Cesium refuses a zero direction.
        direction: Cartesian3.UNIT_Z,
        intensity: HILLSHADE_INTENSITY,
      }),
      position: undefined,
      removeFollow: scene.preRender.addEventListener(() => this.#follow()),
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
    this.#hillshade = null;
  }

  /** Re-aims the light when the camera moved since the last aim; otherwise does nothing. */
  #follow(): void {
    const hillshade = this.#hillshade;
    if (!hillshade) return;
    const camera = this.#scene.camera;
    if (
      hillshade.position &&
      hillshade.direction &&
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
    const { clientHeight, clientWidth } = this.#scene.canvas;
    const centre = camera.pickEllipsoid(
      Cartesian2.fromElements(clientWidth / 2, clientHeight / 2, scratchCentre),
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
      hillshadeElevationDegrees(camera.positionCartographic.height),
    );
    Cartesian3.fromElements(x, y, z, hillshade.light.direction);
  }
}
