"""The observations JSON as a projection of the fit input and its pinned registry (web format 1.1).

Atlas data platform design 2026-10-18 §2.8, builder's call 9, step 1.10.
"""

from __future__ import annotations

import pandas as pd
import pytest

from genomeos.publication import web_observations as wo
from scripts import export_atlas_web
from tests.observation_fixtures import kir_fit_rows, observation_rows

HF_REVISION = "fc17bc1c1d96a0d0766746dcf26277ccdc669717"
WHERE = {
    "source_url": "raw/map_hbs_surveys.csv",
    "dataset": "bschilder/genomeos-data",
    "revision": HF_REVISION,
}
VERSION = "2026-11-20+sha256.ab12"
REGISTRY = wo.PinnedRegistry(VERSION, frozenset(f"pop-{i}" for i in range(6)))


def _evidence(rows: pd.DataFrame) -> pd.DataFrame:
    """What the source adapter joins each row to: its citation, population and study labels."""
    return pd.DataFrame(
        {
            "source_record_id": rows["source_record_id"],
            "country": "Synthetic",
            "citation": "Synthetic contract example; not a publication",
            "study_label": "SYNTHETIC-001",
        }
    ).set_index("source_record_id")


rows = observation_rows()
ev = _evidence(rows)


def test_a_projected_row_is_the_legacy_row_plus_four_fields():
    legacy, projected = (
        wo.serialize_rows(rows, ev, **WHERE),
        wo.project_rows(rows, ev, measurement="allele_frequency", registry=REGISTRY, **WHERE),
    )
    assert (
        len(wo.LEGACY_ROW_FIELDS) == 17
        and [{k: r[k] for k in wo.LEGACY_ROW_FIELDS} for r in projected] == legacy
    )
    assert projected[1] == {
        **legacy[1],
        "measurement": "allele_frequency",
        "population_id": "pop-1",
        "rsid": None,
        "source": "map_hbs",
    }
    assert [set(row) for row in legacy] == [set(wo.LEGACY_ROW_FIELDS)] * len(rows)
    assert [set(row) for row in projected] == [set(wo.LEGACY_ROW_FIELDS) | set(wo.PROJECTION_FIELDS)] * len(
        rows
    )


def test_projected_rows_keep_integer_counts_and_no_surface_value():
    projected = wo.project_rows(rows, ev, measurement="allele_frequency", registry=REGISTRY, **WHERE)
    assert [(row["ac"], row["an"]) for row in projected] == list(zip(rows["ac"], rows["an"], strict=True))
    assert all(type(row["ac"]) is int and type(row["an"]) is int for row in projected)
    assert not [key for row in projected for key in row if key.startswith("post_")]


def test_a_carrier_projection_keeps_ac_and_an():
    """A KIR fit consumes carriers over individuals renamed to `ac`/`an` (#133); the row says so."""
    carriers = kir_fit_rows()
    projected = wo.project_rows(
        carriers, _evidence(carriers), measurement="carrier_frequency", registry=REGISTRY, **WHERE
    )
    assert [(row["ac"], row["an"]) for row in projected] == list(
        zip(carriers["ac"], carriers["an"], strict=True)
    )
    assert {row["measurement"] for row in projected} == {"carrier_frequency"}
    assert {row["source"] for row in projected} == {"afnd"}
    assert not {"carriers", "n_individuals"} & {key for row in projected for key in row}


@pytest.mark.parametrize("measurement", [None, "", "phenotype_frequency"])
def test_projection_requires_a_row_measurement(measurement):
    with pytest.raises(ValueError, match="measurement"):
        wo.project_rows(rows, ev, measurement=measurement, registry=REGISTRY, **WHERE)  # type: ignore[arg-type]


def test_a_population_outside_the_registry_is_refused():
    registry = wo.PinnedRegistry(VERSION, REGISTRY.population_ids - {"pop-5"})
    with pytest.raises(ValueError, match=r"pop-5.*not in population registry 2026-11-20\+sha256\.ab12"):
        wo.project_rows(rows, ev, measurement="allele_frequency", registry=registry, **WHERE)


