"""``inferred.artifacts`` and the ``cells_by_cell`` epochs.

Atlas data platform design 2026-10-18 §2.4, §2.7 checks 6 and 10, §2.8; builder's calls 6, 8 and 22.
Every test reads ``fixture_tree``: release 2026-10-17 of HbS v1 (format 1, res 3, no ``measurement``),
HbS v3 and KIR 2DL1 v3 (format 2, res 4), one cell each over Lagos and London.
"""

from __future__ import annotations

import dataclasses
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import pytest

from genomeos.tables import contracts, inferred, provenance, write_once, writer
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import InputRef
from scripts import build_data_release, build_tables
from tests import tables_fixtures
from tests.tables_fixtures import (
    EPOCH,
    GIT_SHA,
    HBS_V1,
    HBS_V3,
    KIR_V3,
    LAGOS_R3,
    LAGOS_R4,
    LONDON_R3,
    LONDON_R4,
    R0_LAGOS,
    R0_LONDON,
    cells_frame,
)

#: The shared pytest fixture, registered in this module by name.
fixture_tree = tables_fixtures.fixture_tree

PARTS = tuple(
    f"tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res={k}/h3_r0={r0}/part-0.parquet"
    for k, r0 in ((3, R0_LONDON), (3, R0_LAGOS), (4, R0_LONDON), (4, R0_LAGOS))
)


@pytest.fixture
def epoch(fixture_tree):
    """The fixture's records and a connection, before any part is written."""
    return fixture_tree.data, writer.connect(), build_tables.artifact_records(fixture_tree.ctx)


def _record(records, artifact: str) -> inferred.ArtifactRecord:
    (found,) = (record for record in records if record.artifact == artifact)
    return found


def _with_cells(records, artifact: str, frame: pd.DataFrame, out: Path) -> list[inferred.ArtifactRecord]:
    """``records`` with ``artifact``'s cells.parquet replaced by ``frame``, written to ``out``."""
    frame.to_parquet(out, index=False)
    return [
        dataclasses.replace(record, cells_path=out) if record.artifact == artifact else record
        for record in records
    ]


def _with_manifest(records, artifact: str, **changes) -> list[inferred.ArtifactRecord]:
    return [
        dataclasses.replace(record, manifest={**record.manifest, **changes})
        if record.artifact == artifact
        else record
        for record in records
    ]


def test_the_first_epoch_partitions_cells_by_res_and_base_cell(epoch):
    data, con, records = epoch
    assert inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA) == PARTS
    lagos = pd.read_parquet(data / PARTS[3])
    assert list(lagos.columns) == list(inferred.CELLS_BY_CELL_COLUMNS)
    assert lagos[["h3_index", "variant_id"]].values.tolist() == [
        [LAGOS_R4, "chr11-5227002-T-A"],
        [LAGOS_R4, "kir:2dl1"],
    ]
    assert set(lagos["h3_parent_r3"]) == {LAGOS_R3}
    assert pd.read_parquet(data / PARTS[1])["h3_parent_r3"].tolist() == [LAGOS_R3]
    assert lagos[["measurement", "artifact_format", "epoch", "res", "h3_r0"]].values.tolist() == [
        ["allele_frequency", 2, EPOCH, 4, R0_LAGOS],
        ["carrier_frequency", 2, EPOCH, 4, R0_LAGOS],
    ]
    london_r3 = pd.read_parquet(data / PARTS[0])
    assert london_r3[["h3_index", "h3_parent_r3", "measurement"]].values.tolist() == [
        [LONDON_R3, LONDON_R3, "allele_frequency"]
    ]


def test_each_part_records_the_artifacts_it_holds(epoch):
    """A part's inputs are its artifacts' cells.parquet and manifest.json; its sources are theirs."""
    data, con, records = epoch
    inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    kv = provenance.read_kv(data / PARTS[3])
    expected = sorted(
        InputRef(key, sha256)
        for record in records
        if record.artifact in {HBS_V3, KIR_V3}
        for key, sha256 in (
            (record.cells_key, record.cells_sha256),
            (record.manifest_key, record.manifest_sha256),
        )
    )
    assert list(provenance.decode_inputs(kv["genomeos.inputs"])) == expected
    assert provenance.parse_sources(kv[provenance.SOURCES_KEY], where="part") == ("afnd", "map", "worldpop")
    assert provenance.parse_sources(
        provenance.read_kv(data / PARTS[0])[provenance.SOURCES_KEY], where=""
    ) == ("map",)


