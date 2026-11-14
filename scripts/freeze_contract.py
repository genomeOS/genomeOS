"""Freeze the pandera schemas to JSON in contract/ so schema drift appears in diffs.

Plan 3's TypeScript client validates against these files, so a change to a schema must show up
as a reviewable diff rather than as a silent break for downstream consumers.

Every derived table's contract (``genomeos.tables.contracts.TABLE_CONTRACTS``) is frozen under
``contract/tables/`` (Atlas data platform design 2026-10-18 §2.4, §2.5). A file there that no
registered contract renders fails both modes, and is never deleted for you: a contract nothing is
checked against must not stay looking authoritative.

    python scripts/freeze_contract.py            # write
    python scripts/freeze_contract.py --check    # CI: fail if stale
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path, PurePosixPath

from genomeos.artifacts import ArtifactManifest
from genomeos.observations.evidence import (
    LITERATURE_EVIDENCE_SCHEMA,
    LITERATURE_FIELD_EVIDENCE_SCHEMA,
    LITERATURE_SEARCHES_SCHEMA,
)
from genomeos.observations.schema import (
    CARRIER_OBSERVATIONS_SCHEMA,
    OBSERVATIONS_SCHEMA,
)
from genomeos.registry.curated import (
    CPIC_COVERAGE_SCHEMA,
    CPIC_PAIR_TARGETS_SCHEMA,
    CURATED_VARIANTS_SCHEMA,
)
from genomeos.registry.schema import ALIASES_SCHEMA, POPULATIONS_SCHEMA
from genomeos.registry.variants import VARIANT_NORMALIZATION_SCHEMA
from genomeos.tables.contracts import TABLE_CONTRACTS, render

CONTRACT_DIR = Path(__file__).resolve().parents[1] / "contract"
#: The table contracts' folder, relative to CONTRACT_DIR.
TABLES = "tables"
PANDERA_SCHEMAS = {
    "populations.schema.json": POPULATIONS_SCHEMA,
    "population_aliases.schema.json": ALIASES_SCHEMA,
    "variant_normalization.schema.json": VARIANT_NORMALIZATION_SCHEMA,
    "curated_variants.schema.json": CURATED_VARIANTS_SCHEMA,
    "cpic_pair_targets.schema.json": CPIC_PAIR_TARGETS_SCHEMA,
    "cpic_coverage.schema.json": CPIC_COVERAGE_SCHEMA,
    "observations.schema.json": OBSERVATIONS_SCHEMA,
    "carrier_observations.schema.json": CARRIER_OBSERVATIONS_SCHEMA,
    "literature_evidence.schema.json": LITERATURE_EVIDENCE_SCHEMA,
    "literature_field_evidence.schema.json": LITERATURE_FIELD_EVIDENCE_SCHEMA,
    "literature_searches.schema.json": LITERATURE_SEARCHES_SCHEMA,
}
JSON_SCHEMAS = {
    "atlas_catalog.schema.json": ArtifactManifest.model_json_schema(),
}


def _serialise(schema) -> str:
    return json.dumps(json.loads(schema.to_json()), indent=2, sort_keys=True) + "\n"


def _serialise_json_schema(schema: dict) -> str:
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def _table_contracts() -> dict[str, str]:
    """Each table contract's text, keyed by its path relative to CONTRACT_DIR."""
    return {
        PurePosixPath(contract.path).relative_to("contract").as_posix(): render(table)
        for table, contract in TABLE_CONTRACTS.items()
    }


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)

    (CONTRACT_DIR / TABLES).mkdir(parents=True, exist_ok=True)
    stale = []
    rendered = {
        **{name: _serialise(schema) for name, schema in PANDERA_SCHEMAS.items()},
        **{name: _serialise_json_schema(schema) for name, schema in JSON_SCHEMAS.items()},
        **_table_contracts(),
    }
    for name, text in rendered.items():
        path = CONTRACT_DIR / name
        if args.check:
            if not path.exists() or path.read_text() != text:
                stale.append(name)
        else:
            path.write_text(text)

    stray = sorted(
        f"{TABLES}/{path.name}"
        for path in (CONTRACT_DIR / TABLES).iterdir()
        if f"{TABLES}/{path.name}" not in rendered
    )
    if stray:
        print(
            f"contract has files no table contract renders: {stray}\n"
            "remove them, or register their table in genomeos/tables/contracts.py",
            file=sys.stderr,
        )
    if stale:
        print(
            f"contract is stale: {stale}\nrun: python scripts/freeze_contract.py",
            file=sys.stderr,
        )
    if stale or stray:
        return 1
    print("contract up to date" if args.check else f"wrote {len(rendered)} schemas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
