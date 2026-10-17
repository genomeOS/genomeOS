"""Provisioning the upload-only data-store publisher (#480; data store design 2026-10-17 §7).

Every gcloud call goes to tests/fake_gcloud.py (and its platform half) through scripts/gcloud_repo.py;
nothing reaches GCP.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from genomeos.publication import data_release as dr
from scripts import provision_data_store_publisher as provision
from tests.atlas_web_fixtures import install_fake_gcloud

PROJECT = "example-project"
OWNER = "maintainer@example.org"
BUCKET = dr.DATA_STORE_BUCKET
EMAIL = f"data-store-publisher@{PROJECT}.iam.gserviceaccount.com"
MEMBER = f"serviceAccount:{EMAIL}"
READER_ROLE = f"projects/{PROJECT}/roles/dataStoreReader"
READER = {"role": "roles/storage.legacyObjectReader", "members": ["allUsers"]}
Capsys = pytest.CaptureFixture[str]


def world(**extra: Any) -> dict[str, Any]:
    state: dict[str, Any] = {
        "buckets": {BUCKET: {"name": BUCKET, "location": "US-EAST1", "bindings": [dict(READER)]}},
        "objects": {f"{BUCKET}/releases/2026-10-17/a.json": {"name": "releases/2026-10-17/a.json"}},
        "services_enabled": ["iam.googleapis.com"],
    }
    state.update(extra)
    return state


def _run(*extra: str) -> int:
    return provision.main(["--project", PROJECT, "--account", OWNER, *extra])


def test_dry_run_prints_the_whole_sequence_and_runs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run("--dry-run") == 0
    out = capsys.readouterr().out
    assert fake.calls() == []
    for fragment in (
        "services enable iam.googleapis.com iamcredentials.googleapis.com",
        "iam roles create dataStoreReader",
        "--permissions=storage.objects.get,storage.objects.list --stage=GA",
        "iam service-accounts create data-store-publisher",
        f"--member={MEMBER} --role=roles/storage.objectCreator",
        f"--member={MEMBER} --role={READER_ROLE}",
        f"--member=user:{OWNER} --role=roles/iam.serviceAccountTokenCreator",
        f"CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT={EMAIL}",
    ):
        assert fragment in out, fragment
    assert "keys create" not in out, "no key is ever created"


def test_provisioning_grants_upload_only_access_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run() == 0
    state = fake.state()
    assert "iamcredentials.googleapis.com" in state["services_enabled"]
    assert state["buckets"][BUCKET]["bindings"] == [
        READER,
        {"role": "roles/storage.objectCreator", "members": [MEMBER]},
        {"role": READER_ROLE, "members": [MEMBER]},
    ]
    assert state["roles"]["dataStoreReader"]["includedPermissions"] == [
        "storage.objects.get",
        "storage.objects.list",
    ], "read and list only: no create beyond objectCreator, no delete, no overwrite"
    assert state["policies"][f"service-account/{EMAIL}"] == [
        {"role": "roles/iam.serviceAccountTokenCreator", "members": [f"user:{OWNER}"]}
    ]
    assert f"project/{PROJECT}" not in state["policies"], "no project-wide role"
    assert state["objects"] == world()["objects"], "no object is touched"
    before = len(fake.mutating_calls())
    assert _run() == 0
    assert len(fake.mutating_calls()) == before, "a second run changes nothing"
    assert fake.configs() == {str(provision.ROOT / ".local" / "gcloud" / "genomeos")}


@pytest.mark.parametrize("role", ["roles/storage.objectAdmin", "roles/storage.objectUser"])
def test_a_publisher_that_can_overwrite_or_delete_is_refused(
    role: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    state = world(service_accounts={EMAIL: {"email": EMAIL, "disabled": False}})
    state["buckets"][BUCKET]["bindings"].append({"role": role, "members": [MEMBER]})
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run() == 1
    assert "needs-human-decision" in capsys.readouterr().err
    assert fake.state()["buckets"][BUCKET]["bindings"] == state["buckets"][BUCKET]["bindings"]


def test_a_disabled_publisher_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    install_fake_gcloud(
        tmp_path / "gcloud", monkeypatch, world(service_accounts={EMAIL: {"email": EMAIL, "disabled": True}})
    )
    assert _run() == 1
    assert "disabled" in capsys.readouterr().err


def test_a_service_account_maintainer_is_granted_as_one() -> None:
    assert provision.principal(OWNER) == f"user:{OWNER}"
    ci = "ci@example-project.iam.gserviceaccount.com"
    assert provision.principal(ci) == f"serviceAccount:{ci}"


@pytest.mark.parametrize(
    "account",
    ["group:maintainers@example.org", f"user:{OWNER}", "serviceAccount:ci@x.iam.gserviceaccount.com"],
)
def test_an_explicit_member_kind_is_kept(account: str) -> None:
    assert provision.principal(account) == account


@pytest.mark.parametrize("account", ["domain:example.org", "allUsers", "group:", "maintainers"])
def test_a_malformed_account_changes_nothing(
    account: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert provision.main(["--project", PROJECT, "--account", account]) == 1
    assert "--account" in capsys.readouterr().err
    assert fake.calls() == []


def test_a_group_maintainer_is_granted_as_a_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    group = "group:maintainers@example.org"
    assert provision.main(["--project", PROJECT, "--account", group]) == 0
    assert fake.state()["policies"][f"service-account/{EMAIL}"] == [
        {"role": "roles/iam.serviceAccountTokenCreator", "members": [group]}
    ]


def test_who_else_can_mint_its_keys_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    compute = "serviceAccount:1-compute@developer.gserviceaccount.com"
    state = world(
        policies={f"project/{PROJECT}": [{"role": "roles/editor", "members": [compute]}]},
        predefined_roles={"roles/editor": {"includedPermissions": ["iam.serviceAccountKeys.create"]}},
    )
    install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run() == 0
    assert f"warning: {compute} can act as {MEMBER}" in capsys.readouterr().out


@pytest.mark.parametrize("argv", [["--project", PROJECT], ["--account", OWNER]])
def test_project_and_account_are_required(
    argv: list[str], monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    monkeypatch.delenv("GENOMEOS_GCP_PROJECT", raising=False)
    monkeypatch.delenv("GENOMEOS_GCP_ACCOUNT", raising=False)
    assert provision.main(argv) == 2
    assert "GENOMEOS_GCP_ACCOUNT" in capsys.readouterr().err


def test_any_bucket_but_the_committed_one_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run("--bucket", "genomeos-atlas-web") == 1
    assert "committed" in capsys.readouterr().err
    assert fake.calls() == []
