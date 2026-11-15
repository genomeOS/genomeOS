"""The step 2.7 gate: one variant's lookup over loopback HTTP on a 3,102-file lookup set.

Atlas data platform design 2026-10-18 §11 step 2.7 ("attach ≤ 0.6 MB; a lookup ≤ 300 KB and ≤ 15 requests
on a 3,102-file test tree"), §2.6 and §2.10. The ``gate`` fixture writes one release, ``2026-12-01``, under
a tree that ``tests.range_server`` serves on 127.0.0.1, logging every request's bytes:

- **The lookup set** ``gnomad_hgdp_1kg`` / ``2026-12-recount`` over GRCh38: its chr11/5 bin holds 49,152
  variants at 5,000,000 + 20·i (every 7th a deletion) × 80 populations, 3,932,160 rows written by
  ``write_bin``, about 90% of ``ac`` 0 and ``an`` 90-100, both chosen by a hash of ``(i, j)``. The other
  3,101 bins are symlinks to one empty bin, so every URL a macro can compute answers.
- **Curated files:** 3 files of 2,000 rows over 700 ids in all (source ``publications``, never the lookup
  set's), ``GATE_VARIANT`` in exactly one and the uncurated variant in none. ``chrM-16519-T-C``,
  ``hla:a-02-01`` and ``kir:2dl1`` are curated too, so they read curated rows and no bin.
- **The catalog:** the four lookup macros over that lookup set, those files and 61 surfaces (whose cells are
  never read here), with the curated key sets padded by ids no file holds until the statements total
  ``MAX_MACRO_BYTES`` − 1 KiB, the largest catalog a release may render. ``build_catalog_db`` writes it to
  ``catalog/atlas.duckdb``; every URL is on the server.

Each connection is cold: a fresh pinned DuckDB that runs ``INSTALL httpfs; LOAD httpfs`` itself (the
install downloads the extension once per machine, and is never skipped) with its HTTP metadata, external
file and Parquet metadata caches off.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pytest

from genomeos.observations.schema import OBSERVATIONS_SCHEMA
from genomeos.tables import writer
from genomeos.tables.binned import BINNED_COLUMNS, SOURCE_RECORD_ID_TEMPLATE, write_bin
from genomeos.tables.lookup_macros import (
    MAX_MACRO_BYTES,
    SURFACE_COLUMNS,
    CuratedFile,
    FileRef,
    PublishedLookupSet,
    SurfaceFile,
    lookup_statements,
)
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef, bin_path, lookup_set
from tests.lookup_fixtures import W, binned_row, write_curated
from tests.range_server import RangeServer, Request, serve

BINNED = "/allele_observations_binned/"
RELEASE_DIR = "releases/2026-12-01"
CATALOG = "catalog/atlas.duckdb"
LOOKUP = lookup_set("gnomad_hgdp_1kg", "2026-12-recount", GRCH38_LENGTHS)
#: The one bin with rows: 49,152 variants × 80 populations.
GATE_BIN = BinRef("chr11", 5)
N_VARIANTS = 49_152
N_POPULATIONS = 80
#: The settings a cold connection turns off, so each lookup pays for every byte it reads.
CACHES = ("enable_http_metadata_cache", "enable_external_file_cache", "parquet_metadata_cache")
#: Rows per curated file, and ids over all three.
CURATED_ROWS = 2_000
CURATED_IDS = 700
#: The released artifacts the catalog's ``inferred.surfaces`` names, as many as 2026-10-17 released.
N_SURFACES = 61
#: The columns every gate row takes from ``binned_row``.
SHARED_COLUMNS = ("assay", "date_lower", "date_upper", "sampling_design", "disease_ascertainment_excluded")


def _variant_id(i: int) -> str:
    """The bin's variant ``i``: at 5,000,000 + 20·i, a one-base deletion when ``i`` is a multiple of 7."""
    base = "ACGT"[i % 4]
    ref, alt = (base + "T", base) if i % 7 == 0 else (base, "CGTA"[i % 4])
    return f"chr11-{5_000_000 + 20 * i}-{ref}-{alt}"


#: The variant every lookup test reads: i = 24,576, in the bin and in exactly one curated file.
GATE_VARIANT = _variant_id(24_576)
#: A deletion in the bin that no curated file holds or lists.
UNCURATED_VARIANT = _variant_id(40_005)


