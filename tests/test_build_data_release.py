"""Building a data-store release from a local data/ tree (data store design 2026-10-17 §5)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from genomeos.publication import artifact_inputs as ai
from genomeos.publication import data_release as dr
from genomeos.publication.commercial_use import COMMERCIAL_USE_FINDINGS
from genomeos.surfaces.fit_input import OBSERVATIONS_CONTRACT, OBSERVATIONS_FILE, serialize_observations
from scripts import build_data_release as build
from tests.observation_fixtures import observation_rows

ROOT = Path(__file__).resolve().parents[1]
RELEASE = "2026-10-17"
ARTIFACT = "store/artifacts/chr11-5227002-T-A__v3__map-2026-08"
AFND_ARTIFACT = "store/artifacts/hla__a-02-01__v2__afnd-2026-08"


def _write(root: Path, path: str, data: bytes) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def _artifact(root: Path, directory: str, data_version: str, *, grid: str | None = None, n: int = 6) -> None:
    """An artifact directory as `publish()` writes it: cells, the fit's input, then the manifest."""
    payload, record = serialize_observations(observation_rows(n))
    manifest = {"data_version": data_version, "n_observations": n, "observations": record.__dict__}
    if grid is not None:
        manifest["target_grid_source"] = grid
    _write(root, f"{directory}/cells.parquet", b"PAR1 stand-in")
    _write(root, f"{directory}/{OBSERVATIONS_FILE}", payload)
    _write(root, f"{directory}/manifest.json", json.dumps(manifest).encode())


def _without_input(root: Path, directory: str) -> None:
    """An artifact as the releases before #45 published it: no input file, no input record."""
    (root / directory / OBSERVATIONS_FILE).unlink()
    manifest = json.loads((root / directory / "manifest.json").read_text())
    del manifest["observations"]
    _write(root, f"{directory}/manifest.json", json.dumps(manifest).encode())


def _build(root: Path, release: str = RELEASE, **options) -> dict:
    options.setdefault("tracked", set())
    options.setdefault("released_without_input", {})
    return build.build(root, release, **options)


@pytest.fixture()
def tree(tmp_path: Path) -> Path:
    """A tiny data/ tree with one file under every include root and both committed SOURCE.json files."""
    root = tmp_path / "data"
    _artifact(root, ARTIFACT, "map-2026-08", grid="worldpop-1km-unconstrained")
    _artifact(root, AFND_ARTIFACT, "afnd-2026-08")
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
    manifest = _build(tree, tracked=tracked)
    objects = _paths(manifest)
    assert "store/fits/never.fit.pkl" not in objects
    assert objects[f"{ARTIFACT}/cells.parquet"]["sources"] == ["map", "worldpop"]
    assert objects[f"{AFND_ARTIFACT}/manifest.json"]["sources"] == ["afnd"]
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
    sources = _build(tree)["sources"]
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
    first = dr.canonical_bytes(_build(tree))
    second = dr.canonical_bytes(_build(tree))
    assert first == second


def test_a_path_without_a_reviewed_source_rule_is_refused(tree: Path) -> None:
    _write(tree, "validation/new_experiment.csv", b"x\n")
    with pytest.raises(dr.DataReleaseError, match="no reviewed source rule"):
        _build(tree)


def test_a_pickle_inside_an_include_root_is_refused(tree: Path) -> None:
    _write(tree, "validation/fit.pkl", b"\x80\x04")
    with pytest.raises(dr.DataReleaseError, match="pickle"):
        _build(tree)


def test_an_object_dtype_npy_is_refused_as_a_pickle(tree: Path) -> None:
    target = tree / "validation/b0h-timing-20260910-01/arrays/bad.npy"
    target.parent.mkdir(parents=True, exist_ok=True)
    np.save(target, np.array([{"a": 1}], dtype=object), allow_pickle=True)
    with pytest.raises(dr.DataReleaseError, match="pickle"):
        _build(tree)
    np.save(target, np.zeros(3))
    _build(tree)


def test_artifact_directory_and_manifest_must_agree(tree: Path) -> None:
    _write(tree, f"{ARTIFACT}/manifest.json", b'{"data_version": "afnd-2026-08"}')
    with pytest.raises(dr.DataReleaseError, match="data_version"):
        _build(tree)


