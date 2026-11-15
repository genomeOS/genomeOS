"""``measured.fit_inputs``: the measured records each artifact was fit to, as keys only.

Atlas data platform design 2026-10-18 §2.4, §2.7 check 3 and §2.8; builder's call 8; step 1.9.

The table is the only link between measured and inferred (§2.2 rule 3): one row per artifact and record,
keyed by ``(artifact, ingest_version, source_record_id)``, with the artifact's identity and
``measurement``, the curated ingest the record lies in (``source``, ``ingest_version``) and its
``evidence``. It holds no count and no coordinate. ``epoch``, the release that first wrote an artifact's
rows, partitions it and is stored, so check 2 compares each folder with its rows; a later release writes
rows only for artifacts no earlier epoch holds (call 6, ``new_rows``).

- ``fit-record``: the artifact holds its fit input, and each of its rows appears identically in its ingest
  (check 3, ``fit_record_rows``). No released artifact holds one yet; one needs ``cells_by_cell`` 1.1 first
  (F4).
- ``web-json-match`` (call 8): an artifact released before fit inputs whose observations JSON the website
  serves, pinned by sha256 in the web ``catalog.json`` (``parse_web_observations``), equals the published
  ingest of its data record for record (``match_web_json``). The record sets are exactly equal, each
  ``population_label`` resolves through the ingest registry's aliases to the record's ``population_id``,
  and every ``MATCHED_FIELDS`` value is compared with ``==`` on parsed values, never rounded. A KIR carrier
  JSON stores carriers as ``ac``/``an`` (``afnd_carriers.as_binomial``), so those compare with ``carriers``
  and ``n_individuals``.

``ingest_key_for`` routes an artifact to its part by its data_version (``INGEST_FOR_DATA_VERSION``,
reviewed), its variant id's family and its measurement (controller ruling p1-R16): ``hla:``, ``mic:`` and a
KIR allele (``kir:3dl1-007``) to the ``afnd_frequencies`` allele part, ``cyt:`` to the cytokine allele
part, and a KIR gene (``kir:2dl1``, its presence) to the carrier part. A carrier artifact routed or matched
to allele counts, or an allele artifact to carrier counts, fails (check 3).

A served JSON that differs is a ``WebJsonMismatch`` naming the artifact, the record and the field. It stops
the build and never turns the artifact ``none`` silently: only a reviewer's refusal does. An artifact with
no published ingest, or one refused, has no row here; ``inferred.fit_input_evidence`` gives it ``none`` with
that reason (``evidence_kwargs``). Pure: ``scripts/build_tables.py`` reads the files and writes the parts.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import PurePosixPath
from types import MappingProxyType
from typing import Any

import pandas as pd

from genomeos.observations.sources import afnd_frequencies
from genomeos.publication import artifact_inputs as ai
from genomeos.publication import data_release as dr
from genomeos.tables import contracts, inferred, measured
from genomeos.tables.contracts import TableError
from genomeos.tables.meta import artifact_directory_name

FIT_INPUTS_TABLE = contracts.FIT_INPUTS.table
COLUMNS = contracts.columns(FIT_INPUTS_TABLE)
#: The table key, and the order of a part's rows.
SORT_KEY = contracts.FIT_INPUTS.key
PART_FILE = "part-0.parquet"
#: The fields a served observation must equal in its record; a carrier part's ``ac`` and ``an`` are its
#: ``carriers`` and ``n_individuals``.
MATCHED_FIELDS = (
    "ac",
    "an",
    "lat",
    "lon",
    "radius_km",
    "sampling_design",
    "disease_ascertainment_excluded",
    "cohort_id",
    "assay",
    "ingest_version",
)
#: Reviewed: the ingest_version whose curated parts hold the records each served data_version was fit to
#: (§2.8). A data_version not listed has no published ingest, and its artifacts are ``none`` with that reason.
INGEST_FOR_DATA_VERSION: Mapping[str, str] = MappingProxyType({"afnd-2026-08": "afnd-2026-08"})
#: The ``measured.CURATED_INGESTS`` source each AFND family's allele counts lie in (p1-R16).
_ALLELE_SOURCES: Mapping[str, str] = MappingProxyType(
    {
        "hla": afnd_frequencies.SOURCE,
        "mic": afnd_frequencies.SOURCE,
        "kir": afnd_frequencies.SOURCE,
        "cyt": "afnd",
    }
)
#: The ``measured.CURATED_INGESTS`` source of KIR gene presence, carriers over individuals.
_CARRIER_SOURCE = "afnd"
#: A KIR gene-presence id names the gene alone (``afnd_carriers.variant_id``: ``kir:2dl1``); an allele id
#: adds its fields (``kir:3dl1-007``).
_KIR_GENE = re.compile(r"kir:[a-z0-9]+")
_ALLELE, _CARRIER = "allele_frequency", "carrier_frequency"
#: The served artifact fields this module reads.
_IDENTITY = ("variant_id", "model_version", "data_version", "measurement", "registry_version")
#: Each served observation's fields this module reads, with their JSON types.
_ROW_TYPES: Mapping[str, type] = MappingProxyType(
    {
        "source_record_id": str,
        "population_label": str,
        "ac": int,
        "an": int,
        "lat": float,
        "lon": float,
        "radius_km": float,
        "sampling_design": str,
        "disease_ascertainment_excluded": bool,
        "cohort_id": str,
        "assay": str,
        "ingest_version": str,
    }
)
_SCHEMA_VERSION = 1


class WebJsonMismatch(TableError):
    """A served observations JSON that is not its pinned bytes, or not its ingest's records."""


