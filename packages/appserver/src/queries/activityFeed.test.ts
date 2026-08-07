/**
 * Tests for the activity feed query helper.
 *
 * Covers:
 *   - Basic feed assembly (messages, authors, unread counts)
 *   - Cursor pagination (ties, has-more detection)
 *   - Space filter vs. all-joined-spaces
 *   - Deleted room exclusion
 *   - Missing/deleted messages gracefully skipped
 *   - Empty feed for empty DB
 *
 * Phase 2 (per-space read cutover): `selectActivityFeed` fans out to per-space
 * DBs. Like the joinedSpaces test, we seed the MONOLITHIC DB directly (it is
 * the dual-write source of truth), then trigger lazy backfill of the per-space
 * and global DBs via `openSpaceDb`/`openGlobalDb` before querying.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { closeDb, openDb, openGlobalDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { selectActivityFeed, type ActivityFeedScope } from "./activityFeed.ts";

const SPACE = "did:web:space.example";
const OTHER_SPACE = "did:web:other-space.example";
const USER = "did:plc:alice";

const CHANNEL = "01CHANNEL00000000000000000";
const THREAD_A = "01THREADA00000000000000000".slice(0, 26);
const THREAD_B = "01THREADB00000000000000000".slice(0, 26);
const THREAD_C = "01THREADC00000000000000000".slice(0, 26);

let msgCounter = 0;

/**
 * Generate a ULID that encodes a specific timestamp.
 * First 10 chars = Crockford base32 timestamp, next 16 = deterministic suffix.
 */
function ulidForTimestamp(ts: number): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = ts;
  let encoded = "";
  for (let i = 0; i < 10; i++) {
    encoded = chars[remaining % 32]! + encoded;
    remaining = Math.floor(remaining / 32);
  }
  const suffix = String(msgCounter++).padStart(16, "0").slice(0, 16);
  return encoded + suffix;
}

/**
 * Seed the worker-backed DBs for the Phase 2 fan-out read path:
 *   - the monolithic DB is seeded directly (it is the dual-write source)
 *   - the global DB and per-space DBs are lazily backfilled from it on first
 *     access (openGlobalDb / openSpaceDb), mirroring production.
 */
function setup(): { mainDb: DbLike } {
  closeDb();
  // Readstate is not split — it lives on the monolithic DB. The worker's
  // readstate DB is a file by default and would persist across tests, so pin
  // it to an in-memory DB (fresh per worker) like the other derived DBs.
  process.env.READSTATE_DB_PATH = ":memory:";
  const mainDb = openDb({ path: ":memory:" });
  return { mainDb };
}

function seedSpace(db: DbLike, spaceId: string) {
  void db.run("insert into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  void db.run("insert into comp_space (entity) values (?)", [spaceId]);
  void db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
    spaceId,
    spaceId === SPACE ? "Test Space" : "Other Space",
    null,
  ]);
}

function seedUser(db: DbLike, did: string) {
  void db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  void db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
    did,
    did.split(":").pop() ?? did,
    null,
  ]);
}

function seedJoinedSpace(db: DbLike, userDid: string, spaceId: string) {
  // User must exist as an entity for the FK constraint.
  void db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
    userDid,
    userDid,
  ]);
  void db.run("insert into edges (head, tail, label) values (?, ?, 'joinedSpace')", [
    userDid,
    spaceId,
  ]);
}

