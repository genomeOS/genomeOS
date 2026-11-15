"""D18's rule as code and the independent Python counter.

Atlas data platform design 2026-10-18 §1.2 D18, §2.10.

The call controls port the chr22 pilot's (``tests/test_reference_genotypes.py``) to D18's reasons and add
haploid, allele-balance-boundary and absent-call cases; the counter runs on the synthetic windows in
``tests/fixtures/gnomad_recount/``, indels, an MNP, both sex chromosomes and non-PASS records included.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from typing import Any

import pytest

from genomeos.observations.sources.gnomad_recount import rule
from genomeos.observations.sources.gnomad_recount.counter import parse_query_header, recount_python
from genomeos.observations.sources.gnomad_recount.rule import (
    KARYOTYPES,
    CallOutcome,
    RecountError,
    Stage,
    Tally,
    assess_call,
    bin_region,
    check_record,
    denominators,
    expected_ploidy,
    read_stage,
    segment,
)
from genomeos.tables.lookup_sets import BinRef
from genomeos.validation.reference_cohorts import PAPER_STAGE
from tests.gnomad_recount_fixtures import FIXTURES, HARD, fixture_stage, query_lines, record, vcf_with

# The pilot's 12 lazy dispositions (test_reference_genotypes.py::test_preserved_lazy_dispositions), renamed
# to D18's reasons, all diploid; then D18's new haploid, AD-at-exactly-0.2 and absent-call cases.
CALLS = [
    ((".", "bad", "bad", "bad"), 2, CallOutcome(0, 0, "missing")),
    (("./.", "bad", "bad", "bad"), 2, CallOutcome(0, 0, "missing")),
    (("0|1", "20", "10", "2,8"), 2, CallOutcome(2, 1, None)),
    (("1/0", "20", "10", "8,2"), 2, CallOutcome(2, 1, None)),
    (("1/1", "20", "10", "bad"), 2, CallOutcome(2, 2, None)),
    (("0/1", ".", "bad", "bad"), 2, CallOutcome(0, 0, "low_gq")),
    (("0/1", "19", "bad", "bad"), 2, CallOutcome(0, 0, "low_gq")),
    (("0/1", "20", ".", "bad"), 2, CallOutcome(0, 0, "low_dp")),
    (("0/1", "20", "9", "bad"), 2, CallOutcome(0, 0, "low_dp")),
    (("0/1", "20", "10", ".,bad,extra"), 2, CallOutcome(0, 0, "low_allele_balance")),
    (("0/1", "20", "10", "1,bad"), 2, CallOutcome(0, 0, "low_allele_balance")),
    (("0/1", "20", "10", "8,1"), 2, CallOutcome(0, 0, "low_allele_balance")),
    (("1", "20", "5", "."), 1, CallOutcome(1, 1, None)),
    (("0", "20", "9", "."), 1, CallOutcome(1, 0, None)),
    (("1", "20", "4", "0,4"), 1, CallOutcome(0, 0, "low_dp")),
    (("0/1", "20", "15", "3,12"), 2, CallOutcome(2, 1, None)),
    ((".", ".", ".", "."), 0, CallOutcome(0, 0, None)),
    ((".", ".", ".", "."), 1, CallOutcome(0, 0, "missing")),
]


@pytest.mark.parametrize("tokens,expected,outcome", CALLS)
def test_calls_follow_d18_item_3_lazily(tokens, expected, outcome):
    assert assess_call(*tokens, expected=expected) == outcome


# The pilot's 9 refused encodings (test_encountered_invalid_encodings_refuse), each still a hard error.
@pytest.mark.parametrize(
    "tokens",
    [
        ("0/.", "20", "10", "2,8"),
        ("1", "20", "10", "2,8"),
        ("0/1/1", "20", "10", "2,8"),
        ("0/2", "20", "10", "2,8"),
        ("0/1", "-1", "10", "2,8"),
        ("0/1", "20", "x", "2,8"),
        ("0/1", "20", "10", "2,bad"),
        ("0/1", "20", "10", "2,8,0"),
        ("0/1", "20.0", "10", "2,8"),
    ],
)
def test_the_pilots_refused_encodings_still_refuse(tokens):
    with pytest.raises(RecountError):
        assess_call(*tokens, expected=2)


@pytest.mark.parametrize(
    "tokens,expected,match",
    [
        (("./1", "20", "10", "2,8"), 2, "partial genotype"),
        (("0|.", "20", "10", "2,8"), 2, "partial genotype"),
        (("0/2", "20", "10", "2,8"), 2, "allele index above 1"),
        (("2", "20", "10", "0,10"), 1, "allele index above 1"),
        (("0/1", "20", "10", "2,8"), 1, "ploidy"),
        (("1", "20", "10", "0,10"), 2, "ploidy"),
        (("0/1/1", "20", "10", "2,8"), 2, "ploidy"),
        (("0", "20", "10", "10,0"), 0, "ploidy"),
        (("0/1", "-1", "10", "2,8"), 2, "GQ"),
        (("0/1", "20.0", "10", "2,8"), 2, "GQ"),
        (("0/1", "20", "x", "2,8"), 2, "DP"),
        (("0/1", "20", "10", "2,bad"), 2, "AD"),
        (("0/1", "20", "10", "2,8,0"), 2, "AD"),
    ],
)
def test_hard_call_errors_name_their_cause(tokens, expected, match):
    with pytest.raises(RecountError, match=match):
        assess_call(*tokens, expected=expected)


def test_segments_regions_ploidy_and_denominators():
    xs = (10_000, 10_001, 2_781_479, 2_781_480, 155_701_382, 155_701_383, 156_030_895)
    assert [segment("chrX", p) for p in xs] == [
        "x_nonpar", "x_par", "x_par", "x_nonpar", "x_nonpar", "x_par", "x_par"]
    assert [segment("chrY", p) for p in (2_781_479, 2_781_480, 56_887_903)] == ["y_par", "y_nonpar", "y_par"]
    refs = (("chrX", 1), ("chrX", 0), ("chrX", 2), ("chrX", 155), ("chrX", 100), ("chrY", 56), ("chrY", 14),
            ("chr11", 5))
    assert [bin_region(BinRef(c, b)) for c, b in refs] == [
        "par", "straddles_par", "straddles_par", "straddles_par", "nonpar", "straddles_par", "nonpar",
        "autosome"]
    segments = ("autosome", "x_par", "x_nonpar", "y_nonpar")
    assert [expected_ploidy(s, k) for s in segments for k in KARYOTYPES] == [2, 2, 2, 2, 2, 1, 0, 1]
    assert denominators(fixture_stage(), "y_nonpar") == (1, 1, 1, 1)
    assert denominators(fixture_stage(), "x_nonpar") == (2, 2, 2, 2)
    with pytest.raises(RecountError, match="D18 item 4"):
        expected_ploidy("y_par", "XY")
    # chrM is D18 item 1 ("there is no chrM file"), not item 4 as the plan's brief had it.
    with pytest.raises(RecountError, match="D18 item 1"):
        segment("chrM", 1)
    with pytest.raises(RecountError, match="second ALT"):
        check_record("chr1", 7000, "A", "G,T")
    with pytest.raises(RecountError, match=r"\*.*D18 item 2"):
        check_record("chr1", 7000, "A", "*")
    with pytest.raises(RecountError, match="REF 'N'"):
        check_record("chr1", 7000, "N", "A")


def test_the_counter_on_the_fixture_windows():
    stage = fixture_stage()
    lines = query_lines((FIXTURES / "windows.vcf").read_text(), stage.sample_ids)
    sites, tally = recount_python(lines, stage)
    assert [s.variant_id for s in sites] == [
        "chr1-1000-A-G", "chr1-1000-A-T", "chr1-2000-ATCT-A", "chr1-2500-A-AGG", "chr1-3000-AC-GT",
        "chr1-6000-T-C", "chr1-19999998-ATTTT-A", "chr1-20000001-G-A", "chr11-5227002-T-A",
        "chrX-1500000-C-G", "chrX-100000000-A-G", "chrX-155800000-T-C", "chrY-14000000-G-T"]
    by = {s.variant_id: (s.ac, s.an) for s in sites}
    assert by["chr1-1000-A-G"] == ((1, 0, 0, 0), (2, 0, 0, 0))
    assert by["chrX-100000000-A-G"] == ((2, 0, 2, 0), (3, 0, 3, 2))
    assert by["chrY-14000000-G-T"] == ((1, 0, 0, 0), (1, 1, 1, 0))
    assert [s.rsid for s in sites if s.rsid is not None] == ["rs9001", "rs334"]
    totals = (tally.pass_records, tally.pass_non_snv, tally.monomorphic_in_stage, tally.written_sites)
    assert totals == (14, 4, 1, 13)
    assert tally.non_pass == Counter({"AC0": 1, "AC0;AS_VQSR": 1})
    assert tally.an_zero == Counter({"NorthernHan": 2, "PapuanHighlands": 1, "PapuanSepik": 3})
    # Han's second low_gq is SYN01 at chr1:4000, a monomorphic record: refusals count on every PASS record.
    assert tally.refusals == Counter({
        ("Han", "low_gq"): 2, ("NorthernHan", "missing"): 1, ("NorthernHan", "low_allele_balance"): 1,
        ("NorthernHan", "low_dp"): 2, ("PapuanHighlands", "low_gq"): 1, ("PapuanHighlands", "low_dp"): 1,
        ("PapuanSepik", "low_allele_balance"): 1, ("PapuanSepik", "low_dp"): 1,
        ("PapuanSepik", "missing"): 4})


@pytest.mark.parametrize("rec,item", HARD)
def test_hard_errors_name_the_record_and_the_d18_item_never_a_sample(rec, item):
    with pytest.raises(RecountError, match=rf"{rec.split()[0]}:{rec.split()[1]}.*{item}") as err:
        recount_python(query_lines(vcf_with([rec]), fixture_stage().sample_ids), fixture_stage())
    assert "SYN0" not in str(err.value)


@pytest.mark.parametrize(
    "calls,alt",
    [({"SYN01": "0/2:30:30:15,15"}, "G"), ({}, "G,T"), ({}, "*")],
)
def test_item_2_applies_to_non_pass_records_too(calls, alt):
    # Decision 2: D18 item 2's checks apply to every record, so the native and Python counters agree.
    rec = record("chr1", 7000, "A", alt, filter_="AC0", calls=calls)
    with pytest.raises(RecountError, match=r"chr1:7000: .*D18 item 2"):
        recount_python(query_lines(vcf_with([rec]), fixture_stage().sample_ids), fixture_stage())


def test_partial_genotype_on_non_pass_is_counted():
    rec = record("chr1", 7000, "A", "G", filter_="AC0", calls={"SYN01": "./1:30:30:15,15"})
    sites, tally = recount_python(query_lines(vcf_with([rec]), fixture_stage().sample_ids), fixture_stage())
    assert sites == ()
    assert tally.non_pass == Counter({"AC0": 1})
    assert tally == Tally(non_pass=Counter({"AC0": 1}))


def _read_stage(**change: Any) -> Stage:
    """``read_stage`` over the fixture files, with ``change`` replacing some of its arguments."""
    inputs = {
        "metadata": (FIXTURES / "metadata.tsv").read_bytes(),
        "karyotypes": (FIXTURES / "karyotypes.tsv").read_bytes(),
        "stage_ids": (FIXTURES / "stage.txt").read_bytes(),
        "name": "fixture-8",
    } | change
    return read_stage(inputs["metadata"], inputs["karyotypes"], inputs["stage_ids"], name=inputs["name"])


def test_stage_reads_both_karyotype_forms():
    stage = fixture_stage()
    assert stage.populations == ("Han", "NorthernHan", "PapuanHighlands", "PapuanSepik")
    assert stage.sample_ids == tuple(f"SYN0{i}" for i in range(1, 9))
    assert [s.karyotype for s in stage.samples] == ["XX", "XY"] * 4
    assert stage.ids_sha256 == hashlib.sha256((FIXTURES / "stage.txt").read_bytes()).hexdigest()
    flat = "s\tgnomad_sex_imputation.sex_karyotype\n" + "".join(
        f"SYN0{i}\t{'XX' if i % 2 else 'XY'}\n" for i in range(1, 10))
    assert _read_stage(karyotypes=flat.encode()) == stage


_PAPER_IDS = "".join(f"SYN{i:04d}\n" for i in range(1, 4095)).encode()
_BOTH_FORMS = b"s\tgnomad_sex_imputation\tgnomad_sex_imputation.sex_karyotype\nSYN01\t{}\tXX\n"


@pytest.mark.parametrize(
    "change,match",
    [
        ({"stage_ids": "".join(f"SYN0{i}\n" for i in range(1, 10)).encode()}, "XXY.*D18 item 4"),
        ({"stage_ids": b"SYN02\nSYN01\n"}, "sorted"),
        ({"stage_ids": b"SYN01\nSYN01\n"}, "unique"),
        ({"stage_ids": b"SYN01\nSYN99\n"}, "metadata"),
        ({"name": "Fixture One"}, "stage name"),
        ({"karyotypes": _BOTH_FORMS}, "both"),
        ({"name": PAPER_STAGE, "stage_ids": _PAPER_IDS}, "PAPER_SAMPLES_SHA256"),
    ],
)
def test_stage_refusals(change, match):
    with pytest.raises(RecountError, match=match) as err:
        _read_stage(**change)
    assert "SYN" not in str(err.value)


def test_the_paper_stage_checks_the_metadata_digest_after_the_ids(monkeypatch):
    monkeypatch.setattr(rule, "PAPER_SAMPLES_SHA256", hashlib.sha256(_PAPER_IDS).hexdigest())
    with pytest.raises(RecountError, match="METADATA_SHA256"):
        _read_stage(name=PAPER_STAGE, stage_ids=_PAPER_IDS)


def test_query_header_names_the_samples_in_column_order():
    header = query_lines(vcf_with([]), ("SYN02", "SYN01"))[0]
    assert parse_query_header(header) == ("SYN02", "SYN01")
    assert parse_query_header("# " + header[1:]) == ("SYN02", "SYN01")  # older bcftools put a space after '#'
    for damaged in (header[1:], header.replace("[7]", "[8]"), header.replace("SYN01:AD", "SYN02:AD")):
        with pytest.raises(RecountError, match="query"):
            parse_query_header(damaged)


def test_counts_join_by_sample_id():
    stage = fixture_stage()
    vcf = (FIXTURES / "windows.vcf").read_text()
    forward = recount_python(query_lines(vcf, stage.sample_ids), stage)
    assert recount_python(query_lines(vcf, stage.sample_ids[::-1]), stage) == forward
    with pytest.raises(RecountError, match="stage") as err:
        recount_python(query_lines(vcf, stage.sample_ids[:-1]), stage)
    assert "SYN0" not in str(err.value)


def test_tally_round_trips_and_merges():
    stage = fixture_stage()
    _, tally = recount_python(query_lines((FIXTURES / "windows.vcf").read_text(), stage.sample_ids), stage)
    assert Tally.from_json(json.loads(json.dumps(tally.to_json()))) == tally
    assert Tally.from_json(Tally().to_json()) == Tally()
    doubled = tally.merge(tally)
    totals = (doubled.pass_records, doubled.pass_non_snv, doubled.monomorphic_in_stage, doubled.written_sites)
    assert totals == (28, 8, 2, 26)
    assert doubled.non_pass == Counter({"AC0": 2, "AC0;AS_VQSR": 2})
    assert doubled.refusals == Counter({key: 2 * n for key, n in tally.refusals.items()})
    assert doubled.an_zero == Counter({"NorthernHan": 4, "PapuanHighlands": 2, "PapuanSepik": 6})
    assert tally.merge(Tally()) == tally and tally.pass_records == 14
    for damage in ({"refusals": [["Han", "low_qual", 1]]}, {"pass_records": -1}, {"an_zero": {"Han": 0}}):
        with pytest.raises(RecountError):
            Tally.from_json(tally.to_json() | damage)
    with pytest.raises(RecountError, match="keys"):
        Tally.from_json({k: v for k, v in tally.to_json().items() if k != "an_zero"})
