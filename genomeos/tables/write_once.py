"""Released ``tables/`` parts are written once and read back by key (Atlas data platform design 2026-10-18).

§2.2 rule 4, §2.4 and §2.9; builder's call 6. A part inside an ``epoch=``, ``ingest_version=``, ``chrom=``
or ``bin=`` folder (``data_release.PARTITION_KEYS``) is published once and never rewritten: a later
release that changes its rows writes a new epoch or ingest version, and ``data_release.build_manifest``
refuses a released part whose bytes changed. A summary table gets a new key each release instead.

So a build never rebuilds an earlier epoch: it reads the released part, under the key of the release
that first published it (``published_paths``), from a local copy whose sha256 is the published one
(``require_published_local``). Reads are local, never over HTTPS: a part the tree lacks stops the build
with the command that fetches it.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from genomeos.publication import data_release as dr
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import published_paths

__all__ = ("published_paths", "require_published_local")


def require_published_local(data_root: Path, path: str, sha256: str) -> Path:
    """The local copy of the published ``path``, refused unless it is there with sha256 ``sha256``."""
    local = data_root / dr.assert_data_path(path)
    fetch = f"python scripts/fetch_data.py --prefix {_fetch_prefix(path)}"
    if not local.is_file():
        raise TableError(
            f"{path}: an earlier release published it, and {data_root} lacks it; fetch it first: {fetch}"
        )
    with local.open("rb") as stream:
        found = hashlib.file_digest(stream, "sha256").hexdigest()
    if found != sha256:
        raise TableError(
            f"{path}: the local copy has sha256 {found}, but it was published with {sha256}, and a released "
            f"file never changes; delete the local copy and fetch it again: {fetch}"
        )
    return local


def _fetch_prefix(path: str) -> str:
    """The ``fetch_data.py --prefix`` that fetches ``path``: every artifact, or the path's top folder."""
    if path.startswith(dr.ARTIFACT_PREFIX):
        return dr.ARTIFACT_PREFIX
    return f"{path.split('/', 1)[0]}/"
