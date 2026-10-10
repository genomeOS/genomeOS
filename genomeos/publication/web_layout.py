"""Public web-bucket layout for the Atlas explorer's per-artifact data (design §11; fast-load and GCS
design 2026-10-07 §C.1–§C.2).

One pure module fixes every object key, header and origin, so the four tools that touch the bucket
cannot disagree: ``scripts/encode_atlas_web.py --with-downloads`` (download keys and the catalog
rewrite), ``scripts/publish_atlas_web.py`` (what is uploaded, with which headers),
``scripts/provision_atlas_web_bucket.py`` (the CORS policy) and ``scripts/check_atlas_web_data.py``
(what the deploy gate visits). No I/O and no network.

Keys are relative and content-addressed: the first 16 hex digits of the object's sha256 are the last
dot-segment before the extension, so an immutable ``Cache-Control`` can never pin stale bytes.
Digests are over decoded bytes; gzip is a transport encoding the publisher adds.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import urljoin, urlsplit

OBJECT_PREFIX = "atlas/web/"
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
CONTENT_TYPES: Mapping[str, str] = {".gosa": "application/octet-stream", ".json": "application/json"}
DOWNLOAD_KINDS = ("surface", "observations", "manifest")
PRODUCTION_ORIGINS = (
    "https://genome-os.org",
    "https://www.genome-os.org",
)
LOCAL_ORIGINS = tuple(
    f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in (4321, 4322, 4323)
)

_DATA_KEY = re.compile(r"[a-z0-9][a-z0-9._/-]*")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_BUCKET = re.compile(r"[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]")
_T = TypeVar("_T")


class WebLayoutError(ValueError):
    """A catalog, key, base or bucket that would publish or serve the wrong bytes. Always fatal."""


@dataclass(frozen=True)
class DownloadCopy:
    """One canonical JSON file copied byte-for-byte from an export tree into the bucket layout."""

    source: str
    key: str
    sha256: str


@dataclass(frozen=True)
class WebObject:
    """One artifact-base object: what the publisher uploads and the deploy gate checks."""

    key: str
    sha256: str
    decoded_bytes: int | None  # declared by the catalog (grids, web tiers, observations); else None
    content_type: str
    content_disposition: str | None


@dataclass(frozen=True)
class SiteObject:
    """One site-base file that stays in the Pages bundle (Natural Earth context, external caches)."""

    key: str
    sha256: str | None


def cors_policy() -> list[dict[str, Any]]:
    """The bucket CORS document, exactly as ``gcloud storage buckets update --cors-file`` takes it."""
    return [
        {
            "origin": [*PRODUCTION_ORIGINS, *LOCAL_ORIGINS],
            "method": ["GET", "HEAD"],
            "responseHeader": ["Content-Length", "Content-Type", "Content-Encoding", "ETag"],
            "maxAgeSeconds": 3600,
        }
    ]


def assert_data_key(key: object) -> str:
    """A catalog key: relative, lower-case, no scheme, no leading '/', no '..' segment (§B.4)."""
    if not isinstance(key, str) or not _DATA_KEY.fullmatch(key) or ".." in key.split("/"):
        raise WebLayoutError(
            f"invalid data key {key!r}: expected a relative path matching ^[a-z0-9][a-z0-9._/-]*$ "
            "with no '..' segment"
        )
    return key


def assert_absolute_data_base(base: object) -> str:
    """The absolute half of the §B.4 base rule: https (or http on localhost/127.0.0.1), ends in '/'."""
    if not isinstance(base, str) or not base:
        raise WebLayoutError("the artifact data base is empty; set ATLAS_DATA_BASE_URL (design §C.1.4)")
    parts = urlsplit(base)
    local = parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1"}
    if (
        (parts.scheme != "https" and not local)
        or not parts.netloc
        or parts.query
        or parts.fragment
        or not base.endswith("/")
    ):
        raise WebLayoutError(
            f"artifact data base {base!r} must be an absolute https:// URL "
            "(or http://localhost / http://127.0.0.1) ending in '/'"
        )
    return base


def assert_bucket_name(name: object) -> str:
    """A GCS bucket name (3-63 characters, lower case). It comes from a variable, never from git."""
    if not isinstance(name, str) or not _BUCKET.fullmatch(name) or ".." in name:
        raise WebLayoutError(f"invalid bucket name {name!r}; pass the ATLAS_DATA_BUCKET value")
    return name


def resolve_key(key: str, base: str) -> str:
    """``new URL(key, base).href`` for a validated key and an absolute base."""
    return urljoin(assert_absolute_data_base(base), assert_data_key(key))


def object_name(key: str) -> str:
    """The bucket object name for a catalog key."""
    return OBJECT_PREFIX + assert_data_key(key)


def content_type_for(key: str) -> str:
    suffix = key[key.rfind(".") :] if "." in key else ""
    if suffix not in CONTENT_TYPES:
        raise WebLayoutError(f"{key}: no published content type for {suffix!r}")
    return CONTENT_TYPES[suffix]


def download_key(artifact_id: str, model_version: str, data_version: str, kind: str, sha256: str) -> str:
    if kind not in DOWNLOAD_KINDS:
        raise WebLayoutError(f"unknown download kind {kind!r}; expected one of {DOWNLOAD_KINDS}")
    _require_sha256(f"{artifact_id} {kind}", sha256)
    return assert_data_key(
        f"downloads/{artifact_id}/{model_version}/{data_version}/{artifact_id}.{kind}.{sha256[:16]}.json"
    )


def download_disposition(artifact_id: str, kind: str) -> str:
    """Save under the canonical filename even though the key is content-addressed."""
    return f'attachment; filename="{artifact_id}.{kind}.json"'


def apply_download_layout(catalog: Mapping[str, Any]) -> tuple[dict[str, Any], tuple[DownloadCopy, ...]]:
    """Rewrite ``surface_url``, ``observations_url`` and ``downloads.*.url`` to download keys.

    Every sha256 is unchanged because the files are copied, not re-serialised;
    ``observations_url`` and ``downloads.observations.url`` name the same object. Applied to its own
    output it is a no-op, which is how a tree downloaded from the bucket is re-encoded.
    """
    rewritten: dict[str, Any] = copy.deepcopy(dict(catalog))
    copies: dict[str, DownloadCopy] = {}
    for ref in rewritten["artifacts"]:
        for kind, entry in _download_entries(ref):
            key = download_key(ref["id"], ref["model_version"], ref["data_version"], kind, entry["sha256"])
            _add_copy(copies, DownloadCopy(assert_data_key(entry["url"]), key, entry["sha256"]))
            entry["url"] = key
        _bind(ref, "surface")
        if ref["observations_available"]:
            _bind(ref, "observations")
    return rewritten, tuple(copies[key] for key in sorted(copies))


def artifact_objects(catalog: Mapping[str, Any]) -> tuple[WebObject, ...]:
    """Every artifact-base object the catalog references, one per key, in key order."""
    found: dict[str, WebObject] = {}
    for grid in catalog["grids"].values():
        _merge(found, _web_object(grid["url"], grid["sha256"], grid["bytes"], None))
    for ref in catalog["artifacts"]:
        for tier in ("render", "detail"):
            entry = ref["web"][tier]
            _merge(found, _web_object(entry["url"], entry["sha256"], entry["bytes"], None))
        _merge(found, _web_object(ref["surface_url"], ref["surface_sha256"], None, None))
        if ref["observations_available"]:
            _merge(
                found,
                _web_object(
                    ref["observations_url"], ref["observations_sha256"], ref["observations_bytes"], None
                ),
            )
        for kind, entry in _download_entries(ref):
            declared = ref["observations_bytes"] if kind == "observations" else None
            disposition = download_disposition(ref["id"], kind)
            _merge(found, _web_object(entry["url"], entry["sha256"], declared, disposition))
    return tuple(found[key] for key in sorted(found))


def critical_objects(catalog: Mapping[str, Any]) -> tuple[WebObject, ...]:
    """The default (first) artifact's grid, render tier and observations, which the gate GETs."""
    by_key = {item.key: item for item in artifact_objects(catalog)}
    ref = catalog["artifacts"][0]
    grid = catalog["grids"].get(ref["web"]["grid_sha256"])
    if grid is None:
        raise WebLayoutError(f"{ref['id']}: web.grid_sha256 names no catalog grid")
    keys = [grid["url"], ref["web"]["render"]["url"]]
    if ref["observations_available"]:
        keys.append(ref["observations_url"])
    return tuple(by_key[key] for key in keys)


