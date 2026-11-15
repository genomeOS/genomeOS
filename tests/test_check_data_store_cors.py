"""The anonymous probe of the data store's CORS for browser range reads (Atlas data platform design
2026-10-18 §11 step 1.13).

A loopback server stands in for the bucket and applies a CORS document the way GCS's XML API does: a
preflight or a read from a matching origin gets ``Access-Control-Allow-Origin``; ``responseHeader`` is
both the preflight's ``Access-Control-Allow-Headers`` and the read's ``Access-Control-Expose-Headers``;
and a preflight asking for a method or a request header the document lacks gets 200 with no CORS headers.
It starts from the committed ``deploy/data-store-cors.json``. No network, no GCP.

Two behaviours of Google's edge cache in front of the bucket were observed live on 2026-11-15 (anonymous
reads, task 28 review) and are modelled here. A copy the edge filled from a request without ``Origin``
sends ``Access-Control-Expose-Headers`` as one line per ``responseHeader`` entry (``split_expose``). And
the edge answers a GET or HEAD of a URL it holds from that copy, with the CORS headers it was stored
under, ignoring the request's ``Cache-Control: no-cache``, while a URL with a query string it has not
seen misses the cache (``edge_copy``).
"""

from __future__ import annotations

import copy
import http.client
import io
import json
import re
import threading
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import pytest

from genomeos.publication import data_release as dr
from scripts import check_data_store_cors as cors
from scripts import provision_data_store_bucket as provision
from tests.test_fetch_data import _publish
from tests.test_provision_data_store_bucket import OLD_POLICY

RELEASE = "2026-10-17"
NEWER = "2026-10-18"
KEY = f"releases/{RELEASE}/catalog/atlas.duckdb"
OBJECT = bytes(range(256)) * 16  # 4,096 bytes
CATALOG = "catalog/atlas.duckdb"
CELLS = "store/artifacts/x__v3__map-2026-08/cells.parquet"
TABLE = "tables/v1/inferred/artifacts/artifacts.parquet"
NOT_ALLOWED = "Access-Control-Allow-Origin is None, expected 'https://genome-os.org' or '*'"
Capsys = pytest.CaptureFixture[str]


@dataclass
class FakeStore:
    """The bucket in miniature: objects under ``root/<key>``, served under ``cors``."""

    root: Path
    cors: list[dict[str, Any]]
    honours_range: bool = True
    #: Send Access-Control-Expose-Headers as one header line per responseHeader entry.
    split_expose: bool = False
    #: The CORS an edge copy stored before a change carries; it answers a GET or HEAD of a bare URL.
    edge_copy: list[dict[str, Any]] | None = None
    requests: list[dict[str, str | None]] = field(default_factory=list)

    def rule(
        self, origin: str | None, method: str | None, cors: list[dict[str, Any]] | None = None
    ) -> dict[str, Any] | None:
        for rule in self.cors if cors is None else cors:
            if origin and ("*" in rule["origin"] or origin in rule["origin"]) and method in rule["method"]:
                return rule
        return None


