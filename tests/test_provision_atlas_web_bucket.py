"""Provisioning the public Atlas web bucket (design 2026-10-07 §C.2, §C.3)."""

from __future__ import annotations

import json
import shlex
from pathlib import Path

import pytest

from genomeos.publication.web_layout import cors_policy
from scripts import provision_atlas_web_bucket as provision
from tests.atlas_web_fixtures import install_fake_gcloud

PROJECT = "example-project"
PROJECT_NUMBER = "123456789012"
BUCKET = "example-bucket"
URL = f"gs://{BUCKET}"
POLICIES = [
    [
        "org-policies",
        "describe",
        "iam.allowedPolicyMemberDomains",
        f"--project={PROJECT}",
        "--effective",
        "--format=json",
    ],
    [
        "org-policies",
        "describe",
        "storage.publicAccessPrevention",
        f"--project={PROJECT}",
        "--effective",
        "--format=json",
    ],
]
DESCRIBE = ["storage", "buckets", "describe", URL, "--raw", "--format=json"]
CREATE = [
    "storage",
    "buckets",
    "create",
    URL,
    f"--project={PROJECT}",
    "--location=us-east1",
    "--uniform-bucket-level-access",
    "--no-public-access-prevention",
]
LABEL = ["storage", "buckets", "update", URL, "--update-labels=genomeos-purpose=atlas-web"]
PROJECT_DESCRIBE = ["projects", "describe", PROJECT, "--format=json"]
IAM_GET = ["storage", "buckets", "get-iam-policy", URL, "--format=json"]
IAM_ADD = [
    "storage",
    "buckets",
    "add-iam-policy-binding",
    URL,
    "--member=allUsers",
    "--role=roles/storage.objectViewer",
]
CORS = ["storage", "buckets", "update", URL, "--cors-file=deploy/atlas-web-cors.json"]
EDGE_PLAN = [*POLICIES, DESCRIBE, CREATE, LABEL, DESCRIBE, IAM_GET, IAM_ADD, CORS]


def _existing(**fields: object) -> dict[str, object]:
    """Fake state with one same-project bucket this script created (labelled), overridden by ``fields``."""
    bucket: dict[str, object] = {
        "name": BUCKET,
        "location": "US-EAST1",
        "projectNumber": PROJECT_NUMBER,
        "labels": {"genomeos-purpose": "atlas-web"},
        "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": True},
            "publicAccessPrevention": "inherited",
        },
        "bindings": [],
    }
    bucket.update(fields)
    return {"project_number": PROJECT_NUMBER, "buckets": {BUCKET: bucket}}


def _dry(arguments: list[str]) -> str:
    return "DRY-RUN " + shlex.join(["python", "scripts/gcloud_repo.py", "run", *arguments])


def _provision(*extra: str) -> int:
    return provision.main(["--bucket", BUCKET, "--project", PROJECT, *extra])


def test_dry_run_prints_the_full_edge_plan_and_runs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    assert _provision("--dry-run") == 0
    lines = capsys.readouterr().out.splitlines()
    assert [line for line in lines if line.startswith("DRY-RUN ")] == [_dry(step) for step in EDGE_PLAN]
    assert fake.calls() == []
    assert lines[-1] == f"artifact base: https://storage.googleapis.com/{BUCKET}/atlas/web/"


def test_edge_creates_a_public_us_east1_bucket_with_the_cors_policy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    assert _provision() == 0
    assert fake.calls() == EDGE_PLAN
    bucket = fake.state()["buckets"][BUCKET]
    assert bucket["location"] == "US-EAST1"
    assert bucket["iamConfiguration"] == {
        "uniformBucketLevelAccess": {"enabled": True},
        "publicAccessPrevention": "inherited",
    }
    assert bucket["bindings"] == [{"role": "roles/storage.objectViewer", "members": ["allUsers"]}]
    assert bucket["cors"] == cors_policy()
    assert bucket["labels"] == {"genomeos-purpose": "atlas-web"}
    assert "versioning" not in bucket
    out = capsys.readouterr().out
    assert "public-access prevention: inherited" in out
    assert "org policy iam.allowedPolicyMemberDomains: does not block public objects" in out


def test_a_second_run_changes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    assert _provision() == 0
    first = len(fake.calls())
    capsys.readouterr()
    assert _provision() == 0
    assert fake.calls()[first:] == [*POLICIES, DESCRIBE, PROJECT_DESCRIBE, IAM_GET]
    assert "RUN " not in capsys.readouterr().out


