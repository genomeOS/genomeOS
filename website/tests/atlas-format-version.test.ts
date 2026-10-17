import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { atlasCatalogSchema, parseAtlasCatalog } from '../src/atlas/contracts';
import {
  ATLAS_WEB_FORMAT_VERSION,
  AtlasFormatVersionError,
  catalogReadMode,
  parseFormatVersion,
  SUPPORTED_FORMAT,
} from '../src/atlas/format-version';
import { loadPageCatalog } from '../src/lib/catalog-build';
import { goldenCatalogRaw } from './support/gosa-builder';

/** docs/web-data-format.md; fast-load design §B.4 as amended by #467. */

const websiteRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(websiteRoot, '..');
const { major, minor } = SUPPORTED_FORMAT;
const NEWER_MINOR = `${major}.${minor + 1}`;
const NEXT_MAJOR = `${major + 1}.0`;

type Json = Record<string, unknown>;

function golden(formatVersion: string = ATLAS_WEB_FORMAT_VERSION): Json {
  return { ...(goldenCatalogRaw() as Json), format_version: formatVersion };
}

/** The golden catalog with a key this client has never heard of at every kind of nesting. */
function withUnknownKeys(formatVersion: string): Json {
  const catalog = structuredClone(golden(formatVersion)) as {
    artifacts: Json[];
    discovery_groups: Json[];
    grids: Record<string, Json>;
  } & Json;
  const [ref] = catalog.artifacts;
  const web = ref.web as { render: Json } & Json;
  const [resource] = ref.external_resources as Json[];
  const [grid] = Object.values(catalog.grids);
  catalog.future_top_level = { anything: [1, 2, 3] };
  ref.future_artifact_field = 'x';
  web.render.future_tier_field = 7;
  web.preview = { url: 'surfaces/x/preview.0000000000000000.gosa' };
  if (resource) resource.future_resource_field = true;
  grid.future_grid_field = null;
  catalog.discovery_groups[0].future_group_field = 'y';
  return catalog;
}

describe('the format version constant', () => {
  // Agree means the same MAJOR, with this client's MINOR never ahead of the producer's. The producer
  // may be a MINOR ahead: this client reads that catalog, ignoring keys it does not know, so a MINOR
  // change does not force a client change. tests/test_web_format.py checks the same from Python.
  it('agrees with the Python producer constant', () => {
    const python = readFileSync(
      path.join(repoRoot, 'genomeos/publication/web_format.py'),
      'utf8',
    );
    const found = [
      ...python.matchAll(/^WEB_FORMAT_VERSION = "([^"]*)"$/gm),
    ].map((match) => match[1]);
    expect(found).toHaveLength(1);
    const producer = parseFormatVersion(found[0]);
    expect(producer.major).toBe(major);
    expect(minor).toBeLessThanOrEqual(producer.minor);
  });

  it.each([
    'public/data/atlas/catalog.json',
    'tests/fixtures/atlas/golden/catalog.json',
    'tests/fixtures/atlas/parity/catalog.json',
    'tests/fixtures/atlas/e2e/catalog.json',
  ])('reads %s', (relative) => {
    const raw = JSON.parse(
      readFileSync(path.join(websiteRoot, relative), 'utf8'),
    ) as Json;
    expect(raw).not.toHaveProperty('schema_version');
    expect(parseAtlasCatalog(raw).format_version).toBe(raw.format_version);
  });
});

describe('parseFormatVersion', () => {
  it.each([
    ['1.0', { major: 1, minor: 0 }],
    ['1.12', { major: 1, minor: 12 }],
    ['0.3', { major: 0, minor: 3 }],
    ['10.0', { major: 10, minor: 0 }],
  ])('parses %s', (text, parsed) => {
    expect(parseFormatVersion(text)).toEqual(parsed);
  });

  it.each([
    1,
    1.0,
    true,
    null,
    undefined,
    '',
    '1',
    '1.0.0',
    '01.0',
    '1.01',
    'v1.0',
    ' 1.0',
    '1.0\n',
    '1.-1',
    '１.０',
  ])('refuses %j rather than coercing it', (value) => {
    expect(() => parseFormatVersion(value)).toThrow(AtlasFormatVersionError);
    expect(() => parseFormatVersion(value)).toThrow(/MAJOR\.MINOR/);
  });
});

