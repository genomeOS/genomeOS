"""Tests for scripts/encode_natural_earth_borders.py (fast-load spec §B.10; issue #445)."""

from __future__ import annotations

import copy
import gzip
import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from scripts import encode_natural_earth_borders as borders

ROOT = Path(__file__).resolve().parents[1]
#: Mean Earth radius, as in genomeos.geo.h3util.
EARTH_RADIUS_KM = 6371.0088


def _square(x: float, y: float, size: float = 1.0) -> list[list[float]]:
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]


def _feature(geometry: Any, **properties: Any) -> dict[str, Any]:
    return {"geometry": geometry, "properties": properties, "type": "Feature"}


def _collection(*features: dict[str, Any]) -> dict[str, Any]:
    return {"features": list(features), "type": "FeatureCollection"}


def _polygon(*rings: list[list[float]]) -> dict[str, Any]:
    return {"coordinates": list(rings), "type": "Polygon"}


#: Two squares sharing the edge x = 1 (traced in opposite directions), one with a hole, plus a
#: two-part country, a label point and the two name fallbacks.
SAMPLE = _collection(
    _feature(
        _polygon(
            _square(0.12345, 0.0),
            [[0.3, 0.3], [0.3, 0.6], [0.6, 0.6], [0.6, 0.3], [0.3, 0.3]],
        ),
        ADMIN="Alpha",
        LABEL_X=0.5,
        LABEL_Y=0.5,
        MIN_LABEL=3,
        NAME="Alpha",
        NAME_LONG="Alpha Republic",
        POP_EST=12,
    ),
    _feature(
        _polygon([[1.12345, 0.0], [1.12345, 1.0], [2.0, 1.0], [2.0, 0.0], [1.12345, 0.0]]),
        ADMIN="Beta",
        LABEL_X=1.5,
        LABEL_Y=0.5,
        MIN_LABEL=4.5,
        NAME="Beta",
        NAME_LONG="",
    ),
    _feature(
        {"coordinates": [[_square(10.0, 10.0)], [_square(-20.0, -10.0, 0.5)]], "type": "MultiPolygon"},
        LABEL_X=10.5,
        LABEL_Y=10.5,
        NAME="Gamma",
    ),
)
SOURCE = {"revision": "f" * 40, "sha256": "0" * 64, "url": "https://example.org/ne.geojson"}


def _encode(collection: dict[str, Any] = SAMPLE, quantization: int = borders.QUANTIZATION) -> bytes:
    return borders.encode(collection, quantization=quantization, source=SOURCE)


def _polygons(feature: dict[str, Any]) -> list[Any]:
    geometry = feature["geometry"]
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]


def _quantized_rings(collection: dict[str, Any], quantization: int) -> list[list[list[list[int]]]]:
    """Every feature's polygons, rings rounded half-to-even onto the lattice, closing vertex kept."""
    out = []
    for feature in collection["features"]:
        polygons = _polygons(feature)
        out.append(
            [
                [
                    np.rint(np.asarray(ring, dtype=np.float64) * quantization).astype(int).tolist()
                    for ring in p
                ]
                for p in polygons
            ]
        )
    return out


def _repack(data: bytes, header: dict[str, Any] | None = None, payload: bytes | None = None) -> bytes:
    """``data`` with its header JSON or coordinate payload replaced, lengths and padding redone."""
    decoded = borders.read_container(data)
    header_bytes = borders.canonical_json(decoded.header if header is None else header)
    body = decoded.payload if payload is None else payload
    padding = b"\x00" * (-(12 + len(header_bytes)) % 4)
    return b"GOBD" + struct.pack("<HHI", 1, 0, len(header_bytes)) + header_bytes + padding + body


def test_round_trip_reproduces_every_ring_on_the_lattice_and_keeps_only_the_label_properties() -> None:
    decoded = borders.decode(_encode())
    assert [feature.polygons for feature in decoded.features] == _quantized_rings(
        SAMPLE, borders.QUANTIZATION
    )
    assert decoded.features[0].properties == {
        "ADMIN": "Alpha",
        "LABEL_X": 0.5,
        "LABEL_Y": 0.5,
        "MIN_LABEL": 3,
        "NAME": "Alpha",
        "NAME_LONG": "Alpha Republic",
    }
    assert decoded.features[2].properties == {"LABEL_X": 10.5, "LABEL_Y": 10.5, "NAME": "Gamma"}
    assert decoded.header["quantization"] == borders.QUANTIZATION
    assert decoded.header["source"] == SOURCE


