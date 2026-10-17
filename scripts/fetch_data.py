#!/usr/bin/env python3
"""Fetch and verify the public genomeOS data store, with no credentials (data store design 2026-10-17 §6).

    python scripts/fetch_data.py                                  # newest release into data/
    python scripts/fetch_data.py --prefix store/artifacts/chr11-5227002-T-A__v3__map-2026-08/
    python scripts/fetch_data.py --list                           # the plan; no network
    python scripts/fetch_data.py --verify-local                   # hash local files; no network
    python scripts/fetch_data.py --verify-remote                  # GET and hash every object; writes nothing

Reads the committed manifest ``data/releases/<release>.json`` (newest by default) and resolves each
object's key against the committed public base URL (``data_release.DATA_STORE_BASE_URL``), over plain
HTTPS. ``GENOMEOS_DATA_BASE_URL`` or ``--base-url`` may only repeat that URL or name a loopback mirror;
anything else is refused, because the committed value is the truth. Nothing here lists the bucket
(anonymous readers may not): every key comes from the manifest. Every download streams into
``data/.fetch-partial/``, is checked against the manifest's byte count and sha256, and only then is
renamed into place; a mismatch is deleted and reported. A local file that already matches is skipped;
one that differs is a hard error and is never overwritten. Objects git already tracks are skipped
unless ``--include-git-tracked``. Standard library only.

Other scripts call ``require_local(path)``: it makes every published object under a ``data/`` path
present and verified, fetching what is missing, and returns the path unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from collections.abc import Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402

DATA = ROOT / "data"
RELEASES = DATA / "releases"
PARTIAL = ".fetch-partial"
CHUNK = 1 << 20
TIMEOUT_S = 60
USER_AGENT = "genomeos-fetch-data/1"


class FetchError(RuntimeError):
    """A download, a local file or a configuration that would leave unverified bytes in data/."""


def newest_release(releases: Path = RELEASES) -> str | None:
    names = [path.stem for path in releases.glob("*.json")]
    return max(names, key=dr.release_sort_key) if names else None


def load_release(
    release: str | None, releases: Path = RELEASES
) -> tuple[dict[str, Any], tuple[dr.ReleaseObject, ...]]:
    chosen = release or newest_release(releases)
    if chosen is None:
        raise FetchError(f"no committed release manifest under {releases}")
    path = releases / f"{dr.assert_release_id(chosen)}.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("release") != chosen:
        raise FetchError(f"{path} declares release {manifest.get('release')!r}")
    return manifest, dr.validate_manifest(manifest)


def base_url(explicit: str | None = None) -> str:
    """The committed data-store URL; a flag or variable naming anything but it (or loopback) is refused."""
    try:
        return dr.resolve_base_url(explicit or os.environ.get(dr.BASE_URL_VARIABLE))
    except dr.DataReleaseError as error:
        raise FetchError(str(error)) from error


def pending(objects: Sequence[dr.ReleaseObject], *, include_git: bool) -> tuple[dr.ReleaseObject, ...]:
    return tuple(item for item in objects if include_git or not item.in_git)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def local_state(item: dr.ReleaseObject, dest: Path) -> str:
    """``present`` (verified), ``missing``, or a hard error for a file that differs."""
    target = dest / item.path
    if not target.exists():
        return "missing"
    digest = sha256_file(target)
    if digest != item.sha256:
        raise FetchError(
            f"{target}: local sha256 {digest} differs from release {item.sha256}; it is never overwritten. "
            "Move it aside yourself if it is stale."
        )
    return "present"


def _open(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        return urllib.request.urlopen(request, timeout=TIMEOUT_S)  # noqa: S310 - https or loopback only
    except urllib.error.HTTPError as error:
        raise FetchError(f"GET {url} failed: HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise FetchError(f"GET {url} failed: {error.reason}") from error


def _stream(url: str, item: dr.ReleaseObject, sink) -> None:
    """Copy ``url`` into ``sink`` (or nowhere), refusing any byte count or digest but the manifest's."""
    digest = hashlib.sha256()
    received = 0
    try:
        with _open(url) as response:
            encoding = response.headers.get("Content-Encoding")
            if encoding:
                raise FetchError(f"{url}: served with Content-Encoding {encoding!r}; objects are raw bytes")
            while chunk := response.read(CHUNK):
                received += len(chunk)
                if received > item.bytes:
                    raise FetchError(f"{item.path}: more than the manifest's {item.bytes} bytes")
                digest.update(chunk)
                if sink is not None:
                    sink.write(chunk)
    except (OSError, http.client.HTTPException) as error:  # reset, timeout or truncation mid-read
        raise FetchError(f"GET {url} failed after {received} bytes: {error!r}") from error
    if received != item.bytes:
        raise FetchError(f"{item.path}: received {received} bytes, the manifest says {item.bytes}")
    if digest.hexdigest() != item.sha256:
        raise FetchError(
            f"{item.path}: downloaded sha256 {digest.hexdigest()} is not the manifest's {item.sha256}"
        )


