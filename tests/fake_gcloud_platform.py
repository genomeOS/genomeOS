"""The IAM, Pub/Sub, Cloud Functions and billing half of tests/fake_gcloud.py (#480).

tests/fake_gcloud.py hands every command it does not implement to ``dispatch`` here, so the fake
still has one entry point and one state file. These are exactly the commands
scripts/provision_budget_kill_switch.py and scripts/provision_data_store_publisher.py issue (through
scripts/gcp_identity.py), each with its exact flag set; anything else exits 2 (unsupported), so a
script that drifts to an untested command fails its tests. Error text mirrors gcloud 498's
("NOT_FOUND: …", "status=[404]").

State keys: services_enabled[name], roles{id: resource}, service_accounts{email: resource},
topics{name: resource}, functions{name: resource}, policies{"<kind>/<name>": [bindings]} (kind is
project, service-account, topic or run-service), billing_account (str), budgets[resource],
budget_update_merges (merged into a budget's notificationsRule by every update, to stand in for an
update that changes more than it was asked to), last_deploy_source_files[name].
"""

from __future__ import annotations

import fnmatch
import json
import sys
from pathlib import Path
from typing import Any

UNSUPPORTED = 2
BUDGET_PUBLISHER = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"
DEPLOY_FLAGS = {
    "gen2",
    "project",
    "region",
    "runtime",
    "source",
    "entry-point",
    "trigger-topic",
    "run-service-account",
    "trigger-service-account",
    "set-env-vars",
    "memory",
    "timeout",
    "max-instances",
    "ingress-settings",
    "update-labels",
}
INGRESS = {"internal-only": "ALLOW_INTERNAL_ONLY", "all": "ALLOW_ALL"}


def _fail(message: str, code: int = 1) -> int:
    print(f"ERROR: {message}", file=sys.stderr)
    return code


def _unsupported(positional: list[str], flags: dict[str, str]) -> int:
    return _fail(f"fake gcloud: unsupported command {' '.join(positional)} {sorted(flags)}", UNSUPPORTED)


def _print(value: Any) -> int:
    print(json.dumps(value, sort_keys=True))
    return 0


def _pairs(value: str) -> dict[str, str]:
    return dict(item.split("=", 1) for item in value.split(",") if item)


def _uploaded(source: Path) -> list[str]:
    """What gcloud would upload: the top-level names .gcloudignore does not exclude."""
    ignore = source / ".gcloudignore"
    patterns = [
        line.strip()
        for line in (ignore.read_text(encoding="utf-8").splitlines() if ignore.exists() else [])
        if line.strip() and not line.startswith("#")
    ]

    def ignored(path: Path) -> bool:
        return any(
            fnmatch.fnmatch(path.name, pattern.rstrip("/")) and (path.is_dir() or not pattern.endswith("/"))
            for pattern in patterns
        )

    return sorted(path.name for path in source.iterdir() if not ignored(path))


def _policy_get(state: dict[str, Any], kind: str, name: str) -> int:
    return _print({"bindings": state.get("policies", {}).get(f"{kind}/{name}", []), "etag": "BwX="})


def _policy_add(state: dict[str, Any], kind: str, name: str, flags: dict[str, str]) -> int:
    bindings = state.setdefault("policies", {}).setdefault(f"{kind}/{name}", [])
    for binding in bindings:
        if binding["role"] == flags["role"]:
            if flags["member"] not in binding["members"]:
                binding["members"].append(flags["member"])
            return 0
    bindings.append({"role": flags["role"], "members": [flags["member"]]})
    return 0


def _services(state: dict[str, Any], verb: str, rest: list[str], flags: dict[str, str]) -> int | None:
    if verb == "list" and not rest and set(flags) == {"enabled", "project", "format"}:
        return _print([{"config": {"name": name}} for name in state.get("services_enabled", [])])
    if verb == "enable" and rest and set(flags) == {"project"}:
        enabled = state.setdefault("services_enabled", [])
        enabled.extend(name for name in rest if name not in enabled)
        return 0
    return None


