#!/usr/bin/env python3
"""Publish the Atlas web staging tree to the public GCS bucket (fast-load/GCS design 2026-10-07 §C.2).

Uploads exactly the objects the staging ``catalog.json`` references, at ``atlas/web/<key>``, never
renaming a key. Each file is gzip-compressed here (level 9, mtime 0; never ``--gzip-local*``, which
forces ``Cache-Control: no-transform``) and uploaded with ``--if-generation-match=0``,
``--content-encoding=gzip``, an explicit ``--content-type``, the immutable ``--cache-control``,
``--content-disposition`` for downloads and ``--custom-metadata=sha256=…,decoded-bytes=…``.

Identity is the decoded content recorded in that metadata. Every local file is checked against the
catalog, then every object is described before anything is uploaded: absent → upload; present with
both metadata fields matching and ``contentEncoding: gzip`` → skip; anything else → hard error,
never an overwrite. A 412 on upload gets the same comparison. After an upload the stored metadata,
size and md5 must equal what was sent. Compressed bytes and CRC32C are never compared across runs
(zlib output may differ between builds). ``--dry-run`` prints every command and runs none. Nothing is
ever deleted: cached pages keep referencing old keys. Every command goes through
scripts/gcloud_repo.py.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import sys
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication.web_layout import (  # noqa: E402
    IMMUTABLE_CACHE_CONTROL,
    WebLayoutError,
    WebObject,
    artifact_objects,
    assert_bucket_name,
    object_name,
)
from scripts.atlas_web_gcloud import Gcloud, GcloudError  # noqa: E402


class PublishError(RuntimeError):
    """Publishing would serve bytes other than the catalog's, or replace a published object."""


def describe_args(url: str) -> list[str]:
    return ["storage", "objects", "describe", url, "--raw", "--format=json"]


def upload_args(source: Path, url: str, item: WebObject, decoded_bytes: int) -> list[str]:
    arguments = [
        "storage",
        "cp",
        str(source),
        url,
        "--if-generation-match=0",
        "--content-encoding=gzip",
        f"--content-type={item.content_type}",
        f"--cache-control={IMMUTABLE_CACHE_CONTROL}",
    ]
    if item.content_disposition is not None:
        arguments.append(f"--content-disposition={item.content_disposition}")
    arguments.append(f"--custom-metadata=sha256={item.sha256},decoded-bytes={decoded_bytes}")
    return arguments


def staged_bytes(staging: Path, item: WebObject) -> bytes:
    path = staging / item.key
    if not path.is_file():
        raise PublishError(f"{item.key}: missing from the staging tree {staging}")
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != item.sha256:
        raise PublishError(f"{item.key}: staged sha256 {digest} does not match the catalog {item.sha256}")
    if item.decoded_bytes is not None and len(data) != item.decoded_bytes:
        raise PublishError(
            f"{item.key}: staged size {len(data)} is not the declared {item.decoded_bytes} bytes"
        )
    return data


def identity_problems(existing: Mapping[str, Any], item: WebObject, decoded_bytes: int) -> list[str]:
    metadata = existing.get("metadata") or {}
    problems: list[str] = []
    if metadata.get("sha256") != item.sha256:
        problems.append(f"metadata sha256 is {metadata.get('sha256')!r}, catalog says {item.sha256}")
    if metadata.get("decoded-bytes") != str(decoded_bytes):
        problems.append(
            f"metadata decoded-bytes is {metadata.get('decoded-bytes')!r}, staged file has {decoded_bytes}"
        )
    if existing.get("contentEncoding") != "gzip":
        problems.append(f"contentEncoding is {existing.get('contentEncoding')!r}, not 'gzip'")
    return problems


def require_identical(url: str, existing: Mapping[str, Any], item: WebObject, decoded_bytes: int) -> None:
    problems = identity_problems(existing, item, decoded_bytes)
    if problems:
        raise PublishError(
            f"refusing to overwrite {url}: {'; '.join(problems)}. Published objects are never replaced "
            "(design §C.2)"
        )


