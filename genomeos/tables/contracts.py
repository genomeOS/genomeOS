"""Every derived table's frozen contract (Atlas data platform design 2026-10-18 §2.4, §2.5; calls 30, 37).

Everything under ``tables/v1/`` is derived from released bytes, and a reader can trust a file only as
far as it can name the contract the file obeys. This module is that name: one ``TableContract`` per
table, holding its key, its partitions and exactly one schema (pandera, or Arrow for a table pandera
does not describe). ``scripts/freeze_contract.py`` writes each contract to
``contract/tables/<table>.v<MAJOR>.schema.json``, so that a change shows up as a diff, and each file
a build writes records the ``contract_sha256`` it was checked against (§2.5). The frozen file wraps
pandera's JSON with the table, version, key and partitions, because ``to_json`` carries none of
them. A MINOR version is additive; a MAJOR one is a new ``tables/v2/`` (§2.5).

The two allele tables never share a prefix, a file or a contract (§2.4, call 37):

- ``measured.allele_observations`` holds the curated ingests and stores all 17 columns of
  ``OBSERVATIONS_SCHEMA``, the fit-input contract, ``source_record_id`` included.
- ``measured.allele_observations_binned`` holds the whole-genome lookup sets. It stores the other 16
  columns plus ``pos`` and ``source_label``: its ``source_record_id`` is derived by the lookup macro
  from the template recorded in ``measured.ingests`` (call 30: 8.2 GB stored instead of 30.3 GB).
  Its ``variant_id`` is always a ``chr-pos-ref-alt`` locus on chr1-22, X or Y (D18: there is no
  chrM file), because a lookup URL is computed from the chromosome and ``pos // 1e6``. An ``hla:``,
  ``kir:`` or ``phenotype:`` id has no locus, so it lives only in a curated ingest (§2.6).

Both store counts, never frequencies (v1 §7.1b): ``ac`` and ``an``, and no ``af`` column.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

import pandas as pd
import pandera.pandas as pa
import pyarrow
from pandera import extensions

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.schema_checks import REVIEWABLE_TEXT


class TableError(ValueError):
    """A derived table, or a file of one, that its contract does not admit."""


#: The loci a lookup set can hold: D18's chromosome set, chr1-22, X and Y. There is no chrM file
#: (§1.2 item 1), so no chrM id may compute a lookup URL (§2.6).
LOCUS_VARIANT_ID_PATTERN = r"^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y)-\d+-[ACGT]+-[ACGT]+$"
#: The five top-level prefixes of ``tables/v1/`` (§2.3). Measured and inferred never share one.
_TABLE_NAME = re.compile(r"(?:measured|inferred|reference|evidence|meta)\.[a-z][a-z0-9_]*")


# Registered, not an inline lambda: `to_json` drops an anonymous check, so it would be missing from
# the frozen contract and its removal would never show in a diff (as in genomeos.observations.schema).
@extensions.register_check_method(check_type="vectorized")
def pos_matches_variant_id(df):
    """A stored ``pos`` repeats the position field of its ``chr-pos-ref-alt`` id."""
    position = pd.to_numeric(df["variant_id"].str.split("-").str[1], errors="coerce")
    return position.eq(df["pos"]).fillna(False).astype(bool)


@dataclass(frozen=True)
class TableContract:
    """One table's frozen contract: its name, version, key and partitions, and exactly one schema."""

    table: str
    major: int
    minor: int
    key: tuple[str, ...]
    partitions: tuple[str, ...]
    schema: pa.DataFrameSchema | None = None
    arrow_schema: pyarrow.Schema | None = None

    def __post_init__(self) -> None:
        if (self.schema is None) == (self.arrow_schema is None):
            raise TableError(f"{self.table}: a table contract has exactly one schema, pandera or Arrow")
        if not _TABLE_NAME.fullmatch(self.table):
            raise TableError(
                f"{self.table!r} is not <schema>.<name> under measured, inferred, reference, evidence or meta"
            )
        missing = [name for name in self.key if name not in _columns(self)]
        if missing:
            raise TableError(f"{self.table}: key columns {missing} are not columns of its contract")

    @property
    def schema_version(self) -> str:
        """``MAJOR.MINOR``, as each file records it in ``genomeos.schema_version``."""
        return f"{self.major}.{self.minor}"

    @property
    def path(self) -> str:
        """The frozen file, relative to the repository root."""
        return f"contract/tables/{self.table}.v{self.major}.schema.json"


def _columns(contract: TableContract) -> tuple[str, ...]:
    if contract.schema is not None:
        return tuple(contract.schema.columns)
    assert contract.arrow_schema is not None
    return tuple(contract.arrow_schema.names)


