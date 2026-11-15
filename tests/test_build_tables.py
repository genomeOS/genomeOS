"""Building a release's tables/ files (Atlas data platform design 2026-10-18 §2.3-§2.5, §2.7 check 9).

Builder's calls 7 and 15. Every run reads a copy of exactly the two committed manifests through the
hidden ``--releases`` flag, never the real ``data/releases/``, which later release PRs extend. ``main``
runs point the ``git:`` inputs at this checkout's files through the hidden overrides, so an uncommitted
edit to either cannot fail them; the tests of reading a ``git:`` input at its commit use a throwaway
repository.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pandas as pd
import pytest

from genomeos.tables import contracts, meta, provenance
from genomeos.tables.contracts import TableError
from scripts import build_tables
from tests import tables_fixtures
from tests.tables_fixtures import (
    EPOCH,
    GIT_INPUT_FLAGS,
    GIT_SHA,
    HBS_V1,
    HBS_V3,
    KIR_V3,
    LAGOS_R4,
    R0_LAGOS,
    ROOT,
    FixtureTree,
    add_artifact,
    commit_release,
    copy_committed_releases,
)

#: The shared pytest fixture, registered in this module by name.
fixture_tree = tables_fixtures.fixture_tree

META = ("meta.release_objects", "meta.sources", "meta.served", "meta.withdrawn")
#: Variables a git hook exports that would point a ``git`` call at another repository.
_GIT_LOCATION = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR")


def _run(tmp_path: Path, *extra: str, release: str = "2026-11-20") -> int:
    releases = copy_committed_releases(tmp_path / "releases")
    arguments = ["--release", release, "--data", str(tmp_path / "data"), "--git-sha", "HEAD"]
    return build_tables.main([*arguments, "--releases", str(releases), *GIT_INPUT_FLAGS, *extra])


def _digests(data: Path) -> dict[str, str]:
    return {
        table: hashlib.sha256((data / contracts.table_path(table)).read_bytes()).hexdigest() for table in META
    }


def test_build_meta_writes_four_byte_identical_files(tmp_path, capsys):
    """The meta stage alone: the inferred stage would need the 61 released artifacts in ``data/``."""
    assert _run(tmp_path, "--stage", "meta") == 0
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


@pytest.mark.parametrize("revision", ["no-such-revision", GIT_SHA])
def test_a_git_sha_that_names_no_commit_is_refused(tmp_path, capsys, revision):
    """A full sha is checked too: ``0`` * 40 is well formed, and no commit."""
    releases = copy_committed_releases(tmp_path / "releases")
    arguments = ["--release", "2026-11-20", "--data", str(tmp_path / "data"), "--releases", str(releases)]
    assert build_tables.main([*arguments, *GIT_INPUT_FLAGS, "--git-sha", revision]) == 1
    assert "git-sha" in capsys.readouterr().err
    assert not (tmp_path / "data").exists()


def test_a_committed_manifest_not_in_canonical_form_is_refused(tmp_path, capsys):
    """Its recorded sha256 is of the canonical bytes, so the committed file must be exactly those."""
    releases = copy_committed_releases(tmp_path / "releases")
    manifest = releases / "2026-10-18.json"
    manifest.write_bytes(manifest.read_bytes().rstrip(b"\n"))
    arguments = ["--release", "2026-11-20", "--data", str(tmp_path / "data"), "--git-sha", "HEAD"]
    assert build_tables.main([*arguments, "--releases", str(releases), *GIT_INPUT_FLAGS]) == 1
    assert "canonical" in capsys.readouterr().err


# --- a git: input is the file at the stamped commit (§2.7 check 9) ---


def _git(repo: Path, *arguments: str) -> str:
    """``git`` in ``repo`` under a fixed identity, ignoring the user's and the system's configuration."""
    environment = {key: value for key, value in os.environ.items() if key not in _GIT_LOCATION}
    environment |= {
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_AUTHOR_NAME": "test",
        "GIT_AUTHOR_EMAIL": "test@example.org",
        "GIT_COMMITTER_NAME": "test",
        "GIT_COMMITTER_EMAIL": "test@example.org",
    }
    return subprocess.run(
        ["git", *arguments], cwd=repo, env=environment, capture_output=True, check=True, text=True
    ).stdout.strip()


def _commit(repo: Path, files: dict[str, bytes], message: str) -> str:
    for path, payload in files.items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_bytes(payload)
    _git(repo, "add", *files)
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway repository whose one commit holds this checkout's web catalog and withdrawn list."""
    for variable in _GIT_LOCATION:
        monkeypatch.delenv(variable, raising=False)
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q")
    inputs = {path: (ROOT / path).read_bytes() for path in (meta.WEB_CATALOG, meta.WITHDRAWN_LIST)}
    _commit(root, inputs, "inputs")
    return root


