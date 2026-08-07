import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ulid } from "ulidx";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import type { SQLQueryBindings } from "bun:sqlite";

import { toAsyncDb } from "../db/syncAdapter.ts";
import { applyBatch } from "./applyBatch.ts";
import { applyBundle } from "./applyBundle.ts";
import { openDb } from "../db/db.ts";
import type { StatementBundleSuccess } from "./types.ts";
import { selectMessages } from "../queries/selectMessages.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}

function seedSpace(db: Database, streamDid: StreamDid): void {
  // The space entity + comp_space row are normally created by the
  // JoinSpace materialiser. Tests for the apply machinery seed
  // them directly so we can verify backfilled_to.
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    streamDid,
    streamDid,
  ]);
  db.run("insert into comp_space (entity) values (?)", [streamDid]);
}

function decoded(event: Event, idx: number): DecodedStreamEvent {
  return { event, idx: idx as StreamIndex, user: USER };
}

function createRoomEvent(name: string): Event {
  return {
    $type: "space.roomy.room.createRoom.v0",
    id: newUlid(),
    kind: "space.roomy.channel",
    name,
  } as unknown as Event;
}

/** Seed a channel + thread pair so a createRoomLink can reference both. */
function seedChannelAndThread(
  db: Database,
  channelId: string,
  threadId: string,
): void {
  for (const id of [channelId, threadId]) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      id,
      STREAM,
    ]);
  }
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [channelId],
  );
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [threadId],
  );
}

/**
 * Build a createRoomLink event linking `threadId` into `channelId`.
 * Mirrors what the SDK's createThread / createRoomLink operations emit.
 */
function createRoomLinkEvent(channelId: string, threadId: string): Event {
  return {
    $type: "space.roomy.link.createRoomLink.v0",
    id: newUlid(),
    room: channelId,
    linkToRoom: threadId,
    isCreationLink: true,
  } as unknown as Event;
}