@dataclass(frozen=True)
class WebObservations:
    """One served observations JSON: its artifact's identity and its observations (``_ROW_TYPES``'
    fields, each as parsed)."""

    artifact: str
    variant_id: str
    model_version: str
    data_version: str
    measurement: str
    registry_version: str
    rows: pd.DataFrame


def fit_inputs_path(epoch: str) -> str:
    """``tables/v1/measured/fit_inputs/epoch=<epoch>/part-0.parquet``."""
    dr.assert_release_id(epoch)
    return f"{contracts.table_path(FIT_INPUTS_TABLE)}epoch={epoch}/{PART_FILE}"


def parse_web_observations(payload: bytes, *, expected_sha256: str) -> WebObservations:
    """A served observations JSON, refused unless its sha256 is ``expected_sha256`` (the web catalog's pin)
    and each observation holds ``_ROW_TYPES``' fields with their JSON types."""
    digest = hashlib.sha256(payload).hexdigest()
    if digest != expected_sha256:
        raise WebJsonMismatch(
            f"served observations JSON: sha256 {digest}, but the web catalog pins {expected_sha256}"
        )
    try:
        document = json.loads(payload)
    except ValueError as error:
        raise WebJsonMismatch(f"served observations JSON {digest}: not JSON: {error}") from error
    head = document.get("artifact") if isinstance(document, dict) else None
    if (
        not isinstance(head, dict)
        or document.get("schema_version") != _SCHEMA_VERSION
        or not isinstance(document.get("observations"), list)
    ):
        raise WebJsonMismatch(
            f"served observations JSON {digest}: not a schema_version {_SCHEMA_VERSION} artifact with its "
            "observations"
        )
    identity = [head.get(field) for field in _IDENTITY]
    if not all(isinstance(value, str) and value for value in identity):
        raise WebJsonMismatch(
            f"served observations JSON {digest}: its artifact lacks one of {list(_IDENTITY)}"
        )
    variant_id, model_version, data_version, measurement, registry_version = identity
    artifact = artifact_directory_name(variant_id, model_version, data_version)
    records = [_parsed(artifact, index, row) for index, row in enumerate(document["observations"])]
    rows = pd.DataFrame(records, columns=list(_ROW_TYPES), dtype=object)
    twice = rows["source_record_id"][rows["source_record_id"].duplicated()]
    if len(twice):
        raise WebJsonMismatch(f"{artifact}: record {twice.iloc[0]} is served twice")
    return WebObservations(
        artifact, variant_id, model_version, data_version, measurement, registry_version, rows
    )


def served_files(catalog: Mapping[str, Any]) -> tuple[tuple[str, str, Mapping[str, Any]], ...]:
    """``(observations_url, observations_sha256, entry)`` of each artifact the web catalog serves with its
    observations JSON; a url that is not a relative file, or that lacks its sha256, is refused."""
    entries = catalog.get("artifacts")
    if not isinstance(entries, list) or not all(isinstance(entry, Mapping) for entry in entries):
        raise TableError("the web catalog's artifacts must be a list of objects")
    found = []
    for entry in entries:
        url, sha256 = entry.get("observations_url"), entry.get("observations_sha256")
        if url is None and sha256 is None:
            continue
        parts = PurePosixPath(url).parts if isinstance(url, str) else ()
        if not parts or parts[0] == "/" or ".." in parts or not isinstance(sha256, str):
            raise TableError(
                f"web catalog: observations_url {url!r} with observations_sha256 {sha256!r} is not a "
                "relative file and its sha256"
            )
        found.append((url, sha256, entry))
    return tuple(found)


