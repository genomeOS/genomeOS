#!/usr/bin/env python3
"""Build, or check, the committed browser SQL fixture ``website/tests/fixtures/data-store``.

Atlas data platform design 2026-10-18 §2.6, §2.9, §3.1 and step 1.13. The fixture is release
``FIXTURE_RELEASE`` as the data-store bucket would hold it, for ``website/scripts/serve-data-store.mjs`` to
serve at ``FIXTURE_BASE_URL``, where the browser tests read it with the pinned DuckDB-WASM:

- ``releases/<R>/range_probe.parquet``: ``PROBE_ROWS`` rows, ``h3_index`` = ``'8'`` and the row number in
  14 hex digits (a sort key, not an H3 cell) and ``post_mean`` = row / ``PROBE_ROWS``, sorted, in zstd row
  groups of 8,192, so a lookup of ``PROBE_KEY`` needs one row group: the range-read measurement. A
  ``padding`` column no query reads (the row's md5, ``PROBE_PADDING_CHARS`` hex digits) makes the file
  ``PROBE_MIN_BYTES`` or more, so DuckDB-WASM's fixed lookup cost is under a quarter of it, as it is of a
  released ``cells.parquet``. The manifest lists it, and no view reads it.
- ``releases/<R>/catalog/{catalog.sql,atlas.duckdb}``, rendered by ``render_catalog_sql`` over
  ``base_url`` and built by ``build_catalog_db``. Its two data views are ``inferred.artifacts`` (one row,
  the catalog tree's HbS v3, as the release builder writes it) and ``evidence.parity_observations``
  (``PARITY_ROWS``); beside them are ``meta.release`` and the empty ``meta.withdrawn``, which every view
  anti-joins (§2.9).
- ``manifests/<R>.json``, listing every file above under its key, and ``manifests/WITHDRAWN.json``, the
  empty withdrawn list: the website reads this folder as it reads ``data/releases/``.

Every file is synthetic and project-authored (source ``genomeos``), and the pinned DuckDB writes every
Parquet file, so their bytes depend on no pandas or pyarrow version.

    python scripts/build_browser_sql_fixture.py            # write
    python scripts/build_browser_sql_fixture.py --check    # fail if stale

``--check`` builds it again and compares every file byte for byte, except ``atlas.duckdb``, compared by its
views' and macros' SQL as ``build_catalog_fixture.py`` does (the fixture is built on macOS and checked on
Linux), and so the manifest, compared without that file's bytes and sha256.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.tables import catalog, contracts, inferred, meta, writer  # noqa: E402
from genomeos.tables.contracts import TableError  # noqa: E402
from genomeos.tables.provenance import GIT_PREFIX, InputRef  # noqa: E402
from scripts import build_data_release, fixture_trees  # noqa: E402
from scripts.build_catalog_fixture import database_definitions, fixture_files  # noqa: E402

FIXTURE_RELEASE = "2000-01-01"
FIXTURE_BASE_URL = "http://127.0.0.1:4324/"
#: Row 0xe000 (57,344) of the probe: ``post_mean`` 57,344 / 98,304 = 0.5833…
PROBE_KEY = "80000000000e000"
PROBE_FILE = "range_probe.parquet"
PROBE_ROWS = 98_304
#: DuckDB-WASM 1.32.0's fixed cost of one lookup over HTTP, whatever the object's size: the 16 KiB block
#: holding the footer, the 16 KiB block the row group starts in and a 64 KiB read-ahead (measured
#: 2026-11-15; ``website/src/atlas/browser-sql/route.ts``).
WASM_LOOKUP_BYTES = 16_384 + 16_384 + 65_536
#: The probe is at least this large, so that fixed cost is at most half the browser test's bound, under a
#: quarter of the file, and the bound measures the range read rather than the read-ahead.
PROBE_MIN_BYTES = 8 * WASM_LOOKUP_BYTES
#: Hex digits of ``md5(row)`` in the probe's unread ``padding`` column: 12 make it about 0.96 MB.
PROBE_PADDING_CHARS = 12
FIXTURE = ROOT / "website" / "tests" / "fixtures" / "data-store"
#: The parity rows at Lagos's longitude, ``(lat, lon, radius_km, an, ac)``. The Lagos disc (500 km plus
#: each row's radius around 6.5244, 3.3792) holds the first three, 0, 445 and 512 km away: 3 rows, ``an``
#: 60, ``ac`` 6. The fourth (512 km, radius 5) and the fifth (667 km, radius 100) lie outside it.
PARITY_ROWS = (
    (6.5244, 3.3792, 10.0, 10, 1),
    (10.5244, 3.3792, 10.0, 20, 2),
    (11.1244, 3.3792, 20.0, 30, 3),
    (11.1244, 3.3792, 5.0, 40, 4),
    (0.5244, 3.3792, 100.0, 50, 5),
)
SOURCE = "genomeos"
EMPTY_WITHDRAWN: dict[str, Any] = {
    "schema": dr.WITHDRAWN_SCHEMA,
    "schema_version": dr.WITHDRAWN_SCHEMA_VERSION,
    "withdrawn": [],
}
_ARTIFACT = fixture_trees.HBS_V3
_MANIFEST = f"{dr.MANIFEST_PREFIX}{FIXTURE_RELEASE}.json"
_WITHDRAWN = f"{dr.MANIFEST_PREFIX}{dr.WITHDRAWN_FILE}"


def build_fixture(out: Path, base_url: str) -> None:
    """Release ``FIXTURE_RELEASE`` of the fixture's files, its catalog keyed under ``base_url``, at ``out``.

    ``out/releases`` and ``out/manifests`` are replaced; other files in ``out`` are left for ``--check``.
    """
    with tempfile.TemporaryDirectory() as scratch:
        data = Path(scratch) / "data"
        _write_probe(data / PROBE_FILE)
        fixture_trees.write_parity_file(data, PARITY_ROWS)
        _write_withdrawn(data)
        _write_artifacts(data, Path(scratch) / "artifact")
        files = build_data_release.listed_files(data, dr.validate_manifest(_manifest(data)))
        sql = catalog.render_catalog_sql(FIXTURE_RELEASE, files, base_url=base_url)
        (data / catalog.CATALOG_SQL).parent.mkdir(parents=True)
        (data / catalog.CATALOG_SQL).write_text(sql, encoding="utf-8")
        writer.build_catalog_db(sql, data / catalog.CATALOG_DB, data_root=data)
        manifest = _manifest(data)
        for folder in (dr.RELEASE_PREFIX, dr.MANIFEST_PREFIX):
            if (out / folder).exists():
                shutil.rmtree(out / folder)
        for item in dr.validate_manifest(manifest):
            (out / item.key).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(data / item.path, out / item.key)
    (out / _MANIFEST).parent.mkdir(parents=True, exist_ok=True)
    (out / _MANIFEST).write_bytes(dr.canonical_bytes(manifest))
    (out / _WITHDRAWN).write_bytes(dr.canonical_bytes(EMPTY_WITHDRAWN))


def check_fixture(out: Path) -> list[str]:
    """How the fixture at ``out`` differs from a fresh build: nothing, when the list is empty."""
    with tempfile.TemporaryDirectory() as scratch:
        built = Path(scratch) / "data-store"
        build_fixture(built, FIXTURE_BASE_URL)
        found, wanted = fixture_files(out), fixture_files(built)
        problems = [f"{path}: missing" for path in sorted(wanted - found)]
        problems += [f"{path}: not part of the fixture" for path in sorted(found - wanted)]
        for path in sorted(found & wanted):
            if path.endswith(catalog.CATALOG_DB):
                same = database_definitions(out / path) == database_definitions(built / path)
            elif path == _MANIFEST:
                same = _comparable(out / path) == _comparable(built / path)
            else:
                same = (out / path).read_bytes() == (built / path).read_bytes()
            if not same:
                problems.append(f"{path}: differs from a fresh build")
    return problems


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build, or check, the committed browser SQL fixture.")
    parser.add_argument("--check", action="store_true", help="fail if the committed fixture is stale")
    args = parser.parse_args(argv)
    where = FIXTURE.relative_to(ROOT).as_posix()
    try:
        if not args.check:
            build_fixture(FIXTURE, FIXTURE_BASE_URL)
            print(f"wrote {where}: {len(fixture_files(FIXTURE))} files")
            return 0
        problems = check_fixture(FIXTURE)
    except (TableError, dr.DataReleaseError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if problems:
        print(f"{where} is stale:", *problems, sep="\n  ", file=sys.stderr)
        print("run: python scripts/build_browser_sql_fixture.py", file=sys.stderr)
        return 1
    print(f"{where}: current")
    return 0


def _write_probe(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    con = writer.connect()
    try:
        con.execute(
            f"COPY (SELECT '8' || format('{{:014x}}', i) AS h3_index, i / {PROBE_ROWS}.0 AS post_mean, "
            f"substr(md5(i::VARCHAR), 1, {PROBE_PADDING_CHARS}) AS padding "
            f"FROM range({PROBE_ROWS}) AS probe(i) ORDER BY i) TO '{out}' "
            f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {writer.ROW_GROUP_ROWS})"
        )
    finally:
        con.close()


def _write_withdrawn(data: Path) -> None:
    """The empty ``meta.withdrawn``, derived from the fixture's own ``WITHDRAWN.json``."""
    listed = FIXTURE.relative_to(ROOT) / _WITHDRAWN
    digest = hashlib.sha256(dr.canonical_bytes(EMPTY_WITHDRAWN)).hexdigest()
    _write_table(
        meta.withdrawn_frame((), published={}),
        data,
        catalog.WITHDRAWN_TABLE,
        inputs=(InputRef(f"{GIT_PREFIX}{listed.as_posix()}", digest),),
        order_by=("key",),
    )


