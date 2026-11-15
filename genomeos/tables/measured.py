"""The curated ingests under ``tables/v1/measured/``, and ``measured.ingests``, the record of each one.

Atlas data platform design 2026-10-18 §2.3, §2.4 (as amended) and §2.7 checks 2-5 and 9; builder's call 6;
step 1.9.

A curated ingest is one adapter's rows from released raw inputs, written as one
``tables/v1/measured/<table>/source=<s>/ingest_version=<iv>/part-0.parquet`` (``part_path``). The AFND
harvest ``afnd-2026-08`` gives three (``CURATED_INGESTS``), all resolving populations in the ``afnd-2026-08``
registry:

- ``afnd_frequencies``: HLA, MIC and KIR allele counts, in ``measured.allele_observations``;
- ``afnd`` from ``afnd_cytokines``: cytokine genotype triples counted into allele counts, in the same table;
- ``afnd`` from ``afnd_carriers``: KIR gene presence, carriers over individuals, in
  ``measured.carrier_observations``. A carrier count is never an allele row, nor in an allele file (§2.2
  rule 3).

The last two share ``afnd``/``afnd-2026-08``, so ``measured.ingests`` is keyed by ``(table, source,
ingest_version)``. Each row records the registry, the adapter (a repository file) and the commit it ran at,
every input (``IngestInput``), the rows kept, the refusals (``Refusal``: a reason, a population when the
adapter names one, never folded into the reason, and a count) and the ``source_record_id`` template (none
for a curated part, which stores its ids). The table is a summary: it gets a new key each release.

The rules, each refusal a ``TableError`` (v1 §12):

- check 2: a part's ``key=value`` folders equal its rows' values (``check_partition_values``);
- check 3: a part's rows pass its contract's pandera schema, with one source, one ingest version and a
  unique ``source_record_id`` (``ingest_part``); a source with a spatial-support contract enters only
  through the adapter that enforces it (``SPATIAL_SUPPORT_ADAPTERS``, ``check_curated_ingests``);
- check 4: re-ingesting a released part's inputs gives its ``source_record_id`` set (``reingest_matches``);
- check 5: every ``population_id`` resolves in the pinned registry (``reference.require_resolved``, run by
  the stage);
- check 9: every input is a manifest key with its sha256, or a cited URL with md5 and generation
  (``check_ingest_inputs``).

``scripts/build_tables.py`` runs the stage (``build_measured``); this module keeps the rules, and reads
nothing but a ``measured.ingests`` file.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from types import MappingProxyType, ModuleType
from typing import Any

import pandas as pd
import pandera.errors
import pyarrow
import pyarrow.parquet as pq

from genomeos.observations.sources import afnd_carriers, afnd_cytokines, afnd_frequencies
from genomeos.publication import data_release as dr
from genomeos.tables import contracts, reference, writer
from genomeos.tables.contracts import TableError

ALLELE_TABLE = contracts.ALLELE_OBSERVATIONS.table
CARRIER_TABLE = contracts.CARRIER_OBSERVATIONS.table
INGESTS_TABLE = contracts.INGESTS.table
#: The order of a part's rows, and of the writer's ``ORDER BY``.
SORT_KEY = ("variant_id", "population_id", "source_record_id")
INGESTS_PATH = "tables/v1/measured/ingests.parquet"
PART_FILE = "part-0.parquet"
#: The curated tables, each a folder of ``source=``/``ingest_version=`` parts.
PART_TABLES = (ALLELE_TABLE, CARRIER_TABLE)
#: The only source with a spatial-support contract: MAP surveys, whose disc must bound the sampled area
#: (``sampling_bounding_disc``, docs/map-spatial-support.md). Its rows enter only through this adapter,
#: whose ``_explicit_radii`` enforces it; AFND has no such contract, so pandera alone applies (check 3).
SPATIAL_SUPPORT_ADAPTERS: Mapping[str, str] = MappingProxyType(
    {"map_surveys": "genomeos/observations/sources/map_surveys.py"}
)
AFND_INGEST_VERSION = "afnd-2026-08"
#: The AFND harvest's frequency table (step 1.8) and the released AFND population table (call 18).
AFND_FREQUENCIES = "raw/afnd/2026-08/afnd_frequencies.tsv"
AFND_POPULATIONS = "raw/afnd_populations.tsv"
_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_SHA256 = re.compile(r"[0-9a-f]{64}")


def part_path(table: str, source: str, ingest_version: str) -> str:
    """``tables/v1/measured/<table>/source=<source>/ingest_version=<ingest_version>/part-0.parquet``."""
    _part_contract(table)
    _segment("source", source)
    _segment("ingest_version", ingest_version)
    return f"{contracts.table_path(table)}source={source}/ingest_version={ingest_version}/{PART_FILE}"


@dataclass(frozen=True)
class IngestInput:
    """One input of an ingest and its byte count: a released key with its sha256, or a cited upstream URL
    with its md5 and generation (§2.7 check 9, D17)."""

    bytes: int
    key: str | None = None
    sha256: str | None = None
    url: str | None = None
    md5: str | None = None
    generation: int | None = None

    def __post_init__(self) -> None:
        if not _is_count(self.bytes):
            raise TableError(f"ingest input {self.key or self.url}: bytes {self.bytes!r} is not a byte count")
        cited = {"url": self.url, "md5": self.md5, "generation": self.generation}
        if self.key is not None:
            if not self.key.startswith(dr.RELEASE_PREFIX) or not _SHA256.fullmatch(self.sha256 or ""):
                raise TableError(
                    f"ingest input {self.key}: a released input is a releases/<R>/<path> key with a sha256"
                )
            if any(value is not None for value in cited.values()):
                raise TableError(f"ingest input {self.key}: a released key cites no url, md5 or generation")
            return
        missing = [name for name, value in cited.items() if value is None]
        if self.sha256 is not None or missing:
            raise TableError(
                f"ingest input {self.url}: an input is a released key with its sha256, or a cited url with "
                f"its md5 and generation (D17); it lacks {missing or ['key']}"
            )
        if not str(self.url).startswith("https://") or not self.md5 or not _is_count(self.generation, 1):
            raise TableError(f"ingest input {self.url}: an https url, an md5 and a positive generation")


@dataclass(frozen=True)
class Refusal:
    """``count`` rows an adapter refused for ``reason``, in ``population_id`` when it names one."""

    reason: str
    population_id: str | None
    count: int

    def __post_init__(self) -> None:
        population = self.population_id is None or _is_text(self.population_id)
        if not _is_text(self.reason) or not population or not _is_count(self.count):
            raise TableError(f"refusal {self!r}: a reason, an optional population_id and a row count")


@dataclass(frozen=True)
class Ingest:
    """One row of ``measured.ingests``."""

    table: str
    source: str
    ingest_version: str
    registry_version: str
    adapter: str
    adapter_git_sha: str
    inputs: tuple[IngestInput, ...]
    n_rows: int
    refusals: tuple[Refusal, ...]
    source_record_id_template: str | None

    def __post_init__(self) -> None:
        part_path(self.table, self.source, self.ingest_version)
        reference.registry_folder(self.registry_version)
        _adapter_path(self.adapter)
        sha = self.adapter_git_sha
        if not isinstance(sha, str) or not writer.GIT_SHA_PATTERN.fullmatch(sha):
            raise TableError(f"{self.name}: adapter_git_sha {self.adapter_git_sha!r} is not a commit")
        if not self.inputs or not all(isinstance(item, IngestInput) for item in self.inputs):
            raise TableError(f"{self.name}: an ingest records every input it read (§2.1)")
        if not _is_count(self.n_rows) or not all(isinstance(item, Refusal) for item in self.refusals):
            raise TableError(f"{self.name}: n_rows is a row count, and each refusal a Refusal")
        repeated = [key for key, n in Counter(_refusal_key(item) for item in self.refusals).items() if n > 1]
        if repeated:
            raise TableError(f"{self.name}: refusal {repeated[0]} is listed twice")
        if self.source_record_id_template is not None and not _is_text(self.source_record_id_template):
            raise TableError(f"{self.name}: a source_record_id template is text, or none")

    @property
    def key(self) -> tuple[str, str, str]:
        """``(table, source, ingest_version)``, the ``measured.ingests`` key."""
        return (self.table, self.source, self.ingest_version)

    @property
    def name(self) -> str:
        return "/".join(self.key)


@dataclass(frozen=True)
class CuratedIngest:
    """A reviewed ingest: the part it writes, its registry, its adapter's file and ``load``, and the
    release paths of the inputs ``load`` reads, in its argument order (``load(*inputs, ingest_version)``)."""

    table: str
    source: str
    ingest_version: str
    registry_version: str
    adapter: str
    inputs: tuple[str, ...]
    load: Callable[..., tuple[pd.DataFrame, Any]]


def _adapter(module: ModuleType) -> str:
    """The repository file of an adapter module."""
    return f"{module.__name__.replace('.', '/')}.py"


_AFND_INPUTS = (AFND_FREQUENCIES, AFND_POPULATIONS)
#: The curated ingests a release builds, each a part of its own (step 1.9).
CURATED_INGESTS: tuple[CuratedIngest, ...] = tuple(
    CuratedIngest(
        table,
        source,
        AFND_INGEST_VERSION,
        reference.AFND_LEGACY,
        _adapter(module),
        _AFND_INPUTS,
        module.load,
    )
    for table, source, module in (
        (ALLELE_TABLE, afnd_frequencies.SOURCE, afnd_frequencies),
        (ALLELE_TABLE, "afnd", afnd_cytokines),
        (CARRIER_TABLE, "afnd", afnd_carriers),
    )
)


def check_curated_ingests(ingests: Sequence[CuratedIngest]) -> None:
    """Each ingest once, and a source with a spatial-support contract only through its adapter (check 3)."""
    _require_once((ingest.table, ingest.source, ingest.ingest_version) for ingest in ingests)
    for ingest in ingests:
        part_path(ingest.table, ingest.source, ingest.ingest_version)
        _adapter_path(ingest.adapter)
        enforced = SPATIAL_SUPPORT_ADAPTERS.get(ingest.source)
        if enforced is not None and ingest.adapter != enforced:
            raise TableError(
                f"check 3: {ingest.source} rows enter only through {enforced}, which enforces their "
                f"spatial-support contract (sampling_bounding_disc, docs/map-spatial-support.md); "
                f"{ingest.adapter} does not"
            )


def refusals_of(report: Any) -> tuple[Refusal, ...]:
    """An adapter report's ``refusals`` (reason -> count) as ``Refusal`` rows, sorted by reason."""
    found = getattr(report, "refusals", None)
    if not isinstance(found, Mapping):
        raise TableError(f"an adapter report records its refusals as reason -> count; got {report!r}")
    return tuple(Refusal(str(reason), None, int(count)) for reason, count in sorted(found.items()))


