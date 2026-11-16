/**
 * The explorer's camera help, for Atlas design §11. Interaction design §2: keyboard help "lists
 * only shortcuts that are actually bound".
 *
 * Q and E call Camera.lookUp and lookDown, which turn the camera in place, so they are labelled
 * "look up or down", not "tilt" (#483; relabelling was the smaller change than rebinding them to
 * orbit about the view centre). Tilting the view about its centre is a pointer gesture: Cesium's
 * default tilt inputs, which the Atlas does not change, are Ctrl with a left or right drag, a
 * middle-button drag, and a two-finger drag on touch. Cesium has no Command-key modifier.
 */

export const KEYBOARD_HELP =
  'Focus the globe, then use arrows or WASD to pan, +/− to zoom, and Q/E to look up or down.';

export const TILT_HELP =
  'To tilt the Globe or Perspective view, Ctrl+drag (Control, not ⌘, on a Mac) or drag with the middle mouse button; on a touch screen, drag two fingers up or down.';
