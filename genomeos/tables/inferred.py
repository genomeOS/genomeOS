"""``inferred.artifacts`` and ``inferred.cells_by_cell``: the released surfaces as query tables.

Atlas data platform design 2026-10-18 §2.4, §2.7 checks 6 and 10, §2.8; builder's calls 6, 8 and 22.

``store/artifacts/<variant>__<model>__<data>/`` stays the citable unit (§2.2 rule 1); these tables are
derived from it and never cited. Measured and inferred never share a table, file or prefix, and this
module reads nothing under ``measured/``.

- ``inferred.artifacts`` has one row per artifact: its manifest's fields, its ``measurement`` and where
  that came from, ``support_counts``, the release that first published it, its ``cells_by_cell`` epoch,
  the key and sha256 of its ``cells.parquet``, ``manifest.json`` and (when it has one) fit input, and
  its ``fit_input_evidence``. That is never null: ``fit-record``, ``web-json-match``, or ``none`` with
  a reason (§2.8, check 10; call 8).
- ``inferred.cells_by_cell`` holds every cell of every format-1/2 artifact, partitioned as
  ``epoch=<R>/res=<k>/h3_r0=<cell>/part-0.parquet``. ``epoch`` is the release that first wrote the
  artifact's cells: a release writes parts only for artifacts no earlier epoch holds, and a released
  part is never rewritten (call 6). ``measurement`` keeps the KIR carrier-frequency surfaces apart from
  allele frequencies, and ``artifact_format`` says which format the cells came from (call 22).

Two format-1 manifests predate the ``measurement`` field; each takes it from ``REVIEWED_MEASUREMENTS``,
never from a default. Formats 3 and 4 store ``prior_frequency_sd`` per cell, which ``cells_by_cell`` v1
does not hold: they need its contract 1.1 first (F4), so ``write_epoch`` refuses them.

Check 6 compares each artifact's rows in ``cells_by_cell`` with its ``cells.parquet``: the row count,
an order-independent checksum of the 14 columns, the parts' ``measurement`` and ``artifact_format``.
This module does not import the surface stack.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

import duckdb
import h3
import pandas as pd
import pyarrow
import pyarrow.parquet as pq

from genomeos.publication import artifact_inputs as ai
from genomeos.publication import data_release as dr
from genomeos.tables import contracts, writer
from genomeos.tables.contracts import TableError
from genomeos.tables.meta import artifact_directory_name
from genomeos.tables.provenance import InputRef

ARTIFACTS_TABLE = "inferred.artifacts"
CELLS_TABLE = "inferred.cells_by_cell"
#: The 14 columns of a format-1 or format-2 ``cells.parquet``, in order.
CELLS_COLUMNS = (
    "h3_index",
    "variant_id",
    "post_median",
    "post_mean",
    "post_sd",
    "q025",
    "q975",
    "q25",
    "q75",
    "support",
    "posterior_contraction",
    "dist_nearest_obs_km",
    "model_version",
    "data_version",
)
CELLS_BY_CELL_COLUMNS = CELLS_COLUMNS + (
    "h3_r0",
    "h3_parent_r3",
    "measurement",
    "artifact_format",
    "epoch",
    "res",
)
#: The artifact formats ``cells_by_cell`` v1 holds (F4).
READABLE_FORMATS = frozenset({1, 2})
EPOCH_ROOT = "tables/v1/inferred/cells_by_cell"
PART_FILE = "part-0.parquet"
#: An artifact's per-cell surface, inside its directory.
CELLS_FILE = "cells.parquet"
#: The row order of every part.
PART_ORDER = ("h3_index", "variant_id", "model_version", "data_version")
#: The resolution of ``h3_parent_r3``; a res-3 cell is its own parent.
PARENT_RESOLUTION = 3
#: The closed vocabulary of ``measurement``: the quantities a fit input may count.
MEASUREMENTS = tuple(ai.INPUT_CONTRACTS)
FIT_RECORD = "fit-record"
WEB_JSON_MATCH = "web-json-match"
NONE = "none"
EVIDENCE = (FIT_RECORD, WEB_JSON_MATCH, NONE)
#: Reviewed: the measurement of each released artifact whose manifest records none (§2.4).
REVIEWED_MEASUREMENTS: Mapping[str, tuple[str, str]] = MappingProxyType(
    {
        "chr11-5227002-T-A__v1__map-2026-08": (
            "allele_frequency",
            "the format-1 manifest predates the measurement field; the same variant's "
            "store/artifacts/chr11-5227002-T-A__v3__map-2026-08/manifest.json, fit to the same MAP HbS "
            "data, records allele_frequency",
        ),
        "phenotype__g6pd-deficiency__v1__map-2026-08": (
            "allele_frequency",
            "the format-1 manifest predates the measurement field; the same phenotype's "
            "store/artifacts/phenotype__g6pd-deficiency__v3__map-2026-08/manifest.json, fit to the same MAP "
            "G6PD data, records allele_frequency (not the web's phenotype_frequency)",
        ),
    }
)
#: Every field a format-1 or format-2 ``manifest.json`` may hold; anything else is refused, not dropped.
MANIFEST_FIELDS = frozenset(
    {
        "artifact_format",
        "correlation_range_km",
        "data_version",
        "lengthscale_sigma",
        "likelihood",
        "measurement",
        "model_version",
        "n_cells",
        "n_observations",
        "prior_frequency_sd",
        "resolution",
        "support_counts",
        "target_grid_source",
        "target_grid_version",
        "variant_id",
    }
)
#: Absent from some released manifests: two format-1 ones lack measurement, and format 1 has no grid.
_OPTIONAL_FIELDS = frozenset({"measurement", "target_grid_source", "target_grid_version"})
#: The manifest fields ``inferred.artifacts`` copies as they stand.
_COPIED_FIELDS = (
    "variant_id",
    "model_version",
    "data_version",
    "artifact_format",
    "resolution",
    "n_cells",
    "n_observations",
    "likelihood",
    "correlation_range_km",
    "lengthscale_sigma",
    "prior_frequency_sd",
    "target_grid_source",
    "target_grid_version",
)
_IDENTITY = ("variant_id", "model_version", "data_version")
_EPOCH_TABLE = "genomeos_epoch_cells"
_ANCESTRY_VIEW = "genomeos_h3_ancestry"


@dataclass(frozen=True)
class ArtifactRecord:
    """One artifact as the build reads it: its manifest, its local cells, and each file's key and sha256.

    Keys are the first-publishing release's (``releases/<R>/<path>``); an artifact this release adds is
    keyed under this release. ``sources`` are those its cells and manifest carry (call 16).
    """

    artifact: str
    manifest: Mapping[str, Any]
    cells_path: Path
    cells_key: str
    cells_sha256: str
    manifest_key: str
    manifest_sha256: str
    observations_key: str | None
    observations_sha256: str | None
    first_release: str
    sources: tuple[str, ...]

    @property
    def cells_inputs(self) -> tuple[InputRef, InputRef]:
        """What its ``cells_by_cell`` rows derive from: its ``cells.parquet`` and ``manifest.json``."""
        return InputRef(self.cells_key, self.cells_sha256), InputRef(self.manifest_key, self.manifest_sha256)


def measurement_of(artifact: str, manifest: Mapping[str, Any]) -> tuple[str, str]:
    """``(measurement, "manifest" | "reviewed_table")``: the manifest's, or the reviewed table's when it
    records none. Never a default (§2.4)."""
    recorded = manifest.get("measurement")
    reviewed = REVIEWED_MEASUREMENTS.get(artifact)
    if recorded is not None and reviewed is not None:
        raise TableError(
            f"{artifact}: its manifest records measurement {recorded!r}, so REVIEWED_MEASUREMENTS "
            "may not list it"
        )
    if recorded is not None:
        value, origin = recorded, "manifest"
    elif reviewed is not None:
        value, origin = reviewed[0], "reviewed_table"
    else:
        raise TableError(
            f"{artifact}: its manifest records no measurement, and REVIEWED_MEASUREMENTS has no reviewed "
            "entry for it; a measurement is never defaulted (data platform §2.4)"
        )
    if value not in MEASUREMENTS:
        raise TableError(f"{artifact}: measurement {value!r} is not one of {list(MEASUREMENTS)}")
    return value, origin


def fit_input_evidence(
    artifact: str,
    *,
    has_input: bool,
    released_without_input: Mapping[str, str],
    web_json_matches: frozenset[str] = frozenset(),
    web_json_refused: Mapping[str, str] | None = None,
    no_published_ingest: Mapping[str, str] | None = None,
) -> tuple[str, str | None]:
    """``(fit_input_evidence, reason)``: never null, with a reason exactly when it is ``none`` (§2.8).

    An artifact holding its fit input is ``fit-record``; one whose served web JSON matched a published
    ingest is ``web-json-match``. Any other is ``none``, its reason taken in this order (controller
    ruling p1-R15): the reviewed refusal of its web JSON (``web_json_refused``); ``no published ingest
    for <data_version>`` for a served artifact whose data has none (``no_published_ingest`` maps it to
    its data_version); its ``RELEASED_WITHOUT_INPUT`` reason. An artifact none of these names fails.
    """
    refused = web_json_refused or {}
    if artifact in web_json_matches and artifact in refused:
        raise TableError(f"{artifact}: its web JSON is listed as both matched and refused")
    if has_input:
        if artifact in released_without_input:
            raise TableError(
                f"{artifact}: it holds its fit input, but RELEASED_WITHOUT_INPUT lists it as released "
                "without one"
            )
        return FIT_RECORD, None
    if artifact in web_json_matches:
        return WEB_JSON_MATCH, None
    missing_ingest = {
        name: f"no published ingest for {data_version}" if _text(data_version) else ""
        for name, data_version in (no_published_ingest or {}).items()
    }
    for reasons in (refused, missing_ingest, released_without_input):
        if artifact in reasons:
            reason = reasons[artifact]
            if not _text(reason):
                raise TableError(
                    f"{artifact}: fit_input_evidence none needs a reason, and its reason is blank"
                )
            return NONE, reason
    raise TableError(
        f"check 10: {artifact}: no fit_input_evidence: it holds no fit input, no served web JSON matched, "
        "and no reviewed reason names it (data platform §2.8)"
    )


def artifacts_frame(
    records: Sequence[ArtifactRecord],
    *,
    epochs: Mapping[str, str],
    evidence: Mapping[str, tuple[str, str | None]],
) -> pd.DataFrame:
    """``inferred.artifacts``: one row per record, in artifact order (check 10 on ``evidence``)."""
    rows = []
    for record in sorted(records, key=lambda record: record.artifact):
        artifact, manifest = record.artifact, record.manifest
        unknown = sorted(set(manifest) - MANIFEST_FIELDS)
        missing = sorted(MANIFEST_FIELDS - _OPTIONAL_FIELDS - set(manifest))
        if unknown or missing:
            raise TableError(
                f"{artifact}: manifest fields {unknown} are not inferred.artifacts columns, and it lacks "
                f"{missing}"
            )
        if artifact not in epochs:
            raise TableError(f"{artifact}: no cells_by_cell epoch holds its cells")
        measurement, measurement_from = measurement_of(artifact, manifest)
        value, reason = _checked_evidence(artifact, evidence)
        rows.append(
            {
                "artifact": artifact,
                **{field: manifest.get(field) for field in _COPIED_FIELDS},
                "measurement": measurement,
                "measurement_from": measurement_from,
                "support_counts": _support_counts(artifact, manifest["support_counts"]),
                "first_release": record.first_release,
                "epoch": epochs[artifact],
                "cells_key": record.cells_key,
                "cells_sha256": record.cells_sha256,
                "manifest_key": record.manifest_key,
                "manifest_sha256": record.manifest_sha256,
                "observations_key": record.observations_key,
                "observations_sha256": record.observations_sha256,
                "fit_input_evidence": value,
                "fit_input_evidence_reason": reason,
            }
        )
    return pd.DataFrame(rows, columns=list(contracts.columns(ARTIFACTS_TABLE)))


def new_epoch_artifacts(artifacts: Sequence[str], earlier: Mapping[str, str]) -> tuple[str, ...]:
    """The artifacts no earlier epoch holds, sorted: the only ones a new epoch writes (call 6)."""
    return tuple(sorted(set(artifacts) - set(earlier)))


def earlier_epochs(con: duckdb.DuckDBPyConnection, parts: Sequence[Path]) -> dict[str, str]:
    """Each artifact the released ``parts`` hold, with its epoch; an artifact in two epochs is refused."""
    if not parts:
        return {}
    rows = con.execute(
        "SELECT DISTINCT variant_id, model_version, data_version, epoch "
        "FROM read_parquet(?, hive_partitioning = false) ORDER BY ALL",
        [[str(path) for path in parts]],
    ).fetchall()
    found: dict[str, str] = {}
    for variant_id, model_version, data_version, epoch in rows:
        artifact = artifact_directory_name(variant_id, model_version, data_version)
        if artifact in found:
            raise TableError(
                f"{artifact}: cells_by_cell holds it in epochs {found[artifact]} and {epoch}; an artifact's "
                "cells are written once, in one epoch"
            )
        found[artifact] = epoch
    return found


def part_path(epoch: str, res: int, h3_r0: str) -> str:
    """``EPOCH_ROOT/epoch=<epoch>/res=<res>/h3_r0=<h3_r0>/part-0.parquet``."""
    return f"{EPOCH_ROOT}/epoch={epoch}/res={res}/h3_r0={h3_r0}/{PART_FILE}"


def write_epoch(
    con: duckdb.DuckDBPyConnection,
    records: Sequence[ArtifactRecord],
    *,
    epoch: str,
    out_root: Path,
    git_sha: str,
) -> tuple[str, ...]:
    """Write ``records``' cells as epoch ``epoch``: one part per ``(res, h3_r0)``, paths in that order.

    Every record is checked before anything is written: its format (1 or 2), its 14 columns, an identity
    that is its directory, every cell an H3 cell at the manifest's resolution, and exactly ``n_cells``
    distinct cells. A file already in the epoch's folder that this epoch would not write is refused.
    """
    dr.assert_release_id(epoch)
    checked = [(record, *_checked_cells(con, record)) for record in records]
    ancestry = _ancestry(cell for _, cells, _ in checked for cell in cells)
    con.register(_ANCESTRY_VIEW, ancestry)
    try:
        con.execute(f"CREATE OR REPLACE TEMP TABLE {_EPOCH_TABLE} ({_epoch_columns()}, artifact VARCHAR)")
        for record, _, measurement in checked:
            con.execute(
                f"INSERT INTO {_EPOCH_TABLE} SELECT c.*, a.h3_r0, a.h3_parent_r3, ?, ?, ?, a.res, ? "
                f"FROM {_read(record.cells_path)} AS c JOIN {_ANCESTRY_VIEW} AS a USING (h3_index)",
                [measurement, record.manifest["artifact_format"], epoch, record.artifact],
            )
        groups = con.execute(
            f"SELECT res, h3_r0, list(DISTINCT artifact ORDER BY artifact) FROM {_EPOCH_TABLE} "
            "GROUP BY ALL ORDER BY ALL"
        ).fetchall()
        planned = {part_path(epoch, res, h3_r0): artifacts for res, h3_r0, artifacts in groups}
        _refuse_strays(out_root, epoch, planned)
        by_artifact = {record.artifact: record for record in records}
        columns = ", ".join(_identifier(name) for name in CELLS_BY_CELL_COLUMNS)
        for (res, h3_r0, artifacts), relative in zip(groups, planned, strict=True):
            held = [by_artifact[name] for name in artifacts]
            writer.write_parquet(
                con,
                f"SELECT {columns} FROM {_EPOCH_TABLE} WHERE res = {int(res)} AND h3_r0 = '{h3_r0}'",
                out_root / relative,
                table=CELLS_TABLE,
                git_sha=git_sha,
                inputs=[ref for record in held for ref in record.cells_inputs],
                sources=sorted({name for record in held for name in record.sources}),
                order_by=PART_ORDER,
            )
    finally:
        con.execute(f"DROP TABLE IF EXISTS {_EPOCH_TABLE}")
        con.unregister(_ANCESTRY_VIEW)
    return tuple(planned)


def cells_checksum(con: duckdb.DuckDBPyConnection, source_sql: str) -> tuple[int, int]:
    """``(rows, checksum)`` of ``source_sql``: the sum of each row's hash of the 14 ``CELLS_COLUMNS``,
    so the order of the rows does not change it."""
    row = con.execute(f"SELECT count(*), {_CHECKSUM} FROM ({source_sql})").fetchone()
    assert row is not None
    return int(row[0]), int(row[1])


def check_cells_equal(
    con: duckdb.DuckDBPyConnection, records: Sequence[ArtifactRecord], parts: Sequence[Path]
) -> None:
    """Check 6: each artifact's rows in ``parts`` equal its ``cells.parquet`` in count and checksum, and
    carry its measurement and artifact_format. Rows of an artifact no record names are refused."""
    held: dict[str, tuple[int, int, list[str], list[int]]] = {}
    if parts:
        rows = con.execute(
            f"SELECT variant_id, model_version, data_version, count(*), {_CHECKSUM}, "
            "list(DISTINCT measurement ORDER BY measurement), "
            "list(DISTINCT artifact_format ORDER BY artifact_format) "
            "FROM read_parquet(?, hive_partitioning = false) GROUP BY ALL",
            [[str(path) for path in parts]],
        ).fetchall()
        for variant_id, model_version, data_version, count, checksum, measurements, formats in rows:
            artifact = artifact_directory_name(variant_id, model_version, data_version)
            held[artifact] = (int(count), int(checksum), measurements, formats)
    stray = sorted(set(held) - {record.artifact for record in records})
    if stray:
        raise TableError(f"check 6: cells_by_cell holds {stray}, which no released or new artifact is")
    for record in records:
        artifact = record.artifact
        count, checksum = cells_checksum(con, f"SELECT * FROM {_read(record.cells_path)}")
        found_count, found_checksum, measurements, formats = held.get(artifact, (0, 0, [], []))
        if found_count != count:
            raise TableError(
                f"check 6: {artifact}: cells_by_cell holds {found_count} of its rows and its cells.parquet "
                f"{count} (count)"
            )
        if found_checksum != checksum:
            raise TableError(
                f"check 6: {artifact}: its cells_by_cell rows differ from its cells.parquet (checksum)"
            )
        measurement = measurement_of(artifact, record.manifest)[0]
        if measurements != [measurement]:
            raise TableError(
                f"check 6: {artifact}: cells_by_cell measurement {measurements}, not [{measurement!r}]"
            )
        if formats != [record.manifest["artifact_format"]]:
            raise TableError(
                f"check 6: {artifact}: cells_by_cell artifact_format {formats}, not its manifest's "
                f"[{record.manifest['artifact_format']}]"
            )


def _checked_cells(con: duckdb.DuckDBPyConnection, record: ArtifactRecord) -> tuple[list[str], str]:
    """``(distinct cells, measurement)`` of a record ``write_epoch`` may write, or the reason it may not."""
    artifact, manifest = record.artifact, record.manifest
    artifact_format = manifest.get("artifact_format")
    if type(artifact_format) is not int or artifact_format not in READABLE_FORMATS:
        if type(artifact_format) is int and artifact_format in (3, 4):
            raise TableError(
                f"{artifact}: artifact_format {artifact_format} stores prior_frequency_sd in each cell, "
                "which cells_by_cell v1 does not hold; it needs contract 1.1 before such an artifact ships "
                "(F4)"
            )
        raise TableError(
            f"{artifact}: artifact_format {artifact_format!r} is not one of {sorted(READABLE_FORMATS)}"
        )
    identity = tuple(manifest.get(field) for field in _IDENTITY)
    if not all(_text(value) for value in identity) or artifact_directory_name(*identity) != artifact:
        raise TableError(f"{artifact}: its manifest names {identity}, which is not its directory")
    measurement = measurement_of(artifact, manifest)[0]
    names = tuple(pq.read_schema(record.cells_path).names)
    if names != CELLS_COLUMNS:
        raise TableError(
            f"{artifact}: cells.parquet columns {list(names)} are not the format-1/2 CELLS_COLUMNS "
            f"{list(CELLS_COLUMNS)}"
        )
    source = _read(record.cells_path)
    held = con.execute(f"SELECT DISTINCT {', '.join(_IDENTITY)} FROM {source} ORDER BY ALL").fetchall()
    if held != [identity]:
        raise TableError(f"{artifact}: cells.parquet holds {held}, which is not its directory's {identity}")
    row = con.execute(f"SELECT count(*), count(DISTINCT h3_index) FROM {source}").fetchone()
    assert row is not None
    rows, distinct = row
    if distinct != rows:
        raise TableError(
            f"{artifact}: cells.parquet holds {rows} rows over {distinct} cells: a duplicate or null cell"
        )
    if rows != manifest.get("n_cells"):
        raise TableError(
            f"{artifact}: cells.parquet holds {rows} cells, its manifest's n_cells is "
            f"{manifest.get('n_cells')!r}"
        )
    resolution = manifest.get("resolution")
    if type(resolution) is not int or resolution < PARENT_RESOLUTION:
        raise TableError(
            f"{artifact}: resolution {resolution!r} is not an H3 resolution at or finer than h3_parent_r3's "
            f"{PARENT_RESOLUTION}"
        )
    cells = [cell for (cell,) in con.execute(f"SELECT DISTINCT h3_index FROM {source} ORDER BY 1").fetchall()]
    off = [cell for cell in cells if not h3.is_valid_cell(cell) or h3.get_resolution(cell) != resolution]
    if off:
        raise TableError(
            f"{artifact}: {len(off)} cells are not H3 cells at the manifest's resolution {resolution!r}, "
            f"e.g. {off[0]}"
        )
    return cells, measurement


def _ancestry(cells: Iterable[str]) -> pyarrow.Table:
    """Each cell's resolution, resolution-0 ancestor and resolution-3 parent (itself at res 3)."""
    ordered = sorted(set(cells))
    return pyarrow.table(
        {
            "h3_index": pyarrow.array(ordered, pyarrow.string()),
            "res": pyarrow.array([h3.get_resolution(cell) for cell in ordered], pyarrow.int32()),
            "h3_r0": pyarrow.array([h3.cell_to_parent(cell, 0) for cell in ordered], pyarrow.string()),
            "h3_parent_r3": pyarrow.array(
                [h3.cell_to_parent(cell, PARENT_RESOLUTION) for cell in ordered], pyarrow.string()
            ),
        }
    )


