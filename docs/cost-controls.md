# Cost controls

**TL;DR.** The project has a $200 monthly budget. It emails the billing account's administrators
and users at 50%, 90% and 150% of actual spend, and at 100% of forecast spend. If actual spend
reaches **150%** ($300), a kill switch removes public access to the data-store bucket
(`genomeos-atlas-data`). Readers then get an error, and the bucket stays private until the owner
turns public access back on. The Atlas web-data bucket (`genomeos-atlas-web`) keeps serving and is
never touched. Nothing is deleted.

150% is not a hard cap on the bill. The switch stops new downloads from the data-store bucket only.
The web bucket's egress, and anything else in the project, keeps billing after it fires.

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

1. It checks its own settings first. With no `TARGET_BUCKET`, with the web bucket as the target, or
   with no `BUDGET_ID`, it refuses every message, below the threshold too, so a broken deployment
   shows up in the logs within hours rather than on the day it is needed.
2. It acts only on its own budget's messages. Cloud Billing sets a `budgetId` attribute on every
   notification, and it must equal the function's `BUDGET_ID`, which provisioning reads from the
   budget at deploy time (it is never committed). A drill message, or a message from a second
   budget attached to the topic later, is logged as `malformed` and ignored. This is a filter, not
   authentication: anyone who can publish to the topic and read the function's settings can copy
   the id. A forged message can only make the bucket private, never public.
3. It reads `costAmount` and `budgetAmount` from the message itself, as exact decimals. The message's
   `alertThresholdExceeded` field is logged but never used for the decision. While
   `costAmount < 1.5 × budgetAmount`, it does nothing, and does not even read the bucket.
4. At or above that, it reads the IAM policy of the bucket named in its `TARGET_BUCKET` (the
   data-store bucket). It removes every `allUsers` and `allAuthenticatedUsers` member from every
   binding and writes the policy back with the etag it read. Every other member, binding and
   condition stays. A bucket that has no public member is left alone, so repeated messages change
   nothing.
5. It never reads, changes or deletes an object. It refuses `genomeos-atlas-web` by name, whatever
   `TARGET_BUCKET` says.
6. It writes one JSON log line per message, with a `decision` field: `below_threshold` (INFO),
   `made_private` (ALERT, with the removed role and member pairs), `already_private` (NOTICE),
   `malformed` (WARNING, which includes another budget's message), `refused` (CRITICAL, a
   misconfigured deployment) or `error` (ERROR). A malformed message, or a failed IAM call, is logged
   and acknowledged. Nothing is retried in a loop: the next budget message, later the same day,
   tries again.

The 150% ratio is a constant in `kill_switch.py`, not a setting. Changing it is a decision for the
owner, made in a PR.

