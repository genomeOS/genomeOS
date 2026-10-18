"""Idempotent identity and IAM steps for the data-store provisioning scripts (#480; data store design
2026-10-17 §7, §9.2).

Shared by scripts/provision_budget_kill_switch.py and scripts/provision_data_store_publisher.py.
Each step reads the current state through ``scripts.atlas_web_gcloud.Gcloud`` and changes only what
differs. Under ``--dry-run`` every read reports "absent", so the printed plan is the whole sequence
for a fresh project. Roles are only ever granted here, never revoked. A service account that holds a
role it should not (on the bucket, or anywhere in the project) stops the run as a needs-human-decision
error rather than being "fixed" by removing access someone granted on purpose.

Every principal that can act as any service account in the project is reported, because it can also
act as the accounts these scripts create, whatever their own grants say: as a ``note:`` for project
owners and Google-managed service agents, which do so by design, and as a ``warning:`` for anyone
else. Neither is fatal. Such access predates these scripts (a new project gives its default compute
account ``roles/editor``), and removing it is the owner's decision (docs/cost-controls.md,
"Project-wide access").
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any

from scripts.atlas_web_gcloud import Gcloud, GcloudError, GcloudResult
from scripts.provision_atlas_web_bucket import ProvisionError

#: Any one of these, held on the project, lets a principal act as or mint credentials for every
#: service account in it: deploy code that runs as one (actAs), create a key, or get a token.
IMPERSONATION_PERMISSIONS = frozenset(
    {
        "iam.serviceAccounts.actAs",
        "iam.serviceAccountKeys.create",
        "iam.serviceAccounts.getAccessToken",
        "iam.serviceAccounts.implicitDelegation",
        "iam.serviceAccounts.signBlob",
        "iam.serviceAccounts.signJwt",
    }
)
#: Google operates these accounts for its own services (``service-<number>@…`` and
#: ``<number>@cloudservices…``); they act as service accounts by design.
_SERVICE_AGENT = re.compile(
    r"serviceAccount:(service-\d+@[a-z0-9-]+\.iam\.gserviceaccount\.com"
    r"|\d+@cloudservices\.gserviceaccount\.com)"
)


def mutate(gcloud: Gcloud, arguments: Sequence[str]) -> GcloudResult:
    result = gcloud.mutate(arguments)
    if result.returncode != 0:
        raise ProvisionError(f"{Gcloud.display(arguments)} failed: {result.stderr.strip()}")
    return result


#: IAM is eventually consistent: a custom role or service account created moments ago can be refused
#: by a binding for a minute or more ("Role (…) does not exist in the resource's hierarchy" on the
#: first live run, 2026-10-17). Only these messages are retried; any other failure is final.
_PROPAGATING = re.compile(
    r"does not exist in the resource's hierarchy|Service account .+ does not exist", re.IGNORECASE
)
PROPAGATION_DELAYS_S = (10, 20, 30, 30, 30, 30)


def mutate_after_propagation(
    gcloud: Gcloud, arguments: Sequence[str], sleep: Callable[[float], None] = time.sleep
) -> GcloudResult:
    """``mutate``, retrying only while a just-created role or account is still propagating."""
    for delay in (*PROPAGATION_DELAYS_S, None):
        result = gcloud.mutate(arguments)
        if result.returncode == 0:
            return result
        if delay is None or not _PROPAGATING.search(result.stderr):
            break
        print(f"waiting {delay}s for IAM to propagate: {result.stderr.strip().splitlines()[-1]}")
        sleep(delay)
    raise ProvisionError(f"{Gcloud.display(arguments)} failed: {result.stderr.strip()}")


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
        mutate_after_propagation(gcloud, [*add, f"--member={member}", f"--role={role}"])
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


def check_project_iam(gcloud: Gcloud, project: str, member: str, report: list[str]) -> None:
    """``member`` holds no project-wide role (grants are per resource, so one is a mistake: fatal), and
    who else can act as it through a project-wide role (a note or a warning, never fatal)."""
    policy = gcloud.describe(["projects", "get-iam-policy", project, "--format=json"])
    roles = roles_of(policy or {}, member)
    if roles:
        raise ProvisionError(
            f"{member} holds project-wide {', '.join(sorted(roles))}; its grants must be per resource: "
            "needs-human-decision"
        )
    report.append(f"IAM on the project: {member} holds no project-wide role")
    if policy is None:  # dry-run reads nothing
        report.append(f"IAM on the project: who else can act as {member} is reported on a real run")
        return
    found = False
    for binding in policy.get("bindings", []):
        role = str(binding.get("role"))
        members = sorted(binding.get("members") or [])
        permissions = role_permissions(gcloud, role)
        if permissions is None:
            found = True
            report.append(
                f"warning: could not read the permissions of project-wide {role} "
                f"(held by {', '.join(members)}); check by hand whether it can act as {member}"
            )
            continue
        granted = sorted(permissions & IMPERSONATION_PERMISSIONS)
        if not granted:
            continue
        found = True
        condition = " (conditionally)" if binding.get("condition") else ""
        for holder in members:
            expected = _expected_holder(holder, role)
            label = f"note: {holder} ({expected})" if expected else f"warning: {holder}"
            report.append(
                f"{label} can act as {member}{condition} through project-wide {role} "
                f'({", ".join(granted)}); see docs/cost-controls.md, "Project-wide access"'
            )
    if not found:
        report.append(f"IAM on the project: no project-wide role lets anyone act as {member}")


def _expected_holder(holder: str, role: str) -> str | None:
    """Why ``holder`` acting as any service account is by design, or ``None`` when it is a finding."""
    if role == "roles/owner":
        return "a project owner"
    if _SERVICE_AGENT.fullmatch(holder):
        return "a Google-managed service agent"
    return None


def role_permissions(gcloud: Gcloud, role: str) -> frozenset[str] | None:
    """The permissions of a predefined, project or organization role; ``None`` if unreadable."""
    match role.split("/"):
        case ["roles", _]:
            arguments = ["iam", "roles", "describe", role, "--format=json"]
        case ["projects", project, "roles", role_id]:
            arguments = ["iam", "roles", "describe", role_id, f"--project={project}", "--format=json"]
        case ["organizations", organization, "roles", role_id]:
            arguments = [
                "iam",
                "roles",
                "describe",
                role_id,
                f"--organization={organization}",
                "--format=json",
            ]
        case _:
            return None
    try:
        described = gcloud.describe(arguments)
    except GcloudError:
        return None
    return None if described is None else frozenset(described.get("includedPermissions") or [])
