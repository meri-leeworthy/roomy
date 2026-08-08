#!/usr/bin/env bash
set -euo pipefail

# ── Roomy appserver Docker entrypoint ────────────────────────────────────
#
# Restores the appserver's static SQLite databases from S3 (via Litestream)
# when no local copy exists, then starts the app wrapped in `litestream
# replicate` so every WAL change is continuously copied to the backup bucket.
#
# On Railway the appserver runs without persistent disk, so /app/data is
# wiped on every deploy — the local DBs are absent on boot and restored from
# the S3 backup before the app starts. If a local copy already exists (e.g.
# a Railway volume is attached), the local DB wins and replication continues
# from there.
#
# Only the STATIC DBs (see litestream.yml) are restored. Per-space DBs under
# /app/data/spaces/ are derived and regenerate lazily via backfill on first
# access, so they are intentionally not replicated or restored here.

DATA_DIR="${APPSERVER_DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/spaces"

# Restore each static database individually, but only if a local copy is
# missing. `-if-replica-exists` makes the restore a no-op (exit 0) when no
# backup has been written to the bucket yet (fresh bucket / first deploy).
STATIC_DBS=(
  "$DATA_DIR/roomy.sqlite"
  "$DATA_DIR/roomy-readstate.sqlite"
  "$DATA_DIR/roomy-events.sqlite"
  "$DATA_DIR/global.sqlite"
)

restore_if_missing() {
  local db="$1"
  if [ ! -f "$db" ]; then
    echo "[entrypoint] no local DB at $db; attempting Litestream restore"
    litestream restore -if-replica-exists -config /etc/litestream.yml "$db" || \
      echo "[entrypoint] no backup for $db yet; starting fresh"
  else
    echo "[entrypoint] existing DB at $db; skipping restore"
  fi
}

for db in "${STATIC_DBS[@]}"; do
  restore_if_missing "$db"
done

# Run the app under `litestream replicate`: Litestream monitors the static
# databases and replicates changes to S3 continuously, while forwarding
# signals to the Bun process.
exec litestream replicate -config /etc/litestream.yml \
  -exec "bun run packages/appserver/src/index.ts"
