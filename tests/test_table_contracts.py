"""The v1 table contracts (Atlas data platform design 2026-10-18 §2.4, §2.5; builder's calls 30, 37)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import MappingProxyType

import pandas as pd
import pandera
import pyarrow
import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.tables import contracts
from genomeos.tables.contracts import (
    BINNED_OBSERVATIONS_SCHEMA,
    REFERENCE_ALIASES_SCHEMA,
    TABLE_CONTRACTS,
    TableContract,
    TableError,
    columns,
    contract_sha256,
    render,
    table_of,
    table_path,
)
from tests.observation_fixtures import observation_rows

ROOT = Path(__file__).resolve().parents[1]


def _binned(n: int = 2) -> pd.DataFrame:
    """``observation_rows(n)`` as lookup-set rows: no source_record_id, with pos and source_label."""
    return observation_rows(n).drop(columns="source_record_id").assign(pos=5227002, source_label="YRI")


def test_the_curated_allele_table_stores_the_17_observation_columns():
    c = TABLE_CONTRACTS["measured.allele_observations"]
    assert set(c.schema.columns) == set(OBSERVATIONS_SCHEMA.columns) and len(c.schema.columns) == 17
    assert (c.key, c.partitions, c.path) == (
        ("ingest_version", "source_record_id"),
        ("source", "ingest_version"),
        "contract/tables/measured.allele_observations.v1.schema.json",
    )


def test_the_binned_table_stores_16_contract_columns_plus_pos_and_source_label():
    c = TABLE_CONTRACTS["measured.allele_observations_binned"]
    assert set(c.schema.columns) == (set(OBSERVATIONS_SCHEMA.columns) - {"source_record_id"}) | {
        "pos",
        "source_label",
    }
    assert (c.key, c.partitions) == (
        ("ingest_version", "variant_id", "population_id"),
        ("source", "ingest_version", "chrom", "bin"),
    )


def test_table_paths_and_names_round_trip():
    assert (
        table_of("tables/v1/measured/allele_observations/source=afnd/ingest_version=afnd-2026-08/part-0.parquet")
        == "measured.allele_observations"
    )
    binned = "measured.allele_observations_binned"
    assert table_path(binned) == "tables/v1/measured/allele_observations_binned/"
    with pytest.raises(TableError, match="contract"):
        table_path("meta.nothing")


@pytest.mark.parametrize(
    "path",
    [
        "tables/v1/measured/nothing/part-0.parquet",
        "tables/v2/measured/allele_observations/source=afnd/ingest_version=afnd-2026-08/part-0.parquet",
        "tables/v1/measured/allele_observations.parquet",
        "tables/v1/measured/allele_observations/",
        "store/artifacts/x/cells.parquet",
        "tables/v1/reference/populations/populations.parquet",
        "tables/v1/reference/populations/afnd-2026-08/notes.parquet",
        "tables/v1/reference/populations/afnd-2026-08/x/populations.parquet",
        "tables/v1/reference/population_aliases/afnd-2026-08/population_aliases.parquet",
        "tables/v1/reference/populations.parquet",
    ],
)
def test_a_path_no_contract_covers_is_refused(path):
    with pytest.raises(TableError, match="contract"):
        table_of(path)


def test_a_registry_folders_two_files_are_the_two_reference_tables():
    """§2.3: ``tables/v1/reference/populations/<folder>/{populations,population_aliases}.parquet``."""
    folder = "tables/v1/reference/populations/1.0.0-0123abcd"
    assert table_of(f"{folder}/populations.parquet") == "reference.populations"
    assert table_of(f"{folder}/population_aliases.parquet") == "reference.population_aliases"
    legacy = "tables/v1/reference/populations/afnd-2026-08/populations.parquet"
    assert table_of(legacy) == "reference.populations"
    for table in ("reference.populations", "reference.population_aliases"):
        assert table_path(table) == "tables/v1/reference/populations/"
        assert TABLE_CONTRACTS[table].partitions == ("registry_version",)


def test_the_aliases_of_two_registries_stay_apart():
    """One label in two registry releases is two rows; within one release it is one (§2.4)."""
    aliases = pd.DataFrame(
        {
            "population_id": ["hgdp-han", "hgdp-han"],
            "source": "hgdp",
            "label": "Han",
            "registry_version": ["afnd-2026-08", "1.0.0+sha256." + "0" * 64],
        }
    )
    assert len(REFERENCE_ALIASES_SCHEMA.validate(aliases)) == 2
    assert TABLE_CONTRACTS["reference.population_aliases"].key == ("registry_version", "source", "label")
    with pytest.raises((pandera.errors.SchemaError, pandera.errors.SchemaErrors), match="not unique"):
        REFERENCE_ALIASES_SCHEMA.validate(aliases.assign(registry_version="afnd-2026-08"))


def test_a_binned_row_on_a_locus_is_admitted():
    assert len(BINNED_OBSERVATIONS_SCHEMA.validate(_binned())) == 2


# A strict schema reports an extra column as SchemaErrors even when lazy=False (pandera 0.32.1), the
# same pairing tests/test_surface_fit.py catches.
@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (lambda f: f.assign(source_record_id="x"), "column 'source_record_id' not in DataFrameSchema"),
        (lambda f: f.assign(af=0.1), "column 'af' not in DataFrameSchema"),
        (lambda f: f.assign(variant_id="hla:a*02:01"), "str_matches"),
        (lambda f: f.assign(variant_id="phenotype:g6pd-deficiency"), "str_matches"),
        (lambda f: f.assign(variant_id="chrM-73-A-G", pos=73), "str_matches"),
        (lambda f: f.assign(pos=5227003), "pos must be the position in variant_id"),
        # ignore_index: on a repeated index pandera 0.32.1 fails while formatting the duplicates
        # (pandas 3 "Columns with duplicate values are not supported in stack"), not with this message.
        (lambda f: pd.concat([f.iloc[:1], f.iloc[:1]], ignore_index=True), "not unique"),
        (lambda f: f.assign(ac=0, an=0), "greater_than"),
        (lambda f: f.assign(ac=f["an"] + 1), "ac must not exceed an"),
        (lambda f: f.drop(columns="radius_km"), "column 'radius_km' not in dataframe"),
        (lambda f: f.drop(columns="sampling_design"), "column 'sampling_design' not in dataframe"),
    ],
)
def test_a_binned_row_the_contract_refuses_is_a_hard_error(edit, message):
    with pytest.raises((pandera.errors.SchemaError, pandera.errors.SchemaErrors), match=message):
        BINNED_OBSERVATIONS_SCHEMA.validate(edit(_binned()))


def test_no_measured_table_has_a_frequency_column():
    measured = [table for table in TABLE_CONTRACTS if table.startswith("measured.")]
    assert measured
    for table in measured:
        assert not [name for name in columns(table) if name == "af" or "freq" in name], table


def test_a_contract_digest_is_the_sha256_of_its_frozen_file():
    for table, contract in TABLE_CONTRACTS.items():
        assert contract.schema_version == "1.0"
        assert contract_sha256(table) == hashlib.sha256((ROOT / contract.path).read_bytes()).hexdigest()


@pytest.mark.parametrize(
    "schemas",
    [{}, {"schema": OBSERVATIONS_SCHEMA, "arrow_schema": pyarrow.schema([("ac", pyarrow.int64())])}],
)
def test_a_contract_has_exactly_one_schema(schemas):
    with pytest.raises(TableError, match="exactly one schema"):
        TableContract("meta.example", 1, 0, key=("ac",), partitions=(), **schemas)


@pytest.mark.parametrize(
    ("table", "key", "message"),
    [
        ("allele_observations", ("ac",), "is not <schema>.<name>"),
        ("surfaces.allele_observations", ("ac",), "is not <schema>.<name>"),
        ("measured.example", ("ac", "af"), r"key columns \['af'\]"),
    ],
)
def test_a_contract_names_a_v1_prefix_and_keys_on_its_own_columns(table, key, message):
    with pytest.raises(TableError, match=message):
        TableContract(table, 1, 0, key=key, partitions=(), schema=OBSERVATIONS_SCHEMA)


def test_an_arrow_contract_freezes_its_fields_in_order_and_names_one_file(monkeypatch):
    arrow = pyarrow.schema(
        [
            pyarrow.field("release", pyarrow.string(), nullable=False),
            pyarrow.field("sources", pyarrow.list_(pyarrow.string())),
        ]
    )
    example = TableContract("meta.example", 1, 2, key=("release",), partitions=(), arrow_schema=arrow)
    monkeypatch.setattr(contracts, "TABLE_CONTRACTS", MappingProxyType({"meta.example": example}))
    text = render("meta.example")
    assert text.endswith("}\n") and json.loads(text) == {
        "arrow": [
            {"name": "release", "nullable": False, "type": "string"},
            {"name": "sources", "nullable": True, "type": "list<item: string>"},
        ],
        "contract": "genomeos-table",
        "key": ["release"],
        "partitions": [],
        "schema_version": "1.2",
        "table": "meta.example",
    }
    assert columns("meta.example") == ("release", "sources")
    assert table_path("meta.example") == "tables/v1/meta/example.parquet"
    assert table_of("tables/v1/meta/example.parquet") == "meta.example"
