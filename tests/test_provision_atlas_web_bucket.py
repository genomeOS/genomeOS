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
        "iam.managed.allowedPolicyMembers",
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


@pytest.mark.parametrize(
    "labels",
    [{}, {"genomeos-purpose": "staging"}, {"purpose": "atlas-web"}],
    ids=["no-labels", "wrong-value", "wrong-key"],
)
def test_an_unlabelled_bucket_in_the_project_is_never_touched(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    labels: dict[str, str],
) -> None:
    # e.g. a private staging or Cloud Run artifact bucket that happens to have the chosen name
    fake = install_fake_gcloud(tmp_path, monkeypatch, _existing(labels=labels))
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


MANAGED = "iam.managed.allowedPolicyMembers"
ORG_ONLY = "//cloudresourcemanager.googleapis.com/organizations/123456789012"


def _managed(*rules: dict[str, object]) -> dict[str, object]:
    return {"name": f"projects/{PROJECT}/policies/{MANAGED}", "spec": {"rules": list(rules)}}


@pytest.mark.parametrize(
    ("constraint", "policy"),
    [
        (
            "iam.allowedPolicyMemberDomains",
            {"spec": {"rules": [{"values": {"allowedValues": ["C0abc123"]}}]}},
        ),
        ("iam.allowedPolicyMemberDomains", {"spec": {"rules": [{"denyAll": True}]}}),
        (MANAGED, _managed({"enforce": True, "parameters": {"allowedPrincipalSets": [ORG_ONLY]}})),
        (
            MANAGED,
            _managed({"enforce": True, "parameters": {"allowedMemberSubjects": ["user:owner@example.com"]}}),
        ),
        ("storage.publicAccessPrevention", {"spec": {"rules": [{"enforce": True}]}}),
    ],
    ids=["domains-allowlist", "domains-deny-all", "managed-org-only", "managed-named-users", "pap"],
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


@pytest.mark.parametrize(
    "policy",
    [
        _managed({"enforce": True, "parameters": {"allowedMemberSubjects": ["allUsers"]}}),
        _managed({"enforce": False}),
        _managed(),
    ],
    ids=["allows-all-users", "not-enforced", "no-rules"],
)
def test_a_managed_member_policy_that_admits_all_users_does_not_block(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    policy: dict[str, object],
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {"org_policies": {MANAGED: policy}})
    assert _provision() == 0
    assert f"org policy {MANAGED}: does not block public objects" in capsys.readouterr().out
    assert fake.state()["buckets"][BUCKET]["bindings"] == [
        {"role": "roles/storage.objectViewer", "members": ["allUsers"]}
    ]


@pytest.mark.parametrize(
    "constraint", ["iam.allowedPolicyMemberDomains", MANAGED, "storage.publicAccessPrevention"]
)
def test_an_unreadable_org_policy_is_reported_and_provisioning_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], constraint: str
) -> None:
    install_fake_gcloud(tmp_path, monkeypatch, {"org_policy_errors": [constraint]})
    assert _provision() == 0
    assert f"org policy {constraint}: unreadable" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("constraint", "policy"),
    [
        (
            "iam.allowedPolicyMemberDomains",
            {"spec": {"rules": [{"values": {"allowedValues": ["C0abc123"]}}]}},
        ),
        (MANAGED, _managed({"enforce": True, "parameters": {"allowedPrincipalSets": [ORG_ONLY]}})),
    ],
    ids=["domains-allowlist", "managed-org-only"],
)
def test_an_unreadable_sharing_policy_that_blocks_fails_closed_and_a_rerun_adopts_the_bucket(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    constraint: str,
    policy: dict[str, object],
) -> None:
    state = {"org_policies": {constraint: policy}, "org_policy_errors": [constraint]}
    fake = install_fake_gcloud(tmp_path, monkeypatch, state)
    assert _provision() == 1
    captured = capsys.readouterr()
    assert f"org policy {constraint}: unreadable" in captured.out
    assert "add-iam-policy-binding" in captured.err
    assert fake.mutating_calls() == [CREATE, LABEL, IAM_ADD]
    bucket = fake.state()["buckets"][BUCKET]
    assert bucket["bindings"] == []  # still private
    assert bucket["labels"] == {"genomeos-purpose": "atlas-web"}
    # the organization admin grants the project an exception; the labelled bucket is then adopted
    granted = fake.state()
    granted["org_policies"] = {}
    granted["org_policy_errors"] = []
    fake.write_state(granted)
    before = len(fake.mutating_calls())
    assert _provision() == 0
    assert fake.mutating_calls()[before:] == [IAM_ADD, CORS]