def _epoch_columns() -> str:
    """The column definitions of ``cells_by_cell``, in contract order, as DuckDB types."""
    types = {"string": "VARCHAR", "double": "DOUBLE", "int32": "INTEGER"}
    schema = contracts.TABLE_CONTRACTS[CELLS_TABLE].arrow_schema
    assert schema is not None
    return ", ".join(f"{_identifier(field.name)} {types[str(field.type)]}" for field in schema)


def _refuse_strays(out_root: Path, epoch: str, planned: Mapping[str, object]) -> None:
    """A file in the epoch's folder that this epoch would not write (an earlier, different build's)."""
    folder = out_root / EPOCH_ROOT / f"epoch={epoch}"
    if not folder.is_dir():
        return
    found = (path.relative_to(out_root).as_posix() for path in folder.rglob("*") if path.is_file())
    stray = sorted(path for path in found if path not in planned)
    if stray:
        raise TableError(
            f"{stray} lie in epoch={epoch} but this build does not write them; remove {folder} and build "
            "again"
        )


def _support_counts(artifact: str, counts: object) -> dict[str, int]:
    """The manifest's ``support_counts``: a map of support state to a cell count."""
    if not isinstance(counts, Mapping) or not all(
        isinstance(state, str) and type(count) is int and count >= 0 for state, count in counts.items()
    ):
        raise TableError(f"{artifact}: support_counts {counts!r} is not a map of state to cell count")
    return dict(sorted(counts.items()))


