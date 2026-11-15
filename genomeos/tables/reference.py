"""The population registry under ``tables/v1/reference/``, and check 5 against it.

Atlas data platform design 2026-10-18 §2.3, §2.4 and §2.7 check 5; builder's calls 5 and 18; step 1.7.

Each registry release is one folder, ``tables/v1/reference/populations/<folder>/``, holding
``populations.parquet`` (``reference.populations``) and ``population_aliases.parquet``
(``reference.population_aliases``), both carrying the full ``registry_version`` as a column. A
``registry_version`` (``RELEASE+sha256.DIGEST``, ``registry.release_contract``) is not path-safe, so its
folder is ``<release>-<sha8>`` (call 5). The two registries released before a registry had a digest keep
their names as folders (call 18):

- ``AFND_LEGACY`` (``afnd-2026-08``): AFND's populations, rebuilt by ``registry.sources.afnd`` from the
  released raw file ``raw/afnd_populations.tsv`` exactly as the ``afnd-2026-08`` artifacts and ingests
  read it (``afnd_legacy``).
- ``MAP_LEGACY`` (``map-survey-coordinates-v1``): alias rows only, one per MAP survey site
  (``map-hbs-<id>``, ``map-g6pd-<id>``), from the MAP harvest (``map_legacy_aliases``). A MAP survey
  carries its own coordinates, which stay authoritative, so this registry places nothing.

Every other registry places each of its populations, and its aliases name only populations it places
(``reference_frames``). A released folder is never rewritten (calls 5 and 6): a later build re-derives its
rows and verifies them against the released file (``write_once.require_same_rows``).

Check 5: every ``population_id`` resolves in its pinned registry (``require_resolved``), and an
observation's ``lat``, ``lon`` and ``radius_km`` are exactly its registry's
(``require_registry_coordinates``), except under ``MAP_LEGACY``. Every violation is a ``TableError``
(v1 §12).
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from pathlib import Path

import pandas as pd
import pandera.errors
import pandera.pandas as pa
import pyarrow.parquet as pq

from genomeos.observations.sources import map_g6pd, map_surveys
from genomeos.registry.release_contract import validate_release_version
from genomeos.registry.schema import ALIASES_SCHEMA, POPULATIONS_SCHEMA
from genomeos.registry.sources import afnd as afnd_registry
from genomeos.tables import contracts, writer
from genomeos.tables.contracts import TableError

AFND_LEGACY = "afnd-2026-08"
MAP_LEGACY = "map-survey-coordinates-v1"
#: The registries that keep their names as folders (call 18).
LEGACY_REGISTRIES = (AFND_LEGACY, MAP_LEGACY)
POPULATIONS_TABLE = contracts.REFERENCE_POPULATIONS.table
ALIASES_TABLE = contracts.REFERENCE_ALIASES.table
#: An observation's placement and the registry column it must equal exactly (check 5).
PLACEMENT = (("lat", "lat"), ("lon", "lon"), ("radius_km", "uncertainty_radius_km"))
_DIGEST = re.compile(r"[0-9a-f]{64}")
_DIGEST_SEPARATOR = "+sha256."
_SURVEY_ID = re.compile(r"0|[1-9][0-9]*")


def registry_folder(version: str) -> str:
    """The folder of registry ``version``: ``R+sha256.<hex>`` -> ``R-<hex[:8]>``; a legacy name as itself."""
    if version in LEGACY_REGISTRIES:
        return version
    release, separator, digest = str(version).partition(_DIGEST_SEPARATOR)
    if separator and _DIGEST.fullmatch(digest) and _is_release(release):
        return f"{release}-{digest[:8]}"
    raise TableError(
        f"registry_version {version!r} is neither <MAJOR.MINOR.PATCH>+sha256.<64 hex> nor one of the "
        f"legacy registries {list(LEGACY_REGISTRIES)} (data platform §2.3, calls 5 and 18)"
    )


def reference_paths(version: str) -> tuple[str, str]:
    """The release paths of registry ``version``'s populations and aliases files."""
    folder = f"{contracts.REGISTRY_ROOT}{registry_folder(version)}/"
    return (
        f"{folder}{contracts.REGISTRY_FILES[POPULATIONS_TABLE]}",
        f"{folder}{contracts.REGISTRY_FILES[ALIASES_TABLE]}",
    )