def _handler(store: FakeStore) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
            return

        def _log(self) -> None:
            names = (
                "Origin",
                "Range",
                "Cache-Control",
                "Access-Control-Request-Method",
                "Access-Control-Request-Headers",
            )
            parts = urlsplit(self.path)
            entry = {"method": self.command, "path": unquote(parts.path), "query": parts.query}
            store.requests.append(entry | {name: self.headers.get(name) for name in names})

        def _reply(
            self, status: int, headers: Mapping[str, str | list[str]], body: bytes, length: int
        ) -> None:
            self.send_response(status)
            for name, value in headers.items():
                for line in [value] if isinstance(value, str) else value:  # a list: one line each
                    self.send_header(name, line)
            self.send_header("Content-Length", str(length))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _allow(self, rule: dict[str, Any]) -> dict[str, str]:
            origin = self.headers["Origin"]
            return {"Access-Control-Allow-Origin": "*" if "*" in rule["origin"] else origin}

        def do_OPTIONS(self) -> None:
            self._log()
            rule = store.rule(self.headers.get("Origin"), self.headers.get("Access-Control-Request-Method"))
            asked = {
                name.strip().lower()
                for name in (self.headers.get("Access-Control-Request-Headers") or "").split(",")
                if name.strip()
            }
            headers: dict[str, str] = {}
            if rule is not None and asked <= {name.lower() for name in rule["responseHeader"]}:
                headers = self._allow(rule) | {
                    "Access-Control-Allow-Methods": ", ".join(rule["method"]),
                    "Access-Control-Allow-Headers": ", ".join(rule["responseHeader"]),
                    "Access-Control-Max-Age": str(rule["maxAgeSeconds"]),
                }
            self._reply(200, headers, b"", 0)

        def do_HEAD(self) -> None:
            self._object(send_body=False)

        def do_GET(self) -> None:
            self._object(send_body=True)

        def _object(self, *, send_body: bool) -> None:
            self._log()
            path = store.root / unquote(urlsplit(self.path).path).lstrip("/")
            if not path.is_file():
                self._reply(404, {}, b"", 0)
                return
            data = path.read_bytes()
            headers: dict[str, str | list[str]] = {
                "Accept-Ranges": "bytes",
                "Content-Type": "application/octet-stream",
            }
            from_edge = store.edge_copy is not None and not urlsplit(self.path).query
            cors_now = store.edge_copy if from_edge else None
            rule = store.rule(self.headers.get("Origin"), self.command, cors_now)
            if rule is not None:
                headers |= self._allow(rule)
                exposed = list(rule["responseHeader"])
                split = store.split_expose or from_edge
                headers["Access-Control-Expose-Headers"] = exposed if split else ", ".join(exposed)
            status = 200
            requested = self.headers.get("Range")
            if requested and store.honours_range:
                first, last = (int(n) for n in requested.removeprefix("bytes=").split("-"))
                last = min(last, len(data) - 1)
                headers["Content-Range"] = f"bytes {first}-{last}/{len(data)}"
                status, data = 206, data[first : last + 1]
            self._reply(status, headers, data if send_body else b"", len(data))

    return Handler


class _LoopbackOnly:
    """The probe's opener in tests: the fake bucket is on 127.0.0.1, so a request anywhere else is a
    regression and fails the test instead of reaching GCS."""

    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # no env proxy

    def open(self, request: urllib.request.Request, timeout: float) -> object:
        if urlsplit(request.full_url).hostname != "127.0.0.1":
            raise AssertionError(f"the probe tried to reach {request.full_url}; tests stay on loopback")
        return self._opener.open(request, timeout=timeout)


@pytest.fixture(autouse=True)
def _loopback_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cors, "_OPENER", _LoopbackOnly())


@dataclass(frozen=True)
class Served:
    store: FakeStore
    base: str


@pytest.fixture()
def served(tmp_path: Path) -> Iterator[Served]:
    committed = json.loads((provision.ROOT / provision.CORS_FILE).read_text(encoding="utf-8"))
    store = FakeStore(root=tmp_path / "bucket", cors=committed)
    (store.root / KEY).parent.mkdir(parents=True)
    (store.root / KEY).write_bytes(OBJECT)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(store))
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield Served(store, f"http://127.0.0.1:{server.server_address[1]}/")
    finally:
        server.shutdown()
        server.server_close()


def _without(header: str) -> Callable[[FakeStore], None]:
    def mutate(store: FakeStore) -> None:
        store.cors = copy.deepcopy(store.cors)
        for rule in store.cors:
            rule["responseHeader"].remove(header)

    return mutate


def _ignore_range(store: FakeStore) -> None:
    store.honours_range = False


def _short(store: FakeStore) -> None:
    (store.root / KEY).write_bytes(OBJECT[:4000])


def _split_expose(store: FakeStore) -> None:
    store.split_expose = True


def _split_and_without_content_range(store: FakeStore) -> None:
    _split_expose(store)
    _without("Content-Range")(store)


def _edge_copy_from_before_the_change(store: FakeStore) -> None:
    store.edge_copy = OLD_POLICY


