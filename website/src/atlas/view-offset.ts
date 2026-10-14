/**
 * Where the desktop explorer draws the globe beside its controls panel (fast-load design §A.1.13,
 * amended 2026-10-13; #452). The panel floats over the left of a full-width canvas, so the scene
 * shifts its projection centre right by half the width the panel covers and the globe sits in the
 * middle of the open area. The camera does not move. Cesium-free: the island measures the panel
 * and the scene converts the shift into its frustum (`scene/globe-offset.ts`).
 */

/** A horizontal extent in CSS pixels, as `getBoundingClientRect()` reports it. */
export interface HorizontalBox {
  left: number;
  width: number;
}

export interface PanelBox extends HorizontalBox {
  right: number;
}

export interface ControlsLayout {
  canvas: HorizontalBox;
  /** The persistent controls panel; null when it is not mounted. */
  panel: PanelBox | null;
  hidden: boolean;
  /** The phone layout, where the panel is a bottom sheet and covers no side of the globe. */
  phone: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/** CSS px of the canvas, measured from its left edge, that the controls panel covers. */
export function coveredCanvasWidth({
  canvas,
  hidden,
  panel,
  phone,
}: ControlsLayout): number {
  if (phone || hidden || !panel || panel.width <= 0 || canvas.width <= 0)
    return 0;
  return clamp(panel.right - canvas.left, 0, canvas.width);
}

/** CSS px the globe moves right: half the covered width, so it is centred in the rest. */
export function globeShiftPx(
  coveredWidth: number,
  canvasWidth: number,
): number {
  return clamp(coveredWidth, 0, Math.max(0, canvasWidth)) / 2;
}

/**
 * The same shift in normalised device coordinates, where the canvas is 2 wide. A projection
 * shifted by this amount draws everything `shiftPx` CSS px further right at any drawing-buffer
 * resolution, because CSS pixels and the drawing buffer span the same canvas.
 */
export function projectionShift(shiftPx: number, canvasWidth: number): number {
  return canvasWidth > 0 ? (2 * shiftPx) / canvasWidth : 0;
}
