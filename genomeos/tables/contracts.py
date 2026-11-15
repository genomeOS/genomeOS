"""Every derived table's frozen contract (Atlas data platform design 2026-10-18 §2.3-§2.5; calls 4, 5, 18, 30,
37).

Everything under ``tables/v1/`` is derived from released bytes, and a reader can trust a file only as
far as it can name the contract the file obeys. This module is that name: one ``TableContract`` per
table, holding its key, its partitions and exactly one schema (pandera, or Arrow for a table pandera
does not describe). ``scripts/freeze_contract.py`` writes each contract to
``contract/tables/<table>.v<MAJOR>.schema.json``, so that a change shows up as a diff, and each file
a build writes records the ``contract_sha256`` it was checked against (§2.5). The frozen file wraps
pandera's JSON with the table, version, key and partitions, because ``to_json`` carries none of
them. A MINOR version is additive; a MAJOR one is a new ``tables/v2/`` (§2.5). ``TABLE_CONTRACT_REVISIONS``
pins every reviewed revision's digest: a MINOR bump adds a digest and never removes one.

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

``measured.carrier_observations`` holds carrier counts over individuals (KIR gene presence), under the
carrier fit-input contract: ``carriers`` and ``n_individuals`` in place of ``ac`` and ``an``. It is never
unioned with allele counts (§2.2 rule 3, §2.4). ``measured.ingests`` (§2.4 as amended; step 1.9) is an Arrow
contract: one row per curated ingest, keyed by ``(table, source, ingest_version)`` because two AFND adapters
share ``afnd``/``afnd-2026-08``, with each ingest's inputs and its refusals as lists of structs. A refusal is
``{reason, population_id, count}``: a population is its own field, never folded into the reason. Its MINOR
1.1 (§2.10, D17) adds two nullable columns for the whole-genome recount's sample rule, ``sample_rule`` and
``sample_stage_sha256``, null for a curated ingest.

``measured.fit_inputs`` (§2.4, §2.8; call 8) is the only table that links measured to inferred: keys only,
one row per artifact and measured record, with the artifact's identity and ``measurement``, the record's
``source``, ``ingest_version`` and ``source_record_id``, and its ``evidence`` (``fit-record`` or
``web-json-match``). Its ``epoch``, the release that first wrote the artifact's rows, is stored, so check 2
compares each folder with its rows.

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

from genomeos.observations.schema import (
    CARRIER_OBSERVATIONS_SCHEMA,
    OBSERVATIONS_SCHEMA,
    VARIANT_ID_PATTERN,
)
from genomeos.publication import artifact_inputs as ai
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

#: Carrier counts over individuals (§2.4): exactly the carrier fit-input contract, never unioned with
#: allele counts.
CARRIER_OBSERVATIONS = TableContract(
    "measured.carrier_observations",
    major=1,
    minor=0,
    key=("ingest_version", "source_record_id"),
    partitions=("source", "ingest_version"),
    schema=CARRIER_OBSERVATIONS_SCHEMA,
)


#: The evidence a ``measured.fit_inputs`` row may carry (§2.4): ``inferred.FIT_RECORD`` and
#: ``inferred.WEB_JSON_MATCH``. ``none`` is no row, only a reason in ``inferred.artifacts``.
FIT_INPUT_EVIDENCE = ("fit-record", "web-json-match")
#: A release id, ``YYYY-MM-DD`` with an optional ``.N`` (``data_release.assert_release_id``).
RELEASE_ID_PATTERN = r"^\d{4}-\d{2}-\d{2}(?:\.[1-9]\d*)?$"

#: Which measured record each artifact was fit to, as keys only (§2.4, §2.8; call 8).
FIT_INPUTS_SCHEMA = pa.DataFrameSchema(
    {
        "epoch": pa.Column(str, pa.Check.str_matches(RELEASE_ID_PATTERN), nullable=False),
        "artifact": pa.Column(str, REVIEWABLE_TEXT, nullable=False),
        "variant_id": pa.Column(str, pa.Check.str_matches(VARIANT_ID_PATTERN), nullable=False),
        "model_version": pa.Column(str, REVIEWABLE_TEXT, nullable=False),
        "data_version": pa.Column(str, REVIEWABLE_TEXT, nullable=False),
        "measurement": pa.Column(str, pa.Check.isin(list(ai.INPUT_CONTRACTS)), nullable=False),
        "source": pa.Column(str, REVIEWABLE_TEXT, nullable=False),
        "ingest_version": pa.Column(str, REVIEWABLE_TEXT, nullable=False),
        "source_record_id": pa.Column(str, REVIEWABLE_TEXT, nullable=False),
        "evidence": pa.Column(str, pa.Check.isin(list(FIT_INPUT_EVIDENCE)), nullable=False),
    },
    unique=["artifact", "ingest_version", "source_record_id"],
    strict=True,
    coerce=True,
    name="fit_inputs",
)

FIT_INPUTS = TableContract(
    "measured.fit_inputs",
    major=1,
    minor=0,
    key=("artifact", "ingest_version", "source_record_id"),
    partitions=("epoch",),
    schema=FIT_INPUTS_SCHEMA,
)


def _arrow(*fields: tuple[str, pyarrow.DataType, bool]) -> pyarrow.Schema:
    """An ordered Arrow schema from ``(name, type, nullable)``."""
    return pyarrow.schema([pyarrow.field(name, kind, nullable=nullable) for name, kind, nullable in fields])


_TEXT = pyarrow.string()

# DuckDB writes every field of a struct inside a list as nullable, so the contract says so too; which
# fields may be null is ``genomeos.tables.measured``'s check (``IngestInput``, ``Refusal``).
#: One input of an ingest: a released key with its sha256, or a cited upstream URL with md5 and
#: generation (D17), and its byte count.
_INGEST_INPUT = pyarrow.struct(
    [
        ("bytes", pyarrow.int64()),
        ("key", _TEXT),
        ("sha256", _TEXT),
        ("url", _TEXT),
        ("md5", _TEXT),
        ("generation", pyarrow.int64()),
    ]
)
#: Rows an adapter refused for one reason, in one population when it names one.
_REFUSAL = pyarrow.struct([("reason", _TEXT), ("population_id", _TEXT), ("count", pyarrow.int64())])

#: One row per ingest (§2.4 as amended; step 1.9): the table and part it wrote, the registry its
#: populations resolve in, the adapter (a repository file) and the commit it ran at, its inputs, the rows it
#: kept and refused, and the ``source_record_id`` template a lookup set derives its ids from (none for a
#: curated part, which stores them). 1.1 adds the whole-genome recount's sample rule (D17): its
#: ``cohort_id`` and its stage file's sha256, null for a curated ingest.
INGESTS = TableContract(
    "measured.ingests",
    major=1,
    minor=1,
    key=("table", "source", "ingest_version"),
    partitions=(),
    arrow_schema=_arrow(
        ("table", _TEXT, False),
        ("source", _TEXT, False),
        ("ingest_version", _TEXT, False),
        ("registry_version", _TEXT, False),
        ("adapter", _TEXT, False),
        ("adapter_git_sha", _TEXT, False),
        ("inputs", pyarrow.list_(_INGEST_INPUT), False),
        ("n_rows", pyarrow.int64(), False),
        ("refusals", pyarrow.list_(_REFUSAL), False),
        ("source_record_id_template", _TEXT, True),
        ("sample_rule", _TEXT, True),
        ("sample_stage_sha256", _TEXT, True),
    ),
)

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
            CARRIER_OBSERVATIONS,
            INGESTS,
            FIT_INPUTS,
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


#: Every reviewed revision of each table contract, as the sha256 of its frozen file (``contract_sha256``),
#: the digest each published file records. A frozen file equals its render by construction, so this is
#: what makes a contract change a reviewed event: a test fails until the new digest is appended here. A
#: MINOR bump adds a digest and never removes one, because the files written under the earlier revision
#: stay published (§2.5); a MAJOR bump is a new ``tables/v2/``.
TABLE_CONTRACT_REVISIONS: Mapping[str, frozenset[str]] = MappingProxyType(
    {
        "measured.allele_observations": frozenset(
            {"a403dbeb5c28d01815aea260ed22832d2b3152e79dd95c23b91505cab229fc68"}
        ),
        "measured.allele_observations_binned": frozenset(
            {"6a6438fbe95df3d43a93c1752b66365956befab5233442feb49352b0f21032c2"}
        ),
        "measured.carrier_observations": frozenset(
            {"ebdb0706df347a3995f17775634fd2ff2ddffab0fd7d64d65fea13d92676625b"}
        ),
        "measured.ingests": frozenset({"69ffa0a2eaa74eb881a3290920b8f9a6db6a3aced98c55d926e7e4c7899a9591"}),
        "measured.fit_inputs": frozenset(
            {"bbfa62bb67ea2fbbc57a72e7e400249ba993d0ebe2e7484c988611506dcfb56b"}
        ),
        "meta.release_objects": frozenset(
            {"6beb1c9eef2fae9810722172d67b50f1c02fde7275a629ec4a125ebd7b90b666"}
        ),
        "meta.sources": frozenset({"f7b539fe53f37ab31c78eb96d73120481e4ef74eccbd9062621673e308f12d24"}),
        "meta.served": frozenset({"4430430c846120c0bd0a78c6d83bfc5805c29317188e686bfe5c999776c6e7b8"}),
        "meta.withdrawn": frozenset({"28e134d1eb504b0f05ff65942f7bc98e96c4f10b37156568551119ff678381f3"}),
        "inferred.artifacts": frozenset({"99a440e5134c9629ef1f1a164f37cc1f5d40020dc8f374cfeed6fa7594b4871f"}),
        "inferred.cells_by_cell": frozenset(
            {"01753b7d64d6108dec44572bab362cf69941fc0e1560415de416cf533b10feed"}
        ),
        "reference.populations": frozenset(
            {"9e022086fd1e270a0c17d5c9db77f8ca60b3045f8e016502afd4a12c56e043e2"}
        ),
        "reference.population_aliases": frozenset(
            {"4162bfb70c7924246db10808569761752aeeca49195558875274f92fe6e2e9b5"}
        ),
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
