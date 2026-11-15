# WorldPop — commercial-use check

## TL;DR

WorldPop's data may be used commercially, with attribution. Its hub and the landing page of the DOI we
cite both state that WorldPop datasets are licensed under **CC BY 4.0**. The catalogue records of the
two WorldPop datasets our grid uses name the same licence. That is an explicit licence that permits
commercial use, so WorldPop is recorded as `explicitly_open`, which the owner decided in D5b.

The pages were read on **2026-11-14**. The record covers the 62 objects of release 2026-10-18 that
list `worldpop` as a source: 85.8% of that release's bytes.

Two things to carry forward:

- Our citation names one of the two WorldPop datasets the grid is built from. The Cook Islands
  supplement (doi:10.5258/SOTON/WP00660) is not cited.
- WorldPop says that datasets derived from OpenStreetMap or Microsoft's building and road data are
  ODbL, not CC BY 4.0. The records of both datasets we use name CC BY 4.0.

---

## What we use

Each of the 30 artifacts in the website catalogue (`website/public/data/atlas/catalog.json`) gives
the same `target_grid_version`, which names two WorldPop rasters:

| Dataset | Catalogue id | DOI | File |
|---|---|---|---|
| The spatial distribution of population in 2020 (global 1 km mosaic) | 24777 | 10.5258/SOTON/WP00647 | `Global_2000_2020/2020/0_Mosaicked/ppp_2020_1km_Aggregated.tif` |
| The same for 2020, Cook Islands, adjusted to the UNPD total (100 m) | 25910 | 10.5258/SOTON/WP00660 | `Global_2000_2020/2020/COK/cok_ppp_2020_UNadj.tif` |

The grid picks the population-positive H3 cells a surface is predicted on. No WorldPop pixel value
is published: an artifact's cells carry no population column. The 62 objects are the
`cells.parquet` and `manifest.json` of 31 artifacts in `store/artifacts/` (30 at `v3`, plus the
`v2` HbS surface); 56 of them also cite AFND, and 6 cite MAP.

## The pages, as read on 2026-11-14

Each page was fetched at 19:16 US Eastern.

### https://hub.worldpop.org/

The site footer links to https://creativecommons.org/licenses/by/4.0/ (`rel="license"`):

> © 2026 WorldPop datasets are licensed under the Creative Commons Attribution 4.0 International
> License

### https://doi.org/10.5258/SOTON/WP00647

The DOI redirects to https://hub.worldpop.org/doi/10.5258/SOTON/WP00647. The page gives the
citation and carries the same footer, with the same link:

> © 2026 WorldPop datasets are licensed under the Creative Commons Attribution 4.0 International
> License

The page has no licence field for this dataset alone. The statement is the site-wide one.

### Supporting records

The REST catalogue that `scripts/fetch_worldpop.py` reads gives each dataset a `license` field.
For both datasets above (https://hub.worldpop.org/rest/data/pop/wpgp1km?id=24777 and
https://hub.worldpop.org/rest/data/pop/wpgpunadj?id=25910), it is
https://hub.worldpop.org/data/licence.txt. That file begins (sha256
`cb0b6ac8fb7d24e900d3bcba5474cf022a6fef3646fa5b94e6019b54f63be25f`):

> WorldPop datasets are licensed under the Creative Commons Attribution
> 4.0 International License
>
> https://creativecommons.org/licenses/by/4.0/

The rest of the file is the CC BY 4.0 legal code. It names no other licence and no other condition.

The dataset's own page (https://hub.worldpop.org/geodata/summary?id=24777) spells out what the
licence allows:

> WorldPop datasets are available under the Creative Commons Attribution 4.0 International License.
> This means that you are free to share (copy and redistribute the material in any medium or format)
> and adapt (remix, transform, and build upon the material) for any purpose, even commercially,
> provided attribution is included (appropriate credit and a link to the licence).

## Finding — `explicitly_open`

WorldPop names a licence, and that licence grants commercial use in so many words ("for any
purpose, even commercially"). That is an explicit grant, so the finding is `explicitly_open`, not
`no_restriction_found`. The latter is for a check that finds no restriction but also no licence
(AFND, MAP, dbSNP).

### Two statements on the dataset page that are not the licence

The same page carries two more paragraphs. Neither is in `licence.txt`.

> This data is not intended, and should not be used, for purposes that discriminate against,
> exploit, surveil, or otherwise harm individuals or vulnerable populations; users are expected to
> apply it responsibly, assess the risks of their own analyses (particularly when combining it with
> other datasets) and are solely responsible for how they use it.

A statement of expected use, not a licence condition. Recorded so it is not lost.

> WorldPop datasets derived from OpenStreetMap, Microsoft Building Footprints or Microsoft Roads
> Detection are available under the Open Database License (ODbL). This means you are free to share
> the data, provided attribution is included (appropriate credit and a link to the license). If you
> alter or build upon the data, you may distribute the result only under the same ODbL license.

The page does not say which datasets this covers. The catalogue records of both datasets we use name
`licence.txt`, which is CC BY 4.0 alone. This check did not look at which inputs WorldPop's models
used.

## Attribution

CC BY 4.0 asks for credit to the creator, a link to the licence, and a note if the material was
changed. Every door shows the manifest's `sources` block (design 2026-10-18 §9). For WorldPop that
block carries:

- `name`: WorldPop gridded population (the surface target grid);
- `citation`: WorldPop, University of Southampton. doi:10.5258/SOTON/WP00647;
- `url` and `terms.terms_url`: https://hub.worldpop.org/, whose footer links the licence;
- `terms.licence`: `CC-BY-4.0`;
- `terms.note`: how WorldPop was used (it selects the cells a surface is predicted on).

WorldPop's recommended citation for WP00647 is longer:

> WorldPop (www.worldpop.org - School of Geography and Environmental Science, University of
> Southampton; Department of Geography and Geosciences, University of Louisville; Departement de
> Geographie, Universite de Namur) and Center for International Earth Science Information Network
> (CIESIN), Columbia University (2018). Global High Resolution Population Denominators Project -
> Funded by The Bill and Melinda Gates Foundation (OPP1134076).
> https://dx.doi.org/10.5258/SOTON/WP00647

## D5b

The owner decided on 2026-10-19 to "Record WorldPop as `explicitly_open` from its hub's CC BY 4.0
statement, by an evidence PR" (`docs/superpowers/specs/2026-10-18-atlas-data-platform-design.md`
§1.1). This file is that evidence. It moves `REVIEWED_SOURCES["worldpop"]["terms"]` in
`scripts/build_data_release.py` from `not_checked` to `explicitly_open`, with `licence` `CC-BY-4.0`.
Under the design's terms table (§9), WorldPop's objects may then use every door: free, Google-billed,
prepaid and sponsor mirror.

Releases 2026-10-17 and 2026-10-18 keep `not_checked`. A manifest is immutable once published, so
the new terms appear from the next release on.

## What a reviewer should confirm

An agent read these pages and recorded what they say. The quotes above let a person check them
without visiting the sites. What a person may want to confirm:

- that the hub's site-wide footer, together with each dataset's `license` field, is enough to cover
  the two datasets we use, given that the DOI page has no licence field of its own;
- that the ODbL sentence does not reach the 2020 mosaics, whose records name CC BY 4.0 alone;
- whether the citation should also name doi:10.5258/SOTON/WP00660 (the Cook Islands supplement), and
  whether the note says plainly enough that the objects are derived from WorldPop's rasters.