def _roles(state: dict[str, Any], verb: str, role: str, flags: dict[str, str]) -> int | None:
    roles = state.setdefault("roles", {})
    project = flags.get("project")
    if verb == "describe" and set(flags) == {"project", "format"}:
        if role not in roles:
            return _fail(
                f"(gcloud.iam.roles.describe) NOT_FOUND: The role named projects/{project}/roles/{role} "
                "was not found."
            )
        return _print(roles[role])
    if verb == "create" and set(flags) == {"project", "title", "description", "permissions", "stage"}:
        if role in roles:
            return _fail(f"(gcloud.iam.roles.create) ALREADY_EXISTS: A role named {role} already exists.")
        roles[role] = {
            "name": f"projects/{project}/roles/{role}",
            "title": flags["title"],
            "description": flags["description"],
            "includedPermissions": sorted(flags["permissions"].split(",")),
            "stage": flags["stage"],
        }
        return 0
    if verb == "update" and set(flags) == {"project", "permissions"} and role in roles:
        roles[role]["includedPermissions"] = sorted(flags["permissions"].split(","))
        return 0
    if verb == "undelete" and set(flags) == {"project"} and role in roles:
        roles[role].pop("deleted", None)
        return 0
    return None


def _service_accounts(state: dict[str, Any], verb: str, name: str, flags: dict[str, str]) -> int | None:
    accounts = state.setdefault("service_accounts", {})
    if verb == "create" and set(flags) == {"project", "display-name", "description"}:
        email = f"{name}@{flags['project']}.iam.gserviceaccount.com"
        if email in accounts:
            return _fail("(gcloud.iam.service-accounts.create) ALREADY_EXISTS: Service account exists.")
        accounts[email] = {"email": email, "displayName": flags["display-name"], "disabled": False}
        return 0
    if verb not in {"describe", "get-iam-policy", "add-iam-policy-binding"}:
        return None
    if name not in accounts:
        return _fail(f"(gcloud.iam.service-accounts.{verb}) NOT_FOUND: Unknown service account.")
    if verb == "describe" and set(flags) == {"project", "format"}:
        return _print(accounts[name])
    if verb == "get-iam-policy" and set(flags) == {"project", "format"}:
        return _policy_get(state, "service-account", name)
    if verb == "add-iam-policy-binding" and set(flags) == {"project", "member", "role"}:
        return _policy_add(state, "service-account", name, flags)
    return None


def _topics(state: dict[str, Any], verb: str, name: str, flags: dict[str, str]) -> int | None:
    topics = state.setdefault("topics", {})
    if verb == "create" and set(flags) == {"project", "labels"}:
        if name in topics:
            return _fail("(gcloud.pubsub.topics.create) ALREADY_EXISTS: Resource already exists.")
        topics[name] = {
            "name": f"projects/{flags['project']}/topics/{name}",
            "labels": _pairs(flags["labels"]),
        }
        return 0
    if verb not in {"describe", "get-iam-policy", "add-iam-policy-binding"}:
        return None
    if name not in topics:
        return _fail(f"(gcloud.pubsub.topics.{verb}) NOT_FOUND: Resource not found (resource={name}).")
    if verb == "describe" and set(flags) == {"project", "format"}:
        return _print(topics[name])
    if verb == "get-iam-policy" and set(flags) == {"project", "format"}:
        return _policy_get(state, "topic", name)
    if verb == "add-iam-policy-binding" and set(flags) == {"project", "member", "role"}:
        return _policy_add(state, "topic", name, flags)
    return None


