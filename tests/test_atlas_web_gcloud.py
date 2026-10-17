"""Repository-wrapped gcloud calls for the Atlas web bucket scripts (design 2026-10-07 §C.2)."""

from __future__ import annotations

import io
import shlex
from pathlib import Path

import pytest

from scripts.atlas_web_gcloud import Gcloud, GcloudError, GcloudResult
from tests.atlas_web_fixtures import install_fake_gcloud

ROOT = Path(__file__).resolve().parents[1]
OBJECT = "gs://example-bucket/atlas/web/x.json"
DESCRIBE = ["storage", "objects", "describe", OBJECT, "--raw", "--format=json"]
ADDRESS_SCOPE = ["--global", "--project=example-project"]
ADDRESS_DESCRIBE = ["compute", "addresses", "describe", "atlas-web-ip", *ADDRESS_SCOPE, "--format=json"]
ADDRESS_CREATE = ["compute", "addresses", "create", "atlas-web-ip", *ADDRESS_SCOPE, "--ip-version=IPV4"]
STORAGE_404 = "ERROR: (gcloud.storage.objects.describe) gs://example-bucket/x not found: 404.\n"
COMPUTE_404 = (
    "ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\n"
    " - The resource 'projects/example-project/global/addresses/atlas-web-ip' was not found\n"
)
FILE_NOT_FOUND = (
    "Traceback (most recent call last):\n"
    '  File "scripts/gcloud_repo.py", line 25, in run_gcloud\n'
    "FileNotFoundError: [Errno 2] No such file or directory: 'gcloud'\n"
)
MODULE_NOT_FOUND = (
    "Traceback (most recent call last):\nModuleNotFoundError: No module named 'googlecloudsdk.core'\n"
)
SHELL_NOT_FOUND = "sh: 1: gcloud: not found\n"
CRASHED = "ERROR: gcloud crashed (FileNotFoundError): [Errno 2] No such file or directory: 'x'\n"


