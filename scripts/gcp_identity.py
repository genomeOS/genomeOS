"""Idempotent identity and IAM steps for the data-store provisioning scripts (#480; data store design
2026-10-17 §7, §9.2).

Shared by scripts/provision_budget_kill_switch.py and scripts/provision_data_store_publisher.py.
Each step reads the current state through ``scripts.atlas_web_gcloud.Gcloud`` and changes only what
differs. Under ``--dry-run`` every read reports "absent", so the printed plan is the whole sequence
for a fresh project. Roles are only ever granted here, never revoked. A service account that holds a
role it should not (on the bucket, or anywhere in the project) stops the run as a needs-human-decision
error rather than being "fixed" by removing access someone granted on purpose.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from scripts.atlas_web_gcloud import Gcloud, GcloudResult
from scripts.provision_atlas_web_bucket import ProvisionError


def mutate(gcloud: Gcloud, arguments: Sequence[str]) -> GcloudResult:
    result = gcloud.mutate(arguments)
    if result.returncode != 0:
        raise ProvisionError(f"{Gcloud.display(arguments)} failed: {result.stderr.strip()}")
    return result


def listing(gcloud: Gcloud, arguments: Sequence[str]) -> list[dict[str, Any]]:
    """A JSON-array read; empty under dry-run, where nothing is read."""
    result = gcloud.query(arguments)
    if gcloud.dry_run:
        return []
    if result.returncode != 0:
        raise ProvisionError(f"{Gcloud.display(arguments)} failed: {result.stderr.strip()}")
    try:
        value = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as error:
        raise ProvisionError(f"{Gcloud.display(arguments)} printed no JSON ({error})") from error
    if not isinstance(value, list):
        raise ProvisionError(f"{Gcloud.display(arguments)} printed {result.stdout[:200]!r}, not a list")
    return value


def ensure_apis(gcloud: Gcloud, project: str, apis: Iterable[str], report: list[str]) -> None:
    enabled = {
        (item.get("config") or {}).get("name")
        for item in listing(
            gcloud, ["services", "list", "--enabled", f"--project={project}", "--format=json"]
        )
    }
    missing = [api for api in apis if api not in enabled]
    if missing:
        mutate(gcloud, ["services", "enable", *missing, f"--project={project}"])
        report.append(f"APIs: enabled {', '.join(missing)}")
    else:
        report.append("APIs: all required APIs already enabled")


def service_account_email(account_id: str, project: str) -> str:
    return f"{account_id}@{project}.iam.gserviceaccount.com"


def ensure_service_account(
    gcloud: Gcloud, project: str, account_id: str, display_name: str, description: str, report: list[str]
) -> str:
    email = service_account_email(account_id, project)
    current = gcloud.describe(
        ["iam", "service-accounts", "describe", email, f"--project={project}", "--format=json"]
    )
    if current is None:
        mutate(
            gcloud,
            [
                "iam",
                "service-accounts",
                "create",
                account_id,
                f"--project={project}",
                f"--display-name={display_name}",
                f"--description={description}",
            ],
        )
        report.append(f"service account {account_id}: created")
    elif current.get("disabled"):
        raise ProvisionError(f"service account {account_id} exists but is disabled: needs-human-decision")
    else:
        report.append(f"service account {account_id}: exists")
    return email


def roles_of(policy: Mapping[str, Any], member: str) -> set[str]:
    return {
        str(binding.get("role"))
        for binding in policy.get("bindings", [])
        if member in binding.get("members", [])
    }


def ensure_member(
    gcloud: Gcloud,
    *,
    read: Sequence[str],
    add: Sequence[str],
    member: str,
    roles: Sequence[str],
    label: str,
    report: list[str],
    only: bool = False,
) -> None:
    """``member`` holds every one of ``roles`` on the resource ``read``/``add`` name; with ``only``,
    nothing else there."""
    held = roles_of(gcloud.describe(read) or {}, member)
    extra = sorted(held - set(roles)) if only else []
    if extra:
        raise ProvisionError(
            f"{member} also holds {', '.join(extra)} on {label}; it may hold only {', '.join(roles)}: "
            "needs-human-decision"
        )
    for role in roles:
        if role in held:
            report.append(f"IAM on {label}: {member} already has {role}")
            continue
        mutate(gcloud, [*add, f"--member={member}", f"--role={role}"])
        report.append(f"IAM on {label}: {member} granted {role}")


def ensure_bucket_roles(
    gcloud: Gcloud, bucket: str, member: str, roles: Sequence[str], report: list[str]
) -> None:
    """``member`` holds ``roles`` on ``bucket`` and nothing else there."""
    url = f"gs://{bucket}"
    ensure_member(
        gcloud,
        read=["storage", "buckets", "get-iam-policy", url, "--format=json"],
        add=["storage", "buckets", "add-iam-policy-binding", url],
        member=member,
        roles=roles,
        label=f"bucket {bucket}",
        report=report,
        only=True,
    )


def ensure_custom_role(
    gcloud: Gcloud,
    project: str,
    role_id: str,
    title: str,
    description: str,
    permissions: Sequence[str],
    report: list[str],
) -> str:
    """The project role ``role_id`` with exactly ``permissions``; its full name, for bindings."""
    current = gcloud.describe(["iam", "roles", "describe", role_id, f"--project={project}", "--format=json"])
    listed = ", ".join(permissions)
    flag = f"--permissions={','.join(permissions)}"
    if current is None:
        create = ["iam", "roles", "create", role_id, f"--project={project}", f"--title={title}"]
        mutate(gcloud, [*create, f"--description={description}", flag, "--stage=GA"])
        report.append(f"custom role {role_id}: created with {listed}")
        return f"projects/{project}/roles/{role_id}"
    if current.get("deleted"):
        mutate(gcloud, ["iam", "roles", "undelete", role_id, f"--project={project}"])
        report.append(f"custom role {role_id}: undeleted")
    if sorted(current.get("includedPermissions") or []) != sorted(permissions):
        mutate(gcloud, ["iam", "roles", "update", role_id, f"--project={project}", flag])
        report.append(f"custom role {role_id}: permissions set to exactly {listed}")
    else:
        report.append(f"custom role {role_id}: exists with exactly {listed}")
    return f"projects/{project}/roles/{role_id}"


def assert_no_project_role(gcloud: Gcloud, project: str, member: str, report: list[str]) -> None:
    """Grants are per resource, so a project-wide role for ``member`` is a mistake to surface."""
    roles = roles_of(gcloud.describe(["projects", "get-iam-policy", project, "--format=json"]) or {}, member)
    if roles:
        raise ProvisionError(
            f"{member} holds project-wide {', '.join(sorted(roles))}; its grants must be per resource: "
            "needs-human-decision"
        )
    report.append(f"IAM on the project: {member} holds no project-wide role")
