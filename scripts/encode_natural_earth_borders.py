#!/usr/bin/env python3
"""Encode the Natural Earth country borders into the compact GOBD file the Atlas draws (Atlas
design §11; fast-load spec §B.6.9, §B.10; issue #445).

The site used to ship the upstream 1:50m admin-0 GeoJSON (3.08 MB, 1.03 MB gzip). This script
reads that file, pinned at ``SOURCE_REVISION`` and kept outside the site as
``reference/ne_50m_admin_0_countries.geojson``, refuses it unless its sha256 is
``SOURCE_SHA256``, and writes ``website/public/data/atlas/ne-50m-admin-0.borders.bin``:

- every position rounded half-to-even onto a 10⁻⁴-degree lattice (``QUANTIZATION``);
- each border two rings share stored once, as one arc that both rings reference, one of them
  reversed (TopoJSON's arcs, without its JSON);
- arc vertices as zigzag-coded u32 lattice deltas, byte-shuffled so gzip sees each byte plane;
- of the 168 upstream properties, only the six the overlay reads (``KEPT_PROPERTIES``).

**Error bound.** A decoded coordinate is the source coordinate rounded to the lattice, so it is
within half a step, ``MAX_ERROR_DEGREES`` = 0.00005°, of the source on each axis. On the ground
that is at most 7.86 m (at the equator), stated as ``MAX_ERROR_METRES`` = 7.9 m; the committed
file's worst position is 7.82 m off. Ring structure, vertex counts and order, and the label
properties are exact. ``tests/test_encode_natural_earth_borders.py`` and
``website/tests/atlas-geometry-natural-earth.test.ts`` pin both bounds against the source.

**Container ("GOBD" v1, little-endian; fast-load spec §B.10):**

    offset 0  : magic "GOBD"
    offset 4  : u16 format_version = 1
    offset 6  : u16 reserved = 0
    offset 8  : u32 header_length (bytes of UTF-8 JSON)
    offset 12 : header JSON, canonical (sorted keys, no spaces)
              : 0x00 padding to payload_start = align4(12 + header_length)
              : payload: 2·V u32, V = sum(arcs); file length == payload_start + 8·V

The header is ``{arcs, features, quantization, source}``: ``arcs`` lists each arc's vertex count
(≥ 2); ``features`` lists ``{polygons, properties}`` in source order, a polygon being its rings
(outer first, then holes) and a ring its signed arc references (``~i`` walks arc ``i``
backwards); consecutive arcs share their joining vertex, and a ring's last arc ends on its first
vertex, which closes it. The payload is the arc vertices in arc order as interleaved lon, lat
lattice integers, delta-coded from (0, 0) along that whole sequence, zigzag-coded
(``(d << 1) ^ (d >> 31)``) and then byte-shuffled: byte ``k`` of element ``i`` is at
``k·n + i`` for ``n = 2·V`` elements. Every violation is a hard error in both decoders (this one
and ``website/src/atlas/geometry/natural-earth-codec.ts``).

Byte-deterministic; the encoding is decoded back and compared with the quantized source before it
is written (to a temporary sibling, then renamed). Needs only numpy.

    python scripts/encode_natural_earth_borders.py            # write the site file
    python scripts/encode_natural_earth_borders.py --check    # fail if it is stale
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import secrets
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "reference" / "ne_50m_admin_0_countries.geojson"
SOURCE_SHA256 = "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb"
SOURCE_REVISION = "ca96624a56bd078437bca8184e78163e5039ad19"
SOURCE_URL = (
    "https://github.com/nvkelso/natural-earth-vector/blob/"
    f"{SOURCE_REVISION}/geojson/ne_50m_admin_0_countries.geojson"
)
#: The catalog ``context_sources`` key the site fetches (``scripts/export_atlas_web.py``).
OUTPUT_KEY = "ne-50m-admin-0.borders.bin"
OUTPUT_PATH = ROOT / "website" / "public" / "data" / "atlas" / OUTPUT_KEY

MAGIC = b"GOBD"
FORMAT_VERSION = 1
#: Lattice points per degree: positions are rounded to 0.0001°.
QUANTIZATION = 10_000
MAX_ERROR_DEGREES = 0.5 / QUANTIZATION
MAX_ERROR_METRES = 7.9
#: Largest lattice whose deltas (up to 360° across) still zigzag into a u32.
MAX_QUANTIZATION = 1_000_000
#: What the overlay reads: the label text (NAME_LONG, then ADMIN, then NAME), its anchor and scale.
TEXT_PROPERTIES = ("ADMIN", "NAME", "NAME_LONG")
NUMBER_PROPERTIES = ("LABEL_X", "LABEL_Y", "MIN_LABEL")
KEPT_PROPERTIES = tuple(sorted(TEXT_PROPERTIES + NUMBER_PROPERTIES))
HEADER_KEYS = {"arcs", "features", "quantization", "source"}
SHA256 = re.compile(r"^[0-9a-f]{64}$")

Point = tuple[int, int]


@dataclass(frozen=True)
class Container:
    """A container's header JSON and its payload bytes, before the header is validated."""

    header: dict[str, Any]
    payload: bytes


