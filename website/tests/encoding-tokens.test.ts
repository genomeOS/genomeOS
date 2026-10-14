/**
 * One home for the Atlas's visual words (site redesign spec §2.2, #454).
 *
 * The Atlas modules read their constants from `src/atlas/encoding-tokens.ts`, and every value is the
 * one the Atlas shipped before the move (the literals below are copied from origin/main 059c1cd),
 * so the move changes nothing that renders. The site tokens are derived from the same module.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATLAS_PALETTES,
  OBSERVATION_SOLID,
  PRIOR_DOTS,
  UNKNOWN_HATCH,
} from '../src/atlas/encoding-tokens';
import { DEFAULT_OBSERVATION_SOLID_COLOR } from '../src/atlas/observation-encoding';
import { materialForSupport } from '../src/atlas/scene/support-material';
import {
  colorAtPosition,
  paletteStops,
  type PaletteId,
} from '../src/atlas/visual-encoding';
import {
  ENC,
  encodingCss,
  meanBin,
  tier,
  vsupColor,
} from '../src/graphics/encoding';
import { stubCesiumBrowserImageTypes } from './helpers/cesium-stubs';

const atlas = path.resolve(import.meta.dirname, '../src/atlas');
const source = (relative: string) =>
  readFileSync(path.join(atlas, relative), 'utf8');

// The Atlas's values before the move, verbatim.
const BEFORE: Record<PaletteId, readonly string[]> = {
  cividis: ['#00204c', '#7d7c78', '#fee838'],
  genome: ['#10213e', '#27a9d0', '#72e7c1'],
  golden: ['#241133', '#7a3f18', '#d49425', '#f4c86a', '#fff3bd'],
  plasma: ['#0d0887', '#cc4778', '#f0f921'],
  rainbow: ['#6e40aa', '#417de0', '#1ac7c2', '#7bd34d', '#f2cf44', '#ff5e63'],
  signal: ['#24144b', '#ad8bff', '#f4c86a'],
  viridis: ['#440154', '#21918c', '#fde725'],
};

describe('the Atlas reads its visual words from encoding-tokens.ts', () => {
  it('keeps every palette stop, the stud colour and the support materials as they were', () => {
    expect(ATLAS_PALETTES).toEqual(BEFORE);
    for (const id of Object.keys(BEFORE) as PaletteId[])
      expect(paletteStops(id)).toEqual(BEFORE[id]);
    expect(OBSERVATION_SOLID).toBe('#f4fbff');
    expect(DEFAULT_OBSERVATION_SOLID_COLOR).toBe('#f4fbff');
    expect(UNKNOWN_HATCH).toEqual({
      color: '#a8b5c9',
      alpha: 0.72,
      cellAlpha: 0.24,
      lineCount: 5,
      lineThickness: 1.65,
    });
    expect(PRIOR_DOTS).toEqual({
      highlightMix: 0.38,
      darkAlpha: 0.46,
      lightAlpha: 0.82,
      repeat: 10,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the same Cesium materials from them', () => {
    stubCesiumBrowserImageTypes();
    const hatch = materialForSupport('unknown').uniforms as Record<
      string,
      { red: number; green: number; blue: number; alpha: number; x: number }
    >;
    expect(hatch.cellAlpha).toBe(0.24);
    expect(hatch.color.alpha).toBe(0.72);
    expect(
      [hatch.color.red, hatch.color.green, hatch.color.blue].map((c) =>
        Math.round(c * 255),
      ),
    ).toEqual([0xa8, 0xb5, 0xc9]);
    expect(hatch.lineCount).toMatchObject({ x: 5, y: 5 });
    expect(hatch.lineThickness).toMatchObject({ x: 1.65, y: 1.65 });

    const dots = materialForSupport('prior_dominated', '#27a9d0')
      .uniforms as Record<
      string,
      { red: number; green: number; blue: number; alpha: number }
    >;
    expect(dots.darkColor.alpha).toBe(0.46);
    expect(dots.lightColor.alpha).toBe(0.82);
    expect(dots.repeat).toMatchObject({ x: 10, y: 10 });
    // Colour.lerp(base, WHITE, 0.38) on #27a9d0.
    expect(dots.lightColor.red).toBeCloseTo(
      0x27 / 255 + (1 - 0x27 / 255) * 0.38,
      10,
    );
  });

  it('leaves no copy of a moved literal in the module it moved from', () => {
    const palettes = source('visual-encoding.ts');
    const observations = source('observation-encoding.ts');
    const support = source('scene/support-material.ts');
    expect(palettes).toContain("from './encoding-tokens'");
    expect(observations).toContain("from './encoding-tokens'");
    expect(support).toContain("from '../encoding-tokens'");
    for (const stop of Object.values(BEFORE).flat())
      expect(palettes.toLowerCase(), `still spells ${stop}`).not.toContain(
        stop,
      );
    expect(observations).not.toContain('#f4fbff');
    expect(support).not.toContain('#a8b5c9');
    expect(support).not.toMatch(/\b0\.(?:24|38|46|72|82)\b|\b1\.65\b/);
  });

  it('stays Cesium-free and DOM-free, so the site can import it', () => {
    const text = source('encoding-tokens.ts');
    expect(text).not.toMatch(/from 'cesium'|document\.|window\./);
  });
});

describe('the site encoding derived from it (spec §2.2)', () => {
  it('emits the documented ramp, tier, evidence and mark colours', () => {
    expect(ENC.mean).toEqual([
      '#1c7796',
      '#218eb1',
      '#25a2c8',
      '#39b3ce',
      '#4dc3cb',
      '#5dd1c7',
    ]);
    expect(ENC.meanPartial).toEqual(['#307693', '#3b90a7', '#50a6a2']);
    expect(ENC.meanWeak).toBe('#3c6a7e');
    expect(ENC.fog).toBe('#3d4a5c');
    expect(ENC.evidence).toEqual(['#c3d0e0', '#8693a8', '#5a6b84']);
    expect(ENC.obs).toBe('#f4fbff');
    expect(ENC.land).toBe('#112a4b');
    expect(ENC.hatch).toBe('#a8b5c9');
    expect(ENC.hatchAlpha).toBe(0.72);
  });

  it('samples the Atlas genome palette the way visual-encoding.ts does', () => {
    ENC.mean.forEach((colour, index) =>
      expect(colour).toBe(colorAtPosition('genome', 0.22 + 0.116 * index)),
    );
  });

  it('writes every token into one :root block', () => {
    const css = encodingCss();
    expect(css.startsWith(':root{')).toBe(true);
    for (const [name, value] of [
      ['--enc-obs', '#f4fbff'],
      ['--enc-obs-ring', 'var(--color-void)'],
      ['--enc-land', '#112a4b'],
      ['--enc-mean-1', '#1c7796'],
      ['--enc-mean-6', '#5dd1c7'],
      ['--enc-mean-partial-1', '#307693'],
      ['--enc-mean-partial-3', '#50a6a2'],
      ['--enc-mean-weak', '#3c6a7e'],
      ['--enc-fog', '#3d4a5c'],
      ['--enc-evidence-1', '#c3d0e0'],
      ['--enc-evidence-3', '#5a6b84'],
      ['--enc-hatch', '#a8b5c9'],
      ['--enc-gate', 'var(--color-signal)'],
    ])
      expect(css).toContain(`${name}:${value};`);
  });

  it('never reuses a status colour, and never tops a ramp as light as stud white', () => {
    const status = ['#70e6ff', '#72e7c1', '#ad8bff', '#f4c86a'];
    const data = [
      ...ENC.mean,
      ...ENC.meanPartial,
      ENC.meanWeak,
      ENC.fog,
      ...ENC.evidence,
      ENC.land,
      ENC.hatch,
    ];
    for (const colour of data) expect(status).not.toContain(colour);
    expect(ENC.mean.at(-1)).not.toBe(ENC.obs);
  });

  it('tiers evidence by distance in units of the correlation range', () => {
    expect(tier(0, 680)).toBe('strong');
    expect(tier(170, 680)).toBe('strong');
    expect(tier(171, 680)).toBe('partial');
    expect(tier(680, 680)).toBe('partial');
    expect(tier(1360, 680)).toBe('weak');
    expect(tier(1361, 680)).toBe('none');
  });

  it('suppresses value resolution as evidence thins (VSUP)', () => {
    const domain = [0, 0.18] as const;
    expect(meanBin(0, domain)).toBe(0);
    expect(meanBin(0.18, domain)).toBe(5);
    expect(meanBin(0.0299, domain)).toBe(0);
    expect(meanBin(0.03, domain)).toBe(1);
    expect(vsupColor(0.0, 'strong', domain)).toBe('#1c7796');
    expect(vsupColor(0.18, 'strong', domain)).toBe('#5dd1c7');
    // Partial evidence keeps three of the six steps; weak evidence keeps none.
    expect(vsupColor(0.0, 'partial', domain)).toBe('#307693');
    expect(vsupColor(0.05, 'partial', domain)).toBe('#307693');
    expect(vsupColor(0.07, 'partial', domain)).toBe('#3b90a7');
    expect(vsupColor(0.18, 'partial', domain)).toBe('#50a6a2');
    expect(vsupColor(0.0, 'weak', domain)).toBe('#3c6a7e');
    expect(vsupColor(0.18, 'weak', domain)).toBe('#3c6a7e');
    expect(vsupColor(0.1, 'none', domain)).toBeNull();
  });
});
