/**
 * Serve a directory the way the public GCS bucket serves `atlas/web/` (design
 * 2026-10-07 §C.2, §C.3): gzip transport encoding when the client accepts it
 * (identity otherwise, like decompressive transcoding), the immutable
 * Cache-Control, and CORS grants only for origins in deploy/atlas-web-cors.json.
 * Playwright starts it on 127.0.0.1:4323 for the committed e2e tree (and for an
 * ATLAS_DATA_DIR staging tree in the performance harness), so browser tests
 * exercise absolute-URL resolution, crossorigin preload matching, CORS and
 * Content-Encoding.
 *
 * The bucket stores every object gzipped once at upload, so this server
 * compresses each file version once too: off the event loop, shared by
 * concurrent requests, and kept for the server's lifetime (a test or staging
 * tree, never the whole bucket).
 */
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzip } from 'node:zlib';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const CONTENT_TYPES = {
  '.gosa': 'application/octet-stream',
  '.json': 'application/json',
};
const CORS_FILE = fileURLToPath(
  new URL('../../deploy/atlas-web-cors.json', import.meta.url),
);
const CORS_KEYS = new Set([
  'origin',
  'method',
  'responseHeader',
  'maxAgeSeconds',
]);
// Read failures that mean "no such object" (GCS answers 404); any other
// failure (EACCES, EMFILE, EIO, ...) is a server fault and answers 500.
const NO_SUCH_OBJECT = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isStringList(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
  );
}

/**
 * Every entry of a `gcloud storage buckets update --cors-file` document,
 * checked. A malformed document is a hard error, never a partial policy.
 */
function readCorsPolicy(file) {
  const fail = (problem) => {
    throw new Error(`${file}: ${problem}`);
  };
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`not a readable JSON document (${error.message})`);
  }
  if (!Array.isArray(document) || document.length === 0) {
    fail('expected a non-empty array of CORS entries');
  }
  return document.map((entry, index) => {
    const where = `CORS entry ${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${where} is not an object`);
    }
    const unknown = Object.keys(entry).filter((key) => !CORS_KEYS.has(key));
    if (unknown.length > 0) {
      fail(`${where} has unknown keys ${unknown.join(', ')}`);
    }
    if (!isStringList(entry.origin)) {
      fail(`${where}: origin must be a non-empty array of strings`);
    }
    if (entry.origin.includes('*')) {
      fail(`${where}: wildcard origins are not modelled by this server`);
    }
    if (!isStringList(entry.method)) {
      fail(`${where}: method must be a non-empty array of strings`);
    }
    const responseHeader = entry.responseHeader ?? [];
    if (
      !Array.isArray(responseHeader) ||
      !responseHeader.every(isNonEmptyString)
    ) {
      fail(`${where}: responseHeader must be an array of strings`);
    }
    const maxAge = entry.maxAgeSeconds;
    if (maxAge !== undefined && !(Number.isInteger(maxAge) && maxAge >= 0)) {
      fail(`${where}: maxAgeSeconds must be a non-negative integer`);
    }
    return {
      origins: new Set(entry.origin),
      methods: entry.method,
      responseHeader,
      maxAgeSeconds: maxAge,
    };
  });
}

/** The first entry, in document order, that grants this origin this method. */
function corsEntry(policy, origin, method) {
  if (!origin || !method) return undefined;
  return policy.find(
    (entry) => entry.origins.has(origin) && entry.methods.includes(method),
  );
}

function gzipLevel9(body) {
  return new Promise((resolve, reject) =>
    gzip(body, { level: 9 }, (error, payload) =>
      error ? reject(error) : resolve(payload),
    ),
  );
}

export function createAtlasDataServer({ root, corsFile = CORS_FILE }) {
  const base = path.resolve(root);
  const policy = readCorsPolicy(corsFile);
  /** @type {Map<string, { version: string, payload: Promise<Buffer> }>} */
  const compressed = new Map();

  /** The object's bytes and encoding, or null when there is no such object. */
  async function readObject(file, acceptsGzip) {
    let handle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if (NO_SUCH_OBJECT.has(error?.code)) return null;
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return null;
      if (!acceptsGzip) return { payload: await handle.readFile() };
      const version = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
      let cached = compressed.get(file);
      if (cached?.version !== version) {
        const entry = {
          version,
          payload: handle.readFile().then(gzipLevel9),
        };
        compressed.set(file, entry);
        entry.payload.catch(() => {
          if (compressed.get(file) === entry) compressed.delete(file);
        });
        cached = entry;
      }
      return { payload: await cached.payload, encoding: 'gzip' };
    } finally {
      await handle.close();
    }
  }

  async function respond(request, response, headers) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response
        .writeHead(405, { ...headers, Allow: 'GET, HEAD, OPTIONS' })
        .end();
      return;
    }
    let file;
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? '/', 'http://fixture.invalid').pathname,
      );
      if (pathname.includes('\0')) throw new URIError('NUL in path');
      file = path.resolve(base, `.${pathname}`);
    } catch {
      response.writeHead(400, headers).end();
      return;
    }
    const type = CONTENT_TYPES[path.extname(file)];
    if (!type || !file.startsWith(`${base}${path.sep}`)) {
      response.writeHead(404, headers).end();
      return;
    }
    const acceptsGzip = /\bgzip\b/.test(
      String(request.headers['accept-encoding'] ?? ''),
    );
    const object = await readObject(file, acceptsGzip);
    if (!object) {
      response.writeHead(404, headers).end();
      return;
    }
    const { payload, encoding } = object;
    response.writeHead(200, {
      ...headers,
      'Cache-Control': IMMUTABLE,
      'Content-Type': type,
      'Content-Length': String(payload.length),
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : payload);
  }

  return createServer((request, response) => {
    const origin = request.headers.origin;
    const preflight = request.method === 'OPTIONS';
    const entry = corsEntry(
      policy,
      origin,
      preflight
        ? request.headers['access-control-request-method']
        : request.method,
    );
    const headers = { Vary: 'Origin' };
    if (entry) {
      headers['Access-Control-Allow-Origin'] = origin;
      if (entry.responseHeader.length > 0) {
        headers['Access-Control-Expose-Headers'] =
          entry.responseHeader.join(', ');
      }
      if (preflight) {
        headers['Access-Control-Allow-Methods'] = entry.methods.join(', ');
        if (entry.maxAgeSeconds !== undefined) {
          headers['Access-Control-Max-Age'] = String(entry.maxAgeSeconds);
        }
      }
    }
    respond(request, response, headers).catch((error) => {
      console.error(
        `serve-atlas-data: ${request.method} ${request.url} failed:`,
        error,
      );
      if (response.headersSent) response.destroy();
      else response.writeHead(500, headers).end();
    });
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '4323' },
    },
  });
  if (!values.root) throw new Error('--root is required');
  createAtlasDataServer({ root: values.root }).listen(
    Number(values.port),
    values.host,
    () =>
      console.log(
        `Atlas data ${path.resolve(values.root)} at http://${values.host}:${values.port}/`,
      ),
  );
}
