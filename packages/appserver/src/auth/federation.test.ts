import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbLike } from "../db/types.ts";
import { federatedRoomAccess } from "./federation.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SPACE_SCHEMA = join(__dirname, "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA = join(__dirname, "..", "db", "schema-global.sql");

const A = "did:web:space-a.example"; // origin space A
const B = "did:web:space-b.example"; // receiving space B
const USER = "did:plc:bob";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREAD000000000000000000";

function freshSpaceDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SPACE_SCHEMA, "utf8"));
  return toAsyncDb(db);
}
function freshGlobalDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(GLOBAL_SCHEMA, "utf8"));
  return toAsyncDb(db);
}

async function seedSpaceA(spaceDb: DbLike): Promise<void> {
  for (const id of [A, CHANNEL, THREAD]) {
    await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [id, A]);
  }
  await spaceDb.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );
  await spaceDb.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD],
  );
  // canonical link: THREAD -> CHANNEL (head = parent, tail = thread)
  await spaceDb.run(
    "insert into edges (head, tail, label, payload) values (?, ?, 'link', ?)",
    [CHANNEL, THREAD, JSON.stringify({ canonical_parent: 1 })],
  );
}
async function seedActiveFederationWithGrant(
  globalDb: DbLike,
  permission: string,
): Promise<void> {
  await globalDb.run("insert into edges (head, tail, label) values (?, ?, 'joinedSpace')", [USER, B]);
  await globalDb.run(
    "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'active', ?)",
    [A, B, USER],
  );
  await globalDb.run(
    "insert into federation_room_permissions (space_id, federating_space_did, room_id, permission) values (?, ?, ?, ?)",
    [A, B, CHANNEL, permission],
  );
}

describe("federation access — origin grants (read)", () => {
  test("member of B can read a federated channel at origin-grant level", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithGrant(globalDb, "read");

    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER);
    expect(fed).not.toBeNull();
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(false);
    expect(fed!.homeSpaceDid).toBe(B);
  });

  test("readwrite origin grant also grants write (for Phase 3)", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithGrant(globalDb, "readwrite");

    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER);
    expect(fed!.canWrite).toBe(true);
  });

  test("threads inherit federation from their parent channel", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithGrant(globalDb, "read");

    const fed = await federatedRoomAccess(spaceDb, globalDb, THREAD, USER);
    expect(fed).not.toBeNull();
    expect(fed!.canRead).toBe(true);
  });

  test("no origin grant on the channel => no federated access", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithGrant(globalDb, "read");
    await globalDb.run(
      "delete from federation_room_permissions where space_id = ? and federating_space_did = ? and room_id = ?",
      [A, B, CHANNEL],
    );
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER);
    expect(fed).toBeNull();
  });

  test("inactive federation => null", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithGrant(globalDb, "read");
    await globalDb.run(
      "update space_federations set status = 'rejected' where space_id = ? and federating_space_did = ?",
      [A, B],
    );
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER);
    expect(fed).toBeNull();
  });

  test("caller not a member of the receiving space => null", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithGrant(globalDb, "read");
    await globalDb.run("delete from edges where head = ? and label = 'joinedSpace'", [USER]);
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER);
    expect(fed).toBeNull();
  });
});
