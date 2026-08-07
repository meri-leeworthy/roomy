import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  _resetHydrationInflight,
  hydrateUserMembership,
} from "./userHydration.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const USER = UserDid.assert("did:plc:hydration-user");
const SPACE_A = StreamDid.assert("did:web:space-a.example");
const SPACE_B = StreamDid.assert("did:web:space-b.example");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}

/**
 * Intent seeding: the production materializer writes `joinedSpace` edges
 * (head = userDid, tail = spaceId) from space.joinSpace events. We bypass
 * the materializer here and write the rows directly so hydration can be
 * tested in isolation. A left space has no such edge (LeaveSpace deletes it).
 */
function seedPersonalIntent(
  db: Database,
  userDid: UserDid,
  joinedSpaces: StreamDid[],
  leftSpaces: StreamDid[] = [],
): void {
  // Entity rows are the FK targets for the joinedSpace edges. Each entity is
  // scoped to its own stream.
  for (const did of [userDid, ...joinedSpaces, ...leftSpaces]) {
    db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      did,
      did,
    ]);
  }
  for (const did of joinedSpaces) {
    db.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'joinedSpace')",
      [userDid, did],
    );
  }
}

describe("hydrateUserMembership", () => {
  test("no joinedSpace edges → empty result", async () => {
    _resetHydrationInflight();
    const { asyncDb } = freshDb();

    const result = await hydrateUserMembership(USER, {
      db: asyncDb,
    });

    expect(result.intendedSpaceDids).toEqual([]);
    expect(result.hydrationFailures).toEqual([]);
  });

  test("two joined spaces → all hydrated", async () => {
    _resetHydrationInflight();
    const { db, asyncDb } = freshDb();

    // Pre-seed joinedSpace edges so the SQL for intent picks them up.
    seedPersonalIntent(db, USER, [SPACE_A, SPACE_B]);

    const result = await hydrateUserMembership(USER, {
      db: asyncDb,
    });

    expect(new Set(result.intendedSpaceDids)).toEqual(
      new Set([SPACE_A, SPACE_B]),
    );
    expect(result.hydrationFailures).toEqual([]);
  });

  test("left spaces (no joinedSpace edge) are excluded from intent", async () => {
    _resetHydrationInflight();
    const { db, asyncDb } = freshDb();

    seedPersonalIntent(db, USER, [SPACE_A], [SPACE_B]);

    const result = await hydrateUserMembership(USER, {
      db: asyncDb,
    });

    expect(result.intendedSpaceDids).toEqual([SPACE_A]);
  });

  test("concurrent calls for the same user share an in-flight promise", async () => {
    _resetHydrationInflight();
    const { db, asyncDb } = freshDb();

    seedPersonalIntent(db, USER, [SPACE_A]);

    const opts = {
      db: asyncDb,
    };

    const [a, b] = await Promise.all([
      hydrateUserMembership(USER, opts),
      hydrateUserMembership(USER, opts),
    ]);

    expect(a).toBe(b);
  });
});
