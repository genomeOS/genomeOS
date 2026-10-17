"""Provisioning the public data-store bucket (data store design 2026-10-17 §3 C1–C3, §7).

Every gcloud call goes to tests/fake_gcloud.py through scripts/gcloud_repo.py; nothing reaches GCP.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scripts import provision_data_store_bucket as provision
from tests.atlas_web_fixtures import install_fake_gcloud

PROJECT = "example-project"
BUCKET = "example-data-bucket"
PUBLIC = {"role": "roles/storage.objectViewer", "members": ["allUsers"]}
Capsys = pytest.CaptureFixture[str]


def _run(*extra: str) -> int:
    return provision.main(["--bucket", BUCKET, "--project", PROJECT, *extra])


def _bucket(fake) -> dict[str, Any]:
    return fake.state()["buckets"][BUCKET]


def test_committed_cors_file_is_the_policy() -> None:
    committed = json.loads((provision.ROOT / provision.CORS_FILE).read_text(encoding="utf-8"))
    assert committed == provision.cors_policy()


def test_dry_run_prints_the_whole_sequence_and_runs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {})
    assert _run("--dry-run") == 0
    out = capsys.readouterr().out
    assert fake.calls() == []
    for fragment in (
        "storage buckets create",
        "--update-labels=genomeos-purpose=data-store",
        "add-iam-policy-binding",
        "--member=allUsers",
        "--cors-file=deploy/data-store-cors.json",
    ):
        assert fragment in out, fragment
    assert f"base URL: https://storage.googleapis.com/{BUCKET}/" in out


def test_provisioning_creates_a_labelled_public_bucket_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {})
    assert _run() == 0
    bucket = _bucket(fake)
    assert bucket["labels"] == {"genomeos-purpose": "data-store"}
    assert bucket["location"] == "US-EAST1"
    assert bucket["iamConfiguration"]["uniformBucketLevelAccess"] == {"enabled": True}
    assert PUBLIC in bucket["bindings"]
    assert bucket["cors"] == provision.cors_policy()
    before = len(fake.mutating_calls())
    assert _run() == 0
    assert len(fake.mutating_calls()) == before, "a second run changes nothing"
    assert fake.configs() == {str(provision.ROOT / ".local" / "gcloud" / "genomeos")}


@pytest.mark.parametrize("labels", [{}, {"genomeos-purpose": "atlas-web"}])
def test_a_bucket_this_script_did_not_create_is_never_made_public(
    labels: dict[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    state = {"buckets": {BUCKET: {"name": BUCKET, "location": "US-EAST1", "labels": labels, "bindings": []}}}
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run() == 1
    assert "needs-human-decision" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_a_blocking_org_policy_stops_before_any_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    policy = {"spec": {"rules": [{"enforce": True}]}}
    fake = install_fake_gcloud(
        tmp_path / "gcloud", monkeypatch, {"org_policies": {"storage.publicAccessPrevention": policy}}
    )
    assert _run() == 1
    assert "organization policy" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_enforced_public_access_prevention_is_never_lifted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    state = {
        "buckets": {
            BUCKET: {
                "name": BUCKET,
                "location": "US-EAST1",
                "labels": {"genomeos-purpose": "data-store"},
                "projectNumber": "123456789012",
                "iamConfiguration": {"publicAccessPrevention": "enforced"},
                "bindings": [],
            }
        }
    }
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run() == 1
    assert "never lifts" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_a_project_is_required(monkeypatch: pytest.MonkeyPatch, capsys: Capsys) -> None:
    monkeypatch.delenv("GENOMEOS_GCP_PROJECT", raising=False)
    assert provision.main(["--bucket", BUCKET]) == 2
    assert "GENOMEOS_GCP_PROJECT" in capsys.readouterr().err