@dataclass
class Gate:
    """The served release, and cold connections to its catalog; ``close`` closes every one opened."""

    server: RangeServer
    root: Path
    uncurated_variant: str
    catalog_url: str
    _connections: list[duckdb.DuckDBPyConnection] = field(default_factory=list)

    def attach(self) -> list[Request]:
        """The requests of a cold connection attaching the catalog."""
        con = self._cold()
        self.server.clear()
        con.execute(f"ATTACH '{self.catalog_url}' AS atlas (READ_ONLY)")
        return self.server.requests()

    def attached(self) -> duckdb.DuckDBPyConnection:
        """A cold connection with the catalog attached as ``atlas``, the server's log cleared."""
        con = self._cold()
        con.execute(f"ATTACH '{self.catalog_url}' AS atlas (READ_ONLY)")
        self.server.clear()
        return con

    def lookup(self, v: str) -> list[Request]:
        """The requests of ``measured.variant(v)`` on a freshly attached cold connection."""
        self.attached().execute("SELECT * FROM atlas.measured.variant(?)", [v]).fetchall()
        return self.server.requests()

    def path_of(self, chrom: str, bin: int) -> str:
        """The server path of the lookup set's ``(chrom, bin)`` file."""
        return f"/{RELEASE_DIR}/{bin_path(LOOKUP, BinRef(chrom, bin))}"

    def close(self) -> None:
        for con in self._connections:
            con.close()

    def _cold(self) -> duckdb.DuckDBPyConnection:
        con = writer.connect()
        self._connections.append(con)
        con.execute("INSTALL httpfs; LOAD httpfs")
        for setting in CACHES:
            con.execute(f"SET {setting} = false")
        return con


def _mix(n: np.ndarray) -> np.ndarray:
    """splitmix64's finaliser of each ``n``: a well-mixed, deterministic 64-bit hash."""
    z = n.astype(np.uint64) + np.uint64(0x9E3779B97F4A7C15)
    z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    return z ^ (z >> np.uint64(31))


def _shared() -> dict[str, object]:
    """``binned_row``'s value of each ``SHARED_COLUMNS`` column (its ascertainment values are test values,
    O1)."""
    template = binned_row()
    return {name: template[name].iloc[0] for name in SHARED_COLUMNS}


def _bin_rows() -> pd.DataFrame:
    """The chr11/5 bin's 3,932,160 rows: row ``80·i + j`` is variant ``i`` in population ``j``."""
    i = np.repeat(np.arange(N_VARIANTS, dtype=np.int64), N_POPULATIONS)
    j = np.tile(np.arange(N_POPULATIONS, dtype=np.int64), N_VARIANTS)
    h = _mix(i * N_POPULATIONS + j)
    an = 90 + (h >> np.uint64(8)) % np.uint64(11)
    ac = np.where(h % np.uint64(10) == 0, 1 + (h >> np.uint64(32)) % np.uint64(10), 0)
    population = np.arange(N_POPULATIONS)
    ids = np.array([_variant_id(k) for k in range(N_VARIANTS)], dtype=object)
    return pd.DataFrame(
        {
            "variant_id": ids[i],
            "rsid": None,
            "population_id": np.array([f"gate-{k:02d}" for k in population], dtype=object)[j],
            "lat": (-50.0 + 1.25 * population)[j],
            "lon": (-175.0 + 4.4 * population)[j],
            "radius_km": 25.0,
            "ac": ac.astype(np.int64),
            "an": an.astype(np.int64),
            "source": LOOKUP.source,
            "cohort_id": "gnomad-v3.1.2-hgdp-1kg:gate-80:d18-v1",
            "ingest_version": LOOKUP.ingest_version,
            "pos": 5_000_000 + 20 * i,
            "source_label": np.array([f"Pop{k:02d}" for k in population], dtype=object)[j],
            **_shared(),
        },
        columns=list(BINNED_COLUMNS),
    )


def _write_bins(release: Path, scratch: Path) -> None:
    """Write the chr11/5 bin under ``release``, and link every other bin of the lookup set to one empty bin
    written under ``scratch``, outside the served tree."""
    write_bin(_bin_rows(), release, LOOKUP, GATE_BIN, **W)
    empty = scratch / write_bin(binned_row().iloc[0:0], scratch, LOOKUP, GATE_BIN, **W).path
    for ref in LOOKUP.bins():
        if ref != GATE_BIN:
            link = release / bin_path(LOOKUP, ref)
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(empty)


