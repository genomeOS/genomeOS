"""The committed 2,000-cell mesh-parity subset of cyt-il-6-174-c (fast-load spec §B.1, §B.5).

The full canonical export left git (spec §C.1.3). Set ATLAS_DATA_DIR to a staging tree
(``encode_atlas_web.py --with-downloads``) or a bucket download plus the repository catalog to
rebuild the subset from it and compare the result byte for byte (§C.3).
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import h3
import pytest

from genomeos.publication import surface_codec as codec
from scripts import build_atlas_parity_subset as parity

ROOT = Path(__file__).resolve().parents[1]
COMMITTED = ROOT / "website" / "tests" / "fixtures" / "atlas" / "parity"


def _tree(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _cell(h3_index: str, support: str, post_sd: float = 0.05) -> dict:
    return {"h3_index": h3_index, "support": support, "post_mean": 0.1, "post_sd": post_sd}


def test_subset_refuses_a_parent_set_without_every_state_or_an_out_of_domain_value() -> None:
    children = sorted(h3.cell_to_children(parity.PARITY_PARENTS[0], 4))[:4]
    artifact = {"metric_domains": {"post_mean": [0.0, 0.5], "post_sd": [0.01, 0.1]}}
    three_states = [
        _cell(children[0], "observed"),
        _cell(children[1], "interpolated"),
        _cell(children[2], "unknown"),
    ]
    with pytest.raises(ValueError, match="all four support states"):
        parity.subset_cells({"artifact": artifact, "cells": three_states})
    in_domain = [*three_states, _cell(children[3], "prior_dominated")]
    with pytest.raises(ValueError, match="outside metric_domains"):
        parity.subset_cells({"artifact": artifact, "cells": in_domain})
    out_of_domain = [*three_states, _cell(children[3], "prior_dominated", post_sd=0.2)]
    assert len(parity.subset_cells({"artifact": artifact, "cells": out_of_domain})) == 4


def test_committed_subset_is_the_named_parents_and_holds_every_case_parity_needs() -> None:
    catalog = json.loads((COMMITTED / "catalog.json").read_text())
    (ref,) = catalog["artifacts"]
    surface_bytes = (COMMITTED / ref["surface_url"]).read_bytes()
    assert hashlib.sha256(surface_bytes).hexdigest() == ref["surface_sha256"]
    cells = json.loads(surface_bytes)["cells"]
    assert ref["id"] == parity.ARTIFACT_ID and ref["n_cells"] == len(cells) == 1986
    assert ref["support_counts"] == {
        "interpolated": 1448,
        "observed": 6,
        "prior_dominated": 178,
        "unknown": 354,
    }
    assert {h3.cell_to_parent(cell["h3_index"], 1) for cell in cells} == set(parity.PARITY_PARENTS)
    indices = [int(cell["h3_index"], 16) for cell in cells]
    assert indices == sorted(indices)
    low, high = ref["metric_domains"]["post_sd"]
    assert sum(not low <= cell["post_sd"] <= high for cell in cells) == 46
    crossing = [
        cell
        for cell in cells
        if (lambda lons: max(lons) - min(lons) > 180)([p[1] for p in h3.cell_to_boundary(cell["h3_index"])])
    ]
    assert len(crossing) == 15  # cells whose own boundary crosses ±180°
    ((grid_sha, entry),) = catalog["grids"].items()
    grid = codec.verify_container(
        (COMMITTED / entry["url"]).read_bytes(), tier="grid", sha256=entry["sha256"], size=entry["bytes"]
    )
    assert grid.columns["h3"] == tuple(indices)
    tiers = {
        tier: codec.verify_container(
            (COMMITTED / ref["web"][tier]["url"]).read_bytes(),
            tier=tier,
            sha256=ref["web"][tier]["sha256"],
            size=ref["web"][tier]["bytes"],
        )
        for tier in ("render", "detail")
    }
    codec.verify_artifact_tiers(grid=grid, ref=ref, grid_sha256=grid_sha, **tiers)


@pytest.mark.skipif(
    not os.environ.get("ATLAS_DATA_DIR"), reason="set ATLAS_DATA_DIR to a staging tree or bucket download"
)
def test_script_reproduces_the_committed_subset(tmp_path: Path) -> None:
    parity.build_subset(Path(os.environ["ATLAS_DATA_DIR"]), tmp_path / "parity")
    assert _tree(tmp_path / "parity") == _tree(COMMITTED)


def _synthetic_source(source: Path) -> Path:
    """A 4-cell source tree that ``subset_cells`` accepts, with its catalog naming each file's sha256."""
    children = sorted(h3.cell_to_children(parity.PARITY_PARENTS[0], 4))[:4]
    states = ("observed", "interpolated", "prior_dominated", "unknown")
    cells = [_cell(child, state, post_sd=0.2) for child, state in zip(children, states, strict=True)]
    artifact = {"metric_domains": {"post_mean": [0.0, 0.5], "post_sd": [0.01, 0.1]}}
    surface = json.dumps({"artifact": artifact, "cells": cells}).encode()
    manifest = b"{}"
    source.mkdir()
    (source / "surface.json").write_bytes(surface)
    (source / "manifest.json").write_bytes(manifest)
    ref = {
        "downloads": {"manifest": {"sha256": hashlib.sha256(manifest).hexdigest(), "url": "manifest.json"}},
        "id": parity.ARTIFACT_ID,
        "surface_sha256": hashlib.sha256(surface).hexdigest(),
        "surface_url": "surface.json",
    }
    (source / "catalog.json").write_text(json.dumps({"artifacts": [ref]}))
    return source