def _context(tmp_path: Path, repo: Path, git_sha: str = "HEAD") -> build_tables.BuildContext:
    releases = copy_committed_releases(tmp_path / "releases")
    arguments = ["--release", "2026-11-20", "--data", str(tmp_path / "data"), "--releases", str(releases)]
    args = build_tables.build_parser().parse_args([*arguments, "--git-sha", git_sha])
    return build_tables.context(args, repo_root=repo)


def test_a_git_input_is_recorded_as_the_file_at_the_stamped_commit(tmp_path, repo):
    ctx = _context(tmp_path, repo)
    assert ctx.git_sha == _git(repo, "rev-parse", "HEAD")
    build_tables.build_meta(ctx)
    for table, path in (("meta.served", meta.WEB_CATALOG), ("meta.withdrawn", meta.WITHDRAWN_LIST)):
        kv = provenance.read_kv(tmp_path / "data" / contracts.table_path(table))
        assert kv["genomeos.git_sha"] == ctx.git_sha
        committed = hashlib.sha256((repo / path).read_bytes()).hexdigest()
        refs = provenance.decode_inputs(kv["genomeos.inputs"])
        assert provenance.InputRef(f"{provenance.GIT_PREFIX}{path}", committed) in refs


@pytest.mark.parametrize("path", [meta.WEB_CATALOG, meta.WITHDRAWN_LIST])
def test_an_uncommitted_git_input_is_refused(tmp_path, repo, path):
    """An edit not yet committed would be recorded as the file at a commit that does not hold it."""
    (repo / path).write_bytes((repo / path).read_bytes() + b"\n")
    with pytest.raises(TableError, match=re.escape(path)):
        build_tables.build_meta(_context(tmp_path, repo))
    assert not (tmp_path / "data").exists()


def test_a_stamped_commit_whose_git_input_differs_is_refused(tmp_path, repo):
    """``--git-sha`` naming an older commit stamps that commit, so its files must be the ones read."""
    first = _git(repo, "rev-parse", "HEAD")
    catalog = json.loads((repo / meta.WEB_CATALOG).read_bytes())
    _commit(repo, {meta.WEB_CATALOG: json.dumps(catalog, indent=1).encode()}, "reformat the catalog")
    with pytest.raises(TableError, match=re.escape(meta.WEB_CATALOG)):
        build_tables.build_meta(_context(tmp_path, repo, git_sha=first))


def test_a_git_input_missing_from_the_stamped_commit_is_refused(tmp_path, repo):
    shutil.rmtree(repo / ".git")
    _git(repo, "init", "-q")
    _commit(repo, {meta.WEB_CATALOG: (ROOT / meta.WEB_CATALOG).read_bytes()}, "the catalog alone")
    with pytest.raises(TableError, match=re.escape(meta.WITHDRAWN_LIST)):
        build_tables.build_meta(_context(tmp_path, repo))


# --- the inferred stage (step 1.5): inferred.artifacts and the cells_by_cell epochs ---

CELLS_BY_CELL = "tables/v1/inferred/cells_by_cell"
LATER = "2026-11-21"
#: A released artifact (it is in RELEASED_WITHOUT_INPUT) that a later release adds to the fixture.
NEW_ARTIFACT = "hla__a-02-01__v3__afnd-2026-08"


def _run_inferred(tree: FixtureTree, release: str = EPOCH) -> int:
    arguments = ["--release", release, "--data", str(tree.data), "--releases", str(tree.releases)]
    return build_tables.main([*arguments, "--git-sha", "HEAD", "--stage", "inferred"])


