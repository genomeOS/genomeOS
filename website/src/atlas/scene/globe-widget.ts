/**
 * The engine-only Cesium globe behind the Atlas scene (Atlas design §11; spec 2026-10-07 §B.1,
 * with the credit block of §A.1.7; issue #446).
 *
 * `Viewer` brought Cesium's whole widget layer (knockout, Animation, Timeline, BaseLayerPicker,
 * Geocoder, InfoBox, SelectionIndicator and the rest) into the Cesium chunk on the `/app/`
 * critical path, although the Atlas turned every widget off. `CesiumWidget` is the engine's own
 * widget. This module gives it the frame `Viewer` built around it, so the scene's DOM, the credit
 * row and the CSS keyed on them stay as they were.
 */

import { CesiumWidget } from 'cesium';

/** A CesiumWidget in its frame; `destroy` removes both, as `Viewer.destroy` did, even when
 * the widget's own teardown throws. */
export interface GlobeWidget {
  readonly widget: CesiumWidget;
  destroy(): void;
}

export function createGlobeWidget(container: HTMLElement): GlobeWidget {
  const document = container.ownerDocument;
  const frame = document.createElement('div');
  frame.className = 'cesium-viewer';
  const widgetContainer = document.createElement('div');
  widgetContainer.className = 'cesium-viewer-cesiumWidgetContainer';
  const credits = document.createElement('div');
  credits.className = 'cesium-viewer-bottom';
  // Viewer.resize wrote these offsets. The §A.1.7 placement rules override left and bottom with
  // !important, and the desktop credit row keeps right: 0 from here.
  credits.style.left = '5px';
  credits.style.bottom = '3px';
  credits.style.right = '0px';
  frame.append(widgetContainer, credits);
  // Attached before the widget is built, as Viewer did: the widget sizes its canvas as it starts.
  container.append(frame);
  let widget: CesiumWidget;
  try {
    widget = new CesiumWidget(widgetContainer, {
      baseLayer: false,
      creditContainer: credits,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      requestRenderMode: true,
      scene3DOnly: false,
      // Cesium's own panel is a dead end, and its loop stops silently on errors outside
      // Scene.render; the Atlas loop sends every render error to the explorer's retry instead.
      showRenderLoopErrors: false,
      useDefaultRenderLoop: false,
    });
  } catch (error) {
    // "Retry globe" builds the next frame in this container; a failed one must not stay beside it.
    frame.remove();
    throw error;
  }
  return {
    widget,
    destroy() {
      // Viewer.destroy removed its frame first. The frame goes even when the widget's teardown
      // throws (say, after a lost context), so a retry never builds a second one beside it.
      try {
        widget.destroy();
      } finally {
        frame.remove();
      }
    },
  };
}
