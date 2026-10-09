"""Bucket layout contract for the public Atlas web data (design 2026-10-07 §C.1–§C.2)."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

from genomeos.publication.web_layout import (
    WebLayoutError,
    apply_download_layout,
    artifact_objects,
    assert_absolute_data_base,
    assert_bucket_name,
    assert_data_key,
    cors_policy,
    critical_objects,
    download_disposition,
    download_key,
    resolve_key,
    site_objects,
)
from tests.atlas_web_fixtures import (
    GNOMAD,
    GNOMAD_KEY,
    MANIFEST,
    OBSERVATIONS,
    RENDER,
    SURFACE,
    flat_catalog,
    sha256,
    staged_catalog,
)

ROOT = Path(__file__).resolve().parents[1]


def test_cors_policy_is_exactly_the_published_origin_list() -> None:
    assert cors_policy() == [
        {
            "origin": [
                "https://genome-os.org",
                "http://genome-os.org",
                "https://www.genome-os.org",
                "https://bschilder.github.io",
                "http://localhost:4321",
                "http://localhost:4322",
                "http://localhost:4323",
                "http://127.0.0.1:4321",
                "http://127.0.0.1:4322",
                "http://127.0.0.1:4323",
            ],
            "method": ["GET", "HEAD"],
            "responseHeader": ["Content-Length", "Content-Type", "Content-Encoding", "ETag"],
            "maxAgeSeconds": 3600,
        }
    ]
    committed = json.loads((ROOT / "deploy" / "atlas-web-cors.json").read_text(encoding="utf-8"))
    assert committed == cors_policy()


def test_download_keys_are_content_addressed_and_saved_under_the_canonical_name() -> None:
    digest = sha256(SURFACE)
    assert download_key("hbs-test", "v1", "map-test", "surface", digest) == (
        f"downloads/hbs-test/v1/map-test/hbs-test.surface.{digest[:16]}.json"
    )
    assert download_disposition("hbs-test", "surface") == 'attachment; filename="hbs-test.surface.json"'
    with pytest.raises(WebLayoutError, match="download kind"):
        download_key("hbs-test", "v1", "map-test", "render", digest)
    with pytest.raises(WebLayoutError, match="invalid data key"):
        download_key("HbS", "v1", "map-test", "surface", digest)


def test_download_layout_rewrites_only_the_json_urls_and_keeps_every_digest() -> None:
    before = flat_catalog()
    after, copies = apply_download_layout(before)
    ref = after["artifacts"][0]
    prefix = "downloads/hbs-test/v1/map-test/hbs-test"
    assert ref["downloads"]["surface"]["url"] == f"{prefix}.surface.{sha256(SURFACE)[:16]}.json"
    assert ref["downloads"]["observations"]["url"] == (
        f"{prefix}.observations.{sha256(OBSERVATIONS)[:16]}.json"
    )
    assert ref["downloads"]["manifest"]["url"] == f"{prefix}.manifest.{sha256(MANIFEST)[:16]}.json"
    assert ref["surface_url"] == ref["downloads"]["surface"]["url"]
    assert ref["observations_url"] == ref["downloads"]["observations"]["url"]
    assert [(item.source, item.key, item.sha256) for item in copies] == [
        ("hbs-test.manifest.json", ref["downloads"]["manifest"]["url"], sha256(MANIFEST)),
        ("hbs-test.observations.json", ref["downloads"]["observations"]["url"], sha256(OBSERVATIONS)),
        ("hbs-test.surface.json", ref["downloads"]["surface"]["url"], sha256(SURFACE)),
    ]
    restored = json.loads(json.dumps(after))
    restored_ref = restored["artifacts"][0]
    restored_ref["surface_url"] = "hbs-test.surface.json"
    restored_ref["observations_url"] = "hbs-test.observations.json"
    for kind in ("surface", "observations", "manifest"):
        restored_ref["downloads"][kind]["url"] = f"hbs-test.{kind}.json"
    assert restored == before  # only the six URL fields changed; every sha256 is identical
    assert before == flat_catalog()  # the input is not mutated


def test_download_layout_is_a_no_op_on_its_own_output() -> None:
    once, _ = apply_download_layout(flat_catalog())
    twice, copies = apply_download_layout(once)
    assert twice == once
    assert all(item.source == item.key for item in copies)


def test_download_layout_skips_observations_that_were_never_published() -> None:
    catalog = flat_catalog()
    ref = catalog["artifacts"][0]
    ref.update(
        observations_available=False,
        observations_bytes=None,
        observations_sha256=None,
        observations_url=None,
    )
    ref["downloads"]["observations"] = None
    after, copies = apply_download_layout(catalog)
    assert after["artifacts"][0]["observations_url"] is None
    assert after["artifacts"][0]["downloads"]["observations"] is None
    assert [item.source for item in copies] == ["hbs-test.manifest.json", "hbs-test.surface.json"]


def test_download_layout_refuses_a_surface_digest_that_disagrees_with_its_download() -> None:
    catalog = flat_catalog()
    catalog["artifacts"][0]["surface_sha256"] = "0" * 64
    with pytest.raises(WebLayoutError, match="surface_sha256"):
        apply_download_layout(catalog)


def test_artifact_objects_share_json_keys_and_carry_declared_decoded_sizes() -> None:
    catalog = staged_catalog()
    objects = {item.key: item for item in artifact_objects(catalog)}
    assert len(objects) == 6  # grid, render, detail and three JSON objects (urls shared with downloads)
    assert list(objects) == sorted(objects)
    ref = catalog["artifacts"][0]
    surface = objects[ref["surface_url"]]
    assert (surface.decoded_bytes, surface.content_type, surface.content_disposition) == (
        None,
        "application/json",
        'attachment; filename="hbs-test.surface.json"',
    )
    assert objects[ref["observations_url"]].decoded_bytes == len(OBSERVATIONS)
    render = objects[ref["web"]["render"]["url"]]
    assert (render.decoded_bytes, render.content_type, render.content_disposition) == (
        len(RENDER),
        "application/octet-stream",
        None,
    )


def test_artifact_objects_refuse_a_key_that_is_not_content_addressed() -> None:
    with pytest.raises(WebLayoutError, match="not content-addressed"):
        artifact_objects(flat_catalog())


def test_site_objects_and_the_critical_path() -> None:
    catalog = staged_catalog()
    assert [(item.key, item.sha256) for item in site_objects(catalog)] == [
        (GNOMAD_KEY, sha256(GNOMAD)),
        ("ne-50m-admin-0.geojson", None),
    ]
    ref = catalog["artifacts"][0]
    assert [item.key for item in critical_objects(catalog)] == [
        catalog["grids"][ref["web"]["grid_sha256"]]["url"],
        ref["web"]["render"]["url"],
        ref["observations_url"],
    ]


@pytest.mark.parametrize(
    "base",
    [
        "https://storage.googleapis.com/example-bucket/atlas/web/",
        "http://127.0.0.1:4323/",
        "http://localhost:4323/atlas/web/",
    ],
)
def test_absolute_bases_the_gate_accepts(base: str) -> None:
    assert assert_absolute_data_base(base) == base


@pytest.mark.parametrize(
    "base",
    [
        "",
        "/data/atlas/",
        "//cdn.example.org/atlas/web/",
        "https://storage.googleapis.com/example-bucket/atlas/web",
        "http://genome-os.org/atlas/web/",
        "ftp://example.org/atlas/web/",
        "https://example.org/atlas/web/?v=1",
    ],
)
def test_bases_the_gate_refuses(base: str) -> None:
    with pytest.raises(WebLayoutError):
        assert_absolute_data_base(base)


def test_keys_resolve_like_the_browser_resolver() -> None:
    base = "https://storage.googleapis.com/example-bucket/atlas/web/"
    key = "grids/h3-r4.0123456789abcdef.gosa"
    assert resolve_key(key, base) == base + key


@pytest.mark.parametrize(
    "key",
    ["", "../catalog.json", "/grids/x.gosa", "https://example.org/x.json", "Grids/x.gosa", "a/../b.json"],
)
def test_invalid_keys_are_refused(key: str) -> None:
    with pytest.raises(WebLayoutError, match="invalid data key"):
        assert_data_key(key)


@pytest.mark.parametrize("name", ["", "ab", "Example-bucket", "-bad", "bad..name", "a" * 64])
def test_invalid_bucket_names_are_refused(name: str) -> None:
    with pytest.raises(WebLayoutError, match="bucket name"):
        assert_bucket_name(name)


def test_no_concrete_bucket_url_is_tracked() -> None:
    """No bucket name is committed (design §C.1.4; docs/repo-gcloud-auth.md)."""
    found = subprocess.run(
        ["git", "grep", "-n", "-I", "-E", r"storage\.googleapis\.com/[a-z0-9]"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert found.returncode in (0, 1), found.stderr
    concrete = re.compile(r"storage\.googleapis\.com/(?!storage/v1/|example-[a-z0-9.-]*/)[a-z0-9]")
    assert [line for line in found.stdout.splitlines() if concrete.search(line)] == []
