/**
 * The "Query in your browser" examples (Atlas data platform design 2026-10-18 §3.1, step 1.13):
 * §3.1's lookups, offered only where the attached catalog has their objects, and never one that
 * reads measured and inferred data together.
 */
import { describe, expect, it } from 'vitest';

import {
  attachStatement,
  browserSqlExamples,
  sqlString,
} from '../src/atlas/browser-sql/examples';
import { ALL, HBS } from './fixtures/browser-sql';

const ids = (objects: readonly string[]) =>
  browserSqlExamples(objects, HBS).map((example) => example.id);

describe('browser SQL examples', () => {
  it('offers only the examples whose objects the catalog has', () => {
    expect(ids(ALL)).toEqual([
      'observations',
      'surfaces',
      'artifact',
      'parity-near-lagos',
    ]);
    expect(ids(['inferred.artifacts'])).toEqual(['artifact']);
    expect(ids([])).toEqual([]);
    expect(
      browserSqlExamples(ALL, HBS).map((example) => example.requires),
    ).toEqual(ALL);
  });

  it("writes §3.1's lookups exactly", () => {
    expect(
      Object.fromEntries(
        browserSqlExamples(ALL, HBS).map((example) => [
          example.id,
          [example.kind, example.sql],
        ]),
      ),
    ).toEqual({
      observations: [
        'measured',
        'SELECT population_id, ac, an, lat, lon, radius_km, sampling_design, cohort_id, source_record_id\n' +
          "FROM atlas.measured.variant('chr11-5227002-T-A');",
      ],
      surfaces: [
        'inferred',
        "SELECT * FROM atlas.inferred.surfaces('chr11-5227002-T-A');",
      ],
      artifact: [
        'inferred',
        "SELECT * FROM atlas.inferred.artifacts WHERE variant_id = 'chr11-5227002-T-A' AND model_version = 'v3' AND data_version = 'map-2026-08';",
      ],
      'parity-near-lagos': [
        'measured',
        'SELECT count(*) AS observations, sum(an) AS an, sum(ac) AS ac FROM atlas.evidence.parity_observations\n' +
          'WHERE 2 * 6371.0088 * asin(sqrt(pow(sin(radians(lat - 6.5244) / 2), 2) + cos(radians(6.5244)) * cos(radians(lat)) * pow(sin(radians(lon - 3.3792) / 2), 2))) <= 500 + radius_km;',
      ],
    });
  });

  it('never names a measured and an inferred object in one example', () => {
    for (const example of browserSqlExamples(ALL, HBS)) {
      const schemas = new Set(
        [...example.sql.matchAll(/\batlas\.(\w+)\./g)].map((match) => match[1]),
      );
      expect(schemas.size, example.id).toBe(1);
      expect(schemas.has('inferred'), example.id).toBe(
        example.kind === 'inferred',
      );
      expect(example.sql, example.id).toContain(`atlas.${example.requires}`);
    }
  });

  it('quotes values and the catalog URL as SQL strings', () => {
    expect(sqlString("a'b")).toBe("'a''b'");
    expect(sqlString('chr11-5227002-T-A')).toBe("'chr11-5227002-T-A'");
    expect(
      browserSqlExamples(['inferred.surfaces'], {
        ...HBS,
        variantId: "x'); DROP TABLE t; --",
      })[0]!.sql,
    ).toBe("SELECT * FROM atlas.inferred.surfaces('x''); DROP TABLE t; --');");
    expect(attachStatement('https://x/c.duckdb')).toBe(
      "ATTACH 'https://x/c.duckdb' AS atlas (READ_ONLY);",
    );
  });
});
