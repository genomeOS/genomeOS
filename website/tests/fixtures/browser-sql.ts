/**
 * Inputs of the "Query in your browser" examples (Atlas data platform design 2026-10-18 §3.1, step
 * 1.13), shared by their unit tests and the data-access docs test (step 1.15).
 */
import type { BrowserSqlArtifact } from '../../src/atlas/browser-sql/examples';

/** Every catalog object an example needs: the catalog once step 2.7 adds the lookup macros. */
export const ALL: readonly string[] = [
  'measured.variant',
  'inferred.surfaces',
  'inferred.artifacts',
  'evidence.parity_observations',
];

/** The HbS (rs334) map of the Atlas catalog. */
export const HBS: BrowserSqlArtifact = {
  variantId: 'chr11-5227002-T-A',
  modelVersion: 'v3',
  dataVersion: 'map-2026-08',
};
