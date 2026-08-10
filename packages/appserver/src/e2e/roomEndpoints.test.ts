/**
 * Endpoint-by-endpoint e2e coverage for room/message-scoped handlers.
 *
 * Unlike the seed-directly tests, these materialize a space through the REAL
 * write path (`space.roomy.space.sendEvents` → applyBatch → per-space DB +
 * global entity_space index), then query each endpoint. This is what catches
 * regressions like room-scoped handlers 404ing because the entity→space
 * index was never populated for materialized rooms/messages.
 *
 * Run: bun test --cwd packages/appserver src/e2e/roomEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  materializeSpace,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:e2e-user";
const SPACE = "did:web:space-e2e.example";

async function get(ctx: E2eContext, path: string) {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/${path}`);
}

describe("room-scoped endpoints resolve a materialized room", () => {
  test("getMessages returns the materialized message", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.room.getMessages?roomId=${roomId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.some((m: { id: string }) => m.id === messageId)).toBe(true);
  });

  test("getThreads returns 200 for a channel", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.room.getThreads?roomId=${roomId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test("getMetadata returns 200 with room metadata", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, { roomName: "general" });

    const res = await get(ctx, `space.roomy.room.getMetadata?roomId=${roomId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("spaceId", SPACE);
  });

  test("getRoomSummary returns 200", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.room.getRoomSummary?roomId=${roomId}`);
    expect(res.status).toBe(200);
  });

  test("updateSeen returns 200 and persists the read position", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
      { method: "POST", body: JSON.stringify({ roomId, seenUpTo: messageId }) },
    );
    expect(res.status).toBe(200);

    const row = await (ctx.db as unknown as { readState(): { query(s: string): { get<T>(...p: unknown[]): Promise<T | null> } } })
      .readState()
      .query("select seen_up_to from read_positions where user_did = ? and room_id = ?")
      .get<{ seen_up_to: string }>(USER, roomId);
    expect(row?.seen_up_to).toBeTruthy();
  });
});

describe("message-scoped endpoints resolve a materialized message", () => {
  test("getMessage returns the materialized message", async () => {
    const ctx = await startAppserver();
    const { messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.message.getMessage?messageId=${messageId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id", messageId);
  });

  test("getReactions returns 200 (empty reactions)", async () => {
    const ctx = await startAppserver();
    const { messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.message.getReactions?messageId=${messageId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.reactions)).toBe(true);
  });
});

describe("room-scoped endpoints 404 for an unknown room", () => {
  test("getMessages returns 404 for a room that was never materialized", async () => {
    const ctx = await startAppserver();
    const res = await get(ctx, `space.roomy.room.getMessages?roomId=${newUlid()}`);
    expect(res.status).toBe(404);
  });
});
