import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BASEMAP_OPTIONS,
  TERRAIN_OPTIONS,
} from '../src/atlas/earth-style-catalog';

describe('Cesium static runtime', () => {
  // CESIUM_BASE_URL serves these to the engine: sky box and terrain-height assets, the ion
  // credit logo, web workers and their third-party decoders.
  it.each(['Assets', 'ThirdParty', 'Workers'])(
    'copies %s into the production build',
    (directory) => {
      expect(existsSync(resolve('dist/cesium', directory))).toBe(true);
    },
  );

  it('copies every Earth style picker thumbnail', () => {
    const missing = [...BASEMAP_OPTIONS, ...TERRAIN_OPTIONS]
      .map(({ thumbnail }) => thumbnail)
      .filter(
        (thumbnail) =>
          !existsSync(resolve('dist/cesium/Widgets/Images', thumbnail)),
      );
    expect(missing).toEqual([]);
  });

  it('leaves the rest of the widget layer out (issue #446)', () => {
    for (const path of [
      'Widgets/widgets.css',
      'Widgets/Viewer',
      'Widgets/Images/NavigationHelp',
      'Widgets/Images/TimelineIcons.png',
    ])
      expect(existsSync(resolve('dist/cesium', path)), path).toBe(false);
  });
});
