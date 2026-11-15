"""Shared rows, keywords and trees for the lookup-set tests (Atlas data platform design 2026-10-18 §2.6,
§2.10).

``binned_row`` is one ``measured.allele_observations_binned`` row (rs334 in Han), unvalidated, so a test
can build the rows ``write_bin`` must refuse. Its ascertainment values are test values only: the recount
rows' ``sampling_design`` and ``disease_ascertainment_excluded`` are undecided (O1). ``W`` holds the
provenance keywords every ``write_bin`` call in the tests shares.

``macro_release`` writes the tree the lookup macros are tested on (``genomeos.tables.lookup_macros``): one
lookup set over GRCh38 with only its chr11/5 bin written, two curated files and three surfaces, all at
their release paths under ``root/data``. Its URLs are ``example-*`` placeholders, never contacted: every
test reads the local copies through ``genomeos_local`` (``attach_local``).
"""

from __future__ import annotations

import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import TypedDict

import duckdb
import pandas as pd

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.tables import writer
from genomeos.tables.binned import BINNED_COLUMNS, SOURCE_RECORD_ID_TEMPLATE, write_bin
from genomeos.tables.lookup_macros import (
    CuratedFile,
    FileRef,
    PublishedLookupSet,
    SurfaceFile,
    curated_key,
)
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, PART_FILE, BinRef, lookup_set
from genomeos.tables.provenance import InputRef


class WriteBinKeywords(TypedDict):
    """``write_bin``'s provenance keywords, typed so that ``**W`` type-checks against its signature."""

    git_sha: str
    sources: Sequence[str]
    inputs: Sequence[InputRef]


#: The provenance keywords of ``write_bin``: a commit, the 80-identity registry folder's parquet as the
#: input, and the union of its recorded sources.
W = WriteBinKeywords(
    git_sha="0" * 40,
    sources=["genomeos", "gnomad_hgdp_1kg"],
    inputs=[
        InputRef(
            "releases/2026-12-01/tables/v1/reference/populations/1.0.0-0a1b2c3d/populations.parquet",
            "a" * 64,
        )
    ],
)

_DEFAULTS: dict[str, object] = {
    "variant_id": "chr11-5227002-T-A",
    "rsid": "rs334",
    "pos": 5227002,
    "population_id": "hgdp-han",
    "source_label": "Han",
    "lat": 32.27,
    "lon": 114.02,
    "radius_km": 25.0,
    "ac": 3,
    "an": 4,
    "source": "gnomad_hgdp_1kg",
    "assay": "genome",
    "date_lower": 0,
    "date_upper": 0,
    "sampling_design": "healthy_reference",
    "disease_ascertainment_excluded": True,
    "cohort_id": "gnomad-v3.1.2-hgdp-1kg:fixture-8:d18-v1",
    "ingest_version": "fixture-1",
}


def binned_row(**overrides: object) -> pd.DataFrame:
    """One binned row in ``BINNED_COLUMNS`` order, the defaults overridden by column name."""
    unknown = sorted(set(overrides) - set(_DEFAULTS))
    if unknown:
        raise TypeError(f"binned_row() has no column {unknown}")
    values = {**_DEFAULTS, **overrides}
    return pd.DataFrame({name: [values[name]] for name in BINNED_COLUMNS})


# --- the lookup macros' tree (Task 9) ---

LOOKUP_TEST_BASE = "https://storage.googleapis.com/example-lookup/"
DATA_TEST_BASE = "https://storage.googleapis.com/example-data/"
#: The recount cohort of the macro tree's lookup set (Decision 4's form, at a 3-sample fixture stage).
RECOUNT = "gnomad-v3.1.2-hgdp-1kg:fixture-3:d18-v1"
#: The curated gnomAD TSV's cohort (Decision 4).
CURATED_TSV = "gnomad-hgdp-1kg:curated-tsv"
#: The release every file of the macro tree is published in.
MACRO_RELEASE = "2026-12-01"
RS334 = "chr11-5227002-T-A"
#: Each recounted population: its registry id, source label and coordinates.
_RECOUNT_PANEL = {
    "Yoruba": ("hgdp-yoruba", 7.4, 3.9),
    "Han": ("hgdp-han", 32.27, 114.02),
    "NorthernHan": ("hgdp-northernhan", 40.0, 116.0),
}
#: 520 km due north of Lagos (6.5244, 3.3792): inside a 500 km disc only with a radius above 20 km.
NORTH_OF_LAGOS = (11.2009, 3.3792)


@dataclass(frozen=True)
class MacroRelease:
    """The tree ``macro_release`` wrote, and what the release builder would pass the macros for it."""

    data_root: Path
    lookups: tuple[PublishedLookupSet, ...]
    curated: tuple[CuratedFile, ...]
    surfaces: tuple[SurfaceFile, ...]


