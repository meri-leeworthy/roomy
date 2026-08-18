/**
 * Centralized embed enrichment sweeper.
 *
 * A single process-wide background loop owns ALL pending link enrichment.
 * Per-space SpaceMaterializers never fetch embeds themselves — they only
 * call {@link pokeEmbedSweeper} when new links are detected, and this loop
 * drains the global `comp_embed_link` pending set.
 *
 * Why this exists
 * ---------------
 * The original implementation called `enrichPendingLinks` independently from
 * (a) every SpaceMaterializer on every live event batch, (b) once per space
 * at startup, and (c) once per space after backfill. Because every space
 * shares one process-wide DB, each call re-read the *same global* pending
 * list, and because there was no in-flight dedup and no fetch timeout, a
 * single URL was fetched — and errored — dozens-to-hundreds of times while
 * the embed service was slow or down.
 *
 * Centralizing fixes all three amplifiers at once:
 *   - Exactly one in-flight fetch per URL (dedup lives in `enricher.ts`).
 *   - Every fetch has a hard timeout (see `FETCH_TIMEOUT_MS`).
 *   - Sequential processing — never more than one outbound embed request in
 *     flight at a time, so the service can't be flooded.
 *   - A self-healing idle poll catches links detected during backfill or
 *     carried over from a previous session.
 */

import type { DbLike } from "../db/types.ts";
import type { Ulid } from "@roomy-space/sdk";
import {
  enrichLinkAcrossSpaces,
  findPendingLinks,
  findPendingLinksForUrls,
  filterPendingUrls,
  inFlightCount,
  backoffMs,
  type EnrichOutcome,
  type PendingLink,
} from "./enricher.ts";
import { openSpaceDb } from "../db/db.ts";
import { selectMessages } from "../queries/selectMessages.ts";
import type { MessageDto } from "../queries/selectMessages.ts";
import { log } from "../log.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  MessageDiffOp,
} from "../invalidation/types.ts";

// ─── Configuration ──────────────────────────────────────────────────────

/** Max pending links to pull from the DB per sweep batch. */
const SWEEP_BATCH = 25;
/** How often to poll for pending links while idle (no pokes). */
const IDLE_POLL_MS = 30_000;
/**
 * Max concurrent outbound embed-service fetches per sweep batch. Bounded so
 * a large pending batch can't flood the embed service, while still draining
 * far faster than strictly sequential (a batch of 25 finishes in
 * ~ceil(25/8) ≈ 4 fetch round-trips instead of 25). Tunable via env for ops.
 */
const CONCURRENCY = Number(process.env.EMBED_SWEEPER_CONCURRENCY ?? 8);

// ─── Singleton state ────────────────────────────────────────────────────

let sweeperGlobalDb: DbLike | undefined;
let sweeperRouter: InvalidationRouter | undefined;
let started = false;
/** Resolved when the background loop exits. Used by stopEmbedSweeper. */
let loopPromise: Promise<void> | undefined;

// ─── Stats (for /health/embed) ─────────────────────────────────────────
// Lifetime counters incremented in the drain loop. Non-null enrichLink →
// success; null → a definitive or transient FetchResult (failure/settled).
// Reset by _resetEmbedSweeper (tests only). Exposed via embedSweeperStats().
let statsEnrichedOk = 0;
let statsEnrichedNull = 0;
/**
 * #messageDiff frames the sweeper actually emitted to clients (enrichment
 * completed AND the enriched message was resolved to a real room). Lets
 * operators confirm the invalidation path is firing, separate from whether
 * enrichment itself succeeded.
 */
let statsEnrichmentDiffs = 0;
/**
 * Resolved by {@link pokeEmbedSweeper} to wake an idle loop immediately.
 * Null when the loop is busy draining (so extra pokes are cheap no-ops).
 */
let wake: (() => void) | null = null;
/**
 * Consecutive DB errors seen by the sweeper. Used to escalate a backoff so a
 * dead/unreachable DB (e.g. macOS `SQLITE_IOERR_VNODE` under I/O pressure)
 * doesn't cause a tight fetch-then-fail loop that wastes embed-service calls
 * and spams logs. Reset to 0 on a successful DB cycle.
 */
