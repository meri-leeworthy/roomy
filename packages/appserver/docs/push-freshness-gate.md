# Push flood from replayed messages — mechanism and mitigation

**Date:** 2026-09-16
**Task:** TASK-151 (P0). Reported by Meri: "a commit was pushed to production
adding an index on room read cursors. This inadvertently caused a flood of push
notifications from old messages. The mechanism causing this hasn't been
identified. The deployment was reverted."
**Status:** mechanism identified (below); mitigation shipped in this branch.

## Summary

The flood was **not** caused by the index. It was caused by the **Discord
bridge replaying its entire channel history into the live `sendEvents` path**,
and by a push pipeline that had **no notion of message age anywhere**.

The replayed messages were genuinely old (hours to months), but:

- they were submitted to the appserver as ordinary live `createMessage` events
  (`applyBatch(..., { isBackfill: false })`), and
- the only time the push path carried was `decodeTime(event.id)` — the event
  **ULID**, which is *fresh at replay time*, not the message's real timestamp.

So every replayed message looked new to every downstream gate, and each one
produced an immediate push.

## Evidence (production, 2026-09-16)

All times UTC. Source: Grafana Cloud Loki (`service_name="appserver"` and
`"discord-bridge"`).

### 1. The index deploy is a co-factor, not the cause

`/health`'s `build_id` identifies the running build exactly:

| time | build | note |
|---|---|---|
| 01:46:53 | `a0e5f2de` | previous build |
| 03:58:35 | `8e66e829` | **the index commit**, deployed |
| 04:03:42 | `unknown` | **rolled back** (see limitation below) |

`8e66e829` adds exactly one runtime statement —
`create index if not exists idx_read_positions_room on read_positions(room_id)`
in `db/readStateSchema.sql`. Both write-path queries were `where room_id = ?`
before and after; an index changes the *plan*, never the *matching rows*. It
cannot manufacture a row that did not exist.

The push volume also **begins before the deploy**:

```
03:44:xx  push deliveries ramp up   (build a0e5f2de — pre-index)
03:58:35  build 8e66e829 becomes live
04:00–04:05  654 "deliver busy" lines in 5 minutes
04:10:00  push-evaluate activity stops
```

Correlation with the deploy is real; causation is not. The deploy is what
*restarted the process*, which is why the symptom looked deploy-coupled.

**Limitation:** there is no revert commit in git — `8e66e829` is still the tip
of `main`/`next`. "The deployment was reverted" was a Railway redeploy to a
previous image, and the post-rollback build reports `build_id: "unknown"`
(separate open TASK-150). The post-flood build revision therefore cannot be
confirmed from logs; only that it differs from `8e66e829`.

### 2. The replay is the source

`discord-bridge`, scope `backfill`:

```
03:35:02  Backfilling channel 1300595609417552015 → did:plc:yhcspkk2… (cursor: none)
03:35:11  Channel … backfill done: 5 synced, 1 skipped
03:35:12  Backfilling channel 1300586600131989556 → did:plc:yhcspkk2… (cursor: none)
…
03:41:31  Backfilling channel 1290974177662337076 → …  backfill done: 34 synced
03:46:22  Backfilling channel 1282600298745040971 → …  backfill done: 189 synced
```

`cursor: none` means **first-time backfill from the beginning of the channel**
(`backfillChannel`, `services/backfill.ts`: the initial `afterCursor` is the
channel snowflake itself, older than every message). Hundreds of channels were
replayed back-to-back across the window.

Each replayed message is sent via `ingestDiscordMessage` →
`roomy.sendEvent(spaceDid, event)` → XRPC `space.roomy.space.sendEvents`, and
`ingestDiscordMessage` tags it with the historical send time:

```ts
"space.roomy.extension.timestampOverride.v0": {
  $type: "space.roomy.extension.timestampOverride.v0",
  timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
}
```

The appserver's `sendEvents` is the **live** path — it hard-codes
`{ isBackfill: false }` and pokes the push dispatcher for every `createMessage`
with no backfill gate (`StreamManager.ts`, step 6b). The comment there even
states "sendEvents is only ever called with live events" — which is false for
the bridge's replay.

### 3. The replayed messages were pushed regardless of true age

The bridge log reports **`n synced`** per channel. Every synced message
surfaces in the appserver as:

```
{"scope":"push-evaluate","msg":"messageContent for 01M2M5BVQBP4B5W541YF1BZEHF: jakarta has the best public transport…"}
```

These are the **historical Discord messages** (their icons resolve to
`cdn.discordapp.com/avatars/…`, and their content matches the bridged channel
history).

### 4. Delivery rate and scale

- `push-evaluate … "deliver busy"`: **654 deliveries in 04:00–04:05** (55, 167,
  258, 126, 48 per minute), against a baseline of ~2–8/minute all day.
- Delivery is to every subscription of every `busy`-level member: one delivery
  line reads `(4 subscription(s))`, so one message can produce several OS
  notifications.
- Because `level` is **per space** (`push_preferences`), any user with
  `busy` on the bridged space received a push **for every replayed message in
  every replayed channel**.

