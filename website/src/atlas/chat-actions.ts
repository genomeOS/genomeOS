/** Validated reversible view proposals; Atlas design §§11, 13, 16. */

import { z } from 'zod';
import type { AtlasCatalog } from './contracts';
import { comparisonSearch, sameNavigation } from './comparison';
import { serializeExplorerState, type ExplorerState } from './url-state';
import { defaultPalette } from './visual-encoding';

const selection = z.strictObject({ id: z.string(), version: z.string() });
export const actionSchema = z.strictObject({
  id: z.uuid(),
  catalog_revision: z.string().regex(/^[a-f0-9]{64}$/),
  state_token: z.string().max(8000),
  operation: z.enum(['view', 'compare']),
  selections: z.array(selection).min(1).max(2),
  metric: z.enum(['post_mean', 'post_sd']),
  layers: z
    .array(
      z.enum(['surface', 'observations', 'support', 'context', 'countries']),
    )
    .max(5),
  region: z.enum(['current', 'world', 'west-africa']),
});
export const responseSchema = z.strictObject({
  catalog_revision: z.string(),
  answer: z.string().max(20000),
  sources: z
    .array(
      z.strictObject({
        label: z.string(),
        url: z.url().refine((url) => url.startsWith('https://')),
      }),
    )
    .max(20),
  action: actionSchema.nullable(),
});
export type ChatAction = z.infer<typeof actionSchema>;

/** Camera feedback is rounded by Cesium; scientific identity and display options remain exact. */
export function sameAppliedView(
  expected: ExplorerState,
  actual: ExplorerState,
): boolean {
  return (
    sameNavigation(expected, actual) &&
    serializeExplorerState(expected) ===
      serializeExplorerState({ ...actual, camera: expected.camera })
  );
}

export function proposedStates(
  action: ChatAction,
  state: ExplorerState,
  catalog: AtlasCatalog,
  revision: string,
): ExplorerState[] {
  actionSchema.parse(action);
  if (
    action.catalog_revision !== revision ||
    action.state_token !== serializeExplorerState(state)
  )
    throw new Error(
      'The map changed while the assistant was responding. Ask again.',
    );
  const count = action.operation === 'compare' ? 2 : 1;
  if (
    action.selections.length !== count ||
    new Set(action.selections.map((item) => item.id)).size !== count ||
    !action.layers.includes('support')
  )
    throw new Error('Invalid map proposal.');
  return action.selections.map((item) => {
    const ref = catalog.artifacts.find((ref) => ref.id === item.id);
    if (!ref || `${ref.model_version}/${ref.data_version}` !== item.version)
      throw new Error('Requested map or version is unavailable.');
    if (action.layers.includes('observations') && !ref.observations_available)
      throw new Error('Measured observations are unavailable.');
    // Display camera positions are never sampling coordinates or scientific metadata.
    const camera =
      action.region === 'current'
        ? state.camera
        : {
            lon: action.region === 'world' ? 20 : -5,
            lat: 12,
            height: action.region === 'world' ? 18_000_000 : 5_000_000,
            heading: 0,
            pitch: -90,
          };
    return {
      ...state,
      entityId: item.id,
      artifactVersion: item.version,
      metric: action.metric,
      paletteMode: 'metric-default',
      surfacePalette: defaultPalette(action.metric),
      camera,
      layers: Object.fromEntries(
        Object.keys(state.layers).map((key) => [
          key,
          action.layers.includes(key as (typeof action.layers)[number]),
        ]),
      ) as ExplorerState['layers'],
    };
  });
}

export function comparisonLink(states: ExplorerState[], base: string): string {
  return `${base.replace(/\/$/, '')}/app/compare/?${comparisonSearch(serializeExplorerState(states[0]), serializeExplorerState(states[1]))}`;
}
