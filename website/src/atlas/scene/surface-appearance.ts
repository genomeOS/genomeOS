/** Elevated surface and support-mask shading for Atlas design §11 (spec 2026-10-07 §B.6.5, and
 * §B.6.7 as amended 2026-10-13 for the reveal wave, #453).
 *
 * Smooth modes carry their sRGB colour per vertex and multiply it into a
 * white material unchanged. Hexagon and extruded modes carry the sRGB
 * palette-bin colour per vertex and gamma-correct it in the fragment shader,
 * which reproduces the former per-bin material colour under high dynamic
 * range and is the identity without it.
 *
 * Every surface and mask chunk also follows the reveal wave (`reveal-wave.ts`) on the GPU alone:
 * three uniforms, read from one shared state on every draw, so animating the wave writes no
 * buffer. A smooth surface fades per vertex. Flat cells and masks grow from their `cellCentre`
 * towards full size, each vertex pulled towards its cell's axis at its own height, and fade with
 * it; a cell the wave has not reached collapses to that axis, so it draws no fragment in any
 * pass, picking included (Cesium's pick shader reuses this vertex shader and discards alpha 0).
 *
 * The Honmoon band count and mode table come from the Cesium-free `geometry/surface-buffers.ts`,
 * so the contours the worker rasterises for World Terrain (`geometry/raster/contours.ts`) share
 * them and port this fragment texel by texel, within one byte; the `luminous * 1.35` overshoot
 * that high dynamic range keeps here saturates at 255 there (terrain draping design, "Per layer
 * under World Terrain", #483).
 */

import { Material, MaterialAppearance } from 'cesium';

import {
  HONMOON_CONTOUR_BANDS,
  SURFACE_CLEARANCE_METRES,
} from '../geometry/surface-buffers';
import type { SurfaceGeometry } from '../url-state';
import {
  restingWave,
  WAVE_COMPLETE_RADIUS,
  type RevealWaveUniforms,
} from './reveal-wave';

// One owner: the Cesium-free constant from Task 44 (B3.5), re-exported for the scene modules.
export { SURFACE_CLEARANCE_METRES };

// One owner as well: the Honmoon band count and mode table, shared with the draped contours.
export {
  HONMOON_CONTOUR_BANDS,
  honmoonModeForGeometry,
} from '../geometry/surface-buffers';

/** Cesium's geographic projection scales radians by the WGS84 semi-major axis. */
const PROJECTION_SEMI_MAJOR_AXIS_METRES = 6_378_137;

interface WaveUniformMap {
  readonly u_waveOrigin: RevealWaveUniforms['origin'];
  readonly u_waveRadius: number;
  readonly u_waveBand: number;
}

export type ElevatedSurfaceAppearance = MaterialAppearance & {
  uniforms: {
    u_elevationFactor: number;
    u_honmoonMode: number;
    u_vertexColorGamma: number;
  } & WaveUniformMap;
};

export type SupportAppearance = MaterialAppearance & {
  uniforms: WaveUniformMap;
};

/**
 * `cellReveal` (reveal-wave.ts) on the GPU, and the offset from a cell's axis to one of its
 * ground vertices in the frame `czm_computePosition()` draws in: ECEF on the globe; in 2D and
 * Columbus view the projected map frame `(height, x, y)`, linearised at the cell centre for
 * Cesium's geographic projection. Near a pole that projection is far from linear over one cell,
 * so a polar cell there only fades.
 */
