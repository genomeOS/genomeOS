"""The population registry under ``tables/v1/reference/`` and check 5.

Atlas data platform design 2026-10-18 §2.3, §2.4, §2.7 check 5; builder's calls 5, 6 and 18. A
``reference_tree`` is a ``data/`` tree with no committed release, holding ``AFND_REGISTRY_FIXTURE`` as
``raw/afnd_populations.tsv`` and the MAP survey fixtures as the MAP harvest's two files.

``AFND_REGISTRY_FIXTURE`` is the AFND population fixture without the two rows the AFND adapter refuses
(a blank latitude and a blank accession). A refused row stops the registry build (v1 §12), so only
``test_a_row_afnd_refuses_stops_the_registry_build_before_writing`` reads the full fixture.

A ``reference_tree`` also holds ``HGDP_FIXTURE``, the synthetic seven-row HGDP + 1KG input, at
``build_tables.HGDP_1KG_REGISTRY`` (step 1.7): the stage stops without that file. Its folder,
``HGDP_FOLDER``, is ``1.0.0-<sha8>`` of its ``registry_version``, which covers the registry code's bytes,
so it is computed, never written out.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import pytest

from genomeos.registry.sources import afnd as afnd_registry
from genomeos.tables import contracts, provenance, reference, write_once
from genomeos.tables.contracts import TableError
from genomeos.tables.reference import AFND_LEGACY, MAP_LEGACY
from scripts import build_tables
from tests.observation_fixtures import observation_rows
from tests.tables_fixtures import EPOCH, GIT_SHA, ROOT, FixtureTree, commit_release

FIXTURES = Path(__file__).parent / "fixtures"
#: Nine rows, two of which the AFND adapter refuses.
AFND_FIXTURE = FIXTURES / "afnd_populations.tsv"
#: ``AFND_FIXTURE``'s seven rows the adapter keeps.
AFND_REGISTRY_FIXTURE = FIXTURES / "afnd_registry_populations.tsv"
MAP_FIXTURES = (FIXTURES / "map_hbs_surveys.csv", FIXTURES / "map_g6pd_surveys.csv")
#: Seven synthetic HGDP + 1KG rows (Task 17's fixture); every coordinate and radius in it is synthetic.
HGDP_FIXTURE = FIXTURES / "hgdp_1kg_populations.tsv"
LATER = "2026-11-21"
REGISTRY = "tables/v1/reference/populations"
HGDP_FOLDER = reference.registry_folder(reference.hgdp_1kg_registry(HGDP_FIXTURE).registry_version)
AFND_BUILT = (
    f"{REGISTRY}/afnd-2026-08/populations.parquet",
    f"{REGISTRY}/afnd-2026-08/population_aliases.parquet",
)
BUILT = sorted(
    [
        *AFND_BUILT,
        f"{REGISTRY}/map-survey-coordinates-v1/population_aliases.parquet",
        f"{REGISTRY}/{HGDP_FOLDER}/populations.parquet",
        f"{REGISTRY}/{HGDP_FOLDER}/population_aliases.parquet",
    ]
)
POPULATIONS_KEY = contracts.TABLE_CONTRACTS["reference.populations"].key


def _tree(root: Path, *, afnd: Path = AFND_REGISTRY_FIXTURE, hgdp: Path = HGDP_FIXTURE) -> FixtureTree:
    """A ``reference_tree`` under ``root``, holding ``afnd`` as the AFND population file and ``hgdp`` as
    the HGDP + 1KG registry input."""
    tree = FixtureTree(root, root / "data", root / "releases")
    inputs = {
        build_tables.AFND_POPULATIONS: afnd,
        **dict(zip(build_tables.MAP_SURVEYS, MAP_FIXTURES, strict=True)),
        build_tables.HGDP_1KG_REGISTRY: hgdp,
    }
    for path, fixture in inputs.items():
        (tree.data / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(fixture, tree.data / path)
    return tree


@pytest.fixture
def reference_tree(tmp_path: Path) -> FixtureTree:
    return _tree(tmp_path)


def _digests(data: Path) -> dict[str, str]:
    return {
        path.relative_to(data).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((data / REGISTRY).rglob("*"))
        if path.is_file()
    }


def test_registry_folder_names():
    assert reference.registry_folder("1.0.0+sha256.0123abcd" + "0" * 56) == "1.0.0-0123abcd"
    assert reference.registry_folder(AFND_LEGACY) == "afnd-2026-08"
    assert reference.registry_folder(MAP_LEGACY) == "map-survey-coordinates-v1"
    for version in ("afnd-2026-09", "1.0.0", "1.0.0+sha256.0123abcd", "01.0.0+sha256." + "0" * 64):
        with pytest.raises(TableError, match="registry_version"):
            reference.registry_folder(version)
    assert reference.reference_paths(AFND_LEGACY) == AFND_BUILT


def test_afnd_legacy_equals_the_released_registry():
    released = ROOT / "data" / build_tables.AFND_POPULATIONS
    populations, aliases = reference.afnd_legacy(released)
    expected, expected_aliases, _ = afnd_registry.load(released, AFND_LEGACY)
    pd.testing.assert_frame_equal(populations, expected)
    pd.testing.assert_frame_equal(aliases, expected_aliases)
    assert len(populations) == 1821 and set(populations["registry_version"]) == {AFND_LEGACY}


def test_a_row_afnd_refuses_stops_the_registry_build_before_writing(tmp_path):
    """v1 §12: a refused row (a population label with no coordinate, say) fails the build; it is never
    a population silently missing from the published registry."""
    _, _, report = afnd_registry.load(AFND_FIXTURE, AFND_LEGACY)
    assert (report.total, report.refusals) == (9, {"unreadable_latitude": 1, "unusable_pop_id": 1})
    refused = r"refuses 2 of its 9 rows \(unreadable_latitude 1, unusable_pop_id 1\)"
    with pytest.raises(TableError, match=rf"registry afnd-2026-08: .*afnd_populations.tsv: .*{refused}"):
        reference.afnd_legacy(AFND_FIXTURE)
    tree = _tree(tmp_path, afnd=AFND_FIXTURE)
    with pytest.raises(TableError, match=refused):
        build_tables.build_reference(tree.ctx)
    assert _digests(tree.data) == {}
    _, _, kept = afnd_registry.load(AFND_REGISTRY_FIXTURE, AFND_LEGACY)
    assert (kept.total, kept.retained, kept.refusals) == (7, 7, {})


def test_map_legacy_rows_are_aliases_only(tmp_path):
    aliases = reference.map_legacy_aliases(*MAP_FIXTURES)
    rows = set(zip(aliases["source"], aliases["label"], aliases["population_id"], strict=True))
    assert {("map_surveys", "404", "map-hbs-404"), ("map_g6pd", "659", "map-g6pd-659")} <= rows
    assert len(rows) == 11 + 7
    populations, frame = reference.reference_frames(None, aliases, registry_version=MAP_LEGACY)
    assert populations is None and set(frame["registry_version"]) == {MAP_LEGACY}
    with pytest.raises(TableError, match="alias rows only"):
        reference.reference_frames(aliases, aliases, registry_version=MAP_LEGACY)
    afnd_populations, afnd_aliases = reference.afnd_legacy(AFND_REGISTRY_FIXTURE)
    with pytest.raises(TableError, match="places each population"):
        reference.reference_frames(None, afnd_aliases, registry_version=AFND_LEGACY)
    duplicated = tmp_path / "map_hbs_surveys.csv"
    text = MAP_FIXTURES[0].read_text(encoding="utf-8")
    duplicated.write_text(text + text.splitlines()[1] + "\n", encoding="utf-8")
    with pytest.raises(TableError, match="duplicate"):
        reference.map_legacy_aliases(duplicated, MAP_FIXTURES[1])


def test_require_resolved_names_the_missing_id():
    populations, aliases = reference.afnd_legacy(AFND_REGISTRY_FIXTURE)
    known = list(populations["population_id"])
    reference.require_resolved(known, populations, aliases, registry_version=AFND_LEGACY)
    with pytest.raises(TableError, match="afnd-999999"):
        reference.require_resolved(
            [*known, "afnd-999999"], populations, aliases, registry_version=AFND_LEGACY
        )
    map_aliases = reference.map_legacy_aliases(*MAP_FIXTURES)
    reference.require_resolved(["map-hbs-404"], None, map_aliases, registry_version=MAP_LEGACY)
    with pytest.raises(TableError, match="map-hbs-999999"):
        reference.require_resolved(["map-hbs-999999"], None, map_aliases, registry_version=MAP_LEGACY)
    other = "1.0.0+sha256." + "0" * 64
    with pytest.raises(TableError, match=r"registry_version \['afnd-2026-08'\]"):
        reference.require_resolved(known, populations, aliases, registry_version=other)


def test_registry_coordinates_must_match():
    populations, _ = reference.afnd_legacy(AFND_REGISTRY_FIXTURE)
    placed = populations.iloc[:3].reset_index(drop=True)
    observations = observation_rows(3).assign(
        population_id=placed["population_id"],
        lat=placed["lat"],
        lon=placed["lon"],
        radius_km=placed["uncertainty_radius_km"],
    )
    reference.require_registry_coordinates(observations, populations, registry_version=AFND_LEGACY)
    moved = observations.assign(lat=observations["lat"] + [0.0, 0.01, 0.0])
    with pytest.raises(TableError, match="lat"):
        reference.require_registry_coordinates(moved, populations, registry_version=AFND_LEGACY)
    wider = observations.assign(radius_km=observations["radius_km"] + 1e-9)
    with pytest.raises(TableError, match="radius_km"):
        reference.require_registry_coordinates(wider, populations, registry_version=AFND_LEGACY)
    # MAP's own coordinates stay authoritative (check 5, call 18).
    reference.require_registry_coordinates(moved, populations, registry_version=MAP_LEGACY)


def test_build_reference_is_deterministic(tmp_path, capsys):
    first, second = _tree(tmp_path / "a"), _tree(tmp_path / "b")
    assert build_tables.build_reference(first.ctx) == BUILT
    assert build_tables.build_reference(second.ctx) == BUILT
    assert _digests(first.data) == _digests(second.data)
    assert sorted(_digests(first.data)) == BUILT
    out = capsys.readouterr().out
    assert "reference.populations afnd-2026-08: 7 rows, written" in out
    assert "reference.population_aliases map-survey-coordinates-v1: 18 rows, written" in out
    assert f"reference.populations {HGDP_FOLDER}: 7 rows, written" in out


def test_read_reference_reads_back_a_built_folder(reference_tree):
    build_tables.build_reference(reference_tree.ctx)
    populations, aliases = reference.read_reference(reference_tree.data / REGISTRY / "afnd-2026-08")
    expected = reference.reference_frames(
        *reference.afnd_legacy(reference_tree.data / build_tables.AFND_POPULATIONS),
        registry_version=AFND_LEGACY,
    )
    assert populations is not None and expected[0] is not None
    assert sorted(populations["population_id"]) == sorted(expected[0]["population_id"])
    assert len(aliases) == len(expected[1]) and set(aliases["registry_version"]) == {AFND_LEGACY}
    alias_only, map_aliases = reference.read_reference(
        reference_tree.data / REGISTRY / "map-survey-coordinates-v1"
    )
    assert alias_only is None and len(map_aliases) == 18
    misfiled = reference_tree.data / REGISTRY / "afnd-2026-09"
    shutil.copytree(reference_tree.data / REGISTRY / "afnd-2026-08", misfiled)
    with pytest.raises(TableError, match="afnd-2026-09"):
        reference.read_reference(misfiled)


def test_a_published_folder_is_verified_not_rewritten(reference_tree, monkeypatch, capsys):
    built = build_tables.build_reference(reference_tree.ctx)
    digests = _digests(reference_tree.data)
    commit_release(reference_tree.data, reference_tree.releases, EPOCH)
    later = reference_tree.context(release=LATER, git_sha="1" * 40)
    capsys.readouterr()
    assert build_tables.build_reference(later) == built
    out = capsys.readouterr().out
    assert "reference.populations afnd-2026-08: 7 rows, verified" in out
    assert f"reference.populations {HGDP_FOLDER}: 7 rows, verified" in out
    assert _digests(reference_tree.data) == digests
    for path in built:
        assert provenance.read_kv(reference_tree.data / path)["genomeos.git_sha"] == GIT_SHA
    legacy = reference.afnd_legacy

    def drifted(tsv: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
        populations, aliases = legacy(tsv)
        return populations.assign(lat=populations["lat"] + [0.01, *[0.0] * (len(populations) - 1)]), aliases

    monkeypatch.setattr(reference, "afnd_legacy", drifted)
    with pytest.raises(TableError, match="a released part is immutable .* in 1 rows"):
        build_tables.build_reference(later)
    assert _digests(reference_tree.data) == digests


def test_require_same_rows_refuses_a_published_folder_with_other_rows(reference_tree):
    build_tables.build_reference(reference_tree.ctx)
    path = reference_tree.data / AFND_BUILT[0]
    frame = pq.read_table(path).to_pandas()
    write_once.require_same_rows(path, frame.iloc[::-1], key=POPULATIONS_KEY)
    changed = frame.copy()
    changed.loc[0, "uncertainty_radius_km"] += 1.0
    immutable = r"a released part is immutable \(data platform builder's call 6\)"
    message = rf"{immutable}: {re.escape(str(path))} differs"
    with pytest.raises(TableError, match=rf"{message} from its rebuild in 1 rows"):
        write_once.require_same_rows(path, changed, key=POPULATIONS_KEY)
    with pytest.raises(TableError, match=rf"{message} from its rebuild in 2 rows"):
        write_once.require_same_rows(path, changed.drop(index=1), key=POPULATIONS_KEY)


def test_a_stray_registry_file_or_a_missing_harvest_stops_the_build_before_writing(reference_tree):
    stray = reference_tree.data / REGISTRY / "afnd-2026-09" / "populations.parquet"
    stray.parent.mkdir(parents=True)
    stray.write_bytes(b"PAR1 stand-in")
    with pytest.raises(
        TableError, match=r"afnd-2026-09/populations.parquet: no release published it .* remove"
    ):
        build_tables.build_reference(reference_tree.ctx)
    assert sorted(_digests(reference_tree.data)) == [f"{REGISTRY}/afnd-2026-09/populations.parquet"]
    stray.unlink()
    (reference_tree.data / build_tables.MAP_SURVEYS[1]).unlink()
    with pytest.raises(TableError, match=r"map_g6pd_surveys.csv: .* lacks it; copy it from hf://datasets/"):
        build_tables.build_reference(reference_tree.ctx)
    assert _digests(reference_tree.data) == {}
