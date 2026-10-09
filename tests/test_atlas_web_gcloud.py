"""Repository-wrapped gcloud calls for the Atlas web bucket scripts (design 2026-10-07 §C.2)."""

from __future__ import annotations

import io
from pathlib import Path

import pytest

from scripts.atlas_web_gcloud import Gcloud, GcloudError
from tests.atlas_web_fixtures import install_fake_gcloud

ROOT = Path(__file__).resolve().parents[1]
OBJECT = "gs://example-bucket/atlas/web/x.json"
DESCRIBE = ["storage", "objects", "describe", OBJECT, "--raw", "--format=json"]


def test_describe_reads_json_through_the_repository_wrapper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resource = {"size": "3", "metadata": {"sha256": "ab"}}
    fake = install_fake_gcloud(
        tmp_path, monkeypatch, {"objects": {"example-bucket/atlas/web/x.json": resource}}
    )
    assert Gcloud(dry_run=False).describe(DESCRIBE) == resource
    assert fake.calls() == [DESCRIBE]
    assert fake.configs() == {str(ROOT / ".local" / "gcloud" / "genomeos")}


def test_describe_returns_none_for_a_missing_object(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    install_fake_gcloud(tmp_path, monkeypatch, {})
    assert Gcloud(dry_run=False).describe(DESCRIBE) is None


def test_an_unsupported_command_fails_loudly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    install_fake_gcloud(tmp_path, monkeypatch, {})
    with pytest.raises(GcloudError, match="unsupported"):
        Gcloud(dry_run=False).describe(["storage", "objects", "list", "gs://example-bucket"])


def test_dry_run_prints_every_command_and_runs_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    out = io.StringIO()
    gcloud = Gcloud(dry_run=True, out=out)
    assert gcloud.describe(DESCRIBE) is None
    assert (
        gcloud.mutate(["storage", "buckets", "update", "gs://example-bucket", "--no-versioning"]).returncode
        == 0
    )
    assert out.getvalue().splitlines() == [
        f"DRY-RUN python scripts/gcloud_repo.py run storage objects describe {OBJECT} --raw --format=json",
        "DRY-RUN python scripts/gcloud_repo.py run storage buckets update gs://example-bucket "
        "--no-versioning",
    ]
    assert fake.calls() == []


def test_a_refused_upload_precondition_is_reported_as_such(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_gcloud(
        tmp_path,
        monkeypatch,
        {
            "buckets": {"example-bucket": {"name": "example-bucket"}},
            "objects": {"example-bucket/atlas/web/x.json": {"size": "1"}},
        },
    )
    source = tmp_path / "x.json.gz"
    source.write_bytes(b"x")
    out = io.StringIO()
    result = Gcloud(dry_run=False, out=out).mutate(
        ["storage", "cp", str(source), OBJECT, "--if-generation-match=0"]
    )
    assert result.returncode != 0
    assert result.precondition_failed
    assert out.getvalue().startswith("RUN python scripts/gcloud_repo.py run storage cp ")


def test_a_test_without_the_fake_cannot_reach_the_real_gcloud() -> None:
    # tests/conftest.py's autouse fixture: Task 98 (C13) authenticates the repository gcloud on this
    # machine, and Task 104 (C18) runs the whole suite there.
    result = Gcloud(dry_run=False).query(["config", "list", "--format=json"])
    assert result.returncode == 97
    assert "may not run the real gcloud" in result.stderr
