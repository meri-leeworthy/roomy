/**
 * One-time recovery of durable user-space membership intent from the event log.
 *
 * The v6 global repair derived active memberships from per-space `member`
 * edges, which resurrected spaces users had left (leaving persists the
 * `member` edge and only records `leftSpace` in the global DB). This migration
 * instead reduces the full join/leave history — both current
 * `space.roomy.space.*` and deprecated `space.roomy.space.personal.*` events —
 * ordered by event ULID per (user, space), and writes the winner into the
 * read-state `user_space_membership` table.
 *
 * Runs as a resumable read-state migration: the worker inserts a
 * `readstate_schema_migrations` row with `completed_at = null`; startup runs
 * this task and stamps completion only after full success. Interrupted runs
 * retry next boot. Idempotent.
 */

import { decode } from "@atcute/cbor";
import type { DbLike } from "./types.ts";
import { log } from "../log.ts";

/** Current space-side join/leave event types (space = stream_id). */
const CURRENT_JOIN = "space.roomy.space.joinSpace.v0";
const CURRENT_LEAVE = "space.roomy.space.leaveSpace.v0";

/** Deprecated personal-stream join/leave event types (space = payload.spaceDid). */
const PERSONAL_JOIN = "space.roomy.space.personal.joinSpace.v0";
const PERSONAL_LEAVE = "space.roomy.space.personal.leaveSpace.v0";
/** Even older personal-stream variants (space nested under `variant`). */
const STREAM_PERSONAL_JOIN = "space.roomy.stream.personal.joinSpace.v0";
const LEGACY_PERSONAL_JOIN = "space.roomy.personal.joinSpace.v0";

interface MembershipEvent {
  userDid: string;
  spaceDid: string;
  state: "joined" | "left";
  eventId: string;
  source: string;
}

interface RawEvent {
  rowid: number;
  stream_id: string;
  user: string;
  payload: Uint8Array;
}

const SCAN_CHUNK = 50000;

/**
 * Reduce the event log into a (user, space) → latest membership intent map.
 * Bounded memory: only membership events are retained (a few thousand), and
 * the scan is chunked by rowid so the full log is never held in memory.
 */
export function reduceMembershipEvents(
  rows: RawEvent[],
): Map<string, MembershipEvent> {
  const out = new Map<string, MembershipEvent>();
  for (const r of rows) {
    let decoded: any;
    try {
      decoded = decode(r.payload);
    } catch {
      continue; // malformed payload — not a membership event
    }
    const ev = classifyEvent(r, decoded);
    if (!ev) continue;
    const key = `${ev.userDid}\u0000${ev.spaceDid}`;
    const existing = out.get(key);
    if (!existing || compareUlid(ev.eventId, existing.eventId) > 0) {
      out.set(key, ev);
    }
  }
  return out;
}

/** Classify a decoded event as a membership event, or null. */
function classifyEvent(
  r: RawEvent,
  decoded: any,
): MembershipEvent | null {
  const $type = decoded?.$type;
  const variant = decoded?.variant;

  // Current space-side events: space is the stream the event lives in.
  if ($type === CURRENT_JOIN) {
    return { userDid: r.user, spaceDid: r.stream_id, state: "joined", eventId: decoded.id, source: "space.joinSpace" };
  }
  if ($type === CURRENT_LEAVE) {
    return { userDid: r.user, spaceDid: r.stream_id, state: "left", eventId: decoded.id, source: "space.leaveSpace" };
  }

  // Deprecated personal-stream events: space is in the payload.
  if ($type === PERSONAL_JOIN) {
    return { userDid: r.user, spaceDid: decoded.spaceDid, state: "joined", eventId: decoded.id, source: "personal.joinSpace" };
  }
  if ($type === PERSONAL_LEAVE) {
    return { userDid: r.user, spaceDid: decoded.spaceDid, state: "left", eventId: decoded.id, source: "personal.leaveSpace" };
  }

  // Even older variants nested under `variant`.
  if (variant?.$type === STREAM_PERSONAL_JOIN) {
    return { userDid: r.user, spaceDid: variant.spaceDid, state: "joined", eventId: decoded.id, source: "stream.personal.joinSpace" };
  }
  if (variant?.$type === LEGACY_PERSONAL_JOIN) {
    return { userDid: r.user, spaceDid: variant.spaceId, state: "joined", eventId: decoded.id, source: "legacy.personal.joinSpace" };
  }

  return null;
}

