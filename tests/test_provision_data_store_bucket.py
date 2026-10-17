"""Provisioning the public data-store bucket (data store design 2026-10-17 §3 C1–C3, §7).

Every gcloud call goes to tests/fake_gcloud.py through scripts/gcloud_repo.py; nothing reaches GCP.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from genomeos.publication import data_release as dr
from scripts import provision_data_store_bucket as provision
from tests.atlas_web_fixtures import install_fake_gcloud

PROJECT = "example-project"
BUCKET = dr.DATA_STORE_BUCKET  # the committed bucket; the fake gcloud never reaches GCP
READER = {"role": "roles/storage.legacyObjectReader", "members": ["allUsers"]}
LISTER = {"role": "roles/storage.objectViewer", "members": ["allUsers"]}
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
        "--versioning",
        "--soft-delete-duration=30d",
        "add-iam-policy-binding",
        "--member=allUsers --role=roles/storage.legacyObjectReader",
        "--cors-file=deploy/data-store-cors.json",
    ):
        assert fragment in out, fragment
    assert f"base URL: {dr.DATA_STORE_BASE_URL}" in out
    assert "objectViewer" not in out, "anonymous readers are never granted a listing role"


def test_provisioning_creates_a_labelled_public_bucket_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {})
    assert _run() == 0
    bucket = _bucket(fake)
    assert bucket["labels"] == {"genomeos-purpose": "data-store"}
    assert bucket["location"] == "US-EAST1"
    assert bucket["iamConfiguration"]["uniformBucketLevelAccess"] == {"enabled": True}
    assert bucket["versioning"] == {"enabled": True}
    assert bucket["softDeletePolicy"] == {"retentionDurationSeconds": str(30 * 86400)}
    assert bucket["bindings"] == [READER]
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


def test_an_existing_listable_bucket_is_migrated_in_place(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    """objectViewer lets anyone list; the reader role is granted first, then the listing role removed."""
    state = {
        "buckets": {
            BUCKET: {
                "name": BUCKET,
                "location": "US-EAST1",
                "labels": {"genomeos-purpose": "data-store"},
                "projectNumber": "123456789012",
                "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}},
                "softDeletePolicy": {"retentionDurationSeconds": "604800"},
                "cors": provision.cors_policy(),
                "bindings": [dict(LISTER, members=["allUsers"])],
            }
        },
        "objects": {f"{BUCKET}/releases/2026-10-17/a.json": {"name": "releases/2026-10-17/a.json"}},
    }
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run() == 0
    bucket = _bucket(fake)
    assert bucket["bindings"] == [READER]
    assert bucket["versioning"] == {"enabled": True}
    assert bucket["softDeletePolicy"] == {"retentionDurationSeconds": str(30 * 86400)}
    verbs = [call[2] for call in fake.mutating_calls()]
    assert verbs == ["update", "add-iam-policy-binding", "remove-iam-policy-binding"]
    assert fake.state()["objects"] == state["objects"], "no object is touched"
    assert "removed from roles/storage.objectViewer" in capsys.readouterr().out


def test_any_bucket_but_the_committed_one_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {})
    assert provision.main(["--bucket", "example-other-bucket", "--project", PROJECT]) == 1
    assert "committed" in capsys.readouterr().err
    assert fake.calls() == []
