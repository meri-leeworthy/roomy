/**
 * User thread activity helpers.
 *
 * Tracks threads the user has interacted with (sent a message or added a
 * reaction) and provides query support for the sidebar `activeThreads` in
 * `space.getMetadata`.
 *
 * All data lives in the read-state database (`user_thread_activity`),
 * which is appserver-owned and cannot be reconstructed from the event log.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import { hydrateProfiles } from "./profileStore.ts";

/** How far back (in ms) to consider threads active. Default: 120 hours. */
export const ACTIVE_WINDOW_MS = 120 * 60 * 60 * 1000;

/** Maximum number of active threads to return per user+space. */
const MAX_ACTIVE_THREADS = 8;

/**
 * Upsert a user's activity in a thread.
 *
 * Called when the user sends a message, adds a reaction, or reads a thread.
 * This is a no-op if `threadId` is not actually a thread — the caller
 * is responsible for checking.
 */
export async function upsertUserThreadActivity(
  db: DbLike,
  userDid: string,
  threadId: string,
  timestamp: number,
): Promise<void> {
  await db.run(
    `insert into user_thread_activity (user_did, thread_id, last_active_at, updated_at)
     values (?, ?, ?, ?)
     on conflict(user_did, thread_id) do update set
       last_active_at = excluded.last_active_at,
       updated_at = excluded.updated_at`,
    userDid, threadId, timestamp, Date.now(),
  );
}

/**
 * Refresh thread activity when a new message arrives.
 *
 * Re-surfaces the thread in the sidebar for every user who is already
 * tracking it (has a `user_thread_activity` row — they wrote, reacted, or
 * read it), so a thread you've been active in reappears when someone else
 * posts — not only when you post. Also ensures the author is tracking it.
 */
export async function refreshThreadActivityOnMessage(
  db: DbLike,
  threadId: string,
  authorDid: string,
  timestamp: number,
): Promise<void> {
  const now = Date.now();
  await db.run(
    `update user_thread_activity
        set last_active_at = ?, updated_at = ?
      where thread_id = ?`,
    timestamp, now, threadId,
  );
  // Ensure the author is tracking it too.
  await upsertUserThreadActivity(db, authorDid, threadId, timestamp);
}

/**
 * Result shape for a single active thread entry in the sidebar.
 */
export interface ActiveThreadEntry {
  id: string;
  name: string | null;
  /** The parent channel ID this thread is canonically linked to. */
  canonicalParent: string | null;
  /** Latest message timestamp (ISO string), null if no messages. */
  latestTimestamp: string | null;
  /** Up to 3 most recent distinct participants. */
  latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
  canRead: boolean;
  canWrite: boolean;
  unreadCount: number;
  lastRead: string | null;
}

/**
 * Resolve thread metadata (name, latest activity, recent participants) for
 * a batch of thread IDs. Returns a map keyed by thread ID.
 *
 * Reuses the same prepared statements as `listThreadActivity` in
 * `threadActivity.ts`. The caller is responsible for filtering by access.
 */
export async function resolveThreadsByIds(
  db: DbLike,
  threadIds: string[],
): Promise<Map<string, {
  name: string | null;
  latestTimestamp: string | null;
  latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
  canonicalParent: string | null;
}>> {
  const result = new Map<string, {
    name: string | null;
    latestTimestamp: string | null;
    latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
    canonicalParent: string | null;
  }>();

  if (threadIds.length === 0) return result;

  // Batch query thread names
  const nameStmt = await db.query(
    `select ci.name from comp_info ci where ci.entity = ?`,
  );

  // Latest timestamp per thread
  const latestStmt = await db.query(
    `select max(cc.timestamp) as ts
       from entities e
       join comp_content cc on cc.entity = e.id
      where e.room = ?`,
  );

  // Recent participants (up to 3)
  const participantsStmt = await db.query(
    `select did, name, avatar from (
       select author_e.tail as did,
              ci.name as name,
              ci.avatar as avatar,
              max(cc.timestamp) as ts
         from entities msg
         join comp_content cc on cc.entity = msg.id
         join edges author_e on author_e.head = msg.id and author_e.label = 'author'
         left join comp_info ci on ci.entity = author_e.tail
        where msg.room = ?
        group by author_e.tail
     )
     order by ts desc
     limit 3`,
  );

  // Canonical parent (the link edge with canonical_parent=1)
  const parentStmt = await db.query(
    `select head from edges
      where tail = ? and label = 'link'
        and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
      limit 1`,
  );

  for (const tid of threadIds) {
    const nameRow = await nameStmt.get<{ name: string | null }>([tid]);
    const latest = await latestStmt.get<{ ts: number | null }>([tid]);
    const members = await participantsStmt.all<{ did: string; name: string | null; avatar: string | null }>([tid]);
    const parent = await parentStmt.get<{ head: string }>([tid]);

    result.set(tid, {
      name: nameRow?.name ?? null,
      latestTimestamp:
        latest?.ts != null ? new Date(latest.ts).toISOString() : null,
      latestMembers: members.map((m) => ({
        did: m.did,
        name: m.name,
        avatar: m.avatar,
      })),
      canonicalParent: parent?.head ?? null,
    });
  }

  // Resolve participant profiles from the global store (with an in-memory
  // cache). A user's profile entity lives in their own stream, not this
  // space's stream, so the per-space comp_info join above is null for
  // cross-stream users. The global `profiles` table is authoritative; the
  // per-space value (if any) acts as a fallback.
  const membersToHydrate: Array<{ did: string; name: string | null; avatar: string | null }> = [];
  for (const entry of result.values()) membersToHydrate.push(...entry.latestMembers);
  await hydrateProfiles(
    membersToHydrate,
    (m) => m.did,
    (m, p) => {
      if (p.name != null) m.name = p.name;
      if (p.avatar != null) m.avatar = p.avatar;
    },
  );

  return result;
}

