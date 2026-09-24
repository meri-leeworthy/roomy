# @roomy/discord-bridge

Unidirectional Discord → Roomy bridge. Listens to Discord gateway events, persists state in SQLite, and writes to Roomy spaces via the appserver XRPC interface. The bridge never mutates Discord — no channel topics, no marker messages, no webhooks, no role manipulation.

## Architecture

```
Discord Gateway ──► Bot event handlers
                        │
                        ▼
                  ingestDiscordMessage()  ── shared ingestion path
                        │
                  ┌─────┴──────┐
                  │  Dedup via  │
                  │  SQLite     │
                  │  id_mappings│
                  └─────┬──────┘
                        │
                        ▼
                  SpaceManager ──► Appserver (XRPC) ──► Roomy
```

- **Unidirectional**: Discord → Roomy only. No events flow back to Discord.
- **SQLite-backed**: All sync state (ID mappings, cursors, allowlists, profile hashes) lives in a single `bridge.sqlite` file. No LevelDB, no extensions-based dedup.
- **No Discord-side writes**: The bot never sends messages, creates webhooks, edits channel topics, or manages roles. It only reads.
- **Backfill on connect/reconnect**: On every gateway READY event, walks Discord history forward from saved per-channel cursors for each bridged channel.
- **Shared ingestion**: Live messages and backfill use the same `ingestDiscordMessage()` path — identical dedup, room resolution, and event dispatch.

### Directory structure

```
src/
├── index.ts                   # Entry point, gateway wiring, graceful shutdown
├── env.ts                     # Environment variable validation
├── api.ts                     # HTTP API server (/info, /get-guild-id, /get-space-id, /bridges)
├── logger.ts                  # Structured logging
├── db/
│   ├── schema.ts              # SQLite migrations
│   └── repository.ts          # BridgeRepository (all state access)
├── discord/
│   ├── types.ts               # Discordeno property deserialization
│   ├── cache.ts               # Proxy cache extension
│   └── slash-commands.ts      # Slash command registration + handlers
├── roomy/
│   ├── client.ts              # ATProto session + Roomy client init
│   └── space-manager.ts       # Space connection lifecycle (connect/disconnect)
├── services/
│   ├── message-ingestion.ts   # Core message → Roomy event pipeline
│   ├── message-edit-delete.ts # Edit and delete propagation
│   ├── reaction-sync.ts       # Reaction add/remove sync
│   ├── profile-sync.ts        # Discord user profile → updateProfile events
│   ├── room-sync.ts           # Room/sidebar/thread creation + thread handling
│   └── backfill.ts            # History backfill on READY
└── utils/
    ├── hash.ts                # SHA-256 fingerprinting for profile dedup
    └── emoji.ts               # Emoji parsing (unicode + custom)
```

### Synced event types

| Discord event           | Roomy event                     | Notes                                            |
| ----------------------- | ------------------------------- | ------------------------------------------------ |
| MESSAGE_CREATE          | `createMessage.v0`              | Dedup by Discord message ID → Roomy ULID mapping |
| MESSAGE_UPDATE          | `editMessage.v0`                | Skips if no prior mapping exists                 |
| MESSAGE_DELETE          | `deleteMessage.v0`              | Skips if no prior mapping exists                 |
| THREAD_CREATE           | `createRoom` + `createRoomLink` | Thread auto-inherits parent channel's bridge     |
| MESSAGE_REACTION_ADD    | `addBridgedReaction.v0`         |                                                  |
| MESSAGE_REACTION_REMOVE | `removeBridgedReaction.v0`      |                                                  |
| (per-message)           | `updateProfile.v0`              | Hash-based change detection on author profile    |

## Initial structure sync (one-shot)

When a guild is first bridged, its **category structure and channel order** are
mirrored into the space's sidebar: each Discord category becomes a Roomy
sidebar category, and channels are placed in their category **in Discord
`position` order**.

This happens **once**, and never again. The Roomy sidebar belongs to the
space's admins after the import, so a later Discord rename, move, or reorder —
or a new channel — must not stomp their layout. There is deliberately no
ongoing re-sync, no polling loop, and no periodic reconciliation.

**What "once" means, mechanically.** `services/room-sync.ts`'s
`syncInitialStructure` is called only from `runBackfill` — the initial-sync
path (gateway `READY`, `/connect-roomy-space`, `/roomy-backfill`). The live
gateway handlers (`handleChannelCreate`, `handleChannelUpdate`,
`handleThreadCreate`) do **not** call it: those fire on ongoing Discord events,
and a structure write there is exactly the re-sync this design rules out.

`syncInitialStructure` is additionally guarded by a persisted marker in the
bridge's own SQLite DB (`structure_sync`, migration 7), keyed by
`(guild_id, space_did)`:

- `claimStructureSync` inserts the row and returns whether the caller created
  it. Only that caller writes structure; every later call — a reconnect, a
  second backfill, a re-run of the slash command, a process restart — gets
  `false` and sends nothing.