@dataclass(frozen=True)
class Feature:
    """One decoded feature: its rings as closed lists of [x, y] lattice integers, and properties."""

    polygons: list[list[list[list[int]]]]
    properties: dict[str, Any]


@dataclass(frozen=True)
class Decoded:
    header: dict[str, Any]
    features: list[Feature]


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False
    ).encode()


def read_source(path: Path = SOURCE_PATH, sha256: str = SOURCE_SHA256) -> dict[str, Any]:
    """The GeoJSON at ``path``, refused unless its bytes hash to ``sha256``."""
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError(f"{path}: sha256 is not the pinned Natural Earth revision's {sha256}")
    return json.loads(data)


# Source validation: the RFC 7946 rules the overlay relied on, every violation a hard error.


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _ring(ring: Any, where: str) -> np.ndarray:
    if not isinstance(ring, list):
        raise ValueError(f"{where} is not an array")
    for position in ring:
        if not (isinstance(position, list) and len(position) == 2 and all(map(_is_number, position))):
            raise ValueError(f"{where} has a position that is not two finite numbers")
    if len(ring) < 4:
        raise ValueError(f"{where} has fewer than four positions")
    if ring[0] != ring[-1]:
        raise ValueError(f"{where} is not closed")
    array = np.asarray(ring, dtype=np.float64)
    if np.any(np.abs(array[:, 0]) > 180) or np.any(np.abs(array[:, 1]) > 90):
        raise ValueError(f"{where} has a position outside WGS84 bounds")
    return array


def _polygons(geometry: Any, where: str) -> list[list[np.ndarray]]:
    if not isinstance(geometry, dict) or "coordinates" not in geometry:
        raise ValueError(f"{where} geometry must be a Polygon or MultiPolygon")
    kind, coordinates = geometry.get("type"), geometry["coordinates"]
    if kind not in ("Polygon", "MultiPolygon"):
        raise ValueError(f"{where} has unsupported geometry type {kind!r}; the borders are polygons")
    if not isinstance(coordinates, list):
        raise ValueError(f"{where} {kind} coordinates are not an array")
    # An empty Polygon is "coordinates": [] (RFC 7946 §3.1), like an empty MultiPolygon.
    polygons = ([coordinates] if coordinates else []) if kind == "Polygon" else coordinates
    if not polygons:
        raise ValueError(f"{where} has no polygon")
    out = []
    for index, polygon in enumerate(polygons):
        if not isinstance(polygon, list) or not polygon:
            raise ValueError(f"{where} polygon {index} has no ring")
        out.append([_ring(ring, f"{where} polygon {index} ring {r}") for r, ring in enumerate(polygon)])
    return out