describe("applyBatch", () => {
  test("applies a single event and advances backfilled_to", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const event = createRoomEvent("general");
    const stats = await applyBatch(asyncDb, STREAM, [decoded(event, 5)], {
      isBackfill: true,
    });

    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    const room = await asyncDb
      .query("select entity, label from comp_room where entity = ?")
      .get<{ entity: string; label: string }>(event.id);
    expect(room?.label).toBe("space.roomy.channel");

    const cursor = await asyncDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get<{ backfilled_to: number }>(STREAM);
    expect(cursor?.backfilled_to).toBe(5);
  })

  test("counts materialiser errors without aborting the batch", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const ok = createRoomEvent("ok");
    const bad = {
      $type: "space.roomy.this.does.not.exist.v0",
      id: newUlid(),
    } as unknown as Event;
    const ok2 = createRoomEvent("ok2");

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [decoded(ok, 1), decoded(bad, 2), decoded(ok2, 3)],
      { isBackfill: true },
    );

    expect(stats.applied).toBe(2);
    expect(stats.materializerErrors).toBe(1);
    expect(stats.applyErrors).toBe(0);
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]?.reason).toBe("materializer");

    expect(
      (await asyncDb
        .query("select count(*) as count from comp_room")
        .get<{ count: number }>())?.count,
    ).toBe(2);

    // Cursor advances to the highest idx in the batch even though one event
    // failed — the failure is tracked, but we have no reason to stay stuck
    // on a permanently-broken event.
    expect(
      (await asyncDb
        .query("select backfilled_to from comp_space where entity = ?")
        .get<{ backfilled_to: number }>(STREAM))?.backfilled_to,
    ).toBe(3);
  })

  test("backfilled_to never moves backwards", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    await applyBatch(asyncDb, STREAM, [decoded(createRoomEvent("a"), 10)], {
      isBackfill: true,
    });
    await applyBatch(asyncDb, STREAM, [decoded(createRoomEvent("b"), 3)], {
      isBackfill: true,
    });

    const cursor = await asyncDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get<{ backfilled_to: number }>(STREAM);
    expect(cursor?.backfilled_to).toBe(10);
  })

  test("empty batch returns zero stats and does not touch cursor", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    db.run("update comp_space set backfilled_to = 7 where entity = ?", [
      STREAM,
    ]);

    const stats = await applyBatch(asyncDb, STREAM, [], { isBackfill: false });

    expect(stats.applied).toBe(0);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    expect(
      (await asyncDb
        .query("select backfilled_to from comp_space where entity = ?")
        .get<{ backfilled_to: number }>(STREAM))?.backfilled_to,
    ).toBe(7);
  })

  test("a single bad SQL error rolls back only that event's savepoint", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const goodA = createRoomEvent("a");
    const goodB = createRoomEvent("b");

    // Drop comp_room mid-batch by hand-applying the first event, then
    // breaking the schema so the second one's INSERT into comp_room fails.
    // We do this via two batches: first batch applies normally, then we
    // break a constraint and fire a second batch.
    await applyBatch(asyncDb, STREAM, [decoded(goodA, 1)], { isBackfill: true });

    // Force a NOT NULL violation by removing comp_room's `entity` column path —
    // simplest deterministic break is a duplicate-pkey: we re-use goodA's id.
    const dup = {
      $type: "space.roomy.room.createRoom.v0",
      id: goodA.id, // same ULID → entities row already exists, comp_room row exists
      kind: "space.roomy.channel",
      name: "dup",
    } as unknown as Event;

    // (this should NOT throw — comp_room insert has `on conflict do nothing`)
    // So we need a different break: violate the default_access CHECK.
    const broken = {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
      defaultAccess: "bogus", // not in ('readwrite','read','none')
      name: "broken",
    } as unknown as Event;

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [decoded(dup, 2), decoded(broken, 3), decoded(goodB, 4)],
      { isBackfill: true },
    );

    // dup is a no-op (on conflict do nothing), broken should fail apply,
    // goodB should still apply.
    expect(stats.applyErrors).toBeGreaterThanOrEqual(1);
    expect(stats.applied).toBeGreaterThanOrEqual(1);
    expect(
      (await asyncDb
        .query("select name from comp_info where entity = ?")
        .get<{ name: string | null }>(goodB.id))?.name,
    ).toBe("b");

    // The "broken" event must NOT have left an entities row behind — its
    // savepoint should have rolled back.
    expect(
      (await asyncDb
        .query("select count(*) as count from entities where id = ?")
        .get<{ count: number }>(broken.id))?.count,
    ).toBe(0);
  })

  // Regression: the createRoomLink materialiser computes canonical_parent
  // ("first link wins") from the current edge count. With `insert or replace`
  // it was non-idempotent — re-applying the same event flipped
  // canonical_parent 1 → 0, corrupting the parent-channel link for any
  // thread whose stream got re-backfilled. This re-ran on production data
  // and left ~8% of threads orphaned from their channel.
  test("createRoomLink is idempotent under re-application (canonical_parent stays 1)", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    const channelId = newUlid();
    const threadId = newUlid();
    seedChannelAndThread(db, channelId, threadId);

    const link = createRoomLinkEvent(channelId, threadId);

    // First application establishes the link with canonical_parent = 1.
    await applyBatch(asyncDb, STREAM, [decoded(link, 1)], { isBackfill: true });
    const first = await asyncDb
      .query("select payload from edges where label = 'link'")
      .get<{ payload: string }>();
    expect(first?.payload).toBe('{"canonical_parent":1}');

    // Simulate a re-backfill: the same event is delivered and applied again.
    // The materialiser must NOT overwrite the established canonical_parent.
    await applyBatch(asyncDb, STREAM, [decoded(link, 2)], { isBackfill: true });
    await applyBatch(asyncDb, STREAM, [decoded(link, 3)], { isBackfill: true });

    const after = await asyncDb
      .query("select payload from edges where label = 'link'")
      .get<{ payload: string }>();
    expect(after?.payload).toBe('{"canonical_parent":1}');

    // And there is still exactly one link edge (no duplicates).
    const count = (await asyncDb
      .query("select count(*) as n from edges where label = 'link'")
      .get<{ n: number }>())?.n;
    expect(count).toBe(1);
  })

  // The space.joinSpace materialiser must write the `joinedSpace` edge with
  // the *user DID* as head and the space stream as tail — this is what
  // tracks membership (routed to the global DB by the appserver). Pins the
  // edge shape so a stale dist / wrong materialiser fails loudly.
  test("space.joinSpace writes joinedSpace edge with user DID as head", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const joinEvent = {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    } as unknown as Event;

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [{ event: joinEvent, idx: 0 as StreamIndex, user: USER }],
      { isBackfill: true },
    );

    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    // Edge head must be the user DID, tail the space stream.
    const userEdge = await asyncDb
      .query(
        "select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'",
      )
      .get<{ n: number }>(USER, STREAM);
    expect(userEdge?.n).toBe(1);
  })
});

