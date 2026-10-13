/**
 * The block set — who a viewer must not see.
 *
 * Two lookups whose union is the answer, because **a block hides both ways**:
 *
 *   1. `blocks(did)` — the blocks `did` wrote into their own repos, from
 *      `space.roomy.user.block` and `app.bsky.graph.block`.
 *   2. `blockedBy(did)` — everyone whose repo holds a block naming `did`. The
 *      blocked party has no record of their own saying they were blocked, so
 *      the fact only exists in the *blocker's* repo. That is what makes this a
 *      reverse index the appserver has to build rather than look up.
 *
 * `hiddenBy(viewer)` is the union, and it is the only thing any read path
 * needs: a filter never has to ask *who* blocked, only whether this author is
 * hidden from this viewer, so every downstream consumer is direction-agnostic
 * and the mutual case costs no branching anywhere.
 *
 * ## Where the reverse set comes from
 *
 * Enumerating the viewer's space-members' repos. `listRecords` against one
 * account's PDS is the only place a fresh answer exists; a network index would
 * answer more cheaply but only at an ingest lag this feature cannot bound. Each
 * candidate's resolved set is cached in `user_blocks` under *their own*
 * `user_did` — the same row shape as a viewer's own set, so one table serves
 * both directions and the enumeration is a cache warm rather than a per-request
 * cost.
 *
 * ## Why nothing here blocks on the network
 *
 * Every read path in the appserver consumes this set, `room.getMessages`
 * included. A PDS round-trip inside a read would make a message list as slow as
 * its slowest member's PDS. So a read serves the indexed rows it already has and
 * the fetch lands detached for the next read — the same detach-and-hydrate shape
 * as `profileStore`, down to the in-flight map that collapses N concurrent
 * readers of one DID into a single fetch.
 */

