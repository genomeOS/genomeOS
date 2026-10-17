# Cost controls

**TL;DR.** The project has a $200 monthly budget. It emails the billing account's administrators
and users at 50%, 90% and 150% of actual spend, and at 100% of forecast spend. If actual spend
reaches **150%** ($300), a kill switch removes public access to the data-store bucket
(`genomeos-atlas-data`). Readers then get an error, and the bucket stays private until the owner
turns public access back on. The Atlas web-data bucket (`genomeos-atlas-web`) keeps serving and is
never touched. Nothing is deleted.

Owner decision: #480. Context: data store design 2026-10-17 §9.2 (egress and budget) and #473.

## The budget

| | |
|---|---|
| Name | `<project> monthly`, on the project's billing account |
| Amount | $200 per calendar month, this project only, credits included |
| Email thresholds | 50%, 90% and 150% of actual spend; 100% of forecast spend |
| Who gets the emails | Cloud Billing's default recipients: everyone with Billing Account Administrator or Billing Account User on the billing account. No other channel is configured. |
| Programmatic notifications | Pub/Sub topic `budget-notifications`, which triggers the kill switch |

Creating the budget and changing its amount, thresholds or recipients are owner steps. Use the
console (**Billing → Budgets & alerts**) or `gcloud billing budgets update`. The amount and
thresholds above are a record of what was set, not something code enforces. If you change them,
update this table.

Billing data lags actual usage by hours, so every threshold, the kill switch included, fires some
time after spend has crossed it, never at the moment it does.

## What the kill switch does

Cloud Billing publishes the budget's status to `budget-notifications` several times a day, whether
or not a threshold has been crossed. Each message triggers the Cloud Run function
`budget-kill-switch` (2nd gen, us-east1; code in [`deploy/budget-kill-switch/`](../deploy/budget-kill-switch/)).
For each message it does the following:

1. It reads `costAmount` and `budgetAmount` from the message itself, as exact decimals. The message's
   `alertThresholdExceeded` field is logged but never used for the decision.
2. While `costAmount < 1.5 × budgetAmount`, it does nothing, and does not even read the bucket.
3. At or above that, it reads the IAM policy of the bucket named in its `TARGET_BUCKET` (the
   data-store bucket). It removes every `allUsers` and `allAuthenticatedUsers` member from every
   binding and writes the policy back with the etag it read. Every other member, binding and
   condition stays. A bucket that has no public member is left alone, so repeated messages change
   nothing.
4. It never reads, changes or deletes an object. It refuses `genomeos-atlas-web` by name, whatever
   `TARGET_BUCKET` says.
5. It writes one JSON log line per message, with a `decision` field: `below_threshold` (INFO),
   `made_private` (ALERT, with the removed role and member pairs), `already_private` (NOTICE),
   `malformed` (WARNING), `refused` (CRITICAL) or `error` (ERROR). A malformed message, or a failed
   IAM call, is logged and acknowledged. Nothing is retried in a loop: the next budget message,
   later the same day, tries again.

The 150% ratio is a constant in `kill_switch.py`, not a setting. Changing it is a decision for the
owner, made in a PR.