def _kept_properties(properties: Any, where: str) -> dict[str, Any]:
    if not isinstance(properties, dict):
        raise ValueError(f"{where} properties must be an object")
    kept = {key: properties[key] for key in KEPT_PROPERTIES if key in properties}
    for key, value in kept.items():
        if key in TEXT_PROPERTIES and not isinstance(value, str):
            raise ValueError(f"{where} property {key} must be a string")
        if key in NUMBER_PROPERTIES and not _is_number(value):
            raise ValueError(f"{where} property {key} must be a finite number")
    return kept


def _features(collection: Any) -> list[tuple[dict[str, Any], list[list[np.ndarray]]]]:
    if not (
        isinstance(collection, dict)
        and collection.get("type") == "FeatureCollection"
        and isinstance(collection.get("features"), list)
    ):
        raise ValueError("Natural Earth source must be a GeoJSON FeatureCollection")
    out = []
    for index, feature in enumerate(collection["features"]):
        where = f"Natural Earth feature {index}"
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError(f"{where} is not a GeoJSON Feature")
        polygons = _polygons(feature.get("geometry"), where)
        out.append((_kept_properties(feature.get("properties"), where), polygons))
    return out


# Topology: cut every ring where rings meet, then store each distinct cut once.


def _build_arcs(rings: list[list[Point]]) -> tuple[list[tuple[Point, ...]], list[list[int]]]:
    """Arcs and each ring's signed arc references; rings are open (no closing vertex).

    A vertex is a junction where its neighbours differ between the places it occurs, and every
    ring's first vertex is one, so each ring starts on an arc boundary and decodes in its source
    order. Arcs are numbered in order of first use, so the output is deterministic.
    """
    neighbours: dict[Point, tuple[Point, Point]] = {}
    junctions: set[Point] = set()
    for ring in rings:
        junctions.add(ring[0])
        for index, point in enumerate(ring):
            before, after = ring[index - 1], ring[(index + 1) % len(ring)]
            pair = (before, after) if before <= after else (after, before)
            if neighbours.setdefault(point, pair) != pair:
                junctions.add(point)
    arcs: list[tuple[Point, ...]] = []
    index_of: dict[tuple[Point, ...], int] = {}
    references = []
    for ring in rings:
        closed = [*ring, ring[0]]
        cuts = [index for index, point in enumerate(ring) if point in junctions] + [len(ring)]
        refs = []
        for start, end in zip(cuts, cuts[1:], strict=False):
            arc = tuple(closed[start : end + 1])
            if arc in index_of:
                refs.append(index_of[arc])
            elif arc[::-1] in index_of:
                refs.append(~index_of[arc[::-1]])
            else:
                index_of[arc] = len(arcs)
                refs.append(len(arcs))
                arcs.append(arc)
        references.append(refs)
    return arcs, references


def _shuffle(values: np.ndarray) -> bytes:
    return values.astype("<u4").view(np.uint8).reshape(-1, 4).T.tobytes()


def _unshuffle(payload: bytes) -> np.ndarray:
    planes = np.frombuffer(payload, dtype=np.uint8).reshape(4, -1)
    return np.ascontiguousarray(planes.T).view("<u4").reshape(-1).astype(np.int64)


