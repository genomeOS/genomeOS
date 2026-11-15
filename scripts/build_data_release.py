#!/usr/bin/env python3
"""Build a data-store release manifest from the local ``data/`` tree (data store design 2026-10-17 §5).

    python scripts/build_data_release.py --release 2026-10-17

Hashes every file under the include roots, maps each path to its sources with the reviewed table
below, copies the terms each source's record already holds, and writes
``data/releases/<release>.json`` (sorted, no clock: the same tree gives the same bytes). Earlier
committed releases are read so a byte-identical file reuses its earlier key and a published artifact
whose bytes changed is refused. A release file that already exists is never replaced: an identical
rebuild reports "unchanged", a different one is a hard error.

Nothing outside ``INCLUDE`` is published: fits (pickles, design §8) and the raw third-party harvests
(phase 2) stay local. A pickle or an object-dtype ``.npy`` inside an include root is refused, and so
is a path no rule claims; nothing is ever given a source by default.

Inputs travel with outputs (#45): every artifact carries ``observations.parquet``, the table its fit
consumed, recorded in its ``manifest.json``. An artifact without it, or whose record does not match the
file, is refused. The artifacts released before that rule are named in ``RELEASED_WITHOUT_INPUT``, each
with a reason; they are immutable, so none of them may gain the file.

The catalog (Atlas data platform design 2026-10-18 §2.6, §2.7 check 7; calls 4 and 17) is built in two
passes, after ``build_tables.py`` has written the release's ``tables/``:

1. key everything outside ``catalog/``, then run checks 1, 2, 6, 9 and 10 on every ``tables/`` file;
2. write ``catalog/catalog.sql`` over those keys;
3. build ``catalog/atlas.duckdb`` from it twice, over the local copies only, and require identical bytes;
4. write ``catalog/tables.json``, then run check 7 on both files against the keys and ``WITHDRAWN.json``;
5. refuse any other file under ``catalog/``;
6. key the three: ``catalog.sql`` is committed (in git), and each carries the union of the sources of the
   files it lists (call 16);
7. write the manifest, which the catalog therefore never names (``meta.release`` names its key instead).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from collections.abc import Callable, Collection, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import artifact_inputs as ai  # noqa: E402
from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.tables import catalog as tables_catalog  # noqa: E402  (build's flag is ``catalog``)
from genomeos.tables import checks, contracts, provenance, writer  # noqa: E402
from genomeos.tables.contracts import TableError  # noqa: E402

DATA = ROOT / "data"
RELEASES = DATA / "releases"
CHUNK = 1 << 20
#: The include root the catalog pass writes; the first pass keys everything else.
CATALOG_ROOT = "catalog"

#: Paths under data/ that a release publishes (design §3 C7). Everything else stays local.
INCLUDE = (
    "catalog",
    "raw/afnd_populations.tsv",
    "registry",
    "sources",
    "store/INVENTORY.json",
    "store/artifacts",
    "store/catalog-metadata.json",
    "tables",
    "validation",
)
#: Include roots a tree may lack until a release publishes under them (Atlas data platform design
#: 2026-10-18 §2.3): the v1 tables and their catalog arrive with release 1. Once published, each is
#: required.
OPTIONAL_ROOTS: tuple[str, ...] = ("catalog", "tables")

#: The 994 MAP HbS surveys the 2026-09-16 golden-test-1 run fit, as that run serialized them (#45).
PARITY_INPUT = "hbs-piel-parity-2026-09-16"

#: Artifacts the 2026-10-17 release published before an artifact carried the observation table its fit
#: consumed (#45). A released artifact is immutable and cannot gain a file, so each is named here with
#: why it has none. ``artifact_inputs`` refuses an entry no earlier release holds, so a new artifact can
#: never be added, and an entry an earlier release holds with its input, so an input once released can
#: never be dropped. A recovered input is published under a new key, never added to one of these.
_BARE = "released 2026-10-17, before an artifact carried the table its fit consumed (#45)"
_MAP_HBS = (
    f"{_BARE}; its fit read MAP HbS survey rows (data_version map-2026-08; its manifest records 1,071), "
    "which the data store does not hold. The 994 rows under validation/hbs-piel-parity-2026-09-16/ are "
    "the 2026-09-16 parity run's input, not this artifact's"
)
_MAP_G6PD = (
    f"{_BARE}; its fit read MAP G6PD survey rows (data_version map-2026-08) from a raw MAP export the "
    "data store does not hold"
)
_AFND = (
    f"{_BARE}; its fit read allele counts from the AFND frequency harvest (data_version afnd-2026-08), "
    "a raw harvest the data store does not hold"
)
_AFND_KIR = (
    f"{_BARE}; its fit read KIR carrier counts from the AFND frequency harvest (data_version "
    "afnd-2026-08), a raw harvest the data store does not hold"
)
RELEASED_WITHOUT_INPUT: dict[str, str] = {
    "chr11-5227002-T-A__v1__map-2026-08": _MAP_HBS,
    "chr11-5227002-T-A__v2__map-2026-08": _MAP_HBS,
    "chr11-5227002-T-A__v3__map-2026-08": _MAP_HBS,
    "cyt__il-10-1082-g__v2__afnd-2026-08": _AFND,
    "cyt__il-10-1082-g__v3__afnd-2026-08": _AFND,
    "cyt__il-10-819-t__v2__afnd-2026-08": _AFND,
    "cyt__il-10-819-t__v3__afnd-2026-08": _AFND,
    "cyt__il-6-174-c__v2__afnd-2026-08": _AFND,
    "cyt__il-6-174-c__v3__afnd-2026-08": _AFND,
    "cyt__tnfalpha-308-a__v2__afnd-2026-08": _AFND,
    "cyt__tnfalpha-308-a__v3__afnd-2026-08": _AFND,
    "hla__a-02-01__v2__afnd-2026-08": _AFND,
    "hla__a-02-01__v3__afnd-2026-08": _AFND,
    "hla__a-26-01__v2__afnd-2026-08": _AFND,
    "hla__a-26-01__v3__afnd-2026-08": _AFND,
    "hla__a-32-01__v2__afnd-2026-08": _AFND,
    "hla__a-32-01__v3__afnd-2026-08": _AFND,
    "hla__b-40-01__v2__afnd-2026-08": _AFND,
    "hla__b-40-01__v3__afnd-2026-08": _AFND,
    "hla__b-40-02__v2__afnd-2026-08": _AFND,
    "hla__b-40-02__v3__afnd-2026-08": _AFND,
    "hla__b-58-01__v2__afnd-2026-08": _AFND,
    "hla__b-58-01__v3__afnd-2026-08": _AFND,
    "hla__c-03-03__v2__afnd-2026-08": _AFND,
    "hla__c-03-03__v3__afnd-2026-08": _AFND,
    "hla__c-06-02__v2__afnd-2026-08": _AFND,
    "hla__c-06-02__v3__afnd-2026-08": _AFND,
    "hla__c-07-02__v2__afnd-2026-08": _AFND,
    "hla__c-07-02__v3__afnd-2026-08": _AFND,
    "hla__dpb1-04-01__v2__afnd-2026-08": _AFND,
    "hla__dpb1-04-01__v3__afnd-2026-08": _AFND,
    "hla__dpb1-04-02__v2__afnd-2026-08": _AFND,
    "hla__dpb1-04-02__v3__afnd-2026-08": _AFND,
    "hla__dpb1-13-01__v2__afnd-2026-08": _AFND,
    "hla__dpb1-13-01__v3__afnd-2026-08": _AFND,
    "hla__dqb1-03-01__v2__afnd-2026-08": _AFND,
    "hla__dqb1-03-01__v3__afnd-2026-08": _AFND,
    "hla__dqb1-06-02__v2__afnd-2026-08": _AFND,
    "hla__dqb1-06-02__v3__afnd-2026-08": _AFND,
    "hla__drb1-01-01__v2__afnd-2026-08": _AFND,
    "hla__drb1-01-01__v3__afnd-2026-08": _AFND,
    "hla__drb1-04-03__v2__afnd-2026-08": _AFND,
    "hla__drb1-04-03__v3__afnd-2026-08": _AFND,
    "hla__drb1-07-01__v2__afnd-2026-08": _AFND,
    "hla__drb1-07-01__v3__afnd-2026-08": _AFND,
    "hla__drb1-11-01__v2__afnd-2026-08": _AFND,
    "hla__drb1-11-01__v3__afnd-2026-08": _AFND,
    "hla__drb1-14-01__v2__afnd-2026-08": _AFND,
    "hla__drb1-14-01__v3__afnd-2026-08": _AFND,
    "hla__drb1-15-01__v2__afnd-2026-08": _AFND,
    "hla__drb1-15-01__v3__afnd-2026-08": _AFND,
    "kir__2dl1__v2__afnd-2026-08": _AFND_KIR,
    "kir__2dl1__v3__afnd-2026-08": _AFND_KIR,
    "kir__2dl2__v2__afnd-2026-08": _AFND_KIR,
    "kir__2dl2__v3__afnd-2026-08": _AFND_KIR,
    "kir__2ds1__v2__afnd-2026-08": _AFND_KIR,
    "kir__2ds1__v3__afnd-2026-08": _AFND_KIR,
    "kir__3ds1__v2__afnd-2026-08": _AFND_KIR,
    "kir__3ds1__v3__afnd-2026-08": _AFND_KIR,
    "phenotype__g6pd-deficiency__v1__map-2026-08": _MAP_G6PD,
    "phenotype__g6pd-deficiency__v3__map-2026-08": _MAP_G6PD,
}

CPIC_RECORD = "sources/cpic/v1.60.0/SOURCE.json"
CURATED_RECORD = "sources/curated/SOURCE.json"
ARTIFACT_DATA_SOURCES = {"map-": "map", "afnd-": "afnd"}

#: Reviewed terms for sources with no machine-readable record under data/. Each value is copied from
#: the place named in ``recorded_in``; where the repository records no check, the status is
#: ``not_checked`` and the gap is stated rather than filled (AGENTS publication-evidence safeguards).
REVIEWED_SOURCES: dict[str, dict[str, Any]] = {
    "afnd": {
        "name": "Allele Frequency Net Database (AFND)",
        "citation": (
            "Gonzalez-Galarza et al., Allele frequency net database (AFND) 2020 update, Nucleic Acids "
            "Research 48:D783, doi:10.1093/nar/gkz1029"
        ),
        "url": "https://www.allelefrequencies.net/",
        "terms": {
            "status": "no_restriction_found",
            "checked_at": "2026-08-25",
            "terms_url": "https://www.allelefrequencies.net/contact.asp",
            "recorded_in": "https://github.com/genomeOS/genomeOS/issues/117",
            "note": (
                "AFND publishes no standalone licence; under the owner-approved policy (#149) a "
                "completed check that finds no explicit restriction is no_restriction_found."
            ),
        },
        "non_commercial": False,
    },
    "map": {
        "name": "Malaria Atlas Project (MAP) HbS and G6PD survey databases",
        "citation": (
            "Piel et al., Global epidemiology of sickle haemoglobin in neonates, The Lancet 381:142 "
            "(2013); Howes et al., G6PD deficiency prevalence and estimates of affected populations in "
            "malaria endemic countries, PLoS Medicine 9:e1001339 (2012)"
        ),
        "url": "https://data.malariaatlas.org/",
        "terms": {
            "status": "no_restriction_found",
            "checked_at": "2026-10-18",
            "terms_url": "https://malariaatlas.org/open-access-policy/",
            "recorded_in": "docs/research/hbs-piel-parity-2026-09-16.md",
            "note": (
                "MAP's open-access policy covers all its survey data, HbS and G6PD layers alike: the "
                "data are not owned by MAP, public survey data have no restrictions to access or use, "
                "and users are asked to cite the original sources. The owner approved open "
                "redistribution of the HbS survey rows on 2026-10-18 (the 2026-09-16 parity input)."
            ),
        },
        "non_commercial": False,
    },
    "worldpop": {
        "name": "WorldPop gridded population (the surface target grid)",
        "citation": "WorldPop, University of Southampton. doi:10.5258/SOTON/WP00647",
        "url": "https://hub.worldpop.org/",
        "terms": {
            "status": "explicitly_open",
            "checked_at": "2026-11-14",
            "terms_url": "https://hub.worldpop.org/",
            "licence": "CC-BY-4.0",
            "recorded_in": "docs/audits/worldpop-commercial-use.md",
            "note": (
                "WorldPop's hub states that WorldPop datasets are licensed under CC BY 4.0, recorded "
                "as explicitly_open by the owner's decision D5b (2026-10-19; "
                "docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md §1.1). WorldPop "
                "selects the population-positive H3 cells a format-2 surface is predicted on."
            ),
        },
        "non_commercial": False,
    },
    "genomeos": {
        "name": "genomeOS project-authored data and outputs",
        "url": "https://github.com/genomeOS/genomeOS",
        "terms": {
            "status": "explicitly_open",
            "checked_at": "2026-10-19",
            "terms_url": "https://creativecommons.org/licenses/by/4.0/",
            "licence": "CC-BY-4.0",
            "recorded_in": "README.md",
            "note": (
                "Project-authored data and outputs are CC BY 4.0 by the owner's decision D5a "
                "(2026-10-19; docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md §1.1). "
                "Apache-2.0 covers source code and documentation."
            ),
        },
        "non_commercial": False,
    },
}


def _record_sources(data_root: Path) -> dict[str, dict[str, Any]]:
    """CPIC, ClinVar and GeneReviews terms, copied from the committed SOURCE.json records."""
    cpic = json.loads((data_root / CPIC_RECORD).read_text(encoding="utf-8"))
    curated = json.loads((data_root / CURATED_RECORD).read_text(encoding="utf-8"))["sources"]
    found = {
        "cpic": {
            "name": cpic["source"],
            "url": cpic["source_url"],
            "terms": {
                "status": cpic["terms_status"],
                "checked_at": cpic["terms_checked_at"],
                "terms_url": cpic["terms_url"],
                "licence": cpic["content_license"],
                "recorded_in": f"{dr.LOCAL_ROOT}/{CPIC_RECORD}",
            },
            "non_commercial": False,
        }
    }
    for source_id, name in (("clinvar", "ClinVar"), ("genereviews", "GeneReviews")):
        record = curated[name]
        found[source_id] = {
            "name": record["attribution"],
            "url": record["url"],
            "terms": {
                "status": record["reuse_status"],
                "terms_url": record["terms_url"],
                "recorded_in": f"{dr.LOCAL_ROOT}/{CURATED_RECORD}",
                "note": record["usage_note"],
            },
            # NON-COMMERCIAL: GeneReviews' reproduction terms are non-commercial (its record says
            # restriction_found). The curated table stores links and identifiers only, but the marker
            # is carried so an extraction finds every object that names GeneReviews.
            "non_commercial": source_id == "genereviews",
        }
    return found


def _artifact_sources(data_root: Path, path: str) -> tuple[str, ...]:
    directory = path.split("/")[2]
    data_version = directory.rsplit("__", 1)[-1]
    source = next(
        (name for prefix, name in ARTIFACT_DATA_SOURCES.items() if data_version.startswith(prefix)), None
    )
    if source is None:
        raise dr.DataReleaseError(
            f"{path}: data_version {data_version!r} has no reviewed source; add it to ARTIFACT_DATA_SOURCES"
        )
    manifest_path = data_root / dr.ARTIFACT_PREFIX / directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("data_version") != data_version:
        raise dr.DataReleaseError(
            f"{path}: directory data_version {data_version!r} differs from its manifest's "
            f"{manifest.get('data_version')!r}"
        )
    # The grid chose the cells a surface is predicted on; it contributed nothing to the input's rows.
    if path.endswith(f"/{ai.INPUT_FILE}"):
        return (source,)
    grid = manifest.get("target_grid_source") or ""
    return (source, "worldpop") if grid.startswith("worldpop") else (source,)


_RULES: tuple[tuple[Callable[[str], bool], Callable[[Path, str], tuple[str, ...]]], ...] = (
    (lambda path: path.startswith(dr.ARTIFACT_PREFIX), _artifact_sources),
    # A derived table records the union of its inputs' sources (Atlas data platform design 2026-10-18
    # §9, call 16); a file that records none is refused.
    (lambda path: path.startswith("tables/"), provenance.recorded_sources),
    (lambda path: path.startswith("validation/crossval_"), lambda root, path: ("map",)),
    (lambda path: path.startswith(f"validation/{PARITY_INPUT}/"), lambda root, path: ("map",)),
    (lambda path: path.startswith("validation/b0h-timing-"), lambda root, path: ("genomeos",)),
    (lambda path: path == "raw/afnd_populations.tsv", lambda root, path: ("afnd",)),
    (lambda path: path.startswith("sources/cpic/"), lambda root, path: ("cpic",)),
    (lambda path: path.startswith("sources/curated/"), lambda root, path: ("clinvar", "genereviews")),
    (
        lambda path: path.startswith("registry/curated-v1-candidate.1/"),
        lambda root, path: ("clinvar", "cpic", "genereviews"),
    ),
    (
        lambda path: path
        in {"registry/variant_normalization.tsv", "store/INVENTORY.json", "store/catalog-metadata.json"},
        lambda root, path: ("genomeos",),
    ),
)


def sources_for(data_root: Path, path: str) -> tuple[str, ...]:
    for matches, sources in _RULES:
        if matches(path):
            return sources(data_root, path)
    raise dr.DataReleaseError(f"{path}: no reviewed source rule; add one to _RULES rather than guessing")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _refuse_pickled_npy(path: Path, relative: str) -> None:
    with path.open("rb") as stream:
        version = np.lib.format.read_magic(stream)
        if version == (1, 0):
            _, _, dtype = np.lib.format.read_array_header_1_0(stream)
        else:
            _, _, dtype = np.lib.format.read_array_header_2_0(stream)
    if dtype.hasobject:
        raise dr.DataReleaseError(f"{relative}: object-dtype .npy holds a pickle and is never published")


def included_files(
    data_root: Path, *, published: Collection[str] = (), roots: Sequence[str] = INCLUDE
) -> list[str]:
    """Every file under ``roots`` (the include roots). An absent optional root is skipped only while no
    path in ``published`` (what earlier releases hold) lies under it; any other absent root is an error."""
    found: list[str] = []
    for root in roots:
        base = data_root / root
        if base.is_file():
            found.append(root)
        elif base.is_dir():
            found.extend(path.relative_to(data_root).as_posix() for path in base.rglob("*") if path.is_file())
        elif root in OPTIONAL_ROOTS and not any(
            path == root or path.startswith(f"{root}/") for path in published
        ):
            continue
        else:
            raise dr.DataReleaseError(f"include root data/{root} is missing; fetch it first")
    return sorted(found)


def collect(
    data_root: Path, tracked: set[str], *, published: Collection[str] = (), roots: Sequence[str] = INCLUDE
) -> list[dr.FileRecord]:
    records: list[dr.FileRecord] = []
    for relative in included_files(data_root, published=published, roots=roots):
        dr.media_type_for(relative)  # refuses pickles before anything is hashed
        path = data_root / relative
        if relative.endswith(".npy"):
            _refuse_pickled_npy(path, relative)
        sources = sources_for(data_root, relative)
        records.append(
            dr.FileRecord(relative, path.stat().st_size, sha256_of(path), relative in tracked, sources)
        )
    return records


def check_inputs(
    data_root: Path,
    records: Sequence[dr.FileRecord],
    previous: Sequence[Mapping[str, Any]],
    released_without_input: Mapping[str, str],
) -> None:
    """Measure every artifact's ``observations.parquet`` and refuse a missing or misdescribed one (#45)."""
    manifests: dict[str, dict[str, Any]] = {}
    inputs: dict[str, ai.InputFile] = {}
    for record in records:
        if not record.path.startswith(dr.ARTIFACT_PREFIX):
            continue
        directory = dr.artifact_directory(record.path)
        if directory not in manifests:
            manifest_path = data_root / dr.ARTIFACT_PREFIX / directory / "manifest.json"
            manifests[directory] = json.loads(manifest_path.read_text(encoding="utf-8"))
        if record.path == f"{dr.ARTIFACT_PREFIX}{directory}/{ai.INPUT_FILE}":
            metadata = pq.read_metadata(data_root / record.path)
            schema = metadata.schema.to_arrow_schema()
            inputs[directory] = ai.InputFile(
                record.sha256,
                record.bytes,
                metadata.num_rows,
                columns=tuple(schema.names),
                types=tuple(str(field.type) for field in schema),
            )
    released: set[str] = set()
    released_with_input: set[str] = set()
    for manifest in previous:
        for item in dr.validate_manifest(manifest):
            if not item.path.startswith(dr.ARTIFACT_PREFIX):
                continue
            directory = dr.artifact_directory(item.path)
            released.add(directory)
            if item.path == f"{dr.ARTIFACT_PREFIX}{directory}/{ai.INPUT_FILE}":
                released_with_input.add(directory)
    ai.check_artifact_inputs(
        manifests,
        inputs,
        released=released,
        released_with_input=released_with_input,
        released_without_input=released_without_input,
    )