def macro_release(root: Path) -> MacroRelease:
    """Write the macro tree under ``root/data``: the module docstring's lookup set, curated files and cells.

    - Lookup set ``gnomad_hgdp_1kg`` / ``2026-12-recount`` over GRCh38, only its chr11/5 bin written:
      rs334 for Yoruba (7/210), Han (0/66) and NorthernHan (0/20), and ``chr11-5227003-C-T`` for the same
      three, under ``RECOUNT``.
    - Curated A (``gnomad_hgdp_1kg``, ``tsv-fixture``): rs334 at 5/200 and 1/100 under ``CURATED_TSV``, and
      four ``hla:a-02-01`` rows.
    - Curated B (``publications``, ``pub-fixture``): two ``chrM-16519-T-C`` rows, and two
      ``chr11-5227010-G-A`` rows 520 km north of Lagos: ``near-in`` (radius 30 km), ``near-out`` (10 km).
    - Cells: HbS v1 (4 cells, no ``prior_frequency_sd``, format 1, not served), HbS v3 (5 cells, format 3,
      served) and ``kir:2dl1`` v3 (3 cells, ``carrier_frequency``, format 3, served).
    """
    data = root / "data"
    lookup = lookup_set("gnomad_hgdp_1kg", "2026-12-recount", GRCH38_LENGTHS)
    bin_rows = pd.concat(
        [
            _recount(RS334, "rs334", {"Yoruba": (7, 210), "Han": (0, 66), "NorthernHan": (0, 20)}),
            _recount("chr11-5227003-C-T", None, {"Yoruba": (2, 210), "Han": (1, 66), "NorthernHan": (0, 20)}),
        ],
        ignore_index=True,
    )
    write_bin(bin_rows, data, lookup, BinRef("chr11", 5), **W)
    published = PublishedLookupSet(
        lookup, f"{LOOKUP_TEST_BASE}releases/{MACRO_RELEASE}/", SOURCE_RECORD_ID_TEMPLATE
    )
    hla = [
        ("hgdp-yoruba", 7.4, 3.9),
        ("hgdp-han", 32.27, 114.02),
        ("hgdp-french", 46.0, 2.0),
        ("hgdp-pima", 29.0, -108.0),
    ]
    curated_a = pd.concat(
        [
            _curated(RS334, "rs334", "hgdp-yoruba", 7.4, 3.9, 5, 200, cohort_id=CURATED_TSV),
            _curated(RS334, "rs334", "hgdp-han", 32.27, 114.02, 1, 100, cohort_id=CURATED_TSV),
            *(
                _curated("hla:a-02-01", None, population, lat, lon, 20 + i, 100, cohort_id=CURATED_TSV)
                for i, (population, lat, lon) in enumerate(hla)
            ),
        ],
        ignore_index=True,
    )
    publication = partial(
        _curated, source="publications", ingest_version="pub-fixture", cohort_id="pub-fixture:cohort-1"
    )
    curated_b = pd.concat(
        [
            publication("chrM-16519-T-C", "rs3937033", "pub-a", 9.0, 7.5, 40, 50),
            publication("chrM-16519-T-C", "rs3937033", "pub-b", 51.5, -0.1, 12, 50),
            publication("chr11-5227010-G-A", None, "near-in", *NORTH_OF_LAGOS, 1, 100, radius_km=30.0),
            publication("chr11-5227010-G-A", None, "near-out", *NORTH_OF_LAGOS, 2, 100, radius_km=10.0),
        ],
        ignore_index=True,
    )
    curated = tuple(
        write_curated(data / path, rows, url=f"{DATA_TEST_BASE}releases/{MACRO_RELEASE}/{path}")
        for path, rows in (
            (_curated_path("gnomad_hgdp_1kg", "tsv-fixture"), curated_a),
            (_curated_path("publications", "pub-fixture"), curated_b),
        )
    )
    hbs = {"measurement": "allele_frequency"}
    surfaces = (
        _surface(data, RS334, "v1", "map-2026-08", 4, **hbs, artifact_format=1, served=False),
        _surface(data, RS334, "v3", "map-2026-08", 5, **hbs, artifact_format=3, served=True),
        _surface(
            data,
            "kir:2dl1",
            "v3",
            "afnd-2026-08",
            3,
            measurement="carrier_frequency",
            artifact_format=3,
            served=True,
        ),
    )
    return MacroRelease(data, (published,), curated, surfaces)


def write_curated(path: Path, rows: pd.DataFrame, *, url: str) -> CuratedFile:
    """Write ``rows`` as a ``measured.allele_observations`` file at ``path`` through the pinned writer.

    ``path`` lies at its release path (``tables/v1/measured/...``) under a data root, and ``url`` is its
    public URL. The file's key set is ``curated_key`` of each of its ids.
    """
    frame = OBSERVATIONS_SCHEMA.validate(rows).reindex(columns=list(OBSERVATIONS_SCHEMA.columns))
    con = writer.connect()
    try:
        writer.write_frame(
            con,
            frame,
            path,
            table="measured.allele_observations",
            git_sha=W["git_sha"],
            inputs=W["inputs"],
            sources=W["sources"],
            order_by=("source_record_id",),
        )
    finally:
        con.close()
    parts = path.parts
    start = len(parts) - 1 - parts[::-1].index("tables")
    keys = frozenset(curated_key(variant_id) for variant_id in frame["variant_id"])
    return CuratedFile(FileRef("/".join(parts[start:]), url), keys)


