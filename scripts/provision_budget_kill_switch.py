#!/usr/bin/env python3
"""Provision the budget kill switch for the public data-store bucket (#480; data store design
2026-10-17 §9.2; docs/cost-controls.md).

    python scripts/provision_budget_kill_switch.py --project <project> --dry-run
    python scripts/provision_budget_kill_switch.py --project <project>

Owner decision: when this month's spend reaches 150% of the project budget, public access to the
data-store bucket is removed until the owner restores it. The web-data bucket keeps serving. This
script sets up, in order:

1. the APIs a Pub/Sub-triggered Cloud Run function (2nd gen) needs, enabling only the missing ones;
2. the custom role ``budgetKillSwitch``: exactly ``storage.buckets.get``, ``storage.buckets.getIamPolicy``
   and ``storage.buckets.setIamPolicy``;
3. the service account ``budget-kill-switch``, holding that role on the committed data-store bucket
   only, no other role there and no project-wide role;
4. the Pub/Sub topic ``budget-notifications``;
5. the function ``budget-kill-switch`` from ``deploy/budget-kill-switch/`` (``TARGET_BUCKET`` = the
   committed bucket), running as that account and triggered as it, which then needs
   ``roles/run.invoker`` on the function's own service only;
6. the topic attached to the project's existing budget, leaving its amount, thresholds and email
   recipients as they are, then checked. A budget already sending to another topic is refused.

Idempotent: every step reads the current state and changes only what differs; the function is
redeployed only when its source digest (a label) or its settings differ. ``--dry-run`` prints every
command and runs none. Creating the budget, choosing its amount and its recipients are owner steps
in the console. The project id, its number and the billing account are read at run time and never
stored in git (docs/repo-gcloud-auth.md). Every command goes through scripts/gcloud_repo.py.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from scripts import gcp_identity as iam  # noqa: E402
from scripts.atlas_web_gcloud import Gcloud, GcloudError  # noqa: E402
from scripts.provision_atlas_web_bucket import ProvisionError  # noqa: E402

REGION = "us-east1"
APIS = (
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "billingbudgets.googleapis.com",
)
ROLE_ID = "budgetKillSwitch"
ROLE_TITLE = "Budget kill switch"
ROLE_DESCRIPTION = "Read a bucket and replace its IAM policy; nothing else (docs/cost-controls.md)"
ROLE_PERMISSIONS = ("storage.buckets.get", "storage.buckets.getIamPolicy", "storage.buckets.setIamPolicy")
SERVICE_ACCOUNT_ID = "budget-kill-switch"
TOPIC = "budget-notifications"
FUNCTION = "budget-kill-switch"
# Relative to ROOT: the wrapper runs gcloud from the repository root, and the plan names no machine path.
SOURCE = Path("deploy") / "budget-kill-switch"
SOURCE_FILES = (".gcloudignore", "kill_switch.py", "main.py", "requirements.txt")
RUNTIME = "python312"
ENTRY_POINT = "on_budget_notification"
MEMORY = "256Mi"
TIMEOUT = "60s"
LABEL_KEY = "genomeos-purpose"
LABEL_VALUE = "budget-kill-switch"
SOURCE_LABEL = "genomeos-source"
#: Cloud Billing's publisher; the budget API grants it on the topic, and this script checks it.
BUDGET_PUBLISHER = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"


def source_digest(root: Path = ROOT) -> str:
    """First 32 hex digits of the sha256 over the function's files: the deployed version's label."""
    directory = root / SOURCE
    present = {
        path.name for path in directory.iterdir() if path.name != "__pycache__" and path.suffix != ".pyc"
    }
    if present != set(SOURCE_FILES):
        raise ProvisionError(
            f"{SOURCE} holds {sorted(present)}, expected exactly {sorted(SOURCE_FILES)}; "
            "update SOURCE_FILES with the function"
        )
    digest = hashlib.sha256()
    for name in SOURCE_FILES:
        digest.update(name.encode() + b"\0" + (directory / name).read_bytes() + b"\0")
    return digest.hexdigest()[:32]


def deploy_args(project: str, bucket: str, account: str, digest: str) -> list[str]:
    return [
        "functions",
        "deploy",
        FUNCTION,
        "--gen2",
        f"--project={project}",
        f"--region={REGION}",
        f"--runtime={RUNTIME}",
        f"--source={SOURCE}",
        f"--entry-point={ENTRY_POINT}",
        f"--trigger-topic={TOPIC}",
        f"--run-service-account={account}",
        f"--trigger-service-account={account}",
        f"--set-env-vars=TARGET_BUCKET={bucket}",
        f"--memory={MEMORY}",
        f"--timeout={TIMEOUT}",
        "--max-instances=1",
        "--ingress-settings=internal-only",
        f"--update-labels={LABEL_KEY}={LABEL_VALUE},{SOURCE_LABEL}={digest}",
    ]


def function_drift(
    current: Mapping[str, Any], project: str, bucket: str, account: str, digest: str
) -> list[str]:
    """What differs between the deployed function and this checkout; empty when nothing does."""
    build = current.get("buildConfig") or {}
    service = current.get("serviceConfig") or {}
    trigger = current.get("eventTrigger") or {}
    labels = current.get("labels") or {}
    expected = {
        "state": ("ACTIVE", current.get("state")),
        "runtime": (RUNTIME, build.get("runtime")),
        "entry point": (ENTRY_POINT, build.get("entryPoint")),
        "TARGET_BUCKET": (bucket, (service.get("environmentVariables") or {}).get("TARGET_BUCKET")),
        "runtime account": (account, service.get("serviceAccountEmail")),
        "ingress": ("ALLOW_INTERNAL_ONLY", service.get("ingressSettings")),
        "max instances": (1, service.get("maxInstanceCount")),
        "trigger topic": (f"projects/{project}/topics/{TOPIC}", trigger.get("pubsubTopic")),
        "trigger account": (account, trigger.get("serviceAccountEmail")),
        "source label": (digest, labels.get(SOURCE_LABEL)),
        "purpose label": (LABEL_VALUE, labels.get(LABEL_KEY)),
    }
    drift = [
        f"{name} is {actual!r}, expected {want!r}"
        for name, (want, actual) in expected.items()
        if want != actual
    ]
    if trigger.get("retryPolicy") == "RETRY_POLICY_RETRY":
        drift.append("the trigger retries failures (a malformed message could loop)")
    return drift


def ensure_topic(gcloud: Gcloud, project: str, report: list[str]) -> str:
    if (
        gcloud.describe(["pubsub", "topics", "describe", TOPIC, f"--project={project}", "--format=json"])
        is None
    ):
        iam.mutate(
            gcloud,
            [
                "pubsub",
                "topics",
                "create",
                TOPIC,
                f"--project={project}",
                f"--labels={LABEL_KEY}={LABEL_VALUE}",
            ],
        )
        report.append(f"topic {TOPIC}: created")
    else:
        report.append(f"topic {TOPIC}: exists")
    return f"projects/{project}/topics/{TOPIC}"


def ensure_function(
    gcloud: Gcloud, project: str, bucket: str, account: str, digest: str, report: list[str]
) -> None:
    describe = [
        "functions",
        "describe",
        FUNCTION,
        "--gen2",
        f"--project={project}",
        f"--region={REGION}",
        "--format=json",
    ]
    current = gcloud.describe(describe)
    drift = ["absent"] if current is None else function_drift(current, project, bucket, account, digest)
    if drift:
        iam.mutate(gcloud, deploy_args(project, bucket, account, digest))
        report.append(f"function {FUNCTION}: deployed ({'; '.join(drift)})")
        current = gcloud.describe(describe)
        if not gcloud.dry_run:
            left = (
                ["absent"] if current is None else function_drift(current, project, bucket, account, digest)
            )
            if left:
                raise ProvisionError(f"function {FUNCTION} after deploy: {'; '.join(left)}")
    else:
        report.append(f"function {FUNCTION}: deployed and current (source {digest})")
    scope = [f"--region={REGION}", f"--project={project}"]
    iam.ensure_member(
        gcloud,
        read=["run", "services", "get-iam-policy", FUNCTION, *scope, "--format=json"],
        add=["run", "services", "add-iam-policy-binding", FUNCTION, *scope],
        member=f"serviceAccount:{account}",
        roles=("roles/run.invoker",),
        label=f"service {FUNCTION}",
        report=report,
    )


def find_budget(budgets: list[dict[str, Any]], project_number: str, wanted: str | None) -> dict[str, Any]:
    scoped = [
        budget
        for budget in budgets
        if f"projects/{project_number}" in ((budget.get("budgetFilter") or {}).get("projects") or [])
    ]
    if wanted:
        scoped = [
            b for b in scoped if wanted in (b.get("displayName"), str(b.get("name", "")).rsplit("/", 1)[-1])
        ]
    if len(scoped) != 1:
        names = [budget.get("displayName") for budget in scoped]
        raise ProvisionError(
            f"expected exactly one budget scoped to this project{f' named {wanted!r}' if wanted else ''}, "
            f"found {names}; create it in the console (docs/cost-controls.md) or pass --budget"
        )
    return scoped[0]


def ensure_budget_topic(
    gcloud: Gcloud, project: str, topic: str, wanted: str | None, report: list[str]
) -> None:
    billing = gcloud.describe(["billing", "projects", "describe", project, "--format=json"]) or {}
    account = str(billing.get("billingAccountName", "billingAccounts/<billing-account>")).rsplit("/", 1)[-1]
    listed = ["billing", "budgets", "list", f"--billing-account={account}", "--format=json"]
    if gcloud.dry_run:
        gcloud.query(listed)
        budget: dict[str, Any] = {"name": "billingAccounts/<billing-account>/budgets/<budget>"}
    else:
        number = str(project_info(gcloud, project).get("projectNumber", ""))
        budget = find_budget(iam.listing(gcloud, listed), number, wanted)
    budget_id = str(budget["name"]).rsplit("/", 1)[-1]
    rule = budget.get("notificationsRule") or {}
    if rule.get("pubsubTopic") == topic:
        report.append(f"budget {budget.get('displayName', budget_id)!r}: already sends to {TOPIC}")
    elif rule.get("pubsubTopic"):
        raise ProvisionError(
            f"budget {budget.get('displayName')!r} already sends to {rule['pubsubTopic']}; "
            "not replaced: needs-human-decision"
        )
    else:
        iam.mutate(
            gcloud,
            [
                "billing",
                "budgets",
                "update",
                budget_id,
                f"--billing-account={account}",
                f"--notifications-rule-pubsub-topic={topic}",
            ],
        )
        report.append(f"budget {budget.get('displayName', budget_id)!r}: now also sends to {TOPIC}")
        if not gcloud.dry_run:
            after = next(b for b in iam.listing(gcloud, listed) if b.get("name") == budget["name"])
            check_budget_kept(budget, after, topic)
    iam.ensure_member(
        gcloud,
        read=["pubsub", "topics", "get-iam-policy", TOPIC, f"--project={project}", "--format=json"],
        add=["pubsub", "topics", "add-iam-policy-binding", TOPIC, f"--project={project}"],
        member=BUDGET_PUBLISHER,
        roles=("roles/pubsub.publisher",),
        label=f"topic {TOPIC}",
        report=report,
    )


def check_budget_kept(before: Mapping[str, Any], after: Mapping[str, Any], topic: str) -> None:
    """Attaching the topic must leave the amount, the thresholds and the email recipients alone."""
    rule = after.get("notificationsRule") or {}
    problems = [
        f"{field} changed"
        for field in ("amount", "thresholdRules", "budgetFilter")
        if before.get(field) != after.get(field)
    ]
    if rule.get("pubsubTopic") != topic:
        problems.append(f"pubsubTopic is {rule.get('pubsubTopic')!r}")
    if rule.get("disableDefaultIamRecipients"):
        problems.append("default email recipients were disabled")
    before_rule = before.get("notificationsRule") or {}
    if before_rule.get("monitoringNotificationChannels") != rule.get("monitoringNotificationChannels"):
        problems.append("monitoring channels changed")
    if problems:
        raise ProvisionError(f"budget {after.get('displayName')!r} after update: {'; '.join(problems)}")


def project_info(gcloud: Gcloud, project: str) -> dict[str, Any]:
    return gcloud.describe(["projects", "describe", project, "--format=json"]) or {}


def provision(
    gcloud: Gcloud, bucket: str, project: str, wanted_budget: str | None, report: list[str]
) -> None:
    digest = source_digest()
    iam.ensure_apis(gcloud, project, APIS, report)
    role = iam.ensure_custom_role(
        gcloud, project, ROLE_ID, ROLE_TITLE, ROLE_DESCRIPTION, ROLE_PERMISSIONS, report
    )
    account = iam.ensure_service_account(
        gcloud,
        project,
        SERVICE_ACCOUNT_ID,
        "Budget kill switch",
        f"Removes public access from {bucket} at 150% of the budget (docs/cost-controls.md)",
        report,
    )
    member = f"serviceAccount:{account}"
    iam.ensure_bucket_roles(gcloud, bucket, member, (role,), report)
    iam.assert_no_project_role(gcloud, project, member, report)
    topic = ensure_topic(gcloud, project, report)
    ensure_function(gcloud, project, bucket, account, digest, report)
    ensure_budget_topic(gcloud, project, topic, wanted_budget, report)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Provision the budget kill switch for the data-store bucket."
    )
    parser.add_argument(
        "--bucket",
        help=f"must be the committed {dr.DATA_STORE_BUCKET} (the default; or ${dr.BUCKET_VARIABLE})",
    )
    parser.add_argument("--project", help="GCP project id (default: $GENOMEOS_GCP_PROJECT; never in git)")
    parser.add_argument("--budget", help="the budget's display name or id, if several cover the project")
    parser.add_argument("--dry-run", action="store_true", help="print every gcloud command and run none")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    project = args.project or os.environ.get("GENOMEOS_GCP_PROJECT")
    if not project:
        print(
            "error: pass --project or set GENOMEOS_GCP_PROJECT; project ids are not stored in git",
            file=sys.stderr,
        )
        return 2
    try:
        bucket = dr.resolve_bucket(args.bucket or os.environ.get(dr.BUCKET_VARIABLE))
    except dr.DataReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    report: list[str] = []
    try:
        provision(Gcloud(dry_run=args.dry_run), bucket, project, args.budget, report)
    except (ProvisionError, GcloudError) as error:
        print("\n".join(report))
        print(f"error: {error}", file=sys.stderr)
        return 1
    print("\n".join(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