- The claim is written **before** any event is sent, so the sync is
  at-most-once by construction: a crash between claim and write cannot re-apply
  the structure on the next run.
- `applied_at` records that the event was actually sent. A claim with a null
  `applied_at` means the sync failed before (or during) the write — the
  structure is simply absent, and the claim stays set rather than being rolled
  back, because a retry could otherwise apply it twice.
- The one exception, `releaseStructureSync`, runs only on the path that
  provably sent nothing (no bridged channels to place, e.g. the first backfill
  ran before room creation succeeded), so the single initial sync still happens
  once rooms exist.

The guard lives in the bridge's DB rather than as a check against the live
sidebar on purpose: a sidebar check cannot distinguish "not yet synced" from
"an admin has since rearranged it", and would re-apply the structure in the
latter case. Admin edits win — the bridge does not touch the sidebar after the
initial import.

**Merging, not overwriting.** The event is a `space.roomy.space.updateSidebar.v1`
that merges into what's already there: existing categories are preserved and
matched to Discord categories **by name** (Roomy category ids are assigned by
whoever wrote the sidebar, so a name is the only handle the two systems share),
existing children keep their place ahead of the appended Discord channels, and
channels in no Discord category are appended to the first category — where the
client renders orphans in its edit view.

A Discord category is a grouping header, never a bridged room: `type 4` is
excluded from room creation (`CATEGORY_TYPE` in `discord/data.ts`). Likewise
threads are excluded from the structure read, because Discord reports a
thread's `parent_id` as its *channel*, not its category — `parentId` is only a
category on a non-thread channel.

Events carry two extensions:

- `discordMessageOrigin.v0` — debug breadcrumb (snowflake, channelId, guildId). Never read for sync decisions.
- `authorOverride.v0` — content-level puppetting so Roomy renders the Discord author's identity.

## Structure-sync recovery tool (`src/scripts/recover-sidebar.ts`)

The one-shot structure sync merges **into** the space's existing sidebar —
by design, for spaces bridged at creation the merge target is the space's
seed sidebar, so the sync's write is the *first* non-seed layout. For spaces
that were bridged **before** the structure-sync feature shipped (TASK-140
fallout), that merge produced duplicated/reorganized sidebars from the
pre-existing admin layout, which was preserved "behind" the sync write but
is still recoverable from the appserver's event log.

The recovery tool classifies every `structure_sync` row by replaying the
space's sidebar-write history from the appserver's `stream_events` log:

- **`untouched`** — the bridge-authored `updateSidebar.v1` write is the
  latest sidebar change in the log. The bridge DID (`stream_events.user`) and
  `applied_at` identify the sync write unambiguously; the last sidebar write
  *before* it is the pre-sync state. `--apply` restores exactly that state.
- **`edited`** — a non-bridge author wrote a sidebar update after the sync.
  The space's admins own the layout now; leave it.
- **`multi-sync`** — the space received more than one bridge-authored
  sidebar write (two guilds bridged to one space, or a crashed claim
  re-synced). Reverting one write would leave an intermediate merge state;
  manual review.
- **`unapplied` / `no-sync-event`** — nothing (or nothing attributable) was
  written; nothing to revert.

```bash
# Report (read-only; needs the appserver's events SQLite, not the bridge's):
bun run src/scripts/recover-sidebar.ts \
  --events-db /var/lib/appserver/events.sqlite \
  --bridge-db ./data/bridge.sqlite

# Machine-readable report (one JSON object per line):
bun run src/scripts/recover-sidebar.ts --events-db ... --json

# Restore the pre-sync sidebar for every untouched bridge (writes as the
# bridge's ATProto identity via sendEvents):
bun run src/scripts/recover-sidebar.ts --events-db ... --apply --yes
```

`--apply` requires `--yes` and the bridge env (`ATPROTO_BRIDGE_DID`,
`ATPROTO_BRIDGE_APP_PASSWORD`, `APPSERVER_URL`, `APPSERVER_DID`). If
`ATPROTO_BRIDGE_DID` is not set for the report run, attribution falls back
to timestamps (`created_at` vs `applied_at`, within 10 min) and is flagged as
weaker — pass it whenever possible. Restoring a sidebar from deprecated
`updateSidebar.v0` events (which carry no category ids) synthesizes stable
ids, since v1 requires them.

## Environment variables

### Required

| Variable                      | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| `DISCORD_TOKEN`               | Discord bot token                                       |
| `ATPROTO_BRIDGE_DID`          | DID of the ATProto identity the bridge authenticates as |
| `ATPROTO_BRIDGE_APP_PASSWORD` | App password for ATProto authentication                 |
| `APPSERVER_URL`               | Appserver HTTP origin (e.g. `http://127.0.0.1:8080`)    |
| `APPSERVER_DID`               | DID of the appserver service                            |

### Optional

