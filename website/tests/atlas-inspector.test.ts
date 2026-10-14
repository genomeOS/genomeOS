import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactRef, Support } from '../src/atlas/contracts';
import { SUPPORT_CODES } from '../src/atlas/gosa/decode';
import type { SurfaceArtifact } from '../src/atlas/surface-columns';
import { HoverPreview } from '../src/components/atlas/HoverPreview';
import { InspectorPanel } from '../src/components/atlas/InspectorPanel';
import { EscapeStackProvider } from '../src/components/atlas/useEscapeStack';
import { ExplorerPanelsProvider } from '../src/components/atlas/useExplorerPanels';
import { columnarSurface } from './helpers/columnar-surface';

type Detail = 'loading' | 'ready' | 'unavailable';

const CELL = '83754efffffffff';
const artifact = {
  data_version: 'map-2026-08',
  model_version: 'v3',
  registry_version: 'fixture-registry',
} as unknown as ArtifactRef;
const loading = columnarSurface([
  { h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'prior_dominated' },
]);
const loaded = columnarSurface(
  [{ h3: CELL, post_mean: 0.5, post_sd: 0.1, support: 'prior_dominated' }],
  { withDetail: true },
);
// Each value sits just across a readout rounding boundary from its float32 rounding, so the render
// tier prints ≈10.01% and ≈2.35% while the detail tier prints 10.02% and 2.34%.
const straddling = [
  {
    h3: CELL,
    post_mean: 0.10015000001,
    post_sd: 0.02344999999,
    support: 'interpolated' as const,
  },
];
const straddlingRender = columnarSurface(straddling);
const straddlingDetail = columnarSurface(straddling, { withDetail: true });
// Neither value is exact in float32; the markup below was captured from main before #444.
const precise = columnarSurface(
  [
    {
      h3: CELL,
      post_mean: 0.123456789,
      post_sd: 0.0123456789,
      support: 'interpolated',
    },
  ],
  { withDetail: true },
);
const selection = {
  artifactKey: loading.artifactKey,
  kind: 'surface' as const,
  row: 0,
};

/** A percent readout with no "≈" in front of it. */
const UNMARKED_PERCENT = /(?<![≈\d.])\d+\.\d{2}%/;
const NUMBER = /\d+\.\d{2}%|\d+ km/;
/** Rows only the f64 detail tier can fill (spec §B.2). */
const INSPECTOR_DETAIL_ONLY = ['95% credible interval', 'Nearest measurement'];
const HOVER_DETAIL_ONLY = ['95% credible range'];

/** InspectorPanel registers on the Escape stack and the phone panel sheet. */
function inExplorer(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(
      EscapeStackProvider,
      null,
      createElement(ExplorerPanelsProvider, null, element),
    ),
  );
}

function inspector(
  surface: SurfaceArtifact = loading,
  detail: Detail = 'loading',
) {
  return inExplorer(
    createElement(InspectorPanel, {
      artifact,
      detail,
      onClose: vi.fn(),
      onRetryDetail: vi.fn(),
      selection,
      surface,
    }),
  );
}

function hover(surface: SurfaceArtifact = loading, detail: Detail = 'loading') {
  return renderToStaticMarkup(
    createElement(HoverPreview, {
      detail,
      position: { x: 1, y: 2 },
      selection,
      surface,
    }),
  );
}

/** Label → value markup for every `<dt>`/`<dd>` row; no value holds a nested `<dd>`. */
function rows(html: string): Map<string, string> {
  return new Map(
    [...html.matchAll(/<dt>([^<]*)<\/dt><dd>(.*?)<\/dd>/g)].map(
      ([, label, value]) => [label, value],
    ),
  );
}

function text(markup: string | undefined): string {
  return (markup ?? '').replace(/<[^>]+>/g, '');
}

function numbered(valueRows: Map<string, string>): string[] {
  return [...valueRows]
    .filter(([, value]) => NUMBER.test(text(value)))
    .map(([label]) => label);
}

