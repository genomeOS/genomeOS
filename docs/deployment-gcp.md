# GCP deployment

GenomeOS is intended to run on Cloud Run with Cloud SQL for PostgreSQL. The
deployment account must be supplied locally through `--account` or `GENOMEOS_GCP_ACCOUNT`;
do not deploy into a project
owned by another active account.

## Required setup

Authentication and configuration are repository-local. Follow
[`repo-gcloud-auth.md`](repo-gcloud-auth.md) and use:

```bash
python scripts/gcloud_repo.py auth login
python scripts/gcloud_repo.py init --project YOUR_GENOMEOS_PROJECT
```

Do not use plain `gcloud` for GenomeOS operations; it belongs to the global
configuration used by other repositories.

Enable Cloud Run, Cloud Build, Artifact Registry, Cloud SQL Admin, Secret
Manager, and Service Networking APIs. Create a PostgreSQL 17 Cloud SQL instance,
database, least-privilege application user, and store its password in Secret
Manager. Prefer the Cloud SQL connector over a public database address.

The application container accepts:

```text
DATABASE_URL
PANUKB_REGION_QUERY_ENABLED
PANUKB_REGION_MAX_ROWS
```

The active local GCP configuration must be verified before every deployment.
Infrastructure creation is intentionally not hidden inside the application
startup process.

`cloudbuild.yaml` builds the image in Artifact Registry. Supply an immutable
`_TAG` (normally the Git commit SHA) for manual builds; the default `diagnostic`
tag is only for the synthetic preview. The Cloud Run template
at `deploy/cloudrun-service.yaml` contains explicit placeholders for the project,
region, Cloud SQL instance, service account, image tag, artifact bucket, and
artifact version. Replace and review those values before applying it; never
deploy the template verbatim. The runtime identity needs `roles/storage.objectViewer`
on that bucket.

The image contains the tiny checked-in synthetic catalog at
`/app/demo/artifacts` so `/preview` can prove the container read path. Set
`ATLAS_ARTIFACT_ROOT=/app/demo/artifacts` only for a diagnostic deployment and
never present those fixtures as scientific results. Production requires an
explicit immutable artifact root and completion of the GCS work tracked in #33
and #49.

## GitHub Container Registry

After the `ci` workflow succeeds for a commit on `main`, the `container`
workflow publishes the API/read-path image for both `linux/amd64` and
`linux/arm64`. To pull an immutable revision, replace `sha-xxxxxxx` with its
seven-character commit tag:

```bash
docker pull ghcr.io/genomeos/genomeos:latest
TAG=sha-xxxxxxx
docker pull "ghcr.io/genomeos/genomeos:$TAG"
```

`latest` is the convenient discovery tag. Deployments must use the immutable
`sha-...` tag so a cited service revision cannot change underneath them. Tags
published before the repository moved to the genomeOS organization were not
copied; a revision cited from that period stays pullable at
`ghcr.io/bschilder/genomeos:sha-...`. Each
manifest includes OCI source and revision labels, an SBOM, and provenance
attestations. The image is only published after the same root Dockerfile has
passed the container HTTP smoke in `ci`.

If `docker pull` without a GitHub login is refused, check the package's
visibility. GitHub creates a new container package as private, and linking it
to the repository carries over access permissions but not visibility. An
organization owner makes it public under Package settings, then Danger zone.

Cloud Run mounts the artifact bucket read-only at `/mnt/atlas` in the second-generation
execution environment. Publish every version below `catalogs/<artifact-version>/`, upload
data objects before `manifest.json`, and set `ATLAS_ARTIFACT_ROOT` to that exact versioned
directory. Never point the service at a mutable bucket root.

## Public Atlas web bucket

The website's per-artifact Atlas data (encoded `.gosa` tiers and the canonical surface,
observations and manifest JSON) is served from a separate **public** bucket. It is not the private
artifact bucket above and does not replace #33's artifact staging and version pinning: it holds only
encoded site data under content-addressed keys below `atlas/web/`.

- `us-east1`, uniform bucket-level access, `allUsers` with `roles/storage.objectViewer`, no object
  versioning (keys are content-addressed), default soft delete. Published objects are never deleted.
- CORS comes from `deploy/atlas-web-cors.json`: `GET` and `HEAD` from the production origins and the
  local ports 4321–4323.
- `python scripts/provision_atlas_web_bucket.py --mode edge` (provisioned) serves the objects from
  Google's edge cache at `https://storage.googleapis.com/<bucket>/atlas/web/`. `--mode cloud-cdn`
  (scripted, not provisioned) adds a backend bucket with Cloud CDN behind a global external HTTPS load
  balancer with a Google-managed certificate for `data.genome-os.org`; it needs a DNS A record at the
  registrar (a human step) and has a recurring load-balancer cost.
- Provisioning reads and reports public-access prevention and the effective
  `iam.allowedPolicyMemberDomains`, `iam.managed.allowedPolicyMembers` and
  `storage.publicAccessPrevention` organization policies, and stops before changing anything when one
  would block public objects. It is idempotent and `--dry-run` prints every command: it reads nothing,
  so it always shows the new-bucket plan, and the live run still refuses an existing bucket it did not
  create.

The publish runbook is in [`data-store.md`](data-store.md#public-web-data-bucket).