def download(item: dr.ReleaseObject, dest: Path, base: str) -> None:
    partial = dest / PARTIAL
    partial.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(dir=partial, prefix=Path(item.path).name + ".")
    temporary = Path(name)
    try:
        with os.fdopen(handle, "wb") as sink:
            _stream(dr.public_url(base, item.key), item, sink)
        target = dest / item.path
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and local_state(item, dest) == "present":
            return
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def fetch(objects: Sequence[dr.ReleaseObject], dest: Path, base: str | None) -> dict[str, int]:
    """Make every object present and verified under ``dest``; the first problem is a hard error."""
    states = {item.path: local_state(item, dest) for item in objects}
    missing = [item for item in objects if states[item.path] == "missing"]
    counts = {"fetched": 0, "present": len(objects) - len(missing)}
    if missing:
        resolved = base_url(base)
        for item in missing:
            download(item, dest, resolved)
            counts["fetched"] += 1
    return counts


def verify_local(objects: Sequence[dr.ReleaseObject], dest: Path) -> list[str]:
    problems: list[str] = []
    for item in objects:
        try:
            if local_state(item, dest) == "missing":
                problems.append(f"{item.path}: missing")
        except FetchError as error:
            problems.append(str(error))
    return problems


def verify_remote(
    objects: Sequence[dr.ReleaseObject], base: str, release: str, releases: Path = RELEASES
) -> list[str]:
    """GET every object (and the uploaded manifest copy) and check it; nothing is written."""
    problems: list[str] = []
    committed = (releases / f"{release}.json").read_bytes()
    manifest_url = dr.public_url(base, dr.manifest_key(release))
    try:
        with _open(manifest_url) as response:
            if response.read() != committed:
                problems.append(f"{manifest_url}: the uploaded manifest differs from the committed one")
    except FetchError as error:
        problems.append(f"manifest: {error}")
    for item in objects:
        try:
            _stream(dr.public_url(base, item.key), item, None)
        except FetchError as error:
            problems.append(f"{item.path}: {error}")
    return problems


def released_artifact_dirs(releases: Path = RELEASES) -> dict[str, str]:
    """Artifact directory name → the first committed release that published it.

    Every committed release counts, not only the newest: once an artifact is published its key is
    cited, and it stays immutable even if a later release stops listing it (design §5).
    """
    found: dict[str, str] = {}
    names = sorted((path.stem for path in releases.glob("*.json")), key=dr.release_sort_key)
    for name in names:
        for item in load_release(name, releases)[1]:
            if item.path.startswith(dr.ARTIFACT_PREFIX):
                found.setdefault(item.path.split("/")[2], name)
    return found


def require_local(
    path: Path | str,
    *,
    release: str | None = None,
    releases: Path = RELEASES,
    dest: Path = DATA,
    base_url: str | None = None,
) -> Path:
    """Ensure every published object under ``path`` is present and verified; return ``path``.

    A path outside ``dest``, or one no committed release publishes anything under, is the caller's own
    tree and is returned untouched.
    """
    path = Path(path)
    try:
        relative = path.resolve().relative_to(dest.resolve()).as_posix()
    except ValueError:
        return path
    if newest_release(releases) is None and release is None:
        return path
    _, objects = load_release(release, releases)
    if relative != ".":
        objects = tuple(
            item for item in objects if item.path == relative or item.path.startswith(f"{relative}/")
        )
    objects = pending(objects, include_git=False)
    if objects:
        counts = fetch(objects, dest, base_url)
        if counts["fetched"]:
            print(f"fetched {counts['fetched']} verified objects into {dest / relative}", file=sys.stderr)
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch and verify the public genomeOS data store.")
    parser.add_argument("--release", help="release id (default: the newest committed manifest)")
    parser.add_argument("--prefix", action="append", default=[], help="only paths under this prefix")
    parser.add_argument(
        "--base-url", help=f"default: the committed {dr.DATA_STORE_BASE_URL} (or ${dr.BASE_URL_VARIABLE})"
    )
    parser.add_argument("--dest", type=Path, default=DATA, help="where files land (default: data/)")
    parser.add_argument("--releases", type=Path, default=RELEASES, help=argparse.SUPPRESS)
    parser.add_argument("--include-git-tracked", action="store_true", help="also objects git tracks")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--list", action="store_true", help="print the plan; no network")
    mode.add_argument("--verify-local", action="store_true", help="hash local files; no network")
    mode.add_argument("--verify-remote", action="store_true", help="GET and hash every object; no writes")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        manifest, objects = load_release(args.release, args.releases)
        selected = dr.select(objects, args.prefix)
        release = manifest["release"]
        if args.verify_remote:
            problems = verify_remote(selected, base_url(args.base_url), release, args.releases)
            return _report(problems, f"release {release}: {len(selected)} objects verified over HTTPS")
        chosen = pending(selected, include_git=args.include_git_tracked)
        if args.list:
            for item in chosen:
                print(f"{item.bytes:>12,}  {item.sha256[:12]}  {item.path}")
            print(f"release {release}: {len(chosen)} objects, {sum(item.bytes for item in chosen):,} bytes")
            return 0
        if args.verify_local:
            problems = verify_local(chosen, args.dest)
            return _report(problems, f"release {release}: {len(chosen)} local objects verified")
        counts = fetch(chosen, args.dest, args.base_url)
    except (FetchError, dr.DataReleaseError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"release {release}: {counts['fetched']} fetched, {counts['present']} already present and verified")
    return 0


def _report(problems: list[str], success: str) -> int:
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        print(f"{len(problems)} problems", file=sys.stderr)
        return 1
    print(success)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
