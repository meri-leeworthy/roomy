# Server-side Mentions Subscription Plan

**Status:** Implemented
**Date:** 2026-08-18
**Related:** `mentions-plan.md` (mentions extension for web push — implemented)

## Problem

The omp agent bridge (`roomy-cli listen`) currently subscribes to **every room**
(`room:<id>`) it cares about and filters mentions **client-side**. That has two
problems:

1. **Scales poorly.** N rooms = N subscriptions. As the agent joins more spaces
   and rooms, the bridge maintains a growing list of subs.
2. **The frontend will want this too.** A "mentions" inbox/feed in the Roomy UI is
   a natural product feature. Building it client-side (sub to every room) is
   wasteful; the server should be the one to know "who was mentioned".

## Key enabler: mention detection already happens server-side

The appserver already computes the set of mentioned DIDs for every message at
**materialization time** — `src/materialization/toAppliedEvent.ts` populates
`AppliedEvent.details.mentions` from:

- the legacy `space.roomy.extension.mentions.v0` sidecar extension, **or**
- `#didMention` facets in new-format richtext bodies (via `extractMentionDids`).

`inferSignals` already reads `event.details`. So the server already knows who each
message mentions — we just need to surface it as a subscription.

## Design

A client subscribes **once** to a `mentions:<did>` topic on
`space.roomy.sync.subscribe` and receives a `#mention` frame for every message that
mentions that DID, regardless of room or space.

### 1. New signal type `MentionDiff` (`invalidation/types.ts`)

```ts
export interface MentionDiff {
  /** The mentioned user. */
  did: UserDid;
  spaceId: StreamDid;
  roomId: Ulid;
  seq: number;
  /** Reuse the message snapshot shape from MessageDiff. */
  ops: MessageDiffOp[];
}
```

### 2. Emit in `inferSignals`

In `handleCreateMessage` / `handleEditMessage`, read `event.details.mentions`
(already populated). For each mentioned DID, emit a `MentionDiff` signal carrying
the message snapshot. `handleDeleteMessage` emits a `remove` op.

### 3. New topic kind `mentions` in the sync handler

- Topic string: `mentions:<did>`.
- On `sub`, add to the topic index (mirrors `room:<id>`).
- Route `#mention` frames to connections subscribed to `mentions:<did>`.

### 4. New frame `#mention`

Header `{ op: 1, t: "#mention" }`; body carries the message + context
(`spaceId`, `roomId`, `seq`). Reuses the SDK `Message` schema so the client can
apply it without re-fetching.

### 5. Access control

A connection may only subscribe to `mentions:<ownDid>` — the authenticated DID of
the connection. Enforce in the sub handler (a user can't eavesdrop on another
user's mentions).

### 6. Backfill

New query `space.roomy.mention.getMentions` (params: `did`, `cursor`, `limit`)
returning recent mentions. On subscribe, the client fetches backfill via HTTP,
then receives live `#mention` frames — mirroring the room-topic pattern (sub →
invalidate → HTTP refetch).

## Benefits

- **Bridge subscribes to ONE topic**, not N rooms — simpler to maintain, scales to
  any number of spaces/rooms.
- **Same mechanism powers the Roomy frontend** "mentions" inbox later.
- **Server-side detection is authoritative** — `#didMention` facets carry the
  stable DID, and the appserver already computes it.

## Decisions (implemented)

1. **Frame shape:** dedicated `#mention` frame (header `{op:1, t:"#mention"}`),
   body `{ did, spaceId, roomId, seq, ops }` reusing the SDK `Message` schema.
2. **Backfill:** dedicated `space.roomy.mention.getMentions` query backed by a
   global `mentions` index table (cross-space), dual-written during
   materialization.
3. **Edit/delete:** `editMessage` emits `update` ops (and replaces the index
   rows); `deleteMessage` emits `remove` ops (resolved from the index).
4. **Room context:** the `#mention` frame carries `spaceId`/`roomId` so the
   client can navigate and reply in the right room.
5. **Self-mentions:** the author's own DID is excluded from mention signals and
   index rows.

## Implementation notes

- **Mention detection** was already server-side (`toAppliedEvent.ts` populates
  `AppliedEvent.details.mentions` from the mentions extension or `#didMention`
  facets) — the subscription just surfaces it.
- **Global `mentions` table** (`schema-global.sql`, `GLOBAL_SCHEMA_VERSION` → 5):
  `(did, message_id, space_did, room_id, created_at)`, PK `(did, message_id)`.
  Dual-written by `syncMentionsIndex` in the router's `onEventsApplied`.
- **Access control:** a connection may only subscribe to `mentions:<ownDid>`;
  `getMentions` only returns the caller's own mentions.
- **CLI bridge** (`roomy-cli listen`) now subscribes to `mentions:<agentDid>`
  instead of every room. `--no-mention-only` falls back to room subscriptions.
- **Tests:** inferSignals (4), sync handler (3), mentions index (5).

## Files to touch (when implemented)

- `packages/appserver/src/invalidation/types.ts` — `MentionDiff` signal.
- `packages/appserver/src/invalidation/inferSignals.ts` — emit from message handlers.
- `packages/appserver/src/sync/handler.ts` — `mentions` topic kind + `#mention` routing.
- `packages/appserver/src/xrpc/frame.ts` — `#mention` frame builder.
- `packages/appserver/src/handlers/space.roomy.mention.getMentions.ts` — backfill query.
- `packages/appserver/lexicons/space/roomy/mention/getMentions.json` — lexicon.
- `packages/sdk/src/schemas/frames/mention.ts` — `#mention` frame schema.
- `packages/sdk/src/schemas/queries/getMentions.ts` — backfill query schema.
- `packages/cli/src/listen.ts` — subscribe to `mentions:<did>` instead of every room.
