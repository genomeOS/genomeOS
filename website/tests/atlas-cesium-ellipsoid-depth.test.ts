/**
 * Cesium's ray-cast ellipsoid writes its log depth from the near plane, as every other caller of
 * `czm_writeLogDepth` does, so an observation sphere above World Terrain is not lost behind the
 * ground when the frustum's near plane lies far from the camera (terrain draping design, "Goals":
 * "Symbols and labels are never buried"; "Test plan": "Placement"; #483). The correction is
 * integrations/cesium-ellipsoid-log-depth.mjs; this file checks the bundle Pages ships, which
 * globalSetup builds, and the transform's refusal to do nothing when Cesium changes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import cesiumEllipsoidLogDepth from '../integrations/cesium-ellipsoid-log-depth.mjs';

const website = path.resolve(import.meta.dirname, '..');
const ELLIPSOID_FS = path.join(
  website,
  'node_modules/@cesium/engine/Source/Shaders/EllipsoidFS.js',
);
// Literal here, not imported from the plugin, so a wrong constant there cannot pass this file.
const UNCORRECTED = 'czm_writeLogDepth(1.0 + positionCC.w);';
const CORRECTED =
  'czm_writeLogDepth(1.0 + positionCC.w - czm_currentFrustum.x);';

const occurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

type Transform = (code: string, id: string) => { code: string } | null;
const transform = cesiumEllipsoidLogDepth().transform as Transform;

describe('Cesium ellipsoid log depth (terrain draping design, "Goals")', () => {
  it('ships the corrected write, once, and never the uncorrected one', () => {
    const astro = path.join(website, 'dist/_astro');
    const cesium = readdirSync(astro).filter((name) =>
      /^cesium\.[\w-]+\.js$/.test(name),
    );
    expect(cesium).toHaveLength(1);
    const code = readFileSync(path.join(astro, cesium[0]), 'utf8');
    expect(occurrences(code, CORRECTED)).toBe(1);
    expect(occurrences(code, UNCORRECTED)).toBe(0);
  });

  it("corrects exactly the one write in Cesium's EllipsoidFS.js and changes nothing else", () => {
    const source = readFileSync(ELLIPSOID_FS, 'utf8');
    expect(occurrences(source, UNCORRECTED)).toBe(1);
    const result = transform(source, ELLIPSOID_FS);
    expect(result).not.toBeNull();
    expect(occurrences(result!.code, CORRECTED)).toBe(1);
    expect(occurrences(result!.code, UNCORRECTED)).toBe(0);
    expect(result!.code.replace(CORRECTED, UNCORRECTED)).toBe(source);
  });

  it('matches the module by a Windows path or with a query, and leaves other modules alone', () => {
    const source = readFileSync(ELLIPSOID_FS, 'utf8');
    for (const id of [
      'C:\\site\\node_modules\\@cesium\\engine\\Source\\Shaders\\EllipsoidFS.js',
      `${ELLIPSOID_FS}?v=1a2b3c`,
    ])
      expect(occurrences(transform(source, id)!.code, CORRECTED)).toBe(1);
    for (const id of [
      path.join(path.dirname(ELLIPSOID_FS), 'EllipsoidVS.js'),
      path.join(path.dirname(ELLIPSOID_FS), 'BillboardCollectionFS.js'),
      path.join(website, 'src/atlas/scene/observation-layer.ts'),
    ])
      expect(transform(source, id)).toBeNull();
  });

  it('fails the build when a Cesium upgrade drops or repeats the uncorrected write', () => {
    const source = readFileSync(ELLIPSOID_FS, 'utf8');
    const fixedUpstream = source.replace(UNCORRECTED, CORRECTED);
    expect(() => transform(fixedUpstream, ELLIPSOID_FS)).toThrow(
      /found 0 times, expected exactly once/,
    );
    expect(() =>
      transform(`${source}\n// ${UNCORRECTED}`, ELLIPSOID_FS),
    ).toThrow(/found 2 times, expected exactly once/);
  });
});
