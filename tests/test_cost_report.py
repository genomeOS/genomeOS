"""The read-only monthly cost report (Atlas data platform design 2026-10-18 §1.3, §8, builder's call 12;
step 1.14).

Nothing here reaches a cloud: tests/fake_gcloud.py prints the token, a loopback server stands in for the
Monitoring API's ``projects.timeSeries.list`` and records every request, and a fake ``gh`` records every
call. An autouse fixture blocks the real ``gh``, as tests/conftest.py blocks the real gcloud.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import shlex
import sys
import threading
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from tests.atlas_web_fixtures import install_fake_gcloud

ROOT = Path(__file__).resolve().parents[1]


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cost_report", ROOT / "scripts" / "cost_report.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


report = _load()
TOKEN = "ya29.fake-cost-report-token"
GIB = 1 << 30
PROJECT = "example-project"
ARGS = ["--project", PROJECT, "--web-bucket", "example-web", "--today", "2026-12-03"]
D3_TITLE = "Cost trigger D3-egress fired: free data egress over $50 in 2026-10 and 2026-11"
D12_TITLE = "Cost trigger D12-egress fired: free data egress over $50 in 2026-10 and 2026-11"
Capsys = pytest.CaptureFixture[str]

FAKE_GH = """
import json, os, sys
state_path = os.environ["FAKE_GH_STATE"]
with open(os.environ["FAKE_GH_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
state = json.load(open(state_path, encoding="utf-8"))
args = sys.argv[1:]
flags = {args[i]: args[i + 1] for i in range(2, len(args) - 1, 2)}
if args[:2] == ["issue", "list"]:
    print(json.dumps([{"number": i["number"], "title": i["title"]} for i in state["issues"]]))
elif args[:2] == ["issue", "create"]:
    number = 100 + len(state["issues"])
    labels = [args[i + 1] for i in range(len(args) - 1) if args[i] == "--label"]
    state["issues"].append({"number": number, "title": flags["--title"], "body": sys.stdin.read(),
                            "labels": labels})
    json.dump(state, open(state_path, "w", encoding="utf-8"))
    print(f"https://github.com/genomeOS/genomeOS/issues/{number}")
else:
    print("fake gh: unsupported " + " ".join(args), file=sys.stderr)
    sys.exit(2)
"""


@dataclass(frozen=True)
class FakeGh:
    state_path: Path
    log_path: Path

    def calls(self) -> list[list[str]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]

    def issues(self) -> list[dict[str, Any]]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))["issues"]


def install_fake_gh(root: Path, monkeypatch: pytest.MonkeyPatch, issues: list[dict[str, Any]]) -> FakeGh:
    root.mkdir(parents=True, exist_ok=True)
    script = root / "fake_gh.py"
    script.write_text(FAKE_GH, encoding="utf-8")
    shim = root / "gh"
    shim.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n')
    shim.chmod(0o755)
    fake = FakeGh(root / "gh-state.json", root / "gh-log.jsonl")
    fake.state_path.write_text(json.dumps({"issues": issues}), encoding="utf-8")
    monkeypatch.setenv("GENOMEOS_GH_EXECUTABLE", str(shim))
    monkeypatch.setenv("FAKE_GH_STATE", str(fake.state_path))
    monkeypatch.setenv("FAKE_GH_LOG", str(fake.log_path))
    return fake


@pytest.fixture(autouse=True)
def _no_real_gh(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    shim = tmp_path_factory.mktemp("gh-blocked") / "gh"
    shim.write_text('#!/bin/sh\necho "tests may not run the real gh; use install_fake_gh" >&2\nexit 97\n')
    shim.chmod(0o755)
    monkeypatch.setenv("GENOMEOS_GH_EXECUTABLE", str(shim))


def series(bucket: str, sent: Mapping[str, int]) -> dict[str, Any]:
    """One bucket's aligned series: ``sent`` maps each point's endTime (a UTC midnight) to its bytes."""
    points = [
        {"interval": {"startTime": "x", "endTime": end}, "value": {"int64Value": str(value)}}
        for end, value in sent.items()
    ]
    return {
        "metric": {"type": report.SENT_BYTES_METRIC},
        "resource": {"type": "gcs_bucket", "labels": {"bucket_name": bucket}},
        "metricKind": "DELTA",
        "valueType": "INT64",
        "points": points,
    }


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, str]
    authorization: str | None


@dataclass
class FakeMonitoring:
    """Answers ``timeSeries.list`` from ``pages``, keyed by the request's pageToken (None for the first)."""

    pages: dict[str | None, dict[str, Any]]
    status: int = 200
    requests: list[Request] = field(default_factory=list)
    root: str = ""


@contextlib.contextmanager
def monitoring(fake: FakeMonitoring) -> Iterator[FakeMonitoring]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
            return

        def _answer(self) -> None:
            url = urlsplit(self.path)
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            fake.requests.append(Request(self.command, url.path, query, self.headers.get("Authorization")))
            if fake.status != 200:
                body = {"error": {"code": fake.status, "message": "Permission denied (fake)"}}
            else:
                body = fake.pages[query.get("pageToken")]
            data = json.dumps(body).encode()
            self.send_response(fake.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _answer

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.root = f"http://127.0.0.1:{server.server_address[1]}/v3"
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()


FIRING = FakeMonitoring(
    {
        None: {
            "timeSeries": [series("genomeos-atlas-data", {"2026-10-02T00:00:00Z": 417 * GIB})],
            "nextPageToken": "p2",
        },
        "p2": {
            "timeSeries": [
                series("genomeos-atlas-data", {"2026-11-02T00:00:00Z": 417 * GIB}),
                series("example-other", {"2026-11-02T00:00:00Z": 10_000 * GIB}),
            ]
        },
    }
)


def _run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake: FakeMonitoring, argv: list[str]
) -> tuple[int, Any, FakeMonitoring]:
    gcloud = install_fake_gcloud(tmp_path / "gcloud", monkeypatch, {})
    fresh = FakeMonitoring(fake.pages, fake.status)
    with monitoring(fresh) as server:
        monkeypatch.setattr(report, "MONITORING_ROOT", server.root)
        code = report.main(argv)
    return code, gcloud, fresh


def test_the_time_series_url() -> None:
    start = datetime(2026, 10, 1, tzinfo=UTC)
    end = datetime(2026, 12, 3, tzinfo=UTC)
    url = urlsplit(report.time_series_url(PROJECT, start, end))
    query = {key: values for key, values in parse_qs(url.query).items()}
    assert (url.scheme, url.netloc, url.path) == (
        "https",
        "monitoring.googleapis.com",
        "/v3/projects/example-project/timeSeries",
    )
    assert query == {
        "filter": [f'metric.type = "{report.SENT_BYTES_METRIC}" AND resource.type = "gcs_bucket"'],
        "interval.startTime": ["2026-10-01T00:00:00Z"],
        "interval.endTime": ["2026-12-03T00:00:00Z"],
        "aggregation.alignmentPeriod": ["86400s"],
        "aggregation.perSeriesAligner": ["ALIGN_SUM"],
        "aggregation.crossSeriesReducer": ["REDUCE_SUM"],
        "aggregation.groupByFields": ["resource.label.bucket_name"],
    }
    assert parse_qs(urlsplit(report.time_series_url(PROJECT, start, end, "p2")).query)["pageToken"] == ["p2"]
    with pytest.raises(report.CostReportError, match="UTC"):
        report.time_series_url(PROJECT, datetime(2026, 10, 1), end)


def test_a_point_counts_for_the_day_it_ends() -> None:
    page = {"timeSeries": [series("example-web", {"2026-11-15T00:00:00Z": 5, "2026-11-16T00:00:00.000Z": 7})]}
    assert report.parse_time_series([page, {"executionErrors": [], "unreachable": []}]) == [
        report.ct.BucketDay("example-web", date(2026, 11, 14), 5),
        report.ct.BucketDay("example-web", date(2026, 11, 15), 7),
    ]


def _point(**changes: Any) -> dict[str, Any]:
    point: dict[str, Any] = {"interval": {"endTime": "2026-11-15T00:00:00Z"}, "value": {"int64Value": "5"}}
    point.update(changes)
    return point


def _page(bucket: Any = "example-web", points: Any = None) -> dict[str, Any]:
    labels = {} if bucket is None else {"bucket_name": bucket}
    return {
        "timeSeries": [{"resource": {"labels": labels}, "points": [_point()] if points is None else points}]
    }


@pytest.mark.parametrize(
    ("pages", "message"),
    [
        ([[]], "page 1: not a JSON object"),
        ([{"timeSeries": {}}], "timeSeries is not a list"),
        ([_page(bucket=None)], "no bucket_name"),
        ([_page(points={})], "points is not a list"),
        ([_page(points=[_point(value={"doubleValue": 5.0})])], "int64Value"),
        ([_page(points=[_point(value={"int64Value": "-1"})])], "int64Value"),
        ([_page(points=[_point(value={"int64Value": True})])], "int64Value"),
        ([_page(points=[_point(interval={})])], "endTime"),
        ([_page(points=[_point(interval={"endTime": "2026-11-15T00:00:00"})])], "endTime"),
        ([_page(points=[_point(interval={"endTime": "2026-11-15T07:00:00Z"})])], "not at a UTC midnight"),
        ([_page(), _page()], "two data points"),
        (
            [{"timeSeries": [], "executionErrors": [{"code": 13, "message": "partial"}]}],
            "page 1: Monitoring reports an execution error, so its data may be incomplete: partial",
        ),
        (
            [_page(), {"executionErrors": [{"code": 4, "message": "deadline exceeded"}, {"code": 13}]}],
            "page 2: Monitoring reports 2 execution errors, so its data may be incomplete; "
            "the first: deadline exceeded",
        ),
        ([{"executionErrors": [7]}], "an execution error, so its data may be incomplete: 7"),
        ([{"executionErrors": {}}], "page 1: executionErrors is not a list"),
        (
            [_page(), {"unreachable": ["us-east1", "europe-west4"]}],
            "page 2: Monitoring could not reach us-east1, europe-west4, so its data may be incomplete",
        ),
        ([{"unreachable": "us-east1"}], "page 1: unreachable is not a list"),
    ],
)
def test_malformed_data_is_a_hard_error(pages: list[Any], message: str) -> None:
    with pytest.raises(report.CostReportError, match=message):
        report.parse_time_series(pages)


def test_a_run_with_a_fired_trigger(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys) -> None:
    code, gcloud, server = _run(tmp_path, monkeypatch, FIRING, ARGS)
    out = capsys.readouterr()
    assert code == report.EXIT_FIRED == 3
    assert gcloud.calls() == [["auth", "print-access-token"]]
    assert gcloud.configs() == {str(ROOT / ".local" / "gcloud" / "genomeos")}  # through gcloud_repo.py
    assert {request.method for request in server.requests} == {"GET"}
    assert [request.query.get("pageToken") for request in server.requests] == [None, "p2"]
    assert {request.path for request in server.requests} == {"/v3/projects/example-project/timeSeries"}
    assert {request.authorization for request in server.requests} == {f"Bearer {TOKEN}"}
    assert server.requests[0].query["interval.startTime"] == "2026-10-01T00:00:00Z"
    assert server.requests[0].query["interval.endTime"] == "2026-12-03T00:00:00Z"
    assert TOKEN not in out.out + out.err
    lines = out.out.splitlines()
    assert any(line.split()[:4] == ["genomeos-atlas-data", "data", "2026-10", "417.00"] for line in lines)
    assert any(
        line.split()[:5] == ["example-other", "other", "2026-11", "10000.00", "1200.00"] for line in lines
    )
    assert any(line.split()[:2] == ["example-web", "web"] and "no data points" in line for line in lines)
    assert "against the $300 kill switch" in out.out
    assert any(line.split()[:2] == ["fired", "D3-egress"] for line in lines)
    assert any(line.split()[:2] == ["not_measurable", "D3-brake"] for line in lines)
    assert any(line.split()[:2] == ["not_fired", "D11-web"] for line in lines)
    assert f"would open (pass --open-issue): {D3_TITLE}" in out.out


def test_a_run_with_no_trigger_exits_0(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    quiet = FakeMonitoring({None: {"timeSeries": [series("example-web", {"2026-11-02T00:00:00Z": GIB})]}})
    code, _, _ = _run(tmp_path, monkeypatch, quiet, [*ARGS, "--open-issue"])
    assert code == 0
    assert "would open" not in capsys.readouterr().out


def test_a_page_monitoring_marks_incomplete_stops_the_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    """A partial page could undercount a month, so no trigger is judged on it."""
    partial = {**FIRING.pages["p2"], "executionErrors": [{"code": 13, "message": "query timed out"}]}
    code, _, server = _run(tmp_path, monkeypatch, FakeMonitoring({**FIRING.pages, "p2": partial}), ARGS)
    out = capsys.readouterr()
    assert code == 1
    assert len(server.requests) == 2
    assert "page 2: Monitoring reports an execution error" in out.err and "query timed out" in out.err
    assert "Triggers" not in out.out and "not_fired" not in out.out


def test_a_denied_read_names_the_role(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    code, _, server = _run(tmp_path, monkeypatch, FakeMonitoring({}, status=403), ARGS)
    err = capsys.readouterr().err
    assert code == 1
    assert len(server.requests) == 1
    assert "HTTP 403" in err and "Permission denied (fake)" in err and "roles/monitoring.viewer" in err
    assert TOKEN not in err


def test_dry_run_calls_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys) -> None:
    gh = install_fake_gh(tmp_path / "gh", monkeypatch, [])
    code, gcloud, server = _run(tmp_path, monkeypatch, FIRING, [*ARGS, "--dry-run", "--open-issue"])
    out = capsys.readouterr().out
    assert code == 0
    assert (gcloud.calls(), server.requests, gh.calls()) == ([], [], [])
    assert "DRY-RUN python scripts/gcloud_repo.py run auth print-access-token" in out
    assert f"DRY-RUN GET {server.root}/projects/example-project/timeSeries?" in out


def test_a_missing_web_bucket_names_its_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    monkeypatch.delenv("ATLAS_DATA_BUCKET", raising=False)
    code, gcloud, server = _run(tmp_path, monkeypatch, FIRING, ["--project", PROJECT])
    assert code == 2
    assert "ATLAS_DATA_BUCKET" in capsys.readouterr().err
    assert (gcloud.calls(), server.requests) == ([], [])
    monkeypatch.delenv("GENOMEOS_GCP_PROJECT", raising=False)
    assert report.main(["--web-bucket", "example-web"]) == 2
    assert "GENOMEOS_GCP_PROJECT" in capsys.readouterr().err


def test_one_bucket_has_one_role() -> None:
    assert report.bucket_roles("genomeos-atlas-data", None, "example-web") == {
        "genomeos-atlas-data": "data",
        "example-web": "web",
    }
    assert (
        report.bucket_roles("genomeos-atlas-data", "example-lookup", "example-web")["example-lookup"]
        == "lookup"
    )
    with pytest.raises(report.CostReportError, match="two roles"):
        report.bucket_roles("genomeos-atlas-data", None, "genomeos-atlas-data")
    with pytest.raises(report.CostReportError, match="invalid bucket name"):
        report.bucket_roles("genomeos-atlas-data", "gs://example-lookup", "example-web")


def test_an_existing_issue_title_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Capsys
) -> None:
    gh = install_fake_gh(tmp_path / "gh", monkeypatch, [{"number": 7, "title": D3_TITLE}])
    code, _, _ = _run(tmp_path, monkeypatch, FIRING, [*ARGS, "--open-issue"])
    out = capsys.readouterr().out
    assert code == report.EXIT_FIRED
    created = [call for call in gh.calls() if call[:2] == ["issue", "create"]]
    assert len(created) == 1
    assert [issue["title"] for issue in gh.issues()] == [D3_TITLE, D12_TITLE]
    opened = gh.issues()[1]
    assert "needs-human-decision" in opened["labels"]
    assert "$50.04" in opened["body"] and PROJECT not in opened["body"]
    assert f"skipped (#7 has this title): {D3_TITLE}" in out
    assert f"opened https://github.com/genomeOS/genomeOS/issues/101: {D12_TITLE}" in out
    listed = [call for call in gh.calls() if call[:2] == ["issue", "list"]]
    assert all("--state" in call and call[call.index("--state") + 1] == "all" for call in listed)
    # A second run in the same month opens nothing more.
    code, _, _ = _run(tmp_path / "again", monkeypatch, FIRING, [*ARGS, "--open-issue"])
    assert code == report.EXIT_FIRED
    assert len(gh.issues()) == 2


def test_an_unreadable_issue_list_is_a_hard_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Treating it as "no issues" could open a duplicate."""
    shim = tmp_path / "gh"
    shim.write_text('#!/bin/sh\necho \'{"issues": []}\'\n')
    shim.chmod(0o755)
    monkeypatch.setenv("GENOMEOS_GH_EXECUTABLE", str(shim))
    with pytest.raises(report.CostReportError, match="not a list of issues"):
        report.open_issue(D3_TITLE, "body")
