/** The camera help says only what is bound (interaction design §2) and how to tilt (#483). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { CesiumWidget } from 'cesium';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { KEYBOARD_HELP, TILT_HELP } from '../src/atlas/camera-help';
import {
  bindKeyboardCamera,
  keyboardCommandFor,
} from '../src/atlas/scene/camera';
import { CameraHelp } from '../src/components/atlas/CameraHelp';

/** The default tilt inputs of the installed engine's camera controller. */
function cesiumTiltDefaults(): string {
  const source = readFileSync(
    path.resolve(
      import.meta.dirname,
      '../node_modules/@cesium/engine/Source/Scene/ScreenSpaceCameraController.js',
    ),
    'utf8',
  );
  const match = source.match(/this\.tiltEventTypes = \[([\s\S]*?)\];/);
  if (!match) throw new Error('no tiltEventTypes default in the engine');
  return match[1];
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? sourceFiles(file) : [file];
  });
}

describe('camera help (#483)', () => {
  it('labels Q and E by what they do: look up and down in place', () => {
    expect(keyboardCommandFor({ key: 'q', target: null })).toBe('look-up');
    expect(keyboardCommandFor({ key: 'E', target: null })).toBe('look-down');
    expect(KEYBOARD_HELP).toContain('arrows or WASD to pan');
    expect(KEYBOARD_HELP).toContain('Q/E to look up or down');
    expect(KEYBOARD_HELP).not.toMatch(/tilt/i);

    let listener: ((event: KeyboardEvent) => void) | undefined;
    const camera = {
      lookDown: vi.fn(),
      lookUp: vi.fn(),
      positionCartographic: { height: 1e6 },
    };
    bindKeyboardCamera(
      { camera } as unknown as CesiumWidget,
      {
        addEventListener: (_type: string, added: typeof listener) => {
          listener = added;
        },
        hasAttribute: () => true,
      } as unknown as HTMLElement,
    );
    for (const key of ['q', 'e'])
      listener?.({
        key,
        preventDefault: () => {},
        target: null,
      } as unknown as KeyboardEvent);
    expect(camera.lookUp).toHaveBeenCalledTimes(1);
    expect(camera.lookDown).toHaveBeenCalledTimes(1);
  });

  it("names Cesium's default tilt gestures, which the Atlas leaves in place", () => {
    const defaults = cesiumTiltDefaults();
    expect(defaults).toContain('CameraEventType.MIDDLE_DRAG');
    expect(defaults).toContain('CameraEventType.PINCH');
    expect(defaults).toMatch(
      /eventType: CameraEventType\.LEFT_DRAG,\s*modifier: KeyboardEventModifier\.CTRL/,
    );
    // Cesium has no ⌘ modifier, so a Mac's Command key does not tilt.
    expect(defaults).not.toMatch(/META|ALT|SHIFT/);
    for (const file of sourceFiles(path.resolve(import.meta.dirname, '../src')))
      expect(readFileSync(file, 'utf8'), file).not.toContain('tiltEventTypes');

    expect(TILT_HELP).toMatch(/Ctrl\+drag/);
    expect(TILT_HELP).toMatch(/not ⌘/);
    expect(TILT_HELP).toMatch(/middle mouse button/);
    expect(TILT_HELP).toMatch(/two fingers/);
  });

  it('shows both in the Keys help', () => {
    const html = renderToStaticMarkup(createElement(CameraHelp));
    expect(html).toContain('<summary role="button">Keys</summary>');
    expect(html).toContain(KEYBOARD_HELP);
    expect(html).toContain(TILT_HELP.replace('&', '&amp;'));
  });
});
