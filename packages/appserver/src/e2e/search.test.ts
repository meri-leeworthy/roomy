/**
 * E2E coverage for space.roomy.search.messages (Qdrant-backed, Phase 2).
 *
 * These tests materialize a space through the REAL write path
 * (`space.roomy.space.sendEvents` → applyBatch → per-space DB + search
 * enqueue), with an in-memory FAKE Qdrant injected via the client
 * singleton — hermetic, no network, no staging dependency. After each send,
 * the search queue is flushed so results are deterministic.
 *
 * Covered: hit finding, read-access filtering, min-query-length validation,
 * cursor pagination, empty results, and search-unavailable (Qdrant disabled).
 *
 * Run: bun test --cwd packages/appserver src/e2e/search.test.ts
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  materializeSpace,
  spaceDb,
  type E2eContext,
} from "./helpers.ts";
import { _setQdrantClientForTest, _resetQdrantClient, type QdrantClientLike } from "../search/qdrantSearch.ts";
import { flushSearchQueue } from "../search/indexer.ts";
import type { SparseVector } from "../search/bm25.ts";

const USER = "did:plc:e2e-user";
const VISITOR = "did:plc:e2e-visitor";
const SPACE = "did:web:search-e2e.example";

function get(ctx: E2eContext, path: string) {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/${path}`);
}

// ─── In-memory fake Qdrant ───────────────────────────────────────────────

interface FakePoint {
  id: string;
  vector: { [name: string]: SparseVector };
  payload: Record<string, unknown>;
}

/** Minimal Qdrant: filtered sparse scoring, pagination, collection mgmt. */
class FakeQdrant implements QdrantClientLike {
  exists = true;
  points: FakePoint[] = [];

  async collectionExists(_name: string): Promise<{ exists: boolean }> {
    return { exists: this.exists };
  }
  async createCollection(_name: string, _args: unknown): Promise<unknown> {
    this.exists = true;
    return {};
  }
  async createPayloadIndex(_name: string, _args: unknown): Promise<unknown> {
    return {};
  }
  async upsert(_name: string, args: unknown): Promise<unknown> {
    const { points } = args as {
      points: Array<{
        id: string;
        vector: Record<string, SparseVector>;
        payload: Record<string, unknown>;
      }>;
    };
    for (const p of points) {
      const idx = this.points.findIndex((q) => q.id === p.id);
      const point = { id: p.id, vector: p.vector, payload: p.payload };
      if (idx >= 0) this.points[idx] = point;
      else this.points.push(point);
    }
    return {};
  }
  async delete(_name: string, args: unknown): Promise<unknown> {
    const { points } = args as { points: string[] };
    this.points = this.points.filter((p) => !points.includes(p.id));
    return {};
  }
  async query(
    _name: string,
    args: unknown,
  ): Promise<{
    points: Array<{ id: unknown; score: number; payload?: Record<string, unknown> | null }>;
  }> {
    const { query, using, filter, limit, offset } = args as {
      query: SparseVector;
      using: string;
      filter?: { must?: Array<{ key: string; match: { any?: string[] } }> };
      limit: number;
      offset: number;
    };
    if (using !== "bm25") throw new Error("wrong vector name");

    const spaceDids = new Set<string>();
    for (const cond of filter?.must ?? []) {
      if (cond.key === "spaceDid" && cond.match?.any) {
        for (const v of cond.match.any) spaceDids.add(v);
      }
    }

    const scored: Array<{ id: string; score: number; payload: Record<string, unknown> }> = [];
    const qm = new Map<number, number>();
    for (let i = 0; i < query.indices.length; i++) {
      qm.set(query.indices[i]!, query.values[i]!);
    }
    for (const p of this.points) {
      if (spaceDids.size > 0 && !spaceDids.has(p.payload.spaceDid as string)) continue;
      const doc = p.vector[using];
      if (!doc) continue;
      let score = 0;
      for (let i = 0; i < doc.indices.length; i++) {
        const qv = qm.get(doc.indices[i]!);
        if (qv !== undefined) score += qv * doc.values[i]!;
      }
      if (score > 0) scored.push({ id: p.id, score, payload: p.payload });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const page = scored.slice(offset, offset + limit);
    return { points: page.map((p) => ({ id: p.id, score: p.score, payload: p.payload })) };
  }
  async count(_name: string, args?: unknown): Promise<{ count: number }> {
    const filter = (args as { filter?: { must?: Array<{ key: string; match: { value?: string } }> } })?.filter;
    let count = this.points.length;
    if (filter?.must) {
      for (const cond of filter.must) {
        if (cond.key === "spaceDid" && cond.match?.value) {
          count = this.points.filter((p) => p.payload.spaceDid === cond.match!.value).length;
        }
      }
    }
    return { count };
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────

async function sendMessage(
  ctx: E2eContext,
  roomId: string,
  text: string,
): Promise<string> {
  const messageId = newUlid();
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: messageId,
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from(text).toString("base64") },
            },
            extensions: {},
          },
        ],
      }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`sendMessage failed ${res.status}: ${await res.text()}`);
  }
  await flushSearchQueue();
  return messageId;
}

