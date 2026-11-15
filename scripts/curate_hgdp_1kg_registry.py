#!/usr/bin/env python3
"""Curate the coordinates of the 80 HGDP + 1KG identities from gnomAD's sample metadata.

Atlas data platform design 2026-10-18 §1.2 D18 item 1 and §2.4; step 1.7 (phase-1 plan flags F1, F2).

    python scripts/curate_hgdp_1kg_registry.py --metadata "$SCRATCH/gnomad_meta_updated.tsv"
    python scripts/curate_hgdp_1kg_registry.py --metadata "$SCRATCH/gnomad_meta_updated.tsv" \\
        --check data/registry/hgdp_1kg/1.0.0/populations.tsv

The metadata is gnomAD's ``gnomad_meta_updated.tsv`` (``METADATA_URL``, anonymous). D18 item 1 reads
each sample's population from it, and D17 records it by sha256 (``METADATA_SHA256``, the pin in
``reference_cohorts``). Any other bytes are refused. The file is per-sample, so the script reads a local
copy and the file is never committed.

D18 item 1 takes a sample's population from the literal ``population`` field: 80 identities. The
project column (``hgdp_tgp_meta.Project``, mapped by ``PROJECTS``) says whether a label is HGDP's or
1KG's. Every column is found by its name in the header, never by position (F2). A population's coordinate
is the ``latitude`` and ``longitude`` pair beside the ``population`` field. The file also has
``hgdp_tgp_meta.Latitude`` and ``hgdp_tgp_meta.Longitude``, keyed by the 78-label display column
``hgdp_tgp_meta.Population``. That pair puts NorthernHan on Han's point and PapuanHighlands on
PapuanSepik's, so the script does not read it.

``curate`` gives one row per (project, literal population), with the columns ``HEADER``. Every sample of
a population must give the same coordinate. The script refuses, and never averages or drops:

- two coordinates for one population;
- an unknown project;
- a blank, padded or ``NA`` population;
- a coordinate that is not a finite WGS84 number.

Without ``--check``, the script writes the curation to stdout as TSV, one row per population and never
a sample. These are the first four columns of the registry input
``data/registry/hgdp_1kg/1.0.0/populations.tsv``. The other four columns come from the owner's rule
(F1, #508; ``docs/hgdp-registry-input.md``), never from this script: ``uncertainty_radius_km``,
``location_type``, ``provenance`` and ``biocultural_notice``.

With ``--check <tsv>``, the script reads the registry input as the ``reference`` stage does
(``reference.hgdp_1kg_registry``), so every registry refusal applies. The input's identities and
coordinates must equal the curation exactly, and every row's provenance must name the metadata's sha256.
It prints ``80 populations match the pinned metadata``.

In both modes, a curation of other than ``IDENTITIES`` (80) populations stops the script: tell the
owner (F2).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import math
import sys
from collections.abc import Sequence
from pathlib import Path
from types import MappingProxyType
from typing import TextIO

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.tables import reference  # noqa: E402
from genomeos.validation import reference_cohorts  # noqa: E402

#: The sha256 of gnomAD's ``gnomad_meta_updated.tsv`` that D18 item 1 reads (D17).
METADATA_SHA256 = reference_cohorts.METADATA_SHA256
METADATA_URL = (
    "https://storage.googleapis.com/gcp-public-data--gnomad/release/3.1/secondary_analyses/hgdp_1kg_v2/"
    "metadata_and_qc/gnomad_meta_updated.tsv"
)
#: D18 item 1: the callset's population identities.
IDENTITIES = 80
#: Each project value in the metadata, and the registry ``alias_source`` its labels take.
PROJECTS = MappingProxyType({"HGDP": "hgdp", "1000 Genomes": "onekg"})
PROJECT_COLUMN = "hgdp_tgp_meta.Project"
POPULATION_COLUMN = "population"
LATITUDE_COLUMN = "latitude"
LONGITUDE_COLUMN = "longitude"
#: The curation's columns: the first four of the registry input's (``hgdp_1kg.REQUIRED_COLUMNS``).
HEADER = ("alias_source", "population", "latitude", "longitude")
_BOUNDS = {LATITUDE_COLUMN: 90.0, LONGITUDE_COLUMN: 180.0}


def curate(metadata: bytes, *, expected_sha256: str = METADATA_SHA256) -> pd.DataFrame:
    """One row per (project, literal population) of ``metadata``, sorted, with ``HEADER``'s columns."""
    digest = hashlib.sha256(metadata).hexdigest()
    if digest != expected_sha256:
        raise ValueError(
            f"the metadata's sha256 is {digest}, not the pinned {expected_sha256} (D17); use "
            f"gnomad_meta_updated.tsv from {METADATA_URL}"
        )
    try:
        text = metadata.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("the metadata is not UTF-8") from error
    rows = csv.reader(io.StringIO(text, newline=""), delimiter="\t", strict=True)
    header = next(rows, [])
    wanted = (PROJECT_COLUMN, POPULATION_COLUMN, LATITUDE_COLUMN, LONGITUDE_COLUMN)
    missing = [column for column in wanted if column not in header]
    if missing:
        raise ValueError(f"the metadata lacks the columns {missing}; columns are read by name (F2)")
    if len(set(header)) != len(header):
        raise ValueError("the metadata's header names a column twice")
    at = {column: header.index(column) for column in wanted}
    places: dict[tuple[str, str], set[tuple[float, float]]] = {}
    for row in rows:
        line = rows.line_num
        if len(row) != len(header):
            raise ValueError(f"metadata line {line}: {len(row)} fields, not the header's {len(header)}")
        project = row[at[PROJECT_COLUMN]]
        if project not in PROJECTS:
            raise ValueError(f"metadata line {line}: project {project!r} is not one of {sorted(PROJECTS)}")
        population = row[at[POPULATION_COLUMN]]
        if not population.strip() or population != population.strip() or population == "NA":
            raise ValueError(
                f"metadata line {line}: population {population!r} is blank, padded or NA, so it names no "
                "identity"
            )
        latitude, longitude = (
            _coordinate(row[at[column]], column, line, population)
            for column in (LATITUDE_COLUMN, LONGITUDE_COLUMN)
        )
        places.setdefault((PROJECTS[project], population), set()).add((latitude, longitude))
    split = {identity: sorted(found) for identity, found in places.items() if len(found) > 1}
    if split:
        (source, population), found = min(split.items())
        raise ValueError(
            f"population {population!r} ({source}) has {len(found)} coordinates {found} in the metadata; a "
            f"population has one place, never an average ({len(split)} such populations)"
        )
    curated = [(source, population, *found.pop()) for (source, population), found in sorted(places.items())]
    return pd.DataFrame(curated, columns=list(HEADER))