let dbErrorCount = 0;
/** Timestamp (ms) until which the sweeper should skip fetching and just idle. */
let dbBackoffUntil = 0;
/**
 * Priority queue of freshly-detected live link URLs. Drained before the
 * oldest-first backlog so a newly posted link is enriched within seconds
 * instead of waiting behind thousands of historical (backfilled) pending
 * links. Populated by {@link pokeEmbedSweeper} from createMessage batches.
 */
const priorityLinks = new Set<string>();

/**
 * In-memory retry gate for TRANSIENT failures (timeout / 5xx / 429 / network).
 * A URL that fails transiently is kept pending (so it is eventually retried)
 * but is SKIPPED for an exponential backoff window, so the sweeper doesn't
 * re-fetch the same dead links every cycle and burn its concurrency on links
 * known to be down. `retryAt` is the epoch-ms before which the URL is skipped.
 * `attempts` tracks consecutive transient failures to escalate the backoff.
 * Mirrors the `retry_after`/`attempts` persisted in `comp_embed_link_data`,
 * but lives in-memory here so the global pending scan doesn't have to join
 * every per-space DB. Reset on ok/definitive outcomes and on stop.
 */
const transientRetry = new Map<string, { attempts: number; retryAt: number }>();

export interface EmbedSweeperOpts {
  /** Global DB — the `pending_links` index lives here. */
  globalDb: DbLike;
  /** Optional invalidation router — used to push re-fetch signals to clients. */
  invalidationRouter?: InvalidationRouter;
}

/**
 * Start the global embed sweeper. Idempotent — safe to call multiple times.
 * Called once at appserver startup (see `index.ts`).
 */
export function startEmbedSweeper(opts: EmbedSweeperOpts): void {
  if (started) return;
  started = true;
  sweeperGlobalDb = opts.globalDb;
  sweeperRouter = opts.invalidationRouter;
  // Detached background loop — must never reject the process. Any throw is
  // logged and the loop continues (see inner try/catch per sweep).
  loopPromise = runSweeperLoop().catch((err) => {
    log.error("[embed-sweeper] loop crashed:", err);
  });
}

/**
 * Snapshot of sweeper state for the `/health/embed` endpoint. Lets operators
 * watch the backlog drain and see sweep pressure / DB backoff without scraping
 * (potentially rate-limited) logs. `pending` is queried separately in the
 * health handler (it needs the DB) and merged in there.
 */
export function embedSweeperStats(): {
  priorityQueue: number;
  inFlight: number;
  enrichedOk: number;
  enrichedNull: number;
  enrichmentDiffs: number;
  dbErrorCount: number;
  dbBackoffActive: boolean;
} {
  return {
    priorityQueue: priorityLinks.size,
    inFlight: inFlightCount(),
    enrichedOk: statsEnrichedOk,
    enrichedNull: statsEnrichedNull,
    enrichmentDiffs: statsEnrichmentDiffs,
    dbErrorCount,
    dbBackoffActive: Date.now() < dbBackoffUntil,
  };
}

/**
 * Wake the sweeper to drain pending links immediately. Cheap and safe to
 * call frequently: if a sweep is already in progress this is a no-op.
 *
 * Pass freshly-detected `urls` to prioritise them over the backfill backlog —
 * the loop drains the priority queue before the oldest-first pending set.
 * URLs already enriched are skipped by `filterPendingUrls` in the loop.
 */
export function pokeEmbedSweeper(urls?: string[]): void {
  if (urls && urls.length > 0) {
    for (const u of urls) priorityLinks.add(u);
  }
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
}

/**
 * Read-driven prioritisation: when a client reads messages (getMessages /
 * getMessage), jump any never-attempted links in those messages ahead of the
 * oldest-first backfill backlog, so the viewing user sees the cards promptly
 * instead of waiting hours behind erroring/timing-out backlog links. This is
 * the READ counterpart to the WRITE-driven poke in SpaceMaterializer — write
 * prioritisation only helps newly-posted links, not links in messages a user
 * is currently viewing (which were detected during backfill and sit in the
 * backlog).
 *
 * `filterPendingUrls` returns only links with no data row yet, so
 * already-enriched links are a no-op and transient-failed links keep their
 * backoff (we don't hammer a down service on every refetch). Cheap: a single
 * LEFT JOIN, skipped entirely when the page has no links.
 */
