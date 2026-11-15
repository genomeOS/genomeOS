"""The ``meta.*`` tables: what each release published, its sources, what is served and what is withdrawn.

Atlas data platform design 2026-10-18 §2.4, §2.9 and §9; builder's calls 4, 7 and 16. Pure: frames from
mappings the caller has read, no I/O.

- ``meta.release_objects`` and ``meta.sources`` restate each earlier release's committed manifest, one
  row per object and per source. A reused object keeps its first key; a terms status reads in the
  closed vocabulary, so the legacy ``restriction_found`` reads as ``restricted`` (§9).
- ``meta.served`` lists the artifacts the website serves. Until the refit pin lands that is the web
  ``catalog.json`` (call 7), so each row is pinned by it, with the sha256 of the artifact's released
  ``manifest.json``. An artifact served but never released is a hard error.
- ``meta.withdrawn`` restates ``data/releases/WITHDRAWN.json`` with each key's path; a withdrawal of
  anything but a published object is a hard error.

A file's sources are its inputs' (call 16): the manifests for the first two, which therefore carry
every source; the web catalog plus each served artifact's ``manifest.json`` for ``meta.served``; and the
withdrawn list plus the keys it names for ``meta.withdrawn``.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

import pandas as pd

from genomeos.publication import data_release as dr
from genomeos.tables import contracts
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import GIT_PREFIX, InputRef

#: The served list (call 7) and the withdrawn list, as repository paths: both are ``git:`` inputs.
WEB_CATALOG = "website/public/data/atlas/catalog.json"
WITHDRAWN_LIST = f"data/releases/{dr.WITHDRAWN_FILE}"
MANIFEST_FILE = "manifest.json"
_IDENTITY = ("variant_id", "model_version", "data_version")


def release_objects_frame(manifests: Sequence[Mapping[str, Any]]) -> pd.DataFrame:
    """One row per object of each manifest."""
    rows = [
        {
            "release": manifest["release"],
            "path": item.path,
            "key": item.key,
            "bytes": item.bytes,
            "sha256": item.sha256,
            "media_type": item.media_type,
            "in_git": item.in_git,
            "sources": list(item.sources),
        }
        for manifest in _ordered(manifests)
        for item in dr.validate_manifest(manifest)
    ]
    return _frame("meta.release_objects", rows)


def sources_frame(manifests: Sequence[Mapping[str, Any]]) -> pd.DataFrame:
    """One row per source of each manifest, its terms flattened."""
    rows = []
    for manifest in _ordered(manifests):
        dr.validate_manifest(manifest)
        for source, record in sorted(manifest["sources"].items()):
            terms = record["terms"]
            rows.append(
                {
                    "release": manifest["release"],
                    "source": source,
                    "name": record["name"],
                    "citation": record.get("citation"),
                    "url": record.get("url"),
                    "terms_status": dr.terms_status(terms["status"], where=f"source {source}"),
                    "terms_checked_at": terms.get("checked_at"),
                    "terms_url": terms.get("terms_url"),
                    "licence": terms.get("licence"),
                    "recorded_in": terms.get("recorded_in"),
                    "note": terms.get("note"),
                    "non_commercial": record["non_commercial"],
                }
            )
    return _frame("meta.sources", rows)


def released_artifacts(published: Mapping[str, dr.ReleaseObject]) -> dict[str, str]:
    """Each released artifact directory, with the sha256 of its ``manifest.json``."""
    return {
        dr.artifact_directory(path): item.sha256
        for path, item in published.items()
        if path.startswith(dr.ARTIFACT_PREFIX) and path.endswith(f"/{MANIFEST_FILE}")
    }


def served_frame(web_catalog: Mapping[str, Any], *, released_artifacts: Mapping[str, str]) -> pd.DataFrame:
    """The served artifacts, each pinned by the web catalog to its released ``manifest.json``."""
    rows = []
    for artifact, variant_id, model_version, data_version in _served(web_catalog):
        if artifact not in released_artifacts:
            raise TableError(f"{WEB_CATALOG} serves {artifact}, which no committed release holds")
        rows.append(
            {
                "artifact": artifact,
                "variant_id": variant_id,
                "model_version": model_version,
                "data_version": data_version,
                "pinned_by": f"{GIT_PREFIX}{WEB_CATALOG}",
                "pinned_sha256": released_artifacts[artifact],
            }
        )
    return _frame("meta.served", rows)


def served_inputs(
    web_catalog: Mapping[str, Any], catalog_sha256: str, *, published: Mapping[str, dr.ReleaseObject]
) -> tuple[InputRef, ...]:
    """``meta.served``'s inputs: the web catalog and each served artifact's released ``manifest.json``."""
    refs = [InputRef(f"{GIT_PREFIX}{WEB_CATALOG}", catalog_sha256)]
    for artifact, *_ in _served(web_catalog):
        item = published.get(f"{dr.ARTIFACT_PREFIX}{artifact}/{MANIFEST_FILE}")
        if item is None:
            raise TableError(f"{WEB_CATALOG} serves {artifact}, which no committed release holds")
        refs.append(InputRef(item.key, item.sha256))
    return tuple(sorted(refs))


def withdrawn_frame(
    entries: Sequence[dr.Withdrawal], *, published: Mapping[str, dr.ReleaseObject]
) -> pd.DataFrame:
    """The withdrawn keys with their paths; each must be a published object with its recorded sha256."""
    rows = []
    for entry in entries:
        path = entry.key.split("/", 2)[-1]  # releases/<release>/<path>, as validate_withdrawn requires
        item = published.get(path)
        if item is None or (item.key, item.sha256) != (entry.key, entry.sha256):
            raise TableError(
                f"{WITHDRAWN_LIST}: {entry.key} with sha256 {entry.sha256} is not a published object"
            )
        rows.append(
            {
                "key": entry.key,
                "path": path,
                "sha256": entry.sha256,
                "reason": entry.reason,
                "issue": entry.issue,
                "date": entry.date,
                "decided_by": entry.decided_by,
            }
        )
    return _frame("meta.withdrawn", rows)


def artifact_directory_name(variant_id: str, model_version: str, data_version: str) -> str:
    """``<variant>__<model>__<data>``, the variant id's ``:`` written as ``__`` (§2.3)."""
    name = f"{variant_id.replace(':', '__')}__{model_version}__{data_version}"
    try:
        valid = "/" not in name and dr.assert_data_path(name) == name
    except dr.DataReleaseError:
        valid = False
    if not valid:
        raise TableError(f"{name!r} is not a valid artifact directory name (one path segment)")
    return name


def _served(web_catalog: Mapping[str, Any]) -> list[tuple[str, str, str, str]]:
    """``(artifact, variant_id, model_version, data_version)`` of each served artifact, in catalog order."""
    artifacts = web_catalog.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise TableError(f"{WEB_CATALOG}: artifacts must be a non-empty list")
    found: list[tuple[str, str, str, str]] = []
    for item in artifacts:
        fields = [item.get(name) if isinstance(item, Mapping) else None for name in _IDENTITY]
        if not all(isinstance(value, str) and value for value in fields):
            raise TableError(f"{WEB_CATALOG}: an artifact lacks one of {list(_IDENTITY)}: {fields}")
        variant_id, model_version, data_version = fields
        found.append(
            (
                artifact_directory_name(variant_id, model_version, data_version),
                variant_id,
                model_version,
                data_version,
            )
        )
    twice = sorted(name for name, n in Counter(row[0] for row in found).items() if n > 1)
    if twice:
        raise TableError(f"{WEB_CATALOG} serves {twice} twice")
    return found


def _ordered(manifests: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(manifests, key=lambda manifest: dr.release_sort_key(manifest.get("release")))


def _frame(table: str, rows: list[dict[str, Any]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=list(contracts.columns(table)))
