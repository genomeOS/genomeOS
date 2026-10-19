"""Inputs travel with outputs: the release rule for an artifact's fit input (#45; data store design §5).

Every artifact a release publishes carries ``observations.parquet``, the exact observation table its
fit consumed, and its ``manifest.json`` records that file's sha256, size, row count, measurement and
contract. The release builder measures the file and calls ``check_artifact_inputs``; any
disagreement is a hard error (design §12), never a skipped file.

The record is not taken on trust. Beyond agreeing with the file, the file must be what its contract
promises, checked here without loading the contract: integer counts under its own measurement's
names (``ac``/``an`` over chromosomes, ``carriers``/``n_individuals`` over people, #133), no other
measurement's counts, no frequency column (design §7.1b), and exactly the columns of the contract
revision it cites, in their order, so a surface value cannot travel in an observation table
(design §4, §5). That revision must be one this repository has recorded, and the row count
positive, as the project's own reader (``genomeos.surfaces.artifacts.read_observations``) requires.
An input published under an earlier revision is held to that revision's columns, not the current
one's, because a released artifact stays valid when its contract is revised.

What the gate checks is the record and the file's column set and types, read from its footer, not
its rows. A row the contract refuses (a latitude of 200, ``ac`` above ``an``, an unknown
``sampling_design``) is refused by the contract itself: by ``serialize_observations`` when the
artifact is published, and by ``read_observations`` when it is read.

Artifacts released before the rule cannot be repaired in place: a released artifact is immutable,
so it may not gain a file. Each one is named, with a reason, in the builder's reviewed
``RELEASED_WITHOUT_INPUT`` table, and that table may name only an artifact that an earlier release
holds and that no earlier release holds with its input. Nothing is exempt by default: a released
artifact that is missing from the table and has no input fails the build like a new one.

Pure and dependency-free, like ``data_release``: the builder must not load the surface stack to
build a manifest. The publisher's side of the contract is ``genomeos.surfaces.fit_input``, and a
test pins the two together.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from genomeos.publication.data_release import DataReleaseError

#: The input's name inside each artifact directory (``genomeos.surfaces.fit_input.OBSERVATIONS_FILE``).
INPUT_FILE = "observations.parquet"
#: The manifest key that records it.
RECORD_KEY = "observations"
#: The frozen contract each measurement's input obeys (``genomeos.surfaces.fit_input.INPUT_CONTRACTS``).
INPUT_CONTRACTS: Mapping[str, str] = MappingProxyType(
    {
        "allele_frequency": "contract/observations.schema.json",
        "carrier_frequency": "contract/carrier_observations.schema.json",
    }
)
#: Counts, not frequencies (design §7.1b): each measurement's numerator and denominator, by its own
#: names, because ``ac``/``an`` over chromosomes and over people must never share a column (#133).
COUNT_COLUMNS: Mapping[str, tuple[str, str]] = MappingProxyType(
    {"allele_frequency": ("ac", "an"), "carrier_frequency": ("carriers", "n_individuals")}
)
#: Every revision of each contract that an input may cite, as the sha256 of the frozen file. Revising
#: a contract is a reviewed event: append the new digest (a test fails until it is here) and never
#: remove an old one, because an artifact published under it stays valid.
CONTRACT_REVISIONS: Mapping[str, frozenset[str]] = MappingProxyType(
    {
        "contract/observations.schema.json": frozenset(
            {"94471dc24e099b7f173a588677d07a63f52006ec369d1a2f5acb26e07a2dbda4"}
        ),
        "contract/carrier_observations.schema.json": frozenset(
            {"3a20f70713abc063ff4a2d0bcd68c4cf21b56426cd2a5ee623c2bbdc8617e3a1"}
        ),
    }
)
#: Each revision's input columns, exactly and in order, keyed by its digest in ``CONTRACT_REVISIONS``.
#: Keyed by revision, not by measurement, because a revision may change the columns while an input
#: published under an earlier one stays valid: an input is checked against the revision it cites.
#: Add the new revision's columns with its digest, and never change an old entry. Tests require a
#: tuple for every recorded digest, and pin the current one to ``tuple(INPUT_CONTRACTS[m].schema
#: .columns)`` in ``genomeos.surfaces.fit_input``. Every revision so far is strict, so the reader
#: refuses any other column, such as a surface's ``post_mean``.
REVISION_COLUMNS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        # contract/observations.schema.json: alleles over chromosomes.
        "94471dc24e099b7f173a588677d07a63f52006ec369d1a2f5acb26e07a2dbda4": (
            "variant_id", "rsid", "population_id", "lat", "lon", "radius_km", "ac", "an",
            "source_record_id", "source", "assay", "date_lower", "date_upper", "sampling_design",
            "disease_ascertainment_excluded", "cohort_id", "ingest_version",
        ),
        # contract/carrier_observations.schema.json: carriers over individuals (#133).
        "3a20f70713abc063ff4a2d0bcd68c4cf21b56426cd2a5ee623c2bbdc8617e3a1": (
            "variant_id", "rsid", "population_id", "lat", "lon", "radius_km", "carriers", "n_individuals",
            "source_record_id", "source", "assay", "date_lower", "date_upper", "sampling_design",
            "disease_ascertainment_excluded", "cohort_id", "ingest_version",
        ),
    }
)
_INTEGER_TYPES = frozenset({"int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"})
_RECORD_FIELDS = frozenset(
    {"path", "sha256", "bytes", "row_count", "measurement", "schema", "schema_sha256", "columns"}
)
_SHA256 = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class InputFile:
    """What the builder measured from an artifact's ``observations.parquet``.

    ``types`` are the Arrow types of ``columns``, in the same order, as ``str(pyarrow.DataType)``.
    """

    sha256: str
    bytes: int
    rows: int
    columns: tuple[str, ...]
    types: tuple[str, ...]

    def __post_init__(self) -> None:
        if len(self.types) != len(self.columns):
            raise DataReleaseError(f"{INPUT_FILE}: {len(self.columns)} columns but {len(self.types)} types")


def check_artifact_inputs(
    manifests: Mapping[str, Mapping[str, Any]],
    inputs: Mapping[str, InputFile],
    *,
    released: Collection[str],
    released_with_input: Collection[str],
    released_without_input: Mapping[str, str],
) -> None:
    """Refuse a release in which any artifact lacks the input its fit consumed, or misdescribes it.

    ``manifests`` maps each artifact directory in the release to its parsed ``manifest.json``;
    ``inputs`` maps the directories that hold an ``observations.parquet`` to what was measured from
    it; ``released`` names every artifact directory an earlier release holds, and
    ``released_with_input`` those an earlier release holds together with their ``observations.parquet``.
    """
    for name, reason in sorted(released_without_input.items()):
        if not isinstance(reason, str) or not reason.strip():
            raise DataReleaseError(f"{name}: listed as released without its input, but with no reason")
        if name in released_with_input:
            raise DataReleaseError(
                f"{name}: listed as released without its input, but an earlier release holds its "
                f"{INPUT_FILE}. It was released with its input, so it may not be exempted, and no later "
                "release may drop that file (#45)"
            )
        if name not in released:
            raise DataReleaseError(
                f"{name}: listed as released without its input, but no earlier release holds it. Only an "
                f"artifact released before inputs travelled with outputs may be listed; a new artifact "
                f"must carry {INPUT_FILE} (#45)"
            )
    for name in sorted(manifests):
        if name in released_without_input:
            if name in inputs:
                raise DataReleaseError(
                    f"{name}: released without its input, and now holds {INPUT_FILE}. A released artifact "
                    "is immutable and cannot gain a file (design §5); publish the recovered input under a "
                    "new key instead"
                )
            continue
        if name not in inputs:
            raise DataReleaseError(
                f"{name}: no {INPUT_FILE}. Every new artifact carries the observation table its fit "
                "consumed (#45); an artifact released before that rule must be named, with a reason, in "
                "RELEASED_WITHOUT_INPUT"
            )
        _check_record(name, manifests[name], inputs[name])


def _check_record(name: str, manifest: Mapping[str, Any], measured: InputFile) -> None:
    record = manifest.get(RECORD_KEY)
    if not isinstance(record, Mapping):
        raise DataReleaseError(f"{name}: manifest.json records no {RECORD_KEY} for its {INPUT_FILE}")
    unknown, missing = sorted(set(record) - _RECORD_FIELDS), sorted(_RECORD_FIELDS - set(record))
    if unknown or missing:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} record has unknown fields {unknown}, missing fields {missing}"
        )
    if record["path"] != INPUT_FILE:
        raise DataReleaseError(f"{name}: {RECORD_KEY} path {record['path']!r} is not {INPUT_FILE!r}")
    measurement = record["measurement"]
    if not isinstance(measurement, str) or measurement not in INPUT_CONTRACTS:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} measurement {measurement!r} is not one of {list(INPUT_CONTRACTS)}"
        )
    if measurement != manifest.get("measurement"):
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} measurement {measurement!r} is not the artifact's "
            f"{manifest.get('measurement')!r}: a surface's counts are of one quantity (#133)"
        )
    contract = INPUT_CONTRACTS[measurement]
    if record["schema"] != contract:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} schema {record['schema']!r} is not {contract!r}, the {measurement} "
            "contract"
        )
    if not isinstance(record["schema_sha256"], str) or not _SHA256.fullmatch(record["schema_sha256"]):
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} schema_sha256 {record['schema_sha256']!r} is not a digest"
        )
    if record["schema_sha256"] not in CONTRACT_REVISIONS[contract]:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} schema_sha256 {record['schema_sha256']} is not a revision of {contract} "
            "that CONTRACT_REVISIONS records"
        )
    if not isinstance(record["sha256"], str) or not _SHA256.fullmatch(record["sha256"]):
        raise DataReleaseError(f"{name}: {RECORD_KEY} sha256 {record['sha256']!r} is not a digest")
    # 1234.0 == 1234, so equality alone would pass a float the reader refuses.
    if type(record["bytes"]) is not int:
        raise DataReleaseError(f"{name}: {RECORD_KEY} bytes {record['bytes']!r} is not an integer")
    if (record["sha256"], record["bytes"]) != (measured.sha256, measured.bytes):
        raise DataReleaseError(
            f"{name}: {INPUT_FILE} has sha256 {measured.sha256} ({measured.bytes} bytes), but its manifest "
            f"records sha256 {record['sha256']} ({record['bytes']} bytes)"
        )
    columns = record["columns"]
    if not isinstance(columns, list) or tuple(columns) != measured.columns:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} columns {columns!r} are not the file's {list(measured.columns)}"
        )
    _check_counts(name, measurement, measured)
    expected = REVISION_COLUMNS[record["schema_sha256"]]
    if tuple(columns) != expected:
        raise DataReleaseError(
            f"{name}: {INPUT_FILE} columns {columns!r} are not those of the {measurement} contract "
            f"revision it cites ({record['schema_sha256']}), {list(expected)}, in that order: an input "
            "carries nothing else, and never a surface value (design §4, §5)"
        )
    row_count, n_observations = record["row_count"], manifest.get("n_observations")
    if not (type(row_count) is int and row_count > 0):
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} row_count {row_count!r} is not a positive integer: an empty table "
            "fits nothing, and the reader refuses it"
        )
    if not row_count == measured.rows == n_observations:
        raise DataReleaseError(
            f"{name}: {RECORD_KEY} row_count {row_count!r}, file rows {measured.rows} and "
            f"n_observations {n_observations!r} must all agree"
        )


def _check_counts(name: str, measurement: str, measured: InputFile) -> None:
    """Counts, not frequencies (§7.1b), under the measurement's own names (#133)."""
    frequencies = [column for column in measured.columns if "freq" in column.lower()]
    if frequencies:
        raise DataReleaseError(
            f"{name}: {INPUT_FILE} carries {frequencies}; an input holds counts, never frequencies (§7.1b)"
        )
    counts = COUNT_COLUMNS[measurement]
    for other, other_counts in COUNT_COLUMNS.items():
        mixed = [column for column in other_counts if other != measurement and column in measured.columns]
        if mixed:
            raise DataReleaseError(
                f"{name}: a {measurement} {INPUT_FILE} carries {other}'s count columns {mixed}; its counts "
                f"are {list(counts)}, and the two never share a table (#133)"
            )
    absent = [column for column in counts if column not in measured.columns]
    if absent:
        raise DataReleaseError(
            f"{name}: {INPUT_FILE} must carry counts {list(counts)}, but lacks {absent} (design §7.1b)"
        )
    types = dict(zip(measured.columns, measured.types, strict=True))
    fractional = {column: types[column] for column in counts if types[column] not in _INTEGER_TYPES}
    if fractional:
        raise DataReleaseError(
            f"{name}: {INPUT_FILE} counts must have an integer type, not {fractional} (design §7.1b, §12)"
        )
