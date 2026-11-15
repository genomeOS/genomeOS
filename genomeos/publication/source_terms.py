"""Reviewed terms for the sources a data-store release cites (data store design 2026-10-17 §5; Atlas data
platform design 2026-10-18 §2.1, §9).

The terms of each source with no machine-readable record under ``data/``. ``build_data_release.py`` copies
them into a manifest's ``sources`` block, and ``raw_harvests`` refuses a harvest whose source is not
listed here, so this module imports nothing from ``scripts/``. Each value is copied from the place named
in ``recorded_in``; where the repository records no check, the status is ``not_checked`` and the gap is
stated rather than filled (AGENTS publication-evidence safeguards). No I/O.
"""

from __future__ import annotations

from typing import Any

REVIEWED_SOURCES: dict[str, dict[str, Any]] = {
    "afnd": {
        "name": "Allele Frequency Net Database (AFND)",
        "citation": (
            "Gonzalez-Galarza et al., Allele frequency net database (AFND) 2020 update, Nucleic Acids "
            "Research 48:D783, doi:10.1093/nar/gkz1029"
        ),
        "url": "https://www.allelefrequencies.net/",
        "terms": {
            "status": "no_restriction_found",
            "checked_at": "2026-08-25",
            "terms_url": "https://www.allelefrequencies.net/contact.asp",
            "recorded_in": "https://github.com/genomeOS/genomeOS/issues/117",
            "note": (
                "AFND publishes no standalone licence; under the owner-approved policy (#149) a "
                "completed check that finds no explicit restriction is no_restriction_found."
            ),
        },
        "non_commercial": False,
    },
    "map": {
        "name": "Malaria Atlas Project (MAP) HbS and G6PD survey databases",
        "citation": (
            "Piel et al., Global epidemiology of sickle haemoglobin in neonates, The Lancet 381:142 "
            "(2013); Howes et al., G6PD deficiency prevalence and estimates of affected populations in "
            "malaria endemic countries, PLoS Medicine 9:e1001339 (2012)"
        ),
        "url": "https://data.malariaatlas.org/",
        "terms": {
            "status": "no_restriction_found",
            "checked_at": "2026-10-18",
            "terms_url": "https://malariaatlas.org/open-access-policy/",
            "recorded_in": "docs/research/hbs-piel-parity-2026-09-16.md",
            "note": (
                "MAP's open-access policy covers all its survey data, HbS and G6PD layers alike: the "
                "data are not owned by MAP, public survey data have no restrictions to access or use, "
                "and users are asked to cite the original sources. The owner approved open "
                "redistribution of the HbS survey rows on 2026-10-18 (the 2026-09-16 parity input)."
            ),
        },
        "non_commercial": False,
    },
    "worldpop": {
        "name": "WorldPop gridded population (the surface target grid)",
        "citation": "WorldPop, University of Southampton. doi:10.5258/SOTON/WP00647",
        "url": "https://hub.worldpop.org/",
        "terms": {
            "status": "explicitly_open",
            "checked_at": "2026-11-14",
            "terms_url": "https://hub.worldpop.org/",
            "licence": "CC-BY-4.0",
            "recorded_in": "docs/audits/worldpop-commercial-use.md",
            "note": (
                "WorldPop's hub states that WorldPop datasets are licensed under CC BY 4.0, recorded "
                "as explicitly_open by the owner's decision D5b (2026-10-19; "
                "docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md §1.1). WorldPop "
                "selects the population-positive H3 cells a format-2 surface is predicted on."
            ),
        },
        "non_commercial": False,
    },
    "genomeos": {
        "name": "genomeOS project-authored data and outputs",
        "url": "https://github.com/genomeOS/genomeOS",
        "terms": {
            "status": "explicitly_open",
            "checked_at": "2026-10-19",
            "terms_url": "https://creativecommons.org/licenses/by/4.0/",
            "licence": "CC-BY-4.0",
            "recorded_in": "README.md",
            "note": (
                "Project-authored data and outputs are CC BY 4.0 by the owner's decision D5a "
                "(2026-10-19; docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md §1.1). "
                "Apache-2.0 covers source code and documentation."
            ),
        },
        "non_commercial": False,
    },
    # The whole-genome lookup set's source (§9, step 1.8): counts and population coordinates only.
    "gnomad_hgdp_1kg": {
        "name": "gnomAD v3.1.2 HGDP + 1KG callset",
        "citation": "Koenig et al. (2024), Genome Research; https://pmc.ncbi.nlm.nih.gov/articles/PMC11216312/",
        "url": "https://gnomad.broadinstitute.org/",
        "terms": {
            "status": "explicitly_open",
            "checked_at": "2026-09-15",
            "terms_url": "https://gnomad.broadinstitute.org/policies",
            "licence": "CC0-1.0",
            "recorded_in": "docs/audits/gnomad-dbsnp-commercial-use.md",
            "note": (
                "Primary data CC0. Users agree to not attempt to reidentify participants; bundled "
                "annotations such as SpliceAI are CC BY-NC, so only counts and population coordinates "
                "are taken. Do not use 'gnomAD' or 'Genome Aggregation Database' in a tool's name, or "
                "the logo, without permission."
            ),
        },
        "non_commercial": False,
    },
    # The external caches under store/external/<source>/ (§4.3, step 1.8). Each status, checked_at,
    # terms_url and recorded_in copies the commercial_use block website/src/atlas/public-artifacts.json
    # gives the cache; each block's restricted_fields is empty, and raw_harvests.check_external_cache
    # refuses a known non-commercial field, so none of the three is non_commercial.
    "gnomad": {
        "name": "gnomAD browser API (cached variant records)",
        "url": "https://gnomad.broadinstitute.org/",
        "terms": {
            "status": "explicitly_open",
            "checked_at": "2026-09-15",
            "terms_url": "https://gnomad.broadinstitute.org/policies",
            "licence": "CC0-1.0",
            "recorded_in": "docs/audits/gnomad-dbsnp-commercial-use.md",
            "note": (
                "Primary data CC0; users agree to not attempt to reidentify participants. Annotations "
                "with terms of their own, such as SpliceAI (CC BY-NC), are never published in a cache."
            ),
        },
        "non_commercial": False,
    },
    "dbsnp": {
        "name": "NCBI dbSNP RefSNP API (cached variant records)",
        "url": "https://www.ncbi.nlm.nih.gov/snp/",
        "terms": {
            "status": "no_restriction_found",
            "checked_at": "2026-09-15",
            "terms_url": "https://www.ncbi.nlm.nih.gov/home/about/policies/",
            "recorded_in": "docs/audits/gnomad-dbsnp-commercial-use.md",
            "note": (
                "NCBI places no restrictions on the use or distribution of its molecular data, but grants "
                "no permission, since submitters may hold rights; the cache holds identifiers and "
                "coordinates only."
            ),
        },
        "non_commercial": False,
    },
    "alphagenome": {
        "name": "AlphaGenome Variant Impact (AVI) score (cached Atlas lookups)",
        "url": "https://deepmind.google.com/science/alphagenome/atlas",
        "terms": {
            "status": "explicitly_open",
            "checked_at": "2026-09-10",
            "terms_url": "https://deepmind.google.com/science/alphagenome/terms",
            "recorded_in": "docs/audits/alphagenome-avi-licensing.md",
            "note": (
                "The AlphaGenome Services Additional Terms let the AVI Score be used commercially. The "
                "AVI Score Feature Breakdown (top_attributions) is non-commercial and is never published "
                "in a cache."
            ),
        },
        "non_commercial": False,
    },
}
