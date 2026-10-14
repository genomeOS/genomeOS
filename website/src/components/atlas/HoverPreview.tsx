/**
 * Compact evidence preview for Atlas design §11. Surface values follow fast-load
 * spec 2026-10-07 §B.2 (amended 2026-10-13): marked render-tier values until the
 * detail tier loads, then the exact values.
 */

import type { CSSProperties } from 'react';

import type { ObservationColorEncoding } from '../../atlas/observation-encoding';
import type { ObservationPlaceContext } from '../../atlas/place-context';
import type { SurfaceArtifact } from '../../atlas/surface-columns';
import {
  evidenceSupportLabel,
  type InspectorSelection,
} from './InspectorPanel';
import {
  CELL_VALUES_UNAVAILABLE,
  DETAIL_ONLY_TEXT,
  percent,
  provisionalPercent,
  surfaceCellView,
  type DetailStatus,
} from './surface-cell-view';

interface HoverPreviewProps {
  colorEncoding?: ObservationColorEncoding | null;
  detail?: DetailStatus;
  placeContext?: ObservationPlaceContext | null;
  position: { x: number; y: number };
  selection: InspectorSelection;
  surface?: SurfaceArtifact | null;
}

function encodedValue(encoding: ObservationColorEncoding): string {
  if (
    encoding.label === 'Observed frequency' &&
    typeof encoding.value === 'number'
  )
    return percent(encoding.value);
  if (typeof encoding.value === 'number')
    return encoding.value.toLocaleString();
  return encoding.value ?? '';
}

export function HoverPreview({
  colorEncoding,
  detail = 'loading',
  placeContext,
  position,
  selection,
  surface = null,
}: HoverPreviewProps) {
  const style = {
    '--atlas-hover-x': `${position.x}px`,
    '--atlas-hover-y': `${position.y}px`,
  } as CSSProperties;

  if (selection.kind === 'surface') {
    const view = surfaceCellView(surface, selection, detail);
    if (!view) return null;
    return (
      <div className="atlas-hover-preview" style={style} aria-hidden="true">
        <span>Modeled estimate</span>
        {view.state === 'values' ? (
          <dl>
            <div>
              <dt>Posterior</dt>
              <dd>{percent(view.cell.post_mean)}</dd>
            </div>
            <div>
              <dt>95% credible range</dt>
              <dd>
                {percent(view.cell.q025)}–{percent(view.cell.q975)}
              </dd>
            </div>
            <div>
              <dt>Uncertainty</dt>
              <dd>{percent(view.cell.post_sd)}</dd>
            </div>
          </dl>
        ) : (
          <>
            <dl>
              <div>
                <dt>Posterior</dt>
                <dd>{provisionalPercent(view.provisional.post_mean)}</dd>
              </div>
              <div>
                <dt>95% credible range</dt>
                <dd>{DETAIL_ONLY_TEXT[view.state]}</dd>
              </div>
              <div>
                <dt>Uncertainty</dt>
                <dd>{provisionalPercent(view.provisional.post_sd)}</dd>
              </div>
            </dl>
            {view.state === 'unavailable' && (
              <strong>{CELL_VALUES_UNAVAILABLE}</strong>
            )}
          </>
        )}
        <small>{evidenceSupportLabel(view.support)}</small>
      </div>
    );
  }

  const observation = selection.value;
  return (
    <div className="atlas-hover-preview" style={style} aria-hidden="true">
      <span>Measured observation</span>
      <strong>{observation.population_label}</strong>
      {placeContext && (
        <small
          className="atlas-observation-place"
          title={`Nearby mapped place · ${placeContext.revision}`}
        >
          {placeContext.name}
          {placeContext.region ? ` · ${placeContext.region}` : ''}
        </small>
      )}
      {colorEncoding?.label && (
        <div className="atlas-observation-color-key">
          <span
            className="atlas-observation-color-key__swatch"
            data-observation-color={colorEncoding.color}
            style={{ backgroundColor: colorEncoding.color }}
          />
          <span>{colorEncoding.label}</span>
          <strong>{encodedValue(colorEncoding)}</strong>
        </div>
      )}
      <dl>
        <div>
          <dt>Measured frequency</dt>
          <dd>{percent(observation.ac / observation.an)}</dd>
        </div>
        <div>
          <dt>Allele count</dt>
          <dd>
            {observation.ac}/{observation.an}
          </dd>
        </div>
        <div>
          <dt>Sampling radius</dt>
          <dd>{observation.radius_km.toFixed(1)} km</dd>
        </div>
      </dl>
    </div>
  );
}
