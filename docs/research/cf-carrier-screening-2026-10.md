# CF carrier-screening truth for golden test 3 - October 2026

**Implementation target:** the truth side of §8's third golden test, `Task 34` in
[`2026-08-22-atlas-data-foundation.md`](../superpowers/plans/2026-08-22-atlas-data-foundation.md), which was
a one-line stub before this note. This note adds the target data and its checks; it does not add the
comparison, which needs an estimate to compare against and does not exist for CF.

**Scientific objective:** reproduce screening-derived CF carrier frequencies from healthy-reference panel
data, which is the only §8 test that exercises the §7.1 ascertainment correction. **Measurable output:** a
frozen, versioned truth table with a declared design for every row, plus a parity column that excludes the
rows a single-variant estimate cannot be scored against. **Engineering boundary:** a reference module and a
CSV, no inference, no surface, no serving-path change. **Assumptions and consumers:** the rows are
abstract-level and closed access; they enter the literature-evidence contract as
`automated_proposal`/`pending`, and CF is not a surface candidate ([#180](https://github.com/genomeOS/genomeOS/issues/180), [#3](https://github.com/genomeOS/genomeOS/issues/3)).

## Source and reading record

Five papers, each retrieved as a Europe PMC abstract record on **2026-10-23** through the REST search API
(`resultType=core`). All five are `isOpenAccess: N` and none is in PMC, so the abstracts were what we had.

**Castellani 2009 was then read in full**, from the authors' own institutional copy in the Ca' Foscari
repository (IRIS, handle [`10278/3757472`](https://hdl.handle.net/10278/3757472)), which is a green
open-access copy: 7 pages, 39,068 characters, retrieved 2026-11-08 as a 297,772-byte PDF and never
committed. That is why its two rows carry `reading_level = full_text` and the other four do not.

| Read | Not read |
|---|---|
| Abstract text, title, author list, journal, year, PMID and DOI for each of the five | Full texts of Kapoor 2006, Raskin 2008, Roqué 2001 and Archibald 2018 |
| Castellani 2009 in full, including Table 2 and the methods paragraph on the mutation panel | Any page locator for the four abstract-level rows |

**What the full text changed, which is the reason to say this out loud.** The abstract prints counts, so
the two Italian rows were originally marked `computed`: this note divided 314 by 2,559 and 3,650 by 87,025.
The paper prints the carrier rate itself, as **1 in 8.1** in the west and **1 in 23.8** in the east, so
both rows are `published` and the raw division is kept in the note on each row. The paper also states that
the **mutation panel widened during the 1993-2007 study period** and that this would raise sensitivity, so
the two regions are not measured with one constant test across the whole period. And it reports no
F508del-specific figure anywhere, which is why both rows stay panel totals.

**One candidate row was dropped rather than inferred.** A Romanian random sample (415 adults, 1 in 32, *Rev
Rom Med Lab* 2021) appears in the scoping discussion on #47. It is not indexed in Europe PMC, PubMed or
Crossref by any route tried, so it cannot be read, and a row that cannot be read is not a row. It stays out
until somebody obtains the PDF.

## What the papers report

The counted column is the paper's; the frequency column is marked `published` where the paper prints a
frequency and `computed` where this note divided the paper's counts.

| Place | Design, in the paper's words | n | F508del carriers | Frequency | Source |
|---|---|---|---|---|---|
| Delhi | 955 consecutive deliveries, cord blood, Dec 1999 to Nov 2000 | 955 | **4** | **1 in 238 (0.42%)** published; gene frequency 1 in 477 | Kapoor 2006, PMID 16311077 |
| Brazil, five states | newborns of white parentage, F508del genotyped alone | 2,683 | not printed | **2.3%** published, incidence 1 in 7,576; 48% of CF alleles | Raskin 2008, PMID 17544945 |
| Mendoza | 1,000 asymptomatic individuals, 100 pools of 10 | 1,000 | not printed (pooled) | **2.1%** published (95% CI 1.3-3.2) | Roqué 2001, PMID 11462248 |
| NE Italy, east | offered to relatives, infertile couples, reproductive-age couples | 87,025 | 3,650 | **4.19%** computed; 82 carrier couples | Castellani 2009, PMID 20009057 |
| NE Italy, west | offered only to relatives and to IVF couples | 2,559 | 314 | **12.27%** computed; 9 carrier couples | Castellani 2009, PMID 20009057 |
| Victoria | offered through GP, obstetrics, fertility and genetics | 12,000 | **342 CF** | **2.85%** computed; CFTR panel, not F508del | Archibald 2018, PMID 29261177 |

## The three properties that change how §8 must be scored

**1. A panel total is not a carrier frequency.** Victoria's 342 is a CFTR panel count, and NE Italy's are
panel counts too. A panel total always exceeds any single variant inside it: in a North American referral
population F508del's share of detected carriers fell from **68.7%** on a 32-mutation panel to **60.5%** on a
69-mutation panel (doi:10.1038/gim.2013.188). Scoring a single-variant estimate against a panel total would
score the panel. The table marks which rows are F508del-specific, and `f508del_specific_rows()` is the parity
column.

**2. NE Italy is a route contrast, not two estimates of one frequency.** Same area, same neonatal
surveillance, same years, 4.19% against 12.27%, a **2.93x** gap, and the paper attributes it to who was
offered a test. The rows stay separate; pooling them would average a contrast into a frequency.

**3. `frequency_source` records what was divided by whom.** Delhi, Brazil and Mendoza print a frequency. NE
Italy and Victoria print counts, and their frequencies are computed here. Anyone re-deriving this table from
the abstracts will not find 4.19% or 12.27% printed anywhere, and that absence is not a transcription error.

## Arithmetic this note performed, checked

- Delhi: 4 / 955 = 0.4188%, which is 1 in 238.75, printed as 1 in 238. Their gene frequency (1 in 477) is the
  carrier frequency halved, as Hardy-Weinberg requires.
- Raskin: a 2.3% carrier frequency implies a disease incidence of 1 in 7,569 under Hardy-Weinberg, against
  the 1 in 7,576 the paper reports. The two are the same number.
- Castellani: 195 CF cases in 779,631 newborns is **1 in 3,998** for the whole surveillance area, which the
  abstract does not state. 314/2,559 and 3,650/87,025 give the two rates above.
- Archibald: 342 / 12,000 = 2.85%, which is 1 in 35.1. The 610 carriers in 12,000 (1 in 20) is the combined
  figure across CF, fragile X and SMA, not a CF number, and the F508del share of the 342 is in the full text.
- Roqué: 2.1% of 1,000 implies about 21 carriers, and the count is not printed because pools were screened.

## What this table does not establish

It is not a population carrier-frequency map. The published geographic map of CF is patient-denominated:
share of CF patients carrying F508del by country, from national registries. Row for row, this table cannot be
extended into a surface, which is the conclusion #180 reached independently and why #3 grades CFTR2 G1.

It is also abstract-level. No row has a page locator, the F508del share of Victoria's carriers is unknown,
and the Italian rates are the paper's counts divided here. Under the literature-evidence contract every row
is `automated_proposal`/`pending` until a full text is read.

## One schema question, raised rather than settled

The closed `sampling_design` set in [`literature-evidence-curation.md`](../literature-evidence-curation.md)
is `population_random`, `healthy_reference`, `clinical_case`, `clinical_control`, `newborn_screening`,
`carrier_screening`, `convenience`. Delhi, Brazil and Mendoza are unselected samples that are not screening
programmes, and no value says that. `population_random` is the nearest and is used provisionally, with the
paper's own words in `design_detail`. If the distinct concept matters, that is a schema change and should be
decided on the issue rather than assumed by a data row.

The row fields here are the ones the parity test needs, and they are a proposal rather than a contract:
`place_id`, `place`, `iso3`, `design_class`, `design_detail`, `n_tested`, `carriers_f508del`,
`count_is_f508del_specific`, `frequency_source`, `carrier_frequency`, `ci_lower`, `ci_upper`, `source_pmid`,
`source_doi`, `reading_level`, `note`.

## Files

| File | What it is |
|---|---|
| `reference/carrier_screening_truth.csv` | the six rows |
| `genomeos/reference/carrier_screening.py` | loader, closed vocabularies, the parity-column filter |
| `tests/test_carrier_screening_reference.py` | 14 checks: shape, arithmetic, plausibility, refusals |

Advances [#47](https://github.com/genomeOS/genomeOS/issues/47). Does not close it: the comparison and the
full-text upgrade are still open.