def test_inferred_does_not_import_the_surface_stack():
    """Read in a fresh interpreter: this process may already hold genomeos.surfaces."""
    code = (
        "import sys, genomeos.tables.inferred, genomeos.tables.write_once; "
        "print(sorted(m for m in sys.modules if m.startswith(('genomeos.surfaces', 'scripts'))))"
    )
    loaded = subprocess.run([sys.executable, "-c", code], capture_output=True, check=True, text=True)
    assert loaded.stdout.strip() == "[]"


def test_cells_columns_are_the_14_released_columns():
    assert len(inferred.CELLS_COLUMNS) == 14
    assert "prior_frequency_sd" not in inferred.CELLS_COLUMNS
    assert contracts.columns(inferred.CELLS_TABLE) == inferred.CELLS_BY_CELL_COLUMNS


def test_measurement_of_reads_the_manifest_or_the_reviewed_table(epoch):
    _, _, records = epoch
    assert inferred.measurement_of(HBS_V1, _record(records, HBS_V1).manifest) == (
        "allele_frequency",
        "reviewed_table",
    )
    assert inferred.measurement_of(KIR_V3, _record(records, KIR_V3).manifest) == (
        "carrier_frequency",
        "manifest",
    )
    unmarked = {k: v for k, v in _record(records, KIR_V3).manifest.items() if k != "measurement"}
    with pytest.raises(TableError, match="measurement"):
        inferred.measurement_of("kir__2dl1__v2__afnd-2026-08", {**unmarked, "artifact_format": 1})


def test_the_reviewed_measurements_cite_the_v3_manifests():
    assert set(inferred.REVIEWED_MEASUREMENTS) == {
        "chr11-5227002-T-A__v1__map-2026-08",
        "phenotype__g6pd-deficiency__v1__map-2026-08",
    }
    for artifact, (measurement, reason) in inferred.REVIEWED_MEASUREMENTS.items():
        assert measurement == "allele_frequency"
        assert "format-1" in reason and artifact.replace("__v1__", "__v3__") in reason


def test_fit_input_evidence_is_never_null():
    evidence = inferred.fit_input_evidence
    bare = {"a": "released 2026-10-17 before fit inputs"}
    assert evidence("a", has_input=True, released_without_input={}) == ("fit-record", None)
    assert evidence("a", has_input=False, released_without_input=bare, web_json_matches=frozenset({"a"})) == (
        "web-json-match",
        None,
    )
    assert evidence("a", has_input=False, released_without_input=bare) == (
        "none",
        "released 2026-10-17 before fit inputs",
    )
    assert evidence(
        "a", has_input=False, released_without_input=bare, web_json_refused={"a": "ac differs"}
    ) == (
        "none",
        "ac differs",
    )
    with pytest.raises(TableError, match="reason"):
        evidence("a", has_input=False, released_without_input={"a": "  "})
    with pytest.raises(TableError, match="fit_input_evidence"):
        evidence("a", has_input=False, released_without_input={})


