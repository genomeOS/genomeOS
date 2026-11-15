"""The meta.* tables over the committed manifests and web catalog.

Atlas data platform design 2026-10-18 §2.4, §2.9.

Only the two manifests in ``COMMITTED_RELEASES`` are read, so a later release PR leaves the counts alone.
"""

from __future__ import annotations

import json

import pytest

from genomeos.publication import data_release as dr
from genomeos.tables import contracts, meta, provenance
from genomeos.tables.contracts import TableError
from tests.tables_fixtures import ROOT, committed_manifests

MANIFESTS = committed_manifests()
PUBLISHED = provenance.published_paths(MANIFESTS)
WEB_CATALOG = json.loads((ROOT / meta.WEB_CATALOG).read_text(encoding="utf-8"))
G6PD = "phenotype__g6pd-deficiency__v3__map-2026-08"


def _withdrawal(key: str, sha256: str) -> dr.Withdrawal:
    return dr.Withdrawal(
        key, sha256, "a takedown", "https://github.com/genomeOS/genomeOS/issues/1", "2026-11-20", "owner"
    )


def test_release_objects_lists_every_earlier_object_under_its_first_key():
    frame = meta.release_objects_frame(MANIFESTS)
    assert list(frame.columns) == list(contracts.columns("meta.release_objects"))
    assert len(frame) == 245 + 248
    assert frame["release"].value_counts().to_dict() == {"2026-10-17": 245, "2026-10-18": 248}
    (row,) = frame[
        (frame["release"] == "2026-10-18") & (frame["path"] == "raw/afnd_populations.tsv")
    ].to_dict("records")
    assert row["key"] == "releases/2026-10-17/raw/afnd_populations.tsv"
    assert list(row["sources"]) == ["afnd"]


def test_sources_lists_each_release_source():
    frame = meta.sources_frame(MANIFESTS)
    assert list(frame.columns) == list(contracts.columns("meta.sources"))
    assert len(frame) == 14
    genereviews = frame[frame["source"] == "genereviews"]
    assert genereviews["non_commercial"].tolist() == [True, True]
    # The legacy restriction_found reads as restricted (§9), so one vocabulary spans every release.
    assert genereviews["terms_status"].tolist() == ["restricted", "restricted"]


def test_served_is_the_web_catalogs_30():
    frame = meta.served_frame(WEB_CATALOG, released_artifacts=meta.released_artifacts(PUBLISHED))
    assert list(frame.columns) == list(contracts.columns("meta.served"))
    assert len(frame) == 30
    (g6pd,) = frame[frame["variant_id"] == "phenotype:g6pd-deficiency"].to_dict("records")
    manifest = PUBLISHED[f"{dr.ARTIFACT_PREFIX}{G6PD}/manifest.json"]
    assert (g6pd["artifact"], g6pd["pinned_by"], g6pd["pinned_sha256"]) == (
        G6PD,
        f"git:{meta.WEB_CATALOG}",
        manifest.sha256,
    )


def test_served_inputs_are_the_catalog_and_each_served_manifest():
    inputs = meta.served_inputs(WEB_CATALOG, "c" * 64, published=PUBLISHED)
    assert len(inputs) == 31 and inputs == tuple(sorted(inputs))
    assert provenance.InputRef(f"git:{meta.WEB_CATALOG}", "c" * 64) in inputs
    manifest = PUBLISHED[f"{dr.ARTIFACT_PREFIX}{G6PD}/manifest.json"]
    assert provenance.InputRef(manifest.key, manifest.sha256) in inputs


def test_an_artifact_served_but_never_released_is_refused():
    catalog = {
        "artifacts": [*WEB_CATALOG["artifacts"], {**WEB_CATALOG["artifacts"][0], "model_version": "v9"}]
    }
    with pytest.raises(TableError, match="chr11-5227002-T-A__v9__map-2026-08"):
        meta.served_frame(catalog, released_artifacts=meta.released_artifacts(PUBLISHED))
    with pytest.raises(TableError, match="chr11-5227002-T-A__v9__map-2026-08"):
        meta.served_inputs(catalog, "c" * 64, published=PUBLISHED)


def test_an_artifact_served_twice_is_refused():
    catalog = {"artifacts": [*WEB_CATALOG["artifacts"], WEB_CATALOG["artifacts"][0]]}
    with pytest.raises(TableError, match="twice"):
        meta.served_frame(catalog, released_artifacts=meta.released_artifacts(PUBLISHED))


def test_withdrawn_is_empty_for_the_committed_list():
    document = json.loads((ROOT / meta.WITHDRAWN_LIST).read_text(encoding="utf-8"))
    frame = meta.withdrawn_frame(dr.validate_withdrawn(document), published=PUBLISHED)
    assert list(frame.columns) == list(contracts.columns("meta.withdrawn")) and len(frame) == 0


def test_a_withdrawal_names_the_published_path_and_an_unpublished_key_is_refused():
    item = PUBLISHED["raw/afnd_populations.tsv"]
    frame = meta.withdrawn_frame([_withdrawal(item.key, item.sha256)], published=PUBLISHED)
    assert frame[["key", "path", "sha256"]].values.tolist() == [[item.key, item.path, item.sha256]]
    with pytest.raises(TableError, match="not a published object"):
        meta.withdrawn_frame([_withdrawal(item.key, "f" * 64)], published=PUBLISHED)
    with pytest.raises(TableError, match="not a published object"):
        meta.withdrawn_frame(
            [_withdrawal("releases/2026-10-18/raw/afnd_populations.tsv", item.sha256)], published=PUBLISHED
        )


def test_artifact_directory_name():
    assert meta.artifact_directory_name("kir:2dl1", "v3", "afnd-2026-08") == "kir__2dl1__v3__afnd-2026-08"
    assert (
        meta.artifact_directory_name("chr11-5227002-T-A", "v3", "map-2026-08")
        == "chr11-5227002-T-A__v3__map-2026-08"
    )
    with pytest.raises(TableError, match="directory"):
        meta.artifact_directory_name("hla:a*02:01", "v3", "afnd-2026-08")
