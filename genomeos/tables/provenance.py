"""What a ``tables/`` file was derived from, and the sources it therefore carries.

Atlas data platform design 2026-10-18 §2.1, §2.5, §2.7 check 9 and §9; builder's calls 7 and 16.

Every derived file records its inputs by sha256 in ``genomeos.inputs`` (§2.1). An input is data, never
code, in one of three forms:

- ``releases/<R>/<path>``: a released object, under the key of the release that first published it;
- ``manifests/<R>.json``: a committed release manifest;
- ``git:<path>``: a file in this repository at the stamped ``genomeos.git_sha``.

A file's ``genomeos.sources`` is the union of its inputs' sources (call 16), so a ``non_commercial``
source such as GeneReviews follows every byte derived from it. A released key carries the sources its
publishing manifest records, a manifest every source its objects record, and a ``git:`` file only what
``GIT_INPUT_SOURCES`` lists after review; a ``git:`` path missing there is a hard error, so code can
never add or drop a source by reading a new file. The release builder reads a file's recorded sources
back through ``recorded_sources``.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pyarrow
import pyarrow.parquet as pq

from genomeos.publication import data_release as dr
from genomeos.tables.contracts import TableError

GIT_PREFIX = "git:"
#: The metadata key each file records its sources under.
SOURCES_KEY = "genomeos.sources"
#: Reviewed: the sources of each repository file a table reads. Both are project-authored records.
GIT_INPUT_SOURCES: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        "website/public/data/atlas/catalog.json": ("genomeos",),
        "data/releases/WITHDRAWN.json": ("genomeos",),
    }
)
_SHA256 = re.compile(r"[0-9a-f]{64}")
_FORMS = f"{dr.RELEASE_PREFIX}<release>/<path>, {dr.MANIFEST_PREFIX}<release>.json or {GIT_PREFIX}<path>"


@dataclass(frozen=True, order=True)
class InputRef:
    """One input of a derived file: its key in one of the three forms, and its sha256."""

    key: str
    sha256: str

    def __post_init__(self) -> None:
        _parse(self.key)
        if not isinstance(self.sha256, str) or not _SHA256.fullmatch(self.sha256):
            raise TableError(f"input {self.key}: sha256 {self.sha256!r} is not 64 lowercase hex characters")


def _parse(key: object) -> tuple[str, str, str]:
    """``(form, release, path)``: form is ``release``, ``manifest`` or ``git``."""
    if isinstance(key, str):
        try:
            if key.startswith(dr.RELEASE_PREFIX):
                release, _, path = key[len(dr.RELEASE_PREFIX) :].partition("/")
                if dr.release_key(release, path) == key:
                    return "release", release, path
            elif key.startswith(dr.MANIFEST_PREFIX) and key.endswith(".json"):
                release = key[len(dr.MANIFEST_PREFIX) : -len(".json")]
                if dr.manifest_key(release) == key:
                    return "manifest", release, ""
            elif key.startswith(GIT_PREFIX):
                return "git", "", dr.assert_data_path(key[len(GIT_PREFIX) :])
        except dr.DataReleaseError:
            pass
    raise TableError(f"input key {key!r} is none of {_FORMS}")


def encode_inputs(refs: Iterable[InputRef]) -> str:
    """The canonical ``genomeos.inputs`` text: sorted, unique, compact JSON."""
    ordered = sorted(set(refs))
    repeated = sorted(key for key, n in Counter(ref.key for ref in ordered).items() if n > 1)
    if repeated:
        raise TableError(f"inputs {repeated} are each listed with two sha256s")
    return json.dumps([{"key": ref.key, "sha256": ref.sha256} for ref in ordered], separators=(",", ":"))


def decode_inputs(text: str) -> tuple[InputRef, ...]:
    """The inputs a file records, refusing anything but the canonical list ``encode_inputs`` writes."""
    try:
        items = json.loads(text)
    except json.JSONDecodeError as error:
        raise TableError(f"genomeos.inputs is not JSON: {error}") from error
    if not isinstance(items, list) or not all(
        isinstance(item, dict) and set(item) == {"key", "sha256"} for item in items
    ):
        raise TableError("genomeos.inputs must be a list of {key, sha256} objects")
    refs = tuple(InputRef(item["key"], item["sha256"]) for item in items)
    if encode_inputs(refs) != text:
        raise TableError("genomeos.inputs is not in canonical form (sorted, unique, compact JSON)")
    return refs


def read_kv(path: Path) -> dict[str, str]:
    """A Parquet file's key-value metadata, decoded."""
    try:
        metadata = pq.ParquetFile(path).metadata.metadata or {}
    except pyarrow.ArrowException as error:
        raise TableError(f"{path}: not a readable Parquet file: {error}") from error
    return {key.decode("utf-8"): value.decode("utf-8") for key, value in metadata.items()}