const REVEAL_WAVE_GLSL = `
uniform vec3 u_waveOrigin;
uniform float u_waveRadius;
uniform float u_waveBand;

float atlasWaveReveal(vec3 direction)
{
    if (u_waveRadius >= ${WAVE_COMPLETE_RADIUS.toFixed(1)}) return 1.0;
    float cosine = clamp(dot(normalize(direction), u_waveOrigin), -1.0, 1.0);
    return clamp((u_waveRadius - acos(cosine)) / u_waveBand, 0.0, 1.0);
}

vec3 atlasCellOffset(vec3 vertexEcef, vec3 cellCentre)
{
    vec3 ground = vertexEcef - cellCentre;
    if (czm_morphTime == 1.0) return ground;
    float axial = length(cellCentre.xy);
    float radius = length(cellCentre);
    if (axial < 0.05 * radius) return vec3(0.0);
    vec3 east = vec3(-cellCentre.y, cellCentre.x, 0.0) / axial;
    vec3 north = cross(cellCentre / radius, east);
    vec3 projected = vec3(
        0.0,
        dot(ground, east) * ${PROJECTION_SEMI_MAJOR_AXIS_METRES.toFixed(1)} / axial,
        dot(ground, north) * ${PROJECTION_SEMI_MAJOR_AXIS_METRES.toFixed(1)} / radius
    );
    return mix(projected, ground, czm_morphTime);
}
`;

const ELEVATED_SURFACE_VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec3 elevationNormal;
in vec3 surfaceColor;
in float surfaceHeight;
in float surfaceValue;
#ifdef ATLAS_CELL_GROWTH
in vec3 cellCentre;
#endif
in float batchId;

