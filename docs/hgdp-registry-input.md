# HGDP registry input

The HGDP adapter consumes a curated tab-separated file. It is not an importer for an untouched
vendor export. Before building the registry, the curator must establish what each coordinate
represents, what geographic support is justified, and which evidence supports both values.
Parsing checks the supplied representation; it does not inspect or qualify the cited sources.

## Required input

Every file must have these five columns:

| Column | Meaning |
|---|---|
| `population` | Source population label |
| `latitude` | Finite WGS84 latitude in `[-90, 90]` |
| `longitude` | Finite WGS84 longitude in `[-180, 180]` |
| `uncertainty_radius_km` | Finite, strictly positive spatial-support radius in kilometres |
| `provenance` | Locator identifying the supporting coordinate/support source and version |

Additional well-formed columns, such as `region`, are permitted. For example:

```tsv
population	latitude	longitude	uncertainty_radius_km	provenance
Example	1	2	2.5	synthetic:example-v1#row-1
```

Population labels and provenance are preserved literally, including leading zeros, strings such
as `NA`, and leading or trailing whitespace in a nonblank field. Multiple evidence locators may
share the existing `provenance` string field, provided the value identifies the sources and their
versions. The parser does not interpret or verify those locators.

The build refuses a missing or duplicate header, a blank column name, a missing required column,
a blank required value, a malformed or ragged record, a nonnumeric or nonfinite number, a radius
that is zero or negative, an out-of-range coordinate, or a population label that cannot produce a
unique canonical identifier. Rows are never silently dropped, repaired, or filled from defaults.

## Output contract

`genomeos.registry.sources.hgdp.load` still returns the canonical population and alias tables.
The population table contains `population_id`, `lat`, `lon`, `uncertainty_radius_km`,
`location_type`, `provenance`, `biocultural_notice`, and `registry_version`. The alias table
contains `population_id`, `source`, and the literal `label`. HGDP rows retain
`location_type="ancestral"` and the CARE-aligned biocultural notice. The frozen schemas and public
adapter signature are unchanged.

Schema-valid output does not certify the source review, population identity, coordinate meaning,
sampling footprint, residency, or eligibility for a scientific benchmark. Those qualifications
precede parsing and remain open scientific work under [#21](https://github.com/bschilder/genomeOS/issues/21)
and [#219](https://github.com/bschilder/genomeOS/issues/219).

## Migrating existing files

Existing four-column files now fail. Each row must be curated with evidence supporting its
coordinate and spatial extent, then supplied with explicit `uncertainty_radius_km` and
`provenance` values. There is intentionally no conversion command or default-fill recipe because
those values cannot be derived from the old fields.

The six-row file at `tests/fixtures/hgdp_populations.tsv` is synthetic test data. Its radii and
locators are hand-written values used only to verify parsing and serialization; they are not
measured or inferred extents of the named populations and do not satisfy the source-qualification
work tracked in #21 or #219.

## Publishing a registry release

Build into a new path with an explicit release label:

```bash
PYTHONPATH=. python scripts/build_registry.py \
  --hgdp tests/fixtures/hgdp_populations.tsv \
  --release-version 0.1.0 \
  --out data/registry-fixture-v1
```

The command refuses every pre-existing output path and publishes the verified completion manifest
required by the P1 build. See [Immutable registry publication](registry-publication.md) for the
identity, migration, and failure contracts.

## The HGDP + 1KG registry input (Atlas data platform step 1.7)

`data/registry/hgdp_1kg/1.0.0/populations.tsv` holds the 80 HGDP + 1KG identities of D18 (Atlas data
platform design 2026-10-18 §1.2, item 1). Unlike the files above, it is committed. A release publishes it
under `registry/`, with the sources `genomeos` and `gnomad_hgdp_1kg`. The `reference` stage of
`scripts/build_tables.py` reads it through `genomeos.registry.sources.hgdp_1kg` and writes it as the
registry folder `tables/v1/reference/populations/1.0.0-<sha8>/`. Without this file, the stage stops.

Its eight columns are `hgdp_1kg.REQUIRED_COLUMNS`:

| Column | Where it comes from |
|---|---|
| `alias_source` | `hgdp` or `onekg`, the project of the label (`hgdp_tgp_meta.Project` in the metadata) |
| `population` | The metadata's literal `population` field. Han, NorthernHan, PapuanHighlands and PapuanSepik are four identities |
| `latitude`, `longitude` | The metadata's `latitude` and `longitude` beside that field, exactly |
| `uncertainty_radius_km` | The owner's radius rule ([#508](https://github.com/genomeOS/genomeOS/issues/508)) |
| `location_type` | The owner's answer for each row, the 1KG diaspora sites included (#508) |
| `provenance` | The metadata's sha256 and the row's radius locator |
| `biocultural_notice` | HGDP's CARE notice, exactly, on every `hgdp` row; on `onekg` rows, the owner's answer (#508). A blank is stored as null |

The first four columns are curated from gnomAD's per-sample `gnomad_meta_updated.tsv`, sha256
`e18e7a29d0567b8063edc1a714bd31e57dc422823ba51af2c63fecef0dbc3cf1`
(`reference_cohorts.METADATA_SHA256`). That file is never committed. They are never edited by hand. The
other four have no source and no default. Until the owner answers #508 the file is not written, and the
synthetic radii of the test fixtures are never used.

To write or check the file, run from the repository root with `$SCRATCH` outside it:

```bash
curl -fsS -o "$SCRATCH/gnomad_meta_updated.tsv" \
  https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1/secondary_analyses/hgdp_1kg_v2/metadata_and_qc/gnomad_meta_updated.tsv
# The four curated columns, one row per population; stderr reports
# "80 populations from metadata sha256 e18e7a29…".
python scripts/curate_hgdp_1kg_registry.py --metadata "$SCRATCH/gnomad_meta_updated.tsv" > "$SCRATCH/curation.tsv"
# After adding the owner's four columns, hold the committed file to the metadata.
# Expected: "80 populations match the pinned metadata".
python scripts/curate_hgdp_1kg_registry.py --metadata "$SCRATCH/gnomad_meta_updated.tsv" \
  --check data/registry/hgdp_1kg/1.0.0/populations.tsv
```

The script refuses other bytes for the metadata. It also refuses:

- a population with two coordinates (it never averages them);
- an unknown project;
- a blank or `NA` population;
- a curation of other than 80 identities. In that case, stop and tell the owner (plan F2).

`--check` reads the file the way the `reference` stage does. Its identities and coordinates must equal
the curation exactly, and every row's provenance must name the metadata's sha256.

The folder name is `1.0.0-` followed by the first 8 hex digits of the `registry_version`. That version
covers the file's bytes and the registry code (`registry.publication.registry_release`), so any change to
either gives a new folder. A released folder is never rewritten.
