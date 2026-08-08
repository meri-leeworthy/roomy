import { afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { closeDb, openDb, openGlobalDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import {
  JOINED_SPACE_LABEL,
  recordPersonalSpaceMembership,
  selectJoinedSpaces,
} from "./joinedSpaces.ts";

const USER = UserDid.assert("did:plc:test-user");
const SPACE = StreamDid.assert("did:web:space-stream.example");

/**
 * Set up the worker-backed DBs for the Phase 3 fan-out read path:
 *   - space-scoped rows (entities, comp_info, member/admin edges) go into the
 *     per-space DB via `openSpaceDb`
 *   - `joinedSpace` edges go into the global DB via `openGlobalDb`
 *   - read-state (unread counts) goes into the read-state DB
 *
 * Returns `{ globalDb, mainDb }` where `globalDb` is the global handle and
 * `mainDb` is the read-state handle — the handles `selectJoinedSpaces` takes.
 */
function setup(): { globalDb: DbLike; mainDb: DbLike } {
  closeDb();
  process.env.READSTATE_DB_PATH = ":memory:";
  openDb({ path: ":memory:" });
  const globalDb = openGlobalDb();
  const mainDb = openReadStateDb();
  return { globalDb, mainDb };
}

/** Seed an entity row in the space's per-space DB. */
async function seedEntity(spaceId: string, id: string, streamId: string = id): Promise<void> {
  const db = openSpaceDb(spaceId);
  await db.run("insert into entities (id, stream_id) values (?, ?)", [id, streamId]);
}

/**
 * Seed the rows the *space stream's* own materialisation produces: the space
 * + user entities, the space's name, and the creator's admin/member edges.
 * This is space-global truth — it says nothing about who has joined.
 */
async function seedSpace(): Promise<void> {
  const db = openSpaceDb(SPACE);
  await seedEntity(SPACE, SPACE);
  await seedEntity(SPACE, USER);
  await db.run("insert into comp_info (entity, name) values (?, ?)", [
    SPACE,
    "Test Space",
  ]);
  await db.run("insert into edges (head, tail, label) values (?, ?, 'admin')", [
    SPACE,
    USER,
  ]);
  await db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
    SPACE,
    USER,
  ]);
}

/** Seed a `joinedSpace` edge in the global DB: `user` has joined `space`. */
async function joinEdge(user: string, space: string): Promise<void> {
  const db = openGlobalDb();
  await db.run("insert into edges (head, tail, label) values (?, ?, ?)", [
    user,
    space,
    JOINED_SPACE_LABEL,
  ]);
}

describe("selectJoinedSpaces", () => {
  test("a space the user has a joinedSpace edge to is visible", async () => {
    const { globalDb, mainDb } = setup();
    await seedSpace();
    await joinEdge(USER, SPACE);

    const spaces = await selectJoinedSpaces(globalDb, mainDb, USER);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({
      id: SPACE,
      name: "Test Space",
      isMember: true,
      isAdmin: true,
    });
  });

  test("a space with no joinedSpace edge is invisible even if it exists", async () => {
    const { globalDb, mainDb } = setup();
    // Space fully materialised (entity, info, member edge) but the user
    // never joined it — no joinedSpace edge.
    await seedSpace();

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });

  test("a space joined by a different user is not visible (multi-user)", async () => {
    const { globalDb, mainDb } = setup();
    await seedSpace();
    const OTHER_USER = UserDid.assert("did:plc:other-user");
    await seedEntity(SPACE, OTHER_USER);
    // Another user joined the same space. Their edge must not leak into ours.
    await joinEdge(OTHER_USER, SPACE);

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });

  test("a joined space the caller is banned from is excluded", async () => {
    const { globalDb, mainDb } = setup();
    await seedSpace();
    await joinEdge(USER, SPACE);
    const db = openSpaceDb(SPACE);
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });

  test("a joined space with no member/admin edge for the caller is excluded", async () => {
    const { globalDb, mainDb } = setup();
    // joinedSpace intent exists, but the space stream never recorded the
    // member edge (e.g. join not yet accepted) — not a real membership.
    const db = openSpaceDb(SPACE);
    await seedEntity(SPACE, SPACE);
    await seedEntity(SPACE, USER);
    await db.run("insert into comp_info (entity, name) values (?, ?)", [
      SPACE,
      "Test Space",
    ]);
    await joinEdge(USER, SPACE);

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });
});

describe("recordPersonalSpaceMembership", () => {
  test("makes an already-materialised space visible to getSpaces", async () => {
    const { globalDb, mainDb } = setup();
    await seedSpace();
    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);

    // `recordPersonalSpaceMembership` seeds the joinedSpace edge + entity rows.
    // It targets the per-space DB (it writes `entities` rows, which only exist
    // in the per-space schema). The membership edge the read path needs lives
    // in the global DB, so — exactly as the handler fast-path does via
    // `recordGlobalMembership` — we mirror the edge into the global DB.
    const spaceDb = openSpaceDb(SPACE);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);
    const g = openGlobalDb();
    await g.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, ?)",
      [USER, SPACE, JOINED_SPACE_LABEL],
    );

    const spaces = await selectJoinedSpaces(globalDb, mainDb, USER);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ id: SPACE, name: "Test Space" });
  });

  test("seeds the entity rows the joinedSpace edge depends on", async () => {
    const { globalDb } = setup();
    // Neither the space nor the user entity exists yet. The write lands in
    // the per-space DB (which has the `entities` table).
    const spaceDb = openSpaceDb(SPACE);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);

    const edge = await spaceDb
      .query(
        "select head, tail from edges where label = ?",
      )
      .get<{ head: string; tail: string }>(JOINED_SPACE_LABEL);
    expect(edge).toEqual({ head: USER, tail: SPACE });

    // The space entity is scoped to its own stream, not the user.
    const spaceEntity = await spaceDb
      .query(
        "select stream_id from entities where id = ?",
      )
      .get<{ stream_id: string }>(SPACE);
    expect(spaceEntity?.stream_id).toBe(SPACE);
  });

  test("is idempotent", async () => {
    const { globalDb, mainDb } = setup();
    await seedSpace();

    const spaceDb = openSpaceDb(SPACE);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);
    const g = openGlobalDb();
    await g.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, ?)",
      [USER, SPACE, JOINED_SPACE_LABEL],
    );

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toHaveLength(1);
  });
});

afterEach(() => {
  closeDb();
});