function seedRoom(
  db: DbLike,
  roomId: string,
  spaceId: string,
  label: string,
  name: string | null,
  parentChannelId: string | null = null,
  parentChannelName: string | null = null,
) {
  void db.run("insert into entities (id, stream_id) values (?, ?)", [roomId, spaceId]);
  void db.run(
    "insert into comp_room (entity, label, default_access) values (?, ?, 'readwrite')",
    [roomId, label],
  );
  if (name !== null) {
    void db.run("insert into comp_info (entity, name) values (?, ?)", [roomId, name]);
  }
  if (parentChannelId !== null) {
    void db.run(
      `insert into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
      [parentChannelId, roomId],
    );
  }
}

function postMessage(
  db: DbLike,
  roomId: string,
  spaceId: string,
  authorDid: string,
  ts: number,
  content: string = "hello",
): string {
  const msgId = ulidForTimestamp(ts);
  void db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    msgId,
    spaceId,
    roomId,
  ]);
  void db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
    [msgId, Buffer.from(content), msgId, ts],
  );
  void db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    msgId,
    authorDid,
  ]);
  return msgId;
}

function seedActivityItem(
  db: DbLike,
  roomId: string,
  spaceId: string,
  isThread: number,
  lastActivityAt: number,
  messageIds: string[],
  roomName: string | null = null,
  spaceName: string | null = null,
  spaceAvatar: string | null = null,
  parentChannelId: string | null = null,
  parentChannelName: string | null = null,
) {
  void db.run(
    `insert into activity_item
       (room_id, space_id, is_thread, parent_channel_id, parent_channel_name,
        last_activity_at, recent_message_ids,
        room_name, space_name, space_avatar,
        created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))`,
    [
      roomId,
      spaceId,
      isThread,
      parentChannelId,
      parentChannelName,
      lastActivityAt,
      JSON.stringify(messageIds),
      roomName,
      spaceName,
      spaceAvatar,
    ],
  );
}

function seedUnreadCount(
  db: DbLike,
  userDid: string,
  roomId: string,
  count: number,
) {
  void db.run(
    "insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)",
    [userDid, roomId, "idx-0", count],
  );
}

/** Trigger lazy backfill of the per-space + global DBs from the monolithic DB. */
function backfill(spaceDids: string[]) {
  for (const did of spaceDids) openSpaceDb(did);
  openGlobalDb();
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("selectActivityFeed", () => {
  describe("basic feed assembly", () => {
    test("returns feed items with messages and authors", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const msgId = postMessage(mainDb, CHANNEL, SPACE, USER, ts, "Hello world");
      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msgId], "general", "Test Space");
      seedUnreadCount(mainDb, USER, CHANNEL, 3);
      backfill([SPACE]);

      const { feed, cursor } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.threadId).toBe(CHANNEL);
      expect(feed[0]!.threadName).toBe("general");
      expect(feed[0]!.spaceId).toBe(SPACE);
      expect(feed[0]!.spaceName).toBe("Test Space");
      expect(feed[0]!.activityType).toBe("message");
      expect(feed[0]!.unreadCount).toBe(3);
      expect(feed[0]!.messages).toHaveLength(1);
      expect(feed[0]!.messages[0]!.content).toBe("Hello world");
      expect(feed[0]!.messages[0]!.author.did).toBe(USER);
      expect(feed[0]!.lastActivityAt).toBe(new Date(ts).toISOString());
      expect(cursor).toBeNull();
    });

    test("includes parent channel info for thread items", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, SPACE, "space.roomy.thread", "My Thread", CHANNEL, "general");

      const ts = 1_717_536_000_000;
      const msgId = postMessage(mainDb, THREAD_A, SPACE, USER, ts);
      seedActivityItem(
        mainDb, THREAD_A, SPACE, 1, ts, [msgId],
        "My Thread", "Test Space", null, CHANNEL, "general",
      );
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.channelId).toBe(CHANNEL);
      expect(feed[0]!.channelName).toBe("general");
    });

    test("returns empty feed when no activity exists", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      backfill([SPACE]);

      const { feed, cursor } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(0);
      expect(cursor).toBeNull();
    });
  });

  describe("cursor pagination", () => {
    test("returns cursor when more pages exist", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);

      // Two rooms with different timestamps.
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, SPACE, "space.roomy.thread", "Thread A");

      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_000_001;
      const msg1 = postMessage(mainDb, CHANNEL, SPACE, USER, ts1);
      const msg2 = postMessage(mainDb, THREAD_A, SPACE, USER, ts2);

      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts1, [msg1], "general", "Test Space");
      seedActivityItem(mainDb, THREAD_A, SPACE, 1, ts2, [msg2], "Thread A", "Test Space");
      backfill([SPACE]);

      // Limit 1 → should return 1 item + cursor.
      const { feed, cursor } = await selectActivityFeed(openDb(), USER, {
        limit: 1,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      // Newest first: THREAD_A (ts2) should be first.
      expect(feed[0]!.threadId).toBe(THREAD_A);
      expect(cursor).toBe(`${ts2}::${THREAD_A}`);
    });

    test("cursor pagination returns the next page", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);

      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, SPACE, "space.roomy.thread", "Thread A");

      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_000_001;
      const msg1 = postMessage(mainDb, CHANNEL, SPACE, USER, ts1);
      const msg2 = postMessage(mainDb, THREAD_A, SPACE, USER, ts2);

      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts1, [msg1], "general", "Test Space");
      seedActivityItem(mainDb, THREAD_A, SPACE, 1, ts2, [msg2], "Thread A", "Test Space");
      backfill([SPACE]);

      // Page 1: limit 1.
      const page1 = await selectActivityFeed(openDb(), USER, {
        limit: 1,
        cursor: null,
      });
      expect(page1.feed).toHaveLength(1);
      expect(page1.feed[0]!.threadId).toBe(THREAD_A);
      expect(page1.cursor).not.toBeNull();

      // Page 2: use cursor from page 1.
      const page2 = await selectActivityFeed(openDb(), USER, {
        limit: 1,
        cursor: page1.cursor,
      });
      expect(page2.feed).toHaveLength(1);
      expect(page2.feed[0]!.threadId).toBe(CHANNEL);
      expect(page2.cursor).toBeNull();
    });

    test("handles ties (same last_activity_at) correctly", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);

      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, SPACE, "space.roomy.thread", "Thread A");

      const ts = 1_717_536_000_000; // same timestamp
      const msg1 = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      const msg2 = postMessage(mainDb, THREAD_A, SPACE, USER, ts);

      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msg1], "general", "Test Space");
      seedActivityItem(mainDb, THREAD_A, SPACE, 1, ts, [msg2], "Thread A", "Test Space");
      backfill([SPACE]);

      // Limit 1 → should return one item with a cursor.
      const page1 = await selectActivityFeed(openDb(), USER, {
        limit: 1,
        cursor: null,
      });
      expect(page1.feed).toHaveLength(1);
      expect(page1.cursor).not.toBeNull();

      // Page 2 should return the other room.
      const page2 = await selectActivityFeed(openDb(), USER, {
        limit: 1,
        cursor: page1.cursor,
      });
      expect(page2.feed).toHaveLength(1);
      expect(page2.feed[0]!.threadId).not.toBe(page1.feed[0]!.threadId);
      expect(page2.cursor).toBeNull();
    });
  });

  describe("space filter", () => {
    test("filters to a single space when spaceId is provided", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedSpace(mainDb, OTHER_SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedJoinedSpace(mainDb, USER, OTHER_SPACE);

      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, OTHER_SPACE, "space.roomy.thread", "Other Thread");

      const ts = 1_717_536_000_000;
      const msg1 = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      const msg2 = postMessage(mainDb, THREAD_A, OTHER_SPACE, USER, ts);

      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msg1], "general", "Test Space");
      seedActivityItem(mainDb, THREAD_A, OTHER_SPACE, 1, ts, [msg2], "Other Thread", "Other Space");
      backfill([SPACE, OTHER_SPACE]);

      // Filter to SPACE only.
      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
        spaceId: SPACE,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.spaceId).toBe(SPACE);
    });

    test("aggregates across all joined spaces when no spaceId", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedSpace(mainDb, OTHER_SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedJoinedSpace(mainDb, USER, OTHER_SPACE);

      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, OTHER_SPACE, "space.roomy.thread", "Other Thread");

      const ts = 1_717_536_000_000;
      const msg1 = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      const msg2 = postMessage(mainDb, THREAD_A, OTHER_SPACE, USER, ts);

      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msg1], "general", "Test Space");
      seedActivityItem(mainDb, THREAD_A, OTHER_SPACE, 1, ts, [msg2], "Other Thread", "Other Space");
      backfill([SPACE, OTHER_SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(2);
    });

    test("excludes spaces the user has not joined", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedSpace(mainDb, OTHER_SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      // Not joined OTHER_SPACE

      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, OTHER_SPACE, "space.roomy.thread", "Other Thread");

      const ts = 1_717_536_000_000;
      const msg1 = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      const msg2 = postMessage(mainDb, THREAD_A, OTHER_SPACE, USER, ts);

      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msg1], "general", "Test Space");
      seedActivityItem(mainDb, THREAD_A, OTHER_SPACE, 1, ts, [msg2], "Other Thread", "Other Space");
      backfill([SPACE, OTHER_SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.spaceId).toBe(SPACE);
    });
  });

  describe("deleted room exclusion", () => {
    test("excludes rooms marked as deleted", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);

      // Room with deleted=1
      void mainDb.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
      void mainDb.run(
        "insert into comp_room (entity, label, default_access, deleted) values (?, 'space.roomy.channel', 'readwrite', 1)",
        [CHANNEL],
      );

      const ts = 1_717_536_000_000;
      const msgId = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msgId], "deleted-room", "Test Space");
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(0);
    });

    test("includes rooms with deleted=0 or null", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);

      // Room with deleted=0
      void mainDb.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
      void mainDb.run(
        "insert into comp_room (entity, label, default_access, deleted) values (?, 'space.roomy.channel', 'readwrite', 0)",
        [CHANNEL],
      );

      const ts = 1_717_536_000_000;
      const msgId = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msgId], "active-room", "Test Space");
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
    });
  });

  describe("message handling", () => {
    test("skips message IDs that no longer exist (deleted messages)", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const msgId = postMessage(mainDb, CHANNEL, SPACE, USER, ts, "I exist");

      // Store a second message ID that doesn't exist in entities.
      const ghostId = "01GHOST00000000000000000000";
      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msgId, ghostId], "general", "Test Space");
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.messages).toHaveLength(1);
      expect(feed[0]!.messages[0]!.id).toBe(msgId);
    });

    test("returns empty messages array when all message IDs are gone", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const ghostId = "01GHOST00000000000000000000";
      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [ghostId], "general", "Test Space");
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.messages).toHaveLength(0);
    });
  });

  describe("unread counts", () => {
    test("returns 0 for rooms with no readstate row", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const msgId = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msgId], "general", "Test Space");
      // No readstate row for this room.
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed[0]!.unreadCount).toBe(0);
    });

    test("returns correct unread counts per room", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "general");
      seedRoom(mainDb, THREAD_A, SPACE, "space.roomy.thread", "Thread A");

      const ts = 1_717_536_000_000;
      const msg1 = postMessage(mainDb, CHANNEL, SPACE, USER, ts);
      const msg2 = postMessage(mainDb, THREAD_A, SPACE, USER, ts);

      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts, [msg1], "general", "Test Space");
      seedActivityItem(mainDb, THREAD_A, SPACE, 1, ts, [msg2], "Thread A", "Test Space");
      seedUnreadCount(mainDb, USER, CHANNEL, 5);
      seedUnreadCount(mainDb, USER, THREAD_A, 2);
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      const channelItem = feed.find((f) => f.threadId === CHANNEL)!;
      const threadItem = feed.find((f) => f.threadId === THREAD_A)!;
      expect(channelItem.unreadCount).toBe(5);
      expect(threadItem.unreadCount).toBe(2);
    });
  });

  describe("ordering", () => {
    test("returns items newest-first by last_activity_at", async () => {
      const { mainDb } = setup();
      seedSpace(mainDb, SPACE);
      seedUser(mainDb, USER);
      seedJoinedSpace(mainDb, USER, SPACE);

      seedRoom(mainDb, THREAD_A, SPACE, "space.roomy.thread", "Old");
      seedRoom(mainDb, CHANNEL, SPACE, "space.roomy.channel", "New");
      seedRoom(mainDb, THREAD_B, SPACE, "space.roomy.thread", "Middle");

      const ts1 = 1_000;
      const ts2 = 3_000;
      const ts3 = 2_000;
      const msg1 = postMessage(mainDb, THREAD_A, SPACE, USER, ts1);
      const msg2 = postMessage(mainDb, CHANNEL, SPACE, USER, ts2);
      const msg3 = postMessage(mainDb, THREAD_B, SPACE, USER, ts3);

      seedActivityItem(mainDb, THREAD_A, SPACE, 1, ts1, [msg1], "Old", "Test Space");
      seedActivityItem(mainDb, CHANNEL, SPACE, 0, ts2, [msg2], "New", "Test Space");
      seedActivityItem(mainDb, THREAD_B, SPACE, 1, ts3, [msg3], "Middle", "Test Space");
      backfill([SPACE]);

      const { feed } = await selectActivityFeed(openDb(), USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(3);
      expect(feed[0]!.threadName).toBe("New");
      expect(feed[1]!.threadName).toBe("Middle");
      expect(feed[2]!.threadName).toBe("Old");
    });
  });
});

afterEach(() => {
  closeDb();
});
