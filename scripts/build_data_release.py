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
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402

DATA = ROOT / "data"
RELEASES = DATA / "releases"
CHUNK = 1 << 20

#: Paths under data/ that a release publishes (design §3 C7). Everything else stays local.
INCLUDE = (
    "raw/afnd_populations.tsv",
    "registry",
    "sources",
    "store/INVENTORY.json",
    "store/artifacts",
    "store/catalog-metadata.json",
    "validation",
)

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
            "status": dr.NOT_CHECKED,
            "note": "No terms check for the MAP survey layers is recorded in this repository.",
        },
        "non_commercial": False,
    },
    "worldpop": {
        "name": "WorldPop gridded population (the surface target grid)",
        "citation": "WorldPop, University of Southampton. doi:10.5258/SOTON/WP00647",
        "url": "https://hub.worldpop.org/",
        "terms": {
            "status": dr.NOT_CHECKED,
            "note": (
                "Selects the population-positive H3 cells a format-2 surface is predicted on; no "
                "terms check is recorded in this repository."
            ),
        },
        "non_commercial": False,
    },
    "genomeos": {
        "name": "genomeOS project-authored data and outputs",
        "url": "https://github.com/genomeOS/genomeOS",
        "terms": {
            "status": dr.NOT_CHECKED,
            "note": (
                "Project-authored, with no third-party input. The README's Apache-2.0 notice covers "
                "source code and documentation only; no data licence is recorded."
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
    grid = manifest.get("target_grid_source") or ""
    return (source, "worldpop") if grid.startswith("worldpop") else (source,)


_RULES: tuple[tuple[Callable[[str], bool], Callable[[Path, str], tuple[str, ...]]], ...] = (
    (lambda path: path.startswith(dr.ARTIFACT_PREFIX), _artifact_sources),
    (lambda path: path.startswith("validation/crossval_"), lambda root, path: ("map",)),
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


def included_files(data_root: Path) -> list[str]:
    found: list[str] = []
    for root in INCLUDE:
        base = data_root / root
        if base.is_file():
            found.append(root)
        elif base.is_dir():
            found.extend(path.relative_to(data_root).as_posix() for path in base.rglob("*") if path.is_file())
        else:
            raise dr.DataReleaseError(f"include root data/{root} is missing; fetch it first")
    return sorted(found)


def collect(data_root: Path, tracked: set[str]) -> list[dr.FileRecord]:
    records: list[dr.FileRecord] = []
    for relative in included_files(data_root):
        dr.media_type_for(relative)  # refuses pickles before anything is hashed
        path = data_root / relative
        if relative.endswith(".npy"):
            _refuse_pickled_npy(path, relative)
        sources = sources_for(data_root, relative)
        records.append(
            dr.FileRecord(relative, path.stat().st_size, sha256_of(path), relative in tracked, sources)
        )
    return records


def build(
    data_root: Path, release: str, *, tracked: set[str], previous: Sequence[Mapping[str, Any]] = ()
) -> dict[str, Any]:
    records = collect(data_root, tracked)
    used = {name for record in records for name in record.sources}
    available = {**REVIEWED_SOURCES, **_record_sources(data_root)}
    return dr.build_manifest(records, {name: available[name] for name in used}, release, previous)


def git_tracked(data_root: Path) -> set[str]:
    """Paths under ``data_root`` that git tracks, relative to it (the ``in_git`` field)."""
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--", "."], cwd=data_root, capture_output=True, check=True
    ).stdout.decode("utf-8")
    return {entry for entry in listing.split("\0") if entry}


def earlier_releases(directory: Path, release: str) -> list[dict[str, Any]]:
    manifests = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.json"))]
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
        manifest = build(args.data, args.release, tracked=tracked, previous=previous)
    except (dr.DataReleaseError, OSError, KeyError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
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
