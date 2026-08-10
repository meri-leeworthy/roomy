# ── Grafana Alloy (production collector) ────────────────────────────────
#
# Central log collector for Roomy on Railway. Receives logs pushed by
# appserver / discord-bridge / app-lite and ships them to Grafana Cloud.
#
# Config is baked in (the user can't attach a Railway volume), so the only
# runtime inputs are env vars (see README.md):
#   - GRAFANA_CLOUD_LOKI_ID
#   - GRAFANA_CLOUD_LOKI_TOKEN
#   - GRAFANA_CLOUD_REGION   (optional, default `us`)
#
# Ports: 12345 (Alloy UI/reload), 3100 (Loki push API), 4317/4318 (OTLP).

FROM grafana/alloy:latest

COPY config.alloy /etc/alloy/config.alloy

# Alloy writes WAL/positions to disk — keep the volume small but writable.
ENV ALLOY_WAL_DIR=/var/lib/alloy

EXPOSE 12345 3100 4317 4318

CMD ["run", "--server.http.listen-addr=0.0.0.0:12345", "/etc/alloy/config.alloy"]
