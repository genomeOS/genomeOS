/** The desktop globe offset beside the controls panel (fast-load design §A.1.13, amended 2026-10-13; #452). */
import { describe, expect, it } from 'vitest';

import {
  coveredCanvasWidth,
  globeShiftPx,
  projectionShift,
} from '../src/atlas/view-offset';

const canvas = { left: 0, width: 1280 };
// Desktop Chrome in the e2e project: the dock is 25rem (450 px at the Atlas root size) from 18 px.
const panel = { left: 18, right: 468, width: 450 };

describe('covered canvas width', () => {
  it('is the panel right edge minus the canvas left edge while the panel is visible', () => {
    expect(
      coveredCanvasWidth({ canvas, hidden: false, panel, phone: false }),
    ).toBe(468);
    expect(
      coveredCanvasWidth({
        canvas: { left: 100, width: 1180 },
        hidden: false,
        panel,
        phone: false,
      }),
    ).toBe(368);
  });

  it('is 0 while the panel is hidden, whether by its flag or a zero-size box', () => {
    expect(
      coveredCanvasWidth({ canvas, hidden: true, panel, phone: false }),
    ).toBe(0);
    expect(
      coveredCanvasWidth({
        canvas,
        hidden: false,
        panel: { left: 0, right: 0, width: 0 },
        phone: false,
      }),
    ).toBe(0);
    expect(
      coveredCanvasWidth({ canvas, hidden: false, panel: null, phone: false }),
    ).toBe(0);
  });

  it('is 0 in the phone layout, where the panel is a bottom sheet', () => {
    expect(
      coveredCanvasWidth({
        canvas: { left: 0, width: 390 },
        hidden: false,
        panel: { left: 0, right: 390, width: 390 },
        phone: true,
      }),
    ).toBe(0);
  });

  it('stays within the canvas', () => {
    expect(
      coveredCanvasWidth({
        canvas: { left: 500, width: 700 },
        hidden: false,
        panel,
        phone: false,
      }),
    ).toBe(0);
    expect(
      coveredCanvasWidth({
        canvas: { left: 0, width: 300 },
        hidden: false,
        panel,
        phone: false,
      }),
    ).toBe(300);
    expect(
      coveredCanvasWidth({
        canvas: { left: 0, width: 0 },
        hidden: false,
        panel,
        phone: false,
      }),
    ).toBe(0);
  });

  it('follows a resize of the canvas or the panel', () => {
    // At 1100 px the dock narrows to 21rem (max-width: 75rem).
    expect(
      coveredCanvasWidth({
        canvas: { left: 0, width: 1100 },
        hidden: false,
        panel: { left: 18, right: 396, width: 378 },
        phone: false,
      }),
    ).toBe(396);
  });
});

describe('globe shift', () => {
  it('moves the globe half the covered width, centring it in the rest of the canvas', () => {
    expect(globeShiftPx(468, 1280)).toBe(234);
    const shift = globeShiftPx(468, 1280);
    // The open area runs from 468 to 1280; its centre is 874 = 640 + 234.
    expect(1280 / 2 + shift).toBe((468 + 1280) / 2);
  });

  it('is 0 when nothing is covered and never more than half the canvas', () => {
    expect(globeShiftPx(0, 1280)).toBe(0);
    expect(globeShiftPx(-20, 1280)).toBe(0);
    expect(globeShiftPx(2000, 1280)).toBe(640);
    expect(globeShiftPx(Number.NaN, 1280)).toBe(0);
  });

  it('is a fraction of the canvas half-width in the projection (normalised device coordinates)', () => {
    expect(projectionShift(234, 1280)).toBeCloseTo(0.365625, 12);
    expect(projectionShift(640, 1280)).toBe(1);
    expect(projectionShift(0, 1280)).toBe(0);
    expect(projectionShift(234, 0)).toBe(0);
  });
});
