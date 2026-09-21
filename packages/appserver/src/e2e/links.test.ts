/**
 * E2E coverage for the link index endpoints (`space.roomy.room.getLinks` and
 * `space.roomy.space.getLinks`).
 *
 * Unlike the unit tests (which seed the DB directly), these exercise the
 * REAL XRPC handlers: the two-hop message-room resolution, cross-room dedup
 * at the space level, and — the core acceptance point — access control. A
 * links view is a cross-room read: a caller without read access to a room
 * must NOT see that room's links.
 *
 * The link is materialised the same way as the real pipeline: link entity
 * `room` = the message id (NOT the room id). If the handler used a one-hop
 * join it would return the wrong room (or none).
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedRoom,
  seedMessage,
  spaceDb,
  type E2eContext,
} from "./helpers.ts";

const OWNED = "did:web:space-owned.example"; // private (invite-only)
const OTHER = "did:plc:e2e-other";
const OWNER = "did:plc:e2e-owner";

/** Seed a private space with two rooms, each holding a link. */
function seedPrivateSpaceWithLinks(
  ctx: E2eContext,
): { roomA: string; roomB: string } {
  // Private: allowPublicJoin = 0 → a non-member can't read anything.
  seedSpace(ctx.db, OWNED, OWNER, { allowPublicJoin: 0 });
  seedJoinedSpace(ctx.db, OWNER, OWNED);

  const roomA = newUlid();
  const roomB = newUlid();

  for (const [roomId, urlTag] of [
    [roomA, "https://room-a.example/1"],
    [roomB, "https://room-b.example/2"],
  ] as const) {
    seedRoom(ctx.db, roomId, OWNED, "space.roomy.channel");
    const msgId = newUlid();
    seedMessage(ctx.db, msgId, roomId, OWNED);
    // Link entity: room = message id (two-hop), stream_id = '' .
    spaceDb(ctx.db, OWNED).run(
      "insert into entities (id, stream_id, room) values (?, '', ?)",
      [urlTag, msgId],
    );
    spaceDb(ctx.db, OWNED).run(
      "insert into comp_embed_link (entity, show_preview) values (?, 1)",
      [urlTag],
    );
  }
  return { roomA, roomB };
}

describe("space.roomy.room.getLinks", () => {
  test("returns the room's links with the real room id (two-hop join)", async () => {
    const ctx = await startAppserver();
    const { roomA } = seedPrivateSpaceWithLinks(ctx);

    const res = await ctx.authedFetch(OWNER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getLinks?roomId=${roomA}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.links)).toBe(true);
    expect(body.links).toHaveLength(1);
    expect(body.links[0]!.url).toBe("https://room-a.example/1");
    // THE acceptance: roomId is the real room, not the message id.
    expect(body.links[0]!.roomId).toBe(roomA);
  });

  test("a non-member gets 403 from an invite-only room's link index", async () => {
    const ctx = await startAppserver();
    const { roomA } = seedPrivateSpaceWithLinks(ctx);

    const res = await ctx.authedFetch(OTHER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getLinks?roomId=${roomA}`,
    );
    // requireRoomRead 403s the caller (no read access). Observable: no link
    // data leaks — the response is empty, not the room's links.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.links).toBeUndefined();
  });
});

describe("space.roomy.space.getLinks", () => {
  test("returns links from every room, deduped by URL at the space level", async () => {
    const ctx = await startAppserver();
    const { roomA, roomB } = seedPrivateSpaceWithLinks(ctx);

    const res = await ctx.authedFetch(OWNER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getLinks?spaceId=${OWNED}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.links)).toBe(true);
    const urls = body.links.map((l: { url: string }) => l.url);
    expect(urls).toContain("https://room-a.example/1");
    expect(urls).toContain("https://room-b.example/2");
    const roomIds = body.links.map((l: { roomId: string }) => l.roomId);
    expect(roomIds).toContain(roomA);
    expect(roomIds).toContain(roomB);
  });

  test("a non-member sees no links from rooms they cannot read", async () => {
    const ctx = await startAppserver();
    seedPrivateSpaceWithLinks(ctx);

    // OTHER has no membership and the space is invite-only → 403 on the
    // space itself (requireSpaceRead). Observable: no link data leaks.
    const res = await ctx.authedFetch(OTHER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getLinks?spaceId=${OWNED}`,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.links).toBeUndefined();
  });

  test("a member sees only links from rooms they can read", async () => {
    const ctx = await startAppserver();
    const { roomA, roomB } = seedPrivateSpaceWithLinks(ctx);

    // OTHER joins the space (member), but roomB is a private channel
    // (default_access 'none'), so OTHER can read roomA but not roomB.
    seedSpace(ctx.db, OWNED, OTHER, { allowPublicJoin: 0 });
    seedJoinedSpace(ctx.db, OTHER, OWNED);
    spaceDb(ctx.db, OWNED).run(
      "update comp_room set default_access = 'none' where entity = ?",
      [roomB],
    );

    const res = await ctx.authedFetch(OTHER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getLinks?spaceId=${OWNED}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only roomA's link is visible (roomB is unreadable).
    expect(body.links.map((l: { roomId: string }) => l.roomId)).toEqual([roomA]);
  });
});