/** Build a createMessage event with a text body in the decoded `{ buf }` form. */
function createMessageEvent(roomId: string, id: string, text: string): Event {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id,
    room: roomId,
    body: {
      mimeType: "text/markdown",
      data: { buf: new TextEncoder().encode(text) },
    },
    extensions: {},
  } as unknown as Event;
}

/** Build a forwardMessages event forwarding one original into `threadId`. */
function forwardMessageEvent(
  threadId: string,
  channelId: string,
  id: string,
  originalId: string,
): Event {
  return {
    $type: "space.roomy.message.forwardMessages.v0",
    id,
    room: threadId,
    messageIds: [originalId],
    fromRoomId: channelId,
  } as unknown as Event;
}

describe("forwardMessages sort order", () => {
  // Regression: forward-reference entities got no sort_idx, so selectMessages
  // fell back to ordering by the forward event's own ULID. A thread-creation
  // batch forwards several messages within the same millisecond, so those
  // ULIDs differ only in their random suffixes and the original chronological
  // order of the forwarded messages was scrambled (older forwarded messages
  // could appear after newer ones). The fix copies the original message's
  // sort_idx onto the forward-reference entity.
  test("forwarded messages sort by the original's timestamp, not the forward event's", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    const threadId = newUlid();

    // Two originals in the channel: an OLDER one and a NEWER one (2 min apart).
    const T_old = 1_700_000_000_000;
    const T_new = T_old + 120_000;
    const msgOldId = ulid(T_old);
    const msgNewId = ulid(T_new);
    const msgOld = createMessageEvent(channelId, msgOldId, "old msg");
    const msgNew = createMessageEvent(channelId, msgNewId, "new msg");

    // Forward both into the thread. To reproduce the pre-fix scramble
    // deterministically, give the NEWER original's forward an EARLIER forward
    // event id than the OLDER original's forward. Before the fix the forward
    // references sorted by event id, so the newer-original forward would come
    // first (older-after-newer). After the fix they sort by the originals'
    // sort_idx, restoring chronological order.
    const T_fwd = T_new + 120_000;
    const fwdNewId = ulid(T_fwd); // newer original, earlier forward id
    const fwdOldId = ulid(T_fwd + 5_000); // older original, later forward id
    const fwdNew = forwardMessageEvent(threadId, channelId, fwdNewId, msgNewId);
    const fwdOld = forwardMessageEvent(threadId, channelId, fwdOldId, msgOldId);

    await applyBatch(
      asyncDb,
      STREAM,
      [
        decoded(msgOld, 1),
        decoded(msgNew, 2),
        decoded(fwdNew, 3),
        decoded(fwdOld, 4),
      ],
      { isBackfill: true },
    );

    const { messages } = await selectMessages(asyncDb, {
      kind: "room",
      roomId: threadId,
      limit: 100,
      cursor: null,
    });

    // Ascending: the older original's forward first, then the newer's.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe(fwdOldId);
    expect(messages[0]?.content).toBe("old msg");
    expect(messages[1]?.id).toBe(fwdNewId);
    expect(messages[1]?.content).toBe("new msg");
  });
})