def test_refuses_an_out_that_is_its_own_source(tmp_path: Path) -> None:
    source = _synthetic_source(tmp_path / "src")
    before = _tree(source)
    with pytest.raises(ValueError, match="overlaps its source"):
        parity.build_subset(source, source)
    assert _tree(source) == before


@pytest.mark.parametrize("key", ["surface.json", "manifest.json"])
def test_refuses_a_source_file_that_does_not_match_the_source_catalog(tmp_path: Path, key: str) -> None:
    source = _synthetic_source(tmp_path / "src")
    (source / key).write_bytes((source / key).read_bytes() + b" ")
    out = tmp_path / "out"
    with pytest.raises(ValueError, match=f"{key}: sha256 does not match the catalog"):
        parity.build_subset(source, out)
    assert not out.exists()


def test_writes_the_manifest_at_its_flat_key_whatever_the_source_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A staging tree or bucket download names the manifest by its ``downloads/`` key (spec §C.1.3)."""
    source = _synthetic_source(tmp_path / "src")
    nested = f"downloads/{parity.ARTIFACT_ID}/v3/data/{parity.ARTIFACT_ID}.manifest.44136fa355b3678a.json"
    (source / nested).parent.mkdir(parents=True)
    (source / "manifest.json").rename(source / nested)
    catalog = json.loads((source / "catalog.json").read_text())
    (ref,) = catalog["artifacts"]
    ref["downloads"]["manifest"]["url"] = nested
    ref["downloads"]["surface"] = {"sha256": ref["surface_sha256"], "url": ref["surface_url"]}
    (source / "catalog.json").write_text(json.dumps(catalog))
    # The synthetic catalog has no grid to encode; the written catalog is the subject here.
    monkeypatch.setattr(
        parity.encode_atlas_web,
        "encode_export",
        lambda _in, out: json.loads((out / "catalog.json").read_bytes()),
    )
    out = tmp_path / "out"
    written = parity.build_subset(source, out)
    flat = f"{parity.ARTIFACT_ID}.manifest.json"
    assert sorted(_tree(out)) == ["catalog.json", flat, f"{parity.ARTIFACT_ID}.surface.json"]
    assert (out / flat).read_bytes() == b"{}"
    assert written["artifacts"][0]["downloads"]["manifest"] == {
        "sha256": hashlib.sha256(b"{}").hexdigest(),
        "url": flat,
    }
