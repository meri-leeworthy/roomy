/**
 * space.roomy.user.getProfile coverage. In test mode HappyView isn't
 * configured, so getProfile reads the global `profiles` table (the
 * authoritative Roomy profile store). Seed a row there and assert it's
 * returned.
 *
 * Run: bun test --cwd packages/appserver src/e2e/profileEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { startAppserver, type E2eContext } from "./helpers.ts";

const USER = "did:plc:e2e-user";

describe("space.roomy.user.getProfile", () => {
  test("returns a seeded global profile for a DID", async () => {
    const ctx = await startAppserver();
    await (ctx.db as unknown as { global(): { run(s: string, ...p: unknown[]): Promise<unknown> } })
      .global()
      .run(
        "insert or ignore into profiles (did, handle, name, avatar) values (?, ?, ?, ?)",
        [USER, "user.test", "Test User", "https://cdn.example/u.png"],
      );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.user.getProfile?actor=${USER}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("did", USER);
    expect(body).toHaveProperty("handle", "user.test");
    expect(body).toHaveProperty("displayName", "Test User");
  });

  test("returns minimal profile (just did) for an unknown user", async () => {
    const ctx = await startAppserver();
    const unknown = "did:plc:unknown-user";
    // getProfile will try Bluesky hydration for an unknown DID; that network
    // call fails gracefully and returns the minimal { did } shape. Guard the
    // assertion to the did only.
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.user.getProfile?actor=${unknown}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("did", unknown);
  });
});
