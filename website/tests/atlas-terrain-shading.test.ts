/** Physical-terrain shading: the hillshade light policy and its scene controller (Atlas design
 * §11, interaction design §5.2; #483). */
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  DirectionalLight,
  Ellipsoid,
  SceneMode,
  SunLight,
} from 'cesium';
import { describe, expect, it, vi } from 'vitest';

import { ShiftedPerspectiveFrustum } from '../src/atlas/scene/globe-offset';
import {
  HILLSHADE_AZIMUTH_DEGREES,
  HILLSHADE_DIFFUSE_MULTIPLIER,
  HILLSHADE_ELEVATION_DEGREES,
  HILLSHADE_FADE_METRES,
  HILLSHADE_HEADLIGHT_METRES,
  HILLSHADE_SHADOW_DARKNESS,
  hillshadeDirection,
  hillshadeElevationDegrees,
  hillshadeHeadlightWeight,
  hillshadeShading,
  terrainLighting,
} from '../src/atlas/scene/scene-policy';
import { TerrainShading } from '../src/atlas/scene/terrain-shading';
import { FakeEvent } from './helpers/scene-fakes';

const DEGREE = Math.PI / 180;

function up(lon: number, lat: number): number[] {
  return [
    Math.cos(lat * DEGREE) * Math.cos(lon * DEGREE),
    Math.cos(lat * DEGREE) * Math.sin(lon * DEGREE),
    Math.sin(lat * DEGREE),
  ];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

/** The visible disc's angular radius, seen from `height` metres above a sphere of Earth's radius. */
function horizonDegrees(height: number): number {
  const radius = Ellipsoid.WGS84.maximumRadius;
  return Math.acos(radius / (radius + height)) / DEGREE;
}

describe('terrainLighting (draping design)', () => {
  it('lights World Terrain with the hillshade, without atmosphere or water while the surface shows', () => {
    for (const dayNight of [true, false])
      expect(
        terrainLighting({
          dayNight,
          surfaceShown: true,
          terrain: 'world-terrain',
        }),
      ).toEqual({
        enableLighting: true,
        groundAtmosphere: false,
        light: 'hillshade',
        waterEffect: false,
      });
  });

  it('allows the atmosphere and water on World Terrain while no surface shows', () => {
    expect(
      terrainLighting({
        dayNight: true,
        surfaceShown: false,
        terrain: 'world-terrain',
      }),
    ).toEqual({
      enableLighting: true,
      groundAtmosphere: true,
      light: 'hillshade',
      waterEffect: true,
    });
  });

  it('keeps the smooth globe on the real-time sun, lit only when day/night is on', () => {
    for (const surfaceShown of [true, false])
      for (const dayNight of [true, false])
        expect(
          terrainLighting({ dayNight, surfaceShown, terrain: 'smooth-globe' }),
        ).toEqual({
          enableLighting: dayNight,
          groundAtmosphere: true,
          light: 'sun',
          waterEffect: true,
        });
  });
});

describe('hillshadeHeadlightWeight', () => {
  it('is 0 up to 500 km, 1 from 5,000 km (and mid-morph), linear between', () => {
    expect(HILLSHADE_HEADLIGHT_METRES).toEqual([500_000, 5_000_000]);
    for (const h of [-50, 0, 200_000, 500_000])
      expect(hillshadeHeadlightWeight(h)).toBe(0);
    expect(hillshadeHeadlightWeight(2_750_000)).toBeCloseTo(0.5, 12);
    for (const h of [5_000_000, 1.65e7, 1.9e7, Number.NaN])
      expect(hillshadeHeadlightWeight(h)).toBe(1);
  });
});

describe('hillshadeDirection', () => {
  it('shines from the north-west, 45° above the horizon at the target', () => {
    expect(HILLSHADE_AZIMUTH_DEGREES).toBe(315);
    expect(HILLSHADE_ELEVATION_DEGREES).toBe(45);
    for (const [lon, lat] of [
      [0, 0],
      [86.9, 27.98],
      [38.75, 9.03],
      [-70, -33],
    ]) {
      const direction = hillshadeDirection(lon, lat, 315, 45);
      expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
      // The light travels downward at the elevation angle...
      expect(-dot(direction, up(lon, lat))).toBeCloseTo(Math.sin(45 * DEGREE));
      // ...towards the south-east: east and south in equal parts.
      const east = [-Math.sin(lon * DEGREE), Math.cos(lon * DEGREE), 0];
      const north = [
        -Math.sin(lat * DEGREE) * Math.cos(lon * DEGREE),
        -Math.sin(lat * DEGREE) * Math.sin(lon * DEGREE),
        Math.cos(lat * DEGREE),
      ];
      expect(dot(direction, east)).toBeGreaterThan(0);
      expect(dot(direction, north)).toBeCloseTo(-dot(direction, east));
    }
  });

  it('points straight down at an elevation of 90°', () => {
    const direction = hillshadeDirection(20, 12, 315, 90);
    expect(dot(direction, up(20, 12))).toBeCloseTo(-1, 12);
  });
});

describe('hillshadeElevationDegrees', () => {
  it('holds 45° wherever relief is visible', () => {
    for (const height of [0, 1_000, 17_000, 200_000, 500_000, 1_000_000])
      expect(hillshadeElevationDegrees(height)).toBe(45);
  });

  it('rises with the horizon so the light never sets inside the visible disc', () => {
    let previous = 45;
    for (const height of [1e6, 2e6, 5e6, 1e7, 1.65e7, 1e8]) {
      const elevation = hillshadeElevationDegrees(height);
      expect(elevation).toBeGreaterThanOrEqual(previous);
      expect(elevation).toBeGreaterThan(horizonDegrees(height));
      expect(elevation).toBeLessThanOrEqual(90);
      previous = elevation;
    }
  });
});

describe('hillshadeShading (#483 review: no fake night from far out)', () => {
  it('shades fully up to 1,000 km, with shadow darkness 0.45', () => {
    expect(HILLSHADE_FADE_METRES).toEqual([1_000_000, 3_000_000]);
    expect(HILLSHADE_SHADOW_DARKNESS).toBe(0.45);
    for (const height of [-50, 0, 1_000, 17_000, 200_000, 1_000_000])
      expect(hillshadeShading(height)).toEqual({
        enableLighting: true,
        shadowDarkness: 0.45,
      });
  });

  it('fades the shading out between 1,000 and 3,000 km', () => {
    let previous = 0.45;
    for (const height of [1.5e6, 2e6, 2.5e6, 2.999e6]) {
      const { enableLighting, shadowDarkness } = hillshadeShading(height);
      expect(enableLighting).toBe(true);
      expect(shadowDarkness).toBeGreaterThan(previous);
      expect(shadowDarkness).toBeLessThan(1);
      previous = shadowDarkness;
    }
    expect(hillshadeShading(2e6).shadowDarkness).toBeCloseTo(0.725, 12);
  });

  it('draws World Terrain unlit from 3,000 km out, the whole-world 2D map included', () => {
    // 1.65e7: the desktop home view. 1.9e7: Cesium's 2D camera height is the width of the map
    // shown, about 19,000 km for the whole-world map.
    for (const height of [3e6, 1.65e7, 1.9e7, Number.NaN])
      expect(hillshadeShading(height)).toEqual({
        enableLighting: false,
        shadowDarkness: 1,
      });
  });
});

function fakeScene(target = { lat: 27.98, lon: 86.9 }, height = 200_000) {
  const sun = new SunLight();
  const preRender = new FakeEvent();
  const camera = {
    /** Mutable: tests aim the line of sight. */
    directionWC: new Cartesian3(0, 0, -1) as Cartesian3,
    frustum: undefined as unknown,
    pickEllipsoid: vi.fn((_window: Cartesian2) =>
      Cartesian3.fromDegrees(target.lon, target.lat, 0),
    ),
    positionCartographic: Cartographic.fromDegrees(
      target.lon,
      target.lat,
      height,
    ),
    positionWC: Cartesian3.fromDegrees(target.lon, target.lat, height),
  };
  const scene = {
    camera,
    canvas: { clientHeight: 600, clientWidth: 800 },
    globe: {
      dynamicAtmosphereLightingFromSun: false,
      enableLighting: true,
      lambertDiffuseMultiplier: 0.9,
      showGroundAtmosphere: true,
      showWaterEffect: true,
      vertexShadowDarkness: 0.3,
    },
    light: sun as SunLight | DirectionalLight,
    mode: SceneMode.SCENE3D as SceneMode,
    preRender,
    requestRender: vi.fn(),
    verticalExaggeration: 1,
    verticalExaggerationRelativeHeight: 0,
  };
  /** Moves the camera, as a frame of user input would, and runs that frame's preRender. */
  const moveTo = (lon: number, lat: number, toHeight = height) => {
    target.lon = lon;
    target.lat = lat;
    camera.positionCartographic = Cartographic.fromDegrees(lon, lat, toHeight);
    camera.positionWC = Cartesian3.fromDegrees(lon, lat, toHeight);
    preRender.raiseEvent();
  };
  return { camera, moveTo, preRender, scene, sun };
}

function expectDirection(
  light: SunLight | DirectionalLight,
  lon: number,
  lat: number,
  elevation = 45,
) {
  expect(light).toBeInstanceOf(DirectionalLight);
  const expected = hillshadeDirection(lon, lat, 315, elevation);
  const { x, y, z } = (light as DirectionalLight).direction;
  expect(x).toBeCloseTo(expected[0], 9);
  expect(y).toBeCloseTo(expected[1], 9);
  expect(z).toBeCloseTo(expected[2], 9);
}

function expectVector(actual: Cartesian3, expected: Cartesian3) {
  for (const axis of ['x', 'y', 'z'] as const)
    expect(actual[axis]).toBeCloseTo(expected[axis], 9);
}

/** Straight down at `lon`, `lat`: a nadir camera's line of sight. */
const down = (lon: number, lat: number) =>
  Cartesian3.fromArray(up(lon, lat).map((v) => -v));

describe('TerrainShading lighting', () => {
  it('touches nothing until it is told the presentation', () => {
    const { preRender, scene, sun } = fakeScene();
    new TerrainShading(scene);
    expect(scene.light).toBe(sun);
    expect(scene.globe.enableLighting).toBe(true);
    expect(preRender.numberOfListeners).toBe(0);
  });

  it('applies day/night to the smooth globe exactly as before', () => {
    const { preRender, scene, sun } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ dayNight: false });
    expect(scene.globe.enableLighting).toBe(false);
    expect(scene.light).toBe(sun);
    shading.update({ dayNight: true });
    expect(scene.globe.enableLighting).toBe(true);
    expect(scene.light).toBe(sun);
    expect(preRender.numberOfListeners).toBe(0);
    expect(scene.requestRender).toHaveBeenCalled();
  });

  it('switches World Terrain to a fixed north-west light at the view target', () => {
    const { preRender, scene } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ dayNight: false, terrain: 'world-terrain' });
    expect(scene.globe.enableLighting).toBe(true);
    expect(scene.globe.dynamicAtmosphereLightingFromSun).toBe(false);
    expectDirection(scene.light, 86.9, 27.98);
    expect((scene.light as DirectionalLight).intensity).toBeGreaterThan(1);
    expect(preRender.numberOfListeners).toBe(1);
  });

  it('re-aims the light as the view moves, once per moved frame', () => {
    const { camera, moveTo, preRender, scene } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ terrain: 'world-terrain' });
    const picks = camera.pickEllipsoid.mock.calls.length;
    preRender.raiseEvent();
    preRender.raiseEvent();
    // An unmoved camera keeps the light: no pick, no new direction.
    expect(camera.pickEllipsoid.mock.calls.length).toBe(picks);

    moveTo(38.75, 9.03);
    expectDirection(scene.light, 38.75, 9.03);
    expect(camera.pickEllipsoid.mock.calls.length).toBe(picks + 1);
    // The light stays one object: the frame being drawn reads the new direction.
    const light = scene.light;
    moveTo(-70, -33, 16_500_000);
    expect(scene.light).toBe(light);
    // From 5,000 km out the light is the line of sight (draping design).
    expectVector(
      (scene.light as DirectionalLight).direction,
      camera.directionWC,
    );
  });

  it('aims at the ground drawn on the view axis, beside the controls panel (#452)', () => {
    const { camera, moveTo, scene } = fakeScene();
    // The desktop globe is drawn shifted right of the canvas centre, by an eighth of 800 px.
    const frustum = new ShiftedPerspectiveFrustum();
    frustum.projectionShift = 0.25;
    camera.frustum = frustum;
    new TerrainShading(scene).update({ terrain: 'world-terrain' });
    moveTo(38.75, 9.03);
    const [centre] = camera.pickEllipsoid.mock.lastCall!;
    expect(centre.x).toBe(500);
    expect(centre.y).toBe(300);
  });

  it('fades the hillshade with height, and draws World Terrain unlit from far out', () => {
    const { moveTo, scene } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ dayNight: true, terrain: 'world-terrain' });
    expect(scene.globe.enableLighting).toBe(true);
    expect(scene.globe.vertexShadowDarkness).toBe(0.45);
    const light = scene.light;

    moveTo(86.9, 27.98, 2_000_000);
    expect(scene.globe.enableLighting).toBe(true);
    expect(scene.globe.vertexShadowDarkness).toBeCloseTo(0.725, 12);

    // The home view: no light-facing side, so no night the user cannot switch off.
    moveTo(40, 10, 16_500_000);
    expect(scene.globe.enableLighting).toBe(false);
    expect(scene.globe.vertexShadowDarkness).toBe(1);
    // Still World Terrain's light, not the sun: day/night does not apply to it.
    expect(scene.light).toBe(light);
    shading.update({ dayNight: true });
    expect(scene.globe.enableLighting).toBe(false);

    moveTo(86.9, 27.98, 200_000);
    expect(scene.globe.enableLighting).toBe(true);
    expect(scene.globe.vertexShadowDarkness).toBe(0.45);
  });

  it('follows a 2D zoom, which changes the camera height but not its position', () => {
    const { camera, preRender, scene } = fakeScene();
    new TerrainShading(scene).update({ mode: 'map', terrain: 'world-terrain' });
    expect(scene.globe.enableLighting).toBe(true);
    // In 2D Cesium reports the width of the map shown as the camera height.
    camera.positionCartographic = Cartographic.fromDegrees(86.9, 27.98, 1.9e7);
    preRender.raiseEvent();
    expect(scene.globe.enableLighting).toBe(false);
  });

  it('falls back to the point under the camera when the view misses the Earth', () => {
    const { camera, moveTo, scene } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ terrain: 'world-terrain' });
    camera.pickEllipsoid.mockReturnValue(undefined as never);
    moveTo(10, 45);
    expectDirection(scene.light, 10, 45);
  });

  it('restores the sun and the day/night setting when terrain goes back to smooth', () => {
    const { moveTo, preRender, scene, sun } = fakeScene();
    scene.globe.dynamicAtmosphereLightingFromSun = true;
    scene.globe.vertexShadowDarkness = 0.4;
    const shading = new TerrainShading(scene);
    shading.update({ dayNight: false, terrain: 'world-terrain' });
    expect(scene.globe.dynamicAtmosphereLightingFromSun).toBe(false);
    moveTo(86.9, 27.98, 2_000_000);
    shading.update({ terrain: 'smooth-globe' });
    expect(scene.light).toBe(sun);
    expect(scene.globe.enableLighting).toBe(false);
    expect(scene.globe.dynamicAtmosphereLightingFromSun).toBe(true);
    expect(scene.globe.vertexShadowDarkness).toBe(0.4);
    expect(preRender.numberOfListeners).toBe(0);
    shading.update({ dayNight: true });
    expect(scene.globe.enableLighting).toBe(true);
  });

  it('keeps the hillshade when day/night changes under terrain', () => {
    const { scene } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ dayNight: true, terrain: 'world-terrain' });
    const light = scene.light;
    shading.update({ dayNight: false });
    expect(scene.light).toBe(light);
    expect(scene.globe.enableLighting).toBe(true);
  });

  it('stops re-aiming once destroyed', () => {
    const { preRender, scene } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ terrain: 'world-terrain' });
    shading.destroy();
    expect(preRender.numberOfListeners).toBe(0);
  });
});

