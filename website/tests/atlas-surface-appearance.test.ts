import { Color, Material } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  restingWave,
  WAVE_COMPLETE_RADIUS,
  type RevealWaveUniforms,
} from '../src/atlas/scene/reveal-wave';
import {
  elevatedSurfaceAppearance,
  HONMOON_CONTOUR_BANDS,
  honmoonModeForGeometry,
  supportAppearance,
  SURFACE_CLEARANCE_METRES,
  usesVertexColorGamma,
} from '../src/atlas/scene/surface-appearance';
import * as legacyMesh from './legacy/surface-mesh';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';

afterEach(() => vi.unstubAllGlobals());

function whiteMaterial(): Material {
  return Material.fromType('Color', { color: Color.WHITE.withAlpha(0.9) });
}

describe('elevated surface appearance', () => {
  it('gamma-corrects vertex colours only for per-cell bin geometries', () => {
    expect(usesVertexColorGamma('hexagons')).toBe(true);
    expect(usesVertexColorGamma('extruded')).toBe(true);
    expect(usesVertexColorGamma('triangles')).toBe(false);
    expect(usesVertexColorGamma('honmoon')).toBe(false);
    expect(usesVertexColorGamma('honmoon-fill')).toBe(false);
  });

  it('exposes the gamma switch as a uniform that defaults off', () => {
    stubCesiumBrowserImageTypes();
    const smooth = elevatedSurfaceAppearance(whiteMaterial(), 0);
    const binned = elevatedSurfaceAppearance(whiteMaterial(), 2, true, 0, true);

    const resting = restingWave();
    expect(smooth.uniforms).toEqual({
      u_elevationFactor: 0,
      u_honmoonMode: 0,
      u_vertexColorGamma: 0,
      u_waveBand: resting.band,
      u_waveOrigin: resting.origin,
      u_waveRadius: WAVE_COMPLETE_RADIUS,
    });
    expect(binned.uniforms).toEqual({
      u_elevationFactor: 2,
      u_honmoonMode: 0,
      u_vertexColorGamma: 1,
      u_waveBand: resting.band,
      u_waveOrigin: resting.origin,
      u_waveRadius: WAVE_COMPLETE_RADIUS,
    });
    expect(binned.closed).toBe(true);
  });

  it('multiplies the gamma-corrected vertex colour into the material diffuse', () => {
    stubCesiumBrowserImageTypes();
    const source = elevatedSurfaceAppearance(
      whiteMaterial(),
      0,
    ).fragmentShaderSource;

    expect(source).toContain('uniform float u_vertexColorGamma;');
    expect(source).toContain('czm_gammaCorrect(v_surfaceColor)');
    expect(source).toContain('material.diffuse *= surfaceColor;');
    expect(source).not.toContain('material.diffuse *= v_surfaceColor;');
  });

  it('rests with the wave complete, so a surface built outside a wave is whole (#453)', () => {
    expect(restingWave()).toEqual({
      band: 1,
      origin: { x: 1, y: 0, z: 0 },
      radius: WAVE_COMPLETE_RADIUS,
    });
    expect(restingWave()).not.toBe(restingWave());
  });

  it('reads the shared wave state on every draw, so one write moves every chunk (#453)', () => {
    stubCesiumBrowserImageTypes();
    const wave: RevealWaveUniforms = restingWave();
    const first = elevatedSurfaceAppearance(whiteMaterial(), 0);
    const second = elevatedSurfaceAppearance(
      whiteMaterial(),
      0,
      false,
      0,
      true,
      { cellGrowth: true, wave },
    );
    const third = elevatedSurfaceAppearance(
      whiteMaterial(),
      0,
      false,
      0,
      false,
      { wave },
    );
    wave.radius = 0.25;
    wave.band = 0.05;
    wave.origin = { x: 0, y: 1, z: 0 };
    for (const appearance of [second, third]) {
      expect(appearance.uniforms.u_waveRadius).toBe(0.25);
      expect(appearance.uniforms.u_waveBand).toBe(0.05);
      expect(appearance.uniforms.u_waveOrigin).toEqual({ x: 0, y: 1, z: 0 });
    }
    // An appearance given no wave keeps its own resting state.
    expect(first.uniforms.u_waveRadius).toBe(WAVE_COMPLETE_RADIUS);
    // Cesium builds the uniform map from the own enumerable names.
    expect(Object.keys(second.uniforms).sort()).toEqual([
      'u_elevationFactor',
      'u_honmoonMode',
      'u_vertexColorGamma',
      'u_waveBand',
      'u_waveOrigin',
      'u_waveRadius',
    ]);
  });

  it('fades a smooth surface per vertex and grows flat cells from their centre attribute (#453)', () => {
    stubCesiumBrowserImageTypes();
    const smooth = elevatedSurfaceAppearance(whiteMaterial(), 0);
    const flat = elevatedSurfaceAppearance(whiteMaterial(), 0, true, 0, true, {
      cellGrowth: true,
    });

    for (const source of [smooth.vertexShaderSource, flat.vertexShaderSource]) {
      expect(source).toContain('uniform vec3 u_waveOrigin;');
      expect(source).toContain('uniform float u_waveRadius;');
      expect(source).toContain('uniform float u_waveBand;');
      expect(source).toContain(
        `if (u_waveRadius >= ${WAVE_COMPLETE_RADIUS.toFixed(1)}) return 1.0;`,
      );
      expect(source).toContain('out float v_waveReveal;');
    }
    expect(smooth.vertexShaderSource).not.toContain(
      '#define ATLAS_CELL_GROWTH',
    );
    expect(flat.vertexShaderSource).toContain('#define ATLAS_CELL_GROWTH');
    expect(flat.vertexShaderSource).toContain('in vec3 cellCentre;');
    expect(flat.vertexShaderSource).toContain(
      'float reveal = atlasWaveReveal(cellCentre);',
    );
    expect(smooth.vertexShaderSource).toContain(
      'float reveal = atlasWaveReveal(elevationNormal);',
    );
    for (const source of [
      smooth.fragmentShaderSource,
      flat.fragmentShaderSource,
    ]) {
      expect(source).toContain('in float v_waveReveal;');
      // Both the contour and the shaded branch fade with the wave.
      expect(source.match(/out_FragColor\.a \*= v_waveReveal;/g)).toHaveLength(
        2,
      );
    }
  });

  it('gives the support masks the same wave, grown from each cell centre (#453)', () => {
    stubCesiumBrowserImageTypes();
    const wave = restingWave();
    const material = Material.fromType('Grid');
    const appearance = supportAppearance(material, wave);
    wave.radius = 0.5;

    expect(appearance.material).toBe(material);
    expect(appearance.flat).toBe(true);
    expect(appearance.translucent).toBe(true);
    expect(appearance.closed).toBe(false);
    expect(appearance.uniforms.u_waveRadius).toBe(0.5);
    expect(appearance.vertexShaderSource).toContain('in vec3 cellCentre;');
    expect(appearance.vertexShaderSource).toContain('in vec2 st;');
    expect(appearance.vertexShaderSource).toContain(
      'float reveal = atlasWaveReveal(cellCentre);',
    );
    expect(appearance.fragmentShaderSource).toContain(
      'materialInput.st = v_st;',
    );
    expect(appearance.fragmentShaderSource).toContain(
      'out_FragColor.a *= v_waveReveal;',
    );
  });

  it('keeps the legacy surface-mesh exports as the same functions', () => {
    expect(legacyMesh.elevatedSurfaceAppearance).toBe(
      elevatedSurfaceAppearance,
    );
    expect(legacyMesh.honmoonModeForGeometry).toBe(honmoonModeForGeometry);
    expect(legacyMesh.HONMOON_CONTOUR_BANDS).toBe(HONMOON_CONTOUR_BANDS);
    expect(legacyMesh.SURFACE_CLEARANCE_METRES).toBe(SURFACE_CLEARANCE_METRES);
    expect(SURFACE_CLEARANCE_METRES).toBe(650);
  });
});