def _functions(state: dict[str, Any], verb: str, name: str, flags: dict[str, str]) -> int | None:
    functions = state.setdefault("functions", {})
    if verb == "describe" and set(flags) == {"gen2", "project", "region", "format"}:
        if name not in functions:
            return _fail(
                f"(gcloud.functions.describe) ResponseError: status=[404], code=[Ok], message=[Function "
                f"{name} in region {flags['region']} in project {flags['project']} does not exist]"
            )
        return _print(functions[name])
    if verb != "deploy" or set(flags) != DEPLOY_FLAGS:
        return None
    source = Path(flags["source"])  # relative: gcloud runs from the repository root
    if source.is_absolute() or not source.is_dir():
        return _fail(
            f"(gcloud.functions.deploy) source {source} is not a directory under the working directory"
        )
    state["last_deploy_source_files"] = _uploaded(source)
    project, region = flags["project"], flags["region"]
    labels = dict((functions.get(name) or {}).get("labels") or {})
    labels.update(_pairs(flags["update-labels"]))
    functions[name] = {
        "name": f"projects/{project}/locations/{region}/functions/{name}",
        "state": "ACTIVE",
        "labels": labels,
        "buildConfig": {"runtime": flags["runtime"], "entryPoint": flags["entry-point"]},
        "serviceConfig": {
            "environmentVariables": {"LOG_EXECUTION_ID": "true", **_pairs(flags["set-env-vars"])},
            "serviceAccountEmail": flags["run-service-account"],
            "ingressSettings": INGRESS[flags["ingress-settings"]],
            "maxInstanceCount": int(flags["max-instances"]),
            "service": f"projects/{project}/locations/{region}/services/{name}",
        },
        "eventTrigger": {
            "pubsubTopic": f"projects/{project}/topics/{flags['trigger-topic']}",
            "serviceAccountEmail": flags["trigger-service-account"],
            "retryPolicy": "RETRY_POLICY_DO_NOT_RETRY",
        },
    }
    return 0


def _run_services(state: dict[str, Any], verb: str, name: str, flags: dict[str, str]) -> int | None:
    if name not in state.get("functions", {}):
        return _fail(f"(gcloud.run.services.{verb}) NOT_FOUND: Resource '{name}' was not found")
    if verb == "get-iam-policy" and set(flags) == {"region", "project", "format"}:
        return _policy_get(state, "run-service", name)
    if verb == "add-iam-policy-binding" and set(flags) == {"region", "project", "member", "role"}:
        return _policy_add(state, "run-service", name, flags)
    return None


def _billing(state: dict[str, Any], positional: list[str], flags: dict[str, str]) -> int | None:
    account = state.get("billing_account", "000000-000000-000000")
    match positional:
        case ["billing", "projects", "describe", project] if flags == {"format": "json"}:
            return _print(
                {
                    "billingAccountName": f"billingAccounts/{account}",
                    "billingEnabled": True,
                    "projectId": project,
                }
            )
        case ["billing", "budgets", "list"] if flags == {"billing-account": account, "format": "json"}:
            return _print(state.get("budgets", []))
        case ["billing", "budgets", "update", budget_id] if set(flags) == {
            "billing-account",
            "notifications-rule-pubsub-topic",
        }:
            for budget in state.get("budgets", []):
                if budget["name"] == f"billingAccounts/{flags['billing-account']}/budgets/{budget_id}":
                    rule = budget.setdefault("notificationsRule", {})
                    topic = flags["notifications-rule-pubsub-topic"]
                    rule.update(
                        pubsubTopic=topic, schemaVersion="1.0", **state.get("budget_update_merges", {})
                    )
                    # The Budget API grants its publisher on the topic itself (the caller needs setIamPolicy).
                    short = topic.rsplit("/", 1)[-1]
                    if short in state.get("topics", {}):
                        _policy_add(
                            state,
                            "topic",
                            short,
                            {"member": BUDGET_PUBLISHER, "role": "roles/pubsub.publisher"},
                        )
                    return 0
            return _fail(f"(gcloud.billing.budgets.update) NOT_FOUND: budget {budget_id} not found")
    return None


def dispatch(state: dict[str, Any], positional: list[str], flags: dict[str, str]) -> int:
    handled: int | None = None
    match positional:
        case ["services", verb, *rest]:
            handled = _services(state, verb, rest, flags)
        case ["iam", "roles", verb, role]:
            handled = _roles(state, verb, role, flags)
        case ["iam", "service-accounts", verb, name]:
            handled = _service_accounts(state, verb, name, flags)
        case ["projects", "get-iam-policy", project] if flags == {"format": "json"}:
            handled = _policy_get(state, "project", project)
        case ["pubsub", "topics", verb, name]:
            handled = _topics(state, verb, name, flags)
        case ["functions", verb, name]:
            handled = _functions(state, verb, name, flags)
        case ["run", "services", verb, name]:
            handled = _run_services(state, verb, name, flags)
        case ["billing", *_]:
            handled = _billing(state, positional, flags)
    return _unsupported(positional, flags) if handled is None else handled
