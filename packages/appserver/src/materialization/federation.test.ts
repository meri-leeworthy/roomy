import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { applyBatch } from "./applyBatch.ts";
import { StreamDid, StreamIndex, UserDid, newUlid, type Event } from "@roomy-space/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "db", "schema-global.sql");

const A = StreamDid.assert("did:web:space-a.example");
const B = StreamDid.assert("did:web:space-b.example");
const USER = UserDid.assert("did:plc:adminB");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return { db, asyncDb: toAsyncDb(db) };
}
function freshGlobalDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return { db, asyncDb: toAsyncDb(db) };
}
function seedSpace(db: Database): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [A, A]);
  db.run("insert into comp_space (entity) values (?)", [A]);
}
function decoded(event: Event, idx: number) {
  return { event, idx: idx as StreamIndex, user: USER };
}
function requestEvent(b: StreamDid) {
  return { $type: "space.roomy.federation.request.v0", id: newUlid(), federatingSpaceDid: b, message: "hi" } as unknown as Event;
}
function respondEvent(b: StreamDid, approve: boolean) {
  return { $type: "space.roomy.federation.respond.v0", id: newUlid(), federatingSpaceDid: b, approve } as unknown as Event;
}
function removeEvent(b: StreamDid) {
  return { $type: "space.roomy.federation.remove.v0", id: newUlid(), federatingSpaceDid: b } as unknown as Event;
}
function setRoomPermEvent(b: StreamDid, roomId: string, permission: string | null) {
  return { $type: "space.roomy.federation.setRoomPermission.v0", id: newUlid(), federatingSpaceDid: b, roomId, permission } as unknown as Event;
}
function setReceiverPermEvent(origin: StreamDid, roomId: string, grantee: string, kind: string, permission: string | null) {
  return { $type: "space.roomy.federation.setReceiverPermission.v0", id: newUlid(), originSpaceId: origin, roomId, grantee, kind, permission } as unknown as Event;
}

async function receiverPermissionOf(globalDb: DbLike, a: string, b: string, roomId: string, grantee: string, kind: string): Promise<string | undefined> {
  return (await globalDb
    .query("select permission from federation_receiver_permissions where space_id = ? and federating_space_did = ? and room_id = ? and grantee = ? and kind = ?")
    .get<{ permission: string }>(a, b, roomId, grantee, kind))?.permission;
}

async function permissionOf(globalDb: DbLike, a: string, b: string, roomId: string): Promise<string | undefined> {
  return (await globalDb
    .query("select permission from federation_room_permissions where space_id = ? and federating_space_did = ? and room_id = ?")
    .get<{ permission: string }>(a, b, roomId))?.permission;
}

async function statusOf(globalDb: DbLike, a: string, b: string): Promise<string | undefined> {
  return (await globalDb
    .query("select status from space_federations where space_id = ? and federating_space_did = ?")
    .get<{ status: string }>(a, b))?.status;
}

describe("federation materialization (global DB)", () => {
  test("request creates a pending row in the global DB", async () => {
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db);
    const stats = await applyBatch(asyncDb, A, [decoded(requestEvent(B), 0)], { isBackfill: true }, globalDb);
    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);
    expect(await statusOf(globalDb, A, B)).toBe("pending");

    // Must NOT land in the per-space DB: the table should not exist there.
    const spaceTable = await asyncDb
      .query("select 1 as n from sqlite_master where name = 'space_federations'")
      .get<{ n: number }>();
    expect(spaceTable).toBeNull();
  });

  test("respond approve flips status to active", async () => {
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db);
    await applyBatch(asyncDb, A, [decoded(requestEvent(B), 0)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, A, [decoded(respondEvent(B, true), 1)], { isBackfill: true }, globalDb);
    expect(await statusOf(globalDb, A, B)).toBe("active");
  });

  test("respond reject flips status to rejected", async () => {
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db);
    await applyBatch(asyncDb, A, [decoded(requestEvent(B), 0)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, A, [decoded(respondEvent(B, false), 1)], { isBackfill: true }, globalDb);
    expect(await statusOf(globalDb, A, B)).toBe("rejected");
  });

  test("remove flips status to removed", async () => {
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db);
    await applyBatch(asyncDb, A, [decoded(requestEvent(B), 0)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, A, [decoded(respondEvent(B, true), 1)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, A, [decoded(removeEvent(B), 2)], { isBackfill: true }, globalDb);
    expect(await statusOf(globalDb, A, B)).toBe("removed");
  });

  test("setRoomPermission upserts an origin grant in the global DB", async () => {
    const CHANNEL = "01CHANNEL00000000000000000";
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db);
    await applyBatch(asyncDb, A, [decoded(requestEvent(B), 0)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, A, [decoded(respondEvent(B, true), 1)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, A, [decoded(setRoomPermEvent(B, CHANNEL, "read"), 2)], { isBackfill: true }, globalDb);
    expect(await permissionOf(globalDb, A, B, CHANNEL)).toBe("read");

    // Clearing with null removes the grant.
    await applyBatch(asyncDb, A, [decoded(setRoomPermEvent(B, CHANNEL, null), 3)], { isBackfill: true }, globalDb);
    expect(await permissionOf(globalDb, A, B, CHANNEL)).toBeUndefined();
  });

  test("setReceiverPermission upserts a receiver grant in the global DB", async () => {
    const CHANNEL = "01CHANNEL00000000000000000";
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db);
    // Receiver grants target B's stream (B admins configure them).
    await applyBatch(asyncDb, B, [decoded(setReceiverPermEvent(A, CHANNEL, "did:plc:bob", "user", "read"), 0)], { isBackfill: true }, globalDb);
    expect(await receiverPermissionOf(globalDb, A, B, CHANNEL, "did:plc:bob", "user")).toBe("read");

    // Clearing with null removes the grant.
    await applyBatch(asyncDb, B, [decoded(setReceiverPermEvent(A, CHANNEL, "did:plc:bob", "user", null), 1)], { isBackfill: true }, globalDb);
    expect(await receiverPermissionOf(globalDb, A, B, CHANNEL, "did:plc:bob", "user")).toBeUndefined();
  });

  test("remove drops every origin and receiver grant for the federation", async () => {
    const CHANNEL = "01CHANNEL00000000000000000";
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db);
    // Establish an active federation A<->B.
    await applyBatch(asyncDb, A, [decoded(requestEvent(B), 0)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, A, [decoded(respondEvent(B, true), 1)], { isBackfill: true }, globalDb);
    // Both sides author grants.
    await applyBatch(asyncDb, A, [decoded(setRoomPermEvent(B, CHANNEL, "readwrite"), 2)], { isBackfill: true }, globalDb);
    await applyBatch(asyncDb, B, [decoded(setReceiverPermEvent(A, CHANNEL, "did:plc:bob", "user", "readwrite"), 0)], { isBackfill: true }, globalDb);
    expect(await permissionOf(globalDb, A, B, CHANNEL)).toBe("readwrite");
    expect(await receiverPermissionOf(globalDb, A, B, CHANNEL, "did:plc:bob", "user")).toBe("readwrite");

    // Removing the federation (on A's stream) wipes all grants.
    await applyBatch(asyncDb, A, [decoded(removeEvent(B), 3)], { isBackfill: true }, globalDb);
    expect(await statusOf(globalDb, A, B)).toBe("removed");
    expect(await permissionOf(globalDb, A, B, CHANNEL)).toBeUndefined();
    expect(await receiverPermissionOf(globalDb, A, B, CHANNEL, "did:plc:bob", "user")).toBeUndefined();
  });
});
