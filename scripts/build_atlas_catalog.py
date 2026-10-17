#!/usr/bin/env python3
"""CLI for building the P4 serving catalog from published P2 surfaces (design §5, §6, §10).

The published surfaces live in the public data store, not in git (data store design 2026-10-17 §6).
A ``--source`` under ``data/`` is resolved through ``scripts/fetch_data.py``: every released artifact
under it is fetched and sha256-verified first, so a fresh clone builds the same catalog as the machine
that published them, from the committed public URL with no credentials.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from genomeos.artifacts.build import build_catalog  # noqa: E402
from scripts.fetch_data import DATA, FetchError, require_local  # noqa: E402


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DATA / "store" / "artifacts")
    parser.add_argument("--metadata", type=Path, default=DATA / "store" / "catalog-metadata.json")
    parser.add_argument("--out", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        source = require_local(arguments.source)
    except FetchError as error:
        raise SystemExit(f"error: {error}") from error
    path = build_catalog(source, arguments.metadata, arguments.out)
    print(f"wrote immutable Atlas serving catalog: {path}")


if __name__ == "__main__":
    main()