def test_a_none_reason_takes_the_refusal_then_the_missing_ingest_then_the_release_note():
    """Controller ruling p1-R15: web_json_refused > no published ingest > RELEASED_WITHOUT_INPUT."""
    evidence = inferred.fit_input_evidence
    both = {"released_without_input": {"a": "released bare"}, "no_published_ingest": {"a": "map-2026-08"}}
    assert evidence("a", has_input=False, **both) == ("none", "no published ingest for map-2026-08")
    assert evidence("a", has_input=False, web_json_refused={"a": "ac differs"}, **both) == (
        "none",
        "ac differs",
    )
    with pytest.raises(TableError, match="refused"):
        evidence(
            "a",
            has_input=False,
            released_without_input={},
            web_json_matches=frozenset({"a"}),
            web_json_refused={"a": "ac differs"},
        )


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        ("post_mean", f"{KIR_V3}.*checksum"),
        ("drop", f"{KIR_V3}.*count"),
        ("measurement", f"{KIR_V3}.*measurement"),
        ("artifact_format", f"{KIR_V3}.*artifact_format"),
    ],
)
def test_check_6_compares_count_checksum_measurement_and_artifact_format(epoch, edit, message):
    data, con, records = epoch
    inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    parts = [data / part for part in PARTS]
    inferred.check_cells_equal(con, records, parts)
    frame = pd.read_parquet(parts[3])
    kir = frame["variant_id"] == "kir:2dl1"
    if edit == "post_mean":
        frame.loc[kir, "post_mean"] += 1e-9
    elif edit == "drop":
        frame = frame[~kir]
    elif edit == "measurement":
        frame.loc[kir, "measurement"] = "allele_frequency"
    else:
        frame.loc[kir, "artifact_format"] = 1
    frame.to_parquet(parts[3], index=False)
    with pytest.raises(TableError, match=message):
        inferred.check_cells_equal(con, records, parts)


def test_check_6_is_order_independent(epoch):
    data, con, records = epoch
    inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    parts = [data / part for part in PARTS]
    frame = pd.read_parquet(parts[3])
    frame.iloc[::-1].to_parquet(parts[3], index=False)
    inferred.check_cells_equal(con, records, parts)


def test_check_6_refuses_an_artifact_no_record_names(epoch):
    data, con, records = epoch
    inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    others = [record for record in records if record.artifact != KIR_V3]
    with pytest.raises(TableError, match=KIR_V3):
        inferred.check_cells_equal(con, others, [data / part for part in PARTS])


@pytest.mark.parametrize("artifact_format", [3, 4])
def test_write_epoch_refuses_formats_3_and_4(epoch, artifact_format):
    data, con, records = epoch
    records = _with_manifest(records, KIR_V3, artifact_format=artifact_format)
    with pytest.raises(TableError, match=r"prior_frequency_sd.*1\.1"):
        inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    assert not (data / "tables").exists()


def test_write_epoch_refuses_a_column_outside_CELLS_COLUMNS(epoch, tmp_path):
    data, con, records = epoch
    frame = cells_frame(KIR_V3, (LAGOS_R4, LONDON_R4)).assign(prior_frequency_sd=0.1)
    records = _with_cells(records, KIR_V3, frame, tmp_path / "cells.parquet")
    with pytest.raises(TableError, match="columns"):
        inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    assert not (data / "tables").exists()


def test_write_epoch_refuses_an_identity_that_is_not_its_directory(epoch, tmp_path):
    data, con, records = epoch
    frame = cells_frame(KIR_V3, (LAGOS_R4, LONDON_R4)).assign(model_version="v2")
    records = _with_cells(records, KIR_V3, frame, tmp_path / "cells.parquet")
    with pytest.raises(TableError, match="directory"):
        inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    assert not (data / "tables").exists()


def test_write_epoch_refuses_a_cell_off_the_manifest_resolution(epoch, tmp_path):
    data, con, records = epoch
    records = _with_cells(records, KIR_V3, cells_frame(KIR_V3, (LAGOS_R4, LONDON_R3)), tmp_path / "c.parquet")
    with pytest.raises(TableError, match="resolution"):
        inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    assert not (data / "tables").exists()


