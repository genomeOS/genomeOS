"""Budget kill switch: decide from one budget notification whether to make a bucket private
(data store design 2026-10-17 §9.2; docs/cost-controls.md).

Owner decision (#480): when this month's spend reaches 150% of the project budget, the public
data-store bucket loses public access until the owner turns it back on. The Atlas web-data bucket
keeps serving and is never touched.

Pure: no network and no Google client imports, so tests/test_budget_kill_switch.py runs it
directly. ``main.py`` is the thin Cloud Run function around it, and the only module that does I/O.

- The decision reads ``costAmount`` and ``budgetAmount`` from the message itself, as exact decimals.
  ``alertThresholdExceeded`` is logged but never trusted: it reports the highest threshold rule
  crossed, and it is absent when no rule fits the spend.
- Tripping removes every ``allUsers`` and ``allAuthenticatedUsers`` member from every binding of
  the bucket's IAM policy, keeps every other member and condition, and drops bindings left empty.
  Objects are never read, changed or deleted.
- Idempotent: a bucket with no public member is left alone. Budget notifications arrive several
  times a day, so a transient failure is retried by the next notification.
- Acts only on its own budget's messages: the ``budgetId`` attribute Cloud Billing sets on every
  notification must equal ``BUDGET_ID``, which provisioning sets at deploy time (never committed).
  This screens out stray messages (a drill, a second budget attached to the topic). It is not
  authentication: anyone who can publish to the topic and read the function's settings can copy the
  id. A forged message can only make the bucket private, never public.
- A misconfigured deployment (no ``TARGET_BUCKET``, the web bucket, no ``BUDGET_ID``) is refused on
  every message, below the threshold too, so a broken switch shows up in the logs within hours
  instead of on the day it is needed.
- Never raises. A malformed message, a refused target or a failed IAM call is logged and the
  event is acknowledged, so a poison message cannot crash-loop the function.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

#: Trip at ``costAmount >= KILL_RATIO * budgetAmount`` (owner decision, #480). Not configurable.
KILL_RATIO = Decimal("1.5")
PUBLIC_MEMBERS = frozenset({"allUsers", "allAuthenticatedUsers"})
#: Never acted on, whatever the deployment's TARGET_BUCKET says: the Atlas web-data bucket.
PROTECTED_BUCKETS = frozenset({"genomeos-atlas-web"})
SCHEMA_VERSION = "1.0"
CONFLICT_ATTEMPTS = 3


class MalformedMessage(ValueError):
    """The event is not a schema 1.0 budget notification with usable amounts."""


class Conflict(RuntimeError):
    """The IAM policy changed between read and write (an etag mismatch); read it again."""


class BucketIam(Protocol):
    """The two IAM calls the switch makes. ``set_bindings`` writes against the policy last read."""

    def get_bindings(self) -> list[dict[str, Any]]: ...

    def set_bindings(self, bindings: list[dict[str, Any]]) -> None: ...


@dataclass(frozen=True)
class Notification:
    cost: Decimal
    budget: Decimal
    budget_id: str | None
    currency: str | None
    budget_name: str | None
    interval_start: str | None
    alert_threshold: str | None

    @property
    def trips(self) -> bool:
        return self.cost >= KILL_RATIO * self.budget


def parse_notification(event_data: Any) -> Notification:
    """The amounts from a Pub/Sub CloudEvent's data: ``{"message": {"data": <base64 JSON>, ...}}``."""
    if not isinstance(event_data, Mapping):
        raise MalformedMessage("event data is not an object")
    message = event_data.get("message")
    if not isinstance(message, Mapping):
        raise MalformedMessage("event data has no Pub/Sub message")
    attributes = message.get("attributes") or {}
    if not isinstance(attributes, Mapping):
        raise MalformedMessage("message attributes are not an object")
    version = attributes.get("schemaVersion")
    if version is not None and version != SCHEMA_VERSION:
        raise MalformedMessage(f"schemaVersion {version!r} is not {SCHEMA_VERSION}")
    budget_id = attributes.get("budgetId")
    data = message.get("data")
    if not isinstance(data, str) or not data:
        raise MalformedMessage("message has no data")
    try:
        text = base64.b64decode(data, validate=True).decode("utf-8")
        payload = json.loads(text, parse_float=Decimal, parse_int=Decimal)
    except (binascii.Error, UnicodeDecodeError, ValueError) as error:
        raise MalformedMessage(f"message data is not base64 JSON ({error})") from error
    if not isinstance(payload, Mapping):
        raise MalformedMessage("message data is not a JSON object")
    cost = _amount(payload, "costAmount")
    budget = _amount(payload, "budgetAmount")
    if budget <= 0:
        raise MalformedMessage(f"budgetAmount {budget} is not positive")
    return Notification(
        cost=cost,
        budget=budget,
        budget_id=budget_id if isinstance(budget_id, str) and budget_id else None,
        currency=_text(payload, "currencyCode"),
        budget_name=_text(payload, "budgetDisplayName"),
        interval_start=_text(payload, "costIntervalStart"),
        alert_threshold=None
        if payload.get("alertThresholdExceeded") is None
        else str(payload["alertThresholdExceeded"]),
    )


