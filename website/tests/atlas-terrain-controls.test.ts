/** Enable/disable rules of the physical-terrain controls (Atlas design §11, interaction design
 * §5.2; #483). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AtlasCatalog } from '../src/atlas/contracts';
import {
  BASEMAP_IDS,
  RELIEF_RANGE,
  RELIEF_STEP,
  dayNightControl,
  effectiveRelief,
  reliefControl,
} from '../src/atlas/earth-style-catalog';
import {
  parseExplorerState,
  type ExplorerSceneMode,
  type TerrainId,
} from '../src/atlas/url-state';
import { InferredSurfaceControls } from '../src/components/atlas/InferredSurfaceControls';
import { MapStyleControls } from '../src/components/atlas/MapStyleControls';
import { ReliefControl } from '../src/components/atlas/ReliefControl';
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
        onRelief: noop,
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

describe('relief control (#483)', () => {
  it('spans true scale to tenfold in half steps', () => {
    expect(RELIEF_RANGE).toEqual([1, 10]);
    expect(RELIEF_STEP).toBe(0.5);
  });

  it.each<[TerrainId, ExplorerSceneMode, number, boolean, number]>([
    ['smooth-globe', 'globe', 3, true, 1],
    ['smooth-globe', 'perspective', 3, true, 1],
    ['world-terrain', 'map', 3, true, 1],
    ['world-terrain', 'globe', 1, false, 1],
    ['world-terrain', 'globe', 3, false, 3],
    ['world-terrain', 'perspective', 6.5, false, 6.5],
  ])(
    'with %s in %s view at %s×: disabled=%s, applied %s×',
    (terrain, view, relief, disabled, applied) => {
      const control = reliefControl({ relief, terrain, view });
      expect(control.disabled).toBe(disabled);
      expect(control.note === null).toBe(!disabled);
      expect(effectiveRelief({ relief, terrain, view })).toBe(applied);
    },
  );

  it('explains why it is off', () => {
    expect(
      reliefControl({ relief: 1, terrain: 'smooth-globe', view: 'globe' }).note,
    ).toMatch(/World Terrain/);
    expect(
      reliefControl({ relief: 1, terrain: 'world-terrain', view: 'map' }).note,
    ).toMatch(/2D map/);
  });

  it('warns only while raised relief is actually drawn', () => {
    const warning = /hide map data on high ground/;
    expect(
      reliefControl({ relief: 2, terrain: 'world-terrain', view: 'globe' })
        .warning,
    ).toMatch(warning);
    for (const [relief, terrain, view] of [
      [1, 'world-terrain', 'globe'],
      [2, 'smooth-globe', 'globe'],
      [2, 'world-terrain', 'map'],
    ] as const)
      expect(reliefControl({ relief, terrain, view }).warning).toBeNull();
  });

  function relief(terrain: TerrainId, view: ExplorerSceneMode, value: number) {
    return renderToStaticMarkup(
      createElement(ReliefControl, {
        disabled: false,
        relief: value,
        terrain,
        view,
        onRelief: noop,
      }),
    );
  }

  it('renders a labelled "Relief ×" slider over its range', () => {
    const html = relief('world-terrain', 'globe', 2.5);
    expect(html).toContain('Relief ×');
    expect(html).toContain('2.5×');
    const slider = tagWithId(html, 'atlas-relief');
    expect(slider).toContain('type="range"');
    expect(slider).toContain('min="1"');
    expect(slider).toContain('max="10"');
    expect(slider).toContain('step="0.5"');
    expect(slider).toContain('value="2.5"');
    expect(slider).not.toContain('disabled=""');
    expect(html).toMatch(/hide map data on high ground/);
  });

  it.each<[TerrainId, ExplorerSceneMode]>([
    ['smooth-globe', 'globe'],
    ['world-terrain', 'map'],
  ])('is disabled with its reason for %s in %s view', (terrain, view) => {
    const html = relief(terrain, view, 3);
    const slider = tagWithId(html, 'atlas-relief');
    expect(slider).toContain('disabled=""');
    expect(slider).toContain('aria-describedby="atlas-relief-note"');
    expect(html).not.toMatch(/hide map data on high ground/);
  });
});

describe('data elevation control wording (#483)', () => {
  it('says it scales data values, not the ground', () => {
    const { state } = parseExplorerState('?elevation=true', catalog);
    const html = renderToStaticMarkup(
      createElement(
        EscapeStackProvider,
        null,
        createElement(InferredSurfaceControls, {
          disabled: false,
          state,
          onEdgeColorMode: noop,
          onEdgeFixedColor: noop,
          onElevation: noop,
          onExaggeration: noop,
          onGeometry: noop,
          onPalette: noop,
          onSurfaceOpacity: noop,
        }),
      ),
    );
    expect(html).toContain('aria-label="Data height exaggeration"');
    expect(html).toContain('× data height');
    expect(html).toMatch(/not the ground/);
    expect(html).toMatch(/Relief ×/);
  });
});
