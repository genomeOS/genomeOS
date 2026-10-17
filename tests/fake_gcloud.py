#!/usr/bin/env python3
"""Stateful stand-in for the gcloud CLI in the Atlas web bucket tests (design 2026-10-07 §C.3).

It implements exactly the commands scripts/provision_atlas_web_bucket.py,
scripts/publish_atlas_web.py, scripts/provision_data_store_bucket.py and scripts/publish_data_store.py
issue; the IAM, Pub/Sub, Cloud Functions and billing commands of the budget kill switch and the
data-store publisher are in tests/fake_gcloud_platform.py, which shares this state file. It exits 2 on
anything else, so a script that drifts to an
untested command fails its tests instead of passing them. Error text mirrors gcloud 498's formats
("gs://… not found: 404.", "HTTPError 412: …"). State is the JSON file named by FAKE_GCLOUD_STATE;
every invocation is appended to the JSON-lines file named by FAKE_GCLOUD_LOG with the CLOUDSDK_CONFIG
it saw, which proves the call went through scripts/gcloud_repo.py, and the service account it was told
to impersonate (CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT), if any.

State keys: buckets{name: resource + "bindings"}, objects{"bucket/name": resource + "data_b64"},
org_policies{constraint: policy}, org_policy_errors[constraint], race{"bucket/name": resource},
corrupt_uploads (bool), compute{collection: {name: resource}}, project_number (str; the number
`projects describe` reports and `buckets create` stamps, default DEFAULT_PROJECT_NUMBER),
project_error (str; `projects describe` fails with "ERROR: <it>"), invisible_buckets[name] (`buckets
describe` reports these as 404 even once they exist, like a read that lags a create).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

import fake_gcloud_platform  # tests/, beside this file: the script's own directory is on sys.path

UNSUPPORTED = 2
DESCRIBE_FLAGS = {"raw": "", "format": "json"}
DEFAULT_PROJECT_NUMBER = "123456789012"
# scripts/publish_atlas_web.py's upload_args (Task 90 (C5)); --content-disposition is per object.
COPY_FLAGS = {
    "if-generation-match",
    "content-encoding",
    "content-type",
    "cache-control",
    "content-disposition",
    "custom-metadata",
}
# Task 89 (C4)'s cdn_steps: each collection's create flags besides its scope flags, which are --project
# plus --global for every collection except backend-buckets (always global, so it takes no --global).
COMPUTE_CREATE_FLAGS = {
    "backend-buckets": {"gcs-bucket-name", "enable-cdn", "cache-mode"},
    "url-maps": {"default-backend-bucket"},
    "ssl-certificates": {"domains"},
    "target-https-proxies": {"url-map", "ssl-certificates"},
    "addresses": {"ip-version"},
    "forwarding-rules": {"load-balancing-scheme", "target-https-proxy", "address", "ports"},
}


def _split(arguments: list[str]) -> tuple[list[str], dict[str, str]]:
    positional: list[str] = []
    flags: dict[str, str] = {}
    for argument in arguments:
        if argument.startswith("--"):
            name, _, value = argument[2:].partition("=")
            flags[name] = value
        else:
            positional.append(argument)
    return positional, flags


def _fail(message: str, code: int = 1) -> int:
    print(f"ERROR: {message}", file=sys.stderr)
    return code


def _unsupported(positional: list[str], flags: dict[str, str]) -> int:
    return _fail(f"fake gcloud: unsupported command {' '.join(positional)} {sorted(flags)}", UNSUPPORTED)


def _gs(url: str) -> tuple[str, str]:
    if not url.startswith("gs://"):
        raise SystemExit(_fail(f"fake gcloud: not a gs:// URL: {url}", UNSUPPORTED))
    bucket, _, name = url[len("gs://") :].partition("/")
    return bucket, name


def _print(value: Any) -> int:
    print(json.dumps(value, sort_keys=True))
    return 0


def _object_describe(state: dict[str, Any], url: str, flags: dict[str, str]) -> int:
    if flags != DESCRIBE_FLAGS:
        return _unsupported(["storage", "objects", "describe", url], flags)
    bucket, name = _gs(url)
    found = state.get("objects", {}).get(f"{bucket}/{name}")
    if found is None:
        return _fail(f"(gcloud.storage.objects.describe) {url} not found: 404.")
    return _print({key: value for key, value in found.items() if key != "data_b64"})


def _copy(state: dict[str, Any], source: str, url: str, flags: dict[str, str]) -> int:
    if any(name.startswith("gzip") for name in flags):
        return _fail("fake gcloud: --gzip-* sets Cache-Control no-transform; never use it", UNSUPPORTED)
    if not set(flags) <= COPY_FLAGS:
        return _unsupported(["storage", "cp", source, url], flags)
    if flags.get("if-generation-match") != "0":
        return _fail("fake gcloud: uploads must pass --if-generation-match=0", UNSUPPORTED)
    bucket, name = _gs(url)
    if bucket not in state.get("buckets", {}):
        return _fail(f"(gcloud.storage.cp) gs://{bucket} not found: 404.")
    path = f"{bucket}/{name}"
    objects = state.setdefault("objects", {})
    raced = state.get("race", {}).pop(path, None)
    if raced is not None:
        objects[path] = raced
    if path in objects:
        return _fail("HTTPError 412: At least one of the pre-conditions you specified did not hold.")
    data = Path(source).read_bytes()
    stored = data + b"!" if state.get("corrupt_uploads") else data
    metadata = dict(item.split("=", 1) for item in flags.get("custom-metadata", "").split(",") if item)
    resource: dict[str, Any] = {
        "bucket": bucket,
        "name": name,
        "generation": "1",
        "size": str(len(stored)),
        "md5Hash": base64.b64encode(hashlib.md5(stored).digest()).decode("ascii"),
        "contentType": flags.get("content-type", "application/octet-stream"),
        "metadata": metadata,
        "data_b64": base64.b64encode(stored).decode("ascii"),
    }
    for flag, field in (
        ("content-encoding", "contentEncoding"),
        ("cache-control", "cacheControl"),
        ("content-disposition", "contentDisposition"),
    ):
        if flag in flags:
            resource[field] = flags[flag]
    objects[path] = resource
    return 0


def _bucket(state: dict[str, Any], url: str) -> dict[str, Any] | None:
    bucket, _ = _gs(url)
    return state.get("buckets", {}).get(bucket)


def _org_enforces_pap(state: dict[str, Any]) -> bool:
    policy = state.get("org_policies", {}).get("storage.publicAccessPrevention", {})
    return any(rule.get("enforce") is True for rule in policy.get("spec", {}).get("rules", []))


def _bucket_describe(state: dict[str, Any], url: str, flags: dict[str, str]) -> int:
    if flags != DESCRIBE_FLAGS:
        return _unsupported(["storage", "buckets", "describe", url], flags)
    found = _bucket(state, url)
    if found is None or _gs(url)[0] in state.get("invisible_buckets", []):
        return _fail(f"(gcloud.storage.buckets.describe) {url} not found: 404.")
    return _print({key: value for key, value in found.items() if key != "bindings"})


def _bucket_create(state: dict[str, Any], url: str, flags: dict[str, str]) -> int:
    expected = {"project", "location", "uniform-bucket-level-access", "no-public-access-prevention"}
    if set(flags) != expected:
        return _unsupported(["storage", "buckets", "create", url], flags)
    bucket, _ = _gs(url)
    buckets = state.setdefault("buckets", {})
    if bucket in buckets:
        return _fail("HTTPError 409: The requested bucket name is not available.")
    # gcloud 498 `buckets create` has no labels flag: the provisioning script labels in a separate update.
    buckets[bucket] = {
        "name": bucket,
        "location": flags["location"].upper(),
        "projectNumber": state.get("project_number", DEFAULT_PROJECT_NUMBER),
        "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": True},
            "publicAccessPrevention": "enforced" if _org_enforces_pap(state) else "inherited",
        },
        "bindings": [],
    }
    return 0


def _bucket_update(state: dict[str, Any], url: str, flags: dict[str, str]) -> int:
    allowed = {
        "cors-file",
        "uniform-bucket-level-access",
        "no-public-access-prevention",
        "no-versioning",
        "versioning",
        "soft-delete-duration",
        "update-labels",
    }
    if not flags or not set(flags) <= allowed:
        return _unsupported(["storage", "buckets", "update", url], flags)
    found = _bucket(state, url)
    if found is None:
        return _fail(f"(gcloud.storage.buckets.update) {url} not found: 404.")
    if "no-public-access-prevention" in flags and _org_enforces_pap(state):
        return _fail("HTTPError 412: Public access prevention is enforced by an organization policy.")
    if "update-labels" in flags:
        labels = found.setdefault("labels", {})
        for item in flags["update-labels"].split(","):
            key, _, value = item.partition("=")
            labels[key] = value
    if "cors-file" in flags:
        found["cors"] = json.loads(Path(flags["cors-file"]).read_text(encoding="utf-8"))
    iam = found.setdefault("iamConfiguration", {})
    if "uniform-bucket-level-access" in flags:
        iam["uniformBucketLevelAccess"] = {"enabled": True}
    if "no-public-access-prevention" in flags:
        iam["publicAccessPrevention"] = "inherited"
    if "no-versioning" in flags:
        found["versioning"] = {"enabled": False}
    if "versioning" in flags:
        found["versioning"] = {"enabled": True}
    if "soft-delete-duration" in flags:
        value = flags["soft-delete-duration"]
        units = {"d": 86400, "h": 3600, "s": 1}
        if not value[:-1].isdigit() or value[-1] not in units:
            return _unsupported(["storage", "buckets", "update", url], flags)
        found["softDeletePolicy"] = {"retentionDurationSeconds": str(int(value[:-1]) * units[value[-1]])}
    return 0


def _iam_get(state: dict[str, Any], url: str, flags: dict[str, str]) -> int:
    if flags != {"format": "json"}:
        return _unsupported(["storage", "buckets", "get-iam-policy", url], flags)
    found = _bucket(state, url)
    if found is None:
        return _fail(f"(gcloud.storage.buckets.get-iam-policy) {url} not found: 404.")
    return _print({"bindings": found.get("bindings", []), "etag": "CAE="})


def _iam_add(state: dict[str, Any], url: str, flags: dict[str, str]) -> int:
    if set(flags) != {"member", "role"}:
        return _unsupported(["storage", "buckets", "add-iam-policy-binding", url], flags)
    found = _bucket(state, url)
    if found is None:
        return _fail(f"(gcloud.storage.buckets.add-iam-policy-binding) {url} not found: 404.")
    drs = state.get("org_policies", {}).get("iam.allowedPolicyMemberDomains", {})
    restricted = any(
        rule.get("values", {}).get("allowedValues") for rule in drs.get("spec", {}).get("rules", [])
    )
    # The managed constraint admits a member only by name (allowedMemberSubjects) or principal set.
    managed = state.get("org_policies", {}).get("iam.managed.allowedPolicyMembers", {})
    restricted = restricted or any(
        rule.get("enforce") is True
        and flags["member"] not in rule.get("parameters", {}).get("allowedMemberSubjects", [])
        for rule in managed.get("spec", {}).get("rules", [])
    )
    if flags["member"] == "allUsers" and restricted:
        return _fail(
            "HTTPError 412: One or more users named in the policy do not belong to a permitted customer."
        )
    bindings = found.setdefault("bindings", [])
    for binding in bindings:
        if binding["role"] == flags["role"]:
            if flags["member"] not in binding["members"]:
                binding["members"].append(flags["member"])
            return 0
    bindings.append({"role": flags["role"], "members": [flags["member"]]})
    return 0


def _iam_remove(state: dict[str, Any], url: str, flags: dict[str, str]) -> int:
    if set(flags) != {"member", "role"}:
        return _unsupported(["storage", "buckets", "remove-iam-policy-binding", url], flags)
    found = _bucket(state, url)
    if found is None:
        return _fail(f"(gcloud.storage.buckets.remove-iam-policy-binding) {url} not found: 404.")
    for binding in found.get("bindings", []):
        if binding["role"] == flags["role"] and flags["member"] in binding["members"]:
            binding["members"].remove(flags["member"])
            found["bindings"] = [item for item in found["bindings"] if item["members"]]
            return 0
    return _fail(
        "(gcloud.storage.buckets.remove-iam-policy-binding) Policy binding with the specified "
        "principal, role, and condition not found!"
    )


def _org_policy(state: dict[str, Any], constraint: str, flags: dict[str, str]) -> int:
    if set(flags) != {"project", "effective", "format"} or flags["format"] != "json":
        return _unsupported(["org-policies", "describe", constraint], flags)
    if constraint in state.get("org_policy_errors", []):
        return _fail(
            f"(gcloud.org-policies.describe) PERMISSION_DENIED: orgpolicy.policy.get on {constraint}"
        )
    default = {"name": f"projects/{flags['project']}/policies/{constraint}", "spec": {}}
    return _print(state.get("org_policies", {}).get(constraint, default))


def _project_describe(state: dict[str, Any], project: str, flags: dict[str, str]) -> int:
    if flags != {"format": "json"}:
        return _unsupported(["projects", "describe", project], flags)
    if state.get("project_error"):
        return _fail(state["project_error"])
    return _print(
        {
            "lifecycleState": "ACTIVE",
            "projectId": project,
            "projectNumber": state.get("project_number", DEFAULT_PROJECT_NUMBER),
        }
    )


def _compute_flags(collection: str, flags: dict[str, str], expected: set[str]) -> bool:
    """True when ``flags`` are exactly ``collection``'s scope flags plus ``expected``."""
    if collection not in COMPUTE_CREATE_FLAGS:
        return False
    scope = {"project"} if collection == "backend-buckets" else {"project", "global"}
    return set(flags) == scope | expected and bool(flags["project"]) and flags.get("global", "") == ""