def test_write_epoch_refuses_a_cell_count_other_than_n_cells_or_a_duplicate_cell(epoch, tmp_path):
    data, con, records = epoch
    with pytest.raises(TableError, match="n_cells"):
        inferred.write_epoch(
            con, _with_manifest(records, KIR_V3, n_cells=3), epoch=EPOCH, out_root=data, git_sha=GIT_SHA
        )
    repeated = _with_cells(records, KIR_V3, cells_frame(KIR_V3, (LAGOS_R4, LAGOS_R4)), tmp_path / "c.parquet")
    with pytest.raises(TableError, match="duplicate"):
        inferred.write_epoch(con, repeated, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    assert not (data / "tables").exists()


def test_new_epoch_artifacts_are_those_no_earlier_epoch_holds():
    earlier = {HBS_V1: "2026-11-20", KIR_V3: "2026-11-20"}
    assert inferred.new_epoch_artifacts([KIR_V3, HBS_V3, HBS_V1], earlier) == (HBS_V3,)
    assert inferred.new_epoch_artifacts([KIR_V3], earlier) == ()


def test_artifacts_record_their_first_release_keys(fixture_tree):
    counts = build_tables.build_inferred(fixture_tree.ctx)
    assert counts == {"inferred.artifacts": 3, "inferred.cells_by_cell": 6}
    table = pq.read_table(fixture_tree.data / contracts.table_path(inferred.ARTIFACTS_TABLE))
    assert tuple(table.column_names) == contracts.columns(inferred.ARTIFACTS_TABLE)
    rows = {row["artifact"]: row for row in table.to_pylist()}
    kir = rows[KIR_V3]
    assert kir["cells_key"] == "releases/2026-10-17/store/artifacts/kir__2dl1__v3__afnd-2026-08/cells.parquet"
    assert (
        kir["manifest_key"] == "releases/2026-10-17/store/artifacts/kir__2dl1__v3__afnd-2026-08/manifest.json"
    )
    assert (kir["first_release"], kir["epoch"]) == ("2026-10-17", EPOCH)
    assert (kir["measurement"], kir["measurement_from"]) == ("carrier_frequency", "manifest")
    assert kir["observations_key"] is None and kir["observations_sha256"] is None
    assert dict(kir["support_counts"]) == {"interpolated": 1, "observed": 1}
    assert (kir["variant_id"], kir["artifact_format"], kir["resolution"], kir["n_cells"]) == (
        "kir:2dl1",
        2,
        4,
        2,
    )
    reason = build_data_release.RELEASED_WITHOUT_INPUT[KIR_V3]
    assert (kir["fit_input_evidence"], kir["fit_input_evidence_reason"]) == ("none", reason)
    hbs = rows[HBS_V1]
    assert (hbs["measurement"], hbs["measurement_from"]) == ("allele_frequency", "reviewed_table")
    assert (
        hbs["target_grid_source"] is None
        and rows[HBS_V3]["target_grid_source"] == "worldpop-1km-unconstrained"
    )


def test_artifacts_frame_requires_evidence_for_every_artifact(epoch):
    _, _, records = epoch
    epochs = dict.fromkeys((record.artifact for record in records), EPOCH)
    evidence = {record.artifact: ("none", "bare") for record in records if record.artifact != KIR_V3}
    with pytest.raises(TableError, match=f"check 10: {KIR_V3}.*fit_input_evidence"):
        inferred.artifacts_frame(records, epochs=epochs, evidence=evidence)
    with pytest.raises(TableError, match=f"check 10: {KIR_V3}.*reason"):
        inferred.artifacts_frame(
            records, epochs=epochs, evidence={**evidence, KIR_V3: ("web-json-match", "x")}
        )


def test_a_stray_file_in_the_epoch_folder_is_refused_before_writing(epoch):
    """A part an earlier, different build left would be published with this epoch's."""
    data, con, records = epoch
    stray = data / "tables/v1/inferred/cells_by_cell/epoch=2026-11-20/res=5/h3_r0=x/part-0.parquet"
    stray.parent.mkdir(parents=True)
    stray.write_bytes(b"left over")
    with pytest.raises(TableError, match="remove"):
        inferred.write_epoch(con, records, epoch=EPOCH, out_root=data, git_sha=GIT_SHA)
    assert not (data / PARTS[0]).exists()


def test_a_published_file_is_read_only_from_a_copy_with_its_published_sha256(fixture_tree):
    path = f"store/artifacts/{KIR_V3}/cells.parquet"
    item = fixture_tree.ctx.published[path]
    assert (
        write_once.require_published_local(fixture_tree.data, path, item.sha256) == fixture_tree.data / path
    )
    with pytest.raises(
        TableError, match=r"fetch it again: python scripts/fetch_data.py --prefix store/artifacts/"
    ):
        write_once.require_published_local(fixture_tree.data, path, "0" * 64)
    with pytest.raises(TableError, match=r"fetch it first: python scripts/fetch_data.py --prefix tables/"):
        write_once.require_published_local(fixture_tree.data, PARTS[0], item.sha256)
