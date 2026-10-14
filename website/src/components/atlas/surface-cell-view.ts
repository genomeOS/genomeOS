/**
 * Which surface-cell facts the hover preview and inspector may show (Atlas
 * design §11; fast-load spec 2026-10-07 §B.2, amended 2026-10-13).
 *
 * Every exact number comes from the f64 detail tier through `cellAt`. Before
 * that tier loads, or when it is unavailable, the view carries the cell id, the
 * exact support label (from the u8 render column) and the f32 render-tier mean
 * and SD as `ProvisionalCellValues`. Those values are opaque: the only way to
 * print one is `provisionalPercent`, which always adds the "≈" marker, so a
 * render-tier number cannot be shown as an exact one.
 */

import type { Support, SurfaceCell } from '../../atlas/contracts';
import {
  cellAt,
  renderAt,
  type RenderCell,
  type SurfaceArtifact,
} from '../../atlas/surface-columns';

export type DetailStatus = 'loading' | 'ready' | 'unavailable' | 'invalid';

export interface SurfaceSelection {
  kind: 'surface';
  artifactKey: string;
  row: number;
}

const RENDER_TIER_VALUE = Symbol('render-tier value');

/**
 * One f32 render-tier number. It has no `number` field, so neither `percent` nor
 * JSX accepts it; `provisionalPercent` is the one formatter that can read it.
 */
export interface ProvisionalValue {
  readonly [RENDER_TIER_VALUE]: number;
}

/** The render tier's mean and SD for one cell, shown only until `cellAt` can supply the exact ones. */
export interface ProvisionalCellValues {
  readonly post_mean: ProvisionalValue;
  readonly post_sd: ProvisionalValue;
}

/** The two states in which a cell shows provisional values. */
export type ProvisionalState = 'loading' | 'unavailable';

export type SurfaceCellView =
  | { state: 'values'; h3Index: string; support: Support; cell: SurfaceCell }
  | {
      state: ProvisionalState;
      h3Index: string;
      support: Support;
      provisional: ProvisionalCellValues;
    };

export const LOADING_CELL_VALUES = 'Loading cell values…';
export const CELL_VALUES_UNAVAILABLE = 'Cell values unavailable';
export const RETRY_CELL_VALUES = 'Retry cell values';

/** What a detail-only row (credible interval, nearest measurement) shows until the exact values arrive. */
export const DETAIL_ONLY_TEXT: Readonly<Record<ProvisionalState, string>> = {
  loading: 'Loading…',
  unavailable: 'Unavailable',
};

/** The accessible note that follows each provisional value in the inspector. */
export const PROVISIONAL_NOTE: Readonly<Record<ProvisionalState, string>> = {
  loading: 'approximate; exact value loading',
  unavailable: 'approximate; exact value unavailable',
};

const APPROXIMATE_MARKER = '≈';

/** The one readout format for a fraction: percent with two decimals. */
export function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** A render-tier value in the exact readout format, always behind the "≈" marker. */
export function provisionalPercent(value: ProvisionalValue): string {
  return `${APPROXIMATE_MARKER}${percent(value[RENDER_TIER_VALUE])}`;
}

function provisionalValues(render: RenderCell): ProvisionalCellValues {
  return {
    post_mean: { [RENDER_TIER_VALUE]: render.post_mean },
    post_sd: { [RENDER_TIER_VALUE]: render.post_sd },
  };
}

export function surfaceCellView(
  surface: SurfaceArtifact | null,
  selection: SurfaceSelection,
  detail: DetailStatus,
): SurfaceCellView | null {
  if (
    !surface ||
    surface.artifactKey !== selection.artifactKey ||
    detail === 'invalid' ||
    !Number.isInteger(selection.row) ||
    selection.row < 0 ||
    selection.row >= surface.grid.n
  )
    return null;
  const render = renderAt(surface, selection.row);
  if (detail === 'ready' && surface.detail)
    return {
      cell: cellAt(surface, selection.row),
      h3Index: render.h3,
      state: 'values',
      support: render.support,
    };
  return {
    h3Index: render.h3,
    provisional: provisionalValues(render),
    state: detail === 'unavailable' ? 'unavailable' : 'loading',
    support: render.support,
  };
}