| Variable             | Default                            | Description                                                                      |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `STREAM_NSID`        | `space.roomy.space.personal.dev`   | Stream NSID                                                                      |
| `STREAM_HANDLE_NSID` | `space.roomy.space.handle.dev`     | Handle NSID                                                                      |
| `BRIDGE_DATA_DIR`    | `./data`                           | Directory for SQLite database                                                    |
| `BRIDGE_DB_PATH`     | `${BRIDGE_DATA_DIR}/bridge.sqlite` | Path to SQLite database                                                          |
| `PORT`               | `3301`                             | HTTP port for bridge API (`/info`, `/get-guild-id`, `/get-space-id`, `/bridges`) |
| `LOG_LEVEL`          | `info`                             | Log level                                                                        |
| `BRIDGE_RECONNECT_BASE_MS` | `5000`                       | Base delay (ms) for the shared reconnect backoff to a failing appserver          |
| `BRIDGE_RECONNECT_MAX_MS`  | `300000`                     | Max delay (ms) cap for the shared reconnect backoff                              |
| `SYSTEM_SPACE`             | *(unset)*                    | Space DID for admin system messages (capacity alerts)                            |
| `SYSTEM_CHANNEL`           | *(unset)*                    | Channel ULID for admin system messages; both must be set to enable               |
| `BRIDGE_CAPACITY_KILL_SWITCH` | `false`                   | `true`/`1` disables per-guild capacity checks globally (emergency re-enable)      |

## Capacity enforcement (Roomy Pro)

Bridged (guild, space) tuples are checked against `space.roomy.admin.getSpaceMembership`, which reports the space's member count vs its token capacity (`maxMembers`). Decisions are cached for 300s per tuple; the bridge re-checks at startup, every 5 minutes, and on `guildMemberAdd`/`guildMemberRemove`.

Two thresholds drive the policy:

- **Over the capacity threshold** (`memberCount > maxMembers`): sync **continues**, but the bridge posts a notice to the admin system channel (`SYSTEM_SPACE`/`SYSTEM_CHANNEL`) — bridging is at risk, not yet paused.
- **Hard stop** (`memberCount >= 2x maxMembers`): ALL sync for the tuple halts (messages, edits, room/thread creation, profile sync, backfill) and the guild owner is DMed. Sync resumes automatically once a later check finds the member count back below 2x capacity.

System messages are sent as the bridge's ATProto account, so that account must be a member of `SYSTEM_SPACE` with write access to `SYSTEM_CHANNEL`. If either env var is unset, notifications are disabled and enforcement proceeds silently.

## Slash commands

All commands require **Administrator** permissions and only work in guilds.

| Command                                                          | Description                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/connect-roomy-space space-id:<did>`                            | Connect a Roomy space to this Discord guild (full mode)                           |
| `/disconnect-roomy-space [space-id:<did>]`                       | Disconnect a bridged space. Omit space-id if only one bridge exists.              |
| `/roomy-status`                                                  | Show all connected bridges and their mode                                         |
| `/roomy-bridge-channel add channel:#channel [space-id:<did>]`    | Add a channel to the allowlist (switches bridge to subset mode if currently full) |
| `/roomy-bridge-channel remove channel:#channel [space-id:<did>]` | Remove a channel from the allowlist. Existing synced messages are preserved.      |
| `/roomy-bridge-channel list [space-id:<did>]`                    | List channels in the allowlist                                                    |

## Subset mode

Bridges start in **full mode** (all text channels in the guild are synced). Adding a channel via `/roomy-bridge-channel add` switches the bridge to **subset mode** — only explicitly allowlisted channels are synced. Thread children of allowlisted channels are synced automatically.

Channels removed from the allowlist stop receiving new messages; previously synced messages remain in Roomy.

## Deployment

### Docker

The Dockerfile uses a multi-stage Bun build with Litestream for SQLite WAL replication to S3-compatible storage.

```bash
docker build -f packages/discord-bridge/Dockerfile -t roomy-discord-bridge .
```

Required runtime env:

```bash
docker run -d \
  -e DISCORD_TOKEN=... \
  -e ATPROTO_BRIDGE_DID=... \
  -e ATPROTO_BRIDGE_APP_PASSWORD=... \
  -e APPSERVER_URL=... \
  -e APPSERVER_DID=... \
  -e S3_BUCKET=... \
  -e S3_ENDPOINT=... \
  -e S3_REGION=... \
  -e S3_ACCESS_KEY_ID=... \
  -e S3_SECRET_ACCESS_KEY=... \
  -v bridge-data:/data \
  roomy-discord-bridge
```

The entrypoint restores the SQLite database from S3 on first start (if no local DB exists) and wraps the Bun process with Litestream for continuous replication.

### Local development

```bash
cp .env.example .env
# Fill in DISCORD_TOKEN, ATPROTO_BRIDGE_DID, ATPROTO_BRIDGE_APP_PASSWORD,
# APPSERVER_URL, APPSERVER_DID
bun install
bun run dev       # watch mode
bun run start     # production mode
```

