"""Building a data-store release from a local data/ tree (data store design 2026-10-17 §5)."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest

from genomeos.publication import artifact_inputs as ai
from genomeos.publication import data_release as dr
from genomeos.publication import raw_harvests as rh
from genomeos.publication.commercial_use import COMMERCIAL_USE_FINDINGS
from genomeos.surfaces.fit_input import (
    FIT_COUNTS,
    INPUT_CONTRACTS,
    OBSERVATIONS_FILE,
    contract_sha256,
    serialize_observations,
)
from genomeos.tables import catalog, writer
from genomeos.tables.contracts import TableError
from scripts import build_data_release as build
from scripts import build_tables
from tests import tables_fixtures
from tests.observation_fixtures import kir_fit_rows, observation_rows
from tests.tables_fixtures import (
    EPOCH,
    FIXTURE_RELEASE,
    FIXTURE_WITHOUT_INPUT,
    GIT_INPUT_FLAGS,
    HBS_V3,
    FixtureTree,
    build_catalog_tables,
    copy_committed_releases,
    release_catalog_tree,
)
from tests.test_data_release import EMPTY

#: The shared pytest fixture, registered in this module by name.
catalog_tree = tables_fixtures.catalog_tree

ROOT = Path(__file__).resolve().parents[1]
RELEASE = "2026-10-17"
ARTIFACT = "store/artifacts/chr11-5227002-T-A__v3__map-2026-08"
AFND_ARTIFACT = "store/artifacts/hla__a-02-01__v2__afnd-2026-08"
KIR_ARTIFACT = "store/artifacts/kir__2dl1__v9__afnd-2026-08"
ALLELE = "allele_frequency"
CARRIER = "carrier_frequency"


def _write(root: Path, path: str, data: bytes) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def _artifact(
    root: Path,
    directory: str,
    data_version: str,
    *,
    grid: str | None = None,
    n: int = 6,
    measurement: str = ALLELE,
) -> None:
    """An artifact directory as `publish()` writes it: cells, the fit's input, then the manifest."""
    rows = kir_fit_rows(n) if measurement == CARRIER else observation_rows(n)
    payload, record = serialize_observations(rows, measurement=measurement)
    manifest = {
        "data_version": data_version,
        "measurement": measurement,
        "n_observations": n,
        "observations": record.__dict__,
    }
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
    """A tiny data/ tree with one file under every required include root and both SOURCE.json files."""
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
    assert sources["genereviews"]["terms"]["status"] == "restricted"  # the record's restriction_found
    assert sources["genereviews"]["non_commercial"] is True
    assert sources["clinvar"]["terms"]["status"] == curated["ClinVar"]["reuse_status"]
    assert sources["clinvar"]["non_commercial"] is False
    assert sources["afnd"]["terms"]["recorded_in"].endswith("/issues/117")
    assert sources["map"]["terms"]["status"] in COMMERCIAL_USE_FINDINGS
    assert sources["map"]["terms"]["status"] != dr.NOT_CHECKED
    assert sources["map"]["terms"]["terms_url"] == "https://malariaatlas.org/open-access-policy/"
    assert (ROOT / sources["map"]["terms"]["recorded_in"]).is_file()


def test_worldpop_is_recorded_as_explicitly_open_from_its_hub() -> None:
    """WorldPop's hub states CC BY 4.0 (owner decision D5b), and the audit quotes it with the date.

    Atlas data platform design 2026-10-18 §1.1, step 1.3.
    """
    terms = build.REVIEWED_SOURCES["worldpop"]["terms"]
    expected = {
        "status": "explicitly_open",
        "terms_url": "https://hub.worldpop.org/",
        "licence": "CC-BY-4.0",
        "recorded_in": "docs/audits/worldpop-commercial-use.md",
    }
    assert {key: terms.get(key) for key in expected} == expected
    audit = (ROOT / terms["recorded_in"]).read_text(encoding="utf-8")
    assert terms["checked_at"] in audit
    assert "CC BY 4.0" in audit
    assert terms["terms_url"] in audit


def test_project_data_is_recorded_as_cc_by_4() -> None:
    """Project-made data is CC BY 4.0 (owner decision D5a), and the README says so.

    Atlas data platform design 2026-10-18 §1.1, step 1.3.
    """
    terms = build.REVIEWED_SOURCES["genomeos"]["terms"]
    expected = {
        "status": "explicitly_open",
        "checked_at": "2026-10-19",
        "terms_url": "https://creativecommons.org/licenses/by/4.0/",
        "licence": "CC-BY-4.0",
        "recorded_in": "README.md",
    }
    assert {key: terms.get(key) for key in expected} == expected
    readme = (ROOT / terms["recorded_in"]).read_text(encoding="utf-8")
    assert "[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)" in readme


