"""Bucket layout contract for the public Atlas web data (design 2026-10-07 §C.1–§C.2)."""

from __future__ import annotations

import copy
import json
import re
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

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

# Each breaks one artifact ref's downloads against the catalog contract: surface and manifest are
# required, and the observations download exists exactly when observations_available is true.
DOWNLOAD_DEFECTS = [
    pytest.param(
        lambda ref: ref["downloads"].update(surface=None), "downloads.surface is missing", id="surface-null"
    ),
    pytest.param(
        lambda ref: ref["downloads"].pop("manifest"), "downloads.manifest is missing", id="manifest-absent"
    ),
    pytest.param(
        lambda ref: ref["downloads"].update(observations=None),
        "downloads.observations is missing",
        id="observations-null-while-available",
    ),
    pytest.param(
        lambda ref: ref.update(observations_available=False),
        "observations_available is false",
        id="observations-while-unavailable",
    ),
    pytest.param(
        lambda ref: ref.update(observations_available=None), "is not a boolean", id="availability-not-boolean"
    ),
]
MALFORMED_DIGESTS = [None, "", "A" * 64, "0" * 63]


def test_cors_policy_is_exactly_the_published_origin_list() -> None:
    assert cors_policy() == [
        {
            "origin": [
                "https://genome-os.org",
                "https://www.genome-os.org",
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
    with pytest.raises(WebLayoutError, match="invalid sha256"):
        download_key("hbs-test", "v1", "map-test", "surface", digest[:63])


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


@pytest.mark.parametrize(("defect", "message"), DOWNLOAD_DEFECTS)
def test_download_layout_refuses_a_missing_or_unexpected_download(
    defect: Callable[[dict[str, Any]], object], message: str
) -> None:
    catalog = flat_catalog()
    defect(catalog["artifacts"][0])
    with pytest.raises(WebLayoutError, match=message):
        apply_download_layout(catalog)


@pytest.mark.parametrize("field", ["url", "sha256"])
def test_download_layout_refuses_two_downloads_that_share_a_key(field: str) -> None:
    """A second source file, or a second digest with the same 16-digit prefix, for one download key."""
    catalog = flat_catalog()
    twin = copy.deepcopy(catalog["artifacts"][0])
    surface = twin["downloads"]["surface"]
    if field == "url":
        surface["url"] = "elsewhere/hbs-test.surface.json"
    else:
        surface["sha256"] = twin["surface_sha256"] = surface["sha256"][:16] + "0" * 48
    catalog["artifacts"].append(twin)
    with pytest.raises(WebLayoutError, match="two downloads share this key"):
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


@pytest.mark.parametrize(("defect", "message"), DOWNLOAD_DEFECTS)
def test_artifact_objects_refuse_a_missing_or_unexpected_download(
    defect: Callable[[dict[str, Any]], object], message: str
) -> None:
    catalog = staged_catalog()
    defect(catalog["artifacts"][0])
    with pytest.raises(WebLayoutError, match=message):
        artifact_objects(catalog)


@pytest.mark.parametrize(
    ("alias", "message"),
    [
        pytest.param(
            lambda web: {**web["render"], "sha256": web["render"]["sha256"][:16] + "0" * 48},
            "named with two digests",
            id="digest",
        ),
        pytest.param(
            lambda web: {**web["render"], "bytes": web["render"]["bytes"] + 1},
            "two declared decoded sizes",
            id="decoded-size",
        ),
    ],
)
def test_artifact_objects_refuse_one_key_declared_two_ways(
    alias: Callable[[dict[str, Any]], dict[str, Any]], message: str
) -> None:
    catalog = staged_catalog()
    web = catalog["artifacts"][0]["web"]
    web["detail"] = alias(web)  # the detail tier names the render key with another digest or size
    with pytest.raises(WebLayoutError, match=message):
        artifact_objects(catalog)


def test_artifact_objects_refuse_one_key_saved_under_two_filenames() -> None:
    catalog = staged_catalog()
    downloads = catalog["artifacts"][0]["downloads"]
    downloads["manifest"] = {**downloads["surface"], "label": "Artifact manifest"}
    with pytest.raises(WebLayoutError, match="two declared content dispositions"):
        artifact_objects(catalog)


@pytest.mark.parametrize("declared", [0, -1, True, 1.5, "31"])
def test_artifact_objects_refuse_a_declared_size_that_is_not_a_positive_integer(declared: object) -> None:
    catalog = staged_catalog()
    catalog["artifacts"][0]["web"]["render"]["bytes"] = declared
    with pytest.raises(WebLayoutError, match="is not a positive integer"):
        artifact_objects(catalog)


@pytest.mark.parametrize("digest", MALFORMED_DIGESTS)
def test_artifact_objects_refuse_a_malformed_digest(digest: object) -> None:
    catalog = staged_catalog()
    catalog["artifacts"][0]["web"]["render"]["sha256"] = digest
    with pytest.raises(WebLayoutError, match="invalid sha256"):
        artifact_objects(catalog)


def test_artifact_objects_refuse_an_extension_with_no_published_content_type() -> None:
    catalog = staged_catalog()
    render = catalog["artifacts"][0]["web"]["render"]
    render["url"] = render["url"].removesuffix(".gosa") + ".bin"
    with pytest.raises(WebLayoutError, match="no published content type for '.bin'"):
        artifact_objects(catalog)


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


def test_the_critical_path_refuses_a_default_artifact_whose_grid_is_not_declared() -> None:
    catalog = staged_catalog()
    catalog["artifacts"][0]["web"]["grid_sha256"] = "b2" * 32
    with pytest.raises(WebLayoutError, match="names no catalog grid"):
        critical_objects(catalog)


def test_site_objects_list_a_cache_named_twice_with_one_digest_once() -> None:
    catalog = staged_catalog()
    catalog["artifacts"].append(copy.deepcopy(catalog["artifacts"][0]))
    catalog["context_sources"].append({"id": "gnomad-cache-twin", "url": GNOMAD_KEY})
    assert [(item.key, item.sha256) for item in site_objects(catalog)] == [
        (GNOMAD_KEY, sha256(GNOMAD)),
        ("ne-50m-admin-0.geojson", None),
    ]


def test_site_objects_refuse_one_cache_key_with_two_digests() -> None:
    catalog = staged_catalog()
    resources = catalog["artifacts"][0]["external_resources"]
    resources.append({**resources[0], "cache_sha256": "0" * 64})
    with pytest.raises(WebLayoutError, match="two declared cache sha256s"):
        site_objects(catalog)


@pytest.mark.parametrize("digest", MALFORMED_DIGESTS)
def test_site_objects_refuse_a_malformed_cache_digest(digest: object) -> None:
    catalog = staged_catalog()
    catalog["artifacts"][0]["external_resources"][0]["cache_sha256"] = digest
    with pytest.raises(WebLayoutError, match="cache: invalid sha256"):
        site_objects(catalog)


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


NOT_ABSOLUTE = "must be an absolute https:// URL"


@pytest.mark.parametrize(
    ("base", "message"),
    [
        ("", "the artifact data base is empty"),
        ("/data/atlas/", NOT_ABSOLUTE),
        ("//cdn.example.org/atlas/web/", NOT_ABSOLUTE),
        ("https://storage.googleapis.com/example-bucket/atlas/web", NOT_ABSOLUTE),
        ("http://genome-os.org/atlas/web/", NOT_ABSOLUTE),
        ("ftp://example.org/atlas/web/", NOT_ABSOLUTE),
        ("https://example.org/atlas/web/?v=1", NOT_ABSOLUTE),
        ("https://example.org/atlas/web/#top", NOT_ABSOLUTE),
    ],
)
def test_bases_the_gate_refuses(base: str, message: str) -> None:
    with pytest.raises(WebLayoutError, match=re.escape(message)):
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


# Public data buckets owned by third parties that the pipeline reads; never the project's bucket.
THIRD_PARTY_PUBLIC_BUCKETS = frozenset({"gcp-public-data--gnomad"})
# A bucket named in any GCS URL form: gs:// (past any userinfo), path-style, virtual-hosted, the
# JSON/upload/download API and the console. Placeholders (<bucket>, $VAR, {var}, %s) do not start
# with [a-z0-9].
_BUCKET_REFERENCE = re.compile(
    r"(?:gs://(?:[^\s/@]+@)?"
    r"|(?<![a-z0-9._-])(?:commondatastorage\.googleapis\.com|storage\.googleapis\.com|storage\.cloud\.google\.com)"
    r"/(?!(?:upload/|download/|batch/)?storage/v1/)"
    r"|googleapis\.com/(?:upload/|download/)?storage/v1/b/"
    r"|console\.cloud\.google\.com/storage/browser/(?:_details/)?)"
    r"(?P<path>[a-z0-9][a-z0-9._-]*)(?![a-z0-9._-]*@)"  # a token before '@' is userinfo
    r"|(?<![a-z0-9._-])(?P<host>[a-z0-9][a-z0-9._-]*)\.storage\.googleapis\.com"
)
# Assembled at run time so this file names no concrete bucket in its own source.
CONCRETE = "concrete" + "-bucket"


def _concrete_bucket_names(text: str) -> list[str]:
    """Bucket names in ``text``, less ``example-*`` placeholders and third-party public buckets."""
    names = (match["path"] or match["host"] for match in _BUCKET_REFERENCE.finditer(text))
    return [
        name
        for name in names
        if len(name) >= 3 and not name.startswith("example-") and name not in THIRD_PARTY_PUBLIC_BUCKETS
    ]


@pytest.mark.parametrize(
    "text",
    [
        f"https://storage.googleapis.com/{CONCRETE}/atlas/web/",
        f"https://{CONCRETE}.storage.googleapis.com/atlas/web/x.json",
        f'python scripts/gcloud_repo.py run storage ls "gs://{CONCRETE}/atlas/web/"',
        f"gs://user@{CONCRETE}/atlas/web/x.json",
        f"https://storage.cloud.google.com/{CONCRETE}/atlas/web/x.json",
        f"https://commondatastorage.googleapis.com/{CONCRETE}/atlas/web/x.json",
        f"https://storage.googleapis.com/storage/v1/b/{CONCRETE}/o?maxResults=1",
        f"https://www.googleapis.com/storage/v1/b/{CONCRETE}/o/atlas%2Fweb%2Fx.json",
        f"https://storage.googleapis.com/download/storage/v1/b/{CONCRETE}/o/x?alt=media",
        f"https://storage.googleapis.com/upload/storage/v1/b/{CONCRETE}/o?uploadType=media",
        f"https://console.cloud.google.com/storage/browser/{CONCRETE}/atlas/web",
        f"https://console.cloud.google.com/storage/browser/_details/{CONCRETE}/atlas/web/x.json",
    ],
)
def test_bucket_url_hygiene_finds_a_bucket_in_every_url_form(text: str) -> None:
    assert _concrete_bucket_names(text) == [CONCRETE]


@pytest.mark.parametrize(
    "text",
    [
        "https://storage.googleapis.com/example-bucket/atlas/web/",
        "https://example-bucket.storage.googleapis.com/atlas/web/",
        "gs://example-bucket/atlas/web/x.json",
        "https://storage.googleapis.com/<bucket>/atlas/web/",
        'gs://$ATLAS_DATA_BUCKET/atlas/web/* and "https://storage.googleapis.com/${ATLAS_DATA_BUCKET}/"',
        'f"gs://{bucket}/{key}" and "https://storage.googleapis.com/%s/atlas/web/"',
        'JSON_API_ROOT = "https://storage.googleapis.com/storage/v1/" and gs://… and "gs://b/o"',
        "services enable storage.googleapis.com --filter='config.name=storage.googleapis.com'",
        "gs://gcp-public-data--gnomad/release/3.1.2/vcf/genomes/",
        "gs://user@gcp-public-data--gnomad/release/3.1.2/vcf/genomes/",
        'f"gs://user@{bucket}/{key}"',
    ],
)
def test_bucket_url_hygiene_passes_placeholders_and_third_party_data(text: str) -> None:
    assert _concrete_bucket_names(text) == []


def test_no_concrete_bucket_url_is_tracked() -> None:
    """No bucket name of the project's is committed, in any URL form (design §C.1.4;
    docs/repo-gcloud-auth.md)."""
    found = subprocess.run(
        [
            "git",
            "grep",
            "-n",
            "-I",
            "-E",
            r"gs://|googleapis\.com|storage\.cloud\.google\.com|console\.cloud\.google\.com/storage",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert found.returncode in (0, 1), found.stderr
    assert [line for line in found.stdout.splitlines() if _concrete_bucket_names(line)] == []
