# Search + materialisation progress telemetry

The appserver emits structured JSON progress lines for the two search-indexing
paths and the materialisation pipeline. They flow to Grafana Cloud Loki through
the existing in-app sink (stdout → Alloy → Loki, see `deploy/alloy/README.md`).
No extra infrastructure is required — query them directly in Grafana.

## Log lines

| Scope (`scope` label) | `msg` | Emitted | Key fields |
|---|---|---|---|
| `search-backfill` | `progress` | once per sweeper cycle (~60s) | `spaceDid`, `cursor`, `rows`, `indexed`, `backfilled`, `errorCount`, `dbBackoffActive` |
| `materialize` | `progress` | every ~10% of a batch (min every 500 events) | `streamId`, `done`, `total`, `pct`, `applied`, `materializerErrors`, `applyErrors`, `isBackfill` |
| `materialize` | `done` | once per batch | `streamId`, `total`, `applied`, `materializerErrors`, `applyErrors`, `isBackfill` |
| `re-materialize` | `stream-done` | once per stream at boot | `streamId`, `applied`, `materializerErrors`, `applyErrors`, `rebuild` |
| `re-materialize` | `progress` | every 25 streams at boot | `done`, `total`, `pct`, `succeeded`, `failed` |
| `re-materialize` | `complete` | once per boot | `succeeded`, `failed` |

Every record carries the standard fields `ts`, `level`, `scope`, `msg`,
`build_id`, `service`, plus `replica_id`/`railway_service_name` labels when
running on Railway.

**Restart caveat**: the sweeper's `backfilled` counter and the indexer's
`indexedOk` are process-local — they reset to 0 on every deploy. The sweeper's
`cursor` and the materialiser's `applied`/`done` totals are backed by
persistent DB state, so they are the cross-restart progress signals.

## Grafana timeseries panels

> **Label vs field**: the Loki stream labels are only `service_name`, `level`,
> `scope` (plus `replica_id`/`railway_service_name` on Railway). `msg` and the
> progress fields are JSON **fields** inside the line — filter them with
> `| json` + `| msg="..."` AFTER the label selector, never inside `{...}`.
> `{...msg="progress"}` matches nothing.

### 1. Backfill progress (persists across restarts)

Query (Loki data source, LogQL):

```logql
{service_name="appserver", scope="search-backfill"}
| json
| unwrap backfilled
| rate($__rate_interval)
```

Panel type: **Time series** (or Stat / Time series).
This shows the per-second backfill rate. `backfilled` resets per process; for
an absolute progress view use the `cursor` field instead:

```logql
{service_name="appserver", scope="search-backfill"}
| json
| unwrap cursor
```

(`cursor` is a ULID — parse it with `| label_format` / `| line_format` if you
want a readable value; the trend, not the magnitude, is the signal.)

### 2. Materialisation throughput

```logql
{service_name="appserver", scope="materialize"}
| json
| msg="done"
| unwrap applied
| rate($__rate_interval)
```

This is events applied per second, including live `sendEvents` batches
(`isBackfill=false`) and boot re-materialisation (`isBackfill=true`). Split by
path with `| filter` or by adding `isBackfill` to the unwrap/label.

Per-stream progress over time (the `applied` total for one stream):

```logql
{service_name="appserver", scope="materialize"}
| json
| msg="done"
| unwrap applied
```

### 3. Boot re-materialisation (per-deploy)

```logql
{service_name="appserver", scope="re-materialize"}
| json
| msg="stream-done"
| unwrap applied
| rate($__rate_interval)
```

And the overall boot progress:

```logql
{service_name="appserver", scope="re-materialize"}
| json
| msg="progress"
| unwrap done
```

## Panel setup steps (Grafana)

1. Open the Grafana Cloud dashboard (or Grafana instance) with the Loki data
   source connected.
2. **Dashboards → New → New dashboard → Add visualization**.
3. Data source: select the Loki data source.
4. Paste the LogQL query above into the **Query editor** (Explore mode shows
   the same queries).
5. Panel type: **Time series** (default). Set **Legend** to `{{streamId}}` or
   `{{spaceDid}}` if you want per-space series — add `| label_format` to the
   query to promote a field to a label, e.g.:
   ```logql
   {service_name="appserver", scope="materialize"}
   | json
   | msg="done"
   | label_format stream=streamId
   | unwrap applied
   ```
6. Time range: pick a window covering the backfill (e.g. **Last 6 hours**).
   Rate queries need `$__rate_interval`; absolute unwrap queries don't.
7. Save.

## Alerting (optional)

The most useful alert is a stall: `backfilled` rate near zero while
`indexedOk` keeps growing (or while the pre-deploy corpus is still missing
from search). Threshold: `rate(backfilled) < 0.001` for 30 minutes during an
active backfill window. Use a literal window in the alert query (alert rules
don't substitute `$__rate_interval`):

```logql
rate({service_name="appserver", scope="search-backfill"} | json | unwrap backfilled [15m]) < 0.001
```