def parse_sources(text: str, *, where: str) -> tuple[str, ...]:
    """A recorded ``genomeos.sources``: a non-empty, sorted, unique JSON list of source ids."""
    try:
        sources = json.loads(text)
    except json.JSONDecodeError as error:
        raise TableError(f"{where}: {SOURCES_KEY} is not JSON: {error}") from error
    if (
        not isinstance(sources, list)
        or not sources
        or not all(isinstance(name, str) and name for name in sources)
        or sources != sorted(set(sources))
    ):
        raise TableError(
            f"{where}: {SOURCES_KEY} {text!r} is not a non-empty, sorted, unique list of source ids"
        )
    return tuple(sources)


def recorded_sources(data_root: Path, path: str) -> tuple[str, ...]:
    """The sources a ``tables/`` file records (the release builder's rule for ``tables/``)."""
    kv = read_kv(data_root / path)
    if SOURCES_KEY not in kv:
        raise TableError(
            f"{path}: records no {SOURCES_KEY}; every tables/ file carries its inputs' sources "
            "(data platform §9, call 16), so write it through genomeos.tables.writer"
        )
    return parse_sources(kv[SOURCES_KEY], where=path)


def manifest_ref(manifest: Mapping[str, Any]) -> InputRef:
    """A committed manifest as an input: its key and the sha256 of its canonical (committed) bytes."""
    payload = dr.canonical_bytes(manifest)
    return InputRef(dr.manifest_key(manifest["release"]), hashlib.sha256(payload).hexdigest())


def sources_of(
    ref: InputRef,
    *,
    manifests: Mapping[str, Mapping[str, Any]],
    new_sources: Mapping[str, tuple[str, ...]],
) -> tuple[str, ...]:
    """The sources ``ref`` carries. ``manifests`` maps each committed release id to its manifest, and
    ``new_sources`` maps each path this release publishes to its sources."""
    form, release, path = _parse(ref.key)
    if form == "git":
        if path not in GIT_INPUT_SOURCES:
            raise TableError(f"no reviewed sources for {ref.key}; add it to GIT_INPUT_SOURCES after review")
        return GIT_INPUT_SOURCES[path]
    if release not in manifests:
        if form == "release" and path in new_sources:
            return tuple(sorted(set(new_sources[path])))
        raise TableError(f"input {ref.key}: no committed manifest of release {release}, and no source for it")
    manifest = manifests[release]
    objects = dr.validate_manifest(manifest)
    if form == "manifest":
        if manifest_ref(manifest).sha256 != ref.sha256:
            raise TableError(f"input {ref.key}: sha256 {ref.sha256} is not the committed manifest's")
        return tuple(sorted({name for item in objects for name in item.sources}))
    for item in objects:
        if item.key == ref.key:
            if item.sha256 != ref.sha256:
                raise TableError(
                    f"input {ref.key}: sha256 {ref.sha256}, but its manifest records {item.sha256}"
                )
            return item.sources
    raise TableError(f"input {ref.key}: manifests/{release}.json does not publish it")


def union_sources(
    refs: Iterable[InputRef],
    *,
    manifests: Mapping[str, Mapping[str, Any]],
    new_sources: Mapping[str, tuple[str, ...]],
) -> tuple[str, ...]:
    """Every source of every input, sorted and unique (builder's call 16)."""
    found = {name for ref in refs for name in sources_of(ref, manifests=manifests, new_sources=new_sources)}
    return tuple(sorted(found))


def published_paths(manifests: Sequence[Mapping[str, Any]]) -> dict[str, dr.ReleaseObject]:
    """Each released path's first publication, from the committed manifests: the key every later
    release reuses for the same bytes (§2.3)."""
    found: dict[str, dr.ReleaseObject] = {}
    for manifest in sorted(manifests, key=lambda manifest: dr.release_sort_key(manifest.get("release"))):
        for item in dr.validate_manifest(manifest):
            found.setdefault(item.path, item)
    return found
