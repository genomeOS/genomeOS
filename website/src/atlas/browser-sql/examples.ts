/**
 * The "Query in your browser" examples (Atlas data platform design 2026-10-18 §3.1, §7, step 1.13):
 * §3.1's lookups of one variant against the attached release catalog, plus the parity smoke's
 * Lagos disc (§2.7 check 8). Measured and inferred data are never read together (Atlas v1 §4, §5):
 * each example names objects of one kind only, and the panel shows its result under that kind.
 */

export type BrowserSqlExampleId =
  'observations' | 'surfaces' | 'artifact' | 'parity-near-lagos';

export interface BrowserSqlExample {
  id: BrowserSqlExampleId;
  /** Measured observations, or inferred model output. */
  kind: 'measured' | 'inferred';
  label: string;
  /** The catalog object (`schema.name`) the SQL reads; offered only when the catalog has it. */
  requires: string;
  sql: string;
}

/** The selected map's identity, as the release's `inferred.artifacts` keys it. */
export interface BrowserSqlArtifact {
  variantId: string;
  modelVersion: string;
  dataVersion: string;
}

/** Lagos, the parity smoke's centre, and its disc radius in km (§2.7 check 8). */
const LAGOS = { lat: 6.5244, lon: 3.3792, km: 500 };
/** The mean Earth radius the smoke's haversine uses, in km. */
const EARTH_RADIUS_KM = 6371.0088;

/** `value` as a SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The statement that attaches the catalog at `url`, as DuckDB's CLI, Python or R runs it. */
export function attachStatement(url: string): string {
  return `ATTACH ${sqlString(url)} AS atlas (READ_ONLY);`;
}

/** The examples whose objects `objects` (the attached catalog's `schema.name`s) holds. */
export function browserSqlExamples(
  objects: readonly string[],
  artifact: BrowserSqlArtifact,
): BrowserSqlExample[] {
  const v = sqlString(artifact.variantId);
  const m = sqlString(artifact.modelVersion);
  const d = sqlString(artifact.dataVersion);
  const { lat, lon, km } = LAGOS;
  const examples: BrowserSqlExample[] = [
    {
      id: 'observations',
      kind: 'measured',
      label: 'Observations of this variant',
      requires: 'measured.variant',
      sql:
        'SELECT population_id, ac, an, lat, lon, radius_km, sampling_design, cohort_id, source_record_id\n' +
        `FROM atlas.measured.variant(${v});`,
    },
    {
      id: 'surfaces',
      kind: 'inferred',
      label: 'Surfaces of this variant',
      requires: 'inferred.surfaces',
      sql: `SELECT * FROM atlas.inferred.surfaces(${v});`,
    },
    {
      id: 'artifact',
      kind: 'inferred',
      label: "This map's artifact",
      requires: 'inferred.artifacts',
      sql: `SELECT * FROM atlas.inferred.artifacts WHERE variant_id = ${v} AND model_version = ${m} AND data_version = ${d};`,
    },
    {
      id: 'parity-near-lagos',
      kind: 'measured',
      label: `HbS surveys within ${km} km of Lagos`,
      requires: 'evidence.parity_observations',
      sql:
        'SELECT count(*) AS observations, sum(an) AS an, sum(ac) AS ac FROM atlas.evidence.parity_observations\n' +
        `WHERE 2 * ${EARTH_RADIUS_KM} * asin(sqrt(pow(sin(radians(lat - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(lat)) * pow(sin(radians(lon - ${lon}) / 2), 2))) <= ${km} + radius_km;`,
    },
  ];
  return examples.filter((example) => objects.includes(example.requires));
}
