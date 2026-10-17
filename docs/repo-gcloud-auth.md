# Repository-local gcloud authentication

GenomeOS keeps its Google Cloud SDK state separate from the user-wide gcloud
configuration by setting:

```text
CLOUDSDK_CONFIG=.local/gcloud/genomeos
```

Use the wrapper for every GenomeOS authentication, configuration, deployment,
and Cloud Run/Cloud SQL inspection command:

```bash
python scripts/gcloud_repo.py auth login
python scripts/gcloud_repo.py init --account YOUR_GOOGLE_ACCOUNT --project YOUR_GENOMEOS_PROJECT
python scripts/gcloud_repo.py run auth list
python scripts/gcloud_repo.py run config list
```

No account identity or project is stored in Git. Pass `--account` and `--project` to `init`,
or set the local `GENOMEOS_GCP_ACCOUNT` and `GENOMEOS_GCP_PROJECT` environment variables.

## What may and may not be committed

- **May be committed:** the URL and name of a **public, read-only** bucket. The public data store's
  base URL is committed in `genomeos/publication/data_release.py` (owner decision, 2026-10-17; data
  store design 2026-10-17 §3 C8). Its URL is public by construction, and committing it is how a reader
  finds the data. Where a committed value exists, it is the truth: a variable or flag naming a
  different bucket or URL is refused, not followed.
- **May never be committed:** project ids and project numbers, account identities (emails),
  credentials of any kind (access tokens, application-default credentials, service-account keys), and
  the names of private buckets.

`tests/test_web_layout.py::test_no_concrete_bucket_url_is_tracked` enforces the bucket half. It exempts
exactly the committed public data-store URL, and no other bucket or URL form.

Credentials and Cloud SDK state live under ignored `.local/gcloud/genomeos/`.
Never commit that directory, access tokens, application-default credentials, or
service-account keys. Plain `gcloud` continues to use the global configuration, so this wrapper
does not log out or modify accounts outside the repository-local SDK configuration.
