import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BASEMAP_IDS,
  TERRAIN_IDS,
  type BasemapId,
  type TerrainId,
} from '../src/atlas/earth-style-catalog';
import { BrandText } from '../src/components/atlas/BrandText';
import { EarthStylePicker } from '../src/components/atlas/EarthStylePicker';
import { EscapeStackProvider } from '../src/components/atlas/useEscapeStack';

const brand = (text: string) =>
  renderToStaticMarkup(createElement(BrandText, { text }));

function allAvailable<T extends string>(ids: readonly T[]): Record<T, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true])) as Record<T, boolean>;
}

function picker(basemap: BasemapId, terrain: TerrainId): string {
  // The picker registers on the explorer's Escape stack.
  return renderToStaticMarkup(
    createElement(
      EscapeStackProvider,
      null,
      createElement(EarthStylePicker, {
        basemap,
        capabilities: {
          basemaps: allAvailable(BASEMAP_IDS),
          terrains: allAvailable(TERRAIN_IDS),
        },
        disabled: false,
        relief: 1,
        terrain,
        view: 'globe',
        onBasemap: () => {},
        onRelief: () => {},
        onTerrain: () => {},
      }),
    ),
  );
}

describe('BrandText (Atlas design §11)', () => {
  it('sets each genomeOS in the wordmark and leaves the rest as text', () => {
    expect(brand('genomeOS Dark')).toBe(
      '<span class="brand-name">genomeOS</span> Dark',
    );
    expect(brand('genomeOS')).toBe('<span class="brand-name">genomeOS</span>');
    expect(brand('Data: genomeOS and genomeOS')).toBe(
      'Data: <span class="brand-name">genomeOS</span> and ' +
        '<span class="brand-name">genomeOS</span>',
    );
    expect(brand('Smooth Globe')).toBe('Smooth Globe');
  });
});

describe('EarthStylePicker trigger (Atlas design §11)', () => {
  it('names the genomeOS Dark basemap in the wordmark', () => {
    const html = picker('dark-streets', 'smooth-globe');
    expect(html).toContain(
      '<strong><span class="brand-name">genomeOS</span> Dark</strong>',
    );
    expect(html).toContain('<small>Smooth Globe</small>');
    // The accessible name is plain text.
    expect(html).toContain('aria-label="Choose basemap and terrain"');
  });

  it('leaves other basemap labels as plain text', () => {
    expect(picker('openstreetmap', 'smooth-globe')).toContain(
      '<strong>OpenStreetMap</strong>',
    );
  });
});
