# sendEvents write-path performance review

**Date:** 2026-09-14
**Scope:** `space.roomy.space.sendEvents` (`packages/appserver/src/handlers/space.roomy.space.sendEvents.ts`)
**Evidence:** production Tempo traces + Loki logs (Grafana Cloud), and
`packages/appserver/perf/probe-sendevents.ts` run locally against a real
appserver with the production worker pool.

## Summary

`sendEvents` was blocking on a **third-party HTTP request inside the write
path**. Per-event invalidation called `selectMessages`, which hydrates author
profiles and, for any author missing from the global `profiles` table, issues
an on-demand Bluesky/HappyView fetch. That fetch sat between the caller's HTTP
request and its response.

| config | before | after |
|---|---|---|
| batch 1, concurrency 1 | p50 **450 ms**, 2.2 req/s | p50 **4.0 ms**, ~130–190 req/s |
| batch 1, concurrency 8 | p50 **1957 ms**, 2.1 req/s | p50 **23 ms**, ~240 req/s |

Zero outbound fetches on the write path afterwards (was one per event).

The fix is ~20 lines: internal readers of `selectMessages` now skip the
*network* half of profile hydration while keeping the local global-store read.

## Production evidence

Latency distribution over 6 h: p50 **73 ms**, p95 **398 ms**, p99 **2.45 s**,
max **14.7 s**. The 73 ms p50 is itself the tell — the write path should be a
few DB round-trips.

Trace span breakdown for the slowest requests showed the cost concentrated in
one phase:

```
space.roomy.space.sendEvents   14658ms
  sendEvents.authorize         11449ms
  sendEvents.write              3107ms
```

Loki for the same trace (`trace_id=8c55c461…`):

```
05:37:08.495  sendEvents             (request received)
05:37:20.045  writing to events DB   ← 11.5s gap: authorization
05:37:21.613  materialize done
05:37:23.153  sendEvents done
```

The 11.5 s gap is `checkWriteAuth` for a **single** event, so it is not a batch
that is slow — it is one call to something remote inside the auth check.

The stall is **not** local to the request. In the same second, unrelated reads
on the same space were stalled too:

```
05:37:17   GET admin.getDashboardStats  11215ms
05:37:17   GET room.getMessages          9740ms
05:37:19   GET space.getMetadata        17680ms
05:37:20   GET room.getMetadata         12316ms
05:37:21   GET space.getActivityFeed    13969ms
```

Production pool counters confirm an in-process bottleneck: `roomy_pool_worker_pending`
peaked at **48** on the worker owning this space (`space-5`) and **38** on
`space-4`, with 0 currently — a backlog that builds and drains.

## Root cause

Chain, confirmed by stack capture during the local probe:

```
StreamManager.sendEvents
  → InvalidationRouter.onEventsApplied
    → #fetchMessageSnapshots           (one selectMessages per batch)
      → selectMessages
        → hydrateProfiles
          → resolveProfiles → resolveFromGlobalDb
            → hydrateMissingProfiles
              → getProfilesRoomyFirst
                → fetch https://api.bsky.app/xrpc/app.bsky.actor.getProfiles
```

`onEventsApplied` runs inline in `StreamManager.sendEvents` (StreamManager.ts:242).
`#fetchMessageSnapshots` reads message rows so `inferSignals` can build the
`messageDiff` the client applies to its cache. That read went through the
client-facing path, which includes profile resolution — and resolution
self-heals by fetching.

The fetch is not conditional on anything the write path knows. It fires
whenever an author has no row in the global `profiles` table, which is exactly
the state of a **brand-new participant's** first message. That matches the
production pattern: isolated multi-second spikes, not a uniform slowdown.

### Why it is process-wide, not per-request

The stall surfaced on *every* endpoint, including on other spaces. Bun serves
all HTTP handlers on one JS thread; `await fetch(...)` on that thread yields
only when I/O completes, and the concurrent DB round-trips queued behind it
pile up on the shared worker links (`roomy_pool_worker_pending` 48). One
uncached author stalled the space's worker for the duration of a third-party
round-trip.

## Measured cost breakdown

Per-event, batch=1, profile row absent:

- **55 DB round-trips** — of which ~25 are per-space, 12 readstate, 8 global
- **1 outbound HTTPS fetch**, ~440 ms
- handler pre-write work (access + authorize): **~2 ms**

The DB work is *not* the problem: 55 round-trips cost ~7 ms summed. 98 % of
the latency was the single network call. `stage time per call` in the probe
attributes `invalidation 447 ms` out of `TOTAL write 453 ms`.

Attribution of the 55 round-trips: the per-event path runs `isSpaceRebuilding`
plus the event-log transaction, then `applyBatch` (per-event transaction to the
per-space DB + global DB), then invalidation (message snapshot read, reply-edge
lookup, mention index writes), then the read-state unread lookup. Roughly
**two sequential round-trips per event per DB**, on three different workers.

## The fix

1. `SelectScope` gains `skipProfileHydration` for `kind: "ids"` — internal
   readers that want message *rows*, not rendered messages.
2. `resolveProfiles` / `hydrateProfiles` gain `allowNetworkFetch` (default
   `true`). `false` keeps the indexed global-store read and skips only the
   fetch.
3. `InvalidationRouter.#fetchMessageSnapshots` passes `skipProfileHydration: true`.

Chosen over dropping hydration entirely for those readers: the local read is
free and keeps the diff close to what `roomy.room.getMessages` returns (the
client validates the diff against that schema). Only the network half is
removed. The client resolves an unknown author on its next normal read.

## Follow-up: the negative cache

