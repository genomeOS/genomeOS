/**
 * WebGL probes for the e2e specs (Atlas design §11; #483). Each is an init script, so it wraps
 * WebGL2 before Cesium makes its context.
 *
 * - `countGlCalls`: records each `readPixels`, a read-back the page waits on the GPU for, and each
 *   `linkProgram`, whose link status the program's first use waits for, with the page's clock.
 *   A pick in Cesium does both: it reads its pick framebuffer back, and on first use it links the
 *   pick variants of the programs it draws.
 * - `coldShaders`: appends a constant of its own to a WebGL2 shader's `main()`, one per page (the
 *   page's time origin, in ms), so no compiled shader or pipeline of an earlier page or run (the
 *   driver's shader cache) can answer for it: that compile is cold, as on a browser's first run.
 *   Every shader of the page gets it (`'page'`), or only those compiled while the page holds its
 *   cold window open (`'window'`, `setColdShaders`). Cesium compiles a program's shaders when it
 *   first draws with it, so a window around one action makes that action's first draws cold and
 *   leaves the rest of the page as a warm cache has it.
 */

import type { Page } from '@playwright/test';

/** The WebGL2 calls `countGlCalls` records. */
export type GlCall = 'linkProgram' | 'readPixels';

declare global {
  interface Window {
    /**
     * Each counted WebGL2 call, with `performance.now()` as it was made; a link also names its
     * program by the start of its fragment shader, and whether that is a pick variant.
     */
    __atlasGlCalls?: { fn: GlCall; t: number; program?: string }[];
    /** Whether `coldShaders` makes the shaders compiled now cold. */
    __atlasColdShaders?: boolean;
  }
}

/** Records every WebGL2 `readPixels` and `linkProgram` call the page makes (`glCallsSince`). */
export async function countGlCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: { fn: GlCall; t: number; program?: string }[] = [];
    window.__atlasGlCalls = calls;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<
      GlCall,
      (...args: unknown[]) => unknown
    >;
    /** A program by its fragment shader: Cesium's pick variants wrap `czm_non_pick_main`. */
    const programOf = (gl: WebGL2RenderingContext, program: WebGLProgram) => {
      const fragment = (gl.getAttachedShaders(program) ?? [])
        .map((shader) => gl.getShaderSource(shader) ?? '')
        .find((source) => /out_FragColor|out_FragData/.test(source));
      if (fragment === undefined) return 'unknown';
      const pick = fragment.includes('czm_non_pick_main') ? 'pick ' : '';
      const defines = fragment
        .match(/#define \w+/g)
        ?.slice(0, 4)
        .join(' ');
      return `${pick}${defines ?? fragment.slice(0, 60)}`;
    };
    for (const fn of ['linkProgram', 'readPixels'] as const) {
      const call = proto[fn];
      proto[fn] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
        calls.push({
          fn,
          program:
            fn === 'linkProgram'
              ? programOf(this, args[0] as WebGLProgram)
              : undefined,
          t: performance.now(),
        });
        return call.apply(this, args);
      };
    }
  });
}

/** The counted calls made at or after `since` on the page's clock, per call. */
export async function glCallsSince(
  page: Page,
  since: number,
): Promise<Record<GlCall, number>> {
  return page.evaluate((since) => {
    const counts = { linkProgram: 0, readPixels: 0 };
    for (const call of window.__atlasGlCalls!)
      if (call.t >= since) counts[call.fn] += 1;
    return counts;
  }, since);
}

/** The programs linked at or after `since` on the page's clock, as `countGlCalls` names them. */
export async function glLinksSince(
  page: Page,
  since: number,
): Promise<string[]> {
  return page.evaluate(
    (since) =>
      window
        .__atlasGlCalls!.filter(
          (call) => call.fn === 'linkProgram' && call.t >= since,
        )
        .map((call) => call.program ?? 'unknown'),
    since,
  );
}

/**
 * Resolves once the page has made no counted call for `quietMs`: the loads after `ready` (the
 * borders, the starfield) link programs of their own, which a measured window must not catch.
 */
export async function glQuiet(page: Page, quietMs = 1_000): Promise<void> {
  await page.waitForFunction(
    (quietMs) => {
      const calls = window.__atlasGlCalls!;
      const last = calls.length > 0 ? calls[calls.length - 1].t : 0;
      return performance.now() - last >= quietMs;
    },
    quietMs,
    { polling: 100, timeout: 60_000 },
  );
}

/**
 * The page's WebGL2 shaders get a constant of the page's own, so each such compile is cold: all of
 * them (`'page'`), or those compiled while `setColdShaders` holds the window open (`'window'`).
 */
export async function coldShaders(
  page: Page,
  scope: 'page' | 'window' = 'page',
): Promise<void> {
  await page.addInitScript((scope) => {
    window.__atlasColdShaders = scope === 'page';
    const nonce = 100_000 + (Math.floor(performance.timeOrigin) % 900_000);
    const kinds = new WeakMap<WebGLShader, number>();
    const proto = WebGL2RenderingContext.prototype;
    const createShader = proto.createShader;
    proto.createShader = function (this: WebGL2RenderingContext, kind) {
      const shader = createShader.call(this, kind);
      if (shader) kinds.set(shader, kind);
      return shader;
    };
    const shaderSource = proto.shaderSource;
    const main = /void\s+main\s*\(\s*(?:void)?\s*\)/;
    proto.shaderSource = function (
      this: WebGL2RenderingContext,
      shader: WebGLShader,
      source: string,
    ) {
      if (
        !window.__atlasColdShaders ||
        !/^\s*#version 300 es/.test(source) ||
        !main.test(source)
      )
        return shaderSource.call(this, shader, source);
      // The original main runs first; the appended test never holds, so nothing it draws changes.
      const tail =
        kinds.get(shader) === this.VERTEX_SHADER
          ? `if (gl_Position.w == -${nonce}.0) { gl_Position = vec4(${nonce}.0); }`
          : `if (gl_FragCoord.x < -${nonce}.0) { discard; }`;
      return shaderSource.call(
        this,
        shader,
        `${source.replace(main, 'void atlas_cold_main()')}\nvoid main() { atlas_cold_main(); ${tail} }\n`,
      );
    };
  }, scope);
}

/** Opens (`true`) or closes the cold window of `coldShaders(page, 'window')`. */
export async function setColdShaders(page: Page, cold: boolean): Promise<void> {
  await page.evaluate((cold) => {
    window.__atlasColdShaders = cold;
  }, cold);
}