def test_a_new_manifest_writes_restricted_and_keeps_non_commercial(tree: Path) -> None:
    """The record keeps its legacy spelling; a new manifest writes the closed one.

    Atlas data platform design 2026-10-18 §9, step 1.3.
    """
    curated = json.loads((tree / "sources/curated/SOURCE.json").read_text())["sources"]
    assert curated["GeneReviews"]["reuse_status"] == "restriction_found"
    genereviews = _build(tree)["sources"]["genereviews"]
    assert (genereviews["terms"]["status"], genereviews["non_commercial"]) == ("restricted", True)


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


def _cli(root: Path, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """``main``'s arguments for release ``EPOCH`` of ``catalog_tree``, whose tables are built here.

    ``main`` always builds the catalog (both passes), so the tree needs its tables and a parity file. It
    also publishes ``RAW_HARVESTS`` and ``EXTERNAL_CACHES``, which this tree does not hold: the harvests
    and the caches have tests of their own.
    """
    monkeypatch.setattr(build, "RELEASED_WITHOUT_INPUT", FIXTURE_WITHOUT_INPUT)
    monkeypatch.setattr(build, "RAW_HARVESTS", ())
    monkeypatch.setattr(build, "EXTERNAL_CACHES", ())
    build_catalog_tables(root)
    out = root / "releases" / f"{EPOCH}.json"
    return ["--data", str(root / "data"), "--release", EPOCH, "--out", str(out), "--no-git"]


def test_cli_writes_once_and_refuses_to_replace_a_different_release(
    catalog_tree: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    arguments = _cli(catalog_tree, monkeypatch)
    out = catalog_tree / "releases" / f"{EPOCH}.json"
    assert build.main(arguments) == 0
    printed = capsys.readouterr().out
    assert "catalog: 8 views over 10 files; atlas.duckdb " in printed
    assert " bytes, identical over two builds" in printed
    written = out.read_bytes()
    assert build.main(arguments) == 0  # identical: unchanged, not rewritten
    assert out.read_bytes() == written
    _write(catalog_tree / "data", "store/INVENTORY.json", b'{"changed": true}')
    assert build.main(arguments) == 1
    assert out.read_bytes() == written


def test_cli_refuses_a_tree_without_the_served_caches_before_writing(
    catalog_tree: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """``main`` publishes the caches the Atlas serves (step 1.8): a tree without them writes no release."""
    assert build.EXTERNAL_CACHES is rh.EXTERNAL_CACHES
    arguments = _cli(catalog_tree, monkeypatch)
    monkeypatch.setattr(build, "EXTERNAL_CACHES", rh.EXTERNAL_CACHES)
    assert build.main(arguments) == 1
    assert "the Atlas serves this cache, but the release lacks it" in capsys.readouterr().err
    assert not (catalog_tree / "releases" / f"{EPOCH}.json").exists()


def test_cli_reuses_keys_from_earlier_committed_releases(
    catalog_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    arguments = _cli(catalog_tree, monkeypatch)
    curated = catalog_tree / "data" / build.CURATED_RECORD
    curated.write_bytes(curated.read_bytes() + b"\n")  # changed since release 2026-10-17
    assert build.main(arguments) == 0
    out = catalog_tree / "releases" / f"{EPOCH}.json"
    keys = {item["path"]: item["key"] for item in json.loads(out.read_text())["objects"]}
    cells = f"{dr.ARTIFACT_PREFIX}{HBS_V3}/cells.parquet"
    assert keys[cells] == f"releases/{FIXTURE_RELEASE}/{cells}"
    assert keys[build.CURATED_RECORD] == f"releases/{EPOCH}/{build.CURATED_RECORD}"
    assert keys["store/INVENTORY.json"] == f"releases/{EPOCH}/store/INVENTORY.json"


def _committed_manifests() -> list[Path]:
    releases = ROOT / "data" / "releases"
    return [releases / f"{name}.json" for name in dr.release_ids(p.name for p in releases.glob("*.json"))]


def test_committed_releases_validate() -> None:
    for path in _committed_manifests():
        manifest = json.loads(path.read_text(encoding="utf-8"))
        assert path.name == f"{manifest['release']}.json"
        assert path.read_bytes() == dr.canonical_bytes(manifest)
        dr.validate_manifest(manifest)


def test_earlier_releases_skip_the_withdrawn_list(tmp_path: Path) -> None:
    """WITHDRAWN.json sits beside the manifests and is never read as one (platform design §2.9)."""
    releases = tmp_path / "releases"
    releases.mkdir()
    record = dr.FileRecord("store/INVENTORY.json", 2, "a" * 64, False, ("genomeos",))
    for release in ("2026-10-01", RELEASE):
        manifest = dr.build_manifest([record], {"genomeos": build.REVIEWED_SOURCES["genomeos"]}, release)
        (releases / f"{release}.json").write_bytes(dr.canonical_bytes(manifest))
    (releases / dr.WITHDRAWN_FILE).write_bytes(dr.canonical_bytes(EMPTY))
    assert [manifest["release"] for manifest in build.earlier_releases(releases, RELEASE)] == ["2026-10-01"]
    (releases / "latest.json").write_bytes(b"{}")
    with pytest.raises(dr.DataReleaseError, match="neither"):
        build.earlier_releases(releases, RELEASE)


def test_include_roots_cover_the_committed_inputs() -> None:
    for path in ("raw/afnd_populations.tsv", "registry", "sources", "store/INVENTORY.json"):
        assert any(path == root or path.startswith(f"{root}/") for root in build.INCLUDE), path


# --- optional include roots (Atlas data platform design 2026-10-18 §2.3, step 1.2) ---


def test_optional_roots_may_be_absent_until_a_release_publishes_under_them(tree: Path) -> None:
    assert {"catalog", "tables"} <= set(build.OPTIONAL_ROOTS) <= set(build.INCLUDE)
    assert not (tree / "catalog").exists() and not (tree / "tables").exists()
    assert not any(path.startswith(("catalog/", "tables/")) for path in _paths(_build(tree)))


def test_an_optional_root_is_required_once_a_release_published_under_it(tree: Path) -> None:
    published = "tables/v1/meta/served.parquet"
    with pytest.raises(dr.DataReleaseError, match="include root data/tables is missing"):
        build.included_files(tree, published={published})
    record = dr.FileRecord(published, 1, "a" * 64, False, ("genomeos",))
    earlier = dr.build_manifest([record], {"genomeos": build.REVIEWED_SOURCES["genomeos"]}, "2026-10-01")
    with pytest.raises(dr.DataReleaseError, match="include root data/tables is missing"):
        _build(tree, previous=[earlier])


def test_an_optional_root_file_needs_a_reviewed_source_rule(tree: Path) -> None:
    _write(tree, "catalog/x.txt", b"x\n")
    with pytest.raises(dr.DataReleaseError, match="no reviewed source rule"):
        _build(tree)


# --- raw harvests and external caches (Atlas data platform design 2026-10-18 §2.1, §4.3; step 1.8) ---

CACHES = {
    "store/external/gnomad/chr11-5227002-t-a.json": "gnomad",
    "store/external/dbsnp/rs334.json": "dbsnp",
    "store/external/alphagenome/chr11-5227002-t-a.json": "alphagenome",
}


def _harvest(root: Path, source: str, version: str, files: dict[str, bytes]) -> rh.RawHarvest:
    """A harvest of ``files``, written under ``raw/<source>/<version>/`` and pinned to their bytes."""
    for name, data in files.items():
        _write(root, f"raw/{source}/{version}/{name}", data)
    return rh.RawHarvest(
        source=source,
        harvest_version=version,
        files=tuple((name, hashlib.sha256(data).hexdigest()) for name, data in sorted(files.items())),
        upstream_url="https://example.org/",
        copied_from=None,
        retrieved_at=rh.NOT_RECORDED,
        fetch_command=f"python scripts/fetch_{source}.py",
    )


def test_harvests_and_caches_carry_their_sources(tree: Path) -> None:
    harvests = [
        _harvest(tree, "afnd", "2026-08", {"afnd_frequencies.tsv": b"population\tallele\n"}),
        _harvest(tree, "worldpop", "2020", {"ppp_2020_1km_Aggregated.tif": b"II*\x00 stand-in"}),
    ]
    documents = {path: {"source": source, "record": {}} for path, source in CACHES.items()}
    for path, document in documents.items():
        _write(tree, path, json.dumps(document).encode())
    caches = tuple(sorted((path, rh.cache_sha256(document)) for path, document in documents.items()))
    objects = _paths(_build(tree, raw_harvests=harvests, external_caches=caches))
    assert objects["raw/afnd/2026-08/afnd_frequencies.tsv"]["sources"] == ["afnd"]
    raster = objects["raw/worldpop/2020/ppp_2020_1km_Aggregated.tif"]
    assert (raster["media_type"], raster["sources"]) == ("image/tiff", ["worldpop"])
    assert objects["raw/afnd_populations.tsv"]["sources"] == ["afnd"]  # the legacy table, unchanged
    assert {path: objects[path]["sources"] for path in CACHES} == {
        path: [source] for path, source in CACHES.items()
    }
    _write(tree, "store/external/other/x.json", b"{}")
    with pytest.raises(dr.DataReleaseError, match="store/external/other/x.json: no reviewed source rule"):
        _build(tree, raw_harvests=harvests, external_caches=caches)


def test_a_raw_file_no_harvest_lists_stays_local_or_is_refused(tree: Path) -> None:
    """Outside every harvest root a raw file is never read; inside one, it must be listed (§2.1)."""
    harvest = _harvest(tree, "afnd", "2026-08", {"afnd_frequencies.tsv": b"population\tallele\n"})
    _write(tree, "raw/afnd_cache/page.html", b"<html/>")
    assert "raw/afnd_cache/page.html" not in _paths(_build(tree, raw_harvests=[harvest]))
    _write(tree, "raw/afnd/2026-08/notes.txt", b"x\n")
    with pytest.raises(dr.DataReleaseError, match="raw/afnd/2026-08/notes.txt: no reviewed raw harvest"):
        _build(tree, raw_harvests=[harvest])


def test_a_harvest_root_that_is_absent_locally_is_a_hard_error(tree: Path) -> None:
    harvest = _harvest(tree, "map", "2026-08", {"map_hbs_surveys.csv": b"id\n"})
    (tree / "raw/map/2026-08/map_hbs_surveys.csv").unlink()
    (tree / "raw/map/2026-08").rmdir()
    with pytest.raises(dr.DataReleaseError, match="data/raw/map/2026-08 is missing; fetch it first"):
        _build(tree, raw_harvests=[harvest])


def test_a_cache_with_a_non_commercial_field_is_refused_by_the_build(tree: Path) -> None:
    _write(tree, "store/external/gnomad/x.json", json.dumps({"record": {"spliceai": 0.1}}).encode())
    with pytest.raises(dr.DataReleaseError, match="split out spliceai before publishing"):
        _build(tree)


def test_a_release_carries_the_caches_the_atlas_serves_with_their_served_content(tree: Path) -> None:
    """The caches are the source caches the Atlas web export read (step 1.8), as the fetcher writes them.
    A missing one, or another fetch of one, fails the build before any release file is written."""
    served = ROOT / "website/public/data/atlas"
    with pytest.raises(dr.DataReleaseError, match="the Atlas serves this cache, but the release lacks it"):
        _build(tree, external_caches=rh.EXTERNAL_CACHES)
    documents = {
        path: json.loads((served / path.removeprefix("store/")).read_text(encoding="utf-8"))
        for path, _ in rh.EXTERNAL_CACHES
    }
    for path, document in documents.items():  # as scripts/fetch_external_variant_info.py writes a cache
        _write(tree, path, (json.dumps(document, indent=2, sort_keys=True) + "\n").encode())
    objects = _paths(_build(tree, external_caches=rh.EXTERNAL_CACHES))
    assert {path: objects[path]["sources"] for path in documents} == {
        path: [path.split("/")[2]] for path in documents
    }
    gnomad = "store/external/gnomad/chr11-5227002-t-a.json"
    _write(tree, gnomad, json.dumps({**documents[gnomad], "schema_version": 1}).encode())
    with pytest.raises(dr.DataReleaseError, match=f"{gnomad}: its content's sha256 .* the Atlas serves"):
        _build(tree, external_caches=rh.EXTERNAL_CACHES)


def test_the_gnomad_hgdp_1kg_terms_are_recorded() -> None:
    source = build.REVIEWED_SOURCES["gnomad_hgdp_1kg"]
    terms = source["terms"]
    assert terms["status"] == "explicitly_open"
    assert terms["licence"] == "CC0-1.0"
    for phrase in ("reidentify", "SpliceAI", "tool's name"):
        assert phrase in terms["note"], phrase
    assert source["non_commercial"] is False
    assert (ROOT / terms["recorded_in"]).is_file()
    record = dr.FileRecord("raw/gnomad_hgdp_1kg/x/y.tsv", 1, "a" * 64, False, ("gnomad_hgdp_1kg",))
    dr.validate_manifest(dr.build_manifest([record], {"gnomad_hgdp_1kg": source}, RELEASE))


def test_the_external_cache_terms_copy_the_web_catalogs_commercial_use() -> None:
    catalog = json.loads((ROOT / "website/src/atlas/public-artifacts.json").read_text(encoding="utf-8"))
    blocks = [
        (resource["source"], resource["commercial_use"])
        for artifact in catalog["artifacts"]
        for resource in artifact.get("external_resources", [])
    ]
    assert {source for source, _ in blocks} == set(rh.EXTERNAL_CACHE_SOURCES)
    for source, block in blocks:
        reviewed = build.REVIEWED_SOURCES[source]
        terms = reviewed["terms"]
        assert {key: terms[key] for key in ("status", "checked_at", "terms_url", "recorded_in")} == {
            "status": block["finding"],
            "checked_at": block["checked_at"],
            "terms_url": block["terms_url"],
            "recorded_in": block["recorded_in"],
        }, source
        # Nothing restricted is published: check_external_cache refuses a known non-commercial field.
        assert block["restricted_fields"] == [] and reviewed["non_commercial"] is False, source


# --- a tables/ file carries its inputs' sources (Atlas data platform design 2026-10-18 §9; call 16) ---


def test_meta_files_carry_their_inputs_sources(tree: Path, tmp_path: Path) -> None:
    releases = copy_committed_releases(tmp_path / "releases")
    arguments = ["--release", "2026-11-20", "--data", str(tree), "--releases", str(releases)]
    built = build_tables.main([*arguments, "--stage", "meta", "--git-sha", "HEAD", *GIT_INPUT_FLAGS])
    assert built == 0
    objects = _paths(_build(tree))
    meta = "tables/v1/meta"
    assert objects[f"{meta}/served.parquet"]["sources"] == ["afnd", "genomeos", "map", "worldpop"]
    for name in ("release_objects", "sources"):
        assert "genereviews" in objects[f"{meta}/{name}.parquet"]["sources"]  # call 16: it survives the union
    assert objects[f"{meta}/withdrawn.parquet"]["sources"] == ["genomeos"]


def test_reference_folders_carry_their_sources(tree: Path, tmp_path: Path) -> None:
    """Step 1.7: each registry folder carries its inputs' sources (call 16), and is written once (call 6)."""
    fixtures = ROOT / "tests" / "fixtures"
    _write(tree, build_tables.AFND_POPULATIONS, (fixtures / "afnd_populations.tsv").read_bytes())
    names = [path.rsplit("/", 1)[1] for path in build_tables.MAP_SURVEYS]
    harvest = _harvest(tree, "map", "2026-08", {name: (fixtures / name).read_bytes() for name in names})
    fixture = FixtureTree(tmp_path, tree, tmp_path / "releases")
    built = build_tables.build_reference(fixture.context(release=EPOCH))
    manifest = _build(tree, EPOCH, raw_harvests=[harvest])
    objects = _paths(manifest)
    assert {path: objects[path]["sources"] for path in built} == {
        "tables/v1/reference/populations/afnd-2026-08/population_aliases.parquet": ["afnd"],
        "tables/v1/reference/populations/afnd-2026-08/populations.parquet": ["afnd"],
        "tables/v1/reference/populations/map-survey-coordinates-v1/population_aliases.parquet": ["map"],
    }
    # Rewritten under another git sha (as if never released), the folder's bytes change.
    build_tables.build_reference(fixture.context(release="2026-11-21", git_sha="1" * 40))
    immutable = "reference/populations/afnd-2026-08/.*a released part is immutable"
    with pytest.raises(dr.DataReleaseError, match=immutable):
        _build(tree, "2026-11-21", raw_harvests=[harvest], previous=[manifest])


def test_an_unstamped_tables_file_is_refused(tree: Path) -> None:
    out = tree / "tables/v1/meta/served.parquet"
    out.parent.mkdir(parents=True)
    writer.connect().execute(f"COPY (SELECT 'a' AS artifact) TO '{out}' (FORMAT parquet)")
    with pytest.raises(TableError, match="genomeos.sources"):
        _build(tree)


# --- the catalog, in two passes (Atlas data platform design 2026-10-18 §2.6; calls 4 and 17, step 1.6) ---


def test_the_release_lists_the_catalog(catalog_tree: Path) -> None:
    build_catalog_tables(catalog_tree)
    manifest = release_catalog_tree(catalog_tree)
    objects = _paths(manifest)
    sql_object, database = objects[catalog.CATALOG_SQL], objects[catalog.CATALOG_DB]
    assert (sql_object["media_type"], sql_object["in_git"]) == ("application/sql", True)
    assert (database["media_type"], database["in_git"]) == ("application/octet-stream", False)
    assert objects[catalog.TABLES_JSON]["in_git"] is False
    sql = (catalog_tree / "data" / catalog.CATALOG_SQL).read_text(encoding="utf-8")
    keys = {item["key"] for item in manifest["objects"]}
    urls = catalog.catalog_urls(sql)
    assert len(urls) == 10
    assert all(url.startswith(dr.DATA_STORE_BASE_URL) for url in urls)
    assert {url.removeprefix(dr.DATA_STORE_BASE_URL) for url in urls} <= keys
    assert "genereviews" in sql_object["sources"]  # call 16: a non_commercial source survives the union
    assert manifest["sources"]["genereviews"]["non_commercial"] is True
    # §9: meta.release names the manifest's key and cite_as cites it, so each catalog/ file carries every
    # source of the release, cpic included, though no file the catalog lists derives from sources/cpic/
    # (first published in this release).
    assert "cpic" in manifest["sources"]
    assert {path: objects[path]["sources"] for path in catalog.CATALOG_PATHS} == {
        path: sorted(manifest["sources"]) for path in catalog.CATALOG_PATHS
    }


def test_a_stray_catalog_file_is_refused(catalog_tree: Path) -> None:
    """Pass 1 skips catalog/, so the stray reaches pass 5 instead of the source rules."""
    build_catalog_tables(catalog_tree)
    _write(catalog_tree / "data", "catalog/notes.txt", b"x\n")
    with pytest.raises(dr.DataReleaseError, match="catalog/notes.txt: data/catalog/ holds only"):
        release_catalog_tree(catalog_tree)


def test_two_differing_catalog_builds_are_refused(
    catalog_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    build_catalog_tables(catalog_tree)
    real = writer.build_catalog_db
    calls: list[Path] = []

    def differing(sql: str, out: Path, *, data_root: Path) -> Path:
        built = real(sql, out, data_root=data_root)
        calls.append(out)
        if len(calls) == 2:
            with built.open("ab") as stream:
                stream.write(b"\0")
        return built

    monkeypatch.setattr(writer, "build_catalog_db", differing)
    with pytest.raises(TableError, match="two builds differ"):
        release_catalog_tree(catalog_tree)
    assert len(calls) == 2
    assert not (catalog_tree / "data" / catalog.CATALOG_DB).exists()


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
    other, _ = serialize_observations(observation_rows(5), measurement=ALLELE)
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
        ("measurement", CARRIER, "measurement"),
        ("measurement", "phenotype_frequency", "measurement"),
        ("schema_sha256", "0" * 64, "revision"),
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


def test_an_input_record_whose_byte_count_is_not_an_integer_is_refused(tree: Path) -> None:
    """1234.0 == 1234 in Python, but the project's reader refuses it, so the gate must too."""
    manifest = json.loads((tree / ARTIFACT / "manifest.json").read_text())
    manifest["observations"]["bytes"] = float(manifest["observations"]["bytes"])
    _write(tree, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    with pytest.raises(dr.DataReleaseError, match="bytes .* is not an integer"):
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
    payload, _ = serialize_observations(observation_rows(), measurement=ALLELE)
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
    for path in _committed_manifests():
        for item in json.loads(path.read_text(encoding="utf-8"))["objects"]:
            if item["path"].startswith(dr.ARTIFACT_PREFIX):
                directory, name = item["path"][len(dr.ARTIFACT_PREFIX) :].split("/", 1)
                held.setdefault(directory, set()).add(name)
    bare = {directory for directory, names in held.items() if OBSERVATIONS_FILE not in names}
    assert set(build.RELEASED_WITHOUT_INPUT) == bare
    assert all(reason.strip() for reason in build.RELEASED_WITHOUT_INPUT.values())


def test_the_release_rule_and_the_publisher_agree_on_the_input() -> None:
    assert ai.INPUT_FILE == OBSERVATIONS_FILE
    assert dict(ai.INPUT_CONTRACTS) == {name: contract.path for name, contract in INPUT_CONTRACTS.items()}
    assert dict(ai.COUNT_COLUMNS) == {name: contract.counts for name, contract in INPUT_CONTRACTS.items()}
    assert ai.COUNT_COLUMNS[ALLELE] == FIT_COUNTS


@pytest.mark.parametrize("measurement", [ALLELE, CARRIER])
def test_the_release_rule_knows_the_current_revision_of_every_input_contract(measurement: str) -> None:
    """A contract revision is a reviewed event: its sha256 is appended to `CONTRACT_REVISIONS`.

    The publisher writes the current revision's columns, so the gate's columns for that digest are
    exactly the publisher's.
    """
    digest = contract_sha256(measurement)
    assert digest in ai.CONTRACT_REVISIONS[ai.INPUT_CONTRACTS[measurement]]
    assert ai.REVISION_COLUMNS[digest] == tuple(INPUT_CONTRACTS[measurement].schema.columns)


def test_every_recorded_contract_revision_has_its_columns() -> None:
    """The gate checks an input against the revision it cites, so no recorded revision may lack columns."""
    revisions = [digest for digests in ai.CONTRACT_REVISIONS.values() for digest in digests]
    assert len(revisions) == len(set(revisions))
    assert set(ai.REVISION_COLUMNS) == set(revisions)
    for contract, digests in ai.CONTRACT_REVISIONS.items():
        (measurement,) = [m for m, path in ai.INPUT_CONTRACTS.items() if path == contract]
        for digest in digests:
            assert set(ai.COUNT_COLUMNS[measurement]) <= set(ai.REVISION_COLUMNS[digest])


def test_an_input_published_under_an_earlier_contract_revision_stays_valid(
    tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A revision that changes the columns must not fail every input released before it (#45).

    Simulated: the allele contract gains a column. The artifact on disk was published under the
    revision before, so it is checked against that revision's columns and still passes; the same
    file citing the later revision lacks the new column, and is refused.
    """
    earlier, later = contract_sha256(ALLELE), "f" * 64
    revisions = {**ai.CONTRACT_REVISIONS, ai.INPUT_CONTRACTS[ALLELE]: frozenset({earlier, later})}
    columns = {**ai.REVISION_COLUMNS, later: (*ai.REVISION_COLUMNS[earlier], "added_column")}
    monkeypatch.setattr(ai, "CONTRACT_REVISIONS", revisions)
    monkeypatch.setattr(ai, "REVISION_COLUMNS", columns)
    assert f"{ARTIFACT}/{OBSERVATIONS_FILE}" in _paths(_build(tree))
    manifest = json.loads((tree / ARTIFACT / "manifest.json").read_text())
    manifest["observations"]["schema_sha256"] = later
    _write(tree, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    with pytest.raises(dr.DataReleaseError, match="added_column"):
        _build(tree)


def test_an_artifact_exactly_as_publish_writes_it_is_released(tree: Path) -> None:
    """The publisher's manifest record and the release rule are one contract, end to end."""
    from genomeos.surfaces.artifacts import publish
    from tests.test_artifacts import _frame, _manifest, _observations

    directory = publish(
        _frame(),
        tree / dr.ARTIFACT_PREFIX,
        manifest=_manifest(model_version="v9"),
        observations=_observations(),
    )
    objects = _paths(_build(tree))
    path = f"{dr.ARTIFACT_PREFIX}{directory.name}/{OBSERVATIONS_FILE}"
    assert objects[path]["sha256"] == hashlib.sha256((directory / OBSERVATIONS_FILE).read_bytes()).hexdigest()
    assert objects[path]["sources"] == ["map"]


# --- a carrier input is released as carriers over individuals (#133) ---


def test_a_kir_artifact_is_released_with_carriers_over_individuals(tree: Path) -> None:
    _artifact(tree, KIR_ARTIFACT, "afnd-2026-08", measurement=CARRIER)
    objects = _paths(_build(tree))
    assert objects[f"{KIR_ARTIFACT}/{OBSERVATIONS_FILE}"]["sources"] == ["afnd"]


def test_an_input_whose_measurement_is_not_the_artifacts_is_refused(tree: Path) -> None:
    manifest = json.loads((tree / ARTIFACT / "manifest.json").read_text())
    manifest["measurement"] = CARRIER
    _write(tree, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    with pytest.raises(dr.DataReleaseError, match="measurement"):
        _build(tree)


def _hand_written_input(root: Path, directory: str, frame, **record: object) -> None:
    """An input and a record that agree with each other, written without `serialize_observations`.

    What an older tool or a hand edit could produce: the hash, size and columns all match the file,
    so only a check of the content itself can refuse it.
    """
    buffer = io.BytesIO()
    frame.to_parquet(buffer, engine="pyarrow", index=False)
    payload = buffer.getvalue()
    _write(root, f"{directory}/{OBSERVATIONS_FILE}", payload)
    manifest = json.loads((root / directory / "manifest.json").read_text())
    manifest["observations"].update(
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
        columns=[str(column) for column in frame.columns],
        **record,
    )
    _write(root, f"{directory}/manifest.json", json.dumps(manifest).encode())


@pytest.mark.parametrize(
    ("change", "match"),
    [
        (lambda rows: rows.assign(ac=rows["ac"].astype(float)), "integer"),
        (lambda rows: rows.assign(an=rows["an"].astype(str)), "integer"),
        (lambda rows: rows.assign(frequency=rows["ac"] / rows["an"]), "freq"),
        (lambda rows: rows.rename(columns={"ac": "allele_freq"}), "freq"),
        (lambda rows: rows.drop(columns=["an"]), "counts"),
        (lambda rows: rows.assign(carriers=rows["ac"]), "carriers"),
    ],
)
def test_an_input_that_is_not_integer_counts_is_refused_even_if_its_record_agrees(
    tree: Path, change, match: str
) -> None:
    """§7.1b at the release gate: integer counts, never a frequency, never another measurement's."""
    _hand_written_input(tree, ARTIFACT, change(observation_rows()))
    with pytest.raises(dr.DataReleaseError, match=match):
        _build(tree)


@pytest.mark.parametrize(
    "change",
    [
        lambda rows: rows.assign(post_mean=0.1),
        lambda rows: rows.drop(columns=["cohort_id"]),
        lambda rows: rows[["lon", "lat", *[c for c in rows.columns if c not in {"lat", "lon"}]]],
    ],
    ids=["a-surface-column", "a-missing-column", "reordered-columns"],
)
def test_an_input_whose_columns_are_not_its_contracts_is_refused_even_if_its_record_agrees(
    tree: Path, change
) -> None:
    """A surface's `post_mean` in its observation table conflates the two (AGENTS invariant; §4, §5).

    The project's reader (`read_observations`) refuses any column set but the contract's, in its
    order, so the gate refuses it too.
    """
    _hand_written_input(tree, ARTIFACT, change(observation_rows()))
    with pytest.raises(dr.DataReleaseError, match="allele_frequency contract"):
        _build(tree)


def test_an_empty_input_is_refused_even_if_its_record_and_artifact_agree(tree: Path) -> None:
    """An empty table fits nothing; the reader refuses a `row_count` of 0, so the gate does too."""
    _hand_written_input(tree, ARTIFACT, observation_rows().iloc[:0], row_count=0)
    manifest = json.loads((tree / ARTIFACT / "manifest.json").read_text())
    manifest["n_observations"] = 0
    _write(tree, f"{ARTIFACT}/manifest.json", json.dumps(manifest).encode())
    with pytest.raises(dr.DataReleaseError, match="row_count 0 is not a positive integer"):
        _build(tree)


def test_a_carrier_input_written_as_allele_counts_is_refused(tree: Path) -> None:
    """A KIR table under `ac`/`an` would mix people with chromosomes in any pooled query (#133)."""
    _artifact(tree, KIR_ARTIFACT, "afnd-2026-08", measurement=CARRIER)
    _hand_written_input(tree, KIR_ARTIFACT, kir_fit_rows())
    with pytest.raises(dr.DataReleaseError, match="carriers"):
        _build(tree)


# --- the exemption list cannot hide a dropped input ---


def _released_with_input(tree: Path) -> list[dict]:
    """Release 2026-10-01, in which ARTIFACT was published with its input, as every new one is."""
    earlier = build.collect(tree, set())
    used = {name for record in earlier for name in record.sources}
    available = {**build.REVIEWED_SOURCES, **build._record_sources(tree)}
    previous = dr.build_manifest(earlier, {name: available[name] for name in used}, "2026-10-01")
    assert f"{ARTIFACT}/{OBSERVATIONS_FILE}" in _paths(previous)
    return [previous]


def test_an_artifact_released_with_its_input_may_not_be_exempted(tree: Path) -> None:
    previous = _released_with_input(tree)
    exempt = {ARTIFACT.split("/")[2]: "a reason that would hide a dropped input"}
    with pytest.raises(dr.DataReleaseError, match="released with its input"):
        _build(tree, previous=previous, released_without_input=exempt)
    _without_input(tree, ARTIFACT)
    with pytest.raises(dr.DataReleaseError, match="released with its input"):
        _build(tree, previous=previous, released_without_input=exempt)


def test_a_later_release_cannot_drop_an_artifacts_input(tree: Path) -> None:
    previous = _released_with_input(tree)
    _without_input(tree, ARTIFACT)
    with pytest.raises(dr.DataReleaseError, match=f"no {OBSERVATIONS_FILE}"):
        _build(tree, previous=previous)
