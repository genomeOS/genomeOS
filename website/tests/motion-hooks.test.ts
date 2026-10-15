/**
 * The motion hooks ship only in the e2e build (round 2 spec §3.4, §11.1): `window.__motion` and
 * the /kit/ gallery exist where tests scrub scenes, and nowhere a visitor goes. Like
 * PUBLIC_ATLAS_E2E_HOOKS, only `npm run build:e2e` may set PUBLIC_MOTION_HOOKS.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  E2E_CATALOG_PATH,
  assertMotionHooks,
} from '../integrations/dev-kit.mjs';
import { E2E_ATLAS_CATALOG_PATH } from '../src/lib/catalog-build';
import { frozenAt } from '../src/graphics/motion-hooks';
import { dist } from './helpers/dist';

const website = path.resolve(import.meta.dirname, '..');

function files(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
const shipped = (root: string) =>
  files(root).filter((file) => /\.(?:js|html|mjs)$/.test(file));
const mentions = (root: string, text: string) =>
  shipped(root).filter((file) => readFileSync(file, 'utf8').includes(text));

describe('the build guard', () => {
  it('names the e2e build’s own catalog', () => {
    expect(E2E_CATALOG_PATH).toBe(E2E_ATLAS_CATALOG_PATH);
  });

  it('allows the hooks only in the e2e build, and only as "1"', () => {
    expect(assertMotionHooks(undefined, undefined)).toBe(false);
    expect(assertMotionHooks('public/data/atlas/catalog.json', '')).toBe(false);
    expect(assertMotionHooks(E2E_CATALOG_PATH, '1')).toBe(true);
    for (const catalog of [undefined, 'public/data/atlas/catalog.json'])
      expect(() => assertMotionHooks(catalog, '1')).toThrow(
        /PUBLIC_MOTION_HOOKS is only allowed in the e2e build/,
      );
    expect(() => assertMotionHooks(E2E_CATALOG_PATH, 'true')).toThrow(
      /PUBLIC_MOTION_HOOKS must be 1/,
    );
  });

  it('is set by build:e2e and by no other script', () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(website, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const setting = Object.entries(scripts)
      .filter(([, command]) => command.includes('PUBLIC_MOTION_HOOKS='))
      .map(([name]) => name);
    expect(setting).toEqual(['build:e2e']);
    expect(scripts['build:e2e']).toContain('PUBLIC_MOTION_HOOKS=1');
    expect(scripts['build:deployed']).not.toContain('MOTION');
  });
});

describe('MOTION_HOOKS', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is false outside dev and the e2e build', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PUBLIC_MOTION_HOOKS', '');
    vi.resetModules();
    const { MOTION_HOOKS } = await import('../src/graphics/motion-hooks');
    expect(MOTION_HOOKS).toBe(false);
  });

  it('is true in the e2e build', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PUBLIC_MOTION_HOOKS', '1');
    vi.resetModules();
    const { MOTION_HOOKS } = await import('../src/graphics/motion-hooks');
    expect(MOTION_HOOKS).toBe(true);
  });

  it('reads ?t= for every scene, or with &scene= for one', () => {
    expect(frozenAt('?t=1500', 'orbit')).toBe(1500);
    expect(frozenAt('?t=1500&scene=orbit', 'orbit')).toBe(1500);
    expect(frozenAt('?t=1500&scene=board', 'orbit')).toBeNull();
    expect(frozenAt('?t=-4', 'orbit')).toBeNull();
    expect(frozenAt('?t=soon', 'orbit')).toBeNull();
    expect(frozenAt('', 'orbit')).toBeNull();
  });
});

describe('what each build ships', () => {
  // The unit tests' build (tests/setup/build.ts) carries no hooks, as the deployed build does
  // not: the hooks hang on PUBLIC_MOTION_HOOKS alone, which neither sets.
  it('the production build has no __motion and no /kit/ page, in pages or the sitemap', () => {
    expect(mentions(dist, '__motion')).toEqual([]);
    expect(existsSync(path.join(dist, 'kit/index.html'))).toBe(false);
    const sitemaps = readdirSync(dist)
      .filter((file) => /^sitemap.*\.xml$/.test(file))
      .map((file) => readFileSync(path.join(dist, file), 'utf8'))
      .join('\n');
    expect(sitemaps).not.toContain('/kit/');
  });

  describe('the e2e build', () => {
    let out = '';
    beforeAll(() => {
      out = mkdtempSync(path.join(os.tmpdir(), 'genomeos-e2e-hooks-'));
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execFileSync(npm, ['run', 'build:e2e'], {
        cwd: website,
        env: {
          ...process.env,
          ASTRO_TELEMETRY_DISABLED: '1',
          NODE_ENV: 'production',
          OUT_DIR: out,
          PUBLIC_ATLAS_DATA_BASE_URL: '',
          PUBLIC_GA_MEASUREMENT_ID: '',
        },
        stdio: 'ignore',
      });
    }, 300_000);
    afterAll(() => {
      if (out) rmSync(out, { recursive: true, force: true });
    });

    it('carries window.__motion and the /kit/ gallery, kept out of the sitemap', () => {
      expect(mentions(out, '__motion').length).toBeGreaterThan(0);
      const kit = readFileSync(path.join(out, 'kit/index.html'), 'utf8');
      expect(kit).toContain('data-graphic="kit-scene"');
      expect(kit).toContain('<meta name="robots" content="noindex">');
      const sitemaps = readdirSync(out)
        .filter((file) => /^sitemap.*\.xml$/.test(file))
        .map((file) => readFileSync(path.join(out, file), 'utf8'))
        .join('\n');
      expect(sitemaps).not.toContain('/kit/');
    });
  });
});
