/**
 * The local stand-in for the public data store that browser SQL reads by range (Atlas data
 * platform design 2026-10-18 §3.1, step 1.13): GCS's range and CORS behaviour under
 * deploy/data-store-cors.json, plus the request log and forced statuses the browser tests drive.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDataStoreServer } from '../scripts/serve-data-store.mjs';

const KEY = 'releases/2000-01-01/object.parquet';
const OBJECT = Buffer.from(
  Array.from({ length: 4096 }, (_, index) => index % 256),
);
const SITE = 'http://127.0.0.1:4322';
const EXPOSED =
  'Content-Length, Content-Type, ETag, Content-Range, Accept-Ranges, Range';
let parent = '';
let root = '';
let server: Server;
let port = 0;

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function raw(
  pathName: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Reply> {
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

function ranged(range: string): Promise<Reply> {
  return raw(`/${KEY}`, { Origin: SITE, Range: range });
}

async function requests(): Promise<unknown[]> {
  return JSON.parse((await raw('/__requests')).body.toString()) as unknown[];
}

beforeAll(async () => {
  parent = mkdtempSync(path.join(tmpdir(), 'data-store-server-'));
  root = path.join(parent, 'store');
  mkdirSync(path.join(root, 'releases', '2000-01-01'), { recursive: true });
  writeFileSync(path.join(root, KEY), OBJECT);
  server = createDataStoreServer({ root });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

beforeEach(async () => {
  await raw('/__control?force=off');
  await requests();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(parent, { force: true, recursive: true });
});

describe('the data store stand-in: range reads', () => {
  it('answers a ranged GET with 206, its slice and the bucket headers', async () => {
    const response = await ranged('bytes=0-1023');
    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 0-1023/4096');
    expect(response.body.equals(OBJECT.subarray(0, 1024))).toBe(true);
    expect(response.headers['content-length']).toBe('1024');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-expose-headers']).toBe(EXPOSED);
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-type']).toBe(
      'application/vnd.apache.parquet',
    );
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('answers suffix and open ranges', async () => {
    const suffix = await ranged('bytes=-100');
    expect(suffix.status).toBe(206);
    expect(suffix.headers['content-range']).toBe('bytes 3996-4095/4096');
    expect(suffix.body.equals(OBJECT.subarray(3996))).toBe(true);
    const open = await ranged('bytes=4000-');
    expect(open.status).toBe(206);
    expect(open.headers['content-range']).toBe('bytes 4000-4095/4096');
    expect(open.body.byteLength).toBe(96);
    const past = await ranged('bytes=4000-9999');
    expect(past.headers['content-range']).toBe('bytes 4000-4095/4096');
  });

  it('refuses unsatisfiable and multi-part ranges with 416', async () => {
    for (const range of ['bytes=4096-', 'bytes=-0', 'bytes=0-1,4-5']) {
      const response = await ranged(range);
      expect(response.status, range).toBe(416);
      expect(response.headers['content-range'], range).toBe('bytes */4096');
      expect(response.body.byteLength, range).toBe(0);
    }
  });

  it('serves the whole object without a Range, and HEAD advertises byte ranges', async () => {
    const whole = await raw(`/${KEY}`, { Origin: SITE });
    expect(whole.status).toBe(200);
    expect(whole.body.equals(OBJECT)).toBe(true);
    const head = await raw(`/${KEY}`, { Origin: SITE }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(head.headers['content-length']).toBe('4096');
    expect(head.body.byteLength).toBe(0);
  });

  it("answers a HEAD with a Range by 206, as GCS does and DuckDB-WASM's open expects", async () => {
    const head = await raw(
      `/${KEY}`,
      { Origin: SITE, Range: 'bytes=0-' },
      'HEAD',
    );
    expect(head.status).toBe(206);
    expect(head.headers['content-range']).toBe('bytes 0-4095/4096');
    expect(head.headers['content-length']).toBe('4096');
    expect(head.body.byteLength).toBe(0);
  });

  it('serves the whole object under no-range/, whatever the Range asks', async () => {
    const response = await raw(`/no-range/${KEY}`, {
      Origin: SITE,
      Range: 'bytes=0-1023',
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['accept-ranges']).toBeUndefined();
    expect(response.body.equals(OBJECT)).toBe(true);
    const head = await raw(
      `/no-range/${KEY}`,
      { Origin: SITE, Range: 'bytes=0-' },
      'HEAD',
    );
    expect(head.status).toBe(200);
  });

  it('answers 404 outside its root and for an unserved type', async () => {
    writeFileSync(path.join(root, 'notes.txt'), 'not a store object');
    expect((await raw('/releases/2000-01-01/missing.parquet')).status).toBe(
      404,
    );
    expect((await raw('/notes.txt')).status).toBe(404);
    expect((await raw('/a%2F..%2F..%2Fsecret.parquet')).status).toBe(404);
  });
});