def test_an_unknown_data_version_prefix_is_refused(tree: Path) -> None:
    _write(tree, "store/artifacts/x__v1__gnomad-2026-08/manifest.json", b'{"data_version": "gnomad-2026-08"}')
    with pytest.raises(dr.DataReleaseError, match="gnomad-2026-08"):
        _build(tree)


def test_cli_writes_once_and_refuses_to_replace_a_different_release(
    tree: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(build, "RELEASED_WITHOUT_INPUT", {})
    out = tmp_path / "releases" / f"{RELEASE}.json"
    arguments = ["--data", str(tree), "--release", RELEASE, "--out", str(out), "--no-git"]
    assert build.main(arguments) == 0
    written = out.read_bytes()
    assert build.main(arguments) == 0  # identical: unchanged, not rewritten
    assert out.read_bytes() == written
    _write(tree, "store/INVENTORY.json", b'{"changed": true}')
    assert build.main(arguments) == 1
    assert out.read_bytes() == written


def test_cli_reuses_keys_from_earlier_committed_releases(
    tree: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(build, "RELEASED_WITHOUT_INPUT", {})
    releases = tmp_path / "releases"
    first = ["--data", str(tree), "--release", "2026-10-01", "--out", str(releases / "2026-10-01.json")]
    assert build.main([*first, "--no-git"]) == 0
    _write(tree, "store/INVENTORY.json", b'{"changed": true}')
    out = releases / f"{RELEASE}.json"
    assert build.main(["--data", str(tree), "--release", RELEASE, "--out", str(out), "--no-git"]) == 0
    keys = {item["path"]: item["key"] for item in json.loads(out.read_text())["objects"]}
    assert keys[f"{ARTIFACT}/cells.parquet"] == f"releases/2026-10-01/{ARTIFACT}/cells.parquet"
    assert keys[f"{ARTIFACT}/{OBSERVATIONS_FILE}"] == f"releases/2026-10-01/{ARTIFACT}/{OBSERVATIONS_FILE}"
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


# --- inputs travel with outputs (#45) ---


def test_an_artifacts_input_is_released_with_the_data_source_alone(tree: Path) -> None:
    """WorldPop chose the target cells; it contributed nothing to the observation rows."""
    objects = _paths(_build(tree))
    assert objects[f"{ARTIFACT}/{OBSERVATIONS_FILE}"]["sources"] == ["map"]
    assert objects[f"{ARTIFACT}/{OBSERVATIONS_FILE}"]["media_type"] == "application/vnd.apache.parquet"
    assert objects[f"{AFND_ARTIFACT}/{OBSERVATIONS_FILE}"]["sources"] == ["afnd"]


def test_a_new_artifact_without_its_input_is_refused(tree: Path) -> None:
    (tree / ARTIFACT / OBSERVATIONS_FILE).unlink()
    with pytest.raises(dr.DataReleaseError, match=f"no {OBSERVATIONS_FILE}"):
        _build(tree)


def test_a_new_artifact_whose_manifest_does_not_record_its_input_is_refused(tree: Path) -> None:
    manifest = json.loads((tree / ARTIFACT / "manifest.json").read_text())
    del manifest["observations"]
    _write(tree, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    with pytest.raises(dr.DataReleaseError, match="records no observations"):
        _build(tree)


def test_an_input_whose_recorded_hash_does_not_match_is_refused(tree: Path) -> None:
    other, _ = serialize_observations(observation_rows(5))
    _write(tree, f"{ARTIFACT}/{OBSERVATIONS_FILE}", other)
    with pytest.raises(dr.DataReleaseError, match="sha256"):
        _build(tree)


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("row_count", 5, "row_count"),
        ("columns", ["variant_id", "frequency"], "columns"),
        ("path", "inputs.parquet", "path"),
        ("schema", "contract/carrier_observations.schema.json", "schema"),
        ("frequency", 0.1, "unknown fields"),
    ],
)
def test_an_input_record_that_misdescribes_the_file_is_refused(
    tree: Path, field: str, value: object, match: str
) -> None:
    manifest = json.loads((tree / ARTIFACT / "manifest.json").read_text())
    manifest["observations"][field] = value
    _write(tree, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    with pytest.raises(dr.DataReleaseError, match=match):
        _build(tree)


def test_the_input_row_count_must_be_the_artifacts_n_observations(tree: Path) -> None:
    manifest = json.loads((tree / ARTIFACT / "manifest.json").read_text())
    manifest["n_observations"] = 1071
    _write(tree, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    with pytest.raises(dr.DataReleaseError, match="n_observations"):
        _build(tree)


def _history(tree: Path) -> tuple[list[dict], dict[str, str]]:
    """Release 2026-10-01, in which ARTIFACT was published without its input (as before #45)."""
    _without_input(tree, ARTIFACT)
    exempt = {ARTIFACT.split("/")[2]: "released before inputs travelled with outputs"}
    earlier = build.collect(tree, set())
    used = {name for record in earlier for name in record.sources}
    available = {**build.REVIEWED_SOURCES, **build._record_sources(tree)}
    previous = dr.build_manifest(earlier, {name: available[name] for name in used}, "2026-10-01")
    assert f"{ARTIFACT}/{OBSERVATIONS_FILE}" not in _paths(previous)
    return [previous], exempt


def test_a_listed_released_artifact_without_its_input_is_carried_forward(tree: Path) -> None:
    previous, exempt = _history(tree)
    objects = _paths(_build(tree, previous=previous, released_without_input=exempt))
    assert f"{ARTIFACT}/cells.parquet" in objects
    assert f"{ARTIFACT}/{OBSERVATIONS_FILE}" not in objects


def test_a_released_artifact_cannot_gain_its_input(tree: Path) -> None:
    """Immutable means immutable: backfilling an input is a follow-up, never a new file in a cited key."""
    previous, exempt = _history(tree)
    payload, _ = serialize_observations(observation_rows())
    _write(tree, f"{ARTIFACT}/{OBSERVATIONS_FILE}", payload)
    with pytest.raises(dr.DataReleaseError, match="cannot gain"):
        _build(tree, previous=previous, released_without_input=exempt)


def test_a_released_artifact_without_its_input_must_be_listed_with_a_reason(tree: Path) -> None:
    """Nothing is grandfathered by default."""
    previous, exempt = _history(tree)
    with pytest.raises(dr.DataReleaseError, match="RELEASED_WITHOUT_INPUT"):
        _build(tree, previous=previous, released_without_input={})
    blank = dict.fromkeys(exempt, " ")
    with pytest.raises(dr.DataReleaseError, match="reason"):
        _build(tree, previous=previous, released_without_input=blank)


def test_only_an_artifact_an_earlier_release_holds_may_be_listed(tree: Path) -> None:
    """The list is a record of the past, not a way to publish a new artifact without its input."""
    _without_input(tree, ARTIFACT)
    exempt = {ARTIFACT.split("/")[2]: "not released yet"}
    with pytest.raises(dr.DataReleaseError, match="no earlier release holds it"):
        _build(tree, released_without_input=exempt)


def test_the_list_is_exactly_the_committed_artifacts_released_without_their_input() -> None:
    """Every released artifact either carries its input or is listed; every entry was released bare."""
    held: dict[str, set[str]] = {}
    for path in sorted((ROOT / "data" / "releases").glob("*.json")):
        for item in json.loads(path.read_text(encoding="utf-8"))["objects"]:
            if item["path"].startswith(dr.ARTIFACT_PREFIX):
                directory, name = item["path"][len(dr.ARTIFACT_PREFIX) :].split("/", 1)
                held.setdefault(directory, set()).add(name)
    bare = {directory for directory, names in held.items() if OBSERVATIONS_FILE not in names}
    assert set(build.RELEASED_WITHOUT_INPUT) == bare
    assert all(reason.strip() for reason in build.RELEASED_WITHOUT_INPUT.values())


def test_the_release_rule_and_the_publisher_agree_on_the_input() -> None:
    assert ai.INPUT_FILE == OBSERVATIONS_FILE
    assert ai.INPUT_CONTRACT == OBSERVATIONS_CONTRACT
