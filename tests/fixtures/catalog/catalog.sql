-- The genomeOS Atlas catalog of release 2026-11-20, written by scripts/build_data_release.py.

CREATE SCHEMA evidence;
CREATE SCHEMA inferred;
CREATE SCHEMA measured;
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

CREATE MACRO measured.lookup_url(v) AS
CASE WHEN NOT coalesce(regexp_full_match(v, '^(?:chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-\d+-[ACGT]+-[ACGT]+|phenotype:[a-z0-9][a-z0-9-]*|(?:hla|kir|mic|cyt):[a-z0-9][a-z0-9._-]*)$') AND (NOT starts_with(v, 'chr') OR regexp_full_match(v, '^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$')), false) THEN error('measured.lookup_url takes a GRCh38 chr-pos-ref-alt id (chr1-22, X, Y or M; a position of 1-9 digits with no leading zero; alleles in ACGT) or a phenotype:, hla:, kir:, mic: or cyt: id') ELSE CASE WHEN regexp_full_match(v, '^(chr(?:[1-9]|1[0-9]|2[0-2]|X|Y))-([1-9][0-9]{0,8})-[ACGT]+-[ACGT]+$') AND TRY_CAST(split_part(v, '-', 2) AS BIGINT) // 1000000 < CASE split_part(v, '-', 1) WHEN 'chr11' THEN 136 END THEN [coalesce(rtrim(getvariable('genomeos_local'), '/') || '/', 'https://storage.googleapis.com/example-lookup/releases/2026-11-20/') || 'tables/v1/measured/allele_observations_binned/source=gnomad_hgdp_1kg/ingest_version=2026-12-recount/chrom=' || split_part(v, '-', 1) || '/bin=' || CAST(TRY_CAST(split_part(v, '-', 2) AS BIGINT) // 1000000 AS VARCHAR) || '/part-0.parquet'] ELSE []::VARCHAR[] END END;