def test_rounding_moves_a_position_by_at_most_half_a_lattice_step() -> None:
    decoded = borders.decode(_encode())
    errors = [
        abs(value / borders.QUANTIZATION - source)
        for feature, out in zip(SAMPLE["features"], decoded.features, strict=True)
        for polygon, out_polygon in zip(_polygons(feature), out.polygons, strict=True)
        for ring, out_ring in zip(polygon, out_polygon, strict=True)
        for position, out_position in zip(ring, out_ring, strict=True)
        for source, value in zip(position, out_position, strict=True)
    ]
    # 0.12345 and 1.12345 lie between lattice points; every other coordinate is on one.
    assert 0 < max(errors) <= borders.MAX_ERROR_DEGREES + 1e-12


def test_a_border_two_rings_share_is_stored_once() -> None:
    shared = _collection(
        _feature(_polygon(_square(0.0, 0.0)), NAME="West"),
        # Counter-clockwise like West, so it walks the shared edge x = 1 downwards.
        _feature(_polygon([[1.0, 0.0], [2.0, 0.0], [2.0, 1.0], [1.0, 1.0], [1.0, 0.0]]), NAME="East"),
    )
    decoded = borders.decode(_encode(shared))
    payload = borders.read_container(_encode(shared)).payload
    count = len(payload) // 4
    zigzag = [int.from_bytes(payload[i::count][:4], "little") for i in range(count)]
    deltas = np.asarray([(z >> 1) ^ -(z & 1) for z in zigzag]).reshape(-1, 2)
    points = np.cumsum(deltas, axis=0)
    starts = np.cumsum([0, *decoded.header["arcs"]])
    arcs = [points[a:b].tolist() for a, b in zip(starts[:-1], starts[1:], strict=True)]
    edge = sorted([[10_000, 0], [10_000, 10_000]])
    assert sum(sorted(arc[i : i + 2]) == edge for arc in arcs for i in range(len(arc) - 1)) == 1
    assert [f.polygons for f in decoded.features] == _quantized_rings(shared, borders.QUANTIZATION)
    # One ring walks the shared edge forwards and the other walks the same arc reversed.
    west, east = (f["polygons"][0][0] for f in decoded.header["features"])
    assert {ref for ref in west if ref >= 0} & {~ref for ref in east if ref < 0}


def test_encoding_is_byte_deterministic() -> None:
    assert _encode() == _encode(copy.deepcopy(SAMPLE))


def test_container_layout_is_magic_version_header_padding_then_shuffled_deltas() -> None:
    data = _encode()
    assert data[:4] == b"GOBD"
    version, reserved, header_length = struct.unpack_from("<HHI", data, 4)
    assert (version, reserved) == (1, 0)
    header = json.loads(data[12 : 12 + header_length])
    start = 12 + header_length + (-(12 + header_length) % 4)
    assert len(data) == start + 8 * sum(header["arcs"])
    assert set(header) == {"arcs", "features", "quantization", "source"}


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda c: c.update(type="Feature"), "FeatureCollection"),
        (lambda c: c["features"].append({"type": "Feature", "properties": {}}), "feature 3 geometry"),
        (lambda c: c["features"][0].update(geometry=None), "feature 0 geometry"),
        (lambda c: c["features"][0].update(properties=[]), "feature 0 properties"),
        (
            lambda c: c["features"][0].update(
                geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]}
            ),
            "unsupported geometry type",
        ),
        (lambda c: c["features"][0]["geometry"].update(coordinates=[]), "feature 0 has no polygon"),
        (lambda c: c["features"][2]["geometry"]["coordinates"].append([]), "feature 2 polygon 2 has no ring"),
        (
            lambda c: c["features"][0]["geometry"]["coordinates"][0].pop(),
            "feature 0 polygon 0 ring 0 is not closed",
        ),
        (
            lambda c: c["features"][0]["geometry"].update(coordinates=[[[0, 0], [1, 0], [0, 0]]]),
            "fewer than four positions",
        ),
        (
            lambda c: c["features"][0]["geometry"]["coordinates"][1].__setitem__(1, [0.3, "x"]),
            "ring 1 has a position that is not two finite numbers",
        ),
        (
            lambda c: c["features"][0]["geometry"]["coordinates"][0].__setitem__(1, [1.1, 0.0, 5.0]),
            "not two finite numbers",
        ),
        (
            lambda c: c["features"][0]["geometry"]["coordinates"][0].__setitem__(1, [181.0, 0.0]),
            "outside WGS84",
        ),
        (lambda c: c["features"][1]["properties"].update(NAME=7), "feature 1 property NAME"),
        (lambda c: c["features"][1]["properties"].update(LABEL_X="1.5"), "feature 1 property LABEL_X"),
        (lambda c: c["features"][1]["properties"].update(MIN_LABEL=True), "feature 1 property MIN_LABEL"),
        (lambda c: c["features"][1]["properties"].update(LABEL_Y=math.nan), "feature 1 property LABEL_Y"),
    ],
)
def test_malformed_sources_are_refused_naming_the_feature(mutate: Any, message: str) -> None:
    collection = copy.deepcopy(SAMPLE)
    mutate(collection)
    with pytest.raises(ValueError, match=message):
        _encode(collection)


