"""Uploading a release to the data-store bucket without ever overwriting (data store design 2026-10-17 §7).

Every gcloud call goes to tests/fake_gcloud.py through scripts/gcloud_repo.py; nothing reaches GCP.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from genomeos.publication import data_release as dr
from scripts import publish_data_store as publish
from tests.atlas_web_fixtures import install_fake_gcloud

BUCKET = dr.DATA_STORE_BUCKET  # the committed bucket; the fake gcloud never reaches GCP
RELEASE = "2026-10-17"
FILES = {
    "store/artifacts/x__v3__map-2026-08/cells.parquet": b"cells for x",
    "raw/afnd_populations.tsv": b"pop_id\tpopulation\n",
}
SOURCES = {"map": {"name": "MAP", "terms": {"status": "not_checked"}, "non_commercial": False}}
Release = dict[str, Path]
Capsys = pytest.CaptureFixture[str]
EMPTY_BUCKET: dict[str, Any] = {"buckets": {BUCKET: {"name": BUCKET, "location": "US-EAST1", "bindings": []}}}


@pytest.fixture()
def release(tmp_path: Path) -> dict[str, Path]:
    data = tmp_path / "data"
    records = []
    for path, content in FILES.items():
        (data / path).parent.mkdir(parents=True, exist_ok=True)
        (data / path).write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        records.append(dr.FileRecord(path, len(content), digest, path.startswith("raw/"), ("map",)))
    manifest_path = data / "releases" / f"{RELEASE}.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_bytes(dr.canonical_bytes(dr.build_manifest(records, SOURCES, RELEASE)))
    return {"data": data, "manifest": manifest_path}


def _run(release: dict[str, Path], *extra: str) -> int:
    return publish.main(
        ["--bucket", BUCKET, "--manifest", str(release["manifest"]), "--data", str(release["data"]), *extra]
    )


def _objects(fake) -> dict[str, dict[str, Any]]:
    return {name.split("/", 1)[1]: value for name, value in fake.state().get("objects", {}).items()}


def _key(path: str) -> str:
    return dr.release_key(RELEASE, path)


def test_dry_run_plans_every_upload_and_runs_nothing(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _run(release, "--dry-run") == 0
    out = capsys.readouterr().out
    assert fake.calls() == []
    total = sum(len(content) for content in FILES.values()) + release["manifest"].stat().st_size
    assert f"3 objects, {total:,} bytes: 0 uploaded, 0 skipped, 3 planned" in out
    assert "--if-generation-match=0" in out and " rm " not in out and "delete" not in out


def test_every_command_runs_as_the_impersonated_publisher(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The runbook publishes with CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT (docs/data-store.md, #480);
    the wrapper must hand it to every gcloud call, reads included."""
    publisher = "data-store-publisher@example-project.iam.gserviceaccount.com"
    monkeypatch.setenv("CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", publisher)
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _run(release) == 0
    verbs = {call[1] for call in fake.calls()}
    assert verbs == {"objects", "cp"}, "describes and no-overwrite uploads only"
    assert fake.impersonations() == {publisher}


def test_publish_uploads_raw_bytes_with_identity_metadata_then_the_manifest(
    release: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _run(release) == 0
    objects = _objects(fake)
    for path, content in FILES.items():
        stored = objects[_key(path)]
        assert base64.b64decode(stored["data_b64"]) == content
        assert stored["metadata"] == {"sha256": hashlib.sha256(content).hexdigest()}
        assert stored["cacheControl"] == dr.IMMUTABLE_CACHE_CONTROL
        assert stored["contentType"] == dr.media_type_for(path)
        assert "contentEncoding" not in stored
    manifest = objects[dr.manifest_key(RELEASE)]
    assert base64.b64decode(manifest["data_b64"]) == release["manifest"].read_bytes()
    copies = [call for call in fake.calls() if call[:2] == ["storage", "cp"]]
    assert copies[-1][3].endswith(dr.manifest_key(RELEASE)), "the manifest is uploaded last"
    assert all("--if-generation-match=0" in call for call in copies)
    assert fake.configs() == {str(Path(publish.ROOT) / ".local" / "gcloud" / "genomeos")}


def test_a_second_publish_skips_everything(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _run(release) == 0
    before = len(fake.mutating_calls())
    assert _run(release) == 0
    assert len(fake.mutating_calls()) == before
    assert "0 uploaded, 3 skipped" in capsys.readouterr().out


def test_a_different_existing_object_is_a_hard_error_never_an_overwrite(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    key = _key("raw/afnd_populations.tsv")
    state = json.loads(json.dumps(EMPTY_BUCKET))
    state["objects"] = {f"{BUCKET}/{key}": {"name": key, "size": "3", "metadata": {"sha256": "0" * 64}}}
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run(release) == 1
    assert "refusing to overwrite" in capsys.readouterr().err
    assert fake.mutating_calls() == [], "identities are settled before the first upload"


def test_a_lost_race_is_compared_not_overwritten(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    key = _key("raw/afnd_populations.tsv")
    state = json.loads(json.dumps(EMPTY_BUCKET))
    state["race"] = {f"{BUCKET}/{key}": {"name": key, "size": "1", "metadata": {"sha256": "0" * 64}}}
    install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run(release) == 1
    assert "refusing to overwrite" in capsys.readouterr().err


def test_a_corrupted_upload_fails_post_upload_verification(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    state = {**json.loads(json.dumps(EMPTY_BUCKET)), "corrupt_uploads": True}
    install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run(release) == 1
    assert "post-upload verification failed" in capsys.readouterr().err


def test_a_local_file_that_differs_from_the_manifest_stops_before_any_call(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    (release["data"] / "raw/afnd_populations.tsv").write_bytes(b"changed\n")
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _run(release) == 1
    assert "does not match the manifest" in capsys.readouterr().err
    assert fake.calls() == []


def test_a_reused_key_must_already_exist(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    earlier = json.loads(release["manifest"].read_text())
    earlier["release"] = "2026-10-01"
    for item in earlier["objects"]:
        item["key"] = dr.release_key("2026-10-01", item["path"])
    later = dr.build_manifest(
        [
            dr.FileRecord(item["path"], item["bytes"], item["sha256"], item["in_git"], tuple(item["sources"]))
            for item in earlier["objects"]
        ],
        SOURCES,
        RELEASE,
        previous=[earlier],
    )
    release["manifest"].write_bytes(dr.canonical_bytes(later))
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _run(release) == 1
    assert "earlier release" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_matching_sha256_metadata_over_different_stored_bytes_is_refused(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    """The metadata sha256 is the uploader's claim; the server's md5 of the stored bytes must agree."""
    path = "raw/afnd_populations.tsv"
    content = FILES[path]
    forged = base64.b64encode(hashlib.md5(b"other bytes").digest()).decode("ascii")
    key = _key(path)
    state = json.loads(json.dumps(EMPTY_BUCKET))
    state["objects"] = {
        f"{BUCKET}/{key}": {
            "name": key,
            "size": str(len(content)),
            "md5Hash": forged,
            "metadata": {"sha256": hashlib.sha256(content).hexdigest()},
        }
    }
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run(release) == 1
    assert "server md5Hash" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_any_bucket_but_the_committed_one_is_refused(
    release: Release, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    arguments = ["--manifest", str(release["manifest"]), "--data", str(release["data"])]
    assert publish.main(["--bucket", "example-other-bucket", *arguments]) == 1
    monkeypatch.setenv(dr.BUCKET_VARIABLE, "example-other-bucket")
    assert publish.main(arguments) == 1
    assert "committed" in capsys.readouterr().err
    assert fake.calls() == []
