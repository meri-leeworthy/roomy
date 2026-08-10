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

const USER = "did:plc:e2e-user";
const ADMIN = "did:plc:e2e-admin";
const SPACE = "did:web:space-e2e.example";

_setAdminDids([ADMIN]);

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
      { method: "POST", body: JSON.stringify({ flag: "push-notifications", all: true }) },
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
      { method: "POST", body: JSON.stringify({ flag: "push-notifications", all: true }) },
    );
    expect(clear.status).toBe(200);
  });
});