Removing the fetch from the *snapshot* read was necessary but not sufficient —
the write path still made **one** network fetch per event, from
`StreamManager.sendEvents` step 4 (`ensureProfilesRoomyFirst`, the
blank-profile protection). The probe with `--production-profiles` (which
exercises the real pipeline instead of a stubbed fetcher) measured exactly
that: 20 writes, 20 outbound Bluesky calls, **p50 450.9 ms**.

Both fetch caches only ever suppressed a retry *after a success*, because a
cache row is written from the fetch result. A DID that neither HappyView nor
the Bluesky appview can resolve — a brand-new DID, a `did:web`, an appview
hiccup — therefore had no row to find, so `filterMissing` returned it again on
every event and the pipeline re-ran both lookups forever. Under concurrency the
same author's N simultaneous writes each issued their own copy.

### Change

A module-level backoff (`NEGATIVE_CACHE_TTL_MS`, 1 minute) in
`materialization/profiles.ts`, keyed by DID:

- `isProfileFetchBackedOff(did)` — consulted by `getProfilesRoomyFirst` (skips
  both its HappyView and Bluesky legs) and by the read path's
  `hydrateMissingProfiles`, so one failed lookup suppresses every later event
  **and** every later reader.
- `recordUnresolvedProfiles(requested, resolved)` — called by the pipeline once
  every source it consults has been asked, and by `defaultGetProfiles`, which
  `space.roomy.user.getProfile` calls directly as a last resort.

A TTL of one minute (rather than the stale-handle cooldown's hour) keeps the
staleness bounded: a DID that resolves nowhere today may be a user whose Roomy
profile record HappyView has simply not indexed yet, and messages should not
render with a blank name long after the record exists.

**Tradeoff, stated plainly:** for one minute after a failed lookup, a profile
that becomes resolvable in that window is not re-fetched. The fetch cost
becomes one lookup per DID per minute instead of one per event and per reader.

### Measured (probe, `--production-profiles`, same machine)

| config | before | after |
|---|---|---|
| batch 1, concurrency 1 | p50 **450.9 ms**, 2.2 req/s, 20 fetches | p50 **5.0 ms**, 145 req/s, **0 fetches** |
| batch 1, concurrency 8 | p50 **1957 ms**, 2.1 req/s | p50 **25.3 ms**, 190 req/s |

The `outbound (non-local) fetches` line is the regression signal, and it is now
zero with the real profile pipeline enabled — not merely with a stub.

Blank profiles are not made worse. Step 4 runs *before* the invalidation router
in the same `sendEvents` call, so it has already attempted its fetch and written
whatever it could resolve; the snapshot read was a re-read by construction. The
backoff only stops the *retry* of a lookup that just failed.

## Remaining wins (not done — listed for triage)

Ordered by value/effort. None of these are the current bottleneck; #1 and #2
matter as write volume grows.

1. **Batch the authorization N+1.** `sendEvents` calls `checkWriteAuth` per
   event, and each room-write check calls `roomAccess` — ~3–4 SQL round-trips
   per room. `roomAccessMany` already exists (`auth/access.ts:453`) and is used
   by the read handlers; the write path never adopted it. A batch of 50
   messages to one room re-resolves the same room 50 times. This is the
   `sendEvents.authorize 11449ms` span shape under load.
2. **Collapse round-trips per event.** ~38/call at batch=1 is a lot for a
   single insert. The per-event `isSpaceRebuilding` probe and the per-event
   `applyBatch` transaction are the obvious targets (both could be one
   transaction / one read per batch).
3. **In-flight coalescing for concurrent readers of the same DID.**
   `profileStore.ts` has no in-flight coalescing — unlike
   `hydration/userHydration.ts`, which dedupes concurrent calls for the same
   user via an in-flight map. The negative cache removes the *steady-state*
   stampede (N events by one unresolved author now cost one lookup, not N), but
   N *simultaneous* first-time lookups for the same DID still issue N parallel
   fetches before any of them records a result. An in-flight map keyed by DID
   is a direct port of the pattern already used in `userHydration.ts`.
4. **Radical redesign.** The write path materializes inline (event log write →
   decode → profiles → `applyBatch` → invalidation → DB). That is what makes
   writes slow and reads cheap, which is the stated trade. If writes become the
   constraint, the durable shape is: append to the event log and return, then
   materialize on a worker that consumes the log. That inverts the coupling —
   reads already tolerate eventual consistency here (`applyBatch` is
   idempotent and cursor-driven, `isBackfill` already distinguishes replay).
   The cost is that the client's `messageDiff` would no longer be synchronous
   with `sendEvents`, so the client needs an optimistic path (it already
   generates ULIDs client-side for exactly this).

## Harness

`packages/appserver/perf/probe-sendevents.ts` boots the real appserver against
a seeded space and reports latency percentiles, DB round-trips split by
destination DB, stage timings inside `StreamManager.sendEvents`, and every
outbound fetch with its stack.

```bash
APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true \
  bun run packages/appserver/perf/probe-sendevents.ts --batch 1 --iterations 30
```

Add `--production-profiles` to leave `getProfiles` unset so materialisation uses
the real HappyView-first / Bluesky pipeline. Without it the probe stubs the
fetcher, which also stubs out the pipeline's own network behaviour — the stub
hides exactly the fetches this review is about, and a write path that looks
network-free under it can still be issuing one HTTP call per event.

The `outbound (non-local) fetches` line is the regression signal: the write
path is supposed to be local-only, so any non-zero value is a defect.

Note the probe is sensitive to machine load — run it alone, not beside the test
suite.