import type { UserDid } from "@roomy-space/sdk";
import {
  fetchBlockRecords,
  type BlockRecord,
} from "../materialization/blocks.ts";
import { openSpaceDb, tryOpenReadStateDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { selectJoinedSpaceDids } from "./userSpaceMembership.ts";
import { log } from "../log.ts";

/**
 * How long a resolved block set is served from the in-memory cache. A resolved
 * set is authoritative until its TTL, so reads stay off the read-state DB.
 *
 * Read per call so a test can drive a short window and observe a refetch, the
 * same seam `profileFetchTimeoutMs` provides for the profile deadline.
 */
function blockCacheTtlMs(): number {
  const raw = Number(process.env.BLOCK_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

/**
 * How long a failed fetch is left alone. A block lives in the user's own PDS,
 * so a failure is transient (a slow or briefly-down host); retrying it per
 * request would turn one unreadable PDS into a fetch per read, and this is short
 * enough that a recovered host is picked up within the minute.
 */
function blockErrorBackoffMs(): number {
  const raw = Number(process.env.BLOCK_ERROR_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_ERROR_BACKOFF_MS;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_ERROR_BACKOFF_MS = 60_000;

/** The shared empty answer, so an anonymous caller allocates nothing. */
const NO_DIDS: ReadonlySet<string> = new Set<string>();

/**
 * Candidate-blocker sweeps in flight, one per viewer. Keyed by viewer DID so
 * concurrent reads by the same user collapse into one sweep; the sweep's own
 * per-DID fetches are deduplicated by {@link startFetch}.
 */
const inflightSweeps = new Map<string, Promise<void>>();

/** Per-DID fetches in flight, so N readers of one author issue one request. */
const inflightFetches = new Map<string, Promise<void>>();

interface CacheEntry {
  /** Author DIDs the memoised user must not see. */
  dids: Set<string>;
  fetchedAt: number;
}

/** Resolved sets of the blocks a user *wrote*; keyed by that user's DID. */
const writtenCache = new Map<string, CacheEntry>();

/**
 * Resolved reverse sets: the recovered blockers of a user. Keyed by the blocked
 * user's DID. Separate from {@link writtenCache} because the two are different
 * questions over the same table, and a fetch for one does not answer the other.
 */
const reverseCache = new Map<string, CacheEntry>();

// ─── Test helpers ─────────────────────────────────────────────────────────

/** Clear every memo. Mirrors `_resetProfileStoreCache`. */
export function _resetBlockCaches(): void {
  writtenCache.clear();
  reverseCache.clear();
  inflightSweeps.clear();
  inflightFetches.clear();
}

/** The sweeps currently in flight, so a test can await them. */
export function _blockSweepsInFlight(): Promise<void>[] {
  return [...new Set(inflightSweeps.values())];
}

/** The fetches currently in flight, so a test can await them. */
export function _blockFetchesInFlight(): Promise<void>[] {
  return [...new Set(inflightFetches.values())];
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * The blocks `userDid` wrote into their own repos.
 *
 * Serves the memoised set when it is fresh; otherwise reads the indexed rows and
 * starts a detached refresh when those rows are missing or stale. Never fails
 * the caller: a PDS this cannot reach returns whatever rows are already known,
 * because throwing here would fail the message list the set exists to filter.
 */
export async function blocks(userDid: UserDid): Promise<ReadonlySet<string>> {
  const cached = writtenCache.get(userDid);
  if (cached && Date.now() - cached.fetchedAt < blockCacheTtlMs()) {
    return cached.dids;
  }

  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return cached?.dids ?? NO_DIDS;

  const rows = await readOwnRows(readStateDb, userDid);
  const entry: CacheEntry = {
    dids: new Set(rows.written),
    fetchedAt: Date.now(),
  };
  writtenCache.set(userDid, entry);

  // No rows and no stamp at all means the repo has never been read; an empty
  // set of *written* blocks is indistinguishable from an unread repo without
  // the stamp, so both are refetched on the same cadence. A failed attempt
  // inside the backoff window is left alone rather than retried per read.
  const stale = Date.now() - rows.fetchedAt >= blockCacheTtlMs();
  const backedOff =
    rows.status === "error" && Date.now() - rows.fetchedAt < blockErrorBackoffMs();
  if (stale && !backedOff) startFetch(userDid, readStateDb);

  return entry.dids;
}

/**
 * Everyone whose repos hold a block naming `userDid` — the recovered reverse
 * direction.
 *
 * A plain indexed read (`idx_user_blocks_blocked`): the reverse fact is *stored*
 * here once a candidate's repo has been read, so answering needs no network at
 * all. What populates those rows is {@link warmBlockers}.
 */
export async function blockedBy(userDid: UserDid): Promise<ReadonlySet<string>> {
  const cached = reverseCache.get(userDid);
  if (cached && Date.now() - cached.fetchedAt < blockCacheTtlMs()) {
    return cached.dids;
  }

  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return cached?.dids ?? NO_DIDS;

  const rows = await readStateDb
    .query("select user_did from user_blocks where blocked_did = ?")
    .all<{ user_did: string }>([userDid]);
  const entry: CacheEntry = {
    dids: new Set(rows.map((r) => r.user_did)),
    fetchedAt: Date.now(),
  };
  reverseCache.set(userDid, entry);
  return entry.dids;
}

/**
 * The author DIDs a viewer must not see: their own blocks, plus everyone who
 * blocks them.
 *
 * `viewerDid === null` is an anonymous caller, who hides nobody and is hidden
 * from nobody — the empty set, with no DB read and no sweep.
 *
 * The reverse half is only as complete as the last sweep of the viewer's space
 * members' repos. That sweep is started here — detached, so this read returns
 * what is already known — and its completion drops the viewer's memo entries so
 * the next read picks up whatever it recovered.
 */
export async function hiddenBy(
  viewerDid: UserDid | null,
): Promise<ReadonlySet<string>> {
  if (viewerDid === null) return NO_DIDS;

  const [own, reverse] = await Promise.all([
    blocks(viewerDid),
    blockedBy(viewerDid),
  ]);
  warmBlockers(viewerDid);

  if (reverse.size === 0) return own;
  const union = new Set(own);
  for (const did of reverse) union.add(did);
  return union;
}

/**
 * Read one user's written rows and their last-fetch stamp.
 *
 * The stamp is what separates "no blocks" from "never read" — a user with a
 * genuinely empty set has no rows to carry a timestamp, the same distinction
 * `profiles.ts` draws between a profile row and its negative cache.
 */
async function readOwnRows(
  readStateDb: DbLike,
  userDid: UserDid,
): Promise<{ written: string[]; fetchedAt: number; status: "ok" | "error" | null }> {
  const written = await readStateDb
    .query("select blocked_did from user_blocks where user_did = ?")
    .all<{ blocked_did: string }>([userDid]);
  const stamp = await readStateDb
    .query("select fetched_at, status from user_block_fetches where user_did = ?")
    .get<{ fetched_at: number; status: "ok" | "error" }>([userDid]);

  return {
    written: written.map((r) => r.blocked_did),
    fetchedAt: stamp?.fetched_at ?? 0,
    status: stamp?.status ?? null,
  };
}

// ─── Refresh ───────────────────────────────────────────────────────────────

/**
 * Fetch `userDid`'s repos and write the result, off the caller's path.
 *
 * Detached by design: the caller is a read that already returned. The completion
 * drops the memo entries that could have been derived from the pre-fetch rows —
 * this user's own set, and their reverse set, since these rows are what a
 * `blockedBy` read answers from.
 */
function startFetch(userDid: UserDid, readStateDb: DbLike): void {
  if (inflightFetches.has(userDid)) return;

  const run = fetchAndStore(userDid, readStateDb)
    .catch((err) => {
      // `fetchAndStore` records its own failures; this is the outer guard so a
      // defect in it can never surface as an unhandled rejection.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[userBlocks] background fetch failed for ${userDid}: ${message}`);
    })
    .finally(() => {
      inflightFetches.delete(userDid);
      writtenCache.delete(userDid);
      reverseCache.delete(userDid);
    })
    .then(() => undefined);

  inflightFetches.set(userDid, run);
}

/**
 * Fetch one user's blocks and replace their rows. Returns whether the fetch
 * produced an answer — never throws, because every caller is detached and a
 * failure belongs in the recorded state, not in a rejection nobody awaits.
 */
async function fetchAndStore(
  userDid: UserDid,
  readStateDb: DbLike,
): Promise<boolean> {
  let records: BlockRecord[];
  try {
    records = await fetchBlockRecords(userDid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[userBlocks] block fetch failed for ${userDid}: ${message}`);
    await recordFetchError(readStateDb, userDid);
    return false;
  }
  await replaceBlockRows(readStateDb, userDid, records);
  return true;
}

/**
 * Replace a user's block rows and stamp the successful attempt.
 *
 * One transaction, because the delete and the inserts are a single replacement:
 * a crash between them would leave the user with an empty set — nobody hidden —
 * which is the one failure mode a block must not have.
 */
export async function replaceBlockRows(
  readStateDb: DbLike,
  userDid: UserDid,
  records: readonly BlockRecord[],
): Promise<void> {
  const now = Date.now();
  const steps: Array<{
    type: "query" | "run" | "exec";
    sql: string;
    params?: unknown[];
  }> = [
    {
      type: "run",
      sql: "delete from user_blocks where user_did = ?",
      params: [userDid],
    },
  ];
  for (const record of records) {
    steps.push({
      type: "run",
      sql: `insert into user_blocks (user_did, blocked_did, source, created_at, fetched_at)
            values (?, ?, ?, ?, ?)`,
      params: [userDid, record.subject, record.source, record.createdAt, now],
    });
  }
  steps.push({
    type: "run",
    sql: `insert into user_block_fetches (user_did, fetched_at, status)
          values (?, ?, 'ok')
          on conflict(user_did) do update set
            fetched_at = excluded.fetched_at,
            status = excluded.status`,
    params: [userDid, now],
  });
  await readStateDb.transaction(steps);
}

/**
 * Stamp a failed attempt, leaving the rows alone.
 *
 * The rows are deliberately NOT cleared. They are the last known answer, and
 * their absence means "this user hides nobody" — so clearing them on a PDS blip
 * would silently stop hiding every author the user has blocked, which is the
 * exact failure the feature exists to prevent. A stale set is the safe
 * direction: it hides someone who has since been unblocked, until the next
 * successful refresh replaces it.
 */
export async function recordFetchError(
  readStateDb: DbLike,
  userDid: UserDid,
): Promise<void> {
  await readStateDb.run(
    `insert into user_block_fetches (user_did, fetched_at, status)
     values (?, ?, 'error')
     on conflict(user_did) do update set
       fetched_at = excluded.fetched_at,
       status = excluded.status`,
    [userDid, Date.now()],
  );
}

/**
 * Refresh `userDid`'s block set now, in the caller's request, and report whether
 * the fetch succeeded.
 *
 * The immediate path after an in-app block: the write to the PDS has already
 * succeeded, and the TTL would otherwise leave the appserver handing out the
 * author's content for up to a minute. Awaited here because the caller is the
 * procedure whose whole purpose is to close that window; the client treats the
 * call itself as fire-and-forget.
 */
export async function refreshBlockSet(userDid: UserDid): Promise<boolean> {
  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return false;
  writtenCache.delete(userDid);
  reverseCache.delete(userDid);
  return fetchAndStore(userDid, readStateDb);
}

/**
 * Drop the memo entries for `userDid`, so the next read re-resolves them.
 *
 * Called for the subject of a block as well as its author: a block changes what
 * *both* parties see, and the target's cached `hiddenBy` would otherwise keep the
 * reverse direction open for the rest of its TTL — the exact window the refresh
 * procedure exists to close.
 */
export function invalidateBlockSet(userDid: UserDid): void {
  writtenCache.delete(userDid);
  reverseCache.delete(userDid);
}

// ─── Candidate enumeration ──────────────────────────────────────────────────

/**
 * Sweep the viewer's space-members' repos and cache each one's block set, so the
 * next `blockedBy` reads a complete answer.
 *
 * The reverse direction is the only part of a block the appserver cannot learn
 * from the viewer's own repo, and the only way to learn it is to read the
 * accounts that *could* hold it. The candidate set is the viewer's space
 * members: a block by someone the viewer shares no space with could never hide
 * anything from them, so reading that repo would be work with no possible effect.
 *
 * Detached, one sweep per viewer per cache window, with the per-DID fetches
 * deduplicated by {@link startFetch} — the sweep's cost is one `listRecords` loop
 * per member the appserver does not already have a fresh answer for.
 */
export function warmBlockers(viewerDid: UserDid): void {
  if (inflightSweeps.has(viewerDid)) return;
  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return;

  const run = sweepBlockers(viewerDid, readStateDb)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[userBlocks] blocker sweep failed for ${viewerDid}: ${message}`);
    })
    .finally(() => {
      inflightSweeps.delete(viewerDid);
      // The sweep may have recovered rows naming this viewer, so the reverse
      // memo is dropped for the next read to re-read.
      reverseCache.delete(viewerDid);
    });

  inflightSweeps.set(viewerDid, run);
}

async function sweepBlockers(
  viewerDid: UserDid,
  readStateDb: DbLike,
): Promise<void> {
  const candidates = await candidateBlockerDids(viewerDid, readStateDb);
  candidates.delete(viewerDid);
  if (candidates.size === 0) return;

  const dids = [...candidates];
  const stamps = await readStateDb
    .query(
      `select user_did, fetched_at, status from user_block_fetches
        where user_did in (${dids.map(() => "?").join(",")})`,
    )
    .all<{ user_did: string; fetched_at: number; status: "ok" | "error" }>(dids);
  const now = Date.now();
  const fresh = new Set<string>();
  for (const row of stamps) {
    const age = now - row.fetched_at;
    if (
      row.status === "error"
        ? age < blockErrorBackoffMs()
        : age < blockCacheTtlMs()
    ) {
      fresh.add(row.user_did);
    }
  }

  await mapWithConcurrency(
    dids.filter((did) => !fresh.has(did)),
    SWEEP_CONCURRENCY,
    async (did) => {
      startFetch(did, readStateDb);
      // Awaiting the shared promise is what bounds the sweep's concurrency; the
      // fetch itself is already detached from every read path.
      await inflightFetches.get(did);
    },
  );
}

/**
 * The DIDs that could hold a block naming `viewerDid`: the members of every space
 * the viewer has joined.
 *
 * Bridged authors never appear here as blockers — they hold no repo to write a
 * block into — which is why the reverse direction is ATProto-only by
 * construction.
 */
async function candidateBlockerDids(
  viewerDid: UserDid,
  readStateDb: DbLike,
): Promise<Set<UserDid>> {
  const spaceDids = await selectJoinedSpaceDids(readStateDb, viewerDid);
  const candidates = new Set<UserDid>();
  for (const spaceDid of spaceDids) {
    const members = await openSpaceDb(spaceDid)
      .query("select tail as did from edges where head = ? and label = 'member'")
      .all<{ did: string }>([spaceDid]);
    for (const member of members) candidates.add(member.did as UserDid);
  }
  return candidates;
}

/** How many candidate repos are read at once. */
const SWEEP_CONCURRENCY = 4;

/** Run `work` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await work(items[index] as T);
      }
    },
  );
  await Promise.all(runners);
}
