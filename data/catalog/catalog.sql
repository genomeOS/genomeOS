-- The genomeOS Atlas catalog of release 2026-11-15, written by scripts/build_data_release.py.

CREATE SCHEMA evidence;
CREATE SCHEMA inferred;
CREATE SCHEMA meta;

CREATE VIEW meta.release AS SELECT '2026-11-15' AS release, 'manifests/2026-11-15.json' AS manifest_key, 'genomeOS Atlas data, release 2026-11-15. https://storage.googleapis.com/genomeos-atlas-data/manifests/2026-11-15.json' AS cite_as, NULL::VARCHAR AS mirror;

CREATE VIEW evidence.parity_observations AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-10-18/validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/validation/hbs-piel-parity-2026-09-16/piel-comparable-observations.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW inferred.artifacts AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/artifacts.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/artifacts.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false)) AND 'store/artifacts/' || artifact || '/cells.parquet' NOT IN (
  SELECT path
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW inferred.cells_by_cell AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8001fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8003fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8005fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8007fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8009fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=800bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=800dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=800ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8011fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8013fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8015fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8017fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8019fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=801bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=801ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8021fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8025fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8027fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8029fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=802bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=802dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=802ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8031fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8039fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=803dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=803ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8041fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8043fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8045fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8047fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8049fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=804bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=804dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8053fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8055fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8059fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=805dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=805ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8061fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8063fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8065fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8067fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8069fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=806bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=806dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8073fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8075fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8077fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=807bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8081fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8083fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=808bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=808dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=808ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8095fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8097fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=809bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=809dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=809ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a3fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a5fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a7fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80adfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80b3fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80b9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80bbfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80bdfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80bffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80c3fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80c9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80cffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80dbfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80dffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e1fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e5fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e7fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80edfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80effffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80f1fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80f3fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8001fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8003fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8005fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8007fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8009fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=800bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=800dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=800ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8011fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8013fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8015fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8017fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8019fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=801bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=801dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=801ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8021fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8023fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8025fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8027fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8029fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=802bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=802dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=802ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8031fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8035fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8039fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=803dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=803ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8041fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8043fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8045fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8047fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8049fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=804bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=804dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=804ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8053fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8055fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8057fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8059fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=805bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=805dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=805ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8061fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8063fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8065fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8067fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8069fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=806bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=806dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8071fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8073fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8075fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8077fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8079fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=807bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=807ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8081fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8083fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8085fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8089fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=808bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=808dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=808ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8095fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8097fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8099fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=809bfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=809dfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=809ffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a1fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a3fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a5fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a7fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80abfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80adfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b1fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b3fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b5fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80bbfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80bdfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80bffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80c1fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80c3fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80c9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80cffffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80d5fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80d9fffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80dbfffffffffff/part-0.parquet',
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80dffffffffffff/part-0.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8001fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8003fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8005fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8007fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8009fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=800bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=800dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=800ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8011fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8013fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8015fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8017fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8019fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=801bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=801ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8021fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8025fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8027fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8029fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=802bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=802dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=802ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8031fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8039fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=803dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=803ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8041fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8043fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8045fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8047fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8049fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=804bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=804dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8053fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8055fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8059fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=805dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=805ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8061fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8063fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8065fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8067fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8069fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=806bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=806dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8073fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8075fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8077fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=807bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8081fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8083fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=808bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=808dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=808ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8095fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=8097fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=809bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=809dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=809ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a3fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a5fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a7fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80a9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80adfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80b3fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80b9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80bbfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80bdfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80bffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80c3fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80c9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80cffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80dbfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80dffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e1fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e5fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e7fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80e9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80edfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80effffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80f1fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=3/h3_r0=80f3fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8001fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8003fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8005fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8007fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8009fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=800bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=800dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=800ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8011fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8013fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8015fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8017fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8019fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=801bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=801dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=801ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8021fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8023fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8025fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8027fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8029fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=802bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=802dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=802ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8031fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8035fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8039fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=803dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=803ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8041fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8043fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8045fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8047fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8049fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=804bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=804dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=804ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8053fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8055fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8057fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8059fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=805bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=805dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=805ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8061fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8063fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8065fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8067fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8069fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=806bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=806dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8071fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8073fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8075fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8077fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8079fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=807bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=807ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8081fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8083fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8085fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8089fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=808bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=808dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=808ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8095fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8097fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=8099fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=809bfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=809dfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=809ffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a1fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a3fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a5fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a7fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80a9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80abfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80adfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b1fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b3fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b5fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80b9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80bbfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80bdfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80bffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80c1fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80c3fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80c9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80cffffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80d5fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80d9fffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80dbfffffffffff/part-0.parquet',
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/inferred/cells_by_cell/epoch=2026-11-15/res=4/h3_r0=80dffffffffffff/part-0.parquet'
  ] END), filename = true, hive_partitioning = true, hive_types = {'epoch': VARCHAR, 'res': INTEGER, 'h3_r0': VARCHAR})
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false)) AND 'store/artifacts/' || replace(variant_id, ':', '__') || '__' || model_version || '__' || data_version || '/cells.parquet' NOT IN (
  SELECT path
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.release_objects AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/release_objects.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/release_objects.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.served AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/served.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/served.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.sources AS
SELECT * EXCLUDE (filename)
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/sources.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/sources.parquet'
  ] END), filename = true, hive_partitioning = false)
WHERE filename NOT IN (
  SELECT CASE WHEN getvariable('genomeos_local') IS NULL THEN 'https://storage.googleapis.com/genomeos-atlas-data/' || key ELSE rtrim(getvariable('genomeos_local'), '/') || '/' || path END
  FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false));

CREATE VIEW meta.withdrawn AS
SELECT *
FROM read_parquet((CASE WHEN getvariable('genomeos_local') IS NULL THEN [
    'https://storage.googleapis.com/genomeos-atlas-data/releases/2026-11-15/tables/v1/meta/withdrawn.parquet'
  ]
  ELSE [
    rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/meta/withdrawn.parquet'
  ] END), hive_partitioning = false);
