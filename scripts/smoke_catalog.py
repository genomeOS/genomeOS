#!/usr/bin/env python3
"""The parity smoke on a release's catalog, as an anonymous reader runs it.

Atlas data platform design 2026-10-18 §2.7 check 8; builder's call 3.

    python scripts/smoke_catalog.py --release 2026-11-20
    python scripts/smoke_catalog.py --catalog data/catalog/atlas.duckdb --local data/

``--release`` attaches the release's published ``catalog/atlas.duckdb`` read-only over HTTPS, with no
credentials, from the committed data-store URL (``GENOMEOS_DATA_BASE_URL`` may name only a loopback
mirror), and requires its ``meta.release`` to be that release before it reads a file. ``--catalog`` with
``--local`` attaches a local catalog and reads the local copies under ``--local`` instead.

Either way it counts ``evidence.parity_observations``, the 994 MAP HbS surveys of the 2026-09-16 parity
run: all rows, and the rows whose sampling disc reaches within ``DISC_KM`` of Lagos (great-circle distance
at most ``DISC_KM`` plus the row's ``radius_km``). It prints ``parity smoke: golden`` when every count is
``GOLDEN``'s, and otherwise each differing count, exiting 1. Counts and sums are exact integers.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.publication import data_release as dr  # noqa: E402
from genomeos.tables import catalog  # noqa: E402

#: The parity file's counts, verified 2026-11-14 on its sha256 466034e2… (§2.7 check 8).
GOLDEN = {
    "rows": 994,
    "sum_an": 11_359_130,
    "sum_ac": 175_878,
    "disc_rows": 40,
    "disc_sum_an": 52_340,
    "disc_sum_ac": 6_459,
}
LAGOS = (6.5244, 3.3792)
DISC_KM = 500
EARTH_RADIUS_KM = 6371.0088
#: The haversine distance from Lagos, within ``DISC_KM`` plus the row's sampling radius.
_DISC = (
    f"2 * {EARTH_RADIUS_KM} * asin(sqrt(sin(radians(lat - {LAGOS[0]}) / 2)^2 + cos(radians({LAGOS[0]})) "
    f"* cos(radians(lat)) * sin(radians(lon - {LAGOS[1]}) / 2)^2)) <= {DISC_KM} + radius_km"
)


def catalog_url(release: str, base: str | None = None) -> str:
    """The public URL of release ``release``'s ``atlas.duckdb`` (``base``: a loopback mirror, or none)."""
    return dr.public_url(dr.resolve_base_url(base), dr.release_key(release, catalog.CATALOG_DB))


def parity_counts(con: duckdb.DuckDBPyConnection, *, alias: str = "atlas") -> dict[str, int]:
    """``GOLDEN``'s counts over ``<alias>.evidence.parity_observations``."""
    row = con.execute(
        f"SELECT count(*), coalesce(sum(an), 0), coalesce(sum(ac), 0), count(*) FILTER (WHERE {_DISC}), "
        f"coalesce(sum(an) FILTER (WHERE {_DISC}), 0), coalesce(sum(ac) FILTER (WHERE {_DISC}), 0) "
        f"FROM {alias}.{catalog.PARITY_TABLE}"
    ).fetchone()
    assert row is not None
    return dict(zip(GOLDEN, (int(value) for value in row), strict=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="The parity smoke on a release's catalog (check 8).")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--release", type=dr.assert_release_id, help="attach the published catalog")
    source.add_argument("--catalog", type=Path, help="attach this local atlas.duckdb (with --local)")
    parser.add_argument("--local", type=Path, help="the local data/ folder the catalog reads")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if (args.catalog is None) != (args.local is None):
        parser.error("--catalog and --local go together")
    con = duckdb.connect()
    try:
        if args.release is not None:
            _attach(con, catalog_url(args.release, os.environ.get(dr.BASE_URL_VARIABLE)))
            row = con.execute(f"SELECT release FROM atlas.{catalog.RELEASE_VIEW}").fetchone()
            found = row[0] if row else None
            if found != args.release:
                print(f"error: the catalog of release {args.release} names release {found}", file=sys.stderr)
                return 1
        else:
            con.execute("SET VARIABLE genomeos_local = ?", [str(args.local)])
            _attach(con, str(args.catalog))
        counts = parity_counts(con)
    except (duckdb.Error, dr.DataReleaseError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    differing = [name for name, expected in GOLDEN.items() if counts[name] != expected]
    for name in differing:
        print(f"parity smoke: {name} {counts[name]}, expected {GOLDEN[name]}", file=sys.stderr)
    if differing:
        return 1
    print("parity smoke: golden")
    return 0


def _attach(con: duckdb.DuckDBPyConnection, location: str) -> None:
    quoted = location.replace("'", "''")
    con.execute(f"ATTACH '{quoted}' AS atlas (READ_ONLY)")


if __name__ == "__main__":
    raise SystemExit(main())