**What private means for readers.** Anonymous requests to the bucket get an HTTP error, so
`scripts/fetch_data.py` fails. Publishing keeps working, because `data-store-publisher` reads
through its own role, not the public grant. Objects carry
`Cache-Control: public, max-age=31536000, immutable`, so copies that Google's network, a proxy or a
browser has already cached may be served for up to a year (see #473, decision 6). The switch cannot
recall them. Whether Google bills for responses served from its own caches has not been checked.

### Identities

| Identity | Holds | Where |
|---|---|---|
| `budget-kill-switch@<project>.iam.gserviceaccount.com` (the function's runtime and trigger identity) | custom role `budgetKillSwitch`: `storage.buckets.getIamPolicy`, `storage.buckets.setIamPolicy` (the only two calls the function makes) | the data-store bucket only |
| the same account | `roles/run.invoker`, so its Eventarc trigger can deliver the message | the `budget-kill-switch` Cloud Run service only |
| `billing-budget-alert@system.gserviceaccount.com` (Cloud Billing) | `roles/pubsub.publisher` | the `budget-notifications` topic only |

The account has no project-wide role, and provisioning never creates a key for it. It is not
true that only owners can act as it: see [Project-wide access](#project-wide-access) below.
`setIamPolicy` on the bucket would let the function's code grant itself more on that one bucket.
That is the price of being able to remove a grant. The code is in this repository, and the account
can reach nothing else.

### Project-wide access

The kill switch and the publisher get narrow grants, but some principals hold project-wide roles
that reach past them. Both provisioning scripts print a line for every principal that, through a
project-wide role, can act as their service account or mint credentials for it
(`iam.serviceAccounts.actAs`, `iam.serviceAccountKeys.create`, `getAccessToken`, `signBlob`,
`signJwt` or `implicitDelegation`). Project owners and Google-managed service agents
(`service-<number>@…`, `<number>@cloudservices.gserviceaccount.com`) do this by design and get a
`note:`. Anyone else gets a `warning:`. Neither stops the run. Two things stood out on 2026-10-17:

- **The default compute service account (`<number>-compute@developer.gserviceaccount.com`) holds
  `roles/editor`.** Google grants it that by default when the Compute Engine API is enabled. Editor
  includes `actAs`, `serviceAccountKeys.create`, `cloudfunctions.functions.update` and
  `pubsub.topics.publish`. So any workload running as that account could create a key for
  `data-store-publisher`, redeploy `budget-kill-switch` with other code, or publish a fake trip
  message. On 2026-10-17 the project had no VM and the account had no user-managed key. But in a
  project as new as this one, Cloud Functions builds run as that account by default, so the
  switch's build step does too.
- **Editors and owners already control the data-store bucket directly.** The bucket keeps Cloud
  Storage's default `projectEditor:` and `projectOwner:` bindings (`legacyBucketOwner`,
  `legacyObjectOwner`), which include `storage.buckets.setIamPolicy` and `storage.objects.delete`.
  So the kill switch's `setIamPolicy` adds no new route for an Editor: one could already make the
  bucket public or private, or delete objects, without going through it.

These are the owner's decisions, and nothing here changes them. The options are: remove
`roles/editor` from the default compute account, and then give function builds a dedicated account
(`gcloud functions deploy --build-service-account`); remove the `projectEditor:` bindings from the
data-store bucket; or accept both and leave them as they are. Until then, read "cannot overwrite or
delete" on this page as describing the publisher, not every identity in the project.

## Provisioning

```bash
export GENOMEOS_GCP_PROJECT=<project>
python scripts/provision_budget_kill_switch.py --dry-run   # prints the whole plan, runs nothing
python scripts/provision_budget_kill_switch.py
```

The script is idempotent and needs the owner's rights. It enables only the APIs it needs (Cloud
Functions, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Pub/Sub and Billing Budgets) and
creates the role, the account, its bucket binding and the topic. It prints a `warning:` line for
each principal that can act as the account ([Project-wide access](#project-wide-access)), or a
`note:` when that is by design. It finds
the one budget scoped to the project, or the budget named by `--budget`, before it deploys, because
the function is deployed with that budget's id as `BUDGET_ID`. It deploys the function and redeploys
it only when its source digest (the `genomeos-source` label) or a setting, `BUDGET_ID` included,
differs. Then it attaches the topic to that budget. Attaching changes nothing else on the budget: the script checks afterwards that the amount, the
thresholds and the default email recipients are unchanged, and fails loudly if any of them moved.
A budget already sending to a different topic, or an account holding an extra role, stops the run
(needs-human-decision).

**Is it live?** Check that the function is `ACTIVE` with a `BUDGET_ID`, that the budget names the
topic, and that recent log lines exist and say `below_threshold`. A real budget message logged as
`malformed` means the switch is not reading Cloud Billing's messages (for example, they lack the
`budgetId` attribute it expects), so it would never trip. Check this after the first real message
following every deploy. A drill message cannot stand in for it, because the drill sets the
attribute itself.

```bash
python scripts/gcloud_repo.py run functions describe budget-kill-switch --gen2 --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" \
  --format="value(state,labels.genomeos-source,serviceConfig.environmentVariables.BUDGET_ID)"
python scripts/gcloud_repo.py run billing budgets list --billing-account=<billing-account> \
  --format="table(displayName,notificationsRule.pubsubTopic)"
python scripts/gcloud_repo.py run functions logs read budget-kill-switch --gen2 --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --limit=5
```

### Alerting on failures

**Nothing alerts on a failure yet.** An `error` or `refused` line, or a crash at start-up, is only a
log line, and the owner's inbox gets nothing. Only the budget's own threshold emails arrive. A broken
switch could go unnoticed for weeks. Provisioning does not create an alert, because this
repository's pinned gcloud (498) has alerting-policy commands only in its alpha and beta components.
Set one up once, as the owner, in the console:

1. Open **Logging → Logs Explorer** for the project and run this query:

   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="budget-kill-switch"
   (jsonPayload.decision=("made_private" OR "refused" OR "error" OR "malformed") OR severity>=ERROR)
   ```

2. Choose **Actions → Create log alert**. Give it a name, set the time between notifications to 1
   hour, and choose or create an email notification channel for the owner.

`made_private` tells you the switch fired. `refused` and `error` mean it could not act, and
`malformed` means a message it did not recognise. `severity>=ERROR` also covers errors outside the
switch's own log lines, such as a crash at start-up.

A log alert cannot see silence. If messages stop arriving (the budget is detached from the topic, or
the function is deleted), nothing is logged and nothing alerts. The **Is it live?** check above is
the only guard against that, so run it after any change to the budget or the project.

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

2. **Wait until the switch has seen the change.** A message computed before the change, or delivered
   late, still carries the old amount, and it would remove public access again right after you
   restore it. So before you grant anything, wait for a `below_threshold` line whose `budget_amount`
   is the new amount. After a month rollover, wait for one whose `cost_interval_start` is the new
   month. Cloud Billing publishes several times a day, so this can take a few hours:

   ```bash
   export SWITCH='resource.type="cloud_run_revision" AND resource.labels.service_name="budget-kill-switch"'
   python scripts/gcloud_repo.py run logging read --project="$GENOMEOS_GCP_PROJECT" --limit=5 \
     "$SWITCH AND jsonPayload.decision=\"below_threshold\"" \
     --format="table(timestamp,jsonPayload.budget_amount,jsonPayload.cost_interval_start)"
   ```

3. **Grant anonymous read back.** This is the same grant `provision_data_store_bucket.py` makes, and
   re-running that script is equivalent:

   ```bash
   export GENOMEOS_DATA_BUCKET=genomeos-atlas-data
   python scripts/gcloud_repo.py run storage buckets add-iam-policy-binding "gs://$GENOMEOS_DATA_BUCKET" \
     --member=allUsers --role=roles/storage.legacyObjectReader
   ```

   Grant `roles/storage.legacyObjectReader` only. It reads objects by key and cannot list the
   bucket. Never grant `objectViewer`, which can list.

4. **Check.** `curl -sI https://storage.googleapis.com/genomeos-atlas-data/manifests/<release>.json`
   should print `HTTP/2 200`. If a `made_private` line appears after you restored access, a late
   message got through. Go back to step 2.

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
The message must carry the budget's id, or the switch ignores it as `malformed`. Never publish an
above-threshold message to the production topic. It would make the bucket private, which is exactly
what it is built to do.

```bash
export BUDGET_ID=$(python scripts/gcloud_repo.py run functions describe budget-kill-switch --gen2 \
  --region=us-east1 --project="$GENOMEOS_GCP_PROJECT" \
  --format="value(serviceConfig.environmentVariables.BUDGET_ID)")
python scripts/gcloud_repo.py run pubsub topics publish budget-notifications \
  --project="$GENOMEOS_GCP_PROJECT" --attribute="schemaVersion=1.0,budgetId=$BUDGET_ID" \
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
  --trigger-service-account="$SA" --set-env-vars="TARGET_BUCKET=$TEST,BUDGET_ID=drill" --memory=256Mi \
  --timeout=60s --max-instances=1 --ingress-settings=internal-only
python scripts/gcloud_repo.py run run services add-iam-policy-binding "$TEST" --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --member="serviceAccount:$SA" --role=roles/run.invoker

for cost in 120.0 300.0; do   # below, then at, 150% of 200
  python scripts/gcloud_repo.py run pubsub topics publish "$TEST" --project="$GENOMEOS_GCP_PROJECT" \
    --attribute=schemaVersion=1.0,budgetId=drill \
    --message="{\"budgetDisplayName\":\"drill\",\"costAmount\":$cost,\"budgetAmount\":200.0}"
  sleep 60
  python scripts/gcloud_repo.py run storage buckets get-iam-policy "gs://$TEST" --format=json
done   # allUsers is still there after 120.0, and gone after 300.0

python scripts/gcloud_repo.py run functions delete "$TEST" --gen2 --region=us-east1 \
  --project="$GENOMEOS_GCP_PROJECT" --quiet
python scripts/gcloud_repo.py run pubsub topics delete "$TEST" --project="$GENOMEOS_GCP_PROJECT"
python scripts/gcloud_repo.py run storage rm --recursive "gs://$TEST"
```

Deleting the function leaves two things behind: its source archive and its container image.
Cloud Functions keeps them in places the production function shares, the bucket
`gcf-v2-sources-<number>-us-east1` and the Artifact Registry repository `gcf-artifacts`. Delete only
the drill's entries, never the bucket or the repository. In image names, each `-` of the function
name is doubled:

```bash
export NUMBER=$(python scripts/gcloud_repo.py run projects describe "$GENOMEOS_GCP_PROJECT" \
  --format="value(projectNumber)")
export SOURCES=gcf-v2-sources-$NUMBER-us-east1
python scripts/gcloud_repo.py run storage rm --recursive "gs://$SOURCES/$TEST/"
python scripts/gcloud_repo.py run artifacts docker images list \
  "us-east1-docker.pkg.dev/$GENOMEOS_GCP_PROJECT/gcf-artifacts" --format="value(package)" \
  | sort -u | grep -F -- "__us--east1__${TEST//-/--}"
# For each package printed above (the drill's image, and its build cache), and nothing else:
python scripts/gcloud_repo.py run artifacts docker images delete <package> --delete-tags --quiet
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

## Monthly cost report

Once a month the owner runs `scripts/cost_report.py`, a read-only report that measures what each
bucket sent and checks it against every trigger in §1.3 of the
[data platform design](superpowers/specs/2026-10-18-atlas-data-platform-design.md): the triggers
that decide when to add a free mirror, sponsor mirrors or a cheaper web host (step 1.14, builder's
call 12). Nothing schedules it. It needs the owner's login, so it is an owner step.

**What it reads.** One Cloud Monitoring metric, Cloud Storage's bytes sent
(`storage.googleapis.com/network/sent_bytes_count`, sampled every 60 s), for every bucket in the
project. The Monitoring API (`projects.timeSeries.list`, GET requests only) sums it per bucket and
UTC day. The window is the last two complete UTC months, plus this month up to yesterday. The account
needs `roles/monitoring.viewer` on the project, which project owners have. The token comes from
`python scripts/gcloud_repo.py run auth print-access-token` (the repository-local login) and is never
printed. The report writes nothing, except that `--open-issue` opens issues with `gh`.

**Roles.** `genomeos-atlas-data` is `data`. `--web-bucket` (or `$ATLAS_DATA_BUCKET`) is `web`.
`--lookup-bucket` is `lookup`, once step 2.5 creates that bucket. Every other bucket is `other`: it is
reported, never counted.

```bash
export GENOMEOS_GCP_PROJECT=<project> ATLAS_DATA_BUCKET=<web bucket>
python scripts/cost_report.py --dry-run      # prints the token command and the first request; runs neither
python scripts/cost_report.py                # the report; opens nothing
python scripts/cost_report.py --open-issue   # the report, and one issue per fired trigger
```

Add `--lookup-bucket <bucket>` once the lookup bucket exists, and `--today YYYY-MM-DD` to report as of
another UTC day.

| Exit | Meaning |
|---|---|
| 0 | No trigger fired. |
| 1 | A read failed, or returned data the report cannot account for. These are hard errors; nothing is skipped. |
| 2 | `--project` (or `GENOMEOS_GCP_PROJECT`) or `--web-bucket` (or `ATLAS_DATA_BUCKET`) is missing. |
| 3 | At least one trigger fired. With `--open-issue`, each fired trigger has its issue. |

**What it prints.** For each bucket and month: the role, the GiB sent and the dollars at $0.12/GiB.
Then this month's egress so far from every bucket, against the $300 kill switch. Then every trigger's
status (`fired`, `not_fired`, `not_measurable` or `by_hand`) with its evidence, and the issue each
fired trigger gets.

**The triggers.** `genomeos/publication/cost_triggers.py` holds them, each with §1.3's trigger and
recommendation word for word. Free egress is what the data and lookup buckets send; D3's "data egress"
and D12's "free egress" are both measured that way. A two-month trigger fires only when the cost is
strictly over $50 in each of the two complete months.

| Trigger | Decisions | Step | How the report checks it |
|---|---|---|---|
| `D3-egress` | D3 | 3.8 | Data and lookup egress over $50 in each of the last two complete UTC months. |
| `D3-brake` | D3 | 3.8 | A lookup bucket sent 20 GiB or more in one UTC day (D16's brake). `not_measurable` until step 2.5. |
| `D12-egress` | D12a, D12b | 3.4 | As `D3-egress`. |
| `D12-guard` | D12a, D12b | 3.4 | By hand: a PR that raises the 2 GiB release guard. |
| `D11-web` | D11 | 3.5 | Web egress over $50 in each of the last two complete UTC months. |
| `D2a` | D2a, D2c, D6a | 3.1 | By hand: an issue with a genome-wide use case. |
| `3.2` | — | 3.2 | By hand: the first bulk request, or the first `at_cost` or R6 object (§11). |
| `D7` | D7 | 3.3 | By hand: after steps 2.4 and 3.8. |
| `D13` | D13 | 3.7 | By hand: when P3's burden draws ship. |
| `D14` | D14, D10 | 3.6 | By hand: the second whole-genome ingest, or step 3.6. |
| `D2b` | D2b, D15 | — | By hand: the owner confirms. |
| `D6b` | D6b, D8a–D8e, D9 | 4.1–4.5 | By hand: the first scheduled `at_cost` object. |

A month with no data points prints as "no data points (idle bucket, or outside Monitoring's
retention)", and it cannot fire a trigger. How long Monitoring keeps this metric is unverified; for an
older month, read the billing export.

**Issues.** `--open-issue` opens one issue per fired trigger in `genomeOS/genomeOS`, titled
"Cost trigger <id> fired: …", with the labels `needs-human-decision`, `type:governance`,
`P1:observations`, `skill:governance` and `priority:high`. It skips any title an issue already has,
open or closed. Each title names its months, so a rerun in the same month opens nothing new. The body
gives roles and dollars, never the project id.

**Cross-check with the billing export.** The report prices every byte sent at the list rate, before
the free tier (100 GB a month of North American egress, shared across the billing account). It also
counts bytes sent to Google services and within the region, which are not billed as internet egress.
So it can overstate the bill but never understates it. The BigQuery billing export (see "A weekly
spend email") holds what was billed. Before acting on a fired trigger, compare its months with:

```sql
SELECT invoice.month, sku.description, SUM(cost) AS cost
FROM `<project>.billing_export.gcp_billing_export_v1_<billing account>`
WHERE service.description = 'Cloud Storage'
GROUP BY 1, 2
ORDER BY 1, 2;
```

## Who can write to the data store

| Identity | Can | Cannot |
|---|---|---|
| `data-store-publisher` (routine uploads, impersonated; [`docs/data-store.md`](data-store.md)) | create new objects; read objects and list their names (publishing needs both) | overwrite or delete objects, or change any setting |
| `budget-kill-switch` | read and replace the bucket's IAM policy | read, write or delete objects |
| project owners and editors (editors today: the default compute account) | everything, through the bucket's `projectOwner:` and `projectEditor:` bindings | |

Provision the publisher with `scripts/provision_data_store_publisher.py --account <maintainer>`. It
grants the account `roles/storage.objectCreator` and the custom role `dataStoreReader` (exactly
`storage.objects.get` and `storage.objects.list`) on the data-store bucket. It grants the maintainer
`roles/iam.serviceAccountTokenCreator` on that one account. Pass `--account group:<email>` for a
Google group; a bare email is taken as a person.
