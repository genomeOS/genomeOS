"""Checks 1, 2, 6, 9 and 10 over a release's ``tables/`` files, as the release builder keys them.

Atlas data platform design 2026-10-18 §2.2 rule 3, §2.3, §2.7 checks 1, 2, 6, 9 and 10, and §2.8;
builder's calls 16 and 17. ``build_tables.py`` runs checks 1, 2, 6 and 10 on what it writes; the release
builder runs all five again on every file it is about to publish, earlier releases' parts included, since
a release is whatever the local tree holds. Every error is a ``TableError`` that reads
``check <n>: <file>: …``, or ``check <n>: <artifact>: …`` for checks 6 and 10.

- Check 2, the layout: every file lies under ``tables/v1/`` and one of ``SCHEMAS``, and no bytes are
  both measured and inferred (one sha256 under both ``measured/`` and ``inferred/``).
- Check 9, provenance: each file records its inputs and sources; every input key is this release's or a
  committed release's, with the sha256 it was published with; a ``git:`` input is a reviewed one (its
  sha256 at the stamped commit is checked when ``build_tables.py`` reads it); and the recorded sources are
  the union of the inputs' (call 16).
- Check 10: ``inferred.artifacts`` has one row per artifact the release holds, each with a
  ``fit_input_evidence`` (never null) and a reason exactly when it is ``none`` (§2.8).
- Check 1: each file obeys its contract, and that contract is the frozen file this repository commits.
- Check 2, the partitions: each ``key=value`` folder equals the file's own values.
- Check 6: ``cells_by_cell``, every epoch's parts read together, equals each artifact's ``cells.parquet``,
  so an artifact whose cells sit in two epochs fails on its count.

Files are checked for where they lie, what they record and (``inferred.artifacts``) their evidence before
their contract, so a failure names its most specific rule.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pyarrow
import pyarrow.parquet as pq

from genomeos.publication import artifact_inputs as ai
from genomeos.publication import data_release as dr
from genomeos.tables import contracts, inferred, meta, provenance, writer
from genomeos.tables.contracts import TableError

#: The five schemas of ``tables/v1/`` (§2.3); measured and inferred never share a file.
SCHEMAS = ("measured", "inferred", "reference", "evidence", "meta")
TABLES_ROOT = "tables/v1/"
_INPUTS_KEY = "genomeos.inputs"


def check_release_tables(
    data_root: Path,
    objects: Sequence[dr.ReleaseObject],
    *,
    manifests: Sequence[Mapping[str, Any]],
    repo_root: Path,
    new_sources: Mapping[str, tuple[str, ...]],
) -> None:
    """Checks 1, 2, 6, 9 and 10 over ``objects``' ``tables/`` files, read from ``data_root``.

    ``manifests`` are the committed earlier releases, ``repo_root`` holds the frozen contracts, and
    ``new_sources`` maps each path this release keys to its sources.
    """
    tables = [item for item in objects if item.path.startswith(dr.TABLES_PREFIX)]
    _check_layout(tables)
    by_key = {item.key: item for item in objects}
    by_release = {manifest["release"]: manifest for manifest in manifests}
    for item in tables:
        _check_provenance(data_root, item, by_key=by_key, by_release=by_release, new_sources=new_sources)
    _check_evidence(data_root, objects)
    con = writer.connect()
    frozen: dict[str, str | None] = {}
    for item in tables:
        local = data_root / item.path
        with _labelled(1, item.path, item.path, str(local)):
            table = contracts.table_of(item.path)
            writer.check_table_file(local, table)
            _check_frozen(table, repo_root, frozen)
    for item in tables:
        if "=" in item.path:
            with _labelled(2, item.path, item.path):
                writer.check_partitions(con, data_root / item.path, item.path)
    parts = [data_root / item.path for item in tables if item.path.startswith(f"{inferred.EPOCH_ROOT}/")]
    inferred.check_cells_equal(con, _artifact_records(data_root, objects), parts)


def _check_layout(tables: Sequence[dr.ReleaseObject]) -> None:
    """Check 2's layout: the five schemas, and no file both measured and inferred."""
    seen: dict[tuple[str, str], str] = {}
    for item in tables:
        parts = item.path.split("/")
        if not item.path.startswith(TABLES_ROOT) or len(parts) < 4 or parts[2] not in SCHEMAS:
            raise TableError(
                f"check 2: {item.path}: a tables/ file lies under {TABLES_ROOT} and one of "
                f"{', '.join(SCHEMAS)} (§2.3)"
            )
        if parts[2] in ("measured", "inferred"):
            seen.setdefault((parts[2], item.sha256), item.path)
    for (schema, sha256), path in sorted(seen.items()):
        other = seen.get(("inferred", sha256)) if schema == "measured" else None
        if other is not None:
            raise TableError(
                f"check 2: {path}: its bytes (sha256 {sha256}) are also {other}, so they are both measured "
                "and inferred; measured and inferred never share a file (§2.2 rule 3)"
            )


