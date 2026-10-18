/** Physical-terrain shading: the hillshade light policy and its scene controller (Atlas design
 * §11, interaction design §5.2; #483). */
import {
  Cartesian3,
  Cartographic,
  DirectionalLight,
  Ellipsoid,
  SunLight,
} from 'cesium';
import { describe, expect, it, vi } from 'vitest';

import {
  HILLSHADE_AZIMUTH_DEGREES,
  HILLSHADE_ELEVATION_DEGREES,
  hillshadeDirection,
  hillshadeElevationDegrees,
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

describe('terrainLighting (hillshade policy, #483)', () => {
  it('lights World Terrain with the fixed hillshade light, whatever day/night says', () => {
    expect(
      terrainLighting({ dayNight: true, terrain: 'world-terrain' }),
    ).toEqual({ enableLighting: true, light: 'hillshade' });
    expect(
      terrainLighting({ dayNight: false, terrain: 'world-terrain' }),
    ).toEqual({ enableLighting: true, light: 'hillshade' });
  });

  it('keeps the smooth globe on the real-time sun, lit only when day/night is on', () => {
    expect(
      terrainLighting({ dayNight: true, terrain: 'smooth-globe' }),
    ).toEqual({
      enableLighting: true,
      light: 'sun',
    });
    expect(
      terrainLighting({ dayNight: false, terrain: 'smooth-globe' }),
    ).toEqual({ enableLighting: false, light: 'sun' });
  });
});

describe('hillshadeDirection', () => {
  it('shines from the north-west, 35° above the horizon at the target', () => {
    expect(HILLSHADE_AZIMUTH_DEGREES).toBe(315);
    expect(HILLSHADE_ELEVATION_DEGREES).toBe(35);
    for (const [lon, lat] of [
      [0, 0],
      [86.9, 27.98],
      [38.75, 9.03],
      [-70, -33],
    ]) {
      const direction = hillshadeDirection(lon, lat, 315, 35);
      expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
      // The light travels downward at the elevation angle...
      expect(-dot(direction, up(lon, lat))).toBeCloseTo(Math.sin(35 * DEGREE));
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
  it('holds 35° wherever relief is visible', () => {
    for (const height of [0, 1_000, 17_000, 200_000, 500_000])
      expect(hillshadeElevationDegrees(height)).toBe(35);
  });

  it('rises with the horizon so the light never sets inside the visible disc', () => {
    let previous = 35;
    for (const height of [1e6, 2e6, 5e6, 1e7, 1.65e7, 1e8]) {
      const elevation = hillshadeElevationDegrees(height);
      expect(elevation).toBeGreaterThanOrEqual(previous);
      expect(elevation).toBeGreaterThan(horizonDegrees(height));
      expect(elevation).toBeLessThanOrEqual(90);
      previous = elevation;
    }
  });
});

function fakeScene(target = { lat: 27.98, lon: 86.9 }, height = 200_000) {
  const sun = new SunLight();
  const preRender = new FakeEvent();
  const camera = {
    directionWC: new Cartesian3(0, 0, -1),
    pickEllipsoid: vi.fn(() =>
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
    globe: { dynamicAtmosphereLightingFromSun: false, enableLighting: true },
    light: sun as SunLight | DirectionalLight,
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
  elevation = 35,
) {
  expect(light).toBeInstanceOf(DirectionalLight);
  const expected = hillshadeDirection(lon, lat, 315, elevation);
  const { x, y, z } = (light as DirectionalLight).direction;
  expect(x).toBeCloseTo(expected[0], 9);
  expect(y).toBeCloseTo(expected[1], 9);
  expect(z).toBeCloseTo(expected[2], 9);
}

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
    expectDirection(
      scene.light,
      -70,
      -33,
      hillshadeElevationDegrees(16_500_000),
    );
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
    const { preRender, scene, sun } = fakeScene();
    scene.globe.dynamicAtmosphereLightingFromSun = true;
    const shading = new TerrainShading(scene);
    shading.update({ dayNight: false, terrain: 'world-terrain' });
    expect(scene.globe.dynamicAtmosphereLightingFromSun).toBe(false);
    shading.update({ terrain: 'smooth-globe' });
    expect(scene.light).toBe(sun);
    expect(scene.globe.enableLighting).toBe(false);
    expect(scene.globe.dynamicAtmosphereLightingFromSun).toBe(true);
    expect(preRender.numberOfListeners).toBe(0);
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
