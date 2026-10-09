"""Write the download copies of an Atlas web staging tree (fast-load/GCS design 2026-10-07 §C.2).

Thin I/O beside ``genomeos.publication.web_layout.apply_download_layout``: each canonical JSON file is
copied byte-for-byte to its content-addressed download key after its sha256 is checked against the
catalog. A key that already exists must hold identical bytes; anything else is a hard error.

``write_atomic`` is the one temporary-and-rename writer of the staging tree: the download copies
here and ``encode_atlas_web``'s objects and catalog all go through it, so an interrupted run never
leaves a truncated file at a content-addressed key.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sys
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication.web_layout import DownloadCopy  # noqa: E402


class StagingError(RuntimeError):
    """A staged file would not be the bytes the catalog names."""


def write_atomic(path: Path, data: bytes) -> None:
    """Write ``data`` to a hidden sibling, fsync it, then rename it onto ``path``.

    An interrupted run leaves either nothing or the complete bytes at ``path``, never a truncated
    object at a content-addressed key (which every later run would refuse) or a truncated catalog.
    """
    temporary = path.with_name(f".{path.name}.{os.getpid()}-{secrets.token_hex(4)}.tmp")
    stream = temporary.open("xb")  # exclusive: never truncates or later unlinks another writer's file
    try:
        with stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def write_download_copies(in_dir: Path, out_dir: Path, copies: Iterable[DownloadCopy]) -> list[Path]:
    """Copy every download into ``out_dir`` at its key; return the paths written by this call."""
    written: list[Path] = []
    for item in copies:
        source = in_dir / item.source
        if not source.is_file():
            raise StagingError(f"{item.source}: missing from the export directory {in_dir}")
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != item.sha256:
            raise StagingError(
                f"{item.source}: sha256 {digest} does not match the catalog digest {item.sha256}"
            )
        target = out_dir / item.key
        if target.exists():
            if target.read_bytes() != data:
                raise StagingError(
                    f"{item.key}: already staged with different bytes; content-addressed keys never change"
                )
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(target, data)
        written.append(target)
    return written
