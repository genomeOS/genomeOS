#!/usr/bin/env python3
"""Probe the public data store for browser range reads, anonymously (Atlas data platform design 2026-10-18
§11 step 1.13: the gate "ranged GET 206").

    python scripts/check_data_store_cors.py                       # the newest release's catalog
    python scripts/check_data_store_cors.py --release <YYYY-MM-DD> --path <path>

DuckDB-WASM reads a release's Parquet files and ``catalog/atlas.duckdb`` from a web page by HTTP range
request, so the bucket's CORS (``deploy/data-store-cors.json``, applied by
``scripts/provision_data_store_bucket.py``) must let a page send ``Range`` and read the answer. From the
production origin ``PROBE_ORIGIN`` this sends what a browser sends and requires:

- a preflight (``OPTIONS`` asking for ``GET`` with the ``range`` header): 2xx, allowing ``GET`` and
  ``range``;
- ``GET`` with ``Range: bytes=0-1023``: 206, ``Content-Range: bytes 0-1023/<manifest bytes>``, 1,024 bytes
  (all of an object shorter than that), and ``Access-Control-Expose-Headers`` naming ``Content-Range``
  and ``Accept-Ranges``;
- ``HEAD``: 200 and ``Accept-Ranges: bytes``;

and on each, ``Access-Control-Allow-Origin`` of ``*`` or the origin. Header names compare
case-insensitively, and repeated header lines are joined with ", " as a browser joins them. The object
is the newest committed release's ``catalog/atlas.duckdb``, else its first ``.parquet``, or ``--path``;
its key and byte count come from the manifest, so nothing lists the bucket. The base URL is the
committed one or a loopback mirror (``fetch_data.base_url``). Standard library only, no credentials.

The probe tests the bucket's live CORS, not a cached copy. Google's edge cache keeps a public object for
its ``max-age`` (3600 s) with the CORS headers it was stored under, and GCS's built-in cache offers no
invalidation (docs.cloud.google.com/storage/docs/caching). Anonymous reads on 2026-11-15 (task 28
review) found that the edge ignores a request's ``Cache-Control: no-cache`` (a ``no-cache`` GET came back
with ``Age: 8``) but misses on a URL whose query it has not seen. So each request carries its own
``?probe=<random hex>``, a query GCS ignores. Browsers send no such query: for up to an hour after a
CORS change, a page can still get the old headers for an object fetched in full in the hour before it.
"""

from __future__ import annotations

import argparse
import email.message
import http.client
import sys
import urllib.error
import urllib.request
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.publication import web_layout  # noqa: E402
from scripts import fetch_data as fd  # noqa: E402

RANGE_PROBE_BYTES = 1024
PROBE_ORIGIN = web_layout.PRODUCTION_ORIGINS[0]
CATALOG_PATH = "catalog/atlas.duckdb"
#: What a page must be able to read from a ranged answer.
EXPOSED = ("Content-Range", "Accept-Ranges")
TIMEOUT_S = 30
#: Sent with every request, beside the browser's own headers.
COMMON_HEADERS = {"User-Agent": "genomeos-check-data-store-cors/1"}
#: The query parameter that keeps each request out of the edge cache (module docstring).
CACHE_BUSTER = "probe"
_OPENER = urllib.request.build_opener()


@dataclass(frozen=True)
class Reply:
    status: int  # 0 when no HTTP response arrived
    headers: Mapping[str, str]
    body_length: int  # at most RANGE_PROBE_BYTES + 1: the probe never reads a whole object
    error: str = ""


def _lower(headers: Mapping[str, str]) -> dict[str, str]:
    return {name.lower(): value for name, value in headers.items()}


def _tokens(value: str | None) -> set[str]:
    return {token.strip().lower() for token in (value or "").split(",")}


def preflight_problems(status: int, headers: Mapping[str, str]) -> list[str]:
    """What stops a browser sending the ranged GET; the origin is checked by ``probe``."""
    if not 200 <= status < 300:
        return [f"preflight returned {status}, not 2xx"]
    headers = _lower(headers)
    problems: list[str] = []
    if "get" not in _tokens(headers.get("access-control-allow-methods")):
        problems.append("preflight does not allow GET")
    if "range" not in _tokens(headers.get("access-control-allow-headers")):
        problems.append("preflight does not allow the Range request header")
    return problems


def range_problems(
    status: int, headers: Mapping[str, str], body_length: int, expected_bytes: int
) -> list[str]:
    """What stops a page using the answer to ``Range: bytes=0-<RANGE_PROBE_BYTES - 1>`` on an object of
    ``expected_bytes``; the origin is checked by ``probe``."""
    if status != 206:
        return [f"ranged GET returned {status}, not 206"]
    headers = _lower(headers)
    length = min(RANGE_PROBE_BYTES, expected_bytes)
    expected = f"bytes 0-{length - 1}/{expected_bytes}"
    problems: list[str] = []
    content_range = headers.get("content-range")
    if content_range != expected:
        problems.append(f"Content-Range is {content_range!r}, expected {expected!r}")
    if body_length != length:
        problems.append(f"ranged GET body is {body_length} bytes, expected {length}")
    exposed = _tokens(headers.get("access-control-expose-headers"))
    problems.extend(
        f"Access-Control-Expose-Headers lacks {name}" for name in EXPOSED if name.lower() not in exposed
    )
    return problems