def test_an_unlabelled_bucket_in_the_project_is_never_touched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # e.g. a private staging or Cloud Run artifact bucket that happens to have the chosen name
    fake = install_fake_gcloud(tmp_path, monkeypatch, _existing(labels={}))
    assert _provision() == 1
    assert "not created by this script" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_a_labelled_bucket_with_enforced_public_access_prevention_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    enforced = {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"}
    fake = install_fake_gcloud(tmp_path, monkeypatch, _existing(iamConfiguration=enforced))
    assert _provision() == 1
    captured = capsys.readouterr()
    assert "public-access prevention: enforced" in captured.out
    assert "never lifts it" in captured.err
    assert fake.mutating_calls() == []


def test_a_bucket_in_another_project_is_never_touched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, _existing(projectNumber="999999999999"))
    assert _provision() == 1
    assert f"is not in project {PROJECT}" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_a_labelled_bucket_that_drifted_gets_only_the_allowed_update(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    drifted = {"uniformBucketLevelAccess": {"enabled": False}, "publicAccessPrevention": "inherited"}
    fake = install_fake_gcloud(
        tmp_path, monkeypatch, _existing(iamConfiguration=drifted, versioning={"enabled": True})
    )
    assert _provision() == 0
    update = ["storage", "buckets", "update", URL, "--uniform-bucket-level-access", "--no-versioning"]
    assert fake.mutating_calls() == [update, IAM_ADD, CORS]
    assert all("--no-public-access-prevention" not in call for call in fake.mutating_calls())
    bucket = fake.state()["buckets"][BUCKET]
    assert bucket["versioning"] == {"enabled": False}
    assert bucket["iamConfiguration"]["publicAccessPrevention"] == "inherited"


@pytest.mark.parametrize(
    ("constraint", "policy"),
    [
        (
            "iam.allowedPolicyMemberDomains",
            {"spec": {"rules": [{"values": {"allowedValues": ["C0abc123"]}}]}},
        ),
        ("storage.publicAccessPrevention", {"spec": {"rules": [{"enforce": True}]}}),
    ],
)
def test_a_blocking_org_policy_stops_before_any_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    constraint: str,
    policy: dict[str, object],
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {"org_policies": {constraint: policy}})
    assert _provision() == 1
    captured = capsys.readouterr()
    assert constraint in captured.err
    assert f"org policy {constraint}: BLOCKS public objects" in captured.out
    assert fake.mutating_calls() == []


def test_an_unreadable_org_policy_is_reported_and_provisioning_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    install_fake_gcloud(tmp_path, monkeypatch, {"org_policy_errors": ["iam.allowedPolicyMemberDomains"]})
    assert _provision() == 0
    assert "org policy iam.allowedPolicyMemberDomains: unreadable" in capsys.readouterr().out


def test_a_bucket_outside_us_east1_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    elsewhere = {"name": BUCKET, "location": "EU", "iamConfiguration": {}, "bindings": []}
    fake = install_fake_gcloud(tmp_path, monkeypatch, {"buckets": {BUCKET: elsewhere}})
    assert _provision() == 1
    assert "is in eu, not us-east1" in capsys.readouterr().err
    assert fake.mutating_calls() == []


def test_a_cors_file_that_drifted_from_the_layout_module_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    drifted = cors_policy()
    drifted[0]["origin"] = drifted[0]["origin"][:-1]
    path = tmp_path / "cors.json"
    path.write_text(json.dumps(drifted), encoding="utf-8")
    monkeypatch.setattr(provision, "CORS_FILE", path)
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {})
    assert _provision() == 1
    assert "differs from" in capsys.readouterr().err
    assert all(call[:3] != ["storage", "buckets", "update"] for call in fake.calls())


def test_cloud_cdn_dry_run_prints_the_load_balancer_plan_and_the_dns_step(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    assert _provision("--mode", "cloud-cdn", "--dry-run") == 0
    lines = capsys.readouterr().out.splitlines()
    expected = [_dry(step) for step in EDGE_PLAN]
    for describe, create in provision.cdn_steps(BUCKET, PROJECT):
        expected += [_dry(describe), _dry(create)]
    expected.append(
        _dry(
            [
                "compute",
                "addresses",
                "describe",
                "atlas-web-ip",
                "--global",
                f"--project={PROJECT}",
                "--format=json",
            ]
        )
    )
    assert [line for line in lines if line.startswith("DRY-RUN ")] == expected
    assert any(
        line.startswith("HUMAN STEP: create a DNS A record data.genome-os.org -> <address pending>")
        for line in lines
    )
    assert lines[-1] == "artifact base: https://data.genome-os.org/atlas/web/"
    assert fake.calls() == []


def test_cloud_cdn_creates_each_resource_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    assert _provision("--mode", "cloud-cdn") == 0
    created = [call for call in fake.mutating_calls() if call[0] == "compute"]
    assert [(call[1], call[3]) for call in created] == [
        ("backend-buckets", "atlas-web-backend"),
        ("url-maps", "atlas-web-map"),
        ("ssl-certificates", "atlas-web-cert"),
        ("target-https-proxies", "atlas-web-https-proxy"),
        ("addresses", "atlas-web-ip"),
        ("forwarding-rules", "atlas-web-https-rule"),
    ]
    assert "data.genome-os.org -> 203.0.113.10" in capsys.readouterr().out
    before = len(fake.mutating_calls())
    assert _provision("--mode", "cloud-cdn") == 0
    assert len(fake.mutating_calls()) == before


def test_a_project_is_required(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("GENOMEOS_GCP_PROJECT", raising=False)
    assert provision.main(["--bucket", BUCKET]) == 2
    assert "GENOMEOS_GCP_PROJECT" in capsys.readouterr().err