def test_a_quantization_that_cannot_hold_the_globe_is_refused() -> None:
    with pytest.raises(ValueError, match="quantization"):
        _encode(quantization=0)
    with pytest.raises(ValueError, match="quantization"):
        _encode(quantization=borders.MAX_QUANTIZATION + 1)


def _header(data: bytes) -> dict[str, Any]:
    return copy.deepcopy(borders.read_container(data).header)


def _with_header(change: Any) -> bytes:
    data = _encode()
    header = _header(data)
    change(header)
    return _repack(data, header=header)


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (lambda d: b"GOSA" + d[4:], "magic"),
        (lambda d: d[:4] + struct.pack("<H", 2) + d[6:], "format_version"),
        (lambda d: d[:6] + struct.pack("<H", 1) + d[8:], "reserved"),
        (lambda d: d[:8] + struct.pack("<I", len(d)) + d[12:], "header"),
        (lambda d: d + b"\x00", "length"),
        (lambda d: d[:-1], "length"),
        (lambda d: d[:11], "shorter"),
        (lambda d: d[:12] + b"\xff" + d[13:], "header"),
        (lambda d: _with_header(lambda h: h.update(extra=1)), "header keys"),
        (lambda d: _with_header(lambda h: h.update(quantization=0)), "quantization"),
        (lambda d: _with_header(lambda h: h.update(quantization=1.5)), "quantization"),
        (lambda d: _with_header(lambda h: h["arcs"].__setitem__(0, 1)), "arc"),
        (lambda d: _with_header(lambda h: h["features"][0]["polygons"][0][0].__setitem__(0, 999)), "arc"),
        (lambda d: _with_header(lambda h: h["features"][0]["polygons"][0][0].__setitem__(0, True)), "arc"),
        (lambda d: _with_header(lambda h: h["features"][0]["properties"].update(POP_EST=1)), "propert"),
        (lambda d: _with_header(lambda h: h["features"][0]["properties"].update(NAME=None)), "propert"),
        (lambda d: _with_header(lambda h: h["features"][0].update(polygons=[])), "polygon"),
        (lambda d: _with_header(lambda h: h["features"][0]["polygons"][0].append([])), "ring"),
        (lambda d: _with_header(lambda h: h["source"].update(sha256="x")), "source"),
    ],
)
def test_the_decoder_refuses_malformed_containers(data: Any, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        borders.decode(data(_encode()))


def test_the_decoder_refuses_a_non_zero_padding_byte() -> None:
    data = bytearray(_encode())
    header_length = struct.unpack_from("<I", data, 8)[0]
    if (12 + header_length) % 4 == 0:
        pytest.skip("this header needs no padding")
    data[12 + header_length] = 1
    with pytest.raises(ValueError, match="padding"):
        borders.decode(bytes(data))


def test_the_decoder_refuses_rings_that_do_not_close_or_arcs_that_do_not_meet() -> None:
    data = _encode()
    header = _header(data)
    alpha = header["features"][0]["polygons"][0][0]
    # Alpha's outer ring starts with its south edge; its second arc is the edge Beta shares.
    assert len(alpha) == 3
    header["features"][0]["polygons"][0][0] = [alpha[0], alpha[2], alpha[1]]
    with pytest.raises(ValueError, match="ring 0 arc 1 does not start where arc 0 ends"):
        borders.decode(_repack(data, header=header))
    hole = header["features"][0]["polygons"][0][1]
    # Every arc stays referenced, so the first failure is the ring that stops short of its start.
    header["features"][0]["polygons"][0] = [alpha[:2], hole, alpha[2:]]
    with pytest.raises(ValueError, match="ring 0 is not closed"):
        borders.decode(_repack(data, header=header))


def test_the_decoder_refuses_an_unreferenced_arc_and_coordinates_off_the_globe() -> None:
    data = _encode()
    header = _header(data)
    header["arcs"].append(2)
    with pytest.raises(ValueError, match="never referenced"):
        borders.decode(_repack(data, header=header, payload=borders.read_container(data).payload + bytes(16)))
    payload = bytearray(borders.read_container(data).payload)
    # The first x delta's byte plane 2: +2**17 lattice steps puts it past 180 degrees at 1e4.
    count = len(payload) // 4
    payload[2 * count] = 0xFF
    with pytest.raises(ValueError, match="outside"):
        borders.decode(_repack(data, payload=bytes(payload)))


def test_reading_the_source_verifies_its_digest(tmp_path: Path) -> None:
    path = tmp_path / "ne.geojson"
    path.write_bytes(b'{"type": "FeatureCollection", "features": []}')
    with pytest.raises(ValueError, match="sha256"):
        borders.read_source(path, sha256="0" * 64)
    assert borders.read_source(path, sha256=hashlib.sha256(path.read_bytes()).hexdigest())["features"] == []


# The committed source and output (issue #445).


def _committed() -> tuple[dict[str, Any], bytes]:
    source = borders.read_source(borders.SOURCE_PATH)
    return source, borders.OUTPUT_PATH.read_bytes()


def test_the_committed_borders_are_the_encoding_of_the_pinned_source() -> None:
    source, committed = _committed()
    assert borders.SOURCE_PATH == ROOT / "reference" / "ne_50m_admin_0_countries.geojson"
    assert borders.OUTPUT_PATH == ROOT / "website" / "public" / "data" / "atlas" / borders.OUTPUT_KEY
    assert borders.encode_source(source) == committed
    assert borders.read_container(committed).header["source"] == {
        "revision": borders.SOURCE_REVISION,
        "sha256": borders.SOURCE_SHA256,
        "url": borders.SOURCE_URL,
    }


def test_the_site_ships_the_compact_borders_and_not_the_geojson() -> None:
    public = ROOT / "website" / "public" / "data" / "atlas"
    assert not (public / "ne-50m-admin-0.geojson").exists()
    catalog = json.loads((public / "catalog.json").read_text())
    assert catalog["context_sources"][0]["url"] == borders.OUTPUT_KEY


def test_the_committed_borders_are_several_times_smaller_over_gzip() -> None:
    source_gzip = len(gzip.compress(borders.SOURCE_PATH.read_bytes(), mtime=0))
    compact_gzip = len(gzip.compress(borders.OUTPUT_PATH.read_bytes(), mtime=0))
    assert compact_gzip * 3 < source_gzip


def _haversine_km(lon1: np.ndarray, lat1: np.ndarray, lon2: np.ndarray, lat2: np.ndarray) -> np.ndarray:
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.minimum(1.0, a)))