/**
 * Compare two ULIDs by their canonical (uppercase) string form. ULIDs are
 * lexicographically sortable in Crockford base32, so string comparison is
 * correct. Case-insensitive to tolerate mixed-case event IDs.
 */
function compareUlid(a: string, b: string): number {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  return 0;
}

/**
 * Run the membership recovery. Scans the event log, reduces join/leave events
 * by latest ULID per (user, space), and writes the result into the read-state
 * `user_space_membership` table. Idempotent and resumable.
 */
export async function recoverUserSpaceMembership(
  db: DbLike,
): Promise<void> {
  const eventsDb = db.events?.() ?? db;
  const readStateDb = db.readState?.() ?? db;

  // Scan the event log in rowid-keyset chunks (indexed, O(n) total).
  const winners = new Map<string, MembershipEvent>();
  let lastRowid = 0;
  let scanned = 0;
  for (;;) {
    const rows = await eventsDb
      .query(
        `select rowid, stream_id, user, payload
           from stream_events
          where rowid > ?
          order by rowid
          limit ?`,
      )
      .all<RawEvent>([lastRowid, SCAN_CHUNK]);
    if (rows.length === 0) break;
    const chunk = reduceMembershipEvents(rows);
    for (const [key, ev] of chunk) {
      const existing = winners.get(key);
      if (!existing || compareUlid(ev.eventId, existing.eventId) > 0) {
        winners.set(key, ev);
      }
    }
    lastRowid = rows[rows.length - 1]!.rowid;
    scanned += rows.length;
  }

  log.info("startup", `membership recovery scanned ${scanned} events, ${winners.size} (user,space) intents`);

  // Write winners into the read-state table in one transaction.
  const steps = [...winners.values()].map((ev) => ({
    type: "run" as const,
    sql: `insert into user_space_membership
            (user_did, space_did, state, source, source_event_id, updated_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict(user_did, space_did) do update set
            state = excluded.state,
            source = excluded.source,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`,
    params: [ev.userDid, ev.spaceDid, ev.state, ev.source, ev.eventId, Date.now()],
  }));
  if (steps.length > 0) {
    await readStateDb.transaction(steps);
  }

  log.info("startup", `membership recovery wrote ${steps.length} durable membership rows`);
}

interface PendingMigration {
  version: string;
}

type ReadStateMigrationTask = (db: DbLike) => Promise<void>;

/**
 * Async/data migrations keyed by the read-state schema version that scheduled
 * them. Structural DDL is applied synchronously by the DB worker; these tasks
 * may scan the event log and therefore run from the main thread.
 */
const READSTATE_MIGRATION_TASKS: Record<string, ReadStateMigrationTask> = {
  "6": recoverUserSpaceMembership,
};

/**
 * Run incomplete read-state post-migrations in version order.
 *
 * Completion is stamped only after a task succeeds in full. Tasks must be
 * idempotent: if the process exits midway, the null marker remains and the
 * whole task is retried on the next boot.
 */
export async function runPendingReadStateMigrations(
  db: DbLike,
): Promise<void> {
  const readStateDb = db.readState?.() ?? db;
  const pending = await readStateDb
    .query(
      `select version
         from readstate_schema_migrations
        where completed_at is null
        order by cast(version as integer)`,
    )
    .all<PendingMigration>();

  for (const { version } of pending) {
    const task = READSTATE_MIGRATION_TASKS[version];
    if (!task) {
      throw new Error(`No read-state post-migration task registered for schema v${version}`);
    }

    log.info("startup", `running read-state post-migration v${version}`);
    await task(db);
    await readStateDb.run(
      `update readstate_schema_migrations
          set completed_at = ?
        where version = ? and completed_at is null`,
      Date.now(),
      version,
    );
    log.info("startup", `read-state post-migration v${version} complete`);
  }
}