def verify_upload(
    url: str, stored: Mapping[str, Any] | None, item: WebObject, decoded_bytes: int, compressed: bytes
) -> None:
    if stored is None:
        raise PublishError(f"{url}: not found right after upload")
    expected = {
        "size": str(len(compressed)),
        "md5Hash": base64.b64encode(hashlib.md5(compressed, usedforsecurity=False).digest()).decode("ascii"),
        "cacheControl": IMMUTABLE_CACHE_CONTROL,
        "contentType": item.content_type,
        "contentDisposition": item.content_disposition,
    }
    problems = identity_problems(stored, item, decoded_bytes) + [
        f"{field} is {stored.get(field)!r}, expected {value!r}"
        for field, value in expected.items()
        if stored.get(field) != value
    ]
    if problems:
        raise PublishError(
            f"post-upload verification failed for {url}: {'; '.join(problems)}. No deployed catalog "
            f"references it yet; inspect it with `python scripts/gcloud_repo.py run storage objects describe "
            f"{url}` and decide with the owner (it is never overwritten or deleted automatically)"
        )


def publish(staging: Path, bucket: str, gcloud: Gcloud, work_dir: Path) -> dict[str, int]:
    catalog = json.loads((staging / "catalog.json").read_text(encoding="utf-8"))
    objects = artifact_objects(catalog)
    sizes = {item.key: len(staged_bytes(staging, item)) for item in objects}  # all local checks first
    counts = {"uploaded": 0, "skipped": 0, "planned": 0}
    pending: list[WebObject] = []
    for item in objects:  # every identity is settled before the first upload
        url = f"gs://{bucket}/{object_name(item.key)}"
        existing = gcloud.describe(describe_args(url))
        if existing is None:
            pending.append(item)
            continue
        require_identical(url, existing, item, sizes[item.key])
        counts["skipped"] += 1
        print(f"skipped {item.key} (identical)")
    for item in pending:
        outcome = _upload(staging, bucket, gcloud, work_dir, item)
        counts[outcome] += 1
        print(f"{outcome} {item.key}")
    return counts


def _upload(staging: Path, bucket: str, gcloud: Gcloud, work_dir: Path, item: WebObject) -> str:
    url = f"gs://{bucket}/{object_name(item.key)}"
    data = staged_bytes(staging, item)
    compressed = gzip.compress(data, compresslevel=9, mtime=0)
    source = work_dir / f"{item.key}.gz"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(compressed)
    result = gcloud.mutate(upload_args(source, url, item, len(data)))
    if result.returncode != 0:
        if not result.precondition_failed:
            raise PublishError(f"upload of {url} failed: {result.stderr.strip()}")
        raced = gcloud.describe(describe_args(url))
        if raced is None:
            raise PublishError(f"{url}: the upload precondition failed but the object is absent")
        require_identical(url, raced, item, len(data))
        return "skipped"
    stored = gcloud.describe(describe_args(url))
    if gcloud.dry_run:
        return "planned"
    verify_upload(url, stored, item, len(data), compressed)
    return "uploaded"


@contextmanager
def _work_dir(explicit: Path | None) -> Iterator[Path]:
    if explicit is not None:
        explicit.mkdir(parents=True, exist_ok=True)
        yield explicit.resolve()
        return
    with tempfile.TemporaryDirectory(prefix="atlas-web-publish-") as name:
        yield Path(name)


def _bucket(value: str) -> str:
    try:
        return assert_bucket_name(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Publish the Atlas web staging tree to the public GCS bucket."
    )
    parser.add_argument(
        "--staging", type=Path, required=True, help="tree from encode_atlas_web.py --with-downloads"
    )
    parser.add_argument("--bucket", type=_bucket, required=True, help="bucket name (never stored in git)")
    parser.add_argument("--dry-run", action="store_true", help="print every gcloud command and run none")
    parser.add_argument(
        "--work-dir", type=Path, help="where the gzip files are written (default: a temp dir)"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    gcloud = Gcloud(dry_run=args.dry_run)
    try:
        with _work_dir(args.work_dir) as work_dir:
            counts = publish(args.staging.resolve(), args.bucket, gcloud, work_dir)
    except (PublishError, GcloudError, WebLayoutError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    total = sum(counts.values())
    print(
        f"{total} objects: {counts['uploaded']} uploaded, {counts['skipped']} skipped, "
        f"{counts['planned']} planned"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
