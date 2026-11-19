# Atlas web data format

## TL;DR

The Python publication pipeline writes the data the website's Atlas reads. That shared data format
has one version: `format_version` in `catalog.json`, written as `"MAJOR.MINOR"`. It is `1.0` today.

- A **MINOR** change only adds things an older client can safely ignore.
- A **MAJOR** change is anything else.
- The site refuses a catalog of a MAJOR it doesn't know. It reads a newer MINOR and ignores the keys
  it doesn't know.
- Nothing already in the public bucket is ever rewritten.

This page amends fast-load design 2026-10-07 §B.4
([spec](superpowers/specs/2026-10-07-atlas-mobile-fast-load-gcs-design.md)). The issue is
[#467](https://github.com/genomeOS/genomeOS/issues/467).

---

## What the format covers

Everything below is written by Python and read by the website. Each part except the catalog already
had its own version slot before #467. Those slots stay as they are, and the format MAJOR fixes their
values.

| Part | Where it lives | Written by | Read by | Its own slot (format 1) |
|---|---|---|---|---|
| `catalog.json` | committed; inlined into `/app/` | `export_atlas_web.py`, then `encode_atlas_web.py` | `parseAtlasCatalog` (`website/src/atlas/contracts.ts`) | `format_version`, the format version |
| GOSA grid, render and detail objects | bucket | `genomeos/publication/surface_codec.py` | `website/src/atlas/gosa/` | container u16 `format_version` = 1; header `schema_version` = 1 |
| Surface and observations JSON | bucket (the site fetches the observations; the surface is a download) | `export_atlas_web.py` | `observationArtifactSchema` (`surfaceArtifactSchema` describes the download) | `schema_version` = 1 |
| Manifest JSON | bucket (download only) | copied from the P2 artifact by `export_atlas_web.py`, less `observations.path`, which names a data-store file (#45; `genomeos/publication/web_inputs.py`) | not parsed by the site | the P2 manifest contract |
| External caches, `external/<source>/*.json` | committed | `fetch_external_variant_info.py`, copied by the exporter | `externalInfoSchema` | `schema_version`: gnomAD 2, dbSNP 1, AlphaGenome 1 |
| Natural Earth borders, `ne-50m-admin-0.borders.bin` | committed | `scripts/encode_natural_earth_borders.py` | `website/src/atlas/geometry/natural-earth-codec.ts` | GOBD u16 `format_version` = 1 |
| Data keys, digests, the two bases | the catalog | `genomeos/publication/web_layout.py` | `website/src/lib/data-url.ts` | — |

## Where the version lives, and why there

`catalog.json` carries `"format_version": "MAJOR.MINOR"`: two non-negative integers, ASCII digits,
no leading zeros. Each side has one constant:

- Python: `WEB_FORMAT_VERSION` in [`genomeos/publication/web_format.py`](../genomeos/publication/web_format.py)
- TypeScript: `ATLAS_WEB_FORMAT_VERSION` in [`website/src/atlas/format-version.ts`](../website/src/atlas/format-version.ts)

Two cross-language tests make them agree: `tests/test_web_format.py` and
`website/tests/atlas-format-version.test.ts`. Agreeing means:

- **Same MAJOR.**
- **The client's MINOR is never ahead of the producer's.** The producer may be a MINOR ahead, which
  is the point: a MINOR change doesn't force a client change.

The deployed catalog must declare exactly the Python constant.

**Why the catalog.** It's the one entry point: every other object is reached through a key and a
sha256 the catalog names. The catalog is also committed and deployed with the site (§B.4 ruling),
so the client and its catalog always ship together, and changing the version never needs a bucket
write.

**Why not the binary headers.** GOSA and GOBD already have u16 slots, and those slots version their
own container layout. Writing the format version into them would change every object's bytes and
therefore its sha256 and key. Every format bump would then mean re-encoding and re-uploading the
bucket. The immutable, content-addressed layout (§C.2) exists to forbid exactly that.

So the slots stay per-object. Each format MAJOR fixes what every slot must hold (the table above),
and the decoders keep refusing any other value. `tests/test_web_format.py` pins the Python slot
constants to the current MAJOR's row. The golden `.gosa` fixtures and the mutation corpus, shared
byte for byte with the website tests, hold the TypeScript decoders to the same slots.

## The compatibility rule

| Reader | Same MAJOR, same or older MINOR | Same MAJOR, newer MINOR | Another MAJOR | Missing or malformed |
|---|---|---|---|---|
| Browser and `/app/` build (`parseAtlasCatalog`) | strict schema: an unknown key is an error | read; unknown keys in catalog objects are ignored, every known field is still validated, and the build prints a warning | `AtlasFormatVersionError`; the build fails | refused |
| Python writers (`export_atlas_web.py`, `encode_atlas_web.py` and the fixture builders that go through it) | must be exactly the current version | refused | refused | refused |
| Python enumerators (`web_layout`, used by `publish_atlas_web.py` and `check_atlas_web_data.py`) | read | refused: it may name objects they can't enumerate | refused | refused |

**There is no default.** A catalog without `format_version` is refused everywhere; it's never read
as `1.0`. Catalogs from before #467 carried `schema_version: 1` instead. None of them is served any
more: the catalog is inlined into the page at build time, so an old page carries its own old catalog
and its own old client.

## MAJOR or MINOR?

The test for a **MINOR** is that an older client which drops your addition still shows correct
science. That allows two things:

- a new key in a catalog object (top level, an artifact ref, a grid entry, `web`, a download entry,
  a discovery group or reference, an external-resource entry), added as optional on the client;
- a new object that only a client which knows the new key will fetch.

**MAJOR** is everything else, including:

- removing or renaming a catalog key; changing its type, unit, meaning or nullability; making an
  optional key required;
- a new value in a closed set, such as a support state, `artifact_format`, `entity_type`,
  `measurement` or external-resource `source`. An older client would reject the value, or misread
  it. `support_counts` is checked so that a new state can't be ignored as an unknown key;
- any change to a per-object format: GOSA container layout, header, columns, dtypes or encodings;
  surface or observations JSON; an external-cache schema; GOBD. Those decoders are exact by design
  (§B.3 hard errors), so they have no MINOR;
- a change to how existing values are read: decoded versus transport bytes, the data-key rule, how
  keys resolve against the two bases.

If you're not sure, it's MAJOR.

## How to bump

**MINOR.** In Python only:

1. Add the key in the exporter or encoder.
2. Raise the MINOR of `WEB_FORMAT_VERSION`.
3. Re-export and re-encode (`docs/data-store.md`), and commit the new `catalog.json`.
4. Regenerate the golden fixtures: `python tests/fixtures/atlas-web/regenerate.py`. The e2e and
   parity fixture catalogs may stay a MINOR behind, since clients have to read older MINORs anyway.
   Rebuild them when a test needs the new key.

The site keeps building, with a warning that it ignores the new key. When the client wants the key:

1. Add it to the zod schema as `.optional()`, because older catalogs of the same MAJOR don't have it.
2. Raise `ATLAS_WEB_FORMAT_VERSION` to match.

**MAJOR.** Both sides change in one pull request:

1. Raise the MAJOR in both constants and reset the MINOR to 0.
2. Add the new MAJOR's row to `PINNED_OBJECT_VERSIONS` in `tests/test_web_format.py`. Never edit the
   row of a MAJOR that has been deployed.
3. Change the client contract.
4. Re-export, re-encode and publish (`publish_atlas_web.py`), and commit the catalog.

A MAJOR that changes object bytes publishes them under new content-addressed keys, next to the old
ones.

## Why already-published objects stay valid

Published bucket objects are immutable, content-addressed and never deleted (§C.2), so a format
change never touches them.

- **A version bump doesn't touch the bucket.** The version lives only in the committed catalog. The
  1.0 rollout (#467) changed one line of `catalog.json`, `schema_version: 1` → `format_version: "1.0"`.
  Every object key and digest stayed the same, so the deploy gate passes against the objects already
  published.
- **Objects carry no format version of their own.** An object is valid under a format because a
  catalog of that format names it by sha256, and its own slots hold the values that MAJOR pins.
  Format 1.0 is exactly what was already published, so every existing object is a valid format-1
  object as it stands.
- **A MINOR bump leaves every existing key in place.** A newer catalog references the same objects,
  plus any new ones.
- **A MAJOR bump never overwrites.** The new catalog names new keys, and the old objects stay
  published for pages that still reference them. A page's HTML inlines its own catalog, so a cached
  old page keeps fetching objects that still exist.
