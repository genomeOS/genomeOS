/**
 * Serve a data-store tree the way the public bucket `genomeos-atlas-data` answers a browser (Atlas
 * data platform design 2026-10-18 §3.1, §11 step 1.13), so the browser SQL tests read the committed
 * fixture (`tests/fixtures/data-store/`) over HTTP exactly as DuckDB-WASM reads GCS:
 *
 * - objects at their keys, stored as is (never gzip, which makes GCS ignore `Range`), with the
 *   upload's `Cache-Control` (`public, max-age=3600`), an MD5 `ETag` and `Accept-Ranges: bytes`;
 * - one byte range per GET or HEAD (`bytes=a-b`, `bytes=a-` or `bytes=-n`) as a 206 with
 *   `Content-Range`; an unsatisfiable, malformed or multi-part range is a 416. GCS answers a HEAD
 *   with a Range by 206 too (observed anonymously on the data store, 2026-11-15), and DuckDB-WASM
 *   opens a file over HTTP with exactly that request (`HEAD` with `Range: bytes=0-`);
 * - CORS from `deploy/data-store-cors.json` as GCS's XML API applies it: a read or preflight with an
 *   `Origin` and a listed method gets `Access-Control-Allow-Origin: *`; `responseHeader` is both the
 *   read's `Access-Control-Expose-Headers` and the preflight's `Access-Control-Allow-Headers`; and a
 *   preflight asking for any other request header or method gets 200 with no CORS headers.
 *
 * Test controls, which the bucket does not have:
 * - `/no-range/<key>` serves the whole object whatever `Range` asks, as a server that ignores it;
 * - `/__requests` returns, and clears, the log of store requests as `{method, path, range, status,
 *   bytes}` (`bytes`: body bytes sent);
 * - `/__control?force=403|404|off` answers every object request with that status (a paused bucket, a
 *   withdrawn object) until `off`.
 *
 * Playwright starts it on 127.0.0.1:4324 (`npm run serve:data-store`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** What `publish_data_store.py` sets on every object (`data_release.CACHE_CONTROL`). */
const CACHE_CONTROL = 'public, max-age=3600';
/** The served subset of `data_release.MEDIA_TYPES`: what a catalog and its manifests hold. */
const CONTENT_TYPES = {
  '.duckdb': 'application/octet-stream',
  '.json': 'application/json',
  '.parquet': 'application/vnd.apache.parquet',
  '.sql': 'application/sql',
};
const CORS_FILE = fileURLToPath(
  new URL('../../deploy/data-store-cors.json', import.meta.url),
);
const CORS_KEYS = new Set([
  'origin',
  'method',
  'responseHeader',
  'maxAgeSeconds',
]);
const NO_RANGE = '/no-range/';
/** GCS's XML error code for each status this server answers with an error body. */
const ERROR_CODES = { 403: 'AccessDenied', 404: 'NoSuchKey' };
const FORCE_VALUES = new Set(['403', '404', 'off']);
// Read failures that mean "no such object" (GCS answers 404); any other failure is a server fault.
const NO_SUCH_OBJECT = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG']);

function isStringList(value, { nonEmpty }) {
  return (
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}

/**
 * The entries of a `gcloud storage buckets update --cors-file` document, checked. The data store
 * grants every origin (§4: anonymous reads), so an entry that does not list `*` is refused: this
 * server models only that policy, and a malformed document is a hard error, never a partial one.
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
    if (
      !isStringList(entry.origin, { nonEmpty: true }) ||
      !entry.origin.includes('*')
    ) {
      fail(
        `${where}: origin must list "*": the data store grants every origin, and this server models only that`,
      );
    }
    if (!isStringList(entry.method, { nonEmpty: true })) {
      fail(`${where}: method must be a non-empty array of strings`);
    }
    const responseHeader = entry.responseHeader ?? [];
    if (!isStringList(responseHeader, { nonEmpty: false })) {
      fail(`${where}: responseHeader must be an array of strings`);
    }
    const maxAge = entry.maxAgeSeconds;
    if (maxAge !== undefined && !(Number.isInteger(maxAge) && maxAge >= 0)) {
      fail(`${where}: maxAgeSeconds must be a non-negative integer`);
    }
    return {
      methods: entry.method,
      responseHeader,
      allowed: new Set(responseHeader.map((name) => name.toLowerCase())),
      maxAgeSeconds: maxAge,
    };
  });
}

/**
 * The single byte range `header` asks of an object of `size` bytes, as `[first, last]`; `null`
 * when there is no Range; `'unsatisfiable'` for any range this server (and so the test) must not
 * honour: past the end, empty, malformed, or more than one.
 */
function byteRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'unsatisfiable';
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix === 0 || size === 0
      ? 'unsatisfiable'
      : [Math.max(0, size - suffix), size - 1];
  }
  const first = Number(match[1]);
  const last = match[2] === '' ? size - 1 : Number(match[2]);
  if (first >= size || last < first) return 'unsatisfiable';
  return [first, Math.min(last, size - 1)];
}

function errorBody(status) {
  const code = ERROR_CODES[status];
  return Buffer.from(
    `<?xml version='1.0' encoding='UTF-8'?><Error><Code>${code}</Code></Error>`,
  );
}

/**
 * @param {{ root: string, corsFile?: string }} options
 */