describe('TerrainShading, draping design terms', () => {
  it("sets the hillshade terms under World Terrain and restores the globe's own on the smooth globe", () => {
    const { scene } = fakeScene();
    scene.globe.lambertDiffuseMultiplier = 0.7;
    const shading = new TerrainShading(scene);
    shading.update({ terrain: 'world-terrain' });
    expect(HILLSHADE_DIFFUSE_MULTIPLIER).toBe(0.9);
    expect(scene.globe).toMatchObject({
      lambertDiffuseMultiplier: 0.9,
      showGroundAtmosphere: false,
      showWaterEffect: false,
      vertexShadowDarkness: 0.45,
    });
    shading.update({ surfaceShown: false });
    expect(scene.globe).toMatchObject({
      showGroundAtmosphere: true,
      showWaterEffect: true,
    });
    shading.update({ surfaceShown: true });
    expect(scene.globe).toMatchObject({
      showGroundAtmosphere: false,
      showWaterEffect: false,
    });
    shading.update({ terrain: 'smooth-globe' });
    expect(scene.globe).toMatchObject({
      lambertDiffuseMultiplier: 0.7,
      showGroundAtmosphere: true,
      showWaterEffect: true,
      vertexShadowDarkness: 0.3,
    });
  });

  it('never turns on an atmosphere or water effect the smooth globe had off', () => {
    const { scene } = fakeScene();
    Object.assign(scene.globe, {
      showGroundAtmosphere: false,
      showWaterEffect: false,
    });
    const shading = new TerrainShading(scene);
    shading.update({ surfaceShown: false });
    shading.update({ terrain: 'world-terrain' });
    expect(scene.globe).toMatchObject({
      showGroundAtmosphere: false,
      showWaterEffect: false,
    });
    shading.update({ terrain: 'smooth-globe' });
    expect(scene.globe).toMatchObject({
      showGroundAtmosphere: false,
      showWaterEffect: false,
    });
  });

  it('keeps flat ground at the legend colour under a nadir camera up to 3,000 km (GlobeFS.glsl:432)', () => {
    for (const height of [
      1_000, 200_000, 500_000, 1_000_000, 2_000_000, 2_999_000,
    ]) {
      const { camera, scene } = fakeScene({ lat: 40.419, lon: -3.709 }, height);
      camera.directionWC = down(-3.709, 40.419);
      new TerrainShading(scene).update({ terrain: 'world-terrain' });
      const { x, y, z } = (scene.light as DirectionalLight).direction;
      const lambert = -dot([x, y, z], up(-3.709, 40.419));
      expect(
        lambert * scene.globe.lambertDiffuseMultiplier +
          scene.globe.vertexShadowDarkness,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('swings the light towards the line of sight from 500 km, reaching it at 5,000 km', () => {
    const { camera, moveTo, scene } = fakeScene();
    const sight = Cartesian3.normalize(
      new Cartesian3(-1, -2, -3),
      new Cartesian3(),
    );
    camera.directionWC = sight;
    new TerrainShading(scene).update({ terrain: 'world-terrain' });
    moveTo(38.75, 9.03, 2_750_000);
    const hill = new Cartesian3(
      ...hillshadeDirection(
        38.75,
        9.03,
        315,
        hillshadeElevationDegrees(2_750_000),
      ),
    );
    const half = Cartesian3.normalize(
      Cartesian3.add(hill, sight, new Cartesian3()),
      new Cartesian3(),
    );
    expectVector((scene.light as DirectionalLight).direction, half);
    moveTo(38.75, 9.03, 5_000_000);
    expectVector((scene.light as DirectionalLight).direction, sight);
  });

  it('swings towards overhead in 2D and Columbus view, whose camera directions are not Earth-fixed', () => {
    for (const [mode, view] of [
      [SceneMode.COLUMBUS_VIEW, 'perspective'],
      [SceneMode.SCENE2D, 'map'],
    ] as const) {
      const { moveTo, scene } = fakeScene();
      scene.mode = mode;
      new TerrainShading(scene).update({
        mode: view,
        terrain: 'world-terrain',
      });
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
    const before = Cartesian3.clone(
      (scene.light as DirectionalLight).direction,
    );
    scene.mode = SceneMode.MORPHING;
    camera.pickEllipsoid.mockReturnValue(undefined as never);
    camera.positionCartographic = new Cartographic(
      Number.NaN,
      Number.NaN,
      Number.NaN,
    );
    preRender.raiseEvent();
    expect(
      Cartesian3.equals((scene.light as DirectionalLight).direction, before),
    ).toBe(true);
    expect(scene.globe.enableLighting).toBe(false);
  });
});

describe('TerrainShading relief (#483)', () => {
  it('leaves the scene at true scale until relief is set', () => {
    const { scene } = fakeScene();
    new TerrainShading(scene).update({ terrain: 'world-terrain' });
    expect(scene.verticalExaggeration).toBe(1);
  });

  it('exaggerates World Terrain from sea level and requests a frame', () => {
    const { scene } = fakeScene();
    scene.verticalExaggerationRelativeHeight = 500;
    const shading = new TerrainShading(scene);
    shading.update({ relief: 3, terrain: 'world-terrain' });
    expect(scene.verticalExaggeration).toBe(3);
    expect(scene.verticalExaggerationRelativeHeight).toBe(0);
    expect(scene.requestRender).toHaveBeenCalled();
  });

  it('draws the smooth globe and the 2D map at true scale', () => {
    const { scene } = fakeScene();
    const shading = new TerrainShading(scene);
    shading.update({ mode: 'globe', relief: 4, terrain: 'world-terrain' });
    expect(scene.verticalExaggeration).toBe(4);
    shading.update({ mode: 'map' });
    expect(scene.verticalExaggeration).toBe(1);
    shading.update({ mode: 'perspective' });
    expect(scene.verticalExaggeration).toBe(4);
    shading.update({ terrain: 'smooth-globe' });
    expect(scene.verticalExaggeration).toBe(1);
  });
});
