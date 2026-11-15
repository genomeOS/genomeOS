#!/usr/bin/env python3
"""The read-only monthly cost report, checked against the platform's triggers (Atlas data platform
design 2026-10-18 §1.3, §8, builder's call 12; step 1.14).

    python scripts/cost_report.py --dry-run       # print the reads it would make; make none
    python scripts/cost_report.py                 # read and report; exit 3 if a trigger fired
    python scripts/cost_report.py --open-issue    # also open one issue per fired trigger

It reads one metric: Cloud Storage's bytes sent (``SENT_BYTES_METRIC``, [gcs-metrics]:
https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z), for every bucket in the project, summed
per bucket and UTC day by the Monitoring API's ``projects.timeSeries.list``, read with GETs only. The
window is the last two complete UTC months and this month up to yesterday. Reading needs
``roles/monitoring.viewer`` on the project. The token comes from ``gcloud auth print-access-token``
through scripts/gcloud_repo.py (the repository-local login); it goes only into the ``Authorization``
header, never onto a redirect, and is never printed.

Roles: the committed data-store bucket is ``data``; ``--web-bucket`` (or ``$ATLAS_DATA_BUCKET``) is
``web``; ``--lookup-bucket`` is ``lookup`` once step 2.5 creates it. Any other bucket is ``other``:
reported, never counted. genomeos/publication/cost_triggers.py prices the bytes and checks each trigger.

It writes nothing, except that ``--open-issue`` opens one ``needs-human-decision`` issue per fired
trigger with ``gh`` (or ``$GENOMEOS_GH_EXECUTABLE``), skipping any title an issue already has, open or
closed. Each fired title names its months, so a rerun in the same month opens nothing new.

Exit codes: 0, no trigger fired; 3 (``EXIT_FIRED``), at least one fired; 1, a read failed or returned
data the report cannot account for (hard errors, never skipped); 2, a required setting is missing.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import genomeos.publication.cost_triggers as ct  # noqa: E402
from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.publication.access_policy import EGRESS_USD_PER_GIB  # noqa: E402
from genomeos.publication.web_layout import WebLayoutError, assert_bucket_name  # noqa: E402

#: Cloud Storage's Monitoring metric for bytes sent ([gcs-metrics]): a metric type, not a URL.
SENT_BYTES_METRIC = "storage.googleapis.com/network/sent_bytes_count"
MONITORING_ROOT = "https://monitoring.googleapis.com/v3"
GCLOUD = ROOT / "scripts" / "gcloud_repo.py"
TOKEN_COMMAND = ("auth", "print-access-token")
_TOKEN_SHOWN = "python scripts/gcloud_repo.py run " + " ".join(TOKEN_COMMAND)
GITHUB_REPO = "genomeOS/genomeOS"
#: needs-human-decision, plus one label from each board family (docs/board-conventions.md).
ISSUE_LABELS = (
    "needs-human-decision",
    "type:governance",
    "P1:observations",
    "skill:governance",
    "priority:high",
)
EXIT_FIRED = 3
TIMEOUT_S = 60
_ROLE_ORDER = {"data": 0, "lookup": 1, "web": 2, "other": 3}
_OPENER = urllib.request.build_opener()


class CostReportError(RuntimeError):
    """A read failed, or returned data the report cannot account for."""


def _rfc3339(moment: datetime) -> str:
    if moment.tzinfo is None:
        raise CostReportError(f"{moment} has no time zone; the report reads UTC days")
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def time_series_url(project: str, start: datetime, end: datetime, page_token: str | None = None) -> str:
    """One page of bytes sent per bucket and UTC day: aligned to 86,400 s, summed within each series
    and across the method and response-code labels, grouped by bucket."""
    query = [
        ("filter", f'metric.type = "{SENT_BYTES_METRIC}" AND resource.type = "gcs_bucket"'),
        ("interval.startTime", _rfc3339(start)),
        ("interval.endTime", _rfc3339(end)),
        ("aggregation.alignmentPeriod", "86400s"),
        ("aggregation.perSeriesAligner", "ALIGN_SUM"),
        ("aggregation.crossSeriesReducer", "REDUCE_SUM"),
        ("aggregation.groupByFields", "resource.label.bucket_name"),
    ]
    if page_token:
        query.append(("pageToken", page_token))
    encoded = urlencode(query, quote_via=quote)  # spaces as %20, not the form encoding's "+"
    return f"{MONITORING_ROOT}/projects/{quote(project, safe='')}/timeSeries?{encoded}"


def _bucket_of(series: Any, where: str) -> str:
    resource = series.get("resource") if isinstance(series, Mapping) else None
    labels = resource.get("labels") if isinstance(resource, Mapping) else None
    bucket = labels.get("bucket_name") if isinstance(labels, Mapping) else None
    if not isinstance(bucket, str) or not bucket:
        raise CostReportError(f"{where}: a series has no bucket_name label")
    return bucket


def _day_of(point: Mapping[str, Any], where: str) -> date:
    """The UTC day an aligned point covers: it ends at the midnight after it."""
    interval = point.get("interval")
    text = interval.get("endTime") if isinstance(interval, Mapping) else None
    try:
        moment = datetime.fromisoformat(text) if isinstance(text, str) else None
    except ValueError:
        moment = None
    if moment is None or moment.tzinfo is None:
        raise CostReportError(f"{where}: a point's endTime {text!r} is not an RFC 3339 time")
    moment = moment.astimezone(UTC)
    if moment.time() != time(0):
        raise CostReportError(
            f"{where}: a point ends at {text}, not at a UTC midnight; the report reads whole days"
        )
    return moment.date() - timedelta(days=1)


def _sent_of(point: Mapping[str, Any], where: str) -> int:
    value = point.get("value")
    raw = value.get("int64Value") if isinstance(value, Mapping) else None
    if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 0:
        return raw
    if isinstance(raw, str) and raw.isdigit():
        return int(raw)
    raise CostReportError(f"{where}: a point's value {value!r} is not a non-negative int64Value")


def parse_time_series(pages: Sequence[Mapping[str, Any]]) -> list[ct.BucketDay]:
    """Every point of every page, one per bucket and UTC day; anything else is a hard error."""
    found: dict[tuple[str, date], ct.BucketDay] = {}
    for number, page in enumerate(pages, start=1):
        if not isinstance(page, Mapping):
            raise CostReportError(f"page {number}: not a JSON object")
        listed = page.get("timeSeries", [])
        if not isinstance(listed, list):
            raise CostReportError(f"page {number}: timeSeries is not a list")
        for series in listed:
            bucket = _bucket_of(series, f"page {number}")
            where = f"page {number}, bucket {bucket}"
            points = series.get("points")
            if not isinstance(points, list):
                raise CostReportError(f"{where}: points is not a list")
            for point in points:
                if not isinstance(point, Mapping):
                    raise CostReportError(f"{where}: a point is not a JSON object")
                day = _day_of(point, where)
                if (bucket, day) in found:
                    raise CostReportError(f"{where}: two data points for {day}; grouping should give one")
                found[(bucket, day)] = ct.BucketDay(bucket, day, _sent_of(point, where))
    return sorted(found.values(), key=lambda d: (d.bucket, d.day))


def fetch_json(url: str, token: str) -> dict[str, Any]:
    """A GET with the token as a bearer credential; the JSON object it returns."""
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "genomeos-cost-report/1"})
    request.add_unredirected_header("Authorization", f"Bearer {token}")
    shown = f"GET {url.split('?')[0]}"
    try:
        with _OPENER.open(request, timeout=TIMEOUT_S) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            detail = detail[:300]
        hint = "; reading needs roles/monitoring.viewer on the project" if error.code == 403 else ""
        raise CostReportError(f"{shown} failed: HTTP {error.code}: {detail}{hint}") from None
    except urllib.error.URLError as error:
        raise CostReportError(f"{shown} failed: {error.reason}") from None
    try:
        value = json.loads(body)
    except ValueError as error:
        raise CostReportError(f"{shown} returned no JSON ({error})") from None
    if not isinstance(value, dict):
        raise CostReportError(f"{shown} returned {type(value).__name__}, not a JSON object")
    return value


def access_token(gcloud: str) -> str:
    """``gcloud auth print-access-token`` through ``gcloud``, the repository's wrapper script, so the
    repository-local login answers (docs/repo-gcloud-auth.md). The token is returned, never printed."""
    command = [sys.executable, gcloud, "run", *TOKEN_COMMAND]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise CostReportError(
            f"{_TOKEN_SHOWN} failed ({completed.returncode}): {completed.stderr.strip()}; "
            "log in with python scripts/gcloud_repo.py auth login"
        )
    token = completed.stdout.strip()
    if not token or any(character.isspace() for character in token):
        raise CostReportError(f"{_TOKEN_SHOWN} printed no single token")
    return token


def bucket_roles(data: str, lookup: str | None, web: str) -> dict[str, ct.BucketRole]:
    """Each named bucket's role. A bucket has one role; every bucket not named is ``other``."""
    named: list[tuple[str, ct.BucketRole]] = [(data, "data"), (web, "web")]
    if lookup is not None:
        named.insert(1, (lookup, "lookup"))
    roles: dict[str, ct.BucketRole] = {}
    for bucket, role in named:
        try:
            assert_bucket_name(bucket)
        except WebLayoutError:
            raise CostReportError(f"the {role} bucket: invalid bucket name {bucket!r}") from None
        if bucket in roles:
            raise CostReportError(f"{bucket} is named for two roles, {roles[bucket]} and {role}")
        roles[bucket] = role
    return roles