uniform float u_elevationFactor;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec3 v_surfaceColor;
out float v_surfaceValue;
out float v_waveReveal;
${REVEAL_WAVE_GLSL}
void main()
{
    vec4 p = czm_computePosition();
    p.xyz += elevationNormal * surfaceHeight * u_elevationFactor;
#ifdef ATLAS_CELL_GROWTH
    float reveal = atlasWaveReveal(cellCentre);
    if (reveal < 1.0)
    {
        vec3 lift = (elevationNormal - normalize(cellCentre)) * surfaceHeight * u_elevationFactor;
        p.xyz -= (1.0 - reveal) * (atlasCellOffset(position3DHigh + position3DLow, cellCentre) + lift);
    }
#else
    float reveal = atlasWaveReveal(elevationNormal);
#endif
    v_waveReveal = reveal;

    v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
    v_normalEC = czm_normal * normal;
    v_surfaceColor = surfaceColor;
    v_surfaceValue = surfaceValue;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

const ELEVATED_SURFACE_FRAGMENT_SHADER = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec3 v_surfaceColor;
in float v_surfaceValue;
in float v_waveReveal;

uniform float u_honmoonMode;
uniform float u_vertexColorGamma;

void main()
{
    vec3 positionToEyeEC = -v_positionEC;
    vec3 normalEC = normalize(v_normalEC);
#ifdef FACE_FORWARD
    normalEC = faceforward(normalEC, vec3(0.0, 0.0, 1.0), -normalEC);
#endif
    czm_materialInput materialInput;
    materialInput.normalEC = normalEC;
    materialInput.positionToEyeEC = positionToEyeEC;
    czm_material material = czm_getMaterial(materialInput);
    vec3 surfaceColor = u_vertexColorGamma > 0.5
        ? czm_gammaCorrect(v_surfaceColor)
        : v_surfaceColor;
    material.diffuse *= surfaceColor;
    if (u_honmoonMode > 0.5) {
        float contourCoordinate = v_surfaceValue * ${HONMOON_CONTOUR_BANDS.toFixed(1)};
        float distanceToLine = abs(fract(contourCoordinate + 0.5) - 0.5);
        float screenDerivative = clamp(fwidth(contourCoordinate), 0.006, 0.22);
        float pixelsFromLine = distanceToLine / screenDerivative;
        float core = 1.0 - smoothstep(0.45, 1.15, pixelsFromLine);
        float halo = 1.0 - smoothstep(0.7, 4.5, pixelsFromLine);
        vec3 luminous = mix(v_surfaceColor, vec3(1.0), 0.2 + core * 0.3);
        float fillAlpha = u_honmoonMode > 1.5 ? material.alpha * 0.28 : 0.0;
        float lineAlpha = material.alpha * max(core, halo * 0.42);
        vec3 fillColor = v_surfaceColor * 0.55;
        out_FragColor = vec4(
            mix(fillColor, luminous * 1.35, max(core, halo * 0.62)),
            max(fillAlpha, lineAlpha)
        );
        out_FragColor.a *= v_waveReveal;
        return;
    }
#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else
    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif
    out_FragColor.a *= v_waveReveal;
}
`;

/** Cesium's textured material appearance, with each masked cell grown from its centre. */
const SUPPORT_VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec2 st;
in vec3 cellCentre;
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;
out float v_waveReveal;
${REVEAL_WAVE_GLSL}
void main()
{
    vec4 p = czm_computePosition();
    float reveal = atlasWaveReveal(cellCentre);
    if (reveal < 1.0)
        p.xyz -= (1.0 - reveal) * atlasCellOffset(position3DHigh + position3DLow, cellCentre);
    v_waveReveal = reveal;

    v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
    v_normalEC = czm_normal * normal;
    v_st = st;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

const SUPPORT_FRAGMENT_SHADER = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
in float v_waveReveal;

void main()
{
    vec3 positionToEyeEC = -v_positionEC;
    vec3 normalEC = normalize(v_normalEC);
#ifdef FACE_FORWARD
    normalEC = faceforward(normalEC, vec3(0.0, 0.0, 1.0), -normalEC);
#endif
    czm_materialInput materialInput;
    materialInput.normalEC = normalEC;
    materialInput.positionToEyeEC = positionToEyeEC;
    materialInput.st = v_st;
    czm_material material = czm_getMaterial(materialInput);
#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else
    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif
    out_FragColor.a *= v_waveReveal;
}
`;

export function usesVertexColorGamma(geometry: SurfaceGeometry): boolean {
  return geometry === 'hexagons' || geometry === 'extruded';
}

/** Uniforms that read `wave` at every draw (Cesium calls `uniforms[name]` per command). */
function waveUniforms(wave: RevealWaveUniforms): WaveUniformMap {
  return {
    get u_waveBand() {
      return wave.band;
    },
    get u_waveOrigin() {
      return wave.origin;
    },
    get u_waveRadius() {
      return wave.radius;
    },
  };
}

export interface SurfaceWaveOptions {
  /** The shared wave state; a surface given none is always whole. */
  wave?: RevealWaveUniforms;
  /** The chunk carries `cellCentre`, so its cells grow from their centres (flat geometry). */
  cellGrowth?: boolean;
}

export function elevatedSurfaceAppearance(
  material: Material,
  initialFactor: number,
  extruded = false,
  honmoonMode = 0,
  vertexColorGamma = false,
  { cellGrowth = false, wave = restingWave() }: SurfaceWaveOptions = {},
): ElevatedSurfaceAppearance {
  const appearance = new MaterialAppearance({
    closed: extruded,
    flat: !extruded,
    material,
    materialSupport: MaterialAppearance.MaterialSupport.BASIC,
    translucent: true,
    fragmentShaderSource: ELEVATED_SURFACE_FRAGMENT_SHADER,
    vertexShaderSource: cellGrowth
      ? `#define ATLAS_CELL_GROWTH\n${ELEVATED_SURFACE_VERTEX_SHADER}`
      : ELEVATED_SURFACE_VERTEX_SHADER,
  }) as ElevatedSurfaceAppearance;
  appearance.uniforms = Object.defineProperties(
    {
      u_elevationFactor: initialFactor,
      u_honmoonMode: honmoonMode,
      u_vertexColorGamma: vertexColorGamma ? 1 : 0,
    },
    Object.getOwnPropertyDescriptors(waveUniforms(wave)),
  ) as ElevatedSurfaceAppearance['uniforms'];
  return appearance;
}

/** A masked cell's hatch or dots, following the reveal wave like the surface beside it. */
export function supportAppearance(
  material: Material,
  wave: RevealWaveUniforms,
): SupportAppearance {
  const appearance = new MaterialAppearance({
    closed: false,
    flat: true,
    material,
    translucent: true,
    fragmentShaderSource: SUPPORT_FRAGMENT_SHADER,
    vertexShaderSource: SUPPORT_VERTEX_SHADER,
  }) as SupportAppearance;
  appearance.uniforms = waveUniforms(wave);
  return appearance;
}
