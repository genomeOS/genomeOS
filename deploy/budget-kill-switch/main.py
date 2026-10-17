"""Cloud Run function (2nd gen) for the budget kill switch (data store design 2026-10-17 §9.2).

Triggered by the budget's Pub/Sub topic through Eventarc. The decision and the IAM edit live in
``kill_switch.py``, which has no I/O; this module only reads ``TARGET_BUCKET``, talks to Cloud
Storage and prints one JSON log line per event, which Cloud Logging parses (``severity`` included).
Deployed by scripts/provision_budget_kill_switch.py; see docs/cost-controls.md.
"""

from __future__ import annotations

import json
import os
from typing import Any

import functions_framework
import kill_switch
from google.api_core import exceptions
from google.cloud import storage

_client: storage.Client | None = None


class GcsBucketIam:
    """kill_switch.BucketIam over the Cloud Storage JSON API, with the policy's etag kept."""

    def __init__(self, bucket: storage.Bucket) -> None:
        self._bucket = bucket
        self._policy: Any = None

    def get_bindings(self) -> list[dict[str, Any]]:
        # Version 3 returns conditional bindings intact, so writing the policy back never drops one.
        self._policy = self._bucket.get_iam_policy(requested_policy_version=3)
        return [dict(binding) for binding in self._policy.bindings]

    def set_bindings(self, bindings: list[dict[str, Any]]) -> None:
        self._policy.version = 3
        self._policy.bindings = bindings
        try:
            self._bucket.set_iam_policy(self._policy)  # carries the etag read above
        except (exceptions.Conflict, exceptions.PreconditionFailed) as error:
            raise kill_switch.Conflict(str(error)) from error


def _open_bucket(name: str) -> GcsBucketIam:
    global _client
    if _client is None:
        _client = storage.Client()
    return GcsBucketIam(_client.bucket(name))


@functions_framework.cloud_event
def on_budget_notification(cloud_event: Any) -> None:
    record = kill_switch.handle(
        cloud_event.data,
        os.environ.get("TARGET_BUCKET"),
        _open_bucket,
        event_id=cloud_event.get("id"),
    )
    print(json.dumps(record, sort_keys=True), flush=True)
