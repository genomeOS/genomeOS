"""The web observations JSON, and its projection from an artifact's fit input (web format 1.1).

Atlas data platform design 2026-10-18 §2.8 and builder's call 9 (step 1.10); the format rule is in
``docs/web-data-format.md``.

``serialize_rows`` is the legacy observations JSON row: what ``export_atlas_web.py`` has always
served, built from rows the source adapters reload and joined to their citation and labels (the
evidence frame, indexed by ``source_record_id``). An artifact released with its fit input instead serves
a projection of that input (``project_rows``): the exact frame the fit consumed, in its order, as
integer ``ac``/``an`` (a carrier input as carriers over individuals, #133), each row the legacy row plus
``PROJECTION_FIELDS``. ``measurement`` is required and names what the counts count, so allele and
carrier counts are never conflated; every ``population_id`` must be in the registry the artifact was
fitted under (``PinnedRegistry``, check 5). A projected object carries the four keys on every row
(``website/src/atlas/contracts.ts`` refuses a mix), and a row never carries a surface value.

Only an artifact whose fit input a committed release holds is projected (``released_inputs``), and an
observations JSON the published catalog already serves is never regenerated with other bytes
(``require_published_digests``): its sha256 is in the catalog and in every citation.

Pure: frames and mappings in, rows, a registry or a refusal out. No I/O.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import pandas as pd

from genomeos.publication import data_release as dr
from genomeos.publication.artifact_inputs import INPUT_FILE

#: The keys of a legacy row, which every row carries.
LEGACY_ROW_FIELDS = (
    "ac",
    "an",
    "assay",
    "citation_text",
    "cohort_id",
    "disease_ascertainment_excluded",
    "ingest_version",
    "lat",
    "lon",
    "population_label",
    "radius_km",
    "sampling_design",
    "source_locator",
    "source_record_id",
    "source_url",
    "study_id",
    "study_label",
)
#: The keys a projected row adds (web format 1.1): all four on every row of an object, or none.
PROJECTION_FIELDS = ("measurement", "population_id", "rsid", "source")
#: What a row's counts may count: alleles over chromosomes, or carriers over individuals.
ROW_MEASUREMENTS = ("allele_frequency", "carrier_frequency")
#: The published catalog's fields that name an artifact.
_IDENTITY = ("variant_id", "model_version", "data_version")


@dataclass(frozen=True)
class PinnedRegistry:
    """The population registry a projection resolves every ``population_id`` in."""

    version: str
    population_ids: frozenset[str]


def json_value(value: Any) -> Any:
    """A JSON scalar for a frame cell: a missing value is ``None``, a numpy scalar its Python value."""
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        return value.item()
    return value


def serialize_rows(
    observations: pd.DataFrame,
    evidence: pd.DataFrame,
    *,
    source_url: str,
    dataset: str,
    revision: str,
) -> list[dict[str, Any]]:
    """The legacy rows: each observation joined to its source evidence, refusing incomplete metadata."""
    rows: list[dict[str, Any]] = []
    for record in observations.to_dict(orient="records"):
        source_record_id = str(record["source_record_id"])
        if source_record_id not in evidence.index:
            raise ValueError(f"observation {source_record_id}: missing source evidence")
        source = evidence.loc[source_record_id]
        population_label = source["country"]
        citation = source["citation"]
        study_id = record["cohort_id"]
        study_label = source["study_label"]
        if not isinstance(population_label, str) or not population_label.strip():
            raise ValueError(f"observation {source_record_id}: population_label is required")
        if not isinstance(citation, str) or not citation.strip():
            raise ValueError(f"observation {source_record_id}: citation_text is required")
        if not isinstance(study_id, str) or not study_id.strip():
            raise ValueError(f"observation {source_record_id}: study_id is required")
        if not isinstance(study_label, str) or not study_label.strip():
            raise ValueError(f"observation {source_record_id}: study_label is required")
        radius = json_value(record["radius_km"])
        if not isinstance(radius, (int, float)) or not math.isfinite(radius) or radius <= 0:
            raise ValueError(f"observation {source_record_id}: radius_km must be positive and finite")
        lat = float(record["lat"])
        lon = float(record["lon"])
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError(f"observation {source_record_id}: invalid coordinates")
        evidence_url = source.get("source_url", "")
        record_url = (
            str(evidence_url).strip()
            if isinstance(evidence_url, str) and evidence_url.strip()
            else f"https://huggingface.co/datasets/{dataset}/blob/{revision}/{source_url}"
        )
        source_locator = source.get("source_locator", f"MAP survey {source_record_id.split(':', 1)[1]}")
        rows.append(
            {
                "ac": int(record["ac"]),
                "an": int(record["an"]),
                "assay": str(record["assay"]),
                "citation_text": citation.strip(),
                "cohort_id": str(record["cohort_id"]),
                "disease_ascertainment_excluded": bool(record["disease_ascertainment_excluded"]),
                "ingest_version": str(record["ingest_version"]),
                "lat": lat,
                "lon": lon,
                "population_label": population_label.strip(),
                "radius_km": float(radius),
                "sampling_design": str(record["sampling_design"]),
                "source_locator": str(source_locator),
                "source_record_id": source_record_id,
                "source_url": record_url,
                "study_id": study_id.strip(),
                "study_label": study_label.strip(),
            }
        )
    return rows


def project_rows(
    consumed: pd.DataFrame,
    evidence: pd.DataFrame,
    *,
    measurement: str,
    registry: PinnedRegistry,
    source_url: str,
    dataset: str,
    revision: str,
) -> list[dict[str, Any]]:
    """The rows of the frame the fit consumed (in the fit's ``ac``/``an`` shape), in its order: each the
    legacy row plus ``measurement`` and the input's ``population_id``, ``rsid`` and ``source``."""
    if measurement not in ROW_MEASUREMENTS:
        raise ValueError(
            f"a projected row's measurement must be one of {list(ROW_MEASUREMENTS)}, not {measurement!r}: "
            "it names what the counts count (web format 1.1)"
        )
    unresolved = [str(value) for value in consumed["population_id"] if value not in registry.population_ids]
    if unresolved:
        raise ValueError(
            f"{unresolved[0]}: population_id is not in population registry {registry.version} "
            f"({len(set(unresolved))} unresolved); a projection resolves every row in the registry its "
            "artifact was fitted under (§2.7 check 5)"
        )
    projected = []
    legacy = serialize_rows(consumed, evidence, source_url=source_url, dataset=dataset, revision=revision)
    for row, record in zip(legacy, consumed.to_dict(orient="records"), strict=True):
        rsid = json_value(record["rsid"])
        if rsid is not None and (not isinstance(rsid, str) or not rsid.strip()):
            raise ValueError(
                f"observation {row['source_record_id']}: rsid {rsid!r} is neither null nor an rsID"
            )
        projected.append(
            {
                **row,
                "measurement": measurement,
                "population_id": str(record["population_id"]),
                "rsid": rsid,
                "source": str(record["source"]),
            }
        )
    return projected


def require_projectable(
    artifact: str,
    manifest: Mapping[str, Any],
    *,
    web_measurement: str,
    registry_version: str,
    registry: PinnedRegistry | None,
    released_inputs: Mapping[str, str],
) -> PinnedRegistry:
    """The registry to project ``artifact``'s fit input with, once, in this order, it has one; it is the
    one the artifact was fitted under; a committed release holds exactly the input its ``manifest``
    records; and the web artifact counts carriers exactly when the input does."""
    if registry is None:
        raise ValueError(
            f"{artifact}: its manifest records its fit input, so its observations JSON is a projection whose "
            "population_ids resolve in a registry folder; pass it with --registry"
        )
    if registry.version != registry_version:
        raise ValueError(
            f"{artifact}: fitted under population registry {registry_version}, but --registry is "
            f"{registry.version}"
        )
    released, recorded = released_inputs.get(artifact), manifest["observations"]["sha256"]
    if released is None:
        raise ValueError(
            f"{artifact}: no committed release holds its {INPUT_FILE}; only an artifact released with its "
            "fit input is projected (§2.8)"
        )
    if released != recorded:
        raise ValueError(
            f"{artifact}: its manifest records {INPUT_FILE} sha256 {recorded}, but the committed release "
            f"holds {released}"
        )
    counts = str(manifest["measurement"])
    if (counts == "carrier_frequency") != (web_measurement == "carrier_frequency"):
        raise ValueError(
            f"{artifact}: its fit input counts {counts}, but the web artifact's measurement is "
            f"{web_measurement}; rows count carrier_frequency exactly when the artifact does (#133)"
        )
    return registry


def pinned_registry(populations: pd.DataFrame | None, aliases: pd.DataFrame) -> PinnedRegistry:
    """The registry of a reference folder's two frames (``reference.read_reference``; ``populations`` is
    ``None`` for an alias-only registry): their single ``registry_version``, and every ``population_id``
    either names."""
    frames = [frame for frame in (populations, aliases) if frame is not None]
    if any("registry_version" not in frame.columns for frame in frames):
        raise ValueError(
            "a pinned population registry names its registry_version on every row of both frames"
        )
    versions = sorted({str(value) for frame in frames for value in frame["registry_version"]})
    if len(versions) != 1:
        raise ValueError(
            f"a pinned population registry has exactly one registry_version, but its frames carry {versions}"
        )
    ids = frozenset(str(value) for frame in frames for value in frame["population_id"])
    return PinnedRegistry(versions[0], ids)


def released_inputs(manifests: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """Each artifact directory whose fit input a committed release lists, with that input's sha256."""
    found: dict[str, str] = {}
    for manifest in manifests:
        for item in manifest["objects"]:
            path = str(item["path"])
            if not path.startswith(dr.ARTIFACT_PREFIX) or not path.endswith(f"/{INPUT_FILE}"):
                continue
            directory = dr.artifact_directory(path)
            if path != f"{dr.ARTIFACT_PREFIX}{directory}/{INPUT_FILE}":
                continue
            if found.setdefault(directory, item["sha256"]) != item["sha256"]:
                raise ValueError(
                    f"{directory}: committed releases list its {INPUT_FILE} as both {found[directory]} and "
                    f"{item['sha256']}; a released artifact is immutable"
                )
    return found


def require_published_digests(
    published_catalog: Mapping[str, Any],
    *,
    variant_id: str,
    model_version: str,
    data_version: str,
    digests: Mapping[str, str],
) -> None:
    """Refuse to regenerate a JSON the published catalog already serves for this artifact with other bytes.

    ``digests`` maps a catalog field (``observations_sha256``, ``surface_sha256``) to the sha256 of the
    JSON about to be written. An artifact the catalog does not serve, or a field it serves no JSON for
    (``null``), is new, not regenerated.
    """
    artifacts = published_catalog.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("the published catalog lists no artifacts")
    identity = (variant_id, model_version, data_version)
    for entry in artifacts:
        if tuple(entry.get(field) for field in _IDENTITY) != identity:
            continue
        for field, digest in sorted(digests.items()):
            published = entry.get(field)
            if published is not None and published != digest:
                raise ValueError(
                    f"{' '.join(identity)}: a published web JSON is never regenerated (§11 step 1.10): its "
                    f"{field} would become {digest}, but the published catalog serves {published}, which "
                    "every citation of it names"
                )