**What private means for readers.** Anonymous requests to the bucket get an HTTP error, so
`scripts/fetch_data.py` fails. `scripts/publish_data_store.py` also stops at its first metadata
read, before it uploads anything, because it reads through the public grant. Copies that Google's
network or a browser has already cached under the objects' `Cache-Control` can still be served until
they expire (see #473, decision 6). The kill switch caps new egress. It cannot recall copies that
are already cached.

### Identities

| Identity | Holds | Where |
|---|---|---|
| `budget-kill-switch@<project>.iam.gserviceaccount.com` (the function's runtime and trigger identity) | custom role `budgetKillSwitch`: `storage.buckets.get`, `storage.buckets.getIamPolicy`, `storage.buckets.setIamPolicy` | the data-store bucket only |
| the same account | `roles/run.invoker`, so its Eventarc trigger can deliver the message | the `budget-kill-switch` Cloud Run service only |
| `billing-budget-alert@system.gserviceaccount.com` (Cloud Billing) | `roles/pubsub.publisher` | the `budget-notifications` topic only |

The account has no project-wide role. It has no key, and only project owners can act as it.
`setIamPolicy` on the bucket would let the function's code grant itself more on that one bucket.
That is the price of being able to remove a grant. The code is in this repository, and the account
can reach nothing else.

## Provisioning

```bash
export GENOMEOS_GCP_PROJECT=<project>
python scripts/provision_budget_kill_switch.py --dry-run   # prints the whole plan, runs nothing
python scripts/provision_budget_kill_switch.py
```

The script is idempotent and needs the owner's rights. It enables only the APIs it needs (Cloud
Functions, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Pub/Sub and Billing Budgets) and
creates the role, the account, its bucket binding and the topic. It deploys the function and
redeploys it only when its source digest (the `genomeos-source` label) or a setting differs. Then
it attaches the topic to the one budget scoped to the project, or to the budget named by `--budget`.
Attaching changes nothing else on the budget: the script checks afterwards that the amount, the
thresholds and the default email recipients are unchanged, and fails loudly if any of them moved.
A budget already sending to a different topic, or an account holding an extra role, stops the run
(needs-human-decision).

**Is it live?** Check that the function is `ACTIVE`, that the budget names the topic, and that
recent log lines exist:

```bash
python scripts/gcloud_repo.py run functions describe budget-kill-switch --gen2 --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --format="value(state,labels.genomeos-source)"
python scripts/gcloud_repo.py run billing budgets list --billing-account=<billing-account> \
  --format="table(displayName,notificationsRule.pubsubTopic)"
python scripts/gcloud_repo.py run functions logs read budget-kill-switch --gen2 --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --limit=5
```

## Re-enabling public access

The kill switch never turns public access back on. That is the owner's call. Do it in this order:

1. **Stop it from firing again.** The switch checks every budget message. While this month's spend
   stays at or above 150% of the budget, the next message, within hours, removes public access
   again. So either wait for the next calendar month, or first raise the budget so that the spend
   is below 150% of it:

   ```bash
   python scripts/gcloud_repo.py run billing budgets update <budget-id> \
     --billing-account=<billing-account> --budget-amount=<new amount>USD
   ```

   The thresholds are percentages, so they scale with the new amount. Lower it again next month.

2. **Grant anonymous read back.** This is the same grant `provision_data_store_bucket.py` makes, and
   re-running that script is equivalent:

   ```bash
   export GENOMEOS_DATA_BUCKET=genomeos-atlas-data
   python scripts/gcloud_repo.py run storage buckets add-iam-policy-binding "gs://$GENOMEOS_DATA_BUCKET" \
     --member=allUsers --role=roles/storage.legacyObjectReader
   ```

   Grant `roles/storage.legacyObjectReader` only. It reads objects by key and cannot list the
   bucket. Never grant `objectViewer`, which can list.

3. **Check.** `curl -sI https://storage.googleapis.com/genomeos-atlas-data/manifests/<release>.json`
   should print `HTTP/2 200`.

## Testing it

**Without the cloud.** The decision and the IAM edit are pure and fully unit-tested. Provisioning is
tested against the fake gcloud:

```bash
pytest tests/test_budget_kill_switch.py tests/test_provision_budget_kill_switch.py
```

The function itself can be run locally with its own requirements (in a separate virtual
environment), then sent a Pub/Sub CloudEvent with `curl`:

```bash
pip install -r deploy/budget-kill-switch/requirements.txt
cd deploy/budget-kill-switch && TARGET_BUCKET=example-bucket \
  functions-framework --target on_budget_notification --signature-type cloudevent --port 8099
```

**Against production, safely.** Publish a message *below* the threshold to the production topic,
then read the log line. It should say `below_threshold`, and the bucket keeps its `allUsers` member.
Never publish an above-threshold message to the production topic. It would make the bucket private,
which is exactly what it is built to do.

```bash
python scripts/gcloud_repo.py run pubsub topics publish budget-notifications \
  --project="$GENOMEOS_GCP_PROJECT" --attribute=schemaVersion=1.0 \
  --message='{"budgetDisplayName":"drill","costAmount":1.0,"budgetAmount":200.0,"currencyCode":"USD"}'
python scripts/gcloud_repo.py run functions logs read budget-kill-switch --gen2 --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --limit=5
python scripts/gcloud_repo.py run storage buckets get-iam-policy "gs://$GENOMEOS_DATA_BUCKET" --format=json
```

**The full drill, on a throwaway bucket.** This deploys a second copy of the function against a
scratch bucket and its own topic, under the same account and role, so it proves that the real
identity can do the job. Afterwards, delete everything it created.

```bash
export TEST=tmp-killswitch-test-$(date +%Y%m%d%H%M)
export SA=budget-kill-switch@$GENOMEOS_GCP_PROJECT.iam.gserviceaccount.com
python scripts/gcloud_repo.py run storage buckets create "gs://$TEST" --project="$GENOMEOS_GCP_PROJECT" \
  --location=us-east1 --uniform-bucket-level-access
python scripts/gcloud_repo.py run storage buckets add-iam-policy-binding "gs://$TEST" \
  --member=allUsers --role=roles/storage.legacyObjectReader
python scripts/gcloud_repo.py run storage buckets add-iam-policy-binding "gs://$TEST" \
  --member="serviceAccount:$SA" --role="projects/$GENOMEOS_GCP_PROJECT/roles/budgetKillSwitch"
python scripts/gcloud_repo.py run pubsub topics create "$TEST" --project="$GENOMEOS_GCP_PROJECT"
python scripts/gcloud_repo.py run functions deploy "$TEST" --gen2 --project="$GENOMEOS_GCP_PROJECT" \
  --region=us-east1 --runtime=python312 --source=deploy/budget-kill-switch \
  --entry-point=on_budget_notification --trigger-topic="$TEST" --run-service-account="$SA" \
  --trigger-service-account="$SA" --set-env-vars="TARGET_BUCKET=$TEST" --memory=256Mi --timeout=60s \
  --max-instances=1 --ingress-settings=internal-only
python scripts/gcloud_repo.py run run services add-iam-policy-binding "$TEST" --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --member="serviceAccount:$SA" --role=roles/run.invoker

for cost in 120.0 300.0; do   # below, then at, 150% of 200
  python scripts/gcloud_repo.py run pubsub topics publish "$TEST" --project="$GENOMEOS_GCP_PROJECT" \
    --attribute=schemaVersion=1.0 \
    --message="{\"budgetDisplayName\":\"drill\",\"costAmount\":$cost,\"budgetAmount\":200.0}"
  sleep 60
  python scripts/gcloud_repo.py run storage buckets get-iam-policy "gs://$TEST" --format=json
done   # allUsers is still there after 120.0, and gone after 300.0

python scripts/gcloud_repo.py run functions delete "$TEST" --gen2 --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --quiet
python scripts/gcloud_repo.py run pubsub topics delete "$TEST" --project="$GENOMEOS_GCP_PROJECT"
python scripts/gcloud_repo.py run storage rm --recursive "gs://$TEST"
```

## A weekly spend email

Budget emails arrive only when a threshold is crossed. For a regular summary, export billing data to
BigQuery and schedule a Looker Studio report. Both are owner steps in the console, and both need
billing-account rights:

1. **Billing export.** Go to **Billing → Billing export → BigQuery export → Standard usage cost →
   Edit settings**. Choose this project and create a dataset, for example `billing_export` in
   multi-region `US`, then save. Rows start to arrive within about a day. Standard export is not
   backfilled, so it covers spend from the day it is turned on. The BigQuery API is already enabled.
2. **Report.** In [Looker Studio](https://lookerstudio.google.com/), create a report, add the
   BigQuery data source `<project> → billing_export → gcp_billing_export_v1_<billing account>`, and
   chart cost by service and by SKU for the last 7 days. Google's Cloud Billing report template also
   works.
3. **Schedule.** Go to **Share → Schedule delivery**. Add the recipients, set **Repeat** to weekly,
   and pick a day and time.

The export and the queries cost cents a month at this project's size, well inside BigQuery's free
query tier.

## Who can write to the data store

| Identity | Can | Cannot |
|---|---|---|
| `data-store-publisher` (routine uploads, impersonated; [`docs/data-store.md`](data-store.md)) | create new objects; list object names (`gcloud storage cp` needs it) | overwrite or delete objects, or change any setting |
| `budget-kill-switch` | read and replace the bucket's IAM policy | read, write or delete objects |
| project owners | everything | |

Provision the publisher with `scripts/provision_data_store_publisher.py --account <maintainer>`. It
grants the account `roles/storage.objectCreator` and the list-only custom role `dataStoreLister` on the
data-store bucket. It grants the maintainer `roles/iam.serviceAccountTokenCreator` on that one account.
