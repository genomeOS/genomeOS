#!/usr/bin/env python3
"""Upload a committed data-store release to its public bucket, never overwriting (data store design §7).

    python scripts/publish_data_store.py --bucket "$GENOMEOS_DATA_BUCKET" --dry-run
    python scripts/publish_data_store.py --bucket "$GENOMEOS_DATA_BUCKET"

Uploads every object of ``data/releases/<release>.json`` (newest by default) at its manifest key, as
raw bytes with ``--if-generation-match=0``, its media type, the immutable ``Cache-Control`` and
``--custom-metadata=sha256=<hex>``, then the manifest itself at ``manifests/<release>.json``, last.

Identity is the sha256 in object metadata plus the stored size. Every local file is checked against
the manifest first, then every key is described before anything is uploaded: absent → upload; present
with matching identity and no ``Content-Encoding`` → skip; anything else → hard error, never an
overwrite. A key reused from an earlier release must already exist with that identity. A 412 on upload
gets the same comparison. After an upload, the stored size, md5, sha256 metadata, media type and
``Cache-Control`` must equal what was sent. ``--dry-run`` prints every command and the totals and runs
none. Nothing is ever deleted. Every command goes through scripts/gcloud_repo.py (the same wrapper as
the Atlas web bucket's ``publish_atlas_web.py``, whose guard this mirrors).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from scripts.atlas_web_gcloud import Gcloud, GcloudError  # noqa: E402

DATA = ROOT / "data"
RELEASES = DATA / "releases"
CHUNK = 1 << 20


class PublishError(RuntimeError):
    """Publishing would serve bytes other than the manifest's, or replace a published object."""


@dataclass(frozen=True)
class Upload:
    """One object to place in the bucket: the local file and the identity it must carry."""

    source: Path
    key: str
    bytes: int
    sha256: str
    md5_b64: str
    media_type: str
    reused: bool


def _hashes(path: Path) -> tuple[int, str, str]:
    sha, md5, size = hashlib.sha256(), hashlib.md5(usedforsecurity=False), 0
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            sha.update(chunk)
            md5.update(chunk)
            size += len(chunk)
    return size, sha.hexdigest(), base64.b64encode(md5.digest()).decode("ascii")


