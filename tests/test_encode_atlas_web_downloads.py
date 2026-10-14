"""``encode_atlas_web.py --with-downloads`` writes the bucket staging tree (design 2026-10-07 §C.2)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from genomeos.publication.web_layout import DOWNLOAD_KINDS, DownloadCopy, apply_download_layout
from scripts import encode_atlas_web
from scripts.atlas_web_staging import StagingError, write_download_copies
from tests.atlas_web_fixtures import MANIFEST, sha256

ROOT = Path(__file__).resolve().parents[1]
ENCODER = ROOT / "scripts" / "encode_atlas_web.py"
EXPORT_TREE = ROOT / "tests" / "fixtures" / "atlas-web" / "export"  # the committed golden export tree


def _encode(in_dir: Path, out_dir: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ENCODER), "--in", str(in_dir), "--out", str(out_dir), *extra],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def _tree(root: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()
    }


@pytest.fixture()
def export_tree(tmp_path: Path) -> Path:
    tree = tmp_path / "export"
    shutil.copytree(EXPORT_TREE, tree)
    return tree


def test_with_downloads_only_rewrites_the_json_urls_of_the_plain_encode(
    export_tree: Path, tmp_path: Path
) -> None:
    plain = _encode(export_tree, tmp_path / "plain")
    assert plain.returncode == 0, plain.stderr
    staged = _encode(export_tree, tmp_path / "staged", "--with-downloads")
    assert staged.returncode == 0, staged.stderr
    plain_catalog = json.loads((tmp_path / "plain" / "catalog.json").read_text(encoding="utf-8"))
    staged_catalog = json.loads((tmp_path / "staged" / "catalog.json").read_text(encoding="utf-8"))
    assert staged_catalog == apply_download_layout(plain_catalog)[0]
    for ref, plain_ref in zip(staged_catalog["artifacts"], plain_catalog["artifacts"], strict=True):
        for kind in DOWNLOAD_KINDS:
            entry = ref["downloads"][kind]
            if entry is None:
                continue
            assert entry["url"] == (
                f"downloads/{ref['id']}/{ref['model_version']}/{ref['data_version']}/"
                f"{ref['id']}.{kind}.{entry['sha256'][:16]}.json"
            )
            source = export_tree / plain_ref["downloads"][kind]["url"]
            assert (tmp_path / "staged" / entry["url"]).read_bytes() == source.read_bytes()
    for grid in staged_catalog["grids"].values():
        assert (tmp_path / "staged" / grid["url"]).is_file()
    for ref in staged_catalog["artifacts"]:
        assert (tmp_path / "staged" / ref["web"]["render"]["url"]).is_file()
        assert (tmp_path / "staged" / ref["web"]["detail"]["url"]).is_file()


def test_with_downloads_is_deterministic_and_re_encodes_its_own_output(
    export_tree: Path, tmp_path: Path
) -> None:
    for name in ("first", "second"):
        result = _encode(export_tree, tmp_path / name, "--with-downloads")
        assert result.returncode == 0, result.stderr
    assert _tree(tmp_path / "first") == _tree(tmp_path / "second")
    again = _encode(tmp_path / "first", tmp_path / "again", "--with-downloads")
    assert again.returncode == 0, again.stderr
    assert (tmp_path / "again" / "catalog.json").read_bytes() == (
        tmp_path / "first" / "catalog.json"
    ).read_bytes()


@pytest.mark.parametrize("out", ["export", "export/staging"], ids=["out-is-in", "out-inside-in"])
def test_with_downloads_refuses_to_stage_into_the_export_tree(
    export_tree: Path, tmp_path: Path, out: str
) -> None:
    before = _tree(export_tree)
    result = _encode(export_tree, tmp_path / out, "--with-downloads")
    assert result.returncode == 1
    assert (
        "encode_atlas_web: --with-downloads writes the bucket staging tree; pass an --out outside --in"
        in result.stderr.splitlines()
    ), result.stderr
    assert _tree(export_tree) == before
    assert not (export_tree / "staging").exists()


@pytest.mark.parametrize("out", ["website/public", "website/public/data/atlas-staging"])
def test_with_downloads_refuses_to_stage_into_the_pages_bundle(
    export_tree: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, out: str
) -> None:
    assert encode_atlas_web.ROOT == ROOT  # the guard protects this checkout's website/public ...
    stand_in = tmp_path / "checkout"
    public = stand_in / "website" / "public"
    public.mkdir(parents=True)
    monkeypatch.setattr(encode_atlas_web, "ROOT", stand_in)  # ... and is exercised on a stand-in tree
    refusal = (
        r"^encode_atlas_web: --with-downloads must not stage into website/public \(it would ship to Pages\)$"
    )
    with pytest.raises(SystemExit, match=refusal):
        encode_atlas_web.main(["--in", str(export_tree), "--out", str(stand_in / out), "--with-downloads"])
    assert sorted(public.rglob("*")) == []


def test_with_downloads_refuses_a_canonical_json_that_differs_from_its_digest(
    export_tree: Path, tmp_path: Path
) -> None:
    catalog = json.loads((export_tree / "catalog.json").read_text(encoding="utf-8"))
    artifact = catalog["artifacts"][0]
    entry = artifact["downloads"]["manifest"]
    manifest = export_tree / entry["url"]
    tampered = manifest.read_bytes() + b" "
    manifest.write_bytes(tampered)
    result = _encode(export_tree, tmp_path / "staged", "--with-downloads")
    assert result.returncode == 1
    assert (
        f"encode_atlas_web: {entry['url']}: sha256 {sha256(tampered)} does not match the catalog digest "
        f"{entry['sha256']}"
    ) in result.stderr.splitlines(), result.stderr
    assert "Traceback" not in result.stderr
    assert not (tmp_path / "staged" / "catalog.json").exists()
    assert sorted((tmp_path / "staged" / "downloads").rglob(f"{artifact['id']}.manifest.*")) == []


def _manifest_copy() -> DownloadCopy:
    key = f"downloads/hbs-test/v1/map-test/hbs-test.manifest.{sha256(MANIFEST)[:16]}.json"
    return DownloadCopy("hbs-test.manifest.json", key, sha256(MANIFEST))


def test_download_copies_are_byte_identical_and_idempotent(tmp_path: Path) -> None:
    (tmp_path / "in").mkdir()
    (tmp_path / "in" / "hbs-test.manifest.json").write_bytes(MANIFEST)
    item = _manifest_copy()
    assert write_download_copies(tmp_path / "in", tmp_path / "out", [item]) == [tmp_path / "out" / item.key]
    assert (tmp_path / "out" / item.key).read_bytes() == MANIFEST
    assert write_download_copies(tmp_path / "in", tmp_path / "out", [item]) == []


def test_download_copies_refuse_changed_bytes(tmp_path: Path) -> None:
    (tmp_path / "in").mkdir()
    (tmp_path / "in" / "hbs-test.manifest.json").write_bytes(MANIFEST + b" ")
    with pytest.raises(StagingError, match="does not match the catalog digest"):
        write_download_copies(tmp_path / "in", tmp_path / "out", [_manifest_copy()])
    (tmp_path / "in" / "hbs-test.manifest.json").write_bytes(MANIFEST)
    target = tmp_path / "out" / _manifest_copy().key
    target.parent.mkdir(parents=True)
    target.write_bytes(b"other")
    with pytest.raises(StagingError, match="different bytes"):
        write_download_copies(tmp_path / "in", tmp_path / "out", [_manifest_copy()])


def test_an_interrupted_download_copy_leaves_nothing_at_its_key_and_a_rerun_recovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "in").mkdir()
    (tmp_path / "in" / "hbs-test.manifest.json").write_bytes(MANIFEST)
    item = _manifest_copy()
    real_replace = os.replace

    def interrupt(source: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
        if Path(destination) == tmp_path / "out" / item.key:
            raise KeyboardInterrupt  # Ctrl-C after the bytes are written, before they are published
        real_replace(source, destination)

    monkeypatch.setattr(os, "replace", interrupt)
    with pytest.raises(KeyboardInterrupt):
        write_download_copies(tmp_path / "in", tmp_path / "out", [item])
    assert [path for path in (tmp_path / "out").rglob("*") if path.is_file()] == []  # no partial, no temp

    monkeypatch.undo()
    assert write_download_copies(tmp_path / "in", tmp_path / "out", [item]) == [tmp_path / "out" / item.key]
    assert (tmp_path / "out" / item.key).read_bytes() == MANIFEST
