"""The budget kill switch's decision and IAM edit (data store design 2026-10-17 §9.2, #480).

deploy/budget-kill-switch/kill_switch.py has no I/O, so every case runs here without a network;
the bucket is an in-memory stand-in for its two IAM calls.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "deploy" / "budget-kill-switch"


def _load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, SOURCE / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ks = _load("kill_switch")
TARGET = "genomeos-atlas-data"
BUDGET = "example-budget-id"
ATTRIBUTES = {"schemaVersion": "1.0", "budgetId": BUDGET}
READER = {"role": "roles/storage.legacyObjectReader", "members": {"allUsers", "projectViewer:example"}}
OWNER = {"role": "roles/storage.legacyBucketOwner", "members": {"projectOwner:example"}}
KILLER = {"role": "projects/example/roles/budgetKillSwitch", "members": {"serviceAccount:k@example"}}


def event(payload: Any, *, attributes: dict[str, str] | None = None, raw: str | None = None) -> dict:
    data = raw if raw is not None else base64.b64encode(json.dumps(payload).encode()).decode()
    message = {"data": data, "attributes": dict(ATTRIBUTES) if attributes is None else attributes}
    return {"message": message, "subscription": "projects/example/subscriptions/s"}


def notification(cost: Any, budget: Any = 200, **extra: Any) -> dict:
    payload = {
        "budgetDisplayName": "example monthly",
        "costAmount": cost,
        "costIntervalStart": "2026-10-01T07:00:00Z",
        "budgetAmount": budget,
        "budgetAmountType": "SPECIFIED_AMOUNT",
        "currencyCode": "USD",
        **extra,
    }
    return event(payload)


class FakeBucket:
    def __init__(self, bindings: list[dict[str, Any]], conflicts: int = 0, fail: bool = False) -> None:
        self.bindings = [dict(binding, members=set(binding["members"])) for binding in bindings]
        self.conflicts = conflicts
        self.fail = fail
        self.reads = 0
        self.writes: list[list[dict[str, Any]]] = []

    def get_bindings(self) -> list[dict[str, Any]]:
        if self.fail:
            raise PermissionError("403 storage.buckets.getIamPolicy denied")
        self.reads += 1
        return [dict(binding) for binding in self.bindings]

    def set_bindings(self, bindings: list[dict[str, Any]]) -> None:
        if self.conflicts:
            self.conflicts -= 1
            raise ks.Conflict("412 etag mismatch")
        self.writes.append(bindings)
        self.bindings = [dict(binding, members=set(binding["members"])) for binding in bindings]


def run(
    data: Any, bucket: FakeBucket, target: str | None = TARGET, budget_id: str | None = BUDGET
) -> dict[str, Any]:
    opened: list[str] = []

    def open_bucket(name: str) -> FakeBucket:
        opened.append(name)
        return bucket

    record = ks.handle(data, open_bucket, target=target, budget_id=budget_id, event_id="e1")
    json.dumps(record)  # every record is one JSON log line
    record["opened"] = opened
    return record


def public_members(bucket: FakeBucket) -> set[str]:
    return {member for binding in bucket.bindings for member in binding["members"]} & ks.PUBLIC_MEMBERS


def test_below_the_threshold_nothing_is_read_or_written() -> None:
    bucket = FakeBucket([READER, OWNER])
    record = run(notification(299.99), bucket)
    assert record["decision"] == "below_threshold"
    assert record["severity"] == "INFO"
    assert (record["opened"], bucket.reads, bucket.writes) == ([], 0, [])


@pytest.mark.parametrize("cost", [300, 300.0, 1000])
def test_at_or_above_150_percent_every_public_member_is_removed(cost: float) -> None:
    other = {"role": "roles/storage.objectViewer", "members": {"allAuthenticatedUsers"}}
    bucket = FakeBucket([READER, OWNER, other, KILLER])
    record = run(notification(cost), bucket)
    assert record["decision"] == "made_private"
    assert record["severity"] == "ALERT"
    assert record["opened"] == [TARGET]
    assert public_members(bucket) == set()
    roles = {binding["role"]: binding["members"] for binding in bucket.bindings}
    assert roles == {
        READER["role"]: {"projectViewer:example"},
        OWNER["role"]: OWNER["members"],
        KILLER["role"]: KILLER["members"],
    }, "only public members go; a binding left empty is dropped"
    assert {(item["role"], item["member"]) for item in record["removed"]} == {
        (READER["role"], "allUsers"),
        ("roles/storage.objectViewer", "allAuthenticatedUsers"),
    }


def test_the_threshold_is_exact_decimal_arithmetic() -> None:
    """In floats 1.5 * 0.2 is 0.30000000000000004, so a cost of exactly 0.3 would not trip."""
    assert ks.parse_notification(notification(0.3, 0.2)).trips
    assert not ks.parse_notification(notification(0.29999, 0.2)).trips


def test_alert_threshold_exceeded_is_never_trusted() -> None:
    claimed = run(notification(10, alertThresholdExceeded=1.5), FakeBucket([READER]))
    assert claimed["decision"] == "below_threshold"
    assert claimed["alert_threshold_exceeded"] == "1.5"
    silent = FakeBucket([READER])
    assert run(notification(400), silent)["decision"] == "made_private"


def test_a_second_trip_changes_nothing() -> None:
    bucket = FakeBucket([READER, OWNER])
    assert run(notification(400), bucket)["decision"] == "made_private"
    again = run(notification(401), bucket)
    assert again["decision"] == "already_private"
    assert again["severity"] == "NOTICE"
    assert len(bucket.writes) == 1


def test_conditions_and_unrelated_bindings_survive() -> None:
    condition = {"title": "t", "expression": "request.time < timestamp('2030-01-01T00:00:00Z')"}
    conditional = {
        "role": "roles/storage.objectViewer",
        "members": {"allUsers", "user:x@example"},
        "condition": condition,
    }
    kept, removed = ks.strip_public([conditional, OWNER])
    assert kept == [
        {"role": "roles/storage.objectViewer", "members": ["user:x@example"], "condition": condition},
        OWNER,
    ]
    assert removed == [{"role": "roles/storage.objectViewer", "member": "allUsers"}]


def test_an_etag_conflict_is_reread_and_retried() -> None:
    bucket = FakeBucket([READER], conflicts=1)
    record = run(notification(400), bucket)
    assert record["decision"] == "made_private"
    assert bucket.reads == 2


def test_persistent_conflicts_and_io_failures_are_logged_not_raised() -> None:
    record = run(notification(400), FakeBucket([READER], conflicts=ks.CONFLICT_ATTEMPTS))
    assert (record["decision"], record["severity"]) == ("error", "ERROR")
    record = run(notification(400), FakeBucket([READER], fail=True))
    assert record["decision"] == "error"
    assert "PermissionError" in record["error"]


@pytest.mark.parametrize(
    ("target", "budget_id", "why"),
    [
        ("genomeos-atlas-web", BUDGET, "protected"),
        ("", BUDGET, "TARGET_BUCKET is not set"),
        (None, BUDGET, "TARGET_BUCKET is not set"),
        (TARGET, "", "BUDGET_ID is not set"),
        (TARGET, None, "BUDGET_ID is not set"),
    ],
)
@pytest.mark.parametrize("data", [notification(10_000), notification(10), None])
def test_a_misconfigured_switch_refuses_every_message(
    target: str | None, budget_id: str | None, why: str, data: Any
) -> None:
    """Refused below the threshold, and for junk, too: a broken deployment is loud within hours."""
    bucket = FakeBucket([{"role": "roles/storage.objectViewer", "members": {"allUsers"}}])
    record = run(data, bucket, target=target, budget_id=budget_id)
    assert (record["decision"], record["severity"]) == ("refused", "CRITICAL")
    assert why in record["message"]
    assert (record["opened"], bucket.reads, bucket.writes) == ([], 0, [])


@pytest.mark.parametrize(
    "attributes",
    [
        {"schemaVersion": "1.0", "budgetId": "another-budget"},
        {"schemaVersion": "1.0", "budgetId": ""},
        {"schemaVersion": "1.0"},
        {},
    ],
)
def test_a_message_from_another_budget_is_ignored(attributes: dict[str, str]) -> None:
    payload = {"costAmount": 10_000, "budgetAmount": 200}
    bucket = FakeBucket([READER])
    record = run(event(payload, attributes=attributes), bucket)
    assert (record["decision"], record["severity"]) == ("malformed", "WARNING")
    assert "not the configured BUDGET_ID" in record["message"]
    assert (record["opened"], bucket.reads, bucket.writes) == ([], 0, [])


def test_the_web_bucket_is_protected_by_name() -> None:
    # A rename of the web bucket must be made here too (design 2026-10-07 §C.1; data store §3 C1).
    assert ks.PROTECTED_BUCKETS == {"genomeos-atlas-web"}
    assert TARGET not in ks.PROTECTED_BUCKETS


@pytest.mark.parametrize(
    "data",
    [
        None,
        "text",
        {},
        {"message": "x"},
        {"message": {"attributes": {"schemaVersion": "1.0"}}},
        event({"costAmount": 1, "budgetAmount": 1}, raw="%%%not-base64%%%"),
        event({}, raw=base64.b64encode(b"\xff\xfe").decode()),
        event({}, raw=base64.b64encode(b"not json").decode()),
        event([1, 2]),
        event({"budgetAmount": 200}),
        event({"costAmount": 400}),
        event({"costAmount": "400", "budgetAmount": 200}),
        event({"costAmount": True, "budgetAmount": 200}),
        event({"costAmount": None, "budgetAmount": 200}),
        event({"costAmount": 400, "budgetAmount": 0}),
        event({"costAmount": 400, "budgetAmount": -5}),
        event({"costAmount": 400, "budgetAmount": 200}, attributes={"schemaVersion": "2.0"}),
    ],
)
def test_malformed_messages_are_logged_and_ignored(data: Any) -> None:
    bucket = FakeBucket([READER])
    record = run(data, bucket)
    assert (record["decision"], record["severity"]) == ("malformed", "WARNING")
    assert (record["opened"], bucket.reads, bucket.writes) == ([], 0, [])


def test_nan_and_infinity_are_malformed() -> None:
    for constant in ("NaN", "Infinity"):
        raw = base64.b64encode(f'{{"costAmount": {constant}, "budgetAmount": 200}}'.encode()).decode()
        assert run(event({}, raw=raw), FakeBucket([READER]))["decision"] == "malformed"


def test_requirements_are_pinned_exactly() -> None:
    lines = [
        line.strip()
        for line in (SOURCE / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert lines and all(re.fullmatch(r"[a-z0-9-]+==\d+(\.\d+)+", line) for line in lines), lines


def test_the_entry_point_is_the_one_provisioning_deploys() -> None:
    from scripts import provision_budget_kill_switch as provision

    assert f"def {provision.ENTRY_POINT}(" in (SOURCE / "main.py").read_text(encoding="utf-8")


def test_the_cloud_run_wrapper_round_trips_a_real_policy(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Runs only where the function's own requirements are installed (not in the repo's CI)."""
    pytest.importorskip("functions_framework")
    iam = pytest.importorskip("google.api_core.iam")
    exceptions = pytest.importorskip("google.api_core.exceptions")
    main = _load("main")

    class Bucket:
        def __init__(self) -> None:
            self.policy = iam.Policy.from_api_repr(
                {
                    "etag": "CAE=",
                    "version": 1,
                    "bindings": [
                        {"role": READER["role"], "members": sorted(READER["members"])},
                        {"role": OWNER["role"], "members": sorted(OWNER["members"])},
                    ],
                }
            )
            self.saved: list[dict[str, Any]] = []
            self.conflict = True

        def get_iam_policy(self, requested_policy_version: int) -> Any:
            assert requested_policy_version == 3
            return iam.Policy.from_api_repr(self.policy.to_api_repr())

        def set_iam_policy(self, policy: Any) -> Any:
            if self.conflict:
                self.conflict = False
                raise exceptions.PreconditionFailed("etag")
            self.saved.append(policy.to_api_repr())
            return policy

    bucket = Bucket()
    removed = ks._make_private(main.GcsBucketIam(bucket))
    assert removed == [{"role": READER["role"], "member": "allUsers"}]
    saved = bucket.saved[-1]
    assert saved["etag"] == "CAE=" and saved["version"] == 3
    assert {"role": READER["role"], "members": ["projectViewer:example"]} in saved["bindings"]

    class Event(dict):
        data = notification(10)

    monkeypatch.setenv("TARGET_BUCKET", TARGET)
    monkeypatch.setenv("BUDGET_ID", BUDGET)
    main.on_budget_notification(Event(id="e2"))
    line = json.loads(capsys.readouterr().out)
    assert (line["decision"], line["event_id"], line["budget_id"]) == ("below_threshold", "e2", BUDGET)
    monkeypatch.delenv("BUDGET_ID")
    main.on_budget_notification(Event(id="e3"))
    assert json.loads(capsys.readouterr().out)["decision"] == "refused"