def _amount(payload: Mapping[str, Any], key: str) -> Decimal:
    value = payload.get(key)
    # json.loads with parse_float/parse_int=Decimal makes every JSON number a Decimal; booleans,
    # strings, null and NaN/Infinity (parse_constant) all arrive as something else.
    if not isinstance(value, Decimal) or not value.is_finite():
        raise MalformedMessage(f"{key} is {value!r}, not a finite number")
    return value


def _text(payload: Mapping[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) else None


def check_target(bucket: str | None) -> str:
    if not bucket:
        raise ValueError("TARGET_BUCKET is not set")
    if bucket in PROTECTED_BUCKETS:
        raise ValueError(f"{bucket} is protected: the kill switch never changes it")
    return bucket


def check_budget_id(budget_id: str | None) -> str:
    if not budget_id:
        raise ValueError("BUDGET_ID is not set")
    return budget_id


def strip_public(
    bindings: Iterable[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """``bindings`` less every public member, and the (role, member) pairs removed."""
    kept: list[dict[str, Any]] = []
    removed: list[dict[str, str]] = []
    for binding in bindings:
        members = sorted(binding.get("members") or [])
        public = [member for member in members if member in PUBLIC_MEMBERS]
        removed.extend({"role": str(binding.get("role")), "member": member} for member in public)
        if not public:
            kept.append(dict(binding))
            continue
        rest = [member for member in members if member not in PUBLIC_MEMBERS]
        if rest:
            kept.append({**binding, "members": rest})
    return kept, removed


def handle(
    event_data: Any,
    open_bucket: Callable[[str], BucketIam],
    *,
    target: str | None,
    budget_id: str | None,
    event_id: str | None = None,
) -> dict[str, Any]:
    """Act on one notification; the structured log record of what happened. Never raises."""
    record: dict[str, Any] = {"event_id": event_id, "bucket": target, "kill_ratio": str(KILL_RATIO)}
    try:
        bucket = check_target(target)
        expected = check_budget_id(budget_id)
    except ValueError as error:
        return _done(record, "CRITICAL", "refused", f"misconfigured, so no message is acted on: {error}")
    try:
        notification = parse_notification(event_data)
    except MalformedMessage as error:
        return _done(record, "WARNING", "malformed", f"ignored a malformed budget message: {error}")
    record.update(
        cost_amount=str(notification.cost),
        budget_amount=str(notification.budget),
        budget_id=notification.budget_id,
        currency=notification.currency,
        budget_display_name=notification.budget_name,
        cost_interval_start=notification.interval_start,
        alert_threshold_exceeded=notification.alert_threshold,
    )
    if notification.budget_id != expected:
        return _done(
            record,
            "WARNING",
            "malformed",
            f"ignored a message from budget {notification.budget_id!r}, not the configured BUDGET_ID",
        )
    if not notification.trips:
        return _done(record, "INFO", "below_threshold", "spend is below the kill threshold")
    tripped = "spend reached the kill threshold"
    try:
        removed = _make_private(open_bucket(bucket))
    except Exception as error:  # logged and acknowledged; the next notification retries
        record["error"] = f"{type(error).__name__}: {error}"
        return _done(record, "ERROR", "error", f"{tripped}; making {bucket} private failed")
    if not removed:
        return _done(record, "NOTICE", "already_private", f"{tripped}; {bucket} has no public member")
    record["removed"] = removed
    return _done(record, "ALERT", "made_private", f"{tripped}; removed public access to {bucket}")


def _make_private(iam: BucketIam) -> list[dict[str, str]]:
    for attempt in range(1, CONFLICT_ATTEMPTS + 1):
        kept, removed = strip_public(iam.get_bindings())
        if not removed:
            return []
        try:
            iam.set_bindings(kept)
        except Conflict:
            if attempt == CONFLICT_ATTEMPTS:
                raise
            continue
        return removed
    raise AssertionError("unreachable")


def _done(record: dict[str, Any], severity: str, decision: str, message: str) -> dict[str, Any]:
    return {"severity": severity, "message": message, "decision": decision, **record}