### 5. The push pipeline applies no age check anywhere

The enqueue site built each job's time from the event ULID:

```ts
timestamp: decodeTime(e.id),
```

For a replay this is *now*, not the message's time. `evaluatePush` then
consults `resolveLevel` and `roomAccess` and delivers — no age term exists in
`evaluate.ts`, `dispatcher.ts`, or `types.ts`. The `timestampOverride`
extension was already handled correctly on the *materialisation* paths
(`canonicalMessageTimestamp`, `materialize/sortIdx.ts`) but was never consulted
by push at all.

## Hypotheses considered and what the evidence says

- **H1 — boot-time digest sweep fires stale `notification_state` rows.**
  *Not supported as the flood mechanism.* Counted by message text: zero
  `engaged digest` and zero digest-sweep deliveries in the window. (The
  dispatcher's per-recipient decisions, e.g. `…not mentioned`, are logged at
  **debug**, and production emits **no debug lines at all**, so this is
  negative evidence from the info-level delivery lines, not a full picture.)
  The sweep *is* nonetheless a real deploy-coupled hazard and is guarded —
  see mitigation 3.

- **H2 — the schema `exec` blocks the read-state worker; clients retry and
  re-send historical messages.** *Not supported.* 468 sampled messages in the
  flood window are **468 distinct ids with zero repeats** — a retry storm would
  re-send the *same* ULIDs. No 5xx responses were logged during the window.

- **H3 — the Discord bridge replay over the live path (identified).** Supported
  by: bridge `backfill … (cursor: none)` lines throughout the window;
  `push-evaluate` lines carrying historical Discord message content/avatars;
  the `timestampOverride` extension being present on exactly these events; and
  the absence of any other high-volume writer (the appserver's own
  `sendEvents` writer breakdown for the window shows the bridge service and no
  bulk client).

- **H1 and H3 are not mutually exclusive**: a replay both *emits* an immediate
  push per message **and** seeds `notification_state` rows for engaged
  recipients, which the sweep later fires. H3 dominates by two orders of
  magnitude on the evidence; the mitigation covers both.

## Mitigation

Three changes, each "impossible by construction" on the path it guards.

### 1. Freshness gate on every push job (`push/freshness.ts`)

New `isPushFresh(job, now)` compares the message's **canonical** timestamp
(`canonicalMessageTimestamp` — the `timestampOverride` extension for bridged
messages, else the ULID time) against `PUSH_MAX_MESSAGE_AGE_MS` (5 minutes).

Applied at the single enqueue site (`StreamManager`, step 6b): stale messages
are dropped from the poke entirely — no immediate push, **and** no
`notification_state` batch seeded for engaged recipients. A
`[push-freshness] suppressed N/M` line makes any future replay visible in
production within seconds.

The window is 5 minutes because it only has to absorb clock skew and pipeline
latency: the live path measures 0–28s end-to-end in this incident's own
evidence, so 5 minutes is ~10× the observed worst case. A replay is
hours-plus old, so the exact constant is not load-bearing.

Undecodable event ids are treated as **fresh**, deliberately: this is an age
check, and silently dropping a live notification because its age is unknown is
the opposite — and worse — failure.

### 2. Serialized bridge replay (`discord-bridge/services/backfill.ts`)

`runBackfill` previously fired every `(channel, space)` task through
`Promise.allSettled`. Replay now runs **one task at a time**, so it is a single
stream of writes that live traffic interleaves with, rather than a parallel
replay that starves the live path and multiplies the flood.

### 3. Digest age ceiling (`push/dispatcher.ts`)

The sweep now drops (deletes) `notification_state` rows whose
`first_unseen_at` is older than `PUSH_MAX_DIGEST_AGE_MS` (24h) instead of
firing them. This is what makes the sweep safe to run on **every restart** —
the deploy-coupling that made the flood look index-triggered. The 1h
`DIGEST_WINDOW_MS` still governs *when* a fresh batch fires; the ceiling only
decides when a batch is too old to be worth firing at all. `read_positions`
(and therefore the unread counter) is untouched, so nothing user-visible is
lost.

### Tests

- `push/freshness.test.ts` — the gate's contract, including the boundary at
  exactly `PUSH_MAX_MESSAGE_AGE_MS`.
- `streams/pushFreshnessGate.test.ts` — the enqueue seam: a live message is
  poked; a historical message ingested now is **not**; a mixed batch pokes only
  the live ones; a bridged message keeps its override time.
- `push/digestSweepFreshness.test.ts` — the sweep drops a stale batch and
  leaves a fresh overdue one for delivery.

Both new suites were confirmed to **fail with the guards disabled** (the
pre-fix behaviour) and pass with them enabled.

## Follow-ups (not in scope here)

- The bridge re-sending history through the *live* XRPC path is the root cause;
  a replay-marker the appserver can honour (`isBackfill: true` semantics) would
  let it be throttled and de-prioritised rather than merely gated.
- `sendEvents` still has no backpressure: the bridge's replay and live
  user traffic share one serialized write path per stream.
- `/health`'s `build_id: "unknown"` (TASK-150) blocked confirming the deployed
  revision here.
