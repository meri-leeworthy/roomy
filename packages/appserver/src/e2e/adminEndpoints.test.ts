/**
 * Admin endpoint coverage. These require an admin DID (set via the test-only
 * _setAdminDids). connectSpace/listSpaces/getDashboardStats read materialized
 * data, so a space is set up through the real write path first.
 *
 * Run: bun test --cwd packages/appserver src/e2e/adminEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  startAppserver,
  materializeSpace,
  type E2eContext,
} from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";
import { flushSearchQueue } from "../search/indexer.ts";
import { _setQdrantClientForTest, _resetQdrantClient, type QdrantClientLike } from "../search/qdrantSearch.ts";
import { newUlid } from "@roomy-space/sdk";

/** Minimal fake Qdrant so the backfill sweep can index in-memory. */
class FakeQdrant implements QdrantClientLike {
  points: Array<{ id: string; vector: unknown; payload: Record<string, unknown> }> = [];
  async collectionExists(_n: string): Promise<{ exists: boolean }> { return { exists: true }; }
  async createCollection(_n: string, _a: unknown): Promise<unknown> { return {}; }
  async createPayloadIndex(_n: string, _a: unknown): Promise<unknown> { return {}; }
  async upsert(_n: string, args: unknown): Promise<unknown> {
    const { points } = args as { points: Array<{ id: string; vector: unknown; payload: Record<string, unknown> }> };
    for (const p of points) {
      const i = this.points.findIndex((q) => q.id === p.id);
      if (i >= 0) this.points[i] = p; else this.points.push(p);
    }
    return {};
  }
  async delete(_n: string, _a: unknown): Promise<unknown> { return {}; }
  async query(_n: string, _a: unknown): Promise<{ points: Array<{ id: unknown; score: number; payload?: Record<string, unknown> | null }> }> { return { points: [] }; }
  async count(_n: string, _a?: unknown): Promise<{ count: number }> { return { count: this.points.length }; }
}

const USER = "did:plc:e2e-user";
const ADMIN = "did:plc:e2e-admin";
const SPACE = "did:web:space-e2e.example";

_setAdminDids([ADMIN]);

/** Typed handle to the e2e appserver's routed global DB. */
interface GlobalDbHandle {
  query(sql: string): { get<T>(...p: unknown[]): Promise<T | null> };
  run(sql: string, ...p: unknown[]): Promise<{ changes: number }>;
}
function globalDbOf(ctx: E2eContext): GlobalDbHandle {
  return (ctx.db as unknown as { global(): GlobalDbHandle }).global();
}

describe("space.roomy.admin.connectSpace", () => {
  test("returns the materialized space's rooms", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.some((r: { id: string }) => r.id === roomId)).toBe(true);
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(403);
  });
});

describe("space.roomy.admin.listSpaces", () => {
  test("lists the materialized space", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.spaces)).toBe(true);
    expect(body.spaces.some((s: { did: string }) => s.did === SPACE)).toBe(true);
  });
});

describe("space.roomy.admin.getDashboardStats", () => {
  test("returns activity + system stats", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getDashboardStats`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("activity");
    expect(body).toHaveProperty("system");
  });
});

describe("space.roomy.admin.getFlags / setFlag / clearFlag", () => {
  test("round-trips a registered flag", async () => {
    const ctx = await startAppserver();

    const set = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.setFlag`,
      { method: "POST", body: JSON.stringify({ flag: "search", all: true }) },
    );
    expect(set.status).toBe(200);

    const get = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getFlags`,
    );
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(Array.isArray(body.flags)).toBe(true);

    const clear = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.clearFlag`,
      { method: "POST", body: JSON.stringify({ flag: "search", all: true }) },
    );
    expect(clear.status).toBe(200);
  });
});

describe("space.roomy.admin.resetSearchBackfill", () => {
  test("clears every search_backfill_cursor row", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });
    await flushSearchQueue();

    // Seed a cursor row (as the backfill sweeper would after a cycle).
    const globalDb = globalDbOf(ctx);
    await globalDb.run(
      "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
      [SPACE, "01CURSOR000000000000000000", Date.now()],
    );

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.resetSearchBackfill`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(1);

    const remaining = await globalDb
      .query("select count(*) as n from search_backfill_cursor")
      .get<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.resetSearchBackfill`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(403);
  });
});