def _origin_problems(what: str, headers: Mapping[str, str], origin: str) -> list[str]:
    allowed = _lower(headers).get("access-control-allow-origin")
    if allowed in ("*", origin):
        return []
    return [f"{what} Access-Control-Allow-Origin is {allowed!r}, expected {origin!r} or '*'"]


def _merged(message: email.message.Message) -> dict[str, str]:
    """Every header line, lowercased by name; a repeated name's values joined in order with ", ", as
    Fetch combines them. ``dict(message.items())`` would keep only the last line, and GCS's edge sends
    ``Access-Control-Expose-Headers`` as one line per name."""
    merged: dict[str, str] = {}
    for name, value in message.items():
        key = name.lower()
        merged[key] = f"{merged[key]}, {value}" if key in merged else value
    return merged


def _send(url: str, method: str, headers: Mapping[str, str]) -> Reply:
    """One request, no retry, and a fresh query so no cache answers it; an HTTP error status is an
    answer, not an exception."""
    fresh = f"{url}?{CACHE_BUSTER}={uuid.uuid4().hex}"  # unique, not reproducible: not a science path
    request = urllib.request.Request(fresh, method=method, headers={**COMMON_HEADERS, **headers})
    try:
        with _OPENER.open(request, timeout=TIMEOUT_S) as response:
            body = response.read(RANGE_PROBE_BYTES + 1) if method == "GET" else b""
            return Reply(response.status, _merged(response.headers), len(body))
    except urllib.error.HTTPError as error:
        reply = Reply(error.code, _merged(error.headers), 0)
        error.close()
        return reply
    except (OSError, http.client.HTTPException) as error:  # refused, DNS, timeout, reset, TLS, truncation
        return Reply(0, {}, 0, repr(error))


def probe(base: str, key: str, expected_bytes: int, *, origin: str) -> list[str]:
    """Every problem a browser on ``origin`` would meet range-reading ``key``; empty when it would not."""
    url = dr.public_url(base, key)
    problems: list[str] = []
    asks = {
        "Origin": origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "range",
    }
    ranged = {"Origin": origin, "Range": f"bytes=0-{RANGE_PROBE_BYTES - 1}"}
    for what, method, headers in (
        ("preflight", "OPTIONS", asks),
        ("ranged GET", "GET", ranged),
        ("HEAD", "HEAD", {"Origin": origin}),
    ):
        reply = _send(url, method, headers)
        if not reply.status:
            problems.append(f"{what} {url} got no HTTP response ({reply.error})")
            continue
        problems.extend(_origin_problems(what, reply.headers, origin))
        if method == "OPTIONS":
            problems.extend(preflight_problems(reply.status, reply.headers))
        elif method == "GET":
            problems.extend(range_problems(reply.status, reply.headers, reply.body_length, expected_bytes))
        elif reply.status != 200:
            problems.append(f"HEAD returned {reply.status}, not 200")
        elif (accepts := _lower(reply.headers).get("accept-ranges")) != "bytes":
            problems.append(f"HEAD Accept-Ranges is {accepts!r}, expected 'bytes'")
    return problems


def _target(objects: Sequence[dr.ReleaseObject], path: str | None) -> dr.ReleaseObject | None:
    """``path``'s object, else the release's catalog, else its first ``.parquet`` in path order."""
    if path is None:
        paths = [item.path for item in objects]
        parquet = (name for name in paths if name.endswith(".parquet"))
        path = CATALOG_PATH if CATALOG_PATH in paths else next(parquet, None)
    return next((item for item in objects if item.path == path), None)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Probe the data store's CORS for browser range reads.")
    parser.add_argument(
        "--path", help=f"a path the release lists (default: {CATALOG_PATH}, else its first .parquet)"
    )
    parser.add_argument(
        "--base-url", help=f"default: the committed {dr.DATA_STORE_BASE_URL} (or ${dr.BASE_URL_VARIABLE})"
    )
    parser.add_argument("--release", help="release id (default: the newest committed manifest)")
    parser.add_argument("--releases", type=Path, default=fd.RELEASES, help=argparse.SUPPRESS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        base = fd.base_url(args.base_url)
        manifest, objects = fd.load_release(args.release, args.releases)
    except (fd.FetchError, OSError, ValueError) as error:  # ValueError: a DataReleaseError or bad JSON
        print(f"error: {error}", file=sys.stderr)
        return 1
    item = _target(objects, args.path)
    if item is None:
        wanted = args.path or f"{CATALOG_PATH} or a .parquet file"
        print(f"error: {wanted} is not in release {manifest['release']}", file=sys.stderr)
        return 1
    problems = probe(base, item.key, item.bytes, origin=PROBE_ORIGIN)
    if problems:
        for problem in problems:
            print(f"FAIL {item.key}: {problem}")
        print(
            f"FAILED: {len(problems)} problem(s); a browser on {PROBE_ORIGIN} cannot range-read {item.key}. "
            "The bucket's CORS is deploy/data-store-cors.json, applied by "
            "scripts/provision_data_store_bucket.py.",
            file=sys.stderr,
        )
        return 1
    print(
        f"ok: {item.key} answers {PROBE_ORIGIN}: preflight allows Range, ranged GET 206 "
        f"bytes 0-{min(RANGE_PROBE_BYTES, item.bytes) - 1}/{item.bytes}, HEAD Accept-Ranges: bytes"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
