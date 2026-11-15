"""Release manifests for the public genomeOS data store (data store design 2026-10-17 §3–§5).

One pure module fixes the manifest schema, the object keys, the media types and the public URL rule,
so the four tools that touch the store cannot disagree: ``scripts/build_data_release.py`` (writes a
manifest), ``scripts/fetch_data.py`` (reads and verifies), ``scripts/publish_data_store.py`` (uploads)
and ``scripts/provision_data_store_bucket.py`` (only the bucket). No I/O and no network.

A release lists every published file under ``data/`` with its bytes and sha256, plus the source and
terms references the repository already records. Terms are carried, never adjudicated: ``status`` is
copied from the record named in ``recorded_in``, and a source the repository holds no check for is
``not_checked`` (AGENTS "Publication-evidence safeguards"). The status is one of the five
``COMMERCIAL_USE_FINDINGS`` and nothing else; a new manifest writes the legacy ``restriction_found`` of
earlier records and releases as ``restricted`` (Atlas data platform design 2026-10-18 §9, step 1.3).

Keys are immutable and release-versioned, ``releases/<release>/<path>``; a later release reuses an
earlier key for byte-identical content, and a published artifact whose bytes changed is refused (AGENTS
"Artifacts are immutable"; design §5). So is a file added to an artifact directory an earlier release
published: a cited artifact is a closed set of files, and so is the model exported beside it under
``store/models/`` (``closed_directory``; Atlas data platform design 2026-10-18 §2.2 rule 1, step 1.12).
So is a changed ``tables/`` part under a ``PARTITION_KEYS`` folder, or in a population registry's folder
(``is_write_once``): a takedown or a rebuild writes a new epoch, ingest version or registry release
instead (Atlas data platform design 2026-10-18 §2.3, §2.9; builder's calls 5 and 6). A changed summary
table such as ``tables/v1/inferred/artifacts.parquet`` gets this release's key, by design. Pickles are
never published: loading one from the internet executes code (data store design §8). Every violation is
a hard error (design §12).

``WITHDRAWN.json`` sits beside the manifests in ``data/releases/``: the keys withdrawn from serving,
for the owner to delete (Atlas data platform design 2026-10-18 §2.9). It is not a release, so every
reader lists that directory through ``release_ids``, which skips it and refuses any other stray name.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any
from urllib.parse import urlsplit

from genomeos.publication.commercial_use import COMMERCIAL_USE_FINDINGS

SCHEMA = "genomeos-data-release"
SCHEMA_VERSION = 1
LOCAL_ROOT = "data"
RELEASE_PREFIX = "releases/"
MANIFEST_PREFIX = "manifests/"
# One hour, not a year: keys never change meaning, but a takedown must reach readers quickly, and
# no cache can be told to forget a copy (owner decision 2026-10-17, #473).
CACHE_CONTROL = "public, max-age=3600"
NOT_CHECKED = "not_checked"
ARTIFACT_PREFIX = "store/artifacts/"
#: Where a trained model is published, beside its artifact (Atlas data platform design 2026-10-18 §2.1).
MODEL_PREFIX = "store/models/"
#: Each directory under these is a closed set of files once released: an artifact, and its model.
_CLOSED_PREFIXES = (ARTIFACT_PREFIX, MODEL_PREFIX)
BASE_URL_VARIABLE = "GENOMEOS_DATA_BASE_URL"
BUCKET_VARIABLE = "GENOMEOS_DATA_BUCKET"
#: The public, read-only data store. Committed by owner decision (2026-10-17): a public bucket's URL and
#: name may be committed, project ids, accounts and credentials may not (docs/repo-gcloud-auth.md).
#: These committed values are the truth: a variable or flag that names anything else is refused.
DATA_STORE_BUCKET = "genomeos-atlas-data"
DATA_STORE_BASE_URL = "https://storage.googleapis.com/genomeos-atlas-data/"
WITHDRAWN_FILE = "WITHDRAWN.json"
WITHDRAWN_SCHEMA = "genomeos-withdrawn"
WITHDRAWN_SCHEMA_VERSION = 1
TABLES_PREFIX = "tables/"
#: The ``tables/`` partition folders whose parts are written once (Atlas data platform design 2026-10-18
#: §2.4; builder's call 6): a released part never changes bytes.
PARTITION_KEYS = ("epoch", "ingest_version", "chrom", "bin")
#: Where each population registry release has its folder, also written once (Atlas data platform design
#: 2026-10-18 §2.3; builder's calls 5 and 6): a registry release never changes its rows.
REGISTRY_PREFIX = "tables/v1/reference/populations/"

#: Closed: an extension missing here is refused rather than served under a guessed type.
MEDIA_TYPES: Mapping[str, str] = {
    ".csv": "text/csv",
    ".duckdb": "application/octet-stream",
    ".json": "application/json",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".npy": "application/octet-stream",
    ".parquet": "application/vnd.apache.parquet",
    ".sql": "application/sql",
    ".tif": "image/tiff",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
}
#: Never published, whatever the caller asks: unpickling a downloaded file runs its code.
PICKLE_SUFFIXES = (".pkl", ".pickle", ".joblib")
#: Statuses written before the vocabulary was closed, and the finding each reads as. The released
#: manifests and the curated SOURCE.json keep ``restriction_found``; a new manifest writes ``restricted``
#: (Atlas data platform design 2026-10-18 §9). Never add an entry to make a new spelling pass.
LEGACY_TERMS_STATUSES: Mapping[str, str] = {"restriction_found": "restricted"}

_MANIFEST_FIELDS = frozenset(
    {"schema", "schema_version", "release", "local_root", "objects", "sources", "totals"}
)
_OBJECT_FIELDS = frozenset({"path", "key", "bytes", "sha256", "media_type", "in_git", "sources"})
_SOURCE_FIELDS = frozenset({"name", "citation", "url", "terms", "non_commercial"})
_SOURCE_REQUIRED = frozenset({"name", "terms", "non_commercial"})
_TERMS_FIELDS = frozenset({"status", "checked_at", "terms_url", "licence", "recorded_in", "note"})
_TOTALS_FIELDS = ("objects", "bytes", "in_git_objects", "in_git_bytes")
_WITHDRAWN_FIELDS = frozenset({"schema", "schema_version", "withdrawn"})
_WITHDRAWAL_FIELDS = frozenset({"key", "sha256", "reason", "issue", "date", "decided_by"})
_RELEASE = re.compile(r"(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?")
#: A path segment. ``=`` names a hive partition folder (``chrom=chr11``) but never leads one; ``%``,
#: ``+`` and ``:`` stay refused (Atlas data platform design 2026-10-18 §13 call 5): ``%`` and ``+``
#: change meaning when a URL is decoded, and ``:`` is not a portable file-name character.
_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._=-]*")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_SOURCE_ID = re.compile(r"[a-z][a-z0-9_-]*")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_BUCKET = re.compile(r"[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]")


class DataReleaseError(ValueError):
    """A manifest, path, key or URL that would publish or serve the wrong bytes. Always fatal."""


@dataclass(frozen=True)
class FileRecord:
    """One local file the builder hashed: what a release is built from."""

    path: str
    bytes: int
    sha256: str
    in_git: bool
    sources: tuple[str, ...]


@dataclass(frozen=True)
class ReleaseObject:
    """One validated manifest object: what is uploaded, fetched and verified."""

    path: str
    key: str
    bytes: int
    sha256: str
    media_type: str
    in_git: bool
    sources: tuple[str, ...]


@dataclass(frozen=True)
class Withdrawal:
    """One published key withdrawn from serving, with who decided it, when and why (platform §2.9)."""

    key: str
    sha256: str
    reason: str
    issue: str
    date: str
    decided_by: str


def assert_release_id(value: object) -> str:
    """``YYYY-MM-DD`` with an optional ``.N`` (N ≥ 1) for a second release on one day."""
    if not isinstance(value, str) or not _RELEASE.fullmatch(value):
        raise DataReleaseError(f"invalid release id {value!r}: expected YYYY-MM-DD or YYYY-MM-DD.N")
    return value


def release_sort_key(release: str) -> tuple[str, int]:
    match = _RELEASE.fullmatch(assert_release_id(release))
    assert match is not None
    return match.group(1), int(match.group(2) or 0)


def release_ids(file_names: Iterable[str]) -> list[str]:
    """The releases among the file names of ``data/releases/``, oldest first.

    ``WITHDRAWN.json`` is skipped; any other name that is not ``<release>.json`` is refused.
    """
    found: list[str] = []
    for name in file_names:
        if name == WITHDRAWN_FILE:
            continue
        stem = name.removesuffix(".json")
        if stem == name or not _RELEASE.fullmatch(stem):
            raise DataReleaseError(
                f"{name!r} in releases/ is neither a release manifest (YYYY-MM-DD[.N].json) "
                f"nor {WITHDRAWN_FILE}"
            )
        found.append(stem)
    return sorted(found, key=release_sort_key)


def assert_data_path(value: object) -> str:
    """A path relative to ``data/``: no ``..``, no leading ``/`` or ``.``, no backslash, no empty segment."""
    parts = value.split("/") if isinstance(value, str) and value else [""]
    if not all(_SEGMENT.fullmatch(part) for part in parts):
        raise DataReleaseError(
            f"invalid data path {value!r}: expected '/'-separated segments matching "
            "^[A-Za-z0-9][A-Za-z0-9._=-]*$ (relative, no '..', no hidden files)"
        )
    return value


def closed_directory(path: str) -> tuple[str, str] | None:
    """``(prefix, directory)`` for a file in a directory under ``ARTIFACT_PREFIX`` or ``MODEL_PREFIX``,
    which a release publishes as a closed set of files; ``None`` for a path under neither prefix.

    A file directly under one of the prefixes names no directory and is refused.
    """
    prefix = next((prefix for prefix in _CLOSED_PREFIXES if path.startswith(prefix)), None)
    if prefix is None:
        return None
    directory, _, name = path[len(prefix) :].partition("/")
    if not directory or not name:
        raise DataReleaseError(f"{path}: not a file inside a directory under {prefix}")
    return prefix, directory


def artifact_directory(path: str) -> str:
    """The artifact directory a ``store/artifacts/<directory>/<file>`` path lies in."""
    found = closed_directory(path) if path.startswith(ARTIFACT_PREFIX) else None
    if found is None:
        raise DataReleaseError(f"{path}: not a file inside an artifact directory under {ARTIFACT_PREFIX}")
    return found[1]


def is_write_once(path: str) -> bool:
    """A ``tables/`` part inside a ``<key>=`` folder of ``PARTITION_KEYS``, or a registry folder's file
    under ``REGISTRY_PREFIX`` (builder's calls 5 and 6)."""
    if not path.startswith(TABLES_PREFIX):
        return False
    if path.startswith(REGISTRY_PREFIX):
        return True
    folders = path.split("/")[:-1]
    return any(folder.partition("=")[0] in PARTITION_KEYS for folder in folders if "=" in folder)


def media_type_for(path: str) -> str:
    if path.lower().endswith(PICKLE_SUFFIXES):
        raise DataReleaseError(
            f"{path}: a pickle is never published; loading one from the internet executes code "
            "(data store design §8)"
        )
    name = path.rsplit("/", 1)[-1]
    suffix = name[name.rfind(".") :] if "." in name else ""
    if suffix not in MEDIA_TYPES:
        raise DataReleaseError(f"{path}: no media type for {suffix!r}; add it to MEDIA_TYPES deliberately")
    return MEDIA_TYPES[suffix]


def release_key(release: str, path: str) -> str:
    return f"{RELEASE_PREFIX}{assert_release_id(release)}/{assert_data_path(path)}"


def manifest_key(release: str) -> str:
    return f"{MANIFEST_PREFIX}{assert_release_id(release)}.json"


def assert_base_url(base: object) -> str:
    """An absolute https URL (http only on localhost/127.0.0.1) ending in '/', with no query."""
    parts = urlsplit(base) if isinstance(base, str) else None
    local = parts is not None and parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1"}
    if (
        parts is None
        or (parts.scheme != "https" and not local)
        or not parts.netloc
        or parts.query
        or parts.fragment
        or not str(base).endswith("/")
    ):
        raise DataReleaseError(
            f"{BASE_URL_VARIABLE} must be an absolute https:// URL ending in '/', for example "
            f"https://storage.googleapis.com/<bucket>/ (got {base!r})"
        )
    return str(base)


def public_url(base: str, key: str) -> str:
    return assert_base_url(base) + key


def resolve_base_url(value: str | None) -> str:
    """The committed data-store URL, unless ``value`` is it or a loopback mirror (tests, local serving).

    A variable that names any other host or bucket is refused rather than followed: the committed
    value is the truth, so a stale or hostile ``GENOMEOS_DATA_BASE_URL`` cannot redirect a reader.
    """
    if not value or value == DATA_STORE_BASE_URL:
        return DATA_STORE_BASE_URL
    base = assert_base_url(value)
    if urlsplit(base).scheme == "http":  # assert_base_url admits http only on loopback
        return base
    raise DataReleaseError(
        f"{BASE_URL_VARIABLE}={value!r} differs from the committed data-store URL {DATA_STORE_BASE_URL}; "
        "the committed value is the truth (unset the variable, or fix the committed constant in a PR)"
    )


def resolve_bucket(value: str | None) -> str:
    """The committed data-store bucket; any other name is refused, never written to."""
    if not value or value == DATA_STORE_BUCKET:
        return DATA_STORE_BUCKET
    assert_bucket_name(value)
    raise DataReleaseError(
        f"bucket {value!r} differs from the committed data-store bucket {DATA_STORE_BUCKET}; "
        "the committed value is the truth"
    )


def assert_bucket_name(name: object) -> str:
    """A GCS bucket name (3-63 characters, lower case). It comes from a variable, never from git."""
    if not isinstance(name, str) or not _BUCKET.fullmatch(name) or ".." in name:
        raise DataReleaseError(f"invalid bucket name {name!r}")
    return name


def terms_status(value: object, *, where: str) -> str:
    """``value`` as one of the five findings: a finding reads as itself, a legacy status as its finding.

    Anything else, a near miss in case or spacing included, is a hard error (Atlas data platform design
    2026-10-18 §9).
    """
    if isinstance(value, str):
        if value in COMMERCIAL_USE_FINDINGS:
            return value
        if value in LEGACY_TERMS_STATUSES:
            return LEGACY_TERMS_STATUSES[value]
    raise DataReleaseError(
        f"{where}: terms status {value!r} is not one of {list(COMMERCIAL_USE_FINDINGS)} "
        f"(docs/non-commercial-data.md) or a legacy {sorted(LEGACY_TERMS_STATUSES)}"
    )


def canonical_bytes(manifest: Mapping[str, Any]) -> bytes:
    """The committed and uploaded form: sorted keys, two-space indent, trailing newline."""
    return (json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def build_manifest(
    records: Iterable[FileRecord],
    sources: Mapping[str, Mapping[str, Any]],
    release: str,
    previous: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """A validated manifest for ``records``, reusing earlier keys for byte-identical files."""
    assert_release_id(release)
    published = _published(previous, release)
    released_directories = {found for path in published if (found := closed_directory(path)) is not None}
    objects: dict[str, dict[str, Any]] = {}
    for record in records:
        path = assert_data_path(record.path)
        if path in objects:
            raise DataReleaseError(f"{path}: listed twice")
        earlier = published.get(path)
        closed = closed_directory(path)
        if earlier is None and closed in released_directories:
            raise DataReleaseError(
                f"{path}: {''.join(closed)}/ was released without this file, and a released directory is "
                "immutable and cannot gain one (design §5); publish a new model_version instead"
            )
        if earlier is not None and (earlier.sha256, earlier.bytes) != (record.sha256, record.bytes):
            if closed is not None:
                raise DataReleaseError(
                    f"{path}: published in an earlier release with sha256 {earlier.sha256}; artifacts and "
                    "their models are immutable (design §5), so publish a new model_version instead of "
                    "changing one"
                )
            if is_write_once(path):
                raise DataReleaseError(
                    f"{path}: published in an earlier release with sha256 {earlier.sha256}; a released part "
                    "is immutable (data platform builder's call 6); write a new epoch or ingest version, or "
                    "a new registry release"
                )
            earlier = None
        objects[path] = {
            "path": path,
            "key": earlier.key if earlier is not None else release_key(release, path),
            "bytes": record.bytes,
            "sha256": record.sha256,
            "media_type": media_type_for(path),
            "in_git": record.in_git,
            "sources": sorted(record.sources),
        }
    ordered = [objects[path] for path in sorted(objects)]
    manifest = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "release": release,
        "local_root": LOCAL_ROOT,
        "objects": ordered,
        "sources": {name: _written_source(name, sources[name]) for name in sorted(sources)},
        "totals": _totals(ordered),
    }
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest: Mapping[str, Any]) -> tuple[ReleaseObject, ...]:
    """Every rule of data store design §5, or a ``DataReleaseError`` naming the first violation."""
    _closed(manifest, _MANIFEST_FIELDS, "manifest", required=_MANIFEST_FIELDS)
    if manifest["schema"] != SCHEMA or manifest["schema_version"] != SCHEMA_VERSION:
        raise DataReleaseError(f"not a {SCHEMA} v{SCHEMA_VERSION} manifest")
    release = assert_release_id(manifest["release"])
    if manifest["local_root"] != LOCAL_ROOT:
        raise DataReleaseError(f"local_root must be {LOCAL_ROOT!r}")
    sources = manifest["sources"]
    if not isinstance(sources, Mapping):
        raise DataReleaseError("sources must be an object")
    for name, source in sources.items():
        _validate_source(name, source)
    raw = manifest["objects"]
    if not isinstance(raw, list) or not raw:
        raise DataReleaseError("objects must be a non-empty list")
    objects = tuple(_validate_object(item, release, sources) for item in raw)
    paths = [item.path for item in objects]
    if paths != sorted(paths):
        raise DataReleaseError("objects must be sorted by path")
    for field, values in (("path", paths), ("key", [item.key for item in objects])):
        if len(set(values)) != len(values):
            raise DataReleaseError(f"an object {field} is listed twice")
    unused = sorted(set(sources) - {name for item in objects for name in item.sources})
    if unused:
        raise DataReleaseError(f"unused sources {unused}: every declared source must describe an object")
    expected = _totals([item.__dict__ for item in objects])
    if manifest["totals"] != expected:
        raise DataReleaseError(f"totals {manifest['totals']!r} do not match the objects ({expected})")
    return objects


def select(objects: Sequence[ReleaseObject], prefixes: Sequence[str]) -> tuple[ReleaseObject, ...]:
    """Objects whose path starts with any prefix (all when none); a prefix matching nothing is an error."""
    if not prefixes:
        return tuple(objects)
    for prefix in prefixes:
        if not any(item.path.startswith(prefix) for item in objects):
            raise DataReleaseError(f"prefix {prefix!r} matches no object in the release")
    return tuple(item for item in objects if any(item.path.startswith(prefix) for prefix in prefixes))


def validate_withdrawn(document: object) -> tuple[Withdrawal, ...]:
    """Every rule of ``WITHDRAWN.json``, or a ``DataReleaseError`` naming the first violation."""
    if not isinstance(document, Mapping):
        raise DataReleaseError(f"{WITHDRAWN_FILE}: not a JSON object")
    _closed(document, _WITHDRAWN_FIELDS, WITHDRAWN_FILE, required=_WITHDRAWN_FIELDS)
    version = document["schema_version"]
    if (
        document["schema"] != WITHDRAWN_SCHEMA
        or type(version) is not int  # JSON true is not version 1
        or version != WITHDRAWN_SCHEMA_VERSION
    ):
        raise DataReleaseError(f"{WITHDRAWN_FILE}: not a {WITHDRAWN_SCHEMA} v{WITHDRAWN_SCHEMA_VERSION} list")
    if not isinstance(document["withdrawn"], list):
        raise DataReleaseError(f"{WITHDRAWN_FILE}: withdrawn must be a list")
    entries = tuple(_validate_withdrawal(item) for item in document["withdrawn"])
    for earlier, later in pairwise(entry.key for entry in entries):
        if earlier == later:
            raise DataReleaseError(f"{WITHDRAWN_FILE}: {later} is listed twice")
        if earlier > later:
            raise DataReleaseError(f"{WITHDRAWN_FILE}: entries must be sorted by key; {later} is misplaced")
    return entries


def _published(previous: Sequence[Mapping[str, Any]], release: str) -> dict[str, ReleaseObject]:
    """Path → newest earlier object (whose key already points at the original upload)."""
    found: dict[str, ReleaseObject] = {}
    ordered = sorted(previous, key=lambda item: release_sort_key(assert_release_id(item.get("release"))))
    for manifest in ordered:
        if release_sort_key(manifest["release"]) >= release_sort_key(release):
            raise DataReleaseError(
                f"previous release {manifest['release']} is not earlier than {release}"
            )
        for item in validate_manifest(manifest):
            found[item.path] = item
    return found


def _validate_object(item: object, release: str, sources: Mapping[str, Any]) -> ReleaseObject:
    if not isinstance(item, Mapping):
        raise DataReleaseError(f"object {item!r} is not a JSON object")
    _closed(item, _OBJECT_FIELDS, f"object {item.get('path')!r}", required=_OBJECT_FIELDS)
    path = assert_data_path(item["path"])
    if not isinstance(item["sha256"], str) or not _SHA256.fullmatch(item["sha256"]):
        raise DataReleaseError(f"{path}: invalid sha256 {item['sha256']!r}")
    if type(item["bytes"]) is not int or item["bytes"] < 0:
        raise DataReleaseError(f"{path}: bytes {item['bytes']!r} is not a non-negative integer")
    if not isinstance(item["in_git"], bool):
        raise DataReleaseError(f"{path}: in_git {item['in_git']!r} is not a boolean")
    if item["media_type"] != media_type_for(path):
        raise DataReleaseError(
            f"{path}: media type {item['media_type']!r}, expected {media_type_for(path)!r}"
        )
    names = item["sources"]
    if not isinstance(names, list) or not names or names != sorted(set(names)):
        raise DataReleaseError(f"{path}: sources must be a non-empty, sorted, unique list of source ids")
    undeclared = sorted(name for name in names if name not in sources)
    if undeclared:
        raise DataReleaseError(f"{path}: undeclared sources {undeclared}")
    key = item["key"]
    if key != release_key(release, path) and not _earlier_key(key, release, path):
        raise DataReleaseError(
            f"{path}: key {key!r} must be {release_key(release, path)!r} or an earlier release's key "
            "for the same path"
        )
    return ReleaseObject(
        path, key, item["bytes"], item["sha256"], item["media_type"], item["in_git"], tuple(names)
    )


def _earlier_key(key: object, release: str, path: str) -> bool:
    if not isinstance(key, str) or not key.startswith(RELEASE_PREFIX) or not key.endswith(f"/{path}"):
        return False
    candidate = key[len(RELEASE_PREFIX) : -len(path) - 1]
    if not _RELEASE.fullmatch(candidate):
        return False
    return release_sort_key(candidate) < release_sort_key(release)


def _validate_withdrawal(item: object) -> Withdrawal:
    if not isinstance(item, Mapping):
        raise DataReleaseError(f"{WITHDRAWN_FILE}: entry {item!r} is not a JSON object")
    where = f"{WITHDRAWN_FILE} entry {item.get('key')!r}"
    _closed(item, _WITHDRAWAL_FIELDS, where, required=_WITHDRAWAL_FIELDS)
    if not _is_release_key(item["key"]):
        raise DataReleaseError(f"{where}: key must be {RELEASE_PREFIX}<release>/<path>")
    if not isinstance(item["sha256"], str) or not _SHA256.fullmatch(item["sha256"]):
        raise DataReleaseError(f"{where}: sha256 {item['sha256']!r} is not 64 lowercase hex characters")
    for field in ("reason", "decided_by"):
        if not isinstance(item[field], str) or not item[field].strip():
            raise DataReleaseError(f"{where}: {field} must be a non-blank string")
    _https(item["issue"], f"{where}: issue")
    if not isinstance(item["date"], str) or not _DATE.fullmatch(item["date"]):
        raise DataReleaseError(f"{where}: date {item['date']!r} is not YYYY-MM-DD")
    return Withdrawal(
        item["key"], item["sha256"], item["reason"], item["issue"], item["date"], item["decided_by"]
    )


def _is_release_key(key: object) -> bool:
    """``releases/<release>/<path>``, exactly as ``release_key`` writes it."""
    if not isinstance(key, str) or not key.startswith(RELEASE_PREFIX):
        return False
    release, _, path = key[len(RELEASE_PREFIX) :].partition("/")
    try:
        return release_key(release, path) == key
    except DataReleaseError:
        return False


def _written_source(name: str, source: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of ``source`` whose terms carry the finding its status reads as.

    Atlas data platform design 2026-10-18 §9: a new manifest writes the normalised status.
    """
    written = dict(source)
    terms = written.get("terms")
    if isinstance(terms, Mapping) and "status" in terms:
        written["terms"] = {**terms, "status": terms_status(terms["status"], where=f"source {name}")}
    return written


def _validate_source(name: object, source: object) -> None:
    if not isinstance(name, str) or not _SOURCE_ID.fullmatch(name):
        raise DataReleaseError(f"invalid source id {name!r}")
    if not isinstance(source, Mapping):
        raise DataReleaseError(f"source {name}: not a JSON object")
    _closed(source, _SOURCE_FIELDS, f"source {name}", required=_SOURCE_REQUIRED)
    if not isinstance(source["name"], str) or not source["name"]:
        raise DataReleaseError(f"source {name}: name must be a non-empty string")
    if "url" in source:
        _https(source["url"], f"source {name} url")
    if not isinstance(source["non_commercial"], bool):
        raise DataReleaseError(f"source {name}: non_commercial must be a boolean")
    terms = source["terms"]
    if not isinstance(terms, Mapping):
        raise DataReleaseError(f"source {name}: terms must be an object")
    _closed(terms, _TERMS_FIELDS, f"source {name} terms", required=frozenset({"status"}))
    status = terms_status(terms["status"], where=f"source {name}")
    if status != NOT_CHECKED and not terms.get("recorded_in"):
        raise DataReleaseError(
            f"source {name}: status {status!r} must name the record it was copied from (recorded_in)"
        )
    if source["non_commercial"] and status == NOT_CHECKED:
        raise DataReleaseError(
            f"source {name}: a non-commercial marker must come from a recorded terms check, not not_checked"
        )
    if "terms_url" in terms:
        _https(terms["terms_url"], f"source {name} terms_url")
    if "checked_at" in terms:
        checked_at = terms["checked_at"]
        if not isinstance(checked_at, str) or not _DATE.fullmatch(checked_at):
            raise DataReleaseError(f"source {name}: checked_at {checked_at!r} is not YYYY-MM-DD")


def _https(value: object, where: str) -> None:
    if not isinstance(value, str) or not value.startswith("https://"):
        raise DataReleaseError(f"{where} must be an https URL, got {value!r}")


def _closed(
    value: Mapping[str, Any], allowed: frozenset[str], where: str, *, required: frozenset[str]
) -> None:
    unknown = sorted(set(value) - allowed)
    missing = sorted(required - set(value))
    if unknown or missing:
        raise DataReleaseError(f"{where}: unknown fields {unknown}, missing fields {missing}")


def _totals(objects: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    in_git = [item for item in objects if item["in_git"]]
    values = (
        len(objects),
        sum(item["bytes"] for item in objects),
        len(in_git),
        sum(item["bytes"] for item in in_git),
    )
    return dict(zip(_TOTALS_FIELDS, values, strict=True))
