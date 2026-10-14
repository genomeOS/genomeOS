/**
 * The fixture readouts the #452 picking tests identify a hovered cell by, now that the hover
 * preview shows provisional values instead of naming its cell (fast-load design §A.1.13 and §B.2,
 * both amended 2026-10-13; #449, #452).
 */
import { describe, expect, it } from 'vitest';

import { heldReadoutsOf } from './atlas-globe-helpers';

/** The resolution-4 cell under the #452 tests' camera target over Madrid. */
const TARGET_CELL = '84390cbffffffff';

describe('heldReadoutsOf', () => {
  it("reads a fixture cell's render-tier mean and SD as the held hover preview shows them", () => {
    expect(heldReadoutsOf('hbs-rs334', TARGET_CELL)).toEqual({
      posterior: '≈0.73%',
      uncertainty: '≈0.40%',
    });
  });

  it('refuses a cell whose readouts another fixture cell shares', () => {
    expect(() => heldReadoutsOf('hbs-rs334', '8400011ffffffff')).toThrow(
      /≈1\.00% \/ ≈0\.19%, as do .*8401b35ffffffff/,
    );
  });

  it('refuses a cell outside the fixture grid, and an unknown artifact', () => {
    expect(() => heldReadoutsOf('hbs-rs334', '84392abffffffff')).toThrow(
      'The e2e fixture grid has no cell 84392abffffffff.',
    );
    expect(() => heldReadoutsOf('no-such-map', TARGET_CELL)).toThrow(
      'The e2e catalog has no artifact "no-such-map".',
    );
  });
});
