#!/usr/bin/env python3
"""Provision the public data-store bucket (data store design 2026-10-17 §3 C1–C3, §7).

    python scripts/provision_data_store_bucket.py --project <project> --dry-run
    python scripts/provision_data_store_bucket.py --project <project>

The committed bucket (``data_release.DATA_STORE_BUCKET``), separate from the Atlas web-data bucket:
us-east1, uniform bucket-level access, open CORS for ``GET``/``HEAD`` and the label
``genomeos-purpose=data-store``. Anonymous readers get ``roles/storage.legacyObjectReader``: they read
any object by key, but cannot list the bucket (owner decision 2026-10-17); a listing role granted to
``allUsers`` earlier (``objectViewer``, ``legacyBucketReader``) is removed after the reader role is in
place, so reads never lapse. Object versioning is on and soft delete is 30 days: a backstop against an
accidental overwrite or delete, not a substitute for the immutable release paths and no-overwrite
uploads. It mirrors ``provision_atlas_web_bucket.py --mode edge`` and reuses its org-policy check: a
blocking policy stops the run before any change.

Idempotent: every step reads the current state and changes only what differs, so a second run changes
nothing. ``--dry-run`` prints every command and runs none. Because this makes a bucket public, an
existing bucket is adopted only if it carries this script's label and belongs to the project; any other,
including the web-data bucket, is refused before any change (needs-human-decision). Public-access
prevention is never lifted on an existing bucket, and no object is ever touched. The project id is never
stored in git (docs/repo-gcloud-auth.md); the bucket name is committed, and any other is refused. Every
command goes through scripts/gcloud_repo.py.
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

from genomeos.publication import data_release as dr  # noqa: E402
from scripts.atlas_web_gcloud import Gcloud, GcloudError  # noqa: E402
from scripts.provision_atlas_web_bucket import ProvisionError, check_org_policies  # noqa: E402

# Relative to ROOT: the wrapper runs gcloud from the repository root, and the printed plan stays free
# of machine-specific paths.
CORS_FILE = Path("deploy") / "data-store-cors.json"
LOCATION = "us-east1"
PUBLIC_MEMBER = "allUsers"
#: Read an object by key; no ``storage.objects.list``. Readers take every key from the manifest.
PUBLIC_ROLE = "roles/storage.legacyObjectReader"
#: Roles that would let anyone list the bucket; removed from ``allUsers`` once PUBLIC_ROLE is granted.
LISTING_ROLES = ("roles/storage.objectViewer", "roles/storage.legacyBucketReader")
SOFT_DELETE = "30d"
SOFT_DELETE_SECONDS = str(30 * 86400)
LABEL_KEY = "genomeos-purpose"
LABEL_VALUE = "data-store"
# What a bucket created by this script looks like; stands in for the describe a dry run cannot make.
NEW_BUCKET: dict[str, Any] = {
    "location": LOCATION.upper(),
    "iamConfiguration": {
        "uniformBucketLevelAccess": {"enabled": True},
        "publicAccessPrevention": "inherited",
    },
}


def cors_policy() -> list[dict[str, Any]]:
    """Open read CORS: the data is public, and browser tools (DuckDB-WASM, notebooks) need it."""
    return [
        {
            "origin": ["*"],
            "method": ["GET", "HEAD"],
            "responseHeader": ["Content-Length", "Content-Type", "ETag"],
            "maxAgeSeconds": 3600,
        }
    ]


def base_url(bucket: str) -> str:
    return f"https://storage.googleapis.com/{bucket}/"


def assert_created_here(gcloud: Gcloud, url: str, project: str, current: dict[str, Any]) -> None:
    labels = current.get("labels") or {}
    if labels.get(LABEL_KEY) != LABEL_VALUE:
        raise ProvisionError(
            f"{url} exists but was not created by this script (no label {LABEL_KEY}={LABEL_VALUE}); "
            "it is never made public automatically: needs-human-decision"
        )
    project_info = gcloud.describe(["projects", "describe", project, "--format=json"])
    expected = (project_info or {}).get("projectNumber")
    if not expected or str(current.get("projectNumber", "")) != str(expected):
        raise ProvisionError(
            f"{url} is not in project {project} (bucket project number {current.get('projectNumber')!r}, "
            f"project reports {expected!r}): needs-human-decision"
        )


def provision(gcloud: Gcloud, bucket: str, project: str, report: list[str]) -> None:
    url = f"gs://{bucket}"
    try:
        committed = json.loads((ROOT / CORS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProvisionError(f"{CORS_FILE} is unreadable ({error}); restore it from git") from error
    if committed != cors_policy():
        raise ProvisionError(f"{CORS_FILE} differs from cors_policy(); fix the file, not the bucket")
    check_org_policies(gcloud, project, report)
    describe = ["storage", "buckets", "describe", url, "--raw", "--format=json"]
    current = gcloud.describe(describe)
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
        assert_created_here(gcloud, url, project, current)
    location = str(current.get("location", "")).lower()
    if location != LOCATION:
        raise ProvisionError(f"{url} is in {location or 'an unknown location'}, not {LOCATION}")
    iam = current.get("iamConfiguration", {})
    prevention = iam.get("publicAccessPrevention", "inherited")
    report.append(f"public-access prevention: {prevention}")
    if prevention == "enforced":
        raise ProvisionError(
            f"public-access prevention is enforced on {url}; this script never lifts it: needs-human-decision"
        )
    updates: list[str] = []
    if not iam.get("uniformBucketLevelAccess", {}).get("enabled"):
        updates.append("--uniform-bucket-level-access")
    if not (current.get("versioning") or {}).get("enabled"):
        updates.append("--versioning")
    if str((current.get("softDeletePolicy") or {}).get("retentionDurationSeconds")) != SOFT_DELETE_SECONDS:
        updates.append(f"--soft-delete-duration={SOFT_DELETE}")
    if updates:
        _mutate(gcloud, ["storage", "buckets", "update", url, *updates])
        report.append(f"bucket {url}: updated {' '.join(updates)}")
    policy = gcloud.describe(["storage", "buckets", "get-iam-policy", url, "--format=json"]) or {}
    public_roles = {
        binding.get("role")
        for binding in policy.get("bindings", [])
        if PUBLIC_MEMBER in binding.get("members", [])
    }
    if PUBLIC_ROLE in public_roles:
        report.append(f"IAM: {PUBLIC_MEMBER} already has {PUBLIC_ROLE}")
    else:
        _mutate(gcloud, _binding("add", url, PUBLIC_ROLE))
        report.append(f"IAM: {PUBLIC_MEMBER} granted {PUBLIC_ROLE}")
    for role in LISTING_ROLES:  # only after the reader role exists, so anonymous reads never lapse
        if role in public_roles:
            _mutate(gcloud, _binding("remove", url, role))
            report.append(f"IAM: {PUBLIC_MEMBER} removed from {role} (it allows listing)")
    if current.get("cors") == committed:
        report.append("CORS: already the committed policy")
    else:
        _mutate(gcloud, ["storage", "buckets", "update", url, f"--cors-file={CORS_FILE}"])
        report.append(f"CORS: set from {CORS_FILE}")


def _binding(verb: str, url: str, role: str) -> list[str]:
    member = f"--member={PUBLIC_MEMBER}"
    return ["storage", "buckets", f"{verb}-iam-policy-binding", url, member, f"--role={role}"]


def _mutate(gcloud: Gcloud, arguments: list[str]) -> None:
    result = gcloud.mutate(arguments)
    if result.returncode != 0:
        raise ProvisionError(f"{Gcloud.display(arguments)} failed: {result.stderr.strip()}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Provision the public data-store bucket.")
    parser.add_argument(
        "--bucket",
        help=f"must be the committed {dr.DATA_STORE_BUCKET} (the default; or ${dr.BUCKET_VARIABLE})",
    )
    parser.add_argument("--project", help="GCP project id (default: $GENOMEOS_GCP_PROJECT; never in git)")
    parser.add_argument("--dry-run", action="store_true", help="print every gcloud command and run none")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    project = args.project or os.environ.get("GENOMEOS_GCP_PROJECT")
    if not project:
        print("error: pass --project or set GENOMEOS_GCP_PROJECT; project ids are not stored in git",
              file=sys.stderr)
        return 2
    try:
        bucket = dr.resolve_bucket(args.bucket or os.environ.get(dr.BUCKET_VARIABLE))
    except dr.DataReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    report: list[str] = []
    try:
        provision(Gcloud(dry_run=args.dry_run), bucket, project, report)
    except (ProvisionError, GcloudError) as error:
        print("\n".join(report))
        print(f"error: {error}", file=sys.stderr)
        return 1
    print("\n".join(report))
    print(f"base URL: {base_url(bucket)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
