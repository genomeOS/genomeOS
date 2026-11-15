"""The cost report's trigger check (Atlas data platform design 2026-10-18 §1.3, §8, builder's call 12;
step 1.14).

Pure: bytes sent per bucket and UTC day go in, one result per §1.3 trigger comes out. No network, no GCP.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

import genomeos.publication.cost_triggers as ct
from genomeos.publication.access_policy import LOOKUP_DAILY_BYTES_MAX

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "superpowers" / "specs" / "2026-10-18-atlas-data-platform-design.md"
GIB = 1 << 30
ROLES: dict[str, ct.BucketRole] = {
    "genomeos-atlas-data": "data",
    "example-lookup": "lookup",
    "example-web": "web",
}
TODAY = date(2026, 12, 3)  # the complete months are 2026-10 and 2026-11
IDLE = "no data points (idle bucket, or outside Monitoring's retention)"


def month(bucket: str, first: date, total: int) -> list[ct.BucketDay]:
    """``total`` bytes from ``bucket`` in ``first``'s month, split over its first two days."""
    half = total // 2
    return [
        ct.BucketDay(bucket, first, half),
        ct.BucketDay(bucket, first + timedelta(days=1), total - half),
    ]


def statuses(days: list[ct.BucketDay], roles: dict[str, ct.BucketRole] = ROLES) -> dict[str, str]:
    return {result.trigger.id: result.status for result in ct.evaluate(days, roles, TODAY)}


def result(
    days: list[ct.BucketDay], trigger_id: str, roles: dict[str, ct.BucketRole] = ROLES
) -> ct.TriggerResult:
    return next(r for r in ct.evaluate(days, roles, TODAY) if r.trigger.id == trigger_id)


def two_months(bucket: str, october: int, november: int) -> list[ct.BucketDay]:
    return month(bucket, date(2026, 10, 1), october) + month(bucket, date(2026, 11, 1), november)


def test_egress_price() -> None:
    assert ct.egress_usd(GIB) == Decimal("0.12")
    assert ct.egress_usd(417 * GIB) == Decimal("50.04")
    assert ct.egress_usd(0) == Decimal("0")


def test_complete_months() -> None:
    assert ct.complete_months(date(2026, 12, 3)) == ("2026-10", "2026-11")
    assert ct.complete_months(date(2026, 1, 15)) == ("2025-11", "2025-12")
    assert ct.complete_months(date(2026, 3, 1), count=1) == ("2026-02",)
    assert ct.window_start(date(2026, 12, 3)) == date(2026, 10, 1)
    assert ct.window_start(date(2026, 1, 15)) == date(2025, 11, 1)


def test_the_50_dollar_triggers() -> None:
    fired = statuses(two_months("genomeos-atlas-data", 417 * GIB, 417 * GIB))
    assert (fired["D3-egress"], fired["D12-egress"], fired["D11-web"]) == ("fired", "fired", "not_fired")
    # $49.92 in November: strictly over $50 in both months is required.
    short = statuses(two_months("genomeos-atlas-data", 417 * GIB, 416 * GIB))
    assert (short["D3-egress"], short["D12-egress"]) == ("not_fired", "not_fired")
    assert (
        "2026-11: $49.92 (416.00 GiB)"
        in result(two_months("genomeos-atlas-data", 417 * GIB, 416 * GIB), "D3-egress").evidence.splitlines()
    )
    # Free egress is data plus lookup.
    added = two_months("genomeos-atlas-data", 200 * GIB, 200 * GIB) + two_months(
        "example-lookup", 217 * GIB, 217 * GIB
    )
    assert (statuses(added)["D3-egress"], statuses(added)["D12-egress"]) == ("fired", "fired")
    # Web egress fires D11 only.
    web = statuses(two_months("example-web", 417 * GIB, 417 * GIB))
    assert {key for key, value in web.items() if value == "fired"} == {"D11-web"}
    # Any other bucket is reported, never counted.
    other = statuses(two_months("example-other", 10_000 * GIB, 10_000 * GIB))
    assert "fired" not in other.values()


def test_the_brake() -> None:
    day = date(2026, 11, 7)
    tripped = result([ct.BucketDay("example-lookup", day, 20 * GIB)], "D3-brake")
    assert LOOKUP_DAILY_BYTES_MAX == 20 * GIB
    assert tripped.status == "fired"
    assert tripped.evidence.splitlines()[0] == (
        "a lookup bucket sent 20 GiB or more in one UTC day, first on 2026-11-07"
    )
    assert result([ct.BucketDay("example-lookup", day, 20 * GIB - 1)], "D3-brake").status == "not_fired"
    # The brake is per bucket and day: 20 GiB from the data bucket is not a trip.
    assert result([ct.BucketDay("genomeos-atlas-data", day, 20 * GIB)], "D3-brake").status == "not_fired"
    no_lookup = {name: role for name, role in ROLES.items() if role != "lookup"}
    unmeasured = result([ct.BucketDay("example-lookup", day, 20 * GIB)], "D3-brake", no_lookup)
    assert unmeasured.status == "not_measurable"


