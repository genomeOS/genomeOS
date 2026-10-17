"""Release manifests for the public genomeOS data store (data store design 2026-10-17 §3–§5).

One pure module fixes the manifest schema, the object keys, the media types and the public URL rule,
so the four tools that touch the store cannot disagree: ``scripts/build_data_release.py`` (writes a
manifest), ``scripts/fetch_data.py`` (reads and verifies), ``scripts/publish_data_store.py`` (uploads)
and ``scripts/provision_data_store_bucket.py`` (only the bucket). No I/O and no network.

A release lists every published file under ``data/`` with its bytes and sha256, plus the source and
terms references the repository already records. Terms are carried, never adjudicated: ``status`` is
copied from the record named in ``recorded_in``, and a source the repository holds no check for is
``not_checked`` (AGENTS "Publication-evidence safeguards"). Keys are immutable and release-versioned,
``releases/<release>/<path>``; a later release reuses an earlier key for byte-identical content, and a
published artifact whose bytes changed is refused (AGENTS "Artifacts are immutable"; design §5).
Pickles are never published: loading one from the internet executes code (data store design §8).
Every violation is a hard error (design §12).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

SCHEMA = "genomeos-data-release"
SCHEMA_VERSION = 1
LOCAL_ROOT = "data"
RELEASE_PREFIX = "releases/"
MANIFEST_PREFIX = "manifests/"
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
NOT_CHECKED = "not_checked"
ARTIFACT_PREFIX = "store/artifacts/"
BASE_URL_VARIABLE = "GENOMEOS_DATA_BASE_URL"

#: Closed: an extension missing here is refused rather than served under a guessed type.
MEDIA_TYPES: Mapping[str, str] = {
    ".csv": "text/csv",
    ".json": "application/json",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".npy": "application/octet-stream",
    ".parquet": "application/vnd.apache.parquet",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
}
#: Never published, whatever the caller asks: unpickling a downloaded file runs its code.
PICKLE_SUFFIXES = (".pkl", ".pickle", ".joblib")

_MANIFEST_FIELDS = frozenset(
    {"schema", "schema_version", "release", "local_root", "objects", "sources", "totals"}
)
_OBJECT_FIELDS = frozenset({"path", "key", "bytes", "sha256", "media_type", "in_git", "sources"})
_SOURCE_FIELDS = frozenset({"name", "citation", "url", "terms", "non_commercial"})
_SOURCE_REQUIRED = frozenset({"name", "terms", "non_commercial"})
_TERMS_FIELDS = frozenset({"status", "checked_at", "terms_url", "licence", "recorded_in", "note"})
_TOTALS_FIELDS = ("objects", "bytes", "in_git_objects", "in_git_bytes")
_RELEASE = re.compile(r"(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?")
_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
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


def assert_release_id(value: object) -> str:
    """``YYYY-MM-DD`` with an optional ``.N`` (N ≥ 1) for a second release on one day."""
    if not isinstance(value, str) or not _RELEASE.fullmatch(value):
        raise DataReleaseError(f"invalid release id {value!r}: expected YYYY-MM-DD or YYYY-MM-DD.N")
    return value


def release_sort_key(release: str) -> tuple[str, int]:
    match = _RELEASE.fullmatch(assert_release_id(release))
    assert match is not None
    return match.group(1), int(match.group(2) or 0)


def assert_data_path(value: object) -> str:
    """A path relative to ``data/``: no ``..``, no leading ``/`` or ``.``, no backslash, no empty segment."""
    parts = value.split("/") if isinstance(value, str) and value else [""]
    if not all(_SEGMENT.fullmatch(part) for part in parts):
        raise DataReleaseError(
            f"invalid data path {value!r}: expected '/'-separated segments matching "
            "^[A-Za-z0-9][A-Za-z0-9._-]*$ (relative, no '..', no hidden files)"
        )
    return value


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


def assert_bucket_name(name: object) -> str:
    """A GCS bucket name (3-63 characters, lower case). It comes from a variable, never from git."""
    if not isinstance(name, str) or not _BUCKET.fullmatch(name) or ".." in name:
        raise DataReleaseError(f"invalid bucket name {name!r}; pass the GENOMEOS_DATA_BUCKET value")
    return name


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
    objects: dict[str, dict[str, Any]] = {}
    for record in records:
        path = assert_data_path(record.path)
        if path in objects:
            raise DataReleaseError(f"{path}: listed twice")
        earlier = published.get(path)
        if earlier is not None and (earlier.sha256, earlier.bytes) != (record.sha256, record.bytes):
            if path.startswith(ARTIFACT_PREFIX):
                raise DataReleaseError(
                    f"{path}: published in an earlier release with sha256 {earlier.sha256}; artifacts are "
                    "immutable (design §5), so publish a new model_version instead of changing one"
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
        "sources": {name: dict(sources[name]) for name in sorted(sources)},
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
    status = terms["status"]
    if not isinstance(status, str) or not status:
        raise DataReleaseError(f"source {name}: terms status must be a non-empty string")
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
