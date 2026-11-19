"""Write candidate query layouts of the sample under out/layouts/ (DuckDB 1.5.5 writer).

P1_rg<k>:  position-major, chrom + 1 Mb bins, 17 contract columns + pos, row groups of k rows
P5_rg122880: position-major, chrom + 5 Mb bins
P1d_rg122880: as P1 but source_record_id derived in the view (not stored)
NP: narrow population-major copy: population_id/chrom partitions, (pos, ref, alt, ac, an)
G1: genome-sized file list for 1 Mb bins (symlinks; only chr21 bins 25/26 hold real data)

Usage: python -I build_layouts.py <workdir>
"""

import os
import shutil
import sys
from pathlib import Path

import duckdb

W = Path(sys.argv[1])
L = W / "out/layouts"
if L.exists():
    shutil.rmtree(L)
L.mkdir(parents=True)
IV = "gnomad_hgdp_1kg-v3.1.2-probe-2026-10-19"
CONTRACT = [
    "variant_id", "rsid", "population_id", "lat", "lon", "radius_km", "ac", "an",
    "source_record_id", "source", "assay", "date_lower", "date_upper", "sampling_design",
    "disease_ascertainment_excluded", "cohort_id", "ingest_version",
]
con = duckdb.connect()
con.execute("SET threads=1; SET preserve_insertion_order=true")
con.execute(f"CREATE TABLE r AS SELECT * FROM read_parquet('{W}/out/rows.parquet')")


def pos_layout(name, binsize, rgs, cols):
    base = L / name / "source=gnomad_hgdp_1kg" / f"ingest_version={IV}"
    for chrom, b in con.execute(f"SELECT DISTINCT chrom, pos // {binsize} FROM r ORDER BY 1, 2").fetchall():
        d = base / f"chrom={chrom}" / f"bin={b}"
        d.mkdir(parents=True)
        con.execute(
            f"COPY (SELECT {', '.join(cols)}, pos FROM r WHERE chrom='{chrom}' AND pos // {binsize} = {b} "
            f"ORDER BY pos, ref, alt, population_id) TO '{d}/part-0.parquet' "
            f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {rgs})"
        )


for rgs in (8192, 32768, 122880, 1048576):
    pos_layout(f"P1_rg{rgs}", 1_000_000, rgs, CONTRACT)
pos_layout("P5_rg122880", 5_000_000, 122880, CONTRACT)
pos_layout("P1d_rg122880", 1_000_000, 122880, [c for c in CONTRACT if c != "source_record_id"])

base = L / "NP" / "source=gnomad_hgdp_1kg" / f"ingest_version={IV}"
for (pid,) in con.execute("SELECT DISTINCT population_id FROM r ORDER BY 1").fetchall():
    d = base / f"population_id={pid}" / "chrom=chr21"
    d.mkdir(parents=True)
    con.execute(
        f"COPY (SELECT pos, ref, alt, ac, an FROM r WHERE population_id='{pid}' ORDER BY pos, ref, alt) "
        f"TO '{d}/part-0.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)"
    )

# Genome-sized file list (GRCh38 primary assembly lengths, UCSC hg38.chrom.sizes)
SIZES = {
    "chr1": 248956422, "chr2": 242193529, "chr3": 198295559, "chr4": 190214555, "chr5": 181538259,
    "chr6": 170805979, "chr7": 159345973, "chr8": 145138636, "chr9": 138394717, "chr10": 133797422,
    "chr11": 135086622, "chr12": 133275309, "chr13": 114364328, "chr14": 107043718, "chr15": 101991189,
    "chr16": 90338345, "chr17": 83257441, "chr18": 80373285, "chr19": 58617616, "chr20": 64444167,
    "chr21": 46709983, "chr22": 50818468, "chrX": 156040895, "chrY": 57227415,
}
src = L / "P1_rg122880" / "source=gnomad_hgdp_1kg" / f"ingest_version={IV}" / "chrom=chr21"
gbase = L / "G1" / "source=gnomad_hgdp_1kg" / f"ingest_version={IV}"
n = 0
for chrom, length in SIZES.items():
    for b in range((length + 999_999) // 1_000_000):
        d = gbase / f"chrom={chrom}" / f"bin={b}"
        d.mkdir(parents=True)
        real = chrom == "chr21" and b in (25, 26)
        target = src / f"bin={b if real else 25}" / "part-0.parquet"
        os.symlink(target, d / "part-0.parquet")
        n += 1
print("genome 1Mb bins:", n)
for p in sorted(L.iterdir()):
    files = [f for f in p.rglob("*.parquet") if not f.is_symlink()]
    print(p.name, len(files), "files", sum(f.stat().st_size for f in files), "bytes")
