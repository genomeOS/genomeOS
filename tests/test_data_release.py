"""The data-store release manifest (data store design 2026-10-17 §3, §5)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from genomeos.publication import data_release as dr

RELEASE = "2026-10-17"
SHA_A = "a" * 64
SHA_B = "b" * 64

SOURCES: dict[str, Any] = {
    "afnd": {
        "name": "Allele Frequency Net Database (AFND)",
        "terms": {
            "status": "no_restriction_found",
            "checked_at": "2026-08-25",
            "terms_url": "https://example.org/terms",
            "recorded_in": "https://github.com/genomeOS/genomeOS/issues/117",
        },
        "non_commercial": False,
    },
    "map": {"name": "Malaria Atlas Project", "terms": {"status": "not_checked"}, "non_commercial": False},
}


def _records() -> list[dr.FileRecord]:
    return [
        dr.FileRecord("store/artifacts/x__v3__map-2026-08/cells.parquet", 10, SHA_A, False, ("map",)),
        dr.FileRecord("raw/afnd_populations.tsv", 4, SHA_B, True, ("afnd",)),
    ]


def _manifest(**changes: Any) -> dict[str, Any]:
    manifest = dr.build_manifest(_records(), SOURCES, RELEASE)
    manifest.update(changes)
    return manifest


def test_build_sorts_objects_derives_keys_and_media_types_and_totals() -> None:
    manifest = _manifest()
    assert [item["path"] for item in manifest["objects"]] == [
        "raw/afnd_populations.tsv",
        "store/artifacts/x__v3__map-2026-08/cells.parquet",
    ]
    first, second = manifest["objects"]
    assert first["key"] == f"releases/{RELEASE}/raw/afnd_populations.tsv"
    assert first["media_type"] == "text/tab-separated-values"
    assert second["media_type"] == "application/vnd.apache.parquet"
    assert manifest["totals"] == {"objects": 2, "bytes": 14, "in_git_objects": 1, "in_git_bytes": 4}
    assert manifest["schema"] == dr.SCHEMA and manifest["schema_version"] == dr.SCHEMA_VERSION
    assert [item.path for item in dr.validate_manifest(manifest)] == [
        "raw/afnd_populations.tsv",
        "store/artifacts/x__v3__map-2026-08/cells.parquet",
    ]


def test_canonical_bytes_are_deterministic_and_round_trip() -> None:
    first = dr.canonical_bytes(_manifest())
    second = dr.canonical_bytes(json.loads(first))
    assert first == second and first.endswith(b"\n")


@pytest.mark.parametrize(
    "path",
    ["../x.json", "/abs.json", "a//b.json", "a\\b.json", "a/./b.json", ".hidden.json", "a/.DS_Store", ""],
)
def test_unsafe_paths_are_refused(path: str) -> None:
    with pytest.raises(dr.DataReleaseError, match="path"):
        dr.assert_data_path(path)


@pytest.mark.parametrize("path", ["store/fits/x.fit.pkl", "a.pickle", "model.joblib"])
def test_pickles_are_never_published(path: str) -> None:
    record = dr.FileRecord(path, 1, SHA_A, False, ("map",))
    with pytest.raises(dr.DataReleaseError, match="pickle"):
        dr.build_manifest([record], SOURCES, RELEASE)


def test_unknown_extension_is_refused_not_guessed() -> None:
    with pytest.raises(dr.DataReleaseError, match="media type"):
        dr.media_type_for("store/thing.bin")


def test_duplicate_paths_are_refused() -> None:
    records = [*_records(), _records()[0]]
    with pytest.raises(dr.DataReleaseError, match="twice"):
        dr.build_manifest(records, SOURCES, RELEASE)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("sha256", "A" * 64, "sha256"),
        ("sha256", "a" * 63, "sha256"),
        ("bytes", -1, "bytes"),
        ("bytes", True, "bytes"),
        ("bytes", 1.0, "bytes"),
        ("in_git", "yes", "in_git"),
        ("media_type", "text/plain", "media type"),
        ("sources", [], "source"),
        ("sources", ["gnomad"], "undeclared"),
        ("key", "releases/2026-10-18/raw/afnd_populations.tsv", "key"),
        ("key", "releases/2026-10-16/raw/other.tsv", "key"),
        ("key", "manifests/2026-10-17.json", "key"),
    ],
)
def test_object_violations_are_hard_errors(field: str, value: Any, message: str) -> None:
    manifest = _manifest()
    manifest["objects"][0][field] = value
    with pytest.raises(dr.DataReleaseError, match=message):
        dr.validate_manifest(manifest)


def test_unknown_object_and_manifest_fields_are_refused() -> None:
    manifest = _manifest()
    manifest["objects"][0]["md5"] = "x"
    with pytest.raises(dr.DataReleaseError, match="fields"):
        dr.validate_manifest(manifest)
    with pytest.raises(dr.DataReleaseError, match="fields"):
        dr.validate_manifest(_manifest(extra=1))


def test_unsorted_objects_and_stale_totals_are_refused() -> None:
    manifest = _manifest()
    manifest["objects"].reverse()
    with pytest.raises(dr.DataReleaseError, match="sorted"):
        dr.validate_manifest(manifest)
    stale = _manifest()
    stale["totals"]["bytes"] += 1
    with pytest.raises(dr.DataReleaseError, match="totals"):
        dr.validate_manifest(stale)


def test_an_unused_source_is_refused() -> None:
    manifest = _manifest()
    manifest["sources"]["cpic"] = {
        "name": "CPIC",
        "terms": {"status": "not_checked"},
        "non_commercial": False,
    }
    with pytest.raises(dr.DataReleaseError, match="unused"):
        dr.validate_manifest(manifest)


@pytest.mark.parametrize(
    ("terms", "non_commercial", "message"),
    [
        ({"status": "no_restriction_found"}, False, "recorded_in"),
        ({"status": ""}, False, "status"),
        ({"status": "not_checked", "terms_url": "http://insecure.example"}, False, "https"),
        ({"status": "not_checked", "checked_at": "25 Aug"}, False, "checked_at"),
        ({"status": "not_checked", "verdict": "fine"}, False, "fields"),
        ({"status": "not_checked"}, True, "non-commercial"),
        ({"status": "not_checked"}, "no", "non_commercial"),
    ],
)
def test_terms_are_carried_with_their_record_or_refused(
    terms: dict[str, Any], non_commercial: Any, message: str
) -> None:
    manifest = _manifest()
    manifest["sources"]["map"] = {"name": "MAP", "terms": terms, "non_commercial": non_commercial}
    with pytest.raises(dr.DataReleaseError, match=message):
        dr.validate_manifest(manifest)


def test_previous_release_keys_are_reused_for_identical_bytes() -> None:
    previous = dr.build_manifest(_records(), SOURCES, "2026-10-01")
    changed = [_records()[0], dr.FileRecord("raw/afnd_populations.tsv", 5, SHA_A, True, ("afnd",))]
    manifest = dr.build_manifest(changed, SOURCES, RELEASE, previous=[previous])
    keys = {item["path"]: item["key"] for item in manifest["objects"]}
    assert keys["store/artifacts/x__v3__map-2026-08/cells.parquet"].startswith("releases/2026-10-01/")
    assert keys["raw/afnd_populations.tsv"] == f"releases/{RELEASE}/raw/afnd_populations.tsv"
    dr.validate_manifest(manifest)


def test_a_published_artifact_whose_bytes_changed_is_refused() -> None:
    previous = dr.build_manifest(_records(), SOURCES, "2026-10-01")
    mutated = [dr.FileRecord("store/artifacts/x__v3__map-2026-08/cells.parquet", 10, SHA_B, False, ("map",))]
    with pytest.raises(dr.DataReleaseError, match="immutable"):
        dr.build_manifest(mutated, SOURCES, RELEASE, previous=[previous])


def test_previous_releases_must_be_earlier() -> None:
    later = dr.build_manifest(_records(), SOURCES, "2026-10-18")
    with pytest.raises(dr.DataReleaseError, match="earlier"):
        dr.build_manifest(_records(), SOURCES, RELEASE, previous=[later])


@pytest.mark.parametrize("release", ["2026-10-17", "2026-10-17.2"])
def test_release_ids(release: str) -> None:
    assert dr.assert_release_id(release) == release


@pytest.mark.parametrize("release", ["2026-1-17", "latest", "2026-10-17.0", "2026-10-17.x", ""])
def test_bad_release_ids_are_refused(release: str) -> None:
    with pytest.raises(dr.DataReleaseError, match="release"):
        dr.assert_release_id(release)


def test_release_order_is_numeric_within_a_day() -> None:
    assert dr.release_sort_key("2026-10-17.10") > dr.release_sort_key("2026-10-17.9")
    assert dr.release_sort_key("2026-10-17.2") > dr.release_sort_key("2026-10-17")


@pytest.mark.parametrize(
    "base",
    ["https://storage.googleapis.com/example-bucket/", "http://127.0.0.1:8123/", "http://localhost:9/x/"],
)
def test_public_url_joins_base_and_key(base: str) -> None:
    assert dr.public_url(base, "releases/2026-10-17/a.json") == f"{base}releases/2026-10-17/a.json"


@pytest.mark.parametrize(
    "base",
    ["", "storage.googleapis.com/b/", "https://example.org/b", "http://example.org/", "https://e.org/?x=1/"],
)
def test_bad_base_urls_are_refused(base: str) -> None:
    with pytest.raises(dr.DataReleaseError, match="GENOMEOS_DATA_BASE_URL"):
        dr.assert_base_url(base)


def test_manifest_key_and_select() -> None:
    assert dr.manifest_key(RELEASE) == f"manifests/{RELEASE}.json"
    objects = dr.validate_manifest(_manifest())
    assert [item.path for item in dr.select(objects, ["store/"])] == [
        "store/artifacts/x__v3__map-2026-08/cells.parquet"
    ]
    assert dr.select(objects, []) == objects
    with pytest.raises(dr.DataReleaseError, match="matches no object"):
        dr.select(objects, ["validation/"])


def test_validation_does_not_mutate_its_input() -> None:
    manifest = _manifest()
    snapshot = copy.deepcopy(manifest)
    dr.validate_manifest(manifest)
    assert manifest == snapshot
