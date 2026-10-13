---
title: GitHub Pages deployment
description: How the static genomeOS site is validated and published at genome-os.org through GitHub Actions.
sidebar:
  order: 8
  label: Deployment
---

The site is statically rendered. Pull requests validate it; only a push to `main` uploads and
deploys a GitHub Pages artifact.

## Build boundary

Production uses:

```text
site = https://genome-os.org
base = /
```

Fallback verification uses:

```text
site = https://genomeos.github.io
base = /genomeOS
```

Internal paths pass through one base-aware helper. Broken links, missing assets, type errors,
content-contract failures, or accessibility violations stop deployment.

## Atlas data boundary

The Pages artifact carries the site, the Atlas catalog (inlined into `/app/`), the Natural Earth
context files and the `external/` caches. Per-artifact web data — the `.gosa` grid, render and detail
objects and the canonical surface, observations and manifest JSON — is served from a public Google
Cloud Storage bucket under immutable, content-addressed keys:

```text
atlas/web/grids/h3-r{resolution}.{sha256[:16]}.gosa
atlas/web/surfaces/{id}/{model_version}/{data_version}/{render|detail}.{sha256[:16]}.gosa
atlas/web/downloads/{id}/{model_version}/{data_version}/{id}.{surface|observations|manifest}.{sha256[:16]}.json
```

Objects are stored gzip-encoded with `Cache-Control: public, max-age=31536000, immutable`, and their
decoded SHA-256 and size are object metadata. Downloads carry `Content-Disposition` so they save under
their canonical file names. Published objects are never replaced or deleted, because cached pages
keep referencing old keys.

The build reads the bucket base from `PUBLIC_ATLAS_DATA_BASE_URL`: an absolute `https://` URL that
ends in `atlas/web/`. The production build job takes it from the repository variable
`ATLAS_DATA_BASE_URL` and refuses to build without it; the deploy gate also reads the repository
variable `ATLAS_DATA_BUCKET`. Neither the bucket name nor the project is stored in the repository.

## Deploy gate

`scripts/check_atlas_web_data.py` runs before every deployment and on same-repository pull requests.
It refuses the deploy unless every object the catalog names answers with status 200,
`Content-Encoding: gzip`, the immutable `Cache-Control` and a CORS grant for each production origin;
its metadata records the catalog SHA-256 (and the decoded size wherever the catalog declares one); the
default map's grid, render tier and observations decompress to their catalog digests; and every
Natural Earth and external cache file is in the built site. A catalog that names objects before they
are published fails its deploy instead of shipping a broken map.

## Domain boundary

The repository Pages setting owns `genome-os.org`. Because Pages uses a custom Actions workflow,
GitHub ignores and does not require a repository `CNAME` file. DNS points the apex to GitHub's four
Pages IPv4 addresses, and `www` points directly to `genomeos.github.io`, the Pages host of the
<span class="brand-name">genomeOS</span> GitHub organization.

The organization verifies domain ownership with the `_github-pages-challenge-genomeos` TXT record.
The user-level record used before the repository moved to the organization has been removed.
**Enforce HTTPS** is on, so plain `http://` requests redirect to `https://genome-os.org`.

See the <a href="https://github.com/genomeOS/genomeOS/blob/main/docs/superpowers/specs/2026-09-05-docs-website-design.md" target="_blank" rel="noopener noreferrer">website design and deployment contract</a>.