def ingest_part(rows: pd.DataFrame, *, table: str) -> pd.DataFrame:
    """A part's rows: the contract's columns, valid under its pandera schema with a unique
    ``source_record_id``, of one source and one ingest version, sorted by ``SORT_KEY`` (check 3)."""
    schema = _part_contract(table).schema
    assert schema is not None
    try:
        frame = schema.validate(rows.reset_index(drop=True))
    except (pandera.errors.SchemaError, pandera.errors.SchemaErrors) as error:
        raise TableError(f"check 3: rows the {table} contract refuses: {error}") from error
    for column in ("source", "ingest_version"):
        values = sorted(set(frame[column]))
        if len(values) != 1:
            raise TableError(f"check 3: a {table} part holds one {column}; these rows hold {values[:5]}")
    ordered = frame.loc[:, list(schema.columns)].sort_values(list(SORT_KEY), kind="stable")
    return ordered.reset_index(drop=True)


def check_partition_values(path: str, frame: pd.DataFrame) -> None:
    """Check 2 on a part's rows: each ``key=value`` folder of ``path`` equals every row's ``key``."""
    for segment in path.split("/")[:-1]:
        key, separator, value = segment.partition("=")
        if not separator:
            continue
        if key not in frame.columns:
            raise TableError(f"check 2: {path}: partition key {key} is not a column of its rows")
        differs = frame[key].astype(str) != value
        if differs.any():
            raise TableError(
                f"check 2: {path}: {int(differs.sum())} rows have {key} {frame[key][differs].iloc[0]!r}, "
                f"not the folder's {value!r}"
            )


