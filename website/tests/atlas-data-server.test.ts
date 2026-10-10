import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAtlasDataServer } from '../scripts/serve-atlas-data.mjs';

const GRID = 'grids/h3-r3.0123456789abcdef.gosa';
let parent = '';
let server: Server;
let port = 0;

function raw(
  pathName: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, path: pathName, method, headers },
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

beforeAll(async () => {
  parent = mkdtempSync(path.join(tmpdir(), 'atlas-data-server-'));
  const root = path.join(parent, 'tree');
  mkdirSync(path.join(root, 'grids'), { recursive: true });
  writeFileSync(path.join(root, GRID), Buffer.from('GOSA fixture bytes'));
  writeFileSync(path.join(root, 'catalog.json'), '{"artifacts":[]}\n');
  writeFileSync(path.join(root, 'notes.txt'), 'not served');
  writeFileSync(path.join(parent, 'secret.json'), '{"outside":true}\n');
  server = createAtlasDataServer({ root });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
});
