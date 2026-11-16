/** The explorer's WebGL check (Atlas design §11; Cesium globe design §12). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { supportsWebGL } from '../src/atlas/explorer-runtime';

/**
 * The tests run without a DOM: a document and a canvas class stand in, and the canvas would hand
 * back a context, as a browser with working WebGL does.
 */
function stubDocument() {
  class HTMLCanvasElement {
    getContext(_type: string): unknown {
      return {};
    }
  }
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  const createElement = vi.fn(() => new HTMLCanvasElement());
  vi.stubGlobal('HTMLCanvasElement', HTMLCanvasElement);
  vi.stubGlobal('document', { createElement });
  return { createElement, getContext };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('supportsWebGL', () => {
  it('checks that the WebGL API exists without creating a canvas or a context', () => {
    const { createElement, getContext } = stubDocument();
    vi.stubGlobal('WebGL2RenderingContext', class {});
    vi.stubGlobal('WebGLRenderingContext', class {});
    expect(supportsWebGL()).toBe(true);
    expect(createElement).not.toHaveBeenCalled();
    expect(getContext).not.toHaveBeenCalled();
  });

  it('accepts a browser with WebGL 1 only', () => {
    stubDocument();
    vi.stubGlobal('WebGLRenderingContext', class {});
    expect(supportsWebGL()).toBe(true);
  });

  it('reports a browser without the WebGL API as unsupported', () => {
    stubDocument();
    expect(supportsWebGL()).toBe(false);
  });
});
