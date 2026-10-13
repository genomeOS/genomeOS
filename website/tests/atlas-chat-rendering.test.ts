import { describe, expect, it, vi } from 'vitest';
import { acknowledgeMapView } from '../src/atlas/chat-rendering';
import { parseExplorerState } from '../src/atlas/url-state';
import type { AtlasCatalog } from '../src/atlas/contracts';
import type { AtlasSceneController } from '../src/atlas/scene/atlas-scene';

const catalog = {
  artifacts: [{ id: 'hbs', model_version: 'v3', data_version: 'data' }],
} as AtlasCatalog;
const state = parseExplorerState('', catalog).state;
describe('assistant renderer acknowledgement', () => {
  it('waits for the renderer before acknowledging layers, camera and completed paints', async () => {
    let release!: () => void;
    const metric = new Promise<void>((resolve) => {
      release = resolve;
    });
    const layers = vi.fn();
    const camera = vi.fn();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const controller = {
      setMetric: () => metric,
      setLayerVisibility: layers,
      setCamera: camera,
    } as unknown as AtlasSceneController;
    let acknowledged = false;
    const done = acknowledgeMapView(controller, state).then(() => {
      acknowledged = true;
    });
    expect(layers).not.toHaveBeenCalled();
    release();
    await Promise.resolve();
    expect(layers).toHaveBeenCalledWith(state.layers);
    expect(camera).toHaveBeenCalledWith(state.camera, false);
    expect(acknowledged).toBe(false);
    frames.shift()!(0);
    expect(acknowledged).toBe(false);
    frames.shift()!(0);
    await done;
    expect(acknowledged).toBe(true);
    vi.unstubAllGlobals();
  });
  it('never confirms a rejected render', async () => {
    const controller = {
      setMetric: () => Promise.reject(new Error('render failed')),
      setLayerVisibility: vi.fn(),
      setCamera: vi.fn(),
    } as unknown as AtlasSceneController;
    await expect(acknowledgeMapView(controller, state)).rejects.toThrow(
      'render failed',
    );
    expect(controller.setLayerVisibility).not.toHaveBeenCalled();
  });
  it('never applies stale camera or layers after a newer action supersedes a render', async () => {
    const controller = {
      setMetric: () => Promise.resolve(),
      setLayerVisibility: vi.fn(),
      setCamera: vi.fn(),
    } as unknown as AtlasSceneController;
    await expect(
      acknowledgeMapView(controller, state, () => false),
    ).rejects.toThrow('superseded');
    expect(controller.setLayerVisibility).not.toHaveBeenCalled();
    expect(controller.setCamera).not.toHaveBeenCalled();
  });
});
