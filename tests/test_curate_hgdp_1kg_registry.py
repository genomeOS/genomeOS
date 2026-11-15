"""The 80 HGDP + 1KG identities: their curation from gnomAD's sample metadata, and their registry folder.

Atlas data platform design 2026-10-18 §1.2 D18 item 1, §2.3 and §2.4; step 1.7, phase-1 plan flags F1
and F2. The curation tests build a six-sample metadata file here. It has the real file's columns among
decoys, in another order, so a column is found only by its name (F2). Each test passes the file's own
digest as ``expected_sha256``. The real per-sample file is never committed.

``data/registry/hgdp_1kg/1.0.0/populations.tsv`` waits on the owner's answer to #508 (F1: the radius rule,
``location_type`` and the ``onekg`` notice). Until it exists, the tests marked ``waits_on_f1`` skip, and
the ``reference`` stage refuses to build. The stage's own tests run now on the synthetic fixture
``tests/fixtures/hgdp_1kg_populations.tsv``, placed at the same path.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pandas as pd
import pytest

from genomeos.registry.sources import hgdp, hgdp_1kg
from genomeos.tables import provenance, reference
from genomeos.validation import reference_cohorts
from scripts import build_data_release, build_tables
from scripts import curate_hgdp_1kg_registry as curation
from tests.tables_fixtures import EPOCH, ROOT
from tests.test_reference_tables import HGDP_FIXTURE, REGISTRY, _tree

COMMITTED = ROOT / "data" / build_tables.HGDP_1KG_REGISTRY
waits_on_f1 = pytest.mark.skipif(
    not COMMITTED.is_file(),
    reason=f"{build_tables.HGDP_1KG_REGISTRY} waits on the owner's F1 answer (#508)",
)
#: The registry inputs the stage tests read: the synthetic fixture now, the committed file once written.
REGISTRY_INPUTS = [
    pytest.param(HGDP_FIXTURE, id="synthetic-fixture"),
    pytest.param(COMMITTED, id="committed", marks=waits_on_f1),
]
#: The four labels gnomAD's display column merges into two (D18).
COLLIDING = ("Han", "NorthernHan", "PapuanHighlands", "PapuanSepik")

#: The real file's columns that the curation reads, among decoys. ``hgdp_tgp_meta.Population`` is the
#: 78-label display column, which merges NorthernHan into Han, and its latitude is never read.
COLUMNS = (
    "s",
    "hgdp_tgp_meta.Population",
    "hgdp_tgp_meta.Latitude",
    "population",
    "latitude",
    "longitude",
    "hgdp_tgp_meta.Project",
)
#: Six synthetic samples, two per population; every coordinate is synthetic.
SAMPLES = (
    ("SYN0001", "Han", "1.0", "Han", "32.5", "114.25", "HGDP"),
    ("SYN0002", "Han", "1.0", "Han", "32.5", "114.25", "HGDP"),
    ("SYN0003", "Han", "1.0", "NorthernHan", "34.5", "107.75", "HGDP"),
    ("SYN0004", "Han", "1.0", "NorthernHan", "34.5", "107.75", "HGDP"),
    ("SYN0005", "GBR", "1.0", "GBR", "52.75", "-1.875", "1000 Genomes"),
    ("SYN0006", "GBR", "1.0", "GBR", "52.75", "-1.875", "1000 Genomes"),
)
CURATED_LINES = [
    "alias_source\tpopulation\tlatitude\tlongitude",
    "hgdp\tHan\t32.5\t114.25",
    "hgdp\tNorthernHan\t34.5\t107.75",
    "onekg\tGBR\t52.75\t-1.875",
]


def _metadata(*edits: tuple[int, str, str], columns: tuple[str, ...] = COLUMNS) -> bytes:
    """The synthetic metadata, with each ``(sample, column, value)`` edit applied."""
    rows = [list(sample) for sample in SAMPLES]
    for sample, column, value in edits:
        rows[sample][COLUMNS.index(column)] = value
    kept = [COLUMNS.index(column) for column in columns]
    lines = [columns, *([row[at] for at in kept] for row in rows)]
    return "".join("\t".join(fields) + "\n" for fields in lines).encode("utf-8")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _curate(metadata: bytes) -> pd.DataFrame:
    return curation.curate(metadata, expected_sha256=_sha256(metadata))


def _pin(monkeypatch: pytest.MonkeyPatch, metadata: bytes) -> None:
    """Make ``main`` take the synthetic metadata as the pinned file of 3 identities."""
    monkeypatch.setattr(curation, "METADATA_SHA256", _sha256(metadata))
    monkeypatch.setattr(curation, "IDENTITIES", 3)


def _registry_input(path: Path, curated: pd.DataFrame, cites: str) -> Path:
    """A registry input over ``curated``'s rows, with synthetic radii and ``cites`` in each provenance."""
    rows = [
        (
            row.alias_source,
            row.population,
            repr(row.latitude),
            repr(row.longitude),
            "50",
            "ancestral" if row.alias_source == "hgdp" else "sampling",
            f"synthetic:curation-check-fixture; metadata sha256 {cites}",
            hgdp.BIOCULTURAL_NOTICE if row.alias_source == "hgdp" else "",
        )
        for row in curated.itertuples(index=False)
    ]
    lines = [hgdp_1kg.REQUIRED_COLUMNS, *rows]
    path.write_text("".join("\t".join(fields) + "\n" for fields in lines), encoding="utf-8")
    return path