describe('catalogReadMode', () => {
  it('reads its own version strictly and a newer MINOR leniently', () => {
    expect(catalogReadMode(golden())).toBe('strict');
    expect(catalogReadMode(golden(NEWER_MINOR))).toBe('newer-minor');
  });

  it('refuses another MAJOR, naming both versions', () => {
    for (const other of [NEXT_MAJOR, `${major + 1}.${minor + 3}`]) {
      expect(() => catalogReadMode(golden(other))).toThrow(
        AtlasFormatVersionError,
      );
      expect(() => catalogReadMode(golden(other))).toThrow(
        new RegExp(
          `format ${other.replace('.', '\\.')}.*reads format ${major}\\.x`,
        ),
      );
    }
  });

  it('refuses a catalog that declares no version instead of assuming one', () => {
    const { format_version: _, ...missing } = golden();
    for (const raw of [missing, { ...missing, schema_version: 1 }]) {
      expect(() => catalogReadMode(raw)).toThrow(/declares no format_version/);
    }
    for (const raw of [null, [], 'catalog', 1]) {
      expect(() => catalogReadMode(raw)).toThrow(AtlasFormatVersionError);
    }
  });
});

describe('parseAtlasCatalog', () => {
  it('reads the current version exactly as the strict schema does', () => {
    expect(parseAtlasCatalog(golden())).toEqual(
      atlasCatalogSchema.parse(golden()),
    );
  });

  it('refuses an unknown key at the current MINOR: an additive change needs a MINOR bump', () => {
    const caught = (() => {
      try {
        parseAtlasCatalog(withUnknownKeys(ATLAS_WEB_FORMAT_VERSION));
      } catch (error) {
        return error;
      }
    })();
    expect(caught).toBeInstanceOf(ZodError);
    expect((caught as ZodError).issues).toContainEqual(
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['future_top_level'],
      }),
    );
  });

  it('reads a newer MINOR, ignoring every key it does not know', () => {
    const raw = withUnknownKeys(NEWER_MINOR);
    const before = structuredClone(raw);
    const parsed = parseAtlasCatalog(raw);
    expect(parsed).toEqual({
      ...atlasCatalogSchema.parse(golden()),
      format_version: NEWER_MINOR,
    });
    expect(raw).toEqual(before); // the inline catalog is not mutated
  });

  it('still validates every known field of a newer MINOR', () => {
    const badDigest = withUnknownKeys(NEWER_MINOR) as {
      artifacts: { web: { render: Json } }[];
    } & Json;
    badDigest.artifacts[0].web.render.sha256 = 'not-a-digest';
    expect(() => parseAtlasCatalog(badDigest)).toThrow(ZodError);

    // A new support state or artifact format is not additive: it is a MAJOR change.
    const newState = withUnknownKeys(NEWER_MINOR) as {
      artifacts: { support_counts: Json }[];
    } & Json;
    newState.artifacts[0].support_counts.future_state = 1;
    expect(() => parseAtlasCatalog(newState)).toThrow(ZodError);

    const newFormat = withUnknownKeys(NEWER_MINOR) as {
      artifacts: Json[];
    } & Json;
    newFormat.artifacts[0].artifact_format = 4;
    expect(() => parseAtlasCatalog(newFormat)).toThrow(ZodError);
  });

  it('refuses another MAJOR before looking at anything else', () => {
    expect(() => parseAtlasCatalog(golden(NEXT_MAJOR))).toThrow(
      AtlasFormatVersionError,
    );
    expect(() => atlasCatalogSchema.parse(golden(NEXT_MAJOR))).toThrow(
      ZodError,
    );
  });
});

describe('loadPageCatalog (the /app/ build)', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { force: true, recursive: true });
  });

  function catalogFile(raw: unknown): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'genomeos-format-'));
    directories.push(directory);
    const file = path.join(directory, 'catalog.json');
    writeFileSync(file, JSON.stringify(raw));
    return file;
  }

  it('fails the build on another MAJOR, naming the catalog and both versions', () => {
    const file = catalogFile(golden(NEXT_MAJOR));
    expect(() => loadPageCatalog(file)).toThrow(
      new RegExp(
        `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*format ${NEXT_MAJOR.replace('.', '\\.')}`,
      ),
    );
  });

  it('builds with a newer MINOR, inlining it unchanged and saying what it ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = withUnknownKeys(NEWER_MINOR);
    const { catalog, json } = loadPageCatalog(catalogFile(raw));
    expect(catalog.format_version).toBe(NEWER_MINOR);
    expect(JSON.parse(json)).toEqual(raw);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(
      new RegExp(`format ${NEWER_MINOR.replace('.', '\\.')}.*ignored`),
    );
  });
});
