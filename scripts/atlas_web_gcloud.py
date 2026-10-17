"""Repository-wrapped gcloud calls for the Atlas web bucket scripts (design 2026-10-07 §C.2).

Every command runs as ``python scripts/gcloud_repo.py run …`` so it uses the repository-local SDK
configuration (docs/repo-gcloud-auth.md); bare ``gcloud`` is never invoked. The wrapper honours
``GENOMEOS_GCLOUD_EXECUTABLE``, which is how the tests substitute tests/fake_gcloud.py. In dry-run
nothing is executed: every command is printed, reads report "absent" and mutations report success, so
the printed plan is the complete sequence for a fresh bucket.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts" / "gcloud_repo.py"
# A 404 counts only inside gcloud's own command error, which names the command:
# "ERROR: (gcloud.storage.objects.describe) gs://b/o not found: 404." or, for compute, "ERROR:
# (gcloud.compute.addresses.describe) Could not fetch resource:\n - The resource '…' was not found", or,
# for IAM and Pub/Sub, the status "ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown …".
# A gcloud that is missing or broken (a FileNotFoundError or ModuleNotFoundError traceback, a shell's
# "gcloud: not found", "ERROR: gcloud crashed (…)") is a failure, never an absent resource.
_GCLOUD_ERROR = re.compile(r"^ERROR: \(gcloud\.[\w.-]+\)", re.MULTILINE)
_NOT_FOUND = re.compile(r"\b404\b|\bnot found\b|\bNOT_FOUND\b", re.IGNORECASE)
_PRECONDITION = re.compile(r"\b412\b|precondition", re.IGNORECASE)  # "HTTPError 412: …"


class GcloudError(RuntimeError):
    """A gcloud command failed for a reason the caller does not handle."""


@dataclass(frozen=True)
class GcloudResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def not_found(self) -> bool:
        if self.returncode == 0:
            return False
        command_error = _GCLOUD_ERROR.search(self.stderr)
        return command_error is not None and bool(_NOT_FOUND.search(self.stderr, command_error.end()))

    @property
    def precondition_failed(self) -> bool:
        return self.returncode != 0 and bool(_PRECONDITION.search(self.stderr))


class Gcloud:
    """Runs wrapped gcloud commands, or only prints them when ``dry_run`` is set."""

    def __init__(self, *, dry_run: bool, out: TextIO | None = None) -> None:
        self.dry_run = dry_run
        self._out = out

    @staticmethod
    def display(arguments: Sequence[str]) -> str:
        return shlex.join(["python", "scripts/gcloud_repo.py", "run", *arguments])

    def describe(self, arguments: Sequence[str]) -> dict[str, Any] | None:
        """Parsed JSON from a read; ``None`` when gcloud reports 404 (and always in dry-run)."""
        if self.dry_run:
            self._say("DRY-RUN", arguments)
            return None
        result = self._execute(arguments)
        if result.returncode == 0:
            try:
                value = json.loads(result.stdout or "null")
            except json.JSONDecodeError as error:
                raise GcloudError(
                    f"{self.display(arguments)} printed {result.stdout[:200]!r}, not JSON ({error})"
                ) from error
            if not isinstance(value, dict):
                raise GcloudError(
                    f"{self.display(arguments)} printed {result.stdout[:200]!r}, not a JSON object"
                )
            return value
        if result.not_found:
            return None
        raise GcloudError(f"{self.display(arguments)} failed ({result.returncode}): {result.stderr.strip()}")

    def query(self, arguments: Sequence[str]) -> GcloudResult:
        """A read whose failure the caller reports itself (an unreadable org policy, say)."""
        if self.dry_run:
            self._say("DRY-RUN", arguments)
            return GcloudResult(0, "{}", "")
        return self._execute(arguments)

    def mutate(self, arguments: Sequence[str]) -> GcloudResult:
        """A change; printed as ``RUN …`` (an audit line) or ``DRY-RUN …`` before it happens."""
        self._say("DRY-RUN" if self.dry_run else "RUN", arguments)
        if self.dry_run:
            return GcloudResult(0, "", "")
        return self._execute(arguments)

    def _say(self, tag: str, arguments: Sequence[str]) -> None:
        print(f"{tag} {self.display(arguments)}", file=self._out if self._out is not None else sys.stdout)

    def _execute(self, arguments: Sequence[str]) -> GcloudResult:
        completed = subprocess.run(
            [sys.executable, str(WRAPPER), "run", *arguments],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        return GcloudResult(completed.returncode, completed.stdout, completed.stderr)