export async function prioritiseLinksForRead(
  db: DbLike,
  messages: ReadonlyArray<
    Readonly<{ linkEmbeds: ReadonlyArray<{ url: string }> }>
  >,
): Promise<void> {
  const linkUrls = messages.flatMap((m) => m.linkEmbeds.map((l) => l.url));
  if (linkUrls.length === 0) return;
  try {
    const pending = await filterPendingUrls(db, linkUrls);
    if (pending.length > 0) pokeEmbedSweeper(pending);
  } catch (err) {
    // Embed prioritisation is best-effort: a transient DB error (e.g. a macOS
    // SQLITE_IOERR_VNODE from I/O pressure) must NEVER turn a successful
    // getMessages/getMessage into a 500. Messages are the product; embed cards
    // are a secondary enhancement. The sweeper's idle poll picks these links
    // up regardless, so skipping the poke on a DB hiccup is harmless.
    console.warn("[embed] prioritiseLinksForRead failed:", err);
  }
}

/**
 * Record a DB error and escalate a backoff so the loop pauses fetching rather
 * than fetch 8 links per cycle only to fail every write. Capped; reset by
 * {@link markDbOk} on a successful DB cycle.
 */
function markDbError(err: unknown): void {
  dbErrorCount = Math.min(dbErrorCount + 1, 8);
  const backoffMs = Math.min(60_000 * 2 ** (dbErrorCount - 1), 30 * 60_000);
  dbBackoffUntil = Date.now() + backoffMs;
  console.warn(
    `[embed-sweeper] DB error (#${dbErrorCount}); backing off ${Math.round(backoffMs / 1000)}s:`,
    err,
  );
}

/** Mark the DB as healthy again (a successful DB cycle resets the backoff). */
function markDbOk(): void {
  if (dbErrorCount !== 0) dbErrorCount = 0;
  if (dbBackoffUntil !== 0) dbBackoffUntil = 0;
}

// ─── Loop ───────────────────────────────────────────────────────────────

/**
 * Run one sweep cycle: pull a priority + backlog batch, drain it with
 * bounded concurrency, and emit per-URL invalidations for successes. Returns
 * true when the batch was full (more pending likely remain → loop without
 * waiting); false when the loop should wait for a poke / idle poll.
 *
 * Expected DB/fetch failures are caught inline (and drive the DB backoff via
 * `markDbError`). Any *unexpected* throw bubbles to {@link runSweeperLoop}'s
 * outer guard so the loop self-heals instead of dying.
 */
