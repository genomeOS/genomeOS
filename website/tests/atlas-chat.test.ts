import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  actionSchema,
  comparisonLink,
  proposedStates,
  type ChatAction,
} from '../src/atlas/chat-actions';
import { atlasCatalogSchema } from '../src/atlas/contracts';
import {
  parseExplorerState,
  serializeExplorerState,
} from '../src/atlas/url-state';
import { comparisonQueries } from '../src/atlas/comparison';

const catalog = atlasCatalogSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../public/data/atlas/catalog.json', import.meta.url),
      'utf8',
    ),
  ),
);
const state = parseExplorerState('', catalog).state;
const revision = 'a'.repeat(64);
function action(changes: Partial<ChatAction> = {}): ChatAction {
  return {
    id: 'd5f88918-fd97-44ad-ab34-042a14e76936',
    catalog_revision: revision,
    state_token: serializeExplorerState(state),
    operation: 'view',
    selections: [{ id: 'hbs-rs334', version: 'v3/map-2026-08' }],
    metric: 'post_sd',
    layers: ['surface', 'support'],
    region: 'west-africa',
    ...changes,
  };
}
describe('published map assistant', () => {
  it('keeps uncertainty and masks and round trips without mutating the previous view', () => {
    const before = serializeExplorerState(state);
    const [next] = proposedStates(action(), state, catalog, revision);
    expect(next.metric).toBe('post_sd');
    expect(next.layers.support).toBe(true);
    expect(next.camera.lon).toBe(-5);
    expect(
      parseExplorerState(serializeExplorerState(next), catalog).corrections,
    ).toEqual([]);
    expect(serializeExplorerState(state)).toBe(before);
  });
  it('rejects stale states, revisions, unavailable IDs and versions and hidden support', () => {
    for (const changes of [
      { state_token: 'stale' },
      { catalog_revision: 'b'.repeat(64) },
      { selections: [{ id: 'alphaearth', version: 'v1/candidate' }] },
      { selections: [{ id: 'hbs-rs334', version: 'v99/missing' }] },
      { layers: ['surface'] },
    ] as Partial<ChatAction>[])
      expect(() =>
        proposedStates(action(changes), state, catalog, revision),
      ).toThrow();
  });
  it('preserves each comparison selection and independent exact versions in the URL', () => {
    const states = proposedStates(
      action({
        operation: 'compare',
        selections: [
          { id: 'hbs-rs334', version: 'v3/map-2026-08' },
          { id: 'g6pd-deficiency', version: 'v3/map-2026-08' },
        ],
      }),
      state,
      catalog,
      revision,
    );
    const url = new URL(comparisonLink(states, '/'), 'https://genome-os.org');
    const queries = comparisonQueries(url.search)!;
    expect(parseExplorerState(queries.left, catalog).state.entityId).toBe(
      'hbs-rs334',
    );
    expect(parseExplorerState(queries.right, catalog).state.entityId).toBe(
      'g6pd-deficiency',
    );
  });
  it('rejects extra executable content and arbitrary coordinates', () => {
    expect(() =>
      actionSchema.parse({ ...action(), sql: 'DELETE FROM observations' }),
    ).toThrow();
    expect(() =>
      actionSchema.parse({ ...action(), region: { lon: 1, lat: 2 } }),
    ).toThrow();
  });
});