async function sendRoom(ctx: E2eContext, name: string): Promise<string> {
  const roomId = newUlid();
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: roomId,
            $type: "space.roomy.room.createRoom.v0",
            kind: "space.roomy.channel",
            name,
          },
        ],
      }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`createRoom failed ${res.status}: ${await res.text()}`);
  }
  return roomId;
}

async function newAppWithQdrant(): Promise<{ ctx: E2eContext; fake: FakeQdrant }> {
  const ctx = await startAppserver();
  const fake = new FakeQdrant();
  _setQdrantClientForTest(fake);
  return { ctx, fake };
}

describe("space.roomy.search.messages (Qdrant)", () => {
  beforeEach(() => {
    _resetQdrantClient();
  });

  test("search finds a materialized message", async () => {
    const { ctx } = await newAppWithQdrant();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });
    await flushSearchQueue();

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=brown`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages[0].content).toContain("brown");
  });

  test("search respects room read access", async () => {
    const { ctx } = await newAppWithQdrant();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "open forum discussion",
    });
    await sendMessage(ctx, roomId, "another open message");

    // A second, restricted room (default_access = none) with a message.
    const secretRoom = await sendRoom(ctx, "secret");
    await sendMessage(ctx, secretRoom, "secret pineapple recipe");
    await spaceDb(ctx.db, SPACE).run(
      "update comp_room set default_access = 'none' where entity = ?",
      [secretRoom],
    );

    // Admin (USER) sees everything.
    const adminRes = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=pineapple`);
    expect(adminRes.status).toBe(200);
    const adminBody = await adminRes.json();
    expect(adminBody.messages.some((m: { content: string }) => m.content.includes("secret"))).toBe(true);

    // A public-join visitor sees the open room but not the restricted one.
    const visitorRes = await ctx.authedFetch(VISITOR)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.messages?spaceId=${SPACE}&q=pineapple`,
    );
    expect(visitorRes.status).toBe(200);
    const visitorBody = await visitorRes.json();
    expect(visitorBody.messages.some((m: { content: string }) => m.content.includes("secret"))).toBe(false);
    const openRes = await ctx.authedFetch(VISITOR)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.messages?spaceId=${SPACE}&q=forum`,
    );
    const openBody = await openRes.json();
    expect(openBody.messages.length).toBeGreaterThanOrEqual(1);
  });

  test("rejects queries shorter than 3 characters", async () => {
    const { ctx } = await newAppWithQdrant();
    await materializeSpace(ctx, SPACE, USER, { messageText: "hello world" });

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=ab`);
    expect(res.status).toBe(400);
  });

  test("paginates with a cursor", async () => {
    const { ctx } = await newAppWithQdrant();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "alpha page test one",
    });
    await sendMessage(ctx, roomId, "alpha page test two");
    await sendMessage(ctx, roomId, "alpha page test three");

    const page1 = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=page&limit=2`);
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.messages).toHaveLength(2);
    expect(typeof body1.cursor).toBe("string");

    const page2 = await get(
      ctx,
      `space.roomy.search.messages?spaceId=${SPACE}&q=page&limit=2&cursor=${encodeURIComponent(body1.cursor)}`,
    );
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.messages).toHaveLength(1);
    expect(body2.cursor).toBeUndefined();

    const ids = [...body1.messages.map((m: { id: string }) => m.id), body2.messages[0].id];
    expect(new Set(ids).size).toBe(3);
  });

  test("empty result set returns 200 with no messages", async () => {
    const { ctx } = await newAppWithQdrant();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=zzzznotfound`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  test("returns 503 when Qdrant is not configured", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "hello world" });
    await flushSearchQueue();

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=hello`);
    expect(res.status).toBe(503);
  });
});