def _curated_ids() -> list[str]:
    """700 ids: ``GATE_VARIANT``, the three off-set ids that have curated rows, and loci outside the bin."""
    loci = [f"chr{1 + n % 22}-{10_000_000 + 1_009 * n}-G-A" for n in range(CURATED_IDS - 4)]
    return [GATE_VARIANT, "chrM-16519-T-C", "hla:a-02-01", "kir:2dl1", *loci]


def _write_curated(release: Path, url_prefix: str) -> list[CuratedFile]:
    """Three curated files of 2,000 rows each, file ``f`` holding every third id from the ``f``-th."""
    ids = _curated_ids()
    shared = _shared()
    files = []
    for f in range(3):
        held = ids[f::3]
        version = f"gate-{f}"
        rows = []
        for r in range(CURATED_ROWS):
            variant_id, population = held[r % len(held)], r // len(held)
            rows.append(
                {
                    "variant_id": variant_id,
                    "rsid": None,
                    "population_id": f"pub-{population}",
                    "lat": -30.0 + 7.5 * population,
                    "lon": 10.0 * population,
                    "radius_km": 50.0,
                    "ac": r % 7,
                    "an": 100,
                    "source_record_id": f"publications:{version}:{variant_id}:pub-{population}",
                    "source": "publications",
                    "cohort_id": f"{version}:cohort-1",
                    "ingest_version": version,
                    **shared,
                }
            )
        path = (
            "tables/v1/measured/allele_observations/source=publications/"
            f"ingest_version={version}/part-0.parquet"
        )
        frame = pd.DataFrame(rows, columns=list(OBSERVATIONS_SCHEMA.columns))
        files.append(write_curated(release / path, frame, url=f"{url_prefix}{path}"))
    return files


def _surfaces(url_prefix: str) -> list[SurfaceFile]:
    """61 format-3 surfaces, described only: no lookup here reads their cells."""
    columns = frozenset(name for name, _ in SURFACE_COLUMNS[:-3])
    surfaces = []
    for k in range(N_SURFACES):
        variant_id = f"chr{1 + k % 22}-{20_000_000 + 97 * k}-C-G"
        path = f"store/artifacts/{variant_id}__v3__map-2026-08/cells.parquet"
        surface = SurfaceFile(
            FileRef(path, f"{url_prefix}{path}"),
            variant_id,
            "v3",
            "map-2026-08",
            "allele_frequency",
            3,
            True,
            columns,
        )
        surfaces.append(surface)
    return surfaces


