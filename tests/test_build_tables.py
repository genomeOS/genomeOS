"""Building a release's tables/ files (Atlas data platform design 2026-10-18 §2.3-§2.5; calls 7, 15).

Every run reads a copy of exactly the two committed manifests through the hidden ``--releases`` flag,
never the real ``data/releases/``, which later release PRs extend.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from genomeos.tables import contracts
from scripts import build_tables
from tests.tables_fixtures import GIT_SHA, copy_committed_releases

META = ("meta.release_objects", "meta.sources", "meta.served", "meta.withdrawn")


def _run(tmp_path: Path, *extra: str, release: str = "2026-11-20") -> int:
    releases = copy_committed_releases(tmp_path / "releases")
    arguments = ["--release", release, "--data", str(tmp_path / "data"), "--git-sha", GIT_SHA]
    return build_tables.main([*arguments, "--releases", str(releases), *extra])


def _digests(data: Path) -> dict[str, str]:
    return {
        table: hashlib.sha256((data / contracts.table_path(table)).read_bytes()).hexdigest() for table in META
    }


def test_build_meta_writes_four_byte_identical_files(tmp_path, capsys):
    assert _run(tmp_path) == 0
    out = capsys.readouterr().out
    for line in ("meta.release_objects: 493 rows", "meta.sources: 14 rows", "meta.served: 30 rows"):
        assert line in out
    assert "meta.withdrawn: 0 rows" in out
    first = _digests(tmp_path / "data")
    assert _run(tmp_path, "--stage", "meta") == 0
    assert _digests(tmp_path / "data") == first


def test_a_release_already_committed_is_refused(tmp_path, capsys):
    assert _run(tmp_path, release="2026-10-18") == 1
    assert "2026-10-18" in capsys.readouterr().err
    assert not (tmp_path / "data").exists()


def test_a_git_sha_that_names_no_commit_is_refused(tmp_path, capsys):
    releases = copy_committed_releases(tmp_path / "releases")
    arguments = ["--release", "2026-11-20", "--data", str(tmp_path / "data"), "--releases", str(releases)]
    assert build_tables.main([*arguments, "--git-sha", "no-such-revision"]) == 1
    assert "git-sha" in capsys.readouterr().err


def test_a_committed_manifest_not_in_canonical_form_is_refused(tmp_path, capsys):
    """Its recorded sha256 is of the canonical bytes, so the committed file must be exactly those."""
    releases = copy_committed_releases(tmp_path / "releases")
    manifest = releases / "2026-10-18.json"
    manifest.write_bytes(manifest.read_bytes().rstrip(b"\n"))
    arguments = ["--release", "2026-11-20", "--data", str(tmp_path / "data"), "--git-sha", GIT_SHA]
    assert build_tables.main([*arguments, "--releases", str(releases)]) == 1
    assert "canonical" in capsys.readouterr().err
