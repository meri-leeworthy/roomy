# Roomy Appserver (a.k.a. AppView)

Mediates access to its own local SQLite event store via the ATProto XRPC interface.

## Development

Most XRPC methods are authenticated by proxying via the PDS. The appserver can be run and used locally but to be accessible to a public PDS, must be tunneled to the public web, e.g. `tailscale funnel 8080`. The tunneled endpoint becomes the DID e.g. `did:web:device.tail12345.ts.net`. These should be set in `.env`. 

The appserver owns its event store locally; no external event-stream server (Leaf) is required as a runtime dependency.

`APPSERVER_PERSONAL_STREAM_NSID` will determine the collection to refer to for the personal stream. The appserver caches the personal stream DID with no TTL, so the `roomy.sqlite` db files need to be deleted to clear that cache. The `roomy-readstate.sqlite` db is only used to store unread count read states. It is meant as a persistent source of truth whereas the `roomy` db is derived data.

## Deployment

Deployed on Railway from `Dockerfile.appserver` (build context is the repo root).

### Backup & restore (Litestream → S3)

The container runs several SQLite databases in WAL mode under `/app/data` (see
`docs/plans/per-space-dbs.md` for the per-space split):

| DB | Path | Kind |
|---|---|---|
| event log | `roomy-events.sqlite` | **source of truth** (append-only) |
| read-state | `roomy-readstate.sqlite` | persistent source of truth (unread) |
| global membership | `global.sqlite` | derived (regenerable from event log) |
| per-space views | `spaces/<spaceDid>.sqlite` | derived (re-materialised from event log) |

The Docker entrypoint (`packages/appserver/docker-entrypoint.sh`) restores the
**static** DBs (`roomy-events.sqlite`, `roomy-readstate.sqlite`, `global.sqlite`)
from an S3-compatible bucket via Litestream when no local copy exists, then
runs the app under `litestream replicate` so every WAL change is continuously
copied to the bucket. Replication config lives in
`packages/appserver/litestream.yml`.

The **per-space DBs** (`spaces/*.sqlite`) are deliberately *not* replicated:
they are derived data that regenerate lazily via re-materialisation from the
event log on first access after a restore (litestream also needs static paths,
which can't enumerate an unbounded set of spaces).

Railway gives the appserver no persistent disk, so `/app/data` is wiped on
every deploy — the static DBs are re-restored from the backup at boot. If a
Railway volume is later attached, an existing local DB wins and replication
simply continues.

### Fail-closed restore (data-loss protection)

Because `/app/data` is ephemeral, a redeploy with a failed or missing backup
would silently discard all data if the container just "started fresh". The
entrypoint therefore **refuses to start fresh** unless it can restore a backup
or the operator has explicitly opted in:

- If a local DB exists and is a valid SQLite file, it is used as-is.
- If a local DB is missing (or corrupt), the entrypoint restores it from S3.
- If the restore fails (no backup yet, or S3 unreachable/misconfigured), the
  container **exits with an error** instead of starting fresh.
- For the **very first deploy** (no backup exists yet), set
  `LITESTREAM_ALLOW_FRESH_START=true` to allow a fresh start. Leave it unset
  (or `false`) on all subsequent deploys so a backup failure fails loudly
  rather than wiping data.

### Setting up the Railway S3 bucket

1. In Railway, create a **Storage** service and add an **S3** bucket.
2. Link the bucket to the appserver service. Railway injects these variables:
   `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`. No other config is needed — Litestream reads them
   from the environment.

Litestream is only active when the app runs in the container. For local
development, run the appserver directly (`bun run packages/appserver/src/index.ts`)
with no backup config.