def served_as(web: WebObservations, entry: Mapping[str, Any], *, where: object) -> WebObservations:
    """``web``, refused unless it is the artifact the web catalog's ``entry`` serves."""
    for field in ("variant_id", "model_version", "data_version", "measurement"):
        if entry.get(field) != getattr(web, field):
            raise WebJsonMismatch(
                f"{where}: {field} {getattr(web, field)!r}, but the catalog serves it as {entry.get(field)!r}"
            )
    return web


def route(web: WebObservations, *, refused: Collection[str]) -> measured.CuratedIngest | None:
    """The curated ingest holding ``web``'s records, or ``None`` when a reviewer refused its JSON or its data
    has no published ingest. Its populations must resolve in that ingest's registry."""
    key = (
        None if web.artifact in refused else ingest_key_for(web.variant_id, web.measurement, web.data_version)
    )
    if key is None:
        return None
    found = [
        ingest
        for ingest in measured.CURATED_INGESTS
        if (ingest.table, ingest.source, ingest.ingest_version) == key
    ]
    if not found:
        raise TableError(f"{web.artifact}: {'/'.join(key)} is not one of measured.CURATED_INGESTS")
    if web.registry_version != found[0].registry_version:
        raise WebJsonMismatch(
            f"{web.artifact}: registry_version {web.registry_version}, but {'/'.join(key)} resolves its "
            f"populations in {found[0].registry_version}"
        )
    return found[0]


def ingest_key_for(variant_id: str, measurement: str, data_version: str) -> tuple[str, str, str] | None:
    """``(table, source, ingest_version)`` of the curated part holding an artifact's records, or ``None``
    when its data_version has no published ingest. A measurement its id cannot have fails (check 3)."""
    ingest_version = INGEST_FOR_DATA_VERSION.get(data_version)
    if ingest_version is None:
        return None
    where = f"{variant_id} ({data_version}, {measurement})"
    if measurement not in ai.COUNT_COLUMNS:
        raise TableError(f"{where}: a fit input counts one of {list(ai.COUNT_COLUMNS)}, not {measurement}")
    if _KIR_GENE.fullmatch(variant_id):
        if measurement != _CARRIER:
            raise TableError(
                f"check 3: {where}: a KIR gene's presence is a carrier count over individuals, never an "
                "allele frequency"
            )
        return (measured.CARRIER_TABLE, _CARRIER_SOURCE, ingest_version)
    family, colon, _ = variant_id.partition(":")
    if not colon or family not in _ALLELE_SOURCES:
        raise TableError(f"{where}: no reviewed ingest of {ingest_version} holds {variant_id}")
    if measurement != _ALLELE:
        raise TableError(
            f"check 3: {where}: an allele is counted over chromosomes, so a carrier artifact never "
            "matches the allele table"
        )
    return (measured.ALLELE_TABLE, _ALLELE_SOURCES[family], ingest_version)


