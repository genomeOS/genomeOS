"""A byte-logging HTTP Range server over a local tree, for the lookup gate (Atlas data platform design
2026-10-18 §2.6, §11 step 2.7).

``serve(root)`` serves ``root`` on 127.0.0.1 from a ``ThreadingHTTPServer``, as a bucket serves its keys
to DuckDB's httpfs, and logs every request's method, path and the body bytes it is sent:

- ``HEAD`` answers 200 with ``Content-Length`` and ``Accept-Ranges: bytes``;
- ``GET`` with ``Range: bytes=a-b`` or ``bytes=a-`` answers 206 with ``Content-Range``, and without a
  ``Range`` header 200 with the whole file; any other range form, or one starting past the end, is 416;
- a path that is not a file is 404, and a path under a ``deny``-ed prefix is 403, the way a tripped
  budget brake answers; neither has a body (``Content-Length: 0``).

Each request is logged before any of its response is written, so a client that has its answer never
reads a log that lacks it. Paths are logged percent-decoded, without a query.
"""

from __future__ import annotations

import functools
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import TracebackType
from typing import Any, NamedTuple
from urllib.parse import unquote, urlsplit

__all__ = ("RangeServer", "Request", "serve")

_RANGE = re.compile(r"bytes=(\d+)-(\d*)")
_CHUNK = 1 << 16


class Request(NamedTuple):
    """One request as served: its method, its decoded path and the body bytes sent for it."""

    method: str
    path: str
    bytes: int


class _Log:
    """The requests served and the denied prefixes, shared by every handler thread."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[Request] = []
        self.denied: list[str] = []


class _RangeHandler(SimpleHTTPRequestHandler):
    """Serves files under ``directory`` by byte range, logging each request in ``log``."""

    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, log: _Log, **kwargs: Any) -> None:
        self.log = log  # before super().__init__, which handles the request
        super().__init__(*args, **kwargs)

    def do_HEAD(self) -> None:
        self._serve(body=False)

    def do_GET(self) -> None:
        self._serve(body=True)

    def _serve(self, *, body: bool) -> None:
        path = unquote(urlsplit(self.path).path)
        with self.log.lock:
            denied = any(path.startswith(prefix) for prefix in self.log.denied)
        file = Path(self.translate_path(self.path))
        if denied or not file.is_file():
            self._answer(path, 403 if denied else 404, {}, None, 0)
            return
        size = file.stat().st_size
        header = self.headers.get("Range")
        if header is None:
            self._answer(path, 200, {}, file if body else None, size, start=0)
            return
        match = _RANGE.fullmatch(header.strip())
        if match is None or int(match.group(1)) >= size:
            self._answer(path, 416, {"Content-Range": f"bytes */{size}"}, None, 0)
            return
        start = int(match.group(1))
        end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
        if end < start:
            self._answer(path, 416, {"Content-Range": f"bytes */{size}"}, None, 0)
            return
        length = end - start + 1
        headers = {"Content-Range": f"bytes {start}-{end}/{size}"}
        self._answer(path, 206, headers, file if body else None, length, start=start)

    def _answer(
        self,
        path: str,
        status: int,
        headers: dict[str, str],
        file: Path | None,
        length: int,
        *,
        start: int = 0,
    ) -> None:
        """Log the request, then send ``status``, ``headers`` and ``length`` bytes of ``file`` from
        ``start`` (no body when ``file`` is None; ``Content-Length`` is ``length`` either way)."""
        with self.log.lock:
            self.log.requests.append(Request(self.command, path, length if file is not None else 0))
        self.send_response(status)
        self.send_header("Content-Length", str(length))
        if status in (200, 206):
            self.send_header("Accept-Ranges", "bytes")
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if file is None:
            return
        with file.open("rb") as stream:
            stream.seek(start)
            remaining = length
            while remaining:
                chunk = stream.read(min(_CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass


class RangeServer:
    """A running Range server: ``base`` is its URL, ending in ``/``. Leaving its context stops it."""

    def __init__(self, root: Path) -> None:
        self._log = _Log()
        handler = functools.partial(_RangeHandler, directory=str(root), log=self._log)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self._server.server_address[1]}/"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def requests(self) -> list[Request]:
        """Every request served since the last ``clear``, in the order they were answered."""
        with self._log.lock:
            return list(self._log.requests)

    def clear(self) -> None:
        """Forget the requests served so far."""
        with self._log.lock:
            self._log.requests.clear()

    def deny(self, prefix: str) -> None:
        """Answer 403, with no body, to every later request whose path starts with ``prefix``."""
        with self._log.lock:
            self._log.denied.append(prefix)

    def lift(self) -> None:
        """Undo every ``deny``."""
        with self._log.lock:
            self._log.denied.clear()

    def close(self) -> None:
        """Stop serving and release the port."""
        self._server.shutdown()
        self._server.server_close()

    def __enter__(self) -> RangeServer:
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


def serve(root: Path) -> RangeServer:
    """Start serving ``root`` on a free loopback port; use the result as a context manager to stop it."""
    return RangeServer(root)
