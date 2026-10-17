/**
 * The Python→web Atlas data format version (Atlas design §11, §12; fast-load design §B.4, amended by
 * #467). The rules, and how to bump it, are in `docs/web-data-format.md`.
 *
 * `catalog.json` declares `format_version` as `"MAJOR.MINOR"`. This client reads exactly one MAJOR:
 * a catalog of another MAJOR is refused with `AtlasFormatVersionError`, never coerced. A MINOR at or
 * below this client's is read strictly; a newer MINOR is read with the catalog keys this client does
 * not know ignored (`parseAtlasCatalog` in `contracts.ts`), because a MINOR change only adds keys an
 * older reader may skip. A catalog that declares no version is refused: there is no default.
 *
 * The producer's constant is `WEB_FORMAT_VERSION` in `genomeos/publication/web_format.py`;
 * `tests/atlas-format-version.test.ts` and `tests/test_web_format.py` hold the two equal.
 */

export const ATLAS_WEB_FORMAT_VERSION = '1.0';

export interface FormatVersion {
  major: number;
  minor: number;
}

/** How a catalog is read: strictly, or with keys from a newer MINOR ignored. */
export type CatalogReadMode = 'strict' | 'newer-minor';

/** ASCII digits and no leading zeros, so one version has exactly one spelling. */
export const FORMAT_VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

const RULES = 'docs/web-data-format.md';

/** A catalog this client must not read: no version, a malformed one, or another MAJOR. */
export class AtlasFormatVersionError extends Error {
  override name = 'AtlasFormatVersionError';
}

export function parseFormatVersion(value: unknown): FormatVersion {
  const match =
    typeof value === 'string' ? FORMAT_VERSION_PATTERN.exec(value) : null;
  if (!match) {
    throw new AtlasFormatVersionError(
      `Atlas catalog format_version ${JSON.stringify(value) ?? String(value)} is not a "MAJOR.MINOR" string such as "1.0" (${RULES}).`,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export const SUPPORTED_FORMAT: FormatVersion = parseFormatVersion(
  ATLAS_WEB_FORMAT_VERSION,
);

/** The version a raw catalog declares, refused unless this client can read its MAJOR. */
export function catalogReadMode(raw: unknown): CatalogReadMode {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AtlasFormatVersionError(
      'The Atlas catalog is not a JSON object.',
    );
  }
  if (!Object.hasOwn(raw, 'format_version')) {
    throw new AtlasFormatVersionError(
      `The Atlas catalog declares no format_version, so this site cannot tell whether it can read it (${RULES}). A catalog that still carries schema_version predates format versioning and must be re-exported.`,
    );
  }
  const declared = parseFormatVersion(
    (raw as { format_version: unknown }).format_version,
  );
  if (declared.major !== SUPPORTED_FORMAT.major) {
    throw new AtlasFormatVersionError(
      `The Atlas catalog is format ${declared.major}.${declared.minor}, but this site reads format ${SUPPORTED_FORMAT.major}.x only (built for ${ATLAS_WEB_FORMAT_VERSION}). Build the site with a client for format ${declared.major}, or publish a format ${SUPPORTED_FORMAT.major} catalog (${RULES}).`,
    );
  }
  return declared.minor > SUPPORTED_FORMAT.minor ? 'newer-minor' : 'strict';
}
