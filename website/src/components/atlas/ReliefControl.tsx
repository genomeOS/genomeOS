/**
 * The physical-terrain "Physical relief ×" slider, under the terrain choices of the basemap and terrain
 * chooser, for Atlas design §11 and interaction design §5.2 (#483).
 *
 * Relief exaggerates the ground only. Interaction design §5.2 keeps physical terrain and
 * scientific elevation as separate controls; the data's own height is Statistical elevation,
 * under Inferred surface. The slider stays visible when it does not apply (smooth globe, flat
 * 2D map), disabled with the reason.
 */

import {
  RELIEF_RANGE,
  RELIEF_STEP,
  reliefControl,
  type TerrainId,
} from '../../atlas/earth-style-catalog';
import type { ExplorerSceneMode } from '../../atlas/url-state';

interface ReliefControlProps {
  disabled: boolean;
  relief: number;
  /** The terrain on the globe: a requested terrain this build cannot load counts as smooth. */
  terrain: TerrainId;
  view: ExplorerSceneMode;
  onRelief: (value: number) => void;
}

export function ReliefControl({
  disabled,
  relief,
  terrain,
  view,
  onRelief,
}: ReliefControlProps) {
  const control = reliefControl({ relief, terrain, view });
  const describedBy = [
    control.note ? 'atlas-relief-note' : 'atlas-relief-help',
    ...(control.warning ? ['atlas-relief-warning'] : []),
  ].join(' ');
  return (
    <div className="atlas-relief">
      <div className="atlas-relief__title">
        <label htmlFor="atlas-relief">Physical relief ×</label>
        <span>{relief.toFixed(1)}×</span>
      </div>
      <input
        id="atlas-relief"
        type="range"
        min={RELIEF_RANGE[0]}
        max={RELIEF_RANGE[1]}
        step={RELIEF_STEP}
        value={relief}
        disabled={disabled || control.disabled}
        aria-describedby={describedBy}
        aria-valuetext={`${relief}× relief`}
        onChange={(event) => onRelief(Number(event.target.value))}
      />
      {control.note ? (
        <p className="atlas-control-note" id="atlas-relief-note">
          {control.note}
        </p>
      ) : (
        <p className="atlas-control-note" id="atlas-relief-help">
          Exaggerates the ground only, never the data.
        </p>
      )}
      {/* Always present, so a screen reader announces the warning when it appears. */}
      <div role="status">
        {control.warning && (
          <p
            className="atlas-control-note atlas-control-note--warning"
            id="atlas-relief-warning"
          >
            {control.warning}
          </p>
        )}
      </div>
    </div>
  );
}
