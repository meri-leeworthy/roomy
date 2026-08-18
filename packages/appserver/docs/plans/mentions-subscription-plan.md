# Server-side Mentions Subscription Plan

**Status:** Proposed (design)
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

## Open questions / decision points

1. **Frame shape:** dedicated `#mention` frame vs. reuse `#messageDiff` with a
   mention context? Dedicated is cleaner for the client (it knows it's a mention
   without re-deriving it).
2. **Backfill:** dedicated `getMentions` query + cursor, or reuse the existing
   `space.roomy.sync.getEvents` stream mechanism?
3. **Edit/delete:** handle `update`/`remove` mention ops (a message edited to
   remove a mention should stop being a mention).
4. **Room context:** the `#mention` frame should carry `spaceId`/`roomId` so the
   client can navigate to the message and reply in the right room.
5. **Self-mentions:** exclude the author's own DID (a user mentioning themselves
   shouldn't get a mention frame) — mirror the bridge's self-filter.

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
