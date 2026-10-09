"""``encode_atlas_web.py --with-downloads`` writes the bucket staging tree (design 2026-10-07 §C.2)."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from genomeos.publication.web_layout import DOWNLOAD_KINDS, DownloadCopy, apply_download_layout
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


def test_with_downloads_refuses_to_stage_into_the_export_tree(export_tree: Path) -> None:
    result = _encode(export_tree, export_tree, "--with-downloads")
    assert result.returncode != 0
    assert "--with-downloads" in result.stderr
    assert not (export_tree / "downloads").exists()


def test_with_downloads_refuses_to_stage_into_the_pages_bundle(export_tree: Path) -> None:
    target = ROOT / "website" / "public" / "data" / "atlas-staging-refusal-test"
    result = _encode(export_tree, target, "--with-downloads")
    assert result.returncode != 0
    assert "website/public" in result.stderr
    assert not target.exists()


def test_with_downloads_refuses_a_canonical_json_that_differs_from_its_digest(
    export_tree: Path, tmp_path: Path
) -> None:
    catalog = json.loads((export_tree / "catalog.json").read_text(encoding="utf-8"))
    manifest = export_tree / catalog["artifacts"][0]["downloads"]["manifest"]["url"]
    manifest.write_bytes(manifest.read_bytes() + b" ")
    result = _encode(export_tree, tmp_path / "staged", "--with-downloads")
    assert result.returncode != 0
    assert not (tmp_path / "staged" / "catalog.json").exists()


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
