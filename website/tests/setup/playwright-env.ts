/**
 * Opt-in local overrides shared by both Playwright configs (#411). CI sets neither variable, so
 * CI keeps one worker per shard and the test server on 127.0.0.1:4322.
 */
import { readFileSync } from 'node:fs';

type Environment = Readonly<Record<string, string | undefined>>;

/** The `serve:test` port when `PLAYWRIGHT_PORT` is unset; package.json repeats it as the default. */
export const DEFAULT_PLAYWRIGHT_PORT = 4322;

function integerFromEnv(
  env: Environment,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value <= max))
    throw new Error(
      `${name} must be an integer from 1 to ${max}, got "${raw}"`,
    );
  return value;
}

/** `PLAYWRIGHT_WORKERS`: the Playwright worker count, default 1. */
export function playwrightWorkers(env: Environment = process.env): number {
  return integerFromEnv(env, 'PLAYWRIGHT_WORKERS', 1, Number.MAX_SAFE_INTEGER);
}

/** `PLAYWRIGHT_PORT`: the port `npm run serve:test` listens on, default 4322. */
export function playwrightPort(env: Environment = process.env): number {
  return integerFromEnv(
    env,
    'PLAYWRIGHT_PORT',
    DEFAULT_PLAYWRIGHT_PORT,
    65_535,
  );
}

/** The bucket's CORS document, which `serve-atlas-data` applies (design 2026-10-07 §C.2). */
const ATLAS_CORS_FILE = new URL(
  '../../../deploy/atlas-web-cors.json',
  import.meta.url,
);

/** Every origin the bucket's CORS document grants. */
export function atlasCorsOrigins(): string[] {
  const entries = JSON.parse(readFileSync(ATLAS_CORS_FILE, 'utf8')) as {
    origin: string[];
  }[];
  return entries.flatMap((entry) => entry.origin);
}

/**
 * Extra `serve-atlas-data` arguments for the Playwright site origin. The CORS document lists the
 * default local ports, so CI passes none; a `PLAYWRIGHT_PORT` the document does not list gets the
 * test-only `--allow-origin`, and the document itself never widens.
 */
export function atlasDataServerArgs(
  siteOrigin: string,
  corsOrigins: readonly string[] = atlasCorsOrigins(),
): string[] {
  return corsOrigins.includes(siteOrigin) ? [] : ['--allow-origin', siteOrigin];
}
