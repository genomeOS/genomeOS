/**
 * The pointer's bindings (Atlas design §11; owner decision 2026-11-14 on #483): a mouse move is
 * resolved once per animation frame by the CPU hover resolver, and never by a GPU pick; a click
 * runs Cesium's drill pick and arbitrates what it found.
 */
import { Cartesian2, ScreenSpaceEventType } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { observationPickId } from '../src/atlas/scene/observation-layer';
import { bindAtlasPicking } from '../src/atlas/scene/picking';
import type { AtlasPick } from '../src/atlas/scene/types';

/** The input actions bindAtlasPicking registers, by event type, on the one handler it makes. */
const actions = vi.hoisted(
  () => new Map<number, (event: Record<string, unknown>) => void>(),
);

vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cesium')>();
  class FakeHandler {
    setInputAction(
      action: (event: Record<string, unknown>) => void,
      type: number,
    ) {
      actions.set(type, action);
    }
    destroy() {
      actions.clear();
    }
  }
  return { ...actual, ScreenSpaceEventHandler: FakeHandler };
});

const PICK: AtlasPick = observationPickId(
  'map-surveys:1',
  'hbs:v3:map-2026-08',
);
const frames: FrameRequestCallback[] = [];

function bind() {
  const scene = {
    canvas: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    drillPick: vi.fn(() => [{ id: PICK }]),
  };
  const click = vi.fn(
    (_picks: readonly unknown[], _position: Cartesian2) => PICK,
  );
  const hover = vi.fn((_position: Cartesian2) => PICK);
  const onSelect = vi.fn();
  const onHover = vi.fn();
  const unbind = bindAtlasPicking(scene as never, onSelect, onHover, {
    click,
    hover,
  });
  return { click, hover, onHover, onSelect, scene, unbind };
}

function runFrames(): void {
  for (const frame of frames.splice(0)) frame(0);
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  frames.length = 0;
  actions.clear();
});

describe('the pointer’s pick bindings (#483)', () => {
  it('resolves a mouse move on the CPU in the next frame, without a GPU pick', () => {
    const { hover, onHover, scene, unbind } = bind();
    const move = actions.get(ScreenSpaceEventType.MOUSE_MOVE)!;
    move({
      endPosition: new Cartesian2(10, 20),
      startPosition: new Cartesian2(9, 20),
    });
    move({
      endPosition: new Cartesian2(12, 21),
      startPosition: new Cartesian2(10, 20),
    });
    expect(hover).not.toHaveBeenCalled();
    runFrames();
    // Once per frame, at the latest position.
    expect(hover).toHaveBeenCalledTimes(1);
    expect(hover).toHaveBeenCalledWith(new Cartesian2(12, 21));
    expect(onHover).toHaveBeenCalledWith({
      pick: PICK,
      screenPosition: { x: 12, y: 21 },
    });
    expect(scene.drillPick).not.toHaveBeenCalled();
    unbind();
  });

  it('drill picks a click and arbitrates what it found', () => {
    const { click, hover, onSelect, scene, unbind } = bind();
    const position = new Cartesian2(30, 40);
    actions.get(ScreenSpaceEventType.LEFT_CLICK)!({ position });
    expect(scene.drillPick).toHaveBeenCalledWith(position, 12);
    expect(click).toHaveBeenCalledWith([{ id: PICK }], position);
    expect(onSelect).toHaveBeenCalledWith(PICK);
    expect(hover).not.toHaveBeenCalled();
    unbind();
  });
});