def _checked_evidence(
    artifact: str, evidence: Mapping[str, tuple[str, str | None]]
) -> tuple[str, str | None]:
    """Check 10: an evidence value for every artifact, with a reason exactly when it is ``none``."""
    if artifact not in evidence:
        raise TableError(
            f"check 10: {artifact}: no fit_input_evidence; it is never null (data platform §2.8)"
        )
    value, reason = evidence[artifact]
    if (
        value not in EVIDENCE
        or _text(reason) != (value == NONE)
        or (reason is not None and not _text(reason))
    ):
        raise TableError(
            f"check 10: {artifact}: fit_input_evidence {value!r} with reason {reason!r}; it is one of "
            f"{list(EVIDENCE)}, with a reason exactly when it is {NONE}"
        )
    return value, reason


def _text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _read(path: Path) -> str:
    """A ``read_parquet`` of one local file; a folder name such as ``epoch=`` is never a column."""
    quoted = str(path).replace("'", "''")
    return f"read_parquet('{quoted}', hive_partitioning = false)"


def _identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


#: The order-independent checksum of the 14 ``CELLS_COLUMNS`` (check 6).
_CHECKSUM = f"coalesce(sum(hash({', '.join(_identifier(name) for name in CELLS_COLUMNS)})::HUGEINT), 0)"
