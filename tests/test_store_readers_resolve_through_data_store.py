"""The scripts that read data/store resolve it through the data store (data store design 2026-10-17 §6)."""

from __future__ import annotations

from pathlib import Path

import pytest

from scripts import build_atlas_catalog, publish_artifacts, sync_store
from scripts.fetch_data import DATA


def test_build_atlas_catalog_resolves_its_default_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, Path]] = []
    monkeypatch.setattr(
        build_atlas_catalog, "require_local", lambda path: calls.append(("fetch", path)) or path
    )
    monkeypatch.setattr(
        build_atlas_catalog,
        "build_catalog",
        lambda source, metadata, out: calls.append(("build", source)) or out,
    )
    build_atlas_catalog.main(["--out", str(tmp_path / "catalog")])
    assert calls == [("fetch", DATA / "store" / "artifacts"), ("build", DATA / "store" / "artifacts")]


def test_build_atlas_catalog_reports_a_fetch_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def refuse(path: Path) -> Path:
        raise build_atlas_catalog.FetchError("set GENOMEOS_DATA_BASE_URL")

    monkeypatch.setattr(build_atlas_catalog, "require_local", refuse)
    with pytest.raises(SystemExit, match="GENOMEOS_DATA_BASE_URL"):
        build_atlas_catalog.main(["--out", str(tmp_path / "catalog")])


def test_push_atlas_release_resolves_every_target_before_reading_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    artifact = tmp_path / "store" / "artifacts" / "a"
    resolved: list[Path] = []

    def fetch(path: Path) -> Path:
        artifact.mkdir(parents=True, exist_ok=True)
        (artifact / "cells.parquet").write_bytes(b"x" * 2_000_000)
        resolved.append(path)
        return path

    monkeypatch.setattr(sync_store, "atlas_release_targets", lambda: ((str(artifact), "store/artifacts/a"),))
    monkeypatch.setattr(sync_store, "require_local", fetch)
    sync_store.push_atlas_release(dry_run=True)
    assert resolved == [artifact]
    assert "store/artifacts/a" in capsys.readouterr().out


def test_publish_artifacts_refuses_a_released_directory_even_with_overwrite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    released = {"chr11-5227002-T-A__v3__map-2026-08": "2026-10-17"}
    monkeypatch.setattr(publish_artifacts, "released_artifact_dirs", lambda: released)
    with pytest.raises(SystemExit, match="immutable"):
        publish_artifacts.refuse_released(
            DATA / "store" / "artifacts", ["chr11-5227002-T-A__v3__map-2026-08", "new__v4__map-2026-08"]
        )
    publish_artifacts.refuse_released(DATA / "store" / "artifacts", ["new__v4__map-2026-08"])


def test_publish_artifacts_to_a_scratch_directory_is_not_a_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def never(*args: object) -> dict[str, str]:
        raise AssertionError("a scratch --out is not checked against releases")

    monkeypatch.setattr(publish_artifacts, "released_artifact_dirs", never)
    publish_artifacts.refuse_released(tmp_path, ["chr11-5227002-T-A__v3__map-2026-08"])