def test_a_blank_rsid_is_refused_not_served():
    """The client reads a missing rsID as null only; a blank one would make it refuse the object."""
    with pytest.raises(ValueError, match="rsid"):
        wo.project_rows(rows.assign(rsid=""), ev, measurement="allele_frequency", registry=REGISTRY, **WHERE)


def test_projection_keeps_the_fit_input_order():
    shuffled = rows.iloc[[3, 0, 5, 1, 4, 2]].reset_index(drop=True)
    projected = wo.project_rows(shuffled, ev, measurement="allele_frequency", registry=REGISTRY, **WHERE)
    assert [row["source_record_id"] for row in projected] == list(shuffled["source_record_id"])
    assert [row["population_id"] for row in projected] == [
        "pop-3",
        "pop-0",
        "pop-5",
        "pop-1",
        "pop-4",
        "pop-2",
    ]


def test_pinned_registry_has_one_registry_version():
    populations = pd.DataFrame({"population_id": ["pop-0", "pop-1"], "registry_version": VERSION})
    aliases = pd.DataFrame(
        {
            "population_id": ["pop-1", "pop-2"],
            "source": "map_surveys",
            "label": ["1", "2"],
            "registry_version": VERSION,
        }
    )
    assert wo.pinned_registry(populations, aliases) == wo.PinnedRegistry(
        VERSION, frozenset({"pop-0", "pop-1", "pop-2"})
    )
    assert wo.pinned_registry(None, aliases) == wo.PinnedRegistry(VERSION, frozenset({"pop-1", "pop-2"}))
    with pytest.raises(ValueError, match="registry_version"):
        wo.pinned_registry(populations, aliases.assign(registry_version="afnd-2026-08"))
    with pytest.raises(ValueError, match="registry_version"):
        wo.pinned_registry(None, aliases.drop(columns="registry_version"))


def test_released_inputs_of_the_committed_manifests_is_empty():
    """The 61 artifacts of 2026-10-17 were released without their inputs (§2.8), and no committed
    release since holds one, so nothing is projected yet."""
    manifests = export_atlas_web._committed_manifests()
    assert len(manifests) >= 3
    assert wo.released_inputs(manifests) == {}


def test_released_inputs_maps_an_artifact_to_its_released_input():
    artifact = "store/artifacts/kir-2dl1__v1__afnd-2026-08"
    first = {
        "objects": [
            {"path": f"{artifact}/cells.parquet", "sha256": "1" * 64},
            {"path": f"{artifact}/observations.parquet", "sha256": "2" * 64},
            {
                "path": "tables/v1/measured/fit_inputs/epoch=2026-11-20/observations.parquet",
                "sha256": "3" * 64,
            },
        ]
    }
    later = {"objects": [{"path": f"{artifact}/observations.parquet", "sha256": "2" * 64}]}
    assert wo.released_inputs([first, later]) == {"kir-2dl1__v1__afnd-2026-08": "2" * 64}
    with pytest.raises(ValueError, match="kir-2dl1__v1__afnd-2026-08"):
        wo.released_inputs([first, {"objects": [{**later["objects"][0], "sha256": "4" * 64}]}])


def test_a_published_observations_json_is_never_regenerated():
    identity = {"variant_id": "kir:2dl1", "model_version": "v1", "data_version": "afnd-2026-08"}
    published = {
        "artifacts": [
            {**identity, "observations_sha256": "a" * 64, "surface_sha256": "b" * 64},
            {**identity, "variant_id": "kir:2dl2", "observations_sha256": "c" * 64},
        ]
    }
    wo.require_published_digests(published, **identity, digests={"observations_sha256": "a" * 64})
    wo.require_published_digests(
        published, **{**identity, "model_version": "v2"}, digests={"observations_sha256": "d" * 64}
    )
    with pytest.raises(ValueError, match=r"never regenerated.*observations_sha256"):
        wo.require_published_digests(published, **identity, digests={"observations_sha256": "d" * 64})