def _gh(arguments: Sequence[str], stdin: str | None = None) -> str:
    gh = os.environ.get("GENOMEOS_GH_EXECUTABLE", "gh")
    try:
        completed = subprocess.run(
            [gh, *arguments], input=stdin, capture_output=True, text=True, check=False, cwd=ROOT
        )
    except FileNotFoundError:
        raise CostReportError(
            f"{gh} not found; install the GitHub CLI or set GENOMEOS_GH_EXECUTABLE"
        ) from None
    if completed.returncode != 0:
        raise CostReportError(
            f"gh {' '.join(arguments[:2])} failed ({completed.returncode}): {completed.stderr.strip()}"
        )
    return completed.stdout


def open_issue(title: str, body: str) -> None:
    """Open the issue in ``GITHUB_REPO`` unless an issue, open or closed, already has ``title``."""
    search = ["--state", "all", "--search", f'"{title}" in:title', "--limit", "100", "--json", "number,title"]
    listed = _gh(["issue", "list", "-R", GITHUB_REPO, *search])
    try:
        issues = json.loads(listed)
    except ValueError as error:
        raise CostReportError(f"gh issue list printed no JSON ({error})") from None
    if not isinstance(issues, list) or not all(isinstance(issue, Mapping) for issue in issues):
        raise CostReportError(f"gh issue list printed {listed[:200]!r}, not a list of issues")
    for issue in issues:
        if issue.get("title") == title:
            print(f"  skipped (#{issue.get('number')} has this title): {title}")
            return
    labels = [part for label in ISSUE_LABELS for part in ("--label", label)]
    url = _gh(["issue", "create", "-R", GITHUB_REPO, "--title", title, "--body-file", "-", *labels], body)
    print(f"  opened {url.strip()}: {title}")