export async function sweepCycle(globalDb: DbLike): Promise<boolean> {
  // Bail out early if the sweeper has been stopped (e.g. during test teardown).
  if (!started) return false;
  // If the DB has been erroring, wait out the backoff before touching it
  // again — don't fetch links only to fail every write (wastes embed-service
  // calls and spams logs). A poke can still wake us early, but we re-check
  // the backoff at the top of the next cycle.
  const now = Date.now();
  if (now < dbBackoffUntil) {
    await waitForWake(dbBackoffUntil - now);
    return false;
  }

  let pending: PendingLink[] = [];

  // 1. Priority: freshly-detected live links first, so a newly posted
  //    link is enriched within seconds instead of waiting behind the
  //    entire backfill backlog. Resolve which spaces each priority URL is
  //    still pending in via the global `pending_links` index.
  const priority = drainPriorityLinks(SWEEP_BATCH);
  if (priority.length > 0) {
    try {
      pending = await findPendingLinksForUrls(globalDb, priority);
    } catch (err) {
      console.warn("[embed-sweeper] findPendingLinksForUrls failed:", err);
      markDbError(err);
      pending = [];
    }
  }

  // 2. Backlog: fill the rest of the batch with the oldest pending links,
  //    EXCLUDING URLs currently in transient-retry backoff. Excluding them in
  //    the query (not just filtering the result) is what lets the sweeper
  //    advance past a run of down links instead of re-selecting the same
  //    oldest backoff links every cycle and stalling.
  if (pending.length < SWEEP_BATCH) {
    try {
      const now = Date.now();
      const backoffUrls = new Set<string>();
      for (const [url, retry] of transientRetry) {
        if (retry.retryAt > now) backoffUrls.add(url);
      }
      const backlog = await findPendingLinks(
        globalDb,
        SWEEP_BATCH - pending.length,
        backoffUrls,
      );
      // Dedupe in case a priority URL is also among the oldest pending
      // (rare — priority URLs are newest, backlog is oldest-first).
      pending = dedupePending([...pending, ...backlog]);
    } catch (err) {
      // A transient DB error shouldn't kill the loop. Back off so a
      // dead DB doesn't cause a tight fetch-and-fail cycle.
      console.warn("[embed-sweeper] findPendingLinks failed:", err);
      markDbError(err);
    }
  }

  // Skip any priority URLs currently in transient-retry backoff (the priority
  // path resolves spaces for freshly-poked URLs without a backoff filter).
  if (pending.length > 0) {
    const now = Date.now();
    pending = pending.filter((p) => {
      const retry = transientRetry.get(p.url);
      return !retry || retry.retryAt <= now;
    });
  }

  if (pending.length > 0) {
    // Group pending rows by URL → the set of spaces it is pending in (a URL
    // can appear in multiple spaces). enrichLinkAcrossSpaces fetches ONCE per
    // URL and stores the result to every space's DB.
    const spacesByUrl = new Map<string, string[]>();
    for (const p of pending) {
      const arr = spacesByUrl.get(p.url) ?? [];
      arr.push(p.spaceDid);
      spacesByUrl.set(p.url, arr);
    }

    // Drain the batch with bounded concurrency so N links complete in
    // ~ceil(N/CONCURRENCY) fetch round-trips rather than N. Each
    // enrichLinkAcrossSpaces is deduplicated (inFlightLinks) + timeout-bounded,
    // and resolves to the stored embed (null on failure).
    //
    // We stream invalidations per-URL as they SUCCEED (non-null embed): a
    // freshly-posted live link's card appears the moment ITS fetch resolves.
    // Failed (null) enrichments emit nothing. Per-URL error isolation keeps
    // one throwing enrichLinkAcrossSpaces from killing the whole loop.
    let cycleDbError: unknown = null;
    // URLs whose enrichment SUCCEEDED — emit invalidations and drop from the
    // pending set.
    const enrichedUrls = new Set<string>();
    // URLs that are SETTLED (ok OR definitive no-data) — drop from the
    // pending set so the backlog drains. Only transient failures stay pending
    // for a later retry.
    const settledUrls = new Set<string>();
    await mapWithConcurrency([...spacesByUrl.entries()], CONCURRENCY, async ([url, spaces]) => {
      let outcome: EnrichOutcome | null = null;
      try {
        outcome = await enrichLinkAcrossSpaces(url, spaces);
      } catch (err) {
        // enrichLinkAcrossSpaces only throws for DB (storeEmbedData) errors —
        // fetch errors are handled inside fetchEmbedData (returns a
        // FetchResult). Capture once per cycle to drive backoff (don't
        // escalate per-link). Logged at debug: a failing DB under I/O
        // pressure can throw per-link per-cycle, which floods logs.
        if (cycleDbError === null) cycleDbError = err;
        log.debug(`[embed-sweeper] enrichLinkAcrossSpaces threw for ${url}:`, err);
      }
      if (outcome?.status === "ok") {
        statsEnrichedOk++;
        enrichedUrls.add(url);
        settledUrls.add(url);
        transientRetry.delete(url);
        // Emit per-URL invalidation routed to each space's per-space DB.
        for (const spaceDid of spaces) {
          await emitEnrichmentInvalidation(openSpaceDb(spaceDid), [url]);
        }
      } else if (outcome?.status === "definitive") {
        // Settled no-data (page loaded but no OG/oEmbed, or a stable 4xx).
        // Drop from the pending set — re-fetching it every sweep would keep
        // the backlog pinned on dead links forever and starve real ones.
        statsEnrichedNull++;
        settledUrls.add(url);
        transientRetry.delete(url);
      } else {
        // Transient (timeout / 5xx / 429 / network) — keep pending so it is
        // retried later, but skip it for an exponential backoff window so the
        // sweeper doesn't re-fetch the same down links every cycle.
        statsEnrichedNull++;
        const prev = transientRetry.get(url);
        const attempts = (prev?.attempts ?? 0) + 1;
        transientRetry.set(url, { attempts, retryAt: Date.now() + backoffMs(attempts) });
      }
    });

    // Delete the processed rows from the global `pending_links` index. Both
    // successfully-enriched AND definitively-settled URLs are removed; only
    // transient failures stay pending for a later retry. Without this, a
    // backlog of dead/no-data links is re-fetched on every sweep and never
    // drains, so the sweeper never reaches newer real links.
    if (settledUrls.size > 0) {
      try {
        for (const p of pending) {
          if (settledUrls.has(p.url)) {
            await globalDb.run(
              `delete from pending_links where space_did = ? and url = ?`,
              [p.spaceDid, p.url],
            );
          }
        }
      } catch (err) {
        if (cycleDbError === null) cycleDbError = err;
      }
    }

    if (cycleDbError !== null) markDbError(cycleDbError);
    else markDbOk(); // a successful write cycle → DB is healthy again
  }

  // A full batch means there may be more pending — signal the loop to run
  // again without waiting.
  return pending.length >= SWEEP_BATCH;
}

