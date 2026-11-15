"""Every derived table's frozen contract (Atlas data platform design 2026-10-18 §2.3-§2.5; calls 4, 5, 18, 30,
37).

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

The four ``meta.*`` tables (§2.4, §2.9; calls 4, 7) are Arrow contracts: each field's name, type and
nullability, in order. ``meta.release_objects`` keeps a list of sources per object, which pandera
does not describe.

The two ``inferred.*`` tables (§2.4, §2.8; calls 8, 22) are Arrow contracts too, and never share a
prefix, file or column set with ``measured.*``. ``inferred.artifacts`` holds one row per released
artifact: its manifest's fields (``support_counts`` as a map), its ``measurement`` and where that came
from, the key and sha256 of each of its files, and its ``fit_input_evidence``, never null.
``inferred.cells_by_cell`` holds the 14 columns of every format-1 and format-2 ``cells.parquet``, plus
``h3_r0``, ``h3_parent_r3``, ``measurement``, ``artifact_format``, ``epoch`` and ``res``: partition keys
are stored columns, so check 2 compares each folder with its rows. Formats 3 and 4 add
``prior_frequency_sd``, which needs a MINOR 1.1 of ``cells_by_cell`` before such an artifact ships (F4).

The two ``reference.*`` tables (§2.3, §2.4; calls 5, 18) are the population registry. Each registry
release is one folder under ``REGISTRY_ROOT``, holding one file of each table (``REGISTRY_FILES``):
``reference.populations`` is P0's ``POPULATIONS_SCHEMA``, and ``reference.population_aliases`` is P0's
alias columns plus the ``registry_version`` they belong to. Both carry the full ``registry_version``, the
partition the folder names (as ``<release>-<sha8>`` or a legacy name, never ``registry_version=``), so
``table_path`` gives both tables the same root and ``table_of`` tells their files apart by name.
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
from genomeos.publication import data_release as dr
from genomeos.registry.schema import ALIASES_SCHEMA, POPULATIONS_SCHEMA
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


def _arrow(*fields: tuple[str, pyarrow.DataType, bool]) -> pyarrow.Schema:
    """An ordered Arrow schema from ``(name, type, nullable)``."""
    return pyarrow.schema([pyarrow.field(name, kind, nullable=nullable) for name, kind, nullable in fields])


_TEXT = pyarrow.string()

#: Every object of each earlier release, as its committed manifest lists it (§2.4; call 4).
RELEASE_OBJECTS = TableContract(
    "meta.release_objects",
    major=1,
    minor=0,
    key=("release", "path"),
    partitions=(),
    arrow_schema=_arrow(
        ("release", _TEXT, False),
        ("path", _TEXT, False),
        ("key", _TEXT, False),
        ("bytes", pyarrow.int64(), False),
        ("sha256", _TEXT, False),
        ("media_type", _TEXT, False),
        ("in_git", pyarrow.bool_(), False),
        ("sources", pyarrow.list_(_TEXT), False),
    ),
)

#: Each earlier release's sources and the terms it recorded, in the closed vocabulary (§2.4, §9).
SOURCES = TableContract(
    "meta.sources",
    major=1,
    minor=0,
    key=("release", "source"),
    partitions=(),
    arrow_schema=_arrow(
        ("release", _TEXT, False),
        ("source", _TEXT, False),
        ("name", _TEXT, False),
        ("citation", _TEXT, True),
        ("url", _TEXT, True),
        ("terms_status", _TEXT, False),
        ("terms_checked_at", _TEXT, True),
        ("terms_url", _TEXT, True),
        ("licence", _TEXT, True),
        ("recorded_in", _TEXT, True),
        ("note", _TEXT, True),
        ("non_commercial", pyarrow.bool_(), False),
    ),
)

#: The artifacts the website serves and what pins each one (§2.4; call 7).
SERVED = TableContract(
    "meta.served",
    major=1,
    minor=0,
    key=("artifact",),
    partitions=(),
    arrow_schema=_arrow(
        ("artifact", _TEXT, False),
        ("variant_id", _TEXT, False),
        ("model_version", _TEXT, False),
        ("data_version", _TEXT, False),
        ("pinned_by", _TEXT, False),
        ("pinned_sha256", _TEXT, False),
    ),
)

#: The published keys withdrawn from serving, as ``data/releases/WITHDRAWN.json`` lists them (§2.9).
WITHDRAWN = TableContract(
    "meta.withdrawn",
    major=1,
    minor=0,
    key=("key",),
    partitions=(),
    arrow_schema=_arrow(
        ("key", _TEXT, False),
        ("path", _TEXT, False),
        ("sha256", _TEXT, False),
        ("reason", _TEXT, False),
        ("issue", _TEXT, False),
        ("date", _TEXT, False),
        ("decided_by", _TEXT, False),
    ),
)

_DOUBLE = pyarrow.float64()
_INT = pyarrow.int32()

#: One row per released artifact (§2.4, §2.8; call 8): its manifest's fields, where its ``measurement``
#: came from, its files' keys and sha256s, and its ``fit_input_evidence`` with a reason exactly when
#: that is ``none``. A format-1 manifest records no target grid, and no released artifact has an input.
INFERRED_ARTIFACTS = TableContract(
    "inferred.artifacts",
    major=1,
    minor=0,
    key=("artifact",),
    partitions=(),
    arrow_schema=_arrow(
        ("artifact", _TEXT, False),
        ("variant_id", _TEXT, False),
        ("model_version", _TEXT, False),
        ("data_version", _TEXT, False),
        ("artifact_format", _INT, False),
        ("resolution", _INT, False),
        ("n_cells", pyarrow.int64(), False),
        ("n_observations", pyarrow.int64(), False),
        ("measurement", _TEXT, False),
        ("measurement_from", _TEXT, False),
        ("likelihood", _TEXT, False),
        ("correlation_range_km", _DOUBLE, False),
        ("lengthscale_sigma", _DOUBLE, False),
        ("prior_frequency_sd", _DOUBLE, False),
        ("target_grid_source", _TEXT, True),
        ("target_grid_version", _TEXT, True),
        ("support_counts", pyarrow.map_(_TEXT, pyarrow.int64()), False),
        ("first_release", _TEXT, False),
        ("epoch", _TEXT, False),
        ("cells_key", _TEXT, False),
        ("cells_sha256", _TEXT, False),
        ("manifest_key", _TEXT, False),
        ("manifest_sha256", _TEXT, False),
        ("observations_key", _TEXT, True),
        ("observations_sha256", _TEXT, True),
        ("fit_input_evidence", _TEXT, False),
        ("fit_input_evidence_reason", _TEXT, True),
    ),
)

#: Every cell of every format-1/2 artifact, partitioned by the release that first wrote it, the cell's
#: resolution and its resolution-0 ancestor (§2.4; call 22). The first 14 columns are ``cells.parquet``'s.
CELLS_BY_CELL = TableContract(
    "inferred.cells_by_cell",
    major=1,
    minor=0,
    key=("variant_id", "model_version", "data_version", "res", "h3_index"),
    partitions=("epoch", "res", "h3_r0"),
    arrow_schema=_arrow(
        ("h3_index", _TEXT, False),
        ("variant_id", _TEXT, False),
        ("post_median", _DOUBLE, False),
        ("post_mean", _DOUBLE, False),
        ("post_sd", _DOUBLE, False),
        ("q025", _DOUBLE, False),
        ("q975", _DOUBLE, False),
        ("q25", _DOUBLE, False),
        ("q75", _DOUBLE, False),
        ("support", _TEXT, False),
        ("posterior_contraction", _DOUBLE, False),
        ("dist_nearest_obs_km", _DOUBLE, False),
        ("model_version", _TEXT, False),
        ("data_version", _TEXT, False),
        ("h3_r0", _TEXT, False),
        ("h3_parent_r3", _TEXT, False),
        ("measurement", _TEXT, False),
        ("artifact_format", _INT, False),
        ("epoch", _TEXT, False),
        ("res", _INT, False),
    ),
)

#: One registry release's populations (§2.3, §2.4; call 5): P0's schema, ``registry_version`` included.
REFERENCE_POPULATIONS = TableContract(
    "reference.populations",
    major=1,
    minor=0,
    key=("registry_version", "population_id"),
    partitions=("registry_version",),
    schema=POPULATIONS_SCHEMA,
)

#: One registry release's aliases (§2.3, §2.4; call 18): P0's alias columns plus ``registry_version``, so
#: the rows of every registry folder, read together, stay apart. A legacy registry may be aliases alone.
REFERENCE_ALIASES_SCHEMA = pa.DataFrameSchema(
    # add_columns returns a copy, so this schema never shares a column with P0's.
    ALIASES_SCHEMA.add_columns({"registry_version": pa.Column(str, REVIEWABLE_TEXT, nullable=False)}).columns,
    unique=["registry_version", "source", "label"],
    strict=True,
    coerce=True,
    name="reference_population_aliases",
)

REFERENCE_ALIASES = TableContract(
    "reference.population_aliases",
    major=1,
    minor=0,
    key=("registry_version", "source", "label"),
    partitions=("registry_version",),
    schema=REFERENCE_ALIASES_SCHEMA,
)

#: The folder every registry release's folder lies in (§2.3): ``<REGISTRY_ROOT><folder>/<file>``.
REGISTRY_ROOT = dr.REGISTRY_PREFIX
#: Each reference table's file inside a registry folder (``registry.release_contract``'s file names).
REGISTRY_FILES: Mapping[str, str] = MappingProxyType(
    {
        REFERENCE_POPULATIONS.table: "populations.parquet",
        REFERENCE_ALIASES.table: "population_aliases.parquet",
    }
)

#: Every derived table, by name. A table is written, checked or catalogued only if it is here.
TABLE_CONTRACTS: Mapping[str, TableContract] = MappingProxyType(
    {
        contract.table: contract
        for contract in (
            ALLELE_OBSERVATIONS,
            ALLELE_OBSERVATIONS_BINNED,
            RELEASE_OBJECTS,
            SOURCES,
            SERVED,
            WITHDRAWN,
            INFERRED_ARTIFACTS,
            CELLS_BY_CELL,
            REFERENCE_POPULATIONS,
            REFERENCE_ALIASES,
        )
    }
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
    """Where the table lives in a release: a folder of partitions, or one Parquet file (§2.3).

    A reference table lives in the registry folders under ``REGISTRY_ROOT``, one file in each.
    """
    contract = _contract(table)
    if table in REGISTRY_FILES:
        return REGISTRY_ROOT
    schema, name = table.split(".", 1)
    base = f"tables/v{contract.major}/{schema}/{name}"
    return f"{base}/" if contract.partitions else f"{base}.parquet"


def table_of(path: str) -> str:
    """The table a release path belongs to, or a ``TableError`` if no contract covers it.

    Under ``REGISTRY_ROOT`` only a ``REGISTRY_FILES`` name directly inside a registry folder is covered.
    """
    if path.startswith(REGISTRY_ROOT):
        folder, _, name = path.removeprefix(REGISTRY_ROOT).partition("/")
        found = [table for table, file_name in REGISTRY_FILES.items() if folder and name == file_name]
        if found:
            return found[0]
        raise TableError(
            f"{path}: no table contract covers this path; a registry folder holds only "
            f"{sorted(REGISTRY_FILES.values())}"
        )
    for table, contract in TABLE_CONTRACTS.items():
        if table in REGISTRY_FILES:
            continue
        prefix = table_path(table)
        if (path.startswith(prefix) and path != prefix) if contract.partitions else path == prefix:
            return table
    raise TableError(f"{path}: no table contract covers this path")
