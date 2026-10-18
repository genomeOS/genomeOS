/** Enable/disable rules of the physical-terrain controls (Atlas design §11, interaction design
 * §5.2; terrain draping design, "How existing features behave" (#483)). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AtlasCatalog } from '../src/atlas/contracts';
import {
  BASEMAP_IDS,
  TERRAIN_IDS,
  RELIEF_RANGE,
  RELIEF_STEP,
  dayNightControl,
  effectiveRelief,
  reliefControl,
  resolveDrapedView,
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

/** The map controls for `query`, with `applied` the terrain the scene has on the globe. */
function mapControls(query: string, applied?: TerrainId): string {
  const { state } = parseExplorerState(query, catalog);
  return renderToStaticMarkup(
    createElement(
      EscapeStackProvider,
      null,
      createElement(MapStyleControls, {
        appliedTerrain: applied ?? state.terrain,
        capabilities: {
          basemaps: allAvailable(BASEMAP_IDS),
          terrains: allAvailable(TERRAIN_IDS),
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

/** The inferred-surface controls for `query`, with `draped` the scene's draped rule (#483). */
function surfaceControls(query: string, draped: boolean): string {
  const { state } = parseExplorerState(query, catalog);
  return renderToStaticMarkup(
    createElement(
      EscapeStackProvider,
      null,
      createElement(InferredSurfaceControls, {
        disabled: false,
        draped,
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

  it('follows the terrain on the globe, not the one requested (#483 review)', () => {
    // World Terrain still loading, failed, or not loadable without an ion token: the smooth
    // globe stays on, lit by the sun, so day/night applies and there is no relief to raise.
    const html = mapControls('?terrain=world-terrain', 'smooth-globe');
    expect(tagWithId(html, 'atlas-day-night-lighting')).not.toContain(
      'disabled=""',
    );
    expect(html).not.toContain('fixed light from the north-west');
    // The relief slider, in the chooser, is told both terrains.
    const relief = renderToStaticMarkup(
      createElement(ReliefControl, {
        disabled: false,
        relief: 3,
        requested: 'world-terrain',
        terrain: 'smooth-globe',
        view: 'globe',
        onRelief: noop,
      }),
    );
    expect(tagWithId(relief, 'atlas-relief')).toContain('disabled=""');
    expect(relief).toContain(
      'World Terrain has not loaded, so there is no relief to raise.',
    );
    expect(relief).not.toMatch(/hide map data on high ground/);
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
    ).toBe('Choose World Terrain to raise the relief.');
    expect(
      reliefControl({
        relief: 1,
        requested: 'world-terrain',
        terrain: 'smooth-globe',
        view: 'globe',
      }).note,
    ).toBe('World Terrain has not loaded, so there is no relief to raise.');
    expect(
      reliefControl({ relief: 1, terrain: 'world-terrain', view: 'map' }).note,
    ).toMatch(/2D map/);
  });

  it('warns that World Terrain can hide map data wherever its height is drawn, even at 1×', () => {
    // #483 point 3: at true scale the terrain already buries the 650 m surface in the Ethiopian
    // highlands and the Himalaya; raised relief buries more.
    const warning =
      'World Terrain can hide map data on high ground, and raised relief hides more.';
    for (const [relief, view] of [
      [1, 'globe'],
      [3, 'globe'],
      [1, 'perspective'],
    ] as const)
      expect(
        reliefControl({ relief, terrain: 'world-terrain', view }).warning,
      ).toBe(warning);
    // The smooth globe has no height, and the 2D map draws none.
    for (const [relief, terrain, view] of [
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

  it('renders a labelled "Physical relief ×" slider over its range', () => {
    const html = relief('world-terrain', 'globe', 2.5);
    expect(html).toMatch(
      /<label[^>]*for="atlas-relief"[^>]*>Physical relief ×</,
    );
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

  it('announces the warning and describes the slider with it', () => {
    const html = relief('world-terrain', 'globe', 1);
    expect(tagWithId(html, 'atlas-relief')).toContain(
      'aria-describedby="atlas-relief-help atlas-relief-warning"',
    );
    // A live region that is always present, so the warning is announced when it appears.
    expect(html).toMatch(
      /<div role="status"[^>]*><p[^>]*id="atlas-relief-warning"[^>]*>World Terrain can hide map data/,
    );
    expect(relief('smooth-globe', 'globe', 1)).toMatch(
      /<div role="status"[^>]*><\/div>/,
    );
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
    const html = surfaceControls('?elevation=true', false);
    expect(html).toContain('aria-label="Data height exaggeration"');
    expect(html).toContain('× data height');
    expect(html).toMatch(/not the ground/);
    expect(html).toMatch(/Physical relief ×/);
  });
});

describe('draped view (#483)', () => {
  it('forces data elevation to 0 and draws columns as hexagons while draped', () => {
    expect(
      resolveDrapedView({
        draped: true,
        elevation: true,
        exaggeration: 3,
        geometry: 'extruded',
        view: 'globe',
      }),
    ).toEqual({
      elevationFactor: 0,
      elevationNote: 'Not available with World Terrain',
      extrudedLabel: 'Columns (smooth globe only)',
      geometry: 'hexagons',
    });
    for (const geometry of [
      'triangles',
      'hexagons',
      'honmoon',
      'honmoon-fill',
    ] as const)
      expect(
        resolveDrapedView({
          draped: true,
          elevation: false,
          exaggeration: 1,
          geometry,
          view: 'globe',
        }).geometry,
      ).toBe(geometry);
  });

  it("returns today's values on the smooth globe", () => {
    expect(
      resolveDrapedView({
        draped: false,
        elevation: true,
        exaggeration: 3,
        geometry: 'extruded',
        view: 'globe',
      }),
    ).toEqual({
      elevationFactor: 3,
      elevationNote: null,
      extrudedLabel: 'Extruded hexagons',
      geometry: 'extruded',
    });
    expect(
      resolveDrapedView({
        draped: false,
        elevation: true,
        exaggeration: 3,
        geometry: 'triangles',
        view: 'map',
      }).elevationFactor,
    ).toBe(0);
  });

  it("disables Statistical elevation with the note while keeping the URL's choice", () => {
    const html = surfaceControls(
      'elevation=true&exaggeration=2&geometry=extruded&terrain=world-terrain',
      true,
    );
    // React 19's server renderer writes `checked` and `value` after every other attribute, so
    // each tag's attributes are checked in any order.
    const checkbox = tagWithId(html, 'atlas-statistical-elevation');
    expect(checkbox).toContain('type="checkbox"');
    expect(checkbox).toContain('checked=""');
    expect(checkbox).toContain('disabled=""');
    expect(checkbox).toContain('aria-describedby="atlas-data-height-draped"');
    expect(html).toContain('Not available with World Terrain');
    expect(html).toContain(
      '<p class="atlas-control-note" id="atlas-data-height-draped">Not available with World Terrain</p>',
    );
    expect(html).toContain('>Columns (smooth globe only)</option>');
    // The URL's extruded choice stays selected, under its draped label.
    expect(html).toContain(
      '<option value="extruded" selected="">Columns (smooth globe only)</option>',
    );
    const slider = html.match(
      /<input[^>]*aria-label="Data height exaggeration"[^>]*>/,
    )?.[0];
    expect(slider).toContain('disabled=""');
    expect(slider).toContain('value="2"');
  });

  it('leaves the controls as they were on the smooth globe', () => {
    const html = surfaceControls('elevation=true&exaggeration=2', false);
    expect(html).not.toContain('Not available with World Terrain');
    expect(html).toContain('>Extruded hexagons</option>');
    expect(html).not.toMatch(/id="atlas-statistical-elevation"[^>]*disabled/);
  });
});
