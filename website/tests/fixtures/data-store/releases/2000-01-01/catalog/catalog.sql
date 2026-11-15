-- The genomeOS Atlas catalog of release 2000-01-01, written by scripts/build_data_release.py.

CREATE SCHEMA evidence;
CREATE SCHEMA inferred;
CREATE SCHEMA meta;

CREATE VIEW meta.release AS SELECT '2000-01-01' AS release, 'manifests/2000-01-01.json' AS manifest_key, 'genomeOS Atlas data, release 2000-01-01. https://storage.googleapis.com/genomeos-atlas-data/manifests/2000-01-01.json' AS cite_as, NULL::VARCHAR AS mirror;

CREATE VIEW evidence.parity_observations AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'http://127.0.0.1:4324/releases/2000-01-01/validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'http://127.0.0.1:4324/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'http://127.0.0.1:4324/releases/2000-01-01/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW inferred.artifacts AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'http://127.0.0.1:4324/releases/2000-01-01/tables/v1/inferred/artifacts.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/artifacts.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'http://127.0.0.1:4324/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'http://127.0.0.1:4324/releases/2000-01-01/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false)) AND 'store/artifacts/' || artifact || '/cells.parquet' NOT IN (
  SELECT path
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'http://127.0.0.1:4324/releases/2000-01-01/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.withdrawn AS
SELECT *
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'http://127.0.0.1:4324/releases/2000-01-01/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false);