# --- the curation (D18 item 1; F2) ---


def test_curate_writes_one_row_per_literal_population(tmp_path, monkeypatch, capsys):
    curated = _curate(_metadata())
    assert list(curated.columns) == list(curation.HEADER) == list(hgdp_1kg.REQUIRED_COLUMNS[:4])
    assert curated[["alias_source", "population"]].values.tolist() == [
        ["hgdp", "Han"],
        ["hgdp", "NorthernHan"],
        ["onekg", "GBR"],
    ]
    assert curated[["latitude", "longitude"]].values.tolist() == [
        [32.5, 114.25],
        [34.5, 107.75],
        [52.75, -1.875],
    ]
    # The script writes population-level rows only: no sample id leaves the per-sample file.
    metadata = tmp_path / "gnomad_meta_updated.tsv"
    metadata.write_bytes(_metadata())
    _pin(monkeypatch, _metadata())
    assert curation.main(["--metadata", str(metadata)]) == 0
    out, err = capsys.readouterr()
    assert out.splitlines() == CURATED_LINES
    assert "SYN000" not in out
    assert err.strip() == f"3 populations from metadata sha256 {_sha256(_metadata())}"


def test_curate_refuses_another_digest(tmp_path, capsys):
    with pytest.raises(ValueError, match="sha256"):
        curation.curate(_metadata())
    metadata = tmp_path / "gnomad_meta_updated.tsv"
    metadata.write_bytes(_metadata())
    assert curation.main(["--metadata", str(metadata)]) == 1
    out, err = capsys.readouterr()
    assert out == "" and curation.METADATA_SHA256 in err


def test_two_coordinates_for_one_population_are_refused():
    """A population has one place: two coordinates are refused, never averaged."""
    with pytest.raises(ValueError, match=r"population 'Han' \(hgdp\) has 2 coordinates") as refused:
        _curate(_metadata((1, "latitude", "32.75")))
    assert "(32.5, 114.25)" in str(refused.value) and "(32.75, 114.25)" in str(refused.value)
    # The same number written another way is the same coordinate.
    assert len(_curate(_metadata((1, "latitude", "32.50")))) == 3


@pytest.mark.parametrize(
    ("column", "value", "named"),
    [
        ("hgdp_tgp_meta.Project", "tgp", "project 'tgp'"),
        ("population", "", "population ''"),
        ("population", "NA", "population 'NA'"),
    ],
)
def test_an_unknown_project_or_blank_population_is_refused(column, value, named):
    with pytest.raises(ValueError, match=re.escape(named)):
        _curate(_metadata((0, column, value)))


@pytest.mark.parametrize(
    ("column", "value"),
    [("latitude", "NA"), ("latitude", "90.5"), ("longitude", "nan"), ("longitude", "-180.5")],
)
def test_a_coordinate_that_is_not_a_finite_wgs84_number_is_refused(column, value):
    with pytest.raises(ValueError, match=rf"{column} '{value}' of population 'Han'"):
        _curate(_metadata((0, column, value)))


def test_the_columns_are_read_by_name_from_the_header():
    """F2: the curation reads the header, so a missing column is named, never taken by position."""
    without = tuple(column for column in COLUMNS if column != "longitude")
    with pytest.raises(ValueError, match=r"lacks the columns \['longitude'\]"):
        _curate(_metadata(columns=without))
    reordered = tuple(reversed(COLUMNS))
    pd.testing.assert_frame_equal(_curate(_metadata(columns=reordered)), _curate(_metadata()))


def test_the_pinned_digest_is_the_full_hash():
    assert curation.METADATA_SHA256 == "e18e7a29d0567b8063edc1a714bd31e57dc422823ba51af2c63fecef0dbc3cf1"
    assert curation.METADATA_SHA256 == reference_cohorts.METADATA_SHA256
    assert curation.METADATA_URL.endswith(
        "/release/3.1/secondary_analyses/hgdp_1kg_v2/metadata_and_qc/gnomad_meta_updated.tsv"
    )


# --- --check: the registry input against the curation ---