def test_an_idle_month_is_named() -> None:
    days = month("genomeos-atlas-data", date(2026, 11, 1), 417 * GIB)
    evidence = result(days, "D3-egress").evidence.splitlines()
    assert f"2026-10: {IDLE}" in evidence
    assert "2026-11: $50.04 (417.00 GiB)" in evidence
    assert result(days, "D3-egress").status == "not_fired"
    assert f"2026-10: {IDLE}" in result([], "D11-web").evidence.splitlines()


def test_days_outside_the_window_or_repeated_are_refused() -> None:
    with pytest.raises(ValueError, match="outside"):
        ct.evaluate([ct.BucketDay("genomeos-atlas-data", date(2026, 9, 30), 1)], ROLES, TODAY)
    with pytest.raises(ValueError, match="outside"):
        ct.evaluate([ct.BucketDay("genomeos-atlas-data", TODAY, 1)], ROLES, TODAY)
    twice = [ct.BucketDay("genomeos-atlas-data", date(2026, 10, 2), 1)] * 2
    with pytest.raises(ValueError, match="twice"):
        ct.evaluate(twice, ROLES, TODAY)
    with pytest.raises(ValueError, match="sent_bytes"):
        ct.BucketDay("genomeos-atlas-data", date(2026, 10, 2), -1)
    with pytest.raises(ValueError, match="role"):
        ct.evaluate([], {"genomeos-atlas-data": "bulk"}, TODAY)  # type: ignore[dict-item]


def _rows(lines: list[str], first: str) -> dict[str, list[str]]:
    """Markdown table rows whose first cell starts with ``first``, keyed by that cell."""
    rows: dict[str, list[str]] = {}
    for line in lines:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if line.startswith("| ") and cells[0].startswith(first):
            rows[cells[0]] = cells
    return rows


def _section(text: str, start: str, end: str) -> list[str]:
    return text.split(start, 1)[1].split(end, 1)[0].splitlines()


def _decisions(cell: str) -> list[str]:
    """``D6b, D8a–D8e, D9`` as ``[D6b, D8a, D8b, D8c, D8d, D8e, D9]``."""
    found: list[str] = []
    for item in cell.split(", "):
        span = re.fullmatch(r"(D\d+)([a-z])–\1([a-z])", item)
        if span:
            found += [f"{span[1]}{chr(c)}" for c in range(ord(span[2]), ord(span[3]) + 1)]
        else:
            found.append(item)
    return found


def test_every_decision_and_phase_3_step_has_a_trigger() -> None:
    spec = SPEC.read_text(encoding="utf-8")
    later = _rows(_section(spec, "### 1.3 Later, each on its trigger", "### 1.4"), "D")
    # §1.3's columns: #, Question, We recommend, What changes, Trigger. D3b is superseded (trigger "—").
    live = {key: cells for key, cells in later.items() if cells[4] != "—"}
    decisions = {decision for key in live for decision in _decisions(key)}
    assert len(decisions) == 20
    assert {d for trigger in ct.TRIGGERS for d in trigger.decisions} == decisions
    assert {s for trigger in ct.TRIGGERS for s in trigger.steps} >= {f"3.{n}" for n in range(1, 9)}
    assert len({trigger.id for trigger in ct.TRIGGERS}) == len(ct.TRIGGERS)
    for trigger in ct.TRIGGERS:
        if trigger.decisions:
            (cells,) = [cells for key, cells in live.items() if _decisions(key)[0] == trigger.decisions[0]]
            assert (trigger.recommendation, trigger.spec_trigger) == (cells[2], cells[4]), trigger.id
        else:  # step 3.2 has no §1.3 row: its text is §11's (PR; Blocked by; trigger).
            (cells,) = _rows(_section(spec, "**Phase 3: on triggers", "**Phase 4"), trigger.steps[0]).values()
            assert (trigger.recommendation, trigger.spec_trigger) == (cells[1], cells[2]), trigger.id
        assert trigger.measure in {ct.FREE_EGRESS, ct.WEB_EGRESS, ct.LOOKUP_DAY, ct.BY_HAND}
        assert trigger.terms
    d3 = next(trigger for trigger in ct.TRIGGERS if trigger.id == "D3-egress")
    assert d3.spec_trigger == (
        "Data egress over $50 a month for two months (cost report, 1.14), or the brake's first trip"
    )
    by_hand = statuses([])
    assert by_hand["D12-guard"] == by_hand["D7"] == by_hand["3.2"] == "by_hand"


def test_the_issue_for_a_fired_trigger() -> None:
    fired = result(two_months("genomeos-atlas-data", 417 * GIB, 417 * GIB), "D3-egress")
    title, body = ct.issue_for(fired)
    assert title == "Cost trigger D3-egress fired: free data egress over $50 in 2026-10 and 2026-11"
    assert "$50.04" in body
    assert "needs-human-decision" in body
    assert fired.trigger.spec_trigger in body and fired.trigger.recommendation in body
    assert "example-project" not in body
    with pytest.raises(ValueError, match="only a fired trigger"):
        ct.issue_for(result([], "D3-egress"))