def _interval(today: date) -> tuple[datetime, datetime]:
    return datetime.combine(ct.window_start(today), time(0), UTC), datetime.combine(today, time(0), UTC)


def read_days(project: str, today: date) -> list[ct.BucketDay]:
    """Every bucket's bytes sent per UTC day in the report's window, following each nextPageToken."""
    token = access_token(str(GCLOUD))
    start, end = _interval(today)
    pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    page_token: str | None = None
    while True:
        page = fetch_json(time_series_url(project, start, end, page_token), token)
        pages.append(page)
        page_token = page.get("nextPageToken") or None
        if page_token is None:
            return parse_time_series(pages)
        if not isinstance(page_token, str) or page_token in seen:
            raise CostReportError(f"page {len(pages)}: nextPageToken {page_token!r} repeats or is not text")
        seen.add(page_token)


def report_lines(days: Sequence[ct.BucketDay], roles: Mapping[str, ct.BucketRole], today: date) -> list[str]:
    """Per bucket and month: role, GiB and dollars; then this month to date against the kill switch."""
    current = ct.month_of(today)
    months = (*ct.complete_months(today), current)
    buckets = sorted(
        set(roles) | {d.bucket for d in days}, key=lambda b: (_ROLE_ORDER[roles.get(b, "other")], b)
    )
    width = max([len("bucket"), *(len(bucket) for bucket in buckets)])
    lines = [
        f"Cost report for {today} (UTC): bytes each bucket sent, from Cloud Monitoring, priced at "
        f"${EGRESS_USD_PER_GIB}/GiB (list price, before the free tier).",
        "",
        f"{'bucket':<{width}}  {'role':<6}  {'month':<8}  {'GiB':>10}  {'USD':>9}",
    ]
    for bucket in buckets:
        role = roles.get(bucket, "other")
        for month in months:
            label = f"{month}*" if month == current else month
            found = [d.sent_bytes for d in days if d.bucket == bucket and ct.month_of(d.day) == month]
            total = sum(found)
            cells = f"{ct.gib(total):>10}  {ct.egress_usd(total):>9}" if found else ct.NO_DATA_POINTS
            lines.append(f"{bucket:<{width}}  {role:<6}  {label:<8}  {cells}")
    yesterday = today - timedelta(days=1)
    first = today.replace(day=1)
    span = f"{first} to {yesterday}" if yesterday >= first else "no complete UTC day yet"
    to_date = sum(d.sent_bytes for d in days if ct.month_of(d.day) == current)
    usd = ct.egress_usd(to_date)
    share = (usd / ct.KILL_SWITCH_USD * 100).quantize(Decimal("0.1"))
    lines += [
        f"* this month to date: {span}",
        "",
        f"Month to date: ${usd} of egress from every bucket, against the ${ct.KILL_SWITCH_USD} kill switch "
        f"({share}%), which counts the project's whole bill; the billing export is the cross-check.",
    ]
    return lines