def test_check_holds_the_registry_input_to_the_curation(tmp_path, monkeypatch, capsys):
    metadata = _metadata()
    digest = _sha256(metadata)
    curated = _curate(metadata)
    good = _registry_input(tmp_path / "good.tsv", curated, digest)
    assert curation.check(curated, good, expected_sha256=digest) == 3
    path = tmp_path / "gnomad_meta_updated.tsv"
    path.write_bytes(metadata)
    _pin(monkeypatch, metadata)
    assert curation.main(["--metadata", str(path), "--check", str(good)]) == 0
    assert capsys.readouterr().out == "3 populations match the pinned metadata\n"

    moved = _registry_input(tmp_path / "moved.tsv", curated.assign(latitude=[32.5, 34.5, 52.5]), digest)
    with pytest.raises(ValueError, match=r"1 curated rows are not in it .*'GBR', 52\.75"):
        curation.check(curated, moved, expected_sha256=digest)
    missing = _registry_input(tmp_path / "missing.tsv", curated.iloc[:2], digest)
    with pytest.raises(ValueError, match=r"1 curated rows are not in it .* 0 of its rows are not curated"):
        curation.check(curated, missing, expected_sha256=digest)
    uncited = _registry_input(tmp_path / "uncited.tsv", curated, "0" * 64)
    with pytest.raises(ValueError, match=rf"onekg-gbr.*does not name the metadata's sha256 {digest}"):
        curation.check(curated, uncited, expected_sha256=digest)
    assert curation.main(["--metadata", str(path), "--check", str(uncited)]) == 1
    # Every registry refusal applies: a blank radius is never filled.
    blank = tmp_path / "blank.tsv"
    blank.write_text(good.read_text(encoding="utf-8").replace("\t50\t", "\t\t", 1), encoding="utf-8")
    with pytest.raises(ValueError, match="uncertainty_radius_km"):
        curation.check(curated, blank, expected_sha256=digest)


def test_main_stops_unless_the_metadata_gives_80_identities(tmp_path, monkeypatch, capsys):
    """F2: fewer (or more) identities than D18's 80 stop the curation."""
    metadata = tmp_path / "gnomad_meta_updated.tsv"
    metadata.write_bytes(_metadata())
    monkeypatch.setattr(curation, "METADATA_SHA256", _sha256(_metadata()))
    assert curation.IDENTITIES == 80
    assert curation.main(["--metadata", str(metadata)]) == 1
    out, err = capsys.readouterr()
    assert out == "" and "3 populations, not D18's 80" in err


# --- the registry folder (step 1.7; §2.3, §2.4) ---


@waits_on_f1
def test_the_committed_registry_holds_80_identities():
    populations, aliases = hgdp_1kg.load(COMMITTED, reference.HGDP_1KG_RELEASE)
    assert len(populations) == len(aliases) == 80
    assert populations["population_id"].is_unique and aliases["population_id"].is_unique
    assert not aliases.duplicated(["source", "label"]).any()
    assert aliases["source"].value_counts().to_dict() == {"hgdp": 54, "onekg": 26}
    labels = set(zip(aliases["source"], aliases["label"], strict=True))
    assert {("hgdp", label) for label in COLLIDING} <= labels


@waits_on_f1
def test_every_coordinate_cites_the_pinned_metadata():
    populations, _ = hgdp_1kg.load(COMMITTED, reference.HGDP_1KG_RELEASE)
    assert populations["provenance"].str.contains(curation.METADATA_SHA256, regex=False).all()


@pytest.mark.parametrize("tsv", REGISTRY_INPUTS)
def test_the_registry_folder_carries_genomeos_and_gnomad_hgdp_1kg(tmp_path, tsv):
    tree = _tree(tmp_path, hgdp=tsv)
    built = build_tables.build_reference(tree.ctx)
    folder = reference.registry_folder(reference.hgdp_1kg_registry(tsv).registry_version)
    paths = [path for path in built if path.startswith(f"{REGISTRY}/{folder}/")]
    assert len(paths) == 2
    tsv_key = f"releases/{EPOCH}/{build_tables.HGDP_1KG_REGISTRY}"
    assert build_data_release.sources_for(tree.data, build_tables.HGDP_1KG_REGISTRY) == (
        "genomeos",
        "gnomad_hgdp_1kg",
    )
    for path in paths:
        kv = provenance.read_kv(tree.data / path)
        assert build_data_release.sources_for(tree.data, path) == ("genomeos", "gnomad_hgdp_1kg")
        assert [item["key"] for item in json.loads(kv["genomeos.inputs"])] == [tsv_key]


@pytest.mark.parametrize("tsv", REGISTRY_INPUTS)
def test_the_registry_version_and_folder(tsv):
    release = reference.hgdp_1kg_registry(tsv)
    assert re.fullmatch(r"1\.0\.0\+sha256\.[0-9a-f]{64}", release.registry_version)
    assert set(release.populations["registry_version"]) == {release.registry_version}
    digest = release.registry_version.removeprefix("1.0.0+sha256.")
    assert reference.reference_paths(release.registry_version) == (
        f"tables/v1/reference/populations/1.0.0-{digest[:8]}/populations.parquet",
        f"tables/v1/reference/populations/1.0.0-{digest[:8]}/population_aliases.parquet",
    )
    assert build_tables.HGDP_1KG_REGISTRY == "registry/hgdp_1kg/1.0.0/populations.tsv"
