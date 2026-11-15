"""`scripts/export_models.py`: export saved fits beside their artifacts, never over a released one (#471).

Atlas data platform design 2026-10-18 §2.1 and §2.3. The refusals happen before a fit is loaded, and the
clean-up after a failed run is checked with a stand-in export, so these tests need no fit on disk.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from genomeos.publication import data_release as dr
from scripts import export_models

ARTIFACT = "chr11-5227002-T-A__v9__map-test"
SOURCES = {"map": {"name": "MAP", "terms": {"status": "not_checked"}, "non_commercial": False}}


def _args(tmp_path: Path, *extra: str) -> list[str]:
    return [
        "--fits", str(tmp_path / "fits"),
        "--artifacts", str(tmp_path / "artifacts"),
        "--out", str(tmp_path / "models"),
        "--artifact", ARTIFACT,
        *extra,
    ]  # fmt: skip


def test_the_cli_names_its_flags():
    completed = subprocess.run(
        [sys.executable, "scripts/export_models.py", "--help"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    for flag in ("--fits", "--artifacts", "--out", "--artifact"):
        assert flag in completed.stdout


def test_the_cli_refuses_a_released_artifact(tmp_path, capsys):
    """A committed release already holds this artifact's model, and released keys never change."""
    releases = tmp_path / "releases"
    releases.mkdir()
    data = b'{"artifact": "released"}\n'
    record = dr.FileRecord(
        f"{export_models.MODEL_PREFIX}{ARTIFACT}/manifest.json",
        len(data),
        hashlib.sha256(data).hexdigest(),
        False,
        ("map",),
    )
    (releases / "2026-12-01.json").write_bytes(
        dr.canonical_bytes(dr.build_manifest([record], SOURCES, "2026-12-01"))
    )

    assert export_models.main(_args(tmp_path, "--releases", str(releases))) == 1
    error = capsys.readouterr().err
    assert "already published" in error
    assert f"{ARTIFACT} (release 2026-12-01)" in error
    assert not (tmp_path / "models").exists()


def test_the_cli_refuses_an_artifact_without_a_fit_input(tmp_path, capsys):
    artifact = tmp_path / "artifacts" / ARTIFACT
    artifact.mkdir(parents=True)
    (artifact / "manifest.json").write_text(json.dumps({"variant_id": "chr11-5227002-T-A"}))
    releases = tmp_path / "releases"
    releases.mkdir()

    assert export_models.main(_args(tmp_path, "--releases", str(releases))) == 1
    assert "fit input" in capsys.readouterr().err
    assert not (tmp_path / "models").exists()


def test_fit_path_for_names_the_saved_fit():
    assert export_models.fit_path_for(Path("fits"), "kir:2dl1") == Path("fits/kir__2dl1.fit.pkl")


def test_a_failed_run_removes_only_what_it_created(tmp_path, capsys, monkeypatch):
    """The first export is removed when the second fails; a directory that was already there is kept."""
    other = "chr11-5227002-T-A__v8__map-test"
    for name in (ARTIFACT, other):
        (tmp_path / "artifacts" / name).mkdir(parents=True)
        manifest = {"variant_id": "chr11-5227002-T-A", "observations": {"sha256": "0" * 64}}
        (tmp_path / "artifacts" / name / "manifest.json").write_text(json.dumps(manifest))
    (tmp_path / "fits").mkdir()
    export_models.fit_path_for(tmp_path / "fits", "chr11-5227002-T-A").write_bytes(b"")
    kept = tmp_path / "models" / other
    kept.mkdir(parents=True)
    (kept / "manifest.json").write_text("{}")

    def export(fit: object, artifact: Path, out_root: Path) -> Path:
        target = out_root / artifact.name
        if target.exists():
            raise FileExistsError(f"{target} already exists")
        target.mkdir(parents=True)
        (target / "model.json").write_text("{}")
        return target

    monkeypatch.setattr(export_models, "load_fit", lambda path: path)
    monkeypatch.setattr(export_models, "export_model", export)
    monkeypatch.setattr(export_models, "load_model_export", lambda model_dir, artifact: None)
    monkeypatch.setattr(export_models, "require_reproduces_cells", lambda fit, cells: None)
    monkeypatch.setattr(export_models.pd, "read_parquet", lambda path: None)

    args = _args(tmp_path, "--artifact", other, "--releases", str(tmp_path / "fits"))
    assert export_models.main(args) == 1
    assert "already exists" in capsys.readouterr().err
    assert not (tmp_path / "models" / ARTIFACT).exists()
    assert (kept / "manifest.json").read_text() == "{}"
