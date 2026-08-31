# Grafana Alloy — Roomy production log collector

Deploys `grafana/alloy` as a central log collector on Railway. Logs from
app-lite (browser Faro agent) and the app services (appserver, discord-bridge)
are received here and shipped to Grafana Cloud Loki.

The config is **baked into the image** so no Railway volume is required.

## Deploy on Railway

1. **New Project → Deploy from Dockerfile**, pointing at the repo root.
   Set the **Dockerfile path** to `deploy/alloy/Dockerfile`. The build context
   is the repo root, so the config is referenced as `deploy/alloy/config.alloy`.
2. Under the service → **Variables**, set:
   | Variable | Value |
   |---|---|
   | `GRAFANA_CLOUD_LOKI_URL` | `https://logs-prod-<region>.grafana.net/loki/api/v1/push` |
   | `GRAFANA_CLOUD_LOKI_ID` | Grafana Cloud Loki instance ID |
   | `GRAFANA_CLOUD_LOKI_TOKEN` | Grafana Cloud access policy token |
   | `FARO_CORS_ORIGINS` | Comma-separated browser origins allowed to POST to the Faro receiver. Default: `https://app.roomy.chat` (the Caddyfile app origin). Add any other origins that serve the app (e.g. a preview domain). |
   | `FARO_API_KEY` | Shared secret checked against the Faro agent's `api_key`. Default `bad_api_key` (dev-compose parity) — **set a real secret in production**. |
3. **Networking → Private networking** — add this service to a private
   network so the apps can reach it by name at `alloy:3100`.
4. **Ports**: open `3100` (Loki push API), `12345` (Faro browser-agent
   receiver — must be reachable from the browser), and `5005` (Alloy
   UI/reload/healthcheck). `4317`/`4318` (OTLP) are optional.
5. **Healthcheck**: `/-/healthy` on port `5005`.

> Grafana Cloud: *Your Stack → Details* shows your Loki push URL
> (`logs-prod-<region>.grafana.net`). Create an Access Policy token for the
> password; use the Loki instance ID as the user.

## How apps forward logs

| App | Channel | How |
|---|---|---|
| **app-lite** | Browser Faro push (HTTP to `12345`) | The SvelteKit client initializes `@grafana/faro-web-sdk` when `PUBLIC_FARO_URL` is set (`src/lib/telemetry/faro.ts` → `initFaro()` in the root layout). Consoles + uncaught errors are POSTed to the Alloy `faro.receiver "frontend"` on `12345`, which forwards them to Loki. Disabled by default — no `PUBLIC_FARO_URL`, no traffic. |
| **appserver** | In-app Loki push (HTTP to `3100`) | The appserver's structured logger POSTs Loki-compatible JSON to `http://alloy:3100/loki/api/v1/push` (see `packages/appserver/src/log.ts`). |
| **discord-bridge** | In-app Loki push (HTTP to `3100`) | Same Loki-push pattern as the appserver — being wired in TASK-65; stdout is mirrored for Railway visibility meanwhile. |

## Faro (browser agent) notes

- `PUBLIC_FARO_URL` on app-lite must point at something the **browser** can
  reach: the Alloy service's public/private URL on port `12345`. The Alloy UI
  was moved to port `5005` precisely so `12345` is dedicated to the Faro
  receiver (same split as the dev compose stack).
- CORS: the Faro receiver rejects browser POSTs from origins not listed in
  `FARO_CORS_ORIGINS`. In dev, compose.yaml allows `http://127.0.0.1:5173`; in
  prod the default is the production app origin (`https://app.roomy.chat`).
- Tracing: dev Fora pushes also include traces (compose: Tempo); **production
  has no Tempo** — the prod receiver forwards logs to Loki only. No web-vitals
  or tracing instrumentation in app-lite v1.

## Ports
- `5005`  — Alloy UI + config reload / healthcheck
- `12345` — Faro browser-agent receiver (app-lite logs)
- `3100`  — Loki push API receiver (`loki.source.api`)
- `4317`/`4318` — OTLP gRPC/HTTP logs receiver (optional)
