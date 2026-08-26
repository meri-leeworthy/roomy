/**
 * E2E coverage for space.roomy.search.messages.
 *
 * These tests materialize a space through the REAL write path
 * (`space.roomy.space.sendEvents` → applyBatch → per-space DB + message_fts
 * index), then exercise the search endpoint: hit finding, read-access
 * filtering, min-query-length validation, and cursor pagination.
 *
 * Run: bun test --cwd packages/appserver src/e2e/search.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  materializeSpace,
  spaceDb,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:e2e-user";
const MENT = "did:plc:e2e-mention-only";
const SPACE = "did:web:search-e2e.example";

function get(ctx: E2eContext, path: string) {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/${path}`);
}

/** Create a message via the real write path and return its id. */
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
  return messageId;
}

/** Create a room through the real send path and return its id. */
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

describe("space.roomy.search.messages", () => {
  test("search finds a materialized message", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=brown`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages[0].content).toContain("brown");
  });

  test("search respects room read access", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "open forum discussion",
    });
    await sendMessage(ctx, roomId, "another open message");

    // A second, restricted room (default_access = none) with a message.
    const secretRoom = await sendRoom(ctx, "secret");
    await sendMessage(ctx, secretRoom, "secret pineapple recipe");
    await spaceDb(ctx.db as never, SPACE).run(
      "update comp_room set default_access = 'none' where entity = ?",
      [secretRoom],
    );

    // Admin (USER) sees everything.
    const adminRes = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=pineapple`);
    expect(adminRes.status).toBe(200);
    const adminBody = await adminRes.json();
    expect(adminBody.messages.some((m: { content: string }) => m.content.includes("secret"))).toBe(true);

    // A public-join visitor sees the open room but not the restricted one.
    const visitorRes = await ctx.authedFetch(MENT)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.messages?spaceId=${SPACE}&q=pineapple`,
    );
    expect(visitorRes.status).toBe(200);
    const visitorBody = await visitorRes.json();
    expect(visitorBody.messages.some((m: { content: string }) => m.content.includes("secret"))).toBe(false);
    const openRes = await ctx.authedFetch(MENT)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.messages?spaceId=${SPACE}&q=forum`,
    );
    const openBody = await openRes.json();
    expect(openBody.messages.length).toBeGreaterThanOrEqual(1);
  });

  test("rejects queries shorter than 3 characters", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "hello world" });

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=ab`);
    expect(res.status).toBe(400);
  });

  test("paginates with a cursor", async () => {
    const ctx = await startAppserver();
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
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=zzzznotfound`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });
});