def plan(manifest_path: Path, data: Path) -> tuple[str, list[Upload]]:
    """Every upload, with each local file checked against the manifest before any gcloud call."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    objects = dr.validate_manifest(manifest)
    release = manifest["release"]
    uploads: list[Upload] = []
    for item in objects:
        source = data / item.path
        if not source.is_file():
            raise PublishError(f"{item.path}: missing from {data}; fetch or rebuild it first")
        size, sha, md5 = _hashes(source)
        if (size, sha) != (item.bytes, item.sha256):
            raise PublishError(
                f"{item.path}: local {size} bytes sha256 {sha} does not match the manifest "
                f"({item.bytes} bytes, {item.sha256})"
            )
        reused = item.key != dr.release_key(release, item.path)
        uploads.append(Upload(source.resolve(), item.key, size, sha, md5, item.media_type, reused))
    size, sha, md5 = _hashes(manifest_path)
    uploads.append(
        Upload(manifest_path.resolve(), dr.manifest_key(release), size, sha, md5, "application/json", False)
    )
    return release, uploads


def describe_args(url: str) -> list[str]:
    return ["storage", "objects", "describe", url, "--raw", "--format=json"]


def upload_args(item: Upload, url: str) -> list[str]:
    return [
        "storage",
        "cp",
        str(item.source),
        url,
        "--if-generation-match=0",
        f"--content-type={item.media_type}",
        f"--cache-control={dr.IMMUTABLE_CACHE_CONTROL}",
        f"--custom-metadata=sha256={item.sha256}",
    ]


def identity_problems(existing: Mapping[str, Any], item: Upload) -> list[str]:
    metadata = existing.get("metadata") or {}
    problems: list[str] = []
    if metadata.get("sha256") != item.sha256:
        problems.append(f"metadata sha256 is {metadata.get('sha256')!r}, the manifest says {item.sha256}")
    if str(existing.get("size")) != str(item.bytes):
        problems.append(f"size is {existing.get('size')!r}, the manifest says {item.bytes}")
    if existing.get("contentEncoding"):
        problems.append(f"contentEncoding is {existing.get('contentEncoding')!r}; objects are raw bytes")
    return problems


def require_identical(url: str, existing: Mapping[str, Any], item: Upload) -> None:
    problems = identity_problems(existing, item)
    if problems:
        raise PublishError(
            f"refusing to overwrite {url}: {'; '.join(problems)}. Published objects are never replaced "
            "(data store design §3 C6)"
        )


def verify_upload(url: str, stored: Mapping[str, Any] | None, item: Upload) -> None:
    if stored is None:
        raise PublishError(f"{url}: not found right after upload")
    expected = {
        "md5Hash": item.md5_b64,
        "contentType": item.media_type,
        "cacheControl": dr.IMMUTABLE_CACHE_CONTROL,
    }
    problems = identity_problems(stored, item) + [
        f"{field} is {stored.get(field)!r}, expected {value!r}"
        for field, value in expected.items()
        if stored.get(field) != value
    ]
    if problems:
        raise PublishError(
            f"post-upload verification failed for {url}: {'; '.join(problems)}. Inspect it with "
            f"`python scripts/gcloud_repo.py run storage objects describe {url}` and decide with the "
            "owner; it is never overwritten or deleted automatically"
        )


def publish(uploads: Sequence[Upload], bucket: str, gcloud: Gcloud) -> dict[str, int]:
    counts = {"uploaded": 0, "skipped": 0, "planned": 0}
    pending: list[Upload] = []
    for item in uploads:  # every identity is settled before the first upload
        url = f"gs://{bucket}/{item.key}"
        existing = gcloud.describe(describe_args(url))
        if existing is None:
            if item.reused and not gcloud.dry_run:
                raise PublishError(f"{url}: reused from an earlier release but absent from the bucket")
            pending.append(item)
            continue
        require_identical(url, existing, item)
        counts["skipped"] += 1
    for item in pending:  # pending keeps manifest order, so the manifest copy goes last
        outcome = _upload(item, bucket, gcloud)
        counts[outcome] += 1
        print(f"{outcome} {item.key}")
    return counts


def _upload(item: Upload, bucket: str, gcloud: Gcloud) -> str:
    url = f"gs://{bucket}/{item.key}"
    result = gcloud.mutate(upload_args(item, url))
    if result.returncode != 0:
        if not result.precondition_failed:
            raise PublishError(f"upload of {url} failed: {result.stderr.strip()}")
        raced = gcloud.describe(describe_args(url))
        if raced is None:
            raise PublishError(f"{url}: the upload precondition failed but the object is absent")
        require_identical(url, raced, item)
        return "skipped"
    stored = gcloud.describe(describe_args(url))
    if gcloud.dry_run:
        return "planned"
    verify_upload(url, stored, item)
    return "uploaded"


def _bucket(value: str) -> str:
    try:
        return dr.assert_bucket_name(value)
    except dr.DataReleaseError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _newest_manifest() -> Path:
    names = [path.stem for path in RELEASES.glob("*.json")]
    if not names:
        raise PublishError(f"no committed release manifest under {RELEASES}")
    return RELEASES / f"{max(names, key=dr.release_sort_key)}.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Upload a data-store release, never overwriting.")
    parser.add_argument(
        "--bucket",
        type=_bucket,
        default=os.environ.get("GENOMEOS_DATA_BUCKET"),
        help="bucket name (default: $GENOMEOS_DATA_BUCKET; never stored in git)",
    )
    parser.add_argument("--manifest", type=Path, help="default: the newest data/releases/*.json")
    parser.add_argument("--data", type=Path, default=DATA, help="the local data/ tree to upload from")
    parser.add_argument("--dry-run", action="store_true", help="print every gcloud command and run none")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.bucket:
        print("error: pass --bucket or set GENOMEOS_DATA_BUCKET", file=sys.stderr)
        return 2
    try:
        release, uploads = plan(args.manifest or _newest_manifest(), args.data)
        counts = publish(uploads, args.bucket, Gcloud(dry_run=args.dry_run))
    except (PublishError, GcloudError, dr.DataReleaseError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(
        f"release {release}: {len(uploads)} objects, {sum(item.bytes for item in uploads):,} bytes: "
        f"{counts['uploaded']} uploaded, {counts['skipped']} skipped, {counts['planned']} planned"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