def site_objects(catalog: Mapping[str, Any]) -> tuple[SiteObject, ...]:
    """Every site-base file: Natural Earth context sources and external caches (with digests).

    A cache key named more than once must carry one digest; a context source has none to compare.
    """
    found: dict[str, str | None] = {}
    for source in catalog["context_sources"]:
        found.setdefault(assert_data_key(source["url"]), None)
    for ref in catalog["artifacts"]:
        for resource in ref["external_resources"]:
            key = assert_data_key(resource["cache_url"])
            digest = _require_sha256(f"{key} cache", resource["cache_sha256"])
            found[key] = _agree(key, "cache sha256", found.get(key), digest)
    return tuple(SiteObject(key, found[key]) for key in sorted(found))


def _download_entries(ref: Mapping[str, Any]) -> list[tuple[str, Any]]:
    """``ref``'s downloads in ``DOWNLOAD_KINDS`` order. Surface and manifest are required; the
    observations download exists exactly when ``observations_available`` is true (catalog contract)."""
    available = ref["observations_available"]
    if not isinstance(available, bool):
        raise WebLayoutError(f"{ref['id']}: observations_available {available!r} is not a boolean")
    entries: list[tuple[str, Any]] = []
    for kind in DOWNLOAD_KINDS:
        entry = ref["downloads"].get(kind)
        if kind == "observations" and not available:
            if entry is not None:
                raise WebLayoutError(
                    f"{ref['id']}: downloads.observations is set but observations_available is false"
                )
            continue
        if entry is None:
            raise WebLayoutError(f"{ref['id']}: downloads.{kind} is missing")
        entries.append((kind, entry))
    return entries


