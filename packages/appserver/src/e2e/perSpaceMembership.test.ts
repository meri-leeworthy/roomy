/**
 * E2E coverage for the per-space DB split (Phase 1):
 *   - membership (joinedSpace/leftSpace) is tracked consistently in the global DB
 *   - rooms/messages dual-write to the per-space DB
 *   - handler fast-paths and the materialiser keep mono + global + per-space in lockstep
 *
 * These run through the real HTTP transport (test-mode X-Test-Did auth) with
 * :memory: DBs and disabled backfill, mirroring the boot path.
 *
 * Accepted limitation: left-space persistence does not survive a fresh rebuild
 * until the post-migration wipe+replay (see docs/plans/per-space-dbs.md). The
 * assertions here validate the WRITE path keeps mono and global consistent for
 * the live flow; cross-restart leftSpace persistence is out of scope.
 *
 * Run: bun test --cwd packages/appserver src/e2e/perSpaceMembership.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedInvite,
  seedUser,
  type E2eContext,
} from "./helpers.ts";

// ─── Shared identities ────────────────────────────────────────────────
const USER = "did:plc:e2e-user";
const USER2 = "did:plc:e2e-user-2";
const BANNED = "did:plc:e2e-banned";
const SPACE = "did:web:space-e2e.example";
const SPACE2 = "did:web:space-e2e-b.example";
const INVITE = "test-invite-token-abc123";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

// ─── DB assertion helpers ─────────────────────────────────────────────

/** Membership edge presence in the monolithic DB vs the global DB.
 *
 * Edge direction differs by label:
 *  - joinedSpace / leftSpace: head = user, tail = space (membership store)
 *  - member / admin: head = space, tail = user (auth / role state, mono only)
 */
async function membershipIn(
  db: AnyDb,
  user: string,
  space: string,
  label: "joinedSpace" | "leftSpace" | "member" | "admin",
): Promise<{ mono: boolean; global: boolean }> {
  const [head, tail] =
    label === "member" || label === "admin" ? [space, user] : [user, space];
  const q = "select 1 as n from edges where head = ? and tail = ? and label = ?";
  const mono = await db.query(q).get(head, tail, label);
  const global = await db.global().query(q).get(head, tail, label);
  return { mono: mono != null, global: global != null };
}

/** Count of rows of a table in the monolithic vs per-space DB. */
async function tableIn(
  db: AnyDb,
  table: "comp_room" | "comp_content",
  space: string,
): Promise<{ mono: number; per: number }> {
  const mono = await db.query(`select count(*) as n from ${table}`).get() as { n: number } | undefined;
  const per = await db.forSpace(space).query(`select count(*) as n from ${table}`).get() as { n: number } | undefined;
  return { mono: mono?.n ?? 0, per: per?.n ?? 0 };
}

async function joinSpace(ctx: E2eContext, did: string, space: string, invite?: string) {
  return ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`, {
    method: "POST",
    body: JSON.stringify({ spaceId: space, ...(invite ? { inviteToken: invite } : {}) }),
  });
}

async function leaveSpace(ctx: E2eContext, did: string, space: string) {
  return ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.leaveSpace`, {
    method: "POST",
    body: JSON.stringify({ spaceId: space }),
  });
}

// ─── Membership in the global DB ───────────────────────────────────────