@pytest.mark.parametrize(
    ("defect", "expected"),
    [
        pytest.param(lambda store: None, [], id="good"),
        # A browser joins repeated header lines with ", ", so one line per name exposes them all.
        pytest.param(_split_expose, [], id="good-one-expose-line-per-header"),
        pytest.param(
            _split_and_without_content_range,
            ["Access-Control-Expose-Headers lacks Content-Range"],
            id="one-expose-line-per-header-hides-content-range",
        ),
        # The probe reports the bucket's live CORS, not a copy the edge stored before the change.
        pytest.param(_edge_copy_from_before_the_change, [], id="stale-edge-copy"),
        pytest.param(_ignore_range, ["ranged GET returned 200, not 206"], id="ignores-range"),
        pytest.param(
            _without("Content-Range"),
            ["Access-Control-Expose-Headers lacks Content-Range"],
            id="hides-content-range",
        ),
        pytest.param(
            _short, ["Content-Range is 'bytes 0-1023/4000', expected 'bytes 0-1023/4096'"], id="wrong-total"
        ),
        pytest.param(
            _without("Range"),
            [
                f"preflight {NOT_ALLOWED}",
                "preflight does not allow GET",
                "preflight does not allow the Range request header",
            ],
            id="refused-preflight",
        ),
    ],
)
def test_probe_against_loopback_buckets(
    defect: Callable[[FakeStore], None], expected: list[str], served: Served
) -> None:
    defect(served.store)
    assert cors.probe(served.base, KEY, len(OBJECT), origin=cors.PROBE_ORIGIN) == expected


def test_the_probe_sends_what_a_browser_sends(served: Served) -> None:
    """Plus a query of its own on each request, so no cache in front of the bucket holds the URL."""
    assert cors.probe(served.base, KEY, len(OBJECT), origin=cors.PROBE_ORIGIN) == []
    queries = [request.pop("query") for request in served.store.requests]
    assert all(re.fullmatch(r"probe=[0-9a-f]{32}", query or "") for query in queries), queries
    assert len(set(queries)) == len(queries) == 3
    origin = "https://genome-os.org"
    path = f"/{KEY}"
    assert served.store.requests == [
        {
            "method": "OPTIONS",
            "path": path,
            "Origin": origin,
            "Range": None,
            "Cache-Control": None,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "range",
        },
        {
            "method": "GET",
            "path": path,
            "Origin": origin,
            "Range": "bytes=0-1023",
            "Cache-Control": None,
            "Access-Control-Request-Method": None,
            "Access-Control-Request-Headers": None,
        },
        {
            "method": "HEAD",
            "path": path,
            "Origin": origin,
            "Range": None,
            "Cache-Control": None,
            "Access-Control-Request-Method": None,
            "Access-Control-Request-Headers": None,
        },
    ]


def test_repeated_header_lines_merge_as_a_browser_merges() -> None:
    """Fetch's header-list combine: every line of a repeated name, in order, joined with ", "."""
    raw = (
        b"Access-Control-Expose-Headers: Content-Range\r\n"
        b"Access-Control-Allow-Origin: *\r\n"
        b"access-control-expose-headers: Accept-Ranges\r\n"
        b"Access-Control-Expose-Headers: Range\r\n\r\n"
    )
    assert cors._merged(http.client.parse_headers(io.BytesIO(raw))) == {
        "access-control-expose-headers": "Content-Range, Accept-Ranges, Range",
        "access-control-allow-origin": "*",
    }


def test_a_bucket_closed_to_the_origin_fails_every_request(served: Served) -> None:
    served.store.cors = [dict(served.store.cors[0], origin=["https://example.org"])]
    assert cors.probe(served.base, KEY, len(OBJECT), origin=cors.PROBE_ORIGIN) == [
        f"preflight {NOT_ALLOWED}",
        "preflight does not allow GET",
        "preflight does not allow the Range request header",
        f"ranged GET {NOT_ALLOWED}",
        "Access-Control-Expose-Headers lacks Content-Range",
        "Access-Control-Expose-Headers lacks Accept-Ranges",
        f"HEAD {NOT_ALLOWED}",
    ]


def test_a_short_object_answers_with_its_whole_length() -> None:
    """An object under RANGE_PROBE_BYTES is still range-read: GCS answers 206 with all of its bytes."""
    exposed = {"Access-Control-Expose-Headers": "Content-Range, Accept-Ranges"}
    assert cors.range_problems(206, exposed | {"Content-Range": "bytes 0-99/100"}, 100, 100) == []
    assert cors.range_problems(206, exposed | {"Content-Range": "bytes 0-99/100"}, 99, 100) == [
        "ranged GET body is 99 bytes, expected 100"
    ]


