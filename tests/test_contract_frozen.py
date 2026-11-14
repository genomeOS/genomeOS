import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from genomeos.publication.artifact_inputs import CONTRACT_REVISIONS
from genomeos.tables.contracts import TABLE_CONTRACTS, render
from scripts import freeze_contract

REPO = Path(__file__).resolve().parents[1]


def test_frozen_contract_matches_the_live_schemas():
    result = subprocess.run(
        [sys.executable, "scripts/freeze_contract.py", "--check"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_literature_contracts_and_observation_source_key_are_frozen():
    expected = {
        "literature_evidence.schema.json",
        "literature_field_evidence.schema.json",
        "literature_searches.schema.json",
    }
    assert expected.issubset({path.name for path in (REPO / "contract").glob("*.json")})
    observations = json.loads((REPO / "contract" / "observations.schema.json").read_text())
    assert "source_record_id" in observations["columns"]


def test_curated_variant_contracts_are_frozen():
    expected = {
        "curated_variants.schema.json",
        "cpic_pair_targets.schema.json",
        "cpic_coverage.schema.json",
    }
    assert expected.issubset({path.name for path in (REPO / "contract").glob("*.json")})


def test_each_frozen_file_is_its_rendered_contract():
    for table, contract in TABLE_CONTRACTS.items():
        assert (REPO / contract.path).read_text() == render(table), table


def test_the_fit_input_contracts_are_untouched():
    for path in ("contract/observations.schema.json", "contract/carrier_observations.schema.json"):
        assert hashlib.sha256((REPO / path).read_bytes()).hexdigest() in CONTRACT_REVISIONS[path]


def test_the_table_contracts_are_exactly_the_registered_ones():
    assert sorted(p.name for p in (REPO / "contract/tables").iterdir()) == sorted(
        Path(c.path).name for c in TABLE_CONTRACTS.values()
    )


def test_check_refuses_a_stray_table_contract(tmp_path, monkeypatch, capsys):
    shutil.copytree(REPO / "contract", tmp_path / "contract")
    (tmp_path / "contract/tables/measured.retired.v1.schema.json").write_text("{}\n")
    monkeypatch.setattr(freeze_contract, "CONTRACT_DIR", tmp_path / "contract")
    assert freeze_contract.main(["--check"]) == 1
    assert "measured.retired.v1.schema.json" in capsys.readouterr().err