def _write_artifacts(data: Path, store: Path) -> None:
    """``inferred.artifacts``: the catalog tree's HbS v3, first released in ``FIXTURE_RELEASE``, as
    ``build_tables.build_inferred`` writes its row. Its files are written to ``store`` to be keyed and
    hashed, and stay out of the fixture."""
    artifact_format, resolution, cells, measurement = fixture_trees.FIXTURE_ARTIFACTS[_ARTIFACT]
    directory = fixture_trees.add_artifact(
        store,
        _ARTIFACT,
        artifact_format=artifact_format,
        resolution=resolution,
        cells=cells,
        measurement=measurement,
    )
    cells_path, manifest_path = directory / inferred.CELLS_FILE, directory / meta.MANIFEST_FILE
    record = inferred.ArtifactRecord(
        artifact=_ARTIFACT,
        manifest=json.loads(manifest_path.read_text(encoding="utf-8")),
        cells_path=cells_path,
        cells_key=_artifact_key(inferred.CELLS_FILE),
        cells_sha256=build_data_release.sha256_of(cells_path),
        manifest_key=_artifact_key(meta.MANIFEST_FILE),
        manifest_sha256=build_data_release.sha256_of(manifest_path),
        observations_key=None,
        observations_sha256=None,
        first_release=FIXTURE_RELEASE,
        sources=(SOURCE,),
    )
    evidence = inferred.fit_input_evidence(
        _ARTIFACT, has_input=False, released_without_input=build_data_release.RELEASED_WITHOUT_INPUT
    )
    frame = inferred.artifacts_frame(
        [record], epochs={_ARTIFACT: FIXTURE_RELEASE}, evidence={_ARTIFACT: evidence}
    )
    _write_table(frame, data, inferred.ARTIFACTS_TABLE, inputs=record.cells_inputs, order_by=("artifact",))


