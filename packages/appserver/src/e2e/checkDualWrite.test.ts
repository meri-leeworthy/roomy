/**
 * E2E tests for the space.roomy.admin.checkDualWrite consistency endpoint.
 */

import { describe, expect, test } from "bun:test";
import { startAppserver, seedSpace, seedJoinedSpace, seedUser } from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";

const ADMIN = "did:plc:e2e-admin";
const USER = "did:plc:e2e-user";
const SPACE = "did:web:space-e2e.example";

_setAdminDids([ADMIN]);

async function check(ctx: any, qs = "") {
  const res = await ctx.authedFetch(ADMIN)(
    `${ctx.baseUrl}/xrpc/space.roomy.admin.checkDualWrite?${qs}`,
  );
  expect(res.status).toBe(200);
  return res.json();
}

describe("space.roomy.admin.checkDualWrite", () => {
  test("reports ok for a consistent space after a join", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as any, SPACE, USER, { allowPublicJoin: 1 });
    await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`, {
      method: "POST", body: JSON.stringify({ spaceId: SPACE }),
    });

    const body = await check(ctx, `did=${encodeURIComponent(SPACE)}&verbose=1`);
    expect(body.checked).toBe(1);
    expect(body.diverged).toBe(0);
    expect(body.spaces[0].status).toBe("ok");
  });

  test("detects divergence when the global DB is missing a membership edge", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as any, SPACE, USER, { allowPublicJoin: 1 });
    await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`, {
      method: "POST", body: JSON.stringify({ spaceId: SPACE }),
    });

    // Simulate a lost global write: drop the joinedSpace edge from global.
    await (ctx.db as any).global().run(
      "delete from edges where tail = ? and label = 'joinedSpace'",
      [SPACE],
    );

    const body = await check(ctx, `did=${encodeURIComponent(SPACE)}`);
    expect(body.checked).toBe(1);
    expect(body.diverged).toBe(1);
    expect(body.spaces[0].status).toBe("diverged");
    expect(body.spaces[0].diffs.join(" ")).toContain("joinedSpace");
  });

  test("deep check surfaces per-space table divergence (extra row)", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as any, SPACE, USER, { allowPublicJoin: 1 });
    seedJoinedSpace(ctx.db as any, USER, SPACE);

    // Touch the per-space DB (lazy backfill from mono), then add an extra
    // row only there — simulating a spurious per-space write that mono lacks.
    const spaceDb = (ctx.db as any).forSpace(SPACE);
    await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", ["did:web:r1", SPACE]);
    await spaceDb.run("insert or ignore into comp_room (entity, label) values ('did:web:r1', 'space.roomy.channel')");

    const body = await check(ctx, `did=${encodeURIComponent(SPACE)}`);
    expect(body.spaces[0].status).toBe("diverged");
    expect(body.spaces[0].diffs.join(" ")).toContain("comp_room");
  });

  test("deep check surfaces membership routing violation (edge in per-space)", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as any, SPACE, USER, { allowPublicJoin: 1 });
    seedJoinedSpace(ctx.db as any, USER, SPACE);

    // Simulate broken routing: a joinedSpace edge landed in the per-space DB.
    const spaceDb = (ctx.db as any).forSpace(SPACE);
    await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, SPACE]);
    await spaceDb.run("insert or ignore into edges (head, tail, label) values (?, ?, 'joinedSpace')", [USER, SPACE]);

    const body = await check(ctx, `did=${encodeURIComponent(SPACE)}`);
    expect(body.spaces[0].status).toBe("diverged");
    expect(body.spaces[0].diffs.join(" ")).toContain("joinedSpace in per-space");
  });

  test("anonymous (non-admin) → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.checkDualWrite`,
    );
    expect(res.status).toBe(403);
  });
});
