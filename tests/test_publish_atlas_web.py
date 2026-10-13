"""Publishing the Atlas web staging tree (design 2026-10-07 §C.2, §C.3)."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import shlex
from pathlib import Path
from typing import Any

import pytest

from genomeos.publication.web_layout import IMMUTABLE_CACHE_CONTROL, artifact_objects
from scripts import publish_atlas_web as publish
from tests.atlas_web_fixtures import flat_catalog, install_fake_gcloud, staged_catalog, write_staging

BUCKET = "example-bucket"
EMPTY_BUCKET: dict[str, Any] = {"buckets": {BUCKET: {"name": BUCKET, "location": "US-EAST1", "bindings": []}}}


def _dry(arguments: list[str]) -> str:
    return "DRY-RUN " + shlex.join(["python", "scripts/gcloud_repo.py", "run", *arguments])


def _url(key: str) -> str:
    return f"gs://{BUCKET}/atlas/web/{key}"


@pytest.fixture()
def staging(tmp_path: Path) -> Path:
    root = tmp_path / "staging"
    write_staging(root)
    return root


def _publish(staging: Path, *extra: str) -> int:
    return publish.main(["--staging", str(staging), "--bucket", BUCKET, *extra])


def test_dry_run_prints_every_command_and_runs_none(
    staging: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    work = (tmp_path / "gz").resolve()
    assert _publish(staging, "--dry-run", "--work-dir", str(work)) == 0
    lines = capsys.readouterr().out.splitlines()
    assert fake.calls() == []
    objects = artifact_objects(staged_catalog())
    surface = next(item for item in objects if ".surface." in item.key)
    size = len((staging / surface.key).read_bytes())
    assert (
        _dry(
            [
                "storage",
                "cp",
                str(work / f"{surface.key}.gz"),
                _url(surface.key),
                "--if-generation-match=0",
                "--content-encoding=gzip",
                "--content-type=application/json",
                f"--cache-control={IMMUTABLE_CACHE_CONTROL}",
                '--content-disposition=attachment; filename="hbs-test.surface.json"',
                f"--custom-metadata=sha256={surface.sha256},decoded-bytes={size}",
            ]
        )
        in lines
    )
    dry = [line for line in lines if line.startswith("DRY-RUN ")]
    assert len(dry) == 3 * len(objects)  # describe every object, then cp + verify-describe each
    assert dry[: len(objects)] == [_dry(publish.describe_args(_url(item.key))) for item in objects]
    assert not any("--gzip" in line or " rm " in line or "delete" in line for line in lines)
    assert lines[-1] == f"{len(objects)} objects: 0 uploaded, 0 skipped, {len(objects)} planned"


def test_publish_uploads_deterministic_gzip_with_decoded_identity_metadata(
    staging: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _publish(staging) == 0
    stored = fake.state()["objects"]
    objects = artifact_objects(staged_catalog())
    assert sorted(stored) == sorted(f"{BUCKET}/atlas/web/{item.key}" for item in objects)
    for item in objects:
        resource = stored[f"{BUCKET}/atlas/web/{item.key}"]
        data = (staging / item.key).read_bytes()
        body = base64.b64decode(resource["data_b64"])
        assert body == gzip.compress(data, compresslevel=9, mtime=0)
        assert hashlib.sha256(gzip.decompress(body)).hexdigest() == item.sha256
        assert resource["metadata"] == {"sha256": item.sha256, "decoded-bytes": str(len(data))}
        assert resource["contentEncoding"] == "gzip"
        assert resource["cacheControl"] == IMMUTABLE_CACHE_CONTROL
        assert resource["contentType"] == item.content_type
        assert resource.get("contentDisposition") == item.content_disposition
    n = len(objects)
    assert capsys.readouterr().out.splitlines()[-1] == f"{n} objects: {n} uploaded, 0 skipped, 0 planned"


def test_a_second_publish_skips_every_object(
    staging: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _publish(staging) == 0
    first = len(fake.calls())
    capsys.readouterr()
    assert _publish(staging) == 0
    second = fake.calls()[first:]
    assert second and all(call[:3] == ["storage", "objects", "describe"] for call in second)
    n = len(artifact_objects(staged_catalog()))
    assert capsys.readouterr().out.splitlines()[-1] == f"{n} objects: 0 uploaded, {n} skipped, 0 planned"


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"metadata": {"sha256": "0" * 64}}, "metadata sha256 is '0000"),
        ({"contentEncoding": None}, "contentEncoding is None"),
    ],
)
def test_an_existing_object_with_another_identity_is_never_overwritten(
    staging: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    change: dict[str, Any],
    message: str,
) -> None:
    grid = next(iter(staged_catalog()["grids"].values()))
    data = (staging / grid["url"]).read_bytes()
    existing: dict[str, Any] = {
        "contentEncoding": "gzip",
        "metadata": {"sha256": grid["sha256"], "decoded-bytes": str(len(data))},
        "size": "1",
    }
    existing.update(change)
    state = {**EMPTY_BUCKET, "objects": {f"{BUCKET}/atlas/web/{grid['url']}": existing}}
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _publish(staging) == 1
    err = capsys.readouterr().err
    assert f"refusing to overwrite {_url(grid['url'])}" in err
    assert message in err
    assert fake.mutating_calls() == []  # identity is checked for every object before any upload


def test_a_concurrent_upload_is_compared_like_an_existing_object(
    staging: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    render = staged_catalog()["artifacts"][0]["web"]["render"]
    data = (staging / render["url"]).read_bytes()
    path = f"{BUCKET}/atlas/web/{render['url']}"
    identical = {
        "contentEncoding": "gzip",
        "metadata": {"sha256": render["sha256"], "decoded-bytes": str(len(data))},
    }
    install_fake_gcloud(tmp_path / "same", monkeypatch, {**EMPTY_BUCKET, "race": {path: identical}})
    assert _publish(staging) == 0
    assert f"skipped {render['url']}" in capsys.readouterr().out
    different = {**identical, "metadata": {"sha256": "f" * 64, "decoded-bytes": "1"}}
    install_fake_gcloud(tmp_path / "other", monkeypatch, {**EMPTY_BUCKET, "race": {path: different}})
    assert _publish(staging) == 1
    assert f"refusing to overwrite {_url(render['url'])}" in capsys.readouterr().err


def test_post_upload_verification_catches_stored_bytes_that_differ(
    staging: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {**EMPTY_BUCKET, "corrupt_uploads": True})
    assert _publish(staging) == 1
    err = capsys.readouterr().err
    assert "post-upload verification failed" in err
    assert "md5Hash" in err and "size" in err


def test_a_staged_file_that_differs_from_the_catalog_stops_before_any_gcloud_call(
    staging: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    render = staged_catalog()["artifacts"][0]["web"]["render"]["url"]
    (staging / render).write_bytes(b"tampered")
    assert _publish(staging) == 1
    assert f"{render}: staged sha256" in capsys.readouterr().err
    assert fake.calls() == []


def test_a_catalog_with_flat_keys_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    root = tmp_path / "flat"
    root.mkdir()
    (root / "catalog.json").write_text(json.dumps(flat_catalog()), encoding="utf-8")
    assert _publish(root) == 1
    assert "not content-addressed" in capsys.readouterr().err
    assert fake.calls() == []


def test_every_call_goes_through_the_repository_wrapper(
    staging: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, EMPTY_BUCKET)
    assert _publish(staging) == 0
    assert fake.configs() == {str(publish.ROOT / ".local" / "gcloud" / "genomeos")}