def _check_provenance(
    data_root: Path,
    item: dr.ReleaseObject,
    *,
    by_key: Mapping[str, dr.ReleaseObject],
    by_release: Mapping[str, Mapping[str, Any]],
    new_sources: Mapping[str, tuple[str, ...]],
) -> None:
    """Check 9: the file's inputs are keys this or a committed release published, and its sources theirs."""
    local = data_root / item.path
    with _labelled(9, item.path, item.path, str(local)):
        kv = provenance.read_kv(local)
        for name in (_INPUTS_KEY, provenance.SOURCES_KEY):
            if name not in kv:
                raise TableError(
                    f"records no {name}; every tables/ file records its inputs and their sources (§2.1, "
                    "call 16), so write it through genomeos.tables.writer"
                )
        refs = provenance.decode_inputs(kv[_INPUTS_KEY])
        for ref in refs:
            if not ref.key.startswith(dr.RELEASE_PREFIX):
                continue
            listed = by_key.get(ref.key)
            if listed is not None and listed.sha256 != ref.sha256:
                raise TableError(
                    f"input {ref.key}: sha256 {ref.sha256}, but this release lists {listed.sha256}"
                )
            if listed is None and ref.key.split("/", 2)[1] not in by_release:
                raise TableError(
                    f"input {ref.key} is a key of neither this release nor a committed one (§2.7 check 9)"
                )
        expected = provenance.union_sources(refs, manifests=by_release, new_sources=new_sources)
        recorded = provenance.parse_sources(kv[provenance.SOURCES_KEY], where=item.path)
        if recorded != expected:
            raise TableError(
                f"records sources {list(recorded)}, but its inputs carry {list(expected)} (call 16)"
            )


def _check_evidence(data_root: Path, objects: Sequence[dr.ReleaseObject]) -> None:
    """Check 10: one ``inferred.artifacts`` row per artifact of the release, each with its evidence."""
    path = contracts.table_path(inferred.ARTIFACTS_TABLE)
    artifacts = {
        dr.artifact_directory(item.path) for item in objects if item.path.startswith(dr.ARTIFACT_PREFIX)
    }
    if not any(item.path == path for item in objects):
        if artifacts:
            raise TableError(f"check 10: {path}: the release holds {len(artifacts)} artifacts and no {path}")
        return
    columns = ["artifact", "fit_input_evidence", "fit_input_evidence_reason"]
    try:
        rows = pq.read_table(data_root / path, columns=columns).to_pylist()
    except pyarrow.ArrowException as error:
        raise TableError(f"check 10: {path}: its {columns} cannot be read: {error}") from error
    evidence = {
        row["artifact"]: (row["fit_input_evidence"], row["fit_input_evidence_reason"]) for row in rows
    }
    if set(evidence) != artifacts or len(rows) != len(evidence):
        raise TableError(
            f"check 10: {path}: its rows are not one per artifact of the release: "
            f"{sorted(artifacts - set(evidence))[:3]} have none, {sorted(set(evidence) - artifacts)[:3]} "
            f"are not in the release, {len(rows) - len(evidence)} repeat"
        )
    for artifact in sorted(evidence):
        inferred.checked_evidence(artifact, evidence)


def _check_frozen(table: str, repo_root: Path, frozen: dict[str, str | None]) -> None:
    """Check 1: ``table``'s contract is the frozen file ``repo_root`` commits, byte for byte."""
    contract = contracts.TABLE_CONTRACTS[table]
    if table not in frozen:
        path = repo_root / contract.path
        frozen[table] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    if frozen[table] != contracts.contract_sha256(table):
        raise TableError(
            f"the {table} contract it was checked against is not the frozen {contract.path}; "
            "freeze it in a reviewed commit: python scripts/freeze_contract.py"
        )


def _artifact_records(data_root: Path, objects: Sequence[dr.ReleaseObject]) -> list[inferred.ArtifactRecord]:
    """Every artifact the release holds, read from its local copies, for check 6."""
    files: dict[str, dict[str, dr.ReleaseObject]] = {}
    for item in objects:
        if item.path.startswith(dr.ARTIFACT_PREFIX):
            files.setdefault(dr.artifact_directory(item.path), {})[item.path.rsplit("/", 1)[1]] = item
    records = []
    for artifact, held in sorted(files.items()):
        cells, manifest = held.get(inferred.CELLS_FILE), held.get(meta.MANIFEST_FILE)
        if cells is None or manifest is None:
            raise TableError(
                f"check 6: {artifact}: the release lists no {inferred.CELLS_FILE} and "
                f"{meta.MANIFEST_FILE} for it"
            )
        observations = held.get(ai.INPUT_FILE)
        records.append(
            inferred.ArtifactRecord(
                artifact=artifact,
                manifest=json.loads((data_root / manifest.path).read_text(encoding="utf-8")),
                cells_path=data_root / cells.path,
                cells_key=cells.key,
                cells_sha256=cells.sha256,
                manifest_key=manifest.key,
                manifest_sha256=manifest.sha256,
                observations_key=observations.key if observations else None,
                observations_sha256=observations.sha256 if observations else None,
                first_release=manifest.key.split("/", 2)[1],
                sources=tuple(sorted({*cells.sources, *manifest.sources})),
            )
        )
    return records


@contextmanager
def _labelled(check: int, path: str, *named: str) -> Iterator[None]:
    """Re-raise a ``TableError`` as ``check <n>: <path>: …``, dropping a path the callee already named."""
    try:
        yield
    except TableError as error:
        message = str(error)
        for prefix in named:
            message = message.removeprefix(f"{prefix}: ")
        raise TableError(f"check {check}: {path}: {message}") from error
