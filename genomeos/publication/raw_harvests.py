"""Raw harvests and external caches, published with their sources' terms (Atlas data platform design
2026-10-18 §2.1, §2.3, §4.2, §4.3; step 1.8, #472).

A raw harvest is a third-party file as it was fetched, the input a measured table or a surface's fit
read. It is published under ``raw/<source>/<harvest_version>/`` beside the outputs derived from it
(inputs travel with outputs, §2.1), and only as a reviewed ``RawHarvest``: its source is a reviewed
source with recorded terms, and every file is pinned by sha256. A released harvest never changes bytes,
so a refetch that gives other bytes is a new ``harvest_version``. ``raw/afnd_populations.tsv`` predates
this layout and stays its own include root (``LEGACY_RAW``).

An external cache (``store/external/<source>/``) is a normalized API snapshot the Atlas serves beside a
variant. A cache carrying a field ``commercial_use.KNOWN_NON_COMMERCIAL_FIELDS`` names for its source is
refused: the field is split out before publishing (R5, §4.3).

Phase 1 builds no paid door (R5–R7, §4.2), so a harvest file over ``OPEN_OBJECT_MAX_BYTES`` is refused.
Every violation is a hard error (v1 §12). No I/O and no network.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, NoReturn

from genomeos.publication import access_policy as ap
from genomeos.publication import data_release as dr
from genomeos.publication.commercial_use import KNOWN_NON_COMMERCIAL_FIELDS
from genomeos.publication.source_terms import REVIEWED_SOURCES

#: Raw files published before the harvest layout, each an include root of its own.
LEGACY_RAW = ("raw/afnd_populations.tsv",)
#: ``retrieved_at`` when no committed record states the retrieval date: the gap is stated, not filled.
NOT_RECORDED = "not_recorded"
RAW_PREFIX = "raw/"
EXTERNAL_PREFIX = "store/external/"
#: The sources whose API snapshots the Atlas serves (``scripts/export_atlas_web.py``), sorted.
EXTERNAL_CACHE_SOURCES = ("alphagenome", "dbsnp", "gnomad")

_HARVEST_VERSION = re.compile(r"\d{4}(?:-(?:0[1-9]|1[0-2]))?")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_COPIED_FROM = re.compile(r"hf://datasets/bschilder/genomeos-data@[0-9a-f]{40}/[^\s/][^\s]*")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class RawHarvest:
    """One reviewed harvest: the files fetched from ``upstream_url`` in one go, each pinned by sha256.

    ``files`` holds ``(name, sha256)`` pairs sorted by name. ``copied_from`` is the Hugging Face folder
    these exact bytes were copied from (``<copied_from>/<name>``), or ``None`` when ``fetch_command``
    gives them. ``fetch_command`` fetches the files from upstream; where the upstream changes, its
    output is a new harvest, never these bytes.
    """

    source: str
    harvest_version: str
    files: tuple[tuple[str, str], ...]
    upstream_url: str
    copied_from: str | None
    retrieved_at: str
    fetch_command: str

    def __post_init__(self) -> None:
        if not isinstance(self.source, str) or self.source not in REVIEWED_SOURCES:
            self._refuse("source", f"{self.source!r} is not a REVIEWED_SOURCES key, so it has no terms")
        if not isinstance(self.harvest_version, str) or not _HARVEST_VERSION.fullmatch(self.harvest_version):
            self._refuse("harvest_version", f"{self.harvest_version!r} is neither YYYY-MM nor YYYY")
        self._check_files()
        if not isinstance(self.upstream_url, str) or not self.upstream_url.startswith("https://"):
            self._refuse("upstream_url", f"{self.upstream_url!r} is not an https:// URL")
        if self.copied_from is not None and not (
            isinstance(self.copied_from, str) and _COPIED_FROM.fullmatch(self.copied_from)
        ):
            self._refuse(
                "copied_from",
                f"{self.copied_from!r} is neither None nor hf://datasets/bschilder/genomeos-data@<40-hex "
                "revision>/<path>",
            )
        if not _is_date(self.retrieved_at) and self.retrieved_at != NOT_RECORDED:
            self._refuse("retrieved_at", f"{self.retrieved_at!r} is neither YYYY-MM-DD nor {NOT_RECORDED!r}")
        if not isinstance(self.fetch_command, str) or not self.fetch_command.strip():
            self._refuse("fetch_command", "is blank; record the command that fetches the files")

    def _check_files(self) -> None:
        if not isinstance(self.files, tuple) or not self.files:
            self._refuse("files", "is empty; a harvest lists every file it publishes")
        if not all(isinstance(entry, tuple) and len(entry) == 2 for entry in self.files):
            self._refuse("files", "must hold (name, sha256) pairs")
        for name, sha256 in self.files:
            if not isinstance(name, str) or not _is_segment(name):
                self._refuse("files", f"name {name!r} is not one path segment")
            if not isinstance(sha256, str) or not _SHA256.fullmatch(sha256):
                self._refuse("files", f"{name}'s sha256 {sha256!r} is not 64 lowercase hex digits")
        names = [name for name, _ in self.files]
        if names != sorted(set(names)):
            self._refuse("files", f"names {names} must be sorted and unique")

    def _refuse(self, field: str, problem: str) -> NoReturn:
        raise dr.DataReleaseError(f"raw harvest {self.source}/{self.harvest_version}: {field} {problem}")

    @property
    def root(self) -> str:
        """The folder the harvest is published under: ``raw/<source>/<harvest_version>``."""
        return f"{RAW_PREFIX}{self.source}/{self.harvest_version}"


def _is_segment(name: str) -> bool:
    """One path segment, as ``dr.assert_data_path`` accepts it."""
    if "/" in name:
        return False
    try:
        dr.assert_data_path(name)
    except dr.DataReleaseError:
        return False
    return True


def _is_date(value: object) -> bool:
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def harvest_path(harvest: RawHarvest, name: str) -> str:
    """The data path of the file ``name`` that ``harvest`` lists."""
    if name not in {listed for listed, _ in harvest.files}:
        raise dr.DataReleaseError(f"raw harvest {harvest.root} lists no file {name!r}")
    return f"{harvest.root}/{name}"


#: The Hugging Face revision ``website/src/atlas/public-artifacts.json`` cites (``hf_revision``): the bytes
#: the served surfaces were fit on, before the GCS data store existed.
_HF_RAW = "hf://datasets/bschilder/genomeos-data@6e77ef278e71fbb86dafd252f4cecc824388f5fc/raw"
_WORLDPOP_2020 = "https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/"

#: The reviewed harvests a release publishes (step 1.8). Every sha256 equals the publishing machine's
#: ``store/INVENTORY.json`` (released 2026-10-17). No committed record dates a retrieval.
RAW_HARVESTS: tuple[RawHarvest, ...] = (
    # The AFND frequency harvest the afnd-2026-08 artifacts were fit on.
    RawHarvest(
        source="afnd",
        harvest_version="2026-08",
        files=(("afnd_frequencies.tsv", "2436932578b04ded18a06b11788557c7660ee893e5bd93f4bf8c79e898bbe80c"),),
        upstream_url="https://www.allelefrequencies.net/",
        copied_from=_HF_RAW,
        retrieved_at=NOT_RECORDED,
        fetch_command=(
            "python scripts/fetch_afnd_frequencies.py --out data/raw/afnd/2026-08/afnd_frequencies.tsv"
        ),
    ),
    # The MAP WFS survey layers the map-2026-08 artifacts were fit on.
    RawHarvest(
        source="map",
        harvest_version="2026-08",
        files=(
            ("map_g6pd_surveys.csv", "ad473661e7ae42e5195629e0eabc24b5a882c49a41c3bbf375f382ac29b11c37"),
            ("map_hbs_surveys.csv", "ab92edd3059aa59a37f3e2d10361d67e490c573fc3c03bf13eb902e3820e98fd"),
        ),
        upstream_url="https://data.malariaatlas.org/geoserver/Explorer/ows",
        copied_from=_HF_RAW,
        retrieved_at=NOT_RECORDED,
        fetch_command=(
            "python scripts/fetch_map_hbs.py --layer g6pd --out data/raw/map/2026-08/map_g6pd_surveys.csv && "
            "python scripts/fetch_map_hbs.py --layer hbs --out data/raw/map/2026-08/map_hbs_surveys.csv"
        ),
    ),
    # The two rasters the surfaces' target grid was built from (each artifact's target_grid_version).
    # WorldPop serves these bytes unchanged, so they are fetched rather than copied.
    RawHarvest(
        source="worldpop",
        harvest_version="2020",
        files=(
            ("cok_ppp_2020_UNadj.tif", "701030c52abf90a2ba2ffad505f789edf23307b8a671146d595f38e25b2e4a5e"),
            (
                "ppp_2020_1km_Aggregated.tif",
                "d98f9efd911ed4afed696dff9024b20a4e3ec5bf6c0e21f241a26725b7df0866",
            ),
        ),
        upstream_url=_WORLDPOP_2020,
        copied_from=None,
        retrieved_at=NOT_RECORDED,
        fetch_command=(
            "python scripts/fetch_worldpop.py --year 2020 --out "
            "data/raw/worldpop/2020/ppp_2020_1km_Aggregated.tif && curl -fL -o "
            f"data/raw/worldpop/2020/cok_ppp_2020_UNadj.tif {_WORLDPOP_2020}COK/cok_ppp_2020_UNadj.tif"
        ),
    ),
)


def check_raw_harvests(records: Sequence[dr.FileRecord], harvests: Sequence[RawHarvest]) -> None:
    """Every ``raw/`` file in ``records`` is a file a harvest lists, with its pinned bytes and within the
    free whole-file size; every listed file is present. ``LEGACY_RAW`` is outside the harvests."""
    roots = [harvest.root for harvest in harvests]
    for root in roots:
        if roots.count(root) > 1:
            raise dr.DataReleaseError(f"{root}: listed twice in the raw harvests; list each harvest once")
    pinned = {harvest_path(harvest, name): sha256 for harvest in harvests for name, sha256 in harvest.files}
    found: set[str] = set()
    for record in records:
        if not record.path.startswith(RAW_PREFIX) or record.path in LEGACY_RAW:
            continue
        if record.path not in pinned:
            raise dr.DataReleaseError(
                f"{record.path}: no reviewed raw harvest lists this file; list it in RAW_HARVESTS with "
                "its sha256, or keep it outside data/raw/<source>/<harvest_version>/"
            )
        if record.sha256 != pinned[record.path]:
            raise dr.DataReleaseError(
                f"{record.path}: sha256 {record.sha256} differs from the {pinned[record.path]} its harvest "
                "pins; a harvest's bytes never change, so a refetch with other bytes needs a new "
                "harvest_version"
            )
        if record.bytes > ap.OPEN_OBJECT_MAX_BYTES:
            raise dr.DataReleaseError(
                f"{record.path}: {record.bytes:,} bytes is over the {ap.OPEN_OBJECT_MAX_BYTES:,} a raw "
                "harvest file is free to download whole (OPEN_OBJECT_MAX_BYTES); a larger one needs "
                "R5–R7 (Atlas data platform design 2026-10-18 §4.2), which no release builds yet"
            )
        found.add(record.path)
    missing = sorted(set(pinned) - found)
    if missing:
        raise dr.DataReleaseError(
            f"{missing[0]}: listed by its raw harvest but missing locally ({len(missing)} file(s) "
            "missing); fetch the harvest first"
        )


def check_external_cache(path: str, document: object) -> None:
    """Refuse a cache at ``path`` (``store/external/<source>/…``) whose JSON ``document`` holds, at any
    depth, a field ``KNOWN_NON_COMMERCIAL_FIELDS`` names for its source (R5, §4.3)."""
    parts = path.split("/")
    source = parts[2] if path.startswith(EXTERNAL_PREFIX) and len(parts) > 3 else None
    if source not in EXTERNAL_CACHE_SOURCES:
        raise dr.DataReleaseError(
            f"{path}: no reviewed external cache source; expected {EXTERNAL_PREFIX}<source>/… with "
            f"<source> one of {list(EXTERNAL_CACHE_SOURCES)}"
        )
    carried = sorted(_keys(document) & set(KNOWN_NON_COMMERCIAL_FIELDS.get(source, ())))
    if carried:
        field = carried[0]
        raise dr.DataReleaseError(
            f"{path}: {source} publishes {field!r} under a non-commercial licence; split out {field} "
            "before publishing (R5, design §4.3)"
        )


def _keys(value: Any) -> set[str]:
    """Every object key in a JSON value, at any depth."""
    if isinstance(value, Mapping):
        return {str(key) for key in value} | {key for item in value.values() for key in _keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in _keys(item)}
    return set()
