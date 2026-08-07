/**
 * Apply a single materialised event's SQL statements to the database.
 *
 * Each event runs inside its own SAVEPOINT so a single failing event rolls
 * back cleanly without poisoning the rest of the batch. This is stricter than
 * the frontend's per-statement error tolerance: the appserver treats partial
 * application as a bug, not a feature.
 *
 * Side-effects (sort_idx, unread counter) live here rather than inside the SDK
 * materialisers because the original design keeps materialisers free of
 * backfill awareness.
 *
 * Per-space split (Phase 1): when `spaceDb` is provided, the event's
 * statements and per-space side-effects are dual-written to it. The
 * monolithic DB is written first and remains the source of truth: if the
 * per-space write fails, the monolithic DB is still consistent and the space
 * DB is repaired by re-materialising that stream. Read-state side-effects
 * (`readstate.*`) never dual-write — the per-space DB has no readstate
 * tables. `joinedSpace`/`leftSpace` edge statements route to `globalDb`
 * instead of the space DB.
 *
 * Concurrency: `applyBundle` manages its SAVEPOINT via individual async
 * `db.exec` calls (each a separate worker message). Without serialization,
 * concurrent calls interleave: call A's `SAVEPOINT evt_AAA` starts an implicit
 * transaction, call B's `SAVEPOINT evt_BBB` nests within it, then call A's
 * `RELEASE evt_AAA` commits the transaction — destroying evt_BBB. When call B
 * tries `RELEASE evt_BBB`, SQLite raises "no such savepoint". The mutex below
 * serializes the savepoint-managed section so only one `applyBundle` has an
 * open savepoint at a time.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import type { SqlStatement, StatementBundleSuccess } from "./types.ts";
import {
  setMessageSortIdxByForward,
  setMessageSortIdxByReorder,
  setMessageSortIdxByTimestamp,
} from "./sortIdx.ts";
import { isThread, upsertUserThreadActivity } from "../queries/userActiveThreads.ts";
import { upsertUserRoomParticipation } from "../queries/userRoomParticipation.ts";
import { upsertActivityItem } from "./activityItem.ts";
import { writeSetUserProfileToGlobal } from "./profiles.ts";
import { isGlobalEdgeStatement } from "./statementRouting.ts";
import { decodeTime } from "ulidx";

const decodeTimeFromId = (id: string): number => decodeTime(id);

// ─── Async mutex ─────────────────────────────────────────────────────────

/**
 * Minimal promise-based mutex. Serializes the savepoint-managed section of
 * `applyBundle` so concurrent calls don't interleave their SAVEPOINT/RELEASE
 * operations (which would destroy each other's savepoints — see file header).
 */
class AsyncMutex {
  #chain: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const chain = this.#chain;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#chain = promise;
    await chain;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

/**
 * Process-wide mutex for savepoint-managed SQL sections on the materialised
 * DB. Shared by `applyBundle` (side-effects) and `applyBatch`'s inline
 * per-event loop — both manage SAVEPOINT/RELEASE via individual async
 * `db.exec` calls on the same DB handle, so any two concurrent sections can
 * interleave and destroy each other's savepoints. Exporting the instance
 * lets `applyBatch` acquire the same lock as `applyBundle`.
 */
export const savepointMutex = new AsyncMutex();

export interface ApplyBundleOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
  streamId: StreamDid;
}

export async function applyBundle(
  db: DbLike,
  bundle: StatementBundleSuccess,
  opts: ApplyBundleOpts,
  spaceDb?: DbLike,
  globalDb?: DbLike,
): Promise<void> {
  // Serialize the savepoint-managed section: manual SAVEPOINT/RELEASE via
  // individual async db.exec calls is not atomic. Without this lock,
  // concurrent calls destroy each other's savepoints (see file header).
  return savepointMutex.run(() =>
    applyBundleInner(db, bundle, opts, spaceDb, globalDb),
  );
}

