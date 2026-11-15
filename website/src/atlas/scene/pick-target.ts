/**
 * What a pick may resolve against (Atlas design §11; spec 2026-10-07 §B.6.6; #453; terrain
 * draping design, "Picking", #483): the displayed artifact, or before any is displayed the cold
 * reveal's, with the rows its layers draw and its observations. A hover resolves on the CPU (owner
 * decision 2026-11-14 on #483; §B.6.6 as amended that day), so a row counts as drawn only once
 * its chunk is added, as a click needs a surface chunk under the pointer, and the hover tests
 * those observations, so an incoming group, built shown at alpha 0 during a swap, never answers
 * for the displayed one. The incoming groups of an unfinished swap are listed for the translucent
 * depth pick to hide, since depth is written whatever the alpha.
 */

import type { PrimitiveCollection } from 'cesium';

import { isSupportedCode } from '../geometry/support-codes';
import type { SurfaceArtifact } from '../surface-columns';
import type { LayerVisibility } from '../url-state';
import type { ObservationPrimitiveGroup } from './observation-layer';
import { isDrapedGroup, type AnySurfaceGroup } from './surface-groups';
import type { PickTarget } from './surface-pick';

/** An artifact's groups as the scientific layers hold them. */
interface PickGroups {
  artifactKey: string;
  group: AnySurfaceGroup | null;
  observationGroup: ObservationPrimitiveGroup | null;
}

export interface PickTargetSources {
  displayed: (PickGroups & { surface: SurfaceArtifact }) | null;
  /** The newest request's groups, displayed or incoming. */
  epoch: Omit<PickGroups, 'artifactKey'> | null;
  /** The cold epoch being revealed, picked until it commits or is discarded. */
  revealing: { epoch: PickGroups; surface: SurfaceArtifact | null } | null;
  /** Whether a group draws: shown, at alpha > 0. */
  shown(group: AnySurfaceGroup): boolean;
  /** The reveal wave's progress; a draped group draws once its fade has drawn a frame. */
  waveProgress(): number;
  layers(): LayerVisibility;
}

/**
 * Whether the layers draw `row` at call time: its cell layer is on and the group shown, a chunk
 * group has added the chunk carrying it (a cold reveal's group is shown at opacity 1 before any
 * chunk arrives), and a draped group's fade has drawn a frame.
 */
function drawnRows(
  sources: PickTargetSources,
  group: () => AnySurfaceGroup | null,
  surface: SurfaceArtifact,
) {
  return (row: number): boolean => {
    const live = group();
    if (!live || !sources.shown(live)) return false;
    if (isDrapedGroup(live) ? sources.waveProgress() <= 0 : !live.carries(row))
      return false;
    const layers = sources.layers();
    return isSupportedCode(surface.support[row])
      ? layers.surface
      : layers.support;
  };
}

export function pickTargetOf(sources: PickTargetSources): PickTarget | null {
  const { displayed, epoch, revealing } = sources;
  if (displayed) {
    // The incoming groups sit at opacity 0, but a translucent depth pick writes depth
    // whatever the alpha, so both are hidden for that pass (§B.6.6).
    const hidden: PrimitiveCollection[] = [];
    const incoming = epoch?.group;
    // Draped imagery writes no depth of its own.
    if (incoming && incoming !== displayed.group && !isDrapedGroup(incoming))
      hidden.push(incoming.collection);
    const incomingObservations = epoch?.observationGroup;
    if (
      incomingObservations &&
      incomingObservations !== displayed.observationGroup
    )
      hidden.push(incomingObservations.collection);
    return {
      artifactKey: displayed.artifactKey,
      draped: isDrapedGroup(displayed.group),
      drawn: drawnRows(sources, () => displayed.group, displayed.surface),
      hidden,
      observations: displayed.observationGroup,
      surface: displayed.surface,
    };
  }
  return revealing?.surface
    ? {
        artifactKey: revealing.epoch.artifactKey,
        draped: isDrapedGroup(revealing.epoch.group),
        drawn: drawnRows(
          sources,
          () => revealing.epoch.group,
          revealing.surface,
        ),
        hidden: [],
        observations: revealing.epoch.observationGroup,
        surface: revealing.surface,
      }
    : null;
}
