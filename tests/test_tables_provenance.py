"""A tables/ file's inputs and the sources they carry (Atlas data platform design 2026-10-18 §2.1, §9).

Builder's call 16: a derived file's sources are the union of its inputs'.
"""

from __future__ import annotations

import hashlib

import pytest

from genomeos.tables import provenance
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import InputRef
from tests.tables_fixtures import ROOT, committed_manifests

MANIFESTS = {manifest["release"]: manifest for manifest in committed_manifests()}
CATALOG = "git:website/public/data/atlas/catalog.json"


def _released(key: str) -> InputRef:
    """``key`` with the sha256 its publishing manifest records."""
    release = key.split("/")[1]
    (item,) = [item for item in MANIFESTS[release]["objects"] if item["key"] == key]
    return InputRef(key, item["sha256"])


def _sources(ref: InputRef, new_sources=None) -> tuple[str, ...]:
    return provenance.sources_of(ref, manifests=MANIFESTS, new_sources=new_sources or {})


def test_inputs_encode_canonically_and_round_trip():
    refs = [
        InputRef("releases/2026-10-18/x.parquet", "b" * 64),
        InputRef("manifests/2026-10-17.json", "a" * 64),
    ]
    text = provenance.encode_inputs(refs)
    assert text == (
        f'[{{"key":"manifests/2026-10-17.json","sha256":"{"a" * 64}"}},'
        f'{{"key":"releases/2026-10-18/x.parquet","sha256":"{"b" * 64}"}}]'
    )
    assert provenance.decode_inputs(text) == tuple(sorted(refs))


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        '{"key": "git:README.md"}',
        f'[{{"key":"git:README.md","sha256":"{"a" * 64}","note":"x"}}]',
        f'[{{"key": "git:README.md", "sha256": "{"a" * 64}"}}]',
    ],
    ids=["not-json", "not-a-list", "an-extra-field", "not-canonical"],
)
def test_inputs_that_are_not_the_canonical_list_are_refused(text):
    with pytest.raises(TableError, match="genomeos.inputs"):
        provenance.decode_inputs(text)


def test_one_input_key_with_two_digests_is_refused():
    with pytest.raises(TableError, match="two sha256"):
        provenance.encode_inputs([InputRef(CATALOG, "a" * 64), InputRef(CATALOG, "b" * 64)])


@pytest.mark.parametrize("key", ["gs://b/x", "releases/x/y", "manifests/latest.json", "git:/abs", ""])
def test_an_input_ref_outside_the_three_forms_is_refused(key):
    with pytest.raises(TableError, match="input"):
        InputRef(key, "a" * 64)


def test_an_input_ref_needs_a_full_sha256():
    with pytest.raises(TableError, match="sha256"):
        InputRef(CATALOG, "A" * 64)


def test_a_manifest_ref_carries_every_source_of_its_manifest():
    digest = hashlib.sha256((ROOT / "data/releases/2026-10-18.json").read_bytes()).hexdigest()
    assert _sources(InputRef("manifests/2026-10-18.json", digest)) == (
        "afnd",
        "clinvar",
        "cpic",
        "genereviews",
        "genomeos",
        "map",
        "worldpop",
    )
    assert provenance.manifest_ref(MANIFESTS["2026-10-18"]) == InputRef("manifests/2026-10-18.json", digest)


def test_a_released_key_carries_the_sources_its_manifest_records():
    assert _sources(_released("releases/2026-10-17/raw/afnd_populations.tsv")) == ("afnd",)


def test_an_input_whose_digest_is_not_the_published_ones_is_refused():
    key = "releases/2026-10-17/raw/afnd_populations.tsv"
    with pytest.raises(TableError, match="sha256"):
        _sources(InputRef(key, "f" * 64))
    with pytest.raises(TableError, match="sha256"):
        _sources(InputRef("manifests/2026-10-18.json", "f" * 64))


def test_a_key_no_manifest_publishes_is_refused_unless_this_release_wrote_it():
    with pytest.raises(TableError, match="does not publish"):
        _sources(InputRef("releases/2026-10-17/raw/nothing.tsv", "a" * 64))
    this_release = InputRef("releases/2026-11-20/tables/v1/meta/served.parquet", "a" * 64)
    with pytest.raises(TableError, match="no source"):
        _sources(this_release)
    assert _sources(this_release, {"tables/v1/meta/served.parquet": ("genomeos",)}) == ("genomeos",)


def test_a_git_ref_takes_its_reviewed_sources_and_an_unlisted_one_is_refused():
    assert _sources(InputRef(CATALOG, "a" * 64)) == ("genomeos",)
    with pytest.raises(TableError, match="no reviewed sources"):
        _sources(InputRef("git:README.md", "a" * 64))


def test_a_non_commercial_source_survives_the_union():
    """Builder's call 16: a derived file carries GeneReviews, so the non-commercial marker follows it."""
    linked = _released("releases/2026-10-17/sources/curated/SOURCE.json")
    union = provenance.union_sources(
        [linked, InputRef(CATALOG, "a" * 64)], manifests=MANIFESTS, new_sources={}
    )
    assert union == ("clinvar", "genereviews", "genomeos")
    assert MANIFESTS["2026-10-17"]["sources"]["genereviews"]["non_commercial"] is True


def test_published_paths_name_each_paths_first_publication():
    published = provenance.published_paths(list(MANIFESTS.values()))
    assert published["raw/afnd_populations.tsv"].key == "releases/2026-10-17/raw/afnd_populations.tsv"
    assert len(published) == len({item["path"] for m in MANIFESTS.values() for item in m["objects"]})
