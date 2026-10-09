#!/usr/bin/env python3
"""Deploy gate for the Atlas web data in the public bucket (fast-load/GCS design 2026-10-07 §C.1.5).

Fails when the artifact base is empty or not absolute. For every artifact-base key in the catalog
(``grids.*.url``, ``web.render.url``, ``web.detail.url``, ``surface_url``, ``observations_url``,
``downloads.*.url``) it sends HEAD with ``Accept-Encoding: gzip`` and an ``Origin`` for each
production origin and requires 200, ``Content-Encoding: gzip``, the immutable ``Cache-Control`` and
``Access-Control-Allow-Origin`` echoing the origin or ``*``. From the public JSON API
(``storage/v1/b/<bucket>/o/<object>?fields=size,contentEncoding,cacheControl,metadata,crc32c``,
anonymous) it requires metadata ``sha256`` equal to the catalog digest and ``decoded-bytes`` equal to
the declared decoded size where one is declared. It never compares ``Content-Length`` with decoded
bytes: GCS reports the stored gzip size. It GETs, gunzips and sha256-checks the default artifact's
grid, render tier and observations, and checks that every site-base key (Natural Earth context and
external caches) exists in ``dist/``. ``--production`` (the Pages ``build`` job) also requires
``dist/app/index.html`` to bake exactly ``--base`` and to inline exactly ``--catalog``: the browser
fetches the inlined catalog's keys, so checking any other catalog proves nothing about the build.

Metadata is what the publisher asserts; it is trusted only because keys are content-addressed,
uploads refuse overwrite and publishing verifies the uploaded bytes (scripts/publish_atlas_web.py).
Standard library only, so CI needs no install.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
import zlib
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication.web_layout import (  # noqa: E402
    IMMUTABLE_CACHE_CONTROL,
    OBJECT_PREFIX,
    PRODUCTION_ORIGINS,
    WebLayoutError,
    WebObject,
    artifact_objects,
    assert_absolute_data_base,
    assert_bucket_name,
    critical_objects,
    object_name,
    resolve_key,
    site_objects,
)

JSON_API_ROOT = "https://storage.googleapis.com/storage/v1/"
METADATA_FIELDS = "size,contentEncoding,cacheControl,metadata,crc32c"
TIMEOUT_SECONDS = 30
ATTEMPTS = 3
RETRY_DELAY_SECONDS = 1.0
WORKERS = 8
_DATA_BASES = re.compile(r'<script[^>]*\bid="atlas-data-bases"[^>]*>([^<]*)</script>')
# The build escapes every `<` in the inline catalog (escapeInlineJson), so `[^<]*` spans all of it.
_INLINE_CATALOG = re.compile(r'<script[^>]*\bid="atlas-catalog"[^>]*>([^<]*)</script>')
_OPENER = urllib.request.build_opener()


@dataclass(frozen=True)
class Reply:
    status: int  # 0 when no HTTP response arrived
    headers: Mapping[str, str]  # lower-cased names
    body: bytes


def _lower(items: Iterable[tuple[str, str]]) -> dict[str, str]:
    return {name.lower(): value for name, value in items}


def fetch(url: str, *, method: str = "GET", headers: Mapping[str, str] | None = None) -> Reply:
    """One request, retried on 5xx and connection errors; a 4xx is an answer, not an error."""
    request = urllib.request.Request(url, method=method, headers=dict(headers or {}))
    reply = Reply(0, {}, b"")
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(RETRY_DELAY_SECONDS * attempt)
        try:
            with _OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:
                return Reply(response.status, _lower(response.headers.items()), response.read())
        except urllib.error.HTTPError as error:
            reply = Reply(error.code, _lower(error.headers.items()), error.read())
            if error.code < 500:
                return reply
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            reply = Reply(0, {}, str(error).encode())
    return reply


def check_serving(item: WebObject, base: str, origins: Sequence[str]) -> list[str]:
    url = resolve_key(item.key, base)
    problems: list[str] = []
    for origin in origins:
        where = f"{item.key} (Origin {origin})"
        reply = fetch(url, method="HEAD", headers={"Accept-Encoding": "gzip", "Origin": origin})
        if reply.status != 200:
            problems.append(f"{where}: HEAD {url} returned {reply.status}")
            continue
        encoding = reply.headers.get("content-encoding")
        if encoding != "gzip":
            problems.append(f"{where}: Content-Encoding {encoding!r}, expected 'gzip'")
        cache = reply.headers.get("cache-control")
        if cache != IMMUTABLE_CACHE_CONTROL:
            problems.append(f"{where}: Cache-Control {cache!r}, expected {IMMUTABLE_CACHE_CONTROL!r}")
        allowed = reply.headers.get("access-control-allow-origin")
        if allowed not in (origin, "*"):
            problems.append(f"{where}: Access-Control-Allow-Origin {allowed!r}, expected {origin!r} or '*'")
    return problems


def check_metadata(item: WebObject, bucket: str, api_root: str) -> list[str]:
    name = quote(object_name(item.key), safe="")
    url = f"{api_root}b/{quote(bucket, safe='')}/o/{name}?fields={METADATA_FIELDS}"
    reply = fetch(url, headers={"Accept-Encoding": "identity"})
    if reply.status != 200:
        return [f"{item.key}: JSON API returned {reply.status}"]
    try:
        resource: Any = json.loads(reply.body)
    except json.JSONDecodeError:
        return [f"{item.key}: JSON API returned a body that is not JSON"]
    metadata = resource.get("metadata") or {}
    problems: list[str] = []
    if metadata.get("sha256") != item.sha256:
        problems.append(f"{item.key}: metadata sha256 {metadata.get('sha256')!r}, catalog {item.sha256}")
    if item.decoded_bytes is not None and metadata.get("decoded-bytes") != str(item.decoded_bytes):
        problems.append(
            f"{item.key}: metadata decoded-bytes {metadata.get('decoded-bytes')!r}, "
            f"catalog declares {item.decoded_bytes}"
        )
    if resource.get("contentEncoding") != "gzip":
        problems.append(
            f"{item.key}: stored contentEncoding {resource.get('contentEncoding')!r}, expected 'gzip'"
        )
    if resource.get("cacheControl") != IMMUTABLE_CACHE_CONTROL:
        problems.append(f"{item.key}: stored cacheControl {resource.get('cacheControl')!r}")
    return problems


def check_end_to_end(item: WebObject, base: str) -> list[str]:
    url = resolve_key(item.key, base)
    reply = fetch(url, headers={"Accept-Encoding": "gzip", "Origin": PRODUCTION_ORIGINS[0]})
    if reply.status != 200:
        return [f"{item.key}: GET {url} returned {reply.status}"]
    if reply.headers.get("content-encoding") != "gzip":
        return [
            f"{item.key}: GET Content-Encoding {reply.headers.get('content-encoding')!r}, expected 'gzip'"
        ]
    try:
        data = gzip.decompress(reply.body)
    except (OSError, EOFError, zlib.error) as error:
        return [f"{item.key}: GET body is not gzip ({error})"]
    problems: list[str] = []
    digest = hashlib.sha256(data).hexdigest()
    if digest != item.sha256:
        problems.append(f"{item.key}: decoded sha256 {digest}, catalog {item.sha256}")
    if item.decoded_bytes is not None and len(data) != item.decoded_bytes:
        problems.append(f"{item.key}: decoded {len(data)} bytes, catalog declares {item.decoded_bytes}")
    return problems


def check_site(dist: Path, catalog: Mapping[str, Any]) -> list[str]:
    site = dist / "data" / "atlas"
    problems: list[str] = []
    for item in site_objects(catalog):
        path = site / item.key
        if not path.is_file():
            problems.append(f"site-base {item.key}: missing from {site}")
            continue
        if item.sha256 is not None:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != item.sha256:
                problems.append(f"site-base {item.key}: sha256 {digest}, catalog {item.sha256}")
    return problems


def baked_artifact_base(dist: Path) -> str | None:
    path = dist / "app" / "index.html"
    if not path.is_file():
        return None
    match = _DATA_BASES.search(path.read_text(encoding="utf-8"))
    return None if match is None else str(json.loads(match.group(1))["artifact"])


def inlined_catalog(dist: Path) -> Any:
    """The catalog dist/app/index.html inlines (what the browser fetches by), or None."""
    path = dist / "app" / "index.html"
    if not path.is_file():
        return None
    match = _INLINE_CATALOG.search(path.read_text(encoding="utf-8"))
    return None if match is None else json.loads(match.group(1))


def run_checks(
    catalog: Mapping[str, Any],
    *,
    base: str,
    bucket: str,
    dist: Path,
    production: bool,
    api_root: str = JSON_API_ROOT,
    origins: Sequence[str] = PRODUCTION_ORIGINS,
) -> list[str]:
    try:
        assert_absolute_data_base(base)
        assert_bucket_name(bucket)
    except WebLayoutError as error:
        return [str(error)]
    if not base.endswith(f"/{OBJECT_PREFIX}"):
        return [f"artifact base {base!r} must end in /{OBJECT_PREFIX}, the prefix the metadata check reads"]
    parts = urlsplit(base)
    if parts.hostname == "storage.googleapis.com" and parts.path != f"/{bucket}/{OBJECT_PREFIX}":
        return [
            f"artifact base {base!r} does not serve bucket {bucket!r} "
            f"(expected https://storage.googleapis.com/{bucket}/{OBJECT_PREFIX})"
        ]
    problems: list[str] = []
    if production:
        baked = baked_artifact_base(dist)
        if baked != base:
            problems.append(
                f"dist/app/index.html bakes artifact base {baked!r}, not {base!r}: the production build ran "
                "without PUBLIC_ATLAS_DATA_BASE_URL"
            )
        if inlined_catalog(dist) != catalog:
            problems.append(
                "dist/app/index.html inlines a catalog that differs from --catalog: the browser fetches "
                "the inlined catalog's keys, so build with ATLAS_CATALOG_PATH set to the checked catalog"
            )
    objects = artifact_objects(catalog)
    critical = critical_objects(catalog)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        serving = list(pool.map(lambda item: check_serving(item, base, origins), objects))
        metadata = list(pool.map(lambda item: check_metadata(item, bucket, api_root), objects))
        end_to_end = list(pool.map(lambda item: check_end_to_end(item, base), critical))
    for found in [*serving, *metadata, *end_to_end]:
        problems.extend(found)
    problems.extend(check_site(dist, catalog))
    return problems


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Refuse a deploy whose Atlas web data is not published correctly."
    )
    parser.add_argument("--catalog", type=Path, required=True, help="the catalog the site inlines")
    parser.add_argument(
        "--base", required=True, help="PUBLIC_ATLAS_DATA_BASE_URL (absolute, ends in atlas/web/)"
    )
    parser.add_argument("--bucket", required=True, help="the ATLAS_DATA_BUCKET value")
    parser.add_argument("--dist", type=Path, required=True, help="the built site")
    parser.add_argument(
        "--production",
        action="store_true",
        help="also require dist to bake --base and to inline exactly --catalog (build job)",
    )
    parser.add_argument("--api-root", default=JSON_API_ROOT, help=argparse.SUPPRESS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
        problems = run_checks(
            catalog,
            base=args.base,
            bucket=args.bucket,
            dist=args.dist,
            production=args.production,
            api_root=args.api_root,
        )
    except (OSError, json.JSONDecodeError, KeyError, WebLayoutError) as error:
        problems = [f"cannot check {args.catalog}: {error!r}"]
        catalog = {}
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        print(
            f"FAILED: {len(problems)} problem(s); do not deploy until the bucket serves every object the "
            "catalog names (design 2026-10-07 §C.1.5)",
            file=sys.stderr,
        )
        return 1
    print(
        f"ok: {len(artifact_objects(catalog))} artifact objects x {len(PRODUCTION_ORIGINS)} origins, "
        f"{len(critical_objects(catalog))} checked end to end, {len(site_objects(catalog))} site files"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