def build(
    data_root: Path,
    release: str,
    *,
    tracked: set[str],
    released_without_input: Mapping[str, str],
    previous: Sequence[Mapping[str, Any]] = (),
    withdrawn: Sequence[dr.Withdrawal] = (),
    catalog: bool = False,
) -> dict[str, Any]:
    """The release manifest of ``data_root``; with ``catalog``, the two passes of the module docstring.

    ``withdrawn`` is ``WITHDRAWN.json``'s list, which the release's ``meta.withdrawn`` must restate.
    """
    published = {item.path for manifest in previous for item in dr.validate_manifest(manifest)}
    roots = tuple(root for root in INCLUDE if root != CATALOG_ROOT) if catalog else INCLUDE
    records = collect(data_root, tracked, published=published, roots=roots)
    check_inputs(data_root, records, previous, released_without_input)
    manifest = _manifest(data_root, records, release, previous)
    if not catalog:
        return manifest
    objects = dr.validate_manifest(manifest)
    checks.check_release_tables(
        data_root,
        objects,
        manifests=previous,
        repo_root=ROOT,
        new_sources={record.path: record.sources for record in records},
    )
    listed = write_catalog(data_root, release, objects, tracked=tracked, withdrawn=withdrawn)
    return _manifest(data_root, [*records, *listed], release, previous)