def reingest_matches(part: pd.DataFrame, rebuilt: pd.DataFrame) -> None:
    """Check 4: re-ingesting a released part's inputs gives exactly its ``source_record_id`` set."""
    released, again = set(part["source_record_id"]), set(rebuilt["source_record_id"])
    if released != again:
        raise TableError(
            f"check 4: the re-ingest gives {len(again)} source_record_ids and the released part holds "
            f"{len(released)}: {sorted(released - again)[:3]} are missing, {sorted(again - released)[:3]} "
            "are new; a released part is never rewritten (call 6), so publish a new ingest_version"
        )


def ingests_table(ingests: Sequence[Ingest]) -> pyarrow.Table:
    """``measured.ingests``: one row per ingest, sorted by ``(table, source, ingest_version)``."""
    _require_once(ingest.key for ingest in ingests)
    rows = [
        {
            "table": ingest.table,
            "source": ingest.source,
            "ingest_version": ingest.ingest_version,
            "registry_version": ingest.registry_version,
            "adapter": ingest.adapter,
            "adapter_git_sha": ingest.adapter_git_sha,
            "inputs": [asdict(item) for item in ingest.inputs],
            "n_rows": ingest.n_rows,
            "refusals": [asdict(item) for item in sorted(ingest.refusals, key=_refusal_key)],
            "source_record_id_template": ingest.source_record_id_template,
        }
        for ingest in sorted(ingests, key=lambda ingest: ingest.key)
    ]
    return pyarrow.Table.from_pylist(rows, schema=contracts.INGESTS.arrow_schema)


