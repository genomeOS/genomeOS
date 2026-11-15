"""``measured.fit_inputs`` and the legacy ``web-json-match`` evidence.

Atlas data platform design 2026-10-18 §2.4, §2.7 checks 2 and 3, §2.8; builder's call 8; step 1.9.
``allele_part`` and ``carrier_part`` are the measured stage's parts over the AFND harvest stand-in,
``web_payload`` one variant's observations JSON as ``export_atlas_web`` serves it, and ``served_tree`` the
fixture tree plus ``ART`` (HLA-DQB1*03:01) with this release's measured parts.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json

import pandas as pd
import pytest

from genomeos.tables import contracts, fit_inputs, measured, provenance, writer
from genomeos.tables.contracts import TableError
from genomeos.tables.measured import ALLELE_TABLE, CARRIER_TABLE
from genomeos.tables.provenance import InputRef
from scripts import build_tables
from tests import tables_fixtures
from tests.tables_fixtures import ART, EPOCH, GIT_SHA, HBS_V3, commit_release, web_json, web_payload

#: The shared pytest fixtures, registered in this module by name.
allele_part = tables_fixtures.allele_part
carrier_part = tables_fixtures.carrier_part
afnd_aliases = tables_fixtures.afnd_aliases
served_tree = tables_fixtures.served_tree

IV = "afnd-2026-08"
DQB1 = "hla:dqb1-03-01"
LATER = "2026-11-21"
AF = measured.part_path(ALLELE_TABLE, "afnd_frequencies", IV)


def _with_rows(web: fit_inputs.WebObservations, edit) -> fit_inputs.WebObservations:
    rows = web.rows.copy()
    edit(rows)
    return dataclasses.replace(web, rows=rows.reset_index(drop=True))


@pytest.mark.parametrize("field", fit_inputs.MATCHED_FIELDS)
def test_any_differing_field_is_a_mismatch(allele_part, afnd_aliases, field):
    with pytest.raises(fit_inputs.WebJsonMismatch, match=field):
        fit_inputs.match_web_json(
            web_payload(allele_part, "hla:dqb1-03-01", edit=(0, field)), allele_part, aliases=afnd_aliases
        )


def test_the_served_json_matches_its_part_record_for_record(allele_part, afnd_aliases):
    rows = fit_inputs.match_web_json(web_payload(allele_part, DQB1), allele_part, aliases=afnd_aliases)
    assert tuple(rows.columns) == tuple(name for name in fit_inputs.COLUMNS if name != "epoch")
    records = allele_part[allele_part["variant_id"] == DQB1]
    assert sorted(rows["source_record_id"]) == sorted(records["source_record_id"])
    assert set(map(tuple, rows.drop(columns="source_record_id").values.tolist())) == {
        (ART, DQB1, "v3", IV, "allele_frequency", "afnd_frequencies", IV, "web-json-match")
    }


def test_an_unlisted_mismatch_stops_the_build_and_a_listed_one_is_none(served_tree):
    with pytest.raises(fit_inputs.WebJsonMismatch):
        build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.drifted_web)
    rows = build_tables.build_fit_inputs(
        served_tree.ctx,
        web=served_tree.drifted_web,
        web_json_refused={ART: "AFND re-ingest differs from the served JSON in ac"},
    )
    assert ART not in set(rows["artifact"])
    assert not (served_tree.data / fit_inputs.fit_inputs_path(EPOCH)).exists()


def test_a_mismatch_names_the_artifact_the_record_and_the_field(served_tree):
    (web,) = served_tree.drifted_web
    record = web.rows.loc[0, "source_record_id"]
    with pytest.raises(fit_inputs.WebJsonMismatch, match=rf"{ART}: record {record}: ac is"):
        build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.drifted_web)


def test_ingest_key_routes_by_prefix():
    route = fit_inputs.ingest_key_for
    assert route("hla:dqb1-03-01", "allele_frequency", IV) == (ALLELE_TABLE, "afnd_frequencies", IV)
    assert route("cyt:il-6-174-c", "allele_frequency", IV) == (ALLELE_TABLE, "afnd", IV)
    assert route("kir:2dl1", "carrier_frequency", IV) == (CARRIER_TABLE, "afnd", IV)
    with pytest.raises(TableError, match="carrier"):
        route("kir:2dl1", "allele_frequency", IV)
    with pytest.raises(TableError, match="no reviewed ingest"):
        route("chr11-5227002-T-A", "allele_frequency", IV)
    assert route("chr11-5227002-T-A", "allele_frequency", "map-2026-08") is None
    # Controller ruling p1-R16: a KIR or MIC allele is an allele frequency in the afnd_frequencies part.
    assert route("kir:3dl1-007", "allele_frequency", IV) == (ALLELE_TABLE, "afnd_frequencies", IV)
    assert route("mic:mica-008", "allele_frequency", IV) == (ALLELE_TABLE, "afnd_frequencies", IV)
    for allele in ("kir:3dl1-007", "hla:dqb1-03-01", "cyt:il-6-174-c"):
        with pytest.raises(TableError, match="carrier"):
            route(allele, "carrier_frequency", IV)
    with pytest.raises(TableError, match="phenotype_frequency"):
        route("hla:dqb1-03-01", "phenotype_frequency", IV)
    assert dict(build_tables.INGEST_FOR_DATA_VERSION) == {"afnd-2026-08": "afnd-2026-08"}


def test_a_web_json_whose_digest_differs_is_refused(allele_part):
    payload = web_json(allele_part, DQB1)
    with pytest.raises(fit_inputs.WebJsonMismatch, match="sha256"):
        fit_inputs.parse_web_observations(payload, expected_sha256="0" * 64)
    web = fit_inputs.parse_web_observations(payload, expected_sha256=hashlib.sha256(payload).hexdigest())
    assert (web.artifact, web.variant_id, web.measurement, web.registry_version) == (
        ART,
        DQB1,
        "allele_frequency",
        IV,
    )
    assert len(web.rows) == 2


def test_a_web_json_with_a_mistyped_count_is_refused(allele_part):
    document = json.loads(web_json(allele_part, DQB1))
    document["observations"][0]["ac"] = float(document["observations"][0]["ac"])
    payload = json.dumps(document).encode()
    with pytest.raises(fit_inputs.WebJsonMismatch, match=rf"{ART}: record .*: ac"):
        fit_inputs.parse_web_observations(payload, expected_sha256=hashlib.sha256(payload).hexdigest())


def test_radius_is_compared_exactly_not_rounded(allele_part, afnd_aliases):
    def nudge(rows):
        rows.loc[0, "radius_km"] = rows.loc[0, "radius_km"] + 1e-9

    web = _with_rows(web_payload(allele_part, DQB1), nudge)
    with pytest.raises(fit_inputs.WebJsonMismatch, match="radius_km"):
        fit_inputs.match_web_json(web, allele_part, aliases=afnd_aliases)


def test_a_missing_record_is_a_mismatch(allele_part, afnd_aliases):
    web = web_payload(allele_part, DQB1)
    with pytest.raises(fit_inputs.WebJsonMismatch, match="count"):
        fit_inputs.match_web_json(
            dataclasses.replace(web, rows=web.rows.iloc[1:].reset_index(drop=True)),
            allele_part,
            aliases=afnd_aliases,
        )
    with pytest.raises(fit_inputs.WebJsonMismatch, match="count"):
        fit_inputs.match_web_json(web, allele_part.iloc[1:], aliases=afnd_aliases)


def test_a_population_label_must_resolve(allele_part, afnd_aliases):
    def unknown(rows):
        rows.loc[0, "population_label"] = "Atlantis"

    with pytest.raises(fit_inputs.WebJsonMismatch, match="population_label"):
        fit_inputs.match_web_json(
            _with_rows(web_payload(allele_part, DQB1), unknown), allele_part, aliases=afnd_aliases
        )

    def other(rows):  # a population the registry places, but not the record's
        rows.loc[0, "population_label"] = "Albania"

    with pytest.raises(fit_inputs.WebJsonMismatch, match="population_label"):
        fit_inputs.match_web_json(
            _with_rows(web_payload(allele_part, DQB1), other), allele_part, aliases=afnd_aliases
        )


def test_kir_matches_its_carrier_part_and_not_the_allele_part(allele_part, carrier_part, afnd_aliases):
    web = web_payload(carrier_part, "kir:2dl1")
    rows = fit_inputs.match_web_json(web, carrier_part, aliases=afnd_aliases)
    assert rows[["measurement", "source", "source_record_id"]].values.tolist() == [
        ["carrier_frequency", "afnd", carrier_part["source_record_id"].iloc[0]]
    ]
    with pytest.raises(fit_inputs.WebJsonMismatch, match="carrier"):
        fit_inputs.match_web_json(web, allele_part, aliases=afnd_aliases)
    with pytest.raises(fit_inputs.WebJsonMismatch, match="carrier"):
        fit_inputs.match_web_json(web_payload(allele_part, DQB1), carrier_part, aliases=afnd_aliases)


def test_check_3_fit_records_must_appear_identically(allele_part, carrier_part):
    observations = allele_part[allele_part["variant_id"] == DQB1].reset_index(drop=True)
    rows = fit_inputs.fit_record_rows(
        ART, observations, measurement="allele_frequency", part=allele_part, epoch=EPOCH
    )
    assert tuple(rows.columns) == fit_inputs.COLUMNS
    assert set(rows["evidence"]) == {"fit-record"} and set(rows["epoch"]) == {EPOCH}
    assert sorted(rows["source_record_id"]) == sorted(observations["source_record_id"])
    drifted = observations.assign(ac=observations["ac"] + 1)
    with pytest.raises(TableError, match=rf"check 3: {ART}: record .*: ac"):
        fit_inputs.fit_record_rows(
            ART, drifted, measurement="allele_frequency", part=allele_part, epoch=EPOCH
        )
    with pytest.raises(TableError, match="carrier"):
        fit_inputs.fit_record_rows(
            "kir__2dl1__v3__afnd-2026-08",
            carrier_part,
            measurement="carrier_frequency",
            part=allele_part,
            epoch=EPOCH,
        )
    with pytest.raises(TableError, match="count"):
        fit_inputs.fit_record_rows(
            ART, observations, measurement="allele_frequency", part=allele_part.iloc[1:], epoch=EPOCH
        )


def test_new_rows_skip_matched_artifacts(served_tree):
    rows = build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.web)
    assert fit_inputs.matched_artifacts(rows) == frozenset({ART})
    assert len(fit_inputs.new_rows(rows, already=frozenset())) == 2
    assert fit_inputs.new_rows(rows, already=frozenset({ART})).empty


def test_check_2_compares_the_fit_inputs_epoch(tmp_path, allele_part, afnd_aliases):
    rows = fit_inputs.match_web_json(web_payload(allele_part, DQB1), allele_part, aliases=afnd_aliases)
    path = fit_inputs.fit_inputs_path("2026-11-20")
    assert path == "tables/v1/measured/fit_inputs/epoch=2026-11-20/part-0.parquet"
    assert contracts.table_of(path) == fit_inputs.FIT_INPUTS_TABLE
    writer.write_frame(
        writer.connect(),
        rows.assign(epoch="2026-11-21")[list(fit_inputs.COLUMNS)],
        tmp_path / path,
        table=fit_inputs.FIT_INPUTS_TABLE,
        git_sha=GIT_SHA,
        inputs=[InputRef("releases/2026-10-17/raw/afnd_populations.tsv", "0" * 64)],
        sources=["afnd"],
        order_by=fit_inputs.SORT_KEY,
    )
    with pytest.raises(TableError, match="epoch"):
        writer.check_partitions(writer.connect(), tmp_path / path, path)


def test_the_stage_writes_this_epochs_part_and_prints_the_evidence(served_tree, capsys):
    capsys.readouterr()
    rows = build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.web)
    out = capsys.readouterr().out
    assert f"measured.fit_inputs epoch={EPOCH}: 2 rows, 1 artifacts, written" in out
    assert "web-json-match: 1 artifacts (1 allele_frequency)" in out
    assert "none: 3 artifacts, each with a reason" in out
    path = served_tree.data / fit_inputs.fit_inputs_path(EPOCH)
    writer.check_table_file(path, fit_inputs.FIT_INPUTS_TABLE)
    written = pd.read_parquet(path)
    assert written.values.tolist() == rows.values.tolist()
    assert tuple(written.columns) == fit_inputs.COLUMNS and set(written["epoch"]) == {EPOCH}
    refs = provenance.decode_inputs(provenance.read_kv(path)["genomeos.inputs"])
    assert {ref.key for ref in refs} == {
        f"releases/{EPOCH}/{AF}",
        "releases/2026-10-17/raw/afnd_populations.tsv",
    }
    assert provenance.read_kv(path)[provenance.SOURCES_KEY] == '["afnd"]'


def test_a_later_release_keeps_the_earlier_epoch(served_tree, capsys):
    """Call 6: an artifact some earlier epoch holds is matched again but never written again."""
    build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.web)
    part = served_tree.data / fit_inputs.fit_inputs_path(EPOCH)
    digest = hashlib.sha256(part.read_bytes()).hexdigest()
    commit_release(served_tree.data, served_tree.releases, EPOCH)
    capsys.readouterr()
    rows = build_tables.build_fit_inputs(served_tree.context(release=LATER), web=served_tree.web)
    assert "no new artifacts" in capsys.readouterr().out
    assert set(rows["epoch"]) == {EPOCH} and fit_inputs.matched_artifacts(rows) == frozenset({ART})
    assert not (served_tree.data / fit_inputs.fit_inputs_path(LATER)).exists()
    assert hashlib.sha256(part.read_bytes()).hexdigest() == digest


def test_a_stray_fit_inputs_part_is_refused(served_tree):
    stray = served_tree.data / fit_inputs.fit_inputs_path("2026-11-13")
    stray.parent.mkdir(parents=True)
    stray.write_bytes(b"an earlier build's part")
    with pytest.raises(TableError, match="epoch=2026-11-13/part-0.parquet: no release published it"):
        build_tables.build_fit_inputs(served_tree.ctx, web=served_tree.web)


def test_served_json_is_read_at_its_catalog_url_and_digest(allele_part, tmp_path):
    payload = web_json(allele_part, DQB1)
    url = "downloads/hla-dqb1-03-01/v3/afnd-2026-08/hla-dqb1-03-01.observations.json"
    entry = {
        "variant_id": DQB1,
        "model_version": "v3",
        "data_version": IV,
        "measurement": "allele_frequency",
        "observations_url": url,
        "observations_sha256": hashlib.sha256(payload).hexdigest(),
    }
    catalog = {"artifacts": [entry, {**entry, "variant_id": "x:y", "observations_url": None}]}
    with pytest.raises(TableError, match="missing"):
        build_tables.load_served_web_observations({"artifacts": [entry]}, tmp_path / "web")
    (tmp_path / "web" / url).parent.mkdir(parents=True)
    (tmp_path / "web" / url).write_bytes(payload)
    (web,) = build_tables.load_served_web_observations({"artifacts": [entry]}, tmp_path / "web")
    assert (web.artifact, len(web.rows)) == (ART, 2)
    with pytest.raises(TableError, match="observations_url"):
        build_tables.load_served_web_observations(catalog, tmp_path / "web")
    with pytest.raises(fit_inputs.WebJsonMismatch, match="sha256"):
        build_tables.load_served_web_observations(
            {"artifacts": [{**entry, "observations_sha256": "0" * 64}]}, tmp_path / "web"
        )
    with pytest.raises(fit_inputs.WebJsonMismatch, match="model_version"):
        build_tables.load_served_web_observations(
            {"artifacts": [{**entry, "model_version": "v2"}]}, tmp_path / "web"
        )


def _main(tree, *extra: str) -> int:
    arguments = ["--release", EPOCH, "--data", str(tree.data), "--releases", str(tree.releases)]
    return build_tables.main([*arguments, "--git-sha", "HEAD", *extra])


def test_the_fit_inputs_stage_feeds_the_inferred_stage(served_tree, allele_part, tmp_path, capsys):
    payload = web_json(allele_part, DQB1)
    url = "downloads/hla-dqb1-03-01.observations.json"
    (tmp_path / "web" / url).parent.mkdir(parents=True)
    (tmp_path / "web" / url).write_bytes(payload)
    served = [
        {
            "variant_id": DQB1,
            "model_version": "v3",
            "data_version": IV,
            "measurement": "allele_frequency",
            "observations_url": url,
            "observations_sha256": hashlib.sha256(payload).hexdigest(),
        }
    ]
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"artifacts": served}))
    stages = ("--stage", "fit_inputs", "--stage", "inferred", "--web-catalog", str(catalog))
    assert _main(served_tree, *stages) == 1
    assert "--web-observations" in capsys.readouterr().err
    assert _main(served_tree, *stages, "--web-observations", str(tmp_path / "web")) == 0
    out = capsys.readouterr().out
    assert "web-json-match: 1 artifacts (1 allele_frequency)" in out
    assert "inferred.artifacts: 4 rows; fit_input_evidence web-json-match 1, none 3" in out
    frame = pd.read_parquet(served_tree.data / contracts.table_path("inferred.artifacts"))
    evidence = dict(zip(frame["artifact"], frame["fit_input_evidence"], strict=True))
    assert evidence[ART] == "web-json-match" and evidence[HBS_V3] == "none"
    # Run alone, the inferred stage would publish none beside the fit_inputs part: it is refused.
    assert _main(served_tree, "--stage", "inferred") == 1
    assert "fit_inputs" in capsys.readouterr().err