def match_web_json(web: WebObservations, part: pd.DataFrame, *, aliases: pd.DataFrame) -> pd.DataFrame:
    """``web``'s ``measured.fit_inputs`` rows, but their ``epoch``, which the stage gives: once its
    observations equal ``part``'s records of its variant (§2.8, check 3). Any difference is a
    ``WebJsonMismatch`` naming the artifact, the record and the field."""
    columns = _count_columns(web.artifact, web.measurement, part, WebJsonMismatch)
    counts = dict(zip(("ac", "an"), columns, strict=True))
    where = _where(part)
    records = part[part["variant_id"] == web.variant_id]
    served, held = list(web.rows["source_record_id"]), list(records["source_record_id"])
    if sorted(served) != sorted(held):
        raise WebJsonMismatch(
            f"{web.artifact}: the served JSON holds {len(served)} records and {where} {len(held)} of "
            f"{web.variant_id} (count): {sorted(set(held) - set(served))[:3]} only in the part, "
            f"{sorted(set(served) - set(held))[:3]} only in the JSON"
        )
    labels = _labels(aliases)
    by_id = {row["source_record_id"]: row for row in records.to_dict(orient="records")}
    for row in web.rows.to_dict(orient="records"):
        name, record = f"{web.artifact}: record {row['source_record_id']}", by_id[row["source_record_id"]]
        label = row["population_label"]
        if labels.get(label) != record["population_id"]:
            raise WebJsonMismatch(
                f"{name}: population_label {label!r} resolves to {labels.get(label)} in the registry's "
                f"aliases, but the record's population_id is {record['population_id']}"
            )
        for field in MATCHED_FIELDS:
            column = counts.get(field, field)
            there = f"{where}'s {column}"
            _require_equal(
                name, field, row[field], record[column], ("the served JSON", there), WebJsonMismatch
            )
    return _key_rows(web.artifact, web.measurement, records, inferred.WEB_JSON_MATCH)


def fit_record_rows(
    artifact: str, observations: pd.DataFrame, *, measurement: str, part: pd.DataFrame, epoch: str
) -> pd.DataFrame:
    """Check 3: an artifact's ``fit-record`` rows of epoch ``epoch``, once each row of ``observations``, its
    fit input, appears identically in ``part``, its ingest (every column, exact). Any difference is a
    ``TableError`` naming the artifact, the record and the field."""
    dr.assert_release_id(epoch)
    _count_columns(artifact, measurement, part, TableError)
    where = _where(part)
    variants, names = sorted(set(observations["variant_id"])), artifact.rsplit("__", 2)
    if len(variants) != 1 or len(names) != 3 or artifact_directory_name(variants[0], *names[1:]) != artifact:
        raise TableError(f"check 3: {artifact}: its fit input holds variants {variants[:3]}, not its own")
    by_id = {row["source_record_id"]: row for row in part.to_dict(orient="records")}
    ids = list(observations["source_record_id"])
    missing = [record for record in ids if record not in by_id]
    if missing or len(set(ids)) != len(ids):
        raise TableError(
            f"check 3: {artifact}: its fit input holds {len(ids)} records, {len(missing)} of them in no "
            f"record of {where} and {len(ids) - len(set(ids))} repeated (count): {missing[:3]}"
        )
    for row in observations.to_dict(orient="records"):
        name, record = (
            f"check 3: {artifact}: record {row['source_record_id']}",
            by_id[row["source_record_id"]],
        )
        for field, value in row.items():
            if field not in record:
                raise TableError(f"{name}: {field} is not a column of {where}")
            _require_equal(name, field, value, record[field], ("its fit input", where), TableError)
    rows = _key_rows(artifact, measurement, observations, inferred.FIT_RECORD)
    return rows.assign(epoch=epoch)[list(COLUMNS)]


def new_rows(rows: pd.DataFrame, *, already: frozenset[str]) -> pd.DataFrame:
    """The rows of artifacts no earlier epoch holds (``already``): the only ones a new epoch writes."""
    return rows[~rows["artifact"].isin(already)].reset_index(drop=True)


def matched_artifacts(rows: pd.DataFrame) -> frozenset[str]:
    """The artifacts whose rows are ``web-json-match``."""
    return frozenset(rows.loc[rows["evidence"] == inferred.WEB_JSON_MATCH, "artifact"])


def evidence_kwargs(
    web: Sequence[WebObservations], rows: pd.DataFrame, *, refused: Mapping[str, str]
) -> dict[str, Any]:
    """What this stage decides of ``inferred.fit_input_evidence``: the matched artifacts (all of ``rows``'
    epochs), the refused ones with their reasons, and each served artifact whose data has no published
    ingest, with its data_version (controller ruling p1-R15 orders the reasons)."""
    return {
        "web_json_matches": matched_artifacts(rows),
        "web_json_refused": dict(refused),
        "no_published_ingest": {
            item.artifact: item.data_version
            for item in web
            if item.artifact not in refused
            and ingest_key_for(item.variant_id, item.measurement, item.data_version) is None
        },
    }