def test_every_committed_position_is_within_the_stated_error_bound() -> None:
    source, committed = _committed()
    decoded = borders.decode(committed)
    quantization = decoded.header["quantization"]
    assert quantization == borders.QUANTIZATION == 10_000
    lon_lat = []
    for feature, out in zip(source["features"], decoded.features, strict=True):
        polygons = _polygons(feature)
        assert [len(p) for p in polygons] == [len(p) for p in out.polygons]
        for polygon, decoded_polygon in zip(polygons, out.polygons, strict=True):
            for ring, decoded_ring in zip(polygon, decoded_polygon, strict=True):
                assert len(ring) == len(decoded_ring)
                lon_lat.append(np.hstack([np.asarray(ring), np.asarray(decoded_ring) / quantization]))
    positions = np.vstack(lon_lat)
    assert len(positions) == 99_613
    error_deg = np.abs(positions[:, :2] - positions[:, 2:])
    # Half a lattice step per axis (the stated bound), and the measured worst case on the ground.
    assert error_deg.max() <= borders.MAX_ERROR_DEGREES + 1e-12
    distance_m = 1_000 * _haversine_km(positions[:, 0], positions[:, 1], positions[:, 2], positions[:, 3])
    assert distance_m.max() <= borders.MAX_ERROR_METRES
    assert distance_m.max() > 0.95 * borders.MAX_ERROR_METRES


def test_check_mode_passes_on_the_committed_file_and_fails_on_a_stale_one(tmp_path: Path) -> None:
    assert borders.main(["--check"]) == 0
    stale = tmp_path / "stale.bin"
    stale.write_bytes(borders.OUTPUT_PATH.read_bytes()[:-8])
    assert borders.main(["--check", "--out", str(stale)]) == 1


def test_the_cli_writes_the_encoding_atomically(tmp_path: Path) -> None:
    out = tmp_path / "borders.bin"
    assert borders.main(["--out", str(out)]) == 0
    assert out.read_bytes() == borders.OUTPUT_PATH.read_bytes()
    assert [path.name for path in tmp_path.iterdir()] == ["borders.bin"]