def write_cells(path: Path, rows: pd.DataFrame, *, with_prior_sd: bool) -> None:
    """Write ``rows`` as a ``cells.parquet`` at ``path``; without ``prior_frequency_sd`` (formats 1 and 2)
    unless ``with_prior_sd``."""
    frame = rows if with_prior_sd else rows.drop(columns="prior_frequency_sd")
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(path, index=False)


def attach_local(statements: Sequence[str], data_root: Path, local: str) -> duckdb.DuckDBPyConnection:
    """A pinned DuckDB with ``statements`` built into a catalog by ``build_catalog_db``, attached read-only
    as ``atlas``, reading offline from ``local`` (``SET VARIABLE genomeos_local``)."""
    sql = "\n".join(["CREATE SCHEMA measured;", "CREATE SCHEMA inferred;", *statements]) + "\n"
    database = Path(tempfile.mkdtemp(prefix="catalog-", dir=data_root.parent)) / "atlas.duckdb"
    writer.build_catalog_db(sql, database, data_root=data_root)
    con = writer.connect()
    con.execute(f"ATTACH '{database}' AS atlas (READ_ONLY)")
    con.execute("SET VARIABLE genomeos_local = ?", [local])
    return con


def _recount(variant_id: str, rsid: str | None, counts: Mapping[str, tuple[int, int]]) -> pd.DataFrame:
    """One bin row per population of ``counts`` (source label: ``(ac, an)``), under ``RECOUNT``."""
    rows = []
    for label, (ac, an) in counts.items():
        population_id, lat, lon = _RECOUNT_PANEL[label]
        rows.append(
            binned_row(
                variant_id=variant_id,
                rsid=rsid,
                pos=int(variant_id.split("-")[1]),
                population_id=population_id,
                source_label=label,
                lat=lat,
                lon=lon,
                ac=ac,
                an=an,
                cohort_id=RECOUNT,
                ingest_version="2026-12-recount",
            )
        )
    return pd.concat(rows, ignore_index=True)


def _curated(
    variant_id: str,
    rsid: str | None,
    population_id: str,
    lat: float,
    lon: float,
    ac: int,
    an: int,
    *,
    cohort_id: str,
    source: str = "gnomad_hgdp_1kg",
    ingest_version: str = "tsv-fixture",
    radius_km: float = 25.0,
) -> pd.DataFrame:
    """One curated row: the binned defaults with a stored ``source_record_id``, and no ``pos`` or label."""
    values = {
        **_DEFAULTS,
        "variant_id": variant_id,
        "rsid": rsid,
        "population_id": population_id,
        "lat": lat,
        "lon": lon,
        "radius_km": radius_km,
        "ac": ac,
        "an": an,
        "source_record_id": f"{source}:{ingest_version}:{variant_id}:{population_id}",
        "source": source,
        "cohort_id": cohort_id,
        "ingest_version": ingest_version,
    }
    return pd.DataFrame({name: [values[name]] for name in OBSERVATIONS_SCHEMA.columns})


def _curated_path(source: str, ingest_version: str) -> str:
    return (
        f"tables/v1/measured/allele_observations/source={source}/ingest_version={ingest_version}/{PART_FILE}"
    )


def _surface(
    data: Path,
    variant_id: str,
    model_version: str,
    data_version: str,
    n_cells: int,
    *,
    measurement: str,
    artifact_format: int,
    served: bool,
) -> SurfaceFile:
    """Write one artifact's ``cells.parquet`` of ``n_cells`` cells under ``data`` and describe it."""
    directory = "__".join((variant_id.replace(":", "__"), model_version, data_version))
    path = f"store/artifacts/{directory}/cells.parquet"
    cells = pd.DataFrame(
        {
            "h3_index": [f"84589c{i:x}ffffffff" for i in range(n_cells)],
            "variant_id": variant_id,
            "post_median": [0.1 + i / 100 for i in range(n_cells)],
            "post_mean": [0.1 + i / 100 for i in range(n_cells)],
            "post_sd": 0.02,
            "prior_frequency_sd": 0.05,
            "q025": 0.05,
            "q975": 0.2,
            "q25": 0.08,
            "q75": 0.12,
            "support": "measured",
            "posterior_contraction": 0.6,
            "dist_nearest_obs_km": [10.0 * i for i in range(n_cells)],
            "model_version": model_version,
            "data_version": data_version,
        }
    )
    with_prior_sd = artifact_format >= 3
    write_cells(data / path, cells, with_prior_sd=with_prior_sd)
    columns = frozenset(cells.columns) - (set() if with_prior_sd else {"prior_frequency_sd"})
    return SurfaceFile(
        FileRef(path, f"{DATA_TEST_BASE}releases/{MACRO_RELEASE}/{path}"),
        variant_id,
        model_version,
        data_version,
        measurement,
        artifact_format,
        served,
        columns,
    )
