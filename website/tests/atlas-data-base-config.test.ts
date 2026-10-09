import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { artifactDataBaseFrom } from '../src/lib/data-url';

const websiteRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(websiteRoot, '..');
const read = (relative: string): string =>
  readFileSync(path.join(repositoryRoot, relative), 'utf8');
const appPage = read('website/src/pages/app.astro');
const environmentExample = read('.env.example');
const buildSetup = read('website/tests/setup/build.ts');

const BUCKET_BASE = 'https://storage.googleapis.com/example-bucket/atlas/web/';

function dataBasesIn(html: string): { artifact: string; site: string } {
  const match =
    /<script[^>]*\bid="atlas-data-bases"[^>]*>([^<]*)<\/script>/.exec(html);
  expect(match, '#atlas-data-bases').not.toBeNull();
  return JSON.parse(match![1]!) as { artifact: string; site: string };
}

function astroBuild(base: string): string {
  const outDir = mkdtempSync(path.join(tmpdir(), 'genomeos-atlas-base-'));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
    OUT_DIR: outDir,
    PUBLIC_ATLAS_DATA_BASE_URL: base,
    // tests/setup/build.ts pins this too: a shell export of the e2e stall override must not fail
    // these production-shaped builds with an unrelated error.
    PUBLIC_ATLAS_REQUEST_STALL_MS: '',
  };
  delete environment.ATLAS_CATALOG_PATH;
  try {
    execFileSync(
      path.join(
        websiteRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'astro.cmd' : 'astro',
      ),
      ['build'],
      { cwd: websiteRoot, env: environment, stdio: 'pipe' },
    );
    return readFileSync(path.join(outDir, 'app', 'index.html'), 'utf8');
  } finally {
    rmSync(outDir, { force: true, recursive: true });
  }
}

describe('Atlas artifact data base wiring', () => {
  it('reads PUBLIC_ATLAS_DATA_BASE_URL only at the build boundary', () => {
    expect(appPage).toContain('import.meta.env.PUBLIC_ATLAS_DATA_BASE_URL');
    expect(appPage).toContain('id="atlas-data-bases"');
    expect(environmentExample).toMatch(/^PUBLIC_ATLAS_DATA_BASE_URL=$/m);
    expect(buildSetup).toContain("PUBLIC_ATLAS_DATA_BASE_URL: ''");
    expect(`${appPage}\n${environmentExample}\n${buildSetup}`).not.toMatch(
      /ATLAS_DATA_ORIGIN/,
    );
  });
});

describe('artifactDataBaseFrom', () => {
  it('falls back to the site base when unset or empty', () => {
    expect(artifactDataBaseFrom(undefined, '/data/atlas/')).toBe(
      '/data/atlas/',
    );
    expect(artifactDataBaseFrom('', '/genomeOS/data/atlas/')).toBe(
      '/genomeOS/data/atlas/',
    );
  });

  it('accepts the bucket base and the local fixture origin', () => {
    expect(artifactDataBaseFrom(BUCKET_BASE, '/data/atlas/')).toBe(BUCKET_BASE);
    expect(artifactDataBaseFrom('http://127.0.0.1:4323/', '/data/atlas/')).toBe(
      'http://127.0.0.1:4323/',
    );
  });

  it.each([
    BUCKET_BASE.slice(0, -1),
    '/data/atlas/',
    '//cdn.example.org/atlas/web/',
    'http://example.org/atlas/web/',
    'ftp://example.org/atlas/web/',
    ' ',
  ])('refuses %j', (value) => {
    expect(() => artifactDataBaseFrom(value, '/data/atlas/')).toThrow(
      /PUBLIC_ATLAS_DATA_BASE_URL/,
    );
  });
});

describe('production-shaped builds', () => {
  it('bake an absolute artifact base while site data stays same-origin', () => {
    const html = astroBuild(BUCKET_BASE);
    expect(dataBasesIn(html)).toEqual({
      artifact: BUCKET_BASE,
      site: '/data/atlas/',
    });
    // The head script's preloads read the same base from the inline catalog element.
    expect(html).toContain(`data-artifact-data-base="${BUCKET_BASE}"`);
    const island =
      /<astro-island[^>]*component-url="[^"]*AtlasExplorer[^"]*"[^>]*>/.exec(
        html,
      );
    expect(island, 'AtlasExplorer island').not.toBeNull();
    expect(island![0]).toContain(BUCKET_BASE);
  }, 240_000);

  it('fail loudly on a base without its trailing slash', () => {
    let failure: unknown = null;
    try {
      astroBuild(BUCKET_BASE.slice(0, -1));
    } catch (error) {
      failure = error;
    }
    expect(failure, 'the build must fail').not.toBeNull();
    const output = failure as { stdout?: Buffer; stderr?: Buffer };
    expect(`${output.stdout ?? ''}${output.stderr ?? ''}`).toContain(
      'PUBLIC_ATLAS_DATA_BASE_URL',
    );
  }, 240_000);
});
