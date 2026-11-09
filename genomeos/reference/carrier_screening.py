"""Carrier-screening truth rows — the golden test 3 target (design §8, issue #47).

    Kapoor V, Shastri SS, Kabra M, et al. Carrier frequency of F508del mutation of cystic fibrosis
    in Indian population. J Cyst Fibros 2006. doi:10.1016/j.jcf.2005.10.002
    Raskin S, Pereira-Ferrari L, Reis FC, et al. Incidence of cystic fibrosis in five different
    states of Brazil as determined by screening of p.F508del. J Cyst Fibros 2008.
    doi:10.1016/j.jcf.2007.03.006
    Roqué M, Godoy CP, Castellanos M, et al. Population screening of F508del in Argentina.
    Hum Mutat 2001;18:167. doi:10.1002/humu.1173
    Castellani C, Picci L, Tamanini A, et al. Association between carrier screening and incidence
    of cystic fibrosis. JAMA 2009;302:2573-9. doi:10.1001/jama.2009.1758
    Archibald AD, Smith MJ, Burgess T, et al. Reproductive genetic carrier screening for cystic
    fibrosis, fragile X syndrome, and spinal muscular atrophy in Australia. Genet Med 2018.
    doi:10.1038/gim.2017.134

Six rows transcribed from the five abstracts, committed because §8's third golden test needs a
target citable at a fixed version, the same way `piel2013.py` fixes golden test 1's.

**Three properties of these numbers that change how the test must be scored.**

1. **Only three of the six rows are F508del carrier frequencies.** Delhi, Brazil and Mendoza
   genotyped F508del alone, so their frequencies are comparable with one another and with what a
   single-variant estimate produces. NE Italy and Victoria screened with a *panel*, and a panel
   carrier total runs higher than any single variant inside it: in a North American referral
   population F508del's share of detected carriers fell from 68.7% on a 32-mutation panel to 60.5%
   on a 69-mutation panel (doi:10.1038/gim.2013.188). Comparing a single-variant estimate against a
   panel total would score the panel, not the model. `count_is_f508del_specific` marks which is
   which, and `f508del_specific_rows` is the parity column.

2. **Two rows are a contrast between testing routes, not two estimates of one frequency.** NE Italy
   east screened infertile couples and couples of reproductive age; the west tested relatives of
   patients and couples planning IVF. The result is 4.19% against 12.27%, a 2.93x gap in the same
   area over the same years. They are kept as two rows so the contrast stays visible, and they
   should not be pooled.

3. **`frequency_source` separates what the paper printed from what was divided by us.** Delhi,
   Brazil and Mendoza publish a frequency. NE Italy and Victoria publish counts, and their
   frequencies here are `carriers / n_tested` computed at load time from those counts. A reader
   recovering this table from the abstracts will not find 4.19% or 12.27% printed anywhere, and
   should not conclude a transcription error when that search fails.

**Four rows are abstract-level and two are not.** Castellani 2009 was read in full from the authors'
own institutional copy (IRIS Ca' Foscari, handle 10278/3757472), which is a green open-access copy, so
its two rows carry `reading_level = full_text`. The other four papers are closed access with no
repository copy reachable from here, so those rows are abstract-level and carry no page locator. Every
row still enters the literature-evidence contract as `automated_proposal` / `pending`, because
`verified_by` has to be independent of the extractor. This is a *screening-derived truth set* for §8,
not an observation layer: CF has no surface to fit, because #180 excludes CFTR/F508del from surface
eligibility and #3 grades CFTR2 G1 for being patient-denominated.

**What the full text changed.** Two things, both of which a reader would otherwise get wrong from the
abstract alone. The paper prints the carrier rate itself, as **1 in 8.1** in the west and **1 in 23.8**
in the east, so those frequencies are published rather than divided by us. And the **mutation panel
widened during the 1993-2007 study period**, which the paper notes would raise sensitivity, so the two
regions are not being measured with one constant test. It also does not report F508del separately
anywhere, which is why both rows stay panel totals.

**One open schema question, raised here rather than settled silently.** The closed `sampling_design`
set in `docs/literature-evidence-curation.md` has no value meaning "unselected sample that is not a
screening programme". `population_random` is the nearest and is used for the three single-variant
rows; `design_detail` keeps the paper's own words. If the repo wants a distinct value, that is a
schema change and not a fact this table can decide.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import pandas as pd

CITATION = (
    "Kapoor 2006 doi:10.1016/j.jcf.2005.10.002; Raskin 2008 doi:10.1016/j.jcf.2007.03.006; "
    "Roque 2001 doi:10.1002/humu.1173; Castellani 2009 doi:10.1001/jama.2009.1758; "
    "Archibald 2018 doi:10.1038/gim.2017.134"
)

DATA_PATH = Path(__file__).resolve().parents[2] / "reference" / "carrier_screening_truth.csv"

REQUIRED_COLUMNS: tuple[str, ...] = (
    "place_id",
    "place",
    "iso3",
    "design_class",
    "design_detail",
    "n_tested",
    "carriers_f508del",
    "count_is_f508del_specific",
    "frequency_source",
    "carrier_frequency",
    "ci_lower",
    "ci_upper",
    "source_pmid",
    "source_doi",
    "reading_level",
    "note",
)

#: The closed set from `docs/literature-evidence-curation.md`, section `sampling_design`.
SAMPLING_DESIGNS: frozenset[str] = frozenset(
    {
        "population_random",
        "healthy_reference",
        "clinical_case",
        "clinical_control",
        "newborn_screening",
        "carrier_screening",
        "convenience",
    }
)

#: `published` means the paper prints the frequency; `computed` means carriers / n_tested, by us.
FREQUENCY_SOURCES: frozenset[str] = frozenset({"published", "computed"})


def read_truth_rows(path: Path) -> pd.DataFrame:
    """Load and validate the truth table at `path`.

    Validation is structural rather than statistical: the shape and the vocabularies are checked
    here, so a test failure later means a number moved rather than a column being renamed.
    """
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing")
    frame = pd.read_csv(path, keep_default_na=True)
    missing = [column for column in REQUIRED_COLUMNS if column not in frame.columns]
    if missing:
        raise ValueError(f"{path} is missing required columns: {', '.join(missing)}")
    if frame.empty:
        raise ValueError(f"{path} is empty")

    unknown_designs = sorted(set(frame["design_class"]) - SAMPLING_DESIGNS)
    if unknown_designs:
        raise ValueError(f"unknown design_class values: {', '.join(unknown_designs)}")
    unknown_sources = sorted(set(frame["frequency_source"]) - FREQUENCY_SOURCES)
    if unknown_sources:
        raise ValueError(f"unknown frequency_source values: {', '.join(unknown_sources)}")
    if frame["place_id"].duplicated().any():
        duplicated = sorted(frame.loc[frame["place_id"].duplicated(), "place_id"])
        raise ValueError(f"duplicate place_id values: {', '.join(duplicated)}")
    return frame


@lru_cache(maxsize=1)
def truth_rows() -> pd.DataFrame:
    """One row per screening programme: design, counts, frequency, and where it came from."""
    return read_truth_rows(DATA_PATH)


def f508del_specific_rows(frame: pd.DataFrame | None = None) -> pd.DataFrame:
    """The parity column: rows whose frequency is F508del alone, so comparable to one estimate.

    Panel totals stay in the table, because dropping them would hide the reason they cannot be
    compared. This function is how a scorer opts out of them.
    """
    frame = truth_rows() if frame is None else frame
    return frame.loc[frame["count_is_f508del_specific"]].reset_index(drop=True)