CREATE MACRO measured.variant(v) AS TABLE
SELECT * FROM query(CASE WHEN NOT coalesce(regexp_full_match(v, '^(?:chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-\d+-[ACGT]+-[ACGT]+|phenotype:[a-z0-9][a-z0-9-]*|(?:hla|kir|mic|cyt):[a-z0-9][a-z0-9._-]*)$') AND (NOT starts_with(v, 'chr') OR regexp_full_match(v, '^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$')), false) THEN error('measured.variant takes a GRCh38 chr-pos-ref-alt id (chr1-22, X, Y or M; a position of 1-9 digits with no leading zero; alleles in ACGT) or a phenotype:, hla:, kir:, mic: or cyt: id') ELSE 'SELECT NULL::VARCHAR AS variant_id, NULL::VARCHAR AS rsid, NULL::VARCHAR AS population_id, NULL::DOUBLE AS lat, NULL::DOUBLE AS lon, NULL::DOUBLE AS radius_km, NULL::BIGINT AS ac, NULL::BIGINT AS an, NULL::VARCHAR AS source_record_id, NULL::VARCHAR AS source, NULL::VARCHAR AS assay, NULL::BIGINT AS date_lower, NULL::BIGINT AS date_upper, NULL::VARCHAR AS sampling_design, NULL::BOOLEAN AS disease_ascertainment_excluded, NULL::VARCHAR AS cohort_id, NULL::VARCHAR AS ingest_version WHERE false' END)
UNION ALL
SELECT * FROM query(CASE WHEN regexp_full_match(v, '^(chr(?:[1-9]|1[0-9]|2[0-2]|X|Y))-([1-9][0-9]{0,8})-[ACGT]+-[ACGT]+$') AND TRY_CAST(split_part(v, '-', 2) AS BIGINT) // 1000000 < CASE split_part(v, '-', 1) WHEN 'chr11' THEN 136 END THEN 'SELECT CAST(variant_id AS VARCHAR) AS variant_id, CAST(rsid AS VARCHAR) AS rsid, CAST(population_id AS VARCHAR) AS population_id, CAST(lat AS DOUBLE) AS lat, CAST(lon AS DOUBLE) AS lon, CAST(radius_km AS DOUBLE) AS radius_km, CAST(ac AS BIGINT) AS ac, CAST(an AS BIGINT) AS an, CAST(''gnomad-hgdp-1kg:'' || variant_id || '':'' || source_label AS VARCHAR) AS source_record_id, CAST(source AS VARCHAR) AS source, CAST(assay AS VARCHAR) AS assay, CAST(date_lower AS BIGINT) AS date_lower, CAST(date_upper AS BIGINT) AS date_upper, CAST(sampling_design AS VARCHAR) AS sampling_design, CAST(disease_ascertainment_excluded AS BOOLEAN) AS disease_ascertainment_excluded, CAST(cohort_id AS VARCHAR) AS cohort_id, CAST(ingest_version AS VARCHAR) AS ingest_version FROM read_parquet(''' || replace(coalesce(rtrim(getvariable('genomeos_local'), '/') || '/', 'https://storage.googleapis.com/example-lookup/releases/2026-11-20/') || 'tables/v1/measured/allele_observations_binned/source=gnomad_hgdp_1kg/ingest_version=2026-12-recount/chrom=' || split_part(v, '-', 1) || '/bin=' || CAST(TRY_CAST(split_part(v, '-', 2) AS BIGINT) // 1000000 AS VARCHAR) || '/part-0.parquet', '''', '''''') || ''', hive_partitioning = false) WHERE pos = ' || split_part(v, '-', 2) || ' AND variant_id = ''' || v || '''' ELSE 'SELECT NULL::VARCHAR AS variant_id, NULL::VARCHAR AS rsid, NULL::VARCHAR AS population_id, NULL::DOUBLE AS lat, NULL::DOUBLE AS lon, NULL::DOUBLE AS radius_km, NULL::BIGINT AS ac, NULL::BIGINT AS an, NULL::VARCHAR AS source_record_id, NULL::VARCHAR AS source, NULL::VARCHAR AS assay, NULL::BIGINT AS date_lower, NULL::BIGINT AS date_upper, NULL::VARCHAR AS sampling_design, NULL::BOOLEAN AS disease_ascertainment_excluded, NULL::VARCHAR AS cohort_id, NULL::VARCHAR AS ingest_version WHERE false' END)
UNION ALL
SELECT * FROM query(CASE WHEN regexp_full_match(v, '^(?:chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-\d+-[ACGT]+-[ACGT]+|phenotype:[a-z0-9][a-z0-9-]*|(?:hla|kir|mic|cyt):[a-z0-9][a-z0-9._-]*)$') AND CASE WHEN regexp_full_match(v, '^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$') THEN v ELSE split_part(v, ':', 1) || ':' END IN ('chr11-5227002-T-A') THEN 'SELECT CAST(variant_id AS VARCHAR) AS variant_id, CAST(rsid AS VARCHAR) AS rsid, CAST(population_id AS VARCHAR) AS population_id, CAST(lat AS DOUBLE) AS lat, CAST(lon AS DOUBLE) AS lon, CAST(radius_km AS DOUBLE) AS radius_km, CAST(ac AS BIGINT) AS ac, CAST(an AS BIGINT) AS an, CAST(source_record_id AS VARCHAR) AS source_record_id, CAST(source AS VARCHAR) AS source, CAST(assay AS VARCHAR) AS assay, CAST(date_lower AS BIGINT) AS date_lower, CAST(date_upper AS BIGINT) AS date_upper, CAST(sampling_design AS VARCHAR) AS sampling_design, CAST(disease_ascertainment_excluded AS BOOLEAN) AS disease_ascertainment_excluded, CAST(cohort_id AS VARCHAR) AS cohort_id, CAST(ingest_version AS VARCHAR) AS ingest_version FROM read_parquet(''' || replace(coalesce(rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/measured/allele_observations/source=gnomad_hgdp_1kg/ingest_version=tsv-fixture/part-0.parquet', 'https://storage.googleapis.com/example-data/releases/2026-11-20/tables/v1/measured/allele_observations/source=gnomad_hgdp_1kg/ingest_version=tsv-fixture/part-0.parquet'), '''', '''''') || ''', hive_partitioning = false) WHERE variant_id = ''' || v || '''' ELSE 'SELECT NULL::VARCHAR AS variant_id, NULL::VARCHAR AS rsid, NULL::VARCHAR AS population_id, NULL::DOUBLE AS lat, NULL::DOUBLE AS lon, NULL::DOUBLE AS radius_km, NULL::BIGINT AS ac, NULL::BIGINT AS an, NULL::VARCHAR AS source_record_id, NULL::VARCHAR AS source, NULL::VARCHAR AS assay, NULL::BIGINT AS date_lower, NULL::BIGINT AS date_upper, NULL::VARCHAR AS sampling_design, NULL::BOOLEAN AS disease_ascertainment_excluded, NULL::VARCHAR AS cohort_id, NULL::VARCHAR AS ingest_version WHERE false' END);

CREATE MACRO measured.near(v, lat0, lon0, km) AS TABLE
SELECT * FROM (
SELECT * FROM query(CASE WHEN NOT coalesce(regexp_full_match(v, '^(?:chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-\d+-[ACGT]+-[ACGT]+|phenotype:[a-z0-9][a-z0-9-]*|(?:hla|kir|mic|cyt):[a-z0-9][a-z0-9._-]*)$') AND (NOT starts_with(v, 'chr') OR regexp_full_match(v, '^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$')), false) THEN error('measured.near takes a GRCh38 chr-pos-ref-alt id (chr1-22, X, Y or M; a position of 1-9 digits with no leading zero; alleles in ACGT) or a phenotype:, hla:, kir:, mic: or cyt: id') ELSE 'SELECT NULL::VARCHAR AS variant_id, NULL::VARCHAR AS rsid, NULL::VARCHAR AS population_id, NULL::DOUBLE AS lat, NULL::DOUBLE AS lon, NULL::DOUBLE AS radius_km, NULL::BIGINT AS ac, NULL::BIGINT AS an, NULL::VARCHAR AS source_record_id, NULL::VARCHAR AS source, NULL::VARCHAR AS assay, NULL::BIGINT AS date_lower, NULL::BIGINT AS date_upper, NULL::VARCHAR AS sampling_design, NULL::BOOLEAN AS disease_ascertainment_excluded, NULL::VARCHAR AS cohort_id, NULL::VARCHAR AS ingest_version WHERE false' END)
UNION ALL
SELECT * FROM query(CASE WHEN regexp_full_match(v, '^(chr(?:[1-9]|1[0-9]|2[0-2]|X|Y))-([1-9][0-9]{0,8})-[ACGT]+-[ACGT]+$') AND TRY_CAST(split_part(v, '-', 2) AS BIGINT) // 1000000 < CASE split_part(v, '-', 1) WHEN 'chr11' THEN 136 END THEN 'SELECT CAST(variant_id AS VARCHAR) AS variant_id, CAST(rsid AS VARCHAR) AS rsid, CAST(population_id AS VARCHAR) AS population_id, CAST(lat AS DOUBLE) AS lat, CAST(lon AS DOUBLE) AS lon, CAST(radius_km AS DOUBLE) AS radius_km, CAST(ac AS BIGINT) AS ac, CAST(an AS BIGINT) AS an, CAST(''gnomad-hgdp-1kg:'' || variant_id || '':'' || source_label AS VARCHAR) AS source_record_id, CAST(source AS VARCHAR) AS source, CAST(assay AS VARCHAR) AS assay, CAST(date_lower AS BIGINT) AS date_lower, CAST(date_upper AS BIGINT) AS date_upper, CAST(sampling_design AS VARCHAR) AS sampling_design, CAST(disease_ascertainment_excluded AS BOOLEAN) AS disease_ascertainment_excluded, CAST(cohort_id AS VARCHAR) AS cohort_id, CAST(ingest_version AS VARCHAR) AS ingest_version FROM read_parquet(''' || replace(coalesce(rtrim(getvariable('genomeos_local'), '/') || '/', 'https://storage.googleapis.com/example-lookup/releases/2026-11-20/') || 'tables/v1/measured/allele_observations_binned/source=gnomad_hgdp_1kg/ingest_version=2026-12-recount/chrom=' || split_part(v, '-', 1) || '/bin=' || CAST(TRY_CAST(split_part(v, '-', 2) AS BIGINT) // 1000000 AS VARCHAR) || '/part-0.parquet', '''', '''''') || ''', hive_partitioning = false) WHERE pos = ' || split_part(v, '-', 2) || ' AND variant_id = ''' || v || '''' ELSE 'SELECT NULL::VARCHAR AS variant_id, NULL::VARCHAR AS rsid, NULL::VARCHAR AS population_id, NULL::DOUBLE AS lat, NULL::DOUBLE AS lon, NULL::DOUBLE AS radius_km, NULL::BIGINT AS ac, NULL::BIGINT AS an, NULL::VARCHAR AS source_record_id, NULL::VARCHAR AS source, NULL::VARCHAR AS assay, NULL::BIGINT AS date_lower, NULL::BIGINT AS date_upper, NULL::VARCHAR AS sampling_design, NULL::BOOLEAN AS disease_ascertainment_excluded, NULL::VARCHAR AS cohort_id, NULL::VARCHAR AS ingest_version WHERE false' END)
UNION ALL
SELECT * FROM query(CASE WHEN regexp_full_match(v, '^(?:chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-\d+-[ACGT]+-[ACGT]+|phenotype:[a-z0-9][a-z0-9-]*|(?:hla|kir|mic|cyt):[a-z0-9][a-z0-9._-]*)$') AND CASE WHEN regexp_full_match(v, '^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$') THEN v ELSE split_part(v, ':', 1) || ':' END IN ('chr11-5227002-T-A') THEN 'SELECT CAST(variant_id AS VARCHAR) AS variant_id, CAST(rsid AS VARCHAR) AS rsid, CAST(population_id AS VARCHAR) AS population_id, CAST(lat AS DOUBLE) AS lat, CAST(lon AS DOUBLE) AS lon, CAST(radius_km AS DOUBLE) AS radius_km, CAST(ac AS BIGINT) AS ac, CAST(an AS BIGINT) AS an, CAST(source_record_id AS VARCHAR) AS source_record_id, CAST(source AS VARCHAR) AS source, CAST(assay AS VARCHAR) AS assay, CAST(date_lower AS BIGINT) AS date_lower, CAST(date_upper AS BIGINT) AS date_upper, CAST(sampling_design AS VARCHAR) AS sampling_design, CAST(disease_ascertainment_excluded AS BOOLEAN) AS disease_ascertainment_excluded, CAST(cohort_id AS VARCHAR) AS cohort_id, CAST(ingest_version AS VARCHAR) AS ingest_version FROM read_parquet(''' || replace(coalesce(rtrim(getvariable('genomeos_local'), '/') || '/tables/v1/measured/allele_observations/source=gnomad_hgdp_1kg/ingest_version=tsv-fixture/part-0.parquet', 'https://storage.googleapis.com/example-data/releases/2026-11-20/tables/v1/measured/allele_observations/source=gnomad_hgdp_1kg/ingest_version=tsv-fixture/part-0.parquet'), '''', '''''') || ''', hive_partitioning = false) WHERE variant_id = ''' || v || '''' ELSE 'SELECT NULL::VARCHAR AS variant_id, NULL::VARCHAR AS rsid, NULL::VARCHAR AS population_id, NULL::DOUBLE AS lat, NULL::DOUBLE AS lon, NULL::DOUBLE AS radius_km, NULL::BIGINT AS ac, NULL::BIGINT AS an, NULL::VARCHAR AS source_record_id, NULL::VARCHAR AS source, NULL::VARCHAR AS assay, NULL::BIGINT AS date_lower, NULL::BIGINT AS date_upper, NULL::VARCHAR AS sampling_design, NULL::BOOLEAN AS disease_ascertainment_excluded, NULL::VARCHAR AS cohort_id, NULL::VARCHAR AS ingest_version WHERE false' END)
)
WHERE 2 * 6371.0088 * asin(sqrt(sin(radians(lat - lat0) / 2)^2 + cos(radians(lat0)) * cos(radians(lat)) * sin(radians(lon - lon0) / 2)^2)) <= km + radius_km;

CREATE MACRO inferred.surfaces(v) AS TABLE
SELECT * FROM query(CASE WHEN NOT coalesce(regexp_full_match(v, '^(?:chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-\d+-[ACGT]+-[ACGT]+|phenotype:[a-z0-9][a-z0-9-]*|(?:hla|kir|mic|cyt):[a-z0-9][a-z0-9._-]*)$') AND (NOT starts_with(v, 'chr') OR regexp_full_match(v, '^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)-[1-9][0-9]{0,8}-[ACGT]+-[ACGT]+$')), false) THEN error('inferred.surfaces takes a GRCh38 chr-pos-ref-alt id (chr1-22, X, Y or M; a position of 1-9 digits with no leading zero; alleles in ACGT) or a phenotype:, hla:, kir:, mic: or cyt: id') ELSE 'SELECT NULL::VARCHAR AS h3_index, NULL::VARCHAR AS variant_id, NULL::DOUBLE AS post_median, NULL::DOUBLE AS post_mean, NULL::DOUBLE AS post_sd, NULL::DOUBLE AS prior_frequency_sd, NULL::DOUBLE AS q025, NULL::DOUBLE AS q975, NULL::DOUBLE AS q25, NULL::DOUBLE AS q75, NULL::VARCHAR AS support, NULL::DOUBLE AS posterior_contraction, NULL::DOUBLE AS dist_nearest_obs_km, NULL::VARCHAR AS model_version, NULL::VARCHAR AS data_version, NULL::VARCHAR AS measurement, NULL::INTEGER AS artifact_format, NULL::BOOLEAN AS served WHERE false' END);