def check(curated: pd.DataFrame, tsv: Path, *, expected_sha256: str = METADATA_SHA256) -> int:
    """The registry input ``tsv`` against ``curated``: the same identities and coordinates, exactly, and
    each row's provenance naming ``expected_sha256``. Returns its number of populations."""
    release = reference.hgdp_1kg_registry(tsv)
    placed = release.populations.set_index("population_id")
    aliases = release.aliases
    found = pd.DataFrame(
        {
            "alias_source": aliases["source"],
            "population": aliases["label"],
            "latitude": aliases["population_id"].map(placed["lat"]),
            "longitude": aliases["population_id"].map(placed["lon"]),
        }
    )
    expected = set(curated.loc[:, list(HEADER)].itertuples(index=False, name=None))
    rows = set(found.itertuples(index=False, name=None))
    missing, extra = sorted(expected - rows), sorted(rows - expected)
    if missing or extra:
        raise ValueError(
            f"{tsv}: {len(missing)} curated rows are not in it (first {missing[:3]}) and {len(extra)} of its "
            f"rows are not curated (first {extra[:3]}); identities and coordinates come from the pinned "
            "metadata exactly"
        )
    cites = release.populations["provenance"].str.contains(expected_sha256, regex=False)
    if not cites.all():
        uncited = sorted(release.populations.loc[~cites, "population_id"])
        raise ValueError(
            f"{tsv}: the provenance of {uncited[:5]} ({len(uncited)} rows) does not name the metadata's "
            f"sha256 {expected_sha256}"
        )
    return len(found)


def write_tsv(curated: pd.DataFrame, stream: TextIO) -> None:
    """``curated`` as TSV, ``HEADER`` first; each coordinate written so that it reads back exactly."""
    writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
    writer.writerow(HEADER)
    for source, population, latitude, longitude in curated.loc[:, list(HEADER)].itertuples(index=False):
        writer.writerow((source, population, repr(float(latitude)), repr(float(longitude))))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--metadata",
        type=Path,
        required=True,
        help="a local copy of gnomad_meta_updated.tsv (never committed)",
    )
    parser.add_argument(
        "--check", type=Path, metavar="TSV", help="the registry input to hold to the curation"
    )
    args = parser.parse_args(argv)
    try:
        curated = curate(args.metadata.read_bytes(), expected_sha256=METADATA_SHA256)
        if len(curated) != IDENTITIES:
            raise ValueError(
                f"the metadata gives {len(curated)} populations, not D18's {IDENTITIES}; stop and tell the "
                "owner (plan F2)"
            )
        if args.check is None:
            write_tsv(curated, sys.stdout)
            print(f"{len(curated)} populations from metadata sha256 {METADATA_SHA256}", file=sys.stderr)
        else:
            matched = check(curated, args.check, expected_sha256=METADATA_SHA256)
            print(f"{matched} populations match the pinned metadata")
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


def _coordinate(text: str, column: str, line: int, population: str) -> float:
    try:
        value = float(text)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or abs(value) > _BOUNDS[column]:
        raise ValueError(
            f"metadata line {line}: {column} {text!r} of population {population!r} is not a finite WGS84 "
            "coordinate"
        )
    return value


if __name__ == "__main__":
    raise SystemExit(main())
