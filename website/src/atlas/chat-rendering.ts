/** Renderer acknowledgements for existing views; Atlas design §§11, 16. */
import type { AtlasSceneController } from './scene/atlas-scene';
import type { ExplorerState } from './url-state';

export async function acknowledgeMapView(
  controller: AtlasSceneController,
  state: ExplorerState,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await controller.setMetric(state.metric);
  if (!isCurrent()) throw new Error('Map action was superseded.');
  controller.setLayerVisibility(state.layers);
  controller.setCamera(state.camera, false);
  // Let Cesium request/render the applied presentation before issuing the receipt.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  if (!isCurrent()) throw new Error('Map action was superseded.');
}

/** A cold restyle settles with the pending pipeline request, whose handler reports its outcome. */
export function restyleColdLoad(restyle: Promise<void> | undefined): void {
  restyle?.catch(() => undefined);
}
