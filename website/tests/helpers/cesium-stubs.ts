/** Browser image stand-ins that Cesium `Material` uniform checks need in Node
 * (moved verbatim from tests/atlas-scene.test.ts). */

import { vi } from 'vitest';

export function stubCesiumBrowserImageTypes(): void {
  class BrowserImageType {}
  class CanvasImageType extends BrowserImageType {
    height = 0;
    width = 0;
    getContext() {
      return {
        arc: vi.fn(),
        beginPath: vi.fn(),
        bezierCurveTo: vi.fn(),
        closePath: vi.fn(),
        createRadialGradient: () => ({ addColorStop: vi.fn() }),
        ellipse: vi.fn(),
        fill: vi.fn(),
        fillStyle: '',
        // Every pixel opaque: an image reads as its whole rectangle.
        getImageData: (
          _x: number,
          _y: number,
          width: number,
          height: number,
        ) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
        lineWidth: 0,
        moveTo: vi.fn(),
        stroke: vi.fn(),
        strokeStyle: '',
      };
    }
  }
  vi.stubGlobal('HTMLCanvasElement', CanvasImageType);
  for (const browserType of [
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ])
    vi.stubGlobal(browserType, BrowserImageType);
  vi.stubGlobal('document', {
    createElement: (name: string) => {
      if (name !== 'canvas') throw new Error(`Unexpected element: ${name}`);
      return new CanvasImageType();
    },
  });
}