describe('inspector cell-value states', () => {
  it('shows marked provisional values, the id and support while values load', () => {
    const html = inspector(straddlingRender);
    const values = rows(html);
    expect(text(values.get('Posterior estimate'))).toBe(
      '≈10.01% (approximate; exact value loading)',
    );
    expect(text(values.get('Uncertainty'))).toBe(
      '≈2.35% (approximate; exact value loading)',
    );
    // The marker is visible; only the note is for assistive technology.
    expect(values.get('Posterior estimate')).toBe(
      '≈10.01%<span class="visually-hidden"> (approximate; exact value loading)</span>',
    );
    expect(values.get('95% credible interval')).toBe('Loading…');
    expect(values.get('Nearest measurement')).toBe('Loading…');
    expect(text(values.get('Cell values'))).toBe('Loading cell values…');
    expect(values.get('Cell values')).toContain('role="status"');
    expect(values.get('Evidence support')).toBe('interpolated');
    expect(values.get('Cell ID')).toBe(CELL);
    expect(html).not.toMatch(UNMARKED_PERCENT);
    expect(html).not.toMatch(/\d km/);
    expect(html).not.toContain('Retry cell values');
  });

  it('keeps the provisional values beside the unavailable state and its retry', () => {
    const html = inspector(straddlingRender, 'unavailable');
    const values = rows(html);
    expect(text(values.get('Posterior estimate'))).toBe(
      '≈10.01% (approximate; exact value unavailable)',
    );
    expect(text(values.get('Uncertainty'))).toBe(
      '≈2.35% (approximate; exact value unavailable)',
    );
    expect(values.get('95% credible interval')).toBe('Unavailable');
    expect(values.get('Nearest measurement')).toBe('Unavailable');
    expect(text(values.get('Cell values'))).toBe(
      'Cell values unavailableRetry cell values',
    );
    expect(html).not.toMatch(UNMARKED_PERCENT);
    expect(html).not.toContain('Loading');
  });

  it('prints every value from the detail tier once loaded', () => {
    const html = inspector(loaded, 'ready');
    expect(html).toContain('Posterior estimate');
    expect(html).toContain('50.00%');
    expect(html).toContain('45.00%–55.00%');
    expect(html).toContain('42 km');
    expect(html).not.toContain('Loading cell values…');
  });

  it('swaps in the exact float64 values with no marker', () => {
    const values = rows(inspector(straddlingDetail, 'ready'));
    expect(values.get('Posterior estimate')).toBe('10.02%');
    expect(values.get('Uncertainty')).toBe('2.34%');
  });

  it('prints exactly the pre-provisional markup once loaded', () => {
    const html = inspector(precise, 'ready');
    expect(html).toContain(
      '<dl><div><dt>Posterior estimate</dt><dd>12.35%</dd></div><div><dt>95% credible interval</dt><dd>7.35%–17.35%</dd></div><div><dt>Uncertainty</dt><dd>1.23%</dd></div><div><dt>Evidence support</dt><dd>interpolated</dd></div><div><dt>Nearest measurement</dt><dd>42 km</dd></div><div><dt>Cell ID</dt><dd>83754efffffffff</dd></div><div><dt>Google Maps</dt>',
    );
    expect(html).not.toContain('≈');
    expect(html).not.toContain('Loading');
    expect(html).not.toContain('Unavailable');
    expect(html).not.toContain('visually-hidden');
  });

  it.each(SUPPORT_CODES)(
    'shows a provisional number for %s cells exactly where the exact view shows one',
    (support: Support) => {
      const cell = { h3: CELL, post_mean: 0.25, post_sd: 0.05, support };
      const exact = rows(
        inspector(columnarSurface([cell], { withDetail: true }), 'ready'),
      );
      const provisional = rows(inspector(columnarSurface([cell]), 'loading'));
      expect(numbered(provisional)).toEqual(
        numbered(exact).filter(
          (label) => !INSPECTOR_DETAIL_ONLY.includes(label),
        ),
      );
      for (const label of INSPECTOR_DETAIL_ONLY)
        if (exact.has(label)) expect(provisional.get(label)).toBe('Loading…');
      expect(text(provisional.get('Posterior estimate'))).toMatch(/^≈25\.00%/);
      expect(text(provisional.get('Uncertainty'))).toMatch(/^≈5\.00%/);
    },
  );

  it('renders nothing for a selection of another artifact', () => {
    expect(
      inExplorer(
        createElement(InspectorPanel, {
          artifact,
          detail: 'ready',
          onClose: vi.fn(),
          selection: { ...selection, artifactKey: 'other:v3:map-2026-08' },
          surface: loaded,
        }),
      ),
    ).toBe('');
  });
});

describe('hover cell-value states', () => {
  it('shows marked provisional values and the support label while values load', () => {
    const html = hover(straddlingRender);
    const values = rows(html);
    expect(values.get('Posterior')).toBe('≈10.01%');
    expect(values.get('95% credible range')).toBe('Loading…');
    expect(values.get('Uncertainty')).toBe('≈2.35%');
    expect(html).toContain('<small>interpolated</small>');
    expect(html).not.toMatch(UNMARKED_PERCENT);
  });

  it('keeps the provisional values beside the unavailable state', () => {
    const html = hover(straddlingRender, 'unavailable');
    const values = rows(html);
    expect(values.get('Posterior')).toBe('≈10.01%');
    expect(values.get('95% credible range')).toBe('Unavailable');
    expect(values.get('Uncertainty')).toBe('≈2.35%');
    expect(html).toContain('Cell values unavailable');
    expect(html).not.toMatch(UNMARKED_PERCENT);
    expect(html).not.toContain('Loading');
  });

  it('keeps today’s preview once values load', () => {
    const html = hover(loaded, 'ready');
    expect(html).toContain('Posterior');
    expect(html).toContain('50.00%');
    expect(html).toContain('95% credible range');
  });

  it('swaps in the exact float64 values with no marker', () => {
    const values = rows(hover(straddlingDetail, 'ready'));
    expect(values.get('Posterior')).toBe('10.02%');
    expect(values.get('Uncertainty')).toBe('2.34%');
  });

  it('prints exactly the pre-provisional markup once loaded', () => {
    expect(hover(precise, 'ready')).toBe(
      '<div class="atlas-hover-preview" style="--atlas-hover-x:1px;--atlas-hover-y:2px" aria-hidden="true"><span>Modeled estimate</span><dl><div><dt>Posterior</dt><dd>12.35%</dd></div><div><dt>95% credible range</dt><dd>7.35%–17.35%</dd></div><div><dt>Uncertainty</dt><dd>1.23%</dd></div></dl><small>interpolated</small></div>',
    );
  });

  it.each(SUPPORT_CODES)(
    'shows a provisional number for %s cells exactly where the exact preview shows one',
    (support: Support) => {
      const cell = { h3: CELL, post_mean: 0.25, post_sd: 0.05, support };
      const exact = rows(
        hover(columnarSurface([cell], { withDetail: true }), 'ready'),
      );
      const provisional = rows(hover(columnarSurface([cell]), 'loading'));
      expect(numbered(provisional)).toEqual(
        numbered(exact).filter((label) => !HOVER_DETAIL_ONLY.includes(label)),
      );
      for (const label of HOVER_DETAIL_ONLY)
        if (exact.has(label)) expect(provisional.get(label)).toBe('Loading…');
    },
  );
});