// ─── Concurrency: applyBundle savepoint serialization ────────────────────

/**
 * Async DB wrapper that yields to the event loop *before* each operation,
 * simulating the AsyncDatabase worker's per-message interleaving. With
 * `toAsyncDb`, operations execute synchronously before the promise resolves,
 * so concurrent `applyBundle` calls never interleave. This wrapper forces
 * interleaving so the savepoint-mutex fix can be verified.
 */
function yieldingAsyncDb(db: Database): DbLike {
  const toBindings = (...params: unknown[]) => params as SQLQueryBindings[];
  const normaliseRowid = (r: number | bigint | undefined) =>
    r === undefined || r === null ? undefined : Number(r);

  return {
    query(sql: string) {
      const stmt = db.query(sql);
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          await Promise.resolve();
          return stmt.all(...toBindings(...params)) as T[];
        },
        async get<T>(...params: unknown[]): Promise<T | null> {
          await Promise.resolve();
          return (stmt.get(...toBindings(...params)) ?? null) as T | null;
        },
      };
    },
    async prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          await Promise.resolve();
          return stmt.all(...toBindings(...params)) as T[];
        },
        async get<T>(...params: unknown[]): Promise<T | null> {
          await Promise.resolve();
          return (stmt.get(...toBindings(...params)) ?? null) as T | null;
        },
        async run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
          await Promise.resolve();
          const result = stmt.run(...toBindings(...params));
          return { changes: result.changes, lastInsertRowid: normaliseRowid(result.lastInsertRowid) };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await Promise.resolve();
      db.exec(sql);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
      await Promise.resolve();
      const result = (db.run as (...args: unknown[]) => { changes: number; lastInsertRowid?: number | bigint })(sql, ...toBindings(...params));
      return { changes: result.changes, lastInsertRowid: normaliseRowid(result.lastInsertRowid) };
    },
    async transaction<T>(steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }>): Promise<T> {
      // Simulate worker transaction: yield, then run synchronously
      await Promise.resolve();
      let lastResult: unknown;
      const run = db.transaction(() => {
        for (const step of steps) {
          switch (step.type) {
            case "query":
              lastResult = db.prepare(step.sql).all(...toBindings(...(step.params ?? [])));
              break;
            case "run":
              lastResult = (db.run as (...args: unknown[]) => { changes: number; lastInsertRowid?: number | bigint })(step.sql, ...toBindings(...(step.params ?? [])));
              break;
            case "exec":
              db.exec(step.sql);
              lastResult = undefined;
              break;
          }
        }
      });
      run();
      return lastResult as T;
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

describe("applyBundle concurrency", () => {
  test("concurrent applyBundle calls do not destroy each other's savepoints", async () => {
    const { db } = freshDb();
    seedSpace(db, STREAM);

    // Seed a channel room so createMessage events can reference it.
    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, STREAM]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    const asyncDb = yieldingAsyncDb(db);

    // Two createMessage events with distinct ULIDs — each gets its own
    // savepoint name in applyBundle.
    const eventA = createMessageEvent(channelId, newUlid(), "message A");
    const eventB = createMessageEvent(channelId, newUlid(), "message B");

    // First, materialize the events (insert entities + comp_message rows)
    // so applyBundle's side-effects can find them. We use applyBatch with
    // the synchronous adapter for this setup step.
    const syncDb = toAsyncDb(db);
    await applyBatch(syncDb, STREAM, [decoded(eventA, 1)], { isBackfill: true });
    await applyBatch(syncDb, STREAM, [decoded(eventB, 2)], { isBackfill: true });

    // Now fire two applyBundle calls concurrently with the yielding adapter.
    // Without the mutex, their SAVEPOINT/RELEASE operations interleave:
    // A creates evt_AAA (starts implicit transaction), B creates evt_BBB
    // (nested), A releases evt_AAA (commits, destroys evt_BBB), B fails
    // with "no such savepoint: evt_BBB".
    const bundleA: StatementBundleSuccess = {
      status: "success",
      event: eventA,
      eventIdx: 1 as StreamIndex,
      user: USER,
      statements: [],
      dependsOn: [],
    };
    const bundleB: StatementBundleSuccess = {
      status: "success",
      event: eventB,
      eventIdx: 2 as StreamIndex,
      user: USER,
      statements: [],
      dependsOn: [],
    };

    const results = await Promise.allSettled([
      applyBundle(asyncDb, bundleA, { isBackfill: true, streamId: STREAM }),
      applyBundle(asyncDb, bundleB, { isBackfill: true, streamId: STREAM }),
    ]);

    // Both must succeed — no "no such savepoint" errors.
    for (const [i, result] of results.entries()) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "rejected") {
        // Provide a clear failure message with the actual error.
        throw new Error(`applyBundle ${i} failed: ${result.reason}`);
      }
    }
  });
});