def trigger_lines(results: Sequence[ct.TriggerResult]) -> list[str]:
    lines = ["", "Triggers (design §1.3):"]
    for result in results:
        headline, *details = result.evidence.splitlines()
        lines.append(f"  {result.status:<14}  {result.trigger.id:<10}  {headline}")
        lines += [f"  {'':<14}  {'':<10}    {detail}" for detail in details]
    return lines


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only monthly cost report against the §1.3 triggers.")
    parser.add_argument("--project", help="GCP project id (default: $GENOMEOS_GCP_PROJECT; never in git)")
    parser.add_argument("--web-bucket", help="the Atlas web-data bucket (default: $ATLAS_DATA_BUCKET)")
    parser.add_argument("--lookup-bucket", help="the lookup bucket, once step 2.5 creates it")
    parser.add_argument("--today", type=date.fromisoformat, help="report as of this UTC day (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="print the reads it would make; make none")
    parser.add_argument("--open-issue", action="store_true", help="open an issue per fired trigger")
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
    web = args.web_bucket or os.environ.get("ATLAS_DATA_BUCKET")
    if not web:
        print(
            "error: pass --web-bucket or set ATLAS_DATA_BUCKET (the Atlas web-data bucket)", file=sys.stderr
        )
        return 2
    today = args.today or datetime.now(UTC).date()
    try:
        roles = bucket_roles(dr.DATA_STORE_BUCKET, args.lookup_bucket, web)
        if args.dry_run:
            print(f"DRY-RUN {_TOKEN_SHOWN}")
            print(f"DRY-RUN GET {time_series_url(project, *_interval(today))} (then each nextPageToken)")
            print(
                "roles: " + ", ".join(f"{bucket} {role}" for bucket, role in roles.items()) + ", others other"
            )
            return 0
        days = read_days(project, today)
        results = ct.evaluate(days, roles, today)
        print("\n".join([*report_lines(days, roles, today), *trigger_lines(results)]))
        fired = [result for result in results if result.status == "fired"]
        print("\nIssues:" if fired else "\nIssues: none; no trigger fired.")
        for result in fired:
            title, body = ct.issue_for(result)
            if args.open_issue:
                open_issue(title, body)
            else:
                print(f"  would open (pass --open-issue): {title}")
    except (CostReportError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return EXIT_FIRED if fired else 0


if __name__ == "__main__":
    raise SystemExit(main())
