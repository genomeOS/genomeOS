"""Provisioning the budget kill switch (#480; data store design 2026-10-17 §9.2).

Every gcloud call goes to tests/fake_gcloud.py (and its platform half) through scripts/gcloud_repo.py;
nothing reaches GCP.
"""

from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any

import pytest

from genomeos.publication import data_release as dr
from scripts import provision_budget_kill_switch as provision
from tests.atlas_web_fixtures import install_fake_gcloud

PROJECT = "example-project"
NUMBER = "123456789012"  # fake_gcloud.DEFAULT_PROJECT_NUMBER
BILLING = "000000-000000-000000"
BUCKET = dr.DATA_STORE_BUCKET
ACCOUNT = f"budget-kill-switch@{PROJECT}.iam.gserviceaccount.com"
MEMBER = f"serviceAccount:{ACCOUNT}"
ROLE = f"projects/{PROJECT}/roles/budgetKillSwitch"
TOPIC = f"projects/{PROJECT}/topics/budget-notifications"
READER = {"role": "roles/storage.legacyObjectReader", "members": ["allUsers"]}
THRESHOLDS = [
    {"spendBasis": "CURRENT_SPEND", "thresholdPercent": 0.5},
    {"spendBasis": "CURRENT_SPEND", "thresholdPercent": 0.9},
    {"spendBasis": "CURRENT_SPEND", "thresholdPercent": 1.5},
    {"spendBasis": "FORECASTED_SPEND", "thresholdPercent": 1.0},
]
AGENT = "serviceAccount:service-123456789012@compute-system.iam.gserviceaccount.com"
Capsys = pytest.CaptureFixture[str]


def budget(name: str = "b1", projects: list[str] | None = None, **rule: Any) -> dict[str, Any]:
    return {
        "name": f"billingAccounts/{BILLING}/budgets/{name}",
        "displayName": "example monthly",
        "amount": {"specifiedAmount": {"currencyCode": "USD", "units": "200"}},
        "budgetFilter": {"calendarPeriod": "MONTH", "projects": projects or [f"projects/{NUMBER}"]},
        "thresholdRules": THRESHOLDS,
        "notificationsRule": dict(rule),
    }


def world(**extra: Any) -> dict[str, Any]:
    state: dict[str, Any] = {
        "buckets": {BUCKET: {"name": BUCKET, "location": "US-EAST1", "bindings": [dict(READER)]}},
        "objects": {f"{BUCKET}/releases/2026-10-17/a.json": {"name": "releases/2026-10-17/a.json"}},
        "services_enabled": ["iam.googleapis.com", "billingbudgets.googleapis.com"],
        "billing_account": BILLING,
        "budgets": [budget()],
    }
    state.update(extra)
    return state


def _run(*extra: str) -> int:
    return provision.main(["--project", PROJECT, *extra])


def test_dry_run_prints_the_whole_sequence_and_runs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run("--dry-run") == 0
    out = capsys.readouterr().out
    assert fake.calls() == []
    for fragment in (
        "services enable cloudfunctions.googleapis.com run.googleapis.com",
        "iam roles create budgetKillSwitch",
        "--permissions=storage.buckets.getIamPolicy,storage.buckets.setIamPolicy --stage=GA",
        "iam service-accounts create budget-kill-switch",
        f"--member={MEMBER} --role={ROLE}",
        "pubsub topics create budget-notifications",
        "functions deploy budget-kill-switch --gen2",
        "--source=deploy/budget-kill-switch",
        f"--set-env-vars=TARGET_BUCKET={BUCKET},BUDGET_ID=<budget>",
        "--ingress-settings=internal-only",
        f"--member={MEMBER} --role=roles/run.invoker",
        f"--notifications-rule-pubsub-topic={TOPIC}",
    ):
        assert fragment in out, fragment
    assert "--retry" not in out, "a failure is logged and acknowledged, never retried in a loop"
    assert "disable-default-iam-recipients" not in out
    assert out.index("billing budgets list") < out.index("functions deploy"), (
        "the budget is found before the function is deployed with its id"
    )


