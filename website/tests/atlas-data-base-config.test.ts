import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
const packageScripts = (
  JSON.parse(read('website/package.json')) as {
    scripts: Record<string, string>;
  }
).scripts;

const BUCKET_BASE = 'https://storage.googleapis.com/example-bucket/atlas/web/';
// An env read of the variable, in any of the spellings Vite and Node accept.
const ENV_READ =
  /\b(?:import\.meta|process)\.env(?:\.PUBLIC_ATLAS_DATA_BASE_URL\b|\[\s*['"`]PUBLIC_ATLAS_DATA_BASE_URL['"`]\s*\])/g;

/** website/src files (relative, POSIX) whose text names PUBLIC_ATLAS_DATA_BASE_URL at all. */
function sourceFilesNamingTheVariable(): string[] {
  const sourceRoot = path.join(websiteRoot, 'src');
  return readdirSync(sourceRoot, { encoding: 'utf8', recursive: true })
    .filter((relative) => /\.(?:astro|[cm]?[jt]sx?)$/.test(relative))
    .filter((relative) =>
      readFileSync(path.join(sourceRoot, relative), 'utf8').includes(
        'PUBLIC_ATLAS_DATA_BASE_URL',
      ),
    )
    .map((relative) => relative.split(path.sep).join('/'))
    .sort();
}

function dataBasesIn(html: string): { artifact: string; site: string } {
  const match =
    /<script[^>]*\bid="atlas-data-bases"[^>]*>([^<]*)<\/script>/.exec(html);
  expect(match, '#atlas-data-bases').not.toBeNull();
  return JSON.parse(match![1]!) as { artifact: string; site: string };
}

/** The AtlasExplorer island's `props` attribute, HTML-unescaped and parsed. */
function explorerIslandProps(html: string): Record<string, unknown> {
  const island =
    /<astro-island[^>]*component-url="[^"]*AtlasExplorer[^"]*"[^>]*>/.exec(
      html,
    );
  expect(island, 'AtlasExplorer island').not.toBeNull();
  const props = /\sprops="([^"]*)"/.exec(island![0]);
  expect(props, 'AtlasExplorer island props').not.toBeNull();
  return JSON.parse(
    props![1]!
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&'),
  ) as Record<string, unknown>;
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
    // app.astro's frontmatter is the one reader, and it reads the variable once, straight into
    // artifactDataBaseFrom. Vite inlines PUBLIC_* reads into client bundles too, so a read
    // anywhere else would ship an unvalidated base; client code gets the validated base from
    // the AtlasExplorer props and #atlas-data-bases instead. data-url.ts names the variable
    // only in the resolver's docs and errors, and reads no env at all.
    expect(sourceFilesNamingTheVariable()).toEqual([
      'lib/data-url.ts',
      'pages/app.astro',
    ]);
    expect(appPage.match(ENV_READ)).toEqual([
      'import.meta.env.PUBLIC_ATLAS_DATA_BASE_URL',
    ]);
    expect(appPage).toMatch(
      /artifactDataBaseFrom\(\s*import\.meta\.env\.PUBLIC_ATLAS_DATA_BASE_URL,\s*siteDataBase,?\s*\)/,
    );
    expect(read('website/src/lib/data-url.ts')).not.toMatch(
      /\b(?:import\.meta|process)\.env\b/,
    );
    expect(appPage).toContain('id="atlas-data-bases"');
    expect(environmentExample).toMatch(/^PUBLIC_ATLAS_DATA_BASE_URL=$/m);
    expect(buildSetup).toContain("PUBLIC_ATLAS_DATA_BASE_URL: ''");
    expect(`${appPage}\n${environmentExample}\n${buildSetup}`).not.toMatch(
      /ATLAS_DATA_ORIGIN/,
    );
  });

  it('escapes the bases element with the shared inline-JSON escape', () => {
    expect(appPage).toMatch(
      /const dataBasesJson = escapeInlineJson\(\s*JSON\.stringify\(/,
    );
    // No hand-rolled copy of escapeInlineJson's "<" rule in the page.
    expect(appPage).not.toContain('\\u003c');
  });

  it('builds the browser contracts against the cross-origin fixture data', () => {
    expect(packageScripts['test:e2e']).toBe(
      'PUBLIC_ATLAS_DATA_BASE_URL=http://127.0.0.1:4323/ npm run build:e2e && playwright test',
    );
    expect(packageScripts['serve:atlas-data']).toBe(
      'node scripts/serve-atlas-data.mjs --root tests/fixtures/atlas/e2e',
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
    // Astro serialises each island prop as [type, value]; type 0 is a plain JSON value. Pin both
    // bases by name so swapped props fail.
    expect(explorerIslandProps(html)).toMatchObject({
      artifactDataBase: [0, BUCKET_BASE],
      siteDataBase: [0, '/data/atlas/'],
    });
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
