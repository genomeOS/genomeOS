"""The cost report's triggers: §1.3's later decisions, each stated in the report's terms (Atlas data
platform design 2026-10-18 §1.3, §8, builder's call 12; step 1.14).

scripts/cost_report.py reads the bytes each bucket sent per UTC day from Cloud Monitoring and hands them
here. This module prices them and checks every §1.3 trigger:

- **Free egress** is what the data and lookup buckets send; **web egress** is what the web bucket sends.
  Any other bucket is reported by the script and never counted here. D3's "data egress" and D12's "free
  egress" are both measured as data plus lookup (plan flag F7).
- Bytes are priced at ``EGRESS_USD_PER_GIB``, the list price before the free tier (§8), per month and to
  the cent, so the report can overstate the bill but never understates it.
- A two-month trigger fires only when the cost is strictly over ``MONTHLY_TRIGGER_USD`` in each of the
  ``TRIGGER_MONTHS`` last complete UTC months. A month with no data point is named as such: the buckets
  were idle, or the month is past Monitoring's retention. Either way it cannot fire.
- The brake (D16) fires at ``LOOKUP_DAILY_BYTES_MAX`` or more from a lookup bucket in one UTC day. With
  no lookup bucket it is ``not_measurable``.
- Every other trigger is an event or a decision that no byte count shows, so it is ``by_hand``.

Days outside the report's window, or one bucket's day given twice, are hard errors, never dropped.
Pure: no I/O and no clock; the caller passes ``today``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, get_args

from genomeos.publication.access_policy import EGRESS_USD_PER_GIB, LOOKUP_DAILY_BYTES_MAX

BucketRole = Literal["data", "lookup", "web", "other"]
Status = Literal["fired", "not_fired", "not_measurable", "by_hand"]

GIB = 1 << 30
#: §1.3: D3, D11 and D12 fire past $50 a month for two months.
MONTHLY_TRIGGER_USD = Decimal("50")
TRIGGER_MONTHS = 2
#: The budget kill switch: 150% of the $200 monthly budget (docs/cost-controls.md, #480).
KILL_SWITCH_USD = Decimal("300")
NO_DATA_POINTS = "no data points (idle bucket, or outside Monitoring's retention)"

#: Trigger.measure values: how the report measures a trigger.
FREE_EGRESS = "free egress, two months"
WEB_EGRESS = "web egress, two months"
LOOKUP_DAY = "lookup bytes per day"
BY_HAND = "by hand"
_COUNTED: dict[str, frozenset[str]] = {
    FREE_EGRESS: frozenset({"data", "lookup"}),
    WEB_EGRESS: frozenset({"web"}),
}
_LABEL = {FREE_EGRESS: "free data egress", WEB_EGRESS: "web egress"}
_CENT = Decimal("0.01")


@dataclass(frozen=True)
class BucketDay:
    """The bytes one bucket sent in one UTC day."""

    bucket: str
    day: date
    sent_bytes: int

    def __post_init__(self) -> None:
        if not isinstance(self.sent_bytes, int) or isinstance(self.sent_bytes, bool) or self.sent_bytes < 0:
            raise ValueError(f"{self.bucket} {self.day}: sent_bytes {self.sent_bytes!r} is not a count")


@dataclass(frozen=True)
class Trigger:
    """One §1.3 trigger. ``spec_trigger`` and ``recommendation`` are the design's words, verbatim; ``terms``
    restates the trigger in what this report measures (builder's call 12)."""

    id: str
    decisions: tuple[str, ...]
    steps: tuple[str, ...]
    spec_trigger: str
    terms: str
    recommendation: str
    measure: str


@dataclass(frozen=True)
class TriggerResult:
    """``evidence`` is a headline line, then one line per measured month or day."""

    trigger: Trigger
    status: Status
    evidence: str


_OVER = f"over ${MONTHLY_TRIGGER_USD} in each of the last {TRIGGER_MONTHS} complete UTC months"
_FREE = f"the bytes the data and lookup buckets sent, at ${EGRESS_USD_PER_GIB}/GiB, {_OVER}"
_WEB = f"the bytes the web bucket sent, at ${EGRESS_USD_PER_GIB}/GiB, {_OVER}"
_D3 = (
    "Yes, when triggered. Not a precondition now: lookups cost about $0.02 per 1,000, and whole lookup "
    "sets are not free downloads (D1c)"
)
_D3_TRIGGER = "Data egress over $50 a month for two months (cost report, 1.14), or the brake's first trip"
_D12_TRIGGER = "Free egress over $50 a month for two months, or a guard-raising PR"

TRIGGERS: tuple[Trigger, ...] = (
    Trigger("D3-egress", ("D3",), ("3.8",), _D3_TRIGGER, _FREE, _D3, FREE_EGRESS),
    Trigger(
        "D3-brake",
        ("D3",),
        ("3.8",),
        _D3_TRIGGER,
        f"a lookup bucket sent {LOOKUP_DAILY_BYTES_MAX // GIB} GiB or more in one UTC day (D16's brake)",
        _D3,
        LOOKUP_DAY,
    ),
    Trigger("D12-egress", ("D12a", "D12b"), ("3.4",), _D12_TRIGGER, _FREE, "When triggered", FREE_EGRESS),
    Trigger(
        "D12-guard",
        ("D12a", "D12b"),
        ("3.4",),
        _D12_TRIGGER,
        "a PR that raises the release guard (OPEN_RELEASE_GCS_MAX_BYTES, 2 GiB, in "
        "genomeos/publication/access_policy.py)",
        "When triggered",
        BY_HAND,
    ),
    Trigger(
        "D11-web",
        ("D11",),
        ("3.5",),
        "Cost report",
        _WEB,
        "Accept it now; past $50 a month for two months, move web data to Cloudflare R2 with a custom domain",
        WEB_EGRESS,
    ),
    Trigger(
        "D2a",
        ("D2a", "D2c", "D6a"),
        ("3.1",),
        "An issue with a genome-wide use case",
        "an issue states a genome-wide use case; D2c and D6a are decided with 3.1 (D2c also with a "
        "non-chargeable set for 3.2)",
        "Only if a genome-wide use case appears; anonymous lookups stay the main path",
        BY_HAND,
    ),
    Trigger(
        "3.2",
        (),
        ("3.2",),
        "the first bulk request, or the first `at_cost` or R6 object",
        "a bulk download is requested, or an `at_cost` or R6 object is first scheduled (§11; no §1.3 row)",
        "Bulk bucket: `provision_bulk_bucket.py` (owner step); server-side copies of chargeable lookup "
        "sets; `publish_data_store.py` routes by `hosts`",
        BY_HAND,
    ),
    Trigger(
        "D7",
        ("D7",),
        ("3.3",),
        "After 2.4 and 3.8",
        "steps 2.4 and 3.8 have both shipped",
        "Private, until step 2.4 exists and a mirror holds every non-chargeable file",
        BY_HAND,
    ),
    Trigger(
        "D13",
        ("D13",),
        ("3.7",),
        "When P3's burden draws ship",
        "P3's burden draws are ready to publish",
        "Yes, under `store/draws/`: each artifact's draws file (150–311 MB) stays a free whole-file "
        "download under R3's proviso; the whole set is bulk. Until you answer, `store/draws/` is not a "
        "lookup set and nothing is published there",
        BY_HAND,
    ),
    Trigger(
        "D14",
        ("D14", "D10"),
        ("3.6",),
        "Second whole-genome ingest; 3.6",
        "a second whole-genome ingest is planned, or step 3.6 starts; D10 is decided before 3.6",
        "Past about 2 MB",
        BY_HAND,
    ),
    Trigger(
        "D2b",
        ("D2b", "D15"),
        (),
        "Confirm only",
        "the owner confirms; nothing to measure",
        "Yes; confirm",
        BY_HAND,
    ),
    Trigger(
        "D6b",
        ("D6b", "D8a", "D8b", "D8c", "D8d", "D8e", "D9"),
        ("4.1", "4.2", "4.3", "4.4", "4.5"),
        "First scheduled `at_cost` object",
        "an `at_cost` object is first scheduled",
        "Yes; when scheduled; an entity that passes seller review; Paddle; yes; on payment; yes",
        BY_HAND,
    ),
)


def egress_usd(sent_bytes: int) -> Decimal:
    """List-price internet egress for ``sent_bytes``, to the cent (§8)."""
    if sent_bytes < 0:
        raise ValueError(f"sent_bytes {sent_bytes} is negative")
    return (Decimal(sent_bytes) / GIB * EGRESS_USD_PER_GIB).quantize(_CENT, rounding=ROUND_HALF_UP)


def gib(sent_bytes: int) -> str:
    """``sent_bytes`` in GiB, to two places."""
    return f"{Decimal(sent_bytes) / GIB:.2f}"


def month_of(day: date) -> str:
    return f"{day:%Y-%m}"


def complete_months(today: date, count: int = TRIGGER_MONTHS) -> tuple[str, ...]:
    """The ``count`` complete UTC months before ``today``'s, oldest first, as ``YYYY-MM``."""
    if count < 1:
        raise ValueError(f"count {count} is not positive")
    months: list[str] = []
    first = today.replace(day=1)
    for _ in range(count):
        first = (first - timedelta(days=1)).replace(day=1)
        months.append(month_of(first))
    return tuple(reversed(months))


def window_start(today: date) -> date:
    """The first day the report reads: the first of the oldest complete month."""
    year, month = complete_months(today)[0].split("-")
    return date(int(year), int(month), 1)


def _check(days: Sequence[BucketDay], roles: Mapping[str, BucketRole], today: date) -> None:
    for bucket, role in roles.items():
        if role not in get_args(BucketRole):
            raise ValueError(f"{bucket}: role {role!r} is not one of {get_args(BucketRole)}")
    start = window_start(today)
    seen: set[tuple[str, date]] = set()
    for day in days:
        if not start <= day.day < today:
            raise ValueError(
                f"{day.bucket} {day.day}: outside the report's window {start} to {today - timedelta(days=1)}"
            )
        if (day.bucket, day.day) in seen:
            raise ValueError(f"{day.bucket} {day.day}: given twice; each bucket's day is counted once")
        seen.add((day.bucket, day.day))


def _two_months(
    trigger: Trigger, days: Sequence[BucketDay], roles: Mapping[str, BucketRole], months: tuple[str, ...]
) -> TriggerResult:
    counted = _COUNTED[trigger.measure]
    lines: list[str] = []
    over = True
    for month in months:
        found = [d for d in days if roles.get(d.bucket, "other") in counted and month_of(d.day) == month]
        if not found:
            lines.append(f"{month}: {NO_DATA_POINTS}")
            over = False
            continue
        total = sum(d.sent_bytes for d in found)
        usd = egress_usd(total)
        lines.append(f"{month}: ${usd} ({gib(total)} GiB)")
        over = over and usd > MONTHLY_TRIGGER_USD
    span = " and ".join(months)
    label = _LABEL[trigger.measure]
    if over:
        headline = f"{label} over ${MONTHLY_TRIGGER_USD} in {span}"
    else:
        headline = f"{label} at or under ${MONTHLY_TRIGGER_USD} in at least one of {span}"
    return TriggerResult(trigger, "fired" if over else "not_fired", "\n".join([headline, *lines]))


def _brake(
    trigger: Trigger, days: Sequence[BucketDay], roles: Mapping[str, BucketRole], today: date
) -> TriggerResult:
    if "lookup" not in roles.values():
        return TriggerResult(
            trigger, "not_measurable", "no lookup bucket to measure: it comes with step 2.5 (D16)"
        )
    cap = f"{LOOKUP_DAILY_BYTES_MAX // GIB} GiB"
    lookup = [d for d in days if roles.get(d.bucket) == "lookup"]
    trips = sorted((d for d in lookup if d.sent_bytes >= LOOKUP_DAILY_BYTES_MAX), key=lambda d: d.day)
    if trips:
        headline = f"a lookup bucket sent {cap} or more in one UTC day, first on {trips[0].day}"
        lines = [f"{d.day}: {gib(d.sent_bytes)} GiB" for d in trips]
        return TriggerResult(trigger, "fired", "\n".join([headline, *lines]))
    span = f"{window_start(today)} to {today - timedelta(days=1)}"
    if lookup:
        peak = max(lookup, key=lambda d: (d.sent_bytes, d.day))
        line = f"peak {peak.day}: {gib(peak.sent_bytes)} GiB"
    else:
        line = f"{span}: {NO_DATA_POINTS}"
    return TriggerResult(trigger, "not_fired", f"the lookup bucket stayed under {cap} a day, {span}\n{line}")


def evaluate(
    days: Sequence[BucketDay], roles: Mapping[str, BucketRole], today: date
) -> tuple[TriggerResult, ...]:
    """One result per ``TRIGGERS`` entry, in order. ``roles`` names each known bucket's role; any other
    bucket is ``other``. ``days`` must lie in ``window_start(today)`` up to, not including, ``today``."""
    _check(days, roles, today)
    months = complete_months(today)
    results: list[TriggerResult] = []
    for trigger in TRIGGERS:
        if trigger.measure in _COUNTED:
            results.append(_two_months(trigger, days, roles, months))
        elif trigger.measure == LOOKUP_DAY:
            results.append(_brake(trigger, days, roles, today))
        else:
            evidence = f"not measured from bytes sent; check by hand: {trigger.terms}"
            results.append(TriggerResult(trigger, "by_hand", evidence))
    return tuple(results)


def issue_for(result: TriggerResult) -> tuple[str, str]:
    """The title and body of the ``needs-human-decision`` issue for a fired trigger. The body names
    roles, never a project id or a bucket the repository does not commit."""
    if result.status != "fired":
        raise ValueError(f"{result.trigger.id} is {result.status}: only a fired trigger gets an issue")
    trigger = result.trigger
    headline, *measured = result.evidence.splitlines()
    title = f"Cost trigger {trigger.id} fired: {headline}"
    body = [
        "The monthly cost report (`scripts/cost_report.py`, step 1.14) found that this trigger fired. "
        "What to do is the owner's decision (`needs-human-decision`).",
        "",
        "| | |",
        "|---|---|",
        f"| Trigger, in the design's words | {trigger.spec_trigger} |",
        f"| In the report's terms | {trigger.terms} |",
        f"| Decisions | {', '.join(trigger.decisions) or '—'} |",
        f"| Steps | {', '.join(trigger.steps) or '—'} |",
        f"| We recommend | {trigger.recommendation} |",
        "",
        "Measured:",
        "",
        *(f"- {line}" for line in measured),
        "",
        f"Bytes sent come from Cloud Monitoring, priced at the list rate of ${EGRESS_USD_PER_GIB} per GiB "
        "before the free tier, so they can overstate the bill; the billing export is the cross-check "
        '(`docs/cost-controls.md`, "Monthly cost report"; Atlas data platform design 2026-10-18 §1.3, §8).',
    ]
    return title, "\n".join(body)