describe("space.roomy.admin.runSearchBackfill", () => {
  test("clears cursors, tight-loops a full corpus re-index, and reports the delta", async () => {
    const ctx = await startAppserver();
    // One dense space with messages via the real write path.
    await materializeSpace(ctx, SPACE, USER, {
      messageText: "lorem alpha delta gamma omega",
    });
    await flushSearchQueue();

    // Seed a cursor so a pre-existing one is reset too.
    const globalDb = globalDbOf(ctx);
    await globalDb.run(
      "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
      [SPACE, "01CURSOR000000000000000000", Date.now()],
    );

    // Inject a fake Qdrant so the synchronous sweep actually indexes in-memory.
    const fake = new FakeQdrant();
    _setQdrantClientForTest(fake);
    try {
      const res = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.runSearchBackfill`,
        { method: "POST", body: "{}" },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // The cursor was reset and the sweep re-indexed the (now cursor-less)
      // space's messages — at least the new content makes a measurable delta.
      expect(body.deltaBackfilled).toBeGreaterThan(0);
      expect(typeof body.backfilled).toBe("number");
      expect(body.failed).toBe(0);
      expect(body.dbBackoffActive).toBe(false);

      // All cursors were cleared and the space re-stamped with a progress cursor.
      const remaining = await globalDb
        .query("select count(*) as n from search_backfill_cursor where space_did = ?")
        .get<{ n: number }>(SPACE);
      expect(remaining?.n).toBe(1);
    } finally {
      _resetQdrantClient();
    }
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.runSearchBackfill`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(403);
  });
});

describe("space.roomy.admin.reindexSpace", () => {
  test("re-indexes a space whose cursor advanced past unindexed messages", async () => {
    const ctx = await startAppserver();
    const { messageId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "the quick brown fox",
    });
    await flushSearchQueue();

    // Simulate the Sep 2026 hole: the message is materialised but absent from
    // Qdrant, and the cursor has advanced PAST it — so the background sweeper
    // reads the space as caught up and never revisits it.
    const fake = new FakeQdrant();
    _setQdrantClientForTest(fake);
    const globalDb = globalDbOf(ctx);
    await globalDb.run(
      "delete from search_backfill_cursor where space_did = ?",
      [SPACE],
    );
    await globalDb.run(
      "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
      [SPACE, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", Date.now()],
    );
    expect(fake.points.length).toBe(0);

    try {
      const res = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
        { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spaceId).toBe(SPACE);
      expect(body.indexed).toBeGreaterThan(0);
      // A single message is a partial batch → the space was walked to its end.
      expect(body.drained).toBe(true);
      expect(body.failed).toBe(0);
      expect(body.cycles).toBe(1);

      // The skipped message is back in the index.
      const ids = new Set(
        fake.points.map((p) => p.payload.messageId as string),
      );
      expect(ids.has(messageId)).toBe(true);
    } finally {
      _resetQdrantClient();
    }
  });

  test(
    "drains a space larger than one sweep batch, indexing every message",
    // 250 messages = 3 sweep cycles at SWEEP_BATCH=100. This is the shape of
    // the real repair: prod spaces hold thousands of messages in the skip
    // window, so a single-cycle implementation would silently stop early.
    async () => {
      const ctx = await startAppserver();
      const { roomId } = await materializeSpace(ctx, SPACE, USER, {
        messageText: "message number 0",
      });
      // 249 more → 250 total. ≤50 events per request (MAX_BATCH_SIZE) to
      // avoid the IP rate limiter.
      for (let batch = 0; batch < 5; batch++) {
        const events = [];
        for (let i = batch * 50 + 1; i < Math.min((batch + 1) * 50 + 1, 250); i++) {
          events.push({
            id: newUlid(),
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from(`message number ${i}`).toString("base64") },
            },
            extensions: {},
          });
        }
        const res = await ctx.authedFetch(USER)(
          `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
          { method: "POST", body: JSON.stringify({ spaceId: SPACE, events }) },
        );
        if (res.status !== 200) throw new Error(`sendEvents failed ${res.status}`);
      }
      await flushSearchQueue();

      // Start from an empty index with a cursor past the whole corpus —
      // exactly the prod hole.
      const fake = new FakeQdrant();
      _setQdrantClientForTest(fake);
      const globalDb = globalDbOf(ctx);
      await globalDb.run("delete from search_backfill_cursor where space_did = ?", [SPACE]);
      await globalDb.run(
        "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
        [SPACE, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", Date.now()],
      );
      expect(fake.points.length).toBe(0);

      try {
        const res = await ctx.authedFetch(ADMIN)(
          `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
          { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.indexed).toBe(250);
        expect(body.drained).toBe(true);
        expect(body.failed).toBe(0);
        // 100+100+50 → 3 cycles; a >3 count would mean the walk stalled or re-ran.
        expect(body.cycles).toBe(3);
        expect(fake.points.length).toBe(250);
      } finally {
        _resetQdrantClient();
      }
    },
    // Boots an appserver and pushes 250 messages through the real HTTP write
    // path. Fast locally, but CI runners under full-suite parallel load blow
    // the 5s default (observed: "sendEvents failed 500" then a 5s timeout).
    { timeout: 30000 },
  );

  test("does not report a stale per-row error on a clean run", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });
    await flushSearchQueue();

    const globalDb = globalDbOf(ctx);
    await globalDb.run("delete from search_backfill_cursor where space_did = ?", [SPACE]);
    await globalDb.run(
      "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
      [SPACE, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", Date.now()],
    );

    // First run fails (storage full), leaving a per-row error recorded.
    _setQdrantClientForTest(new (class extends FakeQdrant {
      override async upsert(): Promise<unknown> {
        throw new Error("Insufficient Storage");
      }
    })());
    try {
      const bad = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
        { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
      );
      expect((await bad.json()).lastRowError).toContain("storage full");

      // Capacity restored: the SAME process must not keep reporting the old
      // failure next to `failed: 0` — that reads as an active outage.
      _setQdrantClientForTest(new FakeQdrant());
      await globalDb.run("delete from search_backfill_cursor where space_did = ?", [SPACE]);
      const good = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
        { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
      );
      expect(good.status).toBe(200);
      const body = await good.json();
      expect(body.failed).toBe(0);
      expect(body.lastRowError).toBeNull();
    } finally {
      _resetQdrantClient();
    }
  });

  test("does not touch another space's backfill cursor", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });
    await flushSearchQueue();

    const OTHER = "did:web:other-space.example";
    const OTHER_CURSOR = "01OTHERCURSOR000000000000";
    const globalDb = globalDbOf(ctx);
    await globalDb.run(
      "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
      [OTHER, OTHER_CURSOR, Date.now()],
    );

    const fake = new FakeQdrant();
    _setQdrantClientForTest(fake);
    try {
      const res = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
        { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
      );
      expect(res.status).toBe(200);

      // The whole point of a PER-SPACE re-index: other spaces are untouched,
      // unlike resetSearchBackfill which clears every cursor.
      const otherRow = await globalDb
        .query("select cursor from search_backfill_cursor where space_did = ?")
        .get<{ cursor: string }>(OTHER);
      expect(otherRow?.cursor).toBe(OTHER_CURSOR);
    } finally {
      _resetQdrantClient();
    }
  });

  test("reports why a row failed instead of a bare count", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });
    await flushSearchQueue();

    // Every upsert fails, so the space never drains. The response must say
    // WHY — a bare `failed: N` with `lastRowError: null` leaves an operator
    // with no signal beyond the Loki stream (the gap that made the prod
    // wedge undiagnosable from the API).
    _setQdrantClientForTest(new (class extends FakeQdrant {
      override async upsert(): Promise<unknown> {
        throw new Error("simulated Qdrant write failure");
      }
    })());
    const globalDb = globalDbOf(ctx);
    await globalDb.run("delete from search_backfill_cursor where space_did = ?", [SPACE]);
    await globalDb.run(
      "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
      [SPACE, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", Date.now()],
    );

    try {
      const res = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
        { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.failed).toBeGreaterThan(0);
      // `drained` means "walked to the end of the row set", not "all indexed"
      // — a single-row space is a partial batch even when that row fails.
      expect(body.drained).toBe(true);
      expect(typeof body.lastRowError).toBe("string");
      expect(body.lastRowError).toContain("simulated Qdrant write failure");
    } finally {
      _resetQdrantClient();
    }
  });

  test("unknown space → 404", async () => {
    const ctx = await startAppserver();
    _setQdrantClientForTest(new FakeQdrant());
    try {
      const res = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
        {
          method: "POST",
          body: JSON.stringify({ spaceId: "did:web:never-seen.example" }),
        },
      );
      expect(res.status).toBe(404);
    } finally {
      _resetQdrantClient();
    }
  });

  test("missing spaceId → 400", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(400);
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
      { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
    );
    expect(res.status).toBe(403);
  });
});