async function runSweeperLoop(): Promise<void> {
  const globalDb = sweeperGlobalDb;
  if (!globalDb) return;

  for (;;) {
    if (!started) return; // allow clean exit via stopEmbedSweeper
    try {
      const full = await sweepCycle(globalDb);
      if (full) continue;
      // Wait for a poke (new links) or the idle poll, whichever comes first.
      // This bounds latency for newly posted links while also self-healing
      // anything we missed (backfill, prior sessions).
      await waitForWake(IDLE_POLL_MS);
    } catch (err) {
      // Outer resilience: the inner try/catches handle expected DB/fetch
      // failures, but any *unexpected* throw (a future code path not yet
      // guarded) must NOT permanently kill the process-wide loop — without
      // this, a single unhandled rejection would stop all embed enrichment
      // until restart. Log, pause briefly to avoid a tight crash loop, and
      // continue.
      log.error("[embed-sweeper] sweep cycle threw (continuing):", err);
      await waitForWake(IDLE_POLL_MS);
    }
  }
}

/** Remove and return up to `limit` URLs from the priority queue. */
function drainPriorityLinks(limit: number): string[] {
  const out: string[] = [];
  for (const url of priorityLinks) {
    if (out.length >= limit) break;
    out.push(url);
    priorityLinks.delete(url);
  }
  return out;
}

/**
 * Dedupe pending rows by (spaceDid, url) so the same URL isn't enriched twice
 * in the same space within one batch (a URL can be pending under multiple
 * message ids in the same space).
 */