def encode(collection: Any, *, quantization: int, source: dict[str, str]) -> bytes:
    """The GOBD container for a validated FeatureCollection; see the module docstring."""
    if not (isinstance(quantization, int) and 1 <= quantization <= MAX_QUANTIZATION):
        raise ValueError(f"quantization must be an integer in [1, {MAX_QUANTIZATION}]")
    features = _features(collection)
    # Closed rings on the lattice, per feature and polygon: what decode() must give back.
    lattice = [
        [[np.rint(ring * quantization).astype(np.int64).tolist() for ring in polygon] for polygon in polygons]
        for _, polygons in features
    ]
    rings = [
        [(x, y) for x, y in ring[:-1]] for polygons in lattice for polygon in polygons for ring in polygon
    ]
    arcs, references = _build_arcs(rings)
    refs = iter(references)
    header = {
        "arcs": [len(arc) for arc in arcs],
        "features": [
            {"polygons": [[next(refs) for _ in polygon] for polygon in polygons], "properties": properties}
            for properties, polygons in features
        ],
        "quantization": quantization,
        "source": dict(source),
    }
    points = np.asarray([point for arc in arcs for point in arc], dtype=np.int64).reshape(-1)
    deltas = np.diff(points.reshape(-1, 2), axis=0, prepend=np.zeros((1, 2), dtype=np.int64)).reshape(-1)
    zigzag = (deltas << 1) ^ (deltas >> 63)
    header_bytes = canonical_json(header)
    padding = b"\x00" * (-(12 + len(header_bytes)) % 4)
    data = (
        MAGIC
        + struct.pack("<HHI", FORMAT_VERSION, 0, len(header_bytes))
        + header_bytes
        + padding
        + _shuffle(zigzag)
    )
    if [feature.polygons for feature in decode(data).features] != lattice:
        raise AssertionError("GOBD encoding does not decode to the quantized source")
    return data


def encode_source(collection: Any) -> bytes:
    """The committed encoding: ``QUANTIZATION`` and the pinned source's provenance."""
    return encode(
        collection,
        quantization=QUANTIZATION,
        source={"revision": SOURCE_REVISION, "sha256": SOURCE_SHA256, "url": SOURCE_URL},
    )


# Decoding: the same checks, in the same order, as natural-earth-codec.ts.


