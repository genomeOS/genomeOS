-- The genomeOS Atlas catalog of release 2026-11-20, written by scripts/build_data_release.py.

CREATE SCHEMA evidence;
CREATE SCHEMA inferred;
CREATE SCHEMA meta;

CREATE VIEW meta.release AS SELECT '2026-11-20' AS release, 'manifests/2026-11-20.json' AS manifest_key, 'genomeOS Atlas data, release 2026-11-20. https://storage.googleapis.com/genomeos-atlas-data/manifests/2026-11-20.json' AS cite_as, NULL::VARCHAR AS mirror;

CREATE VIEW evidence.parity_observations AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-10-17/validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW inferred.artifacts AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/inferred/artifacts.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/artifacts.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false)) AND 'store/artifacts/' || artifact || '/cells.parquet' NOT IN (
  SELECT path
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW inferred.cells_by_cell AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=3/h3_r0=8019fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=3/h3_r0=8059fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=4/h3_r0=8019fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=4/h3_r0=8059fffffffffff/part-0.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=3/h3_r0=8019fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=3/h3_r0=8059fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=4/h3_r0=8019fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=4/h3_r0=8059fffffffffff/part-0.parquet'
  ] END), filename = true, hive_partitioning = true, hive_types = {'epoch': VARCHAR, 'res': INTEGER, 'h3_r0': VARCHAR})
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false)) AND 'store/artifacts/' || replace(variant_id, ':', '__') || '__' || model_version || '__' || data_version || '/cells.parquet' NOT IN (
  SELECT path
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.release_objects AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/release_objects.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/release_objects.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.served AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/served.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/served.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.sources AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/sources.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/sources.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.withdrawn AS
SELECT *
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-20/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false);