def _padded_statements(
    lookup: PublishedLookupSet, curated: Sequence[CuratedFile], surfaces: Sequence[SurfaceFile]
) -> tuple[str, ...]:
    """The four macros, the curated key sets padded with ids no file holds (one length, spread over the
    files) until the statements total ``MAX_MACRO_BYTES`` − 1 KiB."""

    def render(n: int) -> tuple[str, ...]:
        padded = [
            replace(item, keys=item.keys | {f"chr22-{30_000_000 + k}-A-T" for k in range(f, n, len(curated))})
            for f, item in enumerate(curated)
        ]
        return lookup_statements([lookup], padded, surfaces)

    def size(statements: tuple[str, ...]) -> int:
        return sum(len(statement.encode("utf-8")) for statement in statements)

    target = MAX_MACRO_BYTES - 1024
    unpadded = size(render(0))
    per_key = size(render(1)) - unpadded
    statements = render(-(-(target - unpadded) // per_key))
    assert unpadded < target <= size(statements) <= MAX_MACRO_BYTES
    return statements


@pytest.fixture(scope="module")
def gate(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Gate]:
    root = tmp_path_factory.mktemp("gate")
    release = root / RELEASE_DIR
    _write_bins(release, tmp_path_factory.mktemp("empty-bin"))
    with serve(root) as server:
        url_prefix = f"{server.base}{RELEASE_DIR}/"
        lookup = PublishedLookupSet(LOOKUP, url_prefix, SOURCE_RECORD_ID_TEMPLATE)
        statements = _padded_statements(lookup, _write_curated(release, url_prefix), _surfaces(url_prefix))
        sql = "\n".join(["CREATE SCHEMA measured;", "CREATE SCHEMA inferred;", *statements]) + "\n"
        writer.build_catalog_db(sql, release / CATALOG, data_root=release)
        opened = Gate(server, root, UNCURATED_VARIANT, f"{url_prefix}{CATALOG}")
        try:
            yield opened
        finally:
            opened.close()


@pytest.fixture(autouse=True)
def _no_brake(gate: Gate) -> None:
    """Each test starts with the lookup bucket's brake released, whichever test tripped it."""
    gate.server.lift()


def test_attach_reads_at_most_0_6_mb(gate: Gate) -> None:
    assert sum(r.bytes for r in gate.attach()) <= 600_000


def test_one_lookup_reads_at_most_300_kb_in_at_most_15_requests(gate: Gate) -> None:
    con = gate.attached()
    gate.server.clear()
    rows = dict(
        con.execute(
            "SELECT source, count(*) FROM atlas.measured.variant(?) GROUP BY 1", [GATE_VARIANT]
        ).fetchall()
    )
    reqs = gate.server.requests()
    assert rows["gnomad_hgdp_1kg"] == 80 and sum(r.bytes for r in reqs) <= 300_000 and len(reqs) <= 15
    assert {r.path for r in reqs if BINNED in r.path} == {gate.path_of("chr11", 5)} and len(
        {r.path for r in reqs if "/allele_observations/" in r.path}
    ) == 1


def test_a_variant_in_no_curated_file_touches_only_its_bin(gate: Gate) -> None:
    reqs = gate.lookup(gate.uncurated_variant)
    assert (
        not [r for r in reqs if "/allele_observations/" in r.path]
        and sum(r.bytes for r in reqs) <= 300_000
        and len(reqs) <= 15
    )


@pytest.mark.parametrize("v", ["chrM-16519-T-C", "hla:a-02-01", "kir:2dl1", "chr21-47000001-A-G"])
def test_ids_off_the_recorded_set_make_no_lookup_bucket_request(gate: Gate, v: str) -> None:
    assert not [r for r in gate.lookup(v) if BINNED in r.path]


def test_a_tripped_brake_fails_the_lookup_loudly(gate: Gate) -> None:
    gate.server.deny("/releases/2026-12-01/tables/v1/measured/allele_observations_binned/")
    with pytest.raises(
        duckdb.HTTPException, match=r"allele_observations_binned/.*chrom=chr11/bin=5/part-0\.parquet"
    ):
        gate.attached().execute("SELECT * FROM atlas.measured.variant(?)", [GATE_VARIANT]).fetchall()


@pytest.mark.parametrize("slash", ["", "/"])
def test_offline_mode_reads_the_downloaded_bin_with_no_http(gate: Gate, slash: str) -> None:
    con = gate.attached()
    con.execute(f"SET VARIABLE genomeos_local = '{gate.root}/releases/2026-12-01{slash}'")
    gate.server.clear()
    assert con.execute(
        "SELECT count(*) FROM atlas.measured.variant(?) WHERE source = 'gnomad_hgdp_1kg'", [GATE_VARIANT]
    ).fetchone() == (80,)
    assert gate.server.requests() == []


def _fetch(url: str, method: str = "GET", byte_range: str | None = None) -> tuple[int, dict[str, str], bytes]:
    """``(status, headers, body)`` of one plain HTTP request, an error status included."""
    request = urllib.request.Request(url, method=method, headers={"Range": byte_range} if byte_range else {})
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def test_the_server_answers_heads_and_ranges_and_logs_each_body(gate: Gate) -> None:
    path = gate.path_of("chr11", 5)
    url = f"{gate.server.base}{path[1:]}"
    data = (gate.root / path[1:]).read_bytes()
    size = len(data)
    gate.server.clear()
    status, headers, body = _fetch(url, "HEAD")
    assert (status, headers["Content-Length"], headers["Accept-Ranges"], body) == (
        200,
        str(size),
        "bytes",
        b"",
    )
    status, headers, body = _fetch(url, byte_range="bytes=4-9")
    assert (status, headers["Content-Range"], body) == (206, f"bytes 4-9/{size}", data[4:10])
    status, headers, body = _fetch(url, byte_range=f"bytes={size - 3}-")
    assert (status, headers["Content-Range"], body) == (206, f"bytes {size - 3}-{size - 1}/{size}", data[-3:])
    status, headers, body = _fetch(f"{url}.missing")
    assert (status, headers["Content-Length"], body) == (404, "0", b"")
    gate.server.deny(path.rsplit("/", 1)[0] + "/")
    status, headers, body = _fetch(url, byte_range="bytes=4-9")
    assert (status, headers["Content-Length"], body) == (403, "0", b"")
    assert gate.server.requests() == [
        Request("HEAD", path, 0),
        Request("GET", path, 6),
        Request("GET", path, 3),
        Request("GET", f"{path}.missing", 0),
        Request("GET", path, 0),
    ]