describe("applyBatch concurrency", () => {
  test("concurrent applyBatch calls do not destroy each other's savepoints", async () => {
    const { db } = freshDb();
    seedSpace(db, STREAM);

    // Live batches (isBackfill: false) touch readstate.read_positions for
    // the unread-counter increment, so the readstate schema must be attached
    // (mirrors joinedSpaces.test.ts / dispatcher.test.ts fixtures).
    db.exec("attach database ':memory:' as readstate");
    db.exec(
      "create table if not exists readstate_schema_version (id integer primary key check (id = 1), version text not null) strict",
    );
    db.exec(
      "create table if not exists readstate.read_positions (user_did text not null, room_id text not null, seen_up_to text not null, unread_count integer not null default 0, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
    );
    db.exec(
      "create table if not exists readstate.user_thread_activity (user_did text not null, thread_id text not null, last_active_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, thread_id)) strict",
    );
    db.exec(
      "create table if not exists readstate.user_room_participation (user_did text not null, room_id text not null, last_message_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
    );

    // Seed a channel room so createMessage events can reference it.
    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, STREAM]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );
    const asyncDb = yieldingAsyncDb(db);

    // Two batches racing on the same stream — this is the boot-time
    // re-materialization (backfill) vs a live `sendEvents` write on the same
    // space. Without the shared savepoint mutex, their inline SAVEPOINT /
    // RELEASE operations interleave: A creates evt_AAA (starts the implicit
    // transaction), B creates evt_BBB (nested), A releases evt_AAA (commits,
    // destroying evt_BBB), and B fails with "no such savepoint: evt_BBB".
    const backfillEvents = [
      decoded(createRoomEvent("room-a"), 1),
      decoded(createRoomEvent("room-b"), 2),
      decoded(createRoomEvent("room-c"), 3),
    ];
    const liveEvents = [
      decoded(createMessageEvent(channelId, newUlid(), "live message"), 4),
    ];

    const results = await Promise.allSettled([
      applyBatch(asyncDb, STREAM, backfillEvents, { isBackfill: true }),
      applyBatch(asyncDb, STREAM, liveEvents, { isBackfill: false }),
    ]);

    // Both batches must succeed — no "no such savepoint" errors.
    for (const [i, result] of results.entries()) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "rejected") {
        throw new Error(`applyBatch ${i} failed: ${result.reason}`);
      }
      // The corruption mode: a failed savepoint can leave the surviving
      // call's rows half-committed and its event counted as an apply error
      // while the cursor still advances — silent data loss.
      expect(result.value.applyErrors).toBe(0);
    }

    // And both batches' rows must actually be there (a failed savepoint
    // commits the interleaved partner's partial writes and can drop rows).
    const rooms = await asyncDb
      .query("select count(*) as count from comp_room")
      .get<{ count: number }>();
    // 3 from the backfill batch + the seeded channel room.
    expect(rooms?.count).toBe(4);

    const messages = await asyncDb
      .query("select count(*) as count from entities where room = ?")
      .get<{ count: number }>(channelId);
    expect(messages?.count).toBe(1);

    // Cursor must have advanced past both batches (idx 4 is the last one).
    const cursor = await asyncDb
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(STREAM);
    expect(cursor?.materialized_to).toBe(4);
  });
});

