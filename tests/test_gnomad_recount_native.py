"""The native bcftools count of D18's recount, its ploidy audit and its partial-genotype guard.

Atlas data platform design 2026-10-18 §1.2 D18, §2.10 (builder's call 38).

Every bin of the synthetic windows is counted natively and by the independent Python counter, which must
agree cell for cell and on the tally; each HARD record must stop the native path with its own error, in the
controller's check order (stages, then the partial guard, then the ploidy audit, then the lines).
"""

from __future__ import annotations

import contextlib
import signal
from collections.abc import Iterator

import pytest

from genomeos.observations.sources.gnomad_recount import native
from genomeos.observations.sources.gnomad_recount.native import (
    audit_ploidy,
    groups_file,
    header_contig_lengths,
    indexed_contigs,
    native_bin,
    native_query_format,
    parse_bcftools_version,
    parse_native_line,
    query_bin,
)
from genomeos.observations.sources.gnomad_recount.rule import RecountError, SiteCounts, Stage, StageSample
from genomeos.tables.lookup_sets import GRCH38_LENGTHS, BinRef
from tests.gnomad_recount_fixtures import (
    FIXTURES,
    HARD,
    fixture_stage,
    indexed_vcf,
    record,
    requires_native,
    vcf_with,
)

pytestmark = requires_native

BINS = [BinRef("chr1", 0), BinRef("chr1", 19), BinRef("chr1", 20), BinRef("chr11", 5), BinRef("chrX", 1),
        BinRef("chrX", 100), BinRef("chrX", 155), BinRef("chrY", 14), BinRef("chr1", 7)]
#: HARD's records in order, each with the error that must stop the native path.
HARD_MATCHES = [
    "second ALT", r"\*", r"\[p\]|\[c\]", "partial genotype", "ploidy", "ploidy", "ploidy", "D18 item 4"]
PLOIDY_HEADER = "# [1]Sample\t[2]Chromosome\t[3]Region Start\t[4]Region End\t[5]Ploidy\n"


def _windows(tmp_path):
    return str(indexed_vcf(tmp_path, (FIXTURES / "windows.vcf").read_text()))


def test_version_floor_and_exact_formats():
    assert parse_bcftools_version("bcftools 1.21\nUsing htslib 1.21\n") == (1, 21)
    assert parse_bcftools_version("bcftools 1.23.1\nUsing htslib 1.23.1\n") == (1, 23)
    with pytest.raises(RecountError, match=r"MIN_BCFTOOLS.*1\.21"):
        parse_bcftools_version("bcftools 1.20\nUsing htslib 1.20\n")
    assert groups_file(fixture_stage(), "p").splitlines()[:3] == ["SYN01\tp00", "SYN02\tp00", "SYN03\tp01"]
    assert native_query_format(2) == (
        "%CHROM\t%POS\t%ID\t%REF\t%ALT\t%FILTER\t%INFO/NS_c00,%INFO/NS_c01\t%INFO/NS_g00,%INFO/NS_g01"
        "\t%INFO/NS_d00,%INFO/NS_d01\t%INFO/NS_p00,%INFO/NS_p01\t%INFO/AC_p00,%INFO/AC_p01\t%INFO/AN_p00,%INFO/AN_p01\n"
    )


@pytest.mark.parametrize("ref", BINS)
def test_native_counts_equal_the_independent_counter(tmp_path, ref):
    vcf = _windows(tmp_path)
    native = native_bin(vcf, ref, fixture_stage(), tmp_path / "n")
    assert (native.sites, native.tally) == query_bin(vcf, ref, fixture_stage(), tmp_path / "q")
    assert (native.ploidy_runs > 0) == (native.tally.pass_records > 0)


def test_a_deletion_spanning_a_bin_boundary_is_counted_once_by_pos(tmp_path):
    vcf = _windows(tmp_path)
    left = native_bin(vcf, BinRef("chr1", 19), fixture_stage(), tmp_path / "a").sites
    right = native_bin(vcf, BinRef("chr1", 20), fixture_stage(), tmp_path / "b").sites
    assert [s.variant_id for s in left] == ["chr1-19999998-ATTTT-A"]
    assert [s.variant_id for s in right] == ["chr1-20000001-G-A"]