def evidence_lines(rows: pd.DataFrame, evidence: Mapping[str, tuple[str, str | None]]) -> tuple[str, str]:
    """``web-json-match: <k> artifacts (<n> <measurement>, …)`` over ``rows`` (every epoch's), and ``none:
    <n> artifacts, each with a reason`` over ``evidence`` (every artifact's ``fit_input_evidence``)."""
    matched = rows[rows["evidence"] == inferred.WEB_JSON_MATCH].drop_duplicates("artifact")
    counts = sorted(Counter(matched["measurement"]).items())
    detail = f" ({', '.join(f'{n} {name}' for name, n in counts)})" if counts else ""
    none = sum(value == inferred.NONE for value, _ in evidence.values())
    return (
        f"{inferred.WEB_JSON_MATCH}: {len(matched)} artifacts{detail}",
        f"{inferred.NONE}: {none} artifacts, each with a reason",
    )


def _parsed(artifact: str, index: int, row: object) -> dict[str, Any]:
    """One served observation's ``_ROW_TYPES`` fields, each of its JSON type (an integer is a number too)."""
    if not isinstance(row, dict):
        raise WebJsonMismatch(f"{artifact}: observation {index} is not an object")
    record = row.get("source_record_id", f"#{index}")
    found = {}
    for field, kind in _ROW_TYPES.items():
        value = row.get(field)
        if kind is float and type(value) is int:
            value = float(value)
        if type(value) is not kind:
            raise WebJsonMismatch(
                f"{artifact}: record {record}: {field} is {value!r}, not a JSON {kind.__name__}"
            )
        found[field] = value
    return found


def _count_columns(
    artifact: str, measurement: str, part: pd.DataFrame, error: type[TableError]
) -> tuple[str, str]:
    """``measurement``'s count columns, which ``part`` must hold (check 3: a carrier artifact matched to the
    allele table fails, and an allele artifact matched to the carrier table)."""
    counts = ai.COUNT_COLUMNS.get(measurement)
    if counts is None:
        raise error(f"{artifact}: measurement {measurement!r} is not one of {list(ai.COUNT_COLUMNS)}")
    held = [name for name, columns in ai.COUNT_COLUMNS.items() if set(columns) <= set(part.columns)]
    if held != [measurement]:
        raise error(
            f"check 3: {artifact}: a {measurement} artifact matched to a part of {held or 'no'} counts; "
            "carrier counts and allele counts never stand in for each other"
        )
    return counts


def _where(part: pd.DataFrame) -> str:
    sources, versions = sorted(set(part["source"])), sorted(set(part["ingest_version"]))
    return f"the {'/'.join(sources)} {'/'.join(versions)} part"


def _labels(aliases: pd.DataFrame) -> dict[str, str]:
    """Each alias label's population_id; a label naming two populations is refused."""
    pairs = aliases[["label", "population_id"]].drop_duplicates()
    twice = pairs["label"][pairs["label"].duplicated()]
    if len(twice):
        raise TableError(f"alias {twice.iloc[0]!r} names two populations")
    return dict(zip(pairs["label"], pairs["population_id"], strict=True))


def _require_equal(
    name: str, field: str, value: object, held: object, where: tuple[str, str], error: type[TableError]
) -> None:
    """``value`` equals ``held`` exactly, as the same type: ``25`` is not ``25.0``, nor ``1`` ``True``.
    ``where`` names where each came from."""
    value, held = _plain(value), _plain(held)
    if type(value) is not type(held) or value != held:
        raise error(f"{name}: {field} is {value!r} in {where[0]} and {held!r} in {where[1]}")


def _plain(value: object) -> object:
    """A Python scalar for a NumPy or pandas one, and ``None`` for a missing value."""
    if value is None or (not isinstance(value, str) and bool(pd.isna(value))):
        return None
    item = getattr(value, "item", None)
    return item() if callable(item) else value


def _key_rows(artifact: str, measurement: str, records: pd.DataFrame, evidence: str) -> pd.DataFrame:
    """The key rows of ``records``, an artifact's measured records, without ``epoch``."""
    _, model_version, data_version = artifact.rsplit("__", 2)
    columns = [name for name in COLUMNS if name != "epoch"]
    return pd.DataFrame(
        {
            "artifact": artifact,
            "variant_id": list(records["variant_id"]),
            "model_version": model_version,
            "data_version": data_version,
            "measurement": measurement,
            "source": list(records["source"]),
            "ingest_version": list(records["ingest_version"]),
            "source_record_id": list(records["source_record_id"]),
            "evidence": evidence,
        },
        columns=columns,
    )
