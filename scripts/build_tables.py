#!/usr/bin/env python3
"""Build a release's derived ``tables/`` files into the local ``data/`` tree.

Atlas data platform design 2026-10-18 §2.3-§2.5 and §2.9; builder's calls 4, 7, 15 and 16.

    python scripts/build_tables.py --release 2026-11-20

Run before ``build_data_release.py``, which then publishes each file with the sources it records.
Stages run in the order of ``STAGES``, each taking one ``BuildContext``; ``--stage`` (repeatable) picks
some. The context holds the committed manifests of every earlier release and each released path's first
publication, read from ``data/releases/``; a release id already committed, or older than the newest
one, is refused. ``--git-sha`` (default ``HEAD``) is the commit every file is stamped with.

The ``meta`` stage writes ``tables/v1/meta/{release_objects,sources,served,withdrawn}.parquet`` from
the committed manifests, the web ``catalog.json`` and ``data/releases/WITHDRAWN.json``, and prints
``<table>: <n> rows`` for each. The same inputs give byte-identical files (one pinned DuckDB, call 15).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.tables import contracts, meta, provenance, writer  # noqa: E402
from genomeos.tables.contracts import TableError  # noqa: E402
from genomeos.tables.provenance import InputRef  # noqa: E402

DATA = ROOT / "data"
RELEASES = DATA / "releases"
#: Every stage, in the order a build runs them.
STAGES = ("meta", "reference", "measured", "fit_inputs", "inferred")


@dataclass(frozen=True)
class BuildContext:
    """What every stage reads: the trees, the new release, its stamp and the committed history."""

    data_root: Path
    out_root: Path
    release: str
    git_sha: str
    manifests: tuple[Mapping[str, Any], ...]
    published: Mapping[str, dr.ReleaseObject]
    repo_root: Path


def build_meta(
    ctx: BuildContext, *, web_catalog: Path | None = None, withdrawn: Path | None = None
) -> dict[str, int]:
    """The four ``meta.*`` files. ``web_catalog`` and ``withdrawn`` replace the repository's files (tests)."""
    by_release = {manifest["release"]: manifest for manifest in ctx.manifests}
    manifest_refs = tuple(provenance.manifest_ref(manifest) for manifest in ctx.manifests)
    catalog_bytes, catalog = _read_json(web_catalog or ctx.repo_root / meta.WEB_CATALOG)
    withdrawn_bytes, document = _read_json(withdrawn or ctx.repo_root / meta.WITHDRAWN_LIST)
    entries = dr.validate_withdrawn(document)
    withdrawn_refs = (
        InputRef(f"{provenance.GIT_PREFIX}{meta.WITHDRAWN_LIST}", _sha256(withdrawn_bytes)),
        *(InputRef(entry.key, entry.sha256) for entry in entries),
    )
    released = meta.released_artifacts(ctx.published)
    tables = {
        "meta.release_objects": (
            meta.release_objects_frame(ctx.manifests),
            manifest_refs,
            ("release", "path"),
        ),
        "meta.sources": (meta.sources_frame(ctx.manifests), manifest_refs, ("release", "source")),
        "meta.served": (
            meta.served_frame(catalog, released_artifacts=released),
            meta.served_inputs(catalog, _sha256(catalog_bytes), published=ctx.published),
            ("artifact",),
        ),
        "meta.withdrawn": (meta.withdrawn_frame(entries, published=ctx.published), withdrawn_refs, ("key",)),
    }
    con = writer.connect()
    counts: dict[str, int] = {}
    for table, (frame, inputs, order_by) in tables.items():
        writer.write_frame(
            con,
            frame,
            ctx.out_root / contracts.table_path(table),
            table=table,
            git_sha=ctx.git_sha,
            inputs=inputs,
            sources=provenance.union_sources(inputs, manifests=by_release, new_sources={}),
            order_by=order_by,
        )
        counts[table] = len(frame)
        print(f"{table}: {len(frame)} rows")
    return counts


def committed_manifests(directory: Path) -> tuple[dict[str, Any], ...]:
    """Every manifest in ``directory``, oldest first, each valid and byte for byte its canonical form."""
    manifests: list[dict[str, Any]] = []
    for release in dr.release_ids(path.name for path in directory.glob("*.json")):
        payload, manifest = _read_json(directory / f"{release}.json")
        if not isinstance(manifest, dict) or manifest.get("release") != release:
            raise TableError(f"{directory / release}.json does not hold release {release}")
        if payload != dr.canonical_bytes(manifest):
            raise TableError(f"{directory / release}.json is not in canonical form (dr.canonical_bytes)")
        dr.validate_manifest(manifest)
        manifests.append(manifest)
    return tuple(manifests)


def resolve_git_sha(value: str, repo_root: Path) -> str:
    """A full commit sha: ``value`` itself when it is one, else what git resolves it to."""
    if writer.GIT_SHA_PATTERN.fullmatch(value):
        return value
    try:
        resolved = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{value}^{{commit}}"],
            cwd=repo_root,
            capture_output=True,
            check=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise TableError(f"--git-sha {value!r} names no commit in {repo_root}") from error
    return resolved


def context(args: argparse.Namespace, repo_root: Path = ROOT) -> BuildContext:
    manifests = committed_manifests(args.releases)
    newest = manifests[-1]["release"] if manifests else None
    if newest is not None and dr.release_sort_key(args.release) <= dr.release_sort_key(newest):
        raise TableError(
            f"release {args.release} is not later than the newest committed release {newest}; "
            "tables are built for a new release"
        )
    return BuildContext(
        data_root=args.data,
        out_root=args.data,
        release=args.release,
        git_sha=resolve_git_sha(args.git_sha, repo_root),
        manifests=manifests,
        published=provenance.published_paths(manifests),
        repo_root=repo_root,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a release's derived tables/ files into data/.")
    parser.add_argument("--release", type=dr.assert_release_id, required=True, help="YYYY-MM-DD[.N]")
    parser.add_argument("--data", type=Path, default=DATA, help="the data/ tree (default: the checkout's)")
    parser.add_argument("--git-sha", default="HEAD", help="the commit each file records (default: HEAD)")
    parser.add_argument("--stage", action="append", choices=tuple(_RUNNERS), help="repeatable; default: all")
    # Hidden: tests read copies, never the committed releases/, web catalog or withdrawn list.
    parser.add_argument("--releases", type=Path, default=RELEASES, help=argparse.SUPPRESS)
    parser.add_argument("--web-catalog", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--withdrawn", type=Path, help=argparse.SUPPRESS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    selected = set(args.stage or _RUNNERS)
    try:
        ctx = context(args)
        for stage in STAGES:
            if stage in selected:
                _RUNNERS[stage](ctx, args)
    except (TableError, dr.DataReleaseError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


def _run_meta(ctx: BuildContext, args: argparse.Namespace) -> None:
    build_meta(ctx, web_catalog=args.web_catalog, withdrawn=args.withdrawn)


#: The stages this checkout builds, each run from the parsed arguments; ``--stage`` takes only these.
_RUNNERS: dict[str, Callable[[BuildContext, argparse.Namespace], object]] = {"meta": _run_meta}


def _read_json(path: Path) -> tuple[bytes, Any]:
    payload = path.read_bytes()
    try:
        return payload, json.loads(payload)
    except json.JSONDecodeError as error:
        raise TableError(f"{path}: not JSON: {error}") from error


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