def _compute_describe(state: dict[str, Any], collection: str, name: str, flags: dict[str, str]) -> int:
    if not _compute_flags(collection, flags, {"format"}) or flags["format"] != "json":
        return _unsupported(["compute", collection, "describe", name], flags)
    found = state.get("compute", {}).get(collection, {}).get(name)
    if found is None:
        return _fail(
            f"(gcloud.compute.{collection}.describe) Could not fetch resource:\n"
            f" - The resource '{name}' was not found"
        )
    return _print(found)


def _compute_create(state: dict[str, Any], collection: str, name: str, flags: dict[str, str]) -> int:
    if not _compute_flags(collection, flags, COMPUTE_CREATE_FLAGS.get(collection, set())):
        return _unsupported(["compute", collection, "create", name], flags)
    resources = state.setdefault("compute", {}).setdefault(collection, {})
    if name in resources:
        return _fail(f"(gcloud.compute.{collection}.create) '{name}' already exists")
    resource: dict[str, Any] = {"name": name, **flags}
    if collection == "addresses":
        resource["address"] = "203.0.113.10"
    resources[name] = resource
    return 0


def _dispatch(state: dict[str, Any], positional: list[str], flags: dict[str, str]) -> int:
    match positional:
        case ["storage", "objects", "describe", url]:
            return _object_describe(state, url, flags)
        case ["storage", "cp", source, url]:
            return _copy(state, source, url, flags)
        case ["storage", "buckets", "describe", url]:
            return _bucket_describe(state, url, flags)
        case ["storage", "buckets", "create", url]:
            return _bucket_create(state, url, flags)
        case ["storage", "buckets", "update", url]:
            return _bucket_update(state, url, flags)
        case ["storage", "buckets", "get-iam-policy", url]:
            return _iam_get(state, url, flags)
        case ["storage", "buckets", "add-iam-policy-binding", url]:
            return _iam_add(state, url, flags)
        case ["storage", "buckets", "remove-iam-policy-binding", url]:
            return _iam_remove(state, url, flags)
        case ["org-policies", "describe", constraint]:
            return _org_policy(state, constraint, flags)
        case ["projects", "describe", project]:
            return _project_describe(state, project, flags)
        case ["compute", collection, "describe", name]:
            return _compute_describe(state, collection, name, flags)
        case ["compute", collection, "create", name]:
            return _compute_create(state, collection, name, flags)
        case _:
            return fake_gcloud_platform.dispatch(state, positional, flags)


def main(argv: list[str]) -> int:
    state_path = Path(os.environ["FAKE_GCLOUD_STATE"])
    with open(os.environ["FAKE_GCLOUD_LOG"], "a", encoding="utf-8") as log:
        record = {
            "argv": argv,
            "cloudsdk_config": os.environ.get("CLOUDSDK_CONFIG"),
            "impersonate": os.environ.get("CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT"),
        }
        log.write(json.dumps(record) + "\n")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    positional, flags = _split(argv)
    code = _dispatch(state, positional, flags)
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