def _write_table(
    frame: pd.DataFrame, data: Path, table: str, *, inputs: Sequence[InputRef], order_by: Sequence[str]
) -> None:
    con = writer.connect()
    try:
        writer.write_frame(
            con,
            frame,
            data / contracts.table_path(table),
            table=table,
            git_sha=fixture_trees.GIT_SHA,
            inputs=inputs,
            sources=(SOURCE,),
            order_by=order_by,
        )
    finally:
        con.close()


def _artifact_key(name: str) -> str:
    return dr.release_key(FIXTURE_RELEASE, f"{dr.ARTIFACT_PREFIX}{_ARTIFACT}/{name}")


def _manifest(data: Path) -> dict[str, Any]:
    """The release manifest of every file under ``data``, each from source ``genomeos``."""
    records = [
        dr.FileRecord(
            path.relative_to(data).as_posix(),
            path.stat().st_size,
            build_data_release.sha256_of(path),
            False,
            (SOURCE,),
        )
        for path in sorted(data.rglob("*"))
        if path.is_file()
    ]
    sources = {SOURCE: build_data_release.REVIEWED_SOURCES[SOURCE]}
    return dr.build_manifest(records, sources, FIXTURE_RELEASE)


def _comparable(manifest_file: Path) -> dict[str, Any]:
    """The manifest without ``atlas.duckdb``'s bytes and sha256, and so without the byte total."""
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    for item in manifest["objects"]:
        if item["path"] == catalog.CATALOG_DB:
            del item["bytes"], item["sha256"]
    del manifest["totals"]["bytes"]
    return manifest


if __name__ == "__main__":
    raise SystemExit(main())