describe('the data store stand-in: CORS', () => {
  it('grants a preflight asking for the Range header', async () => {
    const response = await raw(
      `/${KEY}`,
      {
        Origin: SITE,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
      },
      'OPTIONS',
    );
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD');
    expect(response.headers['access-control-allow-headers']).toBe(EXPOSED);
    expect(response.headers['access-control-max-age']).toBe('3600');
  });

  it('gives a preflight for an unlisted header or method no CORS headers', async () => {
    for (const asked of [
      {
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-custom',
      },
      { 'Access-Control-Request-Method': 'PUT' },
    ] as Record<string, string>[]) {
      const response = await raw(
        `/${KEY}`,
        { Origin: SITE, ...asked },
        'OPTIONS',
      );
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-headers']).toBeUndefined();
    }
  });

  it('sends no CORS headers to a request without an Origin', async () => {
    const response = await raw(`/${KEY}`, { Range: 'bytes=0-1' });
    expect(response.status).toBe(206);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a CORS document that does not grant every origin', () => {
    const file = path.join(parent, 'listed-origin.json');
    writeFileSync(
      file,
      JSON.stringify([
        {
          origin: ['https://genome-os.org'],
          method: ['GET', 'HEAD'],
          responseHeader: ['Content-Range'],
          maxAgeSeconds: 3600,
        },
      ]),
    );
    expect(() => createDataStoreServer({ root, corsFile: file })).toThrow(
      /origin/,
    );
  });
});

describe('the data store stand-in: test controls', () => {
  it('logs each store request once, and the log read clears it', async () => {
    await ranged('bytes=0-1023');
    await raw(`/${KEY}`, { Origin: SITE }, 'HEAD');
    await raw(`/no-range/${KEY}`, { Origin: SITE, Range: 'bytes=0-9' });
    expect(await requests()).toEqual([
      {
        method: 'GET',
        path: `/${KEY}`,
        range: 'bytes=0-1023',
        status: 206,
        bytes: 1024,
      },
      { method: 'HEAD', path: `/${KEY}`, range: null, status: 200, bytes: 0 },
      {
        method: 'GET',
        path: `/no-range/${KEY}`,
        range: 'bytes=0-9',
        status: 200,
        bytes: 4096,
      },
    ]);
    expect(await requests()).toEqual([]);
  });

  it('answers every store request with a forced 403 or 404 until it is turned off', async () => {
    for (const status of [403, 404]) {
      expect((await raw(`/__control?force=${status}`)).status).toBe(204);
      const forced = await ranged('bytes=0-1023');
      expect(forced.status).toBe(status);
      expect(forced.headers['access-control-allow-origin']).toBe('*');
      const head = await raw(`/${KEY}`, { Origin: SITE }, 'HEAD');
      expect(head.status).toBe(status);
    }
    await raw('/__control?force=off');
    expect((await ranged('bytes=0-1023')).status).toBe(206);
    expect(
      (await requests()).map((entry) => (entry as { status: number }).status),
    ).toEqual([403, 403, 404, 404, 206]);
  });

  it('refuses an unknown control', async () => {
    expect((await raw('/__control?force=500')).status).toBe(400);
    expect((await raw('/__control')).status).toBe(400);
  });
});