def test_provisioning_sets_everything_up_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run() == 0
    state = fake.state()
    assert set(provision.APIS) <= set(state["services_enabled"])
    assert state["roles"]["budgetKillSwitch"]["includedPermissions"] == sorted(provision.ROLE_PERMISSIONS)
    assert state["buckets"][BUCKET]["bindings"] == [READER, {"role": ROLE, "members": [MEMBER]}]
    assert state["objects"] == world()["objects"], "no object is touched"
    function = state["functions"]["budget-kill-switch"]
    environment = function["serviceConfig"]["environmentVariables"]
    assert (environment["TARGET_BUCKET"], environment["BUDGET_ID"]) == (BUCKET, "b1")
    assert function["serviceConfig"]["serviceAccountEmail"] == ACCOUNT
    assert function["eventTrigger"] == {
        "pubsubTopic": TOPIC,
        "serviceAccountEmail": ACCOUNT,
        "retryPolicy": "RETRY_POLICY_DO_NOT_RETRY",
    }
    assert function["labels"]["genomeos-source"] == provision.source_digest()
    assert state["last_deploy_source_files"] == ["kill_switch.py", "main.py", "requirements.txt"]
    assert state["policies"]["run-service/budget-kill-switch"] == [
        {"role": "roles/run.invoker", "members": [MEMBER]}
    ]
    assert state["policies"]["topic/budget-notifications"] == [
        {"role": "roles/pubsub.publisher", "members": [provision.BUDGET_PUBLISHER]}
    ]
    after = state["budgets"][0]
    assert after["notificationsRule"]["pubsubTopic"] == TOPIC
    assert (after["amount"], after["thresholdRules"]) == (budget()["amount"], THRESHOLDS)
    assert not after["notificationsRule"].get("disableDefaultIamRecipients")
    assert f"project/{PROJECT}" not in state["policies"], "no project-wide role"
    before = len(fake.mutating_calls())
    assert _run() == 0
    assert len(fake.mutating_calls()) == before, "a second run changes nothing"
    assert "deployed and current" in capsys.readouterr().out
    assert fake.configs() == {str(provision.ROOT / ".local" / "gcloud" / "genomeos")}


@pytest.mark.parametrize(
    ("variable", "value"), [("TARGET_BUCKET", "x"), ("BUDGET_ID", "stale"), ("BUDGET_ID", None)]
)
def test_a_changed_setting_redeploys_the_function(
    variable: str, value: str | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run() == 0
    state = fake.state()
    environment = state["functions"]["budget-kill-switch"]["serviceConfig"]["environmentVariables"]
    if value is None:
        del environment[variable]
    else:
        environment[variable] = value
    state["functions"]["budget-kill-switch"]["labels"]["genomeos-source"] = "stale"
    fake.write_state(state)
    assert _run() == 0
    deploys = [call for call in fake.mutating_calls() if call[:2] == ["functions", "deploy"]]
    assert len(deploys) == 2
    function = fake.state()["functions"]["budget-kill-switch"]
    assert function["labels"]["genomeos-source"] == provision.source_digest()
    assert function["serviceConfig"]["environmentVariables"]["BUDGET_ID"] == "b1"


def test_function_drift_names_each_difference() -> None:
    digest = "d" * 32
    current = {
        "state": "ACTIVE",
        "labels": {"genomeos-purpose": "budget-kill-switch", "genomeos-source": digest},
        "buildConfig": {"runtime": "python312", "entryPoint": "on_budget_notification"},
        "serviceConfig": {
            "environmentVariables": {"TARGET_BUCKET": BUCKET, "BUDGET_ID": "b1", "LOG_EXECUTION_ID": "true"},
            "serviceAccountEmail": ACCOUNT,
            "ingressSettings": "ALLOW_INTERNAL_ONLY",
            "maxInstanceCount": 1,
        },
        "eventTrigger": {"pubsubTopic": TOPIC, "serviceAccountEmail": ACCOUNT},
    }
    assert provision.function_drift(current, PROJECT, BUCKET, ACCOUNT, "b1", digest) == []
    changed = copy.deepcopy(current)
    changed["eventTrigger"]["retryPolicy"] = "RETRY_POLICY_RETRY"
    changed["serviceConfig"]["serviceAccountEmail"] = "other@example"
    drift = provision.function_drift(changed, PROJECT, BUCKET, ACCOUNT, "b1", digest)
    assert len(drift) == 2 and "runtime account" in drift[0] and "retries" in drift[1]
    assert provision.function_drift(current, PROJECT, BUCKET, ACCOUNT, "b2", digest) == [
        "BUDGET_ID is 'b1', expected 'b2'"
    ]


def test_the_role_holds_only_what_the_function_calls() -> None:
    main = (provision.ROOT / provision.SOURCE / "main.py").read_text(encoding="utf-8")
    calls = set(re.findall(r"self\._bucket\.(\w+)\(", main))
    assert calls == {"get_iam_policy", "set_iam_policy"}
    assert set(provision.ROLE_PERMISSIONS) == {
        "storage.buckets.getIamPolicy",
        "storage.buckets.setIamPolicy",
    }


def test_an_extra_permission_on_the_role_is_removed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    role = {"name": ROLE, "includedPermissions": ["storage.buckets.get", "storage.objects.delete"]}
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world(roles={"budgetKillSwitch": role}))
    assert _run() == 0
    assert fake.state()["roles"]["budgetKillSwitch"]["includedPermissions"] == sorted(
        provision.ROLE_PERMISSIONS
    )


def test_an_account_with_another_role_on_the_bucket_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    accounts = {ACCOUNT: {"email": ACCOUNT, "disabled": False}}
    admin = {"role": "roles/storage.objectAdmin", "members": [MEMBER]}
    state = world(service_accounts=accounts)
    state["buckets"][BUCKET]["bindings"].append(admin)
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run() == 1
    assert "needs-human-decision" in capsys.readouterr().err
    assert fake.state()["buckets"][BUCKET]["bindings"] == state["buckets"][BUCKET]["bindings"]


