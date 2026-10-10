/**
 * Serve a directory the way the public GCS bucket serves `atlas/web/` (design
 * 2026-10-07 §C.2, §C.3): gzip transport encoding when the client accepts it
 * (identity otherwise, like decompressive transcoding), the immutable
 * Cache-Control, and CORS grants only for origins in deploy/atlas-web-cors.json.
 * Playwright starts it on 127.0.0.1:4323 for the committed e2e tree (and for an
 * ATLAS_DATA_DIR staging tree in the performance harness), so browser tests
 * exercise absolute-URL resolution, crossorigin preload matching, CORS and
 * Content-Encoding.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const CONTENT_TYPES = {
  '.gosa': 'application/octet-stream',
  '.json': 'application/json',
};
const CORS_FILE = fileURLToPath(
  new URL('../../deploy/atlas-web-cors.json', import.meta.url),
);

export function createAtlasDataServer({ root }) {
  const base = path.resolve(root);
  const [policy] = JSON.parse(readFileSync(CORS_FILE, 'utf8'));
  const origins = new Set(policy.origin);
  return createServer(async (request, response) => {
    const headers = { Vary: 'Origin' };
    const origin = request.headers.origin;
    if (origin && origins.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Expose-Headers'] =
        policy.responseHeader.join(', ');
    }
    if (request.method === 'OPTIONS') {
      if (headers['Access-Control-Allow-Origin']) {
        headers['Access-Control-Allow-Methods'] = policy.method.join(', ');
        headers['Access-Control-Max-Age'] = String(policy.maxAgeSeconds);
      }
      response.writeHead(204, headers).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, headers).end();
      return;
    }
    let file;
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? '/', 'http://fixture.invalid').pathname,
      );
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
    let body;
    try {
      body = await readFile(file);
    } catch {
      response.writeHead(404, headers).end();
      return;
    }
    const gzip = /\bgzip\b/.test(
      String(request.headers['accept-encoding'] ?? ''),
    );
    const payload = gzip ? gzipSync(body, { level: 9 }) : body;
    headers['Cache-Control'] = IMMUTABLE;
    headers['Content-Type'] = type;
    headers['Content-Length'] = String(payload.length);
    if (gzip) headers['Content-Encoding'] = 'gzip';
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : payload);
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
