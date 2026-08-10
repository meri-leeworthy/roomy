#!/usr/bin/env bash
set -euo pipefail

# ── Roomy appserver Docker entrypoint ────────────────────────────────────
#
# Litestream backups are OPTIONAL. If S3 credentials are not configured (e.g.
# the Railway S3 bucket isn't linked yet), the app runs directly with no
# backups — so the container never crashes just because backups aren't set up.
#
# When S3 IS configured, the entrypoint restores the appserver's static
# SQLite databases from S3 (via Litestream) when no local copy exists, then
# starts the app wrapped in `litestream replicate` so every WAL change is
# continuously copied to the backup bucket.
#
# On Railway the appserver's SQLite databases live on a persistent volume at
# /data, so they survive deploys. If a DB is absent/corrupt at boot (first
# deploy, or manual reset) it is restored from the S3 backup; otherwise the
# existing file wins and replication simply continues.
#
# ── Fail-closed safety ───────────────────────────────────────────────────
# Because /data is a persistent volume, a redeploy with a failed/missing
# backup still has its local DBs and does not silently discard data. The
# fail-closed check remains a safety net for the case where a local DB is
# absent AND no backup is restorable: we refuse to start fresh unless the
# operator has explicitly opted in via LITESTREAM_ALLOW_FRESH_START=true.
#
# Only the STATIC DBs (see litestream.yml) are restored. Per-space DBs under
# /data/spaces/ are derived and regenerate lazily via re-materialisation
# from the event log on first access, so they are intentionally not
# replicated or restored here.

DATA_DIR="${APPSERVER_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
mkdir -p "${SPACES_DIR:-$DATA_DIR/spaces}"

# ── Optional Litestream ──────────────────────────────────────────────────
# If any required S3 var is missing, run the app directly (no backups). This
# keeps the container deployable before the bucket is linked and avoids the
# "bucket required for s3 replica" crash.
if [ -z "${S3_BUCKET:-}" ] || [ -z "${S3_ENDPOINT:-}" ] || \
   [ -z "${S3_ACCESS_KEY_ID:-}" ] || [ -z "${S3_SECRET_ACCESS_KEY:-}" ]; then
  echo "[entrypoint] S3 backup not configured (need S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)."
  echo "[entrypoint] Running WITHOUT Litestream backups."
  exec bun run packages/appserver/src/index.ts
fi

# Set to "true" ONLY to force a fresh start when S3 is unreachable and no
# backup can be restored (e.g. first deploy against a misconfigured bucket).
ALLOW_FRESH_START="${LITESTREAM_ALLOW_FRESH_START:-false}"

# Static DBs replicated by litestream.yml. The event-log DB is the append-only
# source of truth; read-state is a persistent source of truth; global holds
# membership/profiles. Per-space DBs are derived and excluded.
STATIC_DBS=(
  "${EVENTS_DB_PATH:-$DATA_DIR/roomy-events.sqlite}"
  "${READSTATE_DB_PATH:-$DATA_DIR/roomy-readstate.sqlite}"
  "${GLOBAL_DB_PATH:-$DATA_DIR/global.sqlite}"
)

# SQLite database files begin with the 16-byte magic "SQLite format 3\0".
# Used to detect a corrupt/truncated local DB so we restore over it instead of
# trusting a bad file.
is_valid_sqlite() {
  local db="$1"
  [ -f "$db" ] || return 1
  [ "$(head -c 16 "$db" 2>/dev/null)" = $'SQLite format 3\0' ]
}

restore_or_fail() {
  local db="$1"

  if [ -f "$db" ] && is_valid_sqlite "$db"; then
    echo "[entrypoint] existing valid DB at $db; skipping restore"
    return 0
  fi

  if [ -f "$db" ]; then
    echo "[entrypoint] WARNING: existing DB at $db is not a valid SQLite file; restoring over it" >&2
    rm -f "$db" "$db-wal" "$db-shm"
  fi

  echo "[entrypoint] no local DB at $db; attempting Litestream restore"
  # -if-replica-exists: exit 0 when the replica is absent (S3 reachable) OR
  # when it was restored; exit non-zero when S3 is unreachable/misconfigured.
  if litestream restore -if-replica-exists -config /etc/litestream.yml "$db"; then
    echo "[entrypoint] restored $db (or no backup exists yet)"
    return 0
  fi

  # Restore failed because S3 is unreachable/misconfigured. Do NOT start fresh
  # unless explicitly allowed, to avoid silently discarding data.
  if [ "$ALLOW_FRESH_START" = "true" ]; then
    echo "[entrypoint] WARNING: restore failed for $db; starting fresh (LITESTREAM_ALLOW_FRESH_START=true)" >&2
    return 0
  fi

  echo "[entrypoint] ERROR: no local DB and restore failed for $db (S3 unreachable or misconfigured)." >&2
  echo "[entrypoint] Refusing to start fresh to avoid data loss." >&2
  echo "[entrypoint] If this is intentional, set LITESTREAM_ALLOW_FRESH_START=true." >&2
  exit 1
}

for db in "${STATIC_DBS[@]}"; do
  mkdir -p "$(dirname "$db")"
  restore_or_fail "$db"
done

# Run the app under `litestream replicate`: Litestream monitors the static
# databases and replicates changes to S3 continuously, while forwarding
# signals to the Bun process.
exec litestream replicate -config /etc/litestream.yml \
  -exec "bun run packages/appserver/src/index.ts"