/**
 * Query active threads for a user in a space, returning up to
 * `MAX_ACTIVE_THREADS` results.
 *
 * Step 1: Find candidate thread IDs from `user_thread_activity` (within the
 * activity window, not deleted, labeled as thread).
 * Step 2: Resolve metadata via `resolveThreadsByIds`.
 * Step 3 (caller): Filter by read access and distribute into channel objects.
 *
 * If the user has no rows for this space, runs a lazy backfill from messages
 * the user authored in threads within the activity window.
 */
export async function queryActiveThreads(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
): Promise<Array<{
  id: string;
  last_active_at: number;
}>> {
  const now = Date.now();
  const windowStart = now - ACTIVE_WINDOW_MS;

  // Lazy backfill: if no `user_thread_activity` rows exist for this user in
  // THIS space, seed from authored messages. `user_thread_activity` lives in
  // the read-state DB; the entity/room checks live in the per-space DB (Phase
  // 3 — entities moved out of the read-state DB).
  const myThreads = await readStateDb
    .query("select thread_id from user_thread_activity where user_did = ?")
    .all<{ thread_id: string }>([userDid]);
  let existingCount = 0;
  if (myThreads.length > 0) {
    const ids = myThreads.map((r) => r.thread_id);
    const ph = ids.map(() => "?").join(",");
    const row = await spaceDb
      .query(`select count(*) as count from entities where id in (${ph}) and stream_id = ?`)
      .get<{ count: number }>([...ids, spaceId]);
    existingCount = row?.count ?? 0;
  }
  if (existingCount === 0) {
    await backfillUserThreadActivity(readStateDb, spaceDb, userDid, spaceId, windowStart);
  }

  // Query active threads within the activity window. Two-step: fetch candidate
  // `user_thread_activity` rows from the read-state DB, then confirm each is a
  // non-deleted thread in this space via the per-space DB.
  const utaRows = await readStateDb
    .query(
      `select thread_id, last_active_at
         from user_thread_activity
        where user_did = ?
          and last_active_at > ?
        order by last_active_at desc
        limit ?`,
    )
    .all<{ thread_id: string; last_active_at: number }>([userDid, windowStart, MAX_ACTIVE_THREADS]);

  const rows: Array<{ thread_id: string; last_active_at: number }> = [];
  for (const r of utaRows) {
    const thread = await spaceDb
      .query(
        `select 1 as n from entities e
           join comp_room cr on cr.entity = e.id
          where e.id = ?
            and e.stream_id = ?
            and cr.label = 'space.roomy.thread'
            and coalesce(cr.deleted, 0) = 0
          limit 1`,
      )
      .get<{ n: number }>([r.thread_id, spaceId]);
    if (thread) rows.push(r);
    if (rows.length >= MAX_ACTIVE_THREADS) break;
  }

  return rows.map((r) => ({
    id: r.thread_id,
    last_active_at: r.last_active_at,
  }));
}

/**
 * Backfill `user_thread_activity` from messages the user authored in threads
 * within the given window. This gives the user an immediate populated sidebar
 * without needing to write a new message first. Reads candidate threads from
 * the per-space DB (`spaceDb`), writes rows to the read-state DB
 * (`readStateDb`) — Phase 3: entities/content/edges are per-space.
 */
async function backfillUserThreadActivity(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
  windowStart: number,
): Promise<void> {
  const candidates = await spaceDb
    .query(
      `select e.room as room, max(cc.timestamp) as ts
         from entities e
         join comp_content cc on cc.entity = e.id
         join edges author_e on author_e.head = e.id and author_e.label = 'author'
         join comp_room cr on cr.entity = e.room and cr.label = 'space.roomy.thread'
        where author_e.tail = ?
          and e.stream_id = ?
          and cc.timestamp > ?
        group by e.room`,
    )
    .all<{ room: string; ts: number | null }>([userDid, spaceId, windowStart]);
  for (const c of candidates) {
    await readStateDb.run(
      `insert or ignore into user_thread_activity (user_did, thread_id, last_active_at, updated_at)
       values (?, ?, ?, ?)`,
      userDid, c.room, c.ts ?? windowStart, Date.now(),
    );
  }
}

/**
 * Check if a room is a thread (has comp_room.label = 'space.roomy.thread').
 */
export async function isThread(db: DbLike, roomId: string): Promise<boolean> {
  const row = await db
    .query(
      `select cr.label from comp_room cr where cr.entity = ?`,
    )
    .get<{ label: string }>([roomId]);
  return row?.label === "space.roomy.thread";
}

/**
 * Purge stale user_thread_activity rows older than the given timestamp.
 * Should be called periodically (e.g. once per hour) from a background timer.
 */
export async function purgeStaleThreadActivity(
  db: DbLike,
  olderThan: number,
): Promise<number> {
  const result = await (await db.prepare(
    `delete from user_thread_activity
     where last_active_at < ?`,
  )).run([olderThan]);
  return result.changes;
}