def _scripted_gcloud(
    root: Path, monkeypatch: pytest.MonkeyPatch, *, stdout: str, stderr: str, code: int
) -> None:
    """Point the wrapper at a one-off gcloud printing fixed text: outputs the stateful fake never gives."""
    shim = root / "scripted-gcloud"
    shim.write_text(
        f"#!/bin/sh\nprintf %s {shlex.quote(stdout)}\nprintf %s {shlex.quote(stderr)} >&2\nexit {code}\n",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    monkeypatch.setenv("GENOMEOS_GCLOUD_EXECUTABLE", str(shim))


def test_describe_reads_json_through_the_repository_wrapper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resource = {"size": "3", "metadata": {"sha256": "ab"}}
    fake = install_fake_gcloud(
        tmp_path, monkeypatch, {"objects": {"example-bucket/atlas/web/x.json": resource}}
    )
    assert Gcloud(dry_run=False).describe(DESCRIBE) == resource
    assert fake.calls() == [DESCRIBE]
    assert fake.configs() == {str(ROOT / ".local" / "gcloud" / "genomeos")}


def test_describe_returns_none_for_a_missing_object(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    install_fake_gcloud(tmp_path, monkeypatch, {})
    assert Gcloud(dry_run=False).describe(DESCRIBE) is None


def test_an_unsupported_command_fails_loudly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    install_fake_gcloud(tmp_path, monkeypatch, {})
    with pytest.raises(GcloudError, match="unsupported"):
        Gcloud(dry_run=False).describe(["storage", "objects", "list", "gs://example-bucket"])


def test_dry_run_prints_every_command_and_runs_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    out = io.StringIO()
    gcloud = Gcloud(dry_run=True, out=out)
    assert gcloud.describe(DESCRIBE) is None
    assert (
        gcloud.mutate(["storage", "buckets", "update", "gs://example-bucket", "--no-versioning"]).returncode
        == 0
    )
    assert out.getvalue().splitlines() == [
        f"DRY-RUN python scripts/gcloud_repo.py run storage objects describe {OBJECT} --raw --format=json",
        "DRY-RUN python scripts/gcloud_repo.py run storage buckets update gs://example-bucket "
        "--no-versioning",
    ]
    assert fake.calls() == []


def test_a_refused_upload_precondition_is_reported_as_such(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_gcloud(
        tmp_path,
        monkeypatch,
        {
            "buckets": {"example-bucket": {"name": "example-bucket"}},
            "objects": {"example-bucket/atlas/web/x.json": {"size": "1"}},
        },
    )
    source = tmp_path / "x.json.gz"
    source.write_bytes(b"x")
    out = io.StringIO()
    result = Gcloud(dry_run=False, out=out).mutate(
        ["storage", "cp", str(source), OBJECT, "--if-generation-match=0"]
    )
    assert result.returncode != 0
    assert result.precondition_failed
    assert out.getvalue().startswith("RUN python scripts/gcloud_repo.py run storage cp ")


def test_a_test_without_the_fake_cannot_reach_the_real_gcloud() -> None:
    # tests/conftest.py's autouse fixture: Task 98 (C13) authenticates the repository gcloud on this
    # machine, and Task 104 (C18) runs the whole suite there.
    result = Gcloud(dry_run=False).query(["config", "list", "--format=json"])
    assert result.returncode == 97
    assert "may not run the real gcloud" in result.stderr


@pytest.mark.parametrize(
    ("returncode", "stderr", "absent"),
    [
        (1, STORAGE_404, True),
        (1, COMPUTE_404, True),
        (1, "ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account.\n", True),
        (0, STORAGE_404, False),
        (1, FILE_NOT_FOUND, False),
        (1, MODULE_NOT_FOUND, False),
        (127, SHELL_NOT_FOUND, False),
        (1, CRASHED, False),
        (1, "ERROR: (gcloud.storage.objects.describe) HTTPError 403: permission denied\n", False),
        (1, "ERROR: (gcloud.functions.describe) PERMISSION_DENIED: Cloud Functions API is disabled\n", False),
    ],
)
def test_only_gcloud_s_own_command_error_can_report_an_absent_resource(
    returncode: int, stderr: str, absent: bool
) -> None:
    assert GcloudResult(returncode, "", stderr).not_found is absent


def test_a_missing_gcloud_is_an_error_not_an_absent_resource(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GENOMEOS_GCLOUD_EXECUTABLE", str(tmp_path / "no-such-gcloud"))
    with pytest.raises(GcloudError, match="FileNotFoundError"):
        Gcloud(dry_run=False).describe(DESCRIBE)


@pytest.mark.parametrize(("stderr", "code"), [(MODULE_NOT_FOUND, 1), (SHELL_NOT_FOUND, 127), (CRASHED, 1)])
def test_a_broken_gcloud_is_an_error_not_an_absent_resource(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stderr: str, code: int
) -> None:
    _scripted_gcloud(tmp_path, monkeypatch, stdout="", stderr=stderr, code=code)
    with pytest.raises(GcloudError, match=f"failed \\({code}\\)"):
        Gcloud(dry_run=False).describe(DESCRIBE)


def test_describe_refuses_output_that_is_not_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _scripted_gcloud(tmp_path, monkeypatch, stdout="Listed 0 items.\n", stderr="", code=0)
    with pytest.raises(GcloudError, match="'Listed 0 items.\\\\n', not JSON"):
        Gcloud(dry_run=False).describe(DESCRIBE)


@pytest.mark.parametrize("stdout", ["[]\n", '"absent"\n', "null\n", ""])
def test_describe_refuses_json_that_is_not_an_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stdout: str
) -> None:
    _scripted_gcloud(tmp_path, monkeypatch, stdout=stdout, stderr="", code=0)
    with pytest.raises(GcloudError, match="not a JSON object"):
        Gcloud(dry_run=False).describe(DESCRIBE)


def test_dry_run_query_prints_the_command_and_reports_an_empty_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    out = io.StringIO()
    policy = ["org-policies", "describe", "iam.allowedPolicyMemberDomains", "--project=example-project"]
    assert Gcloud(dry_run=True, out=out).query(policy) == GcloudResult(0, "{}", "")
    assert out.getvalue() == f"DRY-RUN {Gcloud.display(policy)}\n"
    assert fake.calls() == []


def test_the_fake_reports_a_missing_compute_resource_as_gcloud_does_and_creates_it_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    gcloud = Gcloud(dry_run=False, out=io.StringIO())
    assert gcloud.describe(ADDRESS_DESCRIBE) is None
    assert gcloud.mutate(ADDRESS_CREATE).returncode == 0
    assert (gcloud.describe(ADDRESS_DESCRIBE) or {}).get("address") == "203.0.113.10"
    repeated = gcloud.mutate(ADDRESS_CREATE)
    assert repeated.returncode == 1
    assert "already exists" in repeated.stderr
    assert list(fake.state()["compute"]) == ["addresses"]


@pytest.mark.parametrize(
    "arguments",
    [
        ADDRESS_DESCRIBE[:-1] + ["--format=yaml"],
        [argument for argument in ADDRESS_DESCRIBE if argument != "--global"],
        [argument for argument in ADDRESS_DESCRIBE if not argument.startswith("--project")],
        ["compute", "backend-buckets", "describe", "atlas-web-backend", *ADDRESS_SCOPE, "--format=json"],
        ["compute", "instances", "describe", "atlas-web-vm", *ADDRESS_SCOPE, "--format=json"],
    ],
)
def test_the_fake_refuses_a_compute_describe_the_cdn_plan_never_issues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, arguments: list[str]
) -> None:
    install_fake_gcloud(tmp_path, monkeypatch, {})
    with pytest.raises(GcloudError, match="unsupported"):
        Gcloud(dry_run=False).describe(arguments)


@pytest.mark.parametrize(
    "arguments",
    [
        [*ADDRESS_CREATE, "--network-tier=PREMIUM"],
        [argument for argument in ADDRESS_CREATE if argument != "--global"],
        [
            "compute",
            "backend-buckets",
            "create",
            "atlas-web-backend",
            *ADDRESS_SCOPE,
            "--gcs-bucket-name=example-bucket",
            "--enable-cdn",
            "--cache-mode=USE_ORIGIN_HEADERS",
        ],
        ["compute", "instances", "create", "atlas-web-vm", *ADDRESS_SCOPE],
        ["storage", "cp", "x.json.gz", OBJECT, "--if-generation-match=0", "--no-clobber"],
    ],
)
def test_the_fake_refuses_a_mutation_the_scripts_never_issue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, arguments: list[str]
) -> None:
    initial = {"buckets": {"example-bucket": {"name": "example-bucket"}}}
    fake = install_fake_gcloud(tmp_path, monkeypatch, initial)
    result = Gcloud(dry_run=False, out=io.StringIO()).mutate(arguments)
    assert result.returncode == 2
    assert "unsupported" in result.stderr
    assert fake.state() == initial


def test_the_fake_state_and_mutating_calls_record_only_what_changed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = install_fake_gcloud(tmp_path, monkeypatch, {})
    gcloud = Gcloud(dry_run=False, out=io.StringIO())
    bucket = "gs://example-bucket"
    source = tmp_path / "x.json.gz"
    source.write_bytes(b"x")
    create = [
        "storage",
        "buckets",
        "create",
        bucket,
        "--project=example-project",
        "--location=us-east1",
        "--uniform-bucket-level-access",
        "--no-public-access-prevention",
    ]
    label = ["storage", "buckets", "update", bucket, "--update-labels=genomeos-purpose=atlas-web"]
    grant = ["storage", "buckets", "add-iam-policy-binding", bucket, "--member=allUsers", "--role=roles/x"]
    upload = ["storage", "cp", str(source), OBJECT, "--if-generation-match=0", "--custom-metadata=sha256=ab"]
    reads = [
        ["storage", "buckets", "describe", bucket, "--raw", "--format=json"],
        ["storage", "buckets", "get-iam-policy", bucket, "--format=json"],
        DESCRIBE,
    ]
    assert gcloud.describe(reads[0]) is None
    for mutation in (create, label, grant, upload):
        assert gcloud.mutate(mutation).returncode == 0, mutation
    assert gcloud.describe(reads[1]) == {
        "bindings": [{"members": ["allUsers"], "role": "roles/x"}],
        "etag": "CAE=",
    }
    assert (gcloud.describe(reads[2]) or {}).get("metadata") == {"sha256": "ab"}
    assert fake.mutating_calls() == [create, label, grant, upload]
    assert fake.calls() == [reads[0], create, label, grant, upload, reads[1], reads[2]]
    state = fake.state()
    assert state["buckets"]["example-bucket"]["labels"] == {"genomeos-purpose": "atlas-web"}
    assert state["buckets"]["example-bucket"]["bindings"] == [{"members": ["allUsers"], "role": "roles/x"}]
    assert state["buckets"]["example-bucket"]["location"] == "US-EAST1"
    assert state["objects"]["example-bucket/atlas/web/x.json"]["data_b64"] == "eA=="