def read_ingests(path: Path) -> tuple[Ingest, ...]:
    """The ingests a ``measured.ingests`` file records, checked against its contract (check 1)."""
    writer.check_table_file(path, INGESTS_TABLE)
    try:
        return tuple(
            Ingest(
                **{
                    **row,
                    "inputs": tuple(IngestInput(**item) for item in row["inputs"]),
                    "refusals": tuple(Refusal(**item) for item in row["refusals"]),
                }
            )
            for row in pq.read_table(path).to_pylist()
        )
    except TableError as error:
        raise TableError(f"{path}: {error}") from error


def check_ingest_inputs(ingests: Sequence[Ingest], published: Mapping[str, dr.ReleaseObject]) -> None:
    """Check 9: every released input of every ingest is a key of ``published`` (each key of this release and
    the committed earlier ones), with that object's sha256 and bytes. A cited input carries its md5 and
    generation, which ``IngestInput`` requires."""
    for ingest in ingests:
        for item in ingest.inputs:
            if item.key is None:
                continue
            found = published.get(item.key)
            where = f"check 9: {INGESTS_PATH}: {ingest.name}: input {item.key}"
            if found is None:
                raise TableError(f"{where} is not a manifest key of this release or an earlier one")
            if item.sha256 != found.sha256:
                raise TableError(f"{where}: sha256 {item.sha256}, but the manifest records {found.sha256}")
            if item.bytes != found.bytes:
                raise TableError(f"{where}: {item.bytes} bytes, but the manifest records {found.bytes}")


def _part_contract(table: str) -> contracts.TableContract:
    if table not in PART_TABLES:
        raise TableError(f"{table!r}: a curated part is in one of {list(PART_TABLES)}")
    return contracts.TABLE_CONTRACTS[table]


def _segment(name: str, value: object) -> None:
    if not isinstance(value, str) or not _SEGMENT.fullmatch(value):
        raise TableError(f"{name} {value!r} is not one path segment of [A-Za-z0-9._-]")


def _adapter_path(adapter: object) -> None:
    try:
        valid = isinstance(adapter, str) and adapter.endswith(".py") and bool(dr.assert_data_path(adapter))
    except dr.DataReleaseError:
        valid = False
    if not valid:
        raise TableError(f"adapter {adapter!r} is not a repository .py file path")


def _require_once(keys: Iterable[tuple[str, str, str]]) -> None:
    twice = sorted(key for key, n in Counter(keys).items() if n > 1)
    if twice:
        raise TableError(
            f"ingest {'/'.join(twice[0])} is listed twice; measured.ingests holds one row per "
            "(table, source, ingest_version) (§2.4)"
        )


def _refusal_key(refusal: Refusal) -> tuple[str, str]:
    return (refusal.reason, refusal.population_id or "")


def _is_count(value: object, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _is_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())
