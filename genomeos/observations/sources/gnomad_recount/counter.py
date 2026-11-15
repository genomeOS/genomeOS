"""The independent Python counter (Atlas data platform design 2026-10-18 §1.2 D18, §2.10; §2.7 check 12).

It reads the text of ``bcftools query -H -f PY_QUERY_FORMAT -S <stage>`` (every record, PASS or not, with
each stage sample's GT, GQ, DP and AD as written) and applies ``rule``'s D18 checks in Python, sharing
nothing with the native bcftools count but the rule's constants, so check 12 can compare the two cell for
cell. Samples join the stage by the header's ids, never by column position. Every error names the record
as ``chrom:pos`` and never a sample. Pure: no I/O.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

from genomeos.observations.sources.gnomad_recount.rule import (
    RecountError,
    SiteCounts,
    Stage,
    Tally,
    assess_call,
    check_allele_indices,
    check_record,
    expected_ploidy,
    segment,
)

__all__ = ("PY_QUERY_FORMAT", "parse_query_header", "recount_python")

PY_QUERY_FORMAT = "%CHROM\t%POS\t%ID\t%REF\t%ALT\t%FILTER[\t%GT\t%GQ\t%DP\t%AD]\n"
_RECORD_COLUMNS = ("CHROM", "POS", "ID", "REF", "ALT", "FILTER")
_SAMPLE_FIELDS = ("GT", "GQ", "DP", "AD")
_POSITION = re.compile(r"[1-9][0-9]*")


def parse_query_header(line: str) -> tuple[str, ...]:
    """The sample ids of a ``bcftools query -H -f PY_QUERY_FORMAT`` header, in column order.

    bcftools 1.21 writes ``#[1]CHROM``; a space after ``#`` is accepted too.
    """
    text = line.removesuffix("\n")
    if not text.startswith("#"):
        raise RecountError("the query output does not start with a bcftools query -H header")
    columns = text[1:].removeprefix(" ").split("\t")
    names = []
    for n, column in enumerate(columns, start=1):
        if not column.startswith(f"[{n}]"):
            raise RecountError(f"query header column {n} is not numbered [{n}]")
        names.append(column.removeprefix(f"[{n}]"))
    first, fields = len(_RECORD_COLUMNS), len(_SAMPLE_FIELDS)
    if tuple(names[:first]) != _RECORD_COLUMNS or (len(names) - first) % fields:
        raise RecountError("the query header is not PY_QUERY_FORMAT's")
    samples = []
    for start in range(first, len(names), fields):
        sample = names[start].rpartition(":")[0]
        if not sample or names[start : start + fields] != [f"{sample}:{name}" for name in _SAMPLE_FIELDS]:
            raise RecountError(f"query header columns {start + 1}-{start + fields} are not a sample's GT-AD")
        samples.append(sample)
    if len(set(samples)) != len(samples):
        raise RecountError(f"the query header repeats {len(samples) - len(set(samples))} sample(s)")
    return tuple(samples)


def recount_python(lines: Iterable[str], stage: Stage) -> tuple[tuple[SiteCounts, ...], Tally]:
    """Count ``bcftools query`` output under D18: the written sites, in record order, and the tally."""
    rows = iter(lines)
    header = next(rows, None)
    if header is None:
        raise RecountError("the query output is empty")
    samples = parse_query_header(header)
    if sorted(samples) != list(stage.sample_ids):
        missing, extra = set(stage.sample_ids) - set(samples), set(samples) - set(stage.sample_ids)
        raise RecountError(
            f"the query's {len(samples)} samples are not the stage's {len(stage.sample_ids)} "
            f"({len(missing)} missing, {len(extra)} not in the stage)"
        )
    by_id = {sample.sample_id: sample for sample in stage.samples}
    populations = stage.populations
    index = {population: i for i, population in enumerate(populations)}
    column_population = tuple(index[by_id[sample].population] for sample in samples)
    karyotypes = tuple(by_id[sample].karyotype for sample in samples)
    width = len(_RECORD_COLUMNS) + len(_SAMPLE_FIELDS) * len(samples)
    ploidy: dict[str, tuple[int, ...]] = {}
    sites: list[SiteCounts] = []
    tally = Tally()
    for line in rows:
        fields = line.removesuffix("\n").split("\t")
        try:
            if len(fields) != width:
                raise RecountError(f"{len(fields)} columns where the header has {width}")
            chrom, pos_text, rsid, ref, alt, filter_ = fields[: len(_RECORD_COLUMNS)]
            if not _POSITION.fullmatch(pos_text):
                raise RecountError(f"POS {pos_text!r} is not a 1-based position")
            pos = int(pos_text)
            check_record(chrom, pos, ref, alt)
            calls = fields[len(_RECORD_COLUMNS) :]
            if filter_ != "PASS":
                for gt in calls[:: len(_SAMPLE_FIELDS)]:
                    check_allele_indices(gt)
                tally.record_filtered(filter_)
                continue
            seg = segment(chrom, pos)
            if seg not in ploidy:
                ploidy[seg] = tuple(expected_ploidy(seg, karyotype) for karyotype in karyotypes)
            ac, an = [0] * len(populations), [0] * len(populations)
            refusals: Counter[tuple[str, str]] = Counter()
            for j, (p, expected) in enumerate(zip(column_population, ploidy[seg], strict=True)):
                gt, gq, dp, ad = calls[len(_SAMPLE_FIELDS) * j : len(_SAMPLE_FIELDS) * (j + 1)]
                outcome = assess_call(gt, gq, dp, ad, expected=expected)
                ac[p] += outcome.dosage
                an[p] += outcome.alleles
                if outcome.refusal is not None:
                    refusals[(populations[p], outcome.refusal)] += 1
            site = SiteCounts(chrom, pos, ref, alt, None if rsid == "." else rsid, tuple(ac), tuple(an))
            if tally.record_pass(site, refusals, populations):
                sites.append(site)
        except RecountError as error:
            where = ":".join(fields[:2])
            raise RecountError(f"{where}: {error}") from error
    return tuple(sites), tally
