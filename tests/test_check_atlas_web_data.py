"""Deploy gate for the published Atlas web data (design 2026-10-07 §C.1.5)."""

from __future__ import annotations

import gzip
import hashlib
import json
import threading
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest

from genomeos.publication.web_layout import IMMUTABLE_CACHE_CONTROL, PRODUCTION_ORIGINS
from scripts import check_atlas_web_data as gate
from tests.atlas_web_fixtures import GNOMAD_KEY, object_bytes, staged_catalog, write_dist

BUCKET = "example-bucket"


@dataclass
class FakeBucket:
    """storage.googleapis.com in miniature: path-style object reads plus the JSON metadata API."""

    objects: dict[str, bytes]  # catalog key -> decoded bytes
    allowed_origins: set[str] = field(default_factory=lambda: set(PRODUCTION_ORIGINS))
    headers: dict[str, dict[str, str | None]] = field(default_factory=dict)  # key -> overrides; None drops
    metadata: dict[str, dict[str, str]] = field(default_factory=dict)  # key -> custom-metadata overrides
    bodies: dict[str, bytes] = field(default_factory=dict)  # key -> stored gzip body override
    missing: set[str] = field(default_factory=set)
    unavailable_once: set[str] = field(default_factory=set)  # first request answers 503

    def key_for(self, name: str) -> str | None:
        prefix = "atlas/web/"
        key = name[len(prefix) :] if name.startswith(prefix) else None
        return key if key in self.objects and key not in self.missing else None

    def stored(self, key: str) -> bytes:
        return self.bodies.get(key, gzip.compress(self.objects[key], compresslevel=9, mtime=0))


def _handler(bucket: FakeBucket) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

        def do_HEAD(self) -> None:
            self._object(send_body=False)

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            api = f"/storage/v1/b/{BUCKET}/o/"
            if path.startswith(api):
                self._metadata(unquote(path[len(api) :]))
            else:
                self._object(send_body=True)

        def _reply(self, status: int, headers: dict[str, str | None], body: bytes, length: int) -> None:
            self.send_response(status)
            for name, value in headers.items():
                if value is not None:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(length))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _object(self, *, send_body: bool) -> None:
            path = unquote(urlsplit(self.path).path)
            prefix = f"/{BUCKET}/"
            key = bucket.key_for(path[len(prefix) :]) if path.startswith(prefix) else None
            if key is None:
                self._reply(404, {}, b"", 0)
                return
            if key in bucket.unavailable_once:
                bucket.unavailable_once.discard(key)
                self._reply(503, {}, b"", 0)
                return
            stored = bucket.stored(key)
            accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
            body = stored if accepts_gzip else gzip.decompress(stored)
            headers: dict[str, str | None] = {
                "Cache-Control": IMMUTABLE_CACHE_CONTROL,
                "Content-Type": "application/octet-stream" if key.endswith(".gosa") else "application/json",
                "Content-Encoding": "gzip" if accepts_gzip else None,
                "Vary": "Origin",
                "x-goog-meta-sha256": hashlib.sha256(bucket.objects[key]).hexdigest(),
            }
            origin = self.headers.get("Origin")
            if origin is not None and origin in bucket.allowed_origins:
                headers["Access-Control-Allow-Origin"] = origin
            headers.update(bucket.headers.get(key, {}))
            self._reply(200, headers, body if send_body else b"", len(body))

        def _metadata(self, name: str) -> None:
            key = bucket.key_for(name)
            if key is None:
                body = b'{"error":{"code":404}}'
                self._reply(404, {"Content-Type": "application/json"}, body, len(body))
                return
            overrides = bucket.headers.get(key, {})
            resource = {
                "size": str(len(bucket.stored(key))),
                "contentEncoding": overrides.get("Content-Encoding", "gzip"),
                "cacheControl": overrides.get("Cache-Control", IMMUTABLE_CACHE_CONTROL),
                "crc32c": "AAAAAA==",
                "metadata": {
                    "sha256": hashlib.sha256(bucket.objects[key]).hexdigest(),
                    "decoded-bytes": str(len(bucket.objects[key])),
                    **bucket.metadata.get(key, {}),
                },
            }
            body = json.dumps(resource).encode()
            self._reply(200, {"Content-Type": "application/json"}, body, len(body))

    return Handler


