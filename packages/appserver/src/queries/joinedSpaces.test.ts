import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { closeDb, openDb, openGlobalDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import {
  JOINED_SPACE_LABEL,
  recordPersonalSpaceMembership,
  selectJoinedSpaces,
} from "./joinedSpaces.ts";

const USER = UserDid.assert("did:plc:test-user");
const SPACE = StreamDid.assert("did:web:space-stream.example");

/**
 * Set up the worker-backed DBs for the Phase 2 fan-out read path:
 *   - the monolithic DB is seeded directly (it is the dual-write source)
 *   - the global DB and per-space DB are lazily backfilled from it on first
 *     access (openGlobalDb / openSpaceDb), mirroring production.
 */
function setup(): { mainDb: DbLike } {
  closeDb();
  const mainDb = openDb({ path: ":memory:" });
  return { mainDb };
}

/** Seed an entity row. `stream_id` defaults to the entity's own id. */
function seedEntity(db: DbLike, id: string, streamId: string = id): void {
  void db.run("insert into entities (id, stream_id) values (?, ?)", [id, streamId]);
}

/**
 * Seed the rows the *space stream's* own materialisation produces: the space
 * + user entities, the space's name, and the creator's admin/member edges.
 * This is space-global truth — it says nothing about who has joined.
 */
function seedSpace(db: DbLike): void {
  seedEntity(db, SPACE);
  seedEntity(db, USER);
  void db.run("insert into comp_info (entity, name) values (?, ?)", [
    SPACE,
    "Test Space",
  ]);
  void db.run("insert into edges (head, tail, label) values (?, ?, 'admin')", [
    SPACE,
    USER,
  ]);
  void db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
    SPACE,
    USER,
  ]);
}

/** Seed a `joinedSpace` edge: `user` has joined `space`. */
function joinEdge(db: DbLike, user: string, space: string): void {
  void db.run("insert into edges (head, tail, label) values (?, ?, ?)", [
    user,
    space,
    JOINED_SPACE_LABEL,
  ]);
}

describe("selectJoinedSpaces", () => {
  test("a space the user has a joinedSpace edge to is visible", async () => {
    const { mainDb } = setup();
    seedSpace(mainDb);
    joinEdge(mainDb, USER, SPACE);
    // Trigger per-space + global backfill so the space's display fields and
    // membership edge are readable.
    openSpaceDb(SPACE);
    const globalDb = openGlobalDb();

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
    const { mainDb } = setup();
    // Space fully materialised (entity, info, member edge) but the user
    // never joined it — no joinedSpace edge.
    seedSpace(mainDb);
    openSpaceDb(SPACE);
    const globalDb = openGlobalDb();

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });

  test("a space joined by a different user is not visible (multi-user)", async () => {
    const { mainDb } = setup();
    seedSpace(mainDb);
    const OTHER_USER = UserDid.assert("did:plc:other-user");
    seedEntity(mainDb, OTHER_USER);
    // Another user joined the same space. Their edge must not leak into ours.
    joinEdge(mainDb, OTHER_USER, SPACE);
    openSpaceDb(SPACE);
    const globalDb = openGlobalDb();

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });

  test("a joined space the caller is banned from is excluded", async () => {
    const { mainDb } = setup();
    seedSpace(mainDb);
    joinEdge(mainDb, USER, SPACE);
    void mainDb.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);
    openSpaceDb(SPACE);
    const globalDb = openGlobalDb();

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });

  test("a joined space with no member/admin edge for the caller is excluded", async () => {
    const { mainDb } = setup();
    // joinedSpace intent exists, but the space stream never recorded the
    // member edge (e.g. join not yet accepted) — not a real membership.
    seedEntity(mainDb, SPACE);
    seedEntity(mainDb, USER);
    void mainDb.run("insert into comp_info (entity, name) values (?, ?)", [
      SPACE,
      "Test Space",
    ]);
    joinEdge(mainDb, USER, SPACE);
    openSpaceDb(SPACE);
    const globalDb = openGlobalDb();

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);
  });
});

describe("recordPersonalSpaceMembership", () => {
  test("makes an already-materialised space visible to getSpaces", async () => {
    const { mainDb } = setup();
    seedSpace(mainDb);
    openSpaceDb(SPACE);
    const globalDb = openGlobalDb();
    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toEqual([]);

    await recordPersonalSpaceMembership(mainDb, SPACE, USER);
    // The direct membership write lands in the global DB via the handler
    // fast-path (recordGlobalMembership); here we mirror it so the read path
    // sees it.
    void globalDb.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, ?)",
      [USER, SPACE, JOINED_SPACE_LABEL],
    );

    const spaces = await selectJoinedSpaces(globalDb, mainDb, USER);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ id: SPACE, name: "Test Space" });
  });

  test("seeds the entity rows the joinedSpace edge depends on", async () => {
    const { mainDb } = setup();
    // Neither the space nor the user entity exists yet.
    await recordPersonalSpaceMembership(mainDb, SPACE, USER);

    const edge = await mainDb
      .query(
        "select head, tail from edges where label = ?",
      )
      .get<{ head: string; tail: string }>(JOINED_SPACE_LABEL);
    expect(edge).toEqual({ head: USER, tail: SPACE });

    // The space entity is scoped to its own stream, not the user.
    const spaceEntity = await mainDb
      .query(
        "select stream_id from entities where id = ?",
      )
      .get<{ stream_id: string }>(SPACE);
    expect(spaceEntity?.stream_id).toBe(SPACE);
  });

  test("is idempotent", async () => {
    const { mainDb } = setup();
    seedSpace(mainDb);
    openSpaceDb(SPACE);
    const globalDb = openGlobalDb();

    await recordPersonalSpaceMembership(mainDb, SPACE, USER);
    await recordPersonalSpaceMembership(mainDb, SPACE, USER);
    void globalDb.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, ?)",
      [USER, SPACE, JOINED_SPACE_LABEL],
    );

    expect(await selectJoinedSpaces(globalDb, mainDb, USER)).toHaveLength(1);
  });
});

afterEach(() => {
  closeDb();
});
