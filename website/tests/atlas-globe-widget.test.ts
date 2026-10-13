/** The engine-only Atlas globe and the frame Viewer used to build around it (issue #446). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobeWidget } from '../src/atlas/scene/globe-widget';

const widgets = vi.hoisted(
  () =>
    [] as {
      container: FakeElement;
      options: Record<string, unknown>;
      destroy: ReturnType<typeof vi.fn>;
    }[],
);
/** Set to make the next CesiumWidget constructor throw, as it does when WebGL cannot start. */
const construction = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock('cesium', async (importOriginal) => ({
  ...(await importOriginal<typeof import('cesium')>()),
  CesiumWidget: class {
    readonly container: FakeElement;
    readonly options: Record<string, unknown>;
    readonly destroy = vi.fn();
    constructor(container: FakeElement, options: Record<string, unknown>) {
      if (construction.error) throw construction.error;
      this.container = container;
      this.options = options;
      widgets.push(this);
    }
  },
}));

/** Just enough of an HTMLElement to record the tree the globe builds. */
class FakeElement {
  className = '';
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly style: Record<string, string> = {};
  readonly ownerDocument = {
    createElement: (_tag: string) => new FakeElement(),
  };
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

function build() {
  const container = new FakeElement();
  const globe = createGlobeWidget(container as unknown as HTMLElement);
  return { container, globe, widget: widgets.at(-1)! };
}

afterEach(() => {
  widgets.length = 0;
  construction.error = null;
});

describe('Atlas globe widget', () => {
  it('builds the engine CesiumWidget, not Viewer, with the Atlas render options', () => {
    const { globe, widget } = build();
    expect(globe.widget).toBe(widget);
    expect(widget.options).toMatchObject({
      baseLayer: false,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      requestRenderMode: true,
      scene3DOnly: false,
      showRenderLoopErrors: false,
      useDefaultRenderLoop: false,
    });
  });

  it('keeps the frame Viewer built, so the credit row and its CSS are unchanged', () => {
    const { container, widget } = build();
    expect(container.children.map(({ className }) => className)).toEqual([
      'cesium-viewer',
    ]);
    const [frame] = container.children;
    expect(frame.children.map(({ className }) => className)).toEqual([
      'cesium-viewer-cesiumWidgetContainer',
      'cesium-viewer-bottom',
    ]);
    const [widgetContainer, credits] = frame.children;
    expect(widget.container).toBe(widgetContainer);
    expect(widget.options.creditContainer).toBe(credits);
  });

  it('writes the credit offsets Viewer.resize wrote, which the desktop row keeps', () => {
    const { container } = build();
    const credits = container.children[0].children[1];
    expect(credits.style).toEqual({ bottom: '3px', left: '5px', right: '0px' });
  });

  it('destroys the widget and removes its frame', () => {
    const { container, globe, widget } = build();
    globe.destroy();
    expect(widget.destroy).toHaveBeenCalledOnce();
    expect(container.children).toEqual([]);
  });

  it('removes its frame even when the widget teardown throws', () => {
    // Say, teardown after a lost WebGL context. "Retry globe" builds the next frame in the same
    // container, so a frame left here would sit beside it.
    const { container, globe, widget } = build();
    const failure = new Error('teardown after a lost context');
    widget.destroy.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => globe.destroy()).toThrow(failure);
    expect(container.children).toEqual([]);
  });

  it('leaves no frame behind when the widget cannot be built', () => {
    const container = new FakeElement();
    const failure = new Error('WebGL could not start');
    construction.error = failure;
    expect(() =>
      createGlobeWidget(container as unknown as HTMLElement),
    ).toThrow(failure);
    expect(container.children).toEqual([]);
  });
});