def test_public_access_prevention_enforced_on_a_just_created_bucket_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # the org policy is unreadable, so only the new bucket's own setting reveals it
    pap = "storage.publicAccessPrevention"
    state = {"org_policies": {pap: {"spec": {"rules": [{"enforce": True}]}}}, "org_policy_errors": [pap]}
    fake = install_fake_gcloud(tmp_path, monkeypatch, state)
    assert _provision() == 1
    captured = capsys.readouterr()
    assert "public-access prevention: enforced" in captured.out
    assert "never lifts it" in captured.err
    assert fake.mutating_calls() == [CREATE, LABEL]
    bucket = fake.state()["buckets"][BUCKET]
    assert bucket["bindings"] == []
    assert "cors" not in bucket


def test_a_bucket_not_visible_right_after_creation_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {"invisible_buckets": [BUCKET]})
    assert _provision() == 1
    assert f"{URL} is not visible right after creation" in capsys.readouterr().err
    assert fake.mutating_calls() == [CREATE, LABEL]
    assert fake.state()["buckets"][BUCKET]["bindings"] == []


@pytest.mark.parametrize(
    ("project_error", "expected"),
    [
        (
            "(gcloud.projects.describe) NOT_FOUND: Requested entity was not found.",
            f"cannot read the project number of {PROJECT}",
        ),
        (
            "(gcloud.projects.describe) PERMISSION_DENIED: The caller does not have permission",
            f"projects describe {PROJECT} --format=json failed",
        ),
    ],
    ids=["not-found", "permission-denied"],
)
def test_an_unreadable_project_number_is_reported_as_such_and_changes_nothing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    project_error: str,
    expected: str,
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {**_existing(), "project_error": project_error})
    assert _provision() == 1
    err = capsys.readouterr().err
    assert expected in err
    assert "is not in project" not in err  # the bucket is not blamed for an unreadable project
    assert fake.mutating_calls() == []


def test_org_policy_output_that_is_not_a_json_object_stops_with_the_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    state = {"org_policies": {"storage.publicAccessPrevention": ["not", "an", "object"]}}
    fake = install_fake_gcloud(tmp_path, monkeypatch, state)
    assert _provision() == 1
    captured = capsys.readouterr()
    assert "org policy iam.allowedPolicyMemberDomains: does not block public objects" in captured.out
    assert "storage.publicAccessPrevention" in captured.err
    assert "not a JSON object" in captured.err
    assert fake.mutating_calls() == []


def test_org_policy_output_that_is_not_json_stops_with_an_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    shim = tmp_path / "scripted-gcloud"
    shim.write_text("#!/bin/sh\nprintf 'Listed 0 items.\\n'\n", encoding="utf-8")
    shim.chmod(0o755)
    monkeypatch.setenv("GENOMEOS_GCLOUD_EXECUTABLE", str(shim))
    assert _provision() == 1
    err = capsys.readouterr().err
    assert "iam.allowedPolicyMemberDomains" in err
    assert "'Listed 0 items.\\n', not JSON" in err


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
    assert fake.calls() == []  # refused before any gcloud call, reads included


@pytest.mark.parametrize("contents", [None, "[{"], ids=["missing", "not-json"])
def test_an_unreadable_cors_file_is_refused_before_any_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    contents: str | None,
) -> None:
    path = tmp_path / "cors.json"
    if contents is not None:
        path.write_text(contents, encoding="utf-8")
    monkeypatch.setattr(provision, "CORS_FILE", path)
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {})
    assert _provision() == 1
    assert f"{path} is unreadable" in capsys.readouterr().err
    assert fake.calls() == []


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
