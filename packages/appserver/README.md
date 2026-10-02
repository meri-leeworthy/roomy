# Roomy Appserver (a.k.a. AppView)

Mediates access to its own local SQLite event store via the ATProto XRPC interface.

## Development

Most XRPC methods are authenticated by proxying via the PDS. The appserver can be run and used locally but to be accessible to a public PDS, must be tunneled to the public web, e.g. `tailscale funnel 8080`. The tunneled endpoint becomes the DID e.g. `did:web:device.tail12345.ts.net`. These should be set in `.env`. 

The appserver owns its event store locally; no external event-stream server (Leaf) is required as a runtime dependency.

`APPSERVER_PERSONAL_STREAM_NSID` will determine the collection to refer to for the personal stream. The appserver caches the personal stream DID with no TTL, so the `roomy.sqlite` db files need to be deleted to clear that cache. The `roomy-readstate.sqlite` db is only used to store unread count read states. It is meant as a persistent source of truth whereas the `roomy` db is derived data.

## Deployment

Deployed on Railway from `Dockerfile.appserver` (build context is the repo root).

### Backup & restore (Litestream → S3)

The container runs several SQLite databases in WAL mode under `/data`, a
Railway persistent volume that survives deploys (see
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

The `/data` volume persists across deploys, so the DBs (including the
per-space views and their `materialization_cursor`) are not wiped on redeploy.
On boot, an existing valid local DB wins and replication simply continues; a
DB is only restored from S3 when it is absent or corrupt (first deploy, or a
manual reset). This is what makes boot re-materialisation cheap: with the
per-space DBs intact, re-materialisation skips caught-up spaces instead of
rebuilding every space on each deploy.

### Fail-closed restore (data-loss protection)

Because `/data` is a persistent volume, a redeploy with a failed or missing
backup still has its local DBs and does not silently discard data. The
entrypoint still **refuses to start fresh** as a safety net for the case where
a local DB is absent AND no backup can be restored, unless the operator has
explicitly opted in:

- If a local DB exists and is a valid SQLite file, it is used as-is.
- If a local DB is missing (or corrupt), the entrypoint restores it from S3.
- If the restore fails (no backup yet, or S3 unreachable/misconfigured), the
  container **exits with an error** instead of starting fresh.
- For the **very first deploy** (no backup exists yet), set
  `LITESTREAM_ALLOW_FRESH_START=true` to allow a fresh start. Leave it unset
  (or `false`) on all subsequent deploys so a backup failure fails loudly
  rather than wiping data.

### Schema version bumps (blue-green read serving)

When `SPACE_SCHEMA_VERSION` (`src/db/db.ts`) is bumped, every on-disk per-space
DB (`spaces/*.sqlite`) is on a stale schema. The appserver does **not** wipe
them. Instead it serves reads from the old DB while a temp new-schema DB
(`<spaceDid>.sqlite.new`) is rebuilt from the event log in the background, then
atomically swaps it in (`spaceRebuildBegin` → replay → `spaceRebuildCommit`).

- Reads keep serving pre-deploy data during the rebuild — a space never
  appears empty after a schema bump.
- Writes to a rebuilding space are rejected with a retryable `409`
  (`SpaceRematerializing`) and do **not** land in the event log.
- If a rebuild fails, it is aborted and the old DB keeps serving; the next boot
  retries it.

See `docs/plans/blue-green-read-serving.md` for the full design and the
L1/L2/L3 test layers that prove the invariants.

### Setting up the Railway S3 bucket

1. In Railway, create a **Storage** service and add an **S3** bucket.
2. Link the bucket to the appserver service. Railway injects these variables:
   `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`. No other config is needed — Litestream reads them
   from the environment.

Litestream is only active when the app runs in the container. For local
development, run the appserver directly (`bun run packages/appserver/src/index.ts`)
with no backup config.

## Lexicons

`lexicons/` holds the ATProto JSON lexicons this service defines, grouped by
NSID path. The XRPC definitions here are the contract for third-party clients
and are mirrored into the SDK by `packages/sdk/scripts/generate-lexicons.ts`;
pure **record** collections (no query, no procedure — e.g.
`space/roomy/user/profile.json`) are not generated into the SDK and live only
in this directory. Nothing here is served over HTTP: the appserver answers
`/.well-known/did.json` and XRPC, nothing else.

### Publishing a record lexicon

For another app to resolve a record collection over the network, its lexicon
must be published as a `com.atproto.lexicon.schema` record, with the rkey set
to the NSID, in the repo of the NSID's authority.

The authority is derived from the NSID, not from the `roomy.space` apex: drop
the name segment, reverse the rest, and look up `_lexicon.<that domain>`. The
lookup is not hierarchical — a resolver never falls back to a parent or child
domain — so NSIDs that differ in any segment but the last have different
authorities, and each needs its own TXT record:

| NSID | Authority lookup |
| --- | --- |
| `space.roomy.user.block` | `_lexicon.user.roomy.space` |
| `space.roomy.authComplete` | `_lexicon.roomy.space` |

Measured state (2026-10-02):

| Lookup | TXT value | Lexicons published there |
| --- | --- | --- |
| `_lexicon.roomy.space` | `did=did:plc:cyqufxsezk33hqulcilckna6` | `space.roomy.authComplete` only |
| `_lexicon.user.roomy.space` | absent | — |

`did:plc:cyqufxsezk33hqulcilckna6` is the `roomy.space` account. The
appserver's own `did:web:api.roomy.space` cannot hold these records: its DID
document carries an `#atproto` verification key and an appserver service
entry, but no `#atproto_pds`, so it has no repo to publish into.

The reason to publish differs by lexicon kind. A permission set must resolve:
an authorizing PDS resolves an `include:` scope, and a set that cannot be
resolved fails the session — which is why Roomy's one published lexicon,
`space.roomy.authComplete`, is published at all. A record collection does not:
the appserver writes the collection name as a literal and never resolves the
NSID, which is how `space.roomy.user.profile` has been read since it shipped.
Publishing one buys third-party resolution and nothing at runtime.

Publishing is an **out-of-band** step: it needs credentials for whichever
account holds the repo, which the appserver does not have, and it is not part
of the build or deploy. Land the lexicon file here first, then publish with an
authenticated agent for that DID:

```
com.atproto.repo.putRecord { repo: <authority-did>, collection: "com.atproto.lexicon.schema", rkey: <NSID>, record: <the lexicon file> }
```

The record is the lexicon document itself plus `$type:
"com.atproto.lexicon.schema"`. Verify with `com.atproto.repo.listRecords` on
the authority repo (collection `com.atproto.lexicon.schema`).

**Outstanding:** `space/roomy/user/block.json` has no authority to publish
under yet — `_lexicon.user.roomy.space` does not exist — and no record exists.