def _add_copy(copies: dict[str, DownloadCopy], item: DownloadCopy) -> None:
    existing = copies.setdefault(item.key, item)
    if existing != item:
        raise WebLayoutError(
            f"{item.key}: two downloads share this key ({existing.source} sha256 {existing.sha256}; "
            f"{item.source} sha256 {item.sha256}); one key must name one file"
        )


def _bind(ref: dict[str, Any], kind: str) -> None:
    download = ref["downloads"][kind]
    if ref[f"{kind}_sha256"] != download["sha256"]:
        raise WebLayoutError(
            f"{ref['id']}: {kind}_sha256 does not match downloads.{kind}.sha256; they must name one object"
        )
    ref[f"{kind}_url"] = download["url"]


def _web_object(key: object, sha256: object, declared: object, disposition: str | None) -> WebObject:
    checked_key = assert_data_key(key)
    checked_sha = _require_sha256(checked_key, sha256)
    content_type = content_type_for(checked_key)
    stem = checked_key.rsplit(".", 1)[0]
    if not stem.endswith(f".{checked_sha[:16]}"):
        raise WebLayoutError(
            f"{checked_key}: not content-addressed; immutable keys end in .{checked_sha[:16]} before "
            "the extension (design §C.2)"
        )
    if declared is not None and (type(declared) is not int or declared <= 0):
        raise WebLayoutError(f"{checked_key}: declared decoded size {declared!r} is not a positive integer")
    return WebObject(checked_key, checked_sha, declared, content_type, disposition)


def _merge(found: dict[str, WebObject], item: WebObject) -> None:
    existing = found.get(item.key)
    if existing is None:
        found[item.key] = item
        return
    if existing.sha256 != item.sha256:
        raise WebLayoutError(f"{item.key}: named with two digests ({existing.sha256}, {item.sha256})")
    found[item.key] = WebObject(
        item.key,
        item.sha256,
        _agree(item.key, "decoded size", existing.decoded_bytes, item.decoded_bytes),
        item.content_type,
        _agree(item.key, "content disposition", existing.content_disposition, item.content_disposition),
    )


def _agree(key: str, what: str, first: _T | None, second: _T | None) -> _T | None:
    if first is not None and second is not None and first != second:
        raise WebLayoutError(f"{key}: two declared {what}s ({first!r}, {second!r})")
    return first if first is not None else second


def _require_sha256(where: str, sha256: object) -> str:
    if not isinstance(sha256, str) or not _SHA256.fullmatch(sha256):
        raise WebLayoutError(f"{where}: invalid sha256 {sha256!r}")
    return sha256