def _manifest(
    data_root: Path, records: Sequence[dr.FileRecord], release: str, previous: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    used = {name for record in records for name in record.sources}
    available = {**REVIEWED_SOURCES, **_record_sources(data_root)}
    return dr.build_manifest(records, {name: available[name] for name in used}, release, previous)


def listed_files(
    data_root: Path, objects: Sequence[dr.ReleaseObject]
) -> tuple[tables_catalog.CatalogFile, ...]:
    """The files of ``objects`` the catalog's views read, each with the row count of its local copy."""
    rows = {
        item.path: pq.read_metadata(data_root / item.path).num_rows
        for item in objects
        if tables_catalog.catalog_table(item.path) is not None
    }
    return tables_catalog.catalog_files(objects, rows)


def write_catalog(
    data_root: Path,
    release: str,
    objects: Sequence[dr.ReleaseObject],
    *,
    tracked: Collection[str],
    withdrawn: Sequence[dr.Withdrawal],
) -> list[dr.FileRecord]:
    """Passes 2-6: ``catalog/`` over the first pass's ``objects``, and its three files as records."""
    keys = frozenset(entry.key for entry in withdrawn)
    _check_withdrawn_table(data_root, objects, keys)
    files = listed_files(data_root, objects)
    sql = tables_catalog.render_catalog_sql(release, files)
    (data_root / CATALOG_ROOT).mkdir(exist_ok=True)
    (data_root / tables_catalog.CATALOG_SQL).write_text(sql, encoding="utf-8")
    database = writer.build_catalog_db(sql, data_root / tables_catalog.CATALOG_DB, data_root=data_root)
    with tempfile.TemporaryDirectory() as scratch:
        again = writer.build_catalog_db(sql, Path(scratch) / "atlas.duckdb", data_root=data_root)
        if again.read_bytes() != database.read_bytes():
            database.unlink()
            raise TableError(
                f"{tables_catalog.CATALOG_DB}: two builds differ; the catalog builds byte for byte from "
                "catalog.sql with the pinned DuckDB (§2.7 check 7, call 15)"
            )
    tables_json = tables_catalog.render_tables_json(release, files)
    (data_root / tables_catalog.TABLES_JSON).write_bytes(tables_json)
    tables_catalog.check_catalog(sql, tables_json, {item.key: item for item in objects}, keys)
    found = (path.relative_to(data_root).as_posix() for path in (data_root / CATALOG_ROOT).rglob("*"))
    written = set(tables_catalog.CATALOG_PATHS)
    stray = sorted(path for path in found if path not in written and (data_root / path).is_file())
    if stray:
        raise dr.DataReleaseError(
            f"{stray[0]}: data/{CATALOG_ROOT}/ holds only catalog.sql, atlas.duckdb and tables.json, which "
            f"the release build writes; remove {len(stray)} other file(s) and build again"
        )
    by_path = {item.path: item for item in objects}
    sources = tuple(sorted({name for file in files for name in by_path[file.path].sources}))
    return [
        dr.FileRecord(
            path,
            (data_root / path).stat().st_size,
            sha256_of(data_root / path),
            path == tables_catalog.CATALOG_SQL or path in tracked,
            sources,
        )
        for path in tables_catalog.CATALOG_PATHS
    ]


def _check_withdrawn_table(
    data_root: Path, objects: Sequence[dr.ReleaseObject], keys: frozenset[str]
) -> None:
    """The release's ``meta.withdrawn`` restates ``keys``, the list check 7 refuses: the views anti-join
    that table, so a stale one would serve what the committed list withdraws."""
    path = contracts.table_path(tables_catalog.WITHDRAWN_TABLE)
    if not any(item.path == path for item in objects):
        return  # catalog_files refuses a release without it
    found = frozenset(pq.read_table(data_root / path, columns=["key"]).column("key").to_pylist())
    if found != keys:
        raise TableError(
            f"{path} withdraws {sorted(found)}, but {dr.WITHDRAWN_FILE} lists {sorted(keys)}; rebuild the "
            "tables from the committed list: python scripts/build_tables.py"
        )


def withdrawn_entries(directory: Path) -> tuple[dr.Withdrawal, ...]:
    """``directory``'s ``WITHDRAWN.json`` (beside the manifests), or nothing when it has none."""
    path = directory / dr.WITHDRAWN_FILE
    if not path.is_file():
        return ()
    return dr.validate_withdrawn(json.loads(path.read_text(encoding="utf-8")))


def git_tracked(data_root: Path) -> set[str]:
    """Paths under ``data_root`` that git tracks, relative to it (the ``in_git`` field)."""
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--", "."], cwd=data_root, capture_output=True, check=True
    ).stdout.decode("utf-8")
    return {entry for entry in listing.split("\0") if entry}


