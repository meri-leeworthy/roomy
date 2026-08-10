# Grafana Alloy — Roomy production log collector

Deploys `grafana/alloy` as a central log collector on Railway. The apps
(appserver, discord-bridge, app-lite) forward their stdout here over the
Railway private network, and Alloy ships the logs to Grafana Cloud Loki.

The config is **baked into the image** so no Railway volume is required.

## Deploy on Railway

1. **New Project → Deploy from Dockerfile**, pointing at `deploy/alloy/`
   (this directory). Railway uses `Dockerfile` here.
2. Under the service → **Variables**, set:
   | Variable | Value |
   |---|---|
   | `GRAFANA_CLOUD_LOKI_URL` | `https://logs-prod-<region>.grafana.net/loki/api/v1/push` |
   | `GRAFANA_CLOUD_LOKI_ID` | Grafana Cloud Loki instance ID |
   | `GRAFANA_CLOUD_LOKI_TOKEN` | Grafana Cloud access policy token |
3. **Networking → Private networking** — add this service to a private
   network so the apps can reach it by name at `alloy:3100`.
4. **Ports**: open `3100` (Loki push API), `12345` (Alloy UI/reload).
   `4317`/`4318` (OTLP) are optional.
5. **Healthcheck**: `/-/healthy` on port `12345`.

> Grafana Cloud: *Your Stack → Details* shows your Loki push URL
> (`logs-prod-<region>.grafana.net`). Create an Access Policy token for the
> password; use the Loki instance ID as the user.

## How apps forward logs

Each app service's **start command** pipes its stdout through a tiny Loki
forwarder that POSTs to `http://alloy:3100/loki/api/v1/push`. See
`packages/appserver` and `packages/discord-bridge` for the per-app wiring.

## Ports
- `3100`  — Loki push API receiver (`loki.source.api`)
- `12345` — Alloy UI + config reload / healthcheck
- `4317`/`4318` — OTLP gRPC/HTTP logs receiver (optional)
