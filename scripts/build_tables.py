#!/usr/bin/env python3
"""Build a release's derived ``tables/`` files into the local ``data/`` tree.

Atlas data platform design 2026-10-18 §2.3-§2.5, §2.7 checks 5 and 9, and §2.9; builder's calls 4-7, 15, 16
and 18.

    python scripts/build_tables.py --release 2026-11-20

Run before ``build_data_release.py``, which then publishes each file with the sources it records.
Stages run in the order of ``STAGES``, each taking one ``BuildContext``; ``--stage`` (repeatable) picks
some. The context holds the committed manifests of every earlier release and each released path's first
publication, read from ``data/releases/``; a release id already committed, or older than the newest
one, is refused. ``--git-sha`` (default ``HEAD``) is the commit every file is stamped with; it must
name a commit in this repository, a full sha included.

A ``git:<path>`` input is recorded as that file at the stamped commit (§2.7 check 9), so it is read
from the commit, and the build is refused, naming the path, when the working tree's file differs from
it or the commit lacks it: commit the edit first, or stamp the commit that holds it.

The ``meta`` stage writes ``tables/v1/meta/{release_objects,sources,served,withdrawn}.parquet`` from
the committed manifests, the web ``catalog.json`` and ``data/releases/WITHDRAWN.json``, and prints
``<table>: <n> rows`` for each. The same inputs give byte-identical files (one pinned DuckDB, call 15).

The ``reference`` stage (§2.3, §2.4; calls 5, 6 and 18) writes the population registry's folders under
``tables/v1/reference/populations/``: ``afnd-2026-08`` rebuilt from the released raw file
``raw/afnd_populations.tsv``, and ``map-survey-coordinates-v1``, alias rows only, from the MAP harvest
(``raw/map/2026-08/``). A row the AFND adapter refuses stops the stage before anything is written (v1
§12). An input an earlier release published is read from a local copy with its published sha256; any
other is keyed under this release. A folder an earlier release published is never
written again: its rows are re-derived and verified against the released files, so a rerun under another
git sha keeps the first writer's bytes. Any other local file under that root is refused before a folder is
written. It prints ``<table> <folder>: <n> rows, written`` (or ``verified``) for each file.

The ``inferred`` stage (§2.4, §2.8; calls 6, 8, 22) reads every released artifact under
``store/artifacts/`` plus any this release adds, keyed from the committed manifests or else under this
release. It writes ``cells_by_cell`` parts only for artifacts no earlier epoch holds, under
``epoch=<release>``; every earlier epoch's parts are read, never rebuilt, from local copies whose
sha256 is the published one (``fetch_data.py --prefix tables/`` fetches them). Any other local file
under ``cells_by_cell/``, such as an epoch built for a release that was never committed, is refused
before a part is written (remove it and build again). It runs checks 1, 2, 6 and 10, writes
``tables/v1/inferred/artifacts.parquet`` and prints one line for each table.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import artifact_inputs as ai  # noqa: E402
from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.publication import raw_harvests as rh  # noqa: E402
from genomeos.tables import contracts, inferred, meta, provenance, reference, write_once, writer  # noqa: E402
from genomeos.tables.contracts import TableError  # noqa: E402
from genomeos.tables.provenance import InputRef  # noqa: E402
from scripts import build_data_release  # noqa: E402

DATA = ROOT / "data"
RELEASES = DATA / "releases"
#: Every stage, in the order a build runs them.
STAGES = ("meta", "reference", "measured", "fit_inputs", "inferred")
#: The released raw file the ``afnd-2026-08`` registry is rebuilt from (call 18).
AFND_POPULATIONS = "raw/afnd_populations.tsv"
_MAP_HARVEST = next(harvest for harvest in rh.RAW_HARVESTS if harvest.source == "map")
#: The MAP harvest's HbS and G6PD survey layers, the ``map-survey-coordinates-v1`` aliases' inputs.
MAP_SURVEYS = tuple(
    rh.harvest_path(_MAP_HARVEST, name) for name in ("map_hbs_surveys.csv", "map_g6pd_surveys.csv")
)


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
    """The four ``meta.*`` files.

    The web catalog and the withdrawn list are read at ``ctx.git_sha`` (``read_git_input``).
    ``web_catalog`` and ``withdrawn`` replace them with a file read as it stands (tests only).
    """
    by_release = _by_release(ctx)
    manifest_refs = tuple(provenance.manifest_ref(manifest) for manifest in ctx.manifests)
    catalog_bytes, catalog = _git_json(ctx, meta.WEB_CATALOG, web_catalog)
    withdrawn_bytes, document = _git_json(ctx, meta.WITHDRAWN_LIST, withdrawn)
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


def build_reference(ctx: BuildContext) -> list[str]:
    """The registry folders ``afnd-2026-08`` and ``map-survey-coordinates-v1``; their files' release paths.

    A file an earlier release published is verified against its re-derived rows, never written (call 6).
    """
    afnd_input, afnd_copy = _stage_input(ctx, AFND_POPULATIONS)
    map_inputs = [_stage_input(ctx, path) for path in MAP_SURVEYS]
    registries = (
        (reference.AFND_LEGACY, *reference.afnd_legacy(afnd_copy), (afnd_input,)),
        (
            reference.MAP_LEGACY,
            None,
            reference.map_legacy_aliases(*(copy for _, copy in map_inputs)),
            tuple(ref for ref, _ in map_inputs),
        ),
    )
    built: dict[str, tuple[str, pd.DataFrame, tuple[InputRef, ...]]] = {}
    for version, populations, aliases, inputs in registries:
        frames = reference.reference_frames(populations, aliases, registry_version=version)
        tables = (reference.POPULATIONS_TABLE, reference.ALIASES_TABLE)
        for path, table, frame in zip(reference.reference_paths(version), tables, frames, strict=True):
            if frame is not None:
                built[path] = (table, frame, inputs)
    _refuse_registry_strays(ctx, built)
    con = writer.connect()
    new_sources = {
        path: build_data_release.sources_for(ctx.data_root, path)
        for path in (AFND_POPULATIONS, *MAP_SURVEYS)
        if path not in ctx.published
    }
    for path, (table, frame, inputs) in sorted(built.items()):
        key = contracts.TABLE_CONTRACTS[table].key
        item = ctx.published.get(path)
        if item is not None:
            copy = write_once.require_published_local(ctx.data_root, path, item.sha256)
            write_once.require_same_rows(copy, frame, key=key)
            status = "verified"
        else:
            writer.write_frame(
                con,
                frame,
                ctx.out_root / path,
                table=table,
                git_sha=ctx.git_sha,
                inputs=inputs,
                sources=provenance.union_sources(inputs, manifests=_by_release(ctx), new_sources=new_sources),
                order_by=key,
            )
            status = "written"
        print(f"{table} {path.split('/')[-2]}: {len(frame)} rows, {status}")
    return sorted(built)


def artifact_records(ctx: BuildContext) -> tuple[inferred.ArtifactRecord, ...]:
    """Every released artifact, and every artifact directory this release adds, as the build reads it.

    A released file is keyed from the committed manifests and read from a local copy with its published
    sha256 (``write_once.require_published_local``); a new artifact's files are keyed under
    ``ctx.release``, hashed here, and take their sources from the release builder's reviewed rules.
    """
    released = meta.released_artifacts(ctx.published)
    local = ctx.data_root / dr.ARTIFACT_PREFIX
    added = sorted(path.name for path in local.iterdir() if path.is_dir()) if local.is_dir() else []
    records = []
    for artifact in sorted(set(released) | set(added)):
        files: dict[str, tuple[str, str, Path, tuple[str, ...]]] = {}
        for name in (inferred.CELLS_FILE, meta.MANIFEST_FILE, ai.INPUT_FILE):
            path = f"{dr.ARTIFACT_PREFIX}{artifact}/{name}"
            item = ctx.published.get(path)
            if item is not None:
                copy = write_once.require_published_local(ctx.data_root, path, item.sha256)
                files[name] = (item.key, item.sha256, copy, item.sources)
            elif artifact not in released and (ctx.data_root / path).is_file():
                copy = ctx.data_root / path
                sources = build_data_release.sources_for(ctx.data_root, path)
                files[name] = (
                    dr.release_key(ctx.release, path),
                    build_data_release.sha256_of(copy),
                    copy,
                    sources,
                )
        missing = [name for name in (inferred.CELLS_FILE, meta.MANIFEST_FILE) if name not in files]
        if missing:
            raise TableError(f"{dr.ARTIFACT_PREFIX}{artifact}/ holds no {missing}")
        cells_key, cells_sha256, cells_path, cells_sources = files[inferred.CELLS_FILE]
        manifest_key, manifest_sha256, manifest_path, manifest_sources = files[meta.MANIFEST_FILE]
        observations_key, observations_sha256, *_ = files.get(ai.INPUT_FILE, (None, None))
        records.append(
            inferred.ArtifactRecord(
                artifact=artifact,
                manifest=_read_json(manifest_path)[1],
                cells_path=cells_path,
                cells_key=cells_key,
                cells_sha256=cells_sha256,
                manifest_key=manifest_key,
                manifest_sha256=manifest_sha256,
                observations_key=observations_key,
                observations_sha256=observations_sha256,
                first_release=manifest_key.split("/", 2)[1],
                sources=tuple(sorted({*cells_sources, *manifest_sources})),
            )
        )
    return tuple(records)


def build_inferred(
    ctx: BuildContext,
    *,
    web_json_matches: frozenset[str] = frozenset(),
    web_json_refused: Mapping[str, str] | None = None,
) -> dict[str, int]:
    """``inferred.cells_by_cell`` parts for the artifacts no earlier epoch holds, and ``inferred.artifacts``.

    Earlier epochs' parts are read, never rebuilt (call 6). Checks 1 and 2 run on every part, check 6 on
    every artifact against its ``cells.parquet``, and check 10 on every artifact's evidence.
    """
    records = artifact_records(ctx)
    con = writer.connect()
    earlier_parts = sorted(
        (path, item) for path, item in ctx.published.items() if path.startswith(f"{inferred.EPOCH_ROOT}/")
    )
    earlier_copies = []
    for path, item in earlier_parts:
        copy = write_once.require_published_local(ctx.data_root, path, item.sha256)
        writer.check_table_file(copy, inferred.CELLS_TABLE)
        writer.check_partitions(con, copy, path)
        earlier_copies.append(copy)
    earlier = inferred.earlier_epochs(con, earlier_copies)
    new = inferred.new_epoch_artifacts([record.artifact for record in records], earlier)
    written = inferred.write_epoch(
        con,
        [record for record in records if record.artifact in new],
        epoch=ctx.release,
        out_root=ctx.out_root,
        git_sha=ctx.git_sha,
        published=ctx.published,
    )
    for path in written:
        writer.check_partitions(con, ctx.out_root / path, path)
    inferred.check_cells_equal(con, records, [*earlier_copies, *(ctx.out_root / path for path in written)])
    evidence = {
        record.artifact: inferred.fit_input_evidence(
            record.artifact,
            has_input=record.observations_key is not None,
            released_without_input=build_data_release.RELEASED_WITHOUT_INPUT,
            web_json_matches=web_json_matches,
            web_json_refused=web_json_refused,
        )
        for record in records
    }
    epochs = {**earlier, **dict.fromkeys(new, ctx.release)}
    frame = inferred.artifacts_frame(records, epochs=epochs, evidence=evidence)
    inputs, new_sources = _inferred_inputs(ctx, records, earlier_parts)
    writer.write_frame(
        con,
        frame,
        ctx.out_root / contracts.table_path(inferred.ARTIFACTS_TABLE),
        table=inferred.ARTIFACTS_TABLE,
        git_sha=ctx.git_sha,
        inputs=inputs,
        sources=provenance.union_sources(inputs, manifests=_by_release(ctx), new_sources=new_sources),
        order_by=("artifact",),
    )
    rows = sum(int(record.manifest["n_cells"]) for record in records if record.artifact in new)
    by_res = Counter(int(path.split("/res=", 1)[1].split("/", 1)[0]) for path in written)
    print(f"{inferred.ARTIFACTS_TABLE}: {len(frame)} rows; {_evidence_summary(frame)}")
    parts = ", ".join(f"res {res}: {n}" for res, n in sorted(by_res.items()))
    print(
        f"{inferred.CELLS_TABLE} epoch={ctx.release}: {len(new)} artifacts, {rows:,} rows, "
        f"{len(written)} parts" + (f" ({parts})" if parts else "")
    )
    return {inferred.ARTIFACTS_TABLE: len(frame), inferred.CELLS_TABLE: rows}


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
    """The full sha of the commit ``value`` names in ``repo_root``; a full sha must name one too."""
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
    if not writer.GIT_SHA_PATTERN.fullmatch(resolved):
        raise TableError(f"--git-sha {value!r} resolves to {resolved!r}, not a 40-character commit sha")
    return resolved


def read_git_input(repo_root: Path, git_sha: str, path: str) -> bytes:
    """``path`` as commit ``git_sha`` holds it, refused unless the working tree's file is those bytes.

    A ``git:<path>`` input records the sha256 of the file at the stamped ``genomeos.git_sha`` (§2.7
    check 9). Reading the working tree alone would record an uncommitted edit, or a file the stamped
    commit does not hold, under a commit that never contained it.
    """
    try:
        committed = subprocess.run(
            ["git", "cat-file", "blob", f"{git_sha}:{path}"],
            cwd=repo_root,
            capture_output=True,
            check=True,
        ).stdout
    except OSError as error:
        raise TableError(f"{provenance.GIT_PREFIX}{path}: git cannot run: {error}") from error
    except subprocess.CalledProcessError as error:
        raise TableError(
            f"{provenance.GIT_PREFIX}{path}: commit {git_sha} holds no {path}; "
            "commit it, or pass the --git-sha that holds it"
        ) from error
    if (repo_root / path).read_bytes() != committed:
        raise TableError(
            f"{provenance.GIT_PREFIX}{path}: the working tree's {path} differs from commit {git_sha}; "
            "commit it, or pass the --git-sha that holds it"
        )
    return committed


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
        published=write_once.published_paths(manifests),
        repo_root=repo_root,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a release's derived tables/ files into data/.")
    parser.add_argument("--release", type=dr.assert_release_id, required=True, help="YYYY-MM-DD[.N]")
    parser.add_argument("--data", type=Path, default=DATA, help="the data/ tree (default: the checkout's)")
    parser.add_argument(
        "--git-sha", default="HEAD", help="the commit files record and read git: inputs at (default: HEAD)"
    )
    parser.add_argument("--stage", action="append", choices=tuple(_RUNNERS), help="repeatable; default: all")
    # Hidden, for tests: a releases/ folder of copies, and a web catalog and withdrawn list read as
    # they stand instead of at --git-sha.
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


def _run_reference(ctx: BuildContext, args: argparse.Namespace) -> None:
    build_reference(ctx)


def _run_inferred(ctx: BuildContext, args: argparse.Namespace) -> None:
    build_inferred(ctx)


#: The stages this checkout builds, each run from the parsed arguments; ``--stage`` takes only these.
_RUNNERS: dict[str, Callable[[BuildContext, argparse.Namespace], object]] = {
    "meta": _run_meta,
    "reference": _run_reference,
    "inferred": _run_inferred,
}


def _stage_input(ctx: BuildContext, path: str) -> tuple[InputRef, Path]:
    """``path`` as an input: under the key of the release that published it, read from a local copy with
    its published sha256; otherwise the local file, keyed under ``ctx.release``."""
    item = ctx.published.get(path)
    if item is not None:
        copy = write_once.require_published_local(ctx.data_root, path, item.sha256)
        return InputRef(item.key, item.sha256), copy
    local = ctx.data_root / dr.assert_data_path(path)
    if not local.is_file():
        harvest = next((found for found in rh.RAW_HARVESTS if path.startswith(f"{found.root}/")), None)
        hint = ""
        if harvest is not None and harvest.copied_from:
            hint = f"; copy it from {harvest.copied_from}/{path.rsplit('/', 1)[1]}"
        elif harvest is not None:
            hint = f"; fetch it: {harvest.fetch_command}"
        raise TableError(
            f"{path}: the build reads it, no release published it, and {ctx.data_root} lacks it" + hint
        )
    return InputRef(dr.release_key(ctx.release, path), build_data_release.sha256_of(local)), local


def _refuse_registry_strays(ctx: BuildContext, built: Mapping[str, object]) -> None:
    """Refuse any local file under the registry root that no release published and this build does not
    write: the release builder would publish it as a registry release."""
    root = ctx.out_root / contracts.REGISTRY_ROOT
    found = sorted(path.relative_to(ctx.out_root).as_posix() for path in root.rglob("*") if path.is_file())
    strays = [path for path in found if path not in built and path not in ctx.published]
    if strays:
        raise TableError(
            f"{strays[0]}: no release published it and this build does not write it ({len(strays)} such "
            f"file(s) under {contracts.REGISTRY_ROOT}); remove them and build again"
        )


def _inferred_inputs(
    ctx: BuildContext,
    records: Sequence[inferred.ArtifactRecord],
    earlier_parts: Sequence[tuple[str, dr.ReleaseObject]],
) -> tuple[tuple[InputRef, ...], dict[str, tuple[str, ...]]]:
    """``inferred.artifacts``' inputs: each artifact's files and the earlier parts its epochs come from;
    and the sources of each file this release adds (``provenance.sources_of``'s ``new_sources``)."""
    refs = [InputRef(item.key, item.sha256) for _, item in earlier_parts]
    new_sources: dict[str, tuple[str, ...]] = {}
    for record in records:
        files = list(record.cells_inputs)
        if record.observations_key is not None and record.observations_sha256 is not None:
            files.append(InputRef(record.observations_key, record.observations_sha256))
        refs.extend(files)
        if record.first_release == ctx.release:
            for ref in files:
                path = ref.key.split("/", 2)[2]
                new_sources[path] = build_data_release.sources_for(ctx.data_root, path)
    return tuple(sorted(refs)), new_sources


def _evidence_summary(frame: Any) -> str:
    """``fit_input_evidence <value> <n>, …; measurement <value> <n> (<k> from the reviewed table), …``."""
    evidence = Counter(frame["fit_input_evidence"])
    measured = Counter(zip(frame["measurement"], frame["measurement_from"], strict=True))
    found = ", ".join(f"{value} {evidence[value]}" for value in inferred.EVIDENCE if evidence[value])
    measurements = []
    for value in sorted({measurement for measurement, _ in measured}):
        reviewed = measured[(value, "reviewed_table")]
        total = reviewed + measured[(value, "manifest")]
        measurements.append(
            f"{value} {total}" + (f" ({reviewed} from the reviewed table)" if reviewed else "")
        )
    return f"fit_input_evidence {found}; measurement {', '.join(measurements)}"


def _by_release(ctx: BuildContext) -> dict[str, Mapping[str, Any]]:
    return {manifest["release"]: manifest for manifest in ctx.manifests}


def _git_json(ctx: BuildContext, path: str, override: Path | None) -> tuple[bytes, Any]:
    """The ``git:`` input ``path`` at ``ctx.git_sha``, or ``override`` as it stands (tests)."""
    if override is not None:
        return _read_json(override)
    return _parse_json(read_git_input(ctx.repo_root, ctx.git_sha, path), f"{provenance.GIT_PREFIX}{path}")


def _read_json(path: Path) -> tuple[bytes, Any]:
    return _parse_json(path.read_bytes(), path)


def _parse_json(payload: bytes, origin: object) -> tuple[bytes, Any]:
    try:
        return payload, json.loads(payload)
    except json.JSONDecodeError as error:
        raise TableError(f"{origin}: not JSON: {error}") from error


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