#: The curated ingests' table (§2.4): exactly the fit-input contract, the same 17 columns and checks.
ALLELE_OBSERVATIONS = TableContract(
    "measured.allele_observations",
    major=1,
    minor=0,
    key=("ingest_version", "source_record_id"),
    partitions=("source", "ingest_version"),
    schema=OBSERVATIONS_SCHEMA,
)

#: A lookup set's rows (§2.4, §2.10; calls 30, 37). Unique on the table key, because without a stored
#: ``source_record_id`` nothing else identifies a row.
BINNED_OBSERVATIONS_SCHEMA = pa.DataFrameSchema(
    {
        # remove_columns returns a copy, so this schema never shares a column with the fit input's.
        **OBSERVATIONS_SCHEMA.remove_columns(["source_record_id"]).columns,
        "variant_id": pa.Column(str, pa.Check.str_matches(LOCUS_VARIANT_ID_PATTERN), nullable=False),
        # The position the URL's bin is computed from (bin = pos // 1e6, check 2).
        "pos": pa.Column("Int64", pa.Check.ge(1), nullable=False),
        # The label the source gave the population, beside the registry's population_id.
        "source_label": pa.Column(str, REVIEWABLE_TEXT, nullable=False),
    },
    checks=[
        pa.Check.ac_le_an(error="ac must not exceed an"),
        pa.Check.date_lower_le_upper(error="date_lower must not exceed date_upper"),
        pa.Check.pos_matches_variant_id(error="pos must be the position in variant_id"),
    ],
    unique=["ingest_version", "variant_id", "population_id"],
    strict=True,
    coerce=True,
    name="allele_observations_binned",
)

ALLELE_OBSERVATIONS_BINNED = TableContract(
    "measured.allele_observations_binned",
    major=1,
    minor=0,
    key=("ingest_version", "variant_id", "population_id"),
    # chrom and bin are derived from variant_id and pos, never stored (check 2).
    partitions=("source", "ingest_version", "chrom", "bin"),
    schema=BINNED_OBSERVATIONS_SCHEMA,
)

#: Every derived table, by name. A table is written, checked or catalogued only if it is here.
TABLE_CONTRACTS: Mapping[str, TableContract] = MappingProxyType(
    {contract.table: contract for contract in (ALLELE_OBSERVATIONS, ALLELE_OBSERVATIONS_BINNED)}
)


def _contract(table: str) -> TableContract:
    if table not in TABLE_CONTRACTS:
        raise TableError(f"{table!r} has no table contract; registered: {sorted(TABLE_CONTRACTS)}")
    return TABLE_CONTRACTS[table]


def render(table: str) -> str:
    """The frozen file's exact text: the contract's identity around its pandera JSON or Arrow fields.

    An Arrow contract freezes each field's name, type and nullability, in column order.
    """
    contract = _contract(table)
    frozen: dict[str, object] = {
        "contract": "genomeos-table",
        "table": contract.table,
        "schema_version": contract.schema_version,
        "key": list(contract.key),
        "partitions": list(contract.partitions),
    }
    if contract.schema is not None:
        frozen["pandera"] = json.loads(contract.schema.to_json())
    else:
        assert contract.arrow_schema is not None
        frozen["arrow"] = [
            {"name": field.name, "type": str(field.type), "nullable": field.nullable}
            for field in contract.arrow_schema
        ]
    return json.dumps(frozen, indent=2, sort_keys=True) + "\n"


def contract_sha256(table: str) -> str:
    """The sha256 of the frozen file, which each written file records as ``genomeos.contract_sha256``."""
    return hashlib.sha256(render(table).encode("utf-8")).hexdigest()


def columns(table: str) -> tuple[str, ...]:
    """The table's stored columns, in contract order."""
    return _columns(_contract(table))


def table_path(table: str) -> str:
    """Where the table lives in a release: a folder of partitions, or one Parquet file (§2.3)."""
    contract = _contract(table)
    schema, name = table.split(".", 1)
    base = f"tables/v{contract.major}/{schema}/{name}"
    return f"{base}/" if contract.partitions else f"{base}.parquet"


def table_of(path: str) -> str:
    """The table a release path belongs to, or a ``TableError`` if no contract covers it."""
    for table, contract in TABLE_CONTRACTS.items():
        prefix = table_path(table)
        if (path.startswith(prefix) and path != prefix) if contract.partitions else path == prefix:
            return table
    raise TableError(f"{path}: no table contract covers this path")