def reference_frames(
    populations: pd.DataFrame | None, aliases: pd.DataFrame, *, registry_version: str
) -> tuple[pd.DataFrame | None, pd.DataFrame]:
    """A registry's P0 tables as the two reference tables' rows: the aliases gain ``registry_version``.

    ``populations`` is ``None`` exactly for ``MAP_LEGACY``. Its rows must all be of ``registry_version``,
    and every alias must name a population it places.
    """
    _check_alias_only(populations, registry_version)
    aliases = _validated(ALIASES_SCHEMA, aliases, registry_version)
    aliases = _validated(
        contracts.REFERENCE_ALIASES_SCHEMA,
        aliases.assign(registry_version=registry_version),
        registry_version,
    )
    if populations is not None:
        populations = _validated(POPULATIONS_SCHEMA, populations, registry_version)
    _check_registry(populations, aliases, registry_version)
    return populations, aliases


def afnd_legacy(tsv: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Registry ``afnd-2026-08``: ``registry.sources.afnd`` over the released ``raw/afnd_populations.tsv``."""
    populations, aliases, _ = afnd_registry.load(tsv, AFND_LEGACY)
    return populations, aliases


def map_legacy_aliases(hbs_csv: Path, g6pd_csv: Path) -> pd.DataFrame:
    """Registry ``map-survey-coordinates-v1``: one alias per survey site of the MAP harvest's two layers.

    Each row maps a survey ``id`` (the label, verbatim) to the ``population_id`` its observation adapter
    gives that site. A survey id that is not a whole number, or that repeats within a layer, is refused.
    """
    frames = []
    for path, source, population_id in (
        (hbs_csv, map_surveys.SOURCE, map_surveys.population_id),
        (g6pd_csv, map_g6pd.SOURCE, map_g6pd.population_id),
    ):
        labels = _survey_ids(path)
        frames.append(
            pd.DataFrame(
                {
                    "population_id": [population_id(label) for label in labels],
                    "source": source,
                    "label": labels,
                },
                columns=list(ALIASES_SCHEMA.columns),
            )
        )
    return ALIASES_SCHEMA.validate(pd.concat(frames, ignore_index=True))


def read_reference(folder: Path) -> tuple[pd.DataFrame | None, pd.DataFrame]:
    """A registry folder's populations (``None`` for an alias-only registry) and aliases.

    Each file is checked against its contract (check 1), its rows must be of the registry the folder
    names, and the registry must hold together as ``reference_frames`` requires.
    """
    frames: dict[str, pd.DataFrame | None] = {}
    for table in (POPULATIONS_TABLE, ALIASES_TABLE):
        path = folder / contracts.REGISTRY_FILES[table]
        if not path.is_file():
            frames[table] = None
            continue
        writer.check_table_file(path, table)
        frames[table] = pq.read_table(path).to_pandas()
    populations, aliases = frames[POPULATIONS_TABLE], frames[ALIASES_TABLE]
    if aliases is None:
        raise TableError(
            f"{folder}: holds no {contracts.REGISTRY_FILES[ALIASES_TABLE]}; every registry folder does"
        )
    versions = sorted(set(aliases["registry_version"]))
    if len(versions) != 1 or registry_folder(versions[0]) != folder.name:
        raise TableError(
            f"{folder}: its rows are of registry {versions}, which is not the folder {folder.name}"
        )
    _check_registry(populations, aliases, versions[0])
    return populations, aliases


def require_resolved(
    ids: Iterable[str], populations: pd.DataFrame | None, aliases: pd.DataFrame, *, registry_version: str
) -> None:
    """Check 5: every id in ``ids`` is a ``population_id`` of registry ``registry_version``.

    A registry that places its populations resolves an id there; ``MAP_LEGACY``, through its aliases.
    """
    _check_registry(populations, aliases, registry_version)
    _require_known(ids, aliases if populations is None else populations, registry_version)


def require_registry_coordinates(
    observations: pd.DataFrame, populations: pd.DataFrame, *, registry_version: str
) -> None:
    """Check 5: each observation's ``lat``, ``lon`` and ``radius_km`` are exactly its registry's.

    Under ``MAP_LEGACY`` MAP's own coordinates stay authoritative (call 18), so nothing is compared.
    """
    registry_folder(registry_version)
    if registry_version == MAP_LEGACY:
        return
    _require_version(populations, registry_version)
    _require_known(observations["population_id"], populations, registry_version)
    placed = populations.set_index("population_id")
    for column, registry_column in PLACEMENT:
        expected = observations["population_id"].map(placed[registry_column]).to_numpy()
        differs = observations[column].to_numpy() != expected
        if differs.any():
            first = int(differs.argmax())
            found = observations[column].iloc[first]
            raise TableError(
                f"check 5: {observations['population_id'].iloc[first]}: {column} {found!r} is not registry "
                f"{registry_version}'s {registry_column} {expected[first]!r} ({int(differs.sum())} rows "
                "differ); placement comes only from the registry, compared exactly"
            )


def _is_release(release: str) -> bool:
    try:
        validate_release_version(release)
    except (TypeError, ValueError):
        return False
    return True


def _validated(schema: pa.DataFrameSchema, frame: pd.DataFrame, registry_version: str) -> pd.DataFrame:
    try:
        return schema.validate(frame.reset_index(drop=True))
    except (pandera.errors.SchemaError, pandera.errors.SchemaErrors) as error:
        raise TableError(
            f"registry {registry_version}: rows the {schema.name} schema refuses: {error}"
        ) from error


def _require_known(ids: Iterable[str], placed: pd.DataFrame, registry_version: str) -> None:
    missing = sorted(set(ids) - set(placed["population_id"]))
    if missing:
        raise TableError(
            f"check 5: population_id {missing[0]} does not resolve in registry {registry_version} "
            f"({len(missing)} unresolved: {missing[:5]})"
        )


def _check_registry(populations: pd.DataFrame | None, aliases: pd.DataFrame, registry_version: str) -> None:
    """The registry holds together: placed exactly when it is not ``MAP_LEGACY``, every row of
    ``registry_version``, and every alias naming a population it places."""
    _check_alias_only(populations, registry_version)
    for frame in (populations, aliases):
        _require_version(frame, registry_version)
    if populations is not None:
        orphans = sorted(set(aliases["population_id"]) - set(populations["population_id"]))
        if orphans:
            raise TableError(
                f"registry {registry_version}: aliases name population_ids it does not place: {orphans[:5]}"
            )


def _check_alias_only(populations: pd.DataFrame | None, registry_version: str) -> None:
    registry_folder(registry_version)
    if populations is None and registry_version != MAP_LEGACY:
        raise TableError(
            f"registry {registry_version} places each population; only {MAP_LEGACY} is alias rows alone "
            "(call 18)"
        )
    if populations is not None and registry_version == MAP_LEGACY:
        raise TableError(
            f"registry {MAP_LEGACY} is alias rows only: MAP's own coordinates stay authoritative (check 5)"
        )


def _require_version(frame: pd.DataFrame | None, registry_version: str) -> None:
    """Every row of ``frame`` that names its registry names ``registry_version``."""
    if frame is None or "registry_version" not in frame.columns:
        return
    found = sorted(set(frame["registry_version"]) - {registry_version})
    if found:
        raise TableError(f"rows of registry_version {found[:3]} are not of registry {registry_version}")


def _survey_ids(path: Path) -> list[str]:
    """The ``id`` column of a MAP survey layer, verbatim: whole numbers, each once."""
    ids = pd.read_csv(path, usecols=["id"], dtype={"id": str}, keep_default_na=False)["id"].tolist()
    malformed = [value for value in ids if not _SURVEY_ID.fullmatch(value)]
    if malformed:
        raise TableError(
            f"{path}: survey id {malformed[0]!r} is not a whole number, so it names no survey site"
        )
    repeated = sorted((value for value, n in Counter(ids).items() if n > 1), key=int)
    if repeated:
        raise TableError(
            f"{path}: survey ids {repeated[:5]} are listed more than once; a duplicate id would give two "
            "surveys one population_id"
        )
    return ids