describe("per-space dual-write: membership tracked in the global DB", () => {
  test("joinSpace (public) writes joinedSpace to mono + global", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });

    const res = await joinSpace(ctx, USER, SPACE);
    expect(res.status).toBe(200);

    const m = await membershipIn(ctx.db as AnyDb, USER, SPACE, "joinedSpace");
    expect(m.mono).toBe(true);
    expect(m.global).toBe(true);
  });

  test("joinSpace (private, invite) writes joinedSpace to mono + global", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 0 });
    seedInvite(ctx.db as AnyDb, SPACE, INVITE, USER);

    const res = await joinSpace(ctx, USER, SPACE, INVITE);
    expect(res.status).toBe(200);

    const m = await membershipIn(ctx.db as AnyDb, USER, SPACE, "joinedSpace");
    expect(m.mono).toBe(true);
    expect(m.global).toBe(true);
  });

  test("leaveSpace removes joinedSpace and writes leftSpace in mono + global", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);

    const res = await leaveSpace(ctx, USER, SPACE);
    expect(res.status).toBe(200);

    const j = await membershipIn(ctx.db as AnyDb, USER, SPACE, "joinedSpace");
    expect(j.mono).toBe(false);
    expect(j.global).toBe(false);

    const l = await membershipIn(ctx.db as AnyDb, USER, SPACE, "leftSpace");
    expect(l.mono).toBe(true);
    expect(l.global).toBe(true);
  });

  test("rejoin after leave clears leftSpace and restores joinedSpace in mono + global", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);
    await leaveSpace(ctx, USER, SPACE);

    const res = await joinSpace(ctx, USER, SPACE);
    expect(res.status).toBe(200);

    const j = await membershipIn(ctx.db as AnyDb, USER, SPACE, "joinedSpace");
    expect(j.mono).toBe(true);
    expect(j.global).toBe(true);

    const l = await membershipIn(ctx.db as AnyDb, USER, SPACE, "leftSpace");
    expect(l.mono).toBe(false);
    expect(l.global).toBe(false);
  });

  test("multi-user churn keeps mono and global in lockstep", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedSpace(ctx.db as AnyDb, SPACE2, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    // USER joins SPACE + SPACE2; USER2 joins SPACE only.
    await joinSpace(ctx, USER, SPACE);
    await joinSpace(ctx, USER, SPACE2);
    await joinSpace(ctx, USER2, SPACE);

    // USER leaves SPACE2; USER2 leaves SPACE.
    await leaveSpace(ctx, USER, SPACE2);
    await leaveSpace(ctx, USER2, SPACE);

    // USER still in SPACE; USER2 in nothing; USER left SPACE2.
    const u1s1 = await membershipIn(ctx.db as AnyDb, USER, SPACE, "joinedSpace");
    expect(u1s1).toEqual({ mono: true, global: true });
    const u1s2 = await membershipIn(ctx.db as AnyDb, USER, SPACE2, "joinedSpace");
    expect(u1s2).toEqual({ mono: false, global: false });
    const u1s2l = await membershipIn(ctx.db as AnyDb, USER, SPACE2, "leftSpace");
    expect(u1s2l).toEqual({ mono: true, global: true });
    const u2s1 = await membershipIn(ctx.db as AnyDb, USER2, SPACE, "joinedSpace");
    expect(u2s1).toEqual({ mono: false, global: false });
    const u2s1l = await membershipIn(ctx.db as AnyDb, USER2, SPACE, "leftSpace");
    expect(u2s1l).toEqual({ mono: true, global: true });
  });

  test("banned user cannot join → no edge in mono or global", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, BANNED);
    (ctx.db as AnyDb).run(
      "insert into comp_bans (entity, user_did) values (?, ?)",
      [SPACE, BANNED],
    );

    const res = await joinSpace(ctx, BANNED, SPACE);
    expect(res.status).toBe(403);

    const m = await membershipIn(ctx.db as AnyDb, BANNED, SPACE, "joinedSpace");
    expect(m).toEqual({ mono: false, global: false });
  });

  test("non-member cannot leave → no leftSpace in mono or global", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    const res = await leaveSpace(ctx, USER2, SPACE);
    expect(res.status).toBe(403);

    const l = await membershipIn(ctx.db as AnyDb, USER2, SPACE, "leftSpace");
    expect(l).toEqual({ mono: false, global: false });
  });

  test("join materialises member edge in mono (auth/role state)", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    await joinSpace(ctx, USER2, SPACE);
    const mem = await membershipIn(ctx.db as AnyDb, USER2, SPACE, "member");
    // member edge is space-scoped (auth), lives in mono — not in global.
    expect(mem.mono).toBe(true);
    expect(mem.global).toBe(false);
  });

  test("getSpaces reflects a freshly joined membership (read path)", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    const before = await ctx.authedFetch(USER2)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect((await before.json()).spaces).toEqual([]);

    await joinSpace(ctx, USER2, SPACE);

    const after = await ctx.authedFetch(USER2)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    const body = await after.json();
    expect(Array.isArray(body.spaces)).toBe(true);
    expect(body.spaces.some((sp: { id: string }) => sp.id === SPACE)).toBe(true);
  });

  test("createSpace writes joinedSpace to mono + global (when PLC available)", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.createSpace`,
      { method: "POST", body: JSON.stringify({ name: "Test Space" }) },
    );
    if (res.status !== 200) {
      // PLC directory unreachable in CI — the no-backend path is already
      // covered by endpoints.test.ts. Nothing to assert here.
      return;
    }
    const { spaceId } = await res.json();
    const m = await membershipIn(ctx.db as AnyDb, USER, spaceId, "joinedSpace");
    expect(m.mono).toBe(true);
    expect(m.global).toBe(true);
  });
});

// ─── Rooms + messages dual-write to the per-space DB ───────────────────

describe("per-space dual-write: rooms and messages", () => {
  async function send(ctx: E2eContext, did: string, space: string, events: unknown[]) {
    return ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
      method: "POST",
      body: JSON.stringify({ spaceId: space, events }),
    });
  }

  test("createRoom dual-writes comp_room to mono + per-space", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);
    (ctx.db as AnyDb).run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
      [SPACE, USER],
    );

    const room = newUlid();
    const res = await send(ctx, USER, SPACE, [
      { id: room, $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name: "general" },
    ]);
    expect(res.status).toBe(200);

    const rooms = await tableIn(ctx.db as AnyDb, "comp_room", SPACE);
    expect(rooms.mono).toBe(1);
    expect(rooms.per).toBe(1);

    // The room entity row must exist in the per-space DB too.
    const roomInPer = await (ctx.db as AnyDb)
      .forSpace(SPACE)
      .query("select 1 as n from entities where id = ?")
      .get(room);
    expect(roomInPer).not.toBeNull();
  });

  test("createMessage dual-writes comp_content + author edge to mono + per-space", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);

    // Need a room to target.
    const room = newUlid();
    await (ctx.db as AnyDb).run(
      "insert or ignore into entities (id, stream_id) values (?, ?)",
      [room, SPACE],
    );
    await (ctx.db as AnyDb).run(
      "insert or ignore into comp_room (entity, label) values (?, 'space.roomy.channel')",
      [room],
    );

    const msgId = newUlid();
    const res = await send(ctx, USER, SPACE, [
      {
        id: msgId,
        $type: "space.roomy.message.createMessage.v0",
        room,
        body: {
          mimeType: "text/plain",
          data: { $bytes: Buffer.from("hello").toString("base64") },
        },
        extensions: {},
      },
    ]);
    expect(res.status).toBe(200);

    // comp_content may also hold a system "joined" message, so assert the
    // specific message row exists rather than a total count.
    const msgMono = await (ctx.db as AnyDb)
      .query("select 1 as n from comp_content where entity = ?")
      .get(msgId);
    expect(msgMono).not.toBeNull();
    const msgPer = await (ctx.db as AnyDb)
      .forSpace(SPACE)
      .query("select 1 as n from comp_content where entity = ?")
      .get(msgId);
    expect(msgPer).not.toBeNull();

    const author = await membershipIn(ctx.db as AnyDb, USER, SPACE, "member");
    expect(author.mono).toBe(true);
  });

  test("membership edges are routed to global, not the per-space DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);

    // The joinedSpace edge must NOT appear in the per-space DB.
    const per = await (ctx.db as AnyDb)
      .forSpace(SPACE)
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
      .get(USER, SPACE);
    expect(per).toBeNull();

    // But it is in the global DB.
    const g = await (ctx.db as AnyDb)
      .global()
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
      .get(USER, SPACE);
    expect(g).not.toBeNull();
  });
});

// ─── Backfill ──────────────────────────────────────────────────────────

describe("per-space dual-write: global DB backfill", () => {
  test("a mono joinedSpace edge backfills into the global DB on first access", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedJoinedSpace(ctx.db as AnyDb, USER, SPACE);

    // First touch of the global DB triggers the backfill from mono.
    const g = await membershipIn(ctx.db as AnyDb, USER, SPACE, "joinedSpace");
    expect(g.mono).toBe(true);
    expect(g.global).toBe(true);
  });
});

// ─── Concurrency ───────────────────────────────────────────────────────

describe("per-space dual-write: concurrency", () => {
  test("concurrent joins keep mono and global consistent", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    await Promise.all([joinSpace(ctx, USER, SPACE), joinSpace(ctx, USER2, SPACE)]);

    const u1 = await membershipIn(ctx.db as AnyDb, USER, SPACE, "joinedSpace");
    expect(u1).toEqual({ mono: true, global: true });
    const u2 = await membershipIn(ctx.db as AnyDb, USER2, SPACE, "joinedSpace");
    expect(u2).toEqual({ mono: true, global: true });
  });
});
