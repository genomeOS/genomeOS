import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzip } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAtlasDataServer } from '../scripts/serve-atlas-data.mjs';

const SERVER_SCRIPT = path.resolve(
  import.meta.dirname,
  '..',
  'scripts',
  'serve-atlas-data.mjs',
);

// Count compressions without changing them: the server must gzip each file
// version once, not on every GET and HEAD.
vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>();
  return { ...zlib, gzip: vi.fn(zlib.gzip) };
});

const GRID = 'grids/h3-r3.0123456789abcdef.gosa';
const ALLOWED = 'http://127.0.0.1:4322';
let parent = '';
let root = '';
let server: Server;
let port = 0;

function raw(
  pathName: string,
  headers: Record<string, string>,
  method = 'GET',
  serverPort = port,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port: serverPort, path: pathName, method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function listen(target: Server): Promise<number> {
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  return (target.address() as AddressInfo).port;
}

function close(target: Server): Promise<void> {
  return new Promise((resolve) => target.close(() => resolve()));
}

function corsFile(name: string, document: unknown): string {
  const file = path.join(parent, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

beforeAll(async () => {
  parent = mkdtempSync(path.join(tmpdir(), 'atlas-data-server-'));
  root = path.join(parent, 'tree');
  mkdirSync(path.join(root, 'grids'), { recursive: true });
  mkdirSync(path.join(root, 'folder.json'));
  writeFileSync(path.join(root, GRID), Buffer.from('GOSA fixture bytes'));
  writeFileSync(path.join(root, 'catalog.json'), '{"artifacts":[]}\n');
  writeFileSync(path.join(root, 'notes.txt'), 'not served');
  writeFileSync(path.join(parent, 'secret.json'), '{"outside":true}\n');
  server = createAtlasDataServer({ root });
  port = await listen(server);
});

afterAll(async () => {
  await close(server);
  rmSync(parent, { force: true, recursive: true });
});

describe('the bucket-like Atlas data origin', () => {
  it('serves gzip with the immutable cache policy and echoes an allowed origin', async () => {
    const response = await raw(`/${GRID}`, {
      'Accept-Encoding': 'gzip, deflate, br',
      Origin: 'http://127.0.0.1:4322',
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(response.body).toString()).toBe('GOSA fixture bytes');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:4322',
    );
    expect(response.headers['access-control-expose-headers']).toContain(
      'Content-Encoding',
    );
    expect(response.headers.vary).toContain('Origin');
  });

  it('grants nothing to an origin outside the CORS policy', async () => {
    const response = await raw(`/${GRID}`, { Origin: 'https://example.org' });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('transcodes for clients that do not accept gzip, and HEAD has no body', async () => {
    const identity = await raw('/catalog.json', {});
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.headers['content-type']).toBe('application/json');
    expect(identity.body.toString()).toBe('{"artifacts":[]}\n');
    const head = await raw(`/${GRID}`, { 'Accept-Encoding': 'gzip' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-encoding']).toBe('gzip');
    expect(head.body.byteLength).toBe(0);
  });

  it('serves only data files inside its root', async () => {
    expect((await raw('/notes.txt', {})).status).toBe(404);
    expect((await raw('/a%2F..%2F..%2Fsecret.json', {})).status).toBe(404);
    expect((await raw('/missing.json', {})).status).toBe(404);
  });

  it('answers a CORS preflight with the policy only for an allowed origin and method', async () => {
    const granted = await raw(
      `/${GRID}`,
      { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
      'OPTIONS',
    );
    expect(granted.status).toBe(204);
    expect(granted.body.byteLength).toBe(0);
    expect(granted.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(granted.headers['access-control-allow-methods']).toBe('GET, HEAD');
    expect(granted.headers['access-control-max-age']).toBe('3600');
    expect(granted.headers.vary).toContain('Origin');
    for (const refused of [
      { Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET' },
      { Origin: ALLOWED, 'Access-Control-Request-Method': 'PUT' },
      { Origin: ALLOWED },
    ] as Record<string, string>[]) {
      const response = await raw(`/${GRID}`, refused, 'OPTIONS');
      expect(response.status, JSON.stringify(refused)).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
      expect(response.headers['access-control-max-age']).toBeUndefined();
    }
  });

  it('refuses methods other than GET, HEAD and OPTIONS with 405 and an Allow header', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await raw(`/${GRID}`, { Origin: ALLOWED }, method);
      expect(response.status, method).toBe(405);
      expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('answers 400 for malformed percent-encoding and encoded NUL bytes', async () => {
    for (const pathName of ['/%E0%A4%A.json', '/grids/%ZZ.gosa', '/%00.json']) {
      expect((await raw(pathName, {})).status, pathName).toBe(400);
    }
  });

  it('compresses each file version once, however many GETs and HEADs ask for it', async () => {
    const compress = vi.mocked(gzip);
    const key = 'once.json';
    writeFileSync(path.join(root, key), '{"version":1}\n');
    compress.mockClear();
    const [first, second] = await Promise.all([
      raw(`/${key}`, { 'Accept-Encoding': 'gzip' }),
      raw(`/${key}`, { 'Accept-Encoding': 'gzip' }),
    ]);
    const head = await raw(`/${key}`, { 'Accept-Encoding': 'gzip' }, 'HEAD');
    const third = await raw(`/${key}`, { 'Accept-Encoding': 'gzip' });
    expect(compress).toHaveBeenCalledTimes(1);
    for (const response of [first, second, third]) {
      expect(gunzipSync(response.body).toString()).toBe('{"version":1}\n');
      expect(response.body.equals(first.body)).toBe(true);
    }
    expect(head.headers['content-length']).toBe(String(first.body.byteLength));

    writeFileSync(path.join(root, key), '{"version":2,"rewritten":true}\n');
    const rewritten = await raw(`/${key}`, { 'Accept-Encoding': 'gzip' });
    expect(gunzipSync(rewritten.body).toString()).toBe(
      '{"version":2,"rewritten":true}\n',
    );
    expect(compress).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for a directory or a path through a file, as for a missing object', async () => {
    expect((await raw('/folder.json', {})).status).toBe(404);
    expect((await raw('/catalog.json/inner.json', {})).status).toBe(404);
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports an unreadable object as a loud 500, not a 404',
    async () => {
      const locked = path.join(root, 'locked.json');
      writeFileSync(locked, '{"locked":true}\n');
      chmodSync(locked, 0o000);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (const headers of [
          { Origin: ALLOWED },
          { Origin: ALLOWED, 'Accept-Encoding': 'gzip' },
        ] as Record<string, string>[]) {
          const response = await raw('/locked.json', headers);
          expect(response.status).toBe(500);
          expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
        }
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining('/locked.json failed'),
          expect.objectContaining({ code: 'EACCES' }),
        );
      } finally {
        logged.mockRestore();
        chmodSync(locked, 0o600);
      }
    },
  );
});

describe('the data origin CORS document', () => {
  it('honours every entry, the first entry matching both origin and method', async () => {
    const policy = createAtlasDataServer({
      root,
      corsFile: corsFile('two-entries.json', [
        {
          origin: ['http://first.test'],
          method: ['GET', 'HEAD'],
          responseHeader: ['Content-Length'],
          maxAgeSeconds: 60,
        },
        {
          origin: ['http://second.test', 'http://first.test'],
          method: ['GET'],
          responseHeader: ['ETag'],
          maxAgeSeconds: 120,
        },
      ]),
    });
    const policyPort = await listen(policy);
    try {
      const second = await raw(
        '/catalog.json',
        { Origin: 'http://second.test' },
        'GET',
        policyPort,
      );
      expect(second.headers['access-control-allow-origin']).toBe(
        'http://second.test',
      );
      expect(second.headers['access-control-expose-headers']).toBe('ETag');
      const secondHead = await raw(
        '/catalog.json',
        { Origin: 'http://second.test' },
        'HEAD',
        policyPort,
      );
      expect(secondHead.headers['access-control-allow-origin']).toBeUndefined();
      const preflight = await raw(
        '/catalog.json',
        {
          Origin: 'http://second.test',
          'Access-Control-Request-Method': 'GET',
        },
        'OPTIONS',
        policyPort,
      );
      expect(preflight.headers['access-control-allow-methods']).toBe('GET');
      expect(preflight.headers['access-control-max-age']).toBe('120');
      const first = await raw(
        '/catalog.json',
        { Origin: 'http://first.test' },
        'GET',
        policyPort,
      );
      expect(first.headers['access-control-allow-origin']).toBe(
        'http://first.test',
      );
      expect(first.headers['access-control-expose-headers']).toBe(
        'Content-Length',
      );
    } finally {
      await close(policy);
    }
  });

  it.each([
    ['an object', { origin: ['http://a.test'] }, /non-empty array/],
    ['an empty array', [], /non-empty array/],
    ['a non-object entry', ['http://a.test'], /entry 0 is not an object/],
    [
      'an entry without origins',
      [{ origin: [], method: ['GET'] }],
      /entry 0: origin/,
    ],
    [
      'a later entry without methods',
      [
        { origin: ['http://a.test'], method: ['GET'] },
        { origin: ['http://b.test'] },
      ],
      /entry 1: method/,
    ],
    [
      'a misspelt key',
      [{ origin: ['http://a.test'], methods: ['GET'] }],
      /unknown keys methods/,
    ],
    [
      'a string max age',
      [{ origin: ['http://a.test'], method: ['GET'], maxAgeSeconds: '3600' }],
      /maxAgeSeconds/,
    ],
    [
      'a wildcard origin',
      [{ origin: ['*'], method: ['GET'] }],
      /wildcard origins/,
    ],
  ])(
    'refuses %s instead of serving a partial policy',
    (name, document, message) => {
      const file = corsFile(`bad-${name.replaceAll(' ', '-')}.json`, document);
      expect(() => createAtlasDataServer({ root, corsFile: file })).toThrow(
        message,
      );
      expect(() => createAtlasDataServer({ root, corsFile: file })).toThrow(
        file,
      );
    },
  );

  it('refuses a CORS file that is not JSON', () => {
    const file = path.join(parent, 'not-json.json');
    writeFileSync(file, '[{"origin":');
    expect(() => createAtlasDataServer({ root, corsFile: file })).toThrow(
      /not a readable JSON document/,
    );
  });
});

describe('test-only extra origins', () => {
  // A PLAYWRIGHT_PORT override (#411) moves the site to a port the bucket's
  // CORS document does not list; the local data server alone may grant it.
  const MOVED_SITE = 'http://127.0.0.1:4352';

  it('grants an extra loopback site origin what the CORS document grants', async () => {
    const plain = await raw(`/${GRID}`, { Origin: MOVED_SITE });
    expect(plain.headers['access-control-allow-origin']).toBeUndefined();
    const widened = createAtlasDataServer({ root, allowOrigins: [MOVED_SITE] });
    const widenedPort = await listen(widened);
    try {
      const get = await raw(
        `/${GRID}`,
        { Origin: MOVED_SITE },
        'GET',
        widenedPort,
      );
      expect(get.headers['access-control-allow-origin']).toBe(MOVED_SITE);
      expect(get.headers['access-control-expose-headers']).toBe(
        'Content-Length, Content-Type, Content-Encoding, ETag',
      );
      const preflight = await raw(
        `/${GRID}`,
        { Origin: MOVED_SITE, 'Access-Control-Request-Method': 'GET' },
        'OPTIONS',
        widenedPort,
      );
      expect(preflight.headers['access-control-allow-origin']).toBe(MOVED_SITE);
      expect(preflight.headers['access-control-allow-methods']).toBe(
        'GET, HEAD',
      );
      expect(preflight.headers['access-control-max-age']).toBe('3600');
      const listed = await raw(
        `/${GRID}`,
        { Origin: ALLOWED },
        'GET',
        widenedPort,
      );
      expect(listed.headers['access-control-allow-origin']).toBe(ALLOWED);
      const other = await raw(
        `/${GRID}`,
        { Origin: 'http://127.0.0.1:4353' },
        'GET',
        widenedPort,
      );
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await close(widened);
    }
  });

  it.each([
    '*',
    '',
    'https://example.org',
    'http://192.168.1.20:4352',
    'https://127.0.0.1:4352',
    'http://127.0.0.1:4352/',
    'http://localhost:4352/app/',
    '127.0.0.1:4352',
  ])('refuses the extra origin %j', (origin) => {
    expect(() =>
      createAtlasDataServer({ root, allowOrigins: [origin] }),
    ).toThrow(/--allow-origin/);
  });

  it('takes repeatable --allow-origin flags on the command line', async () => {
    const child = spawn(
      process.execPath,
      [
        SERVER_SCRIPT,
        '--root',
        root,
        '--port',
        '0',
        '--allow-origin',
        MOVED_SITE,
        '--allow-origin',
        'http://localhost:4352',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const line = await new Promise<string>((resolve, reject) => {
        child.stdout!.once('data', (chunk: Buffer) =>
          resolve(chunk.toString()),
        );
        child.once('exit', (code) =>
          reject(new Error(`serve-atlas-data exited with code ${code}`)),
        );
      });
      const announced = /at http:\/\/127\.0\.0\.1:(\d+)\//.exec(line);
      expect(announced, line).not.toBeNull();
      const cliPort = Number(announced![1]);
      for (const origin of [MOVED_SITE, 'http://localhost:4352', ALLOWED]) {
        const response = await raw(
          `/${GRID}`,
          { Origin: origin },
          'GET',
          cliPort,
        );
        expect(response.headers['access-control-allow-origin'], origin).toBe(
          origin,
        );
      }
    } finally {
      child.kill();
      if (child.exitCode === null && child.signalCode === null)
        await once(child, 'exit');
    }
  });
});
