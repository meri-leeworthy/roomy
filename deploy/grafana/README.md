# Grafana dashboards — Roomy product analytics

`dashboards/roomy-product-analytics.json` is the dashboard for browser
telemetry: sessions, pseudonymous users, page views, client exceptions, browser
mix, and tile engagement. It reads **only** Loki, from the stream
`{service_name="roomy-app-lite"}` that Alloy's Faro receiver writes
(`deploy/alloy/config.alloy`, `loki.process "frontend"`).

This directory is the **source of truth**: edit the JSON here, re-import it,
and commit the result. There is no provisioning pipeline yet — a change made in
the Grafana UI is lost the next time someone imports the file.

## Import

1. Grafana → **Dashboards** → **New** → **Import**.
2. Paste the JSON (or drag the file in), then **Load**.
3. When prompted for **Loki data source** (`DS_LOKI`), pick the stack's Loki
   data source. The JSON names no data source by uid — the template variable is
   what binds every panel — so the same file imports into any stack.
4. **Import**.

Re-importing over an existing copy overwrites it; there is no merge.

## Caveat: records are logfmt, not JSON

Faro log lines arrive as `key=value` pairs, and Alloy parses them with
`stage.logfmt`. Query them with `| logfmt`. Do **not** use `| json` — console
lines legitimately carry values containing braces (a serialised API error, a
cache-dump listing), and `| json` fails the whole line on them. Where a parse
failure would be possible, `| __error__=""` restricts a panel to lines that
parsed.

## Caveat: `user_id` is a salted hash, and may be absent

`user_id` is `sha256(PUBLIC_ANALYTICS_SALT + ":" + did)`
(`packages/app-lite/src/lib/telemetry/scrub.ts`). The raw DID never leaves the
device.

The salt is inlined into the static bundle at build time (`PUBLIC_ANALYTICS_SALT`
in `Dockerfile.app-lite`), so:

- A build **without** the salt emits no `user_id` at all. Every session from it
  is anonymous, and the user panels show no series — not zero, empty.
- A build **with** the salt starts its series at that deploy. Nothing before it
  can be joined retroactively.
- Rotating the salt starts a new id space; old ids do not line up with new ones.

Any panel that counts users filters `| user_id != ""`, so anonymous sessions
count towards *Sessions per day* but not towards *Distinct pseudonymous users*.

## Caveat: tile attributes arrive under an `event_data_` prefix

The **Tile engagement** panels count three product events —
`event_name="tile_view"`, `tile_post` and `tile_error`
(`packages/app-lite/src/lib/telemetry/tile-events.ts`). Their attributes are
emitted flat but prefixed by the Faro receiver, so a query breaks them down by
the prefixed name, never the name the client passes:

| Event | Attribute as sent | Label in Loki |
|---|---|---|
| `tile_view` | `tile`, `surface` | `event_data_tile`, `event_data_surface` |
| `tile_error` | `tile`, `surface`, `reason` | `event_data_tile`, `event_data_surface`, `event_data_reason` |
| `tile_post` | `count`, `source` | `event_data_count`, `event_data_source` |

`tile` is the first 16 hex characters of `sha256(<tile AT-URI>)`, not a salted
user hash: it is stable across users and sessions so "how many people saw this
tile" is answerable, and it does not yield the author's DID back.

A `tile_view` is reported once per session per tile, so the count is people who
saw a tile, not the number of mounts. A tile's frame mounts as soon as its
manifest loads — there is no card and no click in between — so a view is the
only render phase there is to count. `tile_error` carries a `reason`
(`manifest`, `assets`, `frame`, `other`) and is empty while nothing fails to
load — an empty panel there is expected, not a broken query.

## Panels

| Panel | Query |
|---|---|
| Sessions per day | `count(count by (session_id) (count_over_time({service_name="roomy-app-lite"} \| logfmt [$__interval])))` |
| Distinct pseudonymous users per day | `count(count by (user_id) (count_over_time({service_name="roomy-app-lite"} \| logfmt \| user_id != "" [$__interval])))` |
| Top routes (page views) | `topk(10, sum by (page_url) (count_over_time({service_name="roomy-app-lite"} \| logfmt [7d])))` |
| Exceptions by hash | `topk(10, sum by (hash, value) (count_over_time({service_name="roomy-app-lite"} \| logfmt \| kind="exception" \| __error__="" \| value!~ "ResizeObserver loop" [7d])))` |
| Browser mix | `sum by (browser_name) (count_over_time({service_name="roomy-app-lite"} \| logfmt [7d]))` |
| Tile views / posts per day | `sum(count_over_time({service_name="roomy-app-lite"} \| logfmt \| event_name="tile_view" [$__interval]))` (`tile_post` likewise) |
| Tile errors per day | `sum by (event_data_reason) (count_over_time({service_name="roomy-app-lite"} \| logfmt \| event_name="tile_error" [$__interval]))` |
| Users viewing / posting tiles per day | `count(count by (user_id) (count_over_time({service_name="roomy-app-lite"} \| logfmt \| event_name="tile_view" \| user_id != "" [$__interval])))` (`tile_post` likewise) |

Per-day panels pin the panel interval to `1d`, so `$__interval` resolves to a
day regardless of the selected time range.

**Known gap — native builds.** The Tauri shell emits no Faro telemetry, so every
panel undercounts desktop usage.

**Known noise — ResizeObserver.** Browser layout produces
`ResizeObserver loop completed with undelivered notifications.` exceptions in
volume. The exceptions panel excludes them explicitly, so historical windows
read the same whether or not the client drops them.