def _epoch_digests(data: Path, epoch: str) -> dict[str, str]:
    root = data / CELLS_BY_CELL / f"epoch={epoch}"
    return {
        path.relative_to(data).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _release_first_epoch(tree: FixtureTree) -> dict[str, str]:
    """Build the first epoch at ``EPOCH`` and commit release ``EPOCH`` over it; its parts' digests."""
    assert _run_inferred(tree) == 0
    commit_release(tree.data, tree.releases, EPOCH)
    return _epoch_digests(tree.data, EPOCH)


def test_build_inferred_reports_the_fixture(fixture_tree, capsys):
    assert _run_inferred(fixture_tree) == 0
    out = capsys.readouterr().out
    assert "inferred.artifacts: 3 rows; fit_input_evidence none 3" in out
    assert "inferred.cells_by_cell epoch=2026-11-20: 3 artifacts, 6 rows, 4 parts (res 3: 2, res 4: 2)" in out
    assert "measurement allele_frequency 2 (1 from the reviewed table), carrier_frequency 1" in out


def test_a_later_release_writes_only_new_artifacts_and_never_touches_an_earlier_epoch(fixture_tree, repo):
    earlier = _release_first_epoch(fixture_tree)
    assert len(earlier) == 4
    first_sha = provenance.read_kv(fixture_tree.data / next(iter(earlier)))["genomeos.git_sha"]
    add_artifact(
        fixture_tree.data,
        NEW_ARTIFACT,
        artifact_format=2,
        resolution=4,
        cells=(LAGOS_R4,),
        measurement="allele_frequency",
    )
    later_sha = _commit(repo, {"later.txt": b"a later commit\n"}, "later")
    assert later_sha != first_sha
    args = build_tables.build_parser().parse_args(
        ["--release", LATER, "--data", str(fixture_tree.data), "--releases", str(fixture_tree.releases)]
        + ["--git-sha", later_sha]
    )
    counts = build_tables.build_inferred(build_tables.context(args, repo_root=repo))
    assert counts == {"inferred.artifacts": 4, "inferred.cells_by_cell": 1}
    assert _epoch_digests(fixture_tree.data, EPOCH) == earlier
    (part,) = _epoch_digests(fixture_tree.data, LATER)
    assert part == f"{CELLS_BY_CELL}/epoch={LATER}/res=4/h3_r0={R0_LAGOS}/part-0.parquet"
    assert provenance.read_kv(fixture_tree.data / part)["genomeos.git_sha"] == later_sha
    frame = pd.read_parquet(fixture_tree.data / contracts.table_path("inferred.artifacts"))
    epochs = dict(zip(frame["artifact"], frame["epoch"], strict=True))
    assert epochs == {HBS_V1: EPOCH, HBS_V3: EPOCH, KIR_V3: EPOCH, NEW_ARTIFACT: LATER}
    firsts = dict(zip(frame["artifact"], frame["first_release"], strict=True))
    assert firsts[NEW_ARTIFACT] == LATER and firsts[KIR_V3] == "2026-10-17"
    (key,) = frame.loc[frame["artifact"] == NEW_ARTIFACT, "cells_key"]
    assert key == f"releases/{LATER}/store/artifacts/{NEW_ARTIFACT}/cells.parquet"


def test_a_second_release_built_over_an_unpublished_epoch_is_refused(fixture_tree, capsys):
    """Two releases built in one tree, the first never committed: its parts are no published epoch, so
    the release builder would key both epochs, every artifact's cells twice (call 6)."""
    assert _run_inferred(fixture_tree) == 0
    stale = _epoch_digests(fixture_tree.data, EPOCH)
    capsys.readouterr()
    assert _run_inferred(fixture_tree, release=LATER) == 1
    error = capsys.readouterr().err
    assert f"4 files under {CELLS_BY_CELL}/" in error and f"epoch={EPOCH}" in error and "remove" in error
    assert not (fixture_tree.data / CELLS_BY_CELL / f"epoch={LATER}").exists()
    assert _epoch_digests(fixture_tree.data, EPOCH) == stale
    shutil.rmtree(fixture_tree.data / CELLS_BY_CELL / f"epoch={EPOCH}")
    assert _run_inferred(fixture_tree, release=LATER) == 0
    assert len(_epoch_digests(fixture_tree.data, LATER)) == 4


def test_an_earlier_epoch_listed_but_not_fetched_is_refused(fixture_tree, capsys):
    missing = next(iter(_release_first_epoch(fixture_tree)))
    (fixture_tree.data / missing).unlink()
    capsys.readouterr()
    assert _run_inferred(fixture_tree, release=LATER) == 1
    error = capsys.readouterr().err
    assert missing in error and "fetch_data.py --prefix tables/" in error