def test_a_project_wide_role_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    policies = {f"project/{PROJECT}": [{"role": "roles/storage.admin", "members": [MEMBER]}]}
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world(policies=policies))
    assert _run() == 1
    assert "project-wide roles/storage.admin" in capsys.readouterr().err
    assert "functions" not in fake.state(), "nothing is deployed for an over-privileged account"


def test_who_else_can_act_as_the_account_is_reported_not_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    compute = "serviceAccount:1-compute@developer.gserviceaccount.com"
    policies = {
        f"project/{PROJECT}": [
            {"role": "roles/editor", "members": [compute]},
            {"role": "roles/owner", "members": ["user:owner@example.org"]},
            {"role": "roles/compute.serviceAgent", "members": [AGENT]},
            {"role": "roles/viewer", "members": ["user:viewer@example.org"]},
            {"role": "roles/unknown", "members": ["user:someone@example.org"]},
        ]
    }
    predefined = {
        "roles/editor": {
            "includedPermissions": ["iam.serviceAccounts.actAs", "iam.serviceAccountKeys.create"]
        },
        "roles/viewer": {"includedPermissions": ["storage.buckets.list"]},
        "roles/owner": {"includedPermissions": ["iam.serviceAccounts.actAs"]},
        "roles/compute.serviceAgent": {"includedPermissions": ["iam.serviceAccounts.getAccessToken"]},
    }
    install_fake_gcloud(
        tmp_path / "gcloud", monkeypatch, world(policies=policies, predefined_roles=predefined)
    )
    assert _run() == 0
    out = capsys.readouterr().out
    assert (
        f"warning: {compute} can act as {MEMBER} through project-wide roles/editor "
        "(iam.serviceAccountKeys.create, iam.serviceAccounts.actAs)"
    ) in out
    assert (
        f"note: user:owner@example.org (a project owner) can act as {MEMBER} through project-wide roles/owner"
    ) in out
    assert f"note: {AGENT} (a Google-managed service agent) can act as {MEMBER}" in out
    assert "viewer@example.org" not in out
    assert "could not read the permissions of project-wide roles/unknown" in out


def test_no_one_acting_as_the_account_is_reported_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run() == 0
    assert f"no project-wide role lets anyone act as {MEMBER}" in capsys.readouterr().out


def test_a_budget_already_sending_elsewhere_is_never_rewired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    other = budget(pubsubTopic=f"projects/{PROJECT}/topics/other")
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world(budgets=[other]))
    assert _run() == 1
    assert "needs-human-decision" in capsys.readouterr().err
    assert fake.state()["budgets"] == [other]


def test_an_update_that_drops_the_email_recipients_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    state = world(budget_update_merges={"disableDefaultIamRecipients": True})
    install_fake_gcloud(tmp_path / "gcloud", monkeypatch, state)
    assert _run() == 1
    assert "default email recipients were disabled" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("budgets", "message"),
    [
        ([], "found []"),
        ([budget(projects=["projects/999"])], "found []"),
        ([budget("b1"), budget("b2")], "found ['example monthly', 'example monthly']"),
    ],
)
def test_the_budget_must_be_unambiguous(
    budgets: list[dict[str, Any]],
    message: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: Capsys,
) -> None:
    install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world(budgets=budgets))
    assert _run() == 1
    assert message in capsys.readouterr().err


def test_budget_selects_one_of_several(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world(budgets=[budget("b1"), budget("b2")]))
    assert _run("--budget", "b2") == 0
    rules = [item.get("notificationsRule", {}).get("pubsubTopic") for item in fake.state()["budgets"]]
    assert rules == [None, TOPIC]


@pytest.mark.parametrize("bucket", ["genomeos-atlas-web", "example-other-bucket"])
def test_any_bucket_but_the_committed_one_is_refused(
    bucket: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    fake = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, world())
    assert _run("--bucket", bucket) == 1
    assert "committed" in capsys.readouterr().err
    assert fake.calls() == []


def test_a_project_is_required(monkeypatch: pytest.MonkeyPatch, capsys: Capsys) -> None:
    monkeypatch.delenv("GENOMEOS_GCP_PROJECT", raising=False)
    assert provision.main([]) == 2
    assert "GENOMEOS_GCP_PROJECT" in capsys.readouterr().err


def test_the_source_digest_covers_exactly_the_function_files(tmp_path: Path) -> None:
    source = tmp_path / provision.SOURCE
    source.mkdir(parents=True)
    for name in provision.SOURCE_FILES:
        (source / name).write_text(name, encoding="utf-8")
    (source / "__pycache__").mkdir()
    first = provision.source_digest(tmp_path)
    assert len(first) == 32
    (source / "main.py").write_text("changed", encoding="utf-8")
    assert provision.source_digest(tmp_path) != first
    (source / "extra.py").write_text("", encoding="utf-8")
    with pytest.raises(provision.ProvisionError, match="extra.py"):
        provision.source_digest(tmp_path)