export function createDataStoreServer({ root, corsFile = CORS_FILE }) {
  const base = path.resolve(root);
  const policy = readCorsPolicy(corsFile);
  /** @type {{ method: string, path: string, range: string | null, status: number, bytes: number }[]} */
  let log = [];
  /** @type {number | null} */
  let forced = null;

  /** The first entry granting this origin this method, as GCS matches them. */
  function corsEntry(origin, method) {
    if (!origin || !method) return undefined;
    return policy.find((entry) => entry.methods.includes(method));
  }

  /** The object's file, `null` for a path outside the root or of an unserved type, or 400. */
  function objectFile(pathname) {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes('\0')) throw new URIError('NUL in path');
    const file = path.resolve(base, `.${decoded}`);
    const served =
      file.startsWith(`${base}${path.sep}`) &&
      Object.hasOwn(CONTENT_TYPES, path.extname(file));
    return served ? file : null;
  }

  async function readObject(file) {
    try {
      return await readFile(file);
    } catch (error) {
      if (NO_SUCH_OBJECT.has(error?.code)) return null;
      throw error;
    }
  }

  function preflight(request, response) {
    const entry = corsEntry(
      request.headers.origin,
      request.headers['access-control-request-method'],
    );
    const asked = String(
      request.headers['access-control-request-headers'] ?? '',
    )
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const headers = { Vary: 'Origin' };
    if (entry && asked.every((name) => entry.allowed.has(name))) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = entry.methods.join(', ');
      if (entry.responseHeader.length > 0) {
        headers['Access-Control-Allow-Headers'] =
          entry.responseHeader.join(', ');
      }
      if (entry.maxAgeSeconds !== undefined) {
        headers['Access-Control-Max-Age'] = String(entry.maxAgeSeconds);
      }
    }
    response.writeHead(200, { ...headers, 'Content-Length': '0' }).end();
    return { status: 200, bytes: 0 };
  }

  /** Answers a GET or HEAD of an object; returns what the log records. */
  async function serveObject(request, response, pathname) {
    const entry = corsEntry(request.headers.origin, request.method);
    const headers = { Vary: 'Origin' };
    if (entry) {
      headers['Access-Control-Allow-Origin'] = '*';
      if (entry.responseHeader.length > 0) {
        headers['Access-Control-Expose-Headers'] =
          entry.responseHeader.join(', ');
      }
    }
    const head = request.method === 'HEAD';
    const send = (status, extra, body) => {
      const payload = body ?? Buffer.alloc(0);
      response.writeHead(status, {
        ...headers,
        ...extra,
        'Content-Length': String(payload.length),
      });
      response.end(head ? undefined : payload);
      return { status, bytes: head ? 0 : payload.length };
    };
    const error = (status) =>
      send(
        status,
        { 'Content-Type': 'application/xml; charset=UTF-8' },
        errorBody(status),
      );
    if (forced !== null) return error(forced);
    const honoursRange = !pathname.startsWith(NO_RANGE);
    let file;
    try {
      file = objectFile(
        honoursRange ? pathname : pathname.slice(NO_RANGE.length - 1),
      );
    } catch {
      return send(400, {});
    }
    const data = file === null ? null : await readObject(file);
    if (data === null) return error(404);
    const object = {
      'Cache-Control': CACHE_CONTROL,
      'Content-Type': CONTENT_TYPES[path.extname(file)],
      ETag: `"${createHash('md5').update(data).digest('hex')}"`,
    };
    if (!honoursRange) return send(200, object, data);
    object['Accept-Ranges'] = 'bytes';
    const range = byteRange(request.headers.range, data.length);
    if (range === null) return send(200, object, data);
    if (range === 'unsatisfiable') {
      return send(416, { 'Content-Range': `bytes */${data.length}` });
    }
    const [first, last] = range;
    return send(
      206,
      { ...object, 'Content-Range': `bytes ${first}-${last}/${data.length}` },
      data.subarray(first, last + 1),
    );
  }

  function control(url, response) {
    if (url.pathname === '/__requests') {
      const body = Buffer.from(JSON.stringify(log));
      log = [];
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      });
      response.end(body);
      return;
    }
    const force = url.searchParams.get('force');
    if (force === null || !FORCE_VALUES.has(force)) {
      response.writeHead(400).end();
      return;
    }
    forced = force === 'off' ? null : Number(force);
    response.writeHead(204).end();
  }

  async function handle(request, response, url) {
    if (url.pathname === '/__requests' || url.pathname === '/__control') {
      control(url, response);
      return;
    }
    let result;
    if (request.method === 'OPTIONS') {
      result = preflight(request, response);
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      result = await serveObject(request, response, url.pathname);
    } else {
      response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end();
      result = { status: 405, bytes: 0 };
    }
    log.push({
      method: request.method ?? '',
      path: url.pathname,
      range: request.headers.range ?? null,
      ...result,
    });
  }

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://store.invalid');
    handle(request, response, url).catch((error) => {
      console.error(
        `serve-data-store: ${request.method} ${request.url} failed:`,
        error,
      );
      if (response.headersSent) response.destroy();
      else response.writeHead(500).end();
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
      port: { type: 'string', default: '4324' },
    },
  });
  if (!values.root) throw new Error('--root is required');
  const server = createDataStoreServer({ root: values.root });
  server.listen(Number(values.port), values.host, () =>
    console.log(
      `Data store ${path.resolve(values.root)} at http://${values.host}:${server.address().port}/`,
    ),
  );
}
