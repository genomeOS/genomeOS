import { describe, expect, it } from 'vitest';

import type { Support } from '../src/atlas/contracts';
import { SUPPORT_CODES } from '../src/atlas/gosa/decode';
import {
  percent,
  provisionalPercent,
  surfaceCellView,
} from '../src/components/atlas/surface-cell-view';
import { columnarSurface } from './helpers/columnar-surface';

const CELL = '83754efffffffff';
const cells = [
  { h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'interpolated' as const },
];
// Neither value is exact in float32, so a render-tier read cannot pass for a detail-tier read.
const precise = [
  {
    h3: CELL,
    post_mean: 0.123456789,
    post_sd: 0.0123456789,
    support: 'interpolated' as const,
  },
];
// Each value sits just across a readout rounding boundary from its float32 rounding, so the
// render tier and the detail tier print different digits: 10.01% vs 10.02%, and 2.35% vs 2.34%.
const straddling = [
  {
    h3: CELL,
    post_mean: 0.10015000001,
    post_sd: 0.02344999999,
    support: 'interpolated' as const,
  },
];

function selectionOf(surface: ReturnType<typeof columnarSurface>) {
  return { artifactKey: surface.artifactKey, kind: 'surface' as const, row: 0 };
}

describe('surface cell view gate', () => {
  it('shows the id, support and provisional render values until the detail tier loads', () => {
    const surface = columnarSurface(cells);
    const selection = selectionOf(surface);
    const view = surfaceCellView(surface, selection, 'loading');
    expect(view).toMatchObject({
      h3Index: CELL,
      state: 'loading',
      support: 'interpolated',
    });
    // No detail-tier field and no plain number: the only values are the opaque provisional pair.
    expect(Object.keys(view!).sort()).toEqual([
      'h3Index',
      'provisional',
      'state',
      'support',
    ]);
    expect(Object.keys(view!).includes('cell')).toBe(false);
    expect(surfaceCellView(surface, selection, 'ready')).toMatchObject({
      state: 'loading',
    });
    expect(surfaceCellView(surface, selection, 'unavailable')).toMatchObject({
      state: 'unavailable',
    });
  });

  it('takes every value from the detail tier once it is ready', () => {
    const surface = columnarSurface(precise, { withDetail: true });
    expect(surface.values.post_mean[0]).not.toBe(surface.detail!.post_mean[0]);
    expect(surface.values.post_sd[0]).not.toBe(surface.detail!.post_sd[0]);
    const view = surfaceCellView(surface, selectionOf(surface), 'ready');
    expect(view).toMatchObject({ state: 'values' });
    if (view?.state !== 'values') throw new Error('expected values');
    expect(view.cell.post_mean).toBe(surface.detail!.post_mean[0]);
    expect(view.cell.post_sd).toBe(surface.detail!.post_sd[0]);
    expect(view.cell.q975).toBe(surface.detail!.q975[0]);
    expect(view.cell.h3_index).toBe(CELL);
    expect(view).not.toHaveProperty('provisional');
  });

  it('drops a selection of another artifact or of a failed detail tier', () => {
    const surface = columnarSurface(cells, { withDetail: true });
    expect(
      surfaceCellView(
        surface,
        { artifactKey: 'other:v3:map-2026-08', kind: 'surface', row: 0 },
        'ready',
      ),
    ).toBeNull();
    expect(
      surfaceCellView(
        surface,
        { artifactKey: surface.artifactKey, kind: 'surface', row: 0 },
        'invalid',
      ),
    ).toBeNull();
    expect(
      surfaceCellView(
        null,
        { artifactKey: surface.artifactKey, kind: 'surface', row: 0 },
        'ready',
      ),
    ).toBeNull();
    expect(
      surfaceCellView(
        surface,
        { artifactKey: surface.artifactKey, kind: 'surface', row: 9 },
        'ready',
      ),
    ).toBeNull();
  });
});