async function applyBundleInner(
  db: DbLike,
  bundle: StatementBundleSuccess,
  opts: ApplyBundleOpts,
  spaceDb?: DbLike,
  globalDb?: DbLike,
): Promise<void> {
  const savepoint = `evt_${bundle.event.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  await db.exec(`savepoint ${savepoint}`);

  // Per-batch cache: isThread result is stable per room, avoid re-querying
  // for every message in the same room within a batch.
  const isThreadCache = new Map<string, boolean>();
  const cachedIsThread = async (roomId: string): Promise<boolean> => {
    let result = isThreadCache.get(roomId);
    if (result === undefined) {
      result = await isThread(db, roomId);
      isThreadCache.set(roomId, result);
    }
    return result;
  };

  try {
    // ── Monolithic DB (source of truth) ────────────────────────────────
    // Statements + per-space side effects run on the main DB FIRST; the
    // savepoint always releases (commits) at the end of the try, regardless
    // of what happens on the derived DBs (plan §305: "If the spaceDb write
    // fails, the monolithic DB is still consistent"). Only a main-DB
    // failure rolls back and rethrows.
    for (const statement of bundle.statements) {
      await runStatement(db, statement);
    }

    await setMessageSortIdxByTimestamp(db, bundle.event);
    await setMessageSortIdxByReorder(db, opts.streamId, bundle.event);
    await setMessageSortIdxByForward(db, bundle.event);

    // Activity feed: upsert the activity item for every createMessage event
    // (including backfill, so existing rooms get populated).
    if (
      bundle.event.$type === "space.roomy.message.createMessage.v0" &&
      bundle.event.room
    ) {
      await upsertActivityItem(db, {
        roomId: bundle.event.room,
        spaceId: opts.streamId,
        messageId: bundle.event.id,
      });
    }

    // ── Read-state side effects (monolithic DB only) ──────────────────
    // readstate.* tables do not exist in the per-space DB.

    if (
      !opts.isBackfill &&
      bundle.event.$type === "space.roomy.message.createMessage.v0" &&
      bundle.event.room
    ) {
      const isThreadRoom = await cachedIsThread(bundle.event.room);

      // Increment unread for all users tracking this room.
      if (isThreadRoom) {
        // Threads: only bump users who have engaged with this thread.
        // Uses INSERT ... ON CONFLICT DO UPDATE so the read_positions row
        // is created if it doesn't exist yet (lazy creation).
        await db.run(
          `insert into readstate.read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
           select uta.user_did, ?, coalesce(
             (select stream_id from entities where id = ?), ''
           ), coalesce(
             (select max(sort_idx) from entities where room = ?), '0'
           ), 1, (unixepoch() * 1000)
             from readstate.user_thread_activity uta
            where uta.thread_id = ?
           on conflict(user_did, room_id) do update set
             unread_count = unread_count + 1,
             updated_at = (unixepoch() * 1000)`,
          bundle.event.room,
          bundle.event.room,
          bundle.event.room,
          bundle.event.room,
        );
      } else {
        // Channels: bump all users with a read_positions row.
        await db.run(
          `update readstate.read_positions
              set unread_count = unread_count + 1,
                  updated_at = (unixepoch() * 1000)
            where room_id = ?`,
          bundle.event.room,
        );
      }

      // Track thread activity: if the message is in a thread, upsert the
      // author's interaction so the thread appears in their sidebar.
      if (isThreadRoom) {
        const timestamp = decodeTimeFromId(bundle.event.id);
        await upsertUserThreadActivity(db, bundle.user, bundle.event.room, timestamp);
      }

      // Track the author's participation in this room (all room types —
      // channels included). The Engaged push-digest gate uses this to
      // restrict prompts to rooms you've spoken in. Uses the effective author
      // (override-author for bridged messages) to match the `author` edge.
      const ext = bundle.event.extensions?.[
        "space.roomy.extension.authorOverride.v0"
      ] as { did?: unknown } | undefined;
      const overrideDid =
        typeof ext?.did === "string" ? ext.did : undefined;
      await upsertUserRoomParticipation(
        db,
        overrideDid ?? bundle.user,
        bundle.event.room,
        decodeTimeFromId(bundle.event.id),
      );
    }

    // Track thread creation: if the event creates a thread, register the
    // creating user's activity so the thread appears in their sidebar
    // immediately, without needing to send a message first.
    if (
      !opts.isBackfill &&
      bundle.event.$type === "space.roomy.room.createRoom.v0" &&
      "kind" in bundle.event &&
      bundle.event.kind === "space.roomy.thread"
    ) {
      const timestamp = decodeTimeFromId(bundle.event.id);
      await upsertUserThreadActivity(db, bundle.user, bundle.event.id, timestamp);
    }

    // Track reaction activity in threads (non-backfill only).
    if (
      !opts.isBackfill &&
      (bundle.event.$type === "space.roomy.reaction.addReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.addBridgedReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.removeReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.removeBridgedReaction.v0") &&
      bundle.event.room
    ) {
      if (await cachedIsThread(bundle.event.room)) {
        const timestamp = decodeTimeFromId(bundle.event.id);
        // For bridged reactions, use the reactingUser field instead of the
        // authenticated event sender.
        const reactingUser =
          "reactingUser" in bundle.event && typeof bundle.event.reactingUser === "string"
            ? bundle.event.reactingUser
            : bundle.user;
        await upsertUserThreadActivity(db, reactingUser, bundle.event.room, timestamp);
      }
    }

    // Commit the monolithic savepoint FIRST — the derived writes below must
    // never abort the main DB's already-consistent state.
    await db.exec(`release ${savepoint}`);
  } catch (e) {
    // Main-DB failure: roll back and rethrow — the event is lost everywhere.
    await db.exec(`rollback to ${savepoint}`);
    await db.exec(`release ${savepoint}`);
    throw e;
  }

  // ── Derived DBs ─────────────────────────────────────────────────────
  // Run after the main savepoint is committed. A failure rolls back only
  // the derived target's savepoint; the monolithic DB is already consistent
  // and the space DB is repaired by deleting + re-backfilling it.
  if (spaceDb) {
    try {
      await spaceDb.exec(`savepoint ${savepoint}`);
      for (const statement of bundle.statements) {
        await runStatementForTargets(spaceDb, globalDb, statement);
      }
      await setMessageSortIdxByTimestamp(spaceDb, bundle.event);
      await setMessageSortIdxByReorder(spaceDb, opts.streamId, bundle.event);
      await setMessageSortIdxByForward(spaceDb, bundle.event);
      if (
        bundle.event.$type === "space.roomy.message.createMessage.v0" &&
        bundle.event.room
      ) {
        await upsertActivityItem(spaceDb, {
          roomId: bundle.event.room,
          spaceId: opts.streamId,
          messageId: bundle.event.id,
        });
      }
      // SetUserProfile events update the global profile store (bridged users
      // don't go through HappyView, so the materialiser is the only writer).
      if (bundle.event.$type === "space.roomy.user.updateProfile.v0") {
        await writeSetUserProfileToGlobal(
          bundle.event as unknown as {
            did: string;
            name?: unknown;
            avatar?: unknown;
            description?: unknown;
            extensions?: Record<string, unknown>;
          },
        );
      }
      await spaceDb.exec(`release ${savepoint}`);
    } catch (spaceErr) {
      try {
        await spaceDb.exec(`rollback to ${savepoint}`);
        await spaceDb.exec(`release ${savepoint}`);
      } catch {
        /* best-effort */
      }
      const message =
        spaceErr instanceof Error ? spaceErr.message : String(spaceErr);
      console.error(
        `[materialize] spaceDb dual-write failed for ${opts.streamId} (monolithic intact): ${message}`,
      );
    }
  }
}

/**
 * Run a statement against the derived DBs: global-edge statements go to the
 * global DB, everything else to the per-space DB. A missing target is a
 * silent no-op (tests that don't exercise dual-write pass no derived DBs).
 */
async function runStatementForTargets(
  spaceDb: DbLike,
  globalDb: DbLike | undefined,
  statement: SqlStatement,
): Promise<void> {
  if (isGlobalEdgeStatement(statement.sql)) {
    if (globalDb) await runStatement(globalDb, statement);
    return;
  }
  await runStatement(spaceDb, statement);
}

async function runStatement(db: DbLike, statement: SqlStatement): Promise<void> {
  const params = statement.params;
  if (params === undefined) {
    await db.run(statement.sql);
  } else if (Array.isArray(params)) {
    await db.run(statement.sql, ...(params as unknown[] as never[]));
  } else {
    await db.run(statement.sql, params as never);
  }
}