def _releases(tmp_path: Path, served: Served, newer: dict[str, bytes]) -> Path:
    """RELEASE (cells and a catalog) and then NEWER (``newer``), uploaded into the fake bucket."""
    releases = tmp_path / "releases"
    releases.mkdir()
    first = _publish(served.store.root, releases, RELEASE, {CELLS: b"cells" * 300, CATALOG: OBJECT})
    _publish(served.store.root, releases, NEWER, newer, [first])
    return releases


def _probed(served: Served) -> set[str]:
    return {request["path"] or "" for request in served.store.requests}


@pytest.mark.parametrize(
    ("newer", "key"),
    [
        pytest.param(
            {CELLS: b"cells" * 300, CATALOG: OBJECT[::-1]}, f"releases/{NEWER}/{CATALOG}", id="its-catalog"
        ),
        # NEWER has no catalog, so its first .parquet in path order: the cells it reuses from RELEASE.
        pytest.param(
            {CELLS: b"cells" * 300, TABLE: b"table" * 300}, f"releases/{RELEASE}/{CELLS}", id="no-catalog"
        ),
    ],
)
def test_main_probes_the_newest_catalog(
    newer: dict[str, bytes], key: str, tmp_path: Path, served: Served, capsys: Capsys
) -> None:
    releases = _releases(tmp_path, served, newer)
    assert cors.main(["--base-url", served.base, "--releases", str(releases)]) == 0
    assert _probed(served) == {f"/{key}"}
    out = capsys.readouterr().out.splitlines()
    assert len(out) == 1 and out[0].startswith(f"ok: {key} ")


def test_main_skips_the_withdrawn_list(tmp_path: Path, served: Served, capsys: Capsys) -> None:
    """``WITHDRAWN.json`` sorts after every release name, so a reader that skipped dr.release_ids would
    take it for the newest release."""
    releases = _releases(tmp_path, served, {CELLS: b"cells" * 300, CATALOG: OBJECT[::-1]})
    withdrawn = {
        "schema": dr.WITHDRAWN_SCHEMA,
        "schema_version": dr.WITHDRAWN_SCHEMA_VERSION,
        "withdrawn": [],
    }
    (releases / dr.WITHDRAWN_FILE).write_text(json.dumps(withdrawn), encoding="utf-8")
    assert cors.main(["--base-url", served.base, "--releases", str(releases)]) == 0
    assert _probed(served) == {f"/releases/{NEWER}/{CATALOG}"}


def test_main_probes_a_named_release_and_path(tmp_path: Path, served: Served, capsys: Capsys) -> None:
    releases = _releases(tmp_path, served, {CELLS: b"cells" * 300, TABLE: b"table" * 300})
    argv = ["--base-url", served.base, "--releases", str(releases), "--release", NEWER, "--path", TABLE]
    assert cors.main(argv) == 0
    assert _probed(served) == {f"/releases/{NEWER}/{TABLE}"}
    served.store.requests.clear()
    assert cors.main([*argv[:-1], "tables/v1/absent.parquet"]) == 1
    assert "tables/v1/absent.parquet is not in release 2026-10-18" in capsys.readouterr().err
    assert served.store.requests == []


def test_a_failing_probe_exits_1_and_names_the_key(tmp_path: Path, served: Served, capsys: Capsys) -> None:
    releases = _releases(tmp_path, served, {CELLS: b"cells" * 300, CATALOG: OBJECT[::-1]})
    served.store.honours_range = False
    assert cors.main(["--base-url", served.base, "--releases", str(releases)]) == 1
    captured = capsys.readouterr()
    assert captured.out.splitlines() == [f"FAIL releases/{NEWER}/{CATALOG}: ranged GET returned 200, not 206"]
    assert "FAILED" in captured.err


def test_another_host_exits_1(tmp_path: Path, served: Served, capsys: Capsys) -> None:
    releases = _releases(tmp_path, served, {CELLS: b"cells" * 300, CATALOG: OBJECT[::-1]})
    assert cors.main(["--base-url", "https://example.org/", "--releases", str(releases)]) == 1
    assert "differs from the committed data-store URL" in capsys.readouterr().err
    assert served.store.requests == []