def read_container(data: bytes) -> Container:
    """Preamble, header JSON and padding; the header's contents are not validated here."""
    if len(data) < 12:
        raise ValueError("GOBD file is shorter than its 12-byte preamble")
    if data[:4] != MAGIC:
        raise ValueError("GOBD magic is missing")
    version, reserved, header_length = struct.unpack_from("<HHI", data, 4)
    if version != FORMAT_VERSION:
        raise ValueError(f"GOBD format_version {version} is not {FORMAT_VERSION}")
    if reserved != 0:
        raise ValueError("GOBD reserved field is not 0")
    start = 12 + header_length + (-(12 + header_length) % 4)
    if start > len(data):
        raise ValueError("GOBD header runs past the end of the file")
    try:
        header = json.loads(data[12 : 12 + header_length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"GOBD header is not UTF-8 JSON: {error}") from None
    if not isinstance(header, dict):
        raise ValueError("GOBD header is not a JSON object")
    if any(data[12 + header_length : start]):
        raise ValueError("GOBD padding byte is not 0")
    return Container(header=header, payload=data[start:])


def _is_count(value: Any, minimum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= 2**53 - 1


def _validate_header(header: dict[str, Any]) -> None:
    if set(header) != HEADER_KEYS:
        raise ValueError(f"GOBD header keys must be exactly {sorted(HEADER_KEYS)}")
    if not (_is_count(header["quantization"], 1) and header["quantization"] <= MAX_QUANTIZATION):
        raise ValueError(f"GOBD quantization must be an integer in [1, {MAX_QUANTIZATION}]")
    source = header["source"]
    if not (
        isinstance(source, dict)
        and set(source) == {"revision", "sha256", "url"}
        and all(isinstance(value, str) and value for value in source.values())
        and SHA256.match(source["sha256"])
    ):
        raise ValueError("GOBD source must be {revision, sha256 (64 lowercase hex), url}")
    arcs = header["arcs"]
    if not isinstance(arcs, list) or not all(_is_count(count, 2) for count in arcs):
        raise ValueError("GOBD arcs must be vertex counts of at least 2")
    features = header["features"]
    if not isinstance(features, list):
        raise ValueError("GOBD features must be an array")
    used = [False] * len(arcs)
    for index, feature in enumerate(features):
        where = f"Natural Earth feature {index}"
        if not isinstance(feature, dict) or set(feature) != {"polygons", "properties"}:
            raise ValueError(f"{where} must be exactly {{polygons, properties}}")
        properties = feature["properties"]
        if not isinstance(properties, dict) or not set(properties) <= set(KEPT_PROPERTIES):
            raise ValueError(f"{where} properties must be a subset of {list(KEPT_PROPERTIES)}")
        for key, value in properties.items():
            valid = isinstance(value, str) if key in TEXT_PROPERTIES else _is_number(value)
            if not valid:
                raise ValueError(f"{where} property {key} has the wrong type")
        polygons = feature["polygons"]
        if not isinstance(polygons, list) or not polygons:
            raise ValueError(f"{where} has no polygon")
        for p, polygon in enumerate(polygons):
            if not isinstance(polygon, list) or not polygon:
                raise ValueError(f"{where} polygon {p} has no ring")
            for r, ring in enumerate(polygon):
                if not isinstance(ring, list) or not ring:
                    raise ValueError(f"{where} polygon {p} ring {r} has no arc")
                for ref in ring:
                    if isinstance(ref, bool) or not isinstance(ref, int) or not -len(arcs) <= ref < len(arcs):
                        raise ValueError(f"{where} polygon {p} ring {r} refers to arc {ref!r} of {len(arcs)}")
                    used[ref if ref >= 0 else ~ref] = True
    if not all(used):
        raise ValueError(f"GOBD arc {used.index(False)} is never referenced")


def decode(data: bytes) -> Decoded:
    """Every ring as closed lattice integers, after every check in the module docstring."""
    container = read_container(data)
    header = container.header
    _validate_header(header)
    vertices = sum(header["arcs"])
    if len(container.payload) != 8 * vertices:
        raise ValueError(
            f"GOBD length {len(data)} is not {len(data) - len(container.payload) + 8 * vertices} "
            f"for {vertices} arc vertices"
        )
    zigzag = _unshuffle(container.payload)
    points = np.cumsum(((zigzag >> 1) ^ -(zigzag & 1)).reshape(-1, 2), axis=0)
    limit = 180 * header["quantization"]
    if np.any(np.abs(points[:, 0]) > limit) or np.any(np.abs(points[:, 1]) > limit // 2):
        raise ValueError("GOBD has a coordinate outside WGS84 bounds")
    starts = np.concatenate([[0], np.cumsum(header["arcs"])])
    arcs = [points[start:end].tolist() for start, end in zip(starts[:-1], starts[1:], strict=True)]
    features = []
    for index, feature in enumerate(header["features"]):
        polygons = []
        for p, polygon in enumerate(feature["polygons"]):
            rings = []
            for r, refs in enumerate(polygon):
                where = f"Natural Earth feature {index} polygon {p} ring {r}"
                ring: list[list[int]] = []
                for position, ref in enumerate(refs):
                    arc = arcs[ref] if ref >= 0 else arcs[~ref][::-1]
                    if ring and ring[-1] != arc[0]:
                        raise ValueError(
                            f"{where} arc {position} does not start where arc {position - 1} ends"
                        )
                    ring.extend(arc if not ring else arc[1:])
                if ring[-1] != ring[0]:
                    raise ValueError(f"{where} is not closed")
                if len(ring) < 4:
                    raise ValueError(f"{where} has fewer than four positions")
                rings.append(ring)
            polygons.append(rings)
        features.append(Feature(polygons=polygons, properties=feature["properties"]))
    return Decoded(header=header, features=features)


def _write_atomically(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--source", type=Path, default=SOURCE_PATH)
    parser.add_argument("--out", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--check", action="store_true", help="fail if --out is not the encoding")
    args = parser.parse_args(argv)
    data = encode_source(read_source(args.source))
    if args.check:
        if not args.out.exists() or args.out.read_bytes() != data:
            print(f"{args.out} is stale: run scripts/encode_natural_earth_borders.py", file=sys.stderr)
            return 1
        print(f"{args.out} is current")
        return 0
    _write_atomically(args.out, data)
    print(f"wrote {args.out} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
