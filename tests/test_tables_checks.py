"""Checks 1, 2, 6, 9 and 10 over a release's tables/ files (Atlas data platform design 2026-10-18 §2.7).

§2.2 rule 3, §2.3 and §2.8; builder's calls 16 and 17. Each case builds ``catalog_tree``'s tables, keys
the tree with the release builder's first pass, breaks one file, re-hashes the tree and runs the checks
as the release builder does.
"""

from __future__ import annotations

import dataclasses
import hashlib
import os
import shutil
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from genomeos.publication import data_release as dr
from genomeos.tables import checks, contracts, inferred, provenance, writer
from genomeos.tables.contracts import TableError
from genomeos.tables.provenance import InputRef
from scripts import build_tables
from tests import tables_fixtures
from tests.tables_fixtures import (
    EPOCH,
    GIT_SHA,
    KIR_V3,
    R0_LAGOS,
    R0_LONDON,
    ROOT,
    build_catalog_tables,
    release_catalog_tree,
    rewrite_parquet,
)

catalog_tree = tables_fixtures.catalog_tree

LATER = "2026-11-21"
SERVED = contracts.table_path("meta.served")
WITHDRAWN = contracts.table_path("meta.withdrawn")
ARTIFACTS = contracts.table_path(inferred.ARTIFACTS_TABLE)


def _part(res: int, h3_r0: str, epoch: str = EPOCH) -> str:
    return inferred.part_path(epoch, res, h3_r0)


def _rewrite(data: Path, path: str, select: str, **options) -> None:
    """Replace ``path`` with ``SELECT <select>`` over it, its metadata kept (``rewrite_parquet``)."""
    source = data / path
    staged = source.with_name(f"{source.name}.new")
    rewrite_parquet(writer.connect(), source, staged, select, **options)
    os.replace(staged, source)


def _copy(data: Path, source: str, target: str) -> None:
    (data / target).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(data / source, data / target)


def _changed_columns(data: Path) -> None:
    _rewrite(data, SERVED, "* EXCLUDE (pinned_by)")


def _another_schema(data: Path) -> None:
    _copy(data, SERVED, "tables/v1/other/x.parquet")


def _measured_and_inferred(data: Path) -> None:
    _copy(data, ARTIFACTS, "tables/v1/measured/allele_observations/source=x/ingest_version=y/part-0.parquet")


def _lagos_in_the_london_folder(data: Path) -> None:
    _copy(data, _part(4, R0_LAGOS), _part(4, R0_LONDON))


def _changed_post_mean(data: Path) -> None:
    _rewrite(data, _part(3, R0_LAGOS), "* REPLACE (post_mean + 0.5 AS post_mean)")


def _cells_in_two_epochs(data: Path) -> None:
    """HbS v1's res-3 parts, copied under a second epoch whose folder and column agree (check 2 passes)."""
    for h3_r0 in (R0_LAGOS, R0_LONDON):
        target = data / _part(3, h3_r0, LATER)
        rewrite_parquet(writer.connect(), data / _part(3, h3_r0), target, f"* REPLACE ('{LATER}' AS epoch)")


def _unpublished_input(data: Path) -> None:
    path = data / WITHDRAWN
    writer.write_parquet(
        writer.connect(),
        f"SELECT * FROM read_parquet('{path}')",
        path,
        table="meta.withdrawn",
        git_sha=GIT_SHA,
        inputs=[InputRef(dr.release_key("2026-01-01", "x.json"), "a" * 64)],
        sources=["genomeos"],
        order_by=["key"],
    )


def _unrecorded_sources(data: Path) -> None:
    _rewrite(data, WITHDRAWN, "*", drop=(provenance.SOURCES_KEY,))


def _null_evidence(data: Path) -> None:
    null = f"CASE WHEN artifact = '{KIR_V3}' THEN NULL ELSE fit_input_evidence END"
    _rewrite(data, ARTIFACTS, f"* REPLACE ({null} AS fit_input_evidence)")


def _rehashed(data: Path, objects: Sequence[dr.ReleaseObject]) -> tuple[dr.ReleaseObject, ...]:
    """``objects`` as the tree now holds them: each file's bytes and sha256, a new file keyed under
    ``EPOCH`` with the project's own source."""
    known = {item.path: item for item in objects}
    found = []
    for path in sorted(path for path in data.rglob("*") if path.is_file()):
        relative = path.relative_to(data).as_posix()
        payload = path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        item = known.get(relative)
        if item is None:
            key = dr.release_key(EPOCH, relative)
            item = dr.ReleaseObject(
                relative, key, 0, digest, dr.media_type_for(relative), False, ("genomeos",)
            )
        found.append(dataclasses.replace(item, bytes=len(payload), sha256=digest))
    return tuple(found)


@pytest.mark.parametrize(
    ("tamper", "match"),
    [
        (_changed_columns, r"check 1: .*contract"),
        (_another_schema, r"check 2: .*measured"),
        (_measured_and_inferred, r"check 2: .*both"),
        (_lagos_in_the_london_folder, r"check 2: .*h3_r0"),
        (_changed_post_mean, r"check 6: .*checksum"),
        (_cells_in_two_epochs, r"check 6: .*count"),
        (_unpublished_input, r"check 9: .*releases/"),
        (_unrecorded_sources, r"check 9: .*genomeos.sources"),
        (_null_evidence, r"check 10: .*fit_input_evidence"),
    ],
    ids=[
        "columns-not-the-contract",
        "a-sixth-schema",
        "one-file-measured-and-inferred",
        "a-row-outside-its-h3_r0",
        "a-changed-cell",
        "cells-in-two-epochs",
        "an-input-in-no-manifest",
        "no-recorded-sources",
        "a-null-evidence",
    ],
)
def test_check_release_tables_refuses(catalog_tree: Path, tamper: Callable[[Path], None], match: str) -> None:
    build_catalog_tables(catalog_tree)
    data = catalog_tree / "data"
    objects = dr.validate_manifest(release_catalog_tree(catalog_tree, catalog=False))
    manifests = build_tables.committed_manifests(catalog_tree / "releases")
    arguments = {"manifests": manifests, "repo_root": ROOT}
    checks.check_release_tables(
        data, objects, **arguments, new_sources={item.path: item.sources for item in objects}
    )
    tamper(data)
    objects = _rehashed(data, objects)
    with pytest.raises(TableError, match=match):
        checks.check_release_tables(
            data, objects, **arguments, new_sources={item.path: item.sources for item in objects}
        )


def test_a_contract_that_is_not_its_frozen_file_is_refused(catalog_tree: Path, tmp_path: Path) -> None:
    """Check 1 reads the frozen contract the repository commits, not only the one in the code."""
    build_catalog_tables(catalog_tree)
    data = catalog_tree / "data"
    objects = dr.validate_manifest(release_catalog_tree(catalog_tree, catalog=False))
    repo = tmp_path / "repo"
    shutil.copytree(ROOT / "contract" / "tables", repo / "contract" / "tables")
    frozen = repo / contracts.TABLE_CONTRACTS["meta.served"].path
    frozen.write_text(frozen.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    with pytest.raises(TableError, match=r"check 1: .*meta\.served\.v1\.schema\.json"):
        checks.check_release_tables(
            data,
            objects,
            manifests=build_tables.committed_manifests(catalog_tree / "releases"),
            repo_root=repo,
            new_sources={item.path: item.sources for item in objects},
        )