describe("per-space split dual-write (Phase 1)", () => {
  test("applyBatch dual-writes to per-space and global DBs over the shared worker", async () => {
    // Isolated worker with an in-memory main DB; the per-space and global
    // DBs default to :memory: too (worker init derives them from the main
    // path), so no files are touched.
    const testId = Math.random().toString(36).slice(2, 8);
    process.env.EVENTS_DB_PATH = `/tmp/roomy-events-dual-${testId}.sqlite`;
    const db = openDb({ path: ":memory:", isolated: true });

    const streamDid = StreamDid.assert("did:web:dual.example");

    // Seed space + user entities and a joinedSpace edge in the monolithic DB
    // (mirrors the E2E seed helpers).
    await db.run("insert into entities (id, stream_id) values (?, ?)", [streamDid, streamDid]);
    await db.run("insert into comp_space (entity) values (?)", [streamDid]);
    await db.run("insert into entities (id, stream_id) values (?, ?)", [USER, USER]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'joinedSpace')", [USER, streamDid]);

    // Routed handles over the same worker. First access lazily backfills the
    // per-space DB from the monolithic DB (§1h) and the global DB from the
    // membership edges.
    const spaceDb = db.forSpace(streamDid);
    const globalDb = db.global();

    // Backfilled state: space DB has no rooms yet, global DB has the edge.
    const backfilledRooms = await spaceDb
      .query("select count(*) as n from comp_room")
      .get<{ n: number }>();
    expect(backfilledRooms?.n).toBe(0);
    const gEdge = await globalDb
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
      .get<{ n: number }>(USER, streamDid);
    expect(gEdge?.n).toBe(1);

    // Dual-write a batch: a createRoom event (space-routed) and a
    // space.joinSpace event (its joinedSpace edge is global-routed).
    const events: DecodedStreamEvent[] = [
      decoded(createRoomEvent("dual-room"), 0),
      {
        event: {
          $type: "space.roomy.space.joinSpace.v0",
          id: newUlid(),
        } as unknown as Event,
        idx: 1 as StreamIndex,
        user: USER,
      },
    ];
    const stats = await applyBatch(
      db,
      streamDid,
      events,
      { isBackfill: true },
      spaceDb,
      globalDb,
    );
    expect(stats.applyErrors).toBe(0);
    expect(stats.materializerErrors).toBe(0);

    // Monolithic DB has both.
    const mainRooms = await db
      .query("select count(*) as n from comp_room")
      .get<{ n: number }>();
    expect(mainRooms?.n).toBe(1);

    // Space DB has the room but no joinedSpace edge (that lives in global).
    const spaceRooms = await spaceDb
      .query("select count(*) as n from comp_room")
      .get<{ n: number }>();
    expect(spaceRooms?.n).toBe(1);
    const spaceEdge = await spaceDb
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
      .get<{ n: number }>(USER, streamDid);
    expect(spaceEdge?.n).toBeUndefined();

    // Global DB has the edge, dual-written via routing.
    const gEdgeAfter = await globalDb
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
      .get<{ n: number }>(USER, streamDid);
    expect(gEdgeAfter?.n).toBe(1);

    // Cursor advanced on both DBs (each space DB is self-describing).
    const mainCursor = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(mainCursor?.materialized_to).toBe(1);
    const spaceCursor = await spaceDb
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(spaceCursor?.materialized_to).toBe(1);

    await db.close();
    delete process.env.EVENTS_DB_PATH;
  });

  test("replaying join+leave in order does not re-add a departed user", async () => {
    // This is the migration guarantee: rebuilding the global DB from the
    // event log must respect a user's decision to leave. The log holds both
    // space.joinSpace and space.leaveSpace in order, and replay applies them
    // in idx order, so a join that was later undone must NOT leave a
    // joinedSpace edge behind (which would re-add the user to getSpaces).
    const testId = Math.random().toString(36).slice(2, 8);
    process.env.EVENTS_DB_PATH = `/tmp/roomy-events-replay-${testId}.sqlite`;
    const db = openDb({ path: ":memory:", isolated: true });

    const streamDid = StreamDid.assert("did:web:replay.example");
    await db.run("insert into entities (id, stream_id) values (?, ?)", [streamDid, streamDid]);
    await db.run("insert into comp_space (entity) values (?)", [streamDid]);

    const spaceDb = db.forSpace(streamDid);
    const globalDb = db.global();

    const joined = async (): Promise<number> =>
      (await globalDb
        .query("select count(*) as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
        .get<{ n: number }>(USER, streamDid))?.n ?? 0;
    const left = async (): Promise<number> =>
      (await globalDb
        .query("select count(*) as n from edges where head = ? and tail = ? and label = 'leftSpace'")
        .get<{ n: number }>(USER, streamDid))?.n ?? 0;

    const evJoin = {
      event: { $type: "space.roomy.space.joinSpace.v0", id: newUlid() } as unknown as Event,
      idx: 0 as StreamIndex,
      user: USER,
    };
    const evLeave = {
      event: { $type: "space.roomy.space.leaveSpace.v0", id: newUlid() } as unknown as Event,
      idx: 1 as StreamIndex,
      user: USER,
    };

    // Replay the log in order, exactly as reMaterializeFromLocalEvents does.
    await applyBatch(db, streamDid, [evJoin], { isBackfill: true }, spaceDb, globalDb);
    expect(await joined()).toBe(1);
    expect(await left()).toBe(0);

    await applyBatch(db, streamDid, [evLeave], { isBackfill: true }, spaceDb, globalDb);
    expect(await joined()).toBe(0); // leave undid the join
    expect(await left()).toBe(1);   // leave history preserved

    // The departed user must NOT appear as a member after replay.
    expect(await joined()).toBe(0);

    await db.close();
    delete process.env.EVENTS_DB_PATH;
  });

  test("per-space backfill handles a space with many referenced entities (chunked IN)", async () => {
    // A large space references > SQLite's bind-parameter limit via edges /
    // reactions. The backfill must chunk the `id IN (...)` so it doesn't blow
    // up with "query expected N values, received M". Regression for a 500
    // observed on a ~135k-entity production space.
    const testId = Math.random().toString(36).slice(2, 8);
    process.env.EVENTS_DB_PATH = `/tmp/roomy-events-chunk-${testId}.sqlite`;
    const db = openDb({ path: ":memory:", isolated: true });

    const streamDid = StreamDid.assert("did:web:chunk.example");
    await db.run("insert into entities (id, stream_id) values (?, ?)", [streamDid, streamDid]);
    await db.run("insert into comp_space (entity) values (?)", [streamDid]);
    // USER is the edge tail — must exist for the FK in the mono DB.
    await db.run("insert into entities (id, stream_id) values (?, ?)", [USER, USER]);

    // Many entities that belong to the space.
    const N = 2000;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `msg-${i}`;
      ids.push(id);
      await db.run("insert into entities (id, stream_id) values (?, ?)", [id, streamDid]);
    }
    // Edge endpoints force the referencedIds set to grow past the chunk size.
    for (const id of ids) {
      await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, USER]);
    }

    // Accessing forSpace triggers the lazy backfill. Must not throw.
    const spaceDb = db.forSpace(streamDid);
    const copied = await spaceDb
      .query("select count(*) as n from entities")
      .get<{ n: number }>();
    // Space root + USER (edge tail, pulled in via referencedIds) + all msgs.
    expect(copied?.n).toBe(N + 2);
    const edges = await spaceDb
      .query("select count(*) as n from edges where label = 'author'")
      .get<{ n: number }>();
    expect(edges?.n).toBe(N);

    await db.close();
    delete process.env.EVENTS_DB_PATH;
  });
});