def test_xx_on_chry_counts_no_missing_refusal_natively(tmp_path):
    t = native_bin(_windows(tmp_path), BinRef("chrY", 14), fixture_stage(), tmp_path / "y").tally
    assert {k: v for k, v in t.refusals.items() if k[1] == "missing"} == {("PapuanSepik", "missing"): 1}


@pytest.mark.parametrize("rec,match", zip([r for r, _ in HARD], HARD_MATCHES, strict=True))
def test_every_record_and_call_hard_error_stops_the_native_path(tmp_path, rec, match):
    chrom, pos = rec.split()[0], int(rec.split()[1])
    vcf = str(indexed_vcf(tmp_path, vcf_with([rec])))
    with pytest.raises(RecountError, match=match) as err:
        native_bin(vcf, BinRef(chrom, pos // 1_000_000), fixture_stage(), tmp_path / "w")
    assert "SYN" not in str(err.value)  # bcftools' stderr names samples; the error never does


def test_a_stage_sample_missing_from_the_vcf_fails(tmp_path):
    stage = fixture_stage()
    nine = Stage("fixture-9", (*stage.samples, StageSample("SYN10", "Han", "XX")), stage.ids_sha256)
    with pytest.raises(RecountError, match=r"chr1:1-999999: \[view\]") as err:
        native_bin(_windows(tmp_path), BinRef("chr1", 0), nine, tmp_path / "w")
    assert "SYN10" not in str(err.value)


def test_audit_ploidy_reads_runs_by_segment():
    stage = fixture_stage()
    runs = "SYN01\tchrX\t1500000\t100000000\t2\nSYN02\tchrX\t100000000\t100000000\t1\n"
    assert audit_ploidy(PLOIDY_HEADER + runs, stage) == 2
    assert audit_ploidy(PLOIDY_HEADER, stage) == 0
    for run in ("SYN02\tchrX\t1500000\t100000000\t2\n", "SYN01\tchrY\t14000000\t14000000\t1\n",
                "SYN02\tchr1\t1000\t1000\t1\n"):
        with pytest.raises(RecountError, match="ploidy") as err:
            audit_ploidy(PLOIDY_HEADER + run, stage)
        assert "SYN" not in str(err.value)
    for damaged in ("", "SYN02\tchr1\t1000\t1000\t2\n", PLOIDY_HEADER + "SYN09\tchr1\t1000\t1000\t2\n"):
        with pytest.raises(RecountError, match="check-ploidy"):
            audit_ploidy(damaged, stage)


def test_native_lines_check_every_record_then_derive_refusals_and_check_consistency():
    stage = fixture_stage()
    line = "chr1\t1000\trs9001\tA\tG\tPASS\t2,1,2,2\t1,1,1,2\t1,1,0,1\t1,0,0,0\t1,0,0,0\t2,0,0,0\n"
    filter_, site, refusals = parse_native_line(line, stage)
    assert filter_ == "PASS"
    assert site == SiteCounts("chr1", 1000, "A", "G", "rs9001", (1, 0, 0, 0), (2, 0, 0, 0))
    assert refusals == {
        ("NorthernHan", "missing"): 1, ("Han", "low_gq"): 1, ("PapuanHighlands", "low_gq"): 1,
        ("PapuanHighlands", "low_dp"): 1, ("PapuanSepik", "low_dp"): 1,
        ("NorthernHan", "low_allele_balance"): 1, ("PapuanSepik", "low_allele_balance"): 1}
    assert parse_native_line(line.replace("PASS", "AC0"), stage) == ("AC0", None, {})
    # Decision 2: D18 item 2's record checks hold on every line, PASS or not.
    with pytest.raises(RecountError, match=r"chr1:1000: .*second ALT"):
        parse_native_line(line.replace("\tG\tPASS\t", "\tG,T\tAC0\t"), stage)
    chrx = "chrX\t100000000\t.\tA\tG\tPASS\t2,2,2,1\t2,2,2,1\t2,0,2,1\t2,0,2,1\t2,0,2,0\t3,0,3,2\n"
    chry = "chrY\t14000000\t.\tG\tT\tPASS\t1,1,1,0\t1,1,1,0\t1,1,1,0\t1,1,1,0\t1,0,0,0\t1,1,1,0\n"
    assert parse_native_line(chrx, stage)[1] == SiteCounts(
        "chrX", 100000000, "A", "G", None, (2, 0, 2, 0), (3, 0, 3, 2))
    assert parse_native_line(chry, stage)[2] == {("PapuanSepik", "missing"): 1}
    for damaged in (
        line.replace("\t2,0,0,0\n", "\t3,0,0,0\n"),  # an autosomal AN is 2 x NS
        line.replace("\t1,1,1,2\t", "\t3,1,1,2\t"),  # NS_g above NS_c
        line.replace("\t2,1,2,2\t", "\t3,1,2,2\t"),  # NS_c above the denominator
        line.replace("\t1,0,0,0\t2,0,0,0\n", "\t3,0,0,0\t2,0,0,0\n"),  # AC above AN
        chrx.replace("\t3,0,3,2\n", "\t5,0,3,2\n"),  # a chrX non-PAR AN is at most 2 x NS
        chry.replace("\t1,1,1,0\n", "\t2,1,1,0\n"),  # a chrY non-PAR AN is NS
    ):
        with pytest.raises(RecountError, match="native counts inconsistent"):
            parse_native_line(damaged, stage)
    with pytest.raises(RecountError, match="NS_c"):
        parse_native_line(line.replace("\t2,1,2,2\t", "\t2,.,2,2\t"), stage)


def test_index_and_header_contigs(tmp_path):
    vcf = _windows(tmp_path)
    assert indexed_contigs(vcf) == ("chr1", "chr11", "chrX", "chrY")
    assert header_contig_lengths(vcf) == dict(GRCH38_LENGTHS)


@contextlib.contextmanager
def _within(seconds: int) -> Iterator[None]:
    """Raise ``TimeoutError`` in the block after ``seconds``, so a hung pipeline fails the test."""

    def hung(signum, frame):
        raise TimeoutError("the native pipeline hung")

    previous = signal.signal(signal.SIGALRM, hung)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def test_tee_feeds_its_readers_through_anonymous_pipes_not_named_fifos(tmp_path, monkeypatch):
    # On macOS a named FIFO's reader at times stayed blocked in read() after tee, its only writer, had exited
    # (15 of 12,000 counts, always [guard]), so the count never ended. Anonymous pipes do not do that.
    monkeypatch.setattr(native.os, "mkfifo", lambda *args, **kwargs: pytest.fail("made a named FIFO"))
    vcf, ref = _windows(tmp_path), BinRef("chr1", 0)
    with _within(60):
        counted = native_bin(vcf, ref, fixture_stage(), tmp_path / "n")
    assert (counted.sites, counted.tally) == query_bin(vcf, ref, fixture_stage(), tmp_path / "q")


@pytest.mark.parametrize("records", [0, 4_000], ids=["stream-fits-a-pipe", "tee-blocks-on-a-full-pipe"])
@pytest.mark.parametrize(
    ("name", "value", "reader"),
    [("_AUDIT", ("bcftools", "+no-such-plugin"), "audit"), ("PARTIAL_GENOTYPE", "GT~", "guard")],
)
def test_a_tee_reader_that_dies_is_the_stage_named(tmp_path, monkeypatch, records, name, value, reader):
    # 4,000 records make a stream larger than a pipe buffer, so tee blocks writing to the dead reader's pipe
    # (this side holds its read end, so tee gets no SIGPIPE): the stages still running are stopped, and the
    # reader is named, not [c] reading a stream cut short.
    monkeypatch.setattr(native, name, value)
    lines = [record("chr1", 1_000 + i, "A", "G") for i in range(records)]
    vcf = str(indexed_vcf(tmp_path, vcf_with(lines))) if records else _windows(tmp_path)
    with _within(60), pytest.raises(RecountError, match=rf"chr1:1-999999: \[{reader}\]"):
        native_bin(vcf, BinRef("chr1", 0), fixture_stage(), tmp_path / "w")


def test_a_tee_reader_whose_input_never_ends_fails_instead_of_hanging(tmp_path, monkeypatch):
    monkeypatch.setattr(native, "_READER_GRACE_SECONDS", 0.2)
    pipeline = native._Pipeline(tmp_path, "native")
    try:
        pipeline.start("tee", ["true"])
        pipeline.start("guard", ["sleep", "60"])
        stalled = r"chr1:1-999999: \[guard\] still running .* its input never ended"
        with _within(30), pytest.raises(RecountError, match=stalled):
            pipeline.wait(("guard",), where="chr1:1-999999")
    finally:
        pipeline.close()
    assert pipeline.procs["guard"].returncode == -signal.SIGKILL and pipeline.procs["tee"].returncode == 0
