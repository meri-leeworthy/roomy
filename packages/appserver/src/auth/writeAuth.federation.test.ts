import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbLike } from "../db/types.ts";
import { checkWriteAuth } from "./writeAuth.ts";
import { newUlid } from "@roomy-space/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
    SCHEMA_VERSION,
  ]);
  return { db, asyncDb: toAsyncDb(db) };
}

const A = "did:web:space-a.example"; // origin space A
const B = "did:web:space-b.example"; // federating space B
const ADMIN_A = "did:plc:adminA";
const ADMIN_B = "did:plc:adminB";
const MEMBER_A = "did:plc:memberA";

async function seedSpace(db: DbLike, spaceId: string): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    spaceId,
    spaceId,
  ]);
  await db.run("insert into comp_space (entity) values (?)", [spaceId]);
}
async function seedUser(db: DbLike, did: string): Promise<void> {
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
}
async function addEdge(
  db: DbLike,
  head: string,
  tail: string,
  label: string,
): Promise<void> {
  await db.run("insert into edges (head, tail, label) values (?, ?, ?)", [
    head,
    tail,
    label,
  ]);
}

function requestEvent(spaceB: string) {
  return { $type: "space.roomy.federation.request.v0", id: newUlid(), federatingSpaceDid: spaceB };
}
function respondEvent(spaceB: string, approve: boolean) {
  return { $type: "space.roomy.federation.respond.v0", id: newUlid(), federatingSpaceDid: spaceB, approve };
}
function removeEvent(spaceB: string) {
  return { $type: "space.roomy.federation.remove.v0", id: newUlid(), federatingSpaceDid: spaceB };
}
function setRoomPermEvent(spaceB: string, roomId: string, permission: string | null) {
  return { $type: "space.roomy.federation.setRoomPermission.v0", id: newUlid(), federatingSpaceDid: spaceB, roomId, permission };
}

async function seedRequestContext(opts: { memberA: string; adminA?: boolean; adminB?: boolean }) {
  const { asyncDb: aDb } = freshDb();
  const { asyncDb: bDb } = freshDb();
  await seedSpace(aDb, A);
  await seedSpace(bDb, B);
  await seedUser(aDb, opts.memberA);
  await seedUser(bDb, opts.memberA);
  await addEdge(aDb, A, opts.memberA, "member");
  if (opts.adminB) await addEdge(bDb, B, opts.memberA, "admin");
  return { aDb, bDb };
}

describe("auth/writeAuth — federation request", () => {
  test("admin of B who is a member of A can request", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B, adminB: true });
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), undefined, () => bDb);
    expect(result).toBeUndefined();
  });

  test("admin of B but NOT a member of A is denied", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B });
    // no member edge on A
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), undefined, () => bDb);
    expect(result?.status).toBe(403);
  });

  test("member of A but not admin of B is denied", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: MEMBER_A, adminB: false });
    const result = await checkWriteAuth(aDb, A, MEMBER_A, requestEvent(B), undefined, () => bDb);
    expect(result?.status).toBe(403);
  });

  test("denied when no cross-space resolver is provided", async () => {
    const { aDb } = await seedRequestContext({ memberA: ADMIN_B });
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B));
    expect(result?.status).toBe(403);
  });

  test("missing federatingSpaceDid is a 400", async () => {
    const { aDb } = await seedRequestContext({ memberA: ADMIN_B });
    const result = await checkWriteAuth(aDb, A, ADMIN_B, {
      $type: "space.roomy.federation.request.v0",
      id: newUlid(),
    });
    expect(result?.status).toBe(400);
  });
});

describe("auth/writeAuth — federation respond/remove", () => {
  test("admin of A can respond (approve)", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const result = await checkWriteAuth(aDb, A, ADMIN_A, respondEvent(B, true));
    expect(result).toBeUndefined();
  });

  test("non-admin of A cannot respond", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, MEMBER_A);
    await addEdge(aDb, A, MEMBER_A, "member");
    const result = await checkWriteAuth(aDb, A, MEMBER_A, respondEvent(B, true));
    expect(result?.status).toBe(403);
  });

  test("admin of A can remove", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const result = await checkWriteAuth(aDb, A, ADMIN_A, removeEvent(B));
    expect(result).toBeUndefined();
  });

  test("admin of A can set an origin grant", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const result = await checkWriteAuth(aDb, A, ADMIN_A, setRoomPermEvent(B, "01CHANNEL00000000000000000", "read"));
    expect(result).toBeUndefined();
  });

  test("non-admin of A cannot set an origin permission", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, MEMBER_A);
    await addEdge(aDb, A, MEMBER_A, "member");
    const result = await checkWriteAuth(aDb, A, MEMBER_A, setRoomPermEvent(B, "01CHANNEL00000000000000000", "read"));
    expect(result?.status).toBe(403);
  });
});