def earlier_releases(directory: Path, release: str) -> list[dict[str, Any]]:
    names = dr.release_ids(path.name for path in directory.glob("*.json"))
    manifests = [json.loads((directory / f"{name}.json").read_text(encoding="utf-8")) for name in names]
    return [m for m in manifests if dr.release_sort_key(m["release"]) < dr.release_sort_key(release)]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a data-store release manifest from data/.")
    parser.add_argument("--release", type=dr.assert_release_id, required=True, help="YYYY-MM-DD[.N]")
    parser.add_argument("--data", type=Path, default=DATA, help="the data/ tree (default: the checkout's)")
    parser.add_argument("--out", type=Path, help="default: data/releases/<release>.json")
    parser.add_argument("--no-git", action="store_true", help="treat nothing as git-tracked (tests)")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out = args.out or RELEASES / f"{args.release}.json"
    try:
        tracked = set() if args.no_git else git_tracked(args.data)
        previous = earlier_releases(out.parent, args.release)
        manifest = build(
            args.data,
            args.release,
            tracked=tracked,
            released_without_input=RELEASED_WITHOUT_INPUT,
            previous=previous,
            withdrawn=withdrawn_entries(out.parent),
            catalog=True,
        )
    except (dr.DataReleaseError, OSError, KeyError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    sql = (args.data / tables_catalog.CATALOG_SQL).read_text(encoding="utf-8")
    views, urls = tables_catalog.catalog_views(sql), tables_catalog.catalog_urls(sql)
    database = next(item for item in manifest["objects"] if item["path"] == tables_catalog.CATALOG_DB)
    print(
        f"catalog: {len(views)} views over {len(urls)} files; atlas.duckdb {database['bytes']:,} bytes, "
        "identical over two builds"
    )
    payload = dr.canonical_bytes(manifest)
    if out.exists():
        if out.read_bytes() != payload:
            print(
                f"error: {out} exists with different content; a release is immutable once written. "
                "Build a new release id instead.",
                file=sys.stderr,
            )
            return 1
        print(f"unchanged {out}")
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(payload)
        print(f"wrote {out}")
    totals = manifest["totals"]
    print(
        f"release {args.release}: {totals['objects']} objects, {totals['bytes']:,} bytes "
        f"({totals['in_git_objects']} objects, {totals['in_git_bytes']:,} bytes also tracked in git)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
