/** Enable/disable rules of the physical-terrain controls (Atlas design §11, interaction design
 * §5.2; #483). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AtlasCatalog } from '../src/atlas/contracts';
import { BASEMAP_IDS, dayNightControl } from '../src/atlas/earth-style-catalog';
import { parseExplorerState, type TerrainId } from '../src/atlas/url-state';
import { MapStyleControls } from '../src/components/atlas/MapStyleControls';
import { EscapeStackProvider } from '../src/components/atlas/useEscapeStack';

const catalog = {
  artifacts: [
    { data_version: 'map-2026-08', id: 'hbs-rs334', model_version: 'v1' },
  ],
} as AtlasCatalog;

function allAvailable<T extends string>(ids: readonly T[]): Record<T, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true])) as Record<T, boolean>;
}

const noop = () => {};

function mapControls(query: string, ion = true): string {
  const { state } = parseExplorerState(query, catalog);
  return renderToStaticMarkup(
    createElement(
      EscapeStackProvider,
      null,
      createElement(MapStyleControls, {
        capabilities: {
          basemaps: allAvailable(BASEMAP_IDS),
          terrains: { 'smooth-globe': true, 'world-terrain': ion },
        },
        disabled: false,
        state,
        onBasemap: noop,
        onBasemapBrightness: noop,
        onBasemapOpacity: noop,
        onCountryBorderColor: noop,
        onCountryBorderOpacity: noop,
        onDayNightLighting: noop,
        onEarthOpacity: noop,
        onOceanColor: noop,
        onTerrain: noop,
        onView: noop,
      }),
    ),
  );
}

/** The opening tag of the element with this id. */
function tagWithId(html: string, id: string): string {
  const match = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
  if (!match) throw new Error(`no element #${id}`);
  return match[0];
}

describe('day/night control (#483)', () => {
  it('applies to the smooth globe only', () => {
    expect(dayNightControl('smooth-globe')).toEqual({
      disabled: false,
      note: null,
    });
    const terrain = dayNightControl('world-terrain');
    expect(terrain.disabled).toBe(true);
    expect(terrain.note).toMatch(/fixed light from the north-west/);
  });

  it.each<[TerrainId, boolean]>([
    ['smooth-globe', false],
    ['world-terrain', true],
  ])(
    'with %s, the checkbox is shown and disabled=%s, with its reason',
    (terrain, disabled) => {
      const html = mapControls(`?terrain=${terrain}&dayNight=true`);
      const checkbox = tagWithId(html, 'atlas-day-night-lighting');
      expect(checkbox.includes('disabled=""')).toBe(disabled);
      expect(html.includes('fixed light from the north-west')).toBe(disabled);
      if (disabled)
        expect(checkbox).toContain(
          'aria-describedby="atlas-day-night-lighting-note"',
        );
    },
  );

  it('still applies when this build cannot load the requested World Terrain', () => {
    // No ion token: the smooth globe stays on, lit by the sun.
    const html = mapControls('?terrain=world-terrain', false);
    expect(tagWithId(html, 'atlas-day-night-lighting')).not.toContain(
      'disabled=""',
    );
  });
});