@dataclass(frozen=True)
class Served:
    bucket: FakeBucket
    base: str
    api_root: str


@pytest.fixture(autouse=True)
def _no_proxies(monkeypatch: pytest.MonkeyPatch) -> None:
    """The fake bucket is on 127.0.0.1; never route test requests through an environment proxy."""
    monkeypatch.setattr(gate, "_OPENER", urllib.request.build_opener(urllib.request.ProxyHandler({})))
    monkeypatch.setattr(gate, "RETRY_DELAY_SECONDS", 0.0)


@pytest.fixture()
def served() -> Iterator[Served]:
    fake = FakeBucket(objects=object_bytes(staged_catalog()))
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(fake))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = f"http://127.0.0.1:{server.server_address[1]}/"
    try:
        yield Served(fake, f"{root}{BUCKET}/atlas/web/", f"{root}storage/v1/")
    finally:
        server.shutdown()
        server.server_close()


def _run(
    served: Served, tmp_path: Path, *extra: str, base: str | None = None, dist: Path | None = None
) -> int:
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps(staged_catalog()), encoding="utf-8")
    site = write_dist(tmp_path / "dist", served.base) if dist is None else dist
    return gate.main(
        [
            "--catalog",
            str(catalog_path),
            "--base",
            served.base if base is None else base,
            "--bucket",
            BUCKET,
            "--dist",
            str(site),
            "--api-root",
            served.api_root,
            *extra,
        ]
    )


def test_a_correctly_published_bucket_passes_without_comparing_content_length(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert _run(served, tmp_path, "--production") == 0
    assert (
        capsys.readouterr().out.strip()
        == "ok: 6 artifact objects x 4 origins, 3 checked end to end, 2 site files"
    )
    render = staged_catalog()["artifacts"][0]["web"]["render"]["url"]
    assert len(served.bucket.stored(render)) != len(served.bucket.objects[render])  # CL is the gzip size


@pytest.mark.parametrize(
    "base",
    [
        "",
        "/data/atlas/",
        "https://storage.googleapis.com/example-bucket/atlas/web",
        "http://127.0.0.1:9/example-bucket/elsewhere/",
    ],
)
def test_an_empty_relative_or_malformed_base_fails(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str], base: str
) -> None:
    assert _run(served, tmp_path, base=base) == 1
    assert capsys.readouterr().out.startswith("FAIL ")


def test_an_edge_base_must_name_the_checked_bucket(tmp_path: Path) -> None:
    base = "https://storage.googleapis.com/example-other/atlas/web/"
    problems = gate.run_checks(staged_catalog(), base=base, bucket=BUCKET, dist=tmp_path, production=False)
    assert problems == [
        f"artifact base {base!r} does not serve bucket 'example-bucket' "
        "(expected https://storage.googleapis.com/example-bucket/atlas/web/)"
    ]


