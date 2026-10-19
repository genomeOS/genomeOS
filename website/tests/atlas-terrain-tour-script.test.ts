/**
 * The manual World Terrain tour at production density, `scripts/terrain-tour-production-density.sh`
 * (terrain draping design, "Performance budget and measurement", #483; interaction design §5.2):
 * it builds the e2e bundle over the bucket with the production catalog in the fixture catalog's
 * place, restores that file on every exit, and runs the tour. Run here in a copy of the website's
 * layout, with `npm` and `npx` stubs that record what they were given and what the fixture
 * catalog held at the time: no build, no browser, and the real fixture catalog is never touched.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(
  import.meta.dirname,
  '..',
  'scripts',
  'terrain-tour-production-density.sh',
);
const FIXTURE = 'tests/fixtures/atlas/e2e/catalog.json';
const PRODUCTION = 'public/data/atlas/catalog.json';
const BASE = 'https://storage.googleapis.com/example-bucket/atlas/web/';

/** A stub that logs its arguments, the data base and the fixture catalog, then exits as told. */
const STUB = `#!/usr/bin/env bash
{
  echo "args: $*"
  echo "base: \${PUBLIC_ATLAS_DATA_BASE_URL:-}"
  echo "catalog: $(cat ${FIXTURE})"
} >> "$STUB_LOG"
name=$(basename "$0")
if [ "\${STUB_SIGNAL_FROM:-}" = "$name" ]; then kill -TERM "$PPID"; fi
status_var="STUB_STATUS_$name"
exit "\${!status_var:-0}"
`;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots = [];
});

/** Runs a copy of the script in a fresh website layout, with `npm` and `npx` stubbed. */
function run(
  args: string[] = [],
  env: Record<string, string> = { PUBLIC_ATLAS_DATA_BASE_URL: BASE },
) {
  const root = mkdtempSync(path.join(tmpdir(), 'terrain-tour-script-'));
  roots.push(root);
  const website = path.join(root, 'website');
  const bin = path.join(root, 'bin');
  const temp = path.join(root, 'tmp');
  for (const dir of [
    path.join(website, 'scripts'),
    path.join(website, path.dirname(FIXTURE)),
    path.join(website, path.dirname(PRODUCTION)),
    bin,
    temp,
  ])
    mkdirSync(dir, { recursive: true });
  const script = path.join(website, 'scripts', path.basename(SCRIPT));
  copyFileSync(SCRIPT, script);
  writeFileSync(path.join(website, FIXTURE), 'fixture');
  writeFileSync(path.join(website, PRODUCTION), 'production');
  for (const name of ['npm', 'npx']) {
    writeFileSync(path.join(bin, name), STUB);
    chmodSync(path.join(bin, name), 0o755);
  }
  const log = path.join(root, 'stub.log');
  writeFileSync(log, '');
  const result = spawnSync('bash', [script, ...args], {
    // Run from elsewhere: the script finds the website from its own path.
    cwd: root,
    encoding: 'utf8',
    env: {
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      TMPDIR: temp,
      ...env,
    },
  });
  return {
    catalog: readFileSync(path.join(website, FIXTURE), 'utf8'),
    leftovers: readdirSync(temp),
    log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    status: result.status,
    stderr: result.stderr,
  };
}

describe('the production-density terrain tour script (#483)', () => {
  it('builds the e2e bundle over the bucket with the production catalog, then runs the tour on the fixture catalog', () => {
    const { catalog, leftovers, log, status } = run([
      '--project=mobile-chromium',
    ]);
    expect(status).toBe(0);
    expect(log).toEqual([
      'args: run build:e2e',
      `base: ${BASE}`,
      'catalog: production',
      'args: playwright test tests/atlas-terrain-performance.spec.ts --project=mobile-chromium',
      `base: ${BASE}`,
      'catalog: fixture',
    ]);
    expect(catalog).toBe('fixture');
    expect(leftovers).toEqual([]);
  });

  it('restores the fixture catalog when the build fails, and runs no tour', () => {
    const { catalog, leftovers, log, status } = run([], {
      PUBLIC_ATLAS_DATA_BASE_URL: BASE,
      STUB_STATUS_npm: '3',
    });
    expect(status).toBe(3);
    expect(log.filter((line) => line.startsWith('args:'))).toEqual([
      'args: run build:e2e',
    ]);
    expect(catalog).toBe('fixture');
    expect(leftovers).toEqual([]);
  });

  it('restores the fixture catalog when the build is interrupted', () => {
    const { catalog, leftovers, status } = run([], {
      PUBLIC_ATLAS_DATA_BASE_URL: BASE,
      STUB_SIGNAL_FROM: 'npm',
    });
    expect(status).not.toBe(0);
    expect(catalog).toBe('fixture');
    expect(leftovers).toEqual([]);
  });

  it('exits with the tour’s status, the fixture catalog in place', () => {
    const { catalog, status } = run([], {
      PUBLIC_ATLAS_DATA_BASE_URL: BASE,
      STUB_STATUS_npx: '1',
    });
    expect(status).toBe(1);
    expect(catalog).toBe('fixture');
  });

  it.each([
    ['unset', {}],
    [
      'the local data server',
      { PUBLIC_ATLAS_DATA_BASE_URL: 'http://127.0.0.1:4323/' },
    ],
    ['no trailing slash', { PUBLIC_ATLAS_DATA_BASE_URL: BASE.slice(0, -1) }],
  ])(
    'refuses a data base that is %s, before touching anything',
    (_case, env: Record<string, string>) => {
      const { catalog, log, status, stderr } = run([], env);
      expect(status).toBe(2);
      expect(stderr).toMatch(/PUBLIC_ATLAS_DATA_BASE_URL/);
      expect(log).toEqual([]);
      expect(catalog).toBe('fixture');
    },
  );

  it('names no path of one machine and keeps no lock', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/private\/|\/home\/|scratchpad/);
    expect(text).not.toMatch(/shlock|flock|\.lock\b/);
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
