"""Building a data-store release from a local data/ tree (data store design 2026-10-17 §5)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from genomeos.publication import data_release as dr
from genomeos.publication.commercial_use import COMMERCIAL_USE_FINDINGS
from scripts import build_data_release as build

ROOT = Path(__file__).resolve().parents[1]
RELEASE = "2026-10-17"
ARTIFACT = "store/artifacts/chr11-5227002-T-A__v3__map-2026-08"


def _write(root: Path, path: str, data: bytes) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


@pytest.fixture()
def tree(tmp_path: Path) -> Path:
    """A tiny data/ tree with one file under every include root and both committed SOURCE.json files."""
    root = tmp_path / "data"
    manifest = {"data_version": "map-2026-08", "target_grid_source": "worldpop-1km-unconstrained"}
    _write(root, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    _write(root, f"{ARTIFACT}/cells.parquet", b"PAR1 stand-in")
    afnd = "store/artifacts/hla__a-02-01__v2__afnd-2026-08/manifest.json"
    _write(root, afnd, b'{"data_version": "afnd-2026-08"}')
    _write(root, "store/INVENTORY.json", b"{}")
    _write(root, "store/catalog-metadata.json", b"{}")
    _write(root, "validation/crossval_summary.json", b"{}")
    _write(root, "validation/b0h-timing-20260910-01/report.json", b"{}")
    _write(root, f"validation/{build.PARITY_INPUT}/piel-comparable-observations.tsv", b"variant_id\n")
    _write(root, "raw/afnd_populations.tsv", b"pop_id\tpopulation\n")
    _write(root, "registry/variant_normalization.tsv", b"variant_id\n")
    _write(root, "registry/curated-v1-candidate.1/MANIFEST.json", b"{}")
    for source in ("sources/cpic/v1.60.0/SOURCE.json", "sources/curated/SOURCE.json"):
        _write(root, source, (ROOT / "data" / source).read_bytes())
    _write(root, "store/fits/never.fit.pkl", b"not published: outside every include root")
    return root


def _paths(manifest: dict) -> dict[str, dict]:
    return {item["path"]: item for item in manifest["objects"]}


def test_build_hashes_every_included_file_and_maps_sources(tree: Path) -> None:
    tracked = {"raw/afnd_populations.tsv", "store/INVENTORY.json"}
    manifest = build.build(tree, RELEASE, tracked=tracked)
    objects = _paths(manifest)
    assert "store/fits/never.fit.pkl" not in objects
    assert objects[f"{ARTIFACT}/cells.parquet"]["sources"] == ["map", "worldpop"]
    assert objects["store/artifacts/hla__a-02-01__v2__afnd-2026-08/manifest.json"]["sources"] == ["afnd"]
    assert objects["validation/crossval_summary.json"]["sources"] == ["map"]
    assert objects["validation/b0h-timing-20260910-01/report.json"]["sources"] == ["genomeos"]
    parity = f"validation/{build.PARITY_INPUT}/piel-comparable-observations.tsv"
    assert objects[parity]["sources"] == ["map"]
    assert objects["sources/curated/SOURCE.json"]["sources"] == ["clinvar", "genereviews"]
    registry = objects["registry/curated-v1-candidate.1/MANIFEST.json"]
    assert registry["sources"] == ["clinvar", "cpic", "genereviews"]
    assert objects["raw/afnd_populations.tsv"]["in_git"] is True
    assert objects[f"{ARTIFACT}/cells.parquet"]["in_git"] is False
    data = (tree / ARTIFACT / "cells.parquet").read_bytes()
    assert objects[f"{ARTIFACT}/cells.parquet"]["sha256"] == hashlib.sha256(data).hexdigest()
    assert objects[f"{ARTIFACT}/cells.parquet"]["bytes"] == len(data)
    dr.validate_manifest(manifest)


def test_terms_are_copied_from_the_committed_records(tree: Path) -> None:
    sources = build.build(tree, RELEASE, tracked=set())["sources"]
    cpic = json.loads((tree / "sources/cpic/v1.60.0/SOURCE.json").read_text())
    assert sources["cpic"]["terms"] == {
        "status": cpic["terms_status"],
        "checked_at": cpic["terms_checked_at"],
        "terms_url": cpic["terms_url"],
        "licence": cpic["content_license"],
        "recorded_in": "data/sources/cpic/v1.60.0/SOURCE.json",
    }
    curated = json.loads((tree / "sources/curated/SOURCE.json").read_text())["sources"]
    assert sources["genereviews"]["terms"]["status"] == curated["GeneReviews"]["reuse_status"]
    assert sources["genereviews"]["non_commercial"] is True
    assert sources["clinvar"]["terms"]["status"] == curated["ClinVar"]["reuse_status"]
    assert sources["clinvar"]["non_commercial"] is False
    assert sources["afnd"]["terms"]["recorded_in"].endswith("/issues/117")
    assert sources["map"]["terms"]["status"] in COMMERCIAL_USE_FINDINGS
    assert sources["map"]["terms"]["status"] != dr.NOT_CHECKED
    assert sources["map"]["terms"]["terms_url"] == "https://malariaatlas.org/open-access-policy/"
    assert (ROOT / sources["map"]["terms"]["recorded_in"]).is_file()
    assert sources["worldpop"]["terms"]["status"] == dr.NOT_CHECKED


def test_output_is_deterministic(tree: Path) -> None:
    first = dr.canonical_bytes(build.build(tree, RELEASE, tracked=set()))
    second = dr.canonical_bytes(build.build(tree, RELEASE, tracked=set()))
    assert first == second


def test_a_path_without_a_reviewed_source_rule_is_refused(tree: Path) -> None:
    _write(tree, "validation/new_experiment.csv", b"x\n")
    with pytest.raises(dr.DataReleaseError, match="no reviewed source rule"):
        build.build(tree, RELEASE, tracked=set())


def test_a_pickle_inside_an_include_root_is_refused(tree: Path) -> None:
    _write(tree, "validation/fit.pkl", b"\x80\x04")
    with pytest.raises(dr.DataReleaseError, match="pickle"):
        build.build(tree, RELEASE, tracked=set())


def test_an_object_dtype_npy_is_refused_as_a_pickle(tree: Path) -> None:
    target = tree / "validation/b0h-timing-20260910-01/arrays/bad.npy"
    target.parent.mkdir(parents=True, exist_ok=True)
    np.save(target, np.array([{"a": 1}], dtype=object), allow_pickle=True)
    with pytest.raises(dr.DataReleaseError, match="pickle"):
        build.build(tree, RELEASE, tracked=set())
    np.save(target, np.zeros(3))
    build.build(tree, RELEASE, tracked=set())


def test_artifact_directory_and_manifest_must_agree(tree: Path) -> None:
    _write(tree, f"{ARTIFACT}/manifest.json", b'{"data_version": "afnd-2026-08"}')
    with pytest.raises(dr.DataReleaseError, match="data_version"):
        build.build(tree, RELEASE, tracked=set())


def test_an_unknown_data_version_prefix_is_refused(tree: Path) -> None:
    _write(tree, "store/artifacts/x__v1__gnomad-2026-08/manifest.json", b'{"data_version": "gnomad-2026-08"}')
    with pytest.raises(dr.DataReleaseError, match="gnomad-2026-08"):
        build.build(tree, RELEASE, tracked=set())


def test_cli_writes_once_and_refuses_to_replace_a_different_release(tree: Path, tmp_path: Path) -> None:
    out = tmp_path / "releases" / f"{RELEASE}.json"
    arguments = ["--data", str(tree), "--release", RELEASE, "--out", str(out), "--no-git"]
    assert build.main(arguments) == 0
    written = out.read_bytes()
    assert build.main(arguments) == 0  # identical: unchanged, not rewritten
    assert out.read_bytes() == written
    _write(tree, "store/INVENTORY.json", b'{"changed": true}')
    assert build.main(arguments) == 1
    assert out.read_bytes() == written


def test_cli_reuses_keys_from_earlier_committed_releases(tree: Path, tmp_path: Path) -> None:
    releases = tmp_path / "releases"
    first = ["--data", str(tree), "--release", "2026-10-01", "--out", str(releases / "2026-10-01.json")]
    assert build.main([*first, "--no-git"]) == 0
    _write(tree, "store/INVENTORY.json", b'{"changed": true}')
    out = releases / f"{RELEASE}.json"
    assert build.main(["--data", str(tree), "--release", RELEASE, "--out", str(out), "--no-git"]) == 0
    keys = {item["path"]: item["key"] for item in json.loads(out.read_text())["objects"]}
    assert keys[f"{ARTIFACT}/cells.parquet"] == f"releases/2026-10-01/{ARTIFACT}/cells.parquet"
    assert keys["store/INVENTORY.json"] == f"releases/{RELEASE}/store/INVENTORY.json"


def test_committed_releases_validate() -> None:
    committed = sorted((ROOT / "data" / "releases").glob("*.json"))
    for path in committed:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        assert path.name == f"{manifest['release']}.json"
        assert path.read_bytes() == dr.canonical_bytes(manifest)
        dr.validate_manifest(manifest)


def test_include_roots_cover_the_committed_inputs() -> None:
    for path in ("raw/afnd_populations.tsv", "registry", "sources", "store/INVENTORY.json"):
        assert any(path == root or path.startswith(f"{root}/") for root in build.INCLUDE), path