function dedupePending(links: PendingLink[]): PendingLink[] {
  const seen = new Set<string>();
  const out: PendingLink[] = [];
  for (const l of links) {
    const key = `${l.spaceDid}\u0000${l.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]!);
      }
    },
  );
  await Promise.all(workers);
}

/** Resolve after `ms`, or immediately when {@link pokeEmbedSweeper} fires. */
function waitForWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ─── Invalidation ───────────────────────────────────────────────────────

/**
 * After enrichment, stream the updated embed data to subscribed clients as
 * `#messageDiff` `update` ops — one frame per affected room. The client
 * patches its TanStack cache directly (no HTTP re-fetch) and the link card
 * appears the moment enrichment completes.
 *
 * `entities.room` on a link entity holds the message id that contained the
 * link (see `detectAndStoreLinks`). We resolve message → real room id via
 * the message entity's `room`, then re-select the full message snapshot
 * (which now carries the enriched `linkEmbeds` data) via `selectMessages`.
 *
 * The `update` op carries a complete `MessageDto` because the client
 * any frame missing a required field. Reactions are re-read from
 * `comp_reaction` (unchanged by enrichment); `myReactionId` is intentionally
 * omitted (broadcast diffs can't be per-user) — the client derives
 * "did I react?" from `reaction.myReactionId`, so this doesn't affect rendering.
 */
async function emitEnrichmentInvalidation(
  db: DbLike,
  enrichedUrls: string[],
): Promise<void> {
  if (!sweeperRouter || enrichedUrls.length === 0) return;

  const placeholders = enrichedUrls.map(() => "?").join(",");
  let rows: { messageId: string; roomId: string }[] = [];
  try {
    // Two-hop resolution: link entity → its `room` (message id) →
    // message entity → its `room` (the real room id).
    //
    // Media/link entities store `room = messageId` (see ensureEntity calls
    // in the SDK message materializer and detectAndStoreLinks), NOT the
    // room id. A single-hop lookup yields the message id and emits a diff
    // for room:<messageId> — which never matches any client subscription.
    rows = await db
      .query(
        `select link.room as messageId, msg.room as roomId
           from entities link
           join entities msg on msg.id = link.room
          where link.id in (${placeholders})
            and msg.room is not null`,
      )
      .all<{ messageId: string; roomId: string }>([...enrichedUrls]);
  } catch (err) {
    console.warn("[embed-sweeper] room lookup failed:", err);
    return;
  }

  if (rows.length === 0) return;
  const messageIdToRoom = new Map(rows.map((r) => [r.messageId, r.roomId]));

  // Map each message id → its real room id (a URL may appear in multiple
  // messages; a message may contain multiple enriched URLs).
  let messages: MessageDto[] = [];
  try {
    messages = (await selectMessages(db, {
      kind: "ids",
      ids: [...messageIdToRoom.keys()],
    })).messages;
  } catch (err) {
    console.warn("[embed-sweeper] selectMessages failed:", err);
    return;
  }

  // Group update ops by room so each room gets a single #messageDiff frame.
  const opsByRoom = new Map<string, MessageDiffOp[]>();
  for (const m of messages) {
    const roomId = messageIdToRoom.get(m.id);
    if (!roomId) continue;
    let ops = opsByRoom.get(roomId);
    if (!ops) {
      ops = [];
      opsByRoom.set(roomId, ops);
    }
    ops.push({ op: "update", key: m.id as Ulid, message: m });
  }

  if (opsByRoom.size === 0) return;

  const signals: InvalidationEvent[] = [];
  for (const [roomId, ops] of opsByRoom) {
    signals.push({
      kind: "messageDiff",
      signal: { roomId: roomId as Ulid, seq: 0, ops },
    });
  }

  statsEnrichmentDiffs += signals.length;
  sweeperRouter.emit(signals);
}

// ─── Test helpers ───────────────────────────────────────────────────────

/**
 * Mark the sweeper as started WITHOUT launching the background loop. Tests
 * only: tests that drive `sweepCycle` directly (instead of the real loop)
 * still need `started === true` for the cycle to run, but must NOT spawn a
 * concurrent background loop — otherwise the loop's `waitForWake` and the
 * shared `wake` singleton race the manual `sweepCycle` calls and the test
 * hangs under parallel-suite CPU contention (a 30s idle poll stretches well
 * beyond the 5s default timeout). Use this instead of `startEmbedSweeper`
 * in tests that call `sweepCycle` themselves.
 */
export function _startSweeperNoLoop(opts: EmbedSweeperOpts): void {
  started = true;
  sweeperGlobalDb = opts.globalDb;
  sweeperRouter = opts.invalidationRouter;
}

/**
 * Reset the sweeper singleton (does not cancel an already-running loop).
 * Tests only — clears state so a fresh `startEmbedSweeper` can be issued.
 */
export function _resetEmbedSweeper(): void {
  started = false;
  sweeperGlobalDb = undefined;
  sweeperRouter = undefined;
  wake = null;
  priorityLinks.clear();
  transientRetry.clear();
  dbErrorCount = 0;
  dbBackoffUntil = 0;
  statsEnrichedOk = 0;
  statsEnrichedNull = 0;
  statsEnrichmentDiffs = 0;
}

/**
 * Stop the background sweeper loop. Idempotent. Used by tests to prevent
 * the loop from running after the DB is closed. Signals the loop to exit
 * and returns a promise that resolves once the loop has finished (with a
 * short timeout as a safety net).
 */
export function stopEmbedSweeper(): Promise<void> {
  started = false;
  sweeperGlobalDb = undefined;
  sweeperRouter = undefined;
  const w = wake;
  wake = null;
  w?.(); // wake the loop so it sees `started = false` and exits
  priorityLinks.clear();
  transientRetry.clear();
  dbErrorCount = 0;
  dbBackoffUntil = 0;
  statsEnrichedOk = 0;
  statsEnrichedNull = 0;
  statsEnrichmentDiffs = 0;
  const timeout = Promise.withResolvers<void>();
  setTimeout(timeout.resolve, 50);
  return Promise.race([loopPromise ?? Promise.resolve(), timeout.promise]);
}
