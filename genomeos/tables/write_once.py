"""Released ``tables/`` parts are written once and read back by key (Atlas data platform design 2026-10-18).

§2.2 rule 4, §2.3, §2.4 and §2.9; builder's calls 5 and 6. A part inside an ``epoch=``,
``ingest_version=``, ``chrom=`` or ``bin=`` folder (``data_release.PARTITION_KEYS``), or in a population
registry's folder (``data_release.REGISTRY_PREFIX``), is published once and never rewritten: a later
release that changes its rows writes a new epoch, ingest version or registry release, and
``data_release.build_manifest`` refuses a released part whose bytes changed. A summary table gets a new
key each release instead.

So a build never rebuilds an earlier epoch: it reads the released part, under the key of the release
that first published it (``published_paths``), from a local copy whose sha256 is the published one
(``require_published_local``). Reads are local, never over HTTPS: a part the tree lacks stops the build
with the command that fetches it. A build that can re-derive a released part's rows verifies them
against that copy (``require_same_rows``) instead of writing it again, so a rerun under another git sha
keeps the first writer's bytes.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Hashable, Sequence
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow.parquet as pq

from genomeos.publication import data_release as dr
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import published_paths

__all__ = ("fetch_prefix", "published_paths", "require_published_local", "require_same_rows")


def require_published_local(data_root: Path, path: str, sha256: str) -> Path:
    """The local copy of the published ``path``, refused unless it is there with sha256 ``sha256``."""
    local = data_root / dr.assert_data_path(path)
    fetch = f"python scripts/fetch_data.py --prefix {fetch_prefix(path)}"
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


def fetch_prefix(path: str) -> str:
    """The ``fetch_data.py --prefix`` that fetches ``path``: every artifact, or the path's top folder."""
    if path.startswith(dr.ARTIFACT_PREFIX):
        return dr.ARTIFACT_PREFIX
    return f"{path.split('/', 1)[0]}/"


def require_same_rows(published: Path, rebuilt: pd.DataFrame, *, key: Sequence[str]) -> None:
    """Refuse a rebuild whose rows differ from the released part ``published`` (call 6).

    Rows are matched on ``key``, in any order, and compared value for value, floats exactly; a row only
    one side holds differs too. The columns must be the part's, in its order.
    """
    found = pq.read_table(published).to_pandas()
    immutable = (
        f"a released part is immutable (data platform builder's call 6): {published} differs from its rebuild"
    )
    if list(rebuilt.columns) != list(found.columns):
        raise TableError(f"{immutable} in its columns: {list(rebuilt.columns)}, not {list(found.columns)}")
    if not key or not set(key) <= set(found.columns):
        raise TableError(f"{published}: key {list(key)} must name columns of the part")
    before, after = _keyed(found, key, str(published)), _keyed(rebuilt, key, "the rebuild")
    differ = sum(before.get(name) != after.get(name) for name in before.keys() | after.keys())
    if differ:
        raise TableError(f"{immutable} in {differ} rows")


def _keyed(
    frame: pd.DataFrame, key: Sequence[str], where: str
) -> dict[tuple[Hashable, ...], tuple[Any, ...]]:
    """Each row of ``frame`` as plain Python values, by its ``key`` values; a repeated key is refused."""
    columns = list(frame.columns)
    positions = [columns.index(name) for name in key]
    rows: dict[tuple[Hashable, ...], tuple[Any, ...]] = {}
    for values in frame.itertuples(index=False, name=None):
        row = tuple(_plain(value) for value in values)
        name = tuple(row[position] for position in positions)
        if name in rows:
            raise TableError(f"{where}: key {list(key)} {list(name)} is repeated")
        rows[name] = row
    return rows


def _plain(value: Any) -> Any:
    """A cell as a plain Python value, every kind of missing as ``None``."""
    if value is None or value is pd.NA or (isinstance(value, float) and math.isnan(value)):
        return None
    item = getattr(value, "item", None)
    return item() if callable(item) else value
