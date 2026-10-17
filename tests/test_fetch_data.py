"""Credential-free fetch and verification of the data store (data store design 2026-10-17 §6).

Served by a local ``http.server`` on 127.0.0.1: no network, no GCP.
"""

from __future__ import annotations

import functools
import hashlib
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from genomeos.publication import data_release as dr
from scripts import fetch_data as fd

RELEASE = "2026-10-17"
FILES = {
    "store/artifacts/x__v3__map-2026-08/cells.parquet": b"cells for x",
    "store/artifacts/x__v3__map-2026-08/manifest.json": b'{"variant_id": "x"}',
    "validation/crossval_summary.json": b'{"skill": 1}',
    "raw/afnd_populations.tsv": b"pop_id\tpopulation\n",
}
IN_GIT = {"raw/afnd_populations.tsv"}
SOURCES = {"map": {"name": "MAP", "terms": {"status": "not_checked"}, "non_commercial": False}}


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass


@pytest.fixture()
def store(tmp_path: Path) -> Iterator[dict[str, Path | str]]:
    """A served bucket tree, its committed manifest, and an empty local data/ to fetch into."""
    served = tmp_path / "bucket"
    records = []
    for path, data in FILES.items():
        target = served / dr.release_key(RELEASE, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        records.append(dr.FileRecord(path, len(data), digest, path in IN_GIT, ("map",)))
    manifest = dr.build_manifest(records, SOURCES, RELEASE)
    releases = tmp_path / "releases"
    releases.mkdir()
    (releases / f"{RELEASE}.json").write_bytes(dr.canonical_bytes(manifest))
    (served / dr.manifest_key(RELEASE)).parent.mkdir(parents=True)
    (served / dr.manifest_key(RELEASE)).write_bytes(dr.canonical_bytes(manifest))
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Quiet, directory=str(served)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {
            "served": served,
            "releases": releases,
            "dest": tmp_path / "data",
            "base": f"http://127.0.0.1:{server.server_address[1]}/",
        }
    finally:
        server.shutdown()
        server.server_close()


def _objects(store: dict) -> tuple[dr.ReleaseObject, ...]:
    return fd.load_release(None, store["releases"])[1]


def _served(store: dict, path: str) -> Path:
    return store["served"] / dr.release_key(RELEASE, path)


def test_fetch_downloads_verifies_and_skips_git_tracked_objects(store: dict) -> None:
    counts = fd.fetch(fd.pending(_objects(store), include_git=False), store["dest"], store["base"])
    assert counts == {"fetched": 3, "present": 0}
    for path, data in FILES.items():
        target = store["dest"] / path
        assert (target.read_bytes() == data) if path not in IN_GIT else not target.exists()
    assert not any((store["dest"] / fd.PARTIAL).iterdir())


def test_a_second_fetch_needs_no_network(store: dict) -> None:
    objects = fd.pending(_objects(store), include_git=False)
    fd.fetch(objects, store["dest"], store["base"])
    for path in FILES:
        _served(store, path).unlink()
    assert fd.fetch(objects, store["dest"], store["base"]) == {"fetched": 0, "present": 3}


def test_a_tampered_object_fails_loudly_and_lands_nowhere(store: dict) -> None:
    path = "validation/crossval_summary.json"
    _served(store, path).write_bytes(b'{"skill": 9}')
    with pytest.raises(fd.FetchError, match="sha256"):
        fd.fetch(fd.pending(_objects(store), include_git=False), store["dest"], store["base"])
    assert not (store["dest"] / path).exists()
    assert not any((store["dest"] / fd.PARTIAL).iterdir())


def test_a_truncated_object_fails_on_its_byte_count(store: dict) -> None:
    path = "store/artifacts/x__v3__map-2026-08/cells.parquet"
    _served(store, path).write_bytes(b"cells")
    with pytest.raises(fd.FetchError, match="bytes"):
        fd.fetch(fd.pending(_objects(store), include_git=False), store["dest"], store["base"])
    assert not (store["dest"] / path).exists()


def test_a_differing_local_file_is_never_overwritten(store: dict) -> None:
    path = "validation/crossval_summary.json"
    local = store["dest"] / path
    local.parent.mkdir(parents=True)
    local.write_bytes(b"edited by hand")
    with pytest.raises(fd.FetchError, match="never overwritten"):
        fd.fetch(fd.pending(_objects(store), include_git=False), store["dest"], store["base"])
    assert local.read_bytes() == b"edited by hand"


def test_a_missing_object_is_an_http_error(store: dict) -> None:
    _served(store, "validation/crossval_summary.json").unlink()
    with pytest.raises(fd.FetchError, match="404"):
        fd.fetch(fd.pending(_objects(store), include_git=False), store["dest"], store["base"])


def test_verify_remote_reads_everything_and_writes_nothing(store: dict) -> None:
    objects = _objects(store)
    assert fd.verify_remote(objects, store["base"], RELEASE, store["releases"]) == []
    assert not store["dest"].exists()
    _served(store, "raw/afnd_populations.tsv").write_bytes(b"pop_id\tchanged\n")
    problems = fd.verify_remote(objects, store["base"], RELEASE, store["releases"])
    assert len(problems) == 1 and "raw/afnd_populations.tsv" in problems[0]


def test_verify_remote_checks_the_uploaded_manifest_copy(store: dict) -> None:
    (store["served"] / dr.manifest_key(RELEASE)).write_bytes(b"{}\n")
    problems = fd.verify_remote(_objects(store), store["base"], RELEASE, store["releases"])
    assert problems and "manifest" in problems[0]


def test_verify_local_reports_missing_and_mismatched(store: dict) -> None:
    objects = fd.pending(_objects(store), include_git=False)
    fd.fetch(objects, store["dest"], store["base"])
    (store["dest"] / "validation/crossval_summary.json").write_bytes(b"changed")
    (store["dest"] / "store/artifacts/x__v3__map-2026-08/manifest.json").unlink()
    problems = fd.verify_local(objects, store["dest"])
    assert len(problems) == 2
    assert any("missing" in line for line in problems) and any("sha256" in line for line in problems)


def test_require_local_fetches_what_a_script_needs(store: dict) -> None:
    target = store["dest"] / "store" / "artifacts"
    resolved = fd.require_local(
        target, releases=store["releases"], dest=store["dest"], base_url=store["base"]
    )
    assert resolved == target
    assert (target / "x__v3__map-2026-08" / "cells.parquet").read_bytes() == FILES[
        "store/artifacts/x__v3__map-2026-08/cells.parquet"
    ]
    assert not (store["dest"] / "validation").exists()


def test_require_local_leaves_paths_outside_the_store_alone(store: dict, tmp_path: Path) -> None:
    elsewhere = tmp_path / "my-artifacts"
    resolved = fd.require_local(elsewhere, releases=store["releases"], dest=store["dest"], base_url=None)
    assert resolved == elsewhere


def test_missing_objects_without_a_base_url_name_the_variable(
    store: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(dr.BASE_URL_VARIABLE, raising=False)
    with pytest.raises(fd.FetchError, match=dr.BASE_URL_VARIABLE):
        fd.require_local(store["dest"] / "validation", releases=store["releases"], dest=store["dest"])


def test_nothing_missing_needs_no_base_url(store: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    fd.fetch(fd.pending(_objects(store), include_git=False), store["dest"], store["base"])
    monkeypatch.delenv(dr.BASE_URL_VARIABLE, raising=False)
    target = store["dest"] / "validation"
    assert fd.require_local(target, releases=store["releases"], dest=store["dest"]) == target


def test_cli_fetch_list_and_verify(
    store: dict, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    common = ["--releases", str(store["releases"]), "--dest", str(store["dest"])]
    assert fd.main([*common, "--list"]) == 0
    assert "3 objects" in capsys.readouterr().out
    assert not store["dest"].exists()
    monkeypatch.setenv(dr.BASE_URL_VARIABLE, store["base"])
    assert fd.main([*common, "--prefix", "validation/"]) == 0
    assert (store["dest"] / "validation/crossval_summary.json").exists()
    assert not (store["dest"] / "store").exists()
    assert fd.main([*common, "--verify-remote"]) == 0
    _served(store, "validation/crossval_summary.json").write_bytes(b"tampered")
    assert fd.main([*common, "--verify-remote"]) == 1
    assert fd.main([*common, "--prefix", "nowhere/"]) == 1


def test_released_artifact_dirs_name_their_first_release(store: dict) -> None:
    assert fd.released_artifact_dirs(store["releases"]) == {"x__v3__map-2026-08": RELEASE}
