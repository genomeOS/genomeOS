/** Measuring the controls panel for the desktop globe offset (fast-load design §A.1.13, amended 2026-10-13; #452). */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The hook runs without a DOM: React's effect and the media query are stand-ins, and each test
// runs the effect by hand.
const mocks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  phone: false,
}));

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    mocks.effects.push(effect);
  },
}));
vi.mock('../src/components/atlas/useMediaQuery', () => ({
  MOBILE_QUERY: '(max-width: 52rem)',
  useMediaQuery: () => mocks.phone,
}));

import {
  observeControlsObstruction,
  useGlobeOffset,
  type ObstructionObservers,
} from '../src/components/atlas/useGlobeOffset';

interface Box {
  left: number;
  right: number;
  width: number;
}

function element(box: Box) {
  return {
    box,
    hidden: false,
    getBoundingClientRect() {
      return this.box;
    },
  };
}

function observers() {
  const resize: {
    callback: () => void;
    observed: unknown[];
    disconnected: boolean;
  }[] = [];
  const mutation: {
    callback: () => void;
    observed: [unknown, MutationObserverInit | undefined][];
    disconnected: boolean;
  }[] = [];
  const env: ObstructionObservers = {
    MutationObserver: class {
      record: (typeof mutation)[number];
      constructor(callback: () => void) {
        this.record = { callback, disconnected: false, observed: [] };
        mutation.push(this.record);
      }
      observe(target: unknown, options?: MutationObserverInit) {
        this.record.observed.push([target, options]);
      }
      disconnect() {
        this.record.disconnected = true;
      }
    } as unknown as typeof MutationObserver,
    ResizeObserver: class {
      record: (typeof resize)[number];
      constructor(callback: () => void) {
        this.record = { callback, disconnected: false, observed: [] };
        resize.push(this.record);
      }
      observe(target: unknown) {
        this.record.observed.push(target);
      }
      disconnect() {
        this.record.disconnected = true;
      }
    } as unknown as typeof ResizeObserver,
  };
  return { env, mutation, resize };
}

function layout() {
  return {
    canvas: element({ left: 0, right: 1280, width: 1280 }),
    panel: element({ left: 18, right: 468, width: 450 }),
  };
}

afterEach(() => {
  mocks.effects.length = 0;
  mocks.phone = false;
});

describe('observeControlsObstruction', () => {
  it('reports the covered width at once and watches both boxes and the hidden flag', () => {
    const { canvas, panel } = layout();
    const { env, mutation, resize } = observers();
    const reports: number[] = [];
    observeControlsObstruction(
      {
        canvas: canvas as unknown as HTMLElement,
        panel: panel as unknown as HTMLElement,
        phone: false,
      },
      (width) => reports.push(width),
      env,
    );
    expect(reports).toEqual([468]);
    expect(resize[0].observed).toEqual([panel, canvas]);
    expect(mutation[0].observed).toEqual([
      [panel, { attributeFilter: ['hidden'], attributes: true }],
    ]);
  });

  it('follows a resize of either box and reports only changes', () => {
    const { canvas, panel } = layout();
    const { env, resize } = observers();
    const reports: number[] = [];
    observeControlsObstruction(
      {
        canvas: canvas as unknown as HTMLElement,
        panel: panel as unknown as HTMLElement,
        phone: false,
      },
      (width) => reports.push(width),
      env,
    );
    resize[0].callback();
    // At 1100 px the dock narrows to 21rem.
    canvas.box = { left: 0, right: 1100, width: 1100 };
    panel.box = { left: 18, right: 396, width: 378 };
    resize[0].callback();
    canvas.box = { left: 0, right: 1000, width: 1000 };
    resize[0].callback();
    expect(reports).toEqual([468, 396]);
  });

  it('reports 0 while the panel is hidden and the width again when it returns', () => {
    const { canvas, panel } = layout();
    const { env, mutation, resize } = observers();
    const reports: number[] = [];
    observeControlsObstruction(
      {
        canvas: canvas as unknown as HTMLElement,
        panel: panel as unknown as HTMLElement,
        phone: false,
      },
      (width) => reports.push(width),
      env,
    );
    panel.hidden = true;
    mutation[0].callback();
    panel.hidden = false;
    mutation[0].callback();
    // display: none: the box collapses before React or the attribute says so.
    panel.box = { left: 0, right: 0, width: 0 };
    resize[0].callback();
    expect(reports).toEqual([468, 0, 468, 0]);
  });

  it('reports 0 in the phone layout or without both elements, and watches nothing', () => {
    const { canvas, panel } = layout();
    for (const target of [
      { canvas, panel, phone: true },
      { canvas: null, panel, phone: false },
      { canvas, panel: null, phone: false },
    ]) {
      const { env, mutation, resize } = observers();
      const reports: number[] = [];
      observeControlsObstruction(
        target as unknown as Parameters<typeof observeControlsObstruction>[0],
        (width) => reports.push(width),
        env,
      );
      expect(reports).toEqual([0]);
      expect([resize.length, mutation.length]).toEqual([0, 0]);
    }
  });

  it('disconnects both observers on cleanup', () => {
    const { canvas, panel } = layout();
    const { env, mutation, resize } = observers();
    const stop = observeControlsObstruction(
      {
        canvas: canvas as unknown as HTMLElement,
        panel: panel as unknown as HTMLElement,
        phone: false,
      },
      () => undefined,
      env,
    );
    stop();
    expect([resize[0].disconnected, mutation[0].disconnected]).toEqual([
      true,
      true,
    ]);
  });
});

describe('useGlobeOffset', () => {
  function run(phone: boolean) {
    mocks.phone = phone;
    const { canvas, panel } = layout();
    const controller = { setLeftObstruction: vi.fn() };
    vi.stubGlobal('ResizeObserver', observers().env.ResizeObserver);
    vi.stubGlobal('MutationObserver', observers().env.MutationObserver);
    try {
      useGlobeOffset(
        panel as unknown as HTMLElement,
        { current: canvas as unknown as HTMLElement },
        controller,
      );
      const cleanup = mocks.effects.pop()!();
      return { cleanup, controller };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('passes the covered width to the scene on desktop', () => {
    const { cleanup, controller } = run(false);
    expect(controller.setLeftObstruction).toHaveBeenCalledWith(468);
    expect(typeof cleanup).toBe('function');
  });

  it('passes 0 on a phone, where the panel is a bottom sheet', () => {
    const { controller } = run(true);
    expect(controller.setLeftObstruction).toHaveBeenCalledWith(0);
    expect(controller.setLeftObstruction).not.toHaveBeenCalledWith(468);
  });

  it('waits for a scene', () => {
    const { canvas, panel } = layout();
    useGlobeOffset(
      panel as unknown as HTMLElement,
      { current: canvas as unknown as HTMLElement },
      null,
    );
    expect(mocks.effects.pop()!()).toBeUndefined();
  });
});