def test_a_production_build_that_did_not_bake_the_base_fails(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    dist = write_dist(tmp_path / "same-origin", "/data/atlas/")
    assert _run(served, tmp_path, "--production", dist=dist) == 1
    assert "bakes artifact base '/data/atlas/'" in capsys.readouterr().out
    assert _run(served, tmp_path, dist=dist) == 0  # validate builds never bake the bucket base (§C.1.4)


def test_a_production_build_that_inlines_another_catalog_fails(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # The browser fetches the keys of the catalog dist inlines, so checking a different --catalog
    # would pass a build whose objects are not in the bucket.
    other = {**staged_catalog(), "artifacts": []}
    dist = write_dist(tmp_path / "other-catalog", served.base, catalog=other)
    assert _run(served, tmp_path, "--production", dist=dist) == 1
    assert "inlines a catalog that differs from --catalog" in capsys.readouterr().out
    assert _run(served, tmp_path, dist=dist) == 0  # only the production build job checks it


@pytest.mark.parametrize(
    ("header", "value", "message"),
    [
        ("Content-Encoding", None, "Content-Encoding None, expected 'gzip'"),
        ("Cache-Control", "public, max-age=600", "Cache-Control 'public, max-age=600'"),
    ],
)
def test_transport_headers_are_required_on_every_object(
    served: Served,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    header: str,
    value: str | None,
    message: str,
) -> None:
    key = next(iter(served.bucket.objects))  # the manifest download: not on the critical path
    served.bucket.headers[key] = {header: value}
    assert _run(served, tmp_path) == 1
    out = capsys.readouterr().out
    assert f"FAIL {key} (Origin https://genome-os.org): {message}" in out


def test_every_production_origin_needs_a_cors_grant(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    served.bucket.allowed_origins.discard("http://genome-os.org")
    assert _run(served, tmp_path) == 1
    out = capsys.readouterr().out
    assert "(Origin http://genome-os.org): Access-Control-Allow-Origin None" in out
    assert "(Origin https://genome-os.org): Access-Control-Allow-Origin" not in out


def test_metadata_must_carry_the_catalog_digest(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    key = next(iter(served.bucket.objects))
    served.bucket.metadata[key] = {"sha256": "0" * 64}
    assert _run(served, tmp_path) == 1
    assert f"FAIL {key}: metadata sha256 '{'0' * 64}'" in capsys.readouterr().out


def test_decoded_bytes_are_checked_only_where_the_catalog_declares_them(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    ref = staged_catalog()["artifacts"][0]
    served.bucket.metadata[ref["downloads"]["manifest"]["url"]] = {
        "decoded-bytes": "1"
    }  # undeclared: ignored
    assert _run(served, tmp_path) == 0
    served.bucket.metadata[ref["web"]["render"]["url"]] = {"decoded-bytes": "1"}
    assert _run(served, tmp_path) == 1
    assert f"FAIL {ref['web']['render']['url']}: metadata decoded-bytes '1'" in capsys.readouterr().out


def test_the_default_artifact_is_checked_end_to_end(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    render = staged_catalog()["artifacts"][0]["web"]["render"]["url"]
    served.bucket.bodies[render] = gzip.compress(b"not the render tier", mtime=0)
    assert _run(served, tmp_path) == 1
    assert f"FAIL {render}: decoded sha256" in capsys.readouterr().out


def test_a_missing_object_fails(served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    key = staged_catalog()["artifacts"][0]["surface_url"]
    served.bucket.missing.add(key)
    assert _run(served, tmp_path) == 1
    out = capsys.readouterr().out
    assert f"FAIL {key} (Origin https://genome-os.org): HEAD" in out and "returned 404" in out
    assert f"FAIL {key}: JSON API returned 404" in out


def test_a_transient_server_error_is_retried(served: Served, tmp_path: Path) -> None:
    served.bucket.unavailable_once.add(next(iter(served.bucket.objects)))
    assert _run(served, tmp_path) == 0


def test_site_base_files_must_be_in_the_built_site(
    served: Served, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    dist = write_dist(tmp_path / "site", served.base)
    (dist / "data" / "atlas" / "ne-50m-admin-0.geojson").unlink()
    (dist / "data" / "atlas" / GNOMAD_KEY).write_bytes(b"changed")
    assert _run(served, tmp_path, dist=dist) == 1
    out = capsys.readouterr().out
    assert "FAIL site-base ne-50m-admin-0.geojson: missing" in out
    assert f"FAIL site-base {GNOMAD_KEY}: sha256" in out