describe('provisional render values (spec §B.2, amended 2026-10-13)', () => {
  it('prints the float32 render values, marked, while the detail tier loads', () => {
    const surface = columnarSurface(straddling);
    const view = surfaceCellView(surface, selectionOf(surface), 'loading');
    if (view?.state !== 'loading') throw new Error('expected loading');
    expect(provisionalPercent(view.provisional.post_mean)).toBe('≈10.01%');
    expect(provisionalPercent(view.provisional.post_sd)).toBe('≈2.35%');
  });

  it('keeps the provisional values when the detail tier is unavailable', () => {
    const surface = columnarSurface(straddling);
    const view = surfaceCellView(surface, selectionOf(surface), 'unavailable');
    if (view?.state !== 'unavailable') throw new Error('expected unavailable');
    expect(provisionalPercent(view.provisional.post_mean)).toBe('≈10.01%');
    expect(provisionalPercent(view.provisional.post_sd)).toBe('≈2.35%');
  });

  it('keeps the provisional values when ready is reported before the tier is attached', () => {
    const surface = columnarSurface(straddling);
    const view = surfaceCellView(surface, selectionOf(surface), 'ready');
    if (view?.state !== 'loading') throw new Error('expected loading');
    expect(provisionalPercent(view.provisional.post_mean)).toBe('≈10.01%');
  });

  it('prints the float64 detail values, unmarked, once the tier is ready', () => {
    const surface = columnarSurface(straddling, { withDetail: true });
    const view = surfaceCellView(surface, selectionOf(surface), 'ready');
    if (view?.state !== 'values') throw new Error('expected values');
    expect(percent(view.cell.post_mean)).toBe('10.02%');
    expect(percent(view.cell.post_sd)).toBe('2.34%');
  });

  it('always marks a provisional value, zero included', () => {
    const surface = columnarSurface([
      { h3: CELL, post_mean: 0, post_sd: 0, support: 'observed' },
    ]);
    const view = surfaceCellView(surface, selectionOf(surface), 'loading');
    if (view?.state !== 'loading') throw new Error('expected loading');
    expect(provisionalPercent(view.provisional.post_mean)).toBe('≈0.00%');
    expect(provisionalPercent(view.provisional.post_sd)).toBe('≈0.00%');
  });

  it('cannot hand a provisional value to the exact formatter', () => {
    const surface = columnarSurface(straddling);
    const view = surfaceCellView(surface, selectionOf(surface), 'loading');
    if (view?.state !== 'loading') throw new Error('expected loading');
    // `npm run check` type-checks this file: the directive fails the build if a render-tier value
    // ever becomes a plain number that `percent` accepts.
    // @ts-expect-error A ProvisionalValue is opaque, not a number.
    const unmarked = percent(view.provisional.post_mean);
    // Forced past the type system, it still prints no plausible number.
    expect(unmarked).toBe('NaN%');
    expect(Object.keys(view.provisional.post_mean)).toEqual([]);
  });

  it.each(SUPPORT_CODES)(
    'shows a provisional mean and SD for %s cells, as the exact view shows both',
    (support: Support) => {
      const loading = columnarSurface([
        { h3: CELL, post_mean: 0.25, post_sd: 0.05, support },
      ]);
      const loaded = columnarSurface(
        [{ h3: CELL, post_mean: 0.25, post_sd: 0.05, support }],
        { withDetail: true },
      );
      const provisional = surfaceCellView(
        loading,
        selectionOf(loading),
        'loading',
      );
      const exact = surfaceCellView(loaded, selectionOf(loaded), 'ready');
      if (provisional?.state !== 'loading' || exact?.state !== 'values')
        throw new Error('expected a provisional and an exact view');
      expect(provisional.support).toBe(support);
      expect(exact.support).toBe(support);
      expect(percent(exact.cell.post_mean)).toBe('25.00%');
      expect(percent(exact.cell.post_sd)).toBe('5.00%');
      expect(provisionalPercent(provisional.provisional.post_mean)).toBe(
        '≈25.00%',
      );
      expect(provisionalPercent(provisional.provisional.post_sd)).toBe(
        '≈5.00%',
      );
    },
  );
});
