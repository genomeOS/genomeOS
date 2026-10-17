#!/usr/bin/env python3
"""Provision the upload-only identity that publishes data-store releases (#480; data store design
2026-10-17 §7).

    python scripts/provision_data_store_publisher.py --project <project> --account <owner> --dry-run
    python scripts/provision_data_store_publisher.py --project <project> --account <owner>

Owner decision (#480): routine uploads run as the service account ``data-store-publisher``, never as
the project owner. On the committed data-store bucket it holds ``roles/storage.objectCreator`` and the
custom role ``dataStoreLister`` (exactly ``storage.objects.list``), and nothing else there or anywhere
in the project. So it can add a new object, but it cannot overwrite one (that needs
``storage.objects.delete``), delete one, or change any setting.

The list permission is there because ``gcloud storage cp`` needs it. Before every upload to a key that
does not exist yet, cp reads the object (404) and then lists ``prefix=<key>, delimiter=/`` to check
whether the destination is a folder. Without ``storage.objects.list`` that listing fails with 403, and
so does the upload. The public grant (``legacyObjectReader``) gives ``storage.objects.get`` only, and
``publish_data_store.py``'s own metadata reads go through it.

The maintainer named by ``--account`` gets ``roles/iam.serviceAccountTokenCreator`` on that one
account, which lets them publish with ``CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT``
(docs/data-store.md). No key is ever created.

Idempotent: every step reads the current state and changes only what differs. ``--dry-run`` prints
every command and runs none. The account and project are passed at run time and never stored in git
(docs/repo-gcloud-auth.md). Every command goes through scripts/gcloud_repo.py.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from scripts import gcp_identity as iam  # noqa: E402
from scripts.atlas_web_gcloud import Gcloud, GcloudError  # noqa: E402
from scripts.provision_atlas_web_bucket import ProvisionError  # noqa: E402

SERVICE_ACCOUNT_ID = "data-store-publisher"
BUCKET_ROLE = "roles/storage.objectCreator"
LISTER_ROLE_ID = "dataStoreLister"
LISTER_TITLE = "Data store lister"
LISTER_DESCRIPTION = "List object names in a bucket, which gcloud storage cp needs to upload; nothing else"
LISTER_PERMISSIONS = ("storage.objects.list",)
IMPERSONATION_ROLE = "roles/iam.serviceAccountTokenCreator"
#: Impersonation mints short-lived tokens through the IAM Credentials API.
APIS = ("iam.googleapis.com", "iamcredentials.googleapis.com")


def principal(account: str) -> str:
    """The IAM member for a maintainer: a person, or a service account (a future CI identity)."""
    kind = "serviceAccount" if account.endswith(".gserviceaccount.com") else "user"
    return f"{kind}:{account}"


def provision(gcloud: Gcloud, bucket: str, project: str, account: str, report: list[str]) -> str:
    iam.ensure_apis(gcloud, project, APIS, report)
    email = iam.ensure_service_account(
        gcloud,
        project,
        SERVICE_ACCOUNT_ID,
        "Data store publisher",
        f"Upload-only: creates new objects in {bucket}; cannot overwrite or delete (docs/data-store.md)",
        report,
    )
    lister = iam.ensure_custom_role(
        gcloud, project, LISTER_ROLE_ID, LISTER_TITLE, LISTER_DESCRIPTION, LISTER_PERMISSIONS, report
    )
    member = f"serviceAccount:{email}"
    iam.ensure_bucket_roles(gcloud, bucket, member, (BUCKET_ROLE, lister), report)
    iam.assert_no_project_role(gcloud, project, member, report)
    iam.ensure_member(
        gcloud,
        read=["iam", "service-accounts", "get-iam-policy", email, f"--project={project}", "--format=json"],
        add=["iam", "service-accounts", "add-iam-policy-binding", email, f"--project={project}"],
        member=principal(account),
        roles=(IMPERSONATION_ROLE,),
        label=f"service account {SERVICE_ACCOUNT_ID}",
        report=report,
    )
    return email


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Provision the upload-only data-store publisher.")
    parser.add_argument(
        "--bucket",
        help=f"must be the committed {dr.DATA_STORE_BUCKET} (the default; or ${dr.BUCKET_VARIABLE})",
    )
    parser.add_argument("--project", help="GCP project id (default: $GENOMEOS_GCP_PROJECT; never in git)")
    parser.add_argument(
        "--account",
        help="who may impersonate the publisher (default: $GENOMEOS_GCP_ACCOUNT; never in git)",
    )
    parser.add_argument("--dry-run", action="store_true", help="print every gcloud command and run none")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    project = args.project or os.environ.get("GENOMEOS_GCP_PROJECT")
    account = args.account or os.environ.get("GENOMEOS_GCP_ACCOUNT")
    if not project or not account:
        print(
            "error: pass --project and --account, or set GENOMEOS_GCP_PROJECT and GENOMEOS_GCP_ACCOUNT; "
            "neither is stored in git",
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
        email = provision(Gcloud(dry_run=args.dry_run), bucket, project, account, report)
    except (ProvisionError, GcloudError) as error:
        print("\n".join(report))
        print(f"error: {error}", file=sys.stderr)
        return 1
    print("\n".join(report))
    print(f"publish with: export CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT={email}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
