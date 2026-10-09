#!/usr/bin/env python3
"""Provision the public GCS bucket that serves the Atlas web data (fast-load/GCS design 2026-10-07 §C.2).

Idempotent: every step reads the current state first and changes only what differs, so a second run
changes nothing. ``--dry-run`` prints every command and runs none; because it reads nothing, it prints
the full sequence for a new bucket. Nothing here deletes anything.

``edge`` (default; provisioned): public objects with ``Cache-Control: public`` are served from
Google's edge caches at ``https://storage.googleapis.com/<bucket>/atlas/web/``.

``cloud-cdn`` (scripted, not provisioned): a backend bucket with Cloud CDN behind a global external
HTTPS load balancer with a Google-managed certificate for ``data.genome-os.org``. It needs a DNS A
record at the registrar (GoDaddy; a human step) and has a recurring load-balancer cost.

The bucket is in us-east1 with uniform bucket-level access, readable by ``allUsers``
(``roles/storage.objectViewer``), unversioned (keys are content-addressed) with the default soft
delete. The effective domain-restricted-sharing org policies (the legacy list constraint and its
managed successor) and the public-access-prevention one are read and reported first; a blocking one
stops the run before any change. One that cannot be read is reported and the run continues, so if it
does block, the step it refuses fails and the bucket stays private. Because this makes a bucket public,
an existing bucket is adopted only if it carries the ``genomeos-purpose=atlas-web`` label this
script sets right after creating it and belongs to the project; any other existing bucket is
refused before any change (needs-human-decision), and public-access prevention is never lifted on
an update. No project id or bucket name is
stored in git (docs/repo-gcloud-auth.md): pass ``--bucket`` and ``--project`` (or
``GENOMEOS_GCP_PROJECT``). Every command goes through scripts/gcloud_repo.py.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication.web_layout import OBJECT_PREFIX, assert_bucket_name, cors_policy  # noqa: E402
from scripts.atlas_web_gcloud import Gcloud, GcloudError  # noqa: E402

# Relative to ROOT: the wrapper runs gcloud from the repository root, and the printed plan stays
# free of machine-specific paths.
CORS_FILE = Path("deploy") / "atlas-web-cors.json"
LOCATION = "us-east1"
PUBLIC_MEMBER = "allUsers"
PUBLIC_ROLE = "roles/storage.objectViewer"
DOMAIN_RESTRICTED_SHARING = "iam.allowedPolicyMemberDomains"
# The managed domain-restricted-sharing constraint: when enforced, IAM accepts only the members its
# ``allowedMemberSubjects`` and ``allowedPrincipalSets`` parameters admit, and allUsers is admitted
# only by name in ``allowedMemberSubjects``.
MANAGED_DOMAIN_RESTRICTED_SHARING = "iam.managed.allowedPolicyMembers"
PUBLIC_ACCESS_PREVENTION = "storage.publicAccessPrevention"
ORG_POLICY_CONSTRAINTS = (
    DOMAIN_RESTRICTED_SHARING,
    MANAGED_DOMAIN_RESTRICTED_SHARING,
    PUBLIC_ACCESS_PREVENTION,
)
CDN_DOMAIN = "data.genome-os.org"
CDN_ADDRESS = "atlas-web-ip"
# Set right after creation (gcloud 498 `buckets create` has no labels flag); the proof that an
# existing bucket is one this script made, and so may be made public.
LABEL_KEY = "genomeos-purpose"
LABEL_VALUE = "atlas-web"
# What a bucket created by this script looks like; stands in for the describe a dry run cannot make.
NEW_BUCKET: dict[str, Any] = {
    "location": LOCATION.upper(),
    "iamConfiguration": {
        "uniformBucketLevelAccess": {"enabled": True},
        "publicAccessPrevention": "inherited",
    },
}


class ProvisionError(RuntimeError):
    """The bucket cannot be made public as the design requires."""


def edge_base_url(bucket: str) -> str:
    return f"https://storage.googleapis.com/{bucket}/{OBJECT_PREFIX}"


def policy_blocks(constraint: str, policy: dict[str, Any]) -> bool:
    """True when an effective org policy would stop ``allUsers`` from reading the objects."""
    rules = (policy.get("spec") or {}).get("rules") or []
    if constraint == PUBLIC_ACCESS_PREVENTION:
        return any(rule.get("enforce") is True for rule in rules)
    if constraint == MANAGED_DOMAIN_RESTRICTED_SHARING:
        return any(
            rule.get("enforce") is True
            and PUBLIC_MEMBER not in ((rule.get("parameters") or {}).get("allowedMemberSubjects") or [])
            for rule in rules
        )
    return any(rule.get("denyAll") is True or rule.get("values", {}).get("allowedValues") for rule in rules)


def check_org_policies(gcloud: Gcloud, project: str, report: list[str]) -> None:
    blocked: list[str] = []
    for constraint in ORG_POLICY_CONSTRAINTS:
        arguments = [
            "org-policies",
            "describe",
            constraint,
            f"--project={project}",
            "--effective",
            "--format=json",
        ]
        result = gcloud.query(arguments)
        if gcloud.dry_run:
            report.append(f"org policy {constraint}: not read (dry-run)")
            continue
        if result.returncode != 0:
            detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "no detail"
            report.append(
                f"org policy {constraint}: unreadable ({detail}); "
                "a blocking policy will surface as a failed step"
            )
            continue
        if policy_blocks(constraint, _policy(arguments, result.stdout)):
            blocked.append(constraint)
            report.append(f"org policy {constraint}: BLOCKS public objects")
        else:
            report.append(f"org policy {constraint}: does not block public objects")
    if blocked:
        raise ProvisionError(
            "effective organization policy blocks a public bucket: "
            + ", ".join(blocked)
            + "; an organization admin must grant a project exception (design §C.2)"
        )


def _policy(arguments: list[str], stdout: str) -> dict[str, Any]:
    """The org policy a successful read printed (empty output: no policy set).

    Any output that is not a JSON object is an error; it is never read as a non-blocking policy.
    """
    try:
        value = json.loads(stdout or "{}")
    except json.JSONDecodeError as error:
        raise GcloudError(
            f"{Gcloud.display(arguments)} printed {stdout[:200]!r}, not JSON ({error})"
        ) from error
    if not isinstance(value, dict):
        raise GcloudError(f"{Gcloud.display(arguments)} printed {stdout[:200]!r}, not a JSON object")
    return value


def assert_created_here(gcloud: Gcloud, url: str, project: str, current: dict[str, Any]) -> None:
    """Refuse, before any change, an existing bucket this script did not create (design §C.2).

    Provisioning grants ``allUsers`` read (and anonymous listing) on the whole bucket, so a
    same-named bucket without this script's label, or in another project, is never touched.
    """
    labels = current.get("labels") or {}
    if labels.get(LABEL_KEY) != LABEL_VALUE:
        raise ProvisionError(
            f"{url} exists but was not created by this script (no label {LABEL_KEY}={LABEL_VALUE}); "
            "it is never made public automatically: needs-human-decision"
        )
    project_info = gcloud.describe(["projects", "describe", project, "--format=json"])
    expected = (project_info or {}).get("projectNumber")
    if not expected:
        found = "found no such project" if project_info is None else "reported no projectNumber"
        raise ProvisionError(
            f"cannot read the project number of {project} (projects describe {found}), so {url} cannot "
            "be matched to it; check --project and the account's access"
        )
    if str(current.get("projectNumber", "")) != str(expected):
        raise ProvisionError(
            f"{url} is not in project {project} (bucket project number "
            f"{current.get('projectNumber')!r}); needs-human-decision"
        )


def provision_edge(gcloud: Gcloud, bucket: str, project: str, report: list[str]) -> None:
    url = f"gs://{bucket}"
    try:
        committed = json.loads((ROOT / CORS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:  # ValueError covers JSONDecodeError and UnicodeDecodeError
        raise ProvisionError(f"{CORS_FILE} is unreadable ({error}); restore it from git") from error
    if committed != cors_policy():
        raise ProvisionError(
            f"{CORS_FILE} differs from web_layout.cors_policy(); fix the file, not the bucket"
        )
    check_org_policies(gcloud, project, report)
    describe = ["storage", "buckets", "describe", url, "--raw", "--format=json"]
    current = gcloud.describe(describe)
    created = current is None
    if current is None:
        _mutate(
            gcloud,
            [
                "storage",
                "buckets",
                "create",
                url,
                f"--project={project}",
                f"--location={LOCATION}",
                "--uniform-bucket-level-access",
                "--no-public-access-prevention",
            ],
        )
        _mutate(gcloud, ["storage", "buckets", "update", url, f"--update-labels={LABEL_KEY}={LABEL_VALUE}"])
        report.append(f"bucket {url}: created in {LOCATION}, labelled {LABEL_KEY}={LABEL_VALUE}")
        current = gcloud.describe(describe)
        if current is None:
            if not gcloud.dry_run:
                raise ProvisionError(f"{url} is not visible right after creation")
            current = dict(NEW_BUCKET)
    else:
        report.append(f"bucket {url}: exists")
    location = str(current.get("location", "")).lower()
    if location != LOCATION:
        raise ProvisionError(
            f"{url} is in {location or 'an unknown location'}, not {LOCATION}; choose another name"
        )
    if not created:
        assert_created_here(gcloud, url, project, current)
    iam = current.get("iamConfiguration", {})
    prevention = iam.get("publicAccessPrevention", "inherited")
    report.append(f"public-access prevention: {prevention}")
    if prevention == "enforced":
        raise ProvisionError(
            f"public-access prevention is enforced on {url}; this script never lifts it "
            "(an organization policy or a deliberate setting): needs-human-decision"
        )
    updates: list[str] = []
    if not iam.get("uniformBucketLevelAccess", {}).get("enabled"):
        updates.append("--uniform-bucket-level-access")
    if current.get("versioning", {}).get("enabled"):
        updates.append("--no-versioning")
    if updates:
        _mutate(gcloud, ["storage", "buckets", "update", url, *updates])
        report.append(f"bucket {url}: updated {' '.join(updates)}")
    policy = gcloud.describe(["storage", "buckets", "get-iam-policy", url, "--format=json"]) or {
        "bindings": []
    }
    public = any(
        binding.get("role") == PUBLIC_ROLE and PUBLIC_MEMBER in binding.get("members", [])
        for binding in policy.get("bindings", [])
    )
    if public:
        report.append(f"IAM: {PUBLIC_MEMBER} already has {PUBLIC_ROLE}")
    else:
        _mutate(
            gcloud,
            [
                "storage",
                "buckets",
                "add-iam-policy-binding",
                url,
                f"--member={PUBLIC_MEMBER}",
                f"--role={PUBLIC_ROLE}",
            ],
        )
        report.append(f"IAM: {PUBLIC_MEMBER} granted {PUBLIC_ROLE}")
    if current.get("cors") == committed:
        report.append("CORS: already the committed policy")
    else:
        _mutate(gcloud, ["storage", "buckets", "update", url, f"--cors-file={CORS_FILE}"])
        report.append(f"CORS: set from {CORS_FILE}")


def cdn_steps(bucket: str, project: str) -> list[tuple[list[str], list[str]]]:
    """(describe, create) argument pairs for the cloud-cdn resources, in dependency order."""
    scope = f"--project={project}"
    return [
        (
            ["compute", "backend-buckets", "describe", "atlas-web-backend", scope, "--format=json"],
            [
                "compute",
                "backend-buckets",
                "create",
                "atlas-web-backend",
                scope,
                f"--gcs-bucket-name={bucket}",
                "--enable-cdn",
                "--cache-mode=USE_ORIGIN_HEADERS",
            ],
        ),
        (
            ["compute", "url-maps", "describe", "atlas-web-map", "--global", scope, "--format=json"],
            [
                "compute",
                "url-maps",
                "create",
                "atlas-web-map",
                "--global",
                scope,
                "--default-backend-bucket=atlas-web-backend",
            ],
        ),
        (
            ["compute", "ssl-certificates", "describe", "atlas-web-cert", "--global", scope, "--format=json"],
            [
                "compute",
                "ssl-certificates",
                "create",
                "atlas-web-cert",
                "--global",
                scope,
                f"--domains={CDN_DOMAIN}",
            ],
        ),
        (
            [
                "compute",
                "target-https-proxies",
                "describe",
                "atlas-web-https-proxy",
                "--global",
                scope,
                "--format=json",
            ],
            [
                "compute",
                "target-https-proxies",
                "create",
                "atlas-web-https-proxy",
                "--global",
                scope,
                "--url-map=atlas-web-map",
                "--ssl-certificates=atlas-web-cert",
            ],
        ),
        (
            ["compute", "addresses", "describe", CDN_ADDRESS, "--global", scope, "--format=json"],
            ["compute", "addresses", "create", CDN_ADDRESS, "--global", scope, "--ip-version=IPV4"],
        ),
        (
            [
                "compute",
                "forwarding-rules",
                "describe",
                "atlas-web-https-rule",
                "--global",
                scope,
                "--format=json",
            ],
            [
                "compute",
                "forwarding-rules",
                "create",
                "atlas-web-https-rule",
                "--global",
                scope,
                "--load-balancing-scheme=EXTERNAL_MANAGED",
                "--target-https-proxy=atlas-web-https-proxy",
                f"--address={CDN_ADDRESS}",
                "--ports=443",
            ],
        ),
    ]


def provision_cloud_cdn(gcloud: Gcloud, bucket: str, project: str, report: list[str]) -> None:
    for describe, create in cdn_steps(bucket, project):
        label = f"cloud-cdn {create[1]} {create[3]}"
        if gcloud.describe(describe) is None:
            _mutate(gcloud, create)
            report.append(f"{label}: created")
        else:
            report.append(f"{label}: exists")
    address = gcloud.describe(
        ["compute", "addresses", "describe", CDN_ADDRESS, "--global", f"--project={project}", "--format=json"]
    )
    ip = address.get("address", "<address pending>") if address else "<address pending>"
    report.append(
        f"HUMAN STEP: create a DNS A record {CDN_DOMAIN} -> {ip} at the registrar (GoDaddy); the managed "
        f"certificate provisions only after it resolves. Then set ATLAS_DATA_BASE_URL=https://{CDN_DOMAIN}/{OBJECT_PREFIX}"
    )


def _mutate(gcloud: Gcloud, arguments: list[str]) -> None:
    result = gcloud.mutate(arguments)
    if result.returncode != 0:
        raise ProvisionError(f"{Gcloud.display(arguments)} failed: {result.stderr.strip()}")


def _bucket(value: str) -> str:
    try:
        return assert_bucket_name(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Provision the public GCS bucket for the Atlas web data.")
    parser.add_argument("--mode", choices=("edge", "cloud-cdn"), default="edge")
    parser.add_argument("--bucket", type=_bucket, required=True, help="bucket name (never stored in git)")
    parser.add_argument(
        "--project", help="GCP project id (default: $GENOMEOS_GCP_PROJECT; never stored in git)"
    )
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
    gcloud = Gcloud(dry_run=args.dry_run)
    report: list[str] = []
    try:
        provision_edge(gcloud, args.bucket, project, report)
        if args.mode == "cloud-cdn":
            provision_cloud_cdn(gcloud, args.bucket, project, report)
    except (ProvisionError, GcloudError) as error:
        print("\n".join(report))
        print(f"error: {error}", file=sys.stderr)
        return 1
    print("\n".join(report))
    base = edge_base_url(args.bucket) if args.mode == "edge" else f"https://{CDN_DOMAIN}/{OBJECT_PREFIX}"
    print(f"artifact base: {base}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
